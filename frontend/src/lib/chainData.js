// Reads straight from the contracts. The UI always uses these for anything that decides an
// action (state, balances, roles, deadlines). It also uses them for lists, history and
// reminders whenever the indexer is unreachable, so nothing is lost if the indexer is down.
import { ethers } from "ethers";
import { circleAt, contractsFor, readProvider, chainNow } from "./contracts.js";

const lc = (a) => (a ? a.toLowerCase() : a);
const PAUSER_ROLE = ethers.id("PAUSER_ROLE");

function plain(v) {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v) || (v && typeof v.toArray === "function")) return Array.from(v).map(plain);
  return v;
}

function summaryToRow(address, s) {
  return {
    address: lc(address),
    state: Number(s.state),
    organizer: lc(s.organizer),
    contribution: s.contribution.toString(),
    groupSize: Number(s.groupSize),
    memberCount: Number(s.memberCount),
    participantCount: Number(s.participantCount),
    currentRound: Number(s.currentRound),
    roundDeadline: Number(s.roundDeadline),
    currentRecipient: s.currentRecipient === ethers.ZeroAddress ? null : lc(s.currentRecipient),
    joinDeadline: Number(s.joinDeadline),
    joinCollateral: s.joinCollateral.toString(),
    paused: s.paused,
    termsCid: s.termsCid,
  };
}

export async function listCirclesFromChain(deployment) {
  const { factory } = contractsFor(deployment);
  const addrs = await factory.getCircles();
  const rows = await Promise.all(addrs.map(async (a) => summaryToRow(a, await circleAt(a).getSummary())));
  return rows.reverse();
}

/** Everything the circle page needs, read live. */
export async function loadCircleLive(address, account, deployment) {
  const c = circleAt(address);
  const { payoutOrder, token, vault, reputation } = contractsFor(deployment);
  const [s, members, order, cfg, now] = await Promise.all([c.getSummary(), c.getMembers(), c.getPayoutOrder(), c.config(), chainNow()]);
  const summary = summaryToRow(address, s);
  const draw = await payoutOrder.getDraw(address);

  const people = [...new Set([...members.map(lc), ...(account ? [lc(account)] : [])])];
  const infos = await Promise.all(
    people.map(async (m) => {
      const [info, commitment, revealed, rep] = await Promise.all([
        c.getMemberInfo(m),
        payoutOrder.commitmentOf(address, m),
        payoutOrder.hasRevealed(address, m),
        reputation.getRecord(m),
      ]);
      return {
        address: m,
        joined: members.map(lc).includes(m),
        isMember: info.isMember,
        removed: info.removed,
        position: Number(info.position),
        collateral: info.collateral.toString(),
        paidThisRound: info.paidThisRound,
        withdrawable: info.withdrawable.toString(),
        debt: info.debt.toString(),
        deficit: info.deficit.toString(),
        defaults: Number(info.defaults),
        committed: commitment !== ethers.ZeroHash,
        commitment,
        revealed,
        reputation: { joined: Number(rep.joined), completed: Number(rep.completed), defaults: Number(rep.defaults) },
      };
    })
  );

  const rounds = [];
  for (let r = 1; r <= summary.currentRound; r++) {
    const res = await c.rounds(r);
    rounds.push({ round: r, recipient: lc(order[r - 1]), pot: res.pot.toString(), shortfall: res.shortfall.toString(), settled: res.settled });
  }

  let wallet = null;
  if (account) {
    const [balance, allowVault, allowCircle, isPauser] = await Promise.all([
      token.balanceOf(account),
      token.allowance(account, deployment.CollateralVault),
      token.allowance(account, address),
      c.hasRole(PAUSER_ROLE, account),
    ]);
    wallet = { balance, allowVault, allowCircle, isPauser };
  }

  return {
    ...summary,
    now,
    config: {
      roundDuration: Number(cfg.roundDuration),
      gracePeriod: Number(cfg.gracePeriod),
      joinDuration: Number(cfg.joinDuration),
      drawPhaseDuration: Number(cfg.drawPhaseDuration),
      maxDefaults: Number(cfg.maxDefaults),
    },
    draw: {
      started: draw.started,
      finalized: draw.finalized,
      commitDeadline: Number(draw.commitDeadline),
      revealDeadline: Number(draw.revealDeadline),
      commitCount: Number(draw.commitCount),
      revealCount: Number(draw.revealCount),
      memberCount: Number(draw.memberCount),
    },
    members: infos.filter((i) => i.joined),
    me: account ? infos.find((i) => i.address === lc(account)) : null,
    order: order.map(lc),
    rounds,
    wallet,
    vaultAddress: await vault.getAddress(),
  };
}

/** Circle history from raw logs (used when the indexer is down). */
export async function circleHistoryFromChain(address, deployment) {
  const c = circleAt(address);
  const { payoutOrder, vault, factory } = contractsFor(deployment);
  const byCircle = (contract, name) => contract.queryFilter(contract.filters[name](address), 0);
  const groups = await Promise.all([
    c.queryFilter("*", 0),
    factory.queryFilter(factory.filters.CircleCreated(address), 0),
    ...["DrawStarted", "Committed", "Revealed", "DrawFinalized"].map((n) => byCircle(payoutOrder, n)),
    ...["CollateralDeposited", "CollateralReleased", "CollateralSlashed"].map((n) => byCircle(vault, n)),
  ]);
  const logs = groups.flat().filter((l) => l.fragment && !["RoleGranted", "RoleRevoked"].includes(l.fragment.name));
  logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
  const times = {};
  for (const n of [...new Set(logs.map((l) => l.blockNumber))]) times[n] = Number((await readProvider.getBlock(n)).timestamp);
  return logs.map((l) => ({
    name: l.fragment.name,
    args: Object.fromEntries(l.fragment.inputs.map((inp, i) => [inp.name, plain(l.args[i])])),
    blockNumber: l.blockNumber,
    blockTime: times[l.blockNumber],
    txHash: l.transactionHash,
    logIndex: l.index,
  }));
}

/** Reminders computed in the browser from the chain, when the notifier is unreachable. */
export async function remindersFromChain(account, deployment) {
  if (!account) return [];
  const { factory, payoutOrder } = contractsFor(deployment);
  const now = await chainNow();
  const out = [];
  for (const addr of await factory.getCircles()) {
    const c = circleAt(addr);
    const [s, info] = await Promise.all([c.getSummary(), c.getMemberInfo(account)]);
    const state = Number(s.state);
    const base = { circle: lc(addr), id: `chain:${lc(addr)}` };
    if (info.withdrawable > 0n) {
      out.push({ ...base, kind: "CREDIT_AVAILABLE", severity: "success", title: `You can claim ${ethers.formatUnits(info.withdrawable, 6)} mUSD`, body: "Open the circle and press Claim payout." });
    }
    if (!info.isMember) continue;
    if (state === 1) {
      const d = await payoutOrder.getDraw(addr);
      const committed = (await payoutOrder.commitmentOf(addr, account)) !== ethers.ZeroHash;
      const revealed = await payoutOrder.hasRevealed(addr, account);
      if (!committed && now <= Number(d.commitDeadline)) out.push({ ...base, kind: "COMMIT_DUE", severity: "warning", deadline: Number(d.commitDeadline), title: "Commit your secret for the payout draw", body: "" });
      else if (committed && !revealed && now <= Number(d.revealDeadline)) out.push({ ...base, kind: "REVEAL_DUE", severity: "warning", deadline: Number(d.revealDeadline), title: "Reveal your secret before the deadline", body: "" });
    }
    if (state === 2 && !info.paidThisRound) {
      out.push({
        ...base, kind: "CONTRIBUTION_DUE", deadline: Number(s.roundDeadline), severity: now > Number(s.roundDeadline) ? "danger" : "warning",
        title: `Round ${s.currentRound} payment due: ${ethers.formatUnits(s.contribution, 6)} mUSD`, body: "",
      });
    }
  }
  return out;
}