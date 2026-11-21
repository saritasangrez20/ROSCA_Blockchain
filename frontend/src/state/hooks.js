import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api.js";
import { POLL_MS } from "../lib/config.js";

/** Runs `fn` now, whenever deps change, and every `interval` ms. Keeps the last good data. */
export function usePoll(fn, deps, interval = POLL_MS) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const seq = useRef(0);

  const load = useCallback(async () => {
    const my = ++seq.current;
    try {
      const data = await fnRef.current();
      if (my === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (my === seq.current) setState((s) => ({ data: s.data, error, loading: false }));
    }
  }, []);

  useEffect(() => {
    setState((s) => ({ ...s, loading: true }));
    load();
    if (!interval) return undefined;
    const t = setInterval(load, interval);
    return () => clearInterval(t);
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps

  return { ...state, reload: load };
}

/** Is the indexer API reachable and healthy? The UI switches to chain reads when it is not. */
export function useIndexerHealth() {
  const { data, error } = usePoll(() => api.health(), [], 5000);
  return { online: !!data && !error && data.ok !== false, status: data, error };
}

/** Tries the indexer first and falls back to a direct chain read. Reports which one answered. */
export async function indexerOrChain(fromIndexer, fromChain) {
  try {
    return { source: "indexer", value: await fromIndexer() };
  } catch {
    return { source: "chain", value: await fromChain() };
  }
}
