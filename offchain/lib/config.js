// Shared configuration for every off chain service (indexer, API, notifier, keeper).
// Values come from environment variables (a local .env file, never committed; see .env.example).
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
require("dotenv").config({ path: path.join(ROOT, ".env") });

const env = (name, fallback) => (process.env[name] !== undefined && process.env[name] !== "" ? process.env[name] : fallback);
const num = (name, fallback) => Number(env(name, fallback));
const bool = (name, fallback) => String(env(name, fallback)).toLowerCase() === "true";

const config = {
  root: ROOT,
  network: env("NETWORK", "localhost"),
  rpcUrl: env("RPC_URL", "http://127.0.0.1:8545"),

  // Indexer + API
  apiPort: num("API_PORT", 4000),
  apiHost: env("API_HOST", "127.0.0.1"),
  dbFile: path.resolve(ROOT, env("INDEXER_DB", "offchain/data/indexer.sqlite")),
  startBlock: num("INDEXER_START_BLOCK", 0),
  pollMs: num("INDEXER_POLL_MS", 2000),
  blockChunk: num("INDEXER_BLOCK_CHUNK", 2000),
  confirmations: num("INDEXER_CONFIRMATIONS", 0),

  // IPFS terms storage
  ipfsDir: path.resolve(ROOT, env("IPFS_LOCAL_DIR", "offchain/data/ipfs")),
  ipfsApiUrl: env("IPFS_API_URL", ""), // e.g. http://127.0.0.1:5001 for a local Kubo node
  ipfsGatewayUrl: env("IPFS_GATEWAY_URL", ""), // e.g. http://127.0.0.1:8080
  ipfsMaxBytes: num("IPFS_MAX_BYTES", 1024 * 1024),

  // Notifier
  remindBeforeSec: num("NOTIFY_REMIND_BEFORE_SEC", 2 * 24 * 3600),

  // Keeper
  keeperIntervalMs: num("KEEPER_INTERVAL_MS", 5000),
  keeperAccountIndex: num("KEEPER_ACCOUNT_INDEX", 9),
  keeperPrivateKey: env("KEEPER_PRIVATE_KEY", ""),
  keeperSettleEarly: bool("KEEPER_SETTLE_EARLY", "true"),
  keeperCancelExpired: bool("KEEPER_CANCEL_EXPIRED", "true"),
};

/** Reads deployments/<network>.json written by scripts/deploy.js or scripts/seedLocal.js. */
function loadDeployment(network = config.network) {
  const file = path.join(ROOT, "deployments", `${network}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No deployment found at deployments/${network}.json. Start a node (npx hardhat node) and run ` +
        "npm run deploy:local or npm run seed:local first."
    );
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** ABIs exported by scripts/deploy.js into deployments/abi. */
function loadAbis() {
  const dir = path.join(ROOT, "deployments", "abi");
  const names = ["Circle", "CircleFactory", "CollateralVault", "PayoutOrder", "ReputationRegistry", "MockStablecoin"];
  return Object.fromEntries(names.map((n) => [n, JSON.parse(fs.readFileSync(path.join(dir, `${n}.json`), "utf8"))]));
}

module.exports = { config, loadDeployment, loadAbis };
