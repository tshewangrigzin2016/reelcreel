import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://localhost:5173";
const fails = [], ok = [];
const errors = [];
function check(n, c, d = "") {
  (c ? ok : fails).push(n + (d ? ` — ${d}` : ""));
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
}

const browser = await chromium.launch({
  executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

const bodyText = () => page.evaluate(() => document.body.innerText);
const history = () => page.evaluate(async () => (await (await fetch("/api/history")).json()));

await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#root > *");
await page.waitForTimeout(1000);

// Wipe history so the counts below are deterministic regardless of prior runs.
await page.evaluate(async () => { await fetch("/api/history", { method: "DELETE" }); });

// Seed two rows (history id == job id, so two jobs = two rows even on one URL).
console.log("=== seeding 2 downloads ===");
const before = await history();
await page.evaluate(async () => {
  for (const presetId of ["opus", "aac"]) {
    await fetch("/api/downloads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ",
        presetId,
        videoId: "aqz-KE-bpKQ",
        title: "Seeded History Item",
        options: { fragmentConcurrency: 4 },
      }),
    });
  }
});
let phases = [];
for (let i = 0; i < 90; i++) {
  await page.waitForTimeout(2000);
  const js = await page.evaluate(async () => (await (await fetch("/api/jobs")).json()));
  phases = js.map((j) => j.phase);
  if (phases.length >= 2 && phases.every((p) => ["done", "error"].includes(p))) break;
}
check("both seeds finished", phases.length >= 2 && phases.every((p) => p === "done"), phases.join(","));

console.log("\n=== HISTORY DELETE ===");
await page.getByRole("button", { name: /Library/ }).click();
await page.waitForTimeout(2000);
const hist = await history();
const n0 = hist.length;
check("history has rows", n0 >= 2, `${n0} rows (was ${before.length} before seeding)`);

const delBtns = page.locator('button[title="Remove from history"]');
const dn = await delBtns.count();
check("per-row delete buttons rendered", dn === n0, `${dn} buttons / ${n0} rows`);

const firstTitle = await page.locator("p.truncate").first().innerText().catch(() => "");
await delBtns.first().click();
await page.waitForTimeout(1800);
const hist2 = await history();
check("row deleted after click", hist2.length === n0 - 1, `${n0} -> ${hist2.length}`);
check(
  "deleted row gone from DOM",
  !!firstTitle && !(await bodyText()).includes(firstTitle),
  `removed "${firstTitle.slice(0, 40)}"`,
);
check("count label updated", new RegExp(`${hist2.length} downloaded`).test(await bodyText()));

// clear-all (no confirmation dialog expected)
console.log("\n=== CLEAR ALL ===");
const clearBtn = page.locator('button[title="Clear history"]');
check("clear-history button present", await clearBtn.isVisible());
check("clear-history button enabled", await clearBtn.isEnabled());
if (await clearBtn.isEnabled()) {
  await clearBtn.click();
  await page.waitForTimeout(1800);
  const hist3 = await history();
  check("history cleared", hist3.length === 0, `${hist3.length} rows`);
  check("empty state shown", /Nothing downloaded yet/.test(await bodyText()));
}

console.log("\n===== SUMMARY =====");
console.log(`passed: ${ok.length}   failed: ${fails.length}`);
fails.forEach((f) => console.log("  FAILED: " + f));
const re = errors.filter((e) => !/favicon/i.test(e));
console.log(`console errors: ${re.length}`);
re.slice(0, 10).forEach((e) => console.log("  - " + e.slice(0, 200)));
await browser.close();
process.exit(fails.length || re.length ? 1 : 0);
