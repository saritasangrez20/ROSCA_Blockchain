// Runs transactions and tracks their status for the transaction tray.
// Each action is a list of steps (for example "Approve mUSD" then "Join"). Every step goes
// through: waiting for wallet -> pending (hash) -> confirmed (block, gas) or failed (reason).
// Before asking the wallet, ethers estimates gas, which simulates the call; a call that would
// revert fails here with the contract's reason, so the member never pays for a failed tx.
import { createContext, useCallback, useContext, useMemo, useState } from "react";
import { decodeError } from "../lib/errors.js";
import { IFACES } from "../lib/contracts.js";
import { useWallet } from "./wallet.jsx";

const TxContext = createContext(null);
export const useTx = () => useContext(TxContext);

let nextId = 1;

export function TxProvider({ children }) {
  const { signer, wrongNetwork } = useWallet();
  const [txs, setTxs] = useState([]);
  const [version, setVersion] = useState(0); // bumped after every confirmed tx so views reload

  const update = (id, patch) => setTxs((list) => list.map((t) => (t.id === id ? { ...t, ...patch } : t)));

  /**
   * @param {string} label  what the member is doing, e.g. "Join circle"
   * @param {Array<{label: string, send: (signer) => Promise<import('ethers').TransactionResponse|null>}>} steps
   *        a step may return null to skip itself (for example when the approval already exists)
   * @returns {Promise<{ok: boolean, receipts: object[]}>}
   */
  const run = useCallback(async (label, steps) => {
    const id = nextId++;
    const entry = { id, label, status: "wallet", step: 0, steps: steps.map((s) => s.label), startedAt: Date.now() };
    setTxs((list) => [entry, ...list].slice(0, 12));
    if (!signer) {
      update(id, { status: "failed", error: { title: "Connect a wallet first", detail: "" } });
      return { ok: false, receipts: [] };
    }
    if (wrongNetwork) {
      update(id, { status: "failed", error: { title: "Your wallet is on the wrong network", detail: "Press Switch network at the top." } });
      return { ok: false, receipts: [] };
    }
    const receipts = [];
    for (let i = 0; i < steps.length; i++) {
      update(id, { status: "wallet", step: i, hash: null });
      try {
        const tx = await steps[i].send(signer);
        if (!tx) continue; // step not needed
        update(id, { status: "pending", hash: tx.hash });
        const rc = await tx.wait();
        if (rc.status !== 1) throw Object.assign(new Error("Transaction reverted"), { code: "CALL_EXCEPTION", receipt: rc });
        receipts.push(rc);
        update(id, { hash: rc.hash, block: rc.blockNumber, gasUsed: rc.gasUsed.toString() });
      } catch (e) {
        const error = decodeError(e, IFACES);
        update(id, { status: error.kind === "rejected" ? "rejected" : "failed", error });
        setVersion((v) => v + 1);
        return { ok: false, receipts, error };
      }
    }
    const last = receipts[receipts.length - 1];
    update(id, { status: "confirmed", step: steps.length - 1, hash: last?.hash, block: last?.blockNumber, gasUsed: receipts.reduce((s, r) => s + r.gasUsed, 0n).toString() });
    setVersion((v) => v + 1);
    return { ok: true, receipts };
  }, [signer, wrongNetwork]);

  const dismiss = useCallback((id) => setTxs((list) => list.filter((t) => t.id !== id)), []);
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  const value = useMemo(() => ({ txs, run, dismiss, version, refresh }), [txs, run, dismiss, version, refresh]);
  return <TxContext.Provider value={value}>{children}</TxContext.Provider>;
}
