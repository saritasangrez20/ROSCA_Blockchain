import { useState } from "react";
import { ethers } from "ethers";
import { useWallet } from "../state/wallet.jsx";
import { useTx } from "../state/tx.jsx";
import { usePoll } from "../state/hooks.js";
import { contractsFor, readProvider } from "../lib/contracts.js";
import { api } from "../lib/api.js";
import { money, short } from "../lib/format.js";
import Notifications from "./Notifications.jsx";
import Addr from "./Addr.jsx";
import { useGuide } from "../state/guide.jsx";

export function Mark({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="10.5" fill="none" stroke="var(--brand)" strokeWidth="3.5" />
      <circle cx="16" cy="16" r="4.5" fill="var(--gold)" />
      <circle cx="16" cy="5.5" r="3.6" fill="var(--ink)" />
      <circle cx="25.5" cy="21.5" r="3.2" fill="var(--paid)" />
      <circle cx="6.5" cy="21.5" r="3.2" fill="var(--due)" />
    </svg>
  );
}

const NAV = [
  ["", "Circles"],
  ["organize", "Organize"],
  ["mine", "My circles"],
  ["activity", "Activity"],
];

export default function TopBar({ route, indexer }) {
  const w = useWallet();
  const guide = useGuide();
  const { run, version } = useTx();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [nameMsg, setNameMsg] = useState(null);

  const bal = usePoll(async () => {
    if (!w.account || !w.deployment) return null;
    const { token } = contractsFor(w.deployment);
    const [musd, eth, profile] = await Promise.all([
      token.balanceOf(w.account),
      readProvider.getBalance(w.account),
      api.profiles([w.account]).catch(() => ({})),
    ]);
    return { musd, eth, name: profile[w.account.toLowerCase()] || null };
  }, [w.account, w.deployment, version], 6000);

  const faucet = () =>
    run("Get 100,000 test mUSD", [{ label: "Faucet", send: (s) => contractsFor(w.deployment, s).token.faucet() }]);

  const saveName = async (e) => {
    e.preventDefault();
    setNameMsg(null);
    try {
      await api.setName(w.signer, w.account, name.trim());
      setNaming(false);
      bal.reload();
    } catch (err) {
      setNameMsg(err.code === "ACTION_REJECTED" ? "You declined to sign." : err.message);
    }
  };

  return (
    <header className="top">
      <div className="top-row">
        <a className="brand" href="#/">
          <Mark />
          <span>Committee</span>
        </a>
        <nav aria-label="Main">
          {NAV.map(([r, label]) => (
            <a key={r} href={`#/${r}`} aria-current={route === r ? "page" : undefined}>{label}</a>
          ))}
        </nav>
        <div className="top-right">
          <span className={`pill ${indexer.online ? "ok" : "warn"}`} title={indexer.online ? `Indexer at block ${indexer.status?.lastBlock}` : "The indexer API is not reachable"}>
            {indexer.online ? "Indexer live" : "Indexer offline: reading the chain"}
          </span>
          {w.account && <Notifications indexer={indexer} />}
          <button className={`btn ghost steps-toggle ${guide.open ? "on" : ""}`} aria-expanded={guide.open} onClick={() => guide.setOpen(!guide.open)}>
            {guide.open ? "Hide steps" : "Show steps"}
          </button>
        </div>
      </div>

      <div className="wallet-row">
        {!w.account ? (
          <div className="connect">
            {w.hasInjected ? (
              <button className="btn primary" onClick={() => w.connectMetaMask().catch(() => {})}>Connect MetaMask</button>
            ) : (
              <span className="muted">No browser wallet found. Install MetaMask, or use a local test account.</span>
            )}
            {w.devAccounts.length > 0 && (
              <label className="inline">
                <span>Local test account</span>
                <select defaultValue="" onChange={(e) => e.target.value && w.connectDev(e.target.value)} aria-label="Use a local Hardhat test account">
                  <option value="">Choose…</option>
                  {w.devAccounts.map((a, i) => (
                    <option key={a} value={a}>#{i} {short(a)}{i === 0 ? " (admin)" : i === 1 ? " (organizer in samples)" : ""}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        ) : (
          <div className="me-bar">
            <div className="who">
              <strong><Addr value={w.account} label={bal.data?.name || short(w.account)} /></strong>
              <span className="muted mono-ish" title={w.account}>{bal.data?.name ? short(w.account) : ""} {w.kind === "dev" ? "local test account" : "MetaMask"}</span>
            </div>
            <div className="amounts">
              <span title="Test stablecoin balance"><strong className="num">{bal.data ? money(bal.data.musd) : "…"}</strong></span>
              <span className="muted num">{bal.data ? `${Number(ethers.formatEther(bal.data.eth)).toFixed(3)} ETH for gas` : ""}</span>
            </div>
            <div className="actions">
              <button className="btn" onClick={faucet} disabled={w.wrongNetwork}>Get test mUSD</button>
              {w.kind === "metamask" && <button className="btn ghost" onClick={() => w.addTokenToWallet().catch(() => {})}>Show mUSD in MetaMask</button>}
              <button className="btn ghost" onClick={() => { setName(bal.data?.name || ""); setNaming((v) => !v); }} disabled={!indexer.online} title={indexer.online ? "" : "Display names are stored by the indexer, which is offline"}>
                Set display name
              </button>
              <button className="btn ghost" onClick={w.disconnect}>Disconnect</button>
            </div>
          </div>
        )}
      </div>

      {naming && (
        <form className="name-form" onSubmit={saveName}>
          <label>
            <span>Display name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={32} required autoFocus />
          </label>
          <button className="btn primary" type="submit">Sign and save name</button>
          <span className="muted">Saved by the indexer only, never on chain. Your wallet signs it so nobody else can change it.</span>
          {nameMsg && <span className="error-text">{nameMsg}</span>}
        </form>
      )}

      {w.wrongNetwork && (
        <div className="banner danger" role="alert">
          Your wallet is on chain {w.walletChainId}; this app runs on chain {w.expectedChainId} (Hardhat Local).
          <button className="btn" onClick={() => w.switchNetwork().catch(() => {})}>Switch network</button>
        </div>
      )}
    </header>
  );
}
