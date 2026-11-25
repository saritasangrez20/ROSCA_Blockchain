// Attack A4: join and never pay (free rider), plus its variants.
// Attacker: a member who locks the join deposit and then pays nothing, in any slot.
// Goal:     receive a pot without paying, or make the others carry its share.
// Defence:  missed payments are slashed from the deposit; a member with no deposit left (the
//           last slot) gets a debt that is repaid out of its own pot before it is paid; anything
//           still owed at the end is taken from what remains of its deposit.
const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySystem } = require("../helpers");
const {
  C,
  DAY,
  State,
  balances,
  playRound,
  claimAll,
  activeCircleWithStart,
  createCircle,
  joinAll,
  secretFor,
} = require("./attackHelpers");

async function fixture() {
  return activeCircleWithStart(); // start = balances before joining
}

describe("Attack A4: join and never pay", function () {
  for (const k of [1, 2, 3, 4]) {
    it(`a free rider in slot ${k} pays nothing: honest members end whole, the free rider never ends ahead`, async function () {
      const f = await loadFixture(fixture);
      const rider = f.ordered[k - 1];
      const honest = f.members.filter((m) => m !== rider);
      for (let r = 1; r <= 4; r++) await playRound(f.circle, f.token, honest, { missing: true });
      expect(await f.circle.state()).to.equal(State.Completed);
      await claimAll(f.circle, f.members);

      const end = await balances(f.token, f.members);
      for (const m of honest) expect(end[m.address]).to.equal(f.start[m.address]);
      expect(end[rider.address]).to.be.lte(f.start[rider.address]);
      const addr = await f.circle.getAddress();
      expect(await f.token.balanceOf(addr)).to.equal(0n); // no money stuck
      expect(await f.vault.totalLocked(addr)).to.equal(0n);
      for (const m of f.members) {
        expect(await f.circle.debtOf(m.address)).to.equal(0n);
        expect(await f.circle.deficitOf(m.address)).to.equal(0n);
      }
      expect(await f.circle.defaultsInCircle(rider.address)).to.equal(4n);
    });
  }

  it("variant: join and walk away from the draw: removed, one contribution lost, circle continues", async function () {
    const sys = await deploySystem();
    const members = [sys.alice, sys.bob, sys.carol, sys.dave];
    const circle = await createCircle(sys.factory, sys.organizer);
    await joinAll(circle, sys.token, sys.vault, members);
    const start = await balances(sys.token, members);
    const addr = await circle.getAddress();
    for (const m of members) await sys.payoutOrder.connect(m).commit(addr, await sys.payoutOrder.computeCommitment(secretFor(m), m.address, addr));
    for (const m of members.slice(0, 3)) await sys.payoutOrder.connect(m).reveal(addr, secretFor(m));
    await time.increase(2 * DAY + 1);
    await circle.finalizeDraw();
    expect(await circle.state()).to.equal(State.Active);
    // dave got his deposit back minus one contribution
    expect(await sys.token.balanceOf(sys.dave.address)).to.equal(start[sys.dave.address] + 3n * C - C);
  });

  it("limitation (documented): a defaulter's fresh address passes the reputation check; the deposit is the real protection", async function () {
    const f = await loadFixture(fixture);
    const rider = f.ordered[0];
    await playRound(f.circle, f.token, f.members.filter((m) => m !== rider), { missing: true });
    expect(await f.reputation.isEligible(rider.address, 0)).to.equal(false);
    expect(await f.reputation.isEligible(f.eve.address, 0)).to.equal(true); // a new address has a clean record
  });
});
