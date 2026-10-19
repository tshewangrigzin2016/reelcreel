import { useEffect, useState } from "react";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Download04Icon } from "@hugeicons/core-free-icons";
import type {
  DownloadOptions,
  Preset,
  SearchResult,
} from "@shared/types";
import { formatDuration, formatViews } from "@shared/format";
import { api } from "@/lib/api";
import { useAppStore } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";

const HEIGHTS = [2160, 1440, 1080, 720, 480, 360];

interface Props {
  result: SearchResult | null;
  presets: Preset[];
  defaultPresetId: string;
  defaultOptions: DownloadOptions;
  onClose: () => void;
}

/**
 * Compact download popup for Explore.
 *
 * Same engine as the rest of the app (POST /api/downloads with preset +
 * options + items) — only the picker is minimal: Video/Audio toggle, format,
 * and quality cap. Channels/playlists cannot be queued directly.
 */
export function DownloadDialog({
  result,
  presets,
  defaultPresetId,
  defaultOptions,
  onClose,
}: Props) {
  const [group, setGroup] = useState<"video" | "audio">("video");
  const [presetId, setPresetId] = useState(defaultPresetId);
  const [maxHeight, setMaxHeight] = useState<number | undefined>(
    defaultOptions.maxHeight,
  );
  const [busy, setBusy] = useState(false);

  // Resync compact picker each time a new result is picked (or global defaults
  // change while closed) so the popup never queues with a stale preset.
  useEffect(() => {
    if (result) {
      setPresetId(defaultPresetId);
      setMaxHeight(defaultOptions.maxHeight);
      setGroup("video");
    }
  }, [result?.id, defaultPresetId, defaultOptions.maxHeight]);

  const groupPresets = presets.filter((p) => p.group === group);
  const active =
    groupPresets.find((p) => p.id === presetId) ?? groupPresets[0];

  const open = result !== null;
  const downloadable =
    result && (result.kind === "video" || result.kind === "short" || result.kind === "live");

  const start = async () => {
    if (!result || !downloadable || !active) return;
    setBusy(true);
    try {
      const options: DownloadOptions = { ...defaultOptions, maxHeight };
      const { jobs: queued } = await api.download(active.id, options, [
        {
          url: result.url,
          videoId:
            result.id.startsWith("channel-") || result.kind === "channel" || result.kind === "playlist"
              ? undefined
              : result.id,
          title: result.title,
          thumbnail: result.thumbnail,
        },
      ]);
      if (queued?.length) useAppStore.getState().upsertJobs(queued);
      toast.success(`Queued “${result.title.slice(0, 60)}”.`);
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not start download.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent title="Download">
        {!result ? null : (
          <div className="space-y-4">
            <div className="flex gap-3">
              <img
                src={result.thumbnail}
                alt=""
                className="h-16 w-28 shrink-0 rounded-lg bg-secondary object-cover"
                loading="lazy"
              />
              <div className="min-w-0">
                <p className="line-clamp-2 text-sm font-medium leading-snug">
                  {result.title}
                </p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {[result.channel, result.duration ? formatDuration(result.duration) : null, formatViews(result.viewCount)]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
                <div className="mt-1.5 flex gap-1.5">
                  <Badge variant="outline">{result.kind}</Badge>
                  {active ? <Badge variant="outline">{active.ext.toUpperCase()}</Badge> : null}
                </div>
              </div>
            </div>

            {!downloadable ? (
              <p className="rounded-lg bg-secondary/60 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
                {result.kind === "channel"
                  ? "Channels can't be downloaded directly — use View channel in Explore and pick videos."
                  : "Playlists can't be queued from here yet — use View playlist in Explore or paste the playlist URL in Download instead."}{" "}
                <a
                  href={result.url}
                  target="_blank"
                  rel="noreferrer"
                  className="underline"
                >
                  Open on YouTube
                </a>
              </p>
            ) : (
              <>
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
                      <span className="mb-1 block text-muted-foreground">Quality</span>
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

                <Button className="w-full" size="lg" disabled={busy} onClick={() => void start()}>
                  <HugeiconsIcon icon={Download04Icon} className="mr-2 h-4 w-4" />
                  {busy ? "Queueing…" : `Download${active ? ` · ${active.ext.toUpperCase()}` : ""}`}
                </Button>
              </>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
