// IPFS content identifiers (CIDs) computed locally, with no IPFS library.
//
// We use CID version 1 with the "raw" codec and a sha2-256 multihash. For a file that fits in
// one IPFS block this is exactly the CID that `ipfs add --cid-version=1 --raw-leaves` prints,
// and its digest is simply sha256(file). That is what lets the frontend re hash the terms it
// downloads and compare them with the CID stored in the Circle contract.
//
// Layout: 0x01 (CIDv1) | 0x55 (raw) | 0x12 (sha2-256) | 0x20 (32 bytes) | digest
// Text form: "b" + lowercase base32 without padding (multibase base32).
const crypto = require("crypto");

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const PREFIX = [0x01, 0x55, 0x12, 0x20];

function base32Encode(bytes) {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(text) {
  const out = [];
  let bits = 0;
  let value = 0;
  for (const ch of text) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`invalid base32 character "${ch}"`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
    value &= (1 << bits) - 1;
  }
  return Buffer.from(out);
}

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest();
}

/** CID (v1, raw, sha2-256) of some bytes. */
function cidOf(bytes) {
  return "b" + base32Encode(Buffer.concat([Buffer.from(PREFIX), sha256(bytes)]));
}

/**
 * Parses a CID string.
 * @returns {{ valid: boolean, verifiable: boolean, digest?: Buffer, reason?: string }}
 *          verifiable = we can check it by hashing the file (CIDv1 raw sha2-256).
 */
function parseCid(cid) {
  if (typeof cid !== "string" || cid.length === 0) return { valid: false, verifiable: false, reason: "empty CID" };
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) {
    return { valid: true, verifiable: false, reason: "CIDv0 (dag-pb) cannot be checked by a plain hash" };
  }
  if (!cid.startsWith("b")) return { valid: false, verifiable: false, reason: "not a base32 CIDv1" };
  let bytes;
  try {
    bytes = base32Decode(cid.slice(1));
  } catch (e) {
    return { valid: false, verifiable: false, reason: e.message };
  }
  if (bytes.length < 4 || bytes[0] !== 0x01) return { valid: false, verifiable: false, reason: "not a CIDv1" };
  if (bytes[1] !== 0x55) return { valid: true, verifiable: false, reason: "codec is not raw (file larger than one block?)" };
  if (bytes[2] !== 0x12 || bytes[3] !== 0x20 || bytes.length !== 36) {
    return { valid: true, verifiable: false, reason: "hash is not sha2-256" };
  }
  return { valid: true, verifiable: true, digest: bytes.subarray(4) };
}

/** True when `bytes` hash to exactly `cid`. */
function verifyCid(cid, bytes) {
  const parsed = parseCid(cid);
  if (!parsed.verifiable) return { ok: false, ...parsed };
  const ok = sha256(bytes).equals(parsed.digest);
  return { ok, valid: true, verifiable: true, reason: ok ? "hash matches CID" : "content does not match CID" };
}

module.exports = { cidOf, parseCid, verifyCid, base32Encode, base32Decode };
