/**
 * Runs the planner over every preset for a few real library entries, to confirm
 * the decision matrix (skip / convert / download) is reached by real data and
 * not only by the mocked unit tests.
 *
 * Spawns its own API server so the whole check is one self-contained process
 * that cleans up after itself.
 */
const BASE = "http://127.0.0.1:8787";

const server = Bun.spawn(["bun", "run", "server/index.ts"], {
  cwd: process.cwd(),
  stdout: "ignore",
  stderr: "ignore",
});

async function waitForApi(): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(500);
  }
  return false;
}

let failed = false;
try {
  if (!(await waitForApi())) {
    console.log("API did not come up");
    failed = true;
  } else {
    const presets = (await fetch(`${BASE}/api/presets`).then((r) => r.json())) as Array<{
      id: string;
      label: string;
      group: string;
      ext: string;
    }>;

    const history = (await fetch(`${BASE}/api/history`).then((r) => r.json())) as Array<{
      id: string;
      videoId: string;
      title: string;
      url?: string;
      presetId: string;
      ext?: string;
      source?: Record<string, unknown>;
      playlist?: Record<string, unknown>;
    }>;

    const subjects = history.filter((r) => r.source).slice(0, 3);
    console.log(`sweeping ${presets.length} presets x ${subjects.length} real entries\n`);

    for (const s of subjects) {
      const url = s.url ?? `https://www.youtube.com/watch?v=${s.videoId}`;
      console.log(`=== ${s.title.slice(0, 46)}`);
      console.log(`    stored as ${s.presetId} (.${s.ext})`);

      for (const p of presets) {
        const body = (await fetch(`${BASE}/api/plan`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ url, presetId: p.id, videoId: s.videoId }),
        }).then((r) => r.json())) as {
          action?: string;
          reason?: string;
          lossless?: boolean;
          error?: string;
        };

        if (body.error) {
          console.log(`    ??????? ${p.id.padEnd(10)} ERROR ${body.error}`);
          continue;
        }
        const flag =
          body.action === "skip"
            ? "skip   "
            : body.action === "convert"
              ? "CONVERT"
              : "-------";
        const lossless = body.lossless ? " [lossless remux]" : "";
        console.log(
          `    ${flag} ${p.id.padEnd(10)} ${(body.reason ?? "").slice(0, 72)}${lossless}`,
        );
      }
      console.log();
    }
  }
} finally {
  try {
    server.kill();
  } catch {
    /* already gone */
  }
}

process.exit(failed ? 1 : 0);
