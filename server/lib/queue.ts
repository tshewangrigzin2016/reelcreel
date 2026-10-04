import { publish } from "./events";
import type { JobState } from "../../shared/types";

/**
 * Coalescing job store.
 *
 * yt-dlp emits progress far faster than any UI needs, and pushing every parsed
 * line into React state causes re-render storms. So: the parser mutates job
 * state, a single 100ms timer flushes all dirty jobs as ONE frame containing an
 * array of deltas, and only phase transitions bypass the timer.
 */
export class JobStore {
  persist?: (state: JobState) => void;
  private jobs = new Map<string, JobState>();
  private dirty = new Set<string>();
  private subs = new Set<(deltas: JobState[]) => void>();
  private timer: ReturnType<typeof setInterval>;

  constructor(intervalMs = 100) {
    this.timer = setInterval(() => this.flush(), intervalMs);
    this.timer?.unref?.();
  }

  get(id: string): JobState | undefined {
    return this.jobs.get(id);
  }

  all(): JobState[] {
    return [...this.jobs.values()];
  }

  create(state: JobState): void {
    this.persist?.(state);
    this.jobs.set(state.id, state);
    this.dirty.add(state.id);
    this.flush();
  }

  update(id: string, patch: Partial<JobState>): void {
    const cur = this.jobs.get(id);
    if (!cur) return;
    const phaseChanged = patch.phase !== undefined && patch.phase !== cur.phase;
    const next = { ...cur, ...patch };
    if (
      phaseChanged ||
      patch.order !== undefined ||
      patch.attempts !== undefined
    ) {
      try {
        this.persist?.(next);
      } catch (error) {
        this.jobs.set(id, {
          ...next,
          phase: "error",
          error:
            "Could not persist queue state: " +
            (error instanceof Error ? error.message : String(error)),
        });
        this.dirty.add(id);
        this.flush();
        throw error;
      }
    }
    this.jobs.set(id, next);
    this.dirty.add(id);
    // Transitions are rare and important (queued -> downloading -> done), so
    // they bypass the timer and go out immediately.
    if (phaseChanged) this.flush();
  }

  delete(id: string): void {
    this.jobs.delete(id);
    this.dirty.delete(id);
    publish({ type: "removed", ids: [id] });
  }

  subscribe(fn: (deltas: JobState[]) => void): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  flush(): void {
    if (this.dirty.size === 0) return;
    const deltas: JobState[] = [];
    for (const id of this.dirty) {
      const job = this.jobs.get(id);
      if (job) deltas.push(job);
    }
    this.dirty.clear();
    for (const fn of this.subs) {
      try {
        fn(deltas);
      } catch {
        /* a broken subscriber must not stop the fan-out */
      }
    }
  }
}

/** Bounded-concurrency pool. Three pools keep IO, bandwidth and CPU separate. */
export class Pool {
  private active = 0;
  private waiting: Array<{
    resolve: () => void;
    reject: (reason?: unknown) => void;
    signal?: AbortSignal;
    abort: () => void;
  }> = [];
  constructor(public limit: number) {}
  setLimit(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > 16)
      throw new Error("Invalid pool limit");
    this.limit = n;
    this.pump();
  }
  get running(): number {
    return this.active;
  }
  get pending(): number {
    return this.waiting.length;
  }
  private pump(): void {
    while (this.waiting.length && this.active < this.limit) {
      const entry = this.waiting.shift()!;
      entry.signal?.removeEventListener("abort", entry.abort);
      if (entry.signal?.aborted) {
        entry.reject(entry.signal.reason);
        continue;
      }
      this.active++;
      entry.resolve();
    }
  }
  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active < this.limit) this.active++;
    else
      await new Promise<void>((resolve, reject) => {
        const entry = {
          resolve,
          reject,
          signal,
          abort: () => {
            this.waiting = this.waiting.filter((e) => e !== entry);
            reject(signal?.reason ?? new Error("Cancelled"));
          },
        };
        this.waiting.push(entry);
        signal?.addEventListener("abort", entry.abort, { once: true });
      });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.pump();
    };
  }
  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal);
    try {
      signal?.throwIfAborted();
      return await fn();
    } finally {
      release();
    }
  }
}
export const jobStore = new JobStore();
export const pools = {
  probe: new Pool(4),
  download: new Pool(3),
  ffmpeg: new Pool(1),
};
export function configurePools(
  probe: number,
  download: number,
  conversion = 1,
): void {
  pools.probe.setLimit(probe);
  pools.download.setLimit(download);
  pools.ffmpeg.setLimit(conversion);
}
