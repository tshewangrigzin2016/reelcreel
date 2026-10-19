// Every download so far used the instant Opus remux. These exercise the two
// genuinely different code paths: an ffmpeg re-encode (postprocessor phase,
// different progress parsing) and a DASH video+audio merge.
const BASE = process.argv[2] || "http://localhost:8787";
const VIDEO = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
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

async function run(presetId, expectExt, label) {
  console.log(`\n=== ${label} (${presetId}) ===`);
  const post = await j("/api/downloads", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: VIDEO, presetId, videoId: "aqz-KE-bpKQ", title: `fmt-${presetId}` }),
  });
  check(`${presetId}: accepted`, post.status === 200, "status=" + post.status);
  const id = post.body?.ids?.[0];
  check(`${presetId}: got job id`, !!id, String(id).slice(0, 12));

  let job = null;
  const seenPhases = new Set();
  for (let i = 0; i < 150; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const list = await j("/api/jobs");
    job = (list.body ?? []).find((x) => x.id === id) ?? null;
    if (job) seenPhases.add(job.phase);
    if (!job || ["done", "error", "cancelled"].includes(job.phase)) break;
  }
  check(`${presetId}: reached done`, job?.phase === "done", `phase=${job?.phase} err=${job?.error ?? ""}`);
  check(`${presetId}: phases seen`, [...seenPhases].join(">"), [...seenPhases].join(" > "));
  check(`${presetId}: file path set`, !!job?.filePath, String(job?.filePath).slice(-60));
  if (job?.filePath) {
    check(`${presetId}: extension .${expectExt}`, String(job.filePath).toLowerCase().endsWith("." + expectExt));
    // JobState carries `size` (a display string), not `sizeBytes` (that's the
    // history row). It must be the real on-disk size once done, not the
    // mid-transfer estimate yt-dlp reported.
    check(`${presetId}: job size populated`, !!job.size && /\d/.test(job.size), `size="${job.size}"`);
    const histRow = (await j("/api/history")).body?.find((h) => h.id === id);
    check(`${presetId}: history sizeBytes > 0`, (histRow?.sizeBytes ?? 0) > 0, `${histRow?.sizeBytes} bytes`);
    const exists = await j("/api/open-folder", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: job.filePath.replace(/\\[^\\]+$/, "") }) });
    check(`${presetId}: output dir opens`, exists.status === 200);
  }
  return job;
}

await run("mp3-320", "mp3", "FFmpeg re-encode");
await run("mp4-h264", "mp4", "DASH merge / remux");

// History should now carry both, with correct extensions.
const hist = await j("/api/history");
const exts = (hist.body ?? []).map((h) => h.ext).filter(Boolean);
check("history has mp3 entry", exts.includes("mp3"), exts.join(","));
check("history has mp4 entry", exts.includes("mp4"), exts.join(","));

console.log("\n===== SUMMARY =====");
console.log(`passed: ${ok.length}   failed: ${fails.length}`);
fails.forEach((f) => console.log("  FAILED: " + f));
process.exit(fails.length ? 1 : 0);
