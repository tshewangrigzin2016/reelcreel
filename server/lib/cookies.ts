import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

/**
 * Cookie handling for yt-dlp.
 *
 * YouTube treats a datacenter IP as a bot and asks it to sign in. The only
 * reliable fix is to hand yt-dlp a real browser session, which means a
 * Netscape-format cookies file. On a hosted deployment the user has no shell,
 * so the file has to arrive through the API: these helpers validate it, write
 * it somewhere private, and summarise it without ever returning cookie values.
 *
 * Everything here intentionally works on a single managed path. A manually
 * typed path is still honoured by yt-dlp (that is what `cookiesPath` is), but
 * uploads always land on `cookiesFilePath()` so a public deployment cannot be
 * asked to write to an arbitrary location.
 */

/** A real cookies export is tens of kilobytes; 512 KB is already generous. */
export const MAX_COOKIES_BYTES = 512 * 1024;

const YOUTUBE_COOKIE_DOMAIN =
  /(^|\.)(youtube\.com|youtu\.be|google\.com|googleapis\.com|googlevideo\.com|googleusercontent\.com)$/i;

const HTTP_ONLY_PREFIX = "#HttpOnly_";
const HOSTNAME_RE = /^\.?[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;

export interface ParsedCookies {
  /** Cookie rows, not counting comments or blank lines. */
  entries: number;
  /** Rows for YouTube/Google (the ones that matter for authentication). */
  youtubeEntries: number;
}

export interface CookiesInfo {
  configured: boolean;
  path?: string;
  entries: number;
  youtubeEntries: number;
  bytes: number;
  updatedAt?: string;
  error?: string;
}

/**
 * The managed file. `YTD_COOKIES_FILE` exists for tests and for operators who
 * keep secrets outside the checkout; normal deployments use `data/cookies.txt`.
 */
export function cookiesFilePath(): string {
  const override = process.env.YTD_COOKIES_FILE?.trim();
  if (override) return path.resolve(override);
  // Mirror db.ts: a configured data directory owns secrets as well as the DB,
  // otherwise a service with YTD_DATA_DIR would write cookies into the
  // checkout while its database lives elsewhere.
  const dataDir = process.env.YTD_DATA_DIR || path.join(process.cwd(), "data");
  return path.join(dataDir, "cookies.txt");
}

/**
 * Validates the Netscape cookie format yt-dlp expects.
 *
 * The format is seven tab-separated fields: domain, include-subdomains, path,
 * secure, expiry, name, value. Honest exports also contain a header and
 * comments, and Chrome/yt-dlp mark HttpOnly rows with a `#HttpOnly_` prefix on
 * the domain. Rejecting those would reject every real browser export.
 */
export function parseNetscapeCookies(text: string): ParsedCookies {
  if (typeof text !== "string" || !text.trim())
    throw new Error("The cookies file is empty.");

  if (Buffer.byteLength(text, "utf8") > MAX_COOKIES_BYTES)
    throw new Error(
      `The cookies file is larger than ${Math.round(MAX_COOKIES_BYTES / 1024)} KB.`,
    );

  if (text.includes("\0"))
    throw new Error("The cookies file contains binary data.");

  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  let entries = 0;
  let youtubeEntries = 0;

  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index]!;
    if (!line.trim()) continue;

    // `#HttpOnly_` is data, not a comment. Strip it before splitting so the
    // domain lands in the first field like every other row.
    if (line.startsWith(HTTP_ONLY_PREFIX))
      line = line.slice(HTTP_ONLY_PREFIX.length);
    else if (line.startsWith("#")) continue;

    const fields = line.split("\t");
    if (fields.length !== 7)
      throw new Error(
        `Line ${index + 1} is not a Netscape cookie row (expected 7 tab-separated fields).`,
      );

    const domain = fields[0]!.trim();
    const name = fields[5]!.trim();
    if (!domain || !name)
      throw new Error(`Line ${index + 1} is missing a cookie domain or name.`);
    if (!HOSTNAME_RE.test(domain))
      throw new Error(`Line ${index + 1} has an invalid cookie domain.`);

    const includeSubdomains = fields[1]!.trim().toUpperCase();
    const secure = fields[3]!.trim().toUpperCase();
    if (!["TRUE", "FALSE"].includes(includeSubdomains))
      throw new Error(
        `Line ${index + 1} has an invalid include-subdomains flag.`,
      );
    if (!["TRUE", "FALSE"].includes(secure))
      throw new Error(`Line ${index + 1} has an invalid secure flag.`);
    if (!/^\d+$/.test(fields[4]!.trim()))
      throw new Error(`Line ${index + 1} has an invalid expiry.`);

    entries += 1;
    if (YOUTUBE_COOKIE_DOMAIN.test(domain)) youtubeEntries += 1;
  }

  if (entries === 0)
    throw new Error(
      "No cookie rows found. Export the file with a Netscape cookies extension rather than saving the page.",
    );
  if (youtubeEntries === 0)
    throw new Error(
      "No YouTube or Google cookies found. Export the file while signed in to youtube.com.",
    );

  return { entries, youtubeEntries };
}

/** Writes atomically with owner-only permissions, then reports the summary. */
export function saveCookies(text: string): CookiesInfo {
  const parsed = parseNetscapeCookies(text);
  const file = cookiesFilePath();
  const dir = path.dirname(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  const normalized = text.replace(/^\uFEFF/, "").replace(/\r?\n/g, "\n");
  const body = normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;

  try {
    writeFileSync(temporary, body, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* The rename may already have consumed it. */
    }
    throw error;
  }

  return readCookiesInfo(file);
}

/**
 * Summarises the configured file. Cookie values are never included: this is
 * returned to the browser and shown in Settings.
 */
export function readCookiesInfo(configuredPath?: string): CookiesInfo {
  const requested = configuredPath?.trim();
  const file = requested || cookiesFilePath();
  const base: CookiesInfo = {
    configured: !!requested,
    path: file,
    entries: 0,
    youtubeEntries: 0,
    bytes: 0,
  };

  if (!existsSync(file)) {
    return requested
      ? { ...base, error: "The configured cookies file does not exist." }
      : { ...base, configured: false };
  }

  let stat;
  try {
    stat = statSync(file);
  } catch (error) {
    return {
      ...base,
      configured: true,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!stat.isFile())
    return { ...base, configured: true, error: "That path is not a file." };
  if (stat.size > MAX_COOKIES_BYTES)
    return {
      ...base,
      configured: true,
      bytes: stat.size,
      error: "The cookies file is larger than the 512 KB limit.",
    };

  try {
    const parsed = parseNetscapeCookies(readFileSync(file, "utf8"));
    return {
      ...base,
      configured: true,
      ...parsed,
      bytes: stat.size,
      updatedAt: stat.mtime.toISOString(),
    };
  } catch (error) {
    return {
      ...base,
      configured: true,
      bytes: stat.size,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Removes only the managed upload. A manually typed path is left untouched. */
export function clearManagedCookies(): void {
  const file = cookiesFilePath();
  if (existsSync(file)) rmSync(file, { force: true });
}
