// An address (or hash) shown short, with a copy button like MetaMask's.
import { useState } from "react";
import { short } from "../lib/format.js";

export function CopyButton({ value, label = "Copy" }) {
  const [done, setDone] = useState(false);
  const copy = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Fallback for browsers that block the clipboard API
      const t = Object.assign(document.createElement("textarea"), { value });
      document.body.appendChild(t);
      t.select();
      document.execCommand("copy");
      t.remove();
    }
    setDone(true);
    setTimeout(() => setDone(false), 1400);
  };
  return (
    <button type="button" className={`copy ${done ? "done" : ""}`} onClick={copy} aria-label={`${label} ${value}`} title={done ? "Copied" : `${label}: ${value}`}>
      {done ? (
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2" /></svg>
      ) : (
        <svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.5" /><path d="M10.5 5V3.5A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5H5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
      )}
      {done && <span className="copied">Copied</span>}
    </button>
  );
}

/** Shows `label` (a display name) or the short address, plus a copy button. */
export default function Addr({ value, label, className = "" }) {
  if (!value) return null;
  return (
    <span className={`addr ${className}`}>
      <span title={value}>{label || short(value)}</span>
      <CopyButton value={value} label="Copy address" />
    </span>
  );
}
