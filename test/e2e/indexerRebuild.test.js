// Indexer rebuild test (Member B): the indexer database is only a cache of the chain.
//
// 1. Index three circles incrementally in tiny block chunks while they run
//    (one completes with a default, one is cancelled, one removes a non revealer).
// 2. Delete the database file, rebuild from events alone: every chain derived table is identical.
// 3. Rebuild in place: identical again, and the off chain display names survive.
// 4. Restart from the saved file: nothing is applied twice.
// 5. Reorganise the chain (evm_snapshot / evm_revert): the indexer notices the block hash
//    changed, rebuilds by itself, and drops the events that no longer exist.
const fs = require("fs");
const path = require("path");
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { profileMessage } = require("../../offchain/api/server");
const { REMINDER_KINDS } = require("../../offchain/notifier/notifier");
const h = require("./e2eHelpers");

const C = 1_000n * h.UNIT;

/** Every chain derived row, in a stable order, without autoincrement ids or refresh times. */
function dump(db) {
  const q = (sql) => db.all(sql);
  const reminders = REMINDER_KINDS.map((k) => `'${k}'`).join(",");
  return {
    events: q("SELECT block_number, block_hash, block_time, tx_hash, log_index, contract, address, circle, name, args FROM events ORDER BY block_number, log_index"),
    eventAccounts: q("SELECT e.tx_hash, e.log_index, a.account FROM event_accounts a JOIN events e ON e.id = a.event_id ORDER BY e.block_number, e.log_index, a.account"),
    circles: q("SELECT * FROM circles ORDER BY address"),
    members: q("SELECT * FROM members ORDER BY circle, address"),
    rounds: q("SELECT * FROM rounds ORDER BY circle, round"),
    contributions: q("SELECT * FROM contributions ORDER BY circle, round, member"),
    reputation: q("SELECT * FROM reputation ORDER BY address"),
    eventNotices: q(`SELECT account, circle, kind, ref, title, body, severity, chain_time, deadline, resolved FROM notifications
                     WHERE kind NOT IN (${reminders}) ORDER BY account, circle, kind, ref`),
    openReminders: q(`SELECT account, circle, kind, ref, title, deadline FROM notifications
                      WHERE kind IN (${reminders}) AND resolved = 0 ORDER BY account, circle, kind, ref`),
  };
}

describe("E2E: indexer rebuild from chain events", function () {
  this.timeout(120_000);

  let snap, sys, abis, organizer, people, keeperSigner, dir, dbFile, ipfsDir, live, finalDump;

  before(async function () {
    snap = await h.snapshot();
    const signers = await ethers.getSigners();
    organizer = signers[1];
    people = signers.slice(2, 7);
    keeperSigner = signers[9];
    sys = await h.deploySystem();
    abis = await h.loadArtifactsAbis();
    for (const p of people) await sys.token.mint(p.address, 50_000n * h.UNIT);
    dir = h.tempDir("rosca-rebuild-");
    dbFile = path.join(dir, "indexer.sqlite");
    ipfsDir = path.join(dir, "ipfs");
    live = await h.startOffchain(sys.deployment, abis, { dbFile, ipfsDir, blockChunk: 3 });
  });

  after(async function () {
    if (live) await live.stop();
    await h.revert(snap);
  });

  it("indexes three circles incrementally while they run", async function () {
    const sync = () => live.svc.tick();
    const keeper = h.makeKeeper(sys.deployment, abis, keeperSigner);
    const vaultAddr = await sys.vault.getAddress();
    const join = async (circle, list) => {
      const amt = await circle.joinCollateral();
      for (const m of list) {
        await sys.token.connect(m).approve(vaultAddr, amt);
        await circle.connect(m).join();
        await sync();
      }
    };
    const draw = async (circle, list, skipReveal = []) => {
      const addr = await circle.getAddress();
      for (const m of list) await sys.payoutOrder.connect(m).commit(addr, await sys.payoutOrder.computeCommitment(h.secretFor(m, addr), m.address, addr));
      await sync();
      for (const m of list) if (!skipReveal.includes(m)) await sys.payoutOrder.connect(m).reveal(addr, h.secretFor(m, addr));
      await sync();
    };

    // A display name, which is off chain data and must survive rebuilds.
    const issuedAt = new Date().toISOString();
    const signature = await people[0].signMessage(profileMessage(people[0].address, "Ali", issuedAt));
    expect((await live.api.post("/api/profiles", { address: people[0].address, displayName: "Ali", issuedAt, signature })).status).to.equal(200);

    // Circle 1: 4 members, completes, the round 1 recipient misses round 2.
    const c1 = await h.createCircle(sys.factory, organizer, h.circleConfig("bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku"));
    const four = people.slice(0, 4);
    await join(c1, four);
    await draw(c1, four);
    await keeper.tick(); // finalizeDraw
    const c1Addr = await c1.getAddress();
    const order = (await c1.getPayoutOrder()).map((a) => four.find((m) => m.address === a));
    for (let r = 1; r <= 4; r++) {
      const payers = r === 2 ? order.slice(1) : order;
      for (const m of payers) {
        await sys.token.connect(m).approve(c1Addr, C);
        await c1.connect(m).contribute();
      }
      await sync();
      if (r === 2) await time.increase(33 * h.DAY + 1);
      await keeper.tick();
      await c1.connect(order[r - 1]).claimPayout();
      await sync();
    }
    expect(await c1.state()).to.equal(3n);

    // Circle 2: organizer cancels while open.
    const c2 = await h.createCircle(sys.factory, organizer, h.circleConfig("bafkreifzjut3te2nhyekklss27nh3k72ysco7y32koao5eei66wof36n5e", { maxDefaults: 5n }));
    await join(c2, people.slice(0, 2));
    await c2.connect(organizer).cancel();
    await sync();

    // Circle 3: 3 members, one never reveals, is removed with a penalty, the other two continue.
    const c3 = await h.createCircle(sys.factory, organizer, h.circleConfig("bafkreifektrpqiqvqmbxxiggsa5bquv6aw4jmsfwbvcihnze2xilhanioe", { groupSize: 3n, maxDefaults: 5n }));
    const three = people.slice(2, 5);
    await join(c3, three);
    await draw(c3, three, [three[2]]);
    await time.increase(2 * h.DAY + 1);
    await keeper.tick(); // finalizeDraw after the reveal window
    expect(await c3.participantCount()).to.equal(2n);
    await sync();

    finalDump = dump(live.svc.db);
    expect(finalDump.circles.map((c) => c.state).sort()).to.deep.equal([2, 3, 4]);
    expect(finalDump.members.filter((m) => m.removed === 1)).to.have.length(1);
    expect(finalDump.events.length).to.be.greaterThan(100);
  });

  it("deleting the database and rebuilding from events gives identical tables", async function () {
    await live.stop();
    live = null;
    fs.rmSync(dbFile);
    expect(fs.existsSync(dbFile)).to.equal(false);

    const fresh = await h.startOffchain(sys.deployment, abis, { dbFile, ipfsDir, blockChunk: 1000 });
    try {
      await fresh.svc.tick();
      const rebuilt = dump(fresh.svc.db);
      for (const table of Object.keys(finalDump)) {
        expect(rebuilt[table], table).to.deep.equal(finalDump[table]);
      }
      // The display name was deleted with the file: it is off chain data, not chain data.
      expect(fresh.svc.db.get("SELECT COUNT(*) AS n FROM profiles").n).to.equal(0);
    } finally {
      await fresh.stop();
    }
  });

  it("rebuilding in place gives identical tables and keeps off chain display names", async function () {
    live = await h.startOffchain(sys.deployment, abis, { dbFile, ipfsDir });
    const issuedAt = new Date().toISOString();
    const signature = await people[0].signMessage(profileMessage(people[0].address, "Ali", issuedAt));
    await live.api.post("/api/profiles", { address: people[0].address, displayName: "Ali", issuedAt, signature });

    const r = await live.svc.rebuild();
    expect(r.applied).to.equal(finalDump.events.length);
    const rebuilt = dump(live.svc.db);
    for (const table of Object.keys(finalDump)) expect(rebuilt[table], table).to.deep.equal(finalDump[table]);
    expect(live.svc.db.get("SELECT display_name FROM profiles").display_name).to.equal("Ali");
  });

  it("restarting from the saved file applies nothing twice", async function () {
    await live.stop();
    live = await h.startOffchain(sys.deployment, abis, { dbFile, ipfsDir });
    const r = await live.svc.tick();
    expect(r.applied).to.equal(0);
    expect(dump(live.svc.db).events).to.deep.equal(finalDump.events);
  });

  it("detects a reorganised chain by block hash and rebuilds by itself", async function () {
    const fork = await h.snapshot();
    const lost = await h.createCircle(sys.factory, organizer, h.circleConfig("bafkrei-lost-branch"));
    await live.svc.tick();
    expect(live.svc.db.get("SELECT COUNT(*) AS n FROM circles WHERE address = ?", [(await lost.getAddress()).toLowerCase()]).n).to.equal(1);

    await h.revert(fork); // the block with `lost` disappears ...
    await ethers.provider.send("evm_mine", []); // ... and the chain grows a different block instead
    const kept = await h.createCircle(sys.factory, people[0], h.circleConfig("bafkrei-new-branch"));
    await live.svc.tick();

    const addrs = live.svc.db.all("SELECT address FROM circles").map((r) => r.address);
    expect(addrs).to.include((await kept.getAddress()).toLowerCase());
    expect(live.svc.db.get("SELECT COUNT(*) AS n FROM events WHERE args LIKE '%lost-branch%'").n).to.equal(0);
    const now = dump(live.svc.db);
    expect(now.events.slice(0, finalDump.events.length)).to.deep.equal(finalDump.events);
  });

  it("refuses to mix deployments: a database from another factory is reset", async function () {
    await live.stop();
    const other = await h.deploySystem();
    live = await h.startOffchain(other.deployment, abis, { dbFile, ipfsDir });
    await live.svc.tick();
    expect(live.svc.db.get("SELECT COUNT(*) AS n FROM circles").n).to.equal(0);
    expect(live.svc.db.getMeta("fingerprint")).to.include(other.deployment.CircleFactory.toLowerCase());
  });
});
