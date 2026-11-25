// Attack A1: payout reentrancy.
// Attacker: a member that is a smart contract, in a circle whose token calls the receiver on
//           every transfer (HookToken, ERC777 style), so it can run code in the middle of a payout.
// Goal:     be paid twice, or run settle / finalize / cancel while the circle is half way
//           through moving money.
// Defence:  every Circle and CollateralVault entry point is nonReentrant and updates state
//           before transferring (checks effects interactions); payouts are pull based.
const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  deploySystemWith,
  deployContractMember,
  commitAll,
  contractSecret,
  revealAll,
  createCircle,
  joinAll,
  pay,
  balances,
  State,
  DAY,
} = require("./attackHelpers");

const Attack = { None: 0, ClaimAgain: 1, Settle: 2, Finalize: 3, Cancel: 4 };

async function reentrancyFixture() {
  const sys = await deploySystemWith("HookToken");
  const circle = await createCircle(sys.factory, sys.organizer, { groupSize: 3n });
  const attacker = await deployContractMember("ReentrantMember", sys, circle);
  const humans = [sys.alice, sys.bob];
  const start = await balances(sys.token, [attacker, ...humans]);
  await attacker.join();
  await joinAll(circle, sys.token, sys.vault, humans);
  await commitAll(circle, sys.payoutOrder, humans, [attacker]);
  await revealAll(circle, sys.payoutOrder, humans);
  await attacker.reveal(contractSecret(0));
  return { ...sys, circle, attacker, humans, start, atk: await attacker.getAddress() };
}

/** Plays rounds (everyone pays) until the attacker has something to claim. */
async function untilAttackerIsCredited(f) {
  for (let r = 1; r <= 3 && (await f.circle.withdrawable(f.atk)) === 0n; r++) {
    await f.attacker.contribute();
    await pay(f.circle, f.token, f.humans);
    await f.circle.settleRound();
  }
  const credit = await f.circle.withdrawable(f.atk);
  expect(credit).to.be.gt(0n);
  return credit;
}

/** Solvency: the circle always holds at least everything it owes. */
async function expectSolvent(f) {
  let owed = 0n;
  for (const a of [f.atk, ...f.humans.map((h) => h.address)]) owed += await f.circle.withdrawable(a);
  expect(await f.token.balanceOf(await f.circle.getAddress())).to.be.gte(owed);
}

const guardSelector = (circle) => circle.interface.getError("ReentrancyGuardReentrantCall").selector;

describe("Attack A1: payout reentrancy", function () {
  it("re entering claimPayout during the payout is blocked: the attacker is paid exactly once", async function () {
    const f = await loadFixture(reentrancyFixture);
    await f.circle.finalizeDraw();
    const credit = await untilAttackerIsCredited(f);

    await f.attacker.enableHook();
    await f.attacker.setAttack(Attack.ClaimAgain, false);
    const before = await f.token.balanceOf(f.atk);
    await f.attacker.claim();

    expect(await f.attacker.attempts()).to.equal(1n);
    expect(await f.attacker.blocked()).to.equal(1n);
    expect((await f.attacker.lastError()).slice(0, 10)).to.equal(guardSelector(f.circle));
    expect(await f.token.balanceOf(f.atk)).to.equal(before + credit); // once, not twice
    expect(await f.circle.withdrawable(f.atk)).to.equal(0n);
    await expect(f.attacker.claim()).to.be.revertedWith("Circle: nothing to claim");
    await expectSolvent(f);
  });

  it("if the attacker lets the re entry revert, the whole claim reverts and the credit is kept", async function () {
    const f = await loadFixture(reentrancyFixture);
    await f.circle.finalizeDraw();
    const credit = await untilAttackerIsCredited(f);

    await f.attacker.enableHook();
    await f.attacker.setAttack(Attack.ClaimAgain, true);
    await expect(f.attacker.claim()).to.be.revertedWithCustomError(f.circle, "ReentrancyGuardReentrantCall");
    expect(await f.circle.withdrawable(f.atk)).to.equal(credit); // nothing lost, nothing gained

    await f.attacker.setAttack(Attack.None, false);
    await f.attacker.claim();
    expect(await f.circle.withdrawable(f.atk)).to.equal(0n);
  });

  it("cross function re entry: settleRound called from inside a payout is blocked", async function () {
    // Credit the attacker while the circle is still Active (whatever slot it draws): a fourth
    // member never reveals, and its penalty is shared by the members who did.
    const sys = await deploySystemWith("HookToken");
    const circle = await createCircle(sys.factory, sys.organizer, { groupSize: 4n });
    const attacker = await deployContractMember("ReentrantMember", sys, circle);
    const humans = [sys.alice, sys.bob, sys.carol];
    await attacker.join();
    await joinAll(circle, sys.token, sys.vault, humans);
    await commitAll(circle, sys.payoutOrder, humans, [attacker]);
    await revealAll(circle, sys.payoutOrder, [sys.alice, sys.bob]); // carol walks away
    await attacker.reveal(contractSecret(0));
    await time.increase(2 * DAY + 1);
    await circle.finalizeDraw();
    expect(await circle.state()).to.equal(State.Active);
    expect(await circle.withdrawable(await attacker.getAddress())).to.be.gt(0n);
    const round = await circle.currentRound();

    await attacker.enableHook();
    await attacker.setAttack(Attack.Settle, false);
    await attacker.claim();
    expect(await attacker.blocked()).to.equal(1n);
    expect((await attacker.lastError()).slice(0, 10)).to.equal(guardSelector(circle));
    expect(await circle.currentRound()).to.equal(round);
  });

  it("re entry while deposits are refunded (draw and completion) changes nothing; everyone ends whole", async function () {
    const f = await loadFixture(reentrancyFixture);
    await f.attacker.enableHook();
    await f.attacker.setAttack(Attack.ClaimAgain, false); // fires on every refund and payout

    await f.circle.finalizeDraw(); // later slots get part of their deposit back
    for (let r = 1; r <= 3; r++) {
      await f.attacker.contribute();
      await pay(f.circle, f.token, f.humans);
      await f.circle.settleRound(); // the last one completes and releases every deposit
    }
    expect(await f.circle.state()).to.equal(State.Completed);
    await f.attacker.claim();
    for (const h of f.humans) await f.circle.connect(h).claimPayout();

    const attempts = await f.attacker.attempts();
    expect(attempts).to.be.gt(0n);
    expect(await f.attacker.blocked()).to.equal(attempts); // every attempt was refused
    expect(await f.vault.totalLocked(await f.circle.getAddress())).to.equal(0n);
    expect(await f.token.balanceOf(await f.circle.getAddress())).to.equal(0n);
    const end = await balances(f.token, [f.attacker, ...f.humans]);
    for (const [addr, v] of Object.entries(f.start)) expect(end[addr]).to.equal(v); // paid 3C, got 3C
  });

  it("residual risk (accepted): with a token that calls receivers, a member can block push refunds", async function () {
    // The deployed system uses MockStablecoin, a plain ERC20 that never calls the receiver,
    // and the factory fixes the token at deployment, so this cannot happen there. The test
    // pins the assumption: refunds are pushed in a loop, so a receiver that reverts would
    // block cancel and completion. Pull based refunds are listed as future work.
    const sys = await deploySystemWith("HookToken");
    const circle = await createCircle(sys.factory, sys.organizer, { groupSize: 3n });
    const attacker = await deployContractMember("ReentrantMember", sys, circle);
    await attacker.join();
    await joinAll(circle, sys.token, sys.vault, [sys.alice]);
    await attacker.enableHook();
    await attacker.setAttack(Attack.ClaimAgain, true);
    await expect(circle.connect(sys.organizer).cancel()).to.be.revertedWithCustomError(
      circle,
      "ReentrancyGuardReentrantCall"
    );
    expect(await circle.state()).to.equal(State.Open);
  });
});
