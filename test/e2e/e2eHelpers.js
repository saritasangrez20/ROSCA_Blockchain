// Shared setup for the off chain end to end tests (Member B).
// Runs the real off chain code (indexer, notifier, keeper, IPFS store, HTTP API) against
// Hardhat's in process chain. ABIs come from the compiled artifacts, so the tests keep
// following the contracts if Member C changes their internals.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { ethers, artifacts, network } = require("hardhat");
const { deployAll } = require("../../scripts/deploy");
const { OffchainService } = require("../../offchain/service");
const { Keeper } = require("../../offchain/keeper/keeper");

const UNIT = 10n ** 6n;
const DAY = 86_400;
const quiet = { info() {}, warn() {}, log() {} };

async function loadArtifactsAbis() {
  const names = ["Circle", "CircleFactory", "CollateralVault", "PayoutOrder", "ReputationRegistry", "MockStablecoin"];
  const out = {};
  for (const n of names) out[n] = (await artifacts.readArtifact(n)).abi;
  return out;
}

/** Deploys the system exactly like scripts/deploy.js and returns a deployment object. */
async function deploySystem() {
  const sys = await deployAll();
  const deployment = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    admin: sys.admin.address,
    MockStablecoin: await sys.token.getAddress(),
    CollateralVault: await sys.vault.getAddress(),
    ReputationRegistry: await sys.reputation.getAddress(),
    PayoutOrder: await sys.payoutOrder.getAddress(),
    CircleFactory: await sys.factory.getAddress(),
  };
  return { ...sys, deployment };
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Starts the off chain service plus its HTTP API on a free port. */
async function startOffchain(deployment, abis, { dbFile, ipfsDir, blockChunk = 2000 } = {}) {
  const svc = await new OffchainService({
    provider: ethers.provider,
    deployment,
    abis,
    dbFile: dbFile ?? null,
    ipfsDir: ipfsDir ?? tempDir("rosca-ipfs-"),
    ipfsMaxBytes: 1024 * 1024,
    blockChunk,
    remindBeforeSec: 2 * DAY,
    logger: quiet,
  }).start();
  const server = await new Promise((resolve) => {
    const s = svc.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = {
    get: async (p) => {
      const r = await fetch(base + p);
      return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : Buffer.from(await r.arrayBuffer()) };
    },
    post: async (p, body, headers = {}) => {
      const isJson = !(body instanceof Buffer);
      const r = await fetch(base + p, {
        method: "POST",
        headers: isJson ? { "content-type": "application/json", ...headers } : headers,
        body: isJson ? JSON.stringify(body) : body,
      });
      return { status: r.status, body: await r.json() };
    },
  };
  return { svc, server, api, base, stop: () => new Promise((r) => server.close(() => { svc.close(); r(); })) };
}

function makeKeeper(deployment, abis, signer, opts = {}) {
  return new Keeper({ provider: ethers.provider, signer, deployment, abis, logger: quiet, ...opts });
}

function circleConfig(termsCid, overrides = {}) {
  return {
    contribution: 1_000n * UNIT,
    groupSize: 4n,
    roundDuration: BigInt(30 * DAY),
    gracePeriod: BigInt(3 * DAY),
    joinDuration: BigInt(7 * DAY),
    drawPhaseDuration: BigInt(DAY),
    maxDefaults: 0n,
    termsCid,
    ...overrides,
  };
}

async function createCircle(factory, organizer, cfg) {
  const rc = await (await factory.connect(organizer).createCircle(cfg)).wait();
  const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find((p) => p?.name === "CircleCreated");
  return ethers.getContractAt("Circle", ev.args.circle);
}

const secretFor = (m, circleAddr) => ethers.keccak256(ethers.toUtf8Bytes(`e2e-${m.address}-${circleAddr}`));

/** Chain snapshot helpers so each e2e file leaves the shared Hardhat chain as it found it. */
async function snapshot() {
  return network.provider.request({ method: "evm_snapshot", params: [] });
}
async function revert(id) {
  return network.provider.request({ method: "evm_revert", params: [id] });
}

module.exports = {
  UNIT, DAY, loadArtifactsAbis, deploySystem, startOffchain, makeKeeper, circleConfig, createCircle, secretFor, tempDir, snapshot, revert,
};
