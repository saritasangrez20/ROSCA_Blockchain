// Attack A7: tampering with the off chain terms document.
// Attacker: whoever controls the IPFS gateway, the indexer host or the organizer's server.
// Goal:     show members different terms from the ones the circle was created with.
// Defence:  only the CID (a sha256 based content address) is on chain, written once in
//           initialize. The frontend re hashes whatever document it downloads and refuses a
//           mismatch (frontend/src/components/TermsCheck.jsx, same code as offchain/lib/cid.js).
const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySystem } = require("../helpers");
const { cidOf, verifyCid } = require("../../offchain/lib/cid");
const { createCircle } = require("./attackHelpers");

const TERMS = Buffer.from(
  "Trustless ROSCA terms\nContribution: 1,000 mUSD every round\nDeposit: 100% of what you still owe after your payout\n"
);

async function fixture() {
  const sys = await deploySystem();
  const circle = await createCircle(sys.factory, sys.organizer, { termsCid: cidOf(TERMS) });
  return { ...sys, circle };
}

describe("Attack A7: off chain terms tampering", function () {
  it("the original document matches the CID stored on chain", async function () {
    const { circle } = await loadFixture(fixture);
    const onChain = (await circle.getSummary()).termsCid;
    expect(verifyCid(onChain, TERMS).ok).to.equal(true);
  });

  it("a one character change no longer matches, so the UI refuses it", async function () {
    const { circle } = await loadFixture(fixture);
    const onChain = (await circle.getSummary()).termsCid;
    const tampered = Buffer.from(TERMS.toString().replace("100%", "10%"));
    expect(verifyCid(onChain, tampered).ok).to.equal(false);
    expect(cidOf(tampered)).to.not.equal(onChain);
  });

  it("nobody can change the CID after creation (no setter; initialize runs once)", async function () {
    const { circle } = await loadFixture(fixture);
    const fragment = circle.interface.fragments.filter((f) => f.type === "function" && /terms|cid/i.test(f.name));
    expect(fragment.map((f) => f.name)).to.deep.equal([]); // only read through config() / getSummary()
  });
});
