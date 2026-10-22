import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Download04Icon, Loading03Icon } from "@hugeicons/core-free-icons";
import type {
  DownloadOptions,
  PlaylistEntry,
  Preset,
  SearchResult,
} from "@shared/types";
import { formatDuration, formatViews } from "@shared/format";
import { buildSelectionFingerprint } from "@shared/request-key";
import { api } from "@/lib/api";
import { claimDelivery } from "@/lib/delivery";
import { useAppStore } from "@/lib/store";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const FIRST_PAGE = 20;
const NEXT_PAGE = 10;
const HEIGHTS = [2160, 1440, 1080, 720, 480, 360];

interface Props {
  target: SearchResult | null;
  presets: Preset[];
  defaultPresetId: string;
  defaultOptions: DownloadOptions;
  onClose: () => void;
}

/**
 * Channel / playlist drill-in modal for Explore.
 *
 * Opens from a channel or playlist card, lists uploads/entries with lazy
 * infinite scroll (20 first, 10 more per step), checkbox selection, and the
 * same minimal Video/Audio + format + quality picker the single-video popup
 * uses — applied to the whole selection at once via POST /api/downloads.
 */
export function ExploreListingDialog({
  target,
  presets,
  defaultPresetId,
  defaultOptions,
  onClose,
}: Props) {
  const [entries, setEntries] = useState<PlaylistEntry[]>([]);
  const [title, setTitle] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const [group, setGroup] = useState<"video" | "audio">("video");
  const [presetId, setPresetId] = useState(defaultPresetId);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(
    defaultOptions.maxHeight,
  );
  const [busy, setBusy] = useState(false);

  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const requestRef = useRef(0);

  const open = target !== null;
  const isChannel = target?.kind === "channel";

  /** Canonical listable URL: channelId wins over the search card's URL. */
  const effectiveUrl = target
    ? target.kind === "channel" && target.channelId
      ? `https://www.youtube.com/channel/${target.channelId}/videos`
      : target.channelUrl ?? target.url
    : "";

  const resetFor = useCallback(
    (t: SearchResult) => {
      requestRef.current++;
      setEntries([]);
      setTitle(t.title);
      setError(null);
      setHasMore(false);
      setSelected(new Set());
      setPresetId(defaultPresetId);
      setMaxHeight(defaultOptions.maxHeight);
      setGroup("video");
    },
    [defaultPresetId, defaultOptions.maxHeight],
  );

  const loadPage = useCallback(
    async (url: string, start: number, limit: number, first: boolean) => {
      const ticket = ++requestRef.current;
      if (first) setLoading(true);
      else setLoadingMore(true);
      setError(null);
      try {
        const res = await api.listing(url, start, limit);
        if (ticket !== requestRef.current) return;
        setTitle((prev) => res.title ?? prev);
        setEntries((prev) => {
          const seen = new Set(prev.map((e) => e.id));
          const fresh = res.entries.filter((e) => !seen.has(e.id));
          // Follow "select all" across pages: if everything so far was
          // selected, new arrivals join the selection too.
          setSelected((prevSel) => {
            if (fresh.length === 0) return prevSel;
            if (first) return new Set(fresh.map((e) => e.id));
            if (prevSel.size === prev.length) {
              const next = new Set(prevSel);
              for (const e of fresh) next.add(e.id);
              return next;
            }
            return prevSel;
          });
          return [...prev, ...fresh];
        });
        setHasMore(res.hasMore);
      } catch (err) {
        if (ticket !== requestRef.current) return;
        setError(err instanceof Error ? err.message : "Could not load videos.");
        setHasMore(false);
      } finally {
        if (ticket === requestRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [],
  );

  // Fresh listing each time a new channel/playlist is opened.
  useEffect(() => {
    if (!target) return;
    resetFor(target);
    void loadPage(effectiveUrl, 1, FIRST_PAGE, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.id, target?.url, target?.channelId, target?.channelUrl, resetFor, loadPage]);

  // Auto-load 10 more as the user scrolls to the bottom.
  useEffect(() => {
    if (!open || !hasMore) return;
    const el = sentinelRef.current;
    if (!el || !target) return;
    const url = effectiveUrl;
    const observer = new IntersectionObserver(
      (items) => {
        if (items.some((i) => i.isIntersecting) && !loading && !loadingMore) {
          void loadPage(url, entries.length + 1, NEXT_PAGE, false);
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, hasMore, target, effectiveUrl, entries.length, loading, loadingMore, loadPage]);

  const groupPresets = presets.filter((p) => p.group === group);
  const active =
    groupPresets.find((p) => p.id === presetId) ?? groupPresets[0];

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAll = () =>
    setSelected(new Set(entries.map((e) => e.id)));
  const clear = () => setSelected(new Set());

  const totalSeconds = entries.reduce(
    (sum, e) => sum + (selected.has(e.id) ? (e.duration ?? 0) : 0),
    0,
  );

  const start = async () => {
    if (!target || selected.size === 0 || !active) return;
    setBusy(true);
    try {
      const options: DownloadOptions = { ...defaultOptions, maxHeight };
      const chosen = entries.filter((e) => selected.has(e.id));
      const context = {
        playlistId: target.id,
        playlistTitle: title || target.title,
        playlistUrl: target.url,
        selectionMode: "multiple" as const,
        selectionCount: chosen.length,
        selectionFingerprint: buildSelectionFingerprint(
          chosen.map((e) => e.id),
        ),
      };
      const { jobs: queued } = await api.download(
        active.id,
        options,
        chosen.map((e) => ({
          url: e.url,
          videoId: e.id,
          title: e.title,
          thumbnail: e.thumbnail,
          playlistIndex: e.index,
          playlist: { ...context, entryIndex: e.index },
        })),
      );
      if (queued?.length) {
        useAppStore.getState().upsertJobs(queued);
        for (const job of queued) claimDelivery(job.id);
      }
      toast.success(
        `Queued ${chosen.length} video${chosen.length === 1 ? "" : "s"} from ${title || target.title}.`,
      );
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start download.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent
        title={
          target
            ? `${isChannel ? "Channel" : "Playlist"} · ${title || target.title}`
            : "Videos"
        }
        className="max-w-2xl"
      >
        {!target ? null : (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">
                {entries.length > 0
                  ? `${entries.length} loaded${hasMore ? " · scroll for more" : ""}`
                  : ""}
                {totalSeconds > 0
                  ? ` · ${formatDuration(totalSeconds)} selected`
                  : ""}
              </span>
              <span className="flex shrink-0 gap-1.5">
                <button
                  type="button"
                  onClick={selectAll}
                  disabled={entries.length === 0}
                  className="cursor-pointer rounded-md px-2 py-1 font-medium text-foreground hover:bg-secondary disabled:opacity-40"
                >
                  Select all
                </button>
                <button
                  type="button"
                  onClick={clear}
                  disabled={selected.size === 0}
                  className="cursor-pointer rounded-md px-2 py-1 text-muted-foreground hover:bg-secondary hover:text-foreground disabled:opacity-40"
                >
                  Clear
                </button>
              </span>
            </div>

            <div className="max-h-[46vh] space-y-1 overflow-y-auto pr-1">
              {loading ? (
                <p className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                  <HugeiconsIcon
                    icon={Loading03Icon}
                    className="h-4 w-4 animate-spin"
                  />
                  Loading videos…
                </p>
              ) : null}
              {error && entries.length === 0 ? (
                <p className="rounded-lg border border-destructive/40 px-3 py-3 text-xs text-destructive">
                  {error}
                </p>
              ) : null}
              {!loading && !error && entries.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">
                  No readable videos here yet.
                </p>
              ) : null}
              {entries.map((e) => {
                const checked = selected.has(e.id);
                return (
                  <div
                    key={e.id}
                    onClick={() => toggle(e.id)}
                    className={cn(
                      "group flex cursor-pointer items-center gap-3 rounded-xl border px-3 py-2 transition-colors",
                      checked
                        ? "border-primary bg-secondary/70"
                        : "border-border hover:bg-secondary/40",
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(e.id)}
                      onClick={(ev) => ev.stopPropagation()}
                      aria-label={`Select ${e.title}`}
                      className="h-4 w-4 shrink-0 accent-current"
                    />
                    <img
                      src={e.thumbnail}
                      alt=""
                      loading="lazy"
                      className="h-10 w-[72px] shrink-0 rounded-md bg-secondary object-cover"
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          "block truncate text-xs",
                          checked
                            ? "text-foreground"
                            : "text-muted-foreground",
                        )}
                        title={e.title}
                      >
                        {e.index ? `${e.index}. ` : ""}
                        {e.title}
                      </span>
                      <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                        {[
                          e.duration ? formatDuration(e.duration) : null,
                          formatViews(e.viewCount),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                  </div>
                );
              })}
              <div ref={sentinelRef} aria-hidden className="h-1" />
              {loadingMore ? (
                <p className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground">
                  <HugeiconsIcon
                    icon={Loading03Icon}
                    className="h-3.5 w-3.5 animate-spin"
                  />
                  Loading more…
                </p>
              ) : null}
              {!hasMore && entries.length > 0 ? (
                <p className="py-2 text-center text-[11px] text-faint">
                  End of list — {entries.length} videos.
                </p>
              ) : null}
            </div>

            <div
              role="group"
              aria-label="Format group"
              className="inline-flex rounded-lg border border-border bg-field p-0.5"
            >
              {(["video", "audio"] as const).map((g) => (
                <button
                  key={g}
                  type="button"
                  aria-pressed={group === g}
                  onClick={() => {
                    setGroup(g);
                    const first = presets.find((p) => p.group === g);
                    if (first) setPresetId(first.id);
                  }}
                  className={
                    group === g
                      ? "rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
                      : "rounded-md px-3 py-1 text-xs text-muted-foreground hover:text-foreground"
                  }
                >
                  {g === "video" ? "Video" : "Audio"}
                </button>
              ))}
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-xs">
                <span className="mb-1 block text-muted-foreground">Format</span>
                <Select value={active?.id} onValueChange={setPresetId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Format" />
                  </SelectTrigger>
                  <SelectContent>
                    {groupPresets.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              {group === "video" ? (
                <label className="block text-xs">
                  <span className="mb-1 block text-muted-foreground">
                    Quality
                  </span>
                  <Select
                    value={maxHeight ? String(maxHeight) : "best"}
                    onValueChange={(v) =>
                      setMaxHeight(v === "best" ? undefined : Number(v))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="best">Best available</SelectItem>
                      {HEIGHTS.map((h) => (
                        <SelectItem key={h} value={String(h)}>
                          {h}p max
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
              ) : null}
            </div>

            <Button
              className="w-full"
              size="lg"
              disabled={busy || selected.size === 0}
              onClick={() => void start()}
            >
              <HugeiconsIcon icon={Download04Icon} className="mr-2 h-4 w-4" />
              {busy
                ? "Queueing…"
                : selected.size === 0
                  ? "Select videos to download"
                  : `Download ${selected.size}${active ? ` · ${active.ext.toUpperCase()}` : ""}`}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
