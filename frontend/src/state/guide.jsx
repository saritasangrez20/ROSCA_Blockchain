// Shared state for the Steps box: which circle this tab is following, its live data, and the
// connected account's mUSD balance. The circle page sets the circle; the box keeps following it
// while you visit other pages in the same tab.
import { createContext, useContext, useMemo, useState } from "react";
import { useWallet } from "./wallet.jsx";
import { useTx } from "./tx.jsx";
import { usePoll } from "./hooks.js";
import { loadCircleLive } from "../lib/chainData.js";
import { contractsFor, readProvider } from "../lib/contracts.js";

const GuideContext = createContext(null);
export const useGuide = () => useContext(GuideContext);

const KEY = "rosca:guide-circle";

export function GuideProvider({ children }) {
  const { deployment, account } = useWallet();
  const { version } = useTx();
  const [circle, setCircleState] = useState(() => sessionStorage.getItem(KEY));
  const [open, setOpenState] = useState(() => localStorage.getItem("rosca:guide-open") !== "0");

  const setCircle = (addr) => {
    setCircleState(addr);
    if (addr) sessionStorage.setItem(KEY, addr);
    else sessionStorage.removeItem(KEY);
  };
  const setOpen = (v) => {
    setOpenState(v);
    localStorage.setItem("rosca:guide-open", v ? "1" : "0");
  };

  const live = usePoll(async () => {
    if (!deployment || !circle) return null;
    const code = await readProvider.getCode(circle);
    if (code === "0x") return null; // chain was restarted: the circle no longer exists
    return loadCircleLive(circle, account, deployment);
  }, [deployment, circle, account, version], 4000);

  const balance = usePoll(
    async () => (account && deployment ? contractsFor(deployment).token.balanceOf(account) : null),
    [account, deployment, version],
    6000
  );

  const value = useMemo(
    () => ({ circleAddress: circle, circle: live.data, setCircle, balance: balance.data, open, setOpen }),
    [circle, live.data, balance.data, open] // eslint-disable-line react-hooks/exhaustive-deps
  );
  return <GuideContext.Provider value={value}>{children}</GuideContext.Provider>;
}
