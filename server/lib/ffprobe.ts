import { SharedWork } from "./shared-work";
import { pools } from "./queue";
import { managedProcess } from "./process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { FileFingerprint } from "../../shared/types";
import { resolveBinary } from "./resolve-binary";
import { CURRENT_FINGERPRINT_VERSION, normalizeCodec } from "./fingerprint";
import { stripAnsi } from "./spawn";

/**
 * Reads the real attributes back out of a finished file.
 *
 * The number yt-dlp reported mid-download is the size of the stream it was
 * transferring, not the file that lands on disk, and it says nothing about the
 * codecs a re-encode actually produced. Measuring the finished file is the only
 * way to know what we own.
 */

const TIMEOUT_MS = 15_000;

let cachedFfprobe: string | null | undefined;

/** Called when the ffmpeg shim goes stale, so ffprobe is re-resolved too. */
export function invalidateFfprobe(): void {
  cachedFfprobe = undefined;
}

function siblingCandidates(dir: string, name: string): string[] {
  const exts =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  return exts.map((ext) => path.join(dir, name + ext));
}

async function works(candidate: string): Promise<boolean> {
  if (!candidate || !existsSync(candidate)) return false;
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    proc = Bun.spawn([candidate, "-version"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    const timeout = new Promise<false>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
    });
    const code = await Promise.race([proc.exited, timeout]);
    return code === 0;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      proc?.kill();
    } catch {
      /* already exited */
    }
  }
}

/**
 * ffprobe ships with most ffmpeg builds but not all -- the popular Windows
 * "essentials" zip deliberately omits it. It is checked next to the configured
 * ffmpeg first (a custom path in Settings implies a custom ffprobe beside it),
 * then on PATH, and if neither works the caller falls back to parsing
 * `ffmpeg -i` output.
 */
export async function resolveFfprobe(): Promise<string | null> {
  if (cachedFfprobe !== undefined) return cachedFfprobe;

  try {
    const ffmpeg = await resolveBinary("ffmpeg", "-version");
    if (!ffmpeg) throw new Error("FFmpeg is unavailable.");
    for (const candidate of siblingCandidates(
      path.dirname(ffmpeg.path),
      "ffprobe",
    )) {
      if (await works(candidate)) {
        cachedFfprobe = candidate;
        return candidate;
      }
    }
  } catch {
    /* no ffmpeg at all -- the caller will surface that */
  }

  const fromPath = await resolveBinary("ffprobe", "-version");
  cachedFfprobe = fromPath?.path ?? null;
  return cachedFfprobe;
}

async function run(
  argv: string[],
  signal?: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = "";
  const handle = managedProcess({
    argv,
    signal,
    timeoutMs: TIMEOUT_MS,
    onLine: (line) => {
      stdout += line + "\n";
    },
  });
  const code = await handle.done;
  return { code, stdout, stderr: handle.stderrText() };
}

function extOf(p: string): string {
  return path.extname(p).replace(/^\./, "").toLowerCase();
}

function toNumber(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/** "30000/1001" -> 29.97 */
function parseFrameRate(v: unknown): number | undefined {
  if (typeof v !== "string" || !v) return undefined;
  const [a, b] = v.split("/").map((s) => Number.parseFloat(s));
  if (!Number.isFinite(a) || a <= 0) return undefined;
  const value = Number.isFinite(b) && b > 0 ? a / b : a;
  return Math.round(value * 1000) / 1000;
}

interface RawStream {
  codec_type?: string;
  codec_name?: string;
  codec_long_name?: string;
  profile?: string;
  width?: unknown;
  height?: unknown;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  pix_fmt?: string;
  color_range?: string;
  color_space?: string;
  color_transfer?: string;
  color_primaries?: string;
  sample_fmt?: string;
  sample_rate?: unknown;
  channels?: unknown;
  bit_rate?: unknown;
  tags?: Record<string, unknown>;
}

interface RawChapter {
  id?: unknown;
}

function stableTagValue(
  value: unknown,
): string | number | boolean | null | undefined {
  if (typeof value === "string") return value.trim() ? value.trim() : undefined;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "boolean") return value;
  if (value === null) return null;
  return undefined;
}

function stableProbeMetadata(
  format: Record<string, unknown>,
  streams: RawStream[],
): Record<string, string | number | boolean | null> | undefined {
  const metadata: Record<string, string | number | boolean | null> = {};
  const volatile = new Set(["encoder", "creation_time", "date", "encoded_by"]);
  const add = (key: string, value: unknown): void => {
    const leaf = key.toLowerCase().split(".").at(-1) ?? key.toLowerCase();
    if (volatile.has(leaf)) return;
    const normalized = stableTagValue(value);
    if (normalized !== undefined) metadata[key] = normalized;
  };

  const formatTags = format.tags;
  if (formatTags && typeof formatTags === "object") {
    for (const [key, value] of Object.entries(
      formatTags as Record<string, unknown>,
    )) {
      add(`format.${key.toLowerCase()}`, value);
    }
  }
  streams.forEach((stream, index) => {
    if (!stream.tags || typeof stream.tags !== "object") return;
    for (const [key, value] of Object.entries(stream.tags)) {
      if (volatile.has(key.toLowerCase())) continue;
      add(`stream.${index}.${key.toLowerCase()}`, value);
    }
  });

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function streamFrameRate(stream?: RawStream): number | undefined {
  if (!stream) return undefined;
  return (
    parseFrameRate(stream.r_frame_rate) ?? parseFrameRate(stream.avg_frame_rate)
  );
}

function dynamicRange(stream?: RawStream): string | undefined {
  if (!stream) return undefined;
  return stream.color_transfer || stream.color_space || stream.color_range;
}

function fromFfprobeJson(
  filePath: string,
  text: string,
): FileFingerprint | null {
  let parsed: {
    streams?: RawStream[];
    format?: Record<string, unknown>;
    chapters?: RawChapter[];
  };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    return null;
  }

  const streams = parsed.streams ?? [];
  if (streams.length === 0) return null;

  const video = streams.find((s) => s.codec_type === "video");
  const audio = streams.find((s) => s.codec_type === "audio");
  const format = parsed.format ?? {};

  // Per-stream bitrate is frequently absent (matroska, fragmented mp4); the
  // container's overall bitrate is the only number available in that case.
  const containerBitrate = toNumber(format.bit_rate);
  const subtitles = streams.filter((s) => s.codec_type === "subtitle").length;
  const data = streams.filter((s) => s.codec_type === "data").length;
  const chapters = parsed.chapters?.length ?? 0;
  const languages = [
    ...new Set(
      streams
        .map((stream) => stream.tags?.language)
        .filter(
          (language): language is string =>
            typeof language === "string" && language.trim() !== "",
        )
        .map((language) => language.trim().toLowerCase()),
    ),
  ].sort();
  const formatName =
    typeof format.format_name === "string" ? format.format_name : undefined;
  const container = formatName?.split(",")[0];

  return {
    fingerprintVersion: CURRENT_FINGERPRINT_VERSION,
    path: filePath,
    ext: extOf(filePath),
    container,
    formatName,
    formatLongName:
      typeof format.format_long_name === "string"
        ? format.format_long_name
        : undefined,
    sizeBytes: toNumber(format.size),
    durationSec: toNumber(format.duration),
    width: video ? toNumber(video.width) : undefined,
    height: video ? toNumber(video.height) : undefined,
    fps: streamFrameRate(video),
    vcodec: video ? normalizeCodec(video.codec_name) : undefined,
    acodec: audio ? normalizeCodec(audio.codec_name) : undefined,
    profile: video?.profile,
    pixFmt: video?.pix_fmt,
    dynamicRange: dynamicRange(video),
    vbr: video ? kbps(toNumber(video.bit_rate)) : undefined,
    abr: audio ? kbps(toNumber(audio.bit_rate) ?? containerBitrate) : undefined,
    tbr: kbps(containerBitrate),
    asr: audio ? toNumber(audio.sample_rate) : undefined,
    channels: audio ? toNumber(audio.channels) : undefined,
    formatBitrate: kbps(containerBitrate),
    sampleFmt: audio?.sample_fmt,
    streamCount: streams.length,
    videoStreamCount: streams.filter((s) => s.codec_type === "video").length,
    audioStreamCount: streams.filter((s) => s.codec_type === "audio").length,
    subtitleStreamCount: subtitles,
    dataStreamCount: data,
    chapterCount: chapters,
    hasChapters: chapters > 0,
    ...(languages.length > 0 ? { languages } : {}),
    ...(stableProbeMetadata(format, streams)
      ? { metadata: stableProbeMetadata(format, streams) }
      : {}),
    hasVideo: !!video,
    hasAudio: !!audio,
  };
}

const RE_DURATION = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/;
const RE_VIDEO_STREAM = /Stream #\d+:\d+.*?:\s*Video:\s*([a-z0-9_]+)/i;
const RE_AUDIO_STREAM = /Stream #\d+:\d+.*?:\s*Audio:\s*([a-z0-9_]+)/i;
const RE_DIMENSIONS = /\b(\d{2,5})x(\d{2,5})\b/;
const RE_FPS = /([\d.]+)\s*fps/;
const RE_HZ = /\b(\d{3,6})\s*Hz\b/;
const RE_KBPS = /\b(\d+)\s*kb\/s\b/;
const RE_CHANNELS = /\b(mono|stereo|quad|5\.1|7\.1|\d+\s*channels)\b/i;

const CHANNEL_COUNTS: Record<string, number> = {
  mono: 1,
  stereo: 2,
  quad: 4,
  "5.1": 6,
  "7.1": 8,
};

function channelCount(text: string): number | undefined {
  const m = text.match(RE_CHANNELS);
  if (!m) return undefined;
  const key = m[1]!.toLowerCase().trim();
  if (key in CHANNEL_COUNTS) return CHANNEL_COUNTS[key];
  const n = Number.parseInt(key, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Fallback for builds without ffprobe. `ffmpeg -i <file>` with no output file
 * is the classic trick: it exits non-zero but prints the full stream list first.
 */
function fromFfmpegOutput(
  filePath: string,
  stderr: string,
): FileFingerprint | null {
  const text = stripAnsi(stderr);
  if (!/Stream #\d+:\d+/.test(text)) return null;

  const lines = text.split(/\r?\n/);
  const videoLine = lines.find((l) => RE_VIDEO_STREAM.test(l));
  const audioLine = lines.find((l) => RE_AUDIO_STREAM.test(l));

  let durationSec: number | undefined;
  const dm = text.match(RE_DURATION);
  if (dm) {
    durationSec =
      Number(dm[1]) * 3600 + Number(dm[2]) * 60 + Number.parseFloat(dm[3]!);
  }

  const videoCount = videoLine ? 1 : 0;
  const audioCount = audioLine ? 1 : 0;
  const sizeBytes = safeStat(filePath)?.size;

  return {
    fingerprintVersion: CURRENT_FINGERPRINT_VERSION,
    path: filePath,
    ext: extOf(filePath),
    container: extOf(filePath),
    formatName: extOf(filePath),
    sizeBytes,
    durationSec,
    width: videoLine
      ? numberOr(videoLine.match(RE_DIMENSIONS)?.[1])
      : undefined,
    height: videoLine
      ? numberOr(videoLine.match(RE_DIMENSIONS)?.[2])
      : undefined,
    fps: videoLine ? numberOr(videoLine.match(RE_FPS)?.[1]) : undefined,
    vcodec: videoLine
      ? normalizeCodec(videoLine.match(RE_VIDEO_STREAM)?.[1])
      : undefined,
    acodec: audioLine
      ? normalizeCodec(audioLine.match(RE_AUDIO_STREAM)?.[1])
      : undefined,
    abr: audioLine ? numberOr(audioLine.match(RE_KBPS)?.[1]) : undefined,
    asr: audioLine ? numberOr(audioLine.match(RE_HZ)?.[1]) : undefined,
    streamCount: videoCount + audioCount,
    videoStreamCount: videoCount,
    audioStreamCount: audioCount,
    subtitleStreamCount: 0,
    dataStreamCount: 0,
    chapterCount: 0,
    hasChapters: false,
    hasVideo: !!videoLine,
    hasAudio: !!audioLine,
  };
}

function numberOr(v: string | undefined): number | undefined {
  const n = Number.parseFloat(v ?? "");
  return Number.isFinite(n) ? n : undefined;
}

function kbps(bitsPerSecond?: number): number | undefined {
  if (!bitsPerSecond || bitsPerSecond <= 0) return undefined;
  return Math.round(bitsPerSecond / 100) / 10;
}

function safeStat(p: string) {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}

/**
 * Measures a file on disk. Returns null when it is missing, unreadable or not
 * media at all -- callers treat that as "no usable copy" and download.
 */
async function inspectFileOnce(
  filePath: string,
  signal?: AbortSignal,
): Promise<FileFingerprint | null> {
  const stat = safeStat(filePath);
  if (!stat || stat.size === 0) return null;

  const ffprobe = await resolveFfprobe();
  if (ffprobe) {
    const res = await run(
      [
        ffprobe,
        "-v",
        "error",
        "-print_format",
        "json",
        "-show_streams",
        "-show_format",
        "-show_chapters",
        filePath,
      ],
      signal,
    );
    signal?.throwIfAborted();
    const parsed =
      res.code === 0 ? fromFfprobeJson(filePath, res.stdout) : null;
    if (parsed) return { ...parsed, sizeBytes: parsed.sizeBytes ?? stat.size };
  }

  let ffmpeg: string;
  try {
    const binary = await resolveBinary("ffmpeg", "-version");
    if (!binary) return null;
    ffmpeg = binary.path;
  } catch {
    return null;
  }

  // No output file: ffmpeg prints the probe and exits 1. `-nostdin` stops it
  // swallowing the parent's stdin on some builds.
  const res = await run(
    [ffmpeg, "-nostdin", "-hide_banner", "-i", filePath],
    signal,
  );
  const parsed = fromFfmpegOutput(filePath, res.stderr);
  if (parsed) return { ...parsed, sizeBytes: parsed.sizeBytes ?? stat.size };

  // Recognisable media but nothing parseable: still record the size so the
  // integrity check has something to compare against.
  return null;
}

/** Cheap existence + size check, used before trusting a stored fingerprint. */
export function fileSizeNow(filePath: string): number | undefined {
  return safeStat(filePath)?.size;
}

/**
 * Stable-enough identity for a file during one planning wave. The planner only
 * shares this across concurrent checks in the same request; it is never a
 * long-lived substitute for a fresh ffprobe after a later request.
 */
export function fileSignature(filePath: string): string | undefined {
  const stat = safeStat(filePath);
  if (!stat) return undefined;
  return `${stat.size}:${stat.mtimeMs}:${stat.ino ?? ""}`;
}

const inspections = new SharedWork<FileFingerprint | null>();
export function inspectFile(
  filePath: string,
  signal?: AbortSignal,
): Promise<FileFingerprint | null> {
  const signature = fileSignature(filePath);
  if (!signature) return Promise.resolve(null);
  return inspections.run(
    path.resolve(filePath) + "|" + signature,
    (sharedSignal) =>
      pools.probe.run(
        () => inspectFileOnce(filePath, sharedSignal),
        sharedSignal,
      ),
    signal,
  );
}
