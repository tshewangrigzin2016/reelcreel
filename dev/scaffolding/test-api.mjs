// Covers the API surface the browser tests never touch: health, presets,
// defaults, downloaded-ids, jobs/clear, open-folder, binary test/restore, and
// the 4xx error paths.
const BASE = process.argv[2] || "http://localhost:8787";
const fails = [], ok = [];
function check(n, c, d = "") {
  (c ? ok : fails).push(n + (d ? ` — ${d}` : ""));
  console.log(`${c ? "PASS" : "FAIL"}  ${n}${d ? ` — ${d}` : ""}`);
}
const j = async (p, init) => {
  const r = await fetch(BASE + p, init);
  const t = await r.text();
  let body; try { body = JSON.parse(t); } catch { body = t; }
  return { status: r.status, body };
};

console.log("=== /api/health ===");
const health = await j("/api/health");
check("health 200", health.status === 200, "status=" + health.status);
check("health.ok", health.body?.ok === true);
check("health ytdlp resolved", !!health.body?.ytdlp?.path, health.body?.ytdlp?.version);
check("health ffmpeg resolved", !!health.body?.ffmpeg?.path, health.body?.ffmpeg?.version);
console.log("  ytdlp:", JSON.stringify(health.body?.ytdlp));
console.log("  ffmpeg:", JSON.stringify(health.body?.ffmpeg));

console.log("\n=== /api/presets ===");
const presets = await j("/api/presets");
check("presets 200", presets.status === 200);
check("presets is array", Array.isArray(presets.body), `${presets.body?.length ?? 0} presets`);
const groups = new Set((presets.body ?? []).map((p) => p.group));
check("presets have video+audio groups", groups.has("video") && groups.has("audio"), [...groups].join(","));
check("preset ids unique", new Set((presets.body ?? []).map((p) => p.id)).size === presets.body?.length);
check(
  "every preset has id/label/ext",
  (presets.body ?? []).every((p) => p.id && p.label && p.ext),
);

console.log("\n=== /api/defaults ===");
const def = await j("/api/defaults");
check("defaults 200", def.status === 200);
check("defaults.video set", !!def.body?.video);
check("defaults.audio set", !!def.body?.audio);

console.log("\n=== /api/downloaded + /api/history/ids ===");
const dl = await j("/api/downloaded");
const hids = await j("/api/history/ids");
check("downloaded 200 + array", dl.status === 200 && Array.isArray(dl.body), `${dl.body?.length ?? 0} ids`);
check("history/ids alias matches", JSON.stringify(dl.body) === JSON.stringify(hids.body));

console.log("\n=== /api/jobs/clear ===");
await j("/api/downloads", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ", presetId: "opus", videoId: "aqz-KE-bpKQ", title: "clear-test" }) });
await new Promise((r) => setTimeout(r, 1000));
await j("/api/jobs", {}); // warm
const clr = await j("/api/jobs/clear", { method: "POST" });
check("jobs/clear 200 ok", clr.status === 200 && clr.body?.ok === true);

console.log("\n=== error paths ===");
const noUrl = await j("/api/probe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
check("probe w/o url -> 400", noUrl.status === 400, "status=" + noUrl.status);
const noName = await j("/api/settings/test-binary", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
check("test-binary w/o name -> 400", noName.status === 400, "status=" + noName.status);
const badFolder = await j("/api/open-folder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "C:\\definitely\\not\\a\\real\\folder\\xyz" }) });
check("open-folder missing dir -> 400", badFolder.status === 400, "status=" + badFolder.status);
const retry404 = await j("/api/jobs/does-not-exist/retry", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: "https://www.youtube.com/watch?v=aqz-KE-bpKQ" }) });
check("retry unknown job -> 404", retry404.status === 404, "status=" + retry404.status);

console.log("\n=== /api/settings/test-binary (override must NOT leak) ===");
const before = await j("/api/settings");
check("auto-detect test (yt-dlp)", (await j("/api/settings/test-binary", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "yt-dlp" }) })).body?.ok === true);
check("auto-detect test (ffmpeg)", (await j("/api/settings/test-binary", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "ffmpeg" }) })).body?.ok === true);

const bogus = await j("/api/settings/test-binary", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "yt-dlp", path: "C:\\Windows\\System32\\notepad.exe" }) });
check("bogus path -> ok:false", bogus.body?.ok === false, JSON.stringify(bogus.body).slice(0, 90));

// The regression: after a bogus test the live resolution must be unchanged.
const healthAfter = await j("/api/health");
check(
  "ytdlp resolution unchanged after bogus test",
  healthAfter.body?.ytdlp?.path === health.body?.ytdlp?.path,
  `${health.body?.ytdlp?.path} -> ${healthAfter.body?.ytdlp?.path}`,
);
check(
  "ffmpeg resolution unchanged after bogus test",
  healthAfter.body?.ffmpeg?.path === health.body?.ffmpeg?.path,
);
const after = await j("/api/settings");
check("saved settings untouched", JSON.stringify(after.body) === JSON.stringify(before.body));

console.log("\n=== /api/open-folder (valid dir) ===");
const openOk = await j("/api/open-folder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "C:\\Users\\Tshewang Rinzin\\Downloads\\yt-downloader\\downloads" }) });
check("open-folder 200 ok", openOk.status === 200 && openOk.body?.ok === true, JSON.stringify(openOk.body).slice(0, 80));

console.log("\n===== SUMMARY =====");
console.log(`passed: ${ok.length}   failed: ${fails.length}`);
fails.forEach((f) => console.log("  FAILED: " + f));
process.exit(fails.length ? 1 : 0);
