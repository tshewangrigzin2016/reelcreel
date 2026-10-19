import { chromium } from "playwright-core";

const EXE = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const URL = "http://localhost:5173";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const browser = await chromium.launch({ executablePath: EXE, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

// --- mock the YouTube probe: this sandbox has no network access to YouTube ---
const THUMB = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
const ENTRY = (i) => ({
  id: `vid${String(i).padStart(3, "0")}`,
  title: `${["Alpha", "Bravo", "Charlie", "Delta", "Echo"][i - 1]} video`,
  index: i,
  duration: 100 * i,
  viewCount: 1000 * i,
  thumbnail: THUMB,
  url: `https://www.youtube.com/watch?v=vid${String(i).padStart(3, "0")}`,
  isLive: false,
});
const ENTRIES = [1, 2, 3, 4, 5].map(ENTRY);

const sse = (lines) => lines.map((l) => (l.event ? `event: ${l.event}\n` : "") + `data: ${l.data}\n\n`).join("");

await page.route("**/api/probe/stream*", (route) =>
  route.fulfill({
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    body: sse([
      { data: JSON.stringify({ type: "open" }) },
      {
        event: "meta",
        data: JSON.stringify({
          id: "PLfake",
          title: "Fake Playlist",
          uploader: "Test Uploader",
          webpageUrl: "https://www.youtube.com/playlist?list=PLfake",
          entryCount: ENTRIES.length,
          radio: false,
        }),
      },
      ...ENTRIES.map((e) => ({ event: "entry", data: JSON.stringify(e) })),
      { event: "end", data: JSON.stringify({ code: 0, error: null }) },
    ]),
  }),
);
await page.route("**/api/probe", (route) => {
  const url = route.request().postData() ?? "";
  const body = url.includes("playlist")
    ? {
        kind: "playlist",
        playlist: { id: "PLfake", title: "Fake Playlist", truncated: false },
        entries: ENTRIES,
      }
    : {
        kind: "video",
        video: {
          id: "vid001",
          title: "Fake Video",
          uploader: "Test Uploader",
          thumbnail: THUMB,
          duration: 240,
          viewCount: 1234,
          webpageUrl: "https://www.youtube.com/watch?v=vid001",
          isLive: false,
        },
        entries: [],
      };
  return route.fulfill({ status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
});

const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(URL, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);

// =============================================================== 1. no natives
check("no native <select> anywhere in the DOM", (await page.locator("select").count()) === 0);

// =============================================================== 2. settings
await page.getByTitle("Settings").click();
await page.waitForTimeout(600);

const trigger = page.getByRole("combobox", { name: "Default fragments" });
check("accessible name comes from <label for>", (await trigger.count()) === 1);

const start = (await trigger.innerText()).trim();
const target = ["1", "4", "8", "16"].find((v) => v !== start);
console.log(`      initial value "${start}" -> picking "${target}"`);

await trigger.click();
await page.waitForTimeout(400);
check("clicking the trigger opens a listbox", await page.getByRole("listbox").isVisible());

const opts = await page.getByRole("option").allInnerTexts();
check("all four options render", JSON.stringify(opts) === '["1","4","8","16"]', JSON.stringify(opts));

// Radix hides everything outside the open content from the a11y tree, so the
// trigger is only reachable by role while closed — use its id while open.
check(
  "aria-expanded flips to true when open",
  (await page.locator("#default-fragments").getAttribute("aria-expanded")) === "true",
);

await page.getByRole("option", { name: target, exact: true }).click();
await page.waitForTimeout(400);
check(
  "onValueChange updates the displayed value",
  (await trigger.innerText()).trim() === target,
  `"${start}" -> "${target}"`,
);
check("listbox closes after selection", (await page.getByRole("listbox").count()) === 0);

// =============================================================== 3. keyboard
await trigger.focus();
await page.keyboard.press("Enter");
await page.waitForTimeout(500);
check("Enter opens the dropdown", await page.getByRole("listbox").isVisible());

// Radix moves focus inside a setTimeout, so give the highlight a beat to land.
await page.keyboard.press("ArrowDown");
await page.waitForTimeout(300);
const highlighted = await page.locator('[role="option"][data-highlighted]').innerText();
check("ArrowDown moves the highlight", highlighted !== target, `${target} -> ${highlighted}`);

await page.keyboard.press("Enter");
await page.waitForTimeout(400);
const afterKeys = (await trigger.innerText()).trim();
check("Enter commits the highlighted option", afterKeys === highlighted, `now "${afterKeys}"`);

await trigger.focus();
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);
check("Escape closes the dropdown", (await page.getByRole("listbox").count()) === 0);
check("Escape did not bubble up and close the dialog", (await page.getByRole("dialog").count()) === 1);

// =============================================================== 4. label click
await page.getByText("Default fragments", { exact: true }).click();
await page.waitForTimeout(500);
check("clicking the <label> opens the select", (await page.getByRole("listbox").count()) === 1);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

// =============================================================== 5. persistence
await trigger.click();
await page.waitForTimeout(300);
await page.getByRole("option", { name: "4", exact: true }).click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: "Save" }).click();
await page.waitForTimeout(1200);

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await page.getByTitle("Settings").click();
await page.waitForTimeout(600);
const persisted = (await page.getByRole("combobox", { name: "Default fragments" }).innerText()).trim();
check("value round-trips through Save + reload", persisted === "4", `got "${persisted}"`);
await page.keyboard.press("Escape");
await page.waitForTimeout(500);

// =============================================================== 6. format picker
await page.locator("input").first().fill("https://www.youtube.com/watch?v=vid001");
await page.waitForSelector("#preset-video", { timeout: 20000 });

const fmt = page.getByRole("combobox", { name: "Format" });
check("format select renders", (await fmt.count()) === 1);
const fmtStart = (await fmt.innerText()).trim();
check("format select shows a preset", fmtStart.length > 0, `"${fmtStart}"`);

await fmt.click();
await page.waitForTimeout(400);
const presetCount = await page.getByRole("option").count();
check("presets listed for the video group", presetCount > 1, `${presetCount} options`);

const firstPreset = (await page.getByRole("option").first().innerText()).trim();
await page.getByRole("option").first().click();
await page.waitForTimeout(400);
check("picking a preset updates the trigger", (await fmt.innerText()).trim() === firstPreset, `now "${firstPreset}"`);

// Fragments select in the same panel.
const frags = page.getByRole("combobox", { name: "Fragments" });
check("fragments select renders", (await frags.count()) === 1);
await frags.click();
await page.waitForTimeout(400);
await page.getByRole("option", { name: "16", exact: true }).click();
await page.waitForTimeout(400);
check("fragments select updates", (await frags.innerText()).trim() === "16");

// The Audio tab swaps in the other preset list; both must stay mounted-safe.
await page.getByRole("tab", { name: "Audio" }).click();
await page.waitForTimeout(500);
check("audio tab shows its own format select", (await page.locator("#preset-audio").count()) === 1);
check("video tab's select is unmounted", (await page.locator("#preset-video").count()) === 0);
await page.getByRole("tab", { name: "Video" }).click();
await page.waitForTimeout(400);
check("switching back remounts the video format select", (await page.locator("#preset-video").count()) === 1);
await page.screenshot({ path: "dev/scaffolding/select-format.png" });

// =============================================================== 7. playlist sort
await page.locator("input").first().fill("https://www.youtube.com/playlist?list=PLfake");
await page.waitForSelector('[role="combobox"][aria-label="Sort playlist by"]', { timeout: 20000 });

const sort = page.getByRole("combobox", { name: "Sort playlist by" });
check("playlist sort select renders", (await sort.count()) === 1);
check("kept its w-auto sizing", ((await sort.getAttribute("class")) ?? "").includes("w-auto"));
check("shows the default sort label", (await sort.innerText()).trim() === "Playlist order");

await sort.click();
await page.waitForTimeout(400);
const sortOpts = await page.getByRole("option").allInnerTexts();
check(
  "sort options intact",
  JSON.stringify(sortOpts) === '["Playlist order","Title","Duration","Views"]',
  JSON.stringify(sortOpts),
);
await page.getByRole("option", { name: "Title" }).click();
await page.waitForTimeout(600);
check("choosing a sort key updates the trigger", (await sort.innerText()).trim() === "Title");

const firstRow = await page.locator("table, [role='row']").first().innerText().catch(() => "");
check("sorting actually reorders the list", firstRow.includes("Alpha"), firstRow.split("\n")[0]);
await page.screenshot({ path: "dev/scaffolding/select-playlist.png" });

// =============================================================== 7. errors
const real = errors.filter((e) => !/502|Failed to load resource|ERR_/i.test(e));
check("no console or page errors", real.length === 0, real.slice(0, 2).join(" | "));

await browser.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
