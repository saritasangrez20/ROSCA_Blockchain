// SQLite storage for the indexer, using sql.js (SQLite compiled to WebAssembly).
// sql.js needs no native build step, so `npm install` works the same on Windows, Mac and Linux.
// The database lives in memory and is written to a normal .sqlite file after every change,
// so it can be opened with any SQLite tool (for example `sqlite3 offchain/data/indexer.sqlite`).
const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");

// Tables rebuilt from chain events. Everything here can be thrown away and replayed.
const CHAIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  block_number  INTEGER NOT NULL,
  block_hash    TEXT NOT NULL,
  block_time    INTEGER NOT NULL,
  tx_hash       TEXT NOT NULL,
  log_index     INTEGER NOT NULL,
  contract      TEXT NOT NULL,
  address       TEXT NOT NULL,
  circle        TEXT,
  name          TEXT NOT NULL,
  args          TEXT NOT NULL,
  UNIQUE (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS idx_events_circle ON events (circle, block_number, log_index);
CREATE TABLE IF NOT EXISTS event_accounts (
  event_id INTEGER NOT NULL,
  account  TEXT NOT NULL,
  PRIMARY KEY (event_id, account)
);
CREATE INDEX IF NOT EXISTS idx_event_accounts ON event_accounts (account);
CREATE TABLE IF NOT EXISTS circles (
  address          TEXT PRIMARY KEY,
  organizer        TEXT NOT NULL,
  contribution     TEXT NOT NULL,
  group_size       INTEGER NOT NULL,
  terms_cid        TEXT NOT NULL,
  round_duration   INTEGER,
  grace_period     INTEGER,
  join_deadline    INTEGER,
  draw_phase       INTEGER,
  max_defaults     INTEGER,
  created_block    INTEGER NOT NULL,
  created_time     INTEGER NOT NULL,
  created_tx       TEXT NOT NULL,
  state            INTEGER NOT NULL DEFAULT 0,
  member_count     INTEGER NOT NULL DEFAULT 0,
  current_round    INTEGER NOT NULL DEFAULT 0,
  round_deadline   INTEGER,
  current_recipient TEXT,
  commit_deadline  INTEGER,
  reveal_deadline  INTEGER,
  commits          INTEGER NOT NULL DEFAULT 0,
  reveals          INTEGER NOT NULL DEFAULT 0,
  payout_order     TEXT,
  paused_until     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS members (
  circle        TEXT NOT NULL,
  address       TEXT NOT NULL,
  joined_block  INTEGER NOT NULL,
  joined_time   INTEGER NOT NULL,
  collateral    TEXT NOT NULL DEFAULT '0',
  position      INTEGER NOT NULL DEFAULT 0,
  removed       INTEGER NOT NULL DEFAULT 0,
  committed     INTEGER NOT NULL DEFAULT 0,
  revealed      INTEGER NOT NULL DEFAULT 0,
  defaults      INTEGER NOT NULL DEFAULT 0,
  paid_total    TEXT NOT NULL DEFAULT '0',
  claimed_total TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (circle, address)
);
CREATE TABLE IF NOT EXISTS rounds (
  circle     TEXT NOT NULL,
  round      INTEGER NOT NULL,
  recipient  TEXT NOT NULL,
  deadline   INTEGER NOT NULL,
  paid_count INTEGER NOT NULL DEFAULT 0,
  pot        TEXT,
  shortfall  TEXT,
  settled    INTEGER NOT NULL DEFAULT 0,
  settled_tx TEXT,
  PRIMARY KEY (circle, round)
);
CREATE TABLE IF NOT EXISTS contributions (
  circle  TEXT NOT NULL,
  round   INTEGER NOT NULL,
  member  TEXT NOT NULL,
  amount  TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  PRIMARY KEY (circle, round, member)
);
CREATE TABLE IF NOT EXISTS reputation (
  address   TEXT PRIMARY KEY,
  joined    INTEGER NOT NULL DEFAULT 0,
  completed INTEGER NOT NULL DEFAULT 0,
  defaults  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS notifications (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  account     TEXT NOT NULL,
  circle      TEXT,
  kind        TEXT NOT NULL,
  ref         TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'info',
  chain_time  INTEGER NOT NULL,
  deadline    INTEGER,
  resolved    INTEGER NOT NULL DEFAULT 0,
  UNIQUE (account, kind, circle, ref)
);
CREATE INDEX IF NOT EXISTS idx_notifications_account ON notifications (account, resolved);
`;

// Off chain only data. Not on chain, so a rebuild keeps it.
const OFFCHAIN_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS profiles (
  address      TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  message      TEXT NOT NULL,
  signature    TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);
`;

const CHAIN_TABLES = ["events", "event_accounts", "circles", "members", "rounds", "contributions", "reputation", "notifications"];

let SQL; // the sql.js module, loaded once

class Db {
  static async open(file) {
    if (!SQL) SQL = await initSqlJs();
    const db = new Db();
    db.file = file;
    if (file && fs.existsSync(file)) {
      db.sql = new SQL.Database(fs.readFileSync(file));
    } else {
      db.sql = new SQL.Database();
    }
    db.sql.run(OFFCHAIN_SCHEMA);
    db.sql.run(CHAIN_SCHEMA);
    db.dirty = false;
    return db;
  }

  run(sql, params = []) {
    this.sql.run(sql, params);
    this.dirty = true;
  }

  all(sql, params = []) {
    const stmt = this.sql.prepare(sql);
    try {
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }

  get(sql, params = []) {
    return this.all(sql, params)[0];
  }

  lastId() {
    return this.get("SELECT last_insert_rowid() AS id").id;
  }

  changes() {
    return this.sql.getRowsModified();
  }

  transaction(fn) {
    this.sql.run("BEGIN");
    try {
      const out = fn();
      this.sql.run("COMMIT");
      this.dirty = true;
      return out;
    } catch (e) {
      this.sql.run("ROLLBACK");
      throw e;
    }
  }

  getMeta(key) {
    const row = this.get("SELECT value FROM meta WHERE key = ?", [key]);
    return row ? row.value : null;
  }

  setMeta(key, value) {
    this.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, String(value)]);
  }

  /** Drops every table derived from the chain (profiles and uploaded files stay). */
  resetChainData() {
    for (const t of CHAIN_TABLES) this.sql.run(`DROP TABLE IF EXISTS ${t}`);
    this.sql.run("DELETE FROM meta");
    this.sql.run(CHAIN_SCHEMA);
    this.dirty = true;
  }

  /** Writes the database file atomically (temp file then rename). */
  save() {
    if (!this.file || !this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, Buffer.from(this.sql.export()));
    fs.renameSync(tmp, this.file);
    this.dirty = false;
  }

  close() {
    this.save();
    this.sql.close();
  }
}

module.exports = { Db, CHAIN_TABLES };
