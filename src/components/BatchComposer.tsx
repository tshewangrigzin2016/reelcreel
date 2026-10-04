import { useMemo, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Loading03Icon } from "@hugeicons/core-free-icons";
import { toast } from "sonner";
import type { PlaylistEntry } from "@shared/types";
import { extractVideoId, normalizeUrl } from "@shared/url";
import { api } from "@/lib/api";
import { Button } from "./ui/button";

/**
 * Matches the server's own ceiling, so a paste that passes review cannot be
 * rejected after the fact.
 */
const MAX_ROWS = 500;

/**
 * How many rows the review list paints.
 *
 * Parsing still runs over every line -- a 500-row paste has to be deduplicated
 * in full -- but rendering all of it costs more than it is worth, because the
 * selection table below lists every row anyway with a title and a thumbnail.
 */
const REVIEW_PREVIEW_ROWS = 100;

/**
 * How many URLs go to the server per request.
 *
 * The server probes a chunk concurrently under the shared probe pool, so a
 * larger chunk simply queues longer. Chunking keeps the progress readout honest
 * and stops one unreadable video from stalling the whole paste behind it.
 */
const CHUNK_SIZE = 25;

export interface BatchLoad {
  entries: PlaylistEntry[];
  /** URLs that could not be read, so a dead link is visible before download. */
  errors: string[];
  /** Run time chosen alongside the paste, if any. */
  scheduledAt?: number;
}

export function BatchComposer({
  busy = false,
  onLoad,
}: {
  /** True while a previous batch is still being read. */
  busy?: boolean;
  /**
   * Hands the batch to the selection pipeline.
   *
   * Deliberately the only thing this component can do: it no longer queues.
   * A pasted list arrives as rows in the same table a playlist produces, so
   * format, quality and row selection are all decided before anything is
   * downloaded -- and a re-check can say what already matches.
   */
  onLoad: (load: BatchLoad) => void;
}) {
  const [text, setText] = useState("");
  const [schedule, setSchedule] = useState("");
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);

  const review = useMemo(() => {
    const seen = new Set<string>();
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const url = normalizeUrl(line);
        const id = url ? extractVideoId(url) : null;
        const duplicate = !!id && seen.has(id);
        if (id) seen.add(id);
        return { line, url, id, duplicate };
      });
  }, [text]);

  const valid = review.filter((row) => row.id && !row.duplicate);
  const tooMany = valid.length > MAX_ROWS;

  const load = async () => {
    const urls = valid.map((row) => row.url!);
    setLoading(true);
    setProgress(0);
    try {
      // Read in chunks so a 500-line paste reports progress instead of sitting
      // on one request for minutes, and so a single slow video cannot hold up
      // everything behind it in the list.
      const entries: PlaylistEntry[] = [];
      const errors: string[] = [];
      for (let i = 0; i < urls.length; i += CHUNK_SIZE) {
        const result = await api.probeBatch(urls.slice(i, i + CHUNK_SIZE));
        // `index` is what the table sorts and numbers by, so it has to reflect
        // position in the whole paste rather than in this chunk.
        for (const entry of result.entries) {
          entries.push({ ...entry, index: entries.length + 1 });
        }
        errors.push(...result.errors);
        setProgress(Math.min(i + CHUNK_SIZE, urls.length));
      }

      if (entries.length === 0) {
        toast.error(
          "None of those links could be read. They may be private, deleted or region-locked.",
        );
        return;
      }
      const when = schedule ? new Date(schedule).getTime() : undefined;
      onLoad({
        entries,
        errors,
        scheduledAt:
          when !== undefined && Number.isFinite(when) ? when : undefined,
      });
      // The selection table now holds these rows. Clearing the textarea stops
      // the same list being loaded twice, and the schedule with it so the next
      // paste starts from "now" rather than inheriting a stale run time.
      setText("");
      setSchedule("");
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not read that list.",
      );
    } finally {
      setLoading(false);
      setProgress(0);
    }
  };

  return (
    <details className="mt-6 rounded-lg border border-border p-4">
      <summary className="cursor-pointer text-sm font-medium">
        Batch paste and text import
      </summary>
      <div className="mt-4 space-y-3">
        <p className="text-xs text-muted-foreground">
          Paste one video URL per line, or import a text file. They load into the
          selection table below -- pick the videos and the format, then download.
          Nothing is queued until you click Download.
        </p>
        <label className="block text-xs">
          One YouTube video URL per line
          <textarea
            className="mt-2 min-h-28 w-full rounded border border-border bg-field p-2 text-sm"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
        <div className="flex flex-wrap items-end gap-3">
          <label className="block text-xs">
            Import .txt
            <input
              className="mt-2 block text-xs"
              type="file"
              accept=".txt,text/plain"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file && file.size <= 1000000) void file.text().then(setText);
                else if (file) toast.error("Text files must be under 1 MB.");
              }}
            />
          </label>
          <label className="block text-xs">
            Run at (local time; leave blank for now)
            <input
              className="ml-2 rounded border border-border bg-field p-2"
              type="datetime-local"
              value={schedule}
              onChange={(e) => setSchedule(e.target.value)}
            />
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          The service must remain running. After a restart, scheduled work
          returns paused for review.
        </p>
        {review.length ? (
          <ul className="max-h-60 space-y-2 overflow-auto">
            {review.slice(0, REVIEW_PREVIEW_ROWS).map((row, index) => (
              <li
                key={index}
                className="flex flex-wrap items-center gap-2 text-xs"
              >
                <span className="max-w-72 truncate" title={row.line}>
                  {row.line}
                </span>
                {!row.id ? (
                  <span className="text-destructive">Invalid video URL</span>
                ) : row.duplicate ? (
                  <span>Duplicate omitted</span>
                ) : null}
              </li>
            ))}
            {review.length > REVIEW_PREVIEW_ROWS ? (
              <li className="text-xs text-faint">
                +{review.length - REVIEW_PREVIEW_ROWS} more lines
              </li>
            ) : null}
          </ul>
        ) : null}
        {tooMany ? (
          <p role="alert" className="text-xs text-destructive">
            {valid.length} links is over the {MAX_ROWS} limit. Split the list
            into smaller batches.
          </p>
        ) : null}
        <Button
          disabled={loading || busy || !valid.length || tooMany}
          onClick={() => void load()}
        >
          {loading ? (
            <>
              <HugeiconsIcon
                icon={Loading03Icon}
                className="mr-2 h-4 w-4 animate-spin"
              />
              Reading {progress} of {valid.length}…
            </>
          ) : (
            `Load ${valid.length} video${valid.length === 1 ? "" : "s"}`
          )}
        </Button>
      </div>
    </details>
  );
}
