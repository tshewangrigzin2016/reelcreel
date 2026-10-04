import { normalizeUrl as safeUrl } from "../../shared/url";
import { thumbnailFor } from "../../shared/format";
import { extractVideoId } from "../../shared/url";
import type {
  PlaylistEntry,
  PlaylistMeta,
  PlaylistPreview,
  PlaylistProbe,
  ProbeResult,
  VideoMeta,
  VideoProbe,
} from "../../shared/types";
import * as database from "./db";
import { runYtdlp } from "./spawn";

const TRACKING_PARAMS = [
  "si",
  "pp",
  "feature",
  "src_vid",
  "t",
  "index",
  "start_radio",
  "ab_channel",
];

/** Mixes grow forever, so they get a much tighter ceiling than a real playlist. */
const RADIO_CAP = 30;

/**
 * yt-dlp's `--sleep-requests` is measured per extraction request. A full
 * second made a capped 200-entry playlist spend several minutes enumerating;
 * a small delay still avoids a burst while keeping the UI responsive.
 */
export const PLAYLIST_REQUEST_DELAY_SECONDS = "0.2";
const PROBE_VIDEO_TIMEOUT_MS = 90_000;
const PROBE_PLAYLIST_TIMEOUT_MS = 3 * 60_000;
const PROBE_PREVIEW_TIMEOUT_MS = 45_000;
const PROBE_CACHE_TTL_MS = 15 * 60 * 1000;

/** Cleans up pasted URLs: drops tracking params, keeps the playlist identity. */
export function normalizeUrl(raw: string): string {
  return safeUrl(raw) ?? "";
}

/** True for auto-generated Mixes ("list=RD..."), which need the tighter cap. */
export function isRadioList(url: string): boolean {
  try {
    return /^RD/i.test(new URL(url).searchParams.get("list") ?? "");
  } catch {
    return false;
  }
}

export function isPlaylistUrl(url: string): boolean {
  try {
    return !!new URL(url).searchParams.get("list");
  } catch {
    return false;
  }
}

export async function probeVideo(
  url: string,
  signal?: AbortSignal,
): Promise<VideoProbe> {
  if (signal?.aborted) throw new Error("Probe cancelled.");
  const id = extractVideoId(url);
  if (id) {
    const cached = database.cacheGet?.<VideoProbe | VideoMeta>(
      id,
      PROBE_CACHE_TTL_MS,
    );
    if (cached && "video" in cached) return cached;
    // Older builds stored VideoMeta directly in the same cache table. Accept
    // that shape during the migration so an upgrade never returns malformed
    // probe JSON to the browser.
    if (cached && "id" in cached) {
      return { kind: "video", video: cached as VideoMeta };
    }
  }

  let json = "";
  const handle = await runYtdlp({
    args: ["--dump-json", "--no-playlist", "--", url],
    onLine: (line) => {
      if (line.startsWith("{")) json = line;
    },
    signal,
    timeoutMs: PROBE_VIDEO_TIMEOUT_MS,
    withFfmpegLocation: false,
  });

  const code = await handle.done;
  if (code !== 0 || !json) {
    throw new Error(
      lastError(handle.stderrText()) ?? "Could not read this video.",
    );
  }

  const raw = JSON.parse(json) as Record<string, unknown>;
  const result = { kind: "video" as const, video: toVideoMeta(raw) };
  if (result.video.id) database.cacheSet?.(result.video.id, result);
  return result;
}

export async function probePlaylist(
  url: string,
  cap: number,
  signal?: AbortSignal,
): Promise<PlaylistProbe> {
  if (signal?.aborted) throw new Error("Probe cancelled.");
  const lines: string[] = [];
  const limit = isRadioList(url) ? Math.min(cap, RADIO_CAP) : cap;
  const handle = await runYtdlp({
    args: [
      "--flat-playlist",
      "--lazy-playlist",
      "--dump-json",
      "--yes-playlist",
      "--playlist-end",
      String(limit),
      "--sleep-requests",
      PLAYLIST_REQUEST_DELAY_SECONDS,
      "--",
      url,
    ],
    onLine: (line) => {
      if (line.startsWith("{")) lines.push(line);
    },
    signal,
    timeoutMs: PROBE_PLAYLIST_TIMEOUT_MS,
    withFfmpegLocation: false,
  });

  const code = await handle.done;
  if (code !== 0 || lines.length === 0) {
    throw new Error(
      lastError(handle.stderrText()) ?? "Could not read this playlist.",
    );
  }

  const entries: PlaylistEntry[] = [];
  let playlist: PlaylistMeta | null = null;

  for (const line of lines) {
    const raw = JSON.parse(line) as Record<string, unknown>;
    if (raw._type === "playlist") continue;
    if (!playlist) playlist = toPlaylistMeta(raw, url);
    entries.push(toEntry(raw, entries.length + 1));
  }

  if (!playlist) throw new Error("This playlist has no readable entries.");

  return {
    kind: "playlist",
    playlist: {
      ...playlist,
      entryCount: entries.length,
      truncated: entries.length >= limit,
      radio: isRadioList(url),
    },
    entries,
  };
}

/**
 * Re-deriving the first entry costs one yt-dlp startup (~1s) and one network
 * round trip, and React re-runs the effect on every keystroke that settles into
 * the same URL. A short-lived cache keeps the preview instant on re-focus.
 */
const PREVIEW_TTL_MS = 5 * 60 * 1000;
const PREVIEW_CACHE_LIMIT = 32;
const previewCache = new Map<string, { at: number; value: PlaylistPreview }>();

function previewCacheGet(key: string): PlaylistPreview | null {
  const hit = previewCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > PREVIEW_TTL_MS) {
    previewCache.delete(key);
    return null;
  }
  // Refresh insertion order so the oldest entry is the least recently used.
  previewCache.delete(key);
  previewCache.set(key, hit);
  return hit.value;
}

function previewCacheSet(key: string, value: PlaylistPreview): void {
  previewCache.set(key, { at: Date.now(), value });
  while (previewCache.size > PREVIEW_CACHE_LIMIT) {
    const oldest = previewCache.keys().next();
    if (oldest.done) break;
    previewCache.delete(oldest.value);
  }
}

/**
 * Reads only the first entry of a playlist. `--playlist-end 1` stops yt-dlp
 * after ~1 request instead of paging the whole list, which is what makes the
 * thumbnail appear while the full enumeration is still running.
 */
export async function probePlaylistFirst(
  url: string,
  signal?: AbortSignal,
): Promise<PlaylistPreview> {
  if (signal?.aborted) throw new Error("Probe cancelled.");
  const cached = previewCacheGet(url);
  if (cached) return cached;

  const lines: string[] = [];
  const handle = await runYtdlp({
    args: [
      "--flat-playlist",
      "--lazy-playlist",
      "--dump-json",
      "--yes-playlist",
      "--playlist-end",
      "1",
      "--",
      url,
    ],
    onLine: (line) => {
      if (line.startsWith("{")) lines.push(line);
    },
    signal,
    timeoutMs: PROBE_PREVIEW_TIMEOUT_MS,
    withFfmpegLocation: false,
  });

  const code = await handle.done;
  if (code !== 0 || lines.length === 0) {
    throw new Error(
      lastError(handle.stderrText()) ?? "Could not read this playlist.",
    );
  }

  let meta: PlaylistMeta | null = null;
  let entry: PlaylistEntry | null = null;

  for (const line of lines) {
    const raw = JSON.parse(line) as Record<string, unknown>;
    if (raw._type === "playlist") {
      meta = toPlaylistMeta(raw, url);
      continue;
    }
    if (!entry) entry = toEntry(raw, 1);
  }

  if (!entry) throw new Error("This playlist has no readable entries.");

  const preview: PlaylistPreview = {
    playlistTitle: meta?.title,
    entryCount: meta?.entryCount,
    radio: isRadioList(url),
    entry,
  };
  previewCacheSet(url, preview);
  return preview;
}

export async function probeUrl(
  url: string,
  cap: number,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  const clean = normalizeUrl(url);
  if (isPlaylistUrl(clean)) {
    try {
      return await probePlaylist(clean, cap, signal);
    } catch {
      if (signal?.aborted) throw new Error("Probe cancelled.");
      // A playlist URL whose list param is stale still resolves as a single video.
      return await probeVideo(clean, signal);
    }
  }
  return await probeVideo(clean, signal);
}

/**
 * Resolves a pasted list of individual video URLs into playlist-shaped entries.
 *
 * The batch composer used to hand raw URLs straight to the queue, so there was
 * nothing to show a selection table and nothing to select. Probing each URL
 * costs one yt-dlp call, but it buys a title, a duration and a thumbnail per
 * row, and it turns an unavailable video into a visible error instead of a
 * failed job.
 *
 * Concurrency comes from the shared probe pool, exactly as `planBatch` does, so
 * a 200-line paste cannot open 200 yt-dlp processes.
 */
export async function probeBatch(
  urls: string[],
  signal?: AbortSignal,
): Promise<{ entries: PlaylistEntry[]; errors: string[] }> {
  const entries: PlaylistEntry[] = [];
  const errors: string[] = [];

  await Promise.all(
    urls.map(async (url, index) => {
      try {
        const { video } = await probeVideo(url, signal);
        entries.push({
          id: video.id,
          title: video.title,
          index: index + 1,
          duration: video.duration,
          viewCount: video.viewCount,
          thumbnail: video.thumbnail,
          url: video.webpageUrl ?? url,
          availability: video.availability,
          liveStatus: video.liveStatus,
          isLive: video.isLive,
        });
      } catch (err) {
        if (signal?.aborted) throw err;
        errors.push(
          err instanceof Error ? err.message : String(err) ?? "Unreadable.",
        );
      }
    }),
  );

  // Arrival order is whatever the pool happened to finish in; the table's
  // default sort is "index", so the pasted order has to win.
  entries.sort((a, b) => a.index - b.index);
  return { entries, errors };
}

export function lastError(stderr: string): string | null {
  const lines = stderr.split("\n").map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^ERROR:\s*(.+)$/i);
    if (m) return m[1];
  }
  return null;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Trim to the ~12 fields the UI actually renders. Raw --dump-json is 1-3 MB. */
export function toVideoMeta(raw: Record<string, unknown>): VideoMeta {
  const id = String(raw.id ?? "");
  const description = str(raw.description);
  return {
    id,
    title: str(raw.title) ?? "Untitled",
    uploader:
      str(raw.uploader) ?? str(raw.channel) ?? str(raw.playlist_uploader),
    thumbnail: thumbnailFor(id, "hq"),
    duration: num(raw.duration),
    viewCount: num(raw.view_count),
    uploadDate: str(raw.upload_date),
    description: description ? shortDescription(description) : undefined,
    webpageUrl: str(raw.webpage_url),
    extractor: str(raw.extractor),
    availability: str(raw.availability),
    liveStatus: str(raw.live_status),
    isLive:
      str(raw.live_status) !== undefined && raw.live_status !== "not_live",
  };
}

/** First paragraph-ish chunk; full descriptions run to thousands of characters. */
function shortDescription(text: string): string {
  const flat = text.replace(/\r/g, "").trim();
  const paragraph = flat.split(/\n\s*\n/)[0] ?? flat;
  const clipped =
    paragraph.length > 320
      ? `${paragraph.slice(0, 320).trimEnd()}…`
      : paragraph;
  return clipped.replace(/\n+/g, " · ");
}

export function toEntry(
  raw: Record<string, unknown>,
  index: number,
): PlaylistEntry {
  const id = String(raw.id ?? "");
  const liveStatus = str(raw.live_status);
  return {
    id,
    title: str(raw.title) ?? "Untitled",
    index: num(raw.playlist_index) ?? index,
    duration: num(raw.duration),
    viewCount: num(raw.view_count),
    // Flat mode returns 300-char signed thumbnail URLs; deriving from the ID
    // avoids a request entirely and is strictly better.
    thumbnail: thumbnailFor(id),
    url:
      str(raw.url) ??
      str(raw.webpage_url) ??
      `https://www.youtube.com/watch?v=${id}`,
    availability: str(raw.availability),
    liveStatus,
    isLive: liveStatus !== undefined && liveStatus !== "not_live",
  };
}

/**
 * Flat mode has no per-video `uploader` or `description` (verified undefined),
 * so the channel name has to come from the playlist-level fields.
 *
 * Exported because the SSE stream has to build its meta frame from the first
 * entry: YouTube Mixes never emit a standalone `_type: "playlist"` record.
 */
export function toPlaylistMeta(
  raw: Record<string, unknown>,
  url: string,
): PlaylistMeta {
  return {
    id: str(raw.playlist_id) ?? str(raw.playlist) ?? url,
    title: str(raw.playlist_title) ?? str(raw.playlist) ?? "Playlist",
    uploader:
      str(raw.playlist_uploader) ??
      str(raw.playlist_channel) ??
      str(raw.channel),
    entryCount: num(raw.playlist_count) ?? num(raw.n_entries),
    webpageUrl: str(raw.playlist_webpage_url) ?? str(raw.channel_url) ?? url,
    truncated: false,
  };
}
