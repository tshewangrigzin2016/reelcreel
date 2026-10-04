import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface PlayerChapter {
  title: string;
  start: number;
  end: number;
}

interface Props {
  src: string;
  poster?: string;
  title?: string;
  chapters?: PlayerChapter[];
  autoplay?: boolean;
  onEnded?: () => void;
}

function fmt(t: number): string {
  if (!Number.isFinite(t) || t < 0) return "0:00";
  const s = Math.floor(t);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * Native in-app player with custom controls.
 *
 * One `<video>` element, no iframe and no new tab. The same component plays
 * both sources: `/api/library/:id/stream` for downloaded files and
 * `/api/preview/stream?url=` for not-downloaded videos.
 */
export function VideoPlayer({ src, poster, title, chapters, autoplay, onEnded }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [rate, setRate] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    setError(null);
    setTime(0);
    setPlaying(false);
  }, [src]);

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => undefined);
    else v.pause();
  }, []);

  const skip = useCallback((delta: number) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration)) return;
    v.currentTime = Math.min(Math.max(0, v.currentTime + delta), v.duration || 0);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const shell = shellRef.current;
    if (!shell) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void shell.requestFullscreen().catch(() => undefined);
  }, []);

  const togglePip = useCallback(async () => {
    const v = videoRef.current as HTMLVideoElement & {
      requestPictureInPicture?: () => Promise<unknown>;
    };
    if (!v || typeof v.requestPictureInPicture !== "function") return;
    try {
      if (document.pictureInPictureElement) await document.exitPictureInPicture();
      else await v.requestPictureInPicture();
    } catch {
      /* PiP is best-effort */
    }
  }, []);

  const activeChapter = chapters?.findIndex(
    (ch) => time >= ch.start && time < ch.end,
  );

  return (
    <div
      ref={shellRef}
      tabIndex={0}
      aria-label={title ? `Video player: ${title}` : "Video player"}
      onKeyDown={(e) => {
        if (e.key === " " || e.key.toLowerCase() === "k") {
          e.preventDefault();
          toggle();
        } else if (e.key.toLowerCase() === "j") skip(-10);
        else if (e.key.toLowerCase() === "l") skip(10);
        else if (e.key.toLowerCase() === "f") toggleFullscreen();
        else if (e.key.toLowerCase() === "m") {
          const v = videoRef.current;
          if (v) v.muted = !v.muted;
        }
      }}
      className="overflow-hidden rounded-xl border border-border bg-black"
    >
      <div className="relative">
        <video
          ref={videoRef}
          src={src}
          poster={poster}
          preload="metadata"
          playsInline
          autoPlay={autoplay}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => {
            setDuration(e.currentTarget.duration || 0);
            setError(null);
          }}
          onVolumeChange={(e) => {
            setVolume(e.currentTarget.volume);
            setMuted(e.currentTarget.muted);
          }}
          onRateChange={(e) => setRate(e.currentTarget.playbackRate)}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => setWaiting(false)}
          onCanPlay={() => setWaiting(false)}
          onError={() =>
            setError("Could not play this video. It may need downloading first.")
          }
          onEnded={() => {
            setPlaying(false);
            onEnded?.();
          }}
          className="aspect-video w-full bg-black"
        />
        {waiting && !error ? (
          <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-white/80">
            Loading…
          </span>
        ) : null}
        {error ? (
          <span role="alert" className="absolute inset-x-0 bottom-0 bg-black/80 px-4 py-2 text-xs text-white">
            {error}
          </span>
        ) : null}
      </div>

      <div className="space-y-2 bg-card px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="w-10 shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {fmt(time)}
          </span>
          <input
            type="range"
            aria-label="Seek"
            min={0}
            max={Math.max(0, duration || 0)}
            step={0.1}
            value={Math.min(time, duration || 0)}
            onChange={(e) => {
              const v = videoRef.current;
              if (v) v.currentTime = Number(e.target.value);
              setTime(Number(e.target.value));
            }}
            className="h-1 min-w-0 flex-1 cursor-pointer accent-current"
          />
          <span className="w-10 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
            {fmt(duration)}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <Button
            size="sm"
            variant="outline"
            onClick={toggle}
            aria-label={playing ? "Pause" : "Play"}
            title={playing ? "Pause (k)" : "Play (k)"}
          >
            {playing ? "❚❚" : "▶"}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => skip(-10)} title="Back 10s (j)" aria-label="Back 10 seconds">
            −10s
          </Button>
          <Button size="sm" variant="ghost" onClick={() => skip(10)} title="Forward 10s (l)" aria-label="Forward 10 seconds">
            +10s
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              const v = videoRef.current;
              if (v) v.muted = !v.muted;
            }}
            title="Mute (m)"
            aria-label={muted || volume === 0 ? "Unmute" : "Mute"}
          >
            {muted || volume === 0 ? "🔇" : "🔊"}
          </Button>
          <input
            type="range"
            aria-label="Volume"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => {
              const v = videoRef.current;
              const next = Number(e.target.value);
              if (v) {
                v.volume = next;
                v.muted = next === 0;
              }
            }}
            className="h-1 w-20 cursor-pointer accent-current"
          />
          <label className="ml-auto flex items-center gap-1 text-[11px] text-muted-foreground">
            Speed
            <select
              aria-label="Playback speed"
              value={String(rate)}
              onChange={(e) => {
                const v = videoRef.current;
                const next = Number(e.target.value);
                if (v) v.playbackRate = next;
                setRate(next);
              }}
              className="cursor-pointer rounded-md border border-border bg-field px-1.5 py-1 text-xs text-foreground"
            >
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((r) => (
                <option key={r} value={String(r)}>
                  {r}×
                </option>
              ))}
            </select>
          </label>
          {chapters && chapters.length > 0 ? (
            <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
              Chapter
              <select
                aria-label="Chapter"
                value={activeChapter != null && activeChapter >= 0 ? String(activeChapter) : ""}
                onChange={(e) => {
                  const v = videoRef.current;
                  const ch = chapters[Number(e.target.value)];
                  if (v && ch) v.currentTime = ch.start + 0.1;
                }}
                className={cn(
                  "max-w-40 cursor-pointer rounded-md border border-border bg-field px-1.5 py-1 text-xs text-foreground",
                )}
              >
                <option value="">—</option>
                {chapters.map((ch, i) => (
                  <option key={i} value={String(i)}>
                    {ch.title}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <Button size="sm" variant="ghost" onClick={() => void togglePip()} title="Picture in picture" aria-label="Picture in picture">
            PiP
          </Button>
          <Button size="sm" variant="ghost" onClick={toggleFullscreen} title="Fullscreen (f)" aria-label="Fullscreen">
            ⛶
          </Button>
        </div>
      </div>
    </div>
  );
}
