import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const reservation = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response("test"),
});
const port = reservation.port;
reservation.stop(true);
const origin = "http://127.0.0.1:" + port;
const data = mkdtempSync(path.join(tmpdir(), "yt-browser-"));
const server = Bun.spawn(
  [process.execPath, "run", "verification/browser-server.ts"],
  {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, YTD_DATA_DIR: data, PORT: String(port) },
  },
);
const out = new Response(server.stdout).text();
const err = new Response(server.stderr).text();
try {
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try {
      if (
        (
          await fetch(origin + "/api/jobs", {
            signal: AbortSignal.timeout(500),
          })
        ).ok
      ) {
        ready = true;
        break;
      }
    } catch {}
    await Bun.sleep(100);
  }
  if (!ready) throw new Error("Isolated test server failed to start.");
  const test = Bun.spawn(
    [process.execPath, "run", "verification/browser.mjs"],
    {
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, TEST_ORIGIN: origin },
    },
  );
  const code = await test.exited;
  if (code) process.exitCode = code;
} finally {
  server.kill();
  await server.exited;
  const output = await out;
  const errors = await err;
  if (process.exitCode) console.error(output, errors);
}
