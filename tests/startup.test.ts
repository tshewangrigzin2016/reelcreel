import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { localBoundary } from "../server/lib/boundary";

const boundary = new Hono();
boundary.use("/api/*", localBoundary);
boundary.all("/api/check", (c) => c.json({ ok: true }));

test("loopback proxy requests work on Vite fallback and custom ports", async () => {
  for (const hostname of ["localhost", "127.0.0.1", "[::1]"]) {
    for (const port of [5173, 5174, 5175, 8787, 18787]) {
      const host = `${hostname}:${port}`;
      for (const method of ["GET", "POST"]) {
        for (const browser of [false, true]) {
          const response = await boundary.request("http://127.0.0.1:8787/api/check", {
            method,
            headers: {
              host,
              ...(browser ? { origin: `http://${host}`, "sec-fetch-site": "same-origin" } : {}),
              ...(method === "POST" ? { "content-type": "application/json" } : {}),
            },
            ...(method === "POST" ? { body: "{}" } : {}),
          });
          expect(response.status).toBe(200);
        }
      }
    }
  }
});

test("alternate ports still reject hostile hosts, origins and cross-site requests", async () => {
  const requests: Record<string, string>[] = [
    { host: "evil.test:5174" },
    { host: "localhost.evil.test:5174" },
    { host: "user@localhost:5174" },
    { host: "localhost:5174/" },
    { host: "localhost:65536" },
    { host: "localhost:5174", origin: "http://localhost:5173" },
    { host: "localhost:5174", origin: "http://127.0.0.1:5174" },
    { host: "localhost:5174", origin: "https://evil.test" },
    { host: "localhost:5174", origin: "null" },
    { host: "localhost:5174", origin: "http://localhost:5174/" },
    { host: "localhost:5174", "sec-fetch-site": "cross-site" },
  ];
  for (const headers of requests) {
    for (const method of ["GET", "POST"]) {
      const response = await boundary.request("http://127.0.0.1:8787/api/check", {
        method,
        headers: { ...headers, "content-type": "application/json" },
        ...(method === "POST" ? { body: "{}" } : {}),
      });
      expect(response.status).toBe(403);
    }
  }
});

test("batch probe accepts a list of individual video URLs", async () => {
  // The boundary validates by path, so the route has to be registered under its
  // real name rather than the catch-all used above.
  const batchRoute = new Hono();
  batchRoute.use("/api/*", localBoundary);
  batchRoute.all("/api/probe/batch", (c) => c.json({ ok: true }));

  const post = (body: unknown) =>
    batchRoute.request("http://127.0.0.1:8787/api/probe/batch", {
      method: "POST",
      headers: { host: "127.0.0.1:8787", "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  // Both URL shapes and a bare id are accepted, and normalised by the route.
  expect(
    (
      await post({
        urls: [
          "https://youtu.be/abcdefghijk",
          "https://www.youtube.com/watch?v=klkjk12345A&t=30",
          "lkjh098765B",
        ],
      })
    ).status,
  ).toBe(200);

  // A playlist link is not an individual video. Accepting one here would probe
  // it repeatedly and produce an entry that is not what the line said.
  for (const urls of [
    ["https://www.youtube.com/playlist?list=PL1234567890"],
    ["https://youtu.be/abcdefghijk", "https://www.youtube.com/playlist?list=PL1234567890"],
    ["not-a-url"],
    [],
    "https://youtu.be/abcdefghijk",
    // Over the server's own 500-item ceiling.
    Array.from({ length: 501 }, () => "https://youtu.be/abcdefghijk"),
  ]) {
    const response = await post({ urls });
    expect(response.status).toBe(400);
  }
});

for (const script of ["dev:api", "dev", "start"]) {  test(`${script} rejects an occupied API port without opening the database`, async () => {
    const existing = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("existing process"),
    });
    const data = mkdtempSync(path.join(tmpdir(), "yt-startup-"));
    const proc = Bun.spawn([process.execPath, "run", script], {
      env: { ...process.env, PORT: String(existing.port), YTD_DATA_DIR: data, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(async () => {
      timedOut = true;
      if (process.platform === "win32") {
        await Bun.spawn(["taskkill", "/PID", String(proc.pid), "/T", "/F"], {
          stdout: "ignore", stderr: "ignore",
        }).exited;
      } else proc.kill();
    }, 15000);
    try {
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(timedOut).toBe(false);
      expect(code).not.toBe(0);
      expect(out + err).toContain(`API port ${existing.port} is already in use`);
      expect(out + err).not.toContain("API listening");
      expect(existsSync(path.join(data, "yt-downloader.db"))).toBe(false);
      expect(await (await fetch(existing.url)).text()).toBe("existing process");
    } finally {
      clearTimeout(timer);
      await existing.stop(true);
    }
  }, 25000);
}
