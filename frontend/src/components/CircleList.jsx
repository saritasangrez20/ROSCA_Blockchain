import { useState } from "react";
import { ethers } from "ethers";
import { useWallet } from "../state/wallet.jsx";
import { useTx } from "../state/tx.jsx";
import { usePoll, indexerOrChain } from "../state/hooks.js";
import { api } from "../lib/api.js";
import { listCirclesFromChain } from "../lib/chainData.js";
import { circleAt, chainNow, STATES } from "../lib/contracts.js";
import { money, relative, same, short } from "../lib/format.js";
import Hero from "./Hero.jsx";

export async function fetchCircles({ deployment, account, filter, indexerOnline }) {
  const fromChain = async () => {
    const all = await listCirclesFromChain(deployment);
    if (filter === "member") {
      const flags = await Promise.all(all.map((c) => circleAt(c.address).getMembers().then((m) => m.some((x) => same(x, account)))));
      return all.filter((_, i) => flags[i]);
    }
    if (filter === "organizer") return all.filter((c) => same(c.organizer, account));
    return all;
  };
  const q = filter === "member" ? `?member=${account}` : filter === "organizer" ? `?organizer=${account}` : "";
  const res = indexerOnline ? await indexerOrChain(() => api.circles(q), fromChain) : { source: "chain", value: await fromChain() };
  return { ...res, now: await chainNow() };
}

function nextStep(c, now) {
  if (c.state === 0) return `${c.memberCount} of ${c.groupSize} joined, joining closes ${relative(c.joinDeadline, now)}`;
  if (c.state === 1) return "Payout order draw in progress";
  if (c.state === 2) return `Round ${c.currentRound}, payments close ${relative(c.roundDeadline, now)}`;
  if (c.state === 3) return "All rounds settled";
  return "Did not start; deposits refunded";
}

export function CircleRows({ rows, now, account, empty }) {
  if (!rows.length) return <div className="empty">{empty}</div>;
  return (
    <ul className="circle-rows">
      {rows.map((c) => (
        <li key={c.address}>
          <a href={`#/circle/${c.address}`} className="circle-row">
            <span className={`state s${c.state}`}>{STATES[c.state]}</span>
            <span className="row-main">
              <strong className="num">{money(c.contribution)} × {c.groupSize}</strong>
              <span className="muted">{nextStep(c, now)}</span>
            </span>
            <span className="row-meta">
              <span>{same(c.organizer, account) ? "You organize" : `Organizer ${c.organizerName || short(c.organizer)}`}</span>
              <span className="muted small">{short(c.address)}</span>
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export default function CircleList({ mode, indexer }) {
  const { deployment, account } = useWallet();
  const { version } = useTx();
  const [goto, setGoto] = useState("");
  const filter = mode === "mine" ? "member" : null;
  const list = usePoll(
    () => (mode === "mine" && !account ? Promise.resolve({ value: [], source: null }) : fetchCircles({ deployment, account, filter, indexerOnline: indexer.online })),
    [deployment, account, mode, version, indexer.online]
  );
  const rows = list.data?.value || [];

  return (
    <section>
      {mode === "all" && <Hero />}
      <div className="page-head">
        <div>
          {mode === "mine" ? <h1>Circles you belong to</h1> : <h2 style={{ marginTop: 0 }}>All circles</h2>}
          <p className="lede">{mode === "mine" ? "Circles you joined, in any stage." : "Open one to join, or to follow its rounds."}</p>
        </div>
        <form className="goto" onSubmit={(e) => { e.preventDefault(); if (ethers.isAddress(goto)) window.location.hash = `#/circle/${goto}`; }}>
          <label>
            <span>Open by address</span>
            <input value={goto} onChange={(e) => setGoto(e.target.value.trim())} placeholder="0x…" spellCheck="false" />
          </label>
          <button className="btn" disabled={!ethers.isAddress(goto)}>Open</button>
        </form>
      </div>
      {list.data?.source && <p className="source">Listed from {list.data.source === "indexer" ? "the indexer" : "the chain directly"}.</p>}
      {list.error && !list.data && <div className="banner danger">{list.error.message}</div>}
      {mode === "mine" && !account ? (
        <div className="empty">Connect a wallet to see your circles.</div>
      ) : list.loading && !list.data ? (
        <p className="muted">Loading circles…</p>
      ) : (
        <CircleRows
          rows={rows}
          now={list.data?.now}
          account={account}
          empty={mode === "mine" ? <>You have not joined a circle yet. <a href="#/">Browse open circles</a>.</> : <>No circles yet. <a href="#/organize">Start one</a>.</>}
        />
      )}
    </section>
  );
}
