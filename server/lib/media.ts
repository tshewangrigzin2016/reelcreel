import { statSync } from "node:fs";

/**
 * Byte-level helpers for handing a finished file to a browser.
 *
 * Recovered from the reverted in-app-player commit (31c585d), which had already
 * worked out the two things that are easy to get wrong here: the MIME table,
 * and a Range parser that ignores anything it does not understand instead of
 * returning a bogus 206.
 */

export const STREAMABLE_EXTS = new Set([
  "mp4",
  "mkv",
  "webm",
  "m4a",
  "mp3",
  "opus",
  "flac",
]);

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  mkv: "video/x-matroska",
  webm: "video/webm",
  m4a: "audio/mp4",
  mp3: "audio/mpeg",
  opus: "audio/ogg",
  flac: "audio/flac",
  vtt: "text/vtt",
  srt: "application/x-subrip",
  ass: "text/x-ssa",
  ttml: "application/ttml+xml",
  json3: "application/json",
};

/** MIME type for a download file extension. Exported for unit tests. */
export function contentTypeForExt(ext: string): string | null {
  const normalized = ext.toLowerCase().replace(/^\./, "");
  if (!STREAMABLE_EXTS.has(normalized) && !(normalized in MIME_BY_EXT))
    return null;
  return MIME_BY_EXT[normalized] ?? "application/octet-stream";
}

/** Media extensions this app will deliver. Captions are checked separately. */
export function isMediaExt(ext: string): boolean {
  return STREAMABLE_EXTS.has(ext.toLowerCase().replace(/^\./, ""));
}

export interface ParsedRange {
  start: number;
  /** Inclusive end, or null when the header was open-ended (`bytes=10-`). */
  end: number | null;
}

/**
 * Parses a single `Range: bytes=start-end` header.
 *
 * Returns null for anything we do not serve (multi-range, malformed), so the
 * caller can ignore the header and send the whole file. A suffix range
 * (`bytes=-500`) is supported because that is how some players probe duration.
 * Exported for unit tests.
 */
export function parseRangeHeader(
  header: string | null | undefined,
  size: number,
): ParsedRange | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, startText, endText] = match;
  if (startText === "" && endText === "") return null;
  if (startText === "") {
    // Suffix range: last N bytes.
    const suffix = Number(endText);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    if (suffix >= size) return { start: 0, end: null };
    return { start: size - suffix, end: null };
  }
  const start = Number(startText);
  if (!Number.isInteger(start) || start < 0 || start >= size) return null;
  if (endText === "") return { start, end: null };
  const end = Number(endText);
  if (!Number.isInteger(end) || end < start) return null;
  return { start, end: Math.min(end, size - 1) };
}

/** File size, or null when the path cannot be statted. */
export function fileSize(filePath: string): number | null {
  try {
    return statSync(filePath).size;
  } catch {
    return null;
  }
}

/**
 * Builds the `Content-Disposition` value that makes the browser save the file
 * instead of navigating to it.
 *
 * Two filenames, deliberately: the bare `filename=` parameter is what every
 * browser uses, and it must be ASCII or the header itself is invalid -- a
 * YouTube title with an accent or an emoji throws on header construction. The
 * RFC 5987 `filename*=` parameter carries the real name for the browsers that
 * understand it (all of them, today). Stripping to ASCII is the fallback for
 * the rest, not the primary path.
 */
export function contentDisposition(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f]/g, "").trim() || "media";
  const ascii = cleaned
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 200);
  const encoded = encodeURIComponent(cleaned).replace(
    /['()*]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
