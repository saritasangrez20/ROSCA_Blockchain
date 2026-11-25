// Gas measurement for the gas sheet (Member C, Stage 3).
//
// Plays one complete 4 member circle with one default under fixed conditions and records the
// gas of every state changing call, plus the one off deployment cost of each contract and the
// deployed bytecode sizes. Run it on the baseline commit and again after every optimization;
// docs/gas/gas_sheet.md compares the files.
//
// Usage:
//   npx hardhat run scripts/measureGas.js
//   GAS_OUT=docs/gas/optimized.json GAS_LABEL=optimized npx hardhat run scripts/measureGas.js
//
// Determinism: the payout order is random, so every action is chosen by payout POSITION, not by
// account (the member in slot 1 always pays first and always defaults). The gas of each call is
// therefore the same whichever account the draw puts in which slot.
const { ethers, artifacts } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { deployAll } = require("./deploy");

const UNIT = 10n ** 6n;
const DAY = 86_400;

async function gasOf(txPromise) {
  const rc = await (await txPromise).wait();
  return rc.gasUsed;
}

function gitCommit() {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}

async function main() {
  const [, organizer, a, b, c, d] = await ethers.getSigners();
  const members = [a, b, c, d];

  // ---- one off deployment ----
  const sys = await deployAll();
  const { token, vault, payoutOrder, reputation, factory } = sys;
  const deploy = {};
  for (const [name, contract] of Object.entries({
    MockStablecoin: token,
    CollateralVault: vault,
    ReputationRegistry: reputation,
    PayoutOrder: payoutOrder,
    CircleFactory: factory,
  })) {
    deploy[name] = Number((await contract.deploymentTransaction().wait()).gasUsed);
  }
  deploy.total = Object.values(deploy).reduce((s, v) => s + v, 0);

  for (const m of members) await token.mint(m.address, 100_000n * UNIT);

  const cfg = {
    contribution: 1_000n * UNIT,
    groupSize: 4n,
    roundDuration: BigInt(30 * DAY),
    gracePeriod: BigInt(DAY),
    joinDuration: BigInt(7 * DAY),
    drawPhaseDuration: BigInt(DAY),
    maxDefaults: 0n,
    termsCid: "bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku",
  };

  const g = {}; // named measurements
  let lifecycleTotal = 0n; // every transaction of the circle, from create to completion
  const track = async (txPromise) => {
    const used = await gasOf(txPromise);
    lifecycleTotal += used;
    return used;
  };

  // ---- W1 create ----
  const createTx = await factory.connect(organizer).createCircle(cfg);
  const rc = await createTx.wait();
  g.createCircle = rc.gasUsed;
  lifecycleTotal += rc.gasUsed;
  const created = rc.logs
    .map((l) => {
      try {
        return factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p) => p && p.name === "CircleCreated");
  const circle = await ethers.getContractAt("Circle", created.args.circle);
  const addr = await circle.getAddress();

  // ---- W2 join ----
  const deposit = await circle.joinCollateral();
  for (const m of members) await track(token.connect(m).approve(await vault.getAddress(), deposit));
  g.join_first = await track(circle.connect(a).join());
  g.join_middle = await track(circle.connect(b).join());
  await track(circle.connect(c).join());
  g.join_last_starts_draw = await track(circle.connect(d).join());

  // ---- W3 draw ----
  const secret = (m) => ethers.keccak256(ethers.toUtf8Bytes(`gas-${m.address}`));
  const commits = [];
  for (const m of members) {
    commits.push(await track(payoutOrder.connect(m).commit(addr, await payoutOrder.computeCommitment(secret(m), m.address, addr))));
  }
  g.commit = commits[0];
  const reveals = [];
  for (const m of members) reveals.push(await track(payoutOrder.connect(m).reveal(addr, secret(m))));
  g.reveal_first = reveals[0];
  g.reveal_last = reveals[reveals.length - 1];
  g.finalizeDraw = await track(circle.finalizeDraw());

  // From here on, act by payout position so the numbers do not depend on the random order.
  const order = await circle.getPayoutOrder();
  const slot = order.map((x) => members.find((m) => m.address === x));
  for (const m of members) await track(token.connect(m).approve(addr, 10n * cfg.contribution));

  // ---- round 1: everyone pays ----
  g.contribute_first_in_round = await track(circle.connect(slot[0]).contribute());
  g.contribute_later_in_round = await track(circle.connect(slot[1]).contribute());
  for (const m of [slot[2], slot[3]]) await track(circle.connect(m).contribute());
  g.settleRound_allPaid = await track(circle.settleRound());
  g.claimPayout = await track(circle.connect(slot[0]).claimPayout());

  // ---- rounds 2 to 4: the round 1 recipient stops paying ----
  const honest = [slot[1], slot[2], slot[3]];
  for (let r = 2; r <= 4; r++) {
    for (const m of honest) await track(circle.connect(m).contribute());
    await ethers.provider.send("evm_increaseTime", [32 * DAY]);
    await ethers.provider.send("evm_mine", []);
    const used = await track(circle.settleRound());
    if (r === 2) g.settleRound_oneDefault = used;
    if (r === 4) g.settleRound_last_completes = used;
    await track(circle.connect(slot[r - 1]).claimPayout());
  }
  if (Number(await circle.state()) !== 3) throw new Error("measurement circle did not complete");

  // ---- bytecode sizes ----
  const sizes = {};
  for (const n of ["Circle", "CircleFactory", "CollateralVault", "PayoutOrder", "ReputationRegistry", "MockStablecoin"]) {
    const art = await artifacts.readArtifact(n);
    sizes[n] = (art.deployedBytecode.length - 2) / 2;
  }
  sizes.circleInstanceRuntime = ((await ethers.provider.getCode(addr)).length - 2) / 2;

  const gas = Object.fromEntries(Object.entries(g).map(([k, v]) => [k, Number(v)]));
  console.log("Per call gas");
  console.table(gas);
  console.log("Deployment gas (one off)");
  console.table(deploy);
  console.log(`Whole 4 member circle with one default (every transaction): ${lifecycleTotal} gas`);
  console.table(sizes);

  const file = process.env.GAS_OUT || path.join("docs", "gas", "baseline.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        label: process.env.GAS_LABEL || "baseline",
        commit: gitCommit(),
        measuredAt: new Date().toISOString(),
        solc: "0.8.24",
        optimizerRuns: 200,
        scenario: "4 members, 1,000 mUSD per round, round 1 recipient defaults in rounds 2 to 4",
        gas,
        lifecycleTotal: Number(lifecycleTotal),
        deploy,
        sizes,
      },
      null,
      2
    ) + "\n"
  );
  console.log(`Written to ${file}`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
