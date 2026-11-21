import { useTx } from "../state/tx.jsx";
import { short } from "../lib/format.js";
import { CopyButton } from "./Addr.jsx";

const STATUS = {
  wallet: "Confirm in your wallet",
  pending: "Waiting to be mined",
  confirmed: "Confirmed",
  failed: "Failed",
  rejected: "Rejected",
};

export default function TxTray() {
  const { txs, dismiss } = useTx();
  if (!txs.length) return null;
  return (
    <aside className="tray" aria-live="polite" aria-label="Transactions">
      {txs.slice(0, 4).map((t) => (
        <div key={t.id} className={`tx ${t.status}`}>
          <div className="tx-top">
            <strong>{t.label}</strong>
            <button className="x" onClick={() => dismiss(t.id)} aria-label="Dismiss">×</button>
          </div>
          <div className="tx-status">
            {STATUS[t.status]}
            {t.steps.length > 1 && t.status !== "confirmed" && ` (step ${t.step + 1} of ${t.steps.length}: ${t.steps[t.step]})`}
          </div>
          {t.hash && <div className="small muted" title={t.hash}>tx {short(t.hash)}{t.block ? `, block ${t.block}` : ""}{t.status === "confirmed" && t.gasUsed ? `, ${Number(t.gasUsed).toLocaleString()} gas` : ""} <CopyButton value={t.hash} label="Copy transaction hash" /></div>}
          {t.error && (
            <div className="tx-error">
              <span>{t.error.title}</span>
              {t.error.detail && <span className="small muted">{t.error.detail}</span>}
            </div>
          )}
        </div>
      ))}
    </aside>
  );
}
