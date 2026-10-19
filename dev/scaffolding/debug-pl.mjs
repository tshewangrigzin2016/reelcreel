import { chromium } from "playwright-core";

const PLAYLIST = "https://www.youtube.com/playlist?list=UUSMOQeBJ2RAnuFungnQOxLg";
const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });

page.on("response", async (r) => {
  if (r.status() >= 400) console.log(`HTTP ${r.status()}  ${r.url().slice(0, 160)}`);
});
page.on("requestfailed", (r) => {
  console.log(`REQFAIL ${r.url().slice(0, 160)}  ${r.failure()?.errorText}`);
});
page.on("console", (m) => {
  if (m.type() === "error") console.log("CONSOLE-ERR:", m.text().slice(0, 200));
});
page.on("pageerror", (e) => console.log("PAGEERROR:", e.message.slice(0, 300)));

await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await page.waitForSelector("#root > *");
await page.waitForTimeout(1500);

console.log("\n--- typing playlist URL ---");
await page.locator('input[placeholder="Paste YouTube URL"]').fill(PLAYLIST);

for (const t of [3, 8, 15, 25, 40]) {
  await page.waitForTimeout(t === 3 ? 3000 : 
    t === 8 ? 5000 : t === 15 ? 7000 : t === 25 ? 15000 : 15000);
  const snap = await page.evaluate(() => {
    const txt = document.body.innerText;
    return {
      loadingMore: /loading more/i.test(txt),
      loadingMeta: /Loading metadata/i.test(txt),
      videosMatch: txt.match(/\d+ videos/)?.[0] ?? null,
      noSelected: /No videos selected/.test(txt),
      countSelected: txt.match(/(\d+) of (\d+) selected/)?.[0] ?? null,
      checkboxes: document.querySelectorAll('button[role="checkbox"]').length,
      rows: document.querySelectorAll('[data-index]').length,
      tail: txt.slice(700, 1400).replace(/\n+/g, " | "),
    };
  });
  console.log(`t=${t}s`, JSON.stringify(snap));
}

await page.screenshot({ path: "debug-playlist.png", fullPage: false });
await browser.close();
