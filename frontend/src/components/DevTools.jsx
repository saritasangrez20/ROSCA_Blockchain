// Local chain only: move the chain clock forward so deadlines can be shown in a live demo.
// Uses Hardhat's evm_increaseTime + evm_mine on the read RPC; MetaMask is not involved.
import { useState } from "react";
import { useWallet } from "../state/wallet.jsx";
import { useTx } from "../state/tx.jsx";
import { usePoll } from "../state/hooks.js";
import { readProvider, chainNow } from "../lib/contracts.js";
import { LOCAL_CHAIN_ID } from "../lib/config.js";
import { dateTime } from "../lib/format.js";

const JUMPS = [["1 minute", 60], ["10 minutes", 600], ["1 hour", 3600], ["1 day", 86400], ["7 days", 604800], ["33 days", 33 * 86400]];

export default function DevTools({ compact = false }) {
  const { deployment } = useWallet();
  const { refresh, version } = useTx();
  const [busy, setBusy] = useState(false);
  const now = usePoll(() => chainNow(), [version, busy], 5000);
  if (!deployment || Number(deployment.chainId) !== LOCAL_CHAIN_ID) return null;

  const jump = async (sec) => {
    setBusy(true);
    try {
      await readProvider.send("evm_increaseTime", [sec]);
      await readProvider.send("evm_mine", []);
    } finally {
      setBusy(false);
      refresh();
    }
  };

  if (compact) {
    return (
      <div className="clock-mini">
        <div className="small"><strong>Skip time</strong> <span className="muted">(local chain: {now.data ? dateTime(now.data) : "…"})</span></div>
        <div className="presets">
          {JUMPS.slice(0, 4).map(([label, sec]) => (
            <button key={sec} className="btn ghost" disabled={busy} onClick={() => jump(sec)}>+{label}</button>
          ))}
        </div>
      </div>
    );
  }
  return (
    <details className="devtools">
      <summary>Local chain clock: {now.data ? dateTime(now.data) : "…"}</summary>
      <p className="muted small">Hardhat only. Moves block time forward so round and draw deadlines can pass during a demo.</p>
      <div className="presets">
        {JUMPS.map(([label, sec]) => (
          <button key={sec} className="btn ghost" disabled={busy} onClick={() => jump(sec)}>+{label}</button>
        ))}
      </div>
    </details>
  );
}
