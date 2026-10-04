import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { existsSync, unlinkSync, statSync } from "node:fs";
import path from "node:path";
import * as v from "../../shared/validation";
import type { FormatDiscovery, DownloadProfile } from "../../shared/types";
import {
  libraryPage,
  historyGet,
  getSettings,
  profiles,
  saveProfile,
  deleteProfile,
} from "../lib/db";
import { runYtdlp } from "../lib/spawn";
import { publish } from "../lib/events";
import { inspectFile } from "../lib/ffprobe";
import { compareFile } from "../lib/fingerprint";
import { startSync, getSync, cancelSync, applySync } from "../lib/sync";
export const libraryRoutes = new Hono();
libraryRoutes.get("/library", (c) => {
  const page = v.integer(Number(c.req.query("page") ?? 1), "Page", 1, 1000000);
  const pageSize = v.integer(
    Number(c.req.query("pageSize") ?? 40),
    "Page size",
    1,
    200,
  );
  return c.json(
    libraryPage(
      c.req.query("q") ?? "",
      c.req.query("preset") ?? "",
      page,
      pageSize,
    ),
  );
});
libraryRoutes.post("/library/:id/open", async (c) => {
  const row = historyGet(c.req.param("id"));
  if (!row?.filePath || !existsSync(row.filePath))
    return c.json({ error: "Media file is missing." }, 404);
  const body = v.object(await c.req.json());
  const file = path.resolve(row.filePath);
  if (!/\.(mp4|mkv|webm|m4a|mp3|flac|opus)$/i.test(file))
    return c.json({ error: "Unsupported media file." }, 400);
  const reveal = body.reveal === true;
  const argv =
    process.platform === "win32"
      ? ["explorer.exe", ...(reveal ? ["/select,", file] : [file])]
      : process.platform === "darwin"
        ? ["open", ...(reveal ? ["-R"] : []), file]
        : ["xdg-open", reveal ? path.dirname(file) : file];
  Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
  return c.json({ ok: true });
});
libraryRoutes.delete("/library/:id/media", async (c) => {
  const row = historyGet(c.req.param("id"));
  if (!row?.filePath || !existsSync(row.filePath))
    return c.json({ error: "Media file is missing." }, 404);
  if (
    !row.file ||
    row.file.path !== row.filePath ||
    row.file.sizeBytes !== statSync(row.filePath).size
  )
    return c.json(
      {
        error:
          "This file changed or is unverified; inspect it before deleting it outside the app.",
      },
      409,
    );
  const current = await inspectFile(row.filePath, c.req.raw.signal);
  if (!current || !compareFile(row.file, current).equal)
    return c.json(
      {
        error:
          "Media attributes changed since this download was recorded. The file was not deleted.",
      },
      409,
    );
  unlinkSync(row.filePath);
  publish({ type: "library" });
  return c.json({ ok: true });
});
libraryRoutes.get("/formats", async (c) => {
  const url = v.youtubeUrl(c.req.query("url"), true);
  let raw: Record<string, any> = {};
  const handle = await runYtdlp({
    args: ["--dump-json", "--skip-download", "--no-playlist", "--", url],
    signal: c.req.raw.signal,
    timeoutMs: 90000,
    withFfmpegLocation: false,
    onLine: (line) => {
      if (line.startsWith("{")) raw = JSON.parse(line);
    },
  });
  if ((await handle.done) !== 0)
    return c.json({ error: "Could not discover source formats." }, 502);
  const result: FormatDiscovery = {
    formats: (raw.formats ?? []).map((f: any) => ({
      id: String(f.format_id),
      ext: f.ext,
      width: f.width,
      height: f.height,
      fps: f.fps,
      vcodec: f.vcodec,
      acodec: f.acodec,
      hdr: f.dynamic_range,
      language: f.language,
      size: f.filesize ?? f.filesize_approx,
      estimated: !f.filesize,
    })),
    subtitles: Object.keys(raw.subtitles ?? {}),
    automaticCaptions: Object.keys(raw.automatic_captions ?? {}),
    chapters: (raw.chapters ?? []).map((chapter: any) => ({
      title: chapter.title,
      start: chapter.start_time,
      end: chapter.end_time,
    })),
  };
  return c.json(result);
});
libraryRoutes.get("/profiles", (c) => c.json(profiles()));
libraryRoutes.post("/profiles", async (c) => {
  const raw = v.object(await c.req.json());
  const profile: DownloadProfile = {
    id: typeof raw.id === "string" ? raw.id : randomUUID(),
    name: v.textValue(raw.name, "Profile name", 80),
    presetId: v.presetId(raw.presetId),
    options: v.options(raw.options),
  };
  if (raw.outputDir)
    profile.outputDir = v.textValue(raw.outputDir, "Output folder");
  if (raw.outputTemplate)
    profile.outputTemplate = v.filenameTemplate(raw.outputTemplate);
  saveProfile(profile);
  return c.json(profile);
});
libraryRoutes.delete("/profiles/:id", (c) => {
  deleteProfile(c.req.param("id"));
  return c.json({ ok: true });
});
libraryRoutes.post("/sync/start", async (c) => {
  const raw = v.object(await c.req.json());
  return c.json(
    startSync({
      presetId: v.presetId(raw.presetId),
      options: v.options(raw.options),
      historyIds: raw.historyIds as string[] | undefined,
    }),
  );
});
libraryRoutes.get("/sync/:id", (c) => {
  const task = getSync(c.req.param("id"));
  return task ? c.json(task) : c.json({ error: "Check not found." }, 404);
});
libraryRoutes.post("/sync/:id/cancel", (c) => {
  cancelSync(c.req.param("id"));
  return c.json({ ok: true });
});
libraryRoutes.post("/sync/:id/apply", (c) =>
  c.json({ queued: applySync(c.req.param("id")) }),
);
