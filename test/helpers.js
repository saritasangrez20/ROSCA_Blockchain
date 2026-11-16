const { ethers } = require("hardhat");

const UNIT = 10n ** 6n; // mUSD has 6 decimals
const DAY = 24 * 60 * 60;

/** Default circle settings used across tests. Override any field per test. */
function defaultConfig(overrides = {}) {
  return {
    contribution: 1_000n * UNIT,
    groupSize: 4n,
    roundDuration: BigInt(7 * DAY),
    gracePeriod: BigInt(1 * DAY),
    joinDuration: BigInt(3 * DAY),
    drawPhaseDuration: BigInt(1 * DAY),
    maxDefaults: 0n,
    termsCid: "bafybeigdyrztktx5b5m2t5terms0000000000000000000000000000",
    ...overrides,
  };
}

/** Deploys the whole system the same way scripts/deploy.js does. */
async function deploySystem() {
  const [admin, organizer, alice, bob, carol, dave, eve, outsider] = await ethers.getSigners();

  const token = await ethers.deployContract("MockStablecoin");
  const vault = await ethers.deployContract("CollateralVault", [await token.getAddress(), admin.address]);
  const reputation = await ethers.deployContract("ReputationRegistry", [admin.address]);
  const payoutOrder = await ethers.deployContract("PayoutOrder", [admin.address]);
  const factory = await ethers.deployContract("CircleFactory", [
    await token.getAddress(),
    await vault.getAddress(),
    await payoutOrder.getAddress(),
    await reputation.getAddress(),
    admin.address,
  ]);

  const factoryAddr = await factory.getAddress();
  await vault.grantRole(await vault.REGISTRAR_ROLE(), factoryAddr);
  await payoutOrder.grantRole(await payoutOrder.REGISTRAR_ROLE(), factoryAddr);
  await reputation.grantRole(await reputation.REGISTRAR_ROLE(), factoryAddr);

  for (const s of [organizer, alice, bob, carol, dave, eve, outsider]) {
    await token.mint(s.address, 1_000_000n * UNIT);
  }

  return { token, vault, reputation, payoutOrder, factory, admin, organizer, alice, bob, carol, dave, eve, outsider };
}

/** Organizer creates a circle; returns the Circle contract instance. */
async function createCircle(factory, organizer, overrides = {}) {
  const tx = await factory.connect(organizer).createCircle(defaultConfig(overrides));
  const receipt = await tx.wait();
  const log = receipt.logs
    .map((l) => {
      try {
        return factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((p) => p && p.name === "CircleCreated");
  return ethers.getContractAt("Circle", log.args.circle);
}

/** Each member approves the vault for the join collateral and joins. */
async function joinAll(circle, token, vault, members) {
  const collateral = await circle.joinCollateral();
  for (const m of members) {
    await token.connect(m).approve(await vault.getAddress(), collateral);
    await circle.connect(m).join();
  }
}

function secretFor(signer) {
  return ethers.keccak256(ethers.toUtf8Bytes(`secret-${signer.address}`));
}

/** Every member commits then reveals; finalizeDraw is called unless told otherwise. */
async function runDraw(circle, payoutOrder, members, { finalize = true, skipReveal = [] } = {}) {
  const circleAddr = await circle.getAddress();
  for (const m of members) {
    const c = await payoutOrder.computeCommitment(secretFor(m), m.address, circleAddr);
    await payoutOrder.connect(m).commit(circleAddr, c);
  }
  for (const m of members) {
    if (skipReveal.includes(m)) continue;
    await payoutOrder.connect(m).reveal(circleAddr, secretFor(m));
  }
  if (finalize) await circle.finalizeDraw();
}

/** Returns the members as signers sorted into payout order (index 0 = paid in round 1). */
async function signersInPayoutOrder(circle, members) {
  const order = await circle.getPayoutOrder();
  return order.map((addr) => members.find((m) => m.address === addr));
}

/** Members approve the circle and pay the current round. */
async function pay(circle, token, members) {
  const amount = (await circle.config()).contribution;
  for (const m of members) {
    await token.connect(m).approve(await circle.getAddress(), amount);
    await circle.connect(m).contribute();
  }
}

/** Full setup: deploy, create, four members join and draw. */
async function activeCircle(overrides = {}) {
  const sys = await deploySystem();
  const members = [sys.alice, sys.bob, sys.carol, sys.dave];
  const circle = await createCircle(sys.factory, sys.organizer, overrides);
  await joinAll(circle, sys.token, sys.vault, members);
  await runDraw(circle, sys.payoutOrder, members);
  const ordered = await signersInPayoutOrder(circle, members);
  return { ...sys, circle, members, ordered };
}

module.exports = {
  UNIT,
  DAY,
  defaultConfig,
  deploySystem,
  createCircle,
  joinAll,
  runDraw,
  secretFor,
  signersInPayoutOrder,
  pay,
  activeCircle,
};
