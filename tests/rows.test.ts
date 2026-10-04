import { describe, expect, it } from "bun:test";
import type { JobPhase, JobState, PlanBatchEntry, PlaylistEntry } from "../shared/types";
import {
  badgeFor,
  compareByStatus,
  gridMetrics,
  MIN_COLUMN_WIDTH,
  sectionMode,
  statusLine,
  unifiedRows,
  videoMetaToEntry,
  type UnifiedRow,
} from "../src/lib/rows";

/**
 * The merge, as executable expectations.
 *
 * Every case below is a decision that would otherwise be silent: which of two
 * truths a row speaks for, what happens to a video that is picked *and*
 * downloading, and whether rows move when they start working.
 */

const entry = (id: string, index: number, extra: Partial<PlaylistEntry> = {}) =>
  ({
    id,
    title: `Video ${id}`,
    index,
    duration: 60,
    viewCount: 1000,
    thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    url: `https://youtu.be/${id}`,
    isLive: false,
    ...extra,
  }) satisfies PlaylistEntry;

/**
 * A job for `id`, by default about the same video. Pass `videoId: undefined`
 * for the rows that can never merge into an entry.
 */
const job = (
  id: string,
  phase: JobPhase,
  extra: Partial<JobState> = {},
) =>
  ({
    id,
    videoId: id,
    title: `Job ${id}`,
    phase,
    percent: 45,
    presetId: "mp4-h264",
    attempts: 1,
    order: 1,
    ...extra,
  }) satisfies JobState;

const plan = (
  videoId: string,
  action: PlanBatchEntry["action"],
): PlanBatchEntry => ({
  url: `https://youtu.be/${videoId}`,
  videoId,
  action,
  reason: `${action} because`,
  diffs: [],
});

const build = (input: {
  entries?: PlaylistEntry[];
  jobs?: JobState[];
  selected?: string[];
  planByVideo?: Record<string, PlanBatchEntry>;
  downloaded?: string[];
  owned?: string[];
}) =>
  unifiedRows({
    entries: input.entries ?? [],
    jobs: input.jobs ?? [],
    selected: new Set(input.selected ?? []),
    planByVideo: input.planByVideo ?? {},
    downloadedIds: new Set(input.downloaded ?? []),
    ownedIds: new Set(input.owned ?? []),
  });

const rowFor = (rows: UnifiedRow[], id: string) =>
  rows.find((r) => r.key === id);

/* -------------------------------------------------------------------------- *
 * The ladder, at every rung
 * -------------------------------------------------------------------------- */

describe("the row state ladder", () => {
  it("rung 1: a job in any non-terminal phase speaks in the status line", () => {
    for (const phase of [
      "queued",
      "scheduled",
      "paused",
      "probing",
      "downloading",
      "postprocessing",
      "converting",
    ] as JobPhase[]) {
      const rows = build({ entries: [entry("a", 1)], jobs: [job("a", phase)] });
      expect(rows[0].rung).toBe(1);
      // The ownership badge is gone while a job owns the row, structurally.
      expect(badgeFor(rows[0])).toBeNull();
      expect(statusLine(rows[0].job!)).toBeTruthy();
    }
  });

  it("rung 1 prefers the transfer numbers over the phase label", () => {
    const rows = build({
      entries: [entry("a", 1)],
      jobs: [
        job("a", "downloading", {
          speed: "3.4 MB/s",
          size: "45.2 MB",
          eta: "1m",
        }),
      ],
    });
    expect(statusLine(rows[0].job!)).toBe("3.4 MB/s · 45.2 MB · 1m");
  });

  it("rung 2: a failure speaks in the status line, not a badge", () => {
    // `statusLine` moved verbatim, so the words are the phase's own: "Failed"
    // for a job that broke, "Cancelled" for one the user stopped.
    const wording = (phase: JobPhase) =>
      statusLine(
        build({ entries: [entry("a", 1)], jobs: [job("a", phase)] })[0].job!,
      );
    for (const phase of ["error", "cancelled"] as JobPhase[]) {
      const rows = build({ entries: [entry("a", 1)], jobs: [job("a", phase)] });
      expect(rows[0].rung).toBe(2);
      expect(badgeFor(rows[0])).toBeNull();
    }
    expect(wording("error")).toBe("Failed");
    expect(wording("cancelled")).toBe("Cancelled");
  });

  it("rung 3: a plan outranks everything cheap", () => {
    const rows = build({
      entries: [entry("a", 1)],
      planByVideo: { a: plan("a", "convert") },
      downloaded: ["a"],
      owned: ["a"],
    });
    expect(rows[0].rung).toBe(3);
    expect(badgeFor(rows[0])).toEqual({
      label: "Convert",
      tone: "warning",
      title: "convert because",
    });
  });

  it("rung 3 names each plan action", () => {
    const labels = (action: PlanBatchEntry["action"]) =>
      badgeFor(
        build({
          entries: [entry("a", 1)],
          planByVideo: { a: plan("a", action) },
        })[0],
      )?.label;
    expect(labels("skip")).toBe("Up to date");
    expect(labels("convert")).toBe("Convert");
    expect(labels("download")).toBe("Update");
  });

  it("rung 4: a finished job reads as downloaded", () => {
    for (const phase of ["done", "skipped"] as JobPhase[]) {
      const rows = build({ entries: [entry("a", 1)], jobs: [job("a", phase)] });
      expect(rows[0].rung).toBe(4);
      expect(badgeFor(rows[0])).toEqual({ label: "Downloaded", tone: "success" });
    }
  });

  it("rungs 5 and 6: what is on disk, then what is merely owned", () => {
    const exact = build({ entries: [entry("a", 1)], downloaded: ["a"] });
    expect(exact[0].rung).toBe(5);
    expect(badgeFor(exact[0])?.label).toBe("Downloaded");

    const owned = build({ entries: [entry("a", 1)], owned: ["a"] });
    expect(owned[0].rung).toBe(6);
    expect(badgeFor(owned[0])?.label).toBe("In library");
  });

  it("rung 7: nothing known, nothing said", () => {
    const rows = build({ entries: [entry("a", 1)] });
    expect(rows[0].rung).toBe(7);
    expect(badgeFor(rows[0])).toBeNull();
  });
});

/* -------------------------------------------------------------------------- *
 * The two orderings that are not obvious
 * -------------------------------------------------------------------------- */

describe("ladder precedence", () => {
  it("a plan outranks a *successful* job, because it is the fresher truth", () => {
    // Change the format and this copy no longer matches, even though the job
    // that produced it finished. A naive `job > plan` ladder gets this wrong.
    const rows = build({
      entries: [entry("a", 1)],
      jobs: [job("a", "done")],
      planByVideo: { a: plan("a", "download") },
    });
    expect(rows[0].rung).toBe(3);
    expect(badgeFor(rows[0])?.label).toBe("Update");
    // ...and the job's controls are still there, because the job still exists.
    expect(rows[0].job?.phase).toBe("done");
  });

  it("a failure outranks the plan, so a retry can still read it", () => {
    const rows = build({
      entries: [entry("a", 1)],
      jobs: [job("a", "error")],
      planByVideo: { a: plan("a", "convert") },
    });
    expect(rows[0].rung).toBe(2);
    expect(statusLine(rows[0].job!)).toBe("Failed");
  });
});

/* -------------------------------------------------------------------------- *
 * The union
 * -------------------------------------------------------------------------- */

describe("unifiedRows", () => {
  it("a video that is selected and actively queued is one row, not two", () => {
    const rows = build({
      entries: [entry("a", 1), entry("b", 2)],
      jobs: [job("a", "downloading")],
      selected: ["a", "b"],
    });
    expect(rows).toHaveLength(2);
    expect(rowFor(rows, "a")?.selected).toBe(true);
    // A paused job holds its slot too, so a tick would be a duplicate queue.
    expect(rowFor(rows, "a")?.selectable).toBe(false);
    expect(rowFor(rows, "b")?.selectable).toBe(true);
  });

  it("a paused job holds its slot, and a settled one gives it back", () => {
    const paused = build({
      entries: [entry("a", 1)],
      jobs: [job("a", "paused")],
    });
    expect(paused[0].selectable).toBe(false);

    for (const phase of ["done", "skipped", "error", "cancelled"] as JobPhase[]) {
      const settled = build({
        entries: [entry("a", 1)],
        jobs: [job("a", phase)],
      });
      expect(settled[0].selectable).toBe(true);
    }
  });

  it("jobs with no videoId become a trailing group keyed on the job", () => {
    const rows = build({
      entries: [entry("a", 1)],
      jobs: [
        job("1", "done", { videoId: undefined, order: 1 }),
        job("2", "queued", { videoId: undefined, order: 5 }),
      ],
    });
    expect(rows.map((r) => r.key)).toEqual(["a", "job:1", "job:2"]);
    expect(rows[1].selectable).toBe(false);
    expect(rowFor(rows, "job:1")?.rung).toBe(4);
    expect(rowFor(rows, "job:2")?.rung).toBe(1);
  });

  it("a job from a previous playlist lands in the trailing group, in queue order", () => {
    const rows = build({
      entries: [entry("a", 1), entry("b", 2)],
      jobs: [
        job("2", "done", { videoId: "zzz", order: 2 }),
        job("1", "queued", { videoId: "yyy", order: 1 }),
      ],
    });
    expect(rows.map((r) => r.key)).toEqual(["a", "b", "job:1", "job:2"]);
    // Still fully manageable: the videoId travels with the row.
    expect(rowFor(rows, "job:1")?.videoId).toBe("yyy");
  });

  it("a reload with jobs and no probe result is the trailing group alone", () => {
    const rows = build({ jobs: [job("1", "done", { videoId: undefined })] });
    expect(rows).toHaveLength(1);
    expect(rows[0].key).toBe("job:1");
    expect(rows[0].entry).toBeUndefined();
  });

  it("two jobs for one video show the live one and keep the other visible", () => {
    const rows = build({
      entries: [entry("a", 1)],
      jobs: [
        job("old", "done", { videoId: "a", order: 1 }),
        job("new", "downloading", { videoId: "a", order: 2 }),
      ],
    });
    expect(rows).toHaveLength(2);
    expect(rowFor(rows, "a")?.job?.id).toBe("new");
    expect(rowFor(rows, "job:old")?.job?.phase).toBe("done");
  });
});

/* -------------------------------------------------------------------------- *
 * Rank stability
 * -------------------------------------------------------------------------- */

describe("rank stability", () => {
  it("queueing a video does not move any other row", () => {
    const entries = [entry("a", 1), entry("b", 2), entry("c", 3)];
    const before = build({ entries, selected: ["a", "b", "c"] });
    const after = build({
      entries,
      jobs: [job("b", "downloading")],
      selected: ["a", "c"],
    });

    expect(after.map((r) => r.key)).toEqual(["a", "b", "c"]);
    for (const key of ["a", "c"]) {
      expect(rowFor(after, key)!.rank).toBe(rowFor(before, key)!.rank);
    }
  });

  it("nothing re-sorts as a job runs through its phases", () => {
    const entries = [entry("a", 1), entry("b", 2)];
    const ranks = (
      ["queued", "downloading", "converting", "done"] as JobPhase[]
    ).map((phase) =>
      build({ entries, jobs: [job("b", phase)] }).map((r) => r.rank),
    );
    for (const snapshot of ranks) expect(snapshot).toEqual(ranks[0]);
  });

  it("trailing ranks never collide with a playlist index", () => {
    const rows = build({
      entries: [entry("a", 999_999)],
      jobs: [job("1", "done", { videoId: undefined })],
    });
    expect(rows[0].rank).toBeLessThan(rows[1].rank);
  });
});

/* -------------------------------------------------------------------------- *
 * What the section is doing
 * -------------------------------------------------------------------------- */

describe("sectionMode", () => {
  const one = [entry("a", 1)];
  it("select: a probe with nothing queued yet", () => {
    expect(sectionMode(one, [])).toBe("select");
    expect(sectionMode([], [])).toBe("select");
  });

  it("work: a probe and jobs at once", () => {
    expect(sectionMode(one, [job("a", "done")])).toBe("work");
  });

  it("queue: jobs with no probe to attach them to", () => {
    expect(sectionMode([], [job("1", "queued")])).toBe("queue");
  });
});

/* -------------------------------------------------------------------------- *
 * The drain
 * -------------------------------------------------------------------------- */

describe("the selection drains when work starts", () => {
  /**
   * The same transition App.tsx performs, expressed here so the rule is
   * checked rather than assumed: ids leave on *gain of a job*, once, and a tick
   * that comes back afterwards stays.
   */
  const drain = (
    seen: Set<string>,
    withJob: Set<string>,
    selected: Set<string>,
  ): { selected: Set<string>; seen: Set<string> } => {
    const gained: string[] = [];
    for (const id of withJob) if (!seen.has(id)) gained.push(id);
    const next = new Set(selected);
    for (const id of gained) next.delete(id);
    const recorded = new Set(seen);
    for (const id of gained) recorded.add(id);
    return { selected: next, seen: recorded };
  };

  it("empties the selection the moment work starts", () => {
    const seeded = { selected: new Set(["a", "b"]), seen: new Set<string>() };
    expect(drain(seeded.seen, new Set(), seeded.selected).selected).toEqual(
      new Set(["a", "b"]),
    );

    // The POST response's own upsert lands, and the selection is already empty.
    const queued = drain(seeded.seen, new Set(["a", "b"]), seeded.selected);
    expect(queued.selected).toEqual(new Set());
    expect(queued.seen).toEqual(new Set(["a", "b"]));
  });

  it("is keyed on gaining a job, not on the phase, so re-ticking sticks", () => {
    // Queued, then finished, then re-ticked. A standing "minus settled" filter
    // would prune the tick again on the very next render and nothing could
    // ever be queued twice.
    const queued = drain(new Set(), new Set(["a"]), new Set(["a"]));
    expect(queued.selected).toEqual(new Set());

    const reTick = drain(queued.seen, new Set(["a"]), new Set(["a"]));
    expect(reTick.selected).toEqual(new Set(["a"]));

    // ...and it survives a phase change, which is the same failure mode.
    const afterDone = drain(reTick.seen, new Set(["a"]), reTick.selected);
    expect(afterDone.selected).toEqual(new Set(["a"]));
  });

  it("does not prune on every render once the queue is quiet", () => {
    const first = drain(new Set(), new Set(["a"]), new Set(["a", "b"]));
    expect(first.selected).toEqual(new Set(["b"]));
    for (let i = 0; i < 5; i++) {
      expect(drain(first.seen, new Set(["a"]), new Set(["b"])).selected).toEqual(
        new Set(["b"]),
      );
    }
  });

  it("only prunes the ids that just gained a job", () => {
    const first = drain(new Set(), new Set(["a"]), new Set(["a", "b", "c"]));
    const second = drain(first.seen, new Set(["a", "b"]), first.selected);
    expect(second.selected).toEqual(new Set(["c"]));
  });
});

/* -------------------------------------------------------------------------- *
 * Status sort
 * -------------------------------------------------------------------------- */

describe("compareByStatus", () => {
  it("puts work in flight first, then the chosen-but-unqueued, then the rest", () => {
    const rows = build({
      entries: [entry("a", 1), entry("b", 2), entry("c", 3), entry("d", 4)],
      jobs: [job("a", "downloading")],
      selected: ["b", "c"],
      downloaded: ["d"],
    });
    const sorted = [...rows].sort(compareByStatus).map((r) => r.key);
    // a is in flight; b and c are chosen; d is already on disk and finished.
    expect(sorted[0]).toBe("a");
    expect(sorted.slice(1, 3).sort()).toEqual(["b", "c"]);
    expect(sorted.at(-1)).toBe("d");
  });

  it("orders in-flight rows by queue order, not by playlist index", () => {
    const rows = build({
      entries: [entry("a", 1), entry("b", 2)],
      jobs: [
        job("a", "downloading", { order: 9 }),
        job("b", "downloading", { order: 2 }),
      ],
    });
    expect([...rows].sort(compareByStatus).map((r) => r.key)).toEqual([
      "b",
      "a",
    ]);
  });

  it("keeps a failure out of the finished band: it has a Retry waiting", () => {
    const rows = build({
      entries: [entry("a", 1), entry("b", 2)],
      jobs: [job("a", "error")],
      downloaded: ["b"],
    });
    expect([...rows].sort(compareByStatus).map((r) => r.key)).toEqual([
      "a",
      "b",
    ]);
  });
});

/* -------------------------------------------------------------------------- *
 * Grid geometry
 * -------------------------------------------------------------------------- */

describe("gridMetrics", () => {
  it("fits four columns at the section's widest shell", () => {
    // `max-w-5xl` minus the page gutter, minus the scroller's own px-4.
    const grid = gridMetrics(984);
    expect(grid.columns).toBe(4);
    // Four across at today's card width: 33% more cards for no extra width.
    expect(Math.round(grid.colWidth)).toBe(229);
  });

  it("drops a column rather than clipping a card below the minimum", () => {
    expect(gridMetrics(700).columns).toBe(3);
    expect(gridMetrics(400).columns).toBe(1);
  });

  it("is positive and sane before the observer has measured anything", () => {
    for (const width of [0, 1, MIN_COLUMN_WIDTH]) {
      const grid = gridMetrics(width);
      expect(grid.columns).toBeGreaterThanOrEqual(1);
      expect(grid.colWidth).toBeGreaterThan(0);
      expect(grid.entryCard).toBeGreaterThan(0);
      expect(grid.jobCard).toBeGreaterThan(grid.entryCard);
    }
  });

  it("a job card is taller than an entry card by exactly the status line", () => {
    const grid = gridMetrics(984);
    expect(grid.jobCard - grid.entryCard).toBe(22);
    // Both keep the 16:9 thumbnail plus the same title and meta row.
    expect(grid.entryRow - grid.jobRow).toBe(-22);
  });
});

/* -------------------------------------------------------------------------- *
 * The single-video adapter
 * -------------------------------------------------------------------------- */

describe("videoMetaToEntry", () => {
  it("carries every field a row needs, so one video renders as one row", () => {
    const entry = videoMetaToEntry(
      {
        id: "abc",
        title: "A video",
        thumbnail: "https://example.test/a.jpg",
        duration: 125,
        viewCount: 4321,
        isLive: false,
        webpageUrl: "https://youtu.be/abc",
      },
      "https://www.youtube.com/watch?v=abc&t=1",
    );
    expect(entry).toMatchObject({
      id: "abc",
      title: "A video",
      index: 1,
      duration: 125,
      viewCount: 4321,
      thumbnail: "https://example.test/a.jpg",
      isLive: false,
    });
    // The canonical URL, not the box's, so a scheduled time or a playlist
    // context is not recorded as part of the video's identity.
    expect(entry.url).toBe("https://youtu.be/abc");
  });

  it("falls back to the typed URL and a derived thumbnail", () => {
    const entry = videoMetaToEntry(
      { id: "abc", title: "A", thumbnail: "", isLive: false },
      "https://youtu.be/abc",
    );
    expect(entry.url).toBe("https://youtu.be/abc");
    expect(entry.thumbnail).toContain("abc");
  });
});
