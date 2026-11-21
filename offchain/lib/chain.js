// Small helpers shared by the indexer, notifier and keeper.
const { ethers } = require("ethers");

/**
 * Current chain time in seconds.
 * On a Hardhat node the "pending" block already carries the time the next block will get,
 * including any evm_increaseTime jump, so reminders and the keeper follow the chain clock
 * rather than the computer clock. Other networks fall back to the latest block or wall time.
 */
async function chainNow(provider) {
  try {
    const pending = await provider.send("eth_getBlockByNumber", ["pending", false]);
    if (pending && pending.timestamp) return Number(BigInt(pending.timestamp));
  } catch {
    /* not supported: fall through */
  }
  const latest = await provider.getBlock("latest");
  return Math.max(Number(latest.timestamp), Math.floor(Date.now() / 1000));
}

/** Converts ethers values (BigInt, Result arrays) into plain JSON friendly values. */
function toPlain(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(toPlain);
  if (value && typeof value === "object" && typeof value.toArray === "function") return value.toArray().map(toPlain);
  return value;
}

/** Turns a parsed log into { name, args: { argName: value } } with JSON friendly values. */
function eventArgs(parsed) {
  const args = {};
  parsed.fragment.inputs.forEach((input, i) => {
    args[input.name || `arg${i}`] = toPlain(parsed.args[i]);
  });
  return args;
}

/** Formats a 6 decimal mUSD amount for humans. */
function fmtToken(raw) {
  const s = ethers.formatUnits(BigInt(raw || 0), 6);
  return `${s.endsWith(".0") ? s.slice(0, -2) : s} mUSD`;
}

const STATE_NAMES = ["Open", "OrderDraw", "Active", "Completed", "Cancelled"];

module.exports = { chainNow, toPlain, eventArgs, fmtToken, STATE_NAMES };
