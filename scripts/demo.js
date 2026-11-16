// Plays one whole committee on an in-memory chain and prints what happens.
// Story: 4 friends, 1,000 mUSD a month, 4 months. The person paid in month 1
// stops paying in month 2; their deposit covers it, so nobody else loses money.
// Usage: npx hardhat run scripts/demo.js
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployAll } = require("./deploy");

const UNIT = 10n ** 6n;
const DAY = 86_400;
const fmt = (v) => `${ethers.formatUnits(v, 6)} mUSD`;
const names = {};
const who = (addr) => names[addr] || addr.slice(0, 8);

async function main() {
  const signers = await ethers.getSigners();
  const [, organizer, ali, sara, bilal, hina] = signers;
  Object.assign(names, { [ali.address]: "Ali", [sara.address]: "Sara", [bilal.address]: "Bilal", [hina.address]: "Hina" });
  const members = [ali, sara, bilal, hina];

  const { token, vault, reputation, payoutOrder, factory } = await deployAll();
  for (const m of members) await token.mint(m.address, 10_000n * UNIT);
  console.log("\n1. System deployed. Each member starts with 10,000 mUSD.\n");

  // W1 create
  const cfg = {
    contribution: 1_000n * UNIT,
    groupSize: 4n,
    roundDuration: BigInt(30 * DAY),
    gracePeriod: BigInt(3 * DAY),
    joinDuration: BigInt(7 * DAY),
    drawPhaseDuration: BigInt(1 * DAY),
    coverageBps: 10_000n,
    maxDefaults: 0n,
    termsCid: "bafy-demo-terms",
  };
  const receipt = await (await factory.connect(organizer).createCircle(cfg)).wait();
  const created = receipt.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } }).find(Boolean);
  const circle = await ethers.getContractAt("Circle", created.args.circle);
  const circleAddr = await circle.getAddress();
  console.log(`2. Organizer created a circle at ${circleAddr}: 4 members, 1,000 mUSD per month.`);

  // W2 join
  const deposit = await circle.joinCollateral();
  for (const m of members) {
    await token.connect(m).approve(await vault.getAddress(), deposit);
    await circle.connect(m).join();
  }
  console.log(`3. Ali, Sara, Bilal and Hina joined, each locking a ${fmt(deposit)} security deposit.`);

  // W3 draw
  const secret = (m) => ethers.keccak256(ethers.toUtf8Bytes(`demo-${m.address}`));
  for (const m of members) await payoutOrder.connect(m).commit(circleAddr, await payoutOrder.computeCommitment(secret(m), m.address, circleAddr));
  for (const m of members) await payoutOrder.connect(m).reveal(circleAddr, secret(m));
  await circle.finalizeDraw();
  const order = await circle.getPayoutOrder();
  const ordered = order.map((a) => members.find((m) => m.address === a));
  console.log(`4. Fair draw done. Payout order: ${order.map(who).join(", ")}`);
  for (let i = 0; i < 4; i++) {
    console.log(`   ${who(order[i])} (month ${i + 1}) keeps ${fmt(await vault.collateralOf(circleAddr, order[i]))} locked`);
  }

  // W4 to W6, four months
  for (let r = 1; r <= 4; r++) {
    const skipper = r === 2 ? ordered[0] : null;
    for (const m of members) {
      if (m === skipper) continue;
      await token.connect(m).approve(circleAddr, cfg.contribution);
      await circle.connect(m).contribute();
    }
    if (skipper) {
      console.log(`\n   Month ${r}: ${who(skipper.address)} already got the pot and stops paying...`);
      await time.increase(34 * DAY);
    }
    const tx = await circle.settleRound();
    const rc = await tx.wait();
    for (const l of rc.logs) {
      let p; try { p = circle.interface.parseLog(l); } catch { continue; }
      if (p?.name === "MemberDefaulted") console.log(`   ${who(p.args.member)} defaulted: ${fmt(p.args.covered)} taken from their deposit`);
    }
    const res = await circle.rounds(r);
    await circle.connect(ordered[r - 1]).claimPayout();
    console.log(`5.${r} Month ${r}: pot of ${fmt(res.pot)} paid to ${who(res.recipient)}`);
  }

  // W7 complete
  console.log(`\n6. Circle state: ${["Open", "OrderDraw", "Active", "Completed", "Cancelled"][Number(await circle.state())]}`);
  for (const m of members) {
    const rec = await reputation.getRecord(m.address);
    console.log(`   ${who(m.address)}: balance ${fmt(await token.balanceOf(m.address))}, completed ${rec.completed}, defaults ${rec.defaults}`);
  }
  console.log("\nEveryone except the defaulter ends where they started; the defaulter paid their missed month from the deposit.\n");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
