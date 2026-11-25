// Shared setup for the attack scenario tests (Member C, Stage 3).
// Each attack file states the attacker, the goal, the steps and what must hold afterwards.
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  UNIT,
  DAY,
  deploySystem,
  createCircle,
  joinAll,
  runDraw,
  secretFor,
  signersInPayoutOrder,
  pay,
} = require("../helpers");

const C = 1_000n * UNIT; // contribution in the default test config
const ROUND_AND_GRACE = 8 * DAY; // default config: 7 day round + 1 day grace
const State = { Open: 0n, OrderDraw: 1n, Active: 2n, Completed: 3n, Cancelled: 4n };

/** Deploys the whole system around any ERC20 that has a public or owner `mint`. */
async function deploySystemWith(tokenName) {
  const [admin, organizer, alice, bob, carol, dave, eve, outsider] = await ethers.getSigners();
  const token = await ethers.deployContract(tokenName);
  const tokenAddr = await token.getAddress();
  const vault = await ethers.deployContract("CollateralVault", [tokenAddr, admin.address]);
  const reputation = await ethers.deployContract("ReputationRegistry", [admin.address]);
  const payoutOrder = await ethers.deployContract("PayoutOrder", [admin.address]);
  const factory = await ethers.deployContract("CircleFactory", [
    tokenAddr,
    await vault.getAddress(),
    await payoutOrder.getAddress(),
    await reputation.getAddress(),
    admin.address,
  ]);
  const factoryAddr = await factory.getAddress();
  await vault.grantRole(await vault.REGISTRAR_ROLE(), factoryAddr);
  await payoutOrder.grantRole(await payoutOrder.REGISTRAR_ROLE(), factoryAddr);
  await reputation.grantRole(await reputation.REGISTRAR_ROLE(), factoryAddr);
  for (const s of [organizer, alice, bob, carol, dave, eve, outsider]) await token.mint(s.address, 1_000_000n * UNIT);
  return { token, vault, reputation, payoutOrder, factory, admin, organizer, alice, bob, carol, dave, eve, outsider };
}

/** Deploys a member contract (ReentrantMember or DrawRigger), funds it and points it at `circle`. */
async function deployContractMember(name, sys, circle) {
  const m = await ethers.deployContract(name, [
    await sys.token.getAddress(),
    await sys.vault.getAddress(),
    await sys.payoutOrder.getAddress(),
  ]);
  await sys.token.mint(await m.getAddress(), 1_000_000n * UNIT);
  await m.setCircle(await circle.getAddress());
  return m;
}

/** Commits for every EOA in `eoas` and every contract member in `contracts` (secret = its index). */
async function commitAll(circle, payoutOrder, eoas, contracts = []) {
  const addr = await circle.getAddress();
  for (const m of eoas) await payoutOrder.connect(m).commit(addr, await payoutOrder.computeCommitment(secretFor(m), m.address, addr));
  for (const [i, c] of contracts.entries()) await c.commit(contractSecret(i));
}

function contractSecret(i) {
  return ethers.keccak256(ethers.toUtf8Bytes(`contract-member-secret-${i}`));
}

async function revealAll(circle, payoutOrder, eoas) {
  const addr = await circle.getAddress();
  for (const m of eoas) await payoutOrder.connect(m).reveal(addr, secretFor(m));
}

/** Balances of `accounts` (signers or contracts) as a map address => bigint. */
async function balances(token, accounts) {
  const out = {};
  for (const a of accounts) {
    const address = a.address || (await a.getAddress());
    out[address] = await token.balanceOf(address);
  }
  return out;
}

/** Plays one round: `payers` pay, time jumps past the deadline if someone is missing, round is settled. */
async function playRound(circle, token, payers, { missing = false } = {}) {
  await pay(circle, token, payers);
  if (missing) await time.increase(ROUND_AND_GRACE + 1);
  return circle.settleRound();
}

/** Like helpers.activeCircle, but also records every member's balance BEFORE joining. */
async function activeCircleWithStart(overrides = {}) {
  const sys = await deploySystem();
  const members = [sys.alice, sys.bob, sys.carol, sys.dave];
  const start = await balances(sys.token, members);
  const circle = await createCircle(sys.factory, sys.organizer, overrides);
  await joinAll(circle, sys.token, sys.vault, members);
  await runDraw(circle, sys.payoutOrder, members);
  const ordered = await signersInPayoutOrder(circle, members);
  return { ...sys, circle, members, ordered, start };
}

/** Every account with something to claim claims it. */
async function claimAll(circle, signers) {
  for (const s of signers) {
    if ((await circle.withdrawable(s.address)) > 0n) await circle.connect(s).claimPayout();
  }
}

module.exports = {
  C,
  UNIT,
  DAY,
  ROUND_AND_GRACE,
  State,
  deploySystemWith,
  deployContractMember,
  commitAll,
  contractSecret,
  revealAll,
  balances,
  playRound,
  claimAll,
  activeCircleWithStart,
  createCircle,
  joinAll,
  secretFor,
  signersInPayoutOrder,
  pay,
};
