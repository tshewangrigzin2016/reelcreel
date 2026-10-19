/**
 * End-to-end concurrency test through the REAL runner.ts + queue.ts.
 *
 * Only the yt-dlp spawn layer and the history DB are stubbed, so this exercises
 * the actual job lifecycle: startDownload -> Pool -> runOnce -> phase updates.
 * "A download is running" is measured by how many fake yt-dlp processes are
 * alive at the same instant.
 */
import { mock, spyOn } from "bun:test";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..", "..");
const SPAWN = path.join(ROOT, "server", "lib", "spawn.ts");
const DB = path.join(ROOT, "server", "lib", "db.ts");

// ---- fake yt-dlp -----------------------------------------------------------
let live = 0;
let peakLive = 0;
const liveSamples: number[] = [];

function fakeRunYtdlp(opts: {
  onLine: (line: string) => void;
  onErrLine?: (line: string) => void;
}): unknown {
  live++;
  peakLive = Math.max(peakLive, live);
  liveSamples.push(live);

  let resolveDone!: (code: number) => void;
  const done = new Promise<number>((r) => (resolveDone = r));

  (async () => {
    opts.onLine("[download] Destination: out.f137.mp4");
    await new Promise((r) => setTimeout(r, 15));
    opts.onLine("[download]  55.0% of 10.00MiB at 1.00MiB/s ETA 00:05");
    await new Promise((r) => setTimeout(r, 15));
    opts.onLine("C:\\fake\\out.mp4");
  })().then(() => {
    live--;
    resolveDone(0);
  });

  return {
    proc: {},
    done,
    cancel: async () => {},
    stderrText: () => "",
  };
}

mock.module(SPAWN, () => ({
  runYtdlp: (opts: never) => fakeRunYtdlp(opts as never),
  buildArgs: async () => [],
  isChallengeError: () => false,
  withClientFallback: (fn: (c?: string) => Promise<unknown>) => fn(),
  PLAYER_CLIENT_CHAIN: [undefined],
  stripAnsi: (s: string) => s,
}));

mock.module(DB, () => ({
  historyAdd: () => {},
  historyList: () => [],
  historyDelete: () => {},
  historyClear: () => {},
  downloadedVideoIds: () => new Set<string>(),
  getSettings: () => ({}),
  putSettings: (s: unknown) => s,
}));

// Import AFTER the mocks are registered.
const { startDownload } = await import(path.join(ROOT, "server", "lib", "runner.ts"));
const { jobStore, configurePools } = await import(path.join(ROOT, "server", "lib", "queue.ts"));

const LIMIT = 3;
const TOTAL = 10;
configurePools(4, LIMIT);

const phaseSamples: Record<string, number> = {};
const sampler = setInterval(() => {
  for (const job of jobStore.all()) {
    phaseSamples[job.phase] = (phaseSamples[job.phase] ?? 0) + 1;
  }
}, 3);

const ids: string[] = [];
for (let i = 0; i < TOTAL; i++) {
  ids.push(
    startDownload({
      url: `https://www.youtube.com/watch?v=fake${i}`,
      presetId: "mp4-h264",
      options: {
        embedThumbnail: false,
        embedMetadata: false,
        embedChapters: false,
        subtitles: false,
        subtitleLangs: "en.*",
        sponsorblock: false,
      },
      outputDir: path.join(ROOT, "dev", "scaffolding", "fake-output"),
      outputTemplate: "%(title)s.%(ext)s",
      title: `Video ${i}`,
    }),
  );
}

// Queue is populated synchronously; sample it before anything can finish.
const immediatelyActive = jobStore.all().filter((j) => j.phase === "downloading").length;
const immediatelyQueued = jobStore.all().filter((j) => j.phase === "queued").length;

await Promise.all(
  ids.map(
    (id) =>
      new Promise<void>((resolve) => {
        const unsub = jobStore.subscribe((deltas) => {
          const mine = deltas.find((d) => d.id === id);
          if (mine && (mine.phase === "done" || mine.phase === "error")) {
            unsub();
            resolve();
          }
        });
      }),
  ),
);
clearInterval(sampler);

let failures = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
};

console.log(`\nlimit=${LIMIT}, batch=${TOTAL}\n`);
check(
  `only ${LIMIT} downloads start immediately (got ${immediatelyActive})`,
  immediatelyActive === LIMIT,
);
check(
  `remaining ${TOTAL - LIMIT} sit in "queued" (got ${immediatelyQueued})`,
  immediatelyQueued === TOTAL - LIMIT,
);
check(`peak concurrent downloads === ${LIMIT} (got ${peakLive})`, peakLive === LIMIT);
check(
  `never overshoots the limit (max sample ${Math.max(...liveSamples)})`,
  Math.max(...liveSamples) <= LIMIT,
);
check(`"queued" phase observed while running`, (phaseSamples.queued ?? 0) > 0);
check(
  `all ${TOTAL} finished`,
  jobStore.all().filter((j) => j.phase === "done").length === TOTAL,
  `got ${jobStore.all().filter((j) => j.phase === "done").length}`,
);
check(`no jobs stuck queued/downloading`, jobStore.all().every((j) => j.phase === "done"));

console.log("\nlive-count samples:", liveSamples.join(","));
console.log("phase sample totals:", JSON.stringify(phaseSamples));
console.log(failures === 0 ? "\nEnd-to-end concurrency OK.\n" : `\n${failures} FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
