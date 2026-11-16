const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  UNIT,
  DAY,
  deploySystem,
  createCircle,
  joinAll,
  runDraw,
  signersInPayoutOrder,
  pay,
  activeCircle,
} = require("../helpers");

const State = { Open: 0n, OrderDraw: 1n, Active: 2n, Completed: 3n, Cancelled: 4n };
const C = 1_000n * UNIT; // contribution in the default config
const ROUND_AND_GRACE = 8 * DAY;

async function activeFixture() {
  return activeCircle();
}
async function activeNoCollateralFixture() {
  return activeCircle({ coverageBps: 0n });
}
async function openFixture() {
  const sys = await deploySystem();
  const circle = await createCircle(sys.factory, sys.organizer);
  return { ...sys, circle, members: [sys.alice, sys.bob, sys.carol, sys.dave] };
}

describe("Circle: join (W2)", function () {
  it("locks the slot 1 collateral in the vault when a member joins", async function () {
    const { circle, token, vault, alice } = await loadFixture(openFixture);
    expect(await circle.joinCollateral()).to.equal(3n * C);
    const before = await token.balanceOf(alice.address);
    await joinAll(circle, token, vault, [alice]);
    expect(await token.balanceOf(alice.address)).to.equal(before - 3n * C);
    expect(await vault.collateralOf(await circle.getAddress(), alice.address)).to.equal(3n * C);
    expect(await circle.isMember(alice.address)).to.equal(true);
  });

  it("moves to the order draw when the last member joins", async function () {
    const { circle, token, vault, members } = await loadFixture(openFixture);
    await joinAll(circle, token, vault, members.slice(0, 3));
    expect(await circle.state()).to.equal(State.Open);
    await token.connect(members[3]).approve(await vault.getAddress(), await circle.joinCollateral());
    await expect(circle.connect(members[3]).join())
      .to.emit(circle, "StateChanged")
      .withArgs(State.Open, State.OrderDraw);
  });

  it("rejects joining twice, joining a full circle and joining after the deadline", async function () {
    const { circle, token, vault, members, eve } = await loadFixture(openFixture);
    await joinAll(circle, token, vault, [members[0]]);
    await expect(circle.connect(members[0]).join()).to.be.revertedWith("Circle: already a member");
    await joinAll(circle, token, vault, members.slice(1));
    await expect(circle.connect(eve).join()).to.be.revertedWith("Lifecycle: wrong state");
  });

  it("rejects joining after the join deadline", async function () {
    const { circle, eve } = await loadFixture(openFixture);
    await time.increase(3 * DAY + 1);
    await expect(circle.connect(eve).join()).to.be.revertedWith("Circle: joining closed");
  });

  it("fails cleanly when the member did not approve the collateral", async function () {
    const { circle, vault, eve } = await loadFixture(openFixture);
    await expect(circle.connect(eve).join()).to.be.revertedWithCustomError(
      await ethers.getContractAt("MockStablecoin", await vault.token()),
      "ERC20InsufficientAllowance"
    );
  });
});

describe("Circle: payout order draw (W3)", function () {
  it("sets a full order and refunds collateral later slots do not need", async function () {
    const { circle, vault, ordered } = await loadFixture(activeFixture);
    const addr = await circle.getAddress();
    expect(await circle.state()).to.equal(State.Active);
    expect(await circle.currentRound()).to.equal(1n);
    for (let i = 0; i < 4; i++) {
      expect(await circle.positionOf(ordered[i].address)).to.equal(BigInt(i + 1));
      // slot k keeps (4 - k) contributions locked
      expect(await vault.collateralOf(addr, ordered[i].address)).to.equal(BigInt(3 - i) * C);
    }
  });

  it("cancels with full refunds and records a default when someone never reveals", async function () {
    const sys = await deploySystem();
    const members = [sys.alice, sys.bob, sys.carol, sys.dave];
    const circle = await createCircle(sys.factory, sys.organizer);
    const before = await sys.token.balanceOf(sys.alice.address);
    await joinAll(circle, sys.token, sys.vault, members);
    await runDraw(circle, sys.payoutOrder, members, { finalize: false, skipReveal: [sys.dave] });

    await expect(circle.finalizeDraw()).to.be.revertedWith("Order: reveal window still open");
    await time.increase(2 * DAY + 1);
    await expect(circle.finalizeDraw()).to.emit(circle, "CircleCancelled");

    expect(await circle.state()).to.equal(State.Cancelled);
    expect(await sys.token.balanceOf(sys.alice.address)).to.equal(before);
    expect(await sys.vault.totalLocked(await circle.getAddress())).to.equal(0n);
    expect((await sys.reputation.getRecord(sys.dave.address)).defaults).to.equal(1n);
    expect((await sys.reputation.getRecord(sys.alice.address)).defaults).to.equal(0n);
  });
});

describe("Circle: full happy path (W4, W5, W6, W7)", function () {
  it("runs every round, pays each member the pot once and returns all collateral", async function () {
    const { circle, token, vault, reputation, members, ordered } = await loadFixture(activeFixture);
    const addr = await circle.getAddress();
    const start = {};
    const locked = {};
    for (const m of members) {
      start[m.address] = await token.balanceOf(m.address);
      locked[m.address] = await vault.collateralOf(addr, m.address);
    }

    for (let r = 1; r <= 4; r++) {
      await pay(circle, token, members);
      await expect(circle.settleRound())
        .to.emit(circle, "RoundSettled")
        .withArgs(r, ordered[r - 1].address, 4n * C, 0n);
      await circle.connect(ordered[r - 1]).claimPayout();
    }

    expect(await circle.state()).to.equal(State.Completed);
    expect(await vault.totalLocked(addr)).to.equal(0n);
    expect(await token.balanceOf(addr)).to.equal(0n);
    for (const m of members) {
      // paid 4C, received 4C, and the collateral still locked comes back
      expect(await token.balanceOf(m.address)).to.equal(start[m.address] + locked[m.address]);
      expect((await reputation.getRecord(m.address)).completed).to.equal(1n);
    }
  });

  it("allows a member to pay during the grace period", async function () {
    const { circle, token, members } = await loadFixture(activeFixture);
    await time.increase(7 * DAY + 60); // past the round, inside the 1 day grace
    await pay(circle, token, [members[0]]);
    expect(await circle.hasPaid(1, members[0].address)).to.equal(true);
  });

  it("settles early once everyone has paid, without waiting for the deadline", async function () {
    const { circle, token, members } = await loadFixture(activeFixture);
    await pay(circle, token, members);
    await circle.settleRound();
    expect(await circle.currentRound()).to.equal(2n);
  });
});

describe("Circle: defaults (W5 security)", function () {
  it("early recipient stops paying: collateral is slashed and the next recipient still gets a full pot", async function () {
    const { circle, token, vault, reputation, members, ordered } = await loadFixture(activeFixture);
    const addr = await circle.getAddress();
    const [first, second] = ordered;

    // round 1: everyone pays, first recipient takes the pot
    await pay(circle, token, members);
    await circle.settleRound();
    await circle.connect(first).claimPayout();

    // round 2: the first recipient disappears
    await pay(circle, token, members.filter((m) => m !== first));
    await expect(circle.settleRound()).to.be.revertedWith("Circle: round still open");
    await time.increase(ROUND_AND_GRACE + 1);
    await expect(circle.settleRound())
      .to.emit(circle, "MemberDefaulted")
      .withArgs(2, first.address, C, 0n);

    expect((await circle.rounds(2)).pot).to.equal(4n * C);
    expect(await circle.withdrawable(second.address)).to.equal(4n * C);
    expect(await vault.collateralOf(addr, first.address)).to.equal(2n * C);
    expect((await reputation.getRecord(first.address)).defaults).to.equal(1n);
  });

  it("a defaulter with no collateral repays from their own later pot", async function () {
    const { circle, token, members, ordered } = await loadFixture(activeNoCollateralFixture);
    const [p1, , p3] = ordered;

    // round 1: slot 3 member skips; nothing to slash, so p1 is shortchanged by C
    await pay(circle, token, members.filter((m) => m !== p3));
    await time.increase(ROUND_AND_GRACE + 1);
    await circle.settleRound();
    expect(await circle.withdrawable(p1.address)).to.equal(3n * C);
    expect(await circle.debtOf(p3.address)).to.equal(C);
    expect(await circle.deficitOf(p1.address)).to.equal(C);

    // round 2: all pay
    await pay(circle, token, members);
    await circle.settleRound();

    // round 3: p3's own pot repays the debt to p1 first
    await pay(circle, token, members);
    await expect(circle.settleRound()).to.emit(circle, "DebtRecovered").withArgs(p3.address, C);
    expect(await circle.withdrawable(p3.address)).to.equal(3n * C);
    expect(await circle.withdrawable(p1.address)).to.equal(4n * C); // 3C pot + C repaid
    expect(await circle.debtOf(p3.address)).to.equal(0n);
    expect(await circle.deficitOf(p1.address)).to.equal(0n);
  });

  it("a member who skips their own payout round just receives less", async function () {
    const { circle, token, members, ordered } = await loadFixture(activeNoCollateralFixture);
    const [p1] = ordered;
    await pay(circle, token, members.filter((m) => m !== p1));
    await time.increase(ROUND_AND_GRACE + 1);
    await circle.settleRound();
    expect(await circle.withdrawable(p1.address)).to.equal(3n * C);
    expect(await circle.debtOf(p1.address)).to.equal(0n);
  });

  it("a member with a past default cannot join a circle that allows none", async function () {
    const { circle, token, factory, organizer, vault, members, ordered, eve, outsider } = await loadFixture(activeFixture);
    await pay(circle, token, members.filter((m) => m !== ordered[0]));
    await time.increase(ROUND_AND_GRACE + 1);
    await circle.settleRound();

    const next = await createCircle(factory, organizer, { groupSize: 3n });
    await joinAll(next, token, vault, [eve, outsider]);
    await token.connect(ordered[0]).approve(await vault.getAddress(), await next.joinCollateral());
    await expect(next.connect(ordered[0]).join()).to.be.revertedWith("Circle: too many past defaults");
  });
});

describe("Circle: cancel (W8)", function () {
  it("organizer can cancel while open and everyone is refunded", async function () {
    const { circle, token, vault, alice, bob, organizer } = await loadFixture(openFixture);
    const before = await token.balanceOf(alice.address);
    await joinAll(circle, token, vault, [alice, bob]);
    await circle.connect(organizer).cancel();
    expect(await circle.state()).to.equal(State.Cancelled);
    expect(await token.balanceOf(alice.address)).to.equal(before);
  });

  it("others can cancel only after the join deadline", async function () {
    const { circle, token, vault, alice, outsider } = await loadFixture(openFixture);
    await joinAll(circle, token, vault, [alice]);
    await expect(circle.connect(outsider).cancel()).to.be.revertedWith("Circle: only organizer before deadline");
    await time.increase(3 * DAY + 1);
    await circle.connect(outsider).cancel();
    expect(await circle.state()).to.equal(State.Cancelled);
  });

  it("cannot cancel a circle that is already running", async function () {
    const { circle, organizer } = await loadFixture(activeFixture);
    await expect(circle.connect(organizer).cancel()).to.be.revertedWith("Lifecycle: wrong state");
  });
});

describe("Circle: unauthorized and invalid actions", function () {
  it("non members cannot contribute", async function () {
    const { circle, token, outsider } = await loadFixture(activeFixture);
    await token.connect(outsider).approve(await circle.getAddress(), C);
    await expect(circle.connect(outsider).contribute()).to.be.revertedWithCustomError(
      circle,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("members cannot pay twice in one round or after the round closes", async function () {
    const { circle, token, members } = await loadFixture(activeFixture);
    await pay(circle, token, [members[0]]);
    await expect(pay(circle, token, [members[0]])).to.be.revertedWith("Circle: already paid this round");
    await time.increase(ROUND_AND_GRACE + 1);
    await expect(pay(circle, token, [members[1]])).to.be.revertedWith("Circle: round closed");
  });

  it("nobody can claim money they were not credited, including the organizer", async function () {
    const { circle, token, members, ordered, organizer } = await loadFixture(activeFixture);
    await pay(circle, token, members);
    await circle.settleRound();
    await expect(circle.connect(organizer).claimPayout()).to.be.revertedWith("Circle: nothing to claim");
    await expect(circle.connect(ordered[1]).claimPayout()).to.be.revertedWith("Circle: nothing to claim");
    await circle.connect(ordered[0]).claimPayout();
    await expect(circle.connect(ordered[0]).claimPayout()).to.be.revertedWith("Circle: nothing to claim");
  });

  it("cannot contribute before the circle is active or finalize the draw twice", async function () {
    const { circle, token, vault, members } = await loadFixture(openFixture);
    await joinAll(circle, token, vault, [members[0]]);
    await expect(pay(circle, token, [members[0]])).to.be.revertedWith("Lifecycle: wrong state");
    await expect(circle.finalizeDraw()).to.be.revertedWith("Lifecycle: wrong state");
  });
});

describe("Circle: emergency pause", function () {
  it("only the platform admin can pause", async function () {
    const { circle, organizer } = await loadFixture(activeFixture);
    await expect(circle.connect(organizer).pause()).to.be.revertedWithCustomError(
      circle,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("pause blocks paying but never blocks settling or withdrawing", async function () {
    const { circle, token, members, ordered, admin } = await loadFixture(activeFixture);
    await pay(circle, token, members);
    await circle.connect(admin).pause();
    await circle.settleRound();
    await circle.connect(ordered[0]).claimPayout();
    await token.connect(members[0]).approve(await circle.getAddress(), C);
    await expect(circle.connect(members[0]).contribute()).to.be.revertedWithCustomError(circle, "EnforcedPause");
    await circle.connect(admin).unpause();
    await circle.connect(members[0]).contribute();
  });
});
