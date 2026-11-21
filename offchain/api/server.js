// HTTP API in front of the indexer, notifier and IPFS store. Read only for chain data.
//
//   GET  /api/health                              indexer status (frontend uses it to detect "indexer down")
//   GET  /api/config                              deployed addresses and chain id
//   GET  /api/circles[?organizer=&member=]        circle list
//   GET  /api/circles/:address                    one circle with members, rounds and display names
//   GET  /api/circles/:address/events             history of one circle
//   GET  /api/accounts/:address/events            history of one account across circles
//   GET  /api/accounts/:address/notifications     in app reminders (add ?all=1 for resolved ones too)
//   GET  /api/reputation/:address                 joins, completions and defaults
//   GET  /api/profiles?addresses=a,b              display names (off chain only)
//   POST /api/profiles                            set a display name (signed by the wallet)
//   POST /api/ipfs                                upload the terms document, returns its CID
//   GET  /ipfs/:cid                               download a document by CID
const express = require("express");
const cors = require("cors");
const { ethers } = require("ethers");

const lc = (a) => (a ? String(a).toLowerCase() : a);
const camel = (row) =>
  row && Object.fromEntries(Object.entries(row).map(([k, v]) => [k.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase()), v]));
const parseEvent = (row) => ({ ...camel(row), args: JSON.parse(row.args) });

const PROFILE_PREFIX = "Trustless ROSCA display name";

/** The exact text a wallet signs to set a display name. The frontend builds the same string. */
function profileMessage(address, displayName, issuedAt) {
  return `${PROFILE_PREFIX}\nAddress: ${ethers.getAddress(address)}\nName: ${displayName}\nIssued at: ${issuedAt}`;
}

function validName(name) {
  return typeof name === "string" && name.trim() === name && name.length >= 1 && name.length <= 32 && /^[\p{L}\p{N} ._'-]+$/u.test(name);
}

function createApp({ db, indexer, notifier, ipfs, deployment, chainNowFn }) {
  const app = express();
  app.use(cors());

  const asyncRoute = (fn) => (req, res) =>
    Promise.resolve(fn(req, res)).catch((e) => res.status(e.status || 500).json({ error: e.message }));
  const requireAddress = (value) => {
    if (!ethers.isAddress(value)) throw Object.assign(new Error("Invalid address"), { status: 400 });
    return lc(value);
  };
  const names = (addresses) => {
    if (!addresses.length) return {};
    const marks = addresses.map(() => "?").join(",");
    const rows = db.all(`SELECT address, display_name FROM profiles WHERE address IN (${marks})`, addresses.map(lc));
    return Object.fromEntries(rows.map((r) => [r.address, r.display_name]));
  };

  app.get("/api/health", asyncRoute(async (_req, res) => {
    res.json({ ok: !indexer.lastError, service: "rosca-indexer", ...indexer.status(), chainTime: chainNowFn ? await chainNowFn().catch(() => null) : null });
  }));

  app.get("/api/config", (_req, res) => res.json(deployment));

  app.get("/api/circles", asyncRoute(async (req, res) => {
    let rows;
    if (req.query.member) {
      rows = db.all(
        `SELECT c.* FROM circles c JOIN members m ON m.circle = c.address WHERE m.address = ? ORDER BY c.created_block DESC`,
        [requireAddress(req.query.member)]
      );
    } else if (req.query.organizer) {
      rows = db.all("SELECT * FROM circles WHERE organizer = ? ORDER BY created_block DESC", [requireAddress(req.query.organizer)]);
    } else {
      rows = db.all("SELECT * FROM circles ORDER BY created_block DESC");
    }
    const organizers = names([...new Set(rows.map((r) => r.organizer))]);
    res.json(rows.map((r) => ({ ...camel(r), payoutOrder: r.payout_order ? JSON.parse(r.payout_order) : [], organizerName: organizers[r.organizer] || null })));
  }));

  app.get("/api/circles/:address", asyncRoute(async (req, res) => {
    const addr = requireAddress(req.params.address);
    const c = db.get("SELECT * FROM circles WHERE address = ?", [addr]);
    if (!c) return res.status(404).json({ error: "Circle not indexed (yet)" });
    const members = db.all("SELECT * FROM members WHERE circle = ? ORDER BY CASE WHEN position = 0 THEN 999 ELSE position END, joined_block", [addr]);
    const rounds = db.all("SELECT * FROM rounds WHERE circle = ? ORDER BY round", [addr]);
    const contributions = db.all("SELECT round, member, amount, tx_hash FROM contributions WHERE circle = ?", [addr]);
    const nm = names([c.organizer, ...members.map((m) => m.address)]);
    res.json({
      ...camel(c),
      payoutOrder: c.payout_order ? JSON.parse(c.payout_order) : [],
      organizerName: nm[c.organizer] || null,
      members: members.map((m) => ({ ...camel(m), displayName: nm[m.address] || null })),
      rounds: rounds.map((r) => ({ ...camel(r), paid: contributions.filter((k) => k.round === r.round).map((k) => k.member) })),
    });
  }));

  app.get("/api/circles/:address/events", asyncRoute(async (req, res) => {
    const addr = requireAddress(req.params.address);
    const rows = db.all(
      `SELECT * FROM events WHERE circle = ? AND name NOT IN ('RoleGranted','RoleRevoked','CircleRegistered')
       ORDER BY block_number, log_index`,
      [addr]
    );
    res.json(rows.map(parseEvent));
  }));

  app.get("/api/accounts/:address/events", asyncRoute(async (req, res) => {
    const addr = requireAddress(req.params.address);
    const rows = db.all(
      `SELECT e.* FROM events e JOIN event_accounts a ON a.event_id = e.id WHERE a.account = ? ORDER BY e.block_number DESC, e.log_index DESC LIMIT 500`,
      [addr]
    );
    res.json(rows.map(parseEvent));
  }));

  app.get("/api/accounts/:address/notifications", asyncRoute(async (req, res) => {
    const addr = requireAddress(req.params.address);
    const rows = db.all(
      `SELECT * FROM notifications WHERE account = ? ${req.query.all ? "" : "AND resolved = 0"} ORDER BY chain_time DESC, id DESC LIMIT 200`,
      [addr]
    );
    res.json(rows.map(camel));
  }));

  app.get("/api/reputation/:address", asyncRoute(async (req, res) => {
    const addr = requireAddress(req.params.address);
    res.json(camel(db.get("SELECT * FROM reputation WHERE address = ?", [addr])) || { address: addr, joined: 0, completed: 0, defaults: 0 });
  }));

  app.get("/api/profiles", asyncRoute(async (req, res) => {
    const list = String(req.query.addresses || "").split(",").filter(Boolean).map(requireAddress);
    res.json(names(list));
  }));

  // Display names stay off chain (personal data). The wallet signs the request, so nobody can
  // rename someone else, and an older signed message cannot overwrite a newer name.
  app.post("/api/profiles", express.json({ limit: "4kb" }), asyncRoute(async (req, res) => {
    const { address, displayName, issuedAt, signature } = req.body || {};
    const addr = requireAddress(address);
    if (!validName(displayName)) throw Object.assign(new Error("Name must be 1 to 32 letters, digits, spaces or . _ ' -"), { status: 400 });
    const when = Date.parse(issuedAt);
    if (!Number.isFinite(when) || Math.abs(Date.now() - when) > 10 * 60 * 1000) {
      throw Object.assign(new Error("Signed message is too old or from the future"), { status: 400 });
    }
    const message = profileMessage(addr, displayName, issuedAt);
    let signer;
    try {
      signer = ethers.verifyMessage(message, signature);
    } catch {
      throw Object.assign(new Error("Bad signature"), { status: 400 });
    }
    if (lc(signer) !== addr) throw Object.assign(new Error("Signature is not from this address"), { status: 401 });
    const existing = db.get("SELECT updated_at FROM profiles WHERE address = ?", [addr]);
    if (existing && existing.updated_at >= when) throw Object.assign(new Error("A newer name is already saved"), { status: 409 });
    db.run(
      `INSERT INTO profiles (address, display_name, message, signature, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET display_name = excluded.display_name, message = excluded.message,
         signature = excluded.signature, updated_at = excluded.updated_at`,
      [addr, displayName, message, signature, when]
    );
    db.save();
    res.json({ address: addr, displayName });
  }));

  app.post("/api/ipfs", express.raw({ type: () => true, limit: ipfs.maxBytes + 1 }), asyncRoute(async (req, res) => {
    const filename = String(req.get("x-filename") || "terms").slice(0, 120);
    const contentType = req.get("content-type") || "application/octet-stream";
    const result = await ipfs.add(Buffer.from(req.body || []), { filename, contentType });
    res.status(201).json(result);
  }));

  const serveCid = asyncRoute(async (req, res) => {
    const found = await ipfs.get(req.params.cid);
    if (!found) return res.status(404).json({ error: "Not found in the IPFS store" });
    res.set("Content-Type", found.meta.contentType || "application/octet-stream");
    if (found.meta.filename) res.set("X-Filename", found.meta.filename);
    res.set("Access-Control-Expose-Headers", "X-Filename");
    res.set("Cache-Control", "public, max-age=31536000, immutable"); // content addressed: never changes
    res.send(found.bytes);
  });
  app.get("/ipfs/:cid", serveCid);
  app.get("/api/ipfs/:cid", serveCid);

  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.type === "entity.too.large" ? "File too large" : err.message }));
  return app;
}

module.exports = { createApp, profileMessage, PROFILE_PREFIX };
