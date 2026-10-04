import { useEffect, useState } from "react";
import { api, libraryStreamUrl, previewStreamUrl } from "@/lib/api";
import { VideoPlayer } from "@/components/VideoPlayer";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface WatchTarget {
  title: string;
  /** YouTube watch URL used for preview streaming. */
  previewUrl: string;
  videoId?: string;
  poster?: string;
}

const QUALITIES = ["best", "720", "480", "360"] as const;

/**
 * In-app watch dialog: native `<video>` with custom controls, no new tab.
 *
 * Prefers the downloaded file when one exists on disk (`Local` source) and
 * otherwise streams a progressive preview (`Preview` source, typically
 * <= 720p). Higher quality always means downloading.
 */
export function WatchDialog({
  target,
  onClose,
}: {
  target: WatchTarget | null;
  onClose: () => void;
}) {
  const [source, setSource] = useState<"local" | "preview">("preview");
  const [localId, setLocalId] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [quality, setQuality] =
    useState<(typeof QUALITIES)[number]>("best");

  useEffect(() => {
    setSource("preview");
    setLocalId(null);
    if (!target?.videoId) return;
    const videoId = target.videoId;
    let cancelled = false;
    setChecking(true);
    api
      .libraryByVideo(videoId)
      .then((row) => {
        if (cancelled) return;
        if (row) {
          setLocalId(row.id);
          setSource("local");
        }
      })
      .catch(() => {
        /* no downloaded file: preview stays selected */
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target?.videoId, target?.previewUrl]);

  const open = target !== null;
  const src =
    target && source === "local" && localId
      ? libraryStreamUrl(localId)
      : target
        ? previewStreamUrl(target.previewUrl, quality)
        : "";

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent title={target?.title ?? "Play"} className="max-w-3xl">
        {!target ? null : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <div
                role="group"
                aria-label="Playback source"
                className="inline-flex rounded-lg border border-border bg-field p-0.5"
              >
                <button
                  type="button"
                  aria-pressed={source === "local"}
                  disabled={!localId}
                  onClick={() => setSource("local")}
                  title={localId ? "Play the downloaded file" : "No downloaded file yet"}
                  className={cn(
                    "rounded-md px-3 py-1 text-xs font-medium",
                    source === "local"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground disabled:opacity-40",
                  )}
                >
                  {checking ? "Checking…" : "Downloaded"}
                </button>
                <button
                  type="button"
                  aria-pressed={source === "preview"}
                  onClick={() => setSource("preview")}
                  title="Stream without downloading"
                  className={cn(
                    "rounded-md px-3 py-1 text-xs font-medium",
                    source === "preview"
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  Preview
                </button>
              </div>
              {source === "preview" ? (
                <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  Quality
                  <select
                    aria-label="Preview quality"
                    value={quality}
                    onChange={(e) =>
                      setQuality(e.target.value as (typeof QUALITIES)[number])
                    }
                    className="cursor-pointer rounded-md border border-border bg-field px-1.5 py-1 text-xs text-foreground"
                  >
                    {QUALITIES.map((q) => (
                      <option key={q} value={q}>
                        {q === "best" ? "Best (≤720p)" : `${q}p max`}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
            </div>

            {src ? (
              <VideoPlayer
                key={src}
                src={src}
                poster={target.poster}
                title={target.title}
                autoplay
              />
            ) : null}

            <p className="text-[11px] leading-relaxed text-faint">
              {source === "preview"
                ? "Preview streams without downloading (progressive, up to ~720p). For full quality, download the video and replay it from Downloaded."
                : "Playing the downloaded file in full quality."}{" "}
              <Button
                size="sm"
                variant="ghost"
                className="h-auto px-1 py-0 text-[11px] underline"
                onClick={onClose}
              >
                Close
              </Button>
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
