import { runYtdlp, withClientFallback } from "./spawn";
import { lastError } from "./probe";

const RESOLVE_TIMEOUT_MS = 60_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_LIMIT = 64;

interface CachedUrl {
  at: number;
  directUrl: string;
}

const cache = new Map<string, CachedUrl>();

function cacheGet(key: string): string | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.directUrl;
}

function cacheSet(key: string, directUrl: string): void {
  cache.set(key, { at: Date.now(), directUrl });
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/**
 * yt-dlp format selector for in-app preview playback.
 *
 * Always a single progressive stream (audio + video muxed) so a plain
 * `<video>` element can play it with no MSE/DASH handling. That caps preview
 * quality at what YouTube offers progressively (typically <= 720p); anything
 * higher has separate audio/video tracks and must be downloaded instead.
 * Exported for unit tests.
 */
export function previewFormatFor(quality?: string): string {
  const q = (quality ?? "best").toLowerCase();
  if (q === "best") {
    return "best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/best";
  }
  const height = Number(q);
  if (Number.isInteger(height) && height >= 144 && height <= 4320) {
    return (
      `best[height<=${height}][ext=mp4][acodec!=none][vcodec!=none]` +
      `/best[height<=${height}][acodec!=none][vcodec!=none]` +
      `/best[height<=${height}]`
    );
  }
  return "best[ext=mp4][acodec!=none][vcodec!=none]/best[acodec!=none][vcodec!=none]/best";
}

/** Valid preview quality values accepted by GET /api/preview/stream. */
export function normalizePreviewQuality(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "best";
  const q = value.trim().toLowerCase();
  if (q === "best") return "best";
  const height = Number(q);
  if (Number.isInteger(height) && [144, 240, 360, 480, 720, 1080].includes(height))
    return String(height);
  return "best";
}

/**
 * Resolves a YouTube watch URL to a direct progressive media URL via `yt-dlp -g`.
 *
 * Retries across player clients when YouTube pushes back, using the same
 * challenge fallback as every other probe. Results are cached briefly because
 * the signed URLs expire and because resolution costs a yt-dlp startup.
 */
export async function resolvePreviewUrl(
  url: string,
  quality: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const normalizedQuality = normalizePreviewQuality(quality);
  const key = `${url}|${normalizedQuality}`;
  const cached = cacheGet(key);
  if (cached) return cached;

  const directUrl = await withClientFallback(async (playerClient) => {
    let found = "";
    const handle = await runYtdlp({
      args: [
        "--get-url",
        "-f",
        previewFormatFor(normalizedQuality),
        "--no-playlist",
        "--",
        url,
      ],
      onLine: (line) => {
        const trimmed = line.trim();
        if (!found && /^https?:\/\//.test(trimmed)) found = trimmed;
      },
      signal,
      timeoutMs: RESOLVE_TIMEOUT_MS,
      withFfmpegLocation: false,
      playerClient,
    });
    const code = await handle.done;
    if (code !== 0 || !found) {
      throw new Error(
        lastError(handle.stderrText()) ?? "Could not resolve a playable stream.",
      );
    }
    return found;
  });

  cacheSet(key, directUrl);
  return directUrl;
}
