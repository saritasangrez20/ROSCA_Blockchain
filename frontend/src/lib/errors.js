// Turns a failed wallet or contract call into a sentence a member can act on.
// Handles: rejection in the wallet, revert strings from our contracts, OpenZeppelin custom
// errors (roles, pause, token balance and allowance), panics, gas money and network problems.
import { ethers } from "ethers";

const REVERT_TEXT = {
  "Circle: already a member": "You have already joined this circle.",
  "Circle: already paid this round": "You have already paid for this round.",
  "Circle: bad group size": "Group size must be between 2 and 20 members.",
  "Circle: contribution too large": "The contribution is too large for one round.",
  "Circle: duration too long": "Round, grace, join and draw durations must each be shorter than about 136 years.",
  "Circle: full": "This circle is already full.",
  "Circle: joining closed": "Joining has closed: the join deadline has passed.",
  "Circle: max defaults too large": "The past defaults limit must be 65,535 or less.",
  "Circle: missing terms": "Upload the terms document first; the circle needs its CID.",
  "Circle: nothing to claim": "There is nothing for you to claim in this circle right now.",
  "Circle: only factory": "Only the circle factory can set up a circle.",
  "Circle: only organizer before deadline": "Only the Organizer can cancel before the join deadline. Anyone can cancel after it.",
  "Circle: round closed": "This round's payment window (round plus grace period) has closed. Your deposit will cover it at settlement.",
  "Circle: round still open": "The round cannot be settled yet: not everyone has paid and the deadline (round plus grace) has not passed.",
  "Circle: too many past defaults": "Your address has more past defaults than this circle allows.",
  "Circle: wrong module": "The circle was set up with contract addresses that do not belong to this factory.",
  "Circle: zero contribution": "The contribution must be more than zero.",
  "Circle: zero duration": "Round, join and draw durations must be more than zero.",
  "Circle: zero module": "The circle was set up with a missing contract address.",
  "Factory: zero address": "The factory was set up with a missing contract address.",
  "Lifecycle: illegal transition": "That step is not allowed from the circle's current stage.",
  "Lifecycle: pause cooldown": "A new pause is possible only 7 days after the previous pause ended.",
  "Lifecycle: wrong state": "That action is not available at this stage of the circle.",
  "Lifecycle: zero address": "Organizer and admin addresses must be set.",
  "Order: already committed": "You have already committed a secret for this draw.",
  "Order: already revealed": "You have already revealed your secret.",
  "Order: already started": "The payout draw has already started.",
  "Order: commit phase still open": "Wait until everyone has committed (or the commit window ends) before revealing.",
  "Order: commit window closed": "The commit window has closed.",
  "Order: duration too long": "The draw phase duration is too long.",
  "Order: empty commitment": "The commitment is empty.",
  "Order: finalize in a later block": "Wait for one more block after the last reveal, then finalize the draw. (This stops the last member to reveal from choosing their own slot.)",
  "Order: no active draw": "There is no payout draw running for this circle.",
  "Order: not a member": "Only members of this circle take part in the draw.",
  "Order: reveal window closed": "The reveal window has closed.",
  "Order: reveal window still open": "The draw can be finalized once everyone has revealed or the reveal window ends.",
  "Order: too few members": "A draw needs at least two members.",
  "Order: too many members": "Too many members for one draw.",
  "Order: zero duration": "The draw phase duration must be more than zero.",
  "Order: wrong secret": "That secret does not match your commitment. Use the secret saved when you committed.",
  "Vault: bad position": "Invalid payout position.",
  "Vault: payer must be member or circle": "Deposits can only be paid by the member or the circle.",
  "Vault: zero amount": "The deposit amount must be more than zero.",
};

const ROLE_NAMES = Object.fromEntries(
  ["ORGANIZER_ROLE", "MEMBER_ROLE", "PAUSER_ROLE", "REGISTRAR_ROLE", "CIRCLE_ROLE"].map((r) => [ethers.id(r), r])
);
ROLE_NAMES[ethers.ZeroHash] = "DEFAULT_ADMIN_ROLE";

const ROLE_TEXT = {
  ORGANIZER_ROLE: "Only the Organizer of this circle can do that.",
  MEMBER_ROLE: "Only members of this circle can do that.",
  PAUSER_ROLE: "Only the platform admin can pause or unpause.",
  REGISTRAR_ROLE: "Only the factory can register circles.",
  CIRCLE_ROLE: "Only a registered circle can do that.",
  DEFAULT_ADMIN_ROLE: "Only the system admin can do that.",
};

const fmt = (v) => `${Number(ethers.formatUnits(v, 6)).toLocaleString("en-US", { maximumFractionDigits: 2 })} mUSD`;

function customErrorText(name, args) {
  switch (name) {
    case "AccessControlUnauthorizedAccount": {
      const role = ROLE_NAMES[args[1]] || "a required role";
      return ROLE_TEXT[role] || `Your account is missing ${role}.`;
    }
    case "EnforcedPause":
      return "The platform admin has paused joining and payments (at most 7 days). Settling, refunds and claims still work.";
    case "ExpectedPause":
      return "The circle is not paused.";
    case "ERC20InsufficientBalance":
      return `Not enough mUSD: you have ${fmt(args[1])} but need ${fmt(args[2])}. Use Get test mUSD.`;
    case "ERC20InsufficientAllowance":
      return `The contract is not approved to take ${fmt(args[2])} (approved: ${fmt(args[1])}). Approve first, then retry.`;
    case "ReentrancyGuardReentrantCall":
      return "Blocked a reentrant call (security guard).";
    case "InvalidInitialization":
      return "This circle is already set up.";
    case "SafeERC20FailedOperation":
      return "The token transfer failed.";
    default:
      return null;
  }
}

const PANIC = { 0x01: "assertion failed", 0x11: "arithmetic overflow or underflow", 0x12: "division by zero", 0x32: "array index out of range" };

/** Looks through the nested error shapes of ethers, MetaMask and Hardhat for revert data. */
function findRevertData(err, depth = 0) {
  if (!err || depth > 6) return null;
  if (typeof err === "string") return /^0x[0-9a-f]{8}/i.test(err) ? err : null;
  for (const key of ["data", "revert"]) {
    const v = err[key];
    if (typeof v === "string" && /^0x[0-9a-f]{8}/i.test(v)) return v;
    if (v && typeof v === "object" && typeof v.data === "string" && /^0x[0-9a-f]{8}/i.test(v.data)) return v.data;
  }
  for (const key of ["error", "info", "cause", "data"]) {
    const found = err[key] && typeof err[key] === "object" ? findRevertData(err[key], depth + 1) : null;
    if (found) return found;
  }
  return null;
}

function findMessage(err) {
  const seen = [];
  let e = err;
  for (let i = 0; e && i < 6; i++) {
    if (e.message) seen.push(e.message);
    e = e.error || e.info?.error || e.cause;
  }
  return seen.join(" | ");
}

function isRejection(err) {
  const codes = [err?.code, err?.info?.error?.code, err?.error?.code];
  return codes.includes("ACTION_REJECTED") || codes.includes(4001) || /user (rejected|denied)/i.test(findMessage(err));
}

/**
 * @param {unknown} err
 * @param {ethers.Interface[]} ifaces  contract interfaces used to decode custom errors
 * @returns {{ title: string, detail: string, raw: string, kind: string }}
 */
export function decodeError(err, ifaces = []) {
  const raw = findMessage(err) || String(err);
  if (isRejection(err)) return { kind: "rejected", title: "You rejected the transaction in your wallet", detail: "Nothing was sent.", raw };

  // MetaMask: this site has no permission for the selected account or network (EIP 1193 code 4100)
  const codes = [err?.code, err?.error?.code, err?.info?.error?.code, err?.error?.error?.code];
  if (codes.includes(4100) || /not been authorized by the user/i.test(raw)) {
    return {
      kind: "unauthorized",
      title: "MetaMask has not connected this account or network to the app",
      detail: "In MetaMask, open the site connection for localhost:5173, allow the account you are using and the Hardhat Local network, then retry. Use an account imported from the npx hardhat node list: your own MetaMask account has no test ETH.",
      raw,
    };
  }

  // 1. ethers already decoded a revert string
  const reason = err?.reason || err?.revert?.args?.[0];
  if (typeof reason === "string" && reason && err?.revert?.name !== "Panic") {
    return { kind: "revert", title: REVERT_TEXT[reason] || reason, detail: `Contract said: "${reason}"`, raw };
  }

  // 2. decode raw revert data ourselves
  const data = findRevertData(err);
  if (data) {
    const selector = data.slice(0, 10).toLowerCase();
    try {
      if (selector === "0x08c379a0") {
        const [msg] = ethers.AbiCoder.defaultAbiCoder().decode(["string"], "0x" + data.slice(10));
        return { kind: "revert", title: REVERT_TEXT[msg] || msg, detail: `Contract said: "${msg}"`, raw };
      }
      if (selector === "0x4e487b71") {
        const [code] = ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], "0x" + data.slice(10));
        return { kind: "panic", title: `The contract stopped: ${PANIC[Number(code)] || "panic"}`, detail: `Panic code 0x${code.toString(16)}`, raw };
      }
    } catch {
      /* fall through */
    }
    for (const iface of ifaces) {
      try {
        const parsed = iface.parseError(data);
        if (parsed) {
          const text = customErrorText(parsed.name, parsed.args);
          return { kind: "custom", title: text || `Contract error ${parsed.name}`, detail: `${parsed.name}(${parsed.args.map(String).join(", ")})`, raw };
        }
      } catch {
        /* try the next interface */
      }
    }
  }
  if (err?.revert?.name) {
    const text = customErrorText(err.revert.name, err.revert.args || []);
    return { kind: "custom", title: text || `Contract error ${err.revert.name}`, detail: err.revert.name, raw };
  }

  // 3. wallet and network problems
  if (err?.code === "INSUFFICIENT_FUNDS" || /insufficient funds/i.test(raw)) {
    return { kind: "funds", title: "Not enough ETH to pay for gas", detail: "On the local Hardhat chain, use one of the funded test accounts.", raw };
  }
  if (/nonce too (high|low)|invalid nonce|nonce has already been used/i.test(raw)) {
    return {
      kind: "nonce",
      title: "Your wallet's transaction count is out of date",
      detail: "This happens after restarting the Hardhat node. In MetaMask: Settings, Advanced, Clear activity tab data, then retry.",
      raw,
    };
  }
  if (err?.code === "NETWORK_ERROR" || err?.code === "SERVER_ERROR" || /failed to fetch|ECONNREFUSED|could not detect network/i.test(raw)) {
    return { kind: "network", title: "Cannot reach the blockchain node", detail: "Check that `npx hardhat node` is running on 127.0.0.1:8545.", raw };
  }
  if (err?.code === "CALL_EXCEPTION") {
    return { kind: "revert", title: "The contract rejected this transaction", detail: "No reason was given.", raw };
  }
  return { kind: "unknown", title: err?.shortMessage || "Something went wrong", detail: raw.slice(0, 300), raw };
}
