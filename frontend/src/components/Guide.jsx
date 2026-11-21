// The Steps box: a walkthrough of one full circle, with the current step highlighted and the
// next action for the connected account. On wide screens it sits beside the page; on narrow
// screens the Steps button in the top bar opens it as a panel.
import { useWallet } from "../state/wallet.jsx";
import { useGuide } from "../state/guide.jsx";
import { guideSteps, nextAction } from "../lib/journey.js";
import { STATES } from "../lib/contracts.js";
import Addr from "./Addr.jsx";
import DevTools from "./DevTools.jsx";

export function openAsAnotherMember(address) {
  // "noopener" gives the new tab its own session, so it can sign in as a different account.
  window.open(`${window.location.origin}${window.location.pathname}#/circle/${address}`, "_blank", "noopener");
}

export default function Guide() {
  const { account, wrongNetwork } = useWallet();
  const g = useGuide();
  const steps = guideSteps({ account, wrongNetwork, balance: g.balance, circle: g.circle });
  const next = g.circle ? nextAction(g.circle, account) : null;
  const doneCount = steps.filter((s) => s.done && !s.optional).length;
  const total = steps.filter((s) => !s.optional).length;

  return (
    <aside className={`guide ${g.open ? "open" : ""}`} aria-label="Demo steps">
      <div className="guide-head">
        <h2>Steps</h2>
        <span className="muted small">{doneCount} of {total} done</span>
        <button className="x" onClick={() => g.setOpen(false)} aria-label="Hide steps">×</button>
      </div>

      {g.circleAddress && g.circle && (
        <div className="guide-circle">
          <div className="small muted">Following circle</div>
          <div className="row">
            <Addr value={g.circleAddress} />
            <span className={`state s${g.circle.state}`}>{STATES[g.circle.state]}</span>
          </div>
          <div className="row">
            <a href={`#/circle/${g.circleAddress}`}>Open</a>
            <button className="link" onClick={() => openAsAnotherMember(g.circleAddress)}>Open in new tab</button>
            <button className="link muted" onClick={() => g.setCircle(null)}>Stop following</button>
          </div>
        </div>
      )}

      {next && (
        <div className={`next ${next.who}`} role="status">
          <span className="next-label">{next.who === "you" ? "Your next step" : next.who === "keeper" ? "Happening automatically" : next.who === "done" ? "Done" : next.who === "closed" ? "Closed" : "Waiting for others"}</span>
          <span>{next.text}</span>
        </div>
      )}

      <ol className="steps">
        {steps.map((s) => (
          <li key={s.key} className={`${s.status} ${s.optional ? "optional" : ""} ${s.warn ? "warn" : ""}`}>
            <span className="mark" aria-hidden="true">{s.status === "done" ? "✓" : ""}</span>
            <div>
              <strong>{s.title}</strong>
              {(s.status === "current" || s.warn) && <p className="small">{s.help}</p>}
              {s.status === "current" && s.link && <a className="small" href={s.link.href}>{s.link.label}</a>}
            </div>
          </li>
        ))}
      </ol>

      <DevTools compact />

      <details className="guide-tips">
        <summary>Tips</summary>
        <ul className="small">
          <li>One tab per person: the Organizer uses MetaMask; each member uses a Local test account (#2 to #5) in its own tab.</li>
          <li>Every button that changes something is a transaction with a small gas fee in test ETH. Reading is free.</li>
          <li>Rounds in the Quick demo last 10 minutes plus 2 minutes grace. Skip time (above) moves the local chain clock forward.</li>
          <li>After restarting the Hardhat node, clear MetaMask's activity tab data (Settings, Advanced).</li>
        </ul>
      </details>
    </aside>
  );
}
