/**
 * End-to-end check of the skip/convert engine against real downloaded files.
 * Hits the running API only, so what is verified is the deployed path.
 */
const BASE = "http://127.0.0.1:8787";

const history = (await fetch(`${BASE}/api/history`).then((r) => r.json())) as Array<{
  id: string;
  videoId: string;
  title: string;
  url?: string;
  presetId: string;
  filePath?: string;
  ext?: string;
  requestKey?: string;
  source?: Record<string, unknown>;
  file?: Record<string, unknown>;
  playlist?: Record<string, unknown>;
}>;

console.log(`history rows: ${history.length}`);
const withUrl = history.filter((r) => r.url);
const withSource = history.filter((r) => r.source);
const withFile = history.filter((r) => r.file);
const withPlaylist = history.filter((r) => r.playlist);
console.log(`  with url:      ${withUrl.length}`);
console.log(`  with source:   ${withSource.length}`);
console.log(`  with file fp:  ${withFile.length}`);
console.log(`  with playlist: ${withPlaylist.length}`);

const subject = withSource[0];
if (!subject) {
  console.log("NO SUITABLE ROW");
  process.exit(0);
}

// Rows recorded before the url column existed have no stored link, but the
// video id is enough to rebuild it -- the same fallback syncLibrary uses.
const url = subject.url ?? `https://www.youtube.com/watch?v=${subject.videoId}`;

console.log(`\nsubject: ${subject.title}`);
console.log(`  videoId=${subject.videoId} preset=${subject.presetId} ext=${subject.ext}`);
console.log(`  url=${url} (${subject.url ? "stored" : "rebuilt from id"})`);
console.log(`  playlist=${subject.playlist ? JSON.stringify(subject.playlist) : "none"}`);

async function plan(presetId: string, label: string) {
  const res = await fetch(`${BASE}/api/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ url, presetId, videoId: subject!.videoId }),
  });
  const body = (await res.json()) as {
    action?: string;
    reason?: string;
    diffs?: Array<{ field: string; label: string; from?: string; to?: string }>;
    lossless?: boolean;
    convertOutPath?: string;
    existingPath?: string;
    error?: string;
  };
  console.log(`\n[${label}] preset=${presetId}`);
  if (body.error) {
    console.log(`  ERROR: ${body.error}`);
    return;
  }
  console.log(`  action : ${body.action}`);
  console.log(`  reason : ${body.reason}`);
  if (body.lossless !== undefined) console.log(`  lossless: ${body.lossless}`);
  if (body.convertOutPath) console.log(`  outpath: ${body.convertOutPath}`);
  if (body.diffs?.length) {
    console.log(`  diffs  : ${body.diffs.length}`);
    for (const d of body.diffs.slice(0, 8)) {
      console.log(`    - ${d.label}: ${d.from ?? "?"} -> ${d.to ?? "?"}`);
    }
  }
}

// Same preset it was downloaded with: the strongest possible skip case.
await plan(subject.presetId, "same preset as stored");
// A different video container: the remux path.
const otherVideo = subject.presetId === "mkv-max" ? "mp4-h264" : "mkv-max";
await plan(otherVideo, "different container");
// An audio preset: cannot come from a video file without an encode.
await plan("opus", "audio preset");
