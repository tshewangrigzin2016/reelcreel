import { libraryRoutes } from "./routes/library";
import { previewRoutes } from "./routes/preview";
import { localBoundary } from "./lib/boundary";
import { serverAddress, startupError } from "./lib/listen";
import { subscribeEvents } from "./lib/events";
import {
  initializeQueue,
  pauseJob,
  resumeJob,
  reorderJobs,
} from "./lib/runner";
import { probeOne } from "./lib/resolve-binary";
import { resolveFfprobe } from "./lib/ffprobe";
import * as validation from "../shared/validation";
import { existsSync } from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import type { Context } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import {
  DEFAULT_AUDIO_PRESET,
  DEFAULT_VIDEO_PRESET,
  presetList,
} from "./lib/presets";
import {
  cancelJob,
  clearFinishedJobs,
  removeJob,
  retryJob,
  startDownload,
} from "./lib/runner";
import type {
  DownloadItem,
  DownloadOptions,
  DownloadRequest,
  HealthInfo,
  JobState,
  PlaylistDownloadContext,
  Settings,
} from "../shared/types";
import {
  downloadedIdsForRequest,
  downloadedVideoIds,
  getSettings,
  historyClear,
  historyDelete,
  historyList,
  putSettings,
} from "./lib/db";
import {
  isRadioList,
  isPlaylistUrl,
  lastError,
  normalizeUrl,
  probePlaylistFirst,
  probeVideo,
  probeUrl,
  probeBatch,
  toEntry,
  toPlaylistMeta,
  toVideoMeta,
  PLAYLIST_REQUEST_DELAY_SECONDS,
} from "./lib/probe";
import { jobStore, configurePools } from "./lib/queue";
import { searchYouTube } from "./lib/search";
import { listEntries } from "./lib/listing";
import { invalidateFfprobe } from "./lib/ffprobe";
import { planBatch, planDownload } from "./lib/plan";
import {
  getOverride,
  resolveBinary,
  resolveBinaries,
  setOverride,
} from "./lib/resolve-binary";
import { runYtdlp } from "./lib/spawn";
import { syncLibrary } from "./lib/sync";

function applySettingsOverrides(s: Settings): void {
  setOverride("yt-dlp", s.ytdlpPath);
  setOverride("ffmpeg", s.ffmpegPath);
  invalidateFfprobe();
  setOverride("node", s.jsRuntime === "node" ? s.runtimePath : undefined);
  setOverride("deno", s.jsRuntime === "deno" ? s.runtimePath : undefined);
  configurePools(
    s.probeConcurrency,
    s.downloadConcurrency,
    s.conversionConcurrency,
  );
}

export const app = new Hono();
app.use("/api/*", localBoundary);
app.onError((error, c) =>
  c.json(
    {
      error:
        error instanceof validation.ValidationError
          ? error.message
          : "Operation failed: " + error.message,
    },
    error instanceof validation.ValidationError ? 400 : 500,
  ),
);

interface DownloadBatchBody {
  scheduledAt?: number;
  presetId?: string;
  options?: Partial<DownloadOptions>;
  items?: DownloadItem[];
  // Legacy single-request shape is kept for CLI/API callers outside the UI.
  url?: string | string[];
  outputDir?: string;
  outputTemplate?: string;
  videoId?: string;
  title?: string;
  thumbnail?: string;
  playlistIndex?: number;
}

const DEFAULT_DOWNLOAD_OPTIONS: DownloadOptions = {
  embedThumbnail: false,
  embedMetadata: true,
  embedChapters: false,
  subtitles: false,
  subtitleLangs: "en.*",
  sponsorblock: false,
};

const MAX_DOWNLOAD_ITEMS = 500;

function downloadItemsFrom(body: DownloadBatchBody): DownloadItem[] {
  if (Array.isArray(body.items)) return body.items;

  if (Array.isArray(body.url)) return body.url.map((url) => ({ url }));
  if (typeof body.url === "string") {
    return [
      {
        url: body.url,
        videoId: body.videoId,
        title: body.title,
        thumbnail: body.thumbnail,
        playlistIndex: body.playlistIndex,
      },
    ];
  }

  return [];
}

app.get("/api/health", async (c) => {
  try {
    const bins = await resolveBinaries();
    const info: HealthInfo = {
      ok: true,
      ytdlp: bins.ytdlp,
      ffmpeg: bins.ffmpeg,
      node: bins.node,
      ffprobe: await resolveBinary("ffprobe", "-version"),
      runtime: await resolveBinary(getSettings().jsRuntime, "--version"),
      ejs: {
        available: false,
        detail: "Checking installed yt-dlp solver support",
      },
    };
    const ffprobePath = await resolveFfprobe();
    if (ffprobePath) info.ffprobe = await probeOne(ffprobePath, "-version");
    let diagnostics = "";
    const check = await runYtdlp({
      args: ["--verbose", "--simulate"],
      onLine: (line) => {
        diagnostics += line + "\n";
      },
      onErrLine: (line) => {
        diagnostics += line + "\n";
      },
      timeoutMs: 15000,
      withFfmpegLocation: false,
      withCookies: false,
    });
    await check.done;
    info.ejs = {
      available: /yt_dlp_ejs|yt-dlp-ejs|ejs-/i.test(diagnostics),
      detail: /yt_dlp_ejs|yt-dlp-ejs|ejs-/i.test(diagnostics)
        ? "EJS component detected in yt-dlp diagnostics."
        : "EJS was not reported. Install yt-dlp with its default dependencies; a video probe verifies challenge solving.",
    };
    info.ok =
      !!info.ytdlp &&
      !!info.ffmpeg &&
      !!info.ffprobe &&
      !!info.runtime &&
      !!info.ejs?.available;
    return c.json(info);
  } catch (err) {
    const info: HealthInfo = {
      ok: false,
      ytdlp: null,
      ffmpeg: null,
      node: null,
      error: err instanceof Error ? err.message : String(err),
    };
    return c.json(info, 503);
  }
});

app.get("/api/presets", (c) => c.json(presetList()));

app.get("/api/defaults", (c) =>
  c.json({ video: DEFAULT_VIDEO_PRESET, audio: DEFAULT_AUDIO_PRESET }),
);

app.post("/api/probe", async (c) => {
  const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
  const url = typeof body.url === "string" ? body.url : "";
  if (!url) return c.json({ error: "No URL provided" }, 400);

  const settings = getSettings();
  try {
    const result = await probeUrl(url, settings.playlistCap, c.req.raw.signal);
    return c.json(result);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

// Small direct endpoint retained for integrations that only need one video's
// metadata and do not want the playlist-dispatching POST shape.
app.get("/api/probe/video", async (c) => {
  const url = normalizeUrl(c.req.query("url") ?? "");
  if (!url) return c.json({ error: "No URL provided" }, 400);
  try {
    const result = await probeVideo(url, c.req.raw.signal);
    return c.json(result.video);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

/**
 * Reads a pasted list of individual video URLs as one batch.
 *
 * The batch composer used to queue these lines directly, which meant the only
 * choice offered was "download all of them, now, in whatever format happened to
 * be selected". This resolves them into entries instead, so the batch lands in
 * the same selection table a playlist does: pick rows, change format or
 * quality, re-check what is already on disk, then download.
 */
app.post("/api/probe/batch", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    urls?: unknown;
  } | null;

  if (!Array.isArray(body?.urls)) {
    return c.json({ error: "No URLs provided" }, 400);
  }
  if (body.urls.length === 0) {
    return c.json({ error: "No URLs provided" }, 400);
  }
  if (body.urls.length > MAX_DOWNLOAD_ITEMS) {
    return c.json(
      { error: `Too many URLs (maximum ${MAX_DOWNLOAD_ITEMS}).` },
      413,
    );
  }

  // Each line goes through the same normaliser the download path uses, so a
  // row in the table always points at a URL the server will accept.
  const urls: string[] = [];
  for (const raw of body.urls) {
    try {
      urls.push(validation.youtubeUrl(raw, true));
    } catch {
      /* Skip a line the server would reject anyway; the client already flags
         these before sending, so reaching here means the two disagree. */
    }
  }
  if (urls.length === 0) return c.json({ error: "No valid URLs provided" }, 400);

  try {
    return c.json(await probeBatch(urls, c.req.raw.signal));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

/**
 * First-video preview for a playlist URL. Deliberately separate from /api/probe
 * and /api/probe/stream: those enumerate every entry, while this stops after
 * one, so the thumbnail can render in about a second instead of after the whole
 * list. Fired the moment a playlist URL is recognised, in parallel with the
 * full probe.
 */
app.get("/api/probe/first", async (c) => {
  const url = normalizeUrl(c.req.query("url") ?? "");
  if (!url) return c.json({ error: "No URL provided" }, 400);
  if (!isPlaylistUrl(url)) return c.json({ error: "Not a playlist URL" }, 400);

  try {
    return c.json(await probePlaylistFirst(url, c.req.raw.signal));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

/**
 * YouTube-like search powered by the same yt-dlp binary as downloads.
 *
 * No API key needed: `ytsearchN:` runs through the extractor the probe and
 * download paths already use. Results are scored server-side (title/channel
 * token match + popularity) so the Explore page can render relevance order
 * directly, with `sort=views` as an explicit override.
 */
app.get("/api/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim();
  if (!q) return c.json({ error: "No search query provided" }, 400);
  if (q.length > 200) return c.json({ error: "Search query too long" }, 400);
  const rawLimit = Number(c.req.query("limit") ?? "25");
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), 50)
    : 25;
  const sortParam = c.req.query("sort") ?? "relevance";
  const sort =
    sortParam === "views" || sortParam === "recent" ? sortParam : "relevance";

  try {
    return c.json(await searchYouTube(q, limit, sort, c.req.raw.signal));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

/**
 * Paginated channel-uploads / playlist-entries listing for the Explore
 * drill-in modal.
 *
 * First page is 20 entries, subsequent scroll steps ask for 10 more via
 * `start` (1-based) + `limit`. Same yt-dlp binary as search and downloads,
 * flat mode only, so each page costs a handful of requests instead of a full
 * channel enumeration.
 */
app.get("/api/listing", async (c) => {
  const url = (c.req.query("url") ?? "").trim();
  if (!url) return c.json({ error: "No URL provided" }, 400);
  if (url.length > 2000) return c.json({ error: "URL too long" }, 400);
  const rawStart = Number(c.req.query("start") ?? "1");
  const rawLimit = Number(c.req.query("limit") ?? "20");
  const start = Number.isFinite(rawStart)
    ? Math.min(Math.max(Math.floor(rawStart), 1), 100000)
    : 1;
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), 50)
    : 20;

  try {
    return c.json(await listEntries(url, start, limit, c.req.raw.signal));
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      502,
    );
  }
});

/**
 * Answers "what would this download do?" without doing it.
 *
 * Exposed because the whole skip/convert decision is otherwise invisible until
 * a job is queued: this makes it possible to check a URL against the current
 * settings, and to see exactly which attribute differs when it decides to
 * re-download.
 */
app.post("/api/plan", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    url?: string;
    presetId?: string;
    options?: Partial<DownloadOptions>;
    videoId?: string;
    playlist?: PlaylistDownloadContext;
  } | null;

  const url = typeof body?.url === "string" ? normalizeUrl(body.url) : "";
  if (!url) return c.json({ error: "No URL provided" }, 400);
  if (!body?.presetId) return c.json({ error: "No preset provided" }, 400);

  const settings = getSettings();
  const plan = await planDownload(
    {
      url,
      presetId: body.presetId,
      options: { ...DEFAULT_DOWNLOAD_OPTIONS, ...body.options },
      outputDir: settings.outputDir,
      outputTemplate: settings.outputTemplate,
      videoId: body.videoId,
      playlist: body.playlist,
    },
    {
      skipExisting: settings.skipExisting !== false,
      convertInstead: settings.convertInstead !== false,
      signal: c.req.raw.signal,
    },
  );

  return c.json(plan);
});

/**
 * Answers "what would these downloads do?" for a whole selection at once.
 *
 * The single-item /api/plan exists for one URL; this is the one the UI calls
 * when the format or quality changes, so every row in a playlist selection can
 * be re-checked against the new choice in one round trip. It downloads nothing.
 *
 * Concurrency is bounded by the server's probe pool, so a 200-video selection
 * costs a few seconds rather than 200 simultaneous yt-dlp processes.
 */
app.post("/api/plan/batch", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    presetId?: string;
    options?: Partial<DownloadOptions>;
    items?: DownloadItem[];
  } | null;

  if (!body?.presetId) return c.json({ error: "No preset provided" }, 400);

  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) return c.json({ error: "No items provided" }, 400);
  if (items.length > MAX_DOWNLOAD_ITEMS) {
    return c.json(
      { error: `Too many items (maximum ${MAX_DOWNLOAD_ITEMS}).` },
      413,
    );
  }

  const settings = getSettings();
  const result = await planBatch(
    {
      presetId: body.presetId,
      options: { ...DEFAULT_DOWNLOAD_OPTIONS, ...body.options },
      outputDir: settings.outputDir,
      outputTemplate: settings.outputTemplate,
      items: items.map((item) => ({
        ...item,
        url: normalizeUrl(item.url) || item.url,
      })),
    },
    {
      skipExisting: settings.skipExisting !== false,
      convertInstead: settings.convertInstead !== false,
      signal: c.req.raw.signal,
    },
  );

  return c.json(result);
});

/**
 * Re-checks the library against the format currently selected.
 *
 * With `apply` unset this is a dry run: what would change if the library were
 * brought in line with this preset. With it set, the entries that need work are
 * queued -- re-downloads for changed sources, conversions where the file on
 * disk can be re-shaped instead.
 */
app.post("/api/sync", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    presetId?: string;
    options?: Partial<DownloadOptions>;
    historyIds?: string[];
    apply?: boolean;
  } | null;

  if (!body?.presetId) return c.json({ error: "No preset provided" }, 400);

  const settings = getSettings();
  const result = await syncLibrary(
    {
      presetId: body.presetId,
      options: { ...DEFAULT_DOWNLOAD_OPTIONS, ...body.options },
      historyIds: Array.isArray(body.historyIds) ? body.historyIds : undefined,
      apply: body.apply === true,
    },
    {
      skipExisting: settings.skipExisting !== false,
      convertInstead: settings.convertInstead !== false,
      signal: c.req.raw.signal,
    },
  );

  return c.json(result);
});

/**
 * Playlist entries streamed as they arrive rather than after the whole list is
 * read, so a 200-item playlist starts painting immediately.
 */
app.get("/api/probe/stream", (c) => {
  const rawUrl = c.req.query("url") ?? "";
  const url = normalizeUrl(rawUrl);
  if (!url) return c.json({ error: "No URL provided" }, 400);

  const settings = getSettings();
  const radio = isRadioList(url);
  const cap = radio ? Math.min(settings.playlistCap, 30) : settings.playlistCap;

  return streamSSE(c, async (stream) => {
    const send = (event: string, data: unknown) =>
      stream.writeSSE({ event, data: JSON.stringify(data) });

    await stream.writeSSE({ data: JSON.stringify({ type: "open" }) });

    let seen = 0;
    let metaSent = false;

    try {
      const handle = await runYtdlp({
        args: [
          "--flat-playlist",
          "--lazy-playlist",
          "--dump-json",
          "--yes-playlist",
          "--playlist-end",
          String(cap),
          "--sleep-requests",
          PLAYLIST_REQUEST_DELAY_SECONDS,
          "--",
          url,
        ],
        signal: c.req.raw.signal,
        timeoutMs: Math.max(90_000, cap * 1_000),
        onLine: (line) => {
          if (!line.startsWith("{")) return;
          try {
            const raw = JSON.parse(line) as Record<string, unknown>;

            if (raw._type === "playlist") {
              send("meta", { ...toPlaylistMeta(raw, url), radio });
              metaSent = true;
              return;
            }

            // Mixes have no playlist record, so the first entry carries the
            // playlist identity. The table can't render until meta arrives.
            if (!metaSent) {
              send("meta", { ...toPlaylistMeta(raw, url), radio });
              metaSent = true;
            }

            // Entries carry no usable index of their own, so number them in arrival order.
            send("entry", toEntry(raw, ++seen));
          } catch {
            /* a malformed line shouldn't kill the whole enumeration */
          }
        },
        withFfmpegLocation: false,
      });

      const code = await handle.done;
      // This write MUST be awaited. Returning from the streamSSE callback closes
      // the response, so an un-awaited final frame races the close and is
      // dropped -- the client then never sees `end` and falls back to the slow
      // non-streaming probe with a misleading "lost connection" error.
      await send("end", {
        code,
        truncated: seen >= cap,
        error:
          code === 0
            ? null
            : (lastError(handle.stderrText()) ??
              "Could not read this playlist."),
      });
    } catch (err) {
      // A spawn failure must still close with an `end` frame, otherwise the
      // client only learns of it when the connection drops.
      await send("end", {
        code: -1,
        truncated: false,
        error:
          err instanceof Error ? err.message : "Could not read this playlist.",
      });
    }
  });
});

app.post("/api/downloads", async (c) => {
  const body = (await c.req
    .json()
    .catch(() => null)) as DownloadBatchBody | null;
  const items = body ? downloadItemsFrom(body) : [];
  if (!body || items.length === 0) {
    return c.json({ error: "No download items provided" }, 400);
  }
  if (items.length > MAX_DOWNLOAD_ITEMS) {
    return c.json(
      { error: `Too many download items (maximum ${MAX_DOWNLOAD_ITEMS}).` },
      413,
    );
  }
  if (!body.presetId) return c.json({ error: "No preset provided" }, 400);

  const settings = getSettings();
  const options: DownloadOptions = {
    ...DEFAULT_DOWNLOAD_OPTIONS,
    ...body.options,
  };

  const created: string[] = [];
  const seenIds = new Set<string>();
  for (const item of items) {
    const validatedItem = validation.items([item])[0];
    const url = validatedItem.url;
    if (!url) continue;

    const request: DownloadRequest = {
      url,
      presetId: body.presetId,
      options,
      outputDir: body.outputDir || settings.outputDir,
      outputTemplate: body.outputTemplate || settings.outputTemplate,
      scheduledAt: body.scheduledAt,
      videoId: validatedItem.videoId,
      title: item.title,
      thumbnail: item.thumbnail,
      playlistIndex: item.playlistIndex ?? item.playlist?.entryIndex,
      playlist: item.playlist,
    };
    const id = startDownload(request);
    // startDownload coalesces identical active requests. Keep the response
    // one-row-per-job so the browser does not render duplicate queue entries
    // when a playlist contains the same video twice or the user double-clicks.
    if (!seenIds.has(id)) {
      seenIds.add(id);
      created.push(id);
    }
  }

  if (created.length === 0)
    return c.json({ error: "No valid URLs provided" }, 400);

  // Returning the jobs themselves lets the client paint the queue from the POST
  // response. Waiting for the next SSE frame makes the queue feel unresponsive
  // on the first batch, and silently shows nothing at all if that stream is
  // momentarily unhealthy.
  const jobs = created
    .map((id) => jobStore.get(id))
    .filter((j): j is JobState => j !== undefined);

  return c.json({ ids: created, jobs });
});

app.get("/api/jobs", (c) => c.json(jobStore.all()));

// Bun closes a connection that has been idle for longer than its idleTimeout
// (10s by default), which would silently kill an SSE stream the moment the
// queue goes quiet -- the queue then stops updating until the page is reloaded.
// The heartbeat has to stay comfortably under that, and idleTimeout is
// disabled outright below so a long download is never reaped mid-stream.
const SSE_HEARTBEAT_MS = 8_000;
/** A write that stays in flight this long means nothing is draining the socket. */
const SSE_STALL_MS = 20_000;
/** Hard ceiling so a wedged handler can never hold a subscription forever. */
const SSE_MAX_LIFETIME_MS = 30 * 60 * 1000;

app.get("/api/jobs/stream", (c) => {
  const response = streamSSE(c, async (stream) => {
    let disposed = false;

    // Hono only wires request-abort detection on old Bun builds. Without this,
    // a client that disappears leaves the subscription, its heartbeat and its
    // 30-minute lifetime timer running against a dead socket.
    const signal = c.req.raw.signal;
    const onSignalAbort = () => stream.abort();
    if (signal) signal.addEventListener("abort", onSignalAbort, { once: true });

    let inflight = 0;
    let oldestPendingAt: number | null = null;

    const write = (event: string, data: unknown): void => {
      if (disposed) return;
      inflight += 1;
      if (oldestPendingAt === null) oldestPendingAt = Date.now();
      const done = stream.writeSSE({ event, data: JSON.stringify(data) });
      void done
        .catch(() => undefined)
        .finally(() => {
          inflight -= 1;
          if (inflight === 0) oldestPendingAt = null;
        });
    };

    write("snapshot", jobStore.all());

    const unsub = jobStore.subscribe((deltas) => write("delta", deltas));
    const unsubEvents = subscribeEvents((event) => write(event.type, event));

    // Idle streams get dropped by proxies without a heartbeat.
    const heartbeat = setInterval(() => write("ping", {}), SSE_HEARTBEAT_MS);

    // A half-open connection (dead socket, buffered proxy) stays writable from
    // Hono's point of view: writes simply never resolve. Detecting the stall and
    // tearing the stream down lets the client reconnect to a healthy one.
    const liveness = setInterval(() => {
      if (disposed) return;
      if (
        oldestPendingAt !== null &&
        Date.now() - oldestPendingAt > SSE_STALL_MS
      ) {
        stream.abort();
      }
    }, 5_000);

    let lifetime: ReturnType<typeof setTimeout> | undefined;
    await new Promise<void>((resolve) => {
      stream.onAbort(() => resolve());
      lifetime = setTimeout(resolve, SSE_MAX_LIFETIME_MS);
    });

    disposed = true;
    clearInterval(heartbeat);
    clearInterval(liveness);
    if (lifetime) clearTimeout(lifetime);
    unsub();
    unsubEvents();
    if (signal) signal.removeEventListener("abort", onSignalAbort);
  });

  // streamSSE sets Cache-Control itself, so these have to go on afterwards.
  // `no-transform` and `X-Accel-Buffering: no` stop an intermediary (reverse
  // proxy, dev-server proxy) from buffering deltas until the response ends.
  response.headers.set("Cache-Control", "no-cache, no-transform");
  response.headers.set("X-Accel-Buffering", "no");
  return response;
});

app.post("/api/jobs/:id/cancel", async (c) => {
  const id = c.req.param("id");
  await cancelJob(id);
  return c.json({ ok: true });
});

app.post("/api/jobs/clear", (c) => {
  clearFinishedJobs();
  return c.json({ ok: true });
});

app.post("/api/jobs/:id/retry", async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => null)) as DownloadRequest | null;
  const retried = retryJob(id, body?.url ? body : undefined);
  if (!retried) return c.json({ error: "Job request not found" }, 404);
  return c.json({ ok: true });
});

app.delete("/api/jobs/:id", (c) => {
  removeJob(c.req.param("id"));
  return c.json({ ok: true });
});

app.get("/api/history", (c) => c.json(historyList()));
app.delete("/api/history/:id", (c) => {
  historyDelete(c.req.param("id"));
  return c.json({ ok: true });
});
app.delete("/api/history", (c) => {
  historyClear();
  return c.json({ ok: true });
});

/**
 * Video ids that already have a download recorded.
 *
 * With `?key=` the answer is scoped to one exact request (preset + output
 * options), computed by the same shared helper the download path uses, so the
 * playlist badge tracks the format currently selected. Without it, every video
 * ever downloaded is returned.
 *
 * Either way this is the cheap no-network answer. It cannot prove a file still
 * matches -- resolution and bitrate are only knowable by asking the site, and
 * that check happens when the download starts.
 */
const downloadedIds = (c: Context) => {
  const key = c.req.query("key")?.trim();
  return c.json(
    key ? [...downloadedIdsForRequest(key)] : [...downloadedVideoIds()],
  );
};
app.get("/api/downloaded", downloadedIds);
// Alias retained for older clients that used the history namespace.
app.get("/api/history/ids", downloadedIds);

app.get("/api/settings", (c) => c.json(getSettings()));
app.put("/api/settings", async (c) => {
  const patch = (await c.req.json().catch(() => ({}))) as Partial<Settings>;
  const next = putSettings(validation.settingsUpdate(patch));
  applySettingsOverrides(next);
  return c.json(next);
});

app.post("/api/settings/test-binary", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    path?: string;
  };
  if (!body.name) return c.json({ error: "name is required" }, 400);
  const flag = body.name === "ffmpeg" ? "-version" : "--version";
  const previous = getSettings();
  const overridePath =
    body.path ??
    (body.name === "ffmpeg" ? previous.ffmpegPath : previous.ytdlpPath);

  // This is a *test*, not a save. The override has to be swapped in so
  // resolveBinary() probes the path the user just typed, but it must be put
  // back afterwards: otherwise clicking "Test" on a path the user then
  // abandons (or clears and tests) silently repoints every later download at
  // a binary the saved settings never asked for, and the drift survives until
  // the server restarts.
  const info = overridePath?.trim()
    ? await probeOne(overridePath, flag)
    : await resolveBinary(body.name, flag, true);

  const requested = overridePath?.trim();
  const samePath =
    !!requested &&
    !!info &&
    path.normalize(info.path).toLowerCase() ===
      path.normalize(requested).toLowerCase();
  if (requested && !samePath) {
    return c.json({
      ok: false,
      error: `No working ${body.name} binary at that path`,
    });
  }
  return info
    ? c.json({ ok: true, info })
    : c.json({
        ok: false,
        error: `No working ${body.name} binary at that path`,
      });
});

app.post("/api/open-folder", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { path?: string };
  const settings = getSettings();
  const target = body.path && body.path.trim() ? body.path : settings.outputDir;
  if (!existsSync(target))
    return c.json({ error: "Folder does not exist" }, 400);
  try {
    if (process.platform === "win32")
      Bun.spawn(["explorer", target], { stdout: "ignore", stderr: "ignore" });
    else if (process.platform === "darwin")
      Bun.spawn(["open", target], { stdout: "ignore", stderr: "ignore" });
    else
      Bun.spawn(["xdg-open", target], { stdout: "ignore", stderr: "ignore" });
    return c.json({ ok: true });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : String(err) },
      500,
    );
  }
});

app.post("/api/jobs/:id/pause", async (c) => {
  await pauseJob(c.req.param("id"));
  return c.json({ ok: true });
});
app.post("/api/jobs/:id/resume", (c) =>
  c.json({ ok: resumeJob(c.req.param("id")) }),
);
app.post("/api/queue/reorder", async (c) => {
  const body = validation.object(await c.req.json());
  if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string"))
    return c.json({ error: "ids required" }, 400);
  reorderJobs(body.ids as string[]);
  return c.json({ ok: true });
});
app.post("/api/queue/bulk", async (c) => {
  const body = validation.object(await c.req.json());
  if (
    !["pause", "resume", "retry-failed", "cancel"].includes(String(body.action))
  )
    return c.json({ error: "Invalid bulk action" }, 400);
  const jobs = jobStore.all();
  if (body.action === "pause")
    await Promise.all(jobs.map((job) => pauseJob(job.id)));
  if (body.action === "cancel")
    await Promise.all(jobs.map((job) => cancelJob(job.id)));
  for (const job of jobs)
    if (
      (body.action === "resume" && job.phase === "paused") ||
      (body.action === "retry-failed" && job.phase === "error")
    )
      retryJob(job.id);
  return c.json({ ok: true });
});

app.route("/api", libraryRoutes);
app.route("/api", previewRoutes);

// In production one Bun process serves both the built SPA and the API.
const distDir = path.join(process.cwd(), "dist");
if (existsSync(distDir)) {
  app.use("/*", serveStatic({ root: "./dist" }));
  app.get("*", async (c) =>
    c.html(await Bun.file(path.join(distDir, "index.html")).text()),
  );
}

const serverOptions = {
  // Local-only: this server can spawn processes and touch the filesystem.
  ...serverAddress,
  fetch: app.fetch,
  // The job feed is a long-lived SSE stream and must never be reaped for being
  // idle. Dead clients are still cleaned up: the stream tears itself down when
  // the request aborts, when a write stalls, or after SSE_MAX_LIFETIME_MS.
  idleTimeout: 0,
};

export function startServer() {
  // Bind before recovering persisted jobs: a second launch must not rewrite
  // the queue belonging to the process that already owns this port.
  const server = Bun.serve(serverOptions);
  try {
    applySettingsOverrides(getSettings());
    initializeQueue();
  } catch (error) {
    server.stop(true);
    throw error;
  }
  console.log(`\n  API listening on ${server.url}\n`);
  return server;
}

// Use one explicit listener rather than Bun auto-serving a default export.
if (import.meta.main) {
  try {
    startServer();
  } catch (error) {
    console.error(startupError(error));
    process.exit(1);
  }
}
