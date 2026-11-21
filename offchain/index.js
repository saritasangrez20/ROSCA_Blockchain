// Starts the off chain service: indexer + notifier on a timer, and the HTTP API.
// Usage: npm run offchain      (a Hardhat node must be running and the system deployed)
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const { config, loadDeployment, loadAbis } = require("./lib/config");
const { OffchainService } = require("./service");

async function waitForChain(provider) {
  for (let i = 0; ; i++) {
    try {
      return await provider.getNetwork();
    } catch {
      if (i === 0) console.log(`[offchain] waiting for the chain at ${config.rpcUrl} ...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function main() {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, { polling: true, pollingInterval: config.pollMs });
  const net = await waitForChain(provider);
  const deployment = loadDeployment();
  const svc = await new OffchainService({
    provider, deployment, abis: loadAbis(), dbFile: config.dbFile, ipfsDir: config.ipfsDir, ipfsApiUrl: config.ipfsApiUrl,
    ipfsGatewayUrl: config.ipfsGatewayUrl, ipfsMaxBytes: config.ipfsMaxBytes, startBlock: config.startBlock,
    blockChunk: config.blockChunk, confirmations: config.confirmations, remindBeforeSec: config.remindBeforeSec,
  }).start();

  svc.app.listen(config.apiPort, config.apiHost, () => {
    console.log(`[offchain] chain ${net.chainId} at ${config.rpcUrl}, factory ${deployment.CircleFactory}`);
    console.log(`[offchain] API on http://${config.apiHost}:${config.apiPort}  (try /api/health)`);
    console.log(`[offchain] database ${path.relative(config.root, config.dbFile)}, IPFS store ${path.relative(config.root, config.ipfsDir)}`);
  });

  // Follow redeploys: if deployments/<network>.json now names another factory, re index.
  const deploymentFile = path.join(config.root, "deployments", `${config.network}.json`);
  let running = false;
  const loop = async () => {
    if (running) return;
    running = true;
    try {
      if (fs.existsSync(deploymentFile)) {
        const latest = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
        if (latest.CircleFactory !== svc.deployment.CircleFactory) {
          console.log(`[offchain] new deployment detected (factory ${latest.CircleFactory}); re indexing`);
          await svc.switchDeployment(latest);
        }
      }
      await svc.tick();
    } catch (e) {
      console.warn(`[offchain] sync failed: ${e.shortMessage || e.message}`);
    } finally {
      running = false;
    }
  };
  await loop();
  setInterval(loop, config.pollMs);

  const stop = () => {
    svc.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
