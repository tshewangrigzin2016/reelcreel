import { toast } from "sonner";
import type { JobState } from "@shared/types";
import { useAppStore } from "./store";

/**
 * Fetching finished jobs to this device, one at a time.
 *
 * Two rules shape this module:
 *
 *  1. **One at a time.** Browsers block or silently drop simultaneous
 *     downloads, so a 20-video playlist has to be delivered sequentially. The
 *     server marks each job `delivered` when the last byte is sent, and that
 *     delta is what advances this queue -- the client never guesses.
 *
 *  2. **Only jobs this tab queued.** The set of ids to fetch lives in memory and
 *     is never persisted, so reloading the page cannot trigger a burst of
 *     downloads for a batch that finished while the tab was closed. Those rows
 *     render a Download button instead.
 *
 * The transfer itself is a plain navigation to `/api/jobs/:id/download`, which
 * the server answers with `Content-Disposition: attachment`. That keeps the
 * bytes out of JavaScript entirely: a 4K file streams straight to disk through
 * the browser's own download manager, and a dropped connection resumes with a
 * Range request rather than starting over.
 */

/** How long to wait for a `delivered` delta before assuming it was missed. */
const COMPLETION_WATCHDOG_MS = 120_000;
/** Client-side re-navigations before giving up on one file. */
const MAX_CLIENT_RETRIES = 3;

interface DeliveryItem {
  jobId: string;
  fileIndex: number;
  attempts: number;
}

const queue: DeliveryItem[] = [];
let active: DeliveryItem | null = null;
let watchdog: ReturnType<typeof setTimeout> | undefined;

/** Ids this tab queued, so completion can be attributed to a deliberate action. */
const claimed = new Set<string>();

/** Announce that this tab wants this job delivered when it finishes. */
export function claimDelivery(jobId: string): void {
  claimed.add(jobId);
  const job = useAppStore.getState().jobs[jobId];
  // Already finished before the claim (a fast download): queue it right away.
  if (job?.delivery?.state === "pending") enqueue(job);
}

/**
 * Starts delivery now, for a job the user clicked Download on.
 *
 * Used for rows that finished before this tab existed, and for a retry after an
 * expiry. Goes through the same sequential queue as automatic delivery, so a
 * click during a batch cannot produce two simultaneous browser downloads.
 */
export function startDelivery(jobId: string): void {
  const job = useAppStore.getState().jobs[jobId];
  if (!job?.delivery) {
    toast.error("This file is no longer available on the server.");
    return;
  }
  if (job.delivery.state === "expired" || job.delivery.state === "delivered") {
    toast.error(
      job.delivery.reason ?? "This file is no longer available on the server.",
    );
    return;
  }
  claimed.add(jobId);
  if (queue.some((item) => item.jobId === jobId) || active?.jobId === jobId)
    return;
  queue.push({ jobId, fileIndex: 0, attempts: 0 });
  pump();
}

/** Ids currently waiting or in flight, for the "N of M" readout. */
export function pendingDeliveryIds(): string[] {
  const ids = new Set(queue.map((item) => item.jobId));
  if (active) ids.add(active.jobId);
  return [...ids];
}

export function deliveryQueueLength(): number {
  return queue.length + (active ? 1 : 0);
}

/** Files delivered to this device since the page loaded. */
let sessionDelivered = 0;

/**
 * Progress for the queue header, as `{ done, total }`.
 *
 * Read during render rather than subscribed to: every change to these numbers
 * arrives with a job delta that already re-renders the table, so a second
 * subscription would only duplicate that work.
 */
export function deliveryProgress(): { done: number; total: number } {
  const remaining = deliveryQueueLength();
  return { done: sessionDelivered, total: sessionDelivered + remaining };
}

function enqueue(job: JobState): void {
  if (!claimed.has(job.id)) return;
  if (queue.some((item) => item.jobId === job.id)) return;
  if (active?.jobId === job.id) return;
  queue.push({ jobId: job.id, fileIndex: 0, attempts: 0 });
  pump();
}

/**
 * Starts the next file, if nothing is in flight.
 *
 * Called on every job delta, so it must be cheap and idempotent.
 */
export function pumpDelivery(): void {
  pump();
}

function pump(): void {
  if (active) return;
  const next = queue.shift();
  if (!next) return;
  active = next;
  start(next);
}

function start(item: DeliveryItem): void {
  const job = useAppStore.getState().jobs[item.jobId];
  const file = job?.delivery?.files[item.fileIndex];
  if (!job || !file) {
    finish(item);
    return;
  }

  // A detached anchor is the only way to trigger a browser download without a
  // user gesture per file, and `download` is what names it if the server's
  // Content-Disposition were ever ignored.
  const anchor = document.createElement("a");
  anchor.href = `/api/jobs/${encodeURIComponent(item.jobId)}/download?file=${item.fileIndex}`;
  anchor.download = file.name;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();

  clearWatchdog();
  watchdog = setTimeout(() => {
    // No `delivered` delta arrived. The server is the only authority on what
    // happened, so re-read the job rather than assuming success or failure.
    const current = useAppStore.getState().jobs[item.jobId];
    if (current?.delivery?.state === "delivered" || !current) {
      finish(item);
      return;
    }
    if (current.delivery?.state === "expired") {
      expired(current);
      finish(item);
      return;
    }
    retry(item, "The download did not start.");
  }, COMPLETION_WATCHDOG_MS);
}

function retry(item: DeliveryItem, reason: string): void {
  item.attempts += 1;
  if (item.attempts >= MAX_CLIENT_RETRIES) {
    toast.error(`Could not download “${titleOf(item.jobId)}”. ${reason}`);
    finish(item);
    return;
  }
  active = null;
  queue.unshift(item);
  pump();
}

function finish(item: DeliveryItem): void {
  clearWatchdog();
  active = null;
  claimed.delete(item.jobId);
  sessionDelivered += 1;
  pump();
}

function expired(job: JobState): void {
  claimed.delete(job.id);
  toast.error(
    job.delivery?.reason ??
      `“${job.title}” is no longer available on the server.`,
  );
}

function titleOf(jobId: string): string {
  return useAppStore.getState().jobs[jobId]?.title ?? "this video";
}

function clearWatchdog(): void {
  if (watchdog) clearTimeout(watchdog);
  watchdog = undefined;
}

/**
 * Reacts to job updates.
 *
 * Called from the SSE stream handler. Handles the three transitions that
 * matter: a claimed job becoming ready, a file being delivered (advance to the
 * next file, or finish the job), and a job expiring.
 */
export function onJobsChanged(jobs: JobState[]): void {
  for (const job of jobs) {
    if (!job.delivery) continue;
    if (job.delivery.state === "pending" && claimed.has(job.id) && !active)
      enqueue(job);
    if (job.delivery.state === "expired" && (active?.jobId === job.id || claimed.has(job.id))) {
      expired(job);
      if (active?.jobId === job.id) {
        const item = active;
        clearWatchdog();
        active = null;
        claimed.delete(item.jobId);
        pump();
      }
    }
    if (job.delivery.state === "delivered" && active?.jobId === job.id) {
      const item = active;
      // More files (sidecar captions) mean another sequential download before
      // this job is done.
      if (item.fileIndex + 1 < job.delivery.files.length) {
        clearWatchdog();
        active = { ...item, fileIndex: item.fileIndex + 1, attempts: 0 };
        start(active);
      } else {
        finish(item);
      }
    }
  }
}
