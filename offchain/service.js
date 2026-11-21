// Wires the indexer, notifier, IPFS store and API together. Used by `npm run offchain`
// (offchain/index.js) and by the end to end tests, which pass in Hardhat's provider.
const { Db } = require("./indexer/db");
const { Indexer } = require("./indexer/indexer");
const { Notifier } = require("./notifier/notifier");
const { IpfsStore } = require("./ipfs/store");
const { createApp } = require("./api/server");
const { chainNow } = require("./lib/chain");

class OffchainService {
  constructor({ provider, deployment, abis, dbFile = null, ipfsDir, ipfsApiUrl, ipfsGatewayUrl, ipfsMaxBytes, startBlock = 0,
    blockChunk = 2000, confirmations = 0, remindBeforeSec, logger = console }) {
    Object.assign(this, { provider, deployment, abis, dbFile, startBlock, blockChunk, confirmations, logger });
    this.ipfs = new IpfsStore({ dir: ipfsDir, apiUrl: ipfsApiUrl, gatewayUrl: ipfsGatewayUrl, maxBytes: ipfsMaxBytes });
    this.notifier = new Notifier({ provider, abis, remindBeforeSec, logger });
  }

  async start() {
    this.db = await Db.open(this.dbFile);
    await this._makeIndexer();
    this.app = createApp({
      db: this.db,
      indexer: this.indexerProxy(),
      notifier: this.notifier,
      ipfs: this.ipfs,
      deployment: this.deployment,
      chainNowFn: () => chainNow(this.provider),
    });
    return this;
  }

  async _makeIndexer() {
    this.indexer = new Indexer({
      provider: this.provider, db: this.db, deployment: this.deployment, abis: this.abis, startBlock: this.startBlock,
      blockChunk: this.blockChunk, confirmations: this.confirmations, hooks: [this.notifier.eventHook], logger: this.logger,
    });
    await this.indexer.init();
  }

  /** The API always talks to the current indexer, even after a redeploy swaps it. */
  indexerProxy() {
    const self = this;
    return { status: () => self.indexer.status(), get lastError() { return self.indexer.lastError; } };
  }

  /** Point at a new deployment (for example after restarting the Hardhat node and redeploying). */
  async switchDeployment(deployment) {
    this.deployment = deployment;
    await this._makeIndexer();
  }

  /** One indexer sync plus a notifier refresh. */
  async tick() {
    const r = await this.indexer.sync();
    if (!r.skipped) {
      await this.notifier.refresh(this.db, await chainNow(this.provider));
      this.db.save();
    }
    return r;
  }

  async rebuild() {
    const r = await this.indexer.rebuild();
    await this.notifier.refresh(this.db, await chainNow(this.provider));
    this.db.save();
    return r;
  }

  close() {
    if (this.db) this.db.close();
  }
}

module.exports = { OffchainService };
