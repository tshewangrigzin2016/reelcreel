import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Album02Icon,
  Download04Icon,
  Loading03Icon,
  PlayCircleIcon,
  RadioIcon,
  Search01Icon,
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
import { Badge } from "@/components/ui/badge";
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

function ResultThumb({ r }: { r: SearchResult }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="relative block aspect-video w-full overflow-hidden bg-secondary">
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
          <HugeiconsIcon icon={PlayCircleIcon} className="h-6 w-6" />
        </span>
      )}
      {r.kind === "video" || r.kind === "short" ? (
        r.duration ? (
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/80 px-1 text-[10px] tabular-nums text-white">
            {formatDuration(r.duration)}
          </span>
        ) : null
      ) : null}
      <span className="absolute left-1.5 top-1.5">
        <Badge variant={r.kind === "live" ? "destructive" : "secondary"}>
          {r.kind}
        </Badge>
      </span>
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
        <div
          className={cn(
            "grid gap-3",
            layout === "grid" ? "sm:grid-cols-2" : "grid-cols-1",
          )}
        >
          {results.map((r) => {
            const Icon = KIND_ICON[r.kind];
            const downloaded =
              r.kind !== "channel" &&
              r.kind !== "playlist" &&
              ownedIds.has(r.id);
            return (
              <Card key={`${r.kind}-${r.id}`} className="overflow-hidden">
                <ResultThumb r={r} />
                <div className="space-y-2 p-3">
                  <p className="line-clamp-2 text-sm font-medium leading-snug" title={r.title}>
                    {r.title}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {[
                      r.channel,
                      r.duration ? formatDuration(r.duration) : null,
                      formatViews(r.viewCount),
                      r.videoCount ? `${r.videoCount} items` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline">
                      <HugeiconsIcon icon={Icon} className="mr-1 h-3 w-3" />
                      {r.kind}
                    </Badge>
                    {downloaded ? <Badge variant="success">Downloaded</Badge> : null}
                    <span className="ml-auto text-[11px] tabular-nums text-faint">
                      score {r.score}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="flex-1"
                      disabled={r.kind === "channel" || r.kind === "playlist"}
                      onClick={() => setPicked(r)}
                      title={
                        r.kind === "channel" || r.kind === "playlist"
                          ? "Open on YouTube instead"
                          : "Download"
                      }
                    >
                      <HugeiconsIcon icon={Download04Icon} className="mr-1.5 h-3.5 w-3.5" />
                      Download
                    </Button>
                    <Button size="sm" variant="outline" asChild>
                      <a href={r.url} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    </Button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
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
    </section>
  );
}
