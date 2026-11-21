// Client for the off chain indexer API. Every call has a short timeout so a dead indexer
// never freezes the page; callers fall back to reading the chain directly (see chainData.js).
import { ethers } from "ethers";
import { API_URL } from "./config.js";

async function call(path, { method = "GET", body, headers = {}, timeout = 3000, raw = false } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(API_URL + path, { method, body, headers, signal: ctrl.signal, cache: "no-store" });
    const isJson = !(raw && res.ok) && res.headers.get("content-type")?.includes("json");
    const data = isJson ? await res.json() : await res.arrayBuffer();
    if (!res.ok) throw Object.assign(new Error(data?.error || `Indexer responded ${res.status}`), { status: res.status });
    return { data, res };
  } finally {
    clearTimeout(timer);
  }
}

export const api = {
  health: async () => (await call("/api/health", { timeout: 1500 })).data,
  circles: async (q = "") => (await call(`/api/circles${q}`)).data,
  circle: async (a) => (await call(`/api/circles/${a}`)).data,
  circleEvents: async (a) => (await call(`/api/circles/${a}/events`)).data,
  accountEvents: async (a) => (await call(`/api/accounts/${a}/events`)).data,
  notifications: async (a) => (await call(`/api/accounts/${a}/notifications`)).data,
  profiles: async (addrs) => (addrs.length ? (await call(`/api/profiles?addresses=${addrs.join(",")}`)).data : {}),
  reputation: async (a) => (await call(`/api/reputation/${a}`)).data,

  /** Signs and saves a display name (off chain). The message matches offchain/api/server.js. */
  async setName(signer, address, displayName) {
    const issuedAt = new Date().toISOString();
    const message = `Trustless ROSCA display name\nAddress: ${ethers.getAddress(address)}\nName: ${displayName}\nIssued at: ${issuedAt}`;
    const signature = await signer.signMessage(message);
    return (await call("/api/profiles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address, displayName, issuedAt, signature }),
    })).data;
  },

  async upload(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return (await call("/api/ipfs", {
      method: "POST",
      headers: { "content-type": file.type || "application/octet-stream", "x-filename": file.name || "terms" },
      body: bytes,
      timeout: 15000,
    })).data;
  },

  async ipfsGet(cid) {
    const { data, res } = await call(`/ipfs/${cid}`, { timeout: 5000, raw: true });
    return { bytes: new Uint8Array(data), contentType: res.headers.get("content-type"), filename: res.headers.get("x-filename") };
  },
};
