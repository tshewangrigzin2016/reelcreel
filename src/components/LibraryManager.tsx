import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import type { DownloadOptions, Preset } from "@shared/types";
import { api } from "@/lib/api";
import { libraryChanged } from "@/lib/query";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Card } from "./ui/card";
export function LibraryManager({
  presetId,
  options,
  presets,
}: {
  presetId: string;
  options: DownloadOptions;
  presets: Preset[];
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("");
  const [page, setPage] = useState(1);
  const [syncId, setSyncId] = useState<string | null>(null);
  const library = useQuery({
    queryKey: ["library", query, filter, page],
    queryFn: () => api.library(query, filter, page),
  });
  const sync = useQuery({
    queryKey: ["sync", syncId],
    queryFn: () => api.syncStatus(syncId!),
    enabled: !!syncId,
    refetchInterval: (q) => (q.state.data?.state === "running" ? 750 : false),
  });
  const attempt = async (work: Promise<unknown>) => {
    try {
      await work;
      libraryChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  };
  const task = sync.data;
  const result = task?.result;
  return (
    <section className="space-y-4">
      <h2 className="text-lg font-medium">Library</h2>
      <div className="flex flex-wrap gap-2">
        <Input
          aria-label="Search library"
          placeholder="Search title or video ID"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPage(1);
          }}
        />
        <select
          aria-label="Filter library format"
          className="rounded border border-border bg-field p-2 text-sm"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value);
            setPage(1);
          }}
        >
          <option value="">All formats</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </div>
      <Button
        variant="outline"
        disabled={task?.state === "running"}
        onClick={() =>
          void api
            .startSync(presetId, options)
            .then((t) => setSyncId(t.id))
            .catch((error) => toast.error(error.message))
        }
      >
        Preview library updates
      </Button>
      {task ? (
        <Card className="space-y-2 p-4">
          <p role="status" className="text-sm">
            {task.state === "running"
              ? "Checking library"
              : "Library check " + task.state}
            : {task.checked} of {task.total}
          </p>
          {task.state === "running" ? (
            <Button
              size="sm"
              variant="outline"
              onClick={() => void attempt(api.cancelSync(task.id))}
            >
              Cancel check
            </Button>
          ) : null}
          {result ? (
            <>
              <p className="text-xs">
                {result.counts.skip} unchanged · {result.counts.download}{" "}
                downloads · {result.counts.convert} conversions ·{" "}
                {result.failed} failed · {result.unchecked} unchecked ·{" "}
                {result.queued} queued
              </p>
              <Button
                size="sm"
                disabled={
                  !!task.applied ||
                  result.counts.download + result.counts.convert === 0
                }
                onClick={() =>
                  void api
                    .applySync(task.id)
                    .then((r) => {
                      toast.success("Queued " + r.queued + " updates.");
                      void sync.refetch();
                    })
                    .catch((error) => toast.error(error.message))
                }
              >
                Apply verified updates
              </Button>
              <details className="text-xs">
                <summary>Review checked entries</summary>
                <ul className="mt-2 max-h-64 overflow-auto">
                  {result.entries.map((e) => (
                    <li key={e.historyId} className="py-1">
                      {e.title}: {e.error ?? e.reason}
                    </li>
                  ))}
                </ul>
              </details>
            </>
          ) : null}
          {task.error ? <p role="alert">{task.error}</p> : null}
        </Card>
      ) : null}
      {library.error ? <p role="alert">{library.error.message}</p> : null}
      {library.isPending ? <p role="status">Loading library…</p> : null}
      {library.data?.rows.map((row) => (
        <Card key={row.id} className="space-y-2 p-4">
          <h3 className="text-sm font-medium">{row.title}</h3>
          <p className="text-xs text-muted-foreground">
            {row.ext?.toUpperCase()} ·{" "}
            {new Date(row.completedAt).toLocaleDateString()} ·{" "}
            {row.missing ? "Missing file" : "On disk"} ·{" "}
            {row.provenance === "unknown" || !row.source
              ? "Unverified source"
              : row.provenance}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={row.missing}
              onClick={() => void attempt(api.openFile(row.id))}
            >
              Open
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={row.missing}
              onClick={() => void attempt(api.openFile(row.id, true))}
            >
              Reveal
            </Button>
            {row.url ? (
              <a
                className="p-2 text-xs underline"
                href={row.url}
                target="_blank"
                rel="noreferrer"
              >
                Source
              </a>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void attempt(api.deleteHistory(row.id))}
            >
              Remove history record
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={row.missing || !row.file}
              onClick={() => {
                if (
                  window.confirm(
                    "Delete this media file from disk? This cannot be undone.\n" +
                      row.filePath,
                  )
                )
                  void attempt(api.deleteMedia(row.id));
              }}
            >
              Delete media
            </Button>
          </div>
        </Card>
      ))}
      <div className="flex items-center justify-between">
        <Button
          size="sm"
          variant="outline"
          disabled={page <= 1}
          onClick={() => setPage((p) => p - 1)}
        >
          Previous
        </Button>
        <span className="text-xs">
          Page {page} · {library.data?.total ?? 0} records
        </span>
        <Button
          size="sm"
          variant="outline"
          disabled={
            !library.data || page * library.data.pageSize >= library.data.total
          }
          onClick={() => setPage((p) => p + 1)}
        >
          Next
        </Button>
      </div>
    </section>
  );
}
