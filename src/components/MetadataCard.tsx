import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Clock01Icon, EyeIcon, RadioIcon } from "@hugeicons/core-free-icons";
import type { VideoMeta } from "@shared/types";
import {
  formatDate,
  formatDuration,
  formatViews,
  thumbnailFor,
} from "@shared/format";
import { Badge } from "@/components/ui/badge";

export function MetadataCard({ video }: { video: VideoMeta }) {
  const [expanded, setExpanded] = useState(false);
  const [thumbFailed, setThumbFailed] = useState(false);

  const meta = [
    formatViews(video.viewCount),
    video.uploadDate ? formatDate(video.uploadDate) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <>
      <div className="relative">
        {!thumbFailed ? (
          <img
            src={thumbnailFor(video.id, "hq")}
            alt=""
            loading="lazy"
            onError={() => setThumbFailed(true)}
            className="h-44 w-full object-cover sm:h-56"
          />
        ) : (
          <div className="flex h-44 w-full items-center justify-center bg-secondary text-xs text-muted-foreground sm:h-56">
            No thumbnail
          </div>
        )}
        {typeof video.duration === "number" ? (
          <span className="absolute bottom-3 right-3 rounded bg-black/80 px-1.5 py-0.5 text-[11px] font-medium text-white">
            {formatDuration(video.duration)}
          </span>
        ) : null}
      </div>

      <div className="p-5">
        <h2 className="text-[15px] font-medium leading-snug text-foreground">
          {video.title}
        </h2>

        <p className="mt-1 text-xs text-muted-foreground">
          {video.uploader ? (
            <>
              <span className="text-foreground/80">{video.uploader}</span>
              {meta ? " · " : ""}
            </>
          ) : null}
          {meta}
        </p>

        <div className="mt-3 flex flex-wrap gap-1.5">
          {video.isLive ? (
            <Badge variant="destructive">
              <HugeiconsIcon icon={RadioIcon} className="mr-1 h-3 w-3" />
              {video.liveStatus === "is_upcoming"
                ? "Upcoming premiere"
                : "Live stream"}
            </Badge>
          ) : null}
          {video.duration ? (
            <Badge variant="outline">
              <HugeiconsIcon icon={Clock01Icon} className="mr-1 h-3 w-3" />
              {formatDuration(video.duration)}
            </Badge>
          ) : null}
          {video.viewCount ? (
            <Badge variant="outline">
              <HugeiconsIcon icon={EyeIcon} className="mr-1 h-3 w-3" />
              {formatViews(video.viewCount)}
            </Badge>
          ) : null}
        </div>

        {video.description ? (
          <div className="pt-4">
            <p
              className={`whitespace-pre-line text-xs leading-relaxed text-muted-foreground ${
                expanded ? "" : "line-clamp-3"
              }`}
            >
              {video.description}
            </p>
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="mt-1.5 cursor-pointer text-xs text-foreground underline-offset-4 hover:underline"
            >
              {expanded ? "Show less" : "Show more"}
            </button>
          </div>
        ) : null}
      </div>
    </>
  );
}
