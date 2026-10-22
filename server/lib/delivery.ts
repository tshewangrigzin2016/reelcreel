import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import type {
  DeliveryFile,
  DeliveryInfo,
  DeliveryState,
  HistoryRow,
  JobState,
  Settings,
} from "../../shared/types";
import { getSettings, historyAdd, historyGet } from "./db";
import { jobStore } from "./queue";

/**
 * Delivery: getting a finished file out to the browser, then deleting it.
 *
 * The rules this module enforces, all server-side because none of them can be
 * trusted to a client that may have crashed:
 *
 *   - a file is deleted as soon as the last byte is sent;
 *   - a delivery attempt that ends early counts, and the file is deleted once
 *     the configured number of attempts have failed;
 *   - anything not delivered within the configured time limit is deleted;
 *   - completed-but-undelivered files never exceed the configured size cap --
 *     the oldest is evicted first;
 *   - files left over from a previous process are swept at startup.
 *
 * The job is the authority for this state: `JobState.delivery` is persisted
 * whole in the queue table and broadcast over the existing coalesced `delta` SSE
 * frame, so delivery progress needs no new event type and no client stream
 * changes. The history row is updated to match, because it outlives the job.
 */

/** Server mode: nothing is ever delivered, the file stays where it was put. */
export function deliveryEnabled(settings: Settings = getSettings()): boolean {
  return settings.deliveryMode === "browser";
}

/**
 * The folder a job's media is written into.
 *
 * Browser mode redirects to the temp directory. Everything downstream --
 * `stagingDir`, `ownedPath`, `publishFile`, `cleanupCompletedStage` -- derives
 * from `request.outputDir`, so pointing that at the temp dir makes the whole
 * existing pipeline work unchanged, with the file landing somewhere disposable.
 */
export function effectiveOutputDir(settings: Settings = getSettings()): string {
  return deliveryEnabled(settings) ? settings.tempDir : settings.outputDir;
}

/** What a finished job has ready for the browser. Index 0 is the media. */
export function deliveryInfo(id: string): DeliveryInfo | undefined {
  return jobStore.get(id)?.delivery ?? historyGet(id)?.delivery;
}

/**
 * Absolute path of one delivered file.
 *
 * Resolved through `effectiveOutputDir` rather than `tempDir` directly, so it
 * points at wherever the runner actually published -- the two must agree, and
 * deriving one from the other is the only way to guarantee it. Paths stay
 * server-side: the client only ever sees a name.
 */
function pathFor(name: string, settings: Settings = getSettings()): string {
  return path.join(effectiveOutputDir(settings), name);
}

/** One file, by index, with a freshly measured size. */
export function deliveryFile(
  id: string,
  index: number,
): { path: string; name: string; sizeBytes: number } | undefined {
  const entry = deliveryInfo(id)?.files[index];
  if (!entry) return undefined;
  const target = pathFor(entry.name);
  try {
    return { path: target, name: entry.name, sizeBytes: statSync(target).size };
  } catch {
    return undefined;
  }
}

/**
 * The delivery record for a job that has just finished, without writing it.
 *
 * Exposed so the runner can put it on the history row *and* the durable receipt
 * before either is persisted, which is what lets a restart replay the receipt
 * without re-inspecting a file that may already have been delivered.
 */
export function pendingDeliveryInfo(files: DeliveryFile[]): DeliveryInfo {
  return { state: "pending", attempts: 0, files, readyAt: Date.now() };
}

/**
 * Records that a job finished with media waiting for the browser.
 *
 * Used when the record has to be created after the fact (a receipt replayed on
 * restart). The normal path goes through `pendingDeliveryInfo` instead.
 */
export function registerDelivery(
  id: string,
  files: DeliveryFile[],
): DeliveryInfo {
  return patch(id, pendingDeliveryInfo(files));
}

/**
 * Writes a delivery record to the job and mirrors it onto the history row.
 *
 * The job update is what the client sees; the history write is what survives a
 * restart and what the library page reads. History is written best-effort: a
 * failed mirror must not turn a completed download into a failure.
 */
function patch(id: string, info: DeliveryInfo): DeliveryInfo {
  jobStore.update(id, { delivery: info });
  const row = historyGet(id);
  if (row) {
    try {
      historyAdd({ ...row, delivery: info });
    } catch {
      /* the job copy is authoritative; the next transition retries the mirror */
    }
  }
  return info;
}

/** A response for this file is starting. */
export function beginStream(id: string): DeliveryInfo | undefined {
  const info = deliveryInfo(id);
  if (!info) return undefined;
  return patch(id, { ...info, state: "streaming" });
}

/**
 * Every promised byte was sent.
 *
 * `index` is the file that just finished. The job only becomes `delivered` --
 * and only then is its staging removed -- once the last file in the list has
 * gone out, because a job with captions delivers several files in sequence and
 * deleting the media early would break the next one.
 */
export function completeStream(id: string, index: number): void {
  const info = deliveryInfo(id);
  if (!info) return;
  if (info.files.length - (index + 1) > 0) {
    patch(id, { ...info, state: "pending" });
    return;
  }
  patch(id, { ...info, state: "delivered" });
  removeJobMedia(id, info.files);
}

/**
 * A delivery attempt ended before every byte was sent.
 *
 * Attempts are counted here, on the server, because a crashed tab never reports
 * anything: the count has to survive the client. Returns the resulting state so
 * the route can tell the browser whether asking again is worth it.
 */
export function failStream(id: string, reason: string): DeliveryState {
  const info = deliveryInfo(id);
  if (!info) return "expired";
  const attempts = info.attempts + 1;
  const limit = getSettings().deliveryMaxAttempts;
  if (attempts >= limit) {
    expireDelivery(
      id,
      `Download failed ${attempts} times; the file was removed from the server.`,
    );
    return "expired";
  }
  patch(id, {
    ...info,
    state: "failed",
    attempts,
    reason: `${reason} (attempt ${attempts} of ${limit})`,
  });
  return "failed";
}

/** Deletes a job's media and records why. Used by every expiry path. */
export function expireDelivery(id: string, reason: string): void {
  const info = deliveryInfo(id);
  patch(id, {
    state: "expired",
    attempts: info?.attempts ?? 0,
    files: info?.files ?? [],
    readyAt: info?.readyAt ?? Date.now(),
    reason,
  });
  removeJobMedia(id, info?.files ?? []);
}

/**
 * Removes everything a job produced: the published files and its staging
 * directory.
 *
 * Both halves matter and neither implies the other. `publishFile` *copies* out
 * of staging into the output folder, so deleting only the staging directory
 * leaves the media behind -- which is precisely the leak this feature exists to
 * prevent. Deleting only the media would leave partial transfers on disk.
 */
function removeJobMedia(id: string, files: DeliveryFile[] = []): void {
  const settings = getSettings();
  const mediaDir = effectiveOutputDir(settings);
  for (const file of files)
    try {
      rmSync(path.join(mediaDir, file.name), { force: true });
    } catch {
      /* retention is safer than an uncertain delete; the sweeper retries */
    }
  const staging = jobStore.get(id)?.stagingDir;
  if (!staging) return;
  try {
    rmSync(staging, { recursive: true, force: true });
  } catch {
    /* retention is safer than an uncertain delete; the sweeper retries */
  }
}

export interface SweepResult {
  expiredByTtl: string[];
  expiredByCap: string[];
  removedOrphans: string[];
}

/**
 * The backstop.
 *
 * A tab that crashes leaves no signal at all, so the time limit is the only
 * thing that bounds disk use in that case. The size cap covers the other
 * failure mode: several large files finishing at once on a small disk.
 */
export function sweepDelivery(now = Date.now()): SweepResult {
  const result: SweepResult = {
    expiredByTtl: [],
    expiredByCap: [],
    removedOrphans: [],
  };
  const settings = getSettings();
  if (!deliveryEnabled(settings)) return result;

  const ttlMs = settings.deliveryTtlMinutes * 60_000;
  const capBytes = settings.tempCapMb * 1024 * 1024;

  const waiting = () =>
    jobStore
      .all()
      .map((job) => ({ job, info: job.delivery }))
      .filter(
        (entry): entry is { job: JobState; info: DeliveryInfo } =>
          entry.info !== undefined &&
          (entry.info.state === "pending" || entry.info.state === "failed"),
      );

  for (const { job, info } of waiting())
    if (now - info.readyAt > ttlMs) {
      expireDelivery(
        job.id,
        "Not downloaded within the time limit; the file was removed from the server.",
      );
      result.expiredByTtl.push(job.id);
    }

  // Re-read after TTL expiry so eviction sees what actually remains.
  const survivors = waiting()
    .filter((entry) => entry.info.state === "pending")
    .sort((a, b) => a.info.readyAt - b.info.readyAt);

  const sizeOf = (info: DeliveryInfo) =>
    info.files.reduce((n, file) => n + file.sizeBytes, 0);
  let total = survivors.reduce((sum, entry) => sum + sizeOf(entry.info), 0);
  for (const { job, info } of survivors) {
    if (total <= capBytes) break;
    expireDelivery(
      job.id,
      "The server's temporary storage limit was reached, so the oldest waiting file was removed.",
    );
    total -= sizeOf(info);
    result.expiredByCap.push(job.id);
  }

  result.removedOrphans = removeOrphans(settings);
  return result;
}

/**
 * Deletes transient files that no job claims.
 *
 * Covers a crash between publication and the delivery record, and anything a
 * previous process left behind. Only runs in browser mode and only inside the
 * temp directory, so it can never touch a real media collection.
 */
function removeOrphans(settings: Settings): string[] {
  const removed: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(settings.tempDir);
  } catch {
    return removed; // not created yet: nothing to sweep
  }
  const claimed = new Set(
    jobStore
      .all()
      .filter(
        (job) =>
          job.delivery?.state === "pending" || job.delivery?.state === "streaming",
      )
      .flatMap((job) => (job.delivery?.files ?? []).map((file) => file.name)),
  );
  for (const name of entries) {
    // `.yt-staging` holds in-flight work; a job that is mid-transfer has no
    // delivery record yet, so its staging must never be treated as an orphan.
    if (name === ".yt-staging" || claimed.has(name)) continue;
    try {
      rmSync(path.join(settings.tempDir, name), {
        recursive: true,
        force: true,
      });
      removed.push(name);
    } catch {
      /* a file in use will be caught next sweep */
    }
  }
  return removed;
}

/** Creates the temp directory. Called once at startup in browser mode. */
export function ensureTempDir(settings: Settings = getSettings()): void {
  if (!deliveryEnabled(settings)) return;
  mkdirSync(settings.tempDir, { recursive: true });
  mkdirSync(path.join(settings.tempDir, ".yt-staging"), { recursive: true });
}

/**
 * Repairs delivery state left behind by a process that died.
 *
 * A row stuck in `streaming` is wrong after a restart -- no response is in
 * flight any more -- and a `pending` row whose file is gone can never be
 * delivered, so it must not sit in the queue looking fetchable.
 */
export function recoverDeliveries(): void {
  const settings = getSettings();
  if (!deliveryEnabled(settings)) return;
  for (const job of jobStore.all()) {
    const info = job.delivery;
    if (!info) continue;
    if (info.state === "streaming") {
      patch(job.id, { ...info, state: "pending" });
      continue;
    }
    if (info.state !== "pending" && info.state !== "failed") continue;
    if (!info.files.every((file) => fileExists(pathFor(file.name))))
      expireDelivery(
        job.id,
        "The finished file was lost when the server restarted.",
      );
  }
}

function fileExists(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/** The history row for a job, once one has been written. */
export function historyRow(id: string): HistoryRow | undefined {
  return historyGet(id);
}
