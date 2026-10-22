import { libraryChanged } from "./query";
import { onJobsChanged } from "./delivery";
import { useEffect } from "react";
import type { JobState } from "@shared/types";
import { useAppStore } from "./store";

/** The server heartbeats every 10s, so 35s of silence means the stream is dead. */
const SILENCE_TIMEOUT_MS = 35_000;
const SILENCE_CHECK_MS = 5_000;
const RECONNECT_DELAY_MS = 1_500;

/**
 * One EventSource for the whole queue. The server coalesces updates every
 * 100ms, so this receives ~10 frames/sec regardless of how many downloads are
 * running — no re-render storms.
 *
 * EventSource retries automatically, but only for connections the browser knows
 * are broken. A stream killed by a proxy timeout, a suspended tab or a dropped
 * socket stays "open" from the browser's point of view and simply never
 * delivers another frame. That is why the queue used to need a page reload.
 * The watchdog below detects the silence and reconnects; every reconnect gets a
 * full snapshot from the server, so no state is lost.
 */
export function useJobsStream(): void {
  useEffect(() => {
    let disposed = false;
    let source: EventSource | null = null;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let lastFrameAt = Date.now();

    const clearTimers = () => {
      if (watchdog) clearInterval(watchdog);
      if (reconnect) clearTimeout(reconnect);
      watchdog = undefined;
      reconnect = undefined;
    };

    const connect = () => {
      if (disposed) return;
      clearTimers();

      source?.close();
      const es = new EventSource("/api/jobs/stream");
      source = es;
      lastFrameAt = Date.now();

      const touch = () => {
        lastFrameAt = Date.now();
      };

      const applyJobs = (event: Event, replace: boolean) => {
        touch();
        try {
          const jobs = JSON.parse(
            (event as MessageEvent<string>).data,
          ) as JobState[];
          if (replace) {
            useAppStore.getState().setJobs(jobs);
            libraryChanged();
          } else useAppStore.getState().upsertJobs(jobs);
          // Delivery is driven by these deltas: the server marks a job
          // `delivered` once every byte has been sent, and that is what
          // advances the sequential download queue.
          onJobsChanged(jobs);
        } catch {
          /* ignore malformed frame */
        }
      };

      // The server sends an initial snapshot followed by coalesced deltas.
      // Listening for the old "jobs" event left the queue permanently empty.
      es.addEventListener("snapshot", (event) => applyJobs(event, true));
      es.addEventListener("delta", (event) => applyJobs(event, false));
      es.addEventListener("ping", touch);
      es.addEventListener("library", () => {
        touch();
        libraryChanged();
      });
      es.addEventListener("removed", (event) => {
        touch();
        try {
          for (const id of JSON.parse((event as MessageEvent).data).ids)
            useAppStore.getState().removeJobLocal(id);
        } catch {}
      });

      es.onopen = () => {
        touch();
        useAppStore.getState().setConnected(true);
      };

      es.onerror = () => {
        useAppStore.getState().setConnected(false);
        // Only tear down if this is still the current connection; a stale
        // callback from a superseded one must not start a second reconnect loop.
        if (disposed || source !== es) return;
        source = null;
        es.close();
        reconnect = setTimeout(connect, RECONNECT_DELAY_MS);
      };

      watchdog = setInterval(() => {
        if (disposed || source !== es) return;
        if (Date.now() - lastFrameAt > SILENCE_TIMEOUT_MS) {
          source = null;
          es.close();
          connect();
        }
      }, SILENCE_CHECK_MS);
    };

    connect();

    // A tab that was suspended in the background almost always comes back
    // holding a connection the server already dropped.
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastFrameAt > SILENCE_TIMEOUT_MS) connect();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      disposed = true;
      clearTimers();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      source?.close();
      source = null;
      useAppStore.getState().setConnected(false);
    };
  }, []);
}
