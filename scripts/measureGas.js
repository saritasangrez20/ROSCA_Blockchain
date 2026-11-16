// Measures gas for the main state changing operations under fixed conditions.
// Run it on the baseline tag and again on the optimized tag to fill the gas sheet.
// Usage: npx hardhat run scripts/measureGas.js   (optional: GAS_OUT=docs/gas/optimized.json)
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { deployAll } = require("./deploy");

const UNIT = 10n ** 6n;
const DAY = 86_400;

async function gasOf(txPromise) {
  const rc = await (await txPromise).wait();
  return rc.gasUsed;
}

async function main() {
  const [, organizer, a, b, c, d] = await ethers.getSigners();
  const members = [a, b, c, d];
  const { token, vault, payoutOrder, factory } = await deployAll();
  for (const m of members) await token.mint(m.address, 100_000n * UNIT);

  const cfg = {
    contribution: 1_000n * UNIT, groupSize: 4n, roundDuration: BigInt(30 * DAY), gracePeriod: BigInt(DAY),
    joinDuration: BigInt(7 * DAY), drawPhaseDuration: BigInt(DAY), maxDefaults: 0n,
    termsCid: "bafy-gas-measure",
  };

  const results = {};
  const rc = await (await factory.connect(organizer).createCircle(cfg)).wait();
  results.createCircle = rc.gasUsed;
  const created = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(Boolean);
  const circle = await ethers.getContractAt("Circle", created.args.circle);
  const addr = await circle.getAddress();

  const deposit = await circle.joinCollateral();
  for (const m of members) await token.connect(m).approve(await vault.getAddress(), deposit);
  results.join_first = await gasOf(circle.connect(a).join());
  await circle.connect(b).join();
  await circle.connect(c).join();
  results.join_last_starts_draw = await gasOf(circle.connect(d).join());

  const secret = (m) => ethers.keccak256(ethers.toUtf8Bytes(`gas-${m.address}`));
  for (const m of members) await payoutOrder.connect(m).commit(addr, await payoutOrder.computeCommitment(secret(m), m.address, addr));
  for (const m of members) await payoutOrder.connect(m).reveal(addr, secret(m));
  results.finalizeDraw = await gasOf(circle.finalizeDraw());

  for (const m of members) await token.connect(m).approve(addr, 10n * cfg.contribution);
  results.contribute = await gasOf(circle.connect(a).contribute());
  for (const m of [b, c, d]) await circle.connect(m).contribute();
  results.settleRound_allPaid = await gasOf(circle.settleRound());
  const r1 = (await circle.rounds(1)).recipient;
  results.claimPayout = await gasOf(circle.connect(members.find((m) => m.address === r1)).claimPayout());

  // round 2 with one default, to measure settlement with slashing
  for (const m of [a, b, c]) await circle.connect(m).contribute();
  await ethers.provider.send("evm_increaseTime", [32 * DAY]);
  await ethers.provider.send("evm_mine", []);
  results.settleRound_oneDefault = await gasOf(circle.settleRound());

  const out = Object.fromEntries(Object.entries(results).map(([k, v]) => [k, Number(v)]));
  console.table(out);
  const file = process.env.GAS_OUT || path.join("docs", "gas", "baseline.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ measuredAt: new Date().toISOString(), solc: "0.8.24", optimizerRuns: 200, gas: out }, null, 2));
  console.log(`Written to ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
