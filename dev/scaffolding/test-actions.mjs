import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://localhost:5173";
const VIDEO = "https://www.youtube.com/watch?v=aqz-KE-bpKQ"; // ~10 min, large enough to cancel
const PLAYLIST = "https://www.youtube.com/playlist?list=UUSMOQeBJ2RAnuFungnQOxLg";

const errors = [];
const fails = [];
const ok = [];
const http = [];
function check(name, cond, detail = "") {
  (cond ? ok : fails).push(name + (detail ? ` — ${detail}` : ""));
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("response", (r) => { if (r.status() >= 400) http.push(`${r.status()} ${r.url().slice(0, 120)}`); });

const urlInput = () => page.locator('input[placeholder="Paste YouTube URL"]');
const bodyText = () => page.evaluate(() => document.body.innerText);
const jobs = () => page.evaluate(async () => (await (await fetch("/api/jobs")).json()));

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#root > *");
await page.waitForTimeout(1200);

// ---------- A. Cancel an in-flight download ----------
console.log("\n=== A. CANCEL IN-FLIGHT ===");
await urlInput().fill("");
await urlInput().type(VIDEO, { delay: 3 });
await page.getByText("Big Buck Bunny", { exact: false }).first().waitFor({ timeout: 90000 });
// pick a big preset so it can't finish instantly
await page.locator("select").first().selectOption({ label: "MKV · maximum fidelity" });
await page.waitForTimeout(400);
await page.getByRole("button", { name: /^Download · MKV$/ }).click();
await page.waitForTimeout(2500);
let j = (await jobs())[0];
check("job started", !!j && ["queued", "probing", "downloading"].includes(j.phase), "phase=" + j?.phase);
const cancelBtn = page.locator('button[title="Cancel"]').first();
check("cancel button visible while working", await cancelBtn.isVisible());
await cancelBtn.click();
await page.waitForTimeout(4000);
j = (await jobs())[0];
check("job cancelled", j && ["cancelled", "error"].includes(j.phase), "phase=" + j?.phase);
check("cancelled badge in UI", /Cancelled|Failed/.test(await bodyText()));

// ---------- B. Retry a cancelled job ----------
console.log("\n=== B. RETRY ===");
const retryBtn = page.locator('button[title="Retry"]').first();
check("retry button offered", await retryBtn.isVisible());
await retryBtn.click();
await page.waitForTimeout(4000);
j = (await jobs())[0];
check("retry re-queues job", j && ["queued", "probing", "downloading", "done"].includes(j.phase), "phase=" + j?.phase);
// cancel again + remove
await page.locator('button[title="Cancel"]').first().click().catch(() => {});
await page.waitForTimeout(3500);

// ---------- C. Remove a job ----------
console.log("\n=== C. REMOVE ===");
const removeBtn = page.locator('button[title="Remove"]').first();
check("remove button offered when not working", await removeBtn.isVisible());
await removeBtn.click();
await page.waitForTimeout(1500);
const afterRemove = await jobs();
check("job removed from store", afterRemove.length === 0, `${afterRemove.length} left`);
check("queue back to empty state", /Nothing queued yet/.test(await bodyText()));

// ---------- D. Download from a playlist ----------
console.log("\n=== D. DOWNLOAD FROM PLAYLIST ===");
await urlInput().fill("");
await urlInput().type(PLAYLIST, { delay: 3 });
await page.waitForFunction(() => document.querySelectorAll('[role="row"]').length > 0, { timeout: 120000 }).catch(() => {});
await page.waitForTimeout(2500);
const cbs = page.locator('[role="row"] input[type="checkbox"]');
const n = await cbs.count();
check("playlist loaded", n > 0, `${n} rows`);
// clear all, then select just ONE row to keep the test fast
await page.getByRole("button", { name: /^Clear$/ }).click();
await page.waitForTimeout(800);
await cbs.first().click();
await page.waitForTimeout(800);
const sel = (await bodyText()).match(/(\d+) of (\d+) selected/)?.[0] ?? "";
check("exactly 1 selected", /^1 of /.test(sel), sel);
await page.getByRole("tab", { name: "Audio" }).click();
await page.waitForTimeout(400);
await page.locator("select").first().selectOption({ label: "Opus · native" });
await page.waitForTimeout(400);
const plBtn = page.getByRole("button", { name: /^Download 1 · OPUS$/ });
check("playlist download button", await plBtn.isVisible(), await plBtn.innerText().catch(() => "n/a"));
await plBtn.click();
await page.waitForTimeout(2000);
let pj = await jobs();
check("playlist job queued", pj.length === 1, `${pj.length} jobs`);
let plPhase = "";
for (let i = 0; i < 60; i++) {
  await page.waitForTimeout(2000);
  pj = await jobs();
  if (!pj.length) break;
  plPhase = pj[0].phase;
  if (["done", "error", "cancelled"].includes(plPhase)) break;
}
check("playlist item downloads", plPhase === "done", "phase=" + plPhase);

// ---------- E. Settings save ----------
console.log("\n=== E. SETTINGS SAVE ===");
await page.locator('button[title="Settings"]').click();
await page.waitForTimeout(900);
check("dialog open", (await page.locator('[role="dialog"]').count()) === 1);
const dlgTxt = await page.locator('[role="dialog"]').first().innerText();
console.log("   dialog fields:", dlgTxt.replace(/\n+/g, " | ").slice(0, 260));
// change fragment concurrency select if present
const sels = page.locator('[role="dialog"] select');
const selCount = await sels.count();
console.log("   selects in dialog:", selCount);
let savedOk = false;
if (selCount > 0) {
  const first = sels.first();
  const opts = await first.locator("option").allInnerTexts();
  const cur = await first.inputValue();
  const other = (await first.locator("option").all()).length > 1 ? null : null;
  const values = await first.locator("option").evaluateAll((os) => os.map((o) => o.value));
  const nextVal = values.find((v) => v !== cur);
  if (nextVal) {
    await first.selectOption(nextVal);
    await page.waitForTimeout(500);
    const saveBtn = page.getByRole("button", { name: /Save/i }).first();
    if (await saveBtn.count()) {
      await saveBtn.click();
      await page.waitForTimeout(1500);
      savedOk = (await page.locator("[data-sonner-toast]").count()) > 0;
      check("settings save toast", savedOk);
      const persisted = await page.evaluate(async () => (await (await fetch("/api/settings")).json()));
      console.log("   persisted settings:", JSON.stringify(persisted));
      check("setting persisted", String(persisted.fragmentConcurrency) === String(nextVal), `fc=${persisted.fragmentConcurrency} expected=${nextVal}`);
    } else console.log("   (no Save button found)");
  }
}
await page.keyboard.press("Escape");
await page.waitForTimeout(600);

// ---------- F. Library delete + clear ----------
console.log("\n=== F. LIBRARY DELETE / CLEAR ===");
await page.getByRole("button", { name: /Library/ }).click();
await page.waitForTimeout(2000);
let hist = await page.evaluate(async () => (await (await fetch("/api/history")).json()));
check("history has rows", hist.length > 0, `${hist.length} rows`);
const t = await bodyText();
console.log("   library text:", t.replace(/\n+/g, " | ").slice(0, 300));
const delBtns = page.locator('button[title="Delete"], button[title="Remove"]');
const dcount = await delBtns.count();
console.log("   delete buttons:", dcount);
if (dcount > 0) {
  await delBtns.first().click();
  await page.waitForTimeout(1500);
  const hist2 = await page.evaluate(async () => (await (await fetch("/api/history")).json()));
  check("history row deleted", hist2.length === hist.length - 1, `${hist.length} -> ${hist2.length}`);
} else {
  check("delete control present", false, "no delete button found");
}

// ---------- G. clear all history ----------
const clearAll = page.getByRole("button", { name: /Clear (all|history)/i }).first();
if (await clearAll.count()) {
  page.once("dialog", (d) => d.accept().catch(() => {}));
  await clearAll.click();
  await page.waitForTimeout(1800);
  const hist3 = await page.evaluate(async () => (await (await fetch("/api/history")).json()));
  check("history cleared", hist3.length === 0, `${hist3.length} rows`);
} else {
  console.log("   (no clear-all button)");
}

await page.screenshot({ path: "test-actions-final.png", fullPage: false });

console.log("\n===== SUMMARY =====");
console.log(`passed: ${ok.length}   failed: ${fails.length}`);
if (fails.length) fails.forEach((f) => console.log("  FAILED: " + f));
const realErrors = errors.filter((e) => !/favicon/i.test(e));
console.log(`console errors: ${realErrors.length}`);
realErrors.slice(0, 15).forEach((e) => console.log("  - " + e.slice(0, 220)));
const realHttp = http.filter((h) => !/favicon/i.test(h) && !/\/api\/probe/.test(h));
console.log(`unexpected http >=400: ${realHttp.length}`);
realHttp.slice(0, 10).forEach((h) => console.log("  - " + h));

await browser.close();
process.exit(fails.length ? 1 : 0);
