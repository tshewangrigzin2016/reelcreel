import { useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  ImageOffIcon,
  ListVideoIcon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import type { PlaylistPreview } from "@shared/types";
import { formatDuration } from "@shared/format";

/**
 * Compact confirmation strip shown under the URL field as soon as a pasted link
 * is recognised as a playlist. It renders from the *first entry only*, so it
 * lands in about a second instead of waiting for the whole list to enumerate.
 */
export function PlaylistPreviewCard({
  preview,
  pending,
}: {
  preview: PlaylistPreview | null;
  pending: boolean;
}) {
  const [thumbFailed, setThumbFailed] = useState(false);
  const entry = preview?.entry;

  const meta = [
    preview?.entryCount ? `${preview.entryCount} videos` : null,
    typeof entry?.duration === "number" ? formatDuration(entry.duration) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="mt-3 flex items-center gap-3 rounded-xl border border-border bg-card p-2">
      <div className="relative h-[54px] w-24 shrink-0 overflow-hidden rounded-lg bg-secondary">
        {pending && !entry ? (
          <div className="flex h-full w-full items-center justify-center">
            <HugeiconsIcon
              icon={Loading03Icon}
              className="h-4 w-4 animate-spin text-faint"
            />
          </div>
        ) : entry && !thumbFailed ? (
          <img
            src={entry.thumbnail}
            alt=""
            className="h-full w-full object-cover"
            onError={() => setThumbFailed(true)}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-faint">
            <HugeiconsIcon icon={ImageOffIcon} className="h-4 w-4" />
          </div>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <p className="micro flex items-center gap-1">
          <HugeiconsIcon icon={ListVideoIcon} className="h-3 w-3" />
          {preview?.radio ? "Mix · first video" : "Playlist · first video"}
        </p>
        <p className="mt-0.5 truncate text-sm font-medium" title={entry?.title}>
          {entry ? entry.title : "Reading playlist…"}
        </p>
        <p
          className="truncate text-[11px] text-faint"
          title={preview?.playlistTitle}
        >
          {meta || preview?.playlistTitle || " "}
        </p>
      </div>
    </div>
  );
}
