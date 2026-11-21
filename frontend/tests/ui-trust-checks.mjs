// Browser test (optional): the off chain trust rules, checked in the real UI.
//
//   node frontend/tests/ui-trust-checks.mjs offline <circleUrl>
//       Run while `npm run offchain` is STOPPED. The app must say the indexer is offline and still
//       show the circle list, the circle, its history and the reminders, read from the chain.
//   node frontend/tests/ui-trust-checks.mjs tamper <circleUrl>
//       Run while `npm run offchain` is running. Changes the stored terms file behind the IPFS
//       service's back, checks that the page refuses it, then restores the file.
// <circleUrl> defaults to the one saved by ui-full-circle.mjs in .ui-circle-url.
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const [mode, urlArg] = process.argv.slice(2);
const SHOTS = process.env.SHOTS_DIR || "docs/screenshots";
const url = urlArg || fs.readFileSync(".ui-circle-url", "utf8").trim();
const BASE = url.split("#")[0];
const log = (...a) => console.log("[trust]", ...a);

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
const shot = async (name) => {
  await page.waitForTimeout(600);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.addStyleTag({ content: ".top{position:static !important} .guide.open{position:static !important;max-height:none !important}" });
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
};

try {
  await page.goto(BASE + "#/");
  await page.getByLabel("Use a local Hardhat test account").selectOption({ index: 3 });
  await page.getByRole("button", { name: "Disconnect" }).waitFor();

  if (mode === "offline") {
    await page.getByText("Indexer offline: reading the chain").waitFor({ timeout: 15000 });
    await page.getByText("Listed from the chain directly.").waitFor({ timeout: 15000 });
    log("circle list read from the chain");
    await page.goto(url);
    await page.getByText("Read from chain logs directly (indexer offline).").waitFor({ timeout: 20000 });
    await page.getByText("Circle completed. Remaining deposits returned.").first().waitFor({ timeout: 20000 });
    log("circle history rebuilt from chain logs in the browser");
    await page.getByRole("button", { name: /Reminders/ }).click();
    await page.getByText("Worked out from the chain (notifier offline)").waitFor({ timeout: 15000 });
    await page.keyboard.press("Escape");
    await shot("16-indexer-offline-chain-fallback");
    log("PASS: the UI keeps working with the indexer down");
  } else if (mode === "tamper") {
    await page.goto(url);
    await page.getByText("Verified.").waitFor({ timeout: 20000 });
    const cid = (await page.locator(".terms .cid code").innerText()).trim();
    const file = path.join("offchain", "data", "ipfs", cid);
    const original = fs.readFileSync(file);
    try {
      fs.writeFileSync(file, Buffer.from(original.toString().replace("1000 mUSD", "100 mUSD")));
      await page.getByRole("button", { name: "Check again" }).click();
      await page.getByText("Do not trust this document.").waitFor({ timeout: 20000 });
      await shot("17-tampered-terms-detected");
      log("PASS: a changed terms file is detected by re hashing in the browser");
    } finally {
      fs.writeFileSync(file, original);
    }
    await page.getByRole("button", { name: "Check again" }).click();
    await page.getByText("Verified.").waitFor({ timeout: 20000 });
    log("original restored and verified again");
  } else {
    throw new Error("usage: ui-trust-checks.mjs offline|tamper [circleUrl]");
  }
} catch (e) {
  console.error("[trust] FAILED:", e.message);
  await page.screenshot({ path: path.join(SHOTS, `fail-trust-${mode}.png`), fullPage: true }).catch(() => {});
  process.exitCode = 1;
} finally {
  await browser.close();
}
