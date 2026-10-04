import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
for (const file of [
  "verification/core.test.ts",
  "verification/lifecycle.test.ts",
]) {
  test(
    "isolated regression suite: " + file,
    async () => {
      const data = mkdtempSync(path.join(tmpdir(), "downloader-test-"));
      const proc = Bun.spawn(
        [process.execPath, "test", "--timeout", "20000", file],
        {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, YTD_DATA_DIR: data },
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (code !== 0) console.error(out + err);
      expect(code).toBe(0);
    },
    60000,
  );
}
