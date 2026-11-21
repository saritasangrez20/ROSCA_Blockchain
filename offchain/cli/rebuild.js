// Throws away every chain derived table and rebuilds the indexer database from events only.
// Display names (off chain data) and uploaded terms files are kept.
// Usage: npm run indexer:rebuild     (stop `npm run offchain` first, then start it again)
const { ethers } = require("ethers");
const { config, loadDeployment, loadAbis } = require("../lib/config");
const { OffchainService } = require("../service");

async function main() {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const svc = await new OffchainService({
    provider, deployment: loadDeployment(), abis: loadAbis(), dbFile: config.dbFile, ipfsDir: config.ipfsDir,
    startBlock: config.startBlock, blockChunk: config.blockChunk, remindBeforeSec: config.remindBeforeSec,
  }).start();
  const before = svc.db.get("SELECT COUNT(*) AS n FROM events").n;
  const t0 = Date.now();
  const r = await svc.rebuild();
  const counts = Object.fromEntries(
    ["events", "circles", "members", "rounds", "contributions", "notifications", "profiles"].map((t) => [t, svc.db.get(`SELECT COUNT(*) AS n FROM ${t}`).n])
  );
  svc.close();
  console.log(`[rebuild] replayed ${r.applied} events up to block ${r.head} in ${Date.now() - t0} ms (had ${before} before)`);
  console.table(counts);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
