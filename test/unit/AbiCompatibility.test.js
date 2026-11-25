// Team rule check (Member C, Stage 3): "C may change contract internals for gas and security, but
// not function signatures or events, so B's frontend and indexer keep working."
//
// test/fixtures/abi_handoff holds the ABIs exactly as Member B received them (identical to
// deployments/abi at the handoff_2 tag). Every function there must still exist with the same
// selector, the same output types and the same mutability, and every event with the same
// signature and indexed fields. Additions are allowed. The only removal is the one both handoff
// notes proposed (ReputationRegistry.getHistory, gas optimization G4), which no off chain code used.
const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");
const path = require("path");

const NAMES = ["Circle", "CircleFactory", "CollateralVault", "PayoutOrder", "ReputationRegistry", "MockStablecoin"];
const ALLOWED_REMOVALS = new Set(["ReputationRegistry.getHistory(address)"]);

const outputTypes = (f) => f.outputs.map((o) => o.format("full").replace(/ \w+$/, "")).join(",");

describe("ABI compatibility with the handoff_2 interface", function () {
  for (const name of NAMES) {
    it(`${name}: every handoff function and event is unchanged`, async function () {
      const before = new ethers.Interface(require(path.join(__dirname, "..", "fixtures", "abi_handoff", `${name}.json`)));
      const after = new ethers.Interface((await artifacts.readArtifact(name)).abi);

      before.forEachFunction((f) => {
        const sig = f.format("sighash");
        if (ALLOWED_REMOVALS.has(`${name}.${sig}`)) {
          expect(after.getFunction(sig), `${sig} should be gone`).to.equal(null);
          return;
        }
        const now = after.getFunction(sig);
        expect(now, `${name}.${sig} is missing`).to.not.equal(null);
        expect(now.selector).to.equal(f.selector);
        expect(now.stateMutability, `${name}.${sig} mutability`).to.equal(f.stateMutability);
        expect(outputTypes(now), `${name}.${sig} outputs`).to.equal(outputTypes(f));
      });

      before.forEachEvent((e) => {
        const now = after.getEvent(e.format("sighash"));
        expect(now, `${name} event ${e.format("sighash")} is missing`).to.not.equal(null);
        expect(now.topicHash).to.equal(e.topicHash);
        expect(now.inputs.map((i) => i.indexed)).to.deep.equal(e.inputs.map((i) => i.indexed));
      });
    });
  }
});
