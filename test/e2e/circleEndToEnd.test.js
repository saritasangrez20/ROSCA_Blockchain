// End to end test (Member B): a 4 member circle with one default, through the real off chain stack.
//
// Story: the Organizer uploads the terms to IPFS and creates a circle with the CID. Ali, Sara,
// Bilal and Hina set display names (signed), join and draw the payout order. Round 1 is paid by
// everyone. The round 1 recipient then disappears and never pays again (rounds 2 to 4). The
// keeper settles every round, the defaulter's deposit covers each missed payment, every honest
// member ends with exactly the money they started with, and the indexer, notifier and API show
// the whole story. Every check is made against the chain as well as the indexer.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { cidOf, verifyCid } = require("../../offchain/lib/cid");
const { profileMessage } = require("../../offchain/api/server");
const h = require("./e2eHelpers");

const C = 1_000n * h.UNIT;
const lc = (a) => a.toLowerCase();

describe("E2E: 4 member circle with one default (indexer, notifier, keeper, IPFS, API)", function () {
  this.timeout(120_000);

  let snap, sys, abis, off, keeper, circle, circleAddr, members, organizer, outsider, keeperSigner, byAddr, ordered, defaulter, honest;
  const start = {};
  const termsText = Buffer.from(
    "Trustless ROSCA terms\n4 members, 1,000 mUSD per round, 30 day rounds, 3 day grace.\n" +
      "Deposit covers 100% of what you owe after your payout. Missed payments are slashed.\n"
  );
  let termsCid;

  const notes = async (signer, all = false) =>
    (await off.api.get(`/api/accounts/${signer.address}/notifications${all ? "?all=1" : ""}`)).body;
  const kinds = async (signer) => (await notes(signer)).map((n) => n.kind);
  const sync = () => off.svc.tick();

  before(async function () {
    snap = await h.snapshot();
    const signers = await ethers.getSigners();
    [, organizer] = signers;
    members = signers.slice(2, 6); // Ali, Sara, Bilal, Hina
    outsider = signers[6];
    keeperSigner = signers[9];
    sys = await h.deploySystem();
    abis = await h.loadArtifactsAbis();
    for (const m of members) {
      await sys.token.mint(m.address, 10_000n * h.UNIT);
    }
    off = await h.startOffchain(sys.deployment, abis);
    keeper = h.makeKeeper(sys.deployment, abis, keeperSigner);
  });

  after(async function () {
    if (off) await off.stop();
    await h.revert(snap);
  });

  it("W1: the Organizer uploads the terms to IPFS, and only the CID goes on chain", async function () {
    const up = await off.api.post("/api/ipfs", termsText, { "content-type": "text/plain", "x-filename": "terms.txt" });
    expect(up.status).to.equal(201);
    termsCid = up.body.cid;
    expect(termsCid).to.equal(cidOf(termsText)); // CID computed independently of the service
    expect(termsCid).to.match(/^bafkrei[a-z2-7]{52}$/);

    circle = await h.createCircle(sys.factory, organizer, h.circleConfig(termsCid));
    circleAddr = await circle.getAddress();
    const s = await circle.getSummary();
    expect(s.termsCid).to.equal(termsCid);

    // The UI's integrity check: fetch by CID, re hash, compare with the on chain CID.
    const got = await off.api.get(`/ipfs/${s.termsCid}`);
    expect(got.status).to.equal(200);
    expect(verifyCid(s.termsCid, got.body).ok).to.equal(true);
    expect(verifyCid(s.termsCid, Buffer.from(termsText.toString().replace("100%", "50%"))).ok).to.equal(false);

    await sync();
    const list = (await off.api.get("/api/circles")).body;
    expect(list).to.have.length(1);
    expect(list[0]).to.include({ address: lc(circleAddr), organizer: lc(organizer.address), termsCid, state: 0, groupSize: 4 });
    expect(await kinds(organizer)).to.include("CIRCLE_CREATED");
  });

  it("display names are stored off chain and must be signed by the wallet", async function () {
    const names = ["Ali", "Sara", "Bilal", "Hina"];
    for (let i = 0; i < 4; i++) {
      const issuedAt = new Date().toISOString();
      const signature = await members[i].signMessage(profileMessage(members[i].address, names[i], issuedAt));
      const r = await off.api.post("/api/profiles", { address: members[i].address, displayName: names[i], issuedAt, signature });
      expect(r.status).to.equal(200);
    }
    // An outsider cannot rename Ali: the signature does not match the address.
    const issuedAt = new Date().toISOString();
    const forged = await outsider.signMessage(profileMessage(members[0].address, "Scammer", issuedAt));
    const bad = await off.api.post("/api/profiles", { address: members[0].address, displayName: "Scammer", issuedAt, signature: forged });
    expect(bad.status).to.equal(401);
    const got = (await off.api.get(`/api/profiles?addresses=${members.map((m) => m.address).join(",")}`)).body;
    expect(got[lc(members[0].address)]).to.equal("Ali");
    expect(got[lc(members[3].address)]).to.equal("Hina");
  });

  it("W2: four members join; the Organizer is notified and the draw reminders appear", async function () {
    for (const m of members) start[m.address] = await sys.token.balanceOf(m.address);
    const deposit = await circle.joinCollateral();
    expect(deposit).to.equal(3n * C);
    for (const m of members) {
      await sys.token.connect(m).approve(await sys.vault.getAddress(), deposit);
      await circle.connect(m).join();
    }
    await sync();
    const c = (await off.api.get(`/api/circles/${circleAddr}`)).body;
    expect(c.state).to.equal(1); // OrderDraw
    expect(c.members.map((m) => m.displayName)).to.have.members(["Ali", "Sara", "Bilal", "Hina"]);
    expect(c.members.every((m) => m.collateral === (3n * C).toString())).to.equal(true);
    const orgNotes = await notes(organizer);
    expect(orgNotes.filter((n) => n.kind === "MEMBER_JOINED")).to.have.length(4);
    for (const m of members) expect(await kinds(m)).to.include.members(["JOINED", "DRAW_STARTED", "COMMIT_DUE"]);
  });

  it("W3: commit and reveal; the keeper finalizes the draw; excess deposits are refunded", async function () {
    for (const m of members) {
      await sys.payoutOrder.connect(m).commit(circleAddr, await sys.payoutOrder.computeCommitment(h.secretFor(m, circleAddr), m.address, circleAddr));
    }
    await sync();
    for (const m of members) {
      const k = await kinds(m);
      expect(k).to.include("REVEAL_DUE");
      expect(k).to.not.include("COMMIT_DUE");
    }
    for (const m of members) await sys.payoutOrder.connect(m).reveal(circleAddr, h.secretFor(m, circleAddr));

    const actions = await keeper.tick();
    expect(actions.map((a) => a.action)).to.deep.equal(["finalizeDraw"]);
    expect(await circle.state()).to.equal(2n); // Active

    byAddr = Object.fromEntries(members.map((m) => [m.address, m]));
    ordered = (await circle.getPayoutOrder()).map((a) => byAddr[a]);
    defaulter = ordered[0]; // receives the pot first, then disappears
    honest = ordered.slice(1);

    await sync();
    const c = (await off.api.get(`/api/circles/${circleAddr}`)).body;
    expect(c.payoutOrder).to.deep.equal(ordered.map((m) => lc(m.address)));
    for (let i = 0; i < 4; i++) {
      const row = c.members.find((m) => m.address === lc(ordered[i].address));
      expect(row.position).to.equal(i + 1);
      expect(BigInt(row.collateral)).to.equal(await sys.vault.collateralOf(circleAddr, ordered[i].address)); // indexer == chain
      expect(BigInt(row.collateral)).to.equal(BigInt(3 - i) * C); // 3000, 2000, 1000, 0
    }
    for (const m of members) {
      const k = await kinds(m);
      expect(k).to.include.members(["ORDER_SET", "CONTRIBUTION_DUE"]);
      expect(k).to.not.include("REVEAL_DUE");
    }
  });

  it("W4 to W6, round 1: everyone pays, the keeper settles early, the recipient is notified and claims", async function () {
    // Before anyone pays, the keeper must not settle (round open, not past the deadline).
    expect(await keeper.tick()).to.deep.equal([]);
    for (const m of members) {
      await sys.token.connect(m).approve(circleAddr, C);
      await circle.connect(m).contribute();
    }
    const actions = await keeper.tick();
    expect(actions).to.have.length(1);
    expect(actions[0]).to.include({ action: "settleRound", round: 1 });

    await sync();
    const ready = (await notes(defaulter)).find((n) => n.kind === "PAYOUT_READY");
    expect(ready.title).to.include("4000 mUSD");
    await circle.connect(defaulter).claimPayout();
    await sync();
    expect(await kinds(defaulter)).to.not.include("PAYOUT_READY"); // resolved by PayoutClaimed
  });

  it("round 2: the round 1 recipient stops paying; reminder, keeper waits for the deadline, deposit covers it", async function () {
    for (const m of honest) {
      await sys.token.connect(m).approve(circleAddr, C);
      await circle.connect(m).contribute();
    }
    await sync();
    const due = (await notes(defaulter)).find((n) => n.kind === "CONTRIBUTION_DUE");
    expect(due.ref).to.equal("2");
    for (const m of honest) expect(await kinds(m)).to.not.include("CONTRIBUTION_DUE");

    expect(await keeper.tick()).to.deep.equal([]); // 3 of 4 paid and deadline not reached: nothing to do

    await time.increase(33 * h.DAY + 1); // round (30 days) + grace (3 days) has passed
    await sync();
    expect((await notes(defaulter)).find((n) => n.kind === "CONTRIBUTION_DUE").severity).to.equal("danger");

    const actions = await keeper.tick();
    expect(actions.map((a) => [a.action, a.round])).to.deep.equal([["settleRound", 2]]);

    const r2 = await circle.rounds(2);
    expect(r2.pot).to.equal(4n * C); // the recipient still gets a full pot: others are made whole
    expect(r2.shortfall).to.equal(0n);
    expect(await sys.vault.collateralOf(circleAddr, defaulter.address)).to.equal(2n * C);

    await sync();
    const d = (await notes(defaulter)).find((n) => n.kind === "DEFAULTED");
    expect(d.title).to.equal("Missed payment in round 2");
    expect(d.body).to.include("1000 mUSD was taken from your deposit");
    expect(await kinds(organizer)).to.include("MEMBER_DEFAULTED");
    await circle.connect(ordered[1]).claimPayout();
  });

  it("rounds 3 and 4: the defaulter keeps missing; the circle completes and everyone honest is made whole", async function () {
    for (const r of [3, 4]) {
      for (const m of honest) {
        await sys.token.connect(m).approve(circleAddr, C);
        await circle.connect(m).contribute();
      }
      await time.increase(33 * h.DAY + 1);
      const actions = await keeper.tick();
      expect(actions.map((a) => [a.action, a.round])).to.deep.equal([["settleRound", r]]);
      expect((await circle.rounds(r)).pot).to.equal(4n * C);
      await circle.connect(ordered[r - 1]).claimPayout();
    }
    expect(await circle.state()).to.equal(3n); // Completed

    // Money check against the chain: honest members end exactly where they started.
    for (const m of honest) expect(await sys.token.balanceOf(m.address)).to.equal(start[m.address]);
    // The defaulter paid once, received 4,000 and lost the 3,000 deposit: also net zero, but with 3 defaults on record.
    expect(await sys.token.balanceOf(defaulter.address)).to.equal(start[defaulter.address]);
    expect(await sys.vault.totalLocked(circleAddr)).to.equal(0n);
    expect(await sys.token.balanceOf(circleAddr)).to.equal(0n);
    const rec = await sys.reputation.getRecord(defaulter.address);
    expect(rec.defaults).to.equal(3n);
    expect(rec.completed).to.equal(0n);
  });

  it("history and notifications from the indexer match what happened on chain", async function () {
    await sync();
    const c = (await off.api.get(`/api/circles/${circleAddr}`)).body;
    expect(c.state).to.equal(3);
    expect(c.rounds.map((r) => [r.round, r.settled, r.pot])).to.deep.equal([1, 2, 3, 4].map((r) => [r, 1, (4n * C).toString()]));
    expect(c.rounds[1].paid).to.have.length(3);
    for (const m of members) {
      const row = c.members.find((x) => x.address === lc(m.address));
      expect(BigInt(row.collateral)).to.equal(await sys.vault.collateralOf(circleAddr, m.address));
      expect(row.claimedTotal).to.equal((4n * C).toString());
    }

    const events = (await off.api.get(`/api/circles/${circleAddr}/events`)).body.map((e) => e.name);
    for (const name of ["CircleCreated", "MemberJoined", "DrawStarted", "Committed", "Revealed", "PayoutOrderSet", "RoundStarted",
      "ContributionMade", "MemberDefaulted", "CollateralSlashed", "RoundSettled", "PayoutClaimed", "CollateralReleased", "CircleCompleted"]) {
      expect(events, name).to.include(name);
    }
    expect(events.filter((n) => n === "MemberDefaulted")).to.have.length(3);
    expect(events.filter((n) => n === "RoundSettled")).to.have.length(4);

    const mine = (await off.api.get(`/api/accounts/${defaulter.address}/events`)).body;
    expect(mine.filter((e) => e.name === "MemberDefaulted").map((e) => e.args.round)).to.have.members(["2", "3", "4"]);

    const rep = (await off.api.get(`/api/reputation/${defaulter.address}`)).body;
    expect(rep).to.include({ joined: 1, completed: 0, defaults: 3 });
    const repHonest = (await off.api.get(`/api/reputation/${honest[0].address}`)).body;
    expect(repHonest).to.include({ joined: 1, completed: 1, defaults: 0 });

    for (const m of members) {
      const k = await kinds(m);
      expect(k).to.include("COMPLETED");
      expect(k).to.not.include.members(["CONTRIBUTION_DUE", "PAYOUT_READY"]);
    }
    const all = await notes(defaulter, true);
    expect(all.filter((n) => n.kind === "DEFAULTED").map((n) => n.ref)).to.have.members(["2", "3", "4"]);
  });

  it("health endpoint reports the indexer caught up with the chain", async function () {
    const health = (await off.api.get("/api/health")).body;
    expect(health.ok).to.equal(true);
    expect(health.lastBlock).to.equal(await ethers.provider.getBlockNumber());
    expect(health.circles).to.equal(1);
  });
});
