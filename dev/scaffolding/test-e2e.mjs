import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://localhost:5173";
const VIDEO = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
const PLAYLIST = "https://www.youtube.com/playlist?list=UUSMOQeBJ2RAnuFungnQOxLg";

const errors = [];
const fails = [];
const ok = [];
const http4xx = [];
function check(name, cond, detail = "") {
  (cond ? ok : fails).push(name + (detail ? ` — ${detail}` : ""));
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
page.on("response", (r) => {
  if (r.status() >= 400) http4xx.push(`${r.status()} ${r.url().slice(0, 130)}`);
});

const urlInput = () => page.locator('input[placeholder="Paste YouTube URL"]');
async function typeUrl(u) {
  await urlInput().fill("");
  await urlInput().type(u, { delay: 3 });
}
const bodyText = () => page.evaluate(() => document.body.innerText);

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#root > *", { timeout: 20000 });

// ---------- 1. Initial render ----------
console.log("\n=== 1. INITIAL RENDER ===");
check("app shell renders", (await page.locator("h1").first().innerText()).includes("YouTube"));
check("SSE connected", await page.getByText("Live updates connected").isVisible());
check("yt-dlp badge shown", await page.getByText(/yt-dlp \d/).first().isVisible());
check("ffmpeg badge shown", await page.getByText(/ffmpeg \d/).first().isVisible());
check("queue empty state", await page.getByText("Nothing queued yet.").isVisible());

// ---------- 2. Invalid URL ----------
console.log("\n=== 2. INVALID URL (error path) ===");
await typeUrl("https://www.youtube.com/watch?v=notarealvideo1");
// The probe is a real network round-trip through yt-dlp; the error card only
// appears once the 502 comes back (~5s), so poll for it instead of guessing.
let t2 = "";
try {
  await page.waitForFunction(() => /unavailable|could not|does not exist|private/i.test(document.body.innerText), { timeout: 60000 });
  t2 = await bodyText();
} catch {
  t2 = await bodyText();
}
check("error surfaced to user", /could not|unavailable|not exist|private|error/i.test(t2), t2.match(/.*(could not|unavailable|not exist).*/i)?.[0]?.slice(0, 90) ?? "");
check("not stuck loading", !/Loading metadata/i.test(t2));

// ---------- 3. Single video probe ----------
console.log("\n=== 3. SINGLE VIDEO PROBE ===");
await typeUrl(VIDEO);
await page.getByText("Big Buck Bunny", { exact: false }).first().waitFor({ timeout: 90000 });
check("metadata card rendered", true, "Big Buck Bunny");
const thumbLoaded = await page
  .waitForFunction(
    () => {
      const i = document.querySelector('img[src*="ytimg"]');
      return i && i.complete && i.naturalWidth > 0 ? true : false;
    },
    { timeout: 20000 },
  )
  .then(() => true)
  .catch(() => false);
check("thumbnail loads from CDN", thumbLoaded);
check("duration rendered", /\d+:\d\d/.test(await bodyText()));
check("view count rendered", /views/i.test(await bodyText()));
check("output dir shown", /Saves to/i.test(await bodyText()));

// ---------- 4. Format picker ----------
console.log("\n=== 4. FORMAT PICKER ===");
const fmtSelect = page.locator("select").first();
check("video presets", (await fmtSelect.locator("option").count()) === 4);
await page.getByRole("tab", { name: "Audio" }).click();
await page.waitForTimeout(500);
check("audio presets", (await fmtSelect.locator("option").count()) === 5);
check("audio quality hint", await page.getByText(/best audio is Opus/).isVisible());
await fmtSelect.selectOption({ label: "M4A · AAC 256" });
await page.waitForTimeout(400);
check(
  "re-encode badge for audio",
  await page.getByText("Re-encodes").isVisible(),
);
await fmtSelect.selectOption({ label: "Opus · native" });
await page.waitForTimeout(400);
check("instant badge for native opus", await page.getByText("Instant remux").isVisible());
await page.getByRole("tab", { name: "Video" }).click();
await page.waitForTimeout(400);

// ---------- 5. Options ----------
console.log("\n=== 5. OPTIONS ===");
const switches = page.locator('button[role="switch"]');
// 5 toggles: embedThumbnail, embedMetadata, embedChapters, sponsorblock, subtitles.
check("5 option switches", (await switches.count()) === 5, String(await switches.count()));
const subSwitch = switches.nth(4);
await subSwitch.click();
await page.waitForTimeout(400);
check("subtitle langs input appears", (await page.locator('input[placeholder="en.*"]').count()) === 1);
check("switch aria-checked true", (await subSwitch.getAttribute("aria-checked")) === "true");
await subSwitch.click();
await page.waitForTimeout(300);
check("subtitle langs input hides again", (await page.locator('input[placeholder="en.*"]').count()) === 0);
check("clip range inputs", (await page.locator('input[placeholder="00:00:00"]').count()) === 1);
check("speed limit input", (await page.locator('input[placeholder="e.g. 5M"]').count()) === 1);

// ---------- 6. Download single video ----------
console.log("\n=== 6. DOWNLOAD (audio/opus) ===");
await page.getByRole("tab", { name: "Audio" }).click();
await page.waitForTimeout(400);
await fmtSelect.selectOption({ label: "Opus · native" });
await page.waitForTimeout(400);
const dlBtn = page.getByRole("button", { name: /^Download · OPUS$/ });
check("button reflects format", await dlBtn.isVisible(), await dlBtn.innerText());
await dlBtn.click();
await page.waitForTimeout(1800);
check("success toast", (await page.locator("[data-sonner-toast]").count()) > 0);
check("job row in queue", (await bodyText()).includes("Big Buck Bunny"));

let phase = "";
let job = null;
for (let i = 0; i < 45; i++) {
  await page.waitForTimeout(2000);
  const jobs = await page.evaluate(async () => (await (await fetch("/api/jobs")).json()));
  if (!jobs.length) break;
  job = jobs[0];
  phase = job.phase;
  if (phase === "done" || phase === "error" || phase === "cancelled") break;
}
check("download completes", phase === "done", "phase=" + phase);
const t6 = await bodyText();
check("queue shows Done badge", /Done/.test(t6));
check("queue shows file path", /\.webm|\.opus|\.m4a|\.mp3/i.test(t6));
check("queue shows size", /MiB|KiB|MB/i.test(t6));
check("queue counts 1 finished", /0 active · 1 finished/.test(t6), t6.match(/\d+ active · \d+ finished/)?.[0] ?? "");

// ---------- 7. Playlist ----------
console.log("\n=== 7. PLAYLIST (streaming) ===");
await typeUrl(PLAYLIST);
// enumeration is network-bound; wait for real rows, not just the card
await page.waitForFunction(
  () => document.querySelectorAll('[role="row"]').length > 0,
  { timeout: 120000 },
).catch(() => {});
await page.waitForTimeout(2500);
const rows = await page.locator('[role="row"]').count();
check("playlist rows rendered", rows > 0, `${rows} rows`);
const t7 = await bodyText();
check("playlist entry count shown", /\d+ videos/.test(t7), t7.match(/\d+ videos/)?.[0] ?? "");
check("selection summary", /of \d+ selected|No videos selected/.test(t7), t7.match(/\d+ of \d+ selected/)?.[0] ?? "");
check("NOT stuck on loading more", !/loading more/i.test(t7));
check("thumbnail column present", (await page.locator('[role="row"] img').count()) > 0);

const checkboxes = page.locator('[role="row"] input[type="checkbox"]');
const cbCount = await checkboxes.count();
check("row checkboxes present", cbCount > 0, `${cbCount} checkboxes`);
const before = t7.match(/(\d+) of (\d+) selected/)?.[0] ?? "";
if (cbCount > 0) {
  await checkboxes.first().click();
  await page.waitForTimeout(800);
  const after = (await bodyText()).match(/(\d+) of (\d+) selected/)?.[0] ?? "";
  check("deselect updates count", before !== after, `${before} -> ${after}`);
  await checkboxes.first().click();
  await page.waitForTimeout(600);
}

// selection mode buttons
check("selection modes exist", /Single/.test(await bodyText()) && /Multiple/.test(await bodyText()));
await page.getByRole("button", { name: /^Clear$/ }).click();
await page.waitForTimeout(800);
check("clear selection works", /No videos selected/.test(await bodyText()));
const dlDisabled = await page.getByRole("button", { name: /Select videos|Download/ }).last().isDisabled().catch(() => null);
check("download disabled with empty selection", dlDisabled === true, String(dlDisabled));

// ---------- 8. Queue actions ----------
console.log("\n=== 8. QUEUE ACTIONS ===");
const clearBtn = page.locator('button[title="Clear finished"]');
check("clear-finished enabled", await clearBtn.isEnabled());
await clearBtn.click();
await page.waitForTimeout(1500);
check("queue emptied after clear", await page.getByText("Nothing queued yet.").isVisible());

// ---------- 9. Library ----------
console.log("\n=== 9. LIBRARY (HISTORY) ===");
await page.getByRole("button", { name: /Library/ }).click();
await page.waitForTimeout(2000);
const t9 = await bodyText();
check("history view entered", !(await urlInput().isVisible().catch(() => false)));
check("history row present", /Big Buck Bunny/.test(t9));
check("file size shown in history", /MiB|KiB|MB/i.test(t9));
const delBtns = page.locator('button[title="Remove"], button[title="Delete"]');
console.log("   (delete buttons found: " + (await delBtns.count()) + ")");

// ---------- 10. Settings ----------
console.log("\n=== 10. SETTINGS ===");
await page.locator('button[title="Settings"]').click();
await page.waitForTimeout(900);
check("settings dialog open", (await page.locator('[role="dialog"]').count()) === 1);
const dlg = await page.locator('[role="dialog"]').first().innerText();
check("binaries section", /BINARIES/i.test(dlg), dlg.slice(0, 60).replace(/\n/g, " "));
check("output dir field", /downloads/i.test(dlg));
await page.keyboard.press("Escape");
await page.waitForTimeout(600);
check("dialog closes on Escape", (await page.locator('[role="dialog"]').count()) === 0);

// ---------- 11. Command palette ----------
console.log("\n=== 11. COMMAND PALETTE ===");
await page.keyboard.press("Control+k");
await page.waitForTimeout(800);
check("palette opens", (await page.locator("[cmdk-root]").count()) === 1);
const items = await page.locator("[cmdk-item]").allInnerTexts();
check("6 actions listed", items.length === 6, items.join(" | "));
// run "Switch to Download" from the palette
await page.locator("[cmdk-item]").filter({ hasText: "Switch to Download" }).click();
await page.waitForTimeout(900);
check("palette action ran (switched view)", await urlInput().isVisible());
check("palette closed after action", (await page.locator("[cmdk-root]").count()) === 0);

// ---------- 12. Theme ----------
console.log("\n=== 12. THEME ===");
const themeBtn = page.locator('button[title="Toggle theme"]');
const cls0 = await page.evaluate(() => document.documentElement.className);
await themeBtn.click();
await page.waitForTimeout(600);
const cls1 = await page.evaluate(() => document.documentElement.className);
await themeBtn.click();
await page.waitForTimeout(600);
const cls2 = await page.evaluate(() => document.documentElement.className);
check("theme toggles + restores", cls0 !== cls1 && cls0 === cls2, `"${cls0}" -> "${cls1}" -> "${cls2}"`);

await page.screenshot({ path: "test-e2e-final.png", fullPage: false });

console.log("\n===== SUMMARY =====");
console.log(`passed: ${ok.length}   failed: ${fails.length}`);
if (fails.length) fails.forEach((f) => console.log("  FAILED: " + f));
const realErrors = errors.filter((e) => !/favicon/i.test(e));
console.log(`console errors: ${realErrors.length}`);
realErrors.slice(0, 15).forEach((e) => console.log("  - " + e.slice(0, 200)));
const realHttp = http4xx.filter((h) => !/favicon/i.test(h));
console.log(`http >=400: ${realHttp.length}`);
realHttp.slice(0, 15).forEach((h) => console.log("  - " + h));

await browser.close();
process.exit(fails.length || realErrors.length ? 1 : 0);
