// Contract access for the frontend. ABIs come from ../deployments/abi (exported by
// scripts/deploy.js); addresses come from deployments/<network>.json at runtime.
import { ethers } from "ethers";
import CircleAbi from "../../../deployments/abi/Circle.json";
import CircleFactoryAbi from "../../../deployments/abi/CircleFactory.json";
import CollateralVaultAbi from "../../../deployments/abi/CollateralVault.json";
import PayoutOrderAbi from "../../../deployments/abi/PayoutOrder.json";
import ReputationRegistryAbi from "../../../deployments/abi/ReputationRegistry.json";
import MockStablecoinAbi from "../../../deployments/abi/MockStablecoin.json";
import { API_URL, NETWORK, RPC_URL } from "./config.js";

export const ABIS = {
  Circle: CircleAbi,
  CircleFactory: CircleFactoryAbi,
  CollateralVault: CollateralVaultAbi,
  PayoutOrder: PayoutOrderAbi,
  ReputationRegistry: ReputationRegistryAbi,
  MockStablecoin: MockStablecoinAbi,
};
export const IFACES = Object.values(ABIS).map((abi) => new ethers.Interface(abi));

export const STATES = ["Open", "Order draw", "Active", "Completed", "Cancelled"];

/** One read only provider for the whole app (works without a wallet and without the indexer). */
export const readProvider = new ethers.JsonRpcProvider(RPC_URL, undefined, { staticNetwork: false, polling: true, pollingInterval: 2000 });

/** Finds the deployed addresses: the dev server first, then the indexer API. */
export async function loadDeployment() {
  const tries = [`/deployments/${NETWORK}.json`, `${API_URL}/api/config`];
  for (const url of tries) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) {
        const d = await res.json();
        if (d && d.CircleFactory) return d;
      }
    } catch {
      /* try the next source */
    }
  }
  return null;
}

export function contractsFor(deployment, runner = readProvider) {
  return {
    factory: new ethers.Contract(deployment.CircleFactory, ABIS.CircleFactory, runner),
    vault: new ethers.Contract(deployment.CollateralVault, ABIS.CollateralVault, runner),
    payoutOrder: new ethers.Contract(deployment.PayoutOrder, ABIS.PayoutOrder, runner),
    reputation: new ethers.Contract(deployment.ReputationRegistry, ABIS.ReputationRegistry, runner),
    token: new ethers.Contract(deployment.MockStablecoin, ABIS.MockStablecoin, runner),
  };
}

export const circleAt = (address, runner = readProvider) => new ethers.Contract(address, ABIS.Circle, runner);

/** Chain clock (follows Hardhat time travel through the pending block). */
export async function chainNow(provider = readProvider) {
  try {
    const pending = await provider.send("eth_getBlockByNumber", ["pending", false]);
    if (pending?.timestamp) return Number(BigInt(pending.timestamp));
  } catch {
    /* fall back */
  }
  const latest = await provider.getBlock("latest");
  return Math.max(Number(latest.timestamp), Math.floor(Date.now() / 1000));
}
