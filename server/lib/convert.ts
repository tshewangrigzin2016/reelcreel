import { managedProcess } from "./process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Subprocess } from "bun";
import type { FileFingerprint, SourceFingerprint } from "../../shared/types";
import { normalizeCodec } from "./fingerprint";
import { actualExtForPreset, type PresetDef } from "./presets";
import { resolveBinaries } from "./resolve-binary";
import { stripAnsi } from "./spawn";

/**
 * Turning a file we already have into the format that was asked for.
 *
 * This exists because re-downloading a video to change its container is pure
 * waste -- the media is already on disk. It is deliberately conservative: a
 * conversion is only offered when it costs nothing in quality (a remux), or
 * when the file we hold is genuinely better than what a fresh download would
 * return.
 */

/** Codecs each container will accept from a stream copy. */
const CONTAINER_VIDEO: Record<string, string[]> = {
  mp4: ["h264", "h265", "av1", "mpeg4"],
  mkv: ["h264", "h265", "vp8", "vp9", "av1"],
  webm: ["vp8", "vp9", "av1"],
};

const CONTAINER_AUDIO: Record<string, string[]> = {
  mp4: ["aac", "mp3", "ac3", "eac3", "alac"],
  mkv: ["aac", "opus", "vorbis", "mp3", "flac", "ac3", "eac3", "pcm", "alac"],
  webm: ["opus", "vorbis"],
};

/** Codecs that survive being re-encoded into anything without loss. */
const LOSSLESS_AUDIO = new Set(["flac", "alac", "pcm", "truehd"]);

const VIDEO_ENCODERS: Record<string, { codec: string; args: string[] }> = {
  h264: { codec: "libx264", args: ["-preset", "veryfast", "-crf", "20"] },
  h265: { codec: "libx265", args: ["-preset", "veryfast", "-crf", "25"] },
  vp9: {
    codec: "libvpx-vp9",
    args: ["-crf", "31", "-b:v", "0", "-row-mt", "1"],
  },
  av1: { codec: "libsvtav1", args: ["-crf", "30"] },
};

export interface ConversionPlan {
  /** ffmpeg argv, binary excluded. */
  args: string[];
  /** True for a straight stream copy: seconds, zero quality loss. */
  lossless: boolean;
  /** One line for the queue row, e.g. "Remux MKV → MP4". */
  note: string;
}

export interface ConversionInput {
  /** The file we already have, as measured by ffprobe. */
  source: FileFingerprint;
  /** What the site offers right now, i.e. what a fresh download would give. */
  target: SourceFingerprint;
  preset: PresetDef;
  outPath: string;
  /** Output metadata options from the request. Undefined preserves legacy behavior. */
  embedMetadata?: boolean;
  embedChapters?: boolean;
}

function metadataArgs(input: ConversionInput): string[] {
  return [
    "-map_metadata",
    input.embedMetadata === false ? "-1" : "0",
    "-map_chapters",
    input.embedChapters === false ? "-1" : "0",
  ];
}

/** `-movflags +faststart` only means anything for ISO-BMFF containers. */
function containerFlags(ext: string): string[] {
  return ext === "mp4" || ext === "m4a" || ext === "mov"
    ? ["-movflags", "+faststart"]
    : [];
}

function accepts(ext: string, vcodec?: string, acodec?: string): boolean {
  const videoOk = vcodec ? (CONTAINER_VIDEO[ext] ?? []).includes(vcodec) : true;
  const audioOk = acodec ? (CONTAINER_AUDIO[ext] ?? []).includes(acodec) : true;
  return videoOk && audioOk;
}

/**
 * Re-encoding audio is only worth it when the stream in our file is at least as
 * good as the one a download would fetch. Otherwise we would be asking ffmpeg
 * to make a lossy copy of an already-degraded stream, when re-downloading gets
 * us the original.
 */
function audioWorthReusing(
  source: FileFingerprint,
  target: SourceFingerprint,
): boolean {
  return !!source.acodec && source.acodec === target.acodec;
}

function atLeastTargetResolution(
  source: FileFingerprint,
  target: SourceFingerprint,
): boolean {
  if (source.height === undefined || target.height === undefined) return true;
  if (source.width === undefined || target.width === undefined) return true;
  return source.height >= target.height && source.width >= target.width;
}

function strictlyBetterResolution(
  source: FileFingerprint,
  target: SourceFingerprint,
): boolean {
  if (source.height === undefined || target.height === undefined) return false;
  return source.height > target.height;
}

/**
 * Decides whether the file we hold can become the file that was asked for, and
 * builds the ffmpeg command when it can. Returns null when re-downloading is
 * the better answer.
 */
export function buildConversion(input: ConversionInput): ConversionPlan | null {
  const { source, target, preset, outPath } = input;

  if (preset.group === "audio") return buildAudioConversion(input);

  // An audio-only file cannot become a video.
  if (!source.hasVideo) return null;

  const wantV = target.vcodec;
  const wantA = target.acodec ?? "aac";
  if (!wantV) return null;

  // Never hand back a smaller picture than a download would have produced.
  if (!atLeastTargetResolution(source, target)) return null;

  const from = source.ext.toUpperCase();
  const targetExt = actualExtForPreset(preset);
  const to = targetExt.toUpperCase();

  // Remux: the streams are exactly what the target container wants.
  if (
    source.vcodec === wantV &&
    source.acodec === wantA &&
    accepts(targetExt, wantV, wantA)
  ) {
    return {
      lossless: true,
      note: `Remux ${from} → ${to} · no re-encode`,
      args: [
        "-nostdin",
        "-n",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        source.path,
        "-map",
        "0:v:0",
        ...(source.hasAudio ? ["-map", "0:a:0?"] : []),
        // Subtitle and data streams are dropped on purpose: most of them cannot
        // be copied into a new container and abort the whole remux.
        "-sn",
        "-dn",
        "-c",
        "copy",
        ...metadataArgs(input),
        ...containerFlags(targetExt),
        outPath,
      ],
    };
  }

  // A larger picture is not proof that a lossy transcode preserves source quality.
  return null;
}

function buildAudioConversion(input: ConversionInput): ConversionPlan | null {
  const { source, target, preset, outPath } = input;

  // Nothing to extract -- an audio request against a silent video must download.
  if (!source.hasAudio) return null;

  const spec = preset.audioConvert;
  if (!spec) return null;

  const from = source.ext.toUpperCase();
  const targetExt = actualExtForPreset(preset);
  const to = targetExt.toUpperCase();
  const base = [
    "-nostdin",
    "-n",
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    source.path,
  ];
  const tail = [...metadataArgs(input), ...containerFlags(targetExt), outPath];
  const targetCodec = normalizeCodec(
    spec.codec === "libmp3lame"
      ? "mp3"
      : spec.codec === "libopus"
        ? "opus"
        : spec.codec,
  );

  // Remux: the codec is already right, only the container changes. A quality
  // mode such as MP3 V0 still needs an encode even though its codec family is
  // also MP3; copying a 320k CBR stream would silently ignore that selection.
  if (source.acodec === targetCodec && !spec.qualityArgs?.length) {
    // A CBR target cannot be reached by copying a lower-bitrate stream.
    if (
      spec.abrKbps &&
      source.abr !== undefined &&
      source.abr < spec.abrKbps * 0.95
    ) {
      return null;
    }
    return {
      lossless: true,
      note: `Remux ${from} → ${to} · no re-encode`,
      args: [...base, "-vn", "-c:a", "copy", "-sn", "-dn", ...tail],
    };
  }

  if (!audioWorthReusing(source, target)) return null;

  const quality = spec.abrKbps
    ? ["-b:a", `${spec.abrKbps}k`]
    : (spec.qualityArgs ?? []);

  return {
    lossless: false,
    note: `Convert ${from} → ${to} · ${spec.codec === "libmp3lame" ? "MP3" : spec.codec} encode`,
    args: [
      ...base,
      "-vn",
      "-c:a",
      spec.codec,
      ...quality,
      "-sn",
      "-dn",
      ...tail,
    ],
  };
}

/* -------------------------------------------------------------------------- *
 * Running it
 * -------------------------------------------------------------------------- */

export interface ConvertHandle {
  done: Promise<number>;
  cancel: () => Promise<void>;
  stderrText: () => string;
}

export interface ConvertRunOptions {
  /** ffmpeg argv excluding the binary, i.e. `plan.args`. */
  args: string[];
  /** Total duration of the input, used to turn `out_time` into a percentage. */
  durationSec?: number;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

const RE_OUT_TIME = /^out_time_ms=(\d+)$/;
const RE_OUT_TIME_US = /^out_time_us=(\d+)$/;

/**
 * Runs ffmpeg with machine-readable progress on stdout.
 *
 * `-progress pipe:1 -nostats` is the only combination that gives parseable
 * progress: the default output is `\r`-separated and sized for a terminal.
 * Percent is derived from `out_time` against the input duration, which is what
 * makes an encode look as smooth as a download.
 */
export async function runConversion(
  opts: ConvertRunOptions,
): Promise<ConvertHandle> {
  opts.signal?.throwIfAborted();
  const { ffmpeg } = await resolveBinaries();
  opts.signal?.throwIfAborted();
  return managedProcess({
    argv: [ffmpeg.path, "-progress", "pipe:1", "-nostats", ...opts.args],
    signal: opts.signal,
    onLine: (line) => {
      const match = line.match(/^out_time_us=(\d+)$/);
      if (match && opts.durationSec)
        opts.onProgress?.(
          Math.min(99, (Number(match[1]) / 1000000 / opts.durationSec) * 100),
        );
    },
  });
}

export function conversionError(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !/^\s*(frame|fps|bitrate|speed)\s*=/.test(l));
  for (let i = lines.length - 1; i >= 0; i--) {
    if (
      /error|invalid|failed|no such|unable|could not|not supported/i.test(
        lines[i]!,
      )
    ) {
      return lines[i]!;
    }
  }
  return lines.length ? lines[lines.length - 1]! : "ffmpeg failed.";
}

/**
 * Where the converted file should go.
 *
 * Derived from the existing filename rather than the yt-dlp template: the
 * template was already applied when the source was written, so reusing its
 * stem keeps converted files named consistently with downloaded ones and works
 * even for templates this code cannot expand.
 */
export function convertedPathFor(
  sourcePath: string,
  ext: string,
  outputDir: string,
): string {
  const stem = path.basename(sourcePath, path.extname(sourcePath));
  const safeExt = ext.replace(/^\./, "").toLowerCase();
  const sourceAbs = path.resolve(sourcePath);
  const dir = path.resolve(outputDir);
  const target = path.join(dir, `${stem}.${safeExt}`);

  let candidate =
    path.resolve(target) === sourceAbs
      ? path.join(dir, `${stem} (converted).${safeExt}`)
      : target;
  let suffix = 2;
  // Conversion commands use -y, so never point them at an unrelated existing
  // file. This also makes repeated format changes produce a traceable series
  // instead of silently replacing an older library entry.
  while (
    path.resolve(candidate) !== sourceAbs &&
    (existsSync(candidate) || existsSync(`${candidate}.lock`))
  ) {
    candidate = path.join(dir, `${stem} (converted ${suffix}).${safeExt}`);
    suffix += 1;
  }
  return candidate;
}
