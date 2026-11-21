import { money, same } from "../lib/format.js";
import Addr from "./Addr.jsx";

export default function MembersLedger({ c, nameOf, account }) {
  const rows = [...c.members].sort((a, b) => (a.position || 99) - (b.position || 99));
  const drawing = c.state === 1;
  return (
    <section className="ledger" id="members">
      <h2>Members</h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Seat</th>
              <th scope="col">Member</th>
              <th scope="col" className="r">Deposit</th>
              <th scope="col">{drawing ? "Draw" : c.currentRound ? `Round ${c.currentRound}` : "Status"}</th>
              <th scope="col" className="r">To claim</th>
              <th scope="col" className="r">Missed here</th>
              <th scope="col" className="r">Record</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const isRecipient = same(m.address, c.currentRecipient);
              let round = "–";
              if (m.removed) round = "Removed";
              else if (drawing) round = m.revealed ? "Revealed" : m.committed ? "Committed" : "Not committed";
              else if (c.state === 2) round = m.paidThisRound ? "Paid" : c.now > c.roundDeadline ? "Missed" : "Not yet";
              return (
                <tr key={m.address} className={`${same(m.address, account) ? "me" : ""} ${m.removed ? "removed" : ""}`}>
                  <td className="num">{m.position || "–"}</td>
                  <td>
                    <Addr className="who-cell" value={m.address} label={nameOf(m.address)} />
                    {isRecipient && <span className="tag">receives this round</span>}
                    {same(m.address, c.organizer) && <span className="tag quiet">organizer</span>}
                  </td>
                  <td className="r num">{money(m.collateral)}</td>
                  <td><span className={`st ${round.replace(/\s/g, "-").toLowerCase()}`}>{round}</span></td>
                  <td className="r num">{BigInt(m.withdrawable) > 0n ? money(m.withdrawable) : "–"}</td>
                  <td className="r num">{m.defaults || "–"}</td>
                  <td className="r small" title="Across all circles: completed / defaults">{m.reputation.completed} done, {m.reputation.defaults} missed</td>
                </tr>
              );
            })}
            {Array.from({ length: Math.max(0, c.groupSize - rows.length) }, (_, i) => (
              <tr key={`open-${i}`} className="open-seat"><td>–</td><td colSpan={6} className="muted">Open seat</td></tr>
            ))}
          </tbody>
        </table>
      </div>
      {c.rounds.length > 0 && (
        <>
          <h3>Rounds</h3>
          <ol className="rounds">
            {c.rounds.map((r) => (
              <li key={r.round} className={r.settled ? "done" : "now"}>
                <span>Round {r.round}</span>
                <span>{nameOf(r.recipient)}</span>
                <span className="num">{r.settled ? money(r.pot) : "in progress"}</span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
