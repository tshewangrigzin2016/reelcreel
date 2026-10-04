import type {
  SettingsUpdate,
  LibraryPage,
  FormatDiscovery,
  SyncTask,
} from "@shared/types";
import type {
  DownloadItem,
  HealthInfo,
  HistoryRow,
  JobState,
  PlaylistEntry,
  PlaylistPreview,
  PlanBatchResult,
  Preset,
  ProbeOutcome,
  Settings,
  SyncResult,
  VideoMeta,
} from "@shared/types";

export type { DownloadItem };

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new Error(message);
  }

  return body as T;
}

const post = (path: string) => () =>
  request<{ ok: true }>(path, { method: "POST" });

export const api = {
  library: (query: string, preset: string, page: number) =>
    request<LibraryPage>(
      "/library?q=" +
        encodeURIComponent(query) +
        "&preset=" +
        encodeURIComponent(preset) +
        "&page=" +
        page,
    ),
  openFile: (id: string, reveal = false) =>
    request("/library/" + id + "/open", {
      method: "POST",
      body: JSON.stringify({ reveal }),
    }),
  deleteMedia: (id: string) =>
    request("/library/" + id + "/media", { method: "DELETE" }),
  formats: (url: string, signal?: AbortSignal) =>
    request<FormatDiscovery>("/formats?url=" + encodeURIComponent(url), {
      signal,
    }),
  pauseJob: (id: string) =>
    request("/jobs/" + id + "/pause", { method: "POST" }),
  resumeJob: (id: string) =>
    request("/jobs/" + id + "/resume", { method: "POST" }),
  reorder: (ids: string[]) =>
    request("/queue/reorder", {
      method: "POST",
      body: JSON.stringify({ ids }),
    }),
  bulkQueue: (action: string) =>
    request("/queue/bulk", {
      method: "POST",
      body: JSON.stringify({ action }),
    }),
  startSync: (presetId: string, options: unknown) =>
    request<SyncTask>("/sync/start", {
      method: "POST",
      body: JSON.stringify({ presetId, options }),
    }),
  syncStatus: (id: string) => request<SyncTask>("/sync/" + id),
  cancelSync: (id: string) =>
    request("/sync/" + id + "/cancel", { method: "POST" }),
  applySync: (id: string) =>
    request<{ queued: number }>("/sync/" + id + "/apply", { method: "POST" }),
  health: () => request<HealthInfo>("/health"),
  presets: () => request<Preset[]>("/presets"),

  probe: (url: string, signal?: AbortSignal) =>
    request<ProbeOutcome>("/probe", {
      method: "POST",
      body: JSON.stringify({ url }),
      signal,
    }),

  probeVideo: (url: string) =>
    request<VideoMeta>(`/probe/video?url=${encodeURIComponent(url)}`),

  /**
   * Reads a pasted list of individual video URLs into selection-table entries.
   *
   * Downloads nothing. This is what lets a batch be reviewed, narrowed and
   * re-checked against the selected format before a single job is queued.
   */
  probeBatch: (urls: string[], signal?: AbortSignal) =>
    request<{ entries: PlaylistEntry[]; errors: string[] }>("/probe/batch", {
      method: "POST",
      body: JSON.stringify({ urls }),
      signal,
    }),

  /** First entry only — fast enough to show a thumbnail while the rest loads. */
  playlistPreview: (url: string, signal?: AbortSignal) =>
    request<PlaylistPreview>(`/probe/first?url=${encodeURIComponent(url)}`, {
      signal,
    }),

  /**
   * Returns the freshly created jobs so the queue can be painted from the
   * response, without waiting for the next eventsource frame.
   */
  download: (
    presetId: string,
    options: unknown,
    items: DownloadItem[],
    extra: {
      scheduledAt?: number;
      outputDir?: string;
      outputTemplate?: string;
    } = {},
  ) =>
    request<{ ids: string[]; jobs: JobState[] }>("/downloads", {
      method: "POST",
      body: JSON.stringify({ presetId, options, items, ...extra }),
    }),

  /**
   * Re-plans a whole selection against a preset, downloading nothing. Used when
   * the format or quality changes so every row can be re-checked at once.
   */
  planBatch: (
    presetId: string,
    options: unknown,
    items: DownloadItem[],
    signal?: AbortSignal,
  ) =>
    request<PlanBatchResult>("/plan/batch", {
      signal,
      method: "POST",
      body: JSON.stringify({ presetId, options, items }),
    }),

  /** Re-checks the library against a preset. `apply` queues the work it finds. */
  sync: (
    presetId: string,
    options: unknown,
    apply: boolean,
    historyIds?: string[],
  ) =>
    request<SyncResult>("/sync", {
      method: "POST",
      body: JSON.stringify({ presetId, options, apply, historyIds }),
    }),

  jobs: () => request<JobState[]>("/jobs"),
  cancelJob: (id: string) =>
    request<{ ok: true }>(`/jobs/${id}/cancel`, { method: "POST" }),
  retryJob: (id: string) =>
    request<{ ok: true }>(`/jobs/${id}/retry`, { method: "POST", body: "{}" }),
  removeJob: (id: string) =>
    request<{ ok: true }>(`/jobs/${id}`, { method: "DELETE" }),
  clearJobs: post("/jobs/clear"),

  history: () => request<HistoryRow[]>("/history"),
  historyIds: (requestKey?: string) =>
    request<string[]>(
      requestKey
        ? `/downloaded?key=${encodeURIComponent(requestKey)}`
        : "/downloaded",
    ),
  deleteHistory: (id: string) =>
    request<{ ok: true }>(`/history/${id}`, { method: "DELETE" }),
  clearHistory: () => request<{ ok: true }>("/history", { method: "DELETE" }),

  settings: () => request<Settings>("/settings"),
  saveSettings: (patch: SettingsUpdate) =>
    request<Settings>("/settings", {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  testBinary: (name: "yt-dlp" | "ffmpeg", path?: string) =>
    request<{
      ok: boolean;
      info?: { path: string; version: string };
      error?: string;
    }>("/settings/test-binary", {
      method: "POST",
      body: JSON.stringify({ name, path }),
    }),

  openFolder: post("/open-folder"),
};

export interface PlaylistStreamMeta {
  id: string;
  title: string;
  uploader?: string;
  webpageUrl?: string;
  radio?: boolean;
}

export interface StreamHandlers {
  onMeta: (meta: PlaylistStreamMeta) => void;
  /** Entries arrive batched so a 200-item playlist doesn't re-render per row. */
  onEntries: (entries: PlaylistEntry[]) => void;
  onDone: (result: {
    ok: boolean;
    error?: string;
    truncated?: boolean;
    cap?: number;
  }) => void;
}

/**
 * Streams playlist entries over SSE so the selection table paints as videos
 * arrive, instead of blocking on the whole enumeration. Returns a cancel fn.
 */
export function probePlaylistStream(
  url: string,
  handlers: StreamHandlers,
): () => void {
  const source = new EventSource(
    `/api/probe/stream?url=${encodeURIComponent(url)}`,
  );
  let buffer: PlaylistEntry[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (buffer.length === 0) return;
    const batch = buffer;
    buffer = [];
    handlers.onEntries(batch);
  };

  const finish = (result: {
    ok: boolean;
    error?: string;
    truncated?: boolean;
    cap?: number;
  }) => {
    if (closed) return;
    closed = true;
    flush();
    source.close();
    handlers.onDone(result);
  };

  source.addEventListener("meta", (event) => {
    try {
      handlers.onMeta(
        JSON.parse((event as MessageEvent<string>).data) as PlaylistStreamMeta,
      );
    } catch {
      /* ignore a malformed meta frame */
    }
  });

  source.addEventListener("entry", (event) => {
    try {
      buffer.push(
        JSON.parse((event as MessageEvent<string>).data) as PlaylistEntry,
      );
      if (timer === null) timer = setTimeout(flush, 120);
    } catch {
      /* ignore a malformed entry frame */
    }
  });

  source.addEventListener("end", (event) => {
    let payload: {
      code?: number;
      error?: string | null;
      truncated?: boolean;
      cap?: number;
    } = {};
    try {
      payload = JSON.parse((event as MessageEvent<string>).data);
    } catch {
      /* fall through to the default failure below */
    }
    finish(
      payload.code === 0
        ? { ok: true, truncated: payload.truncated, cap: payload.cap }
        : {
            ok: false,
            error: payload.error ?? "Could not read this playlist.",
          },
    );
  });

  source.addEventListener("error", () => {
    finish({ ok: false, error: "Lost connection while reading the playlist." });
  });

  return () => {
    closed = true;
    if (timer !== null) clearTimeout(timer);
    buffer = [];
    source.close();
  };
}

export type {
  PlaylistEntry,
  VideoMeta,
  JobState,
  Preset,
  Settings,
  HistoryRow,
  HealthInfo,
  PlanBatchResult,
  SyncResult,
};
