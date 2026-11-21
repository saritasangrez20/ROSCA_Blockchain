// Runs the keeper in a loop.
// Usage: npm run keeper            (add -- --once for a single pass)
//
// Which account pays the gas:
//   * KEEPER_PRIVATE_KEY in your local .env (needed on Sepolia; never commit it), or
//   * on a local Hardhat node, unlocked account number KEEPER_ACCOUNT_INDEX (default 9), so no
//     key is needed at all. Account 9 is not one of the demo accounts, so MetaMask nonces stay clean.
const { ethers } = require("ethers");
const { config, loadDeployment, loadAbis } = require("../lib/config");
const { Keeper } = require("./keeper");

async function main() {
  const once = process.argv.includes("--once");
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const { chainId } = await provider.getNetwork();
  let signer;
  if (config.keeperPrivateKey) {
    signer = new ethers.Wallet(config.keeperPrivateKey, provider);
  } else if (Number(chainId) === 31337) {
    signer = await provider.getSigner(config.keeperAccountIndex);
  } else {
    throw new Error("Set KEEPER_PRIVATE_KEY in .env to run the keeper on this network");
  }

  let deployment = loadDeployment();
  const abis = loadAbis();
  let keeper = new Keeper({ provider, signer, deployment, abis, settleEarly: config.keeperSettleEarly, cancelExpired: config.keeperCancelExpired });
  console.log(`[keeper] account ${await signer.getAddress()} on chain ${chainId}, factory ${deployment.CircleFactory}`);
  console.log(`[keeper] settle early when everyone paid: ${config.keeperSettleEarly}; cancel unfilled circles after the join deadline: ${config.keeperCancelExpired}`);

  const pass = async () => {
    try {
      const latest = loadDeployment();
      if (latest.CircleFactory !== deployment.CircleFactory) {
        deployment = latest;
        keeper = new Keeper({ provider, signer, deployment, abis, settleEarly: config.keeperSettleEarly, cancelExpired: config.keeperCancelExpired });
        console.log(`[keeper] following new deployment, factory ${deployment.CircleFactory}`);
      }
      const actions = await keeper.tick();
      if (once) console.log(actions.length ? actions : "[keeper] nothing to do");
    } catch (e) {
      console.warn(`[keeper] pass failed: ${e.shortMessage || e.message}`);
    }
  };
  await pass();
  if (!once) setInterval(pass, config.keeperIntervalMs);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
