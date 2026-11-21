// Frontend settings. Override any of them in frontend/.env.local (see the root .env.example).
const env = import.meta.env || {};

export const NETWORK = env.VITE_NETWORK || "localhost";
// Read only RPC used for every chain read, so the app works even before a wallet is connected
// and keeps working when the indexer is down.
export const RPC_URL = env.VITE_RPC_URL || "http://127.0.0.1:8545";
export const API_URL = (env.VITE_API_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
// Extra public gateways tried for the terms document if our IPFS service is down.
// Whatever a gateway returns is re hashed and checked against the CID on chain.
export const IPFS_GATEWAYS = (env.VITE_IPFS_GATEWAYS || "https://ipfs.io/ipfs/,https://dweb.link/ipfs/")
  .split(",").map((s) => s.trim()).filter(Boolean);
export const LOCAL_CHAIN_ID = 31337;
export const POLL_MS = Number(env.VITE_POLL_MS || 4000);
