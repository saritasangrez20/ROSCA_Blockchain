// Attack A8: several defaulters at once (collusion), checked as invariants over random patterns.
// Attackers: any subset of members, each missing payments at random, including several members
//            with empty deposits missing in the same rounds (the case handoff_1 flagged).
// Goal:      leave honest members short, create money out of nothing, or leave money stuck.
// Claim checked here (Member C's analysis for the report): in round k the pot is at least
//            (k - 1) contributions, because every member already paid out is 100% covered by
//            its deposit. That is always enough to repay the recipient's earlier uncovered debt
//            AND refill its deposit, so after every payout the recipient's deposit is exactly
//            (n - k) contributions and its debt is zero.
const { expect } = require("chai");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySystem, createCircle, joinAll, runDraw, signersInPayoutOrder } = require("../helpers");
const { C, ROUND_AND_GRACE, State } = require("./attackHelpers");

/** Small deterministic generator (xorshift32), so every run checks the same patterns. */
function prng(seed) {
  let x = seed >>> 0 || 1;
  return () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 4294967296;
  };
}

// More patterns or another seed: INVARIANT_TRIALS=200 INVARIANT_SEED=7 npx hardhat test test/attacks/collusionInvariants.test.js
const TRIALS = Number(process.env.INVARIANT_TRIALS || 24);
const SEED = Number(process.env.INVARIANT_SEED || 20261125);

describe("Attack A8: colluding defaulters (random patterns, invariants)", function () {
  this.timeout(300000);

  it(`${TRIALS} random default patterns: 100% cover after every payout; nothing created, lost or stuck; honest members whole`, async function () {
    const sys = await deploySystem();
    const signers = [sys.alice, sys.bob, sys.carol, sys.dave, sys.eve];
    const rand = prng(SEED);
    let patternsWithUncoveredDebt = 0;

    for (let trial = 0; trial < TRIALS; trial++) {
      const n = trial % 2 === 0 ? 4 : 5;
      const members = signers.slice(0, n);
      const start = {};
      for (const m of members) start[m.address] = await sys.token.balanceOf(m.address);

      // maxDefaults is high on purpose: the same accounts default in earlier trials, and the join
      // rule is not what this test is about (attack A2 covers it).
      const circle = await createCircle(sys.factory, sys.organizer, { groupSize: BigInt(n), maxDefaults: 1000n });
      const addr = await circle.getAddress();
      await joinAll(circle, sys.token, sys.vault, members);
      await runDraw(circle, sys.payoutOrder, members);
      const ordered = await signersInPayoutOrder(circle, members);

      // views kept from the baseline getters still answer correctly
      expect(await circle.memberCount()).to.equal(BigInt(n));
      expect((await circle.getMembers()).length).to.equal(n);
      expect(await circle.roundStart()).to.be.gt(0n);
      expect(await circle.pauseExpiresAt()).to.equal(0n);
      for (const m of members) expect(await sys.payoutOrder.hasRevealed(addr, m.address)).to.equal(true);

      // About 40% of members are honest; the rest miss each round with probability 30% to 90%.
      const missP = members.map(() => (rand() < 0.4 ? 0 : 0.3 + 0.6 * rand()));
      const honest = members.filter((_, i) => missP[i] === 0);
      for (const m of members) await sys.token.connect(m).approve(addr, BigInt(n) * C);

      for (let r = 1; r <= n; r++) {
        let payers = 0;
        for (let i = 0; i < n; i++) {
          if (rand() < missP[i]) continue;
          await circle.connect(members[i]).contribute();
          payers++;
        }
        expect(await circle.paidCount(r)).to.equal(BigInt(payers));
        if (payers < n) await time.increase(ROUND_AND_GRACE + 1);
        const rc = await (await circle.settleRound()).wait();
        if (rc.logs.some((l) => circle.interface.parseLog(l)?.name === "DebtRecovered")) patternsWithUncoveredDebt++;

        // Invariant 1: right after its payout the recipient owes nothing and is 100% covered.
        const recipient = ordered[r - 1].address;
        expect(await circle.debtOf(recipient)).to.equal(0n);
        const expectedDeposit = r === n ? 0n : BigInt(n - r) * C; // the last settle releases everything
        expect(await sys.vault.collateralOf(addr, recipient)).to.equal(expectedDeposit);
      }

      // Invariant 2: the circle completes with no debt, no deficit and no locked deposit.
      expect(await circle.state()).to.equal(State.Completed);
      expect(await sys.vault.totalLocked(addr)).to.equal(0n);
      for (const m of members) {
        expect(await circle.debtOf(m.address)).to.equal(0n);
        expect(await circle.deficitOf(m.address)).to.equal(0n);
        if ((await circle.withdrawable(m.address)) > 0n) await circle.connect(m).claimPayout();
      }
      expect(await sys.token.balanceOf(addr)).to.equal(0n); // nothing stuck

      // Invariant 3: money is conserved; honest members end exactly whole; nobody ends ahead.
      let before = 0n;
      let after = 0n;
      for (const m of members) {
        const end = await sys.token.balanceOf(m.address);
        before += start[m.address];
        after += end;
        expect(end).to.be.lte(start[m.address]);
      }
      expect(after).to.equal(before);
      for (const m of honest) expect(await sys.token.balanceOf(m.address)).to.equal(start[m.address]);
    }
    // the generator really produced the hard case (uncovered misses repaid from a later pot)
    expect(patternsWithUncoveredDebt).to.be.greaterThan(0);
  });
});
