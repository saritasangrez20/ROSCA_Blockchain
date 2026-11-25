// Prints the storage layout of the packed contracts (Member C, gas optimization G2).
// Usage: npx hardhat run scripts/storageLayout.js
const { artifacts } = require("hardhat");

async function main() {
  for (const name of ["Circle", "PayoutOrder", "ReputationRegistry"]) {
    const fqn = (await artifacts.getAllFullyQualifiedNames()).find((n) => n.endsWith(`:${name}`));
    const info = await artifacts.getBuildInfo(fqn);
    const [source, contract] = fqn.split(":");
    const layout = info.output.contracts[source][contract].storageLayout;
    console.log(`\n${name}`);
    const rows = layout.storage.map((v) => ({
      slot: Number(v.slot),
      offset: v.offset,
      bytes: Number(layout.types[v.type].numberOfBytes),
      variable: v.label,
      type: layout.types[v.type].label,
    }));
    console.table(rows);
    console.log(`slots used by fixed size variables: ${new Set(rows.map((r) => r.slot)).size}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
