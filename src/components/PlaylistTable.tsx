import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import {
  BanIcon,
  Delete02Icon,
  FolderOpenIcon,
  ImageOffIcon,
  PauseIcon,
  PlayIcon,
  RadioIcon,
  RefreshIcon,
  RotateCcwIcon,
  Search01Icon,
  Tick01Icon,
  TickDouble01Icon,
} from "@hugeicons/core-free-icons";
import type { SelectionMode } from "@shared/types";
import { formatDuration, formatViews, thumbnailFor } from "@shared/format";
import { api } from "@/lib/api";
import {
  badgeFor,
  compareByStatus,
  DIVIDER_HEIGHT,
  gridMetrics,
  rowFacts,
  rowTitle,
  ROW_HEIGHT,
  speaksInStatusLine,
  statusLine,
  type SectionMode,
  type UnifiedRow,
} from "@/lib/rows";
import { cn } from "@/lib/utils";
import { Badge, Checkbox, Progress } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * The selection table and the queue, as one section.
 *
 * A video that is picked and a video that is downloading are the same row, not
 * two. `rows` is that row already resolved -- which source of truth it speaks
 * for (`rung`), whether a click can act on it (`selectable`), where it sits
 * (`rank`) -- so this component renders the answer and owns none of the
 * reasoning.
 *
 * Every height here comes from `ROW_HEIGHT` or from `gridMetrics`, never from
 * a measurement. That is the reason the row is allowed to be small: the error
 * text, `planNote`, `recoveryNote` and Diagnostics were dropped rather than
 * deferred, which is what keeps 72px an invariant instead of an aspiration.
 */

type SortKey = "index" | "title" | "duration" | "views" | "status";

interface Props {
  rows: UnifiedRow[];
  /** What this section is doing right now. Derived, never stored. */
  sectionMode: SectionMode;
  /** How a click changes the selection: replace one, toggle many, or everything. */
  mode: SelectionMode;
  onSelectionChange: (next: Set<string>) => void;
  onModeChange: (next: SelectionMode) => void;
  layout?: "list" | "grid";
  /** Title and identity for the section. Omitted when there is no probe. */
  header?: ReactNode;
  /**
   * Rendered as a sticky action bar under the list.
   *
   * A slot rather than a button prop: the markup, padding and positioning stay
   * owned by the table, the content stays owned by the caller that knows what
   * the button does.
   */
  footer?: ReactNode;
  className?: string;
}

const attempt = (work: Promise<unknown>) => {
  void work.catch((error) => toast.error(error.message));
};

const MODES: { id: SelectionMode; label: string }[] = [
  { id: "single", label: "Single" },
  { id: "multiple", label: "Multiple" },
  { id: "all", label: "Select all" },
];

const MODE_HINT: Record<SelectionMode, string> = {
  single: "Click a video to select it — selecting another replaces it.",
  multiple: "Click to toggle. Shift-click to select a range.",
  all: "Every video is selected. Click any video to drop it.",
};

const BULK_ACTIONS: { id: string; label: string; icon: IconSvgElement }[] = [
  { id: "pause", label: "Pause all", icon: PauseIcon },
  { id: "resume", label: "Resume paused", icon: PlayIcon },
  { id: "retry-failed", label: "Retry failed", icon: RotateCcwIcon },
  { id: "cancel", label: "Cancel all", icon: BanIcon },
];

/**
 * Icon-only queue action with a tooltip above it.
 *
 * The accessible name stays on the button itself (`aria-label` + `title`), so
 * `getByRole("button", { name: "Pause all" })` and `button[title="…"]`
 * selectors keep working. The visible label lives in a CSS-only tooltip
 * positioned on top, shown on hover and on keyboard focus.
 */
function QueueActionButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <span className="group relative inline-flex">
      <Button
        size="icon"
        variant="outline"
        type="button"
        title={label}
        aria-label={label}
        onClick={onClick}
        className="transition-all hover:scale-105 hover:border-foreground/40 hover:text-foreground active:scale-95"
      >
        {children}
      </Button>
      <span
        role="tooltip"
        aria-hidden
        className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-2 py-1 text-[11px] font-medium text-popover-foreground opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {label}
        <span
          aria-hidden
          className="absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-border bg-popover"
        />
      </span>
    </span>
  );
}

/**
 * A row's thumbnail, which may legitimately be absent.
 *
 * Batch paste and library sync both queue rows without one, so a missing
 * thumbnail is a normal state and gets a placeholder rather than a broken
 * image. Falling back to the public YouTube card is safe because
 * `shared/validation.ts:items()` forces every URL through
 * `youtubeUrl(..., individual: true)`, so a `videoId` here is a real one.
 */
const RowThumb = memo(function RowThumb({
  src,
  duration,
  dimmed,
  checked,
  shape,
}: {
  src?: string;
  duration?: number;
  dimmed: boolean;
  checked: boolean;
  shape: "tile" | "cover";
}) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className={cn(
        "relative block overflow-hidden bg-secondary",
        shape === "tile" ? "h-9 w-16 rounded" : "h-full w-full",
      )}
    >
      {src && !failed ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className={cn(
            "h-full w-full object-cover transition-opacity",
            dimmed ? "opacity-70" : "opacity-100",
          )}
        />
      ) : (
        <span
          aria-hidden
          className="flex h-full w-full items-center justify-center text-faint"
        >
          <HugeiconsIcon icon={ImageOffIcon} className="h-4 w-4" />
        </span>
      )}
      {checked ? (
        <span className="absolute inset-0 flex items-center justify-center bg-black/45">
          <HugeiconsIcon
            icon={Tick01Icon}
            className="h-4 w-4 text-white"
            strokeWidth={3}
          />
        </span>
      ) : null}
      {duration ? (
        <span className="absolute bottom-0 right-0 rounded-tl bg-black/80 px-1 text-[10px] tabular-nums text-white">
          {formatDuration(duration)}
        </span>
      ) : null}
    </span>
  );
});

export function PlaylistTable({
  rows,
  sectionMode,
  mode,
  onSelectionChange,
  onModeChange,
  layout = "list",
  header,
  footer,
  className,
}: Props) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("index");
  const [asc, setAsc] = useState(true);
  const lastIndexRef = useRef<number | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  /**
   * Measured rather than derived from a breakpoint: the shell itself changes
   * width with the layout, and `max-w-5xl` is a maximum, not a fixed width, so
   * the real column count depends on the viewport and on whether a scrollbar
   * is present.
   */
  const [width, setWidth] = useState(0);

  const view = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? rows.filter(
          (r) =>
            rowTitle(r).toLowerCase().includes(q) ||
            (r.videoId ?? "").toLowerCase().includes(q),
        )
      : rows;

    const sorted = [...filtered];
    if (sortKey === "status") {
      sorted.sort(compareByStatus);
      return sorted;
    }
    sorted.sort((a, b) => {
      let cmp = 0;
      if (sortKey === "title") cmp = rowTitle(a).localeCompare(rowTitle(b));
      else if (sortKey === "duration")
        cmp = (a.entry?.duration ?? 0) - (b.entry?.duration ?? 0);
      else if (sortKey === "views")
        cmp = (a.entry?.viewCount ?? 0) - (b.entry?.viewCount ?? 0);
      else cmp = a.rank - b.rank;
      return asc ? cmp : -cmp;
    });
    return sorted;
  }, [rows, query, sortKey, asc]);

  /** Jobs that never merged into a row above: the rest of the queue. */
  const trailingCount = useMemo(
    () => rows.reduce((n, r) => n + (r.entry ? 0 : 1), 0),
    [rows],
  );
  /**
   * Where the trailing group starts in `view`, which is also where the "Not in
   * this playlist" rule is drawn and where a shift-click range stops. The
   * Status sort is a lifecycle rank rather than a partition, so it has no such
   * boundary and the range is left alone.
   */
  const trailingAt = useMemo(() => {
    if (sortKey === "status") return view.length;
    const at = view.findIndex((r) => !r.entry);
    return at === -1 ? view.length : at;
  }, [view, sortKey]);

  const hasJobs = useMemo(() => rows.some((r) => r.job), [rows]);
  const jobCount = useMemo(
    () => rows.reduce((n, r) => n + (r.job ? 1 : 0), 0),
    [rows],
  );

  /**
   * The scroller is only mounted when there is something to show, and it
   * remounts whenever that stops being true, so the observer is re-attached on
   * both signals.
   */
  const empty = view.length === 0;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, [layout, empty]);

  const grid = useMemo(() => gridMetrics(width), [width]);

  // One virtual item is a *row*, not an entry: one entry per row in list mode,
  // `columns` entries per row in grid mode.
  const columns = layout === "grid" ? grid.columns : 1;
  const rowCount =
    layout === "grid" ? Math.ceil(view.length / columns) : view.length;

  /**
   * Exact heights, never measured.
   *
   * A grid row is as tall as its tallest cell, because a job card carries one
   * extra status line. The single row that also carries the "Not in this
   * playlist" rule is taller again -- hence a per-index estimate rather than
   * one constant.
   */
  const rowHeight = (i: number) => {
    const base =
      layout === "grid"
        ? view
            .slice(i * columns, i * columns + columns)
            .some((r) => r.job)
          ? grid.jobRow
          : grid.entryRow
        : ROW_HEIGHT;
    return i * columns === trailingAt && trailingCount > 0
      ? base + DIVIDER_HEIGHT
      : base;
  };

  /**
   * Row keys as the virtualizer's item keys.
   *
   * Not cosmetic: `estimateSize` is not part of the virtualizer's measurement
   * cache key, so a heights-by-index estimate has to be invalidated some other
   * way, and `getItemKey` is part of it. A card also keeps its identity across
   * scroll when it is keyed on the row rather than on a position.
   */
  const getItemKey = useCallback((i: number) => view[i]?.key ?? i, [view]);

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: rowHeight,
    getItemKey,
    overscan: 6,
  });

  // Row indices shift whenever the filter or sort changes, which would make a
  // stale shift-click anchor select the wrong range.
  useEffect(() => {
    lastIndexRef.current = null;
  }, [query, sortKey, asc, mode]);

  const selectableIds = useMemo(
    () => rows.filter((r) => r.selectable).map((r) => r.entry!.id),
    [rows],
  );
  const selectableCount = selectableIds.length;
  /**
   * The selection, read back off the rows rather than passed in.
   *
   * The rows already know which of them are selected, and a second source of
   * truth for the same question is how the two lists used to disagree. A tick
   * therefore round-trips through the same union the click came from.
   */
  const chosen = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) if (r.selected && r.videoId) set.add(r.videoId);
    return set;
  }, [rows]);
  /**
   * Counted against what can be picked, not against what exists, so the bar
   * reads "4 of 19 selected" rather than "of 21" while two are mid-transfer.
   */
  const selectedCount = chosen.size;
  const totalSeconds = rows.reduce(
    (sum, r) => sum + (r.selected ? (r.entry?.duration ?? 0) : 0),
    0,
  );
  /** Selected rows already on disk, as the format picker describes them. */
  const alreadyHave = rows.reduce(
    (n, r) => n + (r.selected && (r.rung === 4 || r.rung === 5) ? 1 : 0),
    0,
  );
  /** Rows the last re-check said no longer match the selected format. */
  const needsUpdate = rows.reduce(
    (n, r) => n + (r.plan && r.plan.action !== "skip" ? 1 : 0),
    0,
  );

  /** A 440px scroller around one 72px row is a hole, not a list. */
  const contentHeight =
    (layout === "grid"
      ? rowCount * grid.entryRow
      : view.length * ROW_HEIGHT) +
    (trailingAt < view.length ? DIVIDER_HEIGHT : 0);

  /** Selection changes can imply a mode change (e.g. dropping one out of "all"). */
  const apply = (next: Set<string>, nextMode: SelectionMode = mode) => {
    onSelectionChange(next);
    if (nextMode !== mode) onModeChange(nextMode);
  };

  const toggle = (row: UnifiedRow, index: number, shift: boolean): void => {
    // A row with a job holding its slot cannot be queued twice, and a job with
    // no entry behind it has nothing to queue.
    if (!row.selectable) return;
    const id = row.entry!.id;

    if (mode === "single") {
      const next = new Set(chosen);
      const onlyThis = next.size === 1 && next.has(id);
      apply(onlyThis ? new Set() : new Set([id]));
      lastIndexRef.current = index;
      return;
    }

    const next = new Set(chosen);
    const anchor = lastIndexRef.current;

    if (mode === "multiple" && shift && anchor !== null) {
      const a = Math.min(anchor, index);
      // Stop at the "Not in this playlist" rule rather than sweeping through
      // rows a click could not have selected on its own.
      const b = Math.min(Math.max(anchor, index), trailingAt - 1);
      const turningOn = !chosen.has(view[a]?.entry?.id ?? "");
      for (let i = a; i <= b; i++) {
        const target = view[i];
        if (!target?.entry) continue;
        if (turningOn) next.add(target.entry.id);
        else next.delete(target.entry.id);
      }
    } else if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }

    lastIndexRef.current = index;
    // Leaving "all" by unchecking something falls back to free-form multi-select.
    apply(next, mode === "all" ? "multiple" : mode);
  };

  const handleModeChange = (next: SelectionMode) => {
    if (next === "all") {
      onModeChange("all");
      onSelectionChange(new Set(selectableIds));
      return;
    }

    if (next === "single") {
      const nextSet = new Set<string>();
      if (chosen.size > 0) {
        // Keep the earliest video in playlist order rather than an arbitrary one.
        const first = selectableIds.find((id) => chosen.has(id));
        if (first) nextSet.add(first);
      }
      onModeChange("single");
      onSelectionChange(nextSet);
      return;
    }

    onModeChange("multiple");
  };

  const invert = () =>
    apply(
      new Set(selectableIds.filter((id) => !chosen.has(id))),
      mode === "all" ? "multiple" : mode,
    );

  const clear = () => apply(new Set(), mode === "all" ? "multiple" : mode);

  const Checkbox_ = ({
    row,
    index,
  }: {
    row: UnifiedRow;
    index: number;
  }) => {
    // A fixed-width hole rather than a removed element: the checkbox returns
    // the moment a job settles, and it has to return in place.
    if (!row.selectable) {
      return <span aria-hidden className="h-4 w-4 shrink-0" />;
    }
    const checked = row.selected;
    return (
      <span className="relative inline-flex h-4 w-4 shrink-0 items-center justify-center">
        <Checkbox
          type={mode === "single" ? "radio" : "checkbox"}
          checked={checked}
          onChange={(e) =>
            // A checkbox change originates from a pointer click, so the DOM
            // native event carries the modifier state React drops.
            toggle(row, index, (e.nativeEvent as MouseEvent).shiftKey)
          }
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${rowTitle(row)}`}
          className="peer absolute inset-0 h-4 w-4 opacity-0"
        />
        <span
          aria-hidden
          className={cn(
            "pointer-events-none flex h-4 w-4 items-center justify-center border transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-ring",
            mode === "single" ? "rounded-full" : "rounded-[5px]",
            checked
              ? "border-primary bg-primary"
              : "border-input bg-field group-hover:border-foreground/40",
          )}
        >
          {checked ? (
            mode === "single" ? (
              <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
            ) : (
              <HugeiconsIcon
                icon={Tick01Icon}
                className="h-3 w-3 text-primary-foreground"
                strokeWidth={3}
              />
            )
          ) : null}
        </span>
      </span>
    );
  };

  const StatusBadge = ({
    badge,
  }: {
    badge: NonNullable<ReturnType<typeof badgeFor>>;
  }) => (
    <Badge variant={badge.tone} title={badge.title}>
      {badge.tone === "success" ? (
        <HugeiconsIcon icon={TickDouble01Icon} className="mr-1 h-3 w-3" />
      ) : badge.tone === "warning" ? (
        <HugeiconsIcon icon={RefreshIcon} className="mr-1 h-3 w-3" />
      ) : null}
      {badge.label}
    </Badge>
  );

  /**
   * The two job controls, as a matrix over phase. Moved verbatim from
   * `QueuePanel`.
   *
   * Phase-first rather than `running`-first: "paused" is not an active phase
   * but it is not terminal either, and it must offer Resume, not Retry. The
   * accessible names are load-bearing -- the browser suite locates a paused row
   * by `<article aria-label>` and then for a button named exactly "Resume" --
   * and these are icon-only buttons, so the name comes from `aria-label` and
   * `title` rather than from anything visible.
   */
  const JobButtons = ({ row }: { row: UnifiedRow }) => {
    const job = row.job;
    if (!job) return null;
    const settled = job.phase === "done" || job.phase === "skipped";
    const running = row.rung === 1 && job.phase !== "paused";

    const state =
      job.phase === "paused"
        ? {
            label: "Resume",
            icon: PlayIcon,
            run: () => attempt(api.resumeJob(job.id)),
          }
        : settled
          ? {
              label: "Reveal file",
              icon: FolderOpenIcon,
              run: () => attempt(api.openFile(job.id, true)),
            }
          : job.phase === "error" || job.phase === "cancelled"
            ? {
                label: "Retry",
                icon: RotateCcwIcon,
                run: () => attempt(api.retryJob(job.id)),
              }
            : {
                label: "Pause",
                icon: PauseIcon,
                run: () => attempt(api.pauseJob(job.id)),
              };

    /**
     * A live job has to be stopped before its row can be dropped --
     * `removeJob` refuses to touch anything still in flight. Terminal rows need
     * no stop.
     */
    const drop = () => {
      if (!running) {
        attempt(api.removeJob(job.id));
        return;
      }
      attempt(
        api.cancelJob(job.id).then(() => {
          attempt(api.removeJob(job.id));
        }),
      );
    };

    const StateIcon = state.icon;
    return (
      <>
        <Button
          size="xs"
          variant="ghost"
          title={state.label}
          aria-label={state.label}
          onClick={(e) => {
            e.stopPropagation();
            state.run();
          }}
        >
          <HugeiconsIcon icon={StateIcon} className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="xs"
          variant="ghost"
          title={settled ? "Remove from queue" : "Delete"}
          aria-label={settled ? "Remove from queue" : "Delete"}
          onClick={(e) => {
            e.stopPropagation();
            drop();
          }}
        >
          <HugeiconsIcon icon={Delete02Icon} className="h-3.5 w-3.5" />
        </Button>
      </>
    );
  };

  /**
   * The transfer readout, pinned to the row's bottom edge.
   *
   * `h-0.5` and absolutely positioned, so it costs zero vertical space and
   * reads as a transfer rather than as another control on the row.
   */
  const Transfer = ({ row }: { row: UnifiedRow }) => {
    const job = row.job!;
    return (
      <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0.5">
        <Progress
          value={job.percent}
          indeterminate={
            job.phase === "probing" || job.phase === "postprocessing"
          }
        />
      </span>
    );
  };

  /** One cell of a virtual row. `index` is into the filtered+sorted `view`. */
  const cell = (row: UnifiedRow, index: number) => {
    const badge = badgeFor(row);
    const title = rowTitle(row);
    const src = row.entry
      ? row.entry.thumbnail
      : (row.job?.thumbnail ??
        (row.job?.videoId ? thumbnailFor(row.job.videoId) : undefined));
    // The second line is the job's status when a job owns the row, and the
    // entry's own facts otherwise. Mutually exclusive, by the ladder.
    const spoken = speaksInStatusLine(row);
    const second = spoken ? statusLine(row.job!) : rowFacts(row);

    const body = (
      <>
        {layout === "grid" ? null : (
          <>
            <Checkbox_ row={row} index={index} />
            <RowThumb
              src={src}
              dimmed={!row.selected}
              checked={row.selected && row.selectable}
              shape="tile"
            />
            <span className="w-6 shrink-0 text-right text-[11px] tabular-nums text-faint">
              {row.entry?.index ?? ""}
            </span>
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  "block truncate text-xs",
                  row.selected ? "text-foreground" : "text-muted-foreground",
                )}
                title={title}
              >
                {title}
              </span>
              {second ? (
                <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                  {second}
                </span>
              ) : null}
            </span>
            <span className="flex shrink-0 items-center gap-1">
              {row.entry?.isLive ? (
                <Badge variant="destructive">
                  <HugeiconsIcon icon={RadioIcon} className="mr-1 h-3 w-3" />
                  Live
                </Badge>
              ) : null}
              {badge ? <StatusBadge badge={badge} /> : null}
              <JobButtons row={row} />
            </span>
          </>
        )}

        {layout === "grid" ? (
          <>
            <span
              className="relative block w-full shrink-0"
              style={{ aspectRatio: "16 / 9" }}
            >
              <RowThumb
                src={src}
                duration={row.entry?.duration}
                dimmed={!row.selected}
                checked={row.selected && row.selectable}
                shape="cover"
              />
              {row.selectable ? (
                <span className="absolute left-2 top-2">
                  <Checkbox_ row={row} index={index} />
                </span>
              ) : null}
            </span>
            <span className="flex min-w-0 flex-1 flex-col gap-1.5 p-3">
              <span className="flex items-baseline gap-2">
                <span className="text-[11px] tabular-nums text-faint">
                  {row.entry?.index ?? ""}
                </span>
                <span
                  className={cn(
                    "line-clamp-2 min-w-0 flex-1 text-xs leading-snug",
                    row.selected
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                  title={title}
                >
                  {title}
                </span>
              </span>
              {spoken ? (
                <span className="truncate text-[11px] text-muted-foreground">
                  {second}
                </span>
              ) : null}
              <span className="mt-auto flex flex-wrap items-center gap-1.5">
                {row.entry?.isLive ? (
                  <Badge variant="destructive">
                    <HugeiconsIcon icon={RadioIcon} className="mr-1 h-3 w-3" />
                    Live
                  </Badge>
                ) : null}
                {badge ? <StatusBadge badge={badge} /> : null}
                {/* The icon buttons live in the meta row, which is otherwise
                    empty once the ownership badge is gone, so a job card is
                    22px taller than an entry card rather than 58px. */}
                <span className="ml-auto flex shrink-0 items-center gap-0.5">
                  <JobButtons row={row} />
                  {!row.job && row.entry?.viewCount ? (
                    <span className="text-[11px] tabular-nums text-faint">
                      {formatViews(row.entry.viewCount)}
                    </span>
                  ) : null}
                </span>
              </span>
            </span>
          </>
        ) : null}
      </>
    );

    if (layout === "grid") {
      const shell = {
        onClick: () => toggle(row, index, false),
        // The row's height is exact (`rowHeight`), so a card can fill it rather
        // than carry its own: a row that mixes a job card with entry cards is
        // 22px taller, and the shorter cards stretch to match instead of
        // leaving a ragged edge under the row.
        style: { height: "100%" },
        className: cn(
          "group relative flex cursor-pointer flex-col overflow-hidden rounded-lg border transition-colors",
          row.selected
            ? "border-primary bg-secondary/70"
            : "border-border hover:bg-secondary/40",
        ),
      };
      return row.job ? (
        <article key={row.key} aria-label={row.job.title} {...shell}>
          {body}
          {row.rung === 1 ? <Transfer row={row} /> : null}
        </article>
      ) : (
        <div key={row.key} {...shell}>
          {body}
          {row.rung === 1 ? <Transfer row={row} /> : null}
        </div>
      );
    }

    const shell = {
      onClick: () => toggle(row, index, false),
      style: { height: ROW_HEIGHT },
      className: cn(
        "group relative flex cursor-pointer items-center border-b border-border px-4 transition-colors",
        row.selected ? "bg-secondary/70" : "hover:bg-secondary/40",
      ),
    };
    const inner = (
      <>
        <span
          aria-hidden
          className={cn(
            "absolute left-0 top-0 h-full w-[3px] transition-colors",
            row.selected ? "bg-primary" : "bg-transparent",
          )}
        />
        <span
          role="row"
          aria-selected={row.selected}
          className="flex min-w-0 flex-1 items-center gap-3"
        >
          {body}
        </span>
        {row.rung === 1 ? <Transfer row={row} /> : null}
      </>
    );
    return row.job ? (
      <article key={row.key} aria-label={row.job.title} {...shell}>
        {inner}
      </article>
    ) : (
      <div key={row.key} {...shell}>
        {inner}
      </div>
    );
  };

  return (
    <Card className={cn("overflow-hidden", className)}>
      {header || hasJobs ? (
        <div
          className={cn(
            "flex items-start gap-3 border-b border-border",
            // With no probe to name, the count is the whole header and a 20px
            // band of empty space above it reads as a mistake.
            header ? "p-5" : "justify-end px-5 py-2.5",
          )}
        >
          {header ? <div className="min-w-0 flex-1">{header}</div> : null}
          {hasJobs ? (
            <span className={cn("chip shrink-0", header ? "" : "ml-auto")}>
              {jobCount} queued
            </span>
          ) : null}
        </div>
      ) : null}

      {sectionMode === "queue" ? null : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
            <div className="relative min-w-[160px] flex-1">
              <HugeiconsIcon
                icon={Search01Icon}
                className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
              />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter titles…"
                className="pl-8"
              />
            </div>

            <Select
              value={sortKey}
              onValueChange={(v) => setSortKey(v as SortKey)}
            >
              <SelectTrigger className="w-auto" aria-label="Sort playlist by">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="index">Playlist order</SelectItem>
                <SelectItem value="title">Title</SelectItem>
                <SelectItem value="duration">Duration</SelectItem>
                <SelectItem value="views">Views</SelectItem>
                {/* Filter segments were considered and rejected: they would
                    look like tabs, which is explicitly not what this is. */}
                {hasJobs ? <SelectItem value="status">Status</SelectItem> : null}
              </SelectContent>
            </Select>

            {/* A rank has no meaningful reverse, so the toggle disables rather
                than silently doing nothing. */}
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAsc((v) => !v)}
              disabled={sortKey === "status"}
            >
              {asc ? "Asc" : "Desc"}
            </Button>
          </div>

          <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
            <span className="micro">Selection</span>
            <div
              role="group"
              aria-label="Selection mode"
              className="inline-flex rounded-lg border border-border bg-field p-0.5"
            >
              {MODES.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={mode === m.id}
                  onClick={() => handleModeChange(m.id)}
                  className={cn(
                    "cursor-pointer rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors",
                    mode === m.id
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>

            <div className="ml-auto flex items-center gap-1">
              {mode === "all" ? null : (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={invert}
                  disabled={selectableCount === 0}
                >
                  Invert
                </Button>
              )}
              {/* Renamed from a bare "Clear": the queue's "Clear finished" now
                  sits a row away from it, and two identical buttons in one card
                  is a hazard. */}
              <Button
                variant="ghost"
                size="sm"
                onClick={clear}
                disabled={selectedCount === 0}
              >
                Clear selection
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border bg-secondary/40 px-4 py-2.5">
            <div className="flex items-baseline gap-1.5">
              <span className="text-lg font-semibold tabular-nums leading-none">
                {selectedCount}
              </span>
              <span className="text-xs text-muted-foreground">
                of {selectableCount} video
                {selectableCount === 1 ? "" : "s"} selected
              </span>
            </div>

            <Progress
              value={
                selectableCount ? (selectedCount / selectableCount) * 100 : 0
              }
              className="h-1 w-20 shrink-0"
            />

            {totalSeconds > 0 ? (
              <span className="text-xs tabular-nums text-muted-foreground">
                {formatDuration(totalSeconds)} total
              </span>
            ) : null}

            {alreadyHave > 0 ? (
              <Badge variant="warning">{alreadyHave} already downloaded</Badge>
            ) : null}

            {needsUpdate > 0 ? (
              <Badge variant="warning">
                <HugeiconsIcon icon={RefreshIcon} className="mr-1 h-3 w-3" />
                {needsUpdate} need updating
              </Badge>
            ) : null}

            {query ? (
              <span className="ml-auto text-[11px] text-faint">
                {view.length} shown
              </span>
            ) : null}
          </div>
        </>
      )}

      {hasJobs ? (
        /* List-wide actions get their own row. Inlined into the selection row
           they would put ten ghost buttons in a 672px column, and the sticky
           footer below belongs to committing the selection, not to the queue. */
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2.5">
          <span className="micro">Queue</span>
          {BULK_ACTIONS.map(({ id, label, icon: Icon }) => (
            <QueueActionButton
              key={id}
              label={label}
              onClick={() => attempt(api.bulkQueue(id))}
            >
              <HugeiconsIcon icon={Icon} className="h-4 w-4" />
            </QueueActionButton>
          ))}
          <QueueActionButton
            label="Clear finished"
            onClick={() => attempt(api.clearJobs())}
          >
            <HugeiconsIcon icon={Delete02Icon} className="h-4 w-4" />
          </QueueActionButton>
        </div>
      ) : null}

      {view.length === 0 ? (
        <div className="flex h-[200px] items-center justify-center px-6 text-center text-xs text-muted-foreground">
          {rows.length === 0
            ? "This playlist has no readable entries."
            : `No videos match “${query}”.`}
        </div>
      ) : (
        <div
          ref={scrollRef}
          className={cn(
            "overflow-y-auto",
            contentHeight > 380 ? "h-[380px] sm:h-[440px]" : "h-auto",
          )}
        >
          <div
            style={{
              height: virtualizer.getTotalSize(),
              position: "relative",
            }}
          >
            {virtualizer.getVirtualItems().map((virtual) => {
              const start = virtual.index * columns;
              const cells = view.slice(start, start + columns);
              if (!cells.length) return null;
              const height = rowHeight(virtual.index);
              // `start` is an index into `view` and `virtual.index` an index
              // into rows: the same number in list mode, not in grid mode.
              const divider = start === trailingAt && trailingCount > 0;
              return (
                <div
                  // The virtualizer's own item key, so a card keeps its identity
                  // across scroll instead of remounting on every row change.
                  key={virtual.key}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height,
                    transform: `translateY(${virtual.start}px)`,
                  }}
                >
                  {divider ? (
                    <div
                      style={{ height: DIVIDER_HEIGHT }}
                      className="flex items-center gap-2 px-4"
                    >
                      <span aria-hidden className="h-px flex-1 bg-border" />
                      <span className="text-[10px] uppercase tracking-[0.08em] text-faint">
                        {`Not in this playlist (${trailingCount})`}
                      </span>
                      <span aria-hidden className="h-px flex-1 bg-border" />
                    </div>
                  ) : null}
                  {layout === "grid" ? (
                    <div
                      className="grid gap-3 px-4 py-3"
                      style={{
                        height: height - (divider ? DIVIDER_HEIGHT : 0),
                        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                      }}
                    >
                      {cells.map((c, offset) => cell(c, start + offset))}
                    </div>
                  ) : (
                    cells.map((c, offset) => cell(c, start + offset))
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2.5 text-[11px] text-faint">
        <span>
          {sectionMode === "queue"
            ? "Jobs with no entry in the current probe."
            : MODE_HINT[mode]}
        </span>
        {sectionMode === "queue" ? null : (
          <span>
            {selectedCount === selectableCount && selectableCount > 0
              ? "All videos will download"
              : `${selectableCount - selectedCount} skipped`}
          </span>
        )}
      </div>

      {footer ? (
        <div className="sticky bottom-0 z-10 space-y-2 border-t border-border bg-card/95 px-4 py-3 backdrop-blur">
          {footer}
        </div>
      ) : null}
    </Card>
  );
}
