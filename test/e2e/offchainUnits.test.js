// Unit tests for the off chain building blocks (Member B): CIDs, the IPFS store, the API's
// input checks, and the frontend's error decoder (loaded from frontend/src, so the exact code
// the browser runs is tested).
const path = require("path");
const { pathToFileURL } = require("url");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { cidOf, parseCid, verifyCid } = require("../../offchain/lib/cid");
const { IpfsStore } = require("../../offchain/ipfs/store");
const h = require("./e2eHelpers");

// Known answers checked against Kubo 0.32.1:
//   ipfs add -Q -n --cid-version=1 --raw-leaves --chunker=size-1048576 <file>
const VECTORS = [
  ["", "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"],
  ["hello world", "bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e"],
];

// import() needs a file:// URL on Windows (a plain "D:\\..." path is rejected), so convert it.
const frontend = (file) => import(pathToFileURL(path.join(__dirname, "..", "..", "frontend", "src", "lib", file)).href);

describe("Off chain units: IPFS CIDs", function () {
  it("matches the CIDs printed by a real IPFS node (Kubo)", function () {
    for (const [text, cid] of VECTORS) expect(cidOf(Buffer.from(text))).to.equal(cid);
  });

  it("the browser code computes the same CIDs as the server code", async function () {
    const web = await frontend("cid.js");
    for (const [text, cid] of VECTORS) expect(await web.cidOf(new TextEncoder().encode(text))).to.equal(cid);
    const big = Buffer.alloc(300_000, 7);
    expect(await web.cidOf(new Uint8Array(big))).to.equal(cidOf(big));
  });

  it("detects one changed byte, on the server and in the browser", async function () {
    const web = await frontend("cid.js");
    const doc = Buffer.from("Contribution: 1000 mUSD");
    const cid = cidOf(doc);
    const changed = Buffer.from("Contribution: 1001 mUSD");
    expect(verifyCid(cid, doc).ok).to.equal(true);
    expect(verifyCid(cid, changed).ok).to.equal(false);
    expect((await web.verifyCid(cid, new Uint8Array(doc))).ok).to.equal(true);
    expect((await web.verifyCid(cid, new Uint8Array(changed))).ok).to.equal(false);
  });

  it("rejects malformed CIDs and flags formats that cannot be checked by a plain hash", function () {
    expect(parseCid("").valid).to.equal(false);
    expect(parseCid("bafy-sample-open").valid).to.equal(false); // the placeholder used by seedLocal.js
    const v0 = parseCid("QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o");
    expect(v0.valid).to.equal(true);
    expect(v0.verifiable).to.equal(false);
    expect(parseCid(VECTORS[1][1]).verifiable).to.equal(true);
  });
});

describe("Off chain units: IPFS store", function () {
  it("stores by CID, returns the same bytes, and enforces the size limit", async function () {
    const store = new IpfsStore({ dir: h.tempDir("rosca-ipfs-unit-"), maxBytes: 1000 });
    const r = await store.add(Buffer.from("terms v1"), { filename: "t.txt", contentType: "text/plain" });
    expect(r.cid).to.equal(cidOf(Buffer.from("terms v1")));
    const got = await store.get(r.cid);
    expect(got.bytes.toString()).to.equal("terms v1");
    expect(got.meta.filename).to.equal("t.txt");
    await expect(store.add(Buffer.alloc(1001))).to.be.rejectedWith(/larger than/);
    await expect(store.add(Buffer.alloc(0))).to.be.rejectedWith(/empty/);
    expect(await store.get(cidOf(Buffer.from("never stored")))).to.equal(null);
    await expect(store.get("not-a-cid")).to.be.rejectedWith(/Invalid CID/);
  });
});

describe("Off chain units: API input checks", function () {
  this.timeout(60_000);
  let snap, off, signers;
  before(async function () {
    snap = await h.snapshot();
    signers = await ethers.getSigners();
    const sys = await h.deploySystem();
    off = await h.startOffchain(sys.deployment, await h.loadArtifactsAbis());
  });
  after(async function () {
    await off.stop();
    await h.revert(snap);
  });

  it("rejects bad addresses, bad names and stale signatures", async function () {
    const { profileMessage } = require("../../offchain/api/server");
    expect((await off.api.get("/api/circles/0x123")).status).to.equal(400);
    expect((await off.api.get(`/api/circles/${signers[5].address}`)).status).to.equal(404);

    const me = signers[2];
    const sign = async (name, issuedAt) => me.signMessage(profileMessage(me.address, name, issuedAt));
    const now = new Date().toISOString();
    const bad = await off.api.post("/api/profiles", { address: me.address, displayName: "<script>", issuedAt: now, signature: await sign("<script>", now) });
    expect(bad.status).to.equal(400);
    const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const stale = await off.api.post("/api/profiles", { address: me.address, displayName: "Ali", issuedAt: old, signature: await sign("Ali", old) });
    expect(stale.status).to.equal(400);
    const ok = await off.api.post("/api/profiles", { address: me.address, displayName: "Ali", issuedAt: now, signature: await sign("Ali", now) });
    expect(ok.status).to.equal(200);
    const replay = await off.api.post("/api/profiles", { address: me.address, displayName: "Ali", issuedAt: now, signature: await sign("Ali", now) });
    expect(replay.status).to.equal(409); // the same (or an older) signed message cannot overwrite
  });

  it("refuses an empty upload and serves uploaded files by CID", async function () {
    const empty = await off.api.post("/api/ipfs", Buffer.alloc(0), { "content-type": "text/plain" });
    expect(empty.status).to.equal(400);
    const up = await off.api.post("/api/ipfs", Buffer.from("abc"), { "content-type": "text/plain" });
    expect(up.status).to.equal(201);
    const got = await off.api.get(`/ipfs/${up.body.cid}`);
    expect(got.body.toString()).to.equal("abc");
  });
});

describe("Frontend units: readable transaction errors", function () {
  let decodeError, IFACES;
  before(async function () {
    ({ decodeError } = await frontend("errors.js"));
    const abis = await h.loadArtifactsAbis();
    IFACES = Object.values(abis).map((a) => new ethers.Interface(a));
  });

  const revertData = (reason) => "0x08c379a0" + ethers.AbiCoder.defaultAbiCoder().encode(["string"], [reason]).slice(2);

  it("explains contract revert strings in plain words", function () {
    const e = decodeError({ code: "CALL_EXCEPTION", data: revertData("Circle: round closed") }, IFACES);
    expect(e.title).to.match(/payment window/);
    expect(e.detail).to.include("Circle: round closed");
  });

  it("decodes OpenZeppelin custom errors (role, pause, balance)", function () {
    const circle = IFACES[0];
    const role = circle.encodeErrorResult("AccessControlUnauthorizedAccount", [ethers.ZeroAddress, ethers.id("PAUSER_ROLE")]);
    expect(decodeError({ info: { error: { data: role } } }, IFACES).title).to.match(/platform admin/);
    const paused = circle.encodeErrorResult("EnforcedPause", []);
    expect(decodeError({ error: { data: { data: paused } } }, IFACES).title).to.match(/paused/);
    const token = IFACES.find((i) => i.getError("ERC20InsufficientBalance"));
    const bal = token.encodeErrorResult("ERC20InsufficientBalance", [ethers.ZeroAddress, 0n, 3_000_000_000n]);
    expect(decodeError({ data: bal }, IFACES).title).to.equal("Not enough mUSD: you have 0 mUSD but need 3,000 mUSD. Use Get test mUSD.");
  });

  it("recognises wallet rejection, missing gas money and stale nonces", function () {
    expect(decodeError({ code: "ACTION_REJECTED" }, IFACES).kind).to.equal("rejected");
    expect(decodeError({ info: { error: { code: 4001, message: "User denied" } } }, IFACES).kind).to.equal("rejected");
    expect(decodeError({ code: "INSUFFICIENT_FUNDS", message: "insufficient funds for gas" }, IFACES).kind).to.equal("funds");
    expect(decodeError({ message: "Nonce too high. Expected nonce to be 0" }, IFACES).kind).to.equal("nonce");
    const mm = { code: "UNKNOWN_ERROR", error: { code: 4100, message: "The requested account and/or method has not been authorized by the user." } };
    expect(decodeError(mm, IFACES).kind).to.equal("unauthorized");
  });

  it("decodes a real revert from the chain end to end", async function () {
    const snap = await h.snapshot();
    try {
      const sys = await h.deploySystem();
      const [, organizer] = await ethers.getSigners();
      const circle = await h.createCircle(sys.factory, organizer, h.circleConfig("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"));
      let caught;
      try {
        await circle.connect(organizer).claimPayout();
      } catch (e) {
        caught = e;
      }
      expect(decodeError(caught, IFACES).title).to.equal("There is nothing for you to claim in this circle right now.");
    } finally {
      await h.revert(snap);
    }
  });
});
