import {
  formatDuration,
  formatViews,
  thumbnailFor,
} from "@shared/format";
import type {
  JobPhase,
  JobState,
  PlanBatchEntry,
  PlaylistEntry,
  VideoMeta,
} from "@shared/types";

/**
 * The merge, as data.
 *
 * The selection table and the queue were two lists of the same videos with two
 * vocabularies and two owners. Neither could answer "is this video done yet",
 * because neither knew about the other. This module is the union: one row per
 * thing, with a precedence rule that says which source of truth the row is
 * currently speaking for.
 *
 * Pure, no React and no store import -- which is what makes the interesting
 * part of the merge, the ladder, testable without a browser.
 */

/* -------------------------------------------------------------------------- *
 * The ladder
 * -------------------------------------------------------------------------- */

export type RowRung = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type SectionMode = "select" | "work" | "queue";

export interface UnifiedRow {
  /** `entry.id`, or `job:${job.id}` for a row with no entry behind it. */
  key: string;
  videoId?: string;
  /** Present iff the video is in the current probe. */
  entry?: PlaylistEntry;
  /** Present iff a job exists for this video. */
  job?: JobState;
  rung: RowRung;
  plan?: PlanBatchEntry;
  selected: boolean;
  /** An entry with no job holding its slot: the only rows a click can act on. */
  selectable: boolean;
  /**
   * One stable ordering key, so nothing re-sorts as jobs progress.
   *
   * Entries take `entry.index`; jobs that never merged into an entry are
   * pushed past every possible index by `TRAILING_BASE` and ordered among
   * themselves by `job.order`. A row changes state in place and never moves,
   * which is what keeps shift-click ranges and scroll position honest.
   */
  rank: number;
}

export type BadgeTone = "success" | "warning" | "outline";

export interface RowBadge {
  label: string;
  tone: BadgeTone;
  title?: string;
}

/**
 * Phases where a job still holds its slot.
 *
 * `paused` counts. A paused job is not in flight but it is not finished
 * either, it can be resumed, and offering to queue it again would produce two
 * jobs for one video.
 */
const HOLDS_SLOT: ReadonlySet<JobPhase> = new Set<JobPhase>([
  "queued",
  "scheduled",
  "paused",
  "probing",
  "downloading",
  "postprocessing",
  "converting",
]);

/** Finished, with a file or a deliberate decision behind it. */
const SETTLED: ReadonlySet<JobPhase> = new Set<JobPhase>(["done", "skipped"]);

/** Stopped by something going wrong, including the user cancelling. */
const FAILED: ReadonlySet<JobPhase> = new Set<JobPhase>(["error", "cancelled"]);

/** Past any plausible playlist index, so trailing rows can never collide. */
const TRAILING_BASE = 1_000_000_000;

/* -------------------------------------------------------------------------- *
 * Phases
 * -------------------------------------------------------------------------- */

/** Moved verbatim from `QueuePanel`, which the merged row replaced. */
export const PHASE_LABEL: Record<JobPhase, string> = {
  queued: "Queued",
  scheduled: "Scheduled",
  paused: "Paused",
  probing: "Checking",
  downloading: "Downloading",
  postprocessing: "Processing",
  converting: "Converting",
  done: "Done",
  skipped: "Skipped",
  error: "Failed",
  cancelled: "Cancelled",
};

/** Transferring right now, as opposed to queued, paused or finished. */
const transferring = (job: JobState) => job.phase === "downloading";

/**
 * What the row's second line says.
 *
 * While bytes are moving, the numbers that line answers: how fast, how much,
 * how long. Otherwise the phase is the only thing worth saying.
 */
export function statusLine(job: JobState): string {
  if (transferring(job)) {
    const facts = [job.speed, job.size, job.eta].filter(Boolean);
    if (facts.length) return facts.join(" · ");
  }
  return PHASE_LABEL[job.phase];
}

/* -------------------------------------------------------------------------- *
 * The ladder
 * -------------------------------------------------------------------------- */

export function isJobActive(phase: JobPhase): boolean {
  return HOLDS_SLOT.has(phase);
}

/**
 * One rung per source of truth, most-immediate first.
 *
 * Rungs 1–2 own the status line and rungs 3–7 own a badge. The two are
 * mutually exclusive, so "drop the ownership badge while a job exists" is
 * structural here rather than a special case in the component.
 *
 * Two orderings in here are not obvious and are both deliberate:
 *
 *  - a *plan* outranks a **successful** job. `planByVideo` is recomputed on
 *    every `requestKey` change, so after a format switch it is the freshest
 *    truth available: "this copy no longer matches" beats "it finished". A
 *    naive `job > plan` ladder is wrong here.
 *  - a **failure** outranks the plan. A failed row's problem is the failure,
 *    not the format match. The plan stays one rung down, so it is still
 *    correct for a retry afterwards, but the row says `Failed` until it
 *    succeeds.
 */
function rungFor(input: {
  job?: JobState;
  plan?: PlanBatchEntry;
  downloaded: boolean;
  owned: boolean;
}): RowRung {
  const { job, plan, downloaded, owned } = input;
  if (job) {
    if (HOLDS_SLOT.has(job.phase)) return 1;
    if (FAILED.has(job.phase)) return 2;
  }
  if (plan) return 3;
  if (job && SETTLED.has(job.phase)) return 4;
  if (downloaded) return 5;
  if (owned) return 6;
  return 7;
}

/** The badge a rung earns, or nothing at all. Rungs 1, 2 and 7 have none. */
export function badgeFor(row: UnifiedRow): RowBadge | null {
  switch (row.rung) {
    case 3: {
      const plan = row.plan!;
      return {
        label:
          plan.action === "skip"
            ? "Up to date"
            : plan.action === "convert"
              ? "Convert"
              : "Update",
        tone: plan.action === "skip" ? "success" : "warning",
        title: plan.reason || undefined,
      };
    }
    case 4:
    case 5:
      return { label: "Downloaded", tone: "success" };
    case 6:
      return {
        label: "In library",
        tone: "outline",
        title: "Downloaded in another format.",
      };
    default:
      return null;
  }
}

/** True for the two rungs that speak in a status line rather than a badge. */
export function speaksInStatusLine(row: UnifiedRow): boolean {
  return row.rung === 1 || row.rung === 2;
}

/* -------------------------------------------------------------------------- *
 * The union
 * -------------------------------------------------------------------------- */

export interface UnifiedRowsInput {
  entries: PlaylistEntry[];
  jobs: JobState[];
  selected: Set<string>;
  planByVideo: Record<string, PlanBatchEntry>;
  downloadedIds: Set<string>;
  ownedIds: Set<string>;
}

/**
 * Which of two jobs for one video the row should speak for.
 *
 * A video can be queued twice in one session -- a finished copy and a fresh
 * one. Showing the live job is the only answer that is true right now; the
 * older one is not dropped, it becomes a trailing row of its own.
 */
function preferredJob(a: JobState, b: JobState): JobState {
  const aHolds = HOLDS_SLOT.has(a.phase) ? 1 : 0;
  const bHolds = HOLDS_SLOT.has(b.phase) ? 1 : 0;
  if (aHolds !== bHolds) return aHolds ? a : b;
  return (b.order ?? 0) >= (a.order ?? 0) ? b : a;
}

export function unifiedRows(input: UnifiedRowsInput): UnifiedRow[] {
  const { entries, jobs, selected, planByVideo, downloadedIds, ownedIds } =
    input;

  // Queue order, decided once: it is the fallback tiebreak for jobs that
  // carry no `order` at all.
  const ordered = [...jobs].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  const byVideo = new Map<string, JobState>();
  for (const job of ordered) {
    if (!job.videoId) continue;
    const seen = byVideo.get(job.videoId);
    byVideo.set(job.videoId, seen ? preferredJob(seen, job) : job);
  }

  const rows: UnifiedRow[] = [];
  const merged = new Set<string>();

  for (const entry of entries) {
    const job = byVideo.get(entry.id);
    if (job) merged.add(job.id);
    const plan = planByVideo[entry.id];
    rows.push({
      key: entry.id,
      videoId: entry.id,
      entry,
      job,
      rung: rungFor({
        job,
        plan,
        downloaded: downloadedIds.has(entry.id),
        owned: ownedIds.has(entry.id),
      }),
      plan,
      selected: selected.has(entry.id),
      selectable: !job || !HOLDS_SLOT.has(job.phase),
      rank: entry.index,
    });
  }

  /**
   * Everything the union could not attach to a row above.
   *
   * Three real cases land here and all of them have to stay manageable:
   * `JobState.videoId` is optional, so batch paste, library sync and a
   * `videoId`-less item queue jobs without one; a reload has jobs and no probe
   * result at all, so this group is the entire list; and a job from a previous
   * playlist is still here after a new probe replaced the entries.
   */
  const trailingBase = entries.length ? TRAILING_BASE : 0;
  let offset = 0;
  for (const job of ordered) {
    if (merged.has(job.id)) continue;
    rows.push({
      key: `job:${job.id}`,
      videoId: job.videoId,
      job,
      rung: rungFor({
        job,
        plan: job.videoId ? planByVideo[job.videoId] : undefined,
        downloaded: !!job.videoId && downloadedIds.has(job.videoId),
        owned: !!job.videoId && ownedIds.has(job.videoId),
      }),
      selected: !!job.videoId && selected.has(job.videoId),
      selectable: false,
      rank: trailingBase + offset++,
    });
  }

  return rows.sort((a, b) => a.rank - b.rank);
}

/* -------------------------------------------------------------------------- *
 * What the section is doing
 * -------------------------------------------------------------------------- */

/**
 * Derived on every render, never stored.
 *
 * There is no `useState("selection")` anywhere: the section adapts to the
 * session rather than being a mode the user has to flip between, which is the
 * whole point of collapsing the two sections into one.
 */
export function sectionMode(entries: PlaylistEntry[], jobs: JobState[]): SectionMode {
  if (entries.length === 0) return jobs.length > 0 ? "queue" : "select";
  return jobs.length > 0 ? "work" : "select";
}

/* -------------------------------------------------------------------------- *
 * Sorting and filtering helpers
 * -------------------------------------------------------------------------- */

export function rowTitle(row: UnifiedRow): string {
  return row.entry?.title ?? row.job?.title ?? "";
}

export function rowFacts(row: UnifiedRow): string {
  if (!row.entry) return "";
  return [
    typeof row.entry.duration === "number"
      ? formatDuration(row.entry.duration)
      : null,
    row.entry.viewCount ? formatViews(row.entry.viewCount) : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * A lifecycle rank rather than a scalar, for the Status sort.
 *
 * 0 in flight, 1 chosen but not queued, 2 everything else (a failure included:
 * it has a Retry waiting, so it is not finished), 3 nothing left to do.
 */
export function statusRank(row: UnifiedRow): number {
  if (row.rung === 1) return 0;
  if (row.selected && row.selectable) return 1;
  if (row.rung === 4 || row.rung === 5 || row.rung === 6) return 3;
  return 2;
}

/**
 * Status ordering ignores Asc/Desc, because a rank has no meaningful reverse.
 * Within "in flight" it falls back to queue order, which is the only order
 * that means anything there.
 */
export function compareByStatus(a: UnifiedRow, b: UnifiedRow): number {
  const byRank = statusRank(a) - statusRank(b);
  if (byRank !== 0) return byRank;
  if (a.rung === 1 && b.rung === 1)
    return (a.job?.order ?? 0) - (b.job?.order ?? 0);
  return a.rank - b.rank;
}

/* -------------------------------------------------------------------------- *
 * Row geometry
 * -------------------------------------------------------------------------- */

/**
 * One height for every list row.
 *
 * The guarantee is what keeps the virtualizer smooth: it never measures, so
 * nothing added to a row afterwards can make rows overlap. Everything a row
 * used to show beyond title + one status line -- `job.error`, `planNote`,
 * `recoveryNote`, Diagnostics -- is gone rather than deferred, which is how
 * 72px is an invariant instead of an aspiration.
 */
export const ROW_HEIGHT = 72;

/** The "Not in this playlist" rule, and the offset it adds to that one row. */
export const DIVIDER_HEIGHT = 22;

/** Narrowest a grid card should get before dropping to fewer columns. */
export const MIN_COLUMN_WIDTH = 210;

const GRID_SIDE_PAD = 32; // px-4
const GRID_GAP = 12; // gap-3
const GRID_BLOCK_PAD = 24; // py-3
/** Title, meta row and card padding, below a 16:9 thumbnail. */
const GRID_CARD_CHROME = 88;
/**
 * What a job card adds: the status line and nothing more.
 *
 * The icon buttons live in the meta row, which is otherwise empty once the
 * ownership badge is gone, so a queued card is 22px taller than a selected
 * one rather than 58px.
 */
const GRID_JOB_CHROME = 22;

export interface GridMetrics {
  columns: number;
  colWidth: number;
  entryCard: number;
  jobCard: number;
  entryRow: number;
  jobRow: number;
}

/**
 * Column count and every height derived from one measurement.
 *
 * The virtualizer's `estimateSize` has to be exact or rows overlap, so it must
 * come from the same `ResizeObserver` value as `columns` -- two derivations of
 * the same number is how that goes wrong. Clamped to a real card width so the
 * first render, before the observer has fired, is sane rather than negative.
 */
export function gridMetrics(scrollerWidth: number): GridMetrics {
  const content = Math.max(MIN_COLUMN_WIDTH, scrollerWidth - GRID_SIDE_PAD);
  const columns = Math.max(1, Math.floor(content / MIN_COLUMN_WIDTH));
  const colWidth = (content - GRID_GAP * (columns - 1)) / columns;
  const entryCard = colWidth * (9 / 16) + GRID_CARD_CHROME;
  const jobCard = entryCard + GRID_JOB_CHROME;
  return {
    columns,
    colWidth,
    entryCard,
    jobCard,
    entryRow: entryCard + GRID_BLOCK_PAD,
    jobRow: jobCard + GRID_BLOCK_PAD,
  };
}

/* -------------------------------------------------------------------------- *
 * The single-video path
 * -------------------------------------------------------------------------- */

/**
 * A single video as the one-row list it now is.
 *
 * `VideoMeta` already carries everything a `PlaylistEntry` needs, so the
 * single-video path can render through the same row, the same sticky footer
 * and the same job controls as a playlist -- which is how it gains progress,
 * pause, retry and reveal, none of which it had a path to before.
 */
export function videoMetaToEntry(meta: VideoMeta, url: string): PlaylistEntry {
  return {
    id: meta.id,
    title: meta.title,
    index: 1,
    duration: meta.duration,
    viewCount: meta.viewCount,
    thumbnail: meta.thumbnail || thumbnailFor(meta.id, "mq"),
    url: meta.webpageUrl ?? url,
    availability: meta.availability,
    liveStatus: meta.liveStatus,
    isLive: meta.isLive,
  };
}
