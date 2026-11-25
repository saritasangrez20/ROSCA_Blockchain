// Member C, Stage 3: every revert string in the contracts has a plain words explanation in the
// frontend error decoder (frontend/src/lib/errors.js), including the ones added by the gas
// packing checks and the security fixes S1 and S2.
const { expect } = require("chai");
const { ethers, artifacts } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { pathToFileURL } = require("url");

const frontend = (file) => import(pathToFileURL(path.join(__dirname, "..", "..", "frontend", "src", "lib", file)).href);
const revertData = (reason) => "0x08c379a0" + ethers.AbiCoder.defaultAbiCoder().encode(["string"], [reason]).slice(2);

function revertStrings() {
  const dirs = ["core", "risk", "support"].map((d) => path.join(__dirname, "..", "..", "contracts", d));
  const found = new Set();
  for (const dir of dirs) {
    for (const file of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, file), "utf8");
      for (const m of src.matchAll(/"((?:Circle|Lifecycle|Order|Vault|Reputation|Factory): [^"]+)"/g)) found.add(m[1]);
    }
  }
  return [...found].sort();
}

describe("Frontend error decoder covers every contract revert string", function () {
  it("each revert string gets its own sentence, not the raw text", async function () {
    const { decodeError } = await frontend("errors.js");
    const ifaces = [];
    for (const n of ["Circle", "CircleFactory", "CollateralVault", "PayoutOrder", "ReputationRegistry", "MockStablecoin"]) {
      ifaces.push(new ethers.Interface((await artifacts.readArtifact(n)).abi));
    }
    const strings = revertStrings();
    expect(strings.length).to.be.greaterThan(30);
    const missing = [];
    for (const s of strings) {
      // Registry and zero address checks only fire during deployment, never from the UI.
      if (/zero address|zero token/.test(s)) continue;
      const e = decodeError({ code: "CALL_EXCEPTION", data: revertData(s) }, ifaces);
      if (e.title === s) missing.push(s);
    }
    expect(missing, `no plain words text for: ${missing.join(" | ")}`).to.deep.equal([]);
  });

  it("explains the Stage 3 rules (pause cooldown, finalize in a later block)", async function () {
    const { decodeError } = await frontend("errors.js");
    expect(decodeError({ data: revertData("Lifecycle: pause cooldown") }).title).to.match(/7 days after/);
    expect(decodeError({ data: revertData("Order: finalize in a later block") }).title).to.match(/one more block/);
  });
});
