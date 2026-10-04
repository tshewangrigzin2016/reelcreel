import type {
  FileFingerprint,
  FingerprintScalar,
  PlaylistDownloadContext,
  SkipDiff,
  SourceFingerprint,
  SourceStreamFingerprint,
} from "../../shared/types";
import { buildRequestKey } from "../../shared/request-key";
import { formatDuration } from "../../shared/format";

/**
 * Fingerprint schema version. A missing/older version is deliberately not
 * trusted for skipping: a new field must be observed once before a file can be
 * considered an exact match again.
 */
export const CURRENT_FINGERPRINT_VERSION = 2;

/**
 * The de-duplication contract:
 *
 * - compare every stable attribute we know about on both sides;
 * - treat a missing attribute on either side as a mismatch (we cannot prove it
 *   is the same); and
 * - never use tolerances for the skip decision. Display formatting can round,
 *   but the stored values themselves must be identical.
 */

/* -------------------------------------------------------------------------- *
 * Codec names and primitive normalisation
 * -------------------------------------------------------------------------- */

/**
 * yt-dlp and ffprobe name codecs differently (`avc1.640028` vs `h264`,
 * `mp4a.40.2` vs `aac`). Fold them to a family name before comparing.
 */
export function normalizeCodec(raw?: string | null): string | undefined {
  if (!raw || typeof raw !== "string") return undefined;
  const c = raw.trim().toLowerCase();
  if (!c || c === "none" || c === "unknown") return undefined;

  if (c.startsWith("avc") || c.startsWith("h264")) return "h264";
  if (c.startsWith("hev") || c.startsWith("h265") || c.startsWith("x265"))
    return "h265";
  if (c.startsWith("vp09") || c.startsWith("vp9")) return "vp9";
  if (c.startsWith("vp08") || c.startsWith("vp8")) return "vp8";
  if (c.startsWith("av01")) return "av1";
  if (c.startsWith("mp4a") || c.startsWith("aac")) return "aac";
  if (c.startsWith("mp3")) return "mp3";
  if (c.startsWith("opus")) return "opus";
  if (c.startsWith("vorbis")) return "vorbis";
  if (c.startsWith("flac")) return "flac";
  if (c.startsWith("alac")) return "alac";
  if (c.startsWith("ac3")) return "ac3";
  if (c.startsWith("eac3")) return "eac3";
  if (c.startsWith("dts")) return "dts";
  if (c.startsWith("pcm")) return "pcm";
  return c;
}

type Raw = Record<string, unknown>;

function num(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string" && v.trim()) {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function scalar(v: unknown): FingerprintScalar | undefined {
  if (typeof v === "string") return v.trim() ? v.trim() : undefined;
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "boolean") return v;
  if (v === null) return null;
  return undefined;
}

function hasVideo(s: Raw): boolean {
  const vc = s.vcodec;
  return typeof vc === "string" && vc !== "" && vc !== "none";
}

function hasAudio(s: Raw): boolean {
  const ac = s.acodec;
  return typeof ac === "string" && ac !== "" && ac !== "none";
}

/**
 * yt-dlp exposes the formats it selected as `requested_formats` when `-f`
 * picked more than one. A single selection has no such array and the top-level
 * record *is* the format.
 */
function selectedFormats(raw: Raw): Raw[] {
  const requested = raw.requested_formats;
  if (Array.isArray(requested) && requested.length > 0) {
    return requested.filter((s): s is Raw => !!s && typeof s === "object");
  }
  return [raw];
}

function stableMetadata(
  raw: Raw,
): Record<string, FingerprintScalar> | undefined {
  const values: Record<string, FingerprintScalar> = {};
  const put = (key: string, value: unknown): void => {
    const normalized = scalar(value);
    if (normalized !== undefined) values[key] = normalized;
  };

  // These fields describe the media identity. Volatile engagement counts,
  // signed URLs and availability tokens are intentionally excluded.
  put("uploader", raw.uploader ?? raw.channel);
  put("channelId", raw.channel_id);
  put("uploadDate", raw.upload_date);
  put("releaseTimestamp", raw.release_timestamp ?? raw.timestamp);
  put("liveStatus", raw.live_status);
  put("availability", raw.availability);
  put("ageLimit", raw.age_limit);
  put("isLive", raw.is_live);
  put("wasLive", raw.was_live);
  put("series", raw.series);
  put("seasonNumber", raw.season_number);
  put("episodeNumber", raw.episode_number);
  put("episode", raw.episode);
  put("track", raw.track);
  put("artist", raw.artist);
  put("album", raw.album);

  return Object.keys(values).length > 0 ? values : undefined;
}

function streamFingerprint(raw: Raw): SourceStreamFingerprint | null {
  const formatId = str(raw.format_id);
  if (!formatId) return null;

  return {
    formatId,
    ...(str(raw.ext) ? { ext: str(raw.ext) } : {}),
    ...(str(raw.protocol) ? { protocol: str(raw.protocol) } : {}),
    ...(str(raw.container) ? { container: str(raw.container) } : {}),
    ...(num(raw.width) !== undefined ? { width: num(raw.width) } : {}),
    ...(num(raw.height) !== undefined ? { height: num(raw.height) } : {}),
    ...(str(raw.resolution) ? { resolution: str(raw.resolution) } : {}),
    ...(num(raw.fps) !== undefined ? { fps: num(raw.fps) } : {}),
    ...(normalizeCodec(str(raw.vcodec))
      ? { vcodec: normalizeCodec(str(raw.vcodec)) }
      : {}),
    ...(normalizeCodec(str(raw.acodec))
      ? { acodec: normalizeCodec(str(raw.acodec)) }
      : {}),
    ...(str(raw.profile) ? { profile: str(raw.profile) } : {}),
    ...(str(raw.pix_fmt) ? { pixFmt: str(raw.pix_fmt) } : {}),
    ...(str(raw.dynamic_range) ? { dynamicRange: str(raw.dynamic_range) } : {}),
    ...(num(raw.vbr) !== undefined ? { vbr: num(raw.vbr) } : {}),
    ...(num(raw.abr) !== undefined ? { abr: num(raw.abr) } : {}),
    ...(num(raw.tbr) !== undefined ? { tbr: num(raw.tbr) } : {}),
    ...(num(raw.asr) !== undefined ? { asr: num(raw.asr) } : {}),
    ...(num(raw.audio_channels) !== undefined
      ? { channels: num(raw.audio_channels) }
      : {}),
    ...(str(raw.language) ? { language: str(raw.language) } : {}),
    ...(num(raw.filesize) !== undefined
      ? { filesizeBytes: num(raw.filesize) }
      : {}),
    ...(num(raw.filesize_approx) !== undefined
      ? { filesizeApproxBytes: num(raw.filesize_approx) }
      : {}),
  };
}

function selectedFormatId(
  formats: SourceStreamFingerprint[],
): string | undefined {
  return formats.length > 0
    ? formats.map((format) => format.formatId).join("+")
    : undefined;
}

function selectedExt(formats: SourceStreamFingerprint[]): string | undefined {
  const ext = formats
    .map((format) => format.ext)
    .filter((value): value is string => !!value);
  return ext.length > 0 ? ext.join("+") : undefined;
}

/**
 * Builds the "what does the site offer right now" fingerprint from the JSON of
 * `yt-dlp --simulate --dump-json` run with the preset's format selection.
 *
 * `--dump-json` reports the source format, before post-processing. Retaining
 * both the combined format id and every selected stream prevents a change in
 * one half of a DASH download from being hidden by a stable-looking title or
 * resolution.
 */
export function sourceFingerprintFromYtdlp(
  raw: Raw,
  group: "video" | "audio",
): SourceFingerprint {
  const formats = selectedFormats(raw);
  const streams = formats
    .map(streamFingerprint)
    .filter((value): value is SourceStreamFingerprint => value !== null);
  const video = group === "video" ? formats.find(hasVideo) : undefined;
  const audio = formats.find(hasAudio);
  const videoStream = video ? streamFingerprint(video) : null;
  const audioStream = audio ? streamFingerprint(audio) : null;
  const combinedFormatId = str(raw.format_id) ?? selectedFormatId(streams);
  const metadata = stableMetadata(raw);
  const rawResolution = str(raw.resolution);
  const resolution = str(video?.resolution) ?? rawResolution;

  return {
    fingerprintVersion: CURRENT_FINGERPRINT_VERSION,
    ...(str(raw.id) ? { videoId: str(raw.id) } : {}),
    title: str(raw.title) ?? "Untitled",
    ...(str(raw.uploader ?? raw.channel)
      ? { uploader: str(raw.uploader ?? raw.channel) }
      : {}),
    ...(str(raw.channel_id) ? { channelId: str(raw.channel_id) } : {}),
    ...(str(raw.upload_date) ? { uploadDate: str(raw.upload_date) } : {}),
    ...(combinedFormatId ? { formatId: combinedFormatId } : {}),
    ...(videoStream?.formatId ? { videoFormatId: videoStream.formatId } : {}),
    ...(audioStream?.formatId ? { audioFormatId: audioStream.formatId } : {}),
    ...(selectedExt(streams) ? { sourceExt: selectedExt(streams) } : {}),
    ...(str(raw.protocol) ? { protocol: str(raw.protocol) } : {}),
    ...(str(raw.container) ? { container: str(raw.container) } : {}),
    ...(str(raw.format_note) ? { formatNote: str(raw.format_note) } : {}),
    ...(str(raw.quality) ? { quality: str(raw.quality) } : {}),
    ...(resolution ? { resolution } : {}),
    ...(str(raw.dynamic_range ?? video?.dynamic_range)
      ? { dynamicRange: str(raw.dynamic_range ?? video?.dynamic_range) }
      : {}),
    ...(num(raw.duration) !== undefined
      ? { durationSec: num(raw.duration) }
      : {}),
    ...(video && num(video.width) !== undefined
      ? { width: num(video.width) }
      : {}),
    ...(video && num(video.height) !== undefined
      ? { height: num(video.height) }
      : {}),
    ...(video && num(video.fps) !== undefined ? { fps: num(video.fps) } : {}),
    ...(video && normalizeCodec(str(video.vcodec))
      ? { vcodec: normalizeCodec(str(video.vcodec)) }
      : {}),
    ...(audio && normalizeCodec(str(audio.acodec))
      ? { acodec: normalizeCodec(str(audio.acodec)) }
      : {}),
    ...(str(video?.profile ?? raw.profile)
      ? { profile: str(video?.profile ?? raw.profile) }
      : {}),
    ...(str(video?.pix_fmt ?? raw.pix_fmt)
      ? { pixFmt: str(video?.pix_fmt ?? raw.pix_fmt) }
      : {}),
    ...(video && num(video.vbr) !== undefined ? { vbr: num(video.vbr) } : {}),
    ...(audio && num(audio.abr) !== undefined ? { abr: num(audio.abr) } : {}),
    ...(num(raw.tbr) !== undefined ? { tbr: num(raw.tbr) } : {}),
    ...(audio && num(audio.asr) !== undefined ? { asr: num(audio.asr) } : {}),
    ...(audio && num(audio.audio_channels) !== undefined
      ? { channels: num(audio.audio_channels) }
      : {}),
    ...(num(raw.filesize) !== undefined
      ? { sourceSizeBytes: num(raw.filesize) }
      : {}),
    ...(num(raw.filesize_approx) !== undefined
      ? { sourceSizeApproxBytes: num(raw.filesize_approx) }
      : {}),
    ...(streams.length > 0 ? { selectedFormats: streams } : {}),
    ...(metadata ? { metadata } : {}),
    ...(str(raw.extractor) ? { extractor: str(raw.extractor) } : {}),
  };
}

/* -------------------------------------------------------------------------- *
 * Strict comparison helpers
 * -------------------------------------------------------------------------- */

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([a], [b]) => a.localeCompare(b),
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function display(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return stableJson(value);
}

function equalValue(a: unknown, b: unknown): boolean {
  if (typeof a === "object" || typeof b === "object")
    return stableJson(a) === stableJson(b);
  return Object.is(a, b);
}

export interface SourceComparison {
  equal: boolean;
  /** How many attributes were present and compared on both sides. */
  comparable: number;
  diffs: SkipDiff[];
}

function compareFields(
  have: Record<string, unknown>,
  want: Record<string, unknown>,
  fields: Array<[field: string, label: string]>,
): SourceComparison {
  const diffs: SkipDiff[] = [];
  let comparable = 0;

  for (const [field, label] of fields) {
    const a = have[field];
    const b = want[field];
    if (a === undefined && b === undefined) continue;
    if (a !== undefined && b !== undefined) comparable++;
    if (a === undefined || b === undefined || !equalValue(a, b)) {
      diffs.push({ field, label, from: display(a), to: display(b) });
    }
  }

  return { equal: diffs.length === 0, comparable, diffs };
}

const SOURCE_FIELDS: Array<[field: string, label: string]> = [
  ["fingerprintVersion", "Fingerprint schema"],
  ["videoId", "Video id"],
  ["title", "Title"],
  ["uploader", "Uploader"],
  ["channelId", "Channel"],
  ["uploadDate", "Upload date"],
  ["formatId", "Format"],
  ["videoFormatId", "Video format"],
  ["audioFormatId", "Audio format"],
  ["sourceExt", "Source container"],
  ["protocol", "Protocol"],
  ["container", "Container"],
  ["formatNote", "Quality"],
  ["quality", "Quality target"],
  ["resolution", "Resolution"],
  ["dynamicRange", "Dynamic range"],
  ["durationSec", "Duration"],
  ["width", "Width"],
  ["height", "Height"],
  ["fps", "Frame rate"],
  ["vcodec", "Video codec"],
  ["acodec", "Audio codec"],
  ["profile", "Codec profile"],
  ["pixFmt", "Pixel format"],
  ["vbr", "Video bitrate"],
  ["abr", "Audio bitrate"],
  ["tbr", "Total bitrate"],
  ["asr", "Sample rate"],
  ["channels", "Channels"],
  ["sourceSizeBytes", "Source file size"],
  ["sourceSizeApproxBytes", "Approximate source size"],
  ["selectedFormats", "Selected streams"],
  ["metadata", "Source metadata"],
  ["extractor", "Extractor"],
];

function resolutionLabel(fp: { width?: number; height?: number }): string {
  return fp.width !== undefined && fp.height !== undefined
    ? `${fp.width}x${fp.height}`
    : "unknown";
}

/**
 * Compares source fingerprints attribute by attribute. Any changed or unknown
 * attribute is a mismatch. A format id is mandatory even when every other
 * field happens to look the same: it is the exact rendition selector.
 */
export function compareSource(
  have: SourceFingerprint,
  want: SourceFingerprint,
): SourceComparison {
  const result = compareFields(
    have as unknown as Record<string, unknown>,
    want as unknown as Record<string, unknown>,
    SOURCE_FIELDS,
  );
  const diffs = [...result.diffs];

  if (
    have.fingerprintVersion !== CURRENT_FINGERPRINT_VERSION ||
    want.fingerprintVersion !== CURRENT_FINGERPRINT_VERSION
  ) {
    if (!diffs.some((diff) => diff.field === "fingerprintVersion")) {
      diffs.unshift({
        field: "fingerprintVersion",
        label: "Fingerprint schema",
        from: display(have.fingerprintVersion),
        to: display(want.fingerprintVersion),
      });
    }
  }

  if (!have.formatId || !want.formatId) {
    if (!diffs.some((diff) => diff.field === "formatId")) {
      diffs.push({
        field: "formatId",
        label: "Format",
        from: have.formatId,
        to: want.formatId,
      });
    }
  }

  const widthChanged = diffs.some((diff) => diff.field === "width");
  const heightChanged = diffs.some((diff) => diff.field === "height");
  if (widthChanged || heightChanged) {
    for (let index = diffs.length - 1; index >= 0; index--) {
      if (diffs[index]?.field === "width" || diffs[index]?.field === "height")
        diffs.splice(index, 1);
    }
    diffs.push({
      field: "resolution",
      label: "Resolution",
      from: resolutionLabel(have),
      to: resolutionLabel(want),
    });
  }

  return {
    equal: diffs.length === 0,
    comparable: result.comparable,
    diffs,
  };
}

const FILE_FIELDS: Array<[field: string, label: string]> = [
  ["fingerprintVersion", "Fingerprint schema"],
  ["ext", "File format"],
  ["container", "Container"],
  ["formatName", "Container name"],
  ["formatLongName", "Container description"],
  ["sizeBytes", "File size"],
  ["durationSec", "Duration"],
  ["width", "Width"],
  ["height", "Height"],
  ["fps", "Frame rate"],
  ["vcodec", "Video codec"],
  ["acodec", "Audio codec"],
  ["profile", "Codec profile"],
  ["pixFmt", "Pixel format"],
  ["dynamicRange", "Dynamic range"],
  ["vbr", "Video bitrate"],
  ["abr", "Audio bitrate"],
  ["tbr", "Total bitrate"],
  ["asr", "Sample rate"],
  ["channels", "Channels"],
  ["formatBitrate", "Container bitrate"],
  ["sampleFmt", "Sample format"],
  ["streamCount", "Stream count"],
  ["videoStreamCount", "Video stream count"],
  ["audioStreamCount", "Audio stream count"],
  ["subtitleStreamCount", "Subtitle stream count"],
  ["dataStreamCount", "Data stream count"],
  ["chapterCount", "Chapter count"],
  ["hasChapters", "Chapters"],
  ["languages", "Languages"],
  ["metadata", "File metadata"],
  ["hasVideo", "Video stream"],
  ["hasAudio", "Audio stream"],
];

/** Compares a stored file fingerprint with a fresh ffprobe measurement. */
export function compareFile(
  have: FileFingerprint,
  want: FileFingerprint,
): SourceComparison {
  const result = compareFields(
    have as unknown as Record<string, unknown>,
    want as unknown as Record<string, unknown>,
    FILE_FIELDS,
  );
  const diffs = [...result.diffs];
  if (
    have.fingerprintVersion !== CURRENT_FINGERPRINT_VERSION ||
    want.fingerprintVersion !== CURRENT_FINGERPRINT_VERSION
  ) {
    if (!diffs.some((diff) => diff.field === "fingerprintVersion")) {
      diffs.unshift({
        field: "fingerprintVersion",
        label: "Fingerprint schema",
        from: display(have.fingerprintVersion),
        to: display(want.fingerprintVersion),
      });
    }
  }
  return { equal: diffs.length === 0, comparable: result.comparable, diffs };
}

/* -------------------------------------------------------------------------- *
 * Playlist / selection context
 * -------------------------------------------------------------------------- */

const PLAYLIST_FIELDS: Array<[field: string, label: string]> = [
  ["playlistId", "Playlist"],
  ["entryIndex", "Playlist position"],
  ["selectionMode", "Selection mode"],
  ["selectionCount", "Selection size"],
  ["selectionFingerprint", "Selection"],
];

export interface PlaylistComparison extends SourceComparison {
  /** True when neither side carries any playlist context at all. */
  absent: boolean;
}

/**
 * Compares *how* a video was reached, not what the media is.
 *
 * Stored so a copy pulled from a playlist's selection table can be recognised
 * as such later, and so a change in that context is visible. Deliberately
 * separate from `compareSource`: the same video selected from a playlist is the
 * same media, so these differences are reported for transparency and never
 * allowed to force a re-download on their own.
 */
export function comparePlaylist(
  have: PlaylistDownloadContext | undefined,
  want: PlaylistDownloadContext | undefined,
): PlaylistComparison {
  const a = (have ?? {}) as unknown as Record<string, unknown>;
  const b = (want ?? {}) as unknown as Record<string, unknown>;

  // Only surface positional and selection fields when both sides actually came
  // from the *same* playlist. Comparing across two different playlists makes
  // every field look changed and buries the one difference that matters.
  const sameList =
    !!a.playlistId && !!b.playlistId && a.playlistId === b.playlistId
      ? PLAYLIST_FIELDS
      : [PLAYLIST_FIELDS[0]!];

  const result = compareFields(a, b, sameList);
  const absent = result.comparable === 0 && result.diffs.length === 0;

  return { ...result, absent };
}

/** A cheap pre-check used before the more complete ffprobe comparison. */
export function fileIntact(
  file: FileFingerprint,
  sizeNow: number | undefined,
): boolean {
  if (sizeNow === undefined || file.sizeBytes === undefined) return false;
  return sizeNow === file.sizeBytes;
}

export { buildRequestKey };

/** Human-readable source diff helper for queue/API callers. */
export function describeDiff(diff: SkipDiff): SkipDiff {
  if (diff.field === "durationSec" && diff.from && diff.to) {
    return {
      ...diff,
      from: formatDuration(Number(diff.from)),
      to: formatDuration(Number(diff.to)),
    };
  }
  return diff;
}
