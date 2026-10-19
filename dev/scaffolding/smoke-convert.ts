/**
 * Verifies the FFmpeg conversion path against a real downloaded file.
 *
 * The unit tests mock ffprobe and ffmpeg, so they prove the *decision* but not
 * that a real remux runs and produces a playable file. This uses the real
 * binaries on a real library file and re-measures the result.
 */
import { existsSync, statSync, rmSync } from "node:fs";
import path from "node:path";
import { inspectFile } from "../../server/lib/ffprobe";
import { buildConversion, runConversion } from "../../server/lib/convert";
import { getPreset, actualExtForPreset } from "../../server/lib/presets";
import { compareFile } from "../../server/lib/fingerprint";
import { convertedPathFor } from "../../server/lib/convert";
import { getSettings, historyList } from "../../server/lib/db";

const rows = historyList().filter((r) => r.filePath && existsSync(r.filePath));
if (rows.length === 0) {
  console.log("no history rows with a file on disk");
  process.exit(0);
}

// Smallest real file keeps this quick; conversion behaviour is size-independent.
const row = rows.sort((a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0))[0]!;
console.log(`source file : ${row.filePath}`);
console.log(`             ${((row.sizeBytes ?? 0) / 1e6).toFixed(1)} MB  preset=${row.presetId}`);

const measured = await inspectFile(row.filePath!);
if (!measured) {
  console.log("ffprobe could not read the file");
  process.exit(1);
}

console.log(`\nmeasured    : .${measured.ext} ${measured.width}x${measured.height} ` +
  `v=${measured.vcodec} a=${measured.acodec} dur=${measured.durationSec}s`);
console.log(`              streams=${measured.streamCount} chapters=${measured.chapterCount ?? 0}`);

const settings = getSettings();

// Remux the real file into each container the video presets write.
for (const presetId of ["mkv-max", "webm", "mp4-h264"]) {
  const preset = getPreset(presetId)!;
  const targetExt = actualExtForPreset(preset);

  // A synthetic "what the site offers" built from the measured file itself:
  // the streams are already what the target wants, so this is the pure
  // container-difference case a format switch produces.
  const target = {
    fingerprintVersion: 2,
    title: row.title,
    vcodec: measured.vcodec,
    acodec: measured.acodec,
    width: measured.width,
    height: measured.height,
    abr: measured.abr,
  };

  const outPath = convertedPathFor(row.filePath!, targetExt, settings.outputDir);
  const plan = buildConversion({
    source: measured,
    target: target as never,
    preset,
    outPath,
    embedMetadata: true,
    embedChapters: false,
  });

  if (!plan) {
    console.log(`\n${presetId.padEnd(9)} -> .${targetExt}: buildConversion declined (correct: no lossless path)`);
    continue;
  }

  console.log(`\n${presetId.padEnd(9)} -> .${targetExt}: ${plan.note}`);
  console.log(`             lossless=${plan.lossless}`);

  const started = Date.now();
  const handle = await runConversion({ args: plan.args, durationSec: measured.durationSec });
  const code = await handle.done;
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  if (code !== 0 || !existsSync(outPath)) {
    console.log(`             FAILED (code ${code}): ${handle.stderrText().slice(0, 200)}`);
    continue;
  }

  const after = await inspectFile(outPath);
  const sizeMb = (statSync(outPath).size / 1e6).toFixed(1);
  console.log(`             ok in ${secs}s -> ${sizeMb} MB`);
  console.log(`             result: .${after?.ext} ${after?.width}x${after?.height} ` +
    `v=${after?.vcodec} a=${after?.acodec}`);

  // The container and size must change; the media must not.
  const same = after && compareFile(measured, after);
  const mediaPreserved =
    after?.vcodec === measured.vcodec &&
    after?.acodec === measured.acodec &&
    after?.width === measured.width &&
    after?.height === measured.height;
  console.log(`             media preserved: ${mediaPreserved}`);
  console.log(`             container changed: ${after?.ext !== measured.ext}`);
  console.log(`             full-fingerprint equal: ${same?.equal} ` +
    `(expected false -- ext/size/container differ)`);
  if (same && !same.equal) {
    console.log(`             differing: ${same.diffs.map((d) => d.field).join(", ")}`);
  }

  rmSync(outPath, { force: true });
  console.log(`             cleaned up`);
}
