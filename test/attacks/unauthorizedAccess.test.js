// Attack A5: unauthorized slash, fake circles and privilege abuse.
// Attackers: an outsider with a contract that pretends to be a circle; a compromised or
//            malicious registered circle; the organizer; the platform admin.
// Goal:      move someone else's deposit or pot, or write false records.
// Defence:   AccessControl roles on every module (only factory registered circles hold
//            CIRCLE_ROLE), per circle balances in the vault, no organizer or admin function
//            that moves funds, initialize callable once and only by the factory, and (Stage 3
//            fix S3) the deployer renounces the module admin role so no new registrar can
//            ever be added after deployment.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { activeCircle, defaultConfig } = require("../helpers");
const { deployAll } = require("../../scripts/deploy");
const { C } = require("./attackHelpers");

async function fixture() {
  const sys = await activeCircle();
  const fake = await ethers.deployContract("FakeCircle");
  return { ...sys, fake, circleAddr: await sys.circle.getAddress() };
}

describe("Attack A5: unauthorized access and fake circles", function () {
  it("a contract deployed outside the factory cannot slash, release, pull deposits, frame members or start draws", async function () {
    const f = await loadFixture(fixture);
    const victim = f.ordered[0].address;
    const role = await f.vault.CIRCLE_ROLE();
    const vault = await f.vault.getAddress();
    await expect(f.fake.stealCollateral(vault, victim, C))
      .to.be.revertedWithCustomError(f.vault, "AccessControlUnauthorizedAccount")
      .withArgs(await f.fake.getAddress(), role);
    await expect(f.fake.releaseTo(vault, victim, C)).to.be.revertedWithCustomError(f.vault, "AccessControlUnauthorizedAccount");
    await expect(f.fake.pullDeposit(vault, victim, C)).to.be.revertedWithCustomError(f.vault, "AccessControlUnauthorizedAccount");
    await expect(f.fake.frame(await f.reputation.getAddress(), victim)).to.be.revertedWithCustomError(
      f.reputation,
      "AccessControlUnauthorizedAccount"
    );
    await expect(f.fake.hijackDraw(await f.payoutOrder.getAddress(), [victim, f.alice.address])).to.be.revertedWithCustomError(
      f.payoutOrder,
      "AccessControlUnauthorizedAccount"
    );
    expect(await f.vault.collateralOf(f.circleAddr, victim)).to.equal(3n * C);
  });

  it("after scripts/deploy.js nobody, not even the deployer, can register a new circle by hand", async function () {
    const { admin, vault, payoutOrder, reputation, factory } = await deployAll();
    const [, , , , , , , outsider] = await ethers.getSigners();
    for (const m of [vault, payoutOrder, reputation]) {
      expect(await m.hasRole(await m.DEFAULT_ADMIN_ROLE(), admin.address)).to.equal(false);
      expect(await m.hasRole(await m.REGISTRAR_ROLE(), await factory.getAddress())).to.equal(true);
      await expect(m.connect(admin).grantRole(await m.REGISTRAR_ROLE(), admin.address)).to.be.revertedWithCustomError(
        m,
        "AccessControlUnauthorizedAccount"
      );
      await expect(m.connect(admin).registerCircle(outsider.address)).to.be.revertedWithCustomError(
        m,
        "AccessControlUnauthorizedAccount"
      );
    }
  });

  it("even a registered circle can only touch its own members' deposits", async function () {
    const f = await loadFixture(fixture);
    // In the test system the admin kept its role, so simulate a compromised registered circle.
    await f.vault.grantRole(await f.vault.REGISTRAR_ROLE(), f.admin.address);
    await f.vault.registerCircle(f.outsider.address);
    const victim = f.ordered[0].address;
    const taken = await f.vault.connect(f.outsider).slash.staticCall(victim, C);
    expect(taken).to.equal(0n); // balances are keyed by (circle, member)
    await f.vault.connect(f.outsider).slash(victim, C);
    expect(await f.vault.collateralOf(f.circleAddr, victim)).to.equal(3n * C);
    expect(await f.vault.totalLocked(f.circleAddr)).to.equal(6n * C);
  });

  it("the organizer has no path to the money", async function () {
    const f = await loadFixture(fixture);
    const { circle, organizer } = f;
    await expect(circle.connect(organizer).claimPayout()).to.be.revertedWith("Circle: nothing to claim");
    await expect(circle.connect(organizer).cancel()).to.be.revertedWith("Lifecycle: wrong state");
    await expect(circle.connect(organizer).pause()).to.be.revertedWithCustomError(circle, "AccessControlUnauthorizedAccount");
    await expect(circle.connect(organizer).contribute()).to.be.revertedWithCustomError(circle, "AccessControlUnauthorizedAccount");
    const mods = {
      token: await f.token.getAddress(),
      vault: await f.vault.getAddress(),
      payoutOrder: await f.payoutOrder.getAddress(),
      reputation: await f.reputation.getAddress(),
    };
    await expect(
      circle.connect(organizer).initialize(defaultConfig({ contribution: 1n }), mods, organizer.address, organizer.address)
    ).to.be.revertedWithCustomError(circle, "InvalidInitialization");
    await expect(f.vault.connect(organizer).release(f.alice.address, C)).to.be.revertedWithCustomError(
      f.vault,
      "AccessControlUnauthorizedAccount"
    );
  });

  it("the platform admin can pause, but cannot take or redirect money", async function () {
    const f = await loadFixture(fixture);
    const { circle, admin, token } = f;
    const before = await token.balanceOf(admin.address);
    await circle.connect(admin).pause();
    await expect(circle.connect(admin).claimPayout()).to.be.revertedWith("Circle: nothing to claim");
    await expect(circle.connect(admin).cancel()).to.be.revertedWith("Lifecycle: wrong state");
    expect(await token.balanceOf(admin.address)).to.equal(before);
    expect(await f.vault.totalLocked(f.circleAddr)).to.equal(6n * C);
  });

  it("circles are exact EIP 1167 clones of the factory's implementation, which nobody else can initialize", async function () {
    const f = await loadFixture(fixture);
    const impl = await f.factory.implementation();
    const code = await ethers.provider.getCode(f.circleAddr);
    const expected = `0x363d3d373d3d3d363d73${impl.slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
    expect(code.toLowerCase()).to.equal(expected);

    const implementation = await ethers.getContractAt("Circle", impl);
    const mods = {
      token: await f.token.getAddress(),
      vault: await f.vault.getAddress(),
      payoutOrder: await f.payoutOrder.getAddress(),
      reputation: await f.reputation.getAddress(),
    };
    await expect(
      implementation.connect(f.outsider).initialize(defaultConfig(), mods, f.outsider.address, f.outsider.address)
    ).to.be.revertedWith("Circle: only factory");
    expect(await f.factory.isCircle(impl)).to.equal(false); // not registered, so it can never touch the vault
  });
});
