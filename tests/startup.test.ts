import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { localBoundary } from "../server/lib/boundary";
import { configurationError, publicOrigin } from "../server/lib/listen";

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

/**
 * Public mode: the deployment configuration this feature exists for.
 *
 * Loopback and public mode answer different questions, and the loopback
 * assertions above must keep passing unchanged -- that is the proof the local
 * behaviour was not traded away. What is tested here is the other half: once
 * the process is bound off-loopback, the allowlist becomes "Origin must be
 * exactly PUBLIC_ORIGIN", which is a stricter rule, not a looser one.
 */
const PUBLIC = "https://reel.example.com";

async function withPublicMode<T>(
  origin: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const previousHost = process.env.HOST;
  const previousOrigin = process.env.PUBLIC_ORIGIN;
  process.env.HOST = "0.0.0.0";
  if (origin === undefined) delete process.env.PUBLIC_ORIGIN;
  else process.env.PUBLIC_ORIGIN = origin;
  try {
    return await fn();
  } finally {
    if (previousHost === undefined) delete process.env.HOST;
    else process.env.HOST = previousHost;
    if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousOrigin;
  }
}

const check = (headers: Record<string, string>) =>
  boundary.request("http://127.0.0.1:8787/api/check", {
    method: "GET",
    headers,
  });

test("public mode accepts the configured origin and bare CLI clients", async () => {
  await withPublicMode(PUBLIC, async () => {
    const host = new URL(PUBLIC).host;
    // A browser on the real site.
    expect(
      (
        await check({
          host,
          origin: PUBLIC,
          "sec-fetch-site": "same-origin",
        })
      ).status,
    ).toBe(200);
    // A script or curl: no Origin at all. It cannot be made to issue a
    // cross-site request, so there is nothing to defend against.
    expect((await check({ host })).status).toBe(200);
  });
});

test("public mode trusts X-Forwarded-Host only with TRUST_PROXY", async () => {
  await withPublicMode(PUBLIC, async () => {
    const host = new URL(PUBLIC).host;
    const proxied = {
      host: "10.0.0.5:5173",
      "x-forwarded-host": host,
      origin: PUBLIC,
    };
    delete process.env.TRUST_PROXY;
    // A managed ingress that rewrites Host is not trusted by default: any
    // client can send X-Forwarded-Host.
    expect((await check(proxied)).status).toBe(403);
    process.env.TRUST_PROXY = "1";
    try {
      expect((await check(proxied)).status).toBe(200);
      // Even with TRUST_PROXY, the forwarded host must still be the configured
      // origin; it is not a way to bypass the check.
      expect(
        (await check({ ...proxied, "x-forwarded-host": "evil.test" })).status,
      ).toBe(403);
      // A direct request without the header keeps working.
      expect((await check({ host })).status).toBe(200);
    } finally {
      delete process.env.TRUST_PROXY;
    }
  });
});

test("public mode still rejects everything cross-origin", async () => {
  await withPublicMode(PUBLIC, async () => {
    const host = new URL(PUBLIC).host;
    const hostile: Record<string, string>[] = [
      // The whole point: another site driving this API on a visitor's behalf.
      { host, origin: "https://evil.test" },
      { host, origin: "http://reel.example.com" },
      { host, origin: `${PUBLIC}/` },
      { host, origin: "null" },
      // A Host that does not match PUBLIC_ORIGIN, which is what a
      // misconfigured reverse proxy would produce.
      { host: "localhost:8787", origin: PUBLIC },
      { host: "evil.test", origin: "https://evil.test" },
      { host, "sec-fetch-site": "cross-site" },
    ];
    for (const headers of hostile) expect((await check(headers)).status).toBe(403);
  });
});

test("public mode refuses to start without a usable PUBLIC_ORIGIN", async () => {
  // Bound off-loopback with nothing to compare against: the only way to stay
  // safe would be to drop the Origin check entirely, so it must not boot.
  await withPublicMode(undefined, async () => {
    expect(configurationError()).toContain("PUBLIC_ORIGIN is not set");
  });
  await withPublicMode("https://reel.example.com/path", async () => {
    expect(configurationError()).toContain("not a valid origin");
  });
  await withPublicMode("reel.example.com", async () => {
    expect(configurationError()).toContain("not a valid origin");
  });
  await withPublicMode(PUBLIC, async () => {
    expect(configurationError()).toBeNull();
  });
});

test("loopback mode needs no PUBLIC_ORIGIN and ignores it", async () => {
  await withPublicMode(PUBLIC, async () => {
    delete process.env.HOST;
    expect(configurationError()).toBeNull();
    // Loopback rules still apply even though PUBLIC_ORIGIN is set: the mode
    // comes from the bind address, not from the presence of a config value.
    expect((await check({ host: "localhost:5173" })).status).toBe(200);
    expect(
      (await check({ host: "reel.example.com", origin: PUBLIC })).status,
    ).toBe(403);
  });
});

test("a public origin is normalised, and a malformed one is refused", () => {
  const previous = process.env.PUBLIC_ORIGIN;
  try {
    // A trailing slash is a common typo in a systemd unit. It is harmless
    // because the value is reduced to its origin, so normalise it rather than
    // failing a deployment over it.
    process.env.PUBLIC_ORIGIN = "https://reel.example.com/";
    expect(publicOrigin()).toBe("https://reel.example.com");
    // A path, a non-http scheme or an unparseable value is a real error: the
    // comparison would never match and every request would be refused.
    process.env.PUBLIC_ORIGIN = "https://reel.example.com/app";
    expect(publicOrigin()).toBeNull();
    process.env.PUBLIC_ORIGIN = "ftp://reel.example.com";
    expect(publicOrigin()).toBeNull();
    process.env.PUBLIC_ORIGIN = "";
    expect(publicOrigin()).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previous;
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
