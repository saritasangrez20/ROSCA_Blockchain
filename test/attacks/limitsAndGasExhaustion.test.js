// Attack A9: oversized settings and gas exhaustion.
// Attacker: an organizer choosing extreme settings, or members making every loop as long as
//           possible.
// Goal:     (1) values that silently wrap around in the packed storage of gas optimization G2
//           (a huge contribution stored as a tiny one); (2) a round so expensive to settle that
//           it no longer fits in a block, freezing the circle.
// Defence:  initialize rejects any value that does not fit its packed field; MAX_MEMBERS = 20
//           bounds every loop, and the worst case stays far below the block gas limit.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySystem, defaultConfig, createCircle, joinAll, runDraw } = require("../helpers");
const { UNIT, DAY, State } = require("./attackHelpers");

const U64 = 2n ** 64n;
const U32 = 2n ** 32n;
const U16 = 2n ** 16n;

describe("Attack A9: oversized settings and gas exhaustion", function () {
  it("values that would not fit the packed storage are rejected instead of truncated", async function () {
    const { factory, organizer } = await loadFixture(deploySystem);
    const create = (o) => factory.connect(organizer).createCircle(defaultConfig(o));
    await expect(create({ contribution: U64 })).to.be.revertedWith("Circle: contribution too large");
    await expect(create({ roundDuration: U32 })).to.be.revertedWith("Circle: duration too long");
    await expect(create({ gracePeriod: U32 })).to.be.revertedWith("Circle: duration too long");
    await expect(create({ joinDuration: U32 })).to.be.revertedWith("Circle: duration too long");
    await expect(create({ drawPhaseDuration: U32 })).to.be.revertedWith("Circle: duration too long");
    await expect(create({ maxDefaults: U16 })).to.be.revertedWith("Circle: max defaults too large");

    // the largest values that do fit are stored exactly
    const c = await createCircle(factory, organizer, { contribution: U64 - 1n, maxDefaults: U16 - 1n, gracePeriod: U32 - 1n });
    const cfg = await c.config();
    expect(cfg.contribution).to.equal(U64 - 1n);
    expect(cfg.maxDefaults).to.equal(U16 - 1n);
    expect(cfg.gracePeriod).to.equal(U32 - 1n);
  });

  it("the biggest circle (20 members) settles a round in which every member defaults far below the block limit", async function () {
    const sys = await deploySystem();
    const signers = (await ethers.getSigners()).slice(0, 20);
    for (const s of signers) await sys.token.mint(s.address, 1_000_000n * UNIT);
    const circle = await createCircle(sys.factory, sys.organizer, { groupSize: 20n, contribution: 10n * UNIT });
    await joinAll(circle, sys.token, sys.vault, signers);
    await runDraw(circle, sys.payoutOrder, signers);
    expect(await circle.state()).to.equal(State.Active);

    await time.increase(8 * DAY + 1); // nobody pays round 1
    const rc = await (await circle.settleRound()).wait();
    const limit = (await ethers.provider.getBlock("latest")).gasLimit;
    expect(rc.gasUsed).to.be.lt(limit / 10n); // under 10% of a block
    console.log(`        worst case settleRound, 20 members all defaulting: ${rc.gasUsed} gas (block limit ${limit})`);
  });
});
