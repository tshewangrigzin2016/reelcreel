import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Album02Icon,
  Download04Icon,
  Loading03Icon,
  PlayCircleIcon,
  RadioIcon,
  Search01Icon,
  TickDouble02Icon,
  UserGroupIcon,
  ZapIcon,
} from "@hugeicons/core-free-icons";
import type {
  DownloadOptions,
  Preset,
  SearchResult,
  SearchSort,
} from "@shared/types";
import { formatDuration, formatViews } from "@shared/format";
import { api } from "@/lib/api";
import { FILTERS, filterResults, rankResults, type ExploreFilter } from "@/lib/search";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
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
import { DownloadDialog } from "@/components/DownloadDialog";
import { ExploreListingDialog } from "@/components/ExploreListingDialog";

interface Props {
  presets: Preset[];
  presetId: string;
  options: DownloadOptions;
}

const KIND_ICON = {
  video: PlayCircleIcon,
  short: ZapIcon,
  channel: UserGroupIcon,
  playlist: Album02Icon,
  live: RadioIcon,
} as const;

/**
 * Small icon-only badge that sits on a thumbnail, with the same CSS-only
 * tooltip pattern as `QueueActionButton` in PlaylistTable (top side, instant
 * on hover). No `title` delay, no extra dependency.
 */
function ThumbTip({
  label,
  className,
  large,
  children,
}: {
  label: string;
  className?: string;
  large?: boolean;
  children: ReactNode;
}) {
  return (
    <span className={cn("group/tip absolute z-10 inline-flex", className)}>
      <span
        className={cn(
          "flex items-center justify-center bg-black/70 text-white",
          large ? "rounded-md p-1" : "rounded p-0.5",
        )}
      >
        {children}
      </span>
      <span
        role="tooltip"
        aria-hidden
        className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-popover px-1.5 py-0.5 text-[10px] font-medium text-popover-foreground opacity-0 transition-none group-hover/tip:opacity-100 group-focus-within/tip:opacity-100"
      >
        {label}
        <span
          aria-hidden
          className="absolute left-1/2 top-full h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border-b border-r border-border bg-popover"
        />
      </span>
    </span>
  );
}

function ExploreThumb({
  r,
  shape,
  downloaded,
}: {
  r: SearchResult;
  shape: "tile" | "cover";
  downloaded?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const KindIcon = KIND_ICON[r.kind];
  return (
    <span
      className={cn(
        "relative block",
        shape === "tile" ? "h-9 w-16 shrink-0" : "h-full w-full",
      )}
    >
      <span
        className={cn(
          "absolute inset-0 block overflow-hidden bg-secondary",
          shape === "tile" ? "rounded" : "rounded-t-lg",
        )}
      >
        {!failed ? (
          <img
            src={r.thumbnail}
            alt=""
            loading="lazy"
            onError={() => setFailed(true)}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-full w-full items-center justify-center text-faint">
            <HugeiconsIcon icon={PlayCircleIcon} className="h-4 w-4" />
          </span>
        )}
        {r.kind === "video" || r.kind === "short" ? (
          r.duration ? (
            <span
              className={cn(
                "absolute bg-black/80 px-1 text-[10px] tabular-nums text-white",
                shape === "tile"
                  ? "bottom-0 right-0 rounded-tl"
                  : "bottom-1.5 right-1.5 rounded",
              )}
            >
              {formatDuration(r.duration)}
            </span>
          ) : null
        ) : null}
      </span>
      <ThumbTip
        label={r.kind}
        large={shape === "cover"}
        className={shape === "tile" ? "left-0.5 top-0.5" : "left-1.5 top-1.5"}
      >
        <span role="img" aria-label={r.kind} className="flex">
          <HugeiconsIcon
            icon={KindIcon}
            className={shape === "tile" ? "h-2.5 w-2.5" : "h-3.5 w-3.5"}
          />
        </span>
      </ThumbTip>
      {downloaded ? (
        <ThumbTip
          label="Downloaded"
          large={shape === "cover"}
          className={shape === "tile" ? "right-0.5 top-0.5" : "right-1.5 top-1.5"}
        >
          <span role="img" aria-label="Downloaded" className="flex text-green-400">
            <HugeiconsIcon
              icon={TickDouble02Icon}
              className={shape === "tile" ? "h-2.5 w-2.5" : "h-3.5 w-3.5"}
            />
          </span>
        </ThumbTip>
      ) : null}
    </span>
  );
}

/**
 * YouTube-like Explore: search videos, shorts, channels, playlists and live.
 * Powered by the same yt-dlp binary as downloads (GET /api/search), ranked by
 * the server match algorithm (title/channel tokens + popularity) and
 * re-ranked client-side for exact-phrase hits. Downloading reuses POST
 * /api/downloads through a compact popup.
 */
export function ExplorePage({ presets, presetId, options }: Props) {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ExploreFilter>("all");
  const [sort, setSort] = useState<SearchSort>("relevance");
  const [picked, setPicked] = useState<SearchResult | null>(null);
  const [listing, setListing] = useState<SearchResult | null>(null);
  const layout = useAppStore((s) => s.layout);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounced YouTube-style search-as-you-type.
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    if (!input.trim()) {
      setQuery("");
      return;
    }
    timer.current = setTimeout(() => setQuery(input.trim()), 450);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [input]);

  const search = useQuery({
    queryKey: ["explore", query, sort],
    queryFn: ({ signal }) => api.search(query, 30, sort, signal),
    enabled: query.length > 1,
    staleTime: 60_000,
  });

  const ownedQuery = useQuery({
    queryKey: ["ownership", "all"],
    queryFn: () => api.historyIds(),
  });
  const ownedIds = useMemo(
    () => new Set(ownedQuery.data ?? []),
    [ownedQuery.data],
  );

  const results = useMemo(() => {
    const raw = search.data?.results ?? [];
    return rankResults(filterResults(raw, filter), query);
  }, [search.data, filter, query]);

  const counts = useMemo(() => {
    const raw = search.data?.results ?? [];
    const c: Record<string, number> = { all: raw.length };
    for (const r of raw) c[r.kind] = (c[r.kind] ?? 0) + 1;
    return c;
  }, [search.data]);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-medium">Explore</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Search YouTube like the platform — videos, shorts, channels,
          playlists, live. Same download engine underneath.
        </p>
      </div>

      <div className="rounded-2xl border border-border bg-card p-2">
        <div className="flex items-center gap-1">
          <HugeiconsIcon icon={Search01Icon} className="ml-3 h-4 w-4 shrink-0 text-faint" />
          <Input
            aria-label="Search YouTube"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Search videos, shorts, channels…"
            spellCheck={false}
            className="h-11 flex-1 border-0 bg-transparent px-2 text-sm focus-visible:ring-0"
          />
          {search.isFetching ? (
            <HugeiconsIcon icon={Loading03Icon} className="mr-3 h-4 w-4 animate-spin text-faint" />
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "cursor-pointer rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              filter === f.id
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border bg-card text-muted-foreground hover:text-foreground",
            )}
          >
            {f.label}
            {counts[f.id] ? (
              <span className="ml-1 tabular-nums opacity-70">{counts[f.id]}</span>
            ) : null}
          </button>
        ))}
        <span className="ml-auto">
          <Select value={sort} onValueChange={(v) => setSort(v as SearchSort)}>
            <SelectTrigger className="h-8 w-auto text-xs" aria-label="Sort results">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="relevance">Best match</SelectItem>
              <SelectItem value="views">Most viewed</SelectItem>
              <SelectItem value="recent">Recent relevance</SelectItem>
            </SelectContent>
          </Select>
        </span>
      </div>

      {!query ? (
        <Card className="flex flex-col items-center gap-2 px-6 py-14 text-center">
          <HugeiconsIcon icon={Search01Icon} className="h-6 w-6 text-faint" />
          <p className="text-sm text-muted-foreground">
            Type to search YouTube. Results rank by title match, channel match
            and popularity.
          </p>
          <p className="text-[11px] text-faint">
            Powered by yt-dlp search — no API key needed.
          </p>
        </Card>
      ) : null}

      {search.error ? (
        <Card className="border-destructive/40 p-4 text-sm text-destructive">
          {(search.error as Error).message}
        </Card>
      ) : null}

      {search.isPending && query.length > 1 ? (
        <Card className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <HugeiconsIcon icon={Loading03Icon} className="h-4 w-4 animate-spin" />
          Searching YouTube…
        </Card>
      ) : null}

      {search.data && results.length === 0 ? (
        <Card className="px-6 py-12 text-center text-sm text-muted-foreground">
          No {filter === "all" ? "" : filter + " "}results for “{query}”.
        </Card>
      ) : null}

      {results.length > 0 ? (
        layout === "list" ? (
          <Card className="overflow-visible">
            {results.map((r, idx) => {
              const Icon = KIND_ICON[r.kind];
              const downloaded =
                r.kind !== "channel" &&
                r.kind !== "playlist" &&
                ownedIds.has(r.id);
              const facts = [
                r.channel,
                r.duration ? formatDuration(r.duration) : null,
                formatViews(r.viewCount),
                r.videoCount ? `${r.videoCount} items` : null,
              ]
                .filter(Boolean)
                .join(" · ");
              const primaryAction =
                r.kind === "channel" || r.kind === "playlist" ? (
                  <Button
                    size="sm"
                    onClick={() => setListing(r)}
                    title={
                      r.kind === "channel"
                        ? "View channel uploads"
                        : "View playlist videos"
                    }
                  >
                    <HugeiconsIcon icon={Icon} className="mr-1.5 h-3.5 w-3.5" />
                    {r.kind === "channel" ? "View channel" : "View playlist"}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() => setPicked(r)}
                    title="Download"
                  >
                    <HugeiconsIcon
                      icon={Download04Icon}
                      className="mr-1.5 h-3.5 w-3.5"
                    />
                    Download
                  </Button>
                );
              return (
                <div
                  key={`${r.kind}-${r.id}`}
                  className="group relative flex items-center gap-3 border-b border-border px-4 first:rounded-t-2xl last:rounded-b-2xl last:border-0 hover:bg-secondary/40"
                  style={{ height: 72 }}
                >
                  <span className="hidden w-6 shrink-0 text-right text-[11px] tabular-nums text-faint sm:block">
                    {idx + 1}
                  </span>
                  <ExploreThumb r={r} shape="tile" downloaded={downloaded} />
                  <span className="min-w-0 flex-1">
                    <span
                      className="block truncate text-xs text-foreground"
                      title={r.title}
                    >
                      {r.title}
                    </span>
                    {facts ? (
                      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                        {facts}
                      </span>
                    ) : null}
                  </span>
                  <span className="flex shrink-0 items-center gap-1.5">
                    {primaryAction}
                    <Button size="sm" variant="outline" asChild>
                      <a href={r.url} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    </Button>
                  </span>
                </div>
              );
            })}
          </Card>
        ) : (
          <Card className="overflow-visible">
            <div
              className="grid gap-3 px-4 py-3"
              style={{
                gridTemplateColumns:
                  "repeat(auto-fill, minmax(210px, 1fr))",
              }}
            >
              {results.map((r, idx) => {
                const Icon = KIND_ICON[r.kind];
                const downloaded =
                  r.kind !== "channel" &&
                  r.kind !== "playlist" &&
                  ownedIds.has(r.id);
                const facts = [
                  r.channel,
                  r.duration ? formatDuration(r.duration) : null,
                  formatViews(r.viewCount),
                  r.videoCount ? `${r.videoCount} items` : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <div
                    key={`${r.kind}-${r.id}`}
                    className="group relative flex flex-col overflow-visible rounded-lg border border-border hover:bg-secondary/40"
                  >
                    <span
                      className="relative block w-full shrink-0"
                      style={{ aspectRatio: "16 / 9" }}
                    >
                      <ExploreThumb r={r} shape="cover" downloaded={downloaded} />
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col gap-1.5 p-3">
                      <span className="flex items-baseline gap-2">
                        <span className="text-[11px] tabular-nums text-faint">
                          {idx + 1}
                        </span>
                        <span
                          className="line-clamp-2 min-w-0 flex-1 text-xs leading-snug text-foreground"
                          title={r.title}
                        >
                          {r.title}
                        </span>
                      </span>
                      {facts ? (
                        <span className="truncate text-[11px] text-muted-foreground">
                          {facts}
                        </span>
                      ) : null}
                      <span className="mt-auto flex gap-2 pt-1">
                        {r.kind === "channel" || r.kind === "playlist" ? (
                          <Button
                            size="sm"
                            className="flex-1"
                            onClick={() => setListing(r)}
                            title={
                              r.kind === "channel"
                                ? "View channel uploads"
                                : "View playlist videos"
                            }
                          >
                            <HugeiconsIcon
                              icon={Icon}
                              className="mr-1.5 h-3.5 w-3.5"
                            />
                            {r.kind === "channel"
                              ? "View channel"
                              : "View playlist"}
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            className="flex-1"
                            onClick={() => setPicked(r)}
                            title="Download"
                          >
                            <HugeiconsIcon
                              icon={Download04Icon}
                              className="mr-1.5 h-3.5 w-3.5"
                            />
                            Download
                          </Button>
                        )}
                        <Button size="sm" variant="outline" asChild>
                          <a href={r.url} target="_blank" rel="noreferrer">
                            Open
                          </a>
                        </Button>
                      </span>
                    </span>
                  </div>
                );
              })}
            </div>
          </Card>
        )
      ) : null}

      {search.data?.truncated ? (
        <p className="text-[11px] text-faint">
          Showing top {search.data.results.length} matches for “{search.data.query}”.
        </p>
      ) : null}

      <DownloadDialog
        result={picked}
        presets={presets}
        defaultPresetId={presetId}
        defaultOptions={options}
        onClose={() => setPicked(null)}
      />
      <ExploreListingDialog
        target={listing}
        presets={presets}
        defaultPresetId={presetId}
        defaultOptions={options}
        onClose={() => setListing(null)}
      />
    </section>
  );
}
