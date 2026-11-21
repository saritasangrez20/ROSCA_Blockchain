// What the connected account can do in this circle right now, grouped by role.
// Covers W2 join, W3 commit / reveal / finalize, W4 contribute, W5 settle, W6 claim,
// W7 finish and withdraw, W8 cancel, and the admin pause.
// The buttons only appear when the contract would accept the call, using live chain data.
import { useState } from "react";
import { ethers } from "ethers";
import { useWallet } from "../state/wallet.jsx";
import { useTx } from "../state/tx.jsx";
import { circleAt, contractsFor, readProvider } from "../lib/contracts.js";
import { newSecret, saveSecret, findMatchingSecret, extractSecret, commitmentFor, downloadSecret } from "../lib/secrets.js";
import { money, relative, dateTime } from "../lib/format.js";


function Block({ title, children, tone }) {
  return (
    <div className={`act ${tone || ""}`}>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export default function ActionPanel({ c, history }) {
  const { deployment, account, signer, expectedChainId } = useWallet();
  const { run } = useTx();
  const [pasted, setPasted] = useState("");
  const [savedNote, setSavedNote] = useState(null);
  const [committing, setCommitting] = useState(false); // locks Commit while one is in progress

  if (!account) return <div className="actions-panel"><p className="muted">Connect a wallet to join or act in this circle.</p></div>;

  const me = c.me || {};
  const w = c.wallet || {};
  const contribution = BigInt(c.contribution);
  const deposit = BigInt(c.joinCollateral);
  // Rounds this member still has to pay, including the current one.
  const remaining = Math.max(1, c.participantCount - c.currentRound + 1);
  const approveAll = contribution * BigInt(remaining);
  const isOrganizer = c.organizer === account.toLowerCase();
  const joined = !!me.joined;
  const participant = me.isMember && me.position > 0;
  const isRecipient = c.currentRecipient === account.toLowerCase();
  const now = c.now;
  const allPaid = c.members.filter((m) => m.position > 0 && !m.removed).every((m) => m.paidThisRound);
  const circleW = () => circleAt(c.address, signer);
  const mods = () => contractsFor(deployment, signer);
  const blocks = [];

  // ---------- W2 Join ----------
  if (c.state === 0 && !joined) {
    const open = now <= c.joinDeadline && c.memberCount < c.groupSize;
    const short = w.balance !== undefined && w.balance < deposit;
    blocks.push(
      <Block key="join" title="Join this circle">
        <p>
          You lock <strong className="num">{money(deposit)}</strong> in the vault now. After the draw you keep only what you will still owe once you
          have received the pot; the rest comes back. Then you pay <strong className="num">{money(contribution)}</strong> each round.
        </p>
        {short && <p className="error-text">You have {money(w.balance)}. Press Get test mUSD first.</p>}
        {c.paused && <p className="error-text">Joining is paused by the platform admin.</p>}
        <button className="btn primary" disabled={!open || c.paused}
          onClick={() => run("Join circle", [
            { label: "Approve deposit", send: async (s) => (w.allowVault >= deposit ? null : contractsFor(deployment, s).token.approve(c.vaultAddress, deposit)) },
            { label: "Join", send: () => circleW().join() },
          ])}>
          {w.allowVault >= deposit ? "Join and lock deposit" : "Approve and join (2 steps)"}
        </button>
        {!open && <p className="muted small">Joining is closed.</p>}
      </Block>
    );
  }
  if (c.state === 0 && joined) {
    blocks.push(
      <Block key="joined" title="You are in">
        <p>{money(me.collateral)} is locked as your deposit. The draw starts when all {c.groupSize} seats are taken (joining closes {relative(c.joinDeadline, now)}).</p>
      </Block>
    );
  }

  // ---------- W3 Payout order draw ----------
  if (c.state === 1 && me.isMember) {
    const d = c.draw;
    const revealOpen = d.commitCount === d.memberCount || now > d.commitDeadline;
    if (!me.committed) {
      const canCommit = now <= d.commitDeadline;
      blocks.push(
        <Block key="commit" title="Step 1: commit your secret" tone="due">
          <p>Your browser makes a random secret and sends only its fingerprint. Nobody, including the Organizer, can choose the order. Commit {relative(d.commitDeadline, now)}.</p>
          <button className="btn primary" disabled={!canCommit || committing}
            onClick={async () => {
              if (committing) return;
              setCommitting(true);
              try {
                const secret = newSecret();
                const stored = saveSecret(expectedChainId, c.address, account, secret);
                setSavedNote(stored ? null : secret);
                const commitment = commitmentFor(secret, account, c.address);
                const check = await contractsFor(deployment, readProvider).payoutOrder.computeCommitment(secret, account, c.address);
                if (check !== commitment) throw new Error("Commitment mismatch");
                const res = await run("Commit draw secret", [{ label: "Commit", send: () => mods().payoutOrder.commit(c.address, commitment) }]);
                if (res.ok) downloadSecret(c.address, account, secret);
              } finally {
                setCommitting(false);
              }
            }}>
            {committing ? "Committing…" : "Commit secret"}
          </button>
          {!canCommit && <p className="muted small">The commit window has closed.</p>}
          {savedNote && <p className="error-text">This browser could not store the secret. Copy it now: <code>{savedNote}</code></p>}
        </Block>
      );
    } else if (!me.revealed) {
      const stored = findMatchingSecret(expectedChainId, c.address, account, me.commitment);
      const fromPaste = extractSecret(pasted);
      const pasteMatches = !!fromPaste && commitmentFor(fromPaste, account, c.address) === me.commitment;
      const secret = stored || (pasteMatches ? fromPaste : null);
      blocks.push(
        <Block key="reveal" title="Step 2: reveal your secret" tone="due">
          {revealOpen ? (
            <p>Everyone has committed{now > d.commitDeadline && d.commitCount < d.memberCount ? " or the commit window ended" : ""}. Reveal {relative(d.revealDeadline, now)}. Not revealing removes you and costs one contribution.</p>
          ) : (
            <p>Waiting for the others to commit ({d.commitCount} of {d.memberCount}). Reveal opens when everyone has, or {relative(d.commitDeadline, now)}.</p>
          )}
          {stored ? (
            <p className="small" style={{ color: "var(--paid)", fontWeight: 700 }}>✓ This browser has the secret that matches your commitment.</p>
          ) : (
            <div className="secret-help">
              <p className="small">
                This browser does not have the secret that matches your commitment (for example it was committed from another browser, or
                storage was cleared). Open <strong>draw-secret-circle-{c.address.slice(2, 8)}-member-{account.slice(2, 8)}.txt</strong> (or
                draw-secret-{c.address.slice(2, 8)}.txt) from your Downloads folder and paste the secret, or the whole file, here.
              </p>
              <label className="field wide">
                <span>Secret from your backup file</span>
                <textarea rows={2} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="0x…" spellCheck="false" />
              </label>
              {pasted && (pasteMatches
                ? <p className="small" style={{ color: "var(--paid)", fontWeight: 700 }}>✓ Matches your commitment on chain.</p>
                : <p className="error-text small">{fromPaste ? "This secret belongs to a different commit. Try another backup file." : "No 0x… secret found in what you pasted."}</p>)}
              <p className="muted small">No backup? You cannot reveal. When the reveal window ends you are removed and lose one contribution; the others carry on.</p>
            </div>
          )}
          <button className="btn primary" disabled={!revealOpen || now > d.revealDeadline || !secret}
            onClick={() => run("Reveal draw secret", [{ label: "Reveal", send: () => mods().payoutOrder.reveal(c.address, secret) }])}>
            Reveal secret
          </button>
          {stored && <button className="btn ghost" onClick={() => downloadSecret(c.address, account, stored)}>Download backup</button>}
        </Block>
      );
    } else {
      blocks.push(<Block key="revealed" title="You revealed"><p>Waiting for the draw to be finalized ({d.revealCount} of {d.memberCount} revealed).</p></Block>);
    }
  }
  if (c.state === 1) {
    const d = c.draw;
    const canFinalize = d.revealCount === d.memberCount || now > d.revealDeadline;
    blocks.push(
      <Block key="finalize" title="Finalize the draw">
        <p className="muted">Anyone can do this once everyone revealed or the reveal window ends ({relative(d.revealDeadline, now)}). The keeper does it automatically.</p>
        <button className="btn" disabled={!canFinalize} onClick={() => run("Finalize draw", [{ label: "Finalize draw", send: () => circleW().finalizeDraw() }])}>Finalize draw</button>
      </Block>
    );
  }

  // ---------- W4 Contribute ----------
  if (c.state === 2 && participant) {
    const closed = now > c.roundDeadline;
    if (!me.paidThisRound) {
      blocks.push(
        <Block key="pay" title={`Pay round ${c.currentRound}`} tone={closed ? "late" : "due"}>
          {isRecipient && <p>You receive this round's pot. Paying keeps your own pot whole.</p>}
          <p>
            <strong className="num">{money(contribution)}</strong>, accepted until {dateTime(c.roundDeadline)} ({relative(c.roundDeadline, now)}, grace included).
          </p>
          {closed && <p className="error-text">The payment window has closed. Your deposit will cover this round when it is settled, and a default is recorded.</p>}
          {c.paused && <p className="error-text">Payments are paused by the platform admin.</p>}
          {w.balance !== undefined && w.balance < contribution && <p className="error-text">You have {money(w.balance)}. Press Get test mUSD first.</p>}
          <button className="btn primary" disabled={closed || c.paused}
            onClick={() => run(`Pay round ${c.currentRound}`, [
              { label: "Approve payments", send: async (s) => (w.allowCircle >= contribution ? null : contractsFor(deployment, s).token.approve(c.address, approveAll)) },
              { label: "Pay", send: () => circleW().contribute() },
            ])}>
            {w.allowCircle >= contribution ? "Pay now" : remaining > 1 ? `Approve ${remaining} rounds and pay (2 steps)` : "Approve and pay (2 steps)"}
          </button>
          {w.allowCircle < contribution && remaining > 1 && (
            <p className="muted small">
              One approval of {money(approveAll)} covers your {remaining} remaining payments, so later rounds need a single confirmation. The circle can
              still only take one contribution, and only when you press Pay.
            </p>
          )}
        </Block>
      );
    } else {
      blocks.push(<Block key="paid" title={`Round ${c.currentRound} paid`} tone="ok"><p>Thank you. {isRecipient ? "You receive this round's pot when it is settled." : ""}</p></Block>);
    }
  }

  // ---------- W5 Settle ----------
  if (c.state === 2) {
    const canSettle = allPaid || now > c.roundDeadline;
    blocks.push(
      <Block key="settle" title={`Settle round ${c.currentRound}`}>
        <p className="muted">
          {allPaid ? "Everyone has paid, so the round can be settled now." : `Possible once everyone pays or ${relative(c.roundDeadline, now)}.`} Missed payments are
          taken from deposits and the pot is credited to the recipient. Anyone can press it; the keeper does it automatically.
        </p>
        <button className="btn" disabled={!canSettle} onClick={() => run(`Settle round ${c.currentRound}`, [{ label: "Settle round", send: () => circleW().settleRound() }])}>
          Settle round
        </button>
      </Block>
    );
  }

  // ---------- W6 Claim / W7 Finish and withdraw ----------
  const credit = BigInt(me.withdrawable || 0);
  if (c.state === 3 && joined) {
    const released = (history || []).filter((e) => e.name === "CollateralReleased" && e.args.member?.toLowerCase() === account.toLowerCase());
    const last = released[released.length - 1];
    blocks.push(
      <Block key="finish" title="Finish and withdraw" tone="ok">
        <p>
          The circle is complete. {last ? <>Your remaining deposit of <strong className="num">{money(last.args.amount)}</strong> was returned to your wallet when the last round was settled.</> : "No deposit was left to return to you."}
        </p>
        {credit > 0n ? (
          <button className="btn primary" onClick={() => run("Withdraw credit", [{ label: "Claim payout", send: () => circleW().claimPayout() }])}>
            Withdraw {money(credit)}
          </button>
        ) : (
          <p className="muted">Nothing is left for you to withdraw.</p>
        )}
      </Block>
    );
  } else if (credit > 0n) {
    blocks.push(
      <Block key="claim" title="Money waiting for you" tone="ok">
        <p>You can claim <strong className="num">{money(credit)}</strong> (your pot, a share of a penalty, or a repaid debt).</p>
        <button className="btn primary" onClick={() => run("Claim payout", [{ label: "Claim payout", send: () => circleW().claimPayout() }])}>Claim payout</button>
      </Block>
    );
  }
  if (c.state === 4 && joined) {
    blocks.push(<Block key="cancelled" title="Circle cancelled"><p>The circle did not start. Deposits were refunded{me.removed ? ", minus your penalty for not revealing" : " in full"}.</p></Block>);
  }

  // ---------- W8 Cancel ----------
  if (c.state === 0 && (isOrganizer || now > c.joinDeadline)) {
    blocks.push(
      <Block key="cancel" title={isOrganizer ? "Organizer: cancel the circle" : "Cancel the unfilled circle"}>
        <p className="muted">
          {isOrganizer ? "While the circle is still open, you can cancel it." : "The join deadline passed without the circle filling up, so anyone can cancel it."} Every
          deposit is refunded in full.
        </p>
        <button className="btn danger" onClick={() => window.confirm("Cancel this circle and refund every deposit?") && run("Cancel circle", [{ label: "Cancel circle", send: () => circleW().cancel() }])}>
          Cancel circle
        </button>
      </Block>
    );
  }

  // ---------- Organizer summary ----------
  if (isOrganizer && c.state !== 0) {
    const unpaid = c.members.filter((m) => m.position > 0 && !m.removed && !m.paidThisRound).length;
    blocks.push(
      <Block key="org" title="Organizer view">
        <p className="muted">
          {c.state === 1 && `${c.draw.commitCount} of ${c.draw.memberCount} committed, ${c.draw.revealCount} revealed.`}
          {c.state === 2 && `${c.participantCount - unpaid} of ${c.participantCount} have paid round ${c.currentRound}.`}
          {c.state >= 3 && "This circle is closed."} You can watch and remind, but you have no function that moves anyone's money.
        </p>
        <button className="btn ghost" onClick={() => navigator.clipboard?.writeText(window.location.href)}>Copy invite link</button>
      </Block>
    );
  }
  if (isOrganizer && c.state === 0) {
    blocks.unshift(
      <Block key="org-open" title="Organizer view">
        <p>{c.memberCount} of {c.groupSize} seats taken. Share this page so members can join before {dateTime(c.joinDeadline)}.</p>
        <button className="btn ghost" onClick={() => navigator.clipboard?.writeText(window.location.href)}>Copy invite link</button>
      </Block>
    );
  }

  // ---------- Admin ----------
  if (w.isPauser && c.state <= 2) {
    blocks.push(
      <Block key="admin" title="Platform admin">
        <p className="muted">Pausing stops joining and paying for at most 7 days. Settling, refunds and claims keep working, so a pause cannot trap money.</p>
        {c.paused ? (
          <button className="btn" onClick={() => run("Unpause circle", [{ label: "Unpause", send: () => circleW().unpause() }])}>Unpause</button>
        ) : (
          <button className="btn" onClick={() => run("Pause circle", [{ label: "Pause", send: () => circleW().pause() }])}>Pause for up to 7 days</button>
        )}
      </Block>
    );
  }

  return <div className="actions-panel">{blocks.length ? blocks : <p className="muted">Nothing to do here right now.</p>}</div>;
}