import type {
  DownloadItem,
  DownloadOptions,
  Settings,
  SettingsUpdate,
} from "./types";
import { extractVideoId, normalizeUrl } from "./url";

export class ValidationError extends Error {}
export const PRESET_IDS = [
  "mp4-h264",
  "mp4-best",
  "mkv-max",
  "webm",
  "mp3-320",
  "mp3-v0",
  "m4a",
  "opus",
  "flac",
] as const;
export const DEFAULT_OPTIONS: DownloadOptions = {
  embedThumbnail: false,
  embedMetadata: true,
  embedChapters: false,
  subtitles: false,
  subtitleLangs: "en.*",
  sponsorblock: false,
};
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ValidationError("Expected a JSON object.");
  return value as Record<string, unknown>;
}
export function textValue(value: unknown, name: string, max = 4096): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f]/.test(value)
  )
    throw new ValidationError(
      `${name} must be nonempty text (maximum ${max} characters).`,
    );
  return value.trim();
}
export function integer(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  )
    throw new ValidationError(
      `${name} must be an integer from ${min} to ${max}.`,
    );
  return value;
}
export function youtubeUrl(value: unknown, individual = false): string {
  const url = normalizeUrl(textValue(value, "URL"));
  if (!url || (individual && !extractVideoId(url)))
    throw new ValidationError(
      individual
        ? "Select an individual YouTube video URL."
        : "Enter a valid YouTube video or playlist URL.",
    );
  if (individual)
    return `https://www.youtube.com/watch?v=${extractVideoId(url)}`;
  return url;
}
export function presetId(value: unknown): string {
  if (!PRESET_IDS.includes(value as (typeof PRESET_IDS)[number]))
    throw new ValidationError("Unknown preset. Choose an available format.");
  return value as string;
}
export function filenameTemplate(value: unknown): string {
  const result = textValue(value, "Filename template", 220);
  if (
    /[\\/]/.test(result) ||
    result.includes("..") ||
    /^[A-Za-z]:/.test(result)
  )
    throw new ValidationError(
      "Filename template must be a filename, without folders or ..",
    );
  if (!result.endsWith(".%(ext)s"))
    throw new ValidationError("Filename template must end with .%(ext)s");
  return result;
}
export function options(
  value: unknown = {},
  defaults: DownloadOptions = DEFAULT_OPTIONS,
): DownloadOptions {
  const raw = object(value);
  const allowed = new Set([
    ...Object.keys(DEFAULT_OPTIONS),
    "maxHeight",
    "audioLanguage",
    "subtitleSource",
    "subtitleMode",
  ]);
  for (const key of Object.keys(raw))
    if (!allowed.has(key))
      throw new ValidationError(`Unknown download option: ${key}`);
  const result = { ...defaults } as DownloadOptions;
  for (const key of [
    "embedThumbnail",
    "embedMetadata",
    "embedChapters",
    "subtitles",
    "sponsorblock",
  ] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== "boolean")
        throw new ValidationError(`${key} must be true or false.`);
      result[key] = raw[key];
    }
  }
  for (const key of ["audioLanguage", "subtitleLangs"] as const) {
    if (raw[key] !== undefined)
      result[key] =
        raw[key] === null || raw[key] === ""
          ? (undefined as never)
          : textValue(raw[key], key, 200);
  }
  if (raw.maxHeight !== undefined)
    result.maxHeight =
      raw.maxHeight === null
        ? undefined
        : integer(raw.maxHeight, "Resolution cap", 144, 8640);
  for (const [key, values] of [
    ["subtitleSource", ["manual", "automatic", "both"]],
    ["subtitleMode", ["sidecar", "embedded"]],
  ] as const) {
    if (raw[key] !== undefined) {
      if (!(values as readonly unknown[]).includes(raw[key]))
        throw new ValidationError(`Invalid ${key}.`);
      (result as unknown as Record<string, unknown>)[key] = raw[key];
    }
  }
  if (result.audioLanguage && !/^[A-Za-z0-9_-]+$/.test(result.audioLanguage))
    throw new ValidationError("Audio language must be a language code.");
  return result;
}
export function items(value: unknown): DownloadItem[] {
  if (!Array.isArray(value) || !value.length || value.length > 500)
    throw new ValidationError("Provide between 1 and 500 items.");
  return value.map((item) => {
    const raw = object(item);
    const url = youtubeUrl(raw.url, true);
    const id = extractVideoId(url)!;
    if (raw.videoId !== undefined && raw.videoId !== id)
      throw new ValidationError("Video id does not match its URL.");
    const result: DownloadItem = { url, videoId: id };
    for (const key of ["title", "thumbnail"] as const)
      if (raw[key] !== undefined) result[key] = textValue(raw[key], key);
    if (raw.playlistIndex !== undefined)
      result.playlistIndex = integer(
        raw.playlistIndex,
        "Playlist index",
        1,
        100000,
      );
    if (raw.playlist !== undefined) {
      const p = object(raw.playlist);
      const out: Record<string, unknown> = {};
      for (const key of ["playlistId", "playlistTitle", "selectionFingerprint"])
        if (p[key] !== undefined) out[key] = textValue(p[key], key, 10000);
      if (p.playlistUrl !== undefined)
        out.playlistUrl = youtubeUrl(p.playlistUrl);
      for (const key of ["entryIndex", "selectionCount"])
        if (p[key] !== undefined) out[key] = integer(p[key], key, 1, 100000);
      if (p.selectionMode !== undefined) {
        if (!["single", "multiple", "all"].includes(String(p.selectionMode)))
          throw new ValidationError("Invalid selection mode.");
        out.selectionMode = p.selectionMode;
      }
      result.playlist = out;
    }
    return result;
  });
}
export function settingsUpdate(value: unknown): SettingsUpdate {
  const raw = object(value);
  const result: Record<string, unknown> = {};
  const limits: Record<string, number> = {
    playlistCap: 10000,
    downloadConcurrency: 16,
    probeConcurrency: 16,
    conversionConcurrency: 4,
    // 1 GB is a generous ceiling for one waiting file; the point of the cap is
    // that a small VPS never fills up, so a huge value defeats it.
    tempCapMb: 1024 * 64,
    deliveryTtlMinutes: 60 * 24,
    deliveryMaxAttempts: 10,
  };
  for (const [key, val] of Object.entries(raw)) {
    if (key in limits) result[key] = integer(val, key, 1, limits[key]);
    else if (
      ["ytdlpPath", "ffmpegPath", "runtimePath", "cookiesPath"].includes(key)
    )
      result[key] = val === null || val === "" ? null : textValue(val, key);
    else if (key === "outputDir") result[key] = textValue(val, key);
    else if (key === "tempDir") result[key] = textValue(val, key);
    else if (key === "outputTemplate") result[key] = filenameTemplate(val);
    else if (["skipExisting", "convertInstead"].includes(key)) {
      if (typeof val !== "boolean")
        throw new ValidationError(`${key} must be true or false.`);
      result[key] = val;
    } else if (key === "deliveryMode") {
      if (val !== "server" && val !== "browser")
        throw new ValidationError("Delivery mode must be server or browser.");
      result[key] = val;
    } else if (key === "jsRuntime") {
      if (val !== "node" && val !== "deno")
        throw new ValidationError("Runtime must be node or deno.");
      result[key] = val;
    } else throw new ValidationError(`Unknown setting: ${key}`);
  }
  return result as SettingsUpdate;
}

export function compatibilityError(
  preset: string,
  value: DownloadOptions,
): string | undefined {
  if (["webm", "opus"].includes(preset) && value.embedThumbnail)
    return "WebM cannot embed cover art. Turn off Embed thumbnail or choose another container.";
  if (
    ["m4a", "opus", "mp3-320", "mp3-v0", "flac"].includes(preset) &&
    value.subtitles &&
    value.subtitleMode !== "sidecar"
  )
    return "Audio-only presets need separate caption files. Select Separate caption file in subtitle controls.";
}
