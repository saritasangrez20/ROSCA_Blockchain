import { ethers } from "ethers";

export const UNIT = 10n ** 6n;

export function money(raw, { sign = false } = {}) {
  const v = BigInt(raw ?? 0);
  const s = Number(ethers.formatUnits(v < 0n ? -v : v, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${sign && v > 0n ? "+" : ""}${v < 0n ? "−" : ""}${s} mUSD`;
}

export const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
export const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function duration(sec) {
  sec = Math.max(0, Math.round(Number(sec)));
  if (sec < 60) return `${sec}s`;
  const units = [["d", 86400], ["h", 3600], ["m", 60]];
  const parts = [];
  for (const [u, n] of units) {
    if (sec >= n) {
      parts.push(`${Math.floor(sec / n)}${u}`);
      sec %= n;
    }
    if (parts.length === 2) break;
  }
  return parts.join(" ");
}

/** "in 2d 3h" or "4h ago" relative to chain time. */
export function relative(ts, now) {
  if (!ts || !now) return "";
  const d = Number(ts) - Number(now);
  return d >= 0 ? `in ${duration(d)}` : `${duration(-d)} ago`;
}

export const dateTime = (ts) =>
  ts ? new Date(Number(ts) * 1000).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
