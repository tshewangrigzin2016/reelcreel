import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatBytes } from "@shared/format";
import { api } from "@/lib/api";
import { Button } from "./ui/button";

/**
 * What the site actually offers for the loaded video.
 *
 * Deliberately a disclosure inside the format card rather than its own panel:
 * it is a diagnostic *about* the format, and a separate menu meant the answer
 * was one click and a scroll away from the choice it explains.
 *
 * Costs a full yt-dlp enumeration, so it stays opt-in.
 */
export function SourceFormats({ url }: { url: string }) {
  const [discover, setDiscover] = useState(false);
  const catalog = useQuery({
    queryKey: ["formats", url],
    queryFn: ({ signal }) => api.formats(url, signal),
    enabled: !!url && discover,
    staleTime: 60000,
  });

  return (
    <details className="border-t border-border px-5 py-4">
      <summary className="cursor-pointer text-sm font-medium">
        Source formats and captions
      </summary>
      <div className="mt-3 space-y-3">
        {url ? (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDiscover(true)}
                disabled={catalog.isFetching}
              >
                {catalog.isFetching ? "Reading source…" : "Discover source formats"}
              </Button>
              <p className="text-[11px] text-faint">
                MP4 compatibility depends on the playback device. WebM uses
                VP8/VP9/AV1 video and Opus/Vorbis audio. Native audio retains the
                source bitrate.
              </p>
            </div>

            {catalog.error ? (
              <p role="alert" className="text-xs text-destructive">
                {catalog.error.message}
              </p>
            ) : null}
          </>
        ) : (
          // Rendered anyway so the panel is discoverable before anything is
          // probed, rather than appearing only once it is too late to look.
          <p className="text-xs text-muted-foreground">
            Load a single video to inspect the formats and captions its source
            actually offers.
          </p>
        )}

        {catalog.data ? (
          <>
            <p className="text-xs text-muted-foreground">
              Manual captions: {catalog.data.subtitles.join(", ") || "none"}.
              Automatic captions:{" "}
              {catalog.data.automaticCaptions.join(", ") || "none"}.
            </p>
            <div className="max-h-60 overflow-auto">
              <table className="w-full text-left text-xs">
                <caption className="sr-only">
                  Formats offered by this source
                </caption>
                <thead>
                  <tr>
                    {["Resolution", "Codecs", "FPS / HDR", "Language", "Size"].map(
                      (h) => (
                        <th className="p-2" key={h}>
                          {h}
                        </th>
                      ),
                    )}
                  </tr>
                </thead>
                <tbody>
                  {catalog.data.formats.map((f, i) => (
                    <tr key={f.id + i}>
                      <td className="p-2">
                        {f.height ? f.height + "p" : f.vcodec === "none" ? "Audio" : "Image"}
                      </td>
                      <td>
                        {f.vcodec} / {f.acodec} · {f.ext}
                      </td>
                      <td>
                        {f.fps ?? "—"} / {f.hdr ?? "—"}
                      </td>
                      <td>{f.language ?? "—"}</td>
                      <td>
                        {f.size
                          ? (f.estimated ? "≈ " : "") + formatBytes(f.size)
                          : "Unknown"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        ) : null}
      </div>
    </details>
  );
}
