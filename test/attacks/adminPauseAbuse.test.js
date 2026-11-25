// Attack A6: admin pause abuse (found in Stage 3).
// Attacker: the platform admin (PAUSER_ROLE), malicious or careless.
// Goal:     hurt members without touching funds: pause through a payment deadline so nobody
//           can pay, let anyone settle the round, and every member is slashed and gets a
//           default on their public record. Or pause again and again to freeze a circle.
// Defence (Stage 3 fix S1): time spent paused is added to the current round's deadline, so a
//           pause can never make a member miss a payment; a new pause needs PAUSE_COOLDOWN of
//           unpaused time after the previous one ended, so pauses cannot be chained. Settling
//           a round that had already closed before the pause, claiming, finalizing the draw
//           and cancel refunds keep working while paused.
const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { activeCircle, deploySystem, runDraw } = require("../helpers");
const { C, DAY, ROUND_AND_GRACE, State, pay, createCircle, joinAll } = require("./attackHelpers");

async function fixture() {
  return activeCircle();
}

describe("Attack A6: admin pause abuse", function () {
  it("pausing through the payment deadline no longer forces members into default", async function () {
    const f = await loadFixture(fixture);
    const { circle, token, members, admin, reputation } = f;
    const deadline = await circle.roundDeadline();
    await time.increaseTo(deadline - 3600n); // one hour left to pay
    await circle.connect(admin).pause();
    await time.increase(3 * DAY); // the original deadline passes while nobody can pay
    expect(await time.latest()).to.be.gt(Number(deadline));
    await expect(circle.settleRound()).to.be.revertedWith("Circle: round still open");
    expect(await circle.roundDeadline()).to.be.gte(deadline + BigInt(3 * DAY));

    await circle.connect(admin).unpause();
    await pay(circle, token, members); // the hour members had left is still there
    await expect(circle.settleRound()).to.not.emit(circle, "MemberDefaulted");
    expect((await circle.rounds(1)).pot).to.equal(4n * C);
    for (const m of members) expect((await reputation.getRecord(m.address)).defaults).to.equal(0n);
  });

  it("a pause that runs out by itself also gives its full length back", async function () {
    const f = await loadFixture(fixture);
    const { circle, token, members, admin } = f;
    const deadline = await circle.roundDeadline();
    await time.increaseTo(deadline - 600n);
    await circle.connect(admin).pause();
    await time.increase(7 * DAY + 1); // expired, never unpaused
    expect(await circle.paused()).to.equal(false);
    expect(await circle.roundDeadline()).to.equal(deadline + BigInt(7 * DAY));
    await pay(circle, token, members);
    await expect(circle.settleRound()).to.not.emit(circle, "MemberDefaulted");
  });

  it("the admin cannot chain pauses to freeze a circle", async function () {
    const f = await loadFixture(fixture);
    const { circle, admin } = f;
    await circle.connect(admin).pause();
    await circle.connect(admin).unpause();
    await expect(circle.connect(admin).pause()).to.be.revertedWith("Lifecycle: pause cooldown");

    await time.increase(7 * DAY); // cooldown over
    await circle.connect(admin).pause();
    await time.increase(7 * DAY); // expires by itself...
    await expect(circle.connect(admin).pause()).to.be.revertedWith("Lifecycle: pause cooldown"); // ...no instant re-pause
    await time.increase(7 * DAY);
    await circle.connect(admin).pause();
    expect(await circle.paused()).to.equal(true);
  });

  it("a round that had already closed before the pause can still be settled during it", async function () {
    const f = await loadFixture(fixture);
    const { circle, token, ordered, admin } = f;
    await pay(circle, token, ordered.slice(0, 3)); // the last slot misses round 1
    await time.increase(ROUND_AND_GRACE + 60);
    await circle.connect(admin).pause(); // too late to protect anyone
    await expect(circle.settleRound()).to.emit(circle, "MemberDefaulted");
  });

  it("pause never traps money: claims, the draw and cancel refunds all work while paused", async function () {
    const f = await loadFixture(fixture);
    const { circle, token, members, ordered, admin } = f;
    await pay(circle, token, members);
    await circle.settleRound(); // everyone paid: settling is not blocked
    await circle.connect(admin).pause();
    await circle.connect(ordered[0]).claimPayout();

    const sys = await deploySystem();
    const open = await createCircle(sys.factory, sys.organizer);
    await joinAll(open, sys.token, sys.vault, [sys.alice, sys.bob]);
    await open.connect(sys.admin).pause();
    const before = await sys.token.balanceOf(sys.alice.address);
    await open.connect(sys.organizer).cancel();
    expect(await sys.token.balanceOf(sys.alice.address)).to.equal(before + 3n * C);

    const drawing = await createCircle(sys.factory, sys.organizer);
    const four = [sys.alice, sys.bob, sys.carol, sys.dave];
    await joinAll(drawing, sys.token, sys.vault, four);
    await drawing.connect(sys.admin).pause();
    await runDraw(drawing, sys.payoutOrder, four, { finalize: false });
    await drawing.finalizeDraw();
    expect(await drawing.state()).to.equal(State.Active);
  });
});
