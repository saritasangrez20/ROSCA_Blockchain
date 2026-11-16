const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  UNIT,
  DAY,
  defaultConfig,
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
async function openFixture() {
  const sys = await deploySystem();
  const circle = await createCircle(sys.factory, sys.organizer);
  return { ...sys, circle, members: [sys.alice, sys.bob, sys.carol, sys.dave] };
}
async function drawFixture() {
  const sys = await openFixture();
  await joinAll(sys.circle, sys.token, sys.vault, sys.members);
  return sys;
}

/** Plays round r: everyone in `members` except `skip` pays, then the round is settled. */
async function playRound(circle, token, members, skip = []) {
  await pay(circle, token, members.filter((m) => !skip.includes(m)));
  if (skip.length) await time.increase(ROUND_AND_GRACE + 1);
  return circle.settleRound();
}

describe("Circle: setup (initializer)", function () {
  it("can only be initialized once", async function () {
    const { circle, token, vault, payoutOrder, reputation, organizer, admin } = await loadFixture(openFixture);
    const mods = {
      token: await token.getAddress(),
      vault: await vault.getAddress(),
      payoutOrder: await payoutOrder.getAddress(),
      reputation: await reputation.getAddress(),
    };
    await expect(circle.initialize(defaultConfig(), mods, organizer.address, admin.address)).to.be.revertedWithCustomError(
      circle,
      "InvalidInitialization"
    );
  });

  it("only the deploying factory can initialize a circle", async function () {
    const { token, vault, payoutOrder, reputation, outsider } = await loadFixture(openFixture);
    const fresh = await ethers.deployContract("Circle"); // deployed by the test account, not by outsider
    const mods = {
      token: await token.getAddress(),
      vault: await vault.getAddress(),
      payoutOrder: await payoutOrder.getAddress(),
      reputation: await reputation.getAddress(),
    };
    await expect(
      fresh.connect(outsider).initialize(defaultConfig(), mods, outsider.address, outsider.address)
    ).to.be.revertedWith("Circle: only factory");
  });

  it("exposes a one call summary for the frontend", async function () {
    const { circle, organizer } = await loadFixture(openFixture);
    const s = await circle.getSummary();
    expect(s.state).to.equal(State.Open);
    expect(s.organizer).to.equal(organizer.address);
    expect(s.contribution).to.equal(C);
    expect(s.joinCollateral).to.equal(3n * C);
    expect(s.paused).to.equal(false);
  });
});

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

  it("rejects joining twice and joining a full circle", async function () {
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
    const { circle, token, eve } = await loadFixture(openFixture);
    await expect(circle.connect(eve).join()).to.be.revertedWithCustomError(token, "ERC20InsufficientAllowance");
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
      expect(await vault.collateralOf(addr, ordered[i].address)).to.equal(BigInt(3 - i) * C);
    }
  });

  it("cannot be finalized while the reveal window is open and someone has not revealed", async function () {
    const { circle, payoutOrder, members, dave } = await loadFixture(drawFixture);
    await runDraw(circle, payoutOrder, members, { finalize: false, skipReveal: [dave] });
    await expect(circle.finalizeDraw()).to.be.revertedWith("Order: reveal window still open");
  });

  it("removes a member who never reveals, charges a penalty and continues without them", async function () {
    const { circle, token, vault, reputation, payoutOrder, members, dave } = await loadFixture(drawFixture);
    const addr = await circle.getAddress();
    const daveBefore = await token.balanceOf(dave.address);
    await runDraw(circle, payoutOrder, members, { finalize: false, skipReveal: [dave] });
    await time.increase(2 * DAY + 1);
    await expect(circle.finalizeDraw()).to.emit(circle, "MemberRemoved").withArgs(dave.address, C);

    // circle goes on with three members
    expect(await circle.state()).to.equal(State.Active);
    expect(await circle.participantCount()).to.equal(3n);
    expect(await circle.isMember(dave.address)).to.equal(false);
    expect(await circle.removed(dave.address)).to.equal(true);

    // dave lost exactly one contribution, got the rest of his deposit back, and has a default
    expect(await token.balanceOf(dave.address)).to.equal(daveBefore + 3n * C - C);
    expect(await vault.collateralOf(addr, dave.address)).to.equal(0n);
    expect((await reputation.getRecord(dave.address)).defaults).to.equal(1n);

    // the penalty is shared by the three who revealed
    const order = await circle.getPayoutOrder();
    let credited = 0n;
    for (const a of order) credited += await circle.withdrawable(a);
    expect(credited).to.equal(C);

    // deposits now follow a 3 member circle: 2C, C, 0
    for (let i = 0; i < 3; i++) {
      expect(await vault.collateralOf(addr, order[i])).to.equal(BigInt(2 - i) * C);
    }
  });

  it("a removed member cannot pay into the rounds", async function () {
    const { circle, token, payoutOrder, members, dave } = await loadFixture(drawFixture);
    await runDraw(circle, payoutOrder, members, { finalize: false, skipReveal: [dave] });
    await time.increase(2 * DAY + 1);
    await circle.finalizeDraw();
    await token.connect(dave).approve(await circle.getAddress(), C);
    await expect(circle.connect(dave).contribute()).to.be.revertedWithCustomError(
      circle,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("the remaining members can run the whole circle after a removal", async function () {
    const { circle, token, payoutOrder, members, dave } = await loadFixture(drawFixture);
    await runDraw(circle, payoutOrder, members, { finalize: false, skipReveal: [dave] });
    await time.increase(2 * DAY + 1);
    await circle.finalizeDraw();
    const stayers = members.filter((m) => m !== dave);
    for (let r = 1; r <= 3; r++) {
      await playRound(circle, token, stayers);
      expect((await circle.rounds(r)).pot).to.equal(3n * C);
    }
    expect(await circle.state()).to.equal(State.Completed);
  });

  it("cancels with refunds when fewer than two members reveal", async function () {
    const { circle, token, vault, payoutOrder, members, alice, bob, carol, dave } = await loadFixture(drawFixture);
    const aliceBefore = await token.balanceOf(alice.address);
    await runDraw(circle, payoutOrder, members, { finalize: false, skipReveal: [bob, carol, dave] });
    await time.increase(2 * DAY + 1);
    await expect(circle.finalizeDraw()).to.emit(circle, "CircleCancelled");
    expect(await circle.state()).to.equal(State.Cancelled);
    expect(await vault.totalLocked(await circle.getAddress())).to.equal(0n);
    // alice gets her deposit back plus the three penalties
    expect(await token.balanceOf(alice.address)).to.equal(aliceBefore + 3n * C);
    expect(await circle.withdrawable(alice.address)).to.equal(3n * C);
    await circle.connect(alice).claimPayout();
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
    await playRound(circle, token, members);
    expect(await circle.currentRound()).to.equal(2n);
  });

  it("reports member details in one call", async function () {
    const { circle, token, members, ordered } = await loadFixture(activeFixture);
    await pay(circle, token, [ordered[0]]);
    const v = await circle.getMemberInfo(ordered[0].address);
    expect(v.isMember).to.equal(true);
    expect(v.position).to.equal(1n);
    expect(v.collateral).to.equal(3n * C);
    expect(v.paidThisRound).to.equal(true);
    void members;
  });
});

describe("Circle: defaults keep everyone else whole (W5)", function () {
  it("early recipient stops paying: deposit covers every missed month, all later pots are full", async function () {
    const { circle, token, vault, reputation, members, ordered } = await loadFixture(activeFixture);
    const addr = await circle.getAddress();
    const [first] = ordered;

    await playRound(circle, token, members); // round 1: first gets the pot
    for (let r = 2; r <= 4; r++) {
      await expect(playRound(circle, token, members, [first]))
        .to.emit(circle, "MemberDefaulted")
        .withArgs(r, first.address, C, 0n);
      expect((await circle.rounds(r)).pot).to.equal(4n * C);
      expect((await circle.rounds(r)).shortfall).to.equal(0n);
    }
    expect(await circle.state()).to.equal(State.Completed);
    expect(await vault.collateralOf(addr, first.address)).to.equal(0n);
    expect((await reputation.getRecord(first.address)).defaults).to.equal(3n);
    expect((await reputation.getRecord(first.address)).completed).to.equal(0n);
  });

  it("missing a month before your payout uses part of your deposit, which is refilled from your pot", async function () {
    const { circle, token, vault, members, ordered } = await loadFixture(activeFixture);
    const addr = await circle.getAddress();
    const [p1, p2] = ordered;

    // round 1: p2 skips; their deposit (2C) covers it, p1 still gets a full pot
    await playRound(circle, token, members, [p2]);
    expect((await circle.rounds(1)).pot).to.equal(4n * C);
    expect(await vault.collateralOf(addr, p2.address)).to.equal(C);

    // round 2: p2's own payout refills their deposit back to 2C first
    await expect(playRound(circle, token, members))
      .to.emit(circle, "CollateralRefilled")
      .withArgs(p2.address, C);
    expect(await vault.collateralOf(addr, p2.address)).to.equal(2n * C);
    expect(await circle.withdrawable(p2.address)).to.equal(3n * C);

    // rounds 3 and 4: p2 stops paying; the refilled deposit covers both, pots stay full
    const others = members.filter((m) => m !== p2);
    for (let r = 3; r <= 4; r++) {
      await playRound(circle, token, others, [p2]);
      expect((await circle.rounds(r)).pot).to.equal(4n * C);
    }
    expect(await circle.state()).to.equal(State.Completed);
    void p1;
  });

  it("a member with no deposit left repays missed months from their own later pot", async function () {
    const { circle, token, members, ordered } = await loadFixture(activeFixture);
    const [p1, p2, , p4] = ordered; // p4 is paid last, so keeps no deposit

    await playRound(circle, token, members, [p4]); // round 1: nothing to slash
    expect(await circle.withdrawable(p1.address)).to.equal(3n * C);
    expect(await circle.debtOf(p4.address)).to.equal(C);
    expect(await circle.deficitOf(p1.address)).to.equal(C);

    await playRound(circle, token, members); // round 2
    await playRound(circle, token, members); // round 3
    await expect(playRound(circle, token, members)) // round 4: p4's pot repays p1
      .to.emit(circle, "DebtRecovered")
      .withArgs(p4.address, C);
    expect(await circle.withdrawable(p4.address)).to.equal(3n * C);
    expect(await circle.withdrawable(p1.address)).to.equal(4n * C); // 3C pot + C repaid
    expect(await circle.debtOf(p4.address)).to.equal(0n);
    expect(await circle.deficitOf(p1.address)).to.equal(0n);
    void p2;
  });

  it("a member who skips their own payout round just receives less and keeps their deposit", async function () {
    const { circle, token, vault, members, ordered } = await loadFixture(activeFixture);
    const [p1] = ordered;
    await playRound(circle, token, members, [p1]);
    expect(await circle.withdrawable(p1.address)).to.equal(3n * C);
    expect(await circle.debtOf(p1.address)).to.equal(0n);
    expect(await vault.collateralOf(await circle.getAddress(), p1.address)).to.equal(3n * C);
  });

  it("a member with a past default cannot join a circle that allows none", async function () {
    const { circle, token, factory, organizer, vault, members, ordered, eve, outsider } = await loadFixture(activeFixture);
    await playRound(circle, token, members, [ordered[1]]);

    const next = await createCircle(factory, organizer, { groupSize: 3n });
    await joinAll(next, token, vault, [eve, outsider]);
    await token.connect(ordered[1]).approve(await vault.getAddress(), await next.joinCollateral());
    await expect(next.connect(ordered[1]).join()).to.be.revertedWith("Circle: too many past defaults");
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

  it("a round cannot be settled early while someone can still pay", async function () {
    const { circle, token, members } = await loadFixture(activeFixture);
    await pay(circle, token, members.slice(0, 3));
    await expect(circle.settleRound()).to.be.revertedWith("Circle: round still open");
  });

  it("nobody can claim money they were not credited, including the organizer", async function () {
    const { circle, token, members, ordered, organizer } = await loadFixture(activeFixture);
    await playRound(circle, token, members);
    await expect(circle.connect(organizer).claimPayout()).to.be.revertedWith("Circle: nothing to claim");
    await expect(circle.connect(ordered[1]).claimPayout()).to.be.revertedWith("Circle: nothing to claim");
    await circle.connect(ordered[0]).claimPayout();
    await expect(circle.connect(ordered[0]).claimPayout()).to.be.revertedWith("Circle: nothing to claim");
  });

  it("cannot contribute before the circle is active or finalize the draw early", async function () {
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

  it("a pause switches itself off after 7 days", async function () {
    const { circle, token, members, admin } = await loadFixture(activeFixture);
    await circle.connect(admin).pause();
    expect(await circle.paused()).to.equal(true);
    await time.increase(7 * DAY + 1);
    expect(await circle.paused()).to.equal(false);
    // still inside round 1's grace day, and the expired pause no longer blocks paying
    await pay(circle, token, [members[0]]);
    expect(await circle.hasPaid(1, members[0].address)).to.equal(true);
  });
});
