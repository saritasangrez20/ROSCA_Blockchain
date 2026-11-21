import { useEffect, useRef, useState } from "react";
import { useWallet } from "../state/wallet.jsx";
import { useTx } from "../state/tx.jsx";
import { usePoll } from "../state/hooks.js";
import { api } from "../lib/api.js";
import { remindersFromChain } from "../lib/chainData.js";
import { chainNow } from "../lib/contracts.js";
import { relative } from "../lib/format.js";

const REMINDERS = new Set(["CONTRIBUTION_DUE", "COMMIT_DUE", "REVEAL_DUE"]);
const readKey = (a) => `rosca:read:${a.toLowerCase()}`;
const loadRead = (a) => {
  try {
    return new Set(JSON.parse(localStorage.getItem(readKey(a)) || "[]"));
  } catch {
    return new Set();
  }
};

/** Reminders from the notifier, or computed from the chain if the indexer is down. */
export function useReminders(indexer) {
  const { account, deployment } = useWallet();
  const { version } = useTx();
  return usePoll(async () => {
    if (!account || !deployment) return { items: [], source: null, now: 0 };
    const now = await chainNow();
    if (indexer.online) {
      try {
        return { items: await api.notifications(account), source: "notifier", now };
      } catch {
        /* fall back below */
      }
    }
    return { items: await remindersFromChain(account, deployment), source: "chain", now };
  }, [account, deployment, version, indexer.online], 5000);
}

export function NoticeList({ items, now, read, onOpen }) {
  if (!items.length) return <p className="muted pad">Nothing needs your attention.</p>;
  return (
    <ul className="notices">
      {items.map((n) => (
        <li key={n.id} className={`notice ${n.severity} ${read?.has(n.id) ? "read" : ""}`}>
          <a href={`#/circle/${n.circle}`} onClick={() => onOpen?.(n)}>
            <strong>{n.title}</strong>
            {n.body && <span>{n.body}</span>}
            <span className="muted small">
              {n.deadline && REMINDERS.has(n.kind) ? `Deadline ${relative(n.deadline, now)}` : n.chainTime ? relative(n.chainTime, now) : ""}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export default function Notifications({ indexer }) {
  const { account } = useWallet();
  const { data } = useReminders(indexer);
  const [open, setOpen] = useState(false);
  const [read, setRead] = useState(() => loadRead(account));
  const box = useRef(null);
  useEffect(() => setRead(loadRead(account)), [account]);
  useEffect(() => {
    const close = (e) => box.current && !box.current.contains(e.target) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const items = data?.items || [];
  const unread = items.filter((n) => !read.has(n.id)).length;
  const markAll = () => {
    const next = new Set([...read, ...items.map((n) => n.id)]);
    setRead(next);
    try {
      localStorage.setItem(readKey(account), JSON.stringify([...next].slice(-500)));
    } catch {
      /* storage full or blocked */
    }
  };

  return (
    <div className="bell" ref={box}>
      <button className="btn ghost" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Reminders{unread > 0 && <span className="count" aria-label={`${unread} unread`}>{unread}</span>}
      </button>
      {open && (
        <div className="drop" role="dialog" aria-label="Reminders">
          <div className="drop-head">
            <span className="muted small">{data?.source === "chain" ? "Worked out from the chain (notifier offline)" : "From the notifier"}</span>
            <button className="link" onClick={markAll}>Mark all read</button>
          </div>
          <NoticeList items={items} now={data?.now} read={read} onOpen={() => setOpen(false)} />
          <a className="drop-foot" href="#/activity" onClick={() => setOpen(false)}>All activity</a>
        </div>
      )}
    </div>
  );
}
