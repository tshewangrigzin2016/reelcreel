import { statSync } from "node:fs";

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
};

/** MIME type for a download file extension. Exported for unit tests. */
export function contentTypeForExt(ext: string): string | null {
  const normalized = ext.toLowerCase().replace(/^\./, "");
  if (!STREAMABLE_EXTS.has(normalized)) return null;
  return MIME_BY_EXT[normalized] ?? "application/octet-stream";
}

export interface ParsedRange {
  start: number;
  /** Inclusive end, or null when the header was open-ended (`bytes=10-`). */
  end: number | null;
}

/**
 * Parses a single `Range: bytes=start-end` header.
 *
 * Returns null for anything we do not serve (multi-range, suffix-only is
 * supported, malformed is null so the caller can ignore the header and send
 * the whole file). Exported for unit tests.
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
