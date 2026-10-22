import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MAX_COOKIES_BYTES,
  clearManagedCookies,
  cookiesFilePath,
  parseNetscapeCookies,
  readCookiesInfo,
  saveCookies,
} from "../server/lib/cookies";

const VALID = [
  "# Netscape HTTP Cookie File",
  "# This is a comment, not a cookie.",
  "",
  "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tsecret-value",
  ".youtube.com\tTRUE\t/\tFALSE\t1893456000\tPREF\tlang=en",
  ".google.com\tTRUE\t/\tTRUE\t1893456000\tNID\tabc",
].join("\r\n");

const directories: string[] = [];

function isolate(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "reelcreel-cookies-"));
  directories.push(dir);
  process.env.YTD_COOKIES_FILE = path.join(dir, "cookies.txt");
  return dir;
}

afterEach(() => {
  delete process.env.YTD_COOKIES_FILE;
  delete process.env.YTD_DATA_DIR;
  for (const dir of directories.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe("cookiesFilePath", () => {
  test("lives in the configured data directory", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "reelcreel-data-"));
    directories.push(dir);
    delete process.env.YTD_COOKIES_FILE;
    process.env.YTD_DATA_DIR = dir;
    expect(cookiesFilePath()).toBe(path.join(dir, "cookies.txt"));
  });
});

describe("parseNetscapeCookies", () => {
  test("accepts browser exports with comments and HttpOnly rows", () => {
    expect(parseNetscapeCookies(VALID)).toEqual({
      entries: 3,
      youtubeEntries: 3,
    });
  });

  test("requires YouTube or Google cookies", () => {
    const other = ".example.com\tTRUE\t/\tTRUE\t1893456000\tA\tb\n";
    expect(() => parseNetscapeCookies(other)).toThrow(/YouTube or Google/);
  });

  test("rejects empty and binary files", () => {
    expect(() => parseNetscapeCookies("   \n")).toThrow(/empty/i);
    expect(() =>
      parseNetscapeCookies(VALID.replace("secret-value", "sec\0ret")),
    ).toThrow(/binary/i);
  });

  test("rejects rows that are not seven tab-separated fields", () => {
    const broken = ".youtube.com\tTRUE\t/\tFALSE\t1893456000\tPREF\n";
    expect(() => parseNetscapeCookies(broken)).toThrow(/7 tab-separated/);
  });

  test("rejects invalid flags, expiry and domains", () => {
    const badFlag =
      ".youtube.com\tMAYBE\t/\tFALSE\t1893456000\tPREF\tx\n";
    expect(() => parseNetscapeCookies(badFlag)).toThrow(/include-subdomains/);
    const badExpiry = ".youtube.com\tTRUE\t/\tFALSE\tsoon\tPREF\tx\n";
    expect(() => parseNetscapeCookies(badExpiry)).toThrow(/expiry/);
    const badDomain =
      "not a host\tTRUE\t/\tFALSE\t1893456000\tPREF\tx\n";
    expect(() => parseNetscapeCookies(badDomain)).toThrow(/domain/);
  });

  test("rejects files above the size limit", () => {
    const huge = VALID + "x".repeat(MAX_COOKIES_BYTES);
    expect(() => parseNetscapeCookies(huge)).toThrow(/larger than/);
  });
});

describe("managed cookies file", () => {
  test("saves atomically, reports a summary, and never returns values", () => {
    isolate();
    const info = saveCookies(VALID);
    expect(info.configured).toBe(true);
    expect(info.entries).toBe(3);
    expect(info.youtubeEntries).toBe(3);
    expect(info.path).toBe(cookiesFilePath());
    expect(existsSync(cookiesFilePath())).toBe(true);
    expect(readFileSync(cookiesFilePath(), "utf8")).toContain("secret-value");
    expect(JSON.stringify(info)).not.toContain("secret-value");
    if (process.platform !== "win32")
      expect(statSync(cookiesFilePath()).mode & 0o777).toBe(0o600);

    expect(readCookiesInfo(cookiesFilePath())).toEqual(
      expect.objectContaining({ entries: 3, youtubeEntries: 3 }),
    );
  });

  test("clears only the managed upload", () => {
    const dir = isolate();
    saveCookies(VALID);
    clearManagedCookies();
    expect(existsSync(cookiesFilePath())).toBe(false);
    expect(readCookiesInfo()).toEqual(
      expect.objectContaining({ configured: false, entries: 0 }),
    );
    expect(dir.length).toBeGreaterThan(0);
  });

  test("reports a missing manual path instead of pretending it works", () => {
    isolate();
    const info = readCookiesInfo(path.join(tmpdir(), "does-not-exist.txt"));
    expect(info.configured).toBe(true);
    expect(info.error).toMatch(/does not exist/);
  });
});
