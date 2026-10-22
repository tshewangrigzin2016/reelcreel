import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Delivery state machine, against a real temp directory and a real database.
 *
 * The rules under test are the ones that decide whether a small VPS fills up:
 * an attempt limit, a time limit, a size cap and a startup sweep. None of them
 * can be verified from the client side, which is exactly why they are here.
 *
 * `YTD_DATA_DIR` must be set before the db module is imported, so the whole
 * fixture is built inside `beforeAll` and the modules are imported dynamically.
 */

let dir: string;
let db: typeof import("../server/lib/db");
let delivery: typeof import("../server/lib/delivery");
let queue: typeof import("../server/lib/queue");

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "ytd-delivery-"));
  process.env.YTD_DATA_DIR = path.join(dir, "data");
  process.env.YTD_RATE_LIMIT = "0";
  db = await import("../server/lib/db");
  delivery = await import("../server/lib/delivery");
  queue = await import("../server/lib/queue");
  db.putSettings({ deliveryMode: "browser", tempDir: path.join(dir, "temp") });
  mkdirSync(path.join(dir, "temp"), { recursive: true });
});

afterAll(() => {
  // Windows keeps SQLite's WAL handles open briefly after the last query, so a
  // recursive delete can hit EBUSY. The directory is in the OS temp folder and
  // the suite must not fail on cleanup.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* left for the OS temp cleaner */
  }
  delete process.env.YTD_DATA_DIR;
  delete process.env.YTD_RATE_LIMIT;
});

/** Creates a real file in the temp dir and a job that claims it. */
function stage(
  id: string,
  files: Array<{ name: string; bytes: number }>,
): { staging: string } {
  const staging = path.join(dir, "temp", ".yt-staging", id);
  mkdirSync(staging, { recursive: true });
  for (const file of files)
    writeFileSync(
      path.join(dir, "temp", file.name),
      Buffer.alloc(file.bytes, 0x61),
    );
  queue.jobStore.create({
    id,
    title: "Fixture " + id,
    phase: "done",
    percent: 100,
    presetId: "mp4-h264",
    attempts: 1,
    stagingDir: staging,
    delivery: {
      state: "pending",
      attempts: 0,
      files: files.map((f) => ({ name: f.name, sizeBytes: f.bytes })),
      readyAt: Date.now(),
    },
  });
  db.historyAdd({
    id,
    videoId: "v" + id,
    title: "Fixture " + id,
    presetId: "mp4-h264",
    completedAt: Date.now(),
    filePath: path.join(dir, "temp", files[0]!.name),
    delivery: {
      state: "pending",
      attempts: 0,
      files: files.map((f) => ({ name: f.name, sizeBytes: f.bytes })),
      readyAt: Date.now(),
    },
  });
  return { staging };
}

const exists = (target: string) => {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
};

describe("mode", () => {
  test("browser mode redirects output into the temp directory", () => {
    const settings = db.getSettings();
    expect(delivery.deliveryEnabled(settings)).toBe(true);
    expect(delivery.effectiveOutputDir(settings)).toBe(settings.tempDir);
  });

  test("server mode keeps the configured output folder", () => {
    db.putSettings({ deliveryMode: "server", outputDir: path.join(dir, "out") });
    const settings = db.getSettings();
    expect(delivery.deliveryEnabled(settings)).toBe(false);
    expect(delivery.effectiveOutputDir(settings)).toBe(
      path.join(dir, "out"),
    );
    db.putSettings({ deliveryMode: "browser" });
  });
});

describe("delivery lifecycle", () => {
  test("a finished job starts pending with its files listed", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    stage(id, [{ name: "a.mp4", bytes: 10 }]);
    expect(delivery.deliveryInfo(id)?.state).toBe("pending");
    expect(delivery.deliveryFile(id, 0)?.sizeBytes).toBe(10);
  });

  test("delivering the last file deletes the media and marks it delivered", () => {
    const id = "22222222-2222-2222-2222-222222222222";
    const { staging } = stage(id, [{ name: "b.mp4", bytes: 10 }]);
    delivery.beginStream(id);
    expect(delivery.deliveryInfo(id)?.state).toBe("streaming");
    delivery.completeStream(id, 0);
    expect(delivery.deliveryInfo(id)?.state).toBe("delivered");
    expect(exists(path.join(dir, "temp", "b.mp4"))).toBe(false);
    // Staging is removed too: nothing about this job should survive.
    expect(exists(path.join(staging, "keep.txt"))).toBe(false);
  });

  test("captions keep the job pending until the last file is sent", () => {
    const id = "33333333-3333-3333-3333-333333333333";
    stage(id, [
      { name: "c.mp4", bytes: 10 },
      { name: "c.en.vtt", bytes: 4 },
    ]);
    delivery.completeStream(id, 0);
    // The media is gone from the browser's point of view only after both.
    expect(delivery.deliveryInfo(id)?.state).toBe("pending");
    delivery.completeStream(id, 1);
    expect(delivery.deliveryInfo(id)?.state).toBe("delivered");
  });

  test("one failed attempt keeps the file and counts", () => {
    const id = "44444444-4444-4444-4444-444444444444";
    stage(id, [{ name: "d.mp4", bytes: 10 }]);
    expect(delivery.failStream(id, "interrupted")).toBe("failed");
    const info = delivery.deliveryInfo(id);
    expect(info?.attempts).toBe(1);
    expect(info?.reason).toContain("attempt 1 of 3");
    expect(exists(path.join(dir, "temp", "d.mp4"))).toBe(true);
  });

  test("the third failed attempt deletes the file", () => {
    const id = "55555555-5555-5555-5555-555555555555";
    const { staging } = stage(id, [{ name: "e.mp4", bytes: 10 }]);
    delivery.failStream(id, "interrupted");
    delivery.failStream(id, "interrupted");
    expect(exists(path.join(dir, "temp", "e.mp4"))).toBe(true);
    expect(delivery.failStream(id, "interrupted")).toBe("expired");
    expect(exists(path.join(dir, "temp", "e.mp4"))).toBe(false);
    expect(delivery.deliveryInfo(id)?.state).toBe("expired");
    expect(delivery.deliveryInfo(id)?.reason).toContain("removed from the server");
    expect(exists(staging)).toBe(false);
  });

  test("the attempt limit comes from settings", () => {
    db.putSettings({ deliveryMaxAttempts: 1 });
    try {
      const id = "66666666-6666-6666-6666-666666666666";
      stage(id, [{ name: "f.mp4", bytes: 10 }]);
      expect(delivery.failStream(id, "interrupted")).toBe("expired");
    } finally {
      db.putSettings({ deliveryMaxAttempts: 3 });
    }
  });
});

describe("the sweeper", () => {
  test("expires a file nobody asked for within the time limit", () => {
    const id = "77777777-7777-7777-7777-777777777777";
    stage(id, [{ name: "g.mp4", bytes: 10 }]);
    // Pretend it finished an hour ago; the default limit is 15 minutes.
    const job = queue.jobStore.get(id)!;
    queue.jobStore.update(id, {
      delivery: { ...job.delivery!, readyAt: Date.now() - 60 * 60_000 },
    });
    const result = delivery.sweepDelivery();
    expect(result.expiredByTtl).toContain(id);
    expect(exists(path.join(dir, "temp", "g.mp4"))).toBe(false);
  });

  test("leaves a fresh file alone", () => {
    const id = "88888888-8888-8888-8888-888888888888";
    stage(id, [{ name: "h.mp4", bytes: 10 }]);
    const result = delivery.sweepDelivery();
    expect(result.expiredByTtl).not.toContain(id);
    expect(delivery.deliveryInfo(id)?.state).toBe("pending");
  });

  test("evicts the oldest waiting file when the size cap is exceeded", () => {
    // Cap at 1 MB, then stage two 600 KB files: one has to go, and it must be
    // the older one.
    db.putSettings({ tempCapMb: 1 });
    try {
      const older = "99999999-9999-9999-9999-999999999999";
      const newer = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      stage(older, [{ name: "old.mp4", bytes: 600 * 1024 }]);
      stage(newer, [{ name: "new.mp4", bytes: 600 * 1024 }]);
      const olderJob = queue.jobStore.get(older)!;
      queue.jobStore.update(older, {
        delivery: { ...olderJob.delivery!, readyAt: Date.now() - 60_000 },
      });
      const result = delivery.sweepDelivery();
      expect(result.expiredByCap).toContain(older);
      expect(result.expiredByCap).not.toContain(newer);
      expect(exists(path.join(dir, "temp", "old.mp4"))).toBe(false);
      expect(exists(path.join(dir, "temp", "new.mp4"))).toBe(true);
    } finally {
      db.putSettings({ tempCapMb: 2048 });
    }
  });

  test("removes a file no job claims, but never the staging directory", () => {
    writeFileSync(path.join(dir, "temp", "orphan.mp4"), Buffer.alloc(4));
    const result = delivery.sweepDelivery();
    expect(result.removedOrphans).toContain("orphan.mp4");
    expect(exists(path.join(dir, "temp", "orphan.mp4"))).toBe(false);
    expect(exists(path.join(dir, "temp", ".yt-staging"))).toBe(false);
  });

  test("does nothing at all in server mode", () => {
    db.putSettings({ deliveryMode: "server" });
    try {
      writeFileSync(path.join(dir, "temp", "server-mode.mp4"), Buffer.alloc(4));
      const result = delivery.sweepDelivery();
      expect(result.expiredByTtl).toEqual([]);
      expect(result.expiredByCap).toEqual([]);
      expect(result.removedOrphans).toEqual([]);
      expect(exists(path.join(dir, "temp", "server-mode.mp4"))).toBe(true);
      rmSync(path.join(dir, "temp", "server-mode.mp4"), { force: true });
    } finally {
      db.putSettings({ deliveryMode: "browser" });
    }
  });
});

describe("restart recovery", () => {
  test("a job stuck mid-stream goes back to pending", () => {
    const id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    stage(id, [{ name: "i.mp4", bytes: 10 }]);
    delivery.beginStream(id);
    delivery.recoverDeliveries();
    expect(delivery.deliveryInfo(id)?.state).toBe("pending");
  });

  test("a job whose file vanished is expired rather than left fetchable", () => {
    const id = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    stage(id, [{ name: "j.mp4", bytes: 10 }]);
    rmSync(path.join(dir, "temp", "j.mp4"), { force: true });
    delivery.recoverDeliveries();
    expect(delivery.deliveryInfo(id)?.state).toBe("expired");
  });

  test("an already delivered row is left alone", () => {
    const id = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    stage(id, [{ name: "k.mp4", bytes: 10 }]);
    delivery.completeStream(id, 0);
    delivery.recoverDeliveries();
    expect(delivery.deliveryInfo(id)?.state).toBe("delivered");
  });
});

describe("environment defaults", () => {
  test(
    "YTD_DELIVERY_MODE applies on a fresh database, and a saved value wins",
    async () => {
      // Regression: `normalizedSettings()` used to fall back to the literals
      // "server" and "node" instead of DEFAULT_SETTINGS, so a VPS unit setting
      // YTD_DELIVERY_MODE=browser booted in server mode and kept every file.
      // A separate process is needed because DEFAULT_SETTINGS is built once, at
      // import time.
      const fresh = mkdtempSync(path.join(tmpdir(), "ytd-env-"));
      const script = path.join(fresh, "probe.ts");
      const dbModule = path
        .resolve(import.meta.dir, "../server/lib/db")
        .replace(/\\/g, "/");
      writeFileSync(
        script,
        [
          `const db = await import(${JSON.stringify(dbModule)});`,
          `const first = db.getSettings();`,
          `db.putSettings({ deliveryMode: "server", jsRuntime: "node" });`,
          `const saved = db.getSettings();`,
          `console.log(JSON.stringify({`,
          `  env: [first.deliveryMode, first.jsRuntime],`,
          `  saved: [saved.deliveryMode, saved.jsRuntime],`,
          `}));`,
        ].join("\n"),
      );
      try {
        const proc = Bun.spawn([process.execPath, "run", script], {
          env: {
            ...process.env,
            YTD_DATA_DIR: path.join(fresh, "data"),
            YTD_DELIVERY_MODE: "browser",
            YTD_JS_RUNTIME: "deno",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ]);
        expect(err).toBe("");
        expect(code).toBe(0);
        const result = JSON.parse(out.trim().split("\n").pop()!);
        // The environment configures a fresh instance...
        expect(result.env).toEqual(["browser", "deno"]);
        // ...but an explicitly saved value still wins over it.
        expect(result.saved).toEqual(["server", "node"]);
      } finally {
        try {
          rmSync(fresh, { recursive: true, force: true });
        } catch {
          /* OS temp cleaner */
        }
      }
    },
    30000,
  );
});

describe("history bookkeeping", () => {
  test("a delivered row is not reported as a missing file", () => {
    const id = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    stage(id, [{ name: "l.mp4", bytes: 10 }]);
    delivery.completeStream(id, 0);
    const page = db.libraryPage("", "", 1, 200);
    const row = page.rows.find((r) => r.id === id);
    // The file is gone on purpose; calling that "missing" would make every
    // successful browser download look broken.
    expect(row?.missing).toBe(false);
  });

  test("a server-mode row whose file is gone is still missing", () => {
    const id = "ffffffff-ffff-ffff-ffff-ffffffffffff";
    db.historyAdd({
      id,
      videoId: "vmissing",
      title: "Missing fixture",
      presetId: "mp4-h264",
      completedAt: Date.now(),
      filePath: path.join(dir, "temp", "does-not-exist.mp4"),
    });
    const page = db.libraryPage("Missing fixture", "", 1, 50);
    expect(page.rows[0]?.missing).toBe(true);
  });
});
