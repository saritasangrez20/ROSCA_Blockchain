// Browser side IPFS CID check (same rules as offchain/lib/cid.js, using Web Crypto).
// CIDv1, raw codec, sha2-256: the CID is just a fingerprint of the file, so re hashing the
// downloaded terms and comparing with the CID stored on chain proves they were not changed.
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
  return new Uint8Array(out);
}

async function sha256(bytes) {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
}

export async function cidOf(bytes) {
  const digest = await sha256(bytes);
  const all = new Uint8Array(4 + digest.length);
  all.set(PREFIX, 0);
  all.set(digest, 4);
  return "b" + base32Encode(all);
}

export function parseCid(cid) {
  if (typeof cid !== "string" || !cid) return { valid: false, verifiable: false, reason: "No CID stored" };
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) return { valid: true, verifiable: false, reason: "Old style CIDv0 cannot be checked with a plain hash" };
  if (!cid.startsWith("b")) return { valid: false, verifiable: false, reason: "Not an IPFS CIDv1" };
  let bytes;
  try {
    bytes = base32Decode(cid.slice(1));
  } catch (e) {
    return { valid: false, verifiable: false, reason: `Not a valid CID (${e.message})` };
  }
  if (bytes.length < 4 || bytes[0] !== 0x01) return { valid: false, verifiable: false, reason: "Not an IPFS CIDv1" };
  if (bytes[1] !== 0x55) return { valid: true, verifiable: false, reason: "CID codec is not raw, so it cannot be checked with a plain hash" };
  if (bytes[2] !== 0x12 || bytes[3] !== 0x20 || bytes.length !== 36) return { valid: true, verifiable: false, reason: "CID does not use sha2-256" };
  return { valid: true, verifiable: true, digest: bytes.subarray(4) };
}

export async function verifyCid(cid, bytes) {
  const parsed = parseCid(cid);
  if (!parsed.verifiable) return { ok: false, ...parsed };
  const digest = await sha256(bytes);
  const ok = digest.length === parsed.digest.length && digest.every((b, i) => b === parsed.digest[i]);
  return { ok, valid: true, verifiable: true, reason: ok ? "Matches the CID on chain" : "Does not match the CID on chain" };
}
