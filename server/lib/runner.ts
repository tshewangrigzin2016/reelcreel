import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import type {
  DownloadRequest,
  FileFingerprint,
  HistoryRow,
  JobState,
  SourceFingerprint,
} from "../../shared/types";
import { buildRequestKey, sourceFingerprintFromYtdlp } from "./fingerprint";
import {
  getSettings,
  historyAdd,
  loadJobs,
  saveJob,
  deleteSavedJob,
} from "./db";
import { conversionError, runConversion } from "./convert";
import { inspectFile } from "./ffprobe";
import { planDownload } from "./plan";
import { formatBytes, isTransientError } from "./parse";
import {
  actualExtForPreset,
  buildDownloadArgs,
  getPreset,
  needsEncoder,
} from "./presets";
import { jobStore, pools } from "./queue";
import { runYtdlp } from "./spawn";
import { ownedPath, publishFile, cleanupCompletedStage } from "./output";
import * as validate from "../../shared/validation";

const requests = new Map<string, DownloadRequest>();
const controllers = new Map<string, AbortController>();
const active = new Map<string, Promise<void>>();
const retryAt = new Map<string, number>();
const terminal = new Set(["done", "skipped", "error", "cancelled"]);
let initialized = false;
let scheduler: ReturnType<typeof setInterval> | undefined;
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

function persist(state: JobState): void {
  const req = requests.get(state.id);
  if (req) saveJob(req, state);
}
export function initializeQueue(): void {
  if (initialized) return;
  initialized = true;
  for (const { request, state } of loadJobs()) {
    requests.set(state.id, request);
    if (!terminal.has(state.phase)) {
      state.phase = "paused";
      state.recoveryNote =
        "Paused after restart. Resume continues supported partial transfers; interrupted processing restarts from retained source files.";
      state.error = undefined;
    }
    jobStore.create(state);
    saveJob(request, state);
  }
  jobStore.persist = persist;
  scheduler = setInterval(pump, 250);
  scheduler.unref();
}
function identity(req: DownloadRequest): string {
  return JSON.stringify([
    path.resolve(req.outputDir),
    req.outputTemplate,
    req.videoId || req.url,
    buildRequestKey(req.presetId, req.options),
    req.scheduledAt,
  ]);
}
export function startDownload(input: DownloadRequest): string {
  const req = {
    ...input,
    ...validate.items([
      {
        url: input.url,
        videoId: input.videoId,
        title: input.title,
        thumbnail: input.thumbnail,
        playlist: input.playlist,
        playlistIndex: input.playlistIndex,
      },
    ])[0],
    presetId: validate.presetId(input.presetId),
    options: validate.options(input.options),
    outputTemplate: validate.filenameTemplate(input.outputTemplate),
    outputDir: validate.textValue(input.outputDir, "Output folder"),
  };
  const incompatible = validate.compatibilityError(req.presetId, req.options);
  if (incompatible) throw new validate.ValidationError(incompatible);
  for (const [id, other] of requests)
    if (
      identity(req) === identity(other) &&
      !terminal.has(jobStore.get(id)?.phase ?? "error")
    )
      return id;
  const id = randomUUID();
  requests.set(id, req);
  const order = Math.max(0, ...jobStore.all().map((j) => j.order ?? 0)) + 1;
  const state: JobState = {
    id,
    videoId: req.videoId,
    title: req.title ?? req.url,
    thumbnail: req.thumbnail,
    presetId: req.presetId,
    playlistIndex: req.playlistIndex,
    playlist: req.playlist,
    phase:
      req.scheduledAt && req.scheduledAt > Date.now() ? "scheduled" : "queued",
    scheduledAt: req.scheduledAt,
    percent: 0,
    attempts: 0,
    order,
    stagingDir: path.resolve(req.outputDir, ".yt-staging", id),
  };
  try {
    saveJob(req, state);
    jobStore.create(state);
  } catch (error) {
    requests.delete(id);
    throw error;
  }
  queueMicrotask(pump);
  return id;
}
/**
 * How many jobs may be inside `execute()` at once.
 *
 * `pools.download` is the authority on *transfers*, so admission must not be
 * gated on it: a job spends most of its time in the pipeline (probing the
 * source, then verifying the output with ffprobe) rather than transferring, and
 * both of those already have their own bound. Gating admission on the transfer
 * pool meant N in-flight jobs rarely meant N real transfers -- which is exactly
 * what `downloadConcurrency` promises.
 *
 * So the pipeline gets headroom to run ahead of the transfer slots, sized to
 * the probe pool that is already holding it back. Process count stays bounded:
 * transfers cap at `pools.download`, probes and ffprobe runs at `pools.probe`,
 * and the rest of a large backlog waits in `queued`.
 */
const pipelineCap = () => pools.probe.limit + pools.download.limit;

function pump(): void {
  for (const job of jobStore.all())
    if (
      job.phase === "scheduled" &&
      (job.scheduledAt ?? Infinity) <= Date.now()
    )
      jobStore.update(job.id, { phase: "queued" });
  const queued = jobStore
    .all()
    .filter(
      (j) =>
        j.phase === "queued" &&
        !active.has(j.id) &&
        (retryAt.get(j.id) ?? 0) <= Date.now(),
    )
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const job of queued) {
    if (active.size >= pipelineCap()) break;
    const req = requests.get(job.id);
    if (!req) continue;
    const controller = new AbortController();
    controllers.set(job.id, controller);
    const pending = execute(job.id, req, controller).finally(() => {
      if (controllers.get(job.id) === controller) controllers.delete(job.id);
      active.delete(job.id);
      queueMicrotask(pump);
    });
    active.set(job.id, pending);
    void pending.catch((error) => {
      console.error("Queue persistence error:", errorText(error));
    });
  }
}
async function execute(
  id: string,
  req: DownloadRequest,
  controller: AbortController,
): Promise<void> {
  const signal = controller.signal;
  const update = (patch: Partial<JobState>) => {
    if (!signal.aborted && controllers.get(id) === controller)
      jobStore.update(id, patch);
  };
  try {
    const state = jobStore.get(id)!;
    const staging = state.stagingDir!;
    mkdirSync(staging, { recursive: true });
    // A history failure or crash after publication can be retried without copying output again.
    const receipt = path.join(staging, "completion.json");
    if (existsSync(receipt)) {
      const row = JSON.parse(readFileSync(receipt, "utf8")) as HistoryRow;
      const measured = row.filePath
        ? await inspectFile(row.filePath, signal)
        : null;
      signal.throwIfAborted();
      if (
        !measured ||
        !measured.sizeBytes ||
        (!measured.hasAudio && !measured.hasVideo)
      )
        throw new Error("Previously published output is missing or invalid.");
      historyAdd({ ...row, file: measured });
      update({
        phase: "done",
        percent: 100,
        filePath: row.filePath,
        error: undefined,
      });
      try {
        cleanupCompletedStage(req.outputDir, id);
      } catch {
        /* Retention is safer than uncertain cleanup. */
      }
      return;
    }
    update({
      phase: "probing",
      error: undefined,
      attempts: state.attempts + 1,
    });
    const settings = getSettings();
    const plan = await planDownload(req, {
      skipExisting: settings.skipExisting,
      convertInstead: settings.convertInstead,
      signal,
    });
    signal.throwIfAborted();
    update({ planNote: plan.reason, diffs: plan.diffs });
    if (plan.action === "skip") {
      update({
        phase: "skipped",
        percent: 100,
        filePath: plan.existingPath,
        reused: true,
      });
      return;
    }
    let result:
      | {
          file: string;
          source?: SourceFingerprint;
          provenance: HistoryRow["provenance"];
          reused?: boolean;
        }
      | undefined;
    if (plan.action === "convert" && plan.convertArgs && plan.convertOutPath) {
      try {
        result = await pools.ffmpeg.run(async () => {
          const dir = path.join(staging, "convert-" + randomUUID());
          mkdirSync(dir, { recursive: true });
          const output = path.join(dir, path.basename(plan.convertOutPath!));
          const args = [...plan.convertArgs!];
          args[args.length - 1] = output;
          update({ phase: "converting", percent: 0 });
          const handle = await runConversion({
            args,
            durationSec: plan.source?.durationSec,
            signal,
            onProgress: (percent) => update({ percent }),
          });
          if (signal.aborted) await handle.cancel();
          const code = await handle.done;
          signal.throwIfAborted();
          if (code !== 0) throw new Error(conversionError(handle.stderrText()));
          await verifyOutput(output, req, signal, plan.source);
          return {
            file: output,
            source: plan.source,
            provenance: plan.lossless
              ? ("lossless-copy" as const)
              : ("encoded" as const),
            reused: true,
          };
        }, signal);
      } catch (error) {
        signal.throwIfAborted();
        update({
          planNote:
            "Conversion failed; downloading a fresh copy. " + errorText(error),
        });
      }
    }
    if (!result) {
      // The pipeline runs ahead of the transfer slots (see `pipelineCap`), so
      // this job can reach the transfer with every slot taken. Say so: it is
      // waiting for a download slot, not probing anything. `downloadOnce`
      // flips the phase to "downloading" on acquisition.
      //
      // `running >= limit`, not `pending > 0`: the check and the `acquire` that
      // follows run in the same synchronous block, so this predicate is exactly
      // "acquire is about to enqueue this job". `pending` is a snapshot of
      // *other* waiters, which misses the first job to queue up and would leave
      // it mislabelled "probing" while it sat in the pool.
      if (pools.download.running >= pools.download.limit)
        update({ phase: "queued" });
      // Deliberately *not* wrapped in `pools.ffmpeg.run`. yt-dlp transfers and
      // then encodes inside one process, so a CPU gate either blocks before the
      // process spawns -- holding a slot across the whole transfer, which made
      // MP3 (the default audio preset) download strictly one at a time -- or it
      // does not gate that job at all. We choose the latter, so
      // `downloadConcurrency` is the number of real transfers for every preset.
      // `pools.ffmpeg` now bounds only the `action === "convert"` remux path
      // above and the library-sync conversions.
      result = await pools.download.run(
        () => downloadOnce(id, req, staging, signal, update),
        signal,
      );
    }
    signal.throwIfAborted();
    const stagedPath = ownedPath(staging, result.file);
    const measured = await verifyOutput(stagedPath, req, signal, result.source);
    signal.throwIfAborted();
    const final = publishFile(stagedPath, req.outputDir, id.slice(0, 8));
    const file = { ...measured, path: final };
    const row: HistoryRow = {
      id,
      url: req.url,
      videoId: result.source?.videoId ?? req.videoId ?? req.url,
      title: result.source?.title ?? req.title ?? req.url,
      uploader: result.source?.uploader,
      thumbnail: req.thumbnail,
      filePath: final,
      presetId: req.presetId,
      ext: file.ext,
      sizeBytes: file.sizeBytes,
      duration: file.durationSec,
      completedAt: Date.now(),
      requestKey: buildRequestKey(req.presetId, req.options),
      source: result.source,
      file,
      playlist: req.playlist,
      provenance: result.source ? result.provenance : "unknown",
    };
    if (req.options.subtitles && req.options.subtitleMode === "sidecar") {
      for (const name of readdirSync(path.dirname(stagedPath)))
        if (/\.(vtt|srt|ass|ttml|srv[123]|json3)$/.test(name)) {
          const stem = path.parse(stagedPath).name;
          const preferredName = name.startsWith(stem + ".")
            ? path.parse(final).name + name.slice(stem.length)
            : name;
          publishFile(
            ownedPath(staging, path.join(path.dirname(stagedPath), name)),
            req.outputDir,
            id.slice(0, 8),
            preferredName,
          );
        }
    }
    // Keep a durable receipt once all requested outputs are published, before history commit.
    writeFileSync(receipt, JSON.stringify(row));
    update({ filePath: final });
    historyAdd(row);
    update({
      phase: "done",
      percent: 100,
      filePath: final,
      size: formatBytes(file.sizeBytes!),
      reused: result.reused,
      error: undefined,
      speed: undefined,
      eta: undefined,
      postprocessor: undefined,
    });
    try {
      cleanupCompletedStage(req.outputDir, id);
    } catch {
      /* Retention is safer than uncertain cleanup. */
    }
  } catch (error) {
    if (signal.aborted) return;
    const message = errorText(error);
    const attempts = jobStore.get(id)?.attempts ?? 1;
    if (isTransientError(message) && attempts < 3) {
      retryAt.set(id, Date.now() + Math.min(2 ** attempts * 1000, 30000));
      update({ phase: "queued", error: message + " — retry scheduled." });
    } else
      update({
        phase: "error",
        error: message,
        speed: undefined,
        eta: undefined,
        postprocessor: undefined,
      });
  }
}
async function verifyOutput(
  file: string,
  req: DownloadRequest,
  signal: AbortSignal,
  source?: SourceFingerprint,
): Promise<FileFingerprint> {
  const measured = await inspectFile(file, signal);
  signal.throwIfAborted();
  const preset = getPreset(req.presetId)!;
  if (!measured?.sizeBytes || (!measured.hasVideo && !measured.hasAudio))
    throw new Error(
      "The process exited without a valid media file. Retained staging files can be retried.",
    );
  if (
    (preset.group === "video" && !measured.hasVideo) ||
    (preset.group === "audio" && !measured.hasAudio)
  )
    throw new Error("Output does not contain the requested media streams.");
  if (measured.ext !== actualExtForPreset(preset))
    throw new Error("Output container does not match the requested preset.");
  if (
    req.options.maxHeight &&
    measured.height &&
    measured.height > req.options.maxHeight
  )
    throw new Error("Output exceeds the requested resolution cap.");
  if (
    source?.durationSec &&
    measured.durationSec &&
    !req.options.sponsorblock
  ) {
    // Whole-video transfers only: the clip feature is gone, so an output that
    // does not run the length of the source is a truncated or partial file.
    const tolerance = Math.max(0.5, Math.min(2, source.durationSec * 0.01));
    if (Math.abs(measured.durationSec - source.durationSec) > tolerance)
      throw new Error(
        "Output duration does not match the source. Staging files were retained.",
      );
  }
  return measured;
}
async function downloadOnce(
  id: string,
  req: DownloadRequest,
  staging: string,
  signal: AbortSignal,
  update: (patch: Partial<JobState>) => void,
) {
  const dir = path.join(staging, "transfer");
  mkdirSync(dir, { recursive: true });
  let file: string | undefined, source: SourceFingerprint | undefined;
  const sourcePath = path.join(staging, "source.json");
  if (existsSync(sourcePath))
    source = JSON.parse(readFileSync(sourcePath, "utf8"));
  const diagnostics: string[] = [];
  update({ phase: "downloading", percent: 0 });
  const handle = await runYtdlp({
    args: buildArgsFor(req, dir),
    cwd: dir,
    signal,
    onLine: (line) => {
      if (signal.aborted) return;
      if (line.startsWith("__SOURCE__")) {
        try {
          source = sourceFingerprintFromYtdlp(
            JSON.parse(line.slice(10)),
            getPreset(req.presetId)!.group,
          );
          writeFileSync(sourcePath, JSON.stringify(source));
        } catch {}
      } else if (line.startsWith("__RESULT__")) {
        try {
          file = JSON.parse(line.slice(10));
        } catch {}
      } else if (line.startsWith("__PROGRESS__")) {
        try {
          const p = JSON.parse(line.slice(12));
          const total = p.total_bytes ?? p.total_bytes_estimate;
          update({
            phase: "downloading",
            percent:
              total > 0 ? Math.min(99, (p.downloaded_bytes / total) * 100) : 0,
            size: total ? formatBytes(total) : undefined,
            speed: p.speed ? formatBytes(p.speed) + "/s" : undefined,
            eta: p.eta ? String(Math.ceil(p.eta)) + "s" : undefined,
          });
        } catch {}
      } else if (line.startsWith("__POST__"))
        update({
          phase: "postprocessing",
          postprocessor: "Processing media",
          percent: 99,
        });
    },
    onErrLine: (line) => {
      const safe = line
        .replace(/https?:\/\/\S+/g, "[URL]")
        .replace(/(cookie|authorization)[^\n]*/gi, "[credentials omitted]");
      diagnostics.push(safe);
      if (diagnostics.length > 60) diagnostics.shift();
      update({ logs: [...diagnostics] });
    },
  });
  if (signal.aborted) await handle.cancel();
  const code = await handle.done;
  signal.throwIfAborted();
  if (code !== 0)
    throw new Error(
      diagnostics.filter((line) => /^ERROR:/i.test(line)).at(-1) ??
        "yt-dlp exited with code " + code,
    );
  if (!file)
    throw new Error(
      "yt-dlp exited successfully without reporting a final output file.",
    );
  // The only post-processing that changes the media itself. Clipping used to
  // sit here too; it no longer exists.
  const transformed = !!req.options.sponsorblock;
  return {
    file: path.resolve(dir, file),
    source,
    provenance: transformed
      ? ("transformed" as const)
      : needsEncoder(req.presetId, req.options)
        ? ("encoded" as const)
        : ("original" as const),
  };
}
export function buildArgsFor(req: DownloadRequest, dir: string): string[] {
  return [
    ...buildDownloadArgs(req.presetId, req.options),
    "-o",
    path.join(dir, req.outputTemplate),
    "--print",
    "before_dl:__SOURCE__%()j",
    "--print",
    "after_move:__RESULT__%(filepath)j",
    "--progress",
    "--progress-template",
    "download:__PROGRESS__%(progress)j",
    "--progress-template",
    "postprocess:__POST__%(progress)j",
    "--",
    req.url,
  ];
}
export function isCancelled(id: string): boolean {
  return ["cancelled", "paused"].includes(jobStore.get(id)?.phase ?? "");
}
async function stop(id: string, phase: "paused" | "cancelled"): Promise<void> {
  const job = jobStore.get(id);
  if (!job || terminal.has(job.phase)) return;
  retryAt.delete(id);
  controllers.get(id)?.abort();
  jobStore.update(id, {
    phase,
    speed: undefined,
    eta: undefined,
    postprocessor: undefined,
    recoveryNote:
      "Partial transfers are retained. Resume continues supported transfers; interrupted processing restarts.",
  });
  await active.get(id);
}
export async function cancelJob(id: string): Promise<void> {
  return stop(id, "cancelled");
}
export async function pauseJob(id: string): Promise<void> {
  return stop(id, "paused");
}
export function retryJob(id: string, override?: DownloadRequest): boolean {
  const job = jobStore.get(id);
  const req = override ?? requests.get(id);
  if (
    !job ||
    !req ||
    active.has(id) ||
    !["paused", "error", "cancelled"].includes(job.phase)
  )
    return false;
  if (override) return false; // Saved requests are authoritative; a different request is a new job.
  retryAt.delete(id);
  jobStore.update(id, {
    phase: "queued",
    attempts: 0,
    percent: 0,
    error: undefined,
    scheduledAt: undefined,
  });
  queueMicrotask(pump);
  return true;
}
export const resumeJob = retryJob;
export function reorderJobs(ids: string[]): void {
  if (new Set(ids).size !== ids.length || ids.some((id) => !jobStore.get(id)))
    throw new Error("Invalid queue order.");
  const rest = jobStore
    .all()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .filter((j) => !ids.includes(j.id))
    .map((j) => j.id);
  [...ids, ...rest].forEach((id, order) => jobStore.update(id, { order }));
}
export function removeJob(id: string): void {
  const job = jobStore.get(id);
  if (
    !job ||
    active.has(id) ||
    (!terminal.has(job.phase) && job.phase !== "paused")
  )
    return;
  deleteSavedJob(id);
  requests.delete(id);
  retryAt.delete(id);
  jobStore.delete(id);
}
export function clearFinishedJobs(): void {
  for (const job of jobStore.all())
    if (terminal.has(job.phase)) removeJob(job.id);
}
