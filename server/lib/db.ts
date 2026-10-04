import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";
import { publish } from "./events";
import type {
  DownloadRequest,
  DownloadProfile,
  JobState,
  LibraryPage,
  SettingsUpdate,
  HistoryRow,
  Settings,
} from "../../shared/types";
import type {
  FileFingerprint,
  PlaylistDownloadContext,
  SourceFingerprint,
} from "../../shared/types";

const DATA_DIR = process.env.YTD_DATA_DIR || path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "yt-downloader.db");

let db: Database | null = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS history (
  id            TEXT PRIMARY KEY,
  video_id      TEXT NOT NULL,
  title         TEXT NOT NULL,
  uploader      TEXT,
  thumbnail     TEXT,
  file_path     TEXT,
  preset_id     TEXT,
  ext           TEXT,
  size_bytes    INTEGER,
  duration      INTEGER,
  completed_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_history_video ON history(video_id);
CREATE INDEX IF NOT EXISTS idx_history_time ON history(completed_at DESC);

CREATE TABLE IF NOT EXISTS meta_cache (
  video_id    TEXT PRIMARY KEY,
  json        TEXT NOT NULL,
  fetched_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * Columns added for de-duplication. Kept as separate ALTERs rather than folded
 * into SCHEMA because databases created before this feature exist on disk and
 * `CREATE TABLE IF NOT EXISTS` would silently leave them without the columns --
 * every fingerprint would then be written to a column that isn't there and
 * quietly thrown away, disabling skipping with no visible error.
 */
const MIGRATIONS: Array<[column: string, ddl: string]> = [
  ["request_key", "ALTER TABLE history ADD COLUMN request_key TEXT"],
  ["source_json", "ALTER TABLE history ADD COLUMN source_json TEXT"],
  ["file_json", "ALTER TABLE history ADD COLUMN file_json TEXT"],
  ["playlist_json", "ALTER TABLE history ADD COLUMN playlist_json TEXT"],
  // Needed so a stored row can be re-checked later without guessing the URL
  // back from a video id, which only works for one extractor.
  ["url", "ALTER TABLE history ADD COLUMN url TEXT"],
  ["provenance", "ALTER TABLE history ADD COLUMN provenance TEXT"],
];

function migrate(conn: Database): void {
  const existing = new Set(
    conn
      .query<{ name: string }, []>("PRAGMA table_info(history)")
      .all()
      .map((r) => r.name),
  );
  for (const [column, ddl] of MIGRATIONS) {
    if (existing.has(column)) continue;
    try {
      conn.exec(ddl);
    } catch (error) {
      // A concurrent process may have won the ALTER race. Re-check instead of
      // swallowing permissions/corruption errors that would otherwise make
      // every later history insert fail silently.
      const now = new Set(
        conn
          .query<{ name: string }, []>("PRAGMA table_info(history)")
          .all()
          .map((r) => r.name),
      );
      if (!now.has(column)) throw error;
    }
  }
  conn.exec(
    "CREATE INDEX IF NOT EXISTS idx_history_lookup ON history(video_id, request_key)",
  );
}

export function getDb(): Database {
  if (db) return db;
  mkdirSync(DATA_DIR, { recursive: true });
  const next = new Database(DB_PATH, { create: true });
  try {
    next.exec("PRAGMA journal_mode = WAL");
    next.exec("PRAGMA busy_timeout = 5000");
    const version =
      next.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version ?? 0;
    if (version < 1) {
      const hasHistory = next
        .query("SELECT name FROM sqlite_master WHERE name = 'history'")
        .get();
      if (hasHistory) {
        const backup = path.join(DATA_DIR, "before-v1-" + Date.now() + ".db");
        next.exec("VACUUM INTO '" + backup.replaceAll("'", "''") + "'");
      }
      next.transaction(() => {
        next.exec(SCHEMA);
        migrate(next);
        next.exec(
          "CREATE TABLE IF NOT EXISTS jobs (id TEXT PRIMARY KEY, request_json TEXT NOT NULL, state_json TEXT NOT NULL)",
        );
        next.exec(
          "CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, json TEXT NOT NULL)",
        );
        next.exec("PRAGMA user_version = 1");
      })();
    }
    db = next;
    return next;
  } catch (error) {
    try {
      next.close();
    } catch {
      /* preserve the schema error */
    }
    db = null;
    throw error;
  }
}

const META_TTL_MS = 6 * 60 * 60 * 1000; // 6h for full metadata

export function cacheGet<T>(videoId: string, ttl = META_TTL_MS): T | null {
  try {
    const row = getDb()
      .query<
        { json: string; fetched_at: number },
        string
      >("SELECT json, fetched_at FROM meta_cache WHERE video_id = ?1")
      .get(videoId);
    if (!row) return null;
    if (Date.now() - row.fetched_at > ttl) return null;
    return JSON.parse(row.json) as T;
  } catch {
    return null;
  }
}

export function cacheSet(videoId: string, value: unknown): void {
  try {
    const conn = getDb();
    const now = Date.now();
    conn
      .query(
        "INSERT INTO meta_cache (video_id, json, fetched_at) VALUES (?1, ?2, ?3) " +
          "ON CONFLICT(video_id) DO UPDATE SET json = ?2, fetched_at = ?3",
      )
      .run(videoId, JSON.stringify(value), now);
    // Expired metadata is harmless but otherwise grows forever in a long-lived
    // desktop session. Cleanup is opportunistic so reads stay on the hot path.
    conn
      .query("DELETE FROM meta_cache WHERE fetched_at < ?1")
      .run(now - META_TTL_MS * 2);
  } catch {
    /* cache failures must never break a download */
  }
}

export function historyAdd(row: HistoryRow): void {
  getDb()
    .query(
      "INSERT OR REPLACE INTO history " +
        "(id, video_id, title, uploader, thumbnail, file_path, preset_id, ext, size_bytes, duration, completed_at, " +
        "request_key, source_json, file_json, playlist_json, url, provenance) " +
        "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
    )
    .run(
      row.id,
      row.videoId,
      row.title,
      row.uploader ?? null,
      row.thumbnail ?? null,
      row.filePath ?? null,
      row.presetId,
      row.ext ?? null,
      row.sizeBytes ?? null,
      row.duration ?? null,
      row.completedAt,
      row.requestKey ?? null,
      row.source ? JSON.stringify(row.source) : null,
      row.file ? JSON.stringify(row.file) : null,
      row.playlist ? JSON.stringify(row.playlist) : null,
      row.url ?? null,
      row.provenance ?? "unknown",
    );
  publish({ type: "library" });
}

/**
 * Every completed download of one video, newest first.
 *
 * All of them, not just the latest: the point of the lookup is to answer "do we
 * already have this exact thing", and an older row can be the match while a
 * newer one is a different preset.
 */
export function historyForVideo(videoId: string): HistoryRow[] {
  try {
    return getDb()
      .query<
        Record<string, unknown>,
        string
      >("SELECT * FROM history WHERE video_id = ?1 ORDER BY completed_at DESC")
      .all(videoId)
      .map(mapHistoryRow);
  } catch {
    return [];
  }
}

/**
 * Video ids that already have a download recorded under `requestKey`.
 *
 * This is the cheap, no-network answer the playlist table badge needs. It does
 * NOT prove the file still matches -- resolution and bitrate can only be
 * compared against a live source, which happens when the download starts.
 */
export function downloadedIdsForRequest(requestKey: string): Set<string> {
  try {
    const rows = getDb()
      .query<
        { video_id: string },
        string
      >("SELECT DISTINCT video_id FROM history WHERE request_key = ?1")
      .all(requestKey);
    return new Set(rows.map((r) => r.video_id));
  } catch {
    return new Set();
  }
}

export function historyList(limit = 200): HistoryRow[] {
  try {
    const rows = getDb()
      .query<
        Record<string, unknown>,
        number
      >("SELECT * FROM history ORDER BY completed_at DESC LIMIT ?1")
      .all(limit);
    return rows.map(mapHistoryRow);
  } catch {
    return [];
  }
}

/**
 * Specific rows by id, for a library sweep that only covers part of the list.
 *
 * Falls back to the whole library when no ids are given, ordered newest first so
 * a sweep that has to stop early still covers the most recent downloads.
 */
export function historyRowsFor(ids?: string[]): HistoryRow[] {
  const conn = getDb();
  try {
    if (!ids || ids.length === 0) return historyList(-1);

    const placeholders = ids.map(() => "?").join(",");
    return conn
      .query<Record<string, unknown>, string[]>(
        `SELECT * FROM history WHERE id IN (${placeholders}) ORDER BY completed_at DESC`,
      )
      .all(...ids)
      .map(mapHistoryRow);
  } catch {
    return [];
  }
}

export function historyDelete(id: string): void {
  getDb().query("DELETE FROM history WHERE id = ?1").run(id);
  publish({ type: "library" });
}
export function historyClear(): void {
  getDb().query("DELETE FROM history").run();
  publish({ type: "library" });
}

export function downloadedVideoIds(): Set<string> {
  try {
    const rows = getDb()
      .query<{ video_id: string }, []>("SELECT DISTINCT video_id FROM history")
      .all();
    return new Set(rows.map((r) => r.video_id));
  } catch {
    return new Set();
  }
}

function mapHistoryRow(r: Record<string, unknown>): HistoryRow {
  return {
    provenance: (r.provenance as HistoryRow["provenance"]) ?? "unknown",
    id: String(r.id),
    url: (r.url as string) ?? undefined,
    videoId: String(r.video_id),
    title: String(r.title),
    uploader: (r.uploader as string) ?? undefined,
    thumbnail: (r.thumbnail as string) ?? undefined,
    filePath: (r.file_path as string) ?? undefined,
    presetId: String(r.preset_id ?? ""),
    ext: (r.ext as string) ?? undefined,
    sizeBytes: (r.size_bytes as number) ?? undefined,
    duration: (r.duration as number) ?? undefined,
    completedAt: Number(r.completed_at),
    requestKey: (r.request_key as string) ?? undefined,
    source: parseJson<SourceFingerprint>(r.source_json),
    file: parseJson<FileFingerprint>(r.file_json),
    playlist: parseJson<PlaylistDownloadContext>(r.playlist_json),
  };
}

function parseJson<T>(value: unknown): T | undefined {
  if (typeof value !== "string" || !value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

const DEFAULT_SETTINGS: Settings = {
  conversionConcurrency: 1,
  jsRuntime: "node",
  outputDir: path.join(process.cwd(), "downloads"),
  outputTemplate: "%(title).150s [%(id)s].%(ext)s",
  playlistCap: 200,
  downloadConcurrency: 3,
  probeConcurrency: 4,
  skipExisting: true,
  convertInstead: true,
};

const MAX_CONCURRENCY = 16;

function boundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n)
    ? Math.min(max, Math.max(min, Math.round(n)))
    : fallback;
}

/**
 * Built key by key, never by spreading.
 *
 * A database written before a setting was retired still carries its key in the
 * `settings` table. Spreading `raw` would return it from `GET /api/settings`,
 * the client would echo the whole object back in `PUT /api/settings`, and
 * `settingsUpdate()` would reject it as an unknown setting -- saving Settings
 * would break outright. Naming every key we return means a retired key is
 * dropped on read and never reaches the write path.
 */
function normalizedSettings(raw: Partial<Settings>): Settings {
  return {
    conversionConcurrency: boundedInt(
      raw.conversionConcurrency,
      DEFAULT_SETTINGS.conversionConcurrency,
      1,
      4,
    ),
    jsRuntime: raw.jsRuntime === "deno" ? "deno" : "node",
    runtimePath: raw.runtimePath || undefined,
    cookiesPath: raw.cookiesPath || undefined,
    ytdlpPath:
      typeof raw.ytdlpPath === "string" && raw.ytdlpPath.trim()
        ? raw.ytdlpPath.trim()
        : undefined,
    ffmpegPath:
      typeof raw.ffmpegPath === "string" && raw.ffmpegPath.trim()
        ? raw.ffmpegPath.trim()
        : undefined,
    outputDir:
      typeof raw.outputDir === "string" && raw.outputDir.trim()
        ? raw.outputDir.trim()
        : DEFAULT_SETTINGS.outputDir,
    outputTemplate:
      typeof raw.outputTemplate === "string" && raw.outputTemplate.trim()
        ? raw.outputTemplate.trim()
        : DEFAULT_SETTINGS.outputTemplate,
    playlistCap: boundedInt(
      raw.playlistCap,
      DEFAULT_SETTINGS.playlistCap,
      1,
      10_000,
    ),
    downloadConcurrency: boundedInt(
      raw.downloadConcurrency,
      DEFAULT_SETTINGS.downloadConcurrency,
      1,
      MAX_CONCURRENCY,
    ),
    probeConcurrency: boundedInt(
      raw.probeConcurrency,
      DEFAULT_SETTINGS.probeConcurrency,
      1,
      MAX_CONCURRENCY,
    ),
    skipExisting: raw.skipExisting !== false,
    convertInstead: raw.convertInstead !== false,
  };
}

export function getSettings(): Settings {
  try {
    const rows = getDb()
      .query<
        { key: string; value: string },
        []
      >("SELECT key, value FROM settings")
      .all();
    const stored: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        stored[r.key] = JSON.parse(r.value);
      } catch {
        stored[r.key] = r.value;
      }
    }
    return normalizedSettings(stored as Partial<Settings>);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function putSettings(patch: SettingsUpdate): Settings {
  const next = normalizedSettings({
    ...getSettings(),
    ...patch,
  } as Partial<Settings>);
  const conn = getDb();
  const write = conn.transaction((entries: Array<[string, unknown]>) => {
    const statement = conn.query(
      "INSERT INTO settings (key, value) VALUES (?1, ?2) " +
        "ON CONFLICT(key) DO UPDATE SET value = ?2",
    );
    for (const [k, v] of entries) statement.run(k, JSON.stringify(v ?? null));
  });
  write(Object.entries(next));
  return next;
}

export function libraryPage(
  query = "",
  preset = "",
  page = 1,
  pageSize = 40,
): LibraryPage {
  const conn = getDb();
  const where =
    " WHERE (?1 = '' OR title LIKE ?2 OR video_id LIKE ?2) AND (?3 = '' OR preset_id = ?3)";
  const total =
    conn
      .query<
        { count: number },
        [string, string, string]
      >("SELECT COUNT(*) as count FROM history" + where)
      .get(query, "%" + query + "%", preset)?.count ?? 0;
  const rows = conn
    .query<Record<string, unknown>, [string, string, string, number, number]>(
      "SELECT * FROM history" +
        where +
        " ORDER BY completed_at DESC, id LIMIT ?4 OFFSET ?5",
    )
    .all(query, "%" + query + "%", preset, pageSize, (page - 1) * pageSize)
    .map(mapHistoryRow)
    .map((row) => ({
      ...row,
      missing: !row.filePath || !existsSync(row.filePath),
    }));
  return { rows, total, page, pageSize };
}
export function historyGet(id: string): HistoryRow | undefined {
  const raw = getDb()
    .query<
      Record<string, unknown>,
      string
    >("SELECT * FROM history WHERE id = ?1")
    .get(id);
  return raw ? mapHistoryRow(raw) : undefined;
}
export function saveJob(request: DownloadRequest, state: JobState): void {
  getDb()
    .query(
      "INSERT INTO jobs VALUES (?1, ?2, ?3) ON CONFLICT(id) DO UPDATE SET request_json=?2, state_json=?3",
    )
    .run(state.id, JSON.stringify(request), JSON.stringify(state));
}
export function deleteSavedJob(id: string): void {
  getDb().query("DELETE FROM jobs WHERE id=?1").run(id);
}
export function loadJobs(): Array<{
  request: DownloadRequest;
  state: JobState;
}> {
  return getDb()
    .query<{ request_json: string; state_json: string }, []>(
      "SELECT * FROM jobs",
    )
    .all()
    .map((row) => ({
      request: JSON.parse(row.request_json),
      state: JSON.parse(row.state_json),
    }));
}
export function profiles(): DownloadProfile[] {
  return getDb()
    .query<{ json: string }, []>("SELECT json FROM profiles")
    .all()
    .map((row) => JSON.parse(row.json));
}
export function saveProfile(profile: DownloadProfile): void {
  getDb()
    .query(
      "INSERT INTO profiles VALUES (?1, ?2) ON CONFLICT(id) DO UPDATE SET json=?2",
    )
    .run(profile.id, JSON.stringify(profile));
}
export function deleteProfile(id: string): void {
  getDb().query("DELETE FROM profiles WHERE id=?1").run(id);
}
