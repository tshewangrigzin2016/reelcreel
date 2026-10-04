export type LineKind =
  | "progress"
  | "destination"
  | "postprocessing"
  | "error"
  | "info";

export interface ParsedLine {
  kind: LineKind;
  percent?: number;
  size?: string;
  speed?: string;
  eta?: string;
  filePath?: string;
  postprocessor?: string;
  error?: string;
  raw: string;
}

/**
 * yt-dlp right-pads these fields, so the whitespace between them is not
 * stable. Several small regexes rather than one mega-regex.
 */
// The completion line ("[download] 100% of 3.4MiB in 00:02 at 1.68MiB/s") uses
// "in", unlike the in-flight form which uses "at ... ETA ...". It carries the
// final speed, so capture it -- otherwise the last frame of every download
// blanks out the speed just as the job is about to finish.
const RE_DONE =
  /^\[download\]\s+100%\s+of\s+(?:~\s*)?([\d.]+\s*[KMGT]?i?B)\s+in\s+([\d:]+)(?:\s+at\s+([\d.]+\s*[KMGT]?i?B\/s))?/i;
const RE_FULL =
  /^\[download\]\s+(\d{1,3}(?:\.\d)?)%\s+of\s+(?:~\s*)?([\d.]+\s*[KMGT]?i?B)\s+at\s+([\d.]+\s*[KMGT]?i?B\/s|Unknown B\/s)\s+ETA\s+([\d:]+|Unknown)/i;
const RE_PCT =
  /^\[download\]\s+(\d{1,3}(?:\.\d)?)%\s+at\s+([\d.]+\s*[KMGT]?i?B\/s|Unknown B\/s)\s+ETA\s+([\d:]+|Unknown)/i;
const RE_BYTES =
  /^\[download\]\s+([\d.]+\s*[KMGT]?i?B)\s+at\s+([\d.]+\s*[KMGT]?i?B\/s)(?:\s+\(([\d:]+)\))?/i;
const RE_DEST = /^\[download\]\s+Destination:\s*(.+)$/i;
const RE_PP =
  /^\[(ExtractAudio|Merger|VideoRemuxer|VideoConvertor|EmbedSubtitle|EmbedThumbnail|Metadata|ModifyChapters|SplitChapters|Fixup\w+|SponsorBlock)\]\s*(.*)$/i;
const RE_ERR = /^ERROR:\s*(.+)$/i;

const FRIENDLY_PP: Record<string, string> = {
  ExtractAudio: "Extracting audio",
  Merger: "Merging streams",
  VideoRemuxer: "Remuxing",
  VideoConvertor: "Converting video",
  EmbedSubtitle: "Embedding subtitles",
  EmbedThumbnail: "Embedding thumbnail",
  Metadata: "Writing metadata",
  ModifyChapters: "Adding chapters",
  SplitChapters: "Splitting chapters",
  SponsorBlock: "Removing sponsor segments",
};

export function friendlyPostprocessor(name: string, detail?: string): string {
  const base = FRIENDLY_PP[name] ?? name;
  if (name === "ExtractAudio" && detail?.includes("Destination")) {
    return base;
  }
  if (detail && detail.trim()) {
    const d = detail.trim();
    return `${base}: ${d.length > 60 ? `${d.slice(0, 60)}…` : d}`;
  }
  return base;
}

/**
 * True for lines that are bare filesystem paths, i.e. the output of
 * `--print after_move:filepath`. Windows: C:\...  POSIX: /...
 */
export function isAbsolutePathLike(line: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(line) || line.startsWith("/");
}

const RE_SIZE = /^([\d.]+)\s*([KMGT]?)i?B$/i;
const SIZE_UNITS: Record<string, number> = {
  "": 1,
  K: 1024,
  M: 1024 ** 2,
  G: 1024 ** 3,
  T: 1024 ** 4,
};

/** "422.93KiB" -> 433082. Returns 0 when the text isn't a byte size. */
export function parseSizeToBytes(text: string): number {
  const m = text.trim().match(RE_SIZE);
  if (!m) return 0;
  const mult = SIZE_UNITS[(m[2] ?? "").toUpperCase()] ?? 1;
  const value = Number.parseFloat(m[1]);
  return Number.isFinite(value) ? value * mult : 0;
}

/** Inverse of the above, for totals we have summed ourselves. */
export function formatBytes(bytes: number): string {
  if (!(bytes > 0)) return "0B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 || value >= 100 ? value.toFixed(0) : value.toFixed(1)}${units[unit]}`;
}

export function parseLine(raw: string): ParsedLine | null {
  const line = raw.trim();
  if (!line) return null;

  let m = line.match(RE_DEST);
  if (m) return { kind: "destination", filePath: m[1].trim(), raw: line };

  m = line.match(RE_DONE);
  if (m) {
    return {
      kind: "progress",
      percent: 100,
      size: m[1].replace(/\s+/g, " "),
      eta: "00:00",
      speed: m[3]?.replace(/\s+/g, " "),
      raw: line,
    };
  }

  m = line.match(RE_FULL);
  if (m) {
    return {
      kind: "progress",
      percent: Number.parseFloat(m[1]),
      size: m[2].replace(/\s+/g, " "),
      speed: m[3] === "Unknown B/s" ? undefined : m[3].replace(/\s+/g, " "),
      eta: m[4] === "Unknown" ? undefined : m[4],
      raw: line,
    };
  }

  m = line.match(RE_PCT);
  if (m) {
    return {
      kind: "progress",
      percent: Number.parseFloat(m[1]),
      speed: m[2] === "Unknown B/s" ? undefined : m[2].replace(/\s+/g, " "),
      eta: m[3] === "Unknown" ? undefined : m[3],
      raw: line,
    };
  }

  m = line.match(RE_BYTES);
  if (m) {
    // "[download] 3.50MiB at 1.20MiB/s" reports how much has arrived, not the
    // total -- yt-dlp only emits it when the total is unknown. Deliberately no
    // `size`, so it can't be mistaken for the stream's total and shrink the
    // figure the queue is already showing.
    return {
      kind: "progress",
      speed: m[2].replace(/\s+/g, " "),
      raw: line,
    };
  }

  m = line.match(RE_PP);
  if (m) {
    return {
      kind: "postprocessing",
      postprocessor: friendlyPostprocessor(m[1], m[2]),
      raw: line,
    };
  }

  m = line.match(RE_ERR);
  if (m) return { kind: "error", error: m[1].trim(), raw: line };

  return { kind: "info", raw: line };
}

/** The last `ERROR:` line, falling back to the final non-empty line. */
export function lastErrorLine(text: string): string | null {
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^ERROR:/i.test(lines[i]!)) return lines[i]!.replace(/^ERROR:\s*/i, "");
  }
  return lines.length ? lines[lines.length - 1]! : null;
}

/** Transient failures are worth retrying; content-level ones never are. */
export function isTransientError(message: string): boolean {
  const t = message.toLowerCase();
  if (
    t.includes("video unavailable") ||
    t.includes("private video") ||
    t.includes("does not exist") ||
    t.includes("removed by the uploader") ||
    t.includes("confirm your age") ||
    t.includes("sign in to confirm") ||
    t.includes("not available in your country")
  ) {
    return false;
  }
  return (
    t.includes("timed out") ||
    t.includes("connection") ||
    t.includes("temporary failure") ||
    t.includes("500") ||
    t.includes("502") ||
    t.includes("503") ||
    t.includes("504") ||
    t.includes("http error 5") ||
    t.includes("unable to download") ||
    t.includes("fragment") ||
    t.includes("too many requests") ||
    t.includes("429")
  );
}
