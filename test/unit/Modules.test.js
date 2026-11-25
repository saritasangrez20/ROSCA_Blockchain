const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { UNIT, DAY, deploySystem, createCircle, joinAll, secretFor } = require("../helpers");

async function systemFixture() {
  return deploySystem();
}

describe("MockStablecoin", function () {
  it("uses 6 decimals and gives faucet money to anyone", async function () {
    const { token, outsider } = await loadFixture(systemFixture);
    expect(await token.decimals()).to.equal(6);
    const before = await token.balanceOf(outsider.address);
    await token.connect(outsider).faucet();
    expect(await token.balanceOf(outsider.address)).to.equal(before + 100_000n * UNIT);
  });

  it("only the owner can mint arbitrary amounts", async function () {
    const { token, outsider } = await loadFixture(systemFixture);
    await expect(token.connect(outsider).mint(outsider.address, 1n)).to.be.revertedWithCustomError(
      token,
      "OwnableUnauthorizedAccount"
    );
  });
});

describe("CollateralVault", function () {
  it("computes collateral as 100% of what a position still owes after payout", async function () {
    const { vault } = await loadFixture(systemFixture);
    const c = 1_000n * UNIT;
    // 4 members: slot 1 owes 3 more payments, slot 4 owes none
    expect(await vault.requiredCollateral(c, 4, 1)).to.equal(3n * c);
    expect(await vault.requiredCollateral(c, 4, 2)).to.equal(2n * c);
    expect(await vault.requiredCollateral(c, 4, 4)).to.equal(0n);
  });

  it("rejects an impossible position", async function () {
    const { vault } = await loadFixture(systemFixture);
    await expect(vault.requiredCollateral(1, 4, 0)).to.be.revertedWith("Vault: bad position");
    await expect(vault.requiredCollateral(1, 4, 5)).to.be.revertedWith("Vault: bad position");
  });

  it("a circle can only take deposits from the member or from itself", async function () {
    const { vault, token, admin, outsider, alice, bob } = await loadFixture(systemFixture);
    // make `outsider` act as a registered circle for this test
    await vault.grantRole(await vault.REGISTRAR_ROLE(), admin.address);
    await vault.registerCircle(outsider.address);
    await token.connect(alice).approve(await vault.getAddress(), 10n * UNIT);
    await expect(vault.connect(outsider).deposit(alice.address, bob.address, 10n * UNIT)).to.be.revertedWith(
      "Vault: payer must be member or circle"
    );
    await vault.connect(outsider).deposit(alice.address, alice.address, 10n * UNIT);
    expect(await vault.collateralOf(outsider.address, alice.address)).to.equal(10n * UNIT);
  });

  it("only registered circles can deposit, release or slash", async function () {
    const { vault, outsider, alice } = await loadFixture(systemFixture);
    const role = await vault.CIRCLE_ROLE();
    await expect(vault.connect(outsider).slash(alice.address, 1))
      .to.be.revertedWithCustomError(vault, "AccessControlUnauthorizedAccount")
      .withArgs(outsider.address, role);
    await expect(vault.connect(outsider).release(alice.address, 1)).to.be.revertedWithCustomError(
      vault,
      "AccessControlUnauthorizedAccount"
    );
    await expect(vault.connect(outsider).deposit(alice.address, alice.address, 1)).to.be.revertedWithCustomError(
      vault,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("only the registrar (factory) can register circles", async function () {
    const { vault, outsider } = await loadFixture(systemFixture);
    await expect(vault.connect(outsider).registerCircle(outsider.address)).to.be.revertedWithCustomError(
      vault,
      "AccessControlUnauthorizedAccount"
    );
  });
});

describe("ReputationRegistry", function () {
  it("outsiders cannot write records", async function () {
    const { reputation, outsider, alice } = await loadFixture(systemFixture);
    await expect(reputation.connect(outsider).recordDefault(alice.address)).to.be.revertedWithCustomError(
      reputation,
      "AccessControlUnauthorizedAccount"
    );
    await expect(reputation.connect(outsider).registerCircle(outsider.address)).to.be.revertedWithCustomError(
      reputation,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("records joins (counters on chain, history as events) and reports eligibility", async function () {
    const { reputation, factory, organizer, token, vault, alice, bob } = await loadFixture(systemFixture);
    const circle = await createCircle(factory, organizer, { groupSize: 3n });
    const circleAddr = await circle.getAddress();
    await token.connect(alice).approve(await vault.getAddress(), await circle.joinCollateral());
    // Stage 3 (gas G4): the history entry is the ReputationUpdated event; the indexer stores it.
    await expect(circle.connect(alice).join())
      .to.emit(reputation, "ReputationUpdated")
      .withArgs(alice.address, circleAddr, 0); // EntryKind.Joined
    await joinAll(circle, token, vault, [bob]);
    const rec = await reputation.getRecord(alice.address);
    expect(rec.joined).to.equal(1n);
    expect(rec.defaults).to.equal(0n);
    const events = await reputation.queryFilter(reputation.filters.ReputationUpdated(alice.address));
    expect(events.length).to.equal(1);
    expect(events[0].args.circle).to.equal(circleAddr);
    expect(await reputation.isEligible(alice.address, 0)).to.equal(true);
  });
});

describe("PayoutOrder", function () {
  async function fullCircleFixture() {
    const sys = await deploySystem();
    const members = [sys.alice, sys.bob, sys.carol, sys.dave];
    const circle = await createCircle(sys.factory, sys.organizer);
    await joinAll(circle, sys.token, sys.vault, members);
    return { ...sys, circle, members, circleAddr: await circle.getAddress() };
  }

  it("starts the draw automatically when the circle fills", async function () {
    const { payoutOrder, circleAddr } = await loadFixture(fullCircleFixture);
    const d = await payoutOrder.getDraw(circleAddr);
    expect(d.started).to.equal(true);
    expect(d.memberCount).to.equal(4n);
  });

  it("rejects commits from non members and double commits", async function () {
    const { payoutOrder, circleAddr, alice, outsider } = await loadFixture(fullCircleFixture);
    const c = await payoutOrder.computeCommitment(secretFor(alice), alice.address, circleAddr);
    await expect(payoutOrder.connect(outsider).commit(circleAddr, c)).to.be.revertedWith("Order: not a member");
    await payoutOrder.connect(alice).commit(circleAddr, c);
    await expect(payoutOrder.connect(alice).commit(circleAddr, c)).to.be.revertedWith("Order: already committed");
  });

  it("does not allow reveals while others can still commit", async function () {
    const { payoutOrder, circleAddr, alice } = await loadFixture(fullCircleFixture);
    const c = await payoutOrder.computeCommitment(secretFor(alice), alice.address, circleAddr);
    await payoutOrder.connect(alice).commit(circleAddr, c);
    await expect(payoutOrder.connect(alice).reveal(circleAddr, secretFor(alice))).to.be.revertedWith(
      "Order: commit phase still open"
    );
  });

  it("rejects a wrong secret and a copied commitment", async function () {
    const { payoutOrder, circleAddr, members, alice, bob } = await loadFixture(fullCircleFixture);
    // bob copies alice's commitment: it is bound to alice's address, so bob can never reveal it
    const aliceC = await payoutOrder.computeCommitment(secretFor(alice), alice.address, circleAddr);
    await payoutOrder.connect(alice).commit(circleAddr, aliceC);
    await payoutOrder.connect(bob).commit(circleAddr, aliceC);
    for (const m of members.slice(2)) {
      await payoutOrder.connect(m).commit(circleAddr, await payoutOrder.computeCommitment(secretFor(m), m.address, circleAddr));
    }
    await expect(payoutOrder.connect(bob).reveal(circleAddr, secretFor(alice))).to.be.revertedWith("Order: wrong secret");
    await expect(payoutOrder.connect(alice).reveal(circleAddr, secretFor(bob))).to.be.revertedWith("Order: wrong secret");
  });

  it("closes the commit window after its deadline", async function () {
    const { payoutOrder, circleAddr, alice } = await loadFixture(fullCircleFixture);
    await time.increase(DAY + 1);
    const c = await payoutOrder.computeCommitment(secretFor(alice), alice.address, circleAddr);
    await expect(payoutOrder.connect(alice).commit(circleAddr, c)).to.be.revertedWith("Order: commit window closed");
  });

  it("only a registered circle can start or finalize a draw", async function () {
    const { payoutOrder, outsider, alice, bob } = await loadFixture(fullCircleFixture);
    await expect(payoutOrder.connect(outsider).startDraw([alice.address, bob.address], DAY)).to.be.revertedWithCustomError(
      payoutOrder,
      "AccessControlUnauthorizedAccount"
    );
    await expect(payoutOrder.connect(outsider).finalize()).to.be.revertedWithCustomError(
      payoutOrder,
      "AccessControlUnauthorizedAccount"
    );
  });
});

describe("CircleFactory", function () {
  it("creates a circle, makes the caller organizer and registers it everywhere", async function () {
    const { factory, organizer, vault, payoutOrder, reputation } = await loadFixture(systemFixture);
    const circle = await createCircle(factory, organizer);
    const addr = await circle.getAddress();
    expect(await factory.isCircle(addr)).to.equal(true);
    expect(await factory.circleCount()).to.equal(1n);
    expect(await factory.getCirclesByOrganizer(organizer.address)).to.deep.equal([addr]);
    expect(await circle.organizer()).to.equal(organizer.address);
    expect(await circle.hasRole(await circle.ORGANIZER_ROLE(), organizer.address)).to.equal(true);
    expect(await vault.hasRole(await vault.CIRCLE_ROLE(), addr)).to.equal(true);
    expect(await payoutOrder.hasRole(await payoutOrder.CIRCLE_ROLE(), addr)).to.equal(true);
    expect(await reputation.hasRole(await reputation.CIRCLE_ROLE(), addr)).to.equal(true);
    expect(await circle.state()).to.equal(0n); // Open
  });

  it("rejects invalid settings", async function () {
    const { factory, organizer } = await loadFixture(systemFixture);
    const { defaultConfig } = require("../helpers");
    await expect(factory.connect(organizer).createCircle(defaultConfig({ groupSize: 1n }))).to.be.revertedWith(
      "Circle: bad group size"
    );
    await expect(factory.connect(organizer).createCircle(defaultConfig({ groupSize: 21n }))).to.be.revertedWith(
      "Circle: bad group size"
    );
    await expect(factory.connect(organizer).createCircle(defaultConfig({ contribution: 0n }))).to.be.revertedWith(
      "Circle: zero contribution"
    );
    await expect(factory.connect(organizer).createCircle(defaultConfig({ termsCid: "" }))).to.be.revertedWith(
      "Circle: missing terms"
    );
    await expect(factory.connect(organizer).createCircle(defaultConfig({ roundDuration: 0n }))).to.be.revertedWith(
      "Circle: zero duration"
    );
  });
});
