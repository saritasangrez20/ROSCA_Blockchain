// Deploys the full system and writes addresses + ABIs for the frontend and indexer.
// Usage:
//   npx hardhat node                                   (terminal 1)
//   npx hardhat run scripts/deploy.js --network localhost   (terminal 2)
const { ethers, network, artifacts } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function deployAll() {
  const [admin] = await ethers.getSigners();

  const token = await ethers.deployContract("MockStablecoin");
  const vault = await ethers.deployContract("CollateralVault", [await token.getAddress(), admin.address]);
  const reputation = await ethers.deployContract("ReputationRegistry", [admin.address]);
  const payoutOrder = await ethers.deployContract("PayoutOrder", [admin.address]);
  const factory = await ethers.deployContract("CircleFactory", [
    await token.getAddress(),
    await vault.getAddress(),
    await payoutOrder.getAddress(),
    await reputation.getAddress(),
    admin.address,
  ]);

  // The factory must be allowed to register new circles with each shared module.
  const factoryAddr = await factory.getAddress();
  await (await vault.grantRole(await vault.REGISTRAR_ROLE(), factoryAddr)).wait();
  await (await payoutOrder.grantRole(await payoutOrder.REGISTRAR_ROLE(), factoryAddr)).wait();
  await (await reputation.grantRole(await reputation.REGISTRAR_ROLE(), factoryAddr)).wait();

  return { admin, token, vault, reputation, payoutOrder, factory };
}

async function main() {
  const { admin, token, vault, reputation, payoutOrder, factory } = await deployAll();
  const { chainId } = await ethers.provider.getNetwork();

  const addresses = {
    network: network.name,
    chainId: Number(chainId),
    admin: admin.address,
    MockStablecoin: await token.getAddress(),
    CollateralVault: await vault.getAddress(),
    ReputationRegistry: await reputation.getAddress(),
    PayoutOrder: await payoutOrder.getAddress(),
    CircleFactory: await factory.getAddress(),
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(path.join(outDir, "abi"), { recursive: true });
  fs.writeFileSync(path.join(outDir, `${network.name}.json`), JSON.stringify(addresses, null, 2));
  for (const name of ["MockStablecoin", "CollateralVault", "ReputationRegistry", "PayoutOrder", "CircleFactory", "Circle"]) {
    const { abi } = await artifacts.readArtifact(name);
    fs.writeFileSync(path.join(outDir, "abi", `${name}.json`), JSON.stringify(abi, null, 2));
  }

  console.log("Deployed to", network.name);
  console.table(addresses);
  console.log(`Addresses written to deployments/${network.name}.json, ABIs to deployments/abi/`);
}

module.exports = { deployAll };

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
