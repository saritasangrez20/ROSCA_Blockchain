// Off chain trust check: download the terms by CID and re hash them in the browser.
// It does not matter where the bytes come from (our service or a public gateway): if they do
// not hash to the CID stored in the contract, the page says so.
import { useEffect, useState } from "react";
import { api } from "../lib/api.js";
import { IPFS_GATEWAYS } from "../lib/config.js";
import { parseCid, verifyCid } from "../lib/cid.js";
import { CopyButton } from "./Addr.jsx";

async function fetchTerms(cid) {
  const errors = [];
  try {
    return { ...(await api.ipfsGet(cid)), from: "our IPFS service" };
  } catch (e) {
    errors.push(`IPFS service: ${e.message}`);
  }
  for (const g of IPFS_GATEWAYS) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const res = await fetch(g + cid, { signal: ctrl.signal, cache: "no-store" });
      clearTimeout(t);
      if (res.ok) return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get("content-type"), from: new URL(g).host };
      errors.push(`${new URL(g).host}: ${res.status}`);
    } catch (e) {
      errors.push(`${g}: ${e.name === "AbortError" ? "timed out" : e.message}`);
    }
  }
  throw new Error(errors.join("; "));
}

export default function TermsCheck({ cid }) {
  const [st, setSt] = useState({ phase: "loading" });
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const parsed = parseCid(cid);
    if (!parsed.valid || !parsed.verifiable) {
      setSt({ phase: "unverifiable", reason: parsed.reason });
      return;
    }
    setSt({ phase: "loading" });
    fetchTerms(cid)
      .then(async (doc) => {
        const v = await verifyCid(cid, doc.bytes);
        if (cancelled) return;
        const isText = /^text\/|json|markdown/.test(doc.contentType || "") || !doc.bytes.slice(0, 2000).some((b) => b === 0);
        const url = URL.createObjectURL(new Blob([doc.bytes], { type: v.ok ? doc.contentType || "application/octet-stream" : "text/plain" }));
        setSt({ phase: v.ok ? "ok" : "tampered", from: doc.from, size: doc.bytes.length, text: isText ? new TextDecoder().decode(doc.bytes) : null, url, filename: doc.filename });
      })
      .catch((e) => !cancelled && setSt({ phase: "missing", reason: e.message }));
    return () => {
      cancelled = true;
    };
  }, [cid, nonce]);

  return (
    <section className={`terms ${st.phase}`} id="terms">
      <div className="terms-head">
        <h2>Terms</h2>
        <button className="link" onClick={() => setNonce((n) => n + 1)}>Check again</button>
      </div>
      <p className="cid" title="IPFS content identifier stored in the contract">CID on chain: <code>{cid}</code> <CopyButton value={cid} label="Copy CID" /></p>
      {st.phase === "loading" && <p className="muted">Downloading and checking the terms…</p>}
      {st.phase === "ok" && (
        <p className="verdict ok">Verified. The document from {st.from} hashes to exactly the CID stored in the contract, so it has not been changed since the circle was created.</p>
      )}
      {st.phase === "tampered" && (
        <p className="verdict bad" role="alert">Do not trust this document. What {st.from} returned does not match the CID stored in the contract.</p>
      )}
      {st.phase === "missing" && <p className="verdict warn">The terms could not be downloaded right now ({st.reason}). The CID on chain is still the reference.</p>}
      {st.phase === "unverifiable" && <p className="verdict warn">This circle's CID cannot be checked in the browser: {st.reason}.</p>}
      {st.url && (
        <p>
          <a href={st.url} target="_blank" rel="noreferrer" download={st.filename || undefined}>Open the document</a>
          <span className="muted small"> ({st.size.toLocaleString()} bytes)</span>
        </p>
      )}
      {st.text && st.phase === "ok" && <pre className="terms-text">{st.text.slice(0, 4000)}</pre>}
    </section>
  );
}
