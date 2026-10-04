import { Hono } from "hono";
import { normalizeUrl } from "../lib/probe";
import {
  normalizePreviewQuality,
  resolvePreviewUrl,
} from "../lib/preview";
import { extractVideoId } from "../../shared/url";

export const previewRoutes = new Hono();

/**
 * In-app preview playback for videos that are NOT downloaded.
 *
 * Resolves the watch URL to a direct progressive stream with `yt-dlp -g` and
 * proxies the bytes same-origin so a native `<video>` element can play them
 * with custom controls and working seek. The expiring googlevideo URL never
 * reaches the browser.
 *
 * Progressive only (see previewFormatFor): typically <= 720p. Higher
 * resolutions are split audio/video tracks and must be downloaded.
 */
previewRoutes.get("/preview/stream", async (c) => {
  const raw = c.req.query("url") ?? "";
  const url = normalizeUrl(raw);
  if (!url || !extractVideoId(url)) {
    return c.json({ error: "Enter a valid YouTube video URL." }, 400);
  }
  const quality = normalizePreviewQuality(c.req.query("quality"));

  let direct: string;
  try {
    direct = await resolvePreviewUrl(url, quality, c.req.raw.signal);
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "Could not resolve stream." },
      502,
    );
  }

  const forward = new Headers();
  const range = c.req.header("range");
  if (range) forward.set("range", range);
  forward.set("accept", "*/*");
  forward.set("referer", "https://www.youtube.com/");
  const ua = c.req.header("user-agent");
  if (ua) forward.set("user-agent", ua);

  let upstream: Response;
  try {
    upstream = await fetch(direct, {
      headers: forward,
      signal: c.req.raw.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return c.body(null, 499 as never);
    }
    return c.json({ error: "Preview stream unavailable." }, 502);
  }

  if (!upstream.ok && upstream.status !== 206) {
    return c.json(
      { error: `Preview stream unavailable (${upstream.status}).` },
      502,
    );
  }

  const out = new Headers();
  const contentType =
    upstream.headers.get("content-type") ?? "video/mp4";
  out.set("content-type", contentType);
  for (const name of [
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
    "last-modified",
  ]) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }
  if (!out.has("accept-ranges")) out.set("accept-ranges", "bytes");
  // Signed URLs expire; never let a proxy cache serve a stale redirect body.
  out.set("cache-control", "private, no-store");

  return new Response(upstream.body, {
    status: upstream.status,
    headers: out,
  });
});
