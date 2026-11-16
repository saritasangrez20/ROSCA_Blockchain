// Deploys everything to a running local node and creates sample circles in different
// states, so the frontend and indexer have real data to show from the first minute.
// Usage:
//   npx hardhat node                                         (terminal 1)
//   npx hardhat run scripts/seedLocal.js --network localhost  (terminal 2)
// Then import Hardhat accounts #1 to #5 into MetaMask (keys are printed by `npx hardhat node`).
const { ethers } = require("hardhat");
const { deployAll, saveDeployment } = require("./deploy");

const UNIT = 10n ** 6n;
const DAY = 86_400n;

function config(termsCid) {
  return {
    contribution: 1_000n * UNIT,
    groupSize: 4n,
    roundDuration: 30n * DAY,
    gracePeriod: 3n * DAY,
    joinDuration: 14n * DAY,
    drawPhaseDuration: 2n * DAY,
    maxDefaults: 0n,
    termsCid,
  };
}

async function createCircle(factory, organizer, cfg) {
  const rc = await (await factory.connect(organizer).createCircle(cfg)).wait();
  const ev = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(Boolean);
  return ethers.getContractAt("Circle", ev.args.circle);
}

async function join(circle, token, vault, members) {
  const amount = await circle.joinCollateral();
  for (const m of members) {
    await (await token.connect(m).approve(await vault.getAddress(), amount)).wait();
    await (await circle.connect(m).join()).wait();
  }
}

async function main() {
  const [, organizer, ali, sara, bilal, hina] = await ethers.getSigners();
  const people = [ali, sara, bilal, hina];
  const deployed = await deployAll();
  const { token, vault, payoutOrder, factory } = deployed;

  for (const p of [organizer, ...people]) await (await token.mint(p.address, 50_000n * UNIT)).wait();

  // 1. Open: two of four joined, waiting for more members
  const open = await createCircle(factory, organizer, config("bafy-sample-open"));
  await join(open, token, vault, [ali, sara]);

  // 2. Order draw: full, two members have committed their secret
  const drawing = await createCircle(factory, organizer, config("bafy-sample-draw"));
  await join(drawing, token, vault, people);
  const drawingAddr = await drawing.getAddress();
  for (const m of [ali, sara]) {
    const secret = ethers.id(`seed-${m.address}`);
    await (await payoutOrder.connect(m).commit(drawingAddr, await payoutOrder.computeCommitment(secret, m.address, drawingAddr))).wait();
  }

  // 3. Active: draw finished, round 1 paid by three of four members
  const active = await createCircle(factory, organizer, config("bafy-sample-active"));
  await join(active, token, vault, people);
  const activeAddr = await active.getAddress();
  for (const m of people) {
    const secret = ethers.id(`seed-${m.address}`);
    await (await payoutOrder.connect(m).commit(activeAddr, await payoutOrder.computeCommitment(secret, m.address, activeAddr))).wait();
  }
  for (const m of people) await (await payoutOrder.connect(m).reveal(activeAddr, ethers.id(`seed-${m.address}`))).wait();
  await (await active.finalizeDraw()).wait();
  for (const m of [ali, sara, bilal]) {
    await (await token.connect(m).approve(activeAddr, 1_000n * UNIT)).wait();
    await (await active.connect(m).contribute()).wait();
  }

  const addresses = await saveDeployment(deployed, {
    sampleCircles: { open: await open.getAddress(), orderDraw: drawingAddr, active: activeAddr },
    sampleAccounts: { organizer: organizer.address, ali: ali.address, sara: sara.address, bilal: bilal.address, hina: hina.address },
  });
  console.log("Seeded local chain:");
  console.log(JSON.stringify(addresses, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
