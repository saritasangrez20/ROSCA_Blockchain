// Event indexer: reads contract events from the chain and stores them in SQLite.
//
// Trust rule: the chain is the source of truth. The indexer is a read only cache that can be
// deleted and rebuilt at any time from events alone (see rebuild()). It never signs anything.
//
// How a sync works (blocks are processed in chunks):
//   1. Read CircleCreated events from the factory to learn new circle addresses.
//   2. Read the logs of every known contract (factory, vault, draw, registry, every circle).
//   3. Sort by (block, log index) and apply them one by one inside one SQLite transaction:
//      store the raw event, then update the derived tables (circles, members, rounds, ...).
//   4. Remember the last processed block and its hash.
// If the chain was reset (a fresh Hardhat node) or reorganised, the stored block hash no
// longer matches, and the indexer wipes its chain tables and rebuilds from the start block.
const { ethers } = require("ethers");
const { eventArgs } = require("../lib/chain");

const ZERO = ethers.ZeroAddress;
const lc = (a) => (a ? String(a).toLowerCase() : a);
const DAY7 = 7 * 24 * 3600;

class Indexer {
  /**
   * @param {object} o
   * @param {ethers.Provider} o.provider  any ethers v6 provider (JSON RPC, or Hardhat's in tests)
   * @param {import('./db').Db} o.db
   * @param {object} o.deployment  contents of deployments/<network>.json
   * @param {object} o.abis        ABIs from deployments/abi
   * @param {Array<Function>} [o.hooks] called as hook(db, event) for every applied event
   */
  constructor({ provider, db, deployment, abis, startBlock = 0, blockChunk = 2000, confirmations = 0, hooks = [], logger = console }) {
    this.provider = provider;
    this.db = db;
    this.deployment = deployment;
    this.startBlock = startBlock;
    this.blockChunk = blockChunk;
    this.confirmations = confirmations;
    this.hooks = hooks;
    this.log = logger;
    this.syncing = false;
    this.lastError = null;
    this.lastSyncAt = null;

    this.ifaces = Object.fromEntries(Object.entries(abis).map(([name, abi]) => [name, new ethers.Interface(abi)]));
    this.circleAbi = abis.Circle;
    this.fixed = {
      [lc(deployment.CircleFactory)]: "CircleFactory",
      [lc(deployment.CollateralVault)]: "CollateralVault",
      [lc(deployment.PayoutOrder)]: "PayoutOrder",
      [lc(deployment.ReputationRegistry)]: "ReputationRegistry",
    };
    this.createdTopic = this.ifaces.CircleFactory.getEvent("CircleCreated").topicHash;
  }

  fingerprint(chainId) {
    return `${chainId}:${lc(this.deployment.CircleFactory)}`;
  }

  contractNameOf(address) {
    const a = lc(address);
    if (this.fixed[a]) return this.fixed[a];
    if (this.circles.has(a)) return "Circle";
    return null;
  }

  /** Loads known circles and checks the database still matches this chain and deployment. */
  async init() {
    const { chainId } = await this.provider.getNetwork();
    this.chainId = Number(chainId);
    const fp = this.fingerprint(this.chainId);
    const stored = this.db.getMeta("fingerprint");
    if (stored && stored !== fp) {
      this.log.warn(`[indexer] database belongs to another chain or deployment (${stored}); rebuilding`);
      this.db.resetChainData();
    }
    this.db.setMeta("fingerprint", fp);
    this.circles = new Set(this.db.all("SELECT address FROM circles").map((r) => r.address));
    return this;
  }

  lastBlock() {
    const v = this.db.getMeta("last_block");
    return v === null ? this.startBlock - 1 : Number(v);
  }

  /** Detects a reset or reorganised chain by checking the hash of the last processed block. */
  async _checkContinuity(head) {
    const last = this.lastBlock();
    if (last < this.startBlock) return true;
    const storedHash = this.db.getMeta("last_block_hash");
    if (head < last) return false;
    const block = await this.provider.getBlock(last);
    return !!block && block.hash === storedHash;
  }

  /** Brings the database up to the current head. Safe to call repeatedly. */
  async sync() {
    if (this.syncing) return { skipped: true };
    this.syncing = true;
    try {
      const head = (await this.provider.getBlockNumber()) - this.confirmations;
      if (!(await this._checkContinuity(head))) {
        this.log.warn("[indexer] chain was reset or reorganised; rebuilding from events");
        this._wipe();
      }
      let applied = 0;
      let from = this.lastBlock() + 1;
      while (from <= head) {
        const to = Math.min(head, from + this.blockChunk - 1);
        applied += await this._syncRange(from, to);
        from = to + 1;
      }
      this.lastError = null;
      this.lastSyncAt = Date.now();
      this.head = head;
      this.db.save();
      return { applied, head };
    } catch (e) {
      this.lastError = e.message;
      throw e;
    } finally {
      this.syncing = false;
    }
  }

  /** Deletes every chain derived row and replays all events from the start block. */
  async rebuild() {
    this._wipe();
    return this.sync();
  }

  _wipe() {
    const fp = this.db.getMeta("fingerprint");
    this.db.resetChainData();
    if (fp) this.db.setMeta("fingerprint", fp);
    this.circles = new Set();
  }

  async _syncRange(from, to) {
    // Pass 1: learn circles created in this range so their own events are fetched too.
    const created = await this.provider.getLogs({
      address: this.deployment.CircleFactory,
      topics: [this.createdTopic],
      fromBlock: from,
      toBlock: to,
    });
    const newCircles = {};
    for (const log of created) {
      const parsed = this.ifaces.CircleFactory.parseLog(log);
      const addr = lc(parsed.args.circle);
      if (!this.circles.has(addr)) newCircles[addr] = await this._readCircleSettings(parsed.args.circle);
    }
    for (const addr of Object.keys(newCircles)) this.circles.add(addr);

    // Pass 2: every log from every known contract in this range.
    const addresses = [...Object.keys(this.fixed), ...this.circles];
    const logs = await this.provider.getLogs({ address: addresses, fromBlock: from, toBlock: to });
    logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);

    const times = await this._blockTimes([...new Set(logs.map((l) => l.blockNumber))]);
    const lastBlock = await this.provider.getBlock(to);

    let applied = 0;
    this.db.transaction(() => {
      for (const log of logs) {
        const ev = this._decode(log, times[log.blockNumber]);
        if (!ev) continue;
        if (this._store(ev)) {
          this._project(ev, newCircles);
          for (const hook of this.hooks) hook(this.db, ev);
          applied++;
        }
      }
      this.db.setMeta("last_block", to);
      this.db.setMeta("last_block_hash", lastBlock.hash);
    });
    if (applied) this.log.info?.(`[indexer] blocks ${from}-${to}: ${applied} events`);
    return applied;
  }

  async _readCircleSettings(address) {
    const c = new ethers.Contract(address, this.circleAbi, this.provider);
    const [cfg, joinDeadline] = await Promise.all([c.config(), c.joinDeadline()]);
    return {
      roundDuration: Number(cfg.roundDuration),
      gracePeriod: Number(cfg.gracePeriod),
      drawPhase: Number(cfg.drawPhaseDuration),
      maxDefaults: Number(cfg.maxDefaults),
      joinDeadline: Number(joinDeadline),
    };
  }

  async _blockTimes(numbers) {
    const out = {};
    for (let i = 0; i < numbers.length; i += 20) {
      const part = numbers.slice(i, i + 20);
      const blocks = await Promise.all(part.map((n) => this.provider.getBlock(n)));
      blocks.forEach((b, j) => (out[part[j]] = Number(b.timestamp)));
    }
    return out;
  }

  _decode(log, blockTime) {
    const contract = this.contractNameOf(log.address);
    if (!contract) return null;
    let parsed;
    try {
      parsed = this.ifaces[contract].parseLog(log);
    } catch {
      return null;
    }
    if (!parsed) return null;
    const args = eventArgs(parsed);
    const circle = contract === "Circle" ? lc(log.address) : lc(args.circle) || null;
    return {
      blockNumber: log.blockNumber,
      blockHash: log.blockHash,
      blockTime,
      txHash: log.transactionHash,
      logIndex: log.index,
      contract,
      address: lc(log.address),
      circle,
      name: parsed.name,
      args,
    };
  }

  /** Inserts the raw event. Returns false if it was already stored (idempotent). */
  _store(ev) {
    this.db.run(
      `INSERT OR IGNORE INTO events (block_number, block_hash, block_time, tx_hash, log_index, contract, address, circle, name, args)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ev.blockNumber, ev.blockHash, ev.blockTime, ev.txHash, ev.logIndex, ev.contract, ev.address, ev.circle, ev.name, JSON.stringify(ev.args)]
    );
    if (this.db.changes() === 0) return false;
    ev.id = this.db.lastId();
    for (const acct of accountsIn(ev)) {
      this.db.run("INSERT OR IGNORE INTO event_accounts (event_id, account) VALUES (?, ?)", [ev.id, acct]);
    }
    return true;
  }

  /** Updates the derived tables from one event. */
  _project(ev, newCircles) {
    const db = this.db;
    const a = ev.args;
    const c = ev.circle;
    const add = (x, y) => (BigInt(x || 0) + BigInt(y || 0)).toString();
    const sub = (x, y) => (BigInt(x || 0) - BigInt(y || 0)).toString();
    const member = (addr) => db.get("SELECT * FROM members WHERE circle = ? AND address = ?", [c, lc(addr)]);

    switch (`${ev.contract}.${ev.name}`) {
      case "CircleFactory.CircleCreated": {
        const s = newCircles[c] || {};
        db.run(
          `INSERT OR IGNORE INTO circles (address, organizer, contribution, group_size, terms_cid, round_duration, grace_period,
             join_deadline, draw_phase, max_defaults, created_block, created_time, created_tx)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [c, lc(a.organizer), a.contribution, Number(a.groupSize), a.termsCid, s.roundDuration ?? null, s.gracePeriod ?? null,
            s.joinDeadline ?? null, s.drawPhase ?? null, s.maxDefaults ?? null, ev.blockNumber, ev.blockTime, ev.txHash]
        );
        break;
      }
      case "Circle.StateChanged":
        db.run("UPDATE circles SET state = ? WHERE address = ?", [Number(a.to), c]);
        if (Number(a.to) >= 3) db.run("UPDATE circles SET current_recipient = NULL, round_deadline = NULL WHERE address = ?", [c]);
        break;
      case "Circle.MemberJoined":
        db.run("INSERT OR IGNORE INTO members (circle, address, joined_block, joined_time) VALUES (?, ?, ?, ?)", [c, lc(a.member), ev.blockNumber, ev.blockTime]);
        db.run("UPDATE circles SET member_count = member_count + 1 WHERE address = ?", [c]);
        break;
      case "PayoutOrder.DrawStarted":
        db.run("UPDATE circles SET commit_deadline = ?, reveal_deadline = ? WHERE address = ?", [Number(a.commitDeadline), Number(a.revealDeadline), c]);
        break;
      case "PayoutOrder.Committed":
        db.run("UPDATE members SET committed = 1 WHERE circle = ? AND address = ?", [c, lc(a.member)]);
        db.run("UPDATE circles SET commits = commits + 1 WHERE address = ?", [c]);
        break;
      case "PayoutOrder.Revealed":
        db.run("UPDATE members SET revealed = 1 WHERE circle = ? AND address = ?", [c, lc(a.member)]);
        db.run("UPDATE circles SET reveals = reveals + 1 WHERE address = ?", [c]);
        break;
      case "Circle.MemberRemoved":
        db.run("UPDATE members SET removed = 1, defaults = defaults + 1 WHERE circle = ? AND address = ?", [c, lc(a.member)]);
        break;
      case "Circle.PayoutOrderSet":
        db.run("UPDATE circles SET payout_order = ? WHERE address = ?", [JSON.stringify(a.order.map(lc)), c]);
        a.order.forEach((m, i) => db.run("UPDATE members SET position = ? WHERE circle = ? AND address = ?", [i + 1, c, lc(m)]));
        break;
      case "Circle.RoundStarted":
        db.run("INSERT OR IGNORE INTO rounds (circle, round, recipient, deadline) VALUES (?, ?, ?, ?)", [c, Number(a.round), lc(a.recipient), Number(a.deadline)]);
        db.run("UPDATE circles SET current_round = ?, round_deadline = ?, current_recipient = ? WHERE address = ?", [Number(a.round), Number(a.deadline), lc(a.recipient), c]);
        break;
      case "Circle.ContributionMade": {
        db.run("INSERT OR IGNORE INTO contributions (circle, round, member, amount, tx_hash) VALUES (?, ?, ?, ?, ?)", [c, Number(a.round), lc(a.member), a.amount, ev.txHash]);
        db.run("UPDATE rounds SET paid_count = paid_count + 1 WHERE circle = ? AND round = ?", [c, Number(a.round)]);
        const m = member(a.member);
        if (m) db.run("UPDATE members SET paid_total = ? WHERE circle = ? AND address = ?", [add(m.paid_total, a.amount), c, lc(a.member)]);
        break;
      }
      case "Circle.MemberDefaulted":
        db.run("UPDATE members SET defaults = defaults + 1 WHERE circle = ? AND address = ?", [c, lc(a.member)]);
        break;
      case "Circle.RoundSettled":
        db.run("UPDATE rounds SET settled = 1, pot = ?, shortfall = ?, settled_tx = ? WHERE circle = ? AND round = ?", [a.pot, a.shortfall, ev.txHash, c, Number(a.round)]);
        break;
      case "Circle.PayoutClaimed": {
        const m = member(a.member);
        if (m) db.run("UPDATE members SET claimed_total = ? WHERE circle = ? AND address = ?", [add(m.claimed_total, a.amount), c, lc(a.member)]);
        break;
      }
      case "CollateralVault.CollateralDeposited":
      case "CollateralVault.CollateralReleased":
      case "CollateralVault.CollateralSlashed": {
        // In join() the vault emits CollateralDeposited *before* the circle emits MemberJoined,
        // so the member row may not exist yet: create it here.
        if (ev.name === "CollateralDeposited") {
          db.run("INSERT OR IGNORE INTO members (circle, address, joined_block, joined_time) VALUES (?, ?, ?, ?)", [c, lc(a.member), ev.blockNumber, ev.blockTime]);
        }
        const m = member(a.member);
        if (!m) break;
        const next = ev.name === "CollateralDeposited" ? add(m.collateral, a.amount) : sub(m.collateral, a.amount);
        db.run("UPDATE members SET collateral = ? WHERE circle = ? AND address = ?", [next, c, lc(a.member)]);
        break;
      }
      case "Circle.Paused":
        db.run("UPDATE circles SET paused_until = ? WHERE address = ?", [ev.blockTime + DAY7, c]);
        break;
      case "Circle.Unpaused":
        db.run("UPDATE circles SET paused_until = 0 WHERE address = ?", [c]);
        break;
      case "ReputationRegistry.ReputationUpdated": {
        const col = ["joined", "completed", "defaults"][Number(a.kind)];
        db.run("INSERT OR IGNORE INTO reputation (address) VALUES (?)", [lc(a.member)]);
        db.run(`UPDATE reputation SET ${col} = ${col} + 1 WHERE address = ?`, [lc(a.member)]);
        break;
      }
      default:
        break; // stored in events only (role grants, DrawFinalized, DebtRecovered, ...)
    }
  }

  status() {
    return {
      chainId: this.chainId,
      lastBlock: this.lastBlock(),
      head: this.head ?? null,
      circles: this.circles ? this.circles.size : 0,
      events: this.db.get("SELECT COUNT(*) AS n FROM events").n,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
    };
  }
}

/** Addresses of people an event is about (for per account history). */
function accountsIn(ev) {
  const out = new Set();
  // Role grants and revokes repeat what MemberJoined / registration already say.
  if (ev.name === "RoleGranted" || ev.name === "RoleRevoked") return out;
  const skip = new Set(["circle"]);
  for (const [k, v] of Object.entries(ev.args)) {
    if (skip.has(k)) continue;
    if (typeof v === "string" && ethers.isAddress(v) && v !== ZERO) out.add(lc(v));
    if (Array.isArray(v)) v.forEach((x) => typeof x === "string" && ethers.isAddress(x) && out.add(lc(x)));
  }
  return out;
}

module.exports = { Indexer };
