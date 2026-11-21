// W1 Create circle (Organizer view).
// Order of operations: 1. hash the terms in the browser, 2. upload them to IPFS through the
// off chain service and check it returned the same CID, 3. send createCircle with only the CID.
import { useMemo, useState } from "react";
import { ethers } from "ethers";
import { useWallet } from "../state/wallet.jsx";
import { useTx } from "../state/tx.jsx";
import { usePoll } from "../state/hooks.js";
import { api } from "../lib/api.js";
import { cidOf, parseCid } from "../lib/cid.js";
import { contractsFor } from "../lib/contracts.js";
import { money, duration } from "../lib/format.js";
import { CircleRows, fetchCircles } from "./CircleList.jsx";

const UNITS = { minutes: 60, hours: 3600, days: 86400 };
const PRESETS = {
  demo: { label: "Quick demo (minutes)", round: [10, "minutes"], grace: [2, "minutes"], join: [2, "hours"], draw: [10, "minutes"] },
  monthly: { label: "Monthly committee", round: [30, "days"], grace: [3, "days"], join: [7, "days"], draw: [2, "days"] },
};

function DurationField({ label, value, onChange, hint }) {
  return (
    <label className="field">
      <span>{label}</span>
      <span className="pair">
        <input type="number" min="1" step="1" value={value[0]} onChange={(e) => onChange([e.target.value, value[1]])} required />
        <select value={value[1]} onChange={(e) => onChange([value[0], e.target.value])} aria-label={`${label} unit`}>
          {Object.keys(UNITS).map((u) => <option key={u}>{u}</option>)}
        </select>
      </span>
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

function termsTemplate(f) {
  const sec = (v) => duration(Number(v[0]) * UNITS[v[1]]);
  return `Committee terms

Members: ${f.groupSize}
Contribution: ${f.contribution} mUSD every round
Round length: ${sec(f.round)}, plus a grace period of ${sec(f.grace)}
Joining stays open for ${sec(f.join)}
Payout order: drawn by commit and reveal, ${sec(f.draw)} for each phase

1. Every member locks a security deposit when joining. After the draw it is reduced to exactly what
   the member will still owe after receiving the pot (the last member keeps no deposit).
2. A member who misses a payment has it taken from their deposit; a default is recorded.
3. A member who does not reveal their draw secret is removed and loses one contribution, shared by the others.
4. The Organizer never holds or moves any money. The contracts do.
5. Members with more than ${f.maxDefaults} past defaults cannot join.
`;
}

export default function CreateCircle({ indexer }) {
  const { deployment, account, signer } = useWallet();
  const { run, version } = useTx();
  const [f, setF] = useState({ contribution: "1000", groupSize: "4", maxDefaults: "0", ...presetValues("demo") });
  const [termsMode, setTermsMode] = useState("write");
  const [termsText, setTermsText] = useState(null);
  const [file, setFile] = useState(null);
  const [existingCid, setExistingCid] = useState("");
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);

  function presetValues(key) {
    const p = PRESETS[key];
    return { round: p.round, grace: p.grace, join: p.join, draw: p.draw };
  }
  const set = (k) => (v) => setF((s) => ({ ...s, [k]: v?.target ? v.target.value : v }));
  const text = termsText ?? termsTemplate(f);

  const numbers = useMemo(() => {
    try {
      const c = ethers.parseUnits(f.contribution || "0", 6);
      const n = BigInt(f.groupSize || 0);
      return { c, n, deposit: n > 0n ? c * (n - 1n) : 0n, pot: c * n };
    } catch {
      return null;
    }
  }, [f.contribution, f.groupSize]);

  const mine = usePoll(
    () => (account ? fetchCircles({ deployment, account, filter: "organizer", indexerOnline: indexer.online }) : Promise.resolve(null)),
    [account, deployment, version, indexer.online]
  );

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!numbers || numbers.c <= 0n) return setError("Enter a contribution above zero.");
    if (numbers.n < 2n || numbers.n > 20n) return setError("Group size must be between 2 and 20.");

    let cid;
    if (termsMode === "cid") {
      const p = parseCid(existingCid.trim());
      if (!p.valid) return setError(`That CID is not valid: ${p.reason}.`);
      cid = existingCid.trim();
    } else {
      const doc = termsMode === "file" ? file : new File([text], "terms.txt", { type: "text/plain" });
      if (!doc) return setError("Choose a terms file.");
      if (doc.size > 1024 * 1024) return setError("The terms file must be 1 MB or smaller.");
      setProgress("Hashing the terms in your browser…");
      const localCid = await cidOf(new Uint8Array(await doc.arrayBuffer()));
      setProgress("Uploading the terms to IPFS…");
      try {
        const up = await api.upload(doc);
        if (up.cid !== localCid) {
          setProgress(null);
          return setError(`The IPFS service returned ${up.cid}, but your file hashes to ${localCid}. Nothing was created.`);
        }
        cid = up.cid;
      } catch (err) {
        setProgress(null);
        return setError(`Could not upload the terms: ${err.message}. Start the off chain service (npm run offchain), or paste the CID of terms already on IPFS.`);
      }
    }

    setProgress(`Terms stored as ${cid}. Confirm the transaction in your wallet…`);
    const toSec = (v) => BigInt(Math.round(Number(v[0]) * UNITS[v[1]]));
    const cfg = {
      contribution: numbers.c,
      groupSize: numbers.n,
      roundDuration: toSec(f.round),
      gracePeriod: toSec(f.grace),
      joinDuration: toSec(f.join),
      drawPhaseDuration: toSec(f.draw),
      maxDefaults: BigInt(f.maxDefaults || 0),
      termsCid: cid,
    };
    const res = await run("Create circle", [{ label: "Create circle", send: (s) => contractsFor(deployment, s).factory.createCircle(cfg) }]);
    setProgress(null);
    if (res.ok) {
      const iface = contractsFor(deployment).factory.interface;
      const ev = res.receipts[0].logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).find((p) => p?.name === "CircleCreated");
      if (ev) window.location.hash = `#/circle/${ev.args.circle}`;
    }
  };

  return (
    <section className="two-col">
      <div>
        <div className="page-head">
          <div>
            <h1>Start a circle</h1>
            <p className="lede">You set the rules and invite members. You never hold the money: deposits sit in the vault and payments in the circle contract.</p>
          </div>
        </div>
        {!account && <div className="banner">Connect a wallet to create a circle. The account you use becomes the Organizer.</div>}

        <form className="form" onSubmit={submit}>
          <fieldset>
            <legend>Money</legend>
            <label className="field">
              <span>Contribution per round (mUSD)</span>
              <input inputMode="decimal" value={f.contribution} onChange={set("contribution")} required />
            </label>
            <label className="field">
              <span>Members</span>
              <input type="number" min="2" max="20" value={f.groupSize} onChange={set("groupSize")} required />
              <small className="muted">Also the number of rounds. 2 to 20.</small>
            </label>
            <label className="field">
              <span>Past defaults allowed</span>
              <input type="number" min="0" value={f.maxDefaults} onChange={set("maxDefaults")} required />
              <small className="muted">Join rule checked against the reputation registry.</small>
            </label>
            {numbers && numbers.n >= 2n && (
              <p className="calc">
                Pot each round <strong className="num">{money(numbers.pot)}</strong>. Each member locks <strong className="num">{money(numbers.deposit)}</strong> when
                joining; after the draw the member paid first keeps it all and the member paid last gets it all back.
              </p>
            )}
          </fieldset>

          <fieldset>
            <legend>Timing</legend>
            <div className="presets">
              {Object.entries(PRESETS).map(([k, p]) => (
                <button type="button" key={k} className="btn ghost" onClick={() => setF((s) => ({ ...s, ...presetValues(k) }))}>{p.label}</button>
              ))}
            </div>
            <DurationField label="Round length" value={f.round} onChange={set("round")} />
            <DurationField label="Grace period" value={f.grace} onChange={set("grace")} hint="Late payments are still accepted until round plus grace." />
            <DurationField label="Joining stays open for" value={f.join} onChange={set("join")} />
            <DurationField label="Draw phase (commit, then reveal)" value={f.draw} onChange={set("draw")} />
          </fieldset>

          <fieldset>
            <legend>Terms document</legend>
            <div className="seg" role="radiogroup" aria-label="Terms source">
              {[["write", "Write terms"], ["file", "Upload a file"], ["cid", "Use an existing CID"]].map(([k, l]) => (
                <label key={k} className={termsMode === k ? "on" : ""}>
                  <input type="radio" name="terms" checked={termsMode === k} onChange={() => setTermsMode(k)} /> {l}
                </label>
              ))}
            </div>
            {termsMode === "write" && (
              <label className="field wide">
                <span>Terms</span>
                <textarea rows={12} value={text} onChange={(e) => setTermsText(e.target.value)} />
                <small className="muted">
                  Filled in from your settings until you edit it. <button type="button" className="link" onClick={() => setTermsText(null)}>Reset to settings</button>
                </small>
              </label>
            )}
            {termsMode === "file" && (
              <label className="field wide">
                <span>Terms file (PDF or text, up to 1 MB)</span>
                <input type="file" accept=".pdf,.txt,.md,application/pdf,text/plain" onChange={(e) => setFile(e.target.files?.[0] || null)} />
              </label>
            )}
            {termsMode === "cid" && (
              <label className="field wide">
                <span>IPFS CID</span>
                <input value={existingCid} onChange={(e) => setExistingCid(e.target.value)} placeholder="bafkrei…" spellCheck="false" />
              </label>
            )}
            <p className="muted small">The document goes to IPFS. Only its CID, a fingerprint of the file, is stored in the contract, so anyone can check the terms were never changed.</p>
          </fieldset>

          {error && <div className="banner danger" role="alert">{error}</div>}
          {progress && <div className="banner" role="status">{progress}</div>}
          <button className="btn primary big" type="submit" disabled={!signer || !!progress}>Upload terms and create circle</button>
        </form>
      </div>

      <aside>
        <h2>Circles you organize</h2>
        {!account ? (
          <p className="muted">Connect to see them.</p>
        ) : (
          <CircleRows rows={mine.data?.value || []} now={mine.data?.now} account={account} empty="None yet. Your first circle will appear here." />
        )}
      </aside>
    </section>
  );
}
