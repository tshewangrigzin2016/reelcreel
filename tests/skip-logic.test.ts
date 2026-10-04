import { beforeEach, describe, expect, it, mock } from "bun:test";
import type {
  DownloadItem,
  DownloadOptions,
  FileFingerprint,
  HistoryRow,
  PlaylistDownloadContext,
  SourceFingerprint,
} from "../shared/types";

/**
 * The de-duplication rule, expressed as executable expectations.
 *
 * The contract: a download is skipped only when *every* attribute that is
 * knowable on both sides is equal. Anything else -- a new 4K rendition, a
 * renamed video, a truncated file, a different container -- must fetch.
 */

/* -------------------------------------------------------------------------- *
 * Module stubs
 *
 * mock.module must run before the module under test is imported, which is why
 * plan.ts is pulled in with a dynamic import below rather than at the top.
 * -------------------------------------------------------------------------- */

const state: {
  rows: HistoryRow[];
  sizes: Record<string, number | undefined>;
  measured: Record<string, FileFingerprint | null | undefined>;
  dumpJson: string;
  exitCode: number;
  queuedId: string;
  queueCalls: number;
  failQueueCall: number;
} = {
  rows: [],
  sizes: {},
  measured: {},
  dumpJson: "",
  exitCode: 0,
  queuedId: "job-queued",
  queueCalls: 0,
  failQueueCall: 0,
};

mock.module("../server/lib/db", () => ({
  historyForVideo: (videoId: string) =>
    state.rows.filter((r) => r.videoId === videoId),
  historyRowsFor: (ids?: string[]) =>
    ids ? state.rows.filter((r) => ids.includes(r.id)) : state.rows,
  historyAdd: () => {},
  getSettings: () => ({
    outputDir: "C:\\downloads",
    outputTemplate: "%(title)s.%(ext)s",
    skipExisting: true,
    convertInstead: true,
  }),
}));

/** syncLibrary queues work through the runner; the tests only count the calls. */
mock.module("../server/lib/runner", () => ({
  startDownload: () => {
    state.queueCalls++;
    if (state.queueCalls === state.failQueueCall)
      throw new Error("Queue storage unavailable");
    return state.queuedId;
  },
}));

mock.module("../server/lib/ffprobe", () => ({
  fileSizeNow: (p: string) => state.sizes[p],
  inspectFile: async (p: string) => state.measured[p] ?? null,
}));

mock.module("../server/lib/spawn", () => ({
  runYtdlp: async (opts: { args?: string[]; onLine?: (l: string) => void }) => {
    let json = state.dumpJson;

    // Each URL probes its own video. Without this, every URL in a batch
    // resolves to the same id and a batch test silently asserts that the same
    // video is both downloaded and not downloaded. The id is matched in full,
    // not as YouTube's 11 characters, so fixtures can use readable ids.
    if (json) {
      const url = (opts.args ?? [])
        .filter((a) => typeof a === "string" && a.startsWith("http"))
        .pop();
      const probed = url?.match(/[?&]v=([0-9A-Za-z_-]+)/)?.[1];
      if (probed) {
        try {
          json = JSON.stringify({
            ...(JSON.parse(json) as Record<string, unknown>),
            id: probed,
          });
        } catch {
          /* keep the payload as authored */
        }
      }
    }

    if (json) opts.onLine?.(json);
    return {
      done: Promise.resolve(state.exitCode),
      stderrText: () => "",
      cancel: async () => {},
    };
  },
  stripAnsi: (s: string) => s,
}));

const { planBatch, planDownload, conversionAllowed } = await import(
  "../server/lib/plan"
);
const {
  compareFile,
  comparePlaylist,
  compareSource,
  sourceFingerprintFromYtdlp,
} = await import("../server/lib/fingerprint");
const { syncLibrary, startSync, applySync } = await import(
  "../server/lib/sync"
);
const { jobStore } = await import("../server/lib/queue");
const { buildRequestKey } = await import("../shared/request-key");

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

const OPTIONS: DownloadOptions = {
  embedThumbnail: false,
  embedMetadata: true,
  embedChapters: false,
  subtitles: false,
  subtitleLangs: "en.*",
  sponsorblock: false,
};

const VIDEO_ID = "aqz-KE-bpKQ";

/**
 * A fresh URL per test, for the *same* video id.
 *
 * The cache is keyed by url+preset, so reusing one URL across cases makes a
 * later test read an earlier test's probe and assert against the wrong source.
 * The id stays fixed because the harness below derives the probed video from
 * the URL: a unique cache key and a stable identity are two different needs.
 */
let urlSeq = 0;
function videoUrl(id: string = VIDEO_ID): string {
  return `https://www.youtube.com/watch?v=${id}&_seq=${++urlSeq}`;
}

type PlanArgs = Parameters<typeof planDownload>[0];

function req(over: Partial<PlanArgs> = {}): PlanArgs {
  return {
    url: videoUrl(),
    presetId: "mp4-h264",
    options: OPTIONS,
    outputDir: "C:\\downloads",
    outputTemplate: "%(title)s.%(ext)s",
    videoId: VIDEO_ID,
    ...over,
  };
}

/** A yt-dlp --dump-json payload for one video/audio rendition pair. */
function dumpJson(opts: {
  title?: string;
  videoFormatId?: string;
  vcodec?: string;
  width?: number;
  height?: number;
  vbr?: number;
  audioFormatId?: string;
  acodec?: string;
  abr?: number;
  duration?: number;
}): string {
  const {
    title = "Big Buck Bunny",
    videoFormatId = "137",
    vcodec = "avc1.640028",
    width = 1920,
    height = 1080,
    vbr = 2500,
    audioFormatId = "140",
    acodec = "mp4a.40.2",
    abr = 128,
    duration = 596,
  } = opts;

  return JSON.stringify({
    id: VIDEO_ID,
    title,
    uploader: "Test uploader",
    channel_id: "channel-1",
    upload_date: "20200101",
    format_id: `${videoFormatId}+${audioFormatId}`,
    duration,
    extractor: "youtube",
    requested_formats: [
      {
        format_id: videoFormatId,
        vcodec,
        acodec: "none",
        width,
        height,
        fps: 24,
        vbr,
      },
      {
        format_id: audioFormatId,
        vcodec: "none",
        acodec,
        abr,
        asr: 44100,
        audio_channels: 2,
      },
    ],
  });
}

function file(over: Partial<FileFingerprint> = {}): FileFingerprint {
  return {
    fingerprintVersion: 2,
    path: "C:\\downloads\\Big Buck Bunny [aqz-KE-bpKQ].mp4",
    ext: "mp4",
    sizeBytes: 84_213_760,
    durationSec: 596,
    width: 1920,
    height: 1080,
    vcodec: "h264",
    acodec: "aac",
    hasVideo: true,
    hasAudio: true,
    ...over,
  };
}

function source(over: Partial<SourceFingerprint> = {}): SourceFingerprint {
  return {
    fingerprintVersion: 2,
    videoId: VIDEO_ID,
    title: "Big Buck Bunny",
    uploader: "Test uploader",
    channelId: "channel-1",
    uploadDate: "20200101",
    formatId: "137+140",
    videoFormatId: "137",
    audioFormatId: "140",
    durationSec: 596,
    width: 1920,
    height: 1080,
    fps: 24,
    vcodec: "h264",
    acodec: "aac",
    vbr: 2500,
    abr: 128,
    asr: 44100,
    channels: 2,
    selectedFormats: [
      {
        formatId: "137",
        width: 1920,
        height: 1080,
        fps: 24,
        vcodec: "h264",
        vbr: 2500,
      },
      {
        formatId: "140",
        acodec: "aac",
        abr: 128,
        asr: 44100,
        channels: 2,
      },
    ],
    metadata: {
      uploader: "Test uploader",
      channelId: "channel-1",
      uploadDate: "20200101",
    },
    extractor: "youtube",
    ...over,
  };
}

/** `options` is not part of HistoryRow; it is the request that produced it. */
type RowOver = Partial<HistoryRow> & { options?: DownloadOptions };

/** A selection context, i.e. one video downloaded from a playlist's table. */
function playlist(
  over: Partial<PlaylistDownloadContext> = {},
): PlaylistDownloadContext {
  return {
    playlistId: "PL123",
    playlistTitle: "Test playlist",
    entryIndex: 3,
    selectionMode: "all",
    selectionCount: 10,
    selectionFingerprint: "a,b,c",
    ...over,
  };
}

/**
 * Builds a stored history row. `file` and `source` are always whole objects --
 * a partial fingerprint would silently weaken every assertion built on it.
 */
function row(over: RowOver = {}): HistoryRow {
  const presetId = over.presetId ?? "mp4-h264";
  const fp = file(over.file);
  return {
    provenance: "original",
    id: over.id ?? "job-1",
    // Recorded so a stored row can be re-checked later without guessing the
    // link back from its id. Checked with `in` so a test can pass an explicit
    // undefined to exercise a row recorded before this column existed.
    url:
      "url" in over
        ? over.url
        : `https://www.youtube.com/watch?v=${over.videoId ?? VIDEO_ID}`,
    videoId: over.videoId ?? VIDEO_ID,
    title: over.title ?? "Big Buck Bunny",
    presetId,
    ext: over.ext ?? fp.ext,
    sizeBytes: fp.sizeBytes,
    completedAt: over.completedAt ?? 1_700_000_000_000,
    requestKey: buildRequestKey(presetId, over.options ?? OPTIONS),
    source: source(over.source),
    file: fp,
    // Carried through explicitly. Omitting it here makes every row look like it
    // came from a bare URL, so a test asserting on playlist context silently
    // exercises nothing.
    playlist: over.playlist,
  };
}

function setSource(dump: string): void {
  state.dumpJson = dump;
  state.exitCode = 0;
}

beforeEach(() => {
  state.rows = [];
  state.sizes = {};
  state.measured = {};
  state.dumpJson = "";
  state.exitCode = 0;
  state.queuedId = "job-queued";
  state.queueCalls = 0;
  state.failQueueCall = 0;
  // Jobs are process-wide, so a leftover in-flight job from one test would
  // silently suppress queueing in the next.
  for (const job of jobStore.all()) jobStore.delete(job.id);
});

/** Registers a stored row and makes its file look present and unchanged. */
function onDisk(r: HistoryRow): HistoryRow {
  state.rows.push(r);
  if (r.file) {
    state.sizes[r.file.path] = r.file.sizeBytes;
    state.measured[r.file.path] = r.file;
  }
  return r;
}

/* -------------------------------------------------------------------------- *
 * compareSource -- the core predicate
 * -------------------------------------------------------------------------- */

describe("compareSource", () => {
  it("matches an identical fingerprint", () => {
    const result = compareSource(source(), source());
    expect(result.equal).toBe(true);
    expect(result.diffs).toEqual([]);
  });

  it("rejects a new higher-resolution rendition", () => {
    const have = source();
    const want = source({
      formatId: "401+140",
      height: 2160,
      width: 3840,
      vcodec: "vp9",
      vbr: 12000,
    });

    const result = compareSource(have, want);
    expect(result.equal).toBe(false);
    expect(result.diffs.map((d) => d.field)).toContain("resolution");
    expect(result.diffs.map((d) => d.field)).toContain("formatId");
  });

  it("rejects a renamed video", () => {
    const result = compareSource(
      source(),
      source({ title: "Big Buck Bunny (Remastered)" }),
    );
    expect(result.equal).toBe(false);
    expect(result.diffs.map((d) => d.field)).toContain("title");
  });

  it("rejects changed source size or one selected stream", () => {
    const result = compareSource(
      source(),
      source({
        sourceSizeBytes: 99_999,
        selectedFormats: [
          source().selectedFormats![0]!,
          { ...source().selectedFormats![1]!, abr: 160 },
        ],
      }),
    );
    expect(result.equal).toBe(false);
    expect(result.diffs.map((d) => d.field)).toContain("sourceSizeBytes");
    expect(result.diffs.map((d) => d.field)).toContain("selectedFormats");
  });

  it("rejects a different container even when the streams are identical", () => {
    // Same pixels, but the site now offers them in a different rendition id.
    const result = compareSource(
      source({ formatId: "137+140" }),
      source({ formatId: "248+140" }),
    );
    expect(result.equal).toBe(false);
  });

  it("refuses to decide when the format id is missing", () => {
    // Without a format id there is no proof the same rendition was selected,
    // and guessing there is how a 1080p file satisfies a 4K request.
    const result = compareSource(
      source({ formatId: undefined }),
      source({ formatId: undefined }),
    );
    expect(result.equal).toBe(false);
  });

  it("rejects a fractional duration difference because matching is exact", () => {
    const result = compareSource(
      source({ durationSec: 596 }),
      source({ durationSec: 596.4 }),
    );
    expect(result.equal).toBe(false);
    expect(result.diffs.map((d) => d.field)).toContain("durationSec");
  });

  it("rejects an attribute that is known on only one side", () => {
    const have = source({ vbr: undefined });
    const want = source({ vbr: 2500 });
    expect(compareSource(have, want).equal).toBe(false);
    expect(compareSource(have, want).diffs.map((d) => d.field)).toContain(
      "vbr",
    );
  });
});

describe("compareFile", () => {
  it("rejects a same-sized file whose codec changed", () => {
    const result = compareFile(
      file(),
      file({ vcodec: "vp9", sizeBytes: file().sizeBytes }),
    );
    expect(result.equal).toBe(false);
    expect(result.diffs.map((d) => d.field)).toContain("vcodec");
  });

  it("rejects a changed file size even when media metadata is unchanged", () => {
    const result = compareFile(
      file(),
      file({ sizeBytes: (file().sizeBytes ?? 0) + 1 }),
    );
    expect(result.equal).toBe(false);
    expect(result.diffs.map((d) => d.field)).toContain("sizeBytes");
  });
});

/* -------------------------------------------------------------------------- *
 * planDownload -- the decision
 * -------------------------------------------------------------------------- */

describe("planDownload", () => {
  it("downloads when there is no history at all", async () => {
    setSource(dumpJson({}));
    const plan = await planDownload(req(), {
      skipExisting: true,
      convertInstead: true,
    });
    expect(plan.action).toBe("download");
  });

  it("downloads when the source cannot be read -- failure to prove is not proof", async () => {
    onDisk(row());
    state.dumpJson = "";
    state.exitCode = 1;

    const plan = await planDownload(req(), {
      skipExisting: true,
      convertInstead: true,
    });
    expect(plan.action).toBe("download");
  });

  it("skips when every attribute still matches", async () => {
    onDisk(row());
    setSource(dumpJson({}));

    const plan = await planDownload(req(), {
      skipExisting: true,
      convertInstead: true,
    });
    expect(plan.action).toBe("skip");
    expect(plan.existingPath).toContain("Big Buck Bunny");
  });

  it("re-downloads when the video is now available in 4K", async () => {
    onDisk(row());
    setSource(
      dumpJson({
        videoFormatId: "401",
        vcodec: "vp09.00.10.08",
        width: 3840,
        height: 2160,
        vbr: 12000,
      }),
    );

    const plan = await planDownload(req({ presetId: "mkv-max" }), {
      skipExisting: true,
      convertInstead: true,
    });
    expect(plan.action).toBe("download");
    expect(plan.reason).toMatch(/source changed/i);
    // The changed attributes must be reported, not hidden.
    expect(plan.diffs.map((d) => d.field)).toContain("resolution");
  });

  it("re-downloads when the video was renamed upstream", async () => {
    onDisk(row());
    setSource(dumpJson({ title: "Big Buck Bunny (4K Remaster)" }));

    const plan = await planDownload(req(), {
      skipExisting: true,
      convertInstead: true,
    });
    expect(plan.action).toBe("download");
    expect(plan.diffs.map((d) => d.field)).toContain("title");
  });

  it("re-downloads when the file is gone from disk", async () => {
    const r = row();
    state.rows.push(r);
    // Deliberately no entry in state.sizes: the file does not exist.
    setSource(dumpJson({}));

    const plan = await planDownload(req(), {
      skipExisting: true,
      convertInstead: true,
    });
    expect(plan.action).toBe("download");
  });

  it("re-downloads when the file on disk was truncated", async () => {
    const r = row();
    state.rows.push(r);
    if (r.file) state.sizes[r.file.path] = (r.file.sizeBytes ?? 0) - 4096;
    setSource(dumpJson({}));

    const plan = await planDownload(req(), {
      skipExisting: true,
      convertInstead: true,
    });
    expect(plan.action).toBe("download");
  });

  it("re-downloads when a same-sized file's metadata changed", async () => {
    const r = row();
    onDisk(r);
    if (r.file)
      state.measured[r.file.path] = file({ ...r.file, vcodec: "vp9" });
    setSource(dumpJson({}));

    const plan = await planDownload(req(), {
      skipExisting: true,
      convertInstead: true,
    });
    expect(plan.action).toBe("download");
    expect(plan.reason).toMatch(/full metadata/i);
  });

  it("never skips when the skip setting is off", async () => {
    onDisk(row());
    setSource(dumpJson({}));

    const plan = await planDownload(req(), {
      skipExisting: false,
      convertInstead: true,
    });
    expect(plan.action).not.toBe("skip");
    // The row must say why, or the re-download looks like the feature is broken.
    expect(plan.reason).toMatch(/skipping is turned off/i);
  });

  it("remuxes instead of re-downloading when only the container differs", async () => {
    onDisk(row());
    setSource(dumpJson({}));

    const plan = await planDownload(req({ presetId: "mkv-max" }), {
      skipExisting: true,
      convertInstead: true,
    });
    expect(plan.action).toBe("convert");
    expect(plan.lossless).toBe(true);
    expect(plan.reason).toMatch(/Remux/i);
    expect(plan.convertOutPath).toMatch(/\.mkv$/);
    expect(plan.convertArgs).toContain("-c");
    expect(plan.convertArgs).toContain("copy");
  });

  it("downloads rather than convert when conversion is disabled", async () => {
    onDisk(row());
    setSource(dumpJson({}));

    const plan = await planDownload(req({ presetId: "mkv-max" }), {
      skipExisting: true,
      convertInstead: false,
    });
    expect(plan.action).toBe("download");
  });

  it("skips a playlist-downloaded copy when the same video is requested on its own", async () => {
    // Recorded from a playlist's selection table, now asked for as a bare URL.
    // How a copy was reached is context; the media is identical, so the
    // playlist fields must not by themselves force another download.
    onDisk(row({ playlist: playlist() }));
    setSource(dumpJson({}));

    const plan = await planDownload(req(), {
      skipExisting: true,
      convertInstead: true,
    });
    expect(plan.action).toBe("skip");
  });

  it("skips a standalone copy when the same video is later requested from a playlist", async () => {
    // The mirror image: downloaded on its own, re-requested as part of a
    // selection. Re-downloading here would re-fetch 200 videos for nothing.
    onDisk(row());
    setSource(dumpJson({}));

    const plan = await planDownload(
      req({
        playlist: playlist({ playlistId: "PL123", entryIndex: 3 }),
        playlistIndex: 3,
      }),
      { skipExisting: true, convertInstead: true },
    );
    expect(plan.action).toBe("skip");
  });

  it("does not convert when the format is unchanged but the options are", async () => {
    // Same preset, same container -- only "embed metadata" was switched on.
    // A remux cannot add that, so re-using the file would silently hand back a
    // duplicate that still lacks what was asked for.
    onDisk(row({ options: { ...OPTIONS, embedMetadata: false } }));
    setSource(dumpJson({}));

    const plan = await planDownload(req(), {
      skipExisting: true,
      convertInstead: true,
    });
    expect(plan.action).toBe("download");
    expect(plan.reason).not.toMatch(/Remux|Convert/i);
  });

  it("downloads when the format differs but metadata the copy lacks is now wanted", async () => {
    // ffmpeg can carry metadata through a remux, but only if the file already
    // has it. This copy was written with metadata off, so re-using it would
    // silently drop the feature the user just switched on.
    onDisk(row({ options: { ...OPTIONS, embedMetadata: false } }));
    setSource(dumpJson({}));

    const plan = await planDownload(req({ presetId: "mkv-max" }), {
      skipExisting: true,
      convertInstead: true,
    });
    expect(plan.action).toBe("download");
  });

  it("skips an identical request even when the container label differs from the preset", async () => {
    // A preset's declared extension is only a label -- the Opus preset fetches
    // a webm stream, for one. An identical request yields an identical file, so
    // the label must not by itself force a re-download.
    onDisk(
      row({
        file: file({
          ext: "webm",
          path: "C:\\downloads\\Big Buck Bunny [aqz-KE-bpKQ].webm",
        }),
        ext: "webm",
      }),
    );
    setSource(dumpJson({}));

    const plan = await planDownload(req(), {
      skipExisting: true,
      convertInstead: true,
    });
    expect(plan.action).toBe("skip");
  });

  it("remuxes to the preset's container when the copy on disk is in another one", async () => {
    // Same preset, but the file we hold is in a different container than the
    // preset promises, and the request differs only by something ffmpeg can
    // honour (dropping metadata). Re-shaping beats re-downloading.
    onDisk(
      row({
        file: file({
          ext: "webm",
          path: "C:\\downloads\\Big Buck Bunny [aqz-KE-bpKQ].webm",
        }),
        ext: "webm",
        options: { ...OPTIONS, embedMetadata: true },
      }),
    );
    setSource(dumpJson({}));

    const plan = await planDownload(
      req({ options: { ...OPTIONS, embedMetadata: false } }),
      {
        skipExisting: true,
        convertInstead: true,
      },
    );
    expect(plan.action).toBe("convert");
    expect(plan.convertOutPath).toMatch(/\.mp4$/);
  });

  it("refuses to convert when subtitles are requested", async () => {
    // Embedded subtitles are post-processing ffmpeg cannot reproduce from the
    // finished file, so the only faithful answer is a real download.
    expect(conversionAllowed({ ...OPTIONS, subtitles: true })).toBe(false);
    expect(conversionAllowed({ ...OPTIONS, sponsorblock: true })).toBe(false);
    expect(conversionAllowed({ ...OPTIONS, embedThumbnail: true })).toBe(false);
    expect(conversionAllowed(OPTIONS)).toBe(true);
  });
});

/* -------------------------------------------------------------------------- *
 * comparePlaylist -- context, reported but never decisive
 * -------------------------------------------------------------------------- */

describe("comparePlaylist", () => {
  it("matches an identical selection context", () => {
    const result = comparePlaylist(playlist(), playlist());
    expect(result.equal).toBe(true);
    expect(result.diffs).toEqual([]);
    expect(result.absent).toBe(false);
  });

  it("reports a changed position within the same playlist", () => {
    const result = comparePlaylist(
      playlist({ entryIndex: 3 }),
      playlist({ entryIndex: 7 }),
    );
    expect(result.equal).toBe(false);
    expect(result.diffs.map((d) => d.field)).toContain("entryIndex");
  });

  it("reports a changed selection", () => {
    const result = comparePlaylist(
      playlist({ selectionFingerprint: "a,b,c" }),
      playlist({ selectionFingerprint: "a,b" }),
    );
    expect(result.diffs.map((d) => d.field)).toContain("selectionFingerprint");
  });

  it("reports only the playlist id when the contexts are from different playlists", () => {
    // Comparing positions across two unrelated playlists makes every field look
    // changed at once, which buries the one difference that actually matters.
    const result = comparePlaylist(
      playlist({ playlistId: "PL123", entryIndex: 3 }),
      playlist({ playlistId: "PL999", entryIndex: 3 }),
    );
    expect(result.diffs.map((d) => d.field)).toEqual(["playlistId"]);
  });

  it("treats two requests with no playlist context as absent, not different", () => {
    const result = comparePlaylist(undefined, undefined);
    expect(result.absent).toBe(true);
    expect(result.diffs).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- *
 * planBatch -- re-checking a whole selection
 * -------------------------------------------------------------------------- */

const BATCH_BASE = {
  options: OPTIONS,
  outputDir: "C:\\downloads",
  outputTemplate: "%(title)s.%(ext)s",
};

describe("planBatch", () => {
  it("plans every item and counts the outcomes", async () => {
    onDisk(row());
    setSource(dumpJson({}));

    const items: DownloadItem[] = [
      { url: videoUrl(), videoId: VIDEO_ID, title: "Big Buck Bunny" },
      // Its own URL, so the probe answers for *this* video and not for the one
      // stored in history -- a batch is only interesting if its items differ.
      {
        url: videoUrl("never-downloaded"),
        videoId: "never-downloaded",
        title: "Something else",
      },
    ];

    const result = await planBatch(
      { ...BATCH_BASE, presetId: "mp4-h264", items },
      { skipExisting: true, convertInstead: true },
    );

    expect(result.entries).toHaveLength(2);
    expect(result.counts.skip).toBe(1);
    expect(result.counts.download).toBe(1);
  });

  it("reports the conversion a change of format would need", async () => {
    onDisk(row());
    setSource(dumpJson({}));

    const result = await planBatch(
      {
        ...BATCH_BASE,
        presetId: "mkv-max",
        items: [
          { url: videoUrl(), videoId: VIDEO_ID, title: "Big Buck Bunny" },
        ],
      },
      { skipExisting: true, convertInstead: true },
    );

    expect(result.entries[0]?.action).toBe("convert");
    expect(result.entries[0]?.lossless).toBe(true);
    expect(result.counts.convert).toBe(1);
  });

  it("surfaces a playlist context difference without letting it force a download", async () => {
    // Same media, reached from a different position in the same playlist. That
    // is context, not a different video, so the action must stay a skip.
    onDisk(row({ playlist: playlist({ playlistId: "PL123", entryIndex: 3 }) }));
    setSource(dumpJson({}));

    const result = await planBatch(
      {
        ...BATCH_BASE,
        presetId: "mp4-h264",
        items: [
          {
            url: videoUrl(),
            videoId: VIDEO_ID,
            title: "Big Buck Bunny",
            playlist: playlist({ playlistId: "PL123", entryIndex: 9 }),
          },
        ],
      },
      { skipExisting: true, convertInstead: true },
    );

    expect(result.entries[0]?.action).toBe("skip");
    expect(result.entries[0]?.playlistDiffs?.map((d) => d.field)).toContain(
      "entryIndex",
    );
  });

  it("falls towards download when an item cannot be checked", async () => {
    onDisk(row());
    setSource(dumpJson({}));
    // A failing probe means we cannot prove anything either way.
    state.dumpJson = "";
    state.exitCode = 1;

    const result = await planBatch(
      {
        ...BATCH_BASE,
        presetId: "mp4-h264",
        items: [
          { url: videoUrl(), videoId: VIDEO_ID, title: "Big Buck Bunny" },
        ],
      },
      { skipExisting: true, convertInstead: true },
    );

    expect(result.entries[0]?.action).toBe("download");
  });
});

/* -------------------------------------------------------------------------- *
 * syncLibrary -- bringing stored copies in line with the current selection
 * -------------------------------------------------------------------------- */

const SYNC_SETTINGS = { skipExisting: true, convertInstead: true };

describe("syncLibrary", () => {
  it("reports entries that already match, queueing nothing", async () => {
    onDisk(row());
    setSource(dumpJson({}));

    const result = await syncLibrary(
      { presetId: "mp4-h264", options: OPTIONS },
      SYNC_SETTINGS,
    );

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.action).toBe("skip");
    expect(result.queued).toBe(0);
  });

  it("reports a conversion when the selected format differs", async () => {
    onDisk(row());
    setSource(dumpJson({}));

    const result = await syncLibrary(
      { presetId: "mkv-max", options: OPTIONS },
      SYNC_SETTINGS,
    );

    expect(result.entries[0]?.action).toBe("convert");
    expect(result.entries[0]?.historyId).toBe("job-1");
    // Reporting is free; queueing is not, so it waits to be asked.
    expect(result.queued).toBe(0);
  });

  it("queues the work only when asked to apply", async () => {
    onDisk(row());
    setSource(dumpJson({}));

    const result = await syncLibrary(
      { presetId: "mkv-max", options: OPTIONS, apply: true },
      SYNC_SETTINGS,
    );

    expect(result.queued).toBe(1);
    expect(result.entries[0]?.jobId).toBe("job-queued");
  });

  it("re-downloads when the source itself changed, and says which attributes", async () => {
    onDisk(row());
    setSource(
      dumpJson({
        videoFormatId: "401",
        vcodec: "vp09.00.10.08",
        width: 3840,
        height: 2160,
        vbr: 12000,
      }),
    );

    const result = await syncLibrary(
      { presetId: "mp4-h264", options: OPTIONS },
      SYNC_SETTINGS,
    );

    expect(result.entries[0]?.action).toBe("download");
    expect(result.entries[0]?.diffs.map((d) => d.field)).toContain(
      "resolution",
    );
  });

  it("reports a stored entry it cannot turn back into a URL", async () => {
    onDisk(row({ id: "job-nourl", url: undefined, videoId: "not-a-video-id" }));
    setSource(dumpJson({}));

    const result = await syncLibrary(
      { presetId: "mp4-h264", options: OPTIONS },
      SYNC_SETTINGS,
    );

    // Reported rather than dropped, so the sweep never looks complete when it
    // quietly skipped something it could not check.
    expect(result.entries[0]?.error).toBe("missing-url");
    expect(result.counts.error).toBe(1);
  });

  it("does not queue a second job for a video already in flight", async () => {
    onDisk(row());
    setSource(dumpJson({}));
    state.queuedId = "busy-1";
    jobStore.create({
      id: "busy-1",
      videoId: VIDEO_ID,
      title: "Big Buck Bunny",
      phase: "downloading",
      percent: 10,
      presetId: "mkv-max",
      attempts: 0,
    });

    const result = await syncLibrary(
      { presetId: "mkv-max", options: OPTIONS, apply: true },
      SYNC_SETTINGS,
    );

    expect(result.queued).toBe(0);
    expect(result.checked).toBe(1);
    expect(result.counts.convert).toBe(1);
    expect(result.entries[0]?.reason).toMatch(/already being downloaded/i);
  });

  it("lets the runner distinguish different options for an active video", async () => {
    onDisk(row());
    setSource(dumpJson({}));
    jobStore.create({
      id: "busy-other-options",
      videoId: VIDEO_ID,
      title: "Other request",
      phase: "downloading",
      percent: 10,
      presetId: "mkv-max",
      attempts: 0,
    });
    const result = await syncLibrary(
      {
        presetId: "mkv-max",
        options: { ...OPTIONS, embedThumbnail: true },
        apply: true,
      },
      SYNC_SETTINGS,
    );
    expect(state.queueCalls).toBe(1);
    expect(result.queued).toBe(1);
    expect(result.entries[0]?.jobId).toBe("job-queued");
  });

  it("counts an enqueue failure once without reporting successful work", async () => {
    onDisk(row());
    setSource(dumpJson({}));
    state.failQueueCall = 1;
    const result = await syncLibrary(
      { presetId: "mkv-max", options: OPTIONS, apply: true },
      SYNC_SETTINGS,
    );
    expect(result.checked).toBe(1);
    expect(result.unchecked).toBe(0);
    expect(result.queued).toBe(0);
    expect(result.counts).toEqual({
      download: 0,
      convert: 0,
      skip: 0,
      error: 1,
    });
  });

  async function preview() {
    const task = startSync({ presetId: "mkv-max", options: OPTIONS });
    const deadline = Date.now() + 1000;
    while (task.state === "running" && Date.now() < deadline)
      await Bun.sleep(5);
    expect(task.state).toBe("done");
    return task;
  }

  it("applies a preview once even when every request is already queued", async () => {
    onDisk(row());
    setSource(dumpJson({}));
    const task = await preview();
    jobStore.create({
      id: "job-queued",
      videoId: VIDEO_ID,
      title: "Existing",
      phase: "paused",
      percent: 0,
      presetId: "mkv-max",
      attempts: 0,
    });
    expect(applySync(task.id)).toBe(0);
    expect(task.applied).toBe(true);
    jobStore.delete("job-queued");
    expect(applySync(task.id)).toBe(0);
    expect(state.queueCalls).toBe(1);
  });

  it("applies new preview work only once", async () => {
    onDisk(row());
    setSource(dumpJson({}));
    const task = await preview();
    expect(applySync(task.id)).toBe(1);
    expect(applySync(task.id)).toBe(1);
    expect(state.queueCalls).toBe(1);
    expect(task.result?.entries[0]?.jobId).toBe("job-queued");
  });

  it("retains partial apply progress when queue persistence fails", async () => {
    onDisk(row());
    onDisk(row({ id: "second-row", videoId: "abcdefghijk" }));
    setSource(dumpJson({}));
    const task = await preview();
    state.failQueueCall = 2;
    expect(() => applySync(task.id)).toThrow("Queue storage unavailable");
    expect(task.applied).not.toBe(true);
    expect(task.result?.queued).toBe(1);
    state.queuedId = "second-job";
    expect(applySync(task.id)).toBe(2);
    expect(state.queueCalls).toBe(3);
    expect(task.applied).toBe(true);
  });
});

/* -------------------------------------------------------------------------- *
 * sourceFingerprintFromYtdlp
 * -------------------------------------------------------------------------- */

describe("sourceFingerprintFromYtdlp", () => {
  it("folds yt-dlp codec names onto ffprobe's", () => {
    const fp = sourceFingerprintFromYtdlp(
      JSON.parse(dumpJson({})) as Record<string, unknown>,
      "video",
    );
    expect(fp.vcodec).toBe("h264");
    expect(fp.acodec).toBe("aac");
    expect(fp.height).toBe(1080);
    expect(fp.formatId).toBe("137+140");
  });

  it("ignores the video half for audio-only requests", () => {
    const fp = sourceFingerprintFromYtdlp(
      JSON.parse(dumpJson({})) as Record<string, unknown>,
      "audio",
    );
    expect(fp.acodec).toBe("aac");
    expect(fp.vcodec).toBeUndefined();
  });
});

describe("stored transformation provenance", () => {
  // SponsorBlock is the only remaining transformation. (Chapter clipping used
  // to sit here too; the feature is gone.)
  for (const [name, patch] of [
    ["SponsorBlock cut", { options: { ...OPTIONS, sponsorblock: true } }],
  ] as const)
    it("never reuses a stored " + name + " for a full video", async () => {
      onDisk(row(patch));
      setSource(dumpJson({}));
      const plan = await planDownload(req({ presetId: "mkv-max" }), {
        skipExisting: true,
        convertInstead: true,
      });
      expect(plan.action).toBe("download");
    });
  for (const provenance of ["unknown", "encoded", "transformed"] as const)
    it("requires original provenance: " + provenance, async () => {
      onDisk({ ...row(), provenance });
      setSource(dumpJson({}));
      expect(
        (
          await planDownload(req({ presetId: "mkv-max" }), {
            skipExisting: true,
            convertInstead: true,
          })
        ).action,
      ).toBe("download");
    });
  it("cancellation reports unchecked rows without labelling them skipped", async () => {
    onDisk(row());
    const controller = new AbortController();
    controller.abort();
    const result = await syncLibrary(
      { presetId: "mkv-max", options: OPTIONS },
      { ...SYNC_SETTINGS, signal: controller.signal },
    );
    expect(result.checked).toBe(0);
    expect(result.unchecked).toBe(1);
    expect(result.counts.skip).toBe(0);
    expect(result.truncated).toBe(true);
  });
});
