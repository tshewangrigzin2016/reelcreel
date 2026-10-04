import type { DownloadOptions, Preset } from "../../shared/types";

/**
 * How to produce this preset's audio with ffmpeg directly, for the case where
 * we already hold the media and only the container/codec differs.
 */
export interface AudioConvertSpec {
  /** ffmpeg encoder name. */
  codec: string;
  /** Constant bitrate in kbps. Omitted for VBR and lossless targets. */
  abrKbps?: number;
  /** Quality flags used when there is no bitrate target. */
  qualityArgs?: string[];
}

export interface PresetDef extends Preset {
  build: () => string[];
  /** Present on audio presets; describes the encode ffmpeg should do. */
  audioConvert?: AudioConvertSpec;
}

/**
 * Defaults follow the brief: video = MP4, audio = MP3 at the highest bitrate.
 *
 * Note the split between `instant` (remux — copies existing streams, seconds,
 * no quality loss) and everything else (re-encode — slower, lossy). The UI
 * surfaces this so a 3s job and a 3min job don't look identical.
 */
export const PRESETS: PresetDef[] = [
  {
    id: "mp4-h264",
    label: "MP4 · H.264 + AAC",
    group: "video",
    ext: "mp4",
    instant: true,
    note: "Default. Remux — plays everywhere, no re-encode.",
    build: () => [
      "-f",
      "bv*[vcodec^=avc][ext=mp4]+ba[acodec^=mp4a][ext=m4a]/b[vcodec^=avc][acodec^=mp4a][ext=mp4]",
      "--merge-output-format",
      "mp4",
    ],
  },
  {
    id: "mp4-best",
    label: "MP4 · best quality",
    group: "video",
    ext: "mp4",
    instant: true,
    note: "Highest MP4-compatible stream. Still a remux.",
    build: () => [
      "-f",
      // Deliberately restricted to ext=mp4: plain `bv` can pick VP9, which
      // remuxes into MP4 legally but won't play in QuickTime or on consoles.
      "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]",
      "--merge-output-format",
      "mp4",
    ],
  },
  {
    id: "mkv-max",
    label: "MKV · maximum fidelity",
    group: "video",
    ext: "mkv",
    instant: true,
    note: "4K/8K, HDR and Opus. Best container for high-end formats.",
    build: () => [
      "-f",
      "bv+ba/b",
      "--merge-output-format",
      "mkv",
      "--remux-video",
      "mkv",
    ],
  },
  {
    id: "webm",
    label: "WEBM",
    group: "video",
    ext: "webm",
    instant: true,
    build: () => [
      "-f",
      "bv[ext=webm][vcodec~='^(vp9|vp8|av01)']+ba[ext=webm][acodec~='^(opus|vorbis)']/b[ext=webm][vcodec~='^(vp9|vp8|av01)'][acodec~='^(opus|vorbis)']",
      "--merge-output-format",
      "webm",
      "--remux-video",
      "webm",
    ],
  },
  {
    id: "mp3-320",
    label: "MP3 · 320 kbps",
    group: "audio",
    ext: "mp3",
    instant: false,
    note: "Default. Highest MP3 bitrate.",
    build: () => ["-x", "--audio-format", "mp3", "--audio-quality", "320K"],
    audioConvert: { codec: "libmp3lame", abrKbps: 320 },
  },
  {
    id: "mp3-v0",
    label: "MP3 · V0 (best VBR)",
    group: "audio",
    ext: "mp3",
    instant: false,
    note: "Same quality target as 320k, smaller file.",
    build: () => ["-x", "--audio-format", "mp3", "--audio-quality", "0"],
    audioConvert: { codec: "libmp3lame", qualityArgs: ["-q:a", "0"] },
  },
  {
    id: "m4a",
    label: "M4A · native AAC",
    group: "audio",
    ext: "m4a",
    instant: true,
    note: "Copies native AAC into M4A without re-encoding; bitrate depends on the source.",
    build: () => ["-f", "ba[acodec^=mp4a][ext=m4a]", "--remux-video", "m4a"],
    audioConvert: { codec: "aac" },
  },
  {
    id: "opus",
    label: "WebM · native Opus",
    group: "audio",
    ext: "webm",
    instant: true,
    note: "No re-encode at all — the best real quality per megabyte.",
    build: () => ["-f", "ba[acodec=opus][ext=webm]"],
    audioConvert: { codec: "libopus" },
  },
  {
    id: "flac",
    label: "FLAC · lossless",
    group: "audio",
    ext: "flac",
    instant: false,
    note: "Lossless container around a lossy source — bigger, not better.",
    build: () => ["-x", "--audio-format", "flac"],
    audioConvert: { codec: "flac" },
  },
];

export const DEFAULT_VIDEO_PRESET = "mp4-h264";
export const DEFAULT_AUDIO_PRESET = "mp3-320";

export function getPreset(id: string): PresetDef | undefined {
  return PRESETS.find((p) => p.id === id);
}

/** The extension yt-dlp actually writes, not merely the UI label. */
export function actualExtForPreset(preset: PresetDef): string {
  // Native Opus is delivered in a WebM container by yt-dlp. The "opus" label
  // describes the codec, while the on-disk format is still WebM.
  return preset.id === "opus" ? "webm" : preset.ext;
}

export function presetList(): Preset[] {
  return PRESETS.map(
    ({ build: _build, audioConvert: _audioConvert, ...rest }) => rest,
  );
}

/**
 * Full yt-dlp argv for a job: chosen format plus whatever extras are enabled.
 * The output template is appended by the caller, which needs to control its
 * position relative to other flags.
 */
export function buildDownloadArgs(
  presetId: string,
  options: DownloadOptions,
): string[] {
  const preset = getPreset(presetId);
  if (!preset) throw new Error("Unknown preset: " + presetId);
  const args: string[] = [
    ...buildSourceArgs(preset, options),
    "--no-playlist",
    "--continue",
    "--no-overwrites",
  ];

  if (options.subtitles) {
    if (options.subtitleSource !== "manual") args.push("--write-auto-subs");
    if (options.subtitleSource !== "automatic") args.push("--write-subs");
    args.push("--sub-langs", options.subtitleLangs || "en.*");
    if (options.subtitleMode !== "sidecar") args.push("--embed-subs");
  }

  if (options.embedThumbnail) args.push("--embed-thumbnail");
  if (options.embedMetadata) args.push("--add-metadata");
  if (options.embedChapters) args.push("--embed-chapters");

  if (options.sponsorblock) {
    args.push("--sponsorblock-remove", "sponsor,intro,outro,selfpromo");
  }

  return args;
}

export function buildSourceArgs(
  preset: PresetDef,
  options: DownloadOptions,
): string[] {
  const args = preset.build();
  if (options.maxHeight && preset.group === "video") {
    const index = args.indexOf("-f");
    if (index >= 0)
      args[index + 1] = args[index + 1].replace(
        /\b(bv\*?|b)(?=\[|\+|\/|$)/g,
        "$1[height<=" + options.maxHeight + "]",
      );
  }
  if (options.audioLanguage) {
    let index = args.indexOf("-f");
    if (index < 0) {
      args.push("-f", "ba/b");
      index = args.length - 2;
    }
    const original = args[index + 1];
    const preferred = original.replace(
      /\b(ba|b)(?=\[|\+|\/|$)/g,
      "$1[language^=" + options.audioLanguage + "]",
    );
    args[index + 1] = preferred + "/" + original;
  }
  return args;
}
export function needsEncoder(
  presetId: string,
  options: DownloadOptions,
): boolean {
  return ["mp3-320", "mp3-v0", "flac"].includes(presetId) || !!options.sponsorblock;
}
