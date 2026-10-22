import { test, expect, mock } from "bun:test";
import {
  mkdirSync,
  copyFileSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import { DEFAULT_OPTIONS } from "../shared/validation";
import { managedProcess } from "../server/lib/process";
import * as db from "../server/lib/db";
import { resolveBinary } from "../server/lib/resolve-binary";
import type { DownloadRequest, DownloadPlan } from "../shared/types";
const data = process.env.YTD_DATA_DIR!;
const out = path.join(data, "media");
mkdirSync(out, { recursive: true });
const sample = path.join(data, "sample.mp4");
const ffmpeg = await resolveBinary("ffmpeg", "-version");
if (!ffmpeg) throw new Error("FFmpeg required for isolated media verification");
const make = managedProcess({
  argv: [
    ffmpeg.path,
    "-nostdin",
    "-n",
    "-f",
    "lavfi",
    "-i",
    "color=c=blue:s=160x90:r=10",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100",
    "-t",
    "1",
    "-c:v",
    "libx264",
    "-c:a",
    "aac",
    sample,
  ],
  timeoutMs: 10000,
});
if ((await make.done) !== 0) throw new Error(make.stderrText());
/**
 * A real MP3, so the encoder-preset concurrency test exercises the same
 * transfer-and-verify path a user would, rather than failing on a container
 * mismatch before it could assert anything.
 */
const audioSample = path.join(data, "sample.mp3");
const makeAudio = managedProcess({
  argv: [
    ffmpeg.path,
    "-nostdin",
    "-n",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100",
    "-t",
    "1",
    "-c:a",
    "libmp3lame",
    audioSample,
  ],
  timeoutMs: 10000,
});
if ((await makeAudio.done) !== 0) throw new Error(makeAudio.stderrText());
db.putSettings({ outputDir: out, downloadConcurrency: 1, probeConcurrency: 2 });
let mode = "complete",
  startDelay = 0,
  started = 0,
  cancelled = 0;
/**
 * Transfer accounting. `inflight` is incremented where the mock is entered --
 * which is inside the download pool, after the slot was acquired -- so `peak` is
 * the high-water mark of jobs genuinely holding a transfer slot, and nothing
 * else.
 */
let inflight = 0,
  peakTransfers = 0;
let decision: DownloadPlan = {
  action: "download",
  reason: "fixture",
  diffs: [],
};
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
mock.module("../server/lib/plan", () => ({
  planDownload: async (
    _req: DownloadRequest,
    settings: { signal?: AbortSignal },
  ) => {
    if (mode === "probe-hang")
      await new Promise<void>((_resolve, reject) =>
        settings.signal?.addEventListener(
          "abort",
          () => reject(new Error("aborted")),
          { once: true },
        ),
      );
    return decision;
  },
}));
mock.module("../server/lib/spawn", () => ({
  stripAnsi: (s: string) => s,
  explainYtDlpError: (s: string) => s,
  runYtdlp: async (opts: any) => {
    started++;
    inflight++;
    peakTransfers = Math.max(peakTransfers, inflight);
    const thisMode = mode;
    await delay(startDelay);
    let end!: (code: number) => void;
    const done = new Promise<number>((resolve) => {
      end = (code) => {
        inflight--;
        resolve(code);
      };
    });
    // Audio presets ask yt-dlp for a re-encode, so they produce a different
    // container and have to be verified against a different fixture.
    const audio = opts.args.includes("--audio-format");
    const file = path.join(
      opts.cwd,
      audio ? "identical.mp3" : "identical.mp4",
    );
    const cancel = async () => {
      cancelled++;
      end(-1);
    };
    if (thisMode === "hang") {
      writeFileSync(file + ".part", "partial");
      opts.signal?.addEventListener("abort", () => void cancel(), {
        once: true,
      });
    } else {
      if (thisMode === "transient") {
        opts.onErrLine("ERROR: HTTP Error 503 Service Unavailable");
        queueMicrotask(() => end(1));
        return { done, cancel, stderrText: () => "" };
      }
      if (thisMode !== "missing") {
        if (thisMode === "invalid") writeFileSync(file, "not media");
        else copyFileSync(audio ? audioSample : sample, file);
        opts.onLine("__RESULT__" + JSON.stringify(file));
        if (opts.args.includes("--write-subs"))
          writeFileSync(
            path.join(opts.cwd, "identical.en.vtt"),
            "WEBVTT\n\n00:00.000 --> 00:01.000\nFixture caption\n",
          );
      }
      opts.onLine(
        "__PROGRESS__" +
          JSON.stringify({ downloaded_bytes: 100, total_bytes: 100 }),
      );
      queueMicrotask(() => end(0));
    }
    return { done, cancel, stderrText: () => "" };
  },
}));
const conversion = await import("../server/lib/convert");
const realConversion = conversion.runConversion;
mock.module("../server/lib/convert", () => ({
  ...conversion,
  runConversion: async (opts: any) => {
    if (mode !== "convert-hang") return realConversion(opts);
    started++;
    await delay(startDelay);
    let end!: (n: number) => void;
    const done = new Promise<number>((r) => {
      end = r;
    });
    const cancel = async () => {
      cancelled++;
      end(-1);
    };
    opts.signal?.addEventListener("abort", () => void cancel(), { once: true });
    return { done, cancel, stderrText: () => "" };
  },
}));
const runner = await import("../server/lib/runner");
/**
 * The delivery routes mounted exactly as `server/index.ts` mounts them, so these
 * tests exercise the real path (`/api/jobs/:id/download`) rather than a shape
 * that only exists in the test.
 */
const deliveryApp = new Hono();
deliveryApp.route(
  "/api",
  (await import("../server/routes/delivery")).deliveryRoutes,
);
const { jobStore, pools, configurePools } = await import(
  "../server/lib/queue"
);
runner.initializeQueue();
let sequence = 0;
function request(): DownloadRequest {
  return {
    url: "https://youtu.be/" + String(++sequence).padStart(11, "0"),
    presetId: "mp4-h264",
    options: { ...DEFAULT_OPTIONS },
    outputDir: out,
    outputTemplate: "same.%(ext)s",
  };
}
async function until(fn: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!fn()) {
    if (Date.now() > deadline)
      throw new Error("Timed out: " + JSON.stringify(jobStore.all()));
    await delay(15);
  }
}
function reset() {
  mode = "complete";
  startDelay = 0;
  decision = { action: "download", reason: "fixture", diffs: [] };
}
/** Restore the startup defaults so one test's pool sizes cannot leak. */
const DEFAULT_POOLS = [pools.probe.limit, pools.download.limit] as const;
async function withPools(
  probe: number,
  download: number,
  fn: () => Promise<void>,
) {
  configurePools(probe, download);
  try {
    await fn();
  } finally {
    configurePools(DEFAULT_POOLS[0], DEFAULT_POOLS[1]);
  }
}

test("zero exit without output never becomes Done", async () => {
  reset();
  mode = "missing";
  const id = runner.startDownload(request());
  await until(() => jobStore.get(id)?.phase === "error");
  expect(db.historyGet(id)).toBeUndefined();
  expect(jobStore.get(id)?.error).toContain("without reporting");
});
test("invalid media fails real ffprobe inspection", async () => {
  reset();
  mode = "invalid";
  const id = runner.startDownload(request());
  await until(() => jobStore.get(id)?.phase === "error");
  expect(db.historyGet(id)).toBeUndefined();
});
test("completed output is inspected, persisted and collision safe", async () => {
  reset();
  writeFileSync(path.join(out, "identical.mp4"), "unrelated original");
  const first = runner.startDownload(request());
  const second = runner.startDownload(request());
  await until(
    () =>
      jobStore.get(first)?.phase === "done" &&
      jobStore.get(second)?.phase === "done",
  );
  expect(db.historyGet(first)?.file?.hasVideo).toBe(true);
  expect(jobStore.get(first)?.filePath).not.toBe(
    jobStore.get(second)?.filePath,
  );
  expect(readFileSync(path.join(out, "identical.mp4"), "utf8")).toBe(
    "unrelated original",
  );
  await runner.cancelJob(first);
  expect(existsSync(jobStore.get(first)!.filePath!)).toBe(true);
});
test("history failure stays visible and retry recovers published output", async () => {
  reset();
  db.getDb().exec(
    "CREATE TEMP TRIGGER fail_history BEFORE INSERT ON history BEGIN SELECT RAISE(FAIL, 'fixture history failure'); END",
  );
  const id = runner.startDownload(request());
  await until(() => jobStore.get(id)?.phase === "error");
  const output = jobStore.get(id)?.filePath;
  expect(output).toBeTruthy();
  expect(jobStore.get(id)?.error).toContain("fixture history failure");
  db.getDb().exec("DROP TRIGGER fail_history");
  await delay(20);
  expect(runner.retryJob(id)).toBe(true);
  await until(() => jobStore.get(id)?.phase === "done");
  expect(jobStore.get(id)?.filePath).toBe(output);
  expect(db.historyGet(id)).toBeTruthy();
});
test("cancel before admission never starts another process", async () => {
  reset();
  mode = "hang";
  const hold = runner.startDownload(request());
  await until(() => jobStore.get(hold)?.phase === "downloading");
  await delay(10);
  const count = started;
  const id = runner.startDownload(request());
  await runner.cancelJob(id);
  await runner.cancelJob(hold);
  await delay(30);
  expect(started).toBe(count);
  expect(jobStore.get(id)?.phase).toBe("cancelled");
  expect(pools.download.running).toBe(0);
});
test("cancel during asynchronous startup kills returned handle and ignores buffered output", async () => {
  reset();
  mode = "hang";
  startDelay = 100;
  const before = cancelled;
  const count = started;
  const id = runner.startDownload(request());
  await until(() => started > count);
  await runner.cancelJob(id);
  expect(cancelled).toBeGreaterThan(before);
  expect(jobStore.get(id)?.phase).toBe("cancelled");
  expect(pools.download.running).toBe(0);
});
test("pause retains partials and resume completes without stale updates", async () => {
  reset();
  mode = "hang";
  const id = runner.startDownload(request());
  await until(() =>
    existsSync(
      path.join(
        jobStore.get(id)!.stagingDir!,
        "transfer",
        "identical.mp4.part",
      ),
    ),
  );
  await runner.pauseJob(id);
  expect(jobStore.get(id)?.phase).toBe("paused");
  expect(
    existsSync(
      path.join(
        jobStore.get(id)!.stagingDir!,
        "transfer",
        "identical.mp4.part",
      ),
    ),
  ).toBe(true);
  mode = "complete";
  expect(runner.resumeJob(id)).toBe(true);
  await until(() => jobStore.get(id)?.phase === "done");
});
test("cancellation during probing releases the attempt", async () => {
  reset();
  mode = "probe-hang";
  const id = runner.startDownload(request());
  await until(() => jobStore.get(id)?.phase === "probing");
  await runner.cancelJob(id);
  expect(jobStore.get(id)?.phase).toBe("cancelled");
});
test("cancellation during conversion startup kills handle and releases heavy slot", async () => {
  reset();
  mode = "convert-hang";
  startDelay = 100;
  decision = {
    action: "convert",
    reason: "fixture remux",
    diffs: [],
    convertArgs: [
      "-n",
      "-i",
      sample,
      "-c",
      "copy",
      path.join(out, "converted.mp4"),
    ],
    convertOutPath: path.join(out, "converted.mp4"),
    lossless: true,
  };
  const before = cancelled,
    count = started;
  const id = runner.startDownload(request());
  await until(() => started > count);
  await runner.cancelJob(id);
  expect(cancelled).toBeGreaterThan(before);
  expect(pools.ffmpeg.running).toBe(0);
});
test("restart restores unfinished requests paused, retaining order and staging", async () => {
  reset();
  const req = request();
  req.scheduledAt = Date.now() + 86400000;
  const id = runner.startDownload(req);
  const second = runner.startDownload({
    ...request(),
    scheduledAt: req.scheduledAt,
  });
  runner.reorderJobs([second, id]);
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      'import {initializeQueue} from "./server/lib/runner"; import {jobStore} from "./server/lib/queue"; initializeQueue(); console.log(JSON.stringify(jobStore.all()));',
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, YTD_DATA_DIR: data },
    },
  );
  const [text, error, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  expect(code, error).toBe(0);
  const jobs = JSON.parse(text);
  expect(jobs.find((j: any) => j.id === id).phase).toBe("paused");
  expect(jobs.find((j: any) => j.id === second).order).toBe(0);
  expect(jobs.find((j: any) => j.id === id).stagingDir).toContain(id);
  await runner.cancelJob(id);
  await runner.cancelJob(second);
});

test("sidecar captions follow collision-safe media names and completed staging is cleaned", async () => {
  reset();
  const req = request();
  req.options = { ...req.options, subtitles: true, subtitleMode: "sidecar" };
  const id = runner.startDownload(req);
  await until(() => jobStore.get(id)?.phase === "done");
  const job = jobStore.get(id)!;
  const parsed = path.parse(job.filePath!);
  expect(existsSync(path.join(parsed.dir, parsed.name + ".en.vtt"))).toBe(true);
  expect(existsSync(job.stagingDir!)).toBe(false);
  expect(readFileSync(path.join(out, "identical.mp4"), "utf8")).toBe(
    "unrelated original",
  );
});

test("cancelled retry never wakes later", async () => {
  reset();
  mode = "transient";
  const id = runner.startDownload(request());
  await until(
    () =>
      jobStore.get(id)?.phase === "queued" && jobStore.get(id)?.attempts === 1,
  );
  await runner.cancelJob(id);
  const count = started;
  await delay(2200);
  expect(jobStore.get(id)?.phase).toBe("cancelled");
  expect(started).toBe(count);
});

/*
 * The invariant that was silently broken: `downloadConcurrency` is a promise
 * about real, simultaneous transfers, and admission used to be gated on the
 * same pool while each job also spent its slot probing and verifying. These
 * tests hold a transfer slot open with a delay and watch the high-water mark.
 */

test(
  "peak concurrent transfers equal the download limit for a remux preset",
  async () => {
    reset();
    peakTransfers = 0;
    const ids: string[] = [];
    await withPools(2, 2, async () => {
      // Long enough that the admitted jobs overlap rather than finishing
      // serially, and short enough that the whole batch lands well inside the
      // test budget.
      startDelay = 120;
      for (let i = 0; i < 4; i++) ids.push(runner.startDownload(request()));
      // Drain rather than poll for the peak: on a regression the peak simply
      // never reaches the limit, so waiting for it would hang instead of
      // reporting what actually happened.
      await until(() => ids.every((id) => jobStore.get(id)?.phase === "done"));
      expect(peakTransfers).toBe(2);
      for (const id of ids) runner.removeJob(id);
    });
  },
  20000,
);

test(
  "an encoder preset reaches the same transfer concurrency as a remux one",
  async () => {
    reset();
    peakTransfers = 0;
    const ids: string[] = [];
    await withPools(2, 2, async () => {
      // mp3-320 is the default audio preset and re-encodes inside yt-dlp.
      // While the ffmpeg pool gated the whole transfer this was pinned to 1 no
      // matter what "Concurrent downloads" said.
      startDelay = 120;
      for (let i = 0; i < 4; i++)
        ids.push(runner.startDownload({ ...request(), presetId: "mp3-320" }));
      await until(() => ids.every((id) => jobStore.get(id)?.phase === "done"));
      expect(peakTransfers).toBe(2);
      for (const id of ids) runner.removeJob(id);
    });
  },
  20000,
);

test(
  "a job parked on the download pool reports queued, not probing",
  async () => {
    reset();
    const ids: string[] = [];
    await withPools(2, 2, async () => {
      startDelay = 400;
      for (let i = 0; i < 4; i++) ids.push(runner.startDownload(request()));
      // Sampled over a fixed window rather than awaited on, so a regression
      // reports a failed assertion instead of a timeout. Independent of how
      // many transfers happen to be saturated: what matters is only that a job
      // waiting for a slot never claims to be probing.
      let sawQueued = false;
      let sawProbingBesideTransferring = false;
      const deadline = Date.now() + 2500;
      while (Date.now() < deadline) {
        const phases = ids.map((id) => jobStore.get(id)?.phase);
        if (phases.includes("queued")) sawQueued = true;
        if (phases.includes("downloading") && phases.includes("probing"))
          sawProbingBesideTransferring = true;
        if (ids.every((id) => jobStore.get(id)?.phase === "done")) break;
        await delay(10);
      }
      expect(sawQueued).toBe(true);
      expect(sawProbingBesideTransferring).toBe(false);
      for (const id of ids) await runner.cancelJob(id);
    });
  },
  20000,
);

/**
 * Browser delivery, end to end against the real runner.
 *
 * This is the test that proves the feature's central promise: a finished job
 * lands in the temp directory rather than a media collection, its bytes can be
 * fetched over HTTP, and the server copy is gone once they have been. Everything
 * else in this suite runs in server mode, which is what keeps the local
 * behaviour honest.
 */
test(
  "browser mode delivers the bytes and then deletes the server copy",
  async () => {
    reset();
    const tempDir = path.join(data, "temp-media");
    mkdirSync(tempDir, { recursive: true });
    db.putSettings({ deliveryMode: "browser", tempDir });
    try {
      const id = runner.startDownload(request());
      await until(() => jobStore.get(id)?.phase === "done");

      const job = jobStore.get(id)!;
      expect(job.delivery?.state).toBe("pending");
      expect(job.delivery?.files.length).toBe(1);

      const delivered = job.delivery!.files[0]!;
      // The runner redirected the job into the temp directory even though the
      // request asked for the media folder: browser mode must not depend on a
      // caller remembering to pass the right directory.
      const tempRoot = path.dirname(path.dirname(job.stagingDir!));
      expect(path.resolve(tempRoot)).toBe(path.resolve(tempDir));
      const onDisk = path.join(tempRoot, delivered.name);
      // It landed in the temp directory...
      expect(existsSync(onDisk)).toBe(true);
      // ...and the job says so, rather than pointing into the media folder.
      expect(path.resolve(job.filePath!)).toBe(path.resolve(onDisk));

      const response = await deliveryApp.request(
        `http://localhost/api/jobs/${id}/download?file=0`,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toContain(
        "attachment",
      );
      expect(response.headers.get("content-type")).toBe("video/mp4");
      // Consuming the body is what completes the delivery.
      const bytes = await response.arrayBuffer();
      expect(bytes.byteLength).toBe(delivered.sizeBytes);

      await until(() => jobStore.get(id)?.delivery?.state === "delivered");
      expect(existsSync(onDisk)).toBe(false);
      // Staging goes with it: nothing about this job survives.
      expect(existsSync(jobStore.get(id)!.stagingDir!)).toBe(false);
      // History survives as a record even though the file does not.
      expect(db.historyGet(id)?.delivery?.state).toBe("delivered");
    } finally {
      db.putSettings({ deliveryMode: "server" });
    }
  },
  20000,
);

test(
  "browser mode refuses a second fetch once the file is gone",
  async () => {
    reset();
    const tempDir = path.join(data, "temp-media");
    mkdirSync(tempDir, { recursive: true });
    db.putSettings({ deliveryMode: "browser", tempDir });
    try {
      const id = runner.startDownload(request());
      await until(() => jobStore.get(id)?.phase === "done");
      const first = await deliveryApp.request(
        `http://localhost/api/jobs/${id}/download?file=0`,
      );
      await first.arrayBuffer();
      await until(() => jobStore.get(id)?.delivery?.state === "delivered");

      // A refresh of the download page must not resurrect a deleted file, and
      // the status code tells the client to stop retrying.
      const second = await deliveryApp.request(
        `http://localhost/api/jobs/${id}/download?file=0`,
      );
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({ deliveryState: "delivered" });
    } finally {
      db.putSettings({ deliveryMode: "server" });
    }
  },
  20000,
);

test(
  "a ranged request does not burn a delivery attempt",
  async () => {
    reset();
    const tempDir = path.join(data, "temp-media");
    mkdirSync(tempDir, { recursive: true });
    db.putSettings({ deliveryMode: "browser", tempDir });
    try {
      const id = runner.startDownload(request());
      await until(() => jobStore.get(id)?.phase === "done");
      const size = jobStore.get(id)!.delivery!.files[0]!.sizeBytes;

      // A partial range is a resume, not a failure: counting it would let three
      // resumed chunks delete a file nobody ever failed to fetch.
      const ranged = await deliveryApp.request(
        `http://localhost/api/jobs/${id}/download?file=0`,
        { headers: { range: `bytes=0-99` } },
      );
      expect(ranged.status).toBe(206);
      expect(ranged.headers.get("content-range")).toBe(
        `bytes 0-99/${size}`,
      );
      await ranged.arrayBuffer();
      expect(jobStore.get(id)?.delivery?.state).not.toBe("expired");
      expect(jobStore.get(id)?.delivery?.attempts).toBe(0);

      // An unsatisfiable range is a 416, not a 200 with the whole file.
      const bad = await deliveryApp.request(
        `http://localhost/api/jobs/${id}/download?file=0`,
        { headers: { range: `bytes=${size + 10}-` } },
      );
      expect(bad.status).toBe(416);
    } finally {
      db.putSettings({ deliveryMode: "server" });
    }
  },
  20000,
);

test(
  "server mode has no download route at all",
  async () => {
    reset();
    db.putSettings({ deliveryMode: "server" });
    const id = runner.startDownload(request());
    await until(() => jobStore.get(id)?.phase === "done");
    const response = await deliveryApp.request(
      `http://localhost/api/jobs/${id}/download?file=0`,
    );
    // Nothing to deliver: the file is the user's, sitting in the output folder.
    expect(response.status).toBe(404);
    expect(jobStore.get(id)?.delivery).toBeUndefined();
  },
  20000,
);
