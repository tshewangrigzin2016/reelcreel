import type { ListingResponse, PlaylistEntry, PlaylistMeta } from "../../shared/types";
import { runYtdlp } from "./spawn";
import { lastError, toEntry, toPlaylistMeta } from "./probe";

const LISTING_TIMEOUT_MS = 90_000;
const LISTING_CACHE_TTL_MS = 2 * 60 * 1000;
const LISTING_CACHE_LIMIT = 64;

const cache = new Map<string, { at: number; value: ListingResponse }>();

function cacheGet(key: string): ListingResponse | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > LISTING_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function cacheSet(key: string, value: ListingResponse): void {
  cache.set(key, { at: Date.now(), value });
  while (cache.size > LISTING_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

const YT_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);

/**
 * Accepts the channel / playlist URL shapes Explore can produce and normalizes
 * a channel into its uploads tab (`/videos`) so yt-dlp enumerates uploads.
 *
 * Search results hand us `channelUrl` values like:
 * - https://www.youtube.com/channel/UCxxxx
 * - https://www.youtube.com/@handle
 * Playlist cards hand us `?list=` URLs. Both are listable with
 * `--flat-playlist`; a bare channel URL without `/videos` may resolve to the
 * channel's home tab instead of uploads, hence the suffix.
 */
export function toListableUrl(raw: string): string {
  const s = raw.trim();
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error("Enter a valid YouTube channel or playlist URL.");
  }
  if (!YT_HOSTS.has(u.hostname.toLowerCase())) {
    throw new Error("Enter a valid YouTube channel or playlist URL.");
  }
  // Playlist (or watch-with-list) URLs list as-is.
  if (u.searchParams.get("list")) return u.toString();

  const path = u.pathname.replace(/\/+$/, "");
  const lower = path.toLowerCase();
  const isChannel =
    lower.startsWith("/channel/") ||
    lower.startsWith("/c/") ||
    lower.startsWith("/user/") ||
    lower.startsWith("/@");
  const tabbed = ["/videos", "/shorts", "/streams", "/live", "/playlists", "/featured"].some(
    (t) => lower.endsWith(t),
  );
  if (isChannel && !tabbed && path.length > 1) {
    u.pathname = `${path}/videos`;
    return u.toString();
  }
  // youtu.be / watch URLs without a list param are single videos, not listings.
  if (!isChannel && !u.searchParams.get("list")) {
    throw new Error("That URL is a single video — open it to download it.");
  }
  return u.toString();
}

/**
 * One page of a channel's uploads or a playlist's entries.
 *
 * Uses `--playlist-start/--playlist-end` so the Explore modal can load 20
 * first and 10 more per scroll step instead of enumerating a 1000-video
 * channel up front. `--flat-playlist --lazy-playlist` keeps each page to a
 * handful of requests.
 */
export async function listEntries(
  rawUrl: string,
  start: number,
  limit: number,
  signal?: AbortSignal,
): Promise<ListingResponse> {
  const url = toListableUrl(rawUrl);
  const first = Math.max(1, Math.floor(start) || 1);
  const count = Math.min(Math.max(Math.floor(limit) || 20, 1), 50);
  const end = first + count - 1;
  const cacheKey = `${url}\n${first}\n${count}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  if (signal?.aborted) throw new Error("Listing cancelled.");

  const lines: string[] = [];
  const handle = await runYtdlp({
    args: [
      "--flat-playlist",
      "--lazy-playlist",
      "--dump-json",
      "--yes-playlist",
      "--playlist-start",
      String(first),
      "--playlist-end",
      String(end),
      "--sleep-requests",
      "0.2",
      "--",
      url,
    ],
    onLine: (line) => {
      if (line.startsWith("{")) lines.push(line);
    },
    signal,
    timeoutMs: LISTING_TIMEOUT_MS,
    withFfmpegLocation: false,
    withCookies: false,
  });

  const code = await handle.done;
  if (code !== 0 || lines.length === 0) {
    throw new Error(
      lastError(handle.stderrText()) ?? "Could not read this channel or playlist.",
    );
  }

  let meta: PlaylistMeta | null = null;
  const entries: PlaylistEntry[] = [];
  for (const line of lines) {
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      if (raw._type === "playlist") {
        meta = toPlaylistMeta(raw, url);
        continue;
      }
      const id = typeof raw.id === "string" ? raw.id : "";
      if (!id || id === (meta?.id ?? "")) continue;
      entries.push(toEntry(raw, first + entries.length));
    } catch {
      /* skip a malformed line */
    }
  }

  // Mixes never emit a playlist record; derive identity from the URL instead.
  if (!meta && entries.length > 0) {
    try {
      const first_raw = JSON.parse(lines[0]) as Record<string, unknown>;
      meta = toPlaylistMeta(first_raw, url);
    } catch {
      meta = null;
    }
  }

  if (entries.length === 0) {
    throw new Error(
      lastError("") ?? "This channel or playlist has no readable entries.",
    );
  }

  const response: ListingResponse = {
    url,
    title: meta?.title,
    uploader: meta?.uploader,
    entries,
    hasMore: entries.length >= count,
    start: first,
  };
  cacheSet(cacheKey, response);
  return response;
}
