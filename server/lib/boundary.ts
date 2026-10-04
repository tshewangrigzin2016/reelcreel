import type { MiddlewareHandler } from "hono";
import * as v from "../../shared/validation";
export const localBoundary: MiddlewareHandler = async (c, next) => {
  const rawHost = c.req.header("host") ?? new URL(c.req.url).host;
  let host: URL;
  try {
    host = new URL("http://" + rawHost);
  } catch {
    return c.json({ error: "Invalid Host." }, 403);
  }
  // Vite may choose another port when its preferred port is occupied. Trust
  // only canonical loopback hosts, then require Origin to match the complete
  // Host (including the port), so proxy requests remain same-origin.
  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(host.hostname) ||
    host.host !== rawHost.toLowerCase()
  )
    return c.json({ error: "Local Host required." }, 403);
  const origin = c.req.header("origin");
  if (origin) {
    try {
      const u = new URL(origin);
      if (
        !["http:", "https:"].includes(u.protocol) ||
        u.host !== host.host ||
        u.origin !== origin
      )
        return c.json({ error: "Same-origin requests required." }, 403);
    } catch {
      return c.json({ error: "Invalid Origin." }, 403);
    }
  }
  if (c.req.header("sec-fetch-site") === "cross-site")
    return c.json({ error: "Cross-site requests are not allowed." }, 403);
  if (["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method)) {
    if (
      c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !==
      "application/json"
    )
      return c.json({ error: "Use Content-Type: application/json." }, 415);
    const text = await c.req.text();
    if (text.length > 2000000)
      return c.json({ error: "Request too large." }, 413);
    let body: Record<string, unknown>;
    try {
      body = v.object(text ? JSON.parse(text) : {});
    } catch {
      return c.json({ error: "Invalid JSON object." }, 400);
    }
    try {
      const route = c.req.path;
      if (route === "/api/probe") v.youtubeUrl(body.url);
      // Each pasted line is validated as an individual video URL, the same rule
      // `items()` applies to a download. A batch of playlist links is rejected
      // here rather than probed 500 times over.
      if (route === "/api/probe/batch") {
        if (!Array.isArray(body.urls) || !body.urls.length)
          throw new v.ValidationError("Provide at least one URL.");
        if (body.urls.length > 500)
          throw new v.ValidationError("Provide between 1 and 500 URLs.");
        for (const url of body.urls) v.youtubeUrl(url, true);
      }
      if (
        [
          "/api/downloads",
          "/api/plan",
          "/api/plan/batch",
          "/api/sync",
          "/api/sync/start",
        ].includes(route)
      ) {
        const preset = v.presetId(body.presetId);
        const options = v.options(body.options ?? {});
        const incompatible = v.compatibilityError(preset, options);
        if (incompatible) throw new v.ValidationError(incompatible);
        if (!["/api/sync", "/api/sync/start"].includes(route)) {
          const values =
            body.items ??
            (Array.isArray(body.url)
              ? body.url.map((url) => ({ url }))
              : [body]);
          v.items(values);
        }
        if (body.outputTemplate !== undefined)
          v.filenameTemplate(body.outputTemplate);
        if (body.outputDir !== undefined)
          v.textValue(body.outputDir, "Output folder");
        if (body.scheduledAt !== undefined)
          v.integer(
            body.scheduledAt,
            "Scheduled time",
            Date.now(),
            Date.now() + 366 * 86400000,
          );
        if (
          body.historyIds !== undefined &&
          (!Array.isArray(body.historyIds) ||
            body.historyIds.length > 10000 ||
            body.historyIds.some((id) => typeof id !== "string"))
        )
          throw new v.ValidationError("Invalid history ids.");
        if (body.apply !== undefined && typeof body.apply !== "boolean")
          throw new v.ValidationError("apply must be true or false.");
      }
      if (route === "/api/settings" && c.req.method === "PUT")
        v.settingsUpdate(body);
      if (route === "/api/settings/test-binary") {
        if (!["yt-dlp", "ffmpeg", "node", "deno"].includes(String(body.name)))
          throw new v.ValidationError("Unknown binary.");
        if (body.path) v.textValue(body.path, "Binary path");
      }
      if (/\/api\/jobs\/[^/]+\/retry$/.test(route) && Object.keys(body).length)
        throw new v.ValidationError(
          "Retry uses the saved request; submit a new download to change options.",
        );
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : String(error) },
        400,
      );
    }
  }
  if (
    c.req.method === "GET" &&
    (c.req.path.startsWith("/api/probe/") || c.req.path === "/api/formats")
  ) {
    try {
      v.youtubeUrl(
        c.req.query("url"),
        c.req.path === "/api/formats" || c.req.path.endsWith("/video"),
      );
    } catch (error) {
      return c.json({ error: String(error) }, 400);
    }
  }
  await next();
};
