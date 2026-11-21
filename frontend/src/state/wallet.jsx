// Wallet connection, network check and deployment discovery.
//
// Two ways to sign:
//   * MetaMask (or any injected EIP 1193 wallet): the real flow shown in the demo.
//   * Local test accounts: only on the Hardhat chain (31337). The node keeps those 20 accounts
//     unlocked, so the browser asks the node to sign. Handy for playing four members from one
//     browser without importing keys. Never available on a public network.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ethers } from "ethers";
import { LOCAL_CHAIN_ID, RPC_URL } from "../lib/config.js";
import { loadDeployment, readProvider } from "../lib/contracts.js";

const WalletContext = createContext(null);
export const useWallet = () => useContext(WalletContext);

const hexChain = (id) => "0x" + Number(id).toString(16);

export function WalletProvider({ children }) {
  const [deployment, setDeployment] = useState(null);
  const [setupError, setSetupError] = useState(null);
  const [chainOk, setChainOk] = useState(null); // read RPC reachable and contracts present
  const [account, setAccount] = useState(null);
  const [signer, setSigner] = useState(null);
  const [kind, setKind] = useState(null);
  const [walletChainId, setWalletChainId] = useState(null);
  const [devAccounts, setDevAccounts] = useState([]);
  const factoryRef = useRef(null);
  const hasInjected = typeof window !== "undefined" && !!window.ethereum;

  // Find the deployment and keep checking for redeploys.
  useEffect(() => {
    let stop = false;
    const check = async () => {
      try {
        const d = await loadDeployment();
        if (stop) return;
        if (!d) {
          setSetupError("No deployment found. Start the chain and run npm run seed:local (or npm run deploy:local).");
          setChainOk(false);
          return;
        }
        const code = await readProvider.getCode(d.CircleFactory);
        if (code === "0x") {
          setSetupError("The deployment file points to contracts that are not on this chain. Redeploy with npm run seed:local.");
          setChainOk(false);
          return;
        }
        setSetupError(null);
        setChainOk(true);
        if (factoryRef.current !== d.CircleFactory) {
          factoryRef.current = d.CircleFactory;
          setDeployment(d);
        }
      } catch {
        if (!stop) {
          setChainOk(false);
          setSetupError(`Cannot reach the blockchain node at ${RPC_URL}. Start it with npx hardhat node.`);
        }
      }
    };
    check();
    const t = setInterval(check, 5000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, []);

  const expectedChainId = deployment?.chainId ?? LOCAL_CHAIN_ID;

  // Local test accounts from the node (Hardhat only).
  useEffect(() => {
    if (!deployment || Number(deployment.chainId) !== LOCAL_CHAIN_ID) return setDevAccounts([]);
    readProvider.send("eth_accounts", []).then((a) => setDevAccounts(a.slice(0, 10))).catch(() => setDevAccounts([]));
  }, [deployment]);

  const useInjected = useCallback(async (request = false) => {
    if (!window.ethereum) return;
    const accounts = await window.ethereum.request({ method: request ? "eth_requestAccounts" : "eth_accounts" });
    const chain = await window.ethereum.request({ method: "eth_chainId" });
    setWalletChainId(Number(chain));
    if (!accounts.length) {
      if (kind === "metamask") {
        setAccount(null);
        setSigner(null);
        setKind(null);
      }
      return;
    }
    const provider = new ethers.BrowserProvider(window.ethereum, "any");
    setSigner(await provider.getSigner(accounts[0]));
    setAccount(ethers.getAddress(accounts[0]));
    setKind("metamask");
    sessionStorage.setItem("rosca:wallet", "metamask");
  }, [kind]);

  const connectDev = useCallback(async (address) => {
    const s = await readProvider.getSigner(address);
    setSigner(s);
    setAccount(ethers.getAddress(address));
    setKind("dev");
    setWalletChainId(LOCAL_CHAIN_ID);
    sessionStorage.setItem("rosca:wallet", `dev:${address}`);
  }, []);

  const disconnect = useCallback(() => {
    setSigner(null);
    setAccount(null);
    setKind(null);
    sessionStorage.removeItem("rosca:wallet");
  }, []);

  // Restore the previous session and follow MetaMask account / network changes.
  useEffect(() => {
    const saved = sessionStorage.getItem("rosca:wallet");
    if (saved?.startsWith("dev:") && devAccounts.length) connectDev(saved.slice(4)).catch(() => {});
    else if (saved === "metamask") useInjected(false).catch(() => {});
  }, [devAccounts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!window.ethereum || kind !== "metamask") return;
    const onAccounts = () => useInjected(false);
    const onChain = () => useInjected(false);
    window.ethereum.on?.("accountsChanged", onAccounts);
    window.ethereum.on?.("chainChanged", onChain);
    return () => {
      window.ethereum.removeListener?.("accountsChanged", onAccounts);
      window.ethereum.removeListener?.("chainChanged", onChain);
    };
  }, [kind, useInjected]);

  const switchNetwork = useCallback(async () => {
    try {
      await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexChain(expectedChainId) }] });
    } catch (e) {
      if (e?.code === 4902 || /unrecognized|not been added/i.test(e?.message || "")) {
        await window.ethereum.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: hexChain(expectedChainId), chainName: "Hardhat Local", rpcUrls: [RPC_URL], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 } }],
        });
      } else throw e;
    }
    await useInjected(false);
  }, [expectedChainId, useInjected]);

  const addTokenToWallet = useCallback(async () => {
    if (!window.ethereum || !deployment) return;
    await window.ethereum.request({
      method: "wallet_watchAsset",
      params: { type: "ERC20", options: { address: deployment.MockStablecoin, symbol: "mUSD", decimals: 6 } },
    });
  }, [deployment]);

  const value = useMemo(
    () => ({
      deployment, setupError, chainOk, account, signer, kind, walletChainId, expectedChainId, devAccounts, hasInjected,
      wrongNetwork: !!account && kind === "metamask" && walletChainId !== Number(expectedChainId),
      connectMetaMask: () => useInjected(true), connectDev, disconnect, switchNetwork, addTokenToWallet,
    }),
    [deployment, setupError, chainOk, account, signer, kind, walletChainId, expectedChainId, devAccounts, hasInjected, useInjected, connectDev, disconnect, switchNetwork, addTokenToWallet]
  );
  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}
