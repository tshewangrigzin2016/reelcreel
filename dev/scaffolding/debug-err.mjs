import { chromium } from "playwright-core";

const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage();

page.on("response", async (r) => {
  if (r.url().includes("/api/probe")) {
    let body = "";
    try { body = (await r.text()).slice(0, 200); } catch {}
    console.log(`  -> /api/probe  status=${r.status()}  body=${body}`);
  }
});

await page.goto("http://localhost:5173", { waitUntil: "domcontentloaded" });
await page.waitForSelector("#root > *");
await page.waitForTimeout(1000);

console.log("--- typing invalid URL ---");
const input = page.locator('input[placeholder="Paste YouTube URL"]');
await input.fill("");
await input.type("https://www.youtube.com/watch?v=notarealvideo1", { delay: 3 });

for (const s of [2, 5, 8, 12, 18, 25]) {
  await page.waitForTimeout(s === 2 ? 2000 : 3000);
  const snap = await page.evaluate(() => {
    const t = document.body.innerText;
    return {
      loading: /Loading metadata/i.test(t),
      errLine: t.match(/.*(unavailable|could not|not exist|private|Video unavailable).*/i)?.[0]?.slice(0, 100) ?? null,
      hasCard: !!document.querySelector(".border-destructive\\/40"),
    };
  });
  console.log(`t=${s}s`, JSON.stringify(snap));
}

console.log("\n--- final body text ---");
console.log((await page.evaluate(() => document.body.innerText)).slice(0, 1200));
await browser.close();
