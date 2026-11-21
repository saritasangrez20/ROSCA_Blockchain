// Keeper: moves circles forward when their deadlines pass.
//
// settleRound, finalizeDraw and (after the join deadline) cancel can be called by anyone, so
// the keeper is a convenience, not a trust point: if it stops, any member can press the same
// button in the UI. It reads circles straight from the factory (not from the indexer), and it
// simulates each call first so it only sends transactions that will succeed.
const { ethers } = require("ethers");
const { chainNow, STATE_NAMES } = require("../lib/chain");

class Keeper {
  /**
   * @param {object} o
   * @param {ethers.Provider} o.provider
   * @param {ethers.Signer} o.signer     any funded account; it gains no rights by being the keeper
   * @param {object} o.deployment
   * @param {object} o.abis
   */
  constructor({ provider, signer, deployment, abis, settleEarly = true, cancelExpired = true, logger = console }) {
    this.provider = provider;
    this.signer = signer;
    this.abis = abis;
    this.settleEarly = settleEarly;
    this.cancelExpired = cancelExpired;
    this.log = logger;
    this.factory = new ethers.Contract(deployment.CircleFactory, abis.CircleFactory, provider);
    this.payoutOrder = new ethers.Contract(deployment.PayoutOrder, abis.PayoutOrder, provider);
    this.busy = false;
  }

  /** One pass over every circle. Returns the actions taken. */
  async tick() {
    if (this.busy) return [];
    this.busy = true;
    const actions = [];
    try {
      const now = await chainNow(this.provider);
      const circles = await this.factory.getCircles();
      for (const address of circles) {
        const circle = new ethers.Contract(address, this.abis.Circle, this.signer);
        const s = await circle.getSummary();
        const state = Number(s.state);
        let action = null;

        if (state === 2) {
          // Active: settle once the deadline (round + grace) has passed, or early when all paid.
          const pastDeadline = now > Number(s.roundDeadline);
          if (pastDeadline || this.settleEarly) action = "settleRound";
        } else if (state === 1) {
          const d = await this.payoutOrder.getDraw(address);
          if (Number(d.revealCount) === Number(d.memberCount) || now > Number(d.revealDeadline)) action = "finalizeDraw";
        } else if (state === 0 && this.cancelExpired && now > Number(s.joinDeadline)) {
          action = "cancel";
        }
        if (!action) continue;

        // Simulate first against the next block's time; skip quietly if it would revert
        // (for example settleRound before everyone paid and before the deadline).
        try {
          await circle[action].staticCall({ blockTag: "pending" });
        } catch {
          continue;
        }
        try {
          const tx = await circle[action]();
          const rc = await tx.wait();
          const entry = { circle: address, action, round: Number(s.currentRound), state: STATE_NAMES[state], tx: rc.hash, gasUsed: Number(rc.gasUsed) };
          actions.push(entry);
          this.log.info?.(`[keeper] ${action} on ${address} (${entry.state}${state === 2 ? ` round ${entry.round}` : ""}) tx ${rc.hash}`);
        } catch (e) {
          this.log.warn?.(`[keeper] ${action} on ${address} failed: ${e.shortMessage || e.message}`);
        }
      }
    } finally {
      this.busy = false;
    }
    return actions;
  }
}

module.exports = { Keeper };
