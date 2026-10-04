import { SharedWork } from "./shared-work";
import { extractVideoId } from "../../shared/url";
import { buildSourceArgs } from "./presets";
import path from "node:path";
import type {
  DownloadItem,
  DownloadOptions,
  DownloadPlan,
  DownloadRequest,
  FileFingerprint,
  HistoryRow,
  PlanBatchEntry,
  PlanBatchResult,
  PlaylistDownloadContext,
  RequestKeyParts,
  SkipDiff,
  SourceFingerprint,
} from "../../shared/types";
import * as database from "./db";
import {
  buildConversion,
  convertedPathFor,
  type ConversionInput,
} from "./convert";
import { fileSizeNow, inspectFile } from "./ffprobe";
import * as ffprobe from "./ffprobe";
import {
  buildRequestKey,
  compareFile,
  comparePlaylist,
  compareSource,
  fileIntact,
  sourceFingerprintFromYtdlp,
} from "./fingerprint";
import { formatBytes } from "../../shared/format";
import { actualExtForPreset, getPreset, type PresetDef } from "./presets";
import { pools } from "./queue";
import { runYtdlp } from "./spawn";

/**
 * Decides, per download, whether we already have it.
 *
 * The rule: skip only when *every* attribute still matches. The source half of
 * the fingerprint proves the site is offering the same rendition as last time,
 * the request key proves we are asking for the same thing, and the file half
 * proves it is still on disk unchanged. Any difference at all -- a new 4K
 * stream, a renamed video, a different container -- means download.
 */

type Raw = Record<string, unknown>;

const PLAN_TTL_MS = 2 * 60 * 1000;
const PLAN_CACHE_LIMIT = 64;
const planCache = new Map<string, { at: number; source: SourceFingerprint }>();
/**
 * Several selected rows can refer to the same video (or the user can click
 * Download twice while the first plan is still probing). Share only the
 * in-flight promise: unlike a stale cache this never reuses an older source
 * decision, but it prevents duplicate yt-dlp processes for the same request.
 */
const sourceProbeInflight = new SharedWork<SourceFingerprint | null>();

function cacheGet(key: string): SourceFingerprint | null {
  const hit = planCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PLAN_TTL_MS) {
    planCache.delete(key);
    return null;
  }
  planCache.delete(key);
  planCache.set(key, hit);
  return hit.source;
}

function cacheSet(key: string, source: SourceFingerprint): void {
  planCache.set(key, { at: Date.now(), source });
  while (planCache.size > PLAN_CACHE_LIMIT) {
    const oldest = planCache.keys().next();
    if (oldest.done) break;
    planCache.delete(oldest.value);
  }
}

/**
 * Asks yt-dlp what it *would* download, without downloading it.
 *
 * Only the preset's format selection is passed -- subtitles, thumbnails and
 * rate limits change the output wrapper, not which rendition gets picked, and
 * including them would make the probe slower and more fragile for no gain.
 */
async function probeSource(
  req: DownloadRequest,
  preset: PresetDef,
  signal?: AbortSignal,
): Promise<SourceFingerprint | null> {
  const cacheKey = JSON.stringify([
    req.url,
    preset.id,
    req.options.maxHeight,
    req.options.audioLanguage,
  ]);
  // A planning call is the point where we decide whether a new rendition or
  // metadata change requires work. Source catalogs can change within minutes,
  // so correctness wins over the old two-minute cache. Internal callers may
  // explicitly opt into the cache for a preview-only request.
  if (req.revalidate === false) {
    const cached = cacheGet(cacheKey);
    if (cached) return cached;
  }

  return sourceProbeInflight.run(
    cacheKey,
    async (sharedSignal): Promise<SourceFingerprint | null> => {
      let json = "";
      const handle = await runYtdlp({
        args: [
          "--simulate",
          "--dump-json",
          "--no-playlist",
          ...buildSourceArgs(preset, req.options),
          "--",
          req.url,
        ],
        onLine: (line) => {
          // --dump-json emits one object per line; the last one is the video.
          if (line.startsWith("{")) json = line;
        },
        signal: sharedSignal,
        timeoutMs: 120_000,
        withFfmpegLocation: false,
      });

      const code = await handle.done;
      if (code !== 0 || !json) return null;

      let raw: Raw;
      try {
        raw = JSON.parse(json) as Raw;
      } catch {
        return null;
      }

      const source = sourceFingerprintFromYtdlp(raw, preset.group);
      if (req.revalidate === false) cacheSet(cacheKey, source);
      return source;
    },
    signal,
  );
}

/**
 * Post-processing we cannot reproduce with a plain ffmpeg run: embedded
 * subtitles, SponsorBlock cuts (which change the duration) and cover art.
 * Asking for any of those means re-downloading is the only way to honour the
 * request faithfully.
 */
export function conversionAllowed(options: DownloadOptions): boolean {
  return !(options.subtitles || options.sponsorblock || options.embedThumbnail);
}

/** Rank existing copies so conversion starts from the best one available. */
function rank(a: HistoryRow, b: HistoryRow, group: "video" | "audio"): number {
  const fa = a.file;
  const fb = b.file;
  if (!fa || !fb) return 0;
  if (group === "video") {
    if (fa.hasVideo !== fb.hasVideo) return fa.hasVideo ? -1 : 1;
    return (fb.height ?? 0) - (fa.height ?? 0);
  }
  if (fa.hasAudio !== fb.hasAudio) return fa.hasAudio ? -1 : 1;
  return (fb.abr ?? 0) - (fa.abr ?? 0);
}

function presetLabel(id: string): string {
  return getPreset(id)?.label ?? id;
}

function formatChangedDiff(from: HistoryRow, presetId: string): SkipDiff {
  return {
    field: "presetId",
    label: "Format",
    from: `${presetLabel(from.presetId)} (.${from.ext ?? from.file?.ext ?? "?"})`,
    to: `${presetLabel(presetId)} (.${getPreset(presetId)?.ext ?? "?"})`,
  };
}

/**
 * Whether re-using the file we hold would produce something we don't have.
 *
 * Guards the one case conversion cannot serve: the requested preset *and* the
 * container on disk already match what is stored, so the only difference is a
 * post-processing option. ffmpeg cannot add those by remuxing, so "converting"
 * would hand back a duplicate under a `(converted)` name that still lacks
 * whatever was asked for -- worse than a re-download, and much more confusing.
 */
function formatDiffers(row: HistoryRow, preset: PresetDef): boolean {
  const haveExt = (row.file?.ext ?? row.ext ?? "").toLowerCase();
  return (
    row.presetId !== preset.id ||
    haveExt !== actualExtForPreset(preset).toLowerCase()
  );
}

/**
 * True when the request asks for metadata the stored copy does not carry.
 *
 * Metadata and chapters sit in a middle ground: ffmpeg *can* carry them across
 * a remux with `-map_metadata 0`, but only if the file already has them. If the
 * copy on disk was written without them, re-using it silently drops a feature
 * the user just switched on, so the only faithful answer is a re-download.
 */
function metadataWouldBeMissing(
  row: HistoryRow,
  options: DownloadOptions,
): boolean {
  const needsMetadata = !!options.embedMetadata;
  const needsChapters = !!options.embedChapters;
  if (!needsMetadata && !needsChapters) return false;
  if (!row.requestKey) return needsMetadata || needsChapters;

  let stored: RequestKeyParts;
  try {
    stored = JSON.parse(row.requestKey) as RequestKeyParts;
  } catch {
    return needsMetadata || needsChapters;
  }
  return (
    (needsMetadata && !stored.embedMetadata) ||
    (needsChapters && !stored.embedChapters)
  );
}

interface CandidateResult {
  usable: HistoryRow[];
  /**
   * Rows whose stored file no longer matches what is on disk.
   *
   * Kept, and reported, because "this does not match" is only actionable when
   * it says *what* stopped matching. Truncated, replaced and re-encoded files
   * all look the same from the outside.
   */
  drifted: Array<{ row: HistoryRow; diffs: SkipDiff[] }>;
}

/**
 * A history row is usable only after both cheap integrity and full media
 * inspection pass. Size alone cannot detect a same-sized replacement, a changed
 * codec, a lost chapter, or metadata that was stripped after completion.
 */
async function inspectCached(
  filePath: string,
  cache?: Map<string, Promise<FileFingerprint | null>>,
  signal?: AbortSignal,
): Promise<FileFingerprint | null> {
  if (!cache) return inspectFile(filePath, signal).catch(() => null);
  // Keep compatibility with lightweight test/embedding adapters that only
  // provide the original two ffprobe helpers.
  const signature =
    typeof ffprobe.fileSignature === "function"
      ? ffprobe.fileSignature(filePath)
      : fileSizeNow(filePath) === undefined
        ? undefined
        : String(fileSizeNow(filePath));
  if (!signature) return null;
  const key = `${filePath}|${signature}`;
  const existing = cache.get(key);
  if (existing) return existing;
  const pending = inspectFile(filePath, signal).catch(() => null);
  cache.set(key, pending);
  return pending;
}

async function usableCandidates(
  rows: HistoryRow[],
  fileCache?: Map<string, Promise<FileFingerprint | null>>,
  signal?: AbortSignal,
): Promise<CandidateResult> {
  const usable: HistoryRow[] = [];
  const drifted: CandidateResult["drifted"] = [];

  for (const row of rows) {
    if (!row.file) continue;

    const sizeNow = fileSizeNow(row.file.path);
    if (!fileIntact(row.file, sizeNow)) {
      drifted.push({
        row,
        diffs: [
          {
            field: "sizeBytes",
            label: "File size",
            from: sizeText(row.file.sizeBytes),
            to: sizeText(sizeNow),
          },
        ],
      });
      continue;
    }

    signal?.throwIfAborted();
    const measured = await inspectCached(row.file.path, fileCache, signal);
    if (!measured) {
      drifted.push({ row, diffs: [] });
      continue;
    }

    const compared = compareFile(row.file, measured);
    if (!compared.equal) {
      drifted.push({ row, diffs: compared.diffs });
      continue;
    }

    usable.push({
      ...row,
      file: measured,
      sizeBytes: measured.sizeBytes ?? row.sizeBytes,
      ext: measured.ext || row.ext,
    });
  }

  return { usable, drifted };
}

function sizeText(bytes: number | undefined): string {
  return bytes === undefined ? "unknown" : formatBytes(bytes);
}

/**
 * How a stored copy's playlist context differs from the one being requested.
 *
 * Read from history rather than the plan, because the media decision has
 * already been made by then and this is only ever context. Reported as a diff
 * so "reached from a playlist this time" is visible; it never changes the
 * action, since the same video is the same media however it was selected.
 */
function playlistDiffsFor(
  videoId: string,
  want?: PlaylistDownloadContext,
): SkipDiff[] {
  if (!want) return [];

  const withContext = historyRowsForIds([videoId]).filter((r) => r.playlist);
  if (withContext.length === 0) return [];

  // Prefer a row recorded against the same playlist: comparing the selection
  // of two unrelated playlists makes every field look changed at once.
  const sameList = withContext.find(
    (r) => r.playlist?.playlistId === want.playlistId,
  );
  const best = sameList ?? withContext[0];

  return comparePlaylist(best?.playlist, want).diffs;
}

function historyRowsForIds(ids: string[]): HistoryRow[] {
  const byId = new Map<string, HistoryRow>();
  for (const id of new Set(ids.filter(Boolean))) {
    for (const row of database.historyForVideo?.(id) ?? [])
      byId.set(row.id, row);
  }
  return [...byId.values()].sort((a, b) => b.completedAt - a.completedAt);
}

export interface PlanSettings {
  signal?: AbortSignal;
  skipExisting: boolean;
  convertInstead: boolean;
  /** Shared only within one batch/sync request to avoid duplicate ffprobe work. */
  fileInspectionCache?: Map<string, Promise<FileFingerprint | null>>;
}

/**
 * Works out what to do about one download request.
 *
 * Never throws and never blocks a download: if the source cannot be read, the
 * answer is "download". Failing to prove a duplicate is not a reason to refuse
 * the user's file.
 */
export async function planDownload(
  req: DownloadRequest,
  settings: PlanSettings,
): Promise<DownloadPlan> {
  const preset = getPreset(req.presetId);
  if (!preset) {
    return { action: "download", reason: "", diffs: [] };
  }

  const download = (
    reason: string,
    diffs: SkipDiff[] = [],
    source?: SourceFingerprint,
  ): DownloadPlan => ({
    action: "download",
    reason,
    diffs,
    source,
  });

  settings.signal?.throwIfAborted();
  const known = historyRowsForIds([
    req.videoId ?? extractVideoId(req.url) ?? "",
    req.url,
  ]);
  if (known.length === 0) return download("Not downloaded yet.");
  const source = await probeSource(req, preset, settings.signal).catch(
    (error) => {
      settings.signal?.throwIfAborted();
      return null;
    },
  );
  if (!source) {
    // Either the site is unreachable or yt-dlp could not read it. Both mean
    // "we cannot prove this is a duplicate", so fall through and download.
    return download("", [], undefined);
  }

  const requestKey = buildRequestKey(req.presetId, req.options);
  const storedRows = historyRowsForIds([
    req.videoId ?? "",
    source.videoId ?? "",
    req.url,
  ]);
  const { usable: candidates, drifted } = await usableCandidates(
    storedRows,
    settings.fileInspectionCache,
    settings.signal,
  );

  if (candidates.length === 0) {
    return download(
      storedRows.length > 0
        ? "Stored copy could not be verified against its full metadata; downloading a fresh copy."
        : "Not downloaded yet.",
      // Name what drifted. "Does not match" without the attributes is
      // unfalsifiable, and a truncated file looks identical to a changed codec
      // from the queue row.
      drifted[0]?.diffs ?? [],
      source,
    );
  }

  // 1. Exact match: same request, same source, file still intact.
  if (settings.skipExisting) {
    for (const row of candidates) {
      if (row.requestKey !== requestKey || !row.source) continue;
      if (!compareSource(row.source, source).equal) continue;

      // Described by the file we hold, not by the source: on a skip the user
      // cares about what is on disk, and naming the site's codec next to a file
      // that contains a different one just reads as a bug.
      const size = row.file ? formatBytes(row.file.sizeBytes ?? 0) : "";
      return {
        action: "skip",
        reason: `Already downloaded · ${[presetLabel(req.presetId), size].filter(Boolean).join(" · ")}`,
        diffs: [],
        existingPath: row.file?.path,
        source,
      };
    }
  }

  // 2. Same source, different request: we already hold the media, so change
  //    the file we have instead of fetching it again when that loses nothing.
  const sameSource = candidates
    .filter((row) => row.source && compareSource(row.source, source).equal)
    .sort((a, b) => rank(a, b, preset.group));

  const best = sameSource[0];
  if (best?.file) {
    const formatChanged = formatDiffers(best, preset);
    const diffs: SkipDiff[] = formatChanged
      ? [formatChangedDiff(best, req.presetId)]
      : [];

    if (
      formatChanged &&
      settings.convertInstead &&
      conversionAllowed(req.options) &&
      untouchedSourceCopy(best) &&
      !metadataWouldBeMissing(best, req.options)
    ) {
      const outPath = convertedPathFor(
        best.file.path,
        actualExtForPreset(preset),
        req.outputDir,
      );
      const conversion = buildConversion({
        source: best.file,
        target: source,
        preset,
        outPath,
        embedMetadata: req.options.embedMetadata,
        embedChapters: req.options.embedChapters,
      });
      if (conversion) {
        return {
          action: "convert",
          reason: conversion.note,
          diffs,
          existingPath: best.file.path,
          source,
          convertArgs: conversion.args,
          convertOutPath: outPath,
          lossless: conversion.lossless,
        };
      }
    }

    // Three ways to land here, and each needs its own sentence -- a row that
    // says "the options changed" when the user simply turned skipping off reads
    // like a bug.
    const reason =
      best.requestKey === requestKey
        ? "Re-downloading — an identical copy is on disk, but skipping is turned off."
        : formatChanged
          ? `Re-downloading — ${presetLabel(req.presetId)} needs a fresh copy.`
          : `Re-downloading — the output options changed, so ${presetLabel(
              req.presetId,
            )} has to be written again.`;

    return download(reason, diffs, source);
  }

  // 3. Something about the source itself changed.
  const closest = candidates
    .filter((row) => row.source)
    .sort((a, b) => rank(a, b, preset.group))[0];

  if (closest?.source) {
    const { diffs } = compareSource(closest.source, source);
    const summary = diffs.length
      ? diffs
          .slice(0, 3)
          .map((d) => `${d.label}: ${d.from ?? "?"} → ${d.to ?? "?"}`)
          .join(", ")
      : "attributes changed";
    return download(
      `Re-downloading — the source changed (${summary}).`,
      diffs,
      source,
    );
  }

  return download("No usable copy on disk.", [], source);
}

export interface PlanBatchInput {
  presetId: string;
  options: DownloadOptions;
  outputDir: string;
  outputTemplate: string;
  items: DownloadItem[];
}

/**
 * Re-plans many items at once, downloading nothing.
 *
 * This is what lets a change of format propagate: the UI re-runs the exact
 * planner the download path uses over everything it is showing, then acts only
 * on the rows that came back needing work. One shared decision engine for both
 * paths is the point -- a second, simpler rule here would drift from the real
 * one and the queue would start disagreeing with the badges.
 *
 * Concurrency comes from the shared probe pool, so a 200-item playlist cannot
 * open 200 yt-dlp processes at once.
 */
export async function planBatch(
  input: PlanBatchInput,
  settings: PlanSettings,
): Promise<PlanBatchResult> {
  const counts: PlanBatchResult["counts"] = {
    download: 0,
    skip: 0,
    convert: 0,
    error: 0,
  };
  const fileInspectionCache = new Map<
    string,
    Promise<FileFingerprint | null>
  >();

  const entries = await Promise.all(
    input.items.map(async (item): Promise<PlanBatchEntry> => {
      const base = {
        url: item.url,
        videoId: item.videoId,
        title: item.title,
      };

      try {
        const plan = await planDownload(
          {
            url: item.url,
            presetId: input.presetId,
            options: input.options,
            outputDir: input.outputDir,
            outputTemplate: input.outputTemplate,
            videoId: item.videoId,
            title: item.title,
            thumbnail: item.thumbnail,
            playlistIndex: item.playlistIndex ?? item.playlist?.entryIndex,
            playlist: item.playlist,
          },
          { ...settings, fileInspectionCache },
        );

        counts[plan.action] += 1;

        return {
          ...base,
          action: plan.action,
          reason: plan.reason,
          diffs: plan.diffs,
          ...(item.videoId
            ? { playlistDiffs: playlistDiffsFor(item.videoId, item.playlist) }
            : {}),
          ...(plan.existingPath ? { existingPath: plan.existingPath } : {}),
          ...(plan.lossless !== undefined ? { lossless: plan.lossless } : {}),
        };
      } catch (error) {
        counts.error += 1;
        return {
          ...base,
          // A row that failed to check is not a row that is already up to date.
          // Falling towards "download" is the only safe answer: the alternative
          // is silently never syncing a video we could not read.
          action: "download",
          reason: "Could not check this video — it will download.",
          diffs: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  return { entries, counts };
}

/** Absolute path a conversion should write to. Exported for the runner's tests. */
export function conversionOutputPath(
  existingPath: string,
  ext: string,
  outputDir: string,
): string {
  return path.resolve(convertedPathFor(existingPath, ext, outputDir));
}

/** Only explicit, verified stream provenance allows conversion of an existing copy. */
export function untouchedSourceCopy(row: HistoryRow): boolean {
  if (
    !row.source ||
    !row.file ||
    !row.requestKey ||
    !["original", "lossless-copy"].includes(row.provenance ?? "unknown")
  )
    return false;
  try {
    const stored = JSON.parse(row.requestKey) as RequestKeyParts;
    // `clipStart`/`clipEnd` are no longer writable -- the clip feature is gone
    // and `buildRequestKey` never emits them. They are still read here on
    // purpose: keys stored in SQLite before the removal contain them, and a
    // clipped file is not an untouched copy of its source, so those rows must
    // keep being rejected rather than silently re-classified as convertible.
    if (
      stored.clipStart ||
      stored.clipEnd ||
      stored.sponsorblock ||
      stored.subtitles ||
      stored.embedThumbnail
    )
      return false;
    if (row.file.hasVideo && row.file.vcodec !== row.source.vcodec)
      return false;
    if (row.file.hasAudio && row.file.acodec !== row.source.acodec)
      return false;
    if (
      !row.file.durationSec ||
      !row.source.durationSec ||
      Math.abs(row.file.durationSec - row.source.durationSec) > 2
    )
      return false;
    return true;
  } catch {
    return false;
  }
}
