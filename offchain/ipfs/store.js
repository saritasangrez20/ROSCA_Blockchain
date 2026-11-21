// IPFS terms storage.
//
// The Organizer's terms document is uploaded here first; only the returned CID goes on chain.
// Two backends:
//   1. Local content addressed store (always on): offchain/data/ipfs/<cid>. Same CID format
//      as IPFS, so nothing changes if the team later pins to a real node.
//   2. A real IPFS node (Kubo) when IPFS_API_URL is set: the file is also added and pinned
//      there with settings that give the same CID, and the CIDs are compared.
//
// Integrity never depends on this service: the frontend re hashes whatever it downloads and
// compares it with the CID stored in the Circle contract.
const fs = require("fs");
const path = require("path");
const { cidOf, parseCid, verifyCid } = require("../lib/cid");

class IpfsStore {
  constructor({ dir, apiUrl = "", gatewayUrl = "", maxBytes = 1024 * 1024 }) {
    this.dir = dir;
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.gatewayUrl = gatewayUrl.replace(/\/$/, "");
    this.maxBytes = maxBytes;
    fs.mkdirSync(dir, { recursive: true });
  }

  _file(cid) {
    return path.join(this.dir, cid);
  }

  /** Stores bytes and returns their CID. */
  async add(bytes, { filename = "terms", contentType = "application/octet-stream" } = {}) {
    if (!bytes || bytes.length === 0) throw Object.assign(new Error("Terms file is empty"), { status: 400 });
    if (bytes.length > this.maxBytes) {
      throw Object.assign(new Error(`Terms file is larger than ${this.maxBytes} bytes`), { status: 413 });
    }
    const cid = cidOf(bytes);
    fs.writeFileSync(this._file(cid), bytes);
    fs.writeFileSync(this._file(cid) + ".json", JSON.stringify({ filename, contentType, size: bytes.length, addedAt: new Date().toISOString() }));

    const pinned = { local: true, kubo: null };
    if (this.apiUrl) {
      try {
        const kuboCid = await this._kuboAdd(bytes, filename);
        pinned.kubo = kuboCid === cid ? "pinned" : `CID mismatch (${kuboCid})`;
      } catch (e) {
        pinned.kubo = `failed: ${e.message}`;
      }
    }
    return { cid, size: bytes.length, filename, contentType, pinned };
  }

  /** Returns { bytes, meta } or null. Bytes are always checked against the CID before returning. */
  async get(cid) {
    const parsed = parseCid(cid);
    if (!parsed.valid) throw Object.assign(new Error(`Invalid CID: ${parsed.reason}`), { status: 400 });

    const file = this._file(cid);
    if (fs.existsSync(file)) {
      const bytes = fs.readFileSync(file);
      const metaFile = file + ".json";
      const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, "utf8")) : {};
      return { bytes, meta, source: "local" };
    }
    if (this.gatewayUrl) {
      const res = await fetch(`${this.gatewayUrl}/ipfs/${cid}`);
      if (res.ok) {
        const bytes = Buffer.from(await res.arrayBuffer());
        if (parsed.verifiable && !verifyCid(cid, bytes).ok) {
          throw Object.assign(new Error("Gateway returned content that does not match the CID"), { status: 502 });
        }
        return { bytes, meta: { contentType: res.headers.get("content-type") }, source: "gateway" };
      }
    }
    return null;
  }

  has(cid) {
    return fs.existsSync(this._file(cid));
  }

  async _kuboAdd(bytes, filename) {
    // raw-leaves + CIDv1 + a 1 MiB chunk gives a single raw block, so the CID is sha256(file).
    const url = `${this.apiUrl}/api/v0/add?cid-version=1&raw-leaves=true&chunker=size-1048576&pin=true`;
    const form = new FormData();
    form.append("file", new Blob([bytes]), filename);
    const res = await fetch(url, { method: "POST", body: form });
    if (!res.ok) throw new Error(`Kubo responded ${res.status}`);
    const body = await res.json();
    return body.Hash;
  }
}

module.exports = { IpfsStore };
