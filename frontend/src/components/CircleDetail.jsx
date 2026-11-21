import { useCallback, useEffect } from "react";
import { ethers } from "ethers";
import { useWallet } from "../state/wallet.jsx";
import { useTx } from "../state/tx.jsx";
import { usePoll, indexerOrChain } from "../state/hooks.js";
import { api } from "../lib/api.js";
import { loadCircleLive, circleHistoryFromChain } from "../lib/chainData.js";
import { STATES } from "../lib/contracts.js";
import { money, relative, short, same, duration } from "../lib/format.js";
import RotationRing from "./RotationRing.jsx";
import ActionPanel from "./ActionPanel.jsx";
import MembersLedger from "./MembersLedger.jsx";
import TermsCheck from "./TermsCheck.jsx";
import History from "./History.jsx";
import Addr from "./Addr.jsx";
import { openAsAnotherMember } from "./Guide.jsx";
import { useGuide } from "../state/guide.jsx";
import { nextAction } from "../lib/journey.js";

export default function CircleDetail({ address, indexer }) {
  const { deployment, account } = useWallet();
  const { version } = useTx();
  const valid = ethers.isAddress(address);
  const guide = useGuide();
  useEffect(() => {
    if (valid && guide.circleAddress?.toLowerCase() !== address.toLowerCase()) guide.setCircle(address);
  }, [address]); // eslint-disable-line react-hooks/exhaustive-deps

  const live = usePoll(() => loadCircleLive(address, account, deployment), [address, account, deployment, version], 3000);
  const c = live.data;

  const people = c ? [c.organizer, ...c.members.map((m) => m.address)] : [];
  const names = usePoll(() => (indexer.online && people.length ? api.profiles(people) : Promise.resolve({})), [people.join(","), indexer.online], 10000);
  const nameOf = useCallback(
    (a) => {
      if (!a) return "";
      const n = names.data?.[a.toLowerCase()];
      const label = n || short(a);
      return same(a, account) ? `${label} (you)` : label;
    },
    [names.data, account]
  );

  const history = usePoll(
    () => (indexer.online ? indexerOrChain(() => api.circleEvents(address), () => circleHistoryFromChain(address, deployment)) : circleHistoryFromChain(address, deployment).then((value) => ({ source: "chain", value }))),
    [address, deployment, version, indexer.online],
    6000
  );

  if (!valid) return <div className="banner danger">That is not a valid circle address.</div>;
  if (live.error && !c) return <div className="banner danger">Could not read this circle from the chain: {live.error.shortMessage || live.error.message}</div>;
  if (!c) return <p className="muted">Reading the circle from the chain…</p>;

  const me = c.me;
  const roles = [];
  if (account && same(c.organizer, account)) roles.push("Organizer");
  if (me?.isMember) roles.push("Member");
  if (me?.removed) roles.push("Removed");
  if (account && same(c.currentRecipient, account)) roles.push("Receives this round");
  if (c.wallet?.isPauser) roles.push("Admin");
  if (account && !roles.length) roles.push("Visitor");

  const next = nextAction(c, account);
  const nextDeadline =
    c.state === 0 ? ["Joining closes", c.joinDeadline]
      : c.state === 1 ? (c.draw.commitCount < c.draw.memberCount && c.now <= c.draw.commitDeadline ? ["Commit by", c.draw.commitDeadline] : ["Reveal by", c.draw.revealDeadline])
        : c.state === 2 ? ["Payments close", c.roundDeadline] : null;

  return (
    <article className="circle">
      <div className="circle-head">
        <div>
          <p className="crumbs"><a href="#/">Circles</a> / circle <Addr value={c.address} /></p>
          <h1>
            <span className="num">{money(c.contribution)}</span> a round, {c.groupSize} members
          </h1>
          <p className="lede">
            Organized by <Addr value={c.organizer} label={nameOf(c.organizer)} />. <span className={`state s${c.state}`}>{STATES[c.state]}</span>
            {c.paused && <span className="state paused">Paused by admin</span>}
          </p>
        </div>
        <div className="head-side">
          {account && (
            <ul className="roles" aria-label="Your role in this circle">
              {roles.map((r) => <li key={r}>{r}</li>)}
            </ul>
          )}
          <button className="btn ghost" onClick={() => openAsAnotherMember(c.address)}>Open in new tab (another member)</button>
        </div>
      </div>

      {next && (
        <div className={`next wide ${next.who}`} role="status">
          <span className="next-label">{next.who === "you" ? "Your next step" : next.who === "keeper" ? "Happening automatically" : next.who === "done" ? "Done" : next.who === "closed" ? "Closed" : "Waiting for others"}</span>
          <span>{next.text}</span>
        </div>
      )}

      <nav className="subnav" aria-label="Sections of this circle">
        <a href={`#/circle/${address}`} onClick={(e) => { e.preventDefault(); document.getElementById("actions")?.scrollIntoView({ behavior: "smooth" }); }}>Actions</a>
        <a href={`#/circle/${address}`} onClick={(e) => { e.preventDefault(); document.getElementById("members")?.scrollIntoView({ behavior: "smooth" }); }}>Members</a>
        <a href={`#/circle/${address}`} onClick={(e) => { e.preventDefault(); document.getElementById("terms")?.scrollIntoView({ behavior: "smooth" }); }}>Terms</a>
        <a href={`#/circle/${address}`} onClick={(e) => { e.preventDefault(); document.getElementById("history")?.scrollIntoView({ behavior: "smooth" }); }}>History</a>
      </nav>

      <div className="circle-grid" id="actions">
        <div className="ring-col">
          <RotationRing c={c} nameOf={nameOf} account={account} />
          <dl className="facts">
            <div><dt>Pot each round</dt><dd className="num">{money(BigInt(c.contribution) * BigInt(c.participantCount || c.groupSize))}</dd></div>
            <div><dt>Deposit to join</dt><dd className="num">{money(c.joinCollateral)}</dd></div>
            <div><dt>Round length</dt><dd>{duration(c.config.roundDuration)} + {duration(c.config.gracePeriod)} grace</dd></div>
            {nextDeadline && <div><dt>{nextDeadline[0]}</dt><dd>{relative(nextDeadline[1], c.now)}</dd></div>}
            {me && me.joined && <div><dt>Your deposit</dt><dd className="num">{money(me.collateral)}</dd></div>}
          </dl>
        </div>
        <ActionPanel c={c} history={history.data?.value} />
      </div>

      <MembersLedger c={c} nameOf={nameOf} account={account} />
      <div className="two-col even">
        <TermsCheck cid={c.termsCid} />
        <History events={history.data?.value} source={history.data?.source} nameOf={nameOf} loading={history.loading} />
      </div>
    </article>
  );
}
