import { useState } from "react";
import { money, dateTime, short } from "../lib/format.js";
import { STATES } from "../lib/contracts.js";
import { CopyButton } from "./Addr.jsx";

/** One plain sentence per event. Returns null for events not worth showing. */
export function describe(e, nameOf) {
  const a = e.args || {};
  const n = (x) => nameOf(x);
  switch (e.name) {
    case "CircleCreated": return `${n(a.organizer)} created the circle: ${a.groupSize} members, ${money(a.contribution)} per round.`;
    case "MemberJoined": return `${n(a.member)} joined and locked ${money(a.collateral)}.`;
    case "DrawStarted": return a.circle ? "Every seat taken. The payout draw started." : null; // PayoutOrder's version only
    case "Committed": return `${n(a.member)} committed a draw secret.`;
    case "Revealed": return `${n(a.member)} revealed their secret.`;
    case "DrawFinalized": return a.success ? "Draw finalized with every member." : "Draw finalized without some members.";
    case "MemberRemoved": return `${n(a.member)} did not reveal and was removed. Penalty ${money(a.penalty)}.`;
    case "PayoutOrderSet": return `Payout order: ${a.order.map(n).join(", ")}.`;
    case "RoundStarted": return `Round ${a.round} started. ${n(a.recipient)} receives the pot; payments close ${dateTime(a.deadline)}.`;
    case "ContributionMade": return `${n(a.member)} paid ${money(a.amount)} for round ${a.round}.`;
    case "MemberDefaulted":
      return `${n(a.member)} missed round ${a.round}. ${money(a.covered)} taken from their deposit` + (BigInt(a.uncovered) > 0n ? `, ${money(a.uncovered)} still owed.` : ".");
    case "CollateralDeposited": return `Vault locked ${money(a.amount)} for ${n(a.member)}.`;
    case "CollateralReleased": return `Vault returned ${money(a.amount)} to ${n(a.member)}.`;
    case "CollateralSlashed": return `Vault moved ${money(a.amount)} of ${n(a.member)}'s deposit into the pot.`;
    case "CollateralRefilled": return `${money(a.amount)} of ${n(a.member)}'s pot refilled their deposit.`;
    case "DebtRecovered": return `${money(a.amount)} of debt recovered from ${n(a.debtor)}.`;
    case "RoundSettled": return `Round ${a.round} settled. ${n(a.recipient)} was credited ${money(a.pot)}` + (BigInt(a.shortfall) > 0n ? `, shortfall ${money(a.shortfall)}.` : ".");
    case "PayoutClaimed": return `${n(a.member)} claimed ${money(a.amount)}.`;
    case "CircleCancelled": return `Circle cancelled by ${n(a.by)}. Deposits refunded.`;
    case "CircleCompleted": return "Circle completed. Remaining deposits returned.";
    case "StateChanged": return `Stage: ${STATES[a.from]} to ${STATES[a.to]}.`;
    case "Paused": return "The platform admin paused joining and paying.";
    case "Unpaused": return "The platform admin lifted the pause.";
    default: return null;
  }
}

export default function History({ events, source, nameOf, loading }) {
  const [all, setAll] = useState(false);
  const rows = (events || []).map((e) => ({ e, text: describe(e, nameOf) })).filter((r) => r.text);
  const LIMIT = 12;
  return (
    <section className="history" id="history">
      <h2>History</h2>
      <p className="source">{source === "indexer" ? "From the indexer." : source === "chain" ? "Read from chain logs directly (indexer offline)." : ""}</p>
      {loading && !events ? <p className="muted">Loading history…</p> : !rows.length ? <p className="muted">Nothing has happened yet.</p> : (
        <ol className="timeline">
          {rows.slice().reverse().slice(0, all ? undefined : LIMIT).map(({ e, text }) => (
            <li key={`${e.txHash}-${e.logIndex}`} className={`ev ${e.name}`}>
              <span className="when">{dateTime(e.blockTime)}</span>
              <span className="what">{text}</span>
              <span className="ev-tx muted small" title={e.txHash}>block {e.blockNumber}, tx {short(e.txHash)} <CopyButton value={e.txHash} label="Copy transaction hash" /></span>
            </li>
          ))}
        </ol>
      )}
      {rows.length > LIMIT && (
        <button className="btn ghost history-more" onClick={() => setAll((v) => !v)}>
          {all ? "Show the latest 12" : `Show all ${rows.length} events`}
        </button>
      )}
    </section>
  );
}
