// Plain language guidance: what the connected person should do next in a circle, and the
// step list shown in the Steps box. Pure functions over live chain data (see chainData.js).
import { money } from "./format.js";

const lc = (a) => (a ? a.toLowerCase() : "");

/**
 * The single most useful next action for `account` in circle `c`.
 * @returns {{ who: "you" | "others" | "keeper" | "done" | "closed", text: string }}
 */
export function nextAction(c, account) {
  if (!c) return null;
  const me = c.me || {};
  const now = c.now;
  const mine = (a) => lc(a) === lc(account);
  const credit = BigInt(me.withdrawable || 0);

  if (account && credit > 0n && c.state !== 3) {
    return { who: "you", text: `Your turn: press Claim payout to receive ${money(credit)}.` };
  }

  if (c.state === 0) {
    const missing = c.groupSize - c.memberCount;
    if (now > c.joinDeadline) return { who: "closed", text: "Joining has closed before the circle filled. The keeper cancels it and refunds every deposit. Start a new circle from Organize." };
    if (account && !me.joined) return { who: "you", text: "Your turn: press Approve and join. Two wallet confirmations: approve the deposit, then join." };
    return { who: "others", text: `Waiting for ${missing} more member${missing === 1 ? "" : "s"} to join. Use "Open in new tab" and pick another Local test account for each member.` };
  }

  if (c.state === 1) {
    const d = c.draw;
    const revealOpen = d.commitCount === d.memberCount || now > d.commitDeadline;
    if (me.isMember && !me.committed && now <= d.commitDeadline) return { who: "you", text: "Your turn: press Commit secret." };
    if (me.isMember && me.committed && !me.revealed && revealOpen && now <= d.revealDeadline) return { who: "you", text: "Your turn: press Reveal secret." };
    if (!revealOpen) return { who: "others", text: `Waiting for ${d.memberCount - d.commitCount} member${d.memberCount - d.commitCount === 1 ? "" : "s"} to commit. Reveal opens when everyone has.` };
    if (d.revealCount < d.memberCount && now <= d.revealDeadline) return { who: "others", text: `Waiting for ${d.memberCount - d.revealCount} member${d.memberCount - d.revealCount === 1 ? "" : "s"} to reveal.` };
    return { who: "keeper", text: "Everyone revealed. The keeper finalizes the draw within a few seconds (or press Finalize draw)." };
  }

  if (c.state === 2) {
    const unpaid = c.members.filter((m) => m.position > 0 && !m.removed && !m.paidThisRound);
    const closed = now > c.roundDeadline;
    const participant = me.isMember && me.position > 0;
    if (participant && !me.paidThisRound && !closed) {
      return { who: "you", text: mine(c.currentRecipient) ? `Your turn: pay round ${c.currentRound}. You receive this round's pot.` : `Your turn: pay round ${c.currentRound} (${money(c.contribution)}).` };
    }
    if (!unpaid.length) return { who: "keeper", text: `Everyone paid round ${c.currentRound}. The keeper settles it within a few seconds.` };
    if (closed) return { who: "keeper", text: `Round ${c.currentRound}'s deadline passed. The keeper settles it now; ${unpaid.length} missed payment${unpaid.length === 1 ? " is" : "s are"} taken from deposits.` };
    return {
      who: "others",
      text: `Waiting for ${unpaid.length} payment${unpaid.length === 1 ? "" : "s"} in round ${c.currentRound}. To show a default, leave one member unpaid and use Skip time: +1 hour in the Steps box.`,
    };
  }

  if (c.state === 3) {
    if (account && credit > 0n) return { who: "you", text: `Your turn: press Withdraw to take your last ${money(credit)}.` };
    return { who: "done", text: "Circle complete. Every pot was paid and deposits were returned." };
  }
  return { who: "closed", text: "Cancelled. Every deposit was refunded. Start a new circle from Organize." };
}

/**
 * The demo walkthrough, with each step marked done, current or todo.
 * @param {{ account?: string, wrongNetwork?: boolean, balance?: bigint|null, circle?: object|null }} s
 */
export function guideSteps({ account, wrongNetwork, balance, circle }) {
  const c = circle;
  const st = c ? c.state : -1;
  const steps = [
    {
      key: "wallet",
      title: "Connect a wallet",
      done: !!account,
      help: "Connect MetaMask on the Hardhat Local network with an imported test account (Organizer = account #1). Or pick a Local test account.",
    },
    { key: "network", title: "Right network", done: !!account && !wrongNetwork, help: "If a red banner says wrong network, press Switch network." },
    { key: "money", title: "Get test mUSD", done: balance !== null && balance !== undefined && balance > 0n, help: "Press Get test mUSD in the top bar (free test money, one small gas fee)." },
    {
      key: "create",
      title: "Organizer creates a circle",
      done: !!c,
      help: "Go to Organize, choose Quick demo, then Upload terms and create circle.",
      link: { href: "#/organize", label: "Go to Organize" },
    },
    {
      key: "join",
      title: c ? `Members join (${c.memberCount} of ${c.groupSize})` : "Members join",
      done: st >= 1 && st !== 4,
      help: 'For each member: "Open in new tab", pick Local test account #2 to #5, Get test mUSD, then Approve and join.',
    },
    {
      key: "draw",
      title: c && st === 1 ? `Draw the order (${c.draw.commitCount} committed, ${c.draw.revealCount} revealed)` : "Draw the payout order",
      done: st >= 2 && st !== 4,
      help: "Each member: Commit secret, then Reveal secret once everyone committed. The keeper finalizes.",
    },
    {
      key: "rounds",
      title: c && st === 2 ? `Rounds: round ${c.currentRound} of ${c.participantCount}` : "Pay rounds and claim pots",
      done: st === 3,
      help: "Each round every member pays; the keeper settles; the recipient presses Claim payout.",
    },
    {
      key: "default",
      title: "Show a default (optional)",
      done: st === 3 || (c?.members || []).some((m) => m.defaults > 0),
      optional: true,
      help: "In a round, leave one member unpaid, then Skip time: +1 hour. Their deposit covers the missed payment.",
    },
    { key: "finish", title: "Finish and withdraw", done: st === 3, help: "After the last round, deposits come back automatically; Withdraw any credit left." },
  ];
  if (st === 4) {
    steps.splice(4, steps.length - 4, { key: "cancelled", title: "Circle cancelled", done: false, warn: true, help: "It did not fill before the join deadline (or the Organizer cancelled). Deposits were refunded. Create a new circle.", link: { href: "#/organize", label: "Create a new circle" } });
  }
  const current = steps.findIndex((s) => !s.done && !s.optional);
  return steps.map((s, i) => ({ ...s, status: s.done ? "done" : i === current ? "current" : "todo" }));
}
