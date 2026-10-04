import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import {
  mkdirSync,
  readdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { Hono } from "hono";
import * as v from "../shared/validation";
import { normalizeUrl } from "../shared/url";
import { buildRequestKey } from "../shared/request-key";
import { localBoundary } from "../server/lib/boundary";
import { Pool } from "../server/lib/queue";
import { SharedWork } from "../server/lib/shared-work";
import { managedProcess } from "../server/lib/process";
import { publishFile, ownedPath } from "../server/lib/output";
import {
  buildDownloadArgs,
  getPreset,
  buildSourceArgs,
} from "../server/lib/presets";
const data = process.env.YTD_DATA_DIR!;
const legacy = new Database(path.join(data, "yt-downloader.db"));
legacy.exec(
  "CREATE TABLE history (id TEXT PRIMARY KEY, video_id TEXT NOT NULL, title TEXT NOT NULL, uploader TEXT, thumbnail TEXT, file_path TEXT, preset_id TEXT, ext TEXT, size_bytes INTEGER, duration INTEGER, completed_at INTEGER NOT NULL)",
);
legacy.exec(
  "INSERT INTO history (id,video_id,title,completed_at) VALUES ('legacy','abcdefghijk','Original row',1)",
);
legacy.close();
const db = await import("../server/lib/db");
const pause = (n: number) => new Promise((resolve) => setTimeout(resolve, n));

test("additive migration backs up a legacy database and preserves unknown provenance", () => {
  expect(db.historyGet("legacy")?.title).toBe("Original row");
  expect(db.historyGet("legacy")?.provenance).toBe("unknown");
  const backups = readdirSync(data).filter(
    (name) => name.startsWith("before-v1-") && name.endsWith(".db"),
  );
  expect(backups.length).toBe(1);
  const backup = new Database(path.join(data, backups[0]), { readonly: true });
  expect(backup.query("SELECT title FROM history").get()).toEqual({
    title: "Original row",
  });
  backup.close();
});
test("settings defaults, overrides, explicit clears and storage failures", () => {
  const settings = db.putSettings({});
  expect(settings.conversionConcurrency).toBe(1);
  expect(db.putSettings({ ytdlpPath: "C:/tools/yt-dlp.exe" }).ytdlpPath).toBe(
    "C:/tools/yt-dlp.exe",
  );
  expect(
    db.putSettings({ ytdlpPath: null, ffmpegPath: null, cookiesPath: null })
      .ytdlpPath,
  ).toBeUndefined();
  db.getDb().exec("PRAGMA query_only = ON");
  expect(() => db.putSettings({ playlistCap: 333 })).toThrow();
  expect(() =>
    db.historyAdd({
      id: "failure",
      videoId: "abcdefghijk",
      title: "No write",
      presetId: "mkv-max",
      completedAt: 1,
    }),
  ).toThrow();
  db.getDb().exec("PRAGMA query_only = OFF");
});
test("245 library records remain searchable and traversable", () => {
  db.historyClear();
  for (let i = 0; i < 245; i++)
    db.historyAdd({
      id: "row" + i,
      videoId: String(i).padStart(11, "0"),
      title: "Fixture " + i,
      presetId: i % 2 ? "mp4-h264" : "mkv-max",
      completedAt: i,
    });
  const seen = new Set<string>();
  for (let page = 1; page <= 7; page++)
    for (const row of db.libraryPage("", "", page, 40).rows) seen.add(row.id);
  expect(seen.size).toBe(245);
  expect(db.historyRowsFor().length).toBe(245);
  expect(db.historyList().length).toBe(200);
  expect(db.libraryPage("Fixture 244").total).toBe(1);
  expect(db.libraryPage("", "mkv-max").total).toBe(123);
});
test("URL, preset, option and clip validation reject malformed input", () => {
  for (const url of [
    "garbage",
    "https://youtube.com.evil.test/watch?v=abcdefghijk",
    "https://evil.test/?v=abcdefghijk",
    "file:///a",
    "https://user@youtube.com/watch?v=abcdefghijk",
    "https://youtube.com:123/watch?v=abcdefghijk",
  ])
    expect(normalizeUrl(url)).toBeNull();
  expect(v.youtubeUrl("https://youtu.be/abcdefghijk?si=xyz", true)).toBe(
    "https://www.youtube.com/watch?v=abcdefghijk",
  );
  expect(() => v.presetId("unknown")).toThrow();
  expect(() => v.options({ maxHeight: 99999 })).toThrow();
  expect(() => v.options({ embedThumbnail: "true" })).toThrow();
  // The clip feature is gone, so its keys are unknown options now, not values.
  expect(() => v.options({ clipStart: "0", clipEnd: "10" })).toThrow();
  expect(() => v.options({ rateLimit: "5M" })).toThrow();
  expect(() => v.options({ fragmentConcurrency: 8 })).toThrow();
  expect(() =>
    v.items([{ url: "https://youtu.be/abcdefghijk", videoId: "zzzzzzzzzzz" }]),
  ).toThrow();
  expect(() => v.filenameTemplate("../outside.%(ext)s")).toThrow();
});
test("local boundary preserves proxy/CLI and rejects hostile origins before handler", async () => {
  const app = new Hono();
  let reached = 0;
  app.use("/api/*", localBoundary);
  app.post("/api/downloads", (c) => {
    reached++;
    return c.json({ ok: true });
  });
  const body = JSON.stringify({
    presetId: "mp4-h264",
    items: [{ url: "https://youtu.be/abcdefghijk" }],
  });
  for (const headers of [
    { host: "evil.test", "content-type": "application/json" },
    {
      host: "localhost:8787",
      origin: "https://evil.test",
      "content-type": "application/json",
    },
    { host: "localhost:8787", "content-type": "text/plain" },
  ])
    expect(
      (
        await app.request("http://localhost:8787/api/downloads", {
          method: "POST",
          headers: headers as Record<string, string>,
          body,
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
  expect(reached).toBe(0);
  for (const port of ["8787", "5173"])
    expect(
      (
        await app.request("http://localhost:" + port + "/api/downloads", {
          method: "POST",
          headers: {
            host: "localhost:" + port,
            origin: "http://localhost:" + port,
            "content-type": "application/json",
          },
          body,
        })
      ).status,
    ).toBe(200);
  expect(
    (
      await app.request("http://localhost:8787/api/downloads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      })
    ).status,
  ).toBe(200);
  const invalid = JSON.stringify({
    presetId: "mp4-h264",
    items: [{ url: "https://youtu.be/abcdefghijk" }, { url: "bad" }],
  });
  expect(
    (
      await app.request("http://localhost:8787/api/downloads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: invalid,
      })
    ).status,
  ).toBe(400);
  expect(reached).toBe(3);
});
test("pool limits, cancellation while queued, raising, lowering and release after error", async () => {
  const pool = new Pool(1);
  const release = await pool.acquire();
  const controller = new AbortController();
  const queued = pool.run(async () => 42, controller.signal);
  controller.abort();
  await expect(queued).rejects.toThrow();
  expect(pool.pending).toBe(0);
  release();
  let active = 0,
    peak = 0;
  const runs = Array.from({ length: 15 }, (_, i) =>
    pool.run(async () => {
      active++;
      peak = Math.max(peak, active);
      try {
        await pause(8);
        if (i === 3) throw new Error("fixture");
      } finally {
        active--;
      }
    }),
  );
  pool.setLimit(3);
  await pause(3);
  expect(pool.running).toBe(3);
  pool.setLimit(1);
  await Promise.allSettled(runs);
  expect(peak).toBeLessThanOrEqual(3);
  expect(pool.running).toBe(0);
  expect(pool.pending).toBe(0);
});
test("shared work cancels one subscriber without stopping another", async () => {
  const work = new SharedWork<number>();
  let calls = 0;
  const a = new AbortController();
  const run = async (signal: AbortSignal) => {
    calls++;
    await pause(20);
    signal.throwIfAborted();
    return 7;
  };
  const first = work.run("same", run, a.signal);
  const second = work.run("same", run);
  a.abort();
  await expect(first).rejects.toThrow();
  expect(await second).toBe(7);
  expect(calls).toBe(1);
});
test("hung subprocess is killed at its deadline while streams are open", async () => {
  const began = Date.now();
  const handle = managedProcess({
    argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
    timeoutMs: 100,
  });
  expect(await handle.done).not.toBe(0);
  expect(Date.now() - began).toBeLessThan(5000);
  expect(handle.stderrText()).toContain("timed out");
});
test("exclusive publication protects identical names and rejects outside paths", () => {
  const root = path.join(data, "stage");
  const out = path.join(data, "out");
  mkdirSync(root, { recursive: true });
  mkdirSync(out, { recursive: true });
  const media = path.join(root, "same.mp4");
  writeFileSync(media, "new");
  writeFileSync(path.join(out, "same.mp4"), "original");
  const first = publishFile(ownedPath(root, media), out, "a");
  const second = publishFile(media, out, "b");
  expect(first).not.toBe(second);
  expect(readFileSync(path.join(out, "same.mp4"), "utf8")).toBe("original");
  expect(() => ownedPath(root, first)).toThrow();
});
test("format contracts and request identity include output choices", () => {
  expect(getPreset("opus")?.ext).toBe("webm");
  expect(buildDownloadArgs("m4a", v.DEFAULT_OPTIONS)).toContain(
    "ba[acodec^=mp4a][ext=m4a]",
  );
  expect(
    buildSourceArgs(getPreset("mp4-h264")!, {
      ...v.DEFAULT_OPTIONS,
      maxHeight: 720,
    }).join(" "),
  ).toContain("height<=720");
  const base = buildRequestKey("mp4-h264", v.DEFAULT_OPTIONS);
  for (const options of [{ maxHeight: 720 }, { audioLanguage: "en" }])
    expect(
      buildRequestKey("mp4-h264", { ...v.DEFAULT_OPTIONS, ...options }),
    ).not.toBe(base);
});

test("installed yt-dlp honors resolution, preferred language and native container selection offline", async () => {
  const { resolveBinary } = await import("../server/lib/resolve-binary");
  const binary = await resolveBinary("yt-dlp");
  if (!binary)
    throw new Error("yt-dlp required for format contract verification");
  const fixture = path.join(data, "formats.info.json");
  const formats = [
    {
      format_id: "video720",
      ext: "mp4",
      vcodec: "avc1.640028",
      acodec: "none",
      width: 1280,
      height: 720,
      fps: 30,
      tbr: 2000,
    },
    {
      format_id: "video1080",
      ext: "mp4",
      vcodec: "avc1.640028",
      acodec: "none",
      width: 1920,
      height: 1080,
      fps: 30,
      tbr: 4000,
    },
    {
      format_id: "vp9",
      ext: "webm",
      vcodec: "vp9",
      acodec: "none",
      width: 1920,
      height: 1080,
      fps: 30,
      tbr: 3000,
    },
    {
      format_id: "aac-en",
      ext: "m4a",
      vcodec: "none",
      acodec: "mp4a.40.2",
      language: "en",
      abr: 128,
      tbr: 128,
    },
    {
      format_id: "aac-fr",
      ext: "m4a",
      vcodec: "none",
      acodec: "mp4a.40.2",
      language: "fr",
      abr: 192,
      tbr: 192,
    },
    {
      format_id: "audio-opus",
      ext: "webm",
      vcodec: "none",
      acodec: "opus",
      language: "en",
      abr: 160,
      tbr: 160,
    },
  ].map((format) => ({
    ...format,
    url: "https://example.invalid/" + format.format_id,
  }));
  writeFileSync(
    fixture,
    JSON.stringify({
      id: "abcdefghijk",
      title: "Offline fixture",
      extractor: "youtube",
      webpage_url: "https://www.youtube.com/watch?v=abcdefghijk",
      duration: 10,
      formats,
    }),
  );
  for (const [preset, options, selected] of [
    ["mp4-h264", { maxHeight: 720, audioLanguage: "en" }, "video720+aac-en"],
    ["m4a", { audioLanguage: "fr" }, "aac-fr"],
    ["opus", {}, "audio-opus"],
    ["webm", {}, "vp9+audio-opus"],
  ] as const) {
    let output = "";
    const handle = managedProcess({
      argv: [
        binary.path,
        "--ignore-config",
        "--no-js-runtimes",
        "--simulate",
        "--load-info-json",
        fixture,
        ...buildSourceArgs(getPreset(preset)!, {
          ...v.DEFAULT_OPTIONS,
          ...options,
        }),
        "--print",
        "%(format_id)s",
      ],
      onLine: (line) => {
        output += line;
      },
      timeoutMs: 10000,
    });
    expect(await handle.done, handle.stderrText()).toBe(0);
    expect(output).toBe(selected);
  }
}, 30000);
test("full download arguments isolate configuration, runtime and playlist URL", async () => {
  const { buildArgs } = await import("../server/lib/spawn");
  const { buildArgsFor } = await import("../server/lib/runner");
  const url = "https://www.youtube.com/watch?v=abcdefghijk&list=PLtest";
  const args = await buildArgs({
    args: buildArgsFor(
      {
        url,
        presetId: "mp4-h264",
        options: v.DEFAULT_OPTIONS,
        outputDir: data,
        outputTemplate: "same.%(ext)s",
      },
      data,
    ),
    onLine: () => {},
  });
  expect(args).toContain("--ignore-config");
  expect(args).toContain("--no-playlist");
  expect(args).toContain("--no-js-runtimes");
  expect(args.at(-2)).toBe("--");
  expect(args.at(-1)).toBe(url);
  expect(args[args.indexOf("--js-runtimes") + 1]).toMatch(/^node:.+/);
});

test("queue persistence failures are broadcast as visible errors", async () => {
  const { JobStore } = await import("../server/lib/queue");
  const store = new JobStore();
  store.create({
    id: "persist",
    title: "Fixture",
    phase: "queued",
    percent: 0,
    attempts: 0,
    presetId: "mp4-h264",
  });
  let observed = "";
  store.subscribe((jobs) => {
    observed = jobs[0]?.error ?? "";
  });
  store.persist = () => {
    throw new Error("disk full");
  };
  expect(() => store.update("persist", { phase: "downloading" })).toThrow();
  expect(store.get("persist")?.phase).toBe("error");
  expect(observed).toContain("disk full");
});
test("real yt-dlp emits structured source, progress and final output against local sample media", async () => {
  const { resolveBinary } = await import("../server/lib/resolve-binary");
  const { buildArgsFor } = await import("../server/lib/runner");
  const { runYtdlp } = await import("../server/lib/spawn");
  const { inspectFile } = await import("../server/lib/ffprobe");
  const ffmpeg = await resolveBinary("ffmpeg", "-version");
  if (!ffmpeg) throw new Error("FFmpeg missing");
  const sample = path.join(data, "local-sample.mp4");
  const generated = managedProcess({
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
  expect(await generated.done, generated.stderrText()).toBe(0);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(Bun.file(sample)),
  });
  try {
    const info = path.join(data, "local-source.info.json");
    const url = "http://127.0.0.1:" + server.port + "/sample.mp4";
    writeFileSync(
      info,
      JSON.stringify({
        id: "abcdefghijk",
        title: "Local transfer fixture",
        extractor: "generic",
        extractor_key: "Generic",
        webpage_url: url,
        duration: 1,
        formats: [
          {
            format_id: "18",
            url,
            ext: "mp4",
            vcodec: "avc1.640028",
            acodec: "mp4a.40.2",
            width: 160,
            height: 90,
            fps: 10,
          },
        ],
      }),
    );
    const output = path.join(data, "actual-transfer");
    mkdirSync(output, { recursive: true });
    const args = buildArgsFor(
      {
        url: "https://youtu.be/abcdefghijk",
        presetId: "mp4-h264",
        options: v.DEFAULT_OPTIONS,
        outputDir: output,
        outputTemplate: "sample.%(ext)s",
      },
      output,
    );
    args.splice(-2, 2, "--load-info-json", info);
    const lines: string[] = [];
    const handle = await runYtdlp({
      args,
      onLine: (line) => lines.push(line),
      cwd: output,
      timeoutMs: 15000,
    });
    expect(await handle.done, handle.stderrText()).toBe(0);
    expect(lines.some((line) => line.startsWith("__SOURCE__"))).toBe(true);
    expect(lines.some((line) => line.startsWith("__PROGRESS__"))).toBe(true);
    const result = lines.find((line) => line.startsWith("__RESULT__"));
    expect(result).toBeTruthy();
    const measured = await inspectFile(JSON.parse(result!.slice(10)));
    expect(measured?.hasVideo).toBe(true);
    expect(measured?.hasAudio).toBe(true);
  } finally {
    server.stop(true);
  }
}, 25000);
