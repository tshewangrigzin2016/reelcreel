import type { DownloadOptions, RequestKeyParts } from "./types";

/**
 * Identity of "what the user asked for", independent of the source.
 *
 * Two requests with the same key produce byte-comparable output, so the key
 * covers every field a request can still express. Fields that only changed
 * *how fast* we fetched used to live here and were deliberately excluded; they
 * have since been removed from the request entirely, so there is nothing left
 * to leave out.
 *
 * Lives in `shared/` because both sides need it: the server stores it with each
 * download, and the browser computes it to ask "do I already have this, with
 * the format currently selected?".
 *
 * A plain JSON string rather than a hash: short enough to store, and readable
 * straight out of the database when a skip looks wrong.
 */
export function buildRequestKey(
  presetId: string,
  options: DownloadOptions,
): string {
  const parts: RequestKeyParts = {
    presetId,
    embedThumbnail: !!options.embedThumbnail,
    embedMetadata: !!options.embedMetadata,
    embedChapters: !!options.embedChapters,
    subtitles: !!options.subtitles,
    subtitleLangs: options.subtitles ? options.subtitleLangs || "en.*" : "",
    sponsorblock: !!options.sponsorblock,
    ...(options.maxHeight ? { maxHeight: options.maxHeight } : {}),
    ...(options.audioLanguage ? { audioLanguage: options.audioLanguage } : {}),
    ...(options.subtitles
      ? {
          subtitleSource: options.subtitleSource ?? "both",
          subtitleMode: options.subtitleMode ?? "embedded",
        }
      : {}),
  };
  return JSON.stringify(parts);
}

/**
 * Stable context for a playlist selection. It is stored for audit/history and
 * does not become part of the media request key: selecting the same video from
 * a playlist should still find a matching library file.
 */
export function buildSelectionFingerprint(videoIds: string[]): string {
  return [...new Set(videoIds.filter(Boolean))].sort().join(",");
}
