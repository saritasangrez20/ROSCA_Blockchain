// The commit and reveal secret for the payout draw. It is generated in the browser, never sent
// anywhere, and kept in this browser's storage until the member reveals. Losing it means not
// being able to reveal (and losing one contribution), so the UI also downloads a backup file.
//
// Every secret this browser generates for a circle and member is kept (not just the last one),
// and the reveal step picks the one whose fingerprint matches the commitment on chain. So a
// second Commit click, or a commit from another tab, can never leave the wrong secret behind.
import { ethers } from "ethers";

const key = (chainId, circle, account) => `rosca:secret:${chainId}:${circle.toLowerCase()}:${account.toLowerCase()}`;
const HEX32 = /0x[0-9a-fA-F]{64}/;

export function newSecret() {
  return ethers.hexlify(ethers.randomBytes(32));
}

export function commitmentFor(secret, member, circle) {
  return ethers.solidityPackedKeccak256(["bytes32", "address", "address"], [secret, member, circle]);
}

/** All secrets this browser has generated for this circle and member (oldest first). */
export function loadSecrets(chainId, circle, account) {
  try {
    const raw = localStorage.getItem(key(chainId, circle, account));
    if (!raw) return [];
    if (raw.startsWith("0x")) return [raw]; // older single value format
    return JSON.parse(raw).filter((s) => HEX32.test(s));
  } catch {
    return [];
  }
}

export function saveSecret(chainId, circle, account, secret) {
  try {
    const all = loadSecrets(chainId, circle, account);
    if (!all.includes(secret)) all.push(secret);
    localStorage.setItem(key(chainId, circle, account), JSON.stringify(all.slice(-20)));
    return true;
  } catch {
    return false;
  }
}

/** The stored secret that matches `onChainCommitment`, or null. */
export function findMatchingSecret(chainId, circle, account, onChainCommitment) {
  if (!onChainCommitment) return null;
  return loadSecrets(chainId, circle, account).find((s) => commitmentFor(s, account, circle) === onChainCommitment) || null;
}

/** Pulls a 0x... secret out of whatever was pasted (just the secret, or the whole backup file). */
export function extractSecret(text) {
  const m = String(text || "").match(HEX32);
  return m ? m[0] : null;
}

export function downloadSecret(circle, account, secret) {
  const text = `Trustless ROSCA payout draw secret\nCircle: ${circle}\nMember: ${account}\nSecret: ${secret}\n\nKeep this until you have revealed.\n`;
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = Object.assign(document.createElement("a"), {
    href: url,
    download: `draw-secret-circle-${circle.slice(2, 8)}-member-${account.slice(2, 8)}.txt`,
  });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}