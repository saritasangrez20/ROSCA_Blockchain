import { useWallet } from "../state/wallet.jsx";
import { useTx } from "../state/tx.jsx";
import { usePoll } from "../state/hooks.js";
import { api } from "../lib/api.js";
import { short, same } from "../lib/format.js";
import { useReminders, NoticeList } from "./Notifications.jsx";
import { describe } from "./History.jsx";
import { dateTime } from "../lib/format.js";

export default function Activity({ indexer }) {
  const { account } = useWallet();
  const { version } = useTx();
  const reminders = useReminders(indexer);
  const hist = usePoll(() => (account && indexer.online ? api.accountEvents(account) : Promise.resolve(null)), [account, version, indexer.online], 6000);
  const rep = usePoll(() => (account && indexer.online ? api.reputation(account) : Promise.resolve(null)), [account, version, indexer.online], 10000);
  const nameOf = (a) => (same(a, account) ? "You" : short(a));

  if (!account) return <div className="empty">Connect a wallet to see your reminders and history.</div>;
  return (
    <section className="two-col">
      <div>
        <div className="page-head"><div><h1>Your activity</h1><p className="lede">Reminders for every circle you are in, and everything you have done.</p></div></div>
        <h2>Reminders</h2>
        <p className="source">{reminders.data?.source === "chain" ? "Worked out from the chain because the notifier is offline." : "From the notifier."}</p>
        <NoticeList items={reminders.data?.items || []} now={reminders.data?.now} />
      </div>
      <aside>
        <h2>Your record</h2>
        {rep.data ? (
          <p>{rep.data.joined} circles joined, {rep.data.completed} completed, {rep.data.defaults} missed payments.</p>
        ) : (
          <p className="muted">Shown when the indexer is running. The same numbers are on chain in the reputation registry.</p>
        )}
        <h2>History</h2>
        {!indexer.online ? (
          <p className="muted">The indexer is offline. Open a circle to read its history straight from the chain.</p>
        ) : !hist.data?.length ? (
          <p className="muted">No activity yet.</p>
        ) : (
          <ol className="timeline compact">
            {hist.data.map((e) => {
              const text = describe(e, nameOf);
              return text ? (
                <li key={`${e.txHash}-${e.logIndex}`}>
                  <span className="when">{dateTime(e.blockTime)}</span>
                  <span className="what"><a href={`#/circle/${e.circle}`}>{text}</a></span>
                </li>
              ) : null;
            })}
          </ol>
        )}
      </aside>
    </section>
  );
}
