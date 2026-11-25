// Attack A3: payout order rigging.
// Attacker: a member (here a smart contract, DrawRigger) that wants the first slot, i.e. the
//           pot in round 1.
// Goal:     choose its slot instead of accepting the draw.
// Tries:    (1) reveal last and finalize in the same transaction, undoing both unless the slot
//           is right; (2) after revealing, finalize and undo unless the slot is right, retried
//           every block; (3) withhold its reveal; (4) copy someone's commitment; (5) commit
//           after seeing other secrets.
// Defence (Stage 3 fix S2 for 1 and 2): PayoutOrder.finalize must run in a later block than the
//           last reveal, and the shuffle seed uses the hash of the block that holds the last
//           reveal, so the order is fixed the moment that block exists and is the same whoever
//           finalizes and whenever. Commitments are bound to the member's address; withholding
//           a reveal gets the member removed with a one contribution penalty.
const { expect } = require("chai");
const { loadFixture, time, mine, takeSnapshot } = require("@nomicfoundation/hardhat-network-helpers");
const {
  C,
  DAY,
  State,
  deploySystemWith,
  deployContractMember,
  commitAll,
  contractSecret,
  revealAll,
  createCircle,
  joinAll,
  secretFor,
} = require("./attackHelpers");

async function joinedFixture() {
  const sys = await deploySystemWith("MockStablecoin");
  const circle = await createCircle(sys.factory, sys.organizer); // 4 members
  const rigger = await deployContractMember("DrawRigger", sys, circle);
  const humans = [sys.alice, sys.bob, sys.carol];
  await rigger.join();
  await joinAll(circle, sys.token, sys.vault, humans);
  return { ...sys, circle, rigger, humans, rig: await rigger.getAddress(), circleAddr: await circle.getAddress() };
}

/** Everyone committed and the three humans revealed: the rigger would be the last revealer. */
async function lastRevealerFixture() {
  const f = await joinedFixture();
  await commitAll(f.circle, f.payoutOrder, f.humans, [f.rigger]);
  await revealAll(f.circle, f.payoutOrder, f.humans);
  return f;
}

describe("Attack A3: payout order rigging", function () {
  it("the last revealer cannot reveal and finalize in one transaction to pick its slot", async function () {
    const f = await loadFixture(lastRevealerFixture);
    for (const wanted of [1, 2, 3, 4]) {
      await expect(f.rigger.revealFinalizeOrUndo(contractSecret(0), wanted)).to.be.revertedWith(
        "Order: finalize in a later block"
      );
      await mine(1);
    }
    // It has to reveal on its own, before anyone (itself included) can know the outcome.
    await f.rigger.reveal(contractSecret(0));
    await f.circle.finalizeDraw();
    expect(await f.circle.state()).to.equal(State.Active);
  });

  it("once the last reveal is mined the order is fixed: a later block or another caller gives the same order", async function () {
    const f = await loadFixture(lastRevealerFixture);
    await f.rigger.reveal(contractSecret(0));
    const snap = await takeSnapshot();
    await f.circle.connect(f.alice).finalizeDraw(); // finalized in the very next block
    const first = await f.circle.getPayoutOrder();
    await snap.restore();
    await mine(25);
    await time.increase(DAY);
    await f.circle.connect(f.outsider).finalizeDraw(); // 26 blocks and a day later, someone else
    expect(await f.circle.getPayoutOrder()).to.deep.equal(first);
  });

  it("grinding the finalize block does not help: an unlucky attacker stays unlucky", async function () {
    const f = await loadFixture(lastRevealerFixture);
    await f.rigger.reveal(contractSecret(0));
    const snap = await takeSnapshot();
    await f.circle.finalizeDraw();
    const fated = await f.circle.positionOf(f.rig);
    await snap.restore();

    const wanted = fated === 1n ? 2n : 1n;
    for (let i = 0; i < 12; i++) {
      await expect(f.rigger.finalizeOrUndo(wanted)).to.be.revertedWith("DrawRigger: unlucky, undo");
      await mine(1);
    }
    await f.circle.connect(f.outsider).finalizeDraw(); // the keeper finalizes as usual
    expect(await f.circle.positionOf(f.rig)).to.equal(fated);
  });

  it("withholding a reveal removes the attacker, costs one contribution and does not cancel the circle", async function () {
    const f = await loadFixture(lastRevealerFixture);
    const before = await f.token.balanceOf(f.rig);
    await time.increase(2 * DAY + 1); // reveal window over, the rigger never revealed
    await expect(f.circle.finalizeDraw()).to.emit(f.circle, "MemberRemoved").withArgs(f.rig, C);
    expect(await f.circle.state()).to.equal(State.Active);
    expect(await f.circle.participantCount()).to.equal(3n);
    expect(await f.circle.positionOf(f.rig)).to.equal(0n);
    expect(await f.token.balanceOf(f.rig)).to.equal(before + 3n * C - C); // deposit back minus penalty
    await expect(f.rigger.contribute()).to.be.revertedWithCustomError(f.circle, "AccessControlUnauthorizedAccount");
    // the penalty went to the three who revealed
    let credited = 0n;
    for (const h of f.humans) credited += await f.circle.withdrawable(h.address);
    expect(credited).to.equal(C);
  });

  it("a commitment copied from the mempool cannot be revealed by the copier", async function () {
    const f = await loadFixture(joinedFixture);
    const { payoutOrder, circleAddr, alice, bob } = f;
    const aliceC = await payoutOrder.computeCommitment(secretFor(alice), alice.address, circleAddr);
    await payoutOrder.connect(alice).commit(circleAddr, aliceC);
    await payoutOrder.connect(bob).commit(circleAddr, aliceC); // front run copy
    await payoutOrder.connect(f.carol).commit(circleAddr, await payoutOrder.computeCommitment(secretFor(f.carol), f.carol.address, circleAddr));
    await f.rigger.commit(contractSecret(0));
    await payoutOrder.connect(alice).reveal(circleAddr, secretFor(alice)); // alice's secret is now public
    await expect(payoutOrder.connect(bob).reveal(circleAddr, secretFor(alice))).to.be.revertedWith("Order: wrong secret");
  });

  it("nobody can see a secret before every commitment is in, or commit after the window", async function () {
    const f = await loadFixture(joinedFixture);
    const { payoutOrder, circleAddr, alice, bob } = f;
    await payoutOrder.connect(alice).commit(circleAddr, await payoutOrder.computeCommitment(secretFor(alice), alice.address, circleAddr));
    await expect(payoutOrder.connect(alice).reveal(circleAddr, secretFor(alice))).to.be.revertedWith(
      "Order: commit phase still open"
    );
    await time.increase(DAY + 1);
    await expect(
      payoutOrder.connect(bob).commit(circleAddr, await payoutOrder.computeCommitment(secretFor(bob), bob.address, circleAddr))
    ).to.be.revertedWith("Order: commit window closed");
  });
});
