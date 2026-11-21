// Browser test (optional): a full 4 member circle with one default, driven only through the UI.
//
// Uses the app's "Local test account" option (Hardhat's unlocked accounts) so it runs headless,
// with one browser tab per person: #1 Organizer, #2 to #5 members, #6 an outsider with no money.
// It also saves screenshots for the report into docs/screenshots/.
//
// Needs, all running: npx hardhat node, npm run deploy:local, npm run offchain, npm run keeper, npm run frontend
// Then:   npm i --no-save playwright && npx playwright install chromium
//         node frontend/tests/ui-full-circle.mjs
// Env:    UI_URL (default http://localhost:5173), SHOTS_DIR (default docs/screenshots), CHROME_PATH (optional)
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.UI_URL || "http://localhost:5173";
const SHOTS = process.env.SHOTS_DIR || "docs/screenshots";
fs.mkdirSync(SHOTS, { recursive: true });
const log = (...a) => console.log(`[ui] ${new Date().toISOString().slice(11, 19)}`, ...a);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--no-sandbox"] });
const ctx = await browser.newContext({ viewport: { width: 1360, height: 1000 }, acceptDownloads: true });
const errors = [];

async function shot(page, name, opts = {}) {
  await page.waitForTimeout(600);
  // Keep the sticky header at the top in full page captures.
  if (opts.fullPage) {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.addStyleTag({ content: ".top{position:static !important} .guide.open{position:static !important;max-height:none !important}" });
  }
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), ...opts });
  log("screenshot", name);
}

async function openAs(index, name) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${name}: ${e.message}`));
  await page.goto(BASE + "/#/");
  const select = page.getByLabel("Use a local Hardhat test account");
  await select.waitFor();
  await select.selectOption({ index: index + 1 });
  await page.getByRole("button", { name: "Disconnect" }).waitFor();
  page.person = name;
  return page;
}

/** Waits for the newest tray entry with this label to confirm; throws with the decoded error if it fails. */
async function waitTx(page, label, { expectFail = false, timeout = 30000 } = {}) {
  const entry = page.locator(".tray .tx", { hasText: label }).first();
  await entry.waitFor({ timeout });
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const cls = (await entry.getAttribute("class")) || "";
    if (cls.includes("confirmed")) {
      if (expectFail) throw new Error(`${page.person}: "${label}" confirmed but was expected to fail`);
      const text = await entry.innerText();
      await entry.locator(".x").click();
      return text;
    }
    if (cls.includes("failed") || cls.includes("rejected")) {
      const text = await entry.innerText();
      if (!expectFail) throw new Error(`${page.person}: "${label}" failed: ${text}`);
      return text;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`${page.person}: timed out waiting for "${label}"`);
}

async function setName(page, name) {
  await page.getByRole("button", { name: "Set display name" }).click();
  await page.getByLabel("Display name").fill(name);
  await page.getByRole("button", { name: "Sign and save name" }).click();
  await page.getByRole("button", { name: "Sign and save name" }).waitFor({ state: "detached" });
}

async function receivesThisRound(page) {
  return (await page.locator(".roles li", { hasText: "Receives this round" }).count()) > 0;
}

async function jumpTime(page, label) {
  const details = page.locator("details.devtools");
  if ((await details.getAttribute("open")) === null) await details.locator("summary").click();
  await page.getByRole("button", { name: `+${label}` }).click();
  await page.waitForTimeout(1500);
}

try {
  // ---------- wallet setup ----------
  const organizer = await openAs(1, "Organizer");
  const names = ["Ali", "Sara", "Bilal", "Hina"];
  const members = [];
  for (let i = 0; i < 4; i++) members.push(await openAs(2 + i, names[i]));
  const outsider = await openAs(6, "Outsider");
  await setName(organizer, "Nadia");
  for (let i = 0; i < 4; i++) await setName(members[i], names[i]);
  for (const p of [organizer, ...members]) {
    await p.getByRole("button", { name: "Get test mUSD" }).click();
    await waitTx(p, "Get 100,000 test mUSD");
  }
  await shot(members[0], "01-wallet-connected-faucet");
  log("wallets connected, names signed, faucet used");

  // ---------- W1 create (Organizer) ----------
  await organizer.goto(BASE + "/#/organize");
  await organizer.getByRole("button", { name: "Quick demo (minutes)" }).click();
  await shot(organizer, "02-organizer-create-form", { fullPage: true });
  await organizer.getByRole("button", { name: "Upload terms and create circle" }).click();
  await waitTx(organizer, "Create circle");
  await organizer.waitForURL(/#\/circle\/0x/);
  const circleUrl = organizer.url();
  fs.writeFileSync(path.join(SHOTS, "..", "..", ".ui-circle-url"), circleUrl);
  await organizer.getByText("Verified.").waitFor({ timeout: 20000 });
  log("circle created", circleUrl);
  await shot(organizer, "03-organizer-circle-open-terms-verified", { fullPage: true });

  // ---------- a decoded failure: outsider with no mUSD tries to join ----------
  await outsider.goto(circleUrl);
  await outsider.getByRole("button", { name: /Approve and join/ }).click();
  const failText = await waitTx(outsider, "Join circle", { expectFail: true });
  if (!/Not enough mUSD/.test(failText)) throw new Error(`unexpected failure text: ${failText}`);
  await shot(outsider, "04-readable-error-not-enough-musd");
  log("decoded error shown:", failText.replace(/\s+/g, " ").slice(0, 120));

  // ---------- W2 join ----------
  for (const m of members) {
    await m.goto(circleUrl);
    await m.getByRole("button", { name: /Approve and join|Join and lock deposit/ }).click();
    await waitTx(m, "Join circle");
    log(m.person, "joined");
  }

  // ---------- W3 commit, reveal; keeper finalizes ----------
  for (const m of members) {
    await m.getByRole("button", { name: "Commit secret" }).click();
    await waitTx(m, "Commit draw secret");
  }
  await shot(organizer, "05-order-draw-commits", { fullPage: true });
  for (const m of members) {
    const btn = m.getByRole("button", { name: "Reveal secret" });
    await btn.waitFor();
    await m.waitForFunction(() => {
      const b = [...document.querySelectorAll("button")].find((x) => x.textContent === "Reveal secret");
      return b && !b.disabled;
    }, null, { timeout: 20000 });
    await btn.click();
    await waitTx(m, "Reveal draw secret");
  }
  for (const m of members) await m.getByRole("heading", { name: "Pay round 1" }).waitFor({ timeout: 30000 });
  log("draw finalized by the keeper");

  // ---------- round 1: everyone pays, keeper settles, recipient claims ----------
  let recipient = null;
  for (const m of members) if (await receivesThisRound(m)) recipient = m;
  await shot(organizer, "06-active-round-1-organizer", { fullPage: true });
  for (const m of members) {
    await m.getByRole("button", { name: /Approve .*pay|Pay now/ }).click();
    await waitTx(m, "Pay round 1");
  }
  await recipient.getByRole("heading", { name: "Money waiting for you" }).waitFor({ timeout: 30000 });
  await recipient.getByRole("button", { name: "Reminders" }).click();
  await recipient.getByText(/Your pot is ready/).waitFor({ timeout: 15000 });
  await shot(recipient, "07-payout-ready-notification");
  await recipient.keyboard.press("Escape");
  await recipient.getByRole("button", { name: "Claim payout" }).click();
  await waitTx(recipient, "Claim payout");
  const defaulter = recipient;
  log(`round 1 settled; ${defaulter.person} received the pot and will now stop paying`);

  // ---------- rounds 2 to 4: the defaulter never pays again ----------
  for (let r = 2; r <= 4; r++) {
    await organizer.getByText(`Round ${r}`, { exact: true }).first().waitFor({ timeout: 30000 });
    for (const m of members) await m.getByRole("heading", { name: new RegExp(`(Pay round|Round) ${r}`) }).first().waitFor({ timeout: 30000 });
    let rec = null;
    for (const m of members) if (await receivesThisRound(m)) rec = m;
    for (const m of members) {
      if (m === defaulter) continue;
      await m.getByRole("button", { name: /Approve .*pay|Pay now/ }).click();
      await waitTx(m, `Pay round ${r}`);
    }
    if (r === 2) {
      await defaulter.getByRole("button", { name: "Reminders" }).click();
      await defaulter.getByText("Round 2 payment due").waitFor({ timeout: 15000 });
      await shot(defaulter, "08-defaulter-payment-due-reminder");
      await defaulter.keyboard.press("Escape");
    }
    await jumpTime(organizer, "33 days");
    // The last settlement completes the circle, so the recipient sees "Finish and withdraw" (W7).
    await rec.getByRole("heading", { name: r === 4 ? "Finish and withdraw" : "Money waiting for you" }).waitFor({ timeout: 30000 });
    if (r === 2) {
      await defaulter.reload();
      await defaulter.getByRole("button", { name: "Reminders" }).click();
      await defaulter.getByText("Missed payment in round 2").waitFor({ timeout: 15000 });
      await shot(defaulter, "09-default-recorded-notification");
      await defaulter.keyboard.press("Escape");
      await shot(organizer, "10-organizer-after-default", { fullPage: true });
    }
    if (r === 4) {
      await shot(rec, "11a-finish-and-withdraw", { fullPage: true });
      await rec.getByRole("button", { name: /^Withdraw / }).click();
      await waitTx(rec, "Withdraw credit");
    } else {
      await rec.getByRole("button", { name: "Claim payout" }).click();
      await waitTx(rec, "Claim payout");
    }
    log(`round ${r} settled after the deadline; ${defaulter.person}'s deposit covered the missed payment; ${rec.person} claimed`);
  }

  // ---------- W7 completed ----------
  for (const m of members) await m.getByRole("heading", { name: "Finish and withdraw" }).waitFor({ timeout: 30000 });
  await shot(members.find((m) => m !== defaulter), "11-completed-member-view", { fullPage: true });
  await organizer.goto(BASE + "/#/activity");
  await defaulter.goto(BASE + "/#/activity");
  await defaulter.getByText("Missed payment in round 4").first().waitFor({ timeout: 15000 }).catch(() => {});
  await shot(defaulter, "12-activity-defaulter", { fullPage: true });
  await members[0].goto(BASE + "/#/mine");
  await shot(members[0], "13-my-circles");

  // ---------- admin pause, then W8 cancel, on a second circle ----------
  await organizer.goto(BASE + "/#/organize");
  await organizer.getByRole("button", { name: "Upload terms and create circle" }).click();
  await waitTx(organizer, "Create circle");
  await organizer.waitForURL(/#\/circle\/0x/);
  const second = organizer.url();
  // A member with a clean record (the defaulter is now refused by the reputation rule).
  const joiner = members.find((m) => m !== defaulter);
  const admin = await openAs(0, "Admin");
  await admin.goto(second);
  await admin.getByRole("button", { name: "Pause for up to 7 days" }).click();
  await waitTx(admin, "Pause circle");
  await joiner.goto(second);
  await joiner.getByText("Joining is paused by the platform admin.").waitFor({ timeout: 15000 });
  await shot(joiner, "14-paused-by-admin");
  await admin.getByRole("button", { name: "Unpause" }).click();
  await waitTx(admin, "Unpause circle");
  log("admin paused and unpaused the second circle");
  await joiner.getByRole("button", { name: /Approve and join|Join and lock deposit/ }).click();
  await waitTx(joiner, "Join circle");
  organizer.once("dialog", (d) => d.accept());
  await organizer.reload();
  await organizer.getByRole("button", { name: "Cancel circle" }).click();
  await waitTx(organizer, "Cancel circle");
  await joiner.getByRole("heading", { name: "Circle cancelled" }).waitFor({ timeout: 20000 });
  await shot(joiner, "15-cancelled-refunded");
  log("second circle cancelled by the organizer; deposit refunded");

  if (errors.length) throw new Error("Page errors:\n" + errors.join("\n"));
  log("FULL CIRCLE WITH ONE DEFAULT COMPLETED IN THE UI");
} catch (e) {
  console.error("[ui] FAILED:", e.message);
  for (const p of ctx.pages()) await p.screenshot({ path: path.join(SHOTS, `fail-${p.person || "page"}.png`), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
