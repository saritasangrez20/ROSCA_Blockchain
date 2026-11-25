// Notifier: in app reminders only (no email or Telegram; those are future work).
//
// Two kinds of notification:
//   * Event notices, created while the indexer applies events (eventHook). They follow from
//     events alone, so an indexer rebuild recreates exactly the same ones.
//       circle full / draw started, payout order set, payout ready, default recorded,
//       member removed, circle cancelled, circle completed, pause, new member (organizer)
//   * Deadline reminders, recomputed on every tick from indexed state plus the chain clock
//     (refresh). They resolve themselves when the condition clears (for example the member paid).
//       contribution due, commit due, reveal due, claimable credit
// The notifier only reads; it never sends transactions and the contracts never depend on it.
const { ethers } = require("ethers");
const { fmtToken } = require("../lib/chain");

const REMINDER_KINDS = ["CONTRIBUTION_DUE", "COMMIT_DUE", "REVEAL_DUE", "CREDIT_AVAILABLE"];
const lc = (a) => (a ? String(a).toLowerCase() : a);

function notify(db, { account, circle, kind, ref, title, body, severity = "info", chainTime, deadline = null }) {
  db.run(
    `INSERT INTO notifications (account, circle, kind, ref, title, body, severity, chain_time, deadline)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account, kind, circle, ref) DO UPDATE SET
       title = excluded.title, body = excluded.body, severity = excluded.severity,
       deadline = excluded.deadline, resolved = 0`,
    [lc(account), circle, kind, String(ref), title, body, severity, chainTime, deadline]
  );
}

function resolve(db, account, circle, kinds) {
  const marks = kinds.map(() => "?").join(",");
  db.run(`UPDATE notifications SET resolved = 1 WHERE account = ? AND circle = ? AND kind IN (${marks})`, [lc(account), circle, ...kinds]);
}

class Notifier {
  constructor({ provider, abis, remindBeforeSec = 2 * 24 * 3600, logger = console }) {
    this.provider = provider;
    this.circleAbi = abis.Circle;
    this.remindBeforeSec = remindBeforeSec;
    this.log = logger;
    this.eventHook = this.eventHook.bind(this);
  }

  /** Called by the indexer for every new event (inside its transaction). */
  eventHook(db, ev) {
    const a = ev.args;
    const c = ev.circle;
    const t = ev.blockTime;
    const circle = c ? db.get("SELECT * FROM circles WHERE address = ?", [c]) : null;
    const members = () => db.all("SELECT * FROM members WHERE circle = ?", [c]);
    const ref = `${ev.blockNumber}:${ev.logIndex}`;

    switch (`${ev.contract}.${ev.name}`) {
      case "CircleFactory.CircleCreated":
        notify(db, {
          account: a.organizer, circle: c, kind: "CIRCLE_CREATED", ref: "created", chainTime: t,
          title: "Your circle is open for members",
          body: `${Number(a.groupSize)} members, ${fmtToken(a.contribution)} per round. Share the circle address so members can join.`,
        });
        break;
      case "Circle.MemberJoined":
        if (circle) {
          notify(db, {
            account: circle.organizer, circle: c, kind: "MEMBER_JOINED", ref: lc(a.member), chainTime: t,
            title: `New member joined (${circle.member_count}/${circle.group_size})`,
            body: `${a.member} locked a ${fmtToken(a.collateral)} security deposit.`,
          });
        }
        notify(db, {
          account: a.member, circle: c, kind: "JOINED", ref: "joined", chainTime: t,
          title: "You joined the circle",
          body: `${fmtToken(a.collateral)} is locked in the vault as your deposit. The extra part is refunded after the payout draw.`,
        });
        break;
      case "PayoutOrder.DrawStarted":
        for (const m of members()) {
          notify(db, {
            account: m.address, circle: c, kind: "DRAW_STARTED", ref: "draw", chainTime: t, deadline: Number(a.revealDeadline),
            title: "Circle is full: payout order draw started",
            body: "Commit your secret first, then reveal it once everyone has committed. Not revealing costs one contribution.",
          });
        }
        break;
      case "Circle.MemberRemoved":
        notify(db, {
          account: a.member, circle: c, kind: "REMOVED", ref: "removed", severity: "danger", chainTime: t,
          title: "You were removed from the circle",
          body: `You did not reveal your secret in time. Penalty: ${fmtToken(a.penalty)}; the rest of your deposit was refunded.`,
        });
        resolve(db, a.member, c, ["COMMIT_DUE", "REVEAL_DUE"]);
        break;
      case "Circle.PayoutOrderSet":
        a.order.forEach((m, i) => {
          notify(db, {
            account: m, circle: c, kind: "ORDER_SET", ref: "order", chainTime: t,
            title: `Payout order set: you receive the pot in round ${i + 1}`,
            body: `You are number ${i + 1} of ${a.order.length}. Any deposit above what you still owe after your payout has been refunded.`,
          });
          resolve(db, m, c, ["COMMIT_DUE", "REVEAL_DUE"]);
        });
        break;
      case "Circle.MemberDefaulted":
        notify(db, {
          account: a.member, circle: c, kind: "DEFAULTED", ref: String(a.round), severity: "danger", chainTime: t,
          title: `Missed payment in round ${a.round}`,
          body: `${fmtToken(a.covered)} was taken from your deposit` + (BigInt(a.uncovered) > 0n ? `; ${fmtToken(a.uncovered)} is still owed and will be taken from your pot.` : ".") + " A default was recorded in your reputation.",
        });
        if (circle) {
          notify(db, {
            account: circle.organizer, circle: c, kind: "MEMBER_DEFAULTED", ref: `${a.round}:${lc(a.member)}`, severity: "warning", chainTime: t,
            title: `A member missed round ${a.round}`,
            body: `${a.member} did not pay. ${fmtToken(a.covered)} was covered from their deposit.`,
          });
        }
        break;
      case "Circle.RoundSettled":
        if (BigInt(a.pot) > 0n) {
          notify(db, {
            account: a.recipient, circle: c, kind: "PAYOUT_READY", ref: String(a.round), severity: "success", chainTime: t,
            title: `Your pot is ready: ${fmtToken(a.pot)}`,
            body: `Round ${a.round} was settled. Open the circle and press Claim payout to receive it.`,
          });
        }
        break;
      case "Circle.PayoutClaimed":
        resolve(db, a.member, c, ["PAYOUT_READY", "CREDIT_AVAILABLE"]);
        break;
      case "Circle.CircleCancelled":
        for (const m of members()) {
          if (m.removed) continue; // already told about the penalty in REMOVED
          notify(db, {
            account: m.address, circle: c, kind: "CANCELLED", ref: "cancelled", severity: "warning", chainTime: t,
            title: "Circle cancelled",
            body: "The circle did not start. Your full deposit was returned to your wallet.",
          });
          resolve(db, m.address, c, ["COMMIT_DUE", "REVEAL_DUE", "CONTRIBUTION_DUE"]);
        }
        break;
      case "Circle.CircleCompleted":
        for (const m of members()) {
          if (m.removed) continue;
          notify(db, {
            account: m.address, circle: c, kind: "COMPLETED", ref: "completed", severity: "success", chainTime: t,
            title: "Circle completed",
            body: "Every round is settled. Your remaining deposit was returned to your wallet; claim any credit left in the circle.",
          });
          resolve(db, m.address, c, ["CONTRIBUTION_DUE"]);
        }
        break;
      case "Circle.Paused":
        for (const m of members()) {
          notify(db, {
            account: m.address, circle: c, kind: "PAUSED", ref: ref, severity: "warning", chainTime: t,
            title: "Circle paused by the platform admin",
            body: "Joining and paying are stopped for at most 7 days. Settling, refunds and claims still work.",
          });
        }
        break;
      default:
        break;
    }
  }

  /** Recomputes deadline reminders. `now` is chain time in seconds. */
  async refresh(db, now) {
    // Stage 3 (fix S1): a pause pushes the round deadline back. Events only carry the deadline
    // at round start, so read the current one from the chain before computing reminders.
    await this._refreshDeadlines(db);
    const active = new Set();
    const key = (acct, circle, kind, ref) => `${lc(acct)}|${circle}|${kind}|${ref}`;
    const want = (n) => {
      active.add(key(n.account, n.circle, n.kind, n.ref));
      notify(db, { ...n, chainTime: now });
    };
    const severityFor = (deadline) => (now > deadline ? "danger" : deadline - now <= this.remindBeforeSec ? "warning" : "info");

    db.transaction(() => {
      // Payout draw: commit, then reveal.
      for (const c of db.all("SELECT * FROM circles WHERE state = 1")) {
        const all = db.all("SELECT * FROM members WHERE circle = ?", [c.address]);
        const revealOpen = c.commits === all.length || now > c.commit_deadline;
        for (const m of all) {
          if (!m.committed && now <= c.commit_deadline) {
            want({
              account: m.address, circle: c.address, kind: "COMMIT_DUE", ref: "draw", deadline: c.commit_deadline,
              severity: severityFor(c.commit_deadline),
              title: "Commit your secret for the payout draw",
              body: "Open the circle and press Commit. Your browser keeps the secret until you reveal it.",
            });
          } else if (m.committed && !m.revealed && revealOpen && now <= c.reveal_deadline) {
            want({
              account: m.address, circle: c.address, kind: "REVEAL_DUE", ref: "draw", deadline: c.reveal_deadline,
              severity: severityFor(c.reveal_deadline),
              title: "Reveal your secret before the deadline",
              body: "Everyone has committed. Reveal now: a member who does not reveal is removed and loses one contribution.",
            });
          }
        }
      }

      // Rounds: contribution due for every participant who has not paid.
      for (const c of db.all("SELECT * FROM circles WHERE state = 2")) {
        const unpaid = db.all(
          `SELECT m.address FROM members m
           WHERE m.circle = ? AND m.position > 0 AND m.removed = 0
             AND NOT EXISTS (SELECT 1 FROM contributions k WHERE k.circle = m.circle AND k.round = ? AND k.member = m.address)`,
          [c.address, c.current_round]
        );
        for (const m of unpaid) {
          const closed = now > c.round_deadline;
          want({
            account: m.address, circle: c.address, kind: "CONTRIBUTION_DUE", ref: String(c.current_round), deadline: c.round_deadline,
            severity: severityFor(c.round_deadline),
            title: closed ? `Round ${c.current_round} closed without your payment` : `Round ${c.current_round} payment due: ${fmtToken(c.contribution)}`,
            body: closed
              ? "The payment window (round plus grace period) is over. It will be covered from your deposit when the round is settled."
              : lc(m.address) === c.current_recipient
                ? "You receive this round's pot. If you skip your payment, your own pot is smaller."
                : "Approve and pay before the deadline, or your deposit covers it and a default is recorded.",
          });
        }
      }

      // Drop reminders whose condition has cleared.
      for (const n of db.all(`SELECT * FROM notifications WHERE resolved = 0 AND kind IN ('CONTRIBUTION_DUE','COMMIT_DUE','REVEAL_DUE')`)) {
        if (!active.has(key(n.account, n.circle, n.kind, n.ref))) {
          db.run("UPDATE notifications SET resolved = 1 WHERE id = ?", [n.id]);
        }
      }
    });

    // Credits that no single event announces (penalty shares, debt repayments): read the chain.
    await this._refreshCredits(db, now);
  }

  async _refreshDeadlines(db) {
    if (!this.provider) return;
    const updates = [];
    for (const c of db.all("SELECT address, round_deadline FROM circles WHERE state = 2")) {
      try {
        const circle = new ethers.Contract(c.address, this.circleAbi, this.provider);
        const deadline = Number(await circle.roundDeadline());
        if (deadline !== Number(c.round_deadline)) updates.push([deadline, c.address]);
      } catch (e) {
        this.log.warn?.(`[notifier] could not read the deadline of ${c.address}: ${e.message}`);
      }
    }
    if (updates.length) {
      db.transaction(() => {
        for (const u of updates) db.run("UPDATE circles SET round_deadline = ? WHERE address = ?", u);
      });
    }
  }

  async _refreshCredits(db, now) {
    if (!this.provider) return;
    const rows = db.all(
      `SELECT m.circle, m.address FROM members m JOIN circles c ON c.address = m.circle
       WHERE c.state IN (2, 3, 4)`
    );
    const updates = [];
    for (const r of rows) {
      try {
        const circle = new ethers.Contract(r.circle, this.circleAbi, this.provider);
        const credit = await circle.withdrawable(r.address);
        updates.push({ ...r, credit });
      } catch (e) {
        this.log.warn?.(`[notifier] could not read credit for ${r.address}: ${e.message}`);
      }
    }
    db.transaction(() => {
      for (const u of updates) {
        const readyOpen = db.get(
          "SELECT 1 AS x FROM notifications WHERE account = ? AND circle = ? AND kind = 'PAYOUT_READY' AND resolved = 0",
          [u.address, u.circle]
        );
        if (u.credit > 0n && !readyOpen) {
          notify(db, {
            account: u.address, circle: u.circle, kind: "CREDIT_AVAILABLE", ref: "credit", severity: "success", chainTime: now,
            title: `You can claim ${fmtToken(u.credit)}`,
            body: "Money was credited to you in this circle (penalty share, debt repayment or leftover pot). Press Claim payout.",
          });
        } else if (u.credit === 0n || readyOpen) {
          db.run("UPDATE notifications SET resolved = 1 WHERE account = ? AND circle = ? AND kind = 'CREDIT_AVAILABLE'", [u.address, u.circle]);
        }
      }
    });
  }
}

module.exports = { Notifier, REMINDER_KINDS };
