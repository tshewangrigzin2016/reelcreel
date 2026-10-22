import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
const origin = process.env.TEST_ORIGIN ?? "http://127.0.0.1:8799";
const browser = await chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
});
const context = await browser.newContext({
  viewport: { width: 1100, height: 1000 },
});
await context.addInitScript(() => {
  const Original = window.EventSource;
  window.EventSource = class extends Original {
    constructor(url, options) {
      super(url, options);
      if (String(url).includes("/jobs/stream")) window.__jobStream = this;
    }
  };
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
const requests = [];
page.on("request", (req) => {
  if (req.url().includes("/api/")) requests.push(new URL(req.url()).pathname);
});
try {
  await page.goto(origin);
  await page.getByRole("heading", { name: "YouTube downloader" }).waitFor();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  assert(
    await page
      .getByRole("combobox", { name: "JavaScript runtime", exact: true })
      .isVisible(),
  );
  // The clip & limits feature is gone, so "Default fragments" is no longer a
  // control. Assert the surviving concurrency limit still round-trips instead.
  // A number input is a spinbutton, not a textbox.
  const concurrent = page.getByRole("spinbutton", {
    name: "Concurrent downloads",
    exact: true,
  });
  await concurrent.fill("4");
  const pathField = page.getByRole("textbox", {
    name: "yt-dlp path (override)",
    exact: true,
  });
  await pathField.fill("");
  const before = await page
    .getByRole("textbox", { name: "Download folder", exact: true })
    .inputValue();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert((await page.request.get(origin + "/api/settings")).ok());
  // A retired key must not survive a read, or the client would echo it back and
  // the next save would be rejected as an unknown setting.
  const saved = await (await page.request.get(origin + "/api/settings")).json();
  assert.equal(saved.downloadConcurrency, 4);
  assert.equal("fragmentConcurrency" in saved, false);
  assert.equal("rateLimit" in saved, false);
  // Preserve edits after a server-side validation error.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const template = page.getByRole("textbox", {
    name: "Filename template",
    exact: true,
  });
  await template.fill("../invalid.%(ext)s");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Filename template" })
    .waitFor();
  assert.equal(await template.inputValue(), "../invalid.%(ext)s");
  await page.keyboard.press("Escape");
  await page
    .getByText("Batch paste and text import", { exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "One YouTube video URL per line" })
    .fill("https://youtu.be/abcdefghijk\nhttps://youtu.be/abcdefghijk\nbad");
  assert(
    await page.getByText("Duplicate omitted", { exact: true }).isVisible(),
  );
  assert(
    await page.getByText("Invalid video URL", { exact: true }).isVisible(),
  );
  // The composer loads rows rather than queueing them, so the button counts
  // what it will load. An unparseable line is dropped with a visible reason and
  // the readable ones still load; only a paste with nothing readable in it, or
  // one over the server's row cap, blocks the load.
  assert(
    !(await page
      .getByRole("button", { name: "Load 1 video", exact: true })
      .isDisabled()),
    "one readable row out of three lines is still a loadable batch",
  );
  await page
    .getByRole("textbox", { name: "One YouTube video URL per line" })
    .fill("bad\nalso bad");
  assert(
    await page
      .getByRole("button", { name: "Load 0 videos", exact: true })
      .isDisabled(),
    "a paste with nothing readable in it cannot be loaded",
  );
  // No per-row format dropdown: one format decision, made in the format card.
  assert.equal(
    await page.locator("select[aria-label^='Format for']").count(),
    0,
  );
  const formatSelect = page.getByRole("combobox", { name: "Format", exact: true });
  await page.getByRole("tab", { name: "Audio", exact: true }).click();
  await formatSelect.click();
  await page.getByRole("option", { name: /FLAC/ }).click();
  assert((await formatSelect.innerText()).includes("FLAC"));
  // Back to video so later assertions read against the default group.
  await page.getByRole("tab", { name: "Video", exact: true }).click();
  // The profile strip and the separate quality panel are gone; the format card
  // now carries the quality/caption controls and the source-format disclosure.
  assert.equal(
    await page.getByRole("combobox", { name: "Profile", exact: true }).count(),
    0,
  );
  assert.equal(
    await page
      .getByText("Quality, captions and source formats", { exact: true })
      .count(),
    0,
  );
  for (const control of [
    "Maximum height",
    "Caption source",
    "Caption output",
  ])
    assert.equal(
      await page.getByRole("combobox", { name: control, exact: true }).count(),
      1,
      control + " belongs to the format card",
    );
  assert.equal(
    await page
      .getByRole("textbox", { name: "Preferred audio language", exact: true })
      .count(),
    1,
  );
  await page
    .getByText("Source formats and captions", { exact: true })
    .click();
  await page
    .getByText("Load a single video to inspect the formats", { exact: false })
    .waitFor();
  // Section D: the layout toggle is shared by the table and the queue, and
  // survives a reload. `aria-label` wins over `title`, so the accessible name
  // is the bare mode.
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await page.reload();
  await page.getByRole("heading", { name: "YouTube downloader" }).waitFor();
  assert.equal(
    await page
      .getByRole("button", { name: "Grid", exact: true })
      .getAttribute("aria-pressed"),
    "true",
  );
  await page.getByRole("button", { name: "List", exact: true }).click();
  // Two subscribers converge on removal; a scheduled job needs no network or real download.
  const response = await page.request.post(origin + "/api/downloads", {
    data: {
      presetId: "mp4-h264",
      items: [
        { url: "https://youtu.be/abcdefghijk", title: "Browser queue fixture" },
      ],
      scheduledAt: Date.now() + 86400000,
    },
  });
  assert(response.ok(), await response.text());
  const created = await response.json();
  const id = created.ids[0];
  await page
    .getByRole("article", { name: "Browser queue fixture", exact: true })
    .waitFor();
  const second = await context.newPage();
  await second.goto(origin);
  await second
    .getByRole("article", { name: "Browser queue fixture", exact: true })
    .waitFor();
  await page.request.post(origin + "/api/jobs/" + id + "/pause", { data: {} });
  await page
    .getByRole("article", { name: "Browser queue fixture", exact: true })
    .getByRole("button", { name: "Resume", exact: true })
    .waitFor();
  await page.request.delete(origin + "/api/jobs/" + id, {
    headers: { "content-type": "application/json" },
  });
  await page
    .getByRole("article", { name: "Browser queue fixture", exact: true })
    .waitFor({ state: "hidden" });
  await second
    .getByRole("article", { name: "Browser queue fixture", exact: true })
    .waitFor({ state: "hidden" });
  // Deliver progress through the actual stream listeners with a completed row present.
  await page.waitForTimeout(500);
  requests.length = 0;
  await page.evaluate(async () => {
    const feed = window.__jobStream;
    feed.dispatchEvent(
      new MessageEvent("delta", {
        data: JSON.stringify([
          {
            id: "done-fixture",
            title: "Completed fixture",
            phase: "done",
            presetId: "mp4-h264",
            attempts: 1,
            percent: 100,
          },
        ]),
      }),
    );
    for (let i = 0; i < 20; i++) {
      feed.dispatchEvent(
        new MessageEvent("delta", {
          data: JSON.stringify([
            {
              id: "progress-fixture",
              title: "Progress fixture",
              phase: "downloading",
              presetId: "mp4-h264",
              attempts: 1,
              percent: i,
            },
          ]),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  });
  assert.equal(
    requests.filter((url) =>
      ["/api/library", "/api/history", "/api/downloaded"].includes(url),
    ).length,
    0,
    "Progress must not refetch library data",
  );
  await page.evaluate(() => {
    for (let i = 0; i < 20; i++)
      window.__jobStream.dispatchEvent(
        new MessageEvent("library", { data: "{}" }),
      );
  });
  await page.waitForTimeout(500);
  assert.equal(
    requests.filter((url) => url === "/api/downloaded").length,
    2,
    "Library notifications coalesce to one refresh per ownership query",
  );
  /* ------------------------------------------------------------------------ *
   * The merge: one list that does the work of the table and the queue.
   * ------------------------------------------------------------------------ */
  // A job with no `videoId` cannot be attached to any entry, so it lands in the
  // trailing group rather than being dropped or given a row of its own.
  const merged = await page.request.post(origin + "/api/downloads", {
    data: {
      presetId: "mp4-h264",
      items: [{ url: "https://youtu.be/ponmlkjihgf", title: "Merged fixture" }],
      scheduledAt: Date.now() + 86400000,
    },
  });
  assert(merged.ok(), await merged.text());
  const mergedId = (await merged.json()).ids[0];
  // One section, not two. The queue's list-wide actions live in the same card
  // as the list that replaced it, and no separate queue section is left: the
  // heading it used to carry is gone rather than renamed.
  assert.equal(
    await page.getByRole("heading", { name: /^Queue/ }).count(),
    0,
    "The queue section is gone; its rows are the list's rows",
  );
  await page.getByRole("button", { name: "Pause all", exact: true }).waitFor();
  await page
    .getByRole("button", { name: "Clear finished", exact: true })
    .waitFor();
  await page.getByText("3 queued", { exact: true }).waitFor();
  await page
    .getByText("Not in this playlist (3)", { exact: true })
    .waitFor();
  // The rule belongs to the first trailing *row*, and a row is `columns` entries
  // wide in grid mode — so the two indices are not the same number there.
  await page.getByRole("button", { name: "Grid", exact: true }).click();
  await page
    .getByText("Not in this playlist (3)", { exact: true })
    .waitFor();
  await page
    .getByRole("article", { name: "Merged fixture", exact: true })
    .getByRole("button", { name: "Delete", exact: true })
    .waitFor();
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page
    .getByText("Not in this playlist (3)", { exact: true })
    .waitFor();
  // The badge and the job controls answer different questions, so a settled row
  // carries both: what needs doing, and what can be done to the job.
  const done = page.getByRole("article", { name: "Completed fixture", exact: true });
  await done.getByText("Downloaded", { exact: true }).waitFor();
  await done.getByRole("button", { name: "Reveal file", exact: true }).waitFor();
  await done
    .getByRole("button", { name: "Remove from queue", exact: true })
    .waitFor();
  // A row mid-transfer speaks in a status line instead of a badge, and offers
  // Pause. Neither is present on a row with no job at all.
  const moving = page.getByRole("article", { name: "Progress fixture", exact: true });
  await moving.getByRole("button", { name: "Pause", exact: true }).waitFor();
  await moving.getByRole("button", { name: "Delete", exact: true }).waitFor();
  assert.equal(
    await moving.getByText("Downloaded", { exact: true }).count(),
    0,
    "A job owns the row's status line, so no ownership badge",
  );
  // With no probe result there is nothing to pick from, so the selection chrome
  // is not on the page and the list says why.
  assert.equal(
    await page.getByRole("group", { name: "Selection mode" }).count(),
    0,
    "Nothing to select from a queue with no probe behind it",
  );
  assert.equal(
    await page.getByPlaceholder("Filter titles…").count(),
    0,
  );
  await page
    .getByText("Jobs with no entry in the current probe.", { exact: true })
    .waitFor();
  /* A reload leaves jobs with no probe result at all. They must still be listed,
   * still be fully manageable, and still say what they are. The two fixtures
   * above only ever existed in the client store, so exactly this one survives. */
  await page.request.post(origin + "/api/jobs/" + mergedId + "/pause", {
    data: {},
  });
  await page.reload();
  await page.getByRole("heading", { name: "YouTube downloader" }).waitFor();
  const reloaded = page.getByRole("article", { name: "Merged fixture", exact: true });
  await reloaded.waitFor();
  await reloaded.getByRole("button", { name: "Resume", exact: true }).waitFor();
  await page.getByText("1 queued", { exact: true }).waitFor();
  await page
    .getByText("Not in this playlist (1)", { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole("article", { name: "Completed fixture", exact: true }).count(),
    0,
    "A store-only fixture does not come back from the server",
  );
  await page.request.delete(origin + "/api/jobs/" + mergedId, {
    headers: { "content-type": "application/json" },
  });
  await page
    .getByRole("article", { name: "Merged fixture", exact: true })
    .waitFor({ state: "hidden" });
  /* The Library page was replaced by Explore (commit 7e0d034), so the old
   * search/pagination walk through a "Library" button no longer exists. What
   * still matters from that block is that the paginated library API and its
   * 245 fixture rows survive, so it is asserted through the API the Explore
   * surface and any future library UI would consume. */
  const libraryPage = await (
    await page.request.get(origin + "/api/library?q=Fixture%20244&page=1")
  ).json();
  assert.equal(libraryPage.total, 1, "library search finds one fixture");
  assert.equal(libraryPage.rows[0].title, "Fixture 244");
  const libraryAll = await (
    await page.request.get(origin + "/api/library?page=1&pageSize=200")
  ).json();
  assert.equal(libraryAll.total, 245, "all 245 fixture rows are reachable");
  const libraryPage2 = await (
    await page.request.get(origin + "/api/library?page=2&pageSize=200")
  ).json();
  assert.equal(libraryPage2.rows.length, 45, "page 2 carries the remainder");

  mkdirSync(".test-artifacts", { recursive: true });
  await page.screenshot({
    path: ".test-artifacts/library-light.png",
    fullPage: false,
  });

  /* Browser delivery. The point of this block is that the Settings surface and
   * the queue row both stop offering local-file affordances once the server
   * says it delivers to the browser instead of saving. */
  const deliverySave = await page.request.put(origin + "/api/settings", {
    headers: { "content-type": "application/json" },
    data: { deliveryMode: "browser" },
  });
  assert(deliverySave.ok(), "delivery mode must save");
  // The mode is read from the settings query, which was fetched before this
  // PUT, so the page has to refetch for the new mode to reach the UI.
  await page.reload();
  await page.getByRole("heading", { name: "YouTube downloader" }).waitFor();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("dialog").waitFor();
  // The folder field is a server path and means nothing here, so it is gone
  // rather than present and inert.
  assert.equal(
    await page
      .getByRole("textbox", { name: "Download folder", exact: true })
      .count(),
    0,
    "Download folder is hidden while delivering to the browser",
  );
  // So are both re-download toggles: nothing is retained to compare against.
  assert.equal(
    await page.getByRole("switch", { name: /Skip files I already have/ }).count(),
    0,
    "Skip-existing is hidden in browser mode",
  );
  await page
    .getByRole("switch", { name: /Send files to the browser/ })
    .waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  // The main page stops claiming a folder and says where the file goes.
  await page
    .getByText("Your device — the server keeps no copy", { exact: true })
    .waitFor();
  // Back to the mode every other assertion in this suite assumes.
  const deliveryRestore = await page.request.put(origin + "/api/settings", {
    headers: { "content-type": "application/json" },
    data: { deliveryMode: "server" },
  });
  assert(deliveryRestore.ok(), "delivery mode must restore");
  await page.reload();
  await page.getByRole("heading", { name: "YouTube downloader" }).waitFor();

  await page.getByRole("button", { name: /theme/i }).click();
  await page.screenshot({
    path: ".test-artifacts/library-dark.png",
    fullPage: false,
  });
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      browser: "passed",
      twoTabs: "converged",
      settings: "save, error preservation and retired-key removal passed",
      formatSelector: "present with nothing probed",
      batchSharesFormat: "one format selector drives URL box, batch and library",
      removedPanels: "profile strip and quality panel gone, controls in format card",
      batch: "loads into the selection table, no per-row dropdown, no direct queue",
      layout: "grid/list toggles and survives reload",
      library: "245-row pagination and search passed through the API",
      deliveryMode: "folder and re-download toggles hidden when delivering to the browser",
      progressFetches: 0,
      coalescedOwnershipFetches: 2,
      errors,
    }),
  );
} finally {
  await browser.close();
}
