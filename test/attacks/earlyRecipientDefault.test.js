// Attack A2: early recipient default ("take the pot and run").
// Attacker: a member drawn into an early slot.
// Goal:     receive the whole pot, stop paying, and leave the others short.
// Defence:  after their payout a member's deposit always equals 100% of what they still owe
//           (CollateralVault.requiredCollateral), and settleRound slashes it for every missed
//           round, so every later pot is still full.
const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { C, State, balances, playRound, claimAll, activeCircleWithStart, createCircle, joinAll } = require("./attackHelpers");

async function fixture() {
  return activeCircleWithStart(); // start = balances before joining
}

/** The member at payout slot `k` takes the pot in round k and pays nothing afterwards. */
async function runAway(k) {
  const f = await loadFixture(fixture);
  const runner = f.ordered[k - 1];
  const honest = f.members.filter((m) => m !== runner);

  for (let r = 1; r <= 4; r++) {
    const stillPaying = r <= k;
    const tx = await playRound(f.circle, f.token, stillPaying ? f.members : honest, { missing: !stillPaying });
    if (!stillPaying) {
      await expect(tx).to.emit(f.circle, "MemberDefaulted").withArgs(r, runner.address, C, 0n); // fully covered
    }
    const res = await f.circle.rounds(r);
    expect(res.pot).to.equal(4n * C); // every pot is full
    expect(res.shortfall).to.equal(0n);
  }
  expect(await f.circle.state()).to.equal(State.Completed);
  await claimAll(f.circle, f.members);
  return { ...f, runner, honest };
}

describe("Attack A2: early recipient takes the pot and stops paying", function () {
  for (const k of [1, 2, 3]) {
    it(`slot ${k} runs after its payout: honest members end exactly whole, the runner gains nothing`, async function () {
      const f = await runAway(k);
      const end = await balances(f.token, f.members);
      for (const m of f.honest) expect(end[m.address]).to.equal(f.start[m.address]);
      // The runner received 4C but lost exactly what it skipped from its deposit: zero profit.
      expect(end[f.runner.address]).to.equal(f.start[f.runner.address]);
      // Nothing is left behind in the circle or the vault.
      const addr = await f.circle.getAddress();
      expect(await f.token.balanceOf(addr)).to.equal(0n);
      expect(await f.vault.totalLocked(addr)).to.equal(0n);
      // The defaults are on the record, so circles that allow none will refuse the runner.
      const rec = await f.reputation.getRecord(f.runner.address);
      expect(rec.defaults).to.equal(BigInt(4 - k));
      expect(rec.completed).to.equal(0n);
    });
  }

  it("the runner is refused by the next circle that allows no past defaults", async function () {
    const f = await runAway(1);
    const next = await createCircle(f.factory, f.organizer, { groupSize: 3n });
    await joinAll(next, f.token, f.vault, [f.eve, f.outsider]);
    await f.token.connect(f.runner).approve(await f.vault.getAddress(), await next.joinCollateral());
    await expect(next.connect(f.runner).join()).to.be.revertedWith("Circle: too many past defaults");
  });
});
