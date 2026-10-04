import { randomUUID } from "node:crypto";
import type {
  DownloadOptions,
  DownloadRequest,
  HistoryRow,
  SyncEntry,
  SyncResult,
  SyncTask,
} from "../../shared/types";
import { normalizeUrl } from "../../shared/url";
import { getSettings, historyRowsFor } from "./db";
import { planDownload, type PlanSettings } from "./plan";
import { jobStore, pools } from "./queue";
import { startDownload } from "./runner";
export interface SyncInput {
  presetId: string;
  options: DownloadOptions;
  historyIds?: string[];
  apply?: boolean;
}
function enqueue(request: DownloadRequest): {
  jobId: string;
  created: boolean;
} {
  const existing = new Set(jobStore.all().map((job) => job.id));
  const jobId = startDownload(request);
  return { jobId, created: !existing.has(jobId) };
}
function requestFor(row: HistoryRow, input: SyncInput): DownloadRequest | null {
  const settings = getSettings();
  const url = normalizeUrl(row.url ?? row.videoId);
  if (!url) return null;
  return {
    url,
    videoId: row.videoId,
    title: row.title,
    thumbnail: row.thumbnail,
    presetId: input.presetId,
    options: input.options,
    outputDir: settings.outputDir,
    outputTemplate: settings.outputTemplate,
    playlist: row.playlist,
  };
}
export async function syncLibrary(
  input: SyncInput,
  settings: PlanSettings,
  progress?: (checked: number, total: number) => void,
): Promise<SyncResult> {
  const rows = [
    ...new Map(
      historyRowsFor(input.historyIds)
        .reverse()
        .map((row) => [row.videoId, row]),
    ).values(),
  ].reverse();
  const deadline = AbortSignal.timeout(5 * 60 * 1000);
  const signal = settings.signal
    ? AbortSignal.any([settings.signal, deadline])
    : deadline;
  const entries: SyncEntry[] = [];
  const counts = { download: 0, skip: 0, convert: 0, error: 0 };
  let index = 0,
    checked = 0,
    queued = 0;
  progress?.(0, rows.length);
  const worker = async () => {
    while (index < rows.length && !signal.aborted) {
      const row = rows[index++];
      const base = {
        historyId: row.id,
        videoId: row.videoId,
        title: row.title,
      };
      try {
        const request = requestFor(row, input);
        if (!request) throw new Error("missing-url");
        const plan = await planDownload(request, { ...settings, signal });
        signal.throwIfAborted();
        let jobId: string | undefined;
        let reason = plan.reason;
        if (input.apply && plan.action !== "skip") {
          const result = enqueue(request);
          jobId = result.jobId;
          if (result.created) queued++;
          else reason = "Already being downloaded.";
        }
        counts[plan.action]++;
        checked++;
        entries.push({
          ...base,
          action: plan.action,
          reason,
          diffs: plan.diffs,
          existingPath: plan.existingPath,
          jobId,
        });
      } catch (error) {
        if (signal.aborted) break;
        counts.error++;
        checked++;
        entries.push({
          ...base,
          action: "download",
          reason: "Could not verify this entry.",
          diffs: [],
          error: error instanceof Error ? error.message : String(error),
        });
      }
      progress?.(checked, rows.length);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(pools.probe.limit, rows.length) }, worker),
  );
  return {
    entries,
    counts,
    queued,
    checked,
    unchecked: rows.length - checked,
    failed: counts.error,
    total: rows.length,
    truncated: checked < rows.length,
  };
}
const tasks = new Map<
  string,
  { task: SyncTask; input: SyncInput; controller: AbortController }
>();
export function startSync(input: SyncInput): SyncTask {
  if ([...tasks.values()].some((value) => value.task.state === "running"))
    throw new Error("A library check is already running.");
  while (tasks.size >= 20) tasks.delete(tasks.keys().next().value!);
  const controller = new AbortController();
  const task: SyncTask = {
    id: randomUUID(),
    state: "running",
    checked: 0,
    total: 0,
  };
  tasks.set(task.id, { task, input, controller });
  const settings = getSettings();
  void syncLibrary(
    { ...input, apply: false },
    {
      skipExisting: settings.skipExisting,
      convertInstead: settings.convertInstead,
      signal: controller.signal,
    },
    (checked, total) => {
      task.checked = checked;
      task.total = total;
    },
  ).then(
    (result) => {
      task.result = result;
      task.state = controller.signal.aborted ? "cancelled" : "done";
    },
    (error) => {
      task.state = "error";
      task.error = String(error);
    },
  );
  return task;
}
export function getSync(id: string): SyncTask | undefined {
  return tasks.get(id)?.task;
}
export function cancelSync(id: string): void {
  tasks.get(id)?.controller.abort();
}
export function applySync(id: string): number {
  const saved = tasks.get(id);
  if (!saved?.task.result || saved.task.state === "running")
    throw new Error("Wait for the preview before applying updates.");
  if (saved.task.applied) return saved.task.result.queued;
  const entries = saved.task.result.entries.filter(
    (entry) => entry.action !== "skip" && !entry.error && !entry.jobId,
  );
  const ids = entries.map((entry) => entry.historyId);
  const rows = new Map(
    (ids.length ? historyRowsFor(ids) : []).map((row) => [row.id, row]),
  );
  for (const entry of entries) {
    const row = rows.get(entry.historyId);
    if (!row) continue;
    const request = requestFor(row, saved.input);
    if (request) {
      const result = enqueue(request);
      entry.jobId = result.jobId;
      if (result.created) saved.task.result.queued++;
    }
  }
  saved.task.applied = true;
  return saved.task.result.queued;
}
