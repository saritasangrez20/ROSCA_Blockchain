import { useEffect, useState } from "react";
import { WalletProvider, useWallet } from "./state/wallet.jsx";
import { TxProvider } from "./state/tx.jsx";
import { GuideProvider, useGuide } from "./state/guide.jsx";
import Guide from "./components/Guide.jsx";
import { useIndexerHealth } from "./state/hooks.js";
import TopBar from "./components/TopBar.jsx";
import CircleList from "./components/CircleList.jsx";
import CircleDetail from "./components/CircleDetail.jsx";
import CreateCircle from "./components/CreateCircle.jsx";
import Activity from "./components/Activity.jsx";
import TxTray from "./components/TxTray.jsx";
import DevTools from "./components/DevTools.jsx";

/** Tiny hash router: #/  #/organize  #/mine  #/activity  #/circle/0x... */
function useRoute() {
  const read = () => (window.location.hash.replace(/^#/, "") || "/").split("/").filter(Boolean);
  const [parts, setParts] = useState(read);
  useEffect(() => {
    const on = () => {
      setParts(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return parts;
}

function Setup({ message }) {
  return (
    <section className="setup">
      <h1>The app cannot see the contracts yet</h1>
      <p>{message}</p>
      <ol>
        <li>Terminal 1: <code>npx hardhat node</code></li>
        <li>Terminal 2: <code>npm run seed:local</code></li>
        <li>Terminal 3: <code>npm run offchain</code> and, in a fourth, <code>npm run keeper</code></li>
      </ol>
      <p className="muted">This page checks again every few seconds.</p>
    </section>
  );
}

function Shell() {
  const route = useRoute();
  const { deployment, setupError } = useWallet();
  const indexer = useIndexerHealth();
  const guide = useGuide();
  const [page, arg] = route;

  let body;
  if (!deployment) body = <Setup message={setupError || "Looking for the deployment…"} />;
  else if (page === "circle" && arg) body = <CircleDetail address={arg} indexer={indexer} />;
  else if (page === "organize") body = <CreateCircle indexer={indexer} />;
  else if (page === "mine") body = <CircleList mode="mine" indexer={indexer} />;
  else if (page === "activity") body = <Activity indexer={indexer} />;
  else body = <CircleList mode="all" indexer={indexer} />;

  return (
    <>
      <TopBar route={page || ""} indexer={indexer} />
      {setupError && deployment && <div className="banner danger" role="alert">{setupError}</div>}
      <div className={`shell ${guide.open && deployment ? "with-guide" : ""}`}>
        <main className="page">{body}</main>
        {deployment && <Guide />}
      </div>
      <footer className="foot">
        <DevTools />
        <p className="muted">
          Money is held by the contracts, never by the Organizer. History and reminders come from the indexer when it is running,
          and from the chain directly when it is not.
        </p>
      </footer>
      <TxTray />
    </>
  );
}

export default function App() {
  return (
    <WalletProvider>
      <TxProvider>
        <GuideProvider>
          <Shell />
        </GuideProvider>
      </TxProvider>
    </WalletProvider>
  );
}
