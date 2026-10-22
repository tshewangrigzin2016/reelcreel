export type JobPhase =
  | "paused"
  | "scheduled"
  | "queued"
  | "probing"
  | "downloading"
  | "postprocessing"
  /** Re-using a file we already have: ffmpeg remux/re-encode instead of a fetch. */
  | "converting"
  | "done"
  /** Nothing to do -- an identical copy is already on disk. */
  | "skipped"
  | "error"
  | "cancelled";

export interface BinaryInfo {
  path: string;
  version: string;
}

export interface HealthInfo {
  ok: boolean;
  ytdlp: BinaryInfo | null;
  ffmpeg: BinaryInfo | null;
  node: BinaryInfo | null;
  ffprobe?: BinaryInfo | null;
  runtime?: BinaryInfo | null;
  ejs?: { available: boolean; detail: string };
  error?: string;
}

/**
 * Summary of the configured cookies file. Deliberately contains no cookie
 * values: it is rendered in Settings and returned by the API.
 */
export interface CookiesInfo {
  configured: boolean;
  path?: string;
  entries: number;
  youtubeEntries: number;
  bytes: number;
  updatedAt?: string;
  error?: string;
}

export interface CookiesUploadResult {
  ok: true;
  info: CookiesInfo;
  settings: Settings;
}

export interface CookiesTestResult {
  ok: boolean;
  /** True when yt-dlp reached YouTube and read a video without a sign-in wall. */
  authenticated: boolean;
  /** True when YouTube demanded a sign-in ("not a bot") during the probe. */
  signInRequired: boolean;
  detail: string;
  /**
   * The video actually probed. When a download has already failed with a
   * sign-in wall, its video is used, because a popular test video can pass
   * while the user's own video is still blocked.
   */
  testedUrl: string;
  cookies: CookiesInfo;
}

export interface VideoMeta {
  id: string;
  title: string;
  uploader?: string;
  thumbnail: string;
  duration?: number;
  viewCount?: number;
  uploadDate?: string;
  description?: string;
  webpageUrl?: string;
  extractor?: string;
  availability?: string;
  liveStatus?: string;
  isLive: boolean;
  thumbnails?: string[];
}

export interface PlaylistEntry {
  id: string;
  title: string;
  index: number;
  duration?: number;
  viewCount?: number;
  thumbnail: string;
  url: string;
  availability?: string;
  liveStatus?: string;
  isLive: boolean;
}

/**
 * How clicking a playlist entry changes the selection.
 *  - single: clicking replaces the selection with exactly that one video
 *  - multiple: clicking toggles; shift-click fills a range
 *  - all: every video is selected (individual deselect drops back to multiple)
 */
export type SelectionMode = "single" | "multiple" | "all";

export interface PlaylistMeta {
  id: string;
  title: string;
  uploader?: string;
  entryCount?: number;
  webpageUrl?: string;
  truncated: boolean;
  /** Auto-generated "Mix" (list=RD…), which is capped lower than a real playlist. */
  radio?: boolean;
  /**
   * True when these entries came from a pasted list of individual video URLs
   * rather than from a real playlist.
   *
   * A batch reuses the playlist selection pipeline -- same table, same format
   * card, same re-check -- but there is no playlist URL behind it. Downloads
   * made from a batch therefore record a title and fingerprint only, and the
   * server must never be handed an invented playlist URL.
   */
  batch?: boolean;
}

export type ProbeKind = "video" | "playlist";

export interface VideoProbe {
  kind: "video";
  video: VideoMeta;
}

export interface PlaylistProbe {
  kind: "playlist";
  playlist: PlaylistMeta;
  entries: PlaylistEntry[];
}

export type ProbeResult = VideoProbe | PlaylistProbe;

/**
 * Cheap "is this playlist real?" answer: just the first entry and enough
 * playlist identity to caption it. Fetched as soon as a playlist URL is typed,
 * long before the full enumeration finishes.
 */
export interface PlaylistPreview {
  playlistTitle?: string;
  entryCount?: number;
  radio?: boolean;
  entry: PlaylistEntry;
}

/** What /api/probe returns: a single video, or a playlist plus its flat entries. */
export interface ProbeOutcome {
  kind: "video" | "playlist";
  video?: VideoMeta;
  playlist?: PlaylistMeta;
  entries: PlaylistEntry[];
}

/* ------------------------------------------------------------------------- *
 * De-duplication fingerprints
 * ------------------------------------------------------------------------- */

/** A single source stream selected by yt-dlp. */
export interface SourceStreamFingerprint {
  /** Exact yt-dlp format id for this stream. */
  formatId: string;
  ext?: string;
  protocol?: string;
  container?: string;
  width?: number;
  height?: number;
  resolution?: string;
  fps?: number;
  /** Normalised codec names (`h264`, `vp9`, `aac`, `opus`, ...). */
  vcodec?: string;
  acodec?: string;
  profile?: string;
  pixFmt?: string;
  dynamicRange?: string;
  /** kbps. */
  vbr?: number;
  abr?: number;
  tbr?: number;
  /** Audio sample rate, Hz. */
  asr?: number;
  channels?: number;
  language?: string;
  filesizeBytes?: number;
  filesizeApproxBytes?: number;
}

export type FingerprintScalar = string | number | boolean | null;

/**
 * What the *site* offers, independent of anything we chose.
 *
 * Recorded alongside every completed download. A later request is only a
 * duplicate when this still matches exactly, so a 1080p copy does not satisfy
 * a request once 4K appears, a renamed video counts as new content, and a
 * changed source file size is visible to the decision engine.
 */
export interface SourceFingerprint {
  /** Bumped whenever the compared attribute set changes. */
  fingerprintVersion?: number;
  /** Stable upstream identity. */
  videoId?: string;
  /** Title upstream at the time. A rename is a real difference. */
  title: string;
  uploader?: string;
  channelId?: string;
  uploadDate?: string;
  /** Combined yt-dlp format ids, e.g. `137+140`. */
  formatId?: string;
  videoFormatId?: string;
  audioFormatId?: string;
  sourceExt?: string;
  protocol?: string;
  container?: string;
  formatNote?: string;
  quality?: string;
  resolution?: string;
  dynamicRange?: string;
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  /** Normalised codec names (`h264`, `vp9`, `aac`, `opus`, ...). */
  vcodec?: string;
  acodec?: string;
  profile?: string;
  pixFmt?: string;
  /** kbps. */
  vbr?: number;
  abr?: number;
  tbr?: number;
  /** Audio sample rate, Hz. */
  asr?: number;
  channels?: number;
  /** Exact or approximate size reported by the selected source. */
  sourceSizeBytes?: number;
  sourceSizeApproxBytes?: number;
  /** Every selected stream, retained so a combined format cannot hide a change. */
  selectedFormats?: SourceStreamFingerprint[];
  /** Stable, non-volatile upstream metadata (never signed URLs or view counts). */
  metadata?: Record<string, FingerprintScalar>;
  extractor?: string;
}

/** What actually landed on disk, measured after the job finished. */
export interface FileFingerprint {
  /** Bumped whenever the compared attribute set changes. */
  fingerprintVersion?: number;
  path: string;
  ext: string;
  container?: string;
  formatName?: string;
  formatLongName?: string;
  sizeBytes?: number;
  durationSec?: number;
  width?: number;
  height?: number;
  fps?: number;
  vcodec?: string;
  acodec?: string;
  profile?: string;
  pixFmt?: string;
  dynamicRange?: string;
  /** kbps. */
  vbr?: number;
  abr?: number;
  tbr?: number;
  asr?: number;
  channels?: number;
  formatBitrate?: number;
  sampleFmt?: string;
  streamCount?: number;
  videoStreamCount?: number;
  audioStreamCount?: number;
  subtitleStreamCount?: number;
  dataStreamCount?: number;
  chapterCount?: number;
  hasChapters?: boolean;
  languages?: string[];
  /** Stable ffprobe metadata, excluding volatile encoder timestamps. */
  metadata?: Record<string, FingerprintScalar>;
  hasVideo: boolean;
  hasAudio: boolean;
}

/** Context retained for downloads made from a playlist's selection table. */
export interface PlaylistDownloadContext {
  playlistId?: string;
  playlistUrl?: string;
  playlistTitle?: string;
  entryIndex?: number;
  selectionMode?: SelectionMode;
  selectionCount?: number;
  /** Stable sorted ids of the selection at queue time. */
  selectionFingerprint?: string;
}

/**
 * Stable identity of "what the user asked for", independent of the source.
 *
 * Two requests with the same key produce byte-comparable output. Everything a
 * request can still express belongs here, so any change to the *result* is
 * visible as a key change.
 *
 * `clipStart`/`clipEnd`/`accurateClips` are **legacy read-only**. The clip
 * feature has been removed, so nothing writes them any more -- but keys
 * already stored in SQLite contain them, and `server/lib/plan.ts` has to keep
 * reading them to classify those rows correctly. Never add them back to
 * `buildRequestKey`.
 */
export interface RequestKeyParts {
  presetId: string;
  embedThumbnail: boolean;
  embedMetadata: boolean;
  embedChapters: boolean;
  subtitles: boolean;
  subtitleLangs: string;
  sponsorblock: boolean;
  /** @deprecated legacy read-only; see the note above. */
  clipStart?: string;
  /** @deprecated legacy read-only; see the note above. */
  clipEnd?: string;
  maxHeight?: number;
  audioLanguage?: string;
  subtitleSource?: string;
  subtitleMode?: string;
  /** @deprecated legacy read-only; see the note above. */
  accurateClips?: boolean;
}

export interface DownloadRecord {
  videoId: string;
  presetId: string;
  /** Hash of the RequestKeyParts above. */
  requestKey: string;
  source: SourceFingerprint;
  file: FileFingerprint;
  playlist?: PlaylistDownloadContext;
}

export type PlanAction = "download" | "skip" | "convert";

/** One attribute that differs between what we have and what is available. */
export interface SkipDiff {
  field: string;
  label: string;
  from?: string;
  to?: string;
}

export interface DownloadPlan {
  action: PlanAction;
  /** Shown on the queue row, so the decision is never silent. */
  reason: string;
  /** Attribute-level differences that forced this decision. */
  diffs: SkipDiff[];
  /** Existing file that satisfies (or can be turned into) this request. */
  existingPath?: string;
  /** What the site offers right now. */
  source?: SourceFingerprint;
  /** ffmpeg argv when `action === "convert"`. */
  convertArgs?: string[];
  /** Where `convertArgs` writes. Tracked separately so callers never have to
   *  reach into the argv to find the destination. */
  convertOutPath?: string;
  /** True when the conversion is a straight stream copy: instant, lossless. */
  lossless?: boolean;
}

/* ------------------------------------------------------------------------- *
 * Re-evaluating a selection or the whole library
 *
 * The single-item planner answers "what should this download do?". These types
 * answer the same question for many items at once, which is what makes a change
 * of format propagate: the UI re-plans everything it is showing, and can then
 * act on only the rows that came back as `convert` or `download`.
 * ------------------------------------------------------------------------- */

/** One outcome of re-planning a selection, keyed back to the item that produced it. */
export interface PlanBatchEntry {
  /** Echoed from the request so the client can match rows without re-ordering. */
  url: string;
  videoId?: string;
  title?: string;
  action: PlanAction;
  reason: string;
  diffs: SkipDiff[];
  /**
   * Differences in playlist/selection context only.
   *
   * Reported, never decisive: the same video reached from a playlist is still
   * the same media, so a different selection must not by itself force a
   * re-download. It is shown so a change in *how* the video was reached is
   * visible rather than silently ignored.
   */
  playlistDiffs?: SkipDiff[];
  existingPath?: string;
  /** True when `action` is a conversion that only copies streams. */
  lossless?: boolean;
  error?: string;
}

export interface PlanBatchResult {
  entries: PlanBatchEntry[];
  counts: Record<PlanAction, number> & { error: number };
}

/** A stored library row after being re-checked against the current selection. */
export interface SyncEntry {
  /** History row id, so the UI can map the result back to the entry it showed. */
  historyId: string;
  videoId: string;
  title: string;
  action: PlanAction;
  reason: string;
  diffs: SkipDiff[];
  existingPath?: string;
  /** Present only when `apply` was set and work was actually queued. */
  jobId?: string;
  error?: string;
}

export interface SyncRequest {
  presetId: string;
  options?: Partial<DownloadOptions>;
  /** Limit the sweep to these history rows. Omitted means the whole library. */
  historyIds?: string[];
  /** Queue the work rather than only reporting what would happen. */
  apply?: boolean;
}

export interface SyncResult {
  entries: SyncEntry[];
  counts: Record<PlanAction, number> & { error: number };
  /** How many jobs were queued. Zero when `apply` was not set. */
  queued: number;
  /** True when the sweep stopped early because it ran out of time or items. */
  truncated: boolean;
  checked?: number;
  unchecked?: number;
  failed?: number;
  total?: number;
}

/**
 * Who ends up holding a finished file.
 *
 * `server` keeps it in the output folder -- the original local-downloader
 * behaviour, and the only mode where skip-existing, convert-instead and
 * open/reveal mean anything. `browser` streams it out and deletes it.
 */
export type DeliveryMode = "server" | "browser";

/**
 * What happened to a finished job's bytes.
 *
 * Deliberately orthogonal to `JobPhase`. A phase says what the server is doing
 * right now; this says where the media went. Keeping them apart means `done`
 * keeps its existing meaning ("produced and verified") and the terminal-phase
 * set, the row badge ladder and every phase-based test are untouched.
 */
export type DeliveryState =
  /** Server mode: nothing is delivered, the file stays put. */
  | "not-applicable"
  /** Browser mode: finished, waiting for the browser to ask for it. */
  | "pending"
  /** Browser mode: a response is in flight. */
  | "streaming"
  /** Browser mode: a delivery attempt ended early. Retried up to a limit. */
  | "failed"
  /** Browser mode: every file reached the browser; the server copy is gone. */
  | "delivered"
  /** Browser mode: deleted without reaching the browser. */
  | "expired";

/** One file a browser-mode job has ready to deliver. */
export interface DeliveryFile {
  /** Name offered to the browser. Never a path: paths stay server-side. */
  name: string;
  sizeBytes: number;
}

export interface DeliveryInfo {
  state: DeliveryState;
  /** Failed delivery attempts. Reaching the configured limit expires the job. */
  attempts: number;
  /**
   * Index 0 is always the media file; sidecar captions follow. A job with no
   * captions has exactly one entry.
   */
  files: DeliveryFile[];
  /** When the media became ready, used to expire the oldest first. */
  readyAt: number;
  /** Why it expired, shown in the queue instead of a generic failure. */
  reason?: string;
}

export interface JobState {
  id: string;
  videoId?: string;
  title: string;
  thumbnail?: string;
  phase: JobPhase;
  percent: number;
  size?: string;
  speed?: string;
  eta?: string;
  postprocessor?: string;
  filePath?: string;
  error?: string;
  presetId: string;
  playlistIndex?: number;
  attempts: number;
  order?: number;
  stagingDir?: string;
  scheduledAt?: number;
  logs?: string[];
  recoveryNote?: string;
  /** Why the job was skipped, or what changed to force a fresh download. */
  planNote?: string;
  /** Attribute differences behind `planNote`. */
  diffs?: SkipDiff[];
  /** True when this row finished by re-using a file already on disk. */
  reused?: boolean;
  /** Selection-table context, when this job came from a playlist. */
  playlist?: PlaylistDownloadContext;
  /**
   * Delivery bookkeeping, present only in browser mode once the media is ready.
   *
   * Lives on the job rather than only on the history row because the job is the
   * authority: it is persisted whole in the queue table and broadcast over SSE,
   * so delivery progress needs no new event type and survives a restart.
   */
  delivery?: DeliveryInfo;
}

/** One video queued for download (a playlist selection is an array of these). */
export interface DownloadItem {
  url: string;
  videoId?: string;
  title?: string;
  thumbnail?: string;
  playlistIndex?: number;
  playlist?: PlaylistDownloadContext;
}

export interface DownloadRequest {
  url: string;
  presetId: string;
  options: DownloadOptions;
  outputDir: string;
  outputTemplate: string;
  playlistIndex?: number;
  videoId?: string;
  title?: string;
  thumbnail?: string;
  playlist?: PlaylistDownloadContext;
  /** Internal opt-in for callers that deliberately accept a cached source probe. */
  revalidate?: boolean;
  scheduledAt?: number;
  /**
   * Which caller queued this, for the per-visitor queue cap.
   *
   * Server-derived, never read from a request body: a client that could set
   * this could shed its own limit by changing it. Absent for jobs restored from
   * a database written before the cap existed, which are simply not counted.
   */
  clientIp?: string;
}

export interface DownloadOptions {
  embedThumbnail: boolean;
  embedMetadata: boolean;
  embedChapters: boolean;
  subtitles: boolean;
  subtitleLangs: string;
  sponsorblock: boolean;
  maxHeight?: number;
  audioLanguage?: string;
  subtitleSource?: "manual" | "automatic" | "both";
  subtitleMode?: "sidecar" | "embedded";
}

/** Wire-safe descriptor (no functions) sent to the browser. */
export interface Preset {
  id: string;
  label: string;
  group: "video" | "audio";
  ext: string;
  /** Remux rather than re-encode — finishes in seconds with zero quality loss. */
  instant: boolean;
  note?: string;
}

export interface Settings {
  conversionConcurrency: number;
  jsRuntime: "node" | "deno";
  runtimePath?: string;
  cookiesPath?: string;
  ytdlpPath?: string;
  ffmpegPath?: string;
  outputDir: string;
  outputTemplate: string;
  playlistCap: number;
  /**
   * The number of real, simultaneous network transfers. This is the only
   * limit on transfer parallelism -- there is no separate per-request fragment
   * fan-out, so total connection count is exactly this number.
   */
  downloadConcurrency: number;
  /** Concurrent yt-dlp source probes and ffprobe runs. */
  probeConcurrency: number;
  /**
   * Skip a download when an identical copy is already on disk. "Identical"
   * means every attribute still matches -- title, format ids, resolution,
   * codecs, bitrates, duration, container and file size.
   */
  skipExisting: boolean;
  /**
   * When the attributes match but the requested format differs, remux or
   * re-encode the file we already have with ffmpeg instead of fetching it
   * again. Only used when re-using loses nothing versus a fresh download.
   */
  convertInstead: boolean;
  /**
   * Whether finished media is kept on this machine or handed to the browser.
   * See `DeliveryMode`. Browser mode makes `outputDir`, `skipExisting` and
   * `convertInstead` irrelevant, because nothing is retained to compare against.
   */
  deliveryMode: DeliveryMode;
  /**
   * Where browser-mode media waits to be delivered. Kept separate from
   * `outputDir` so transient files never mix with a real media collection.
   */
  tempDir: string;
  /** Ceiling for transient media; the oldest pending file is evicted past it. */
  tempCapMb: number;
  /** How long a finished file may wait for the browser before it is deleted. */
  deliveryTtlMinutes: number;
  /** Failed delivery attempts tolerated before the file is deleted. */
  deliveryMaxAttempts: number;
}

export interface HistoryRow {
  provenance?:
    | "original"
    | "lossless-copy"
    | "encoded"
    | "transformed"
    | "unknown";
  missing?: boolean;
  id: string;
  /**
   * Where the media came from. Required to re-check a stored row later: a
   * library sweep has to ask the site what it offers *now*, and a video id
   * alone is not a URL for every extractor.
   */
  url?: string;
  videoId: string;
  title: string;
  uploader?: string;
  thumbnail?: string;
  filePath?: string;
  presetId: string;
  ext?: string;
  sizeBytes?: number;
  duration?: number;
  completedAt: number;
  /** Stable hash of the request (preset + output options). */
  requestKey?: string;
  /** What the site offered when this was downloaded. */
  source?: SourceFingerprint;
  /** What landed on disk, measured with ffprobe. */
  file?: FileFingerprint;
  /** Selection-table context, when this row came from a playlist. */
  playlist?: PlaylistDownloadContext;
  /**
   * How the media was handed over. Absent on server-mode rows, where the file
   * is simply still on disk.
   */
  delivery?: DeliveryInfo;
}

export type SettingsUpdate = {
  [K in keyof Settings]?:
    | Settings[K]
    | (undefined extends Settings[K] ? null : never);
};
export interface SourceFormat {
  id: string;
  ext: string;
  width?: number;
  height?: number;
  fps?: number;
  vcodec?: string;
  acodec?: string;
  hdr?: string;
  language?: string;
  size?: number;
  estimated?: boolean;
}
export interface FormatDiscovery {
  formats: SourceFormat[];
  subtitles: string[];
  automaticCaptions: string[];
  chapters: Array<{ title: string; start: number; end: number }>;
}
export interface LibraryPage {
  rows: HistoryRow[];
  total: number;
  page: number;
  pageSize: number;
}
export interface DownloadProfile {
  id: string;
  name: string;
  presetId: string;
  options: DownloadOptions;
  outputDir?: string;
  outputTemplate?: string;
}
export interface SyncTask {
  applied?: boolean;
  id: string;
  state: "running" | "done" | "cancelled" | "error";
  result?: SyncResult;
  error?: string;
  checked: number;
  total: number;
}

/* ------------------------------------------------------------------------- *
 * Explore search (YouTube-like, powered by yt-dlp ytsearch)
 * ------------------------------------------------------------------------- */

export type SearchKind = "video" | "short" | "channel" | "playlist" | "live";

export interface SearchResult {
  id: string;
  kind: SearchKind;
  title: string;
  channel?: string;
  channelId?: string;
  channelUrl?: string;
  thumbnail: string;
  url: string;
  duration?: number;
  viewCount?: number;
  subscriberCount?: number;
  videoCount?: number;
  description?: string;
  liveStatus?: string;
  /** 0-100 relevance score from the match algorithm (higher = better). */
  score: number;
}

export type SearchSort = "relevance" | "views" | "recent";

export interface SearchResponse {
  query: string;
  count: number;
  truncated: boolean;
  results: SearchResult[];
}

/* ------------------------------------------------------------------------- *
 * Channel / playlist listing (Explore drill-in, paginated for lazy scroll)
 * ------------------------------------------------------------------------- */

/** One page of a channel's uploads or a playlist's entries. */
export interface ListingResponse {
  /** Echoed normalized URL the listing was read from. */
  url: string;
  title?: string;
  uploader?: string;
  entries: PlaylistEntry[];
  /** True when another page is likely available (entries.length === limit). */
  hasMore: boolean;
  /** 1-based index of the first entry in this page. */
  start: number;
}
