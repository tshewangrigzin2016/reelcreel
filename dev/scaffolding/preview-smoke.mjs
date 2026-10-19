import { chromium } from "playwright-core";

const BASE = process.env.BASE ?? "http://localhost:8788";
const PLAYLIST = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ";
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  args: ["--no-proxy-server"],
});

const page = await browser.newPage({ viewport: { width: 720, height: 900 } });
page.on("console", (m) => {
  if (m.type() === "error") console.log("  [console.error]", m.text());
});
page.on("pageerror", (e) => console.log("  [pageerror]", e.message));

await page.goto(BASE, { waitUntil: "domcontentloaded" });

async function type(url) {
  await page.fill("input", "");
  await page.fill("input", url);
}

page.on("requestfailed", (r) => {
  if (r.url().includes("ytimg")) console.log("  [img failed]", r.url(), r.failure()?.errorText);
});

// 1. Playlist URL -> the preview strip appears with the first video's thumb.
const t0 = Date.now();
await type(PLAYLIST);
await page.waitForSelector("img[src*='i.ytimg.com']", { timeout: 30_000 });
console.log("strip painted after", Date.now() - t0, "ms");

const img = page.locator("img[src*='i.ytimg.com']").first();
for (let i = 0; i < 24; i++) {
  const ok = await img.evaluate((el) => el.complete && el.naturalWidth > 0).catch(() => false);
  if (ok) break;
  await page.waitForTimeout(500);
}
const caption = await page.locator("p", { hasText: /first video/i }).first().innerText();
const title = await page
  .locator("p", { hasText: /Never Gonna Give You Up/i })
  .first()
  .innerText()
  .catch(() => "(title not found)");
const src = await img.getAttribute("src");
const loaded = await img.evaluate((el) => el.complete && el.naturalWidth > 0);
console.log("playlist ->", { caption, title, src, thumbLoaded: loaded });
await page.screenshot({ path: "dev/scaffolding/preview-smoke.png", fullPage: false });

// 2. Plain video URL -> no strip at all.
await type(VIDEO);
await page.waitForTimeout(1500);
const stripCount = await page.locator("text=/first video/i").count();
console.log("video -> strip present:", stripCount > 0, "(expected false)");

// 3. Clearing the field removes it.
await type(PLAYLIST);
await page.waitForSelector("text=/first video/i", { timeout: 30_000 });
await type("");
await page.waitForTimeout(600);
console.log("cleared -> strip present:", (await page.locator("text=/first video/i").count()) > 0);

await browser.close();
console.log("smoke OK");
