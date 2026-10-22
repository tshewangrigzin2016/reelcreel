import { managedProcess } from "./process";
import { pools } from "./queue";
import { getSettings } from "./db";
import path from "node:path";
import type { Subprocess } from "bun";
import { resolveBinary } from "./resolve-binary";

const ANSI = /\u001b\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

export interface RunHandle {
  proc: Subprocess;
  done: Promise<number>;
  cancel: () => Promise<void>;
  stderrText: () => string;
}

/** Errors that mean "YouTube pushed back", i.e. worth trying another client. */
const CHALLENGE_RE =
  /page needs to be reloaded|sign in to confirm|not a bot|too many requests|http error 429|http error 5\d\d|unable to extract/i;

export function isChallengeError(message: string): boolean {
  return CHALLENGE_RE.test(message);
}

const SIGN_IN_RE = /sign in to confirm|not a bot|use --cookies for the authentication/i;

/**
 * Turns YouTube's terse "sign in" error into something a hosted user can act
 * on. The server has no shell, so the fix is an upload in Settings, not a flag
 * on a command line.
 */
export function explainYtDlpError(message: string): string {
  if (!SIGN_IN_RE.test(message) || message.includes("Settings → YouTube cookies"))
    return message;
  return (
    message +
    "\n\nYouTube is asking this server to sign in. Upload a cookies.txt exported " +
    "from a browser signed in to youtube.com under Settings → YouTube cookies, " +
    "then retry the download."
  );
}

/**
 * Runs `fn` with each player client in turn, stopping at the first success.
 * Non-challenge failures (private video, bad URL) are rethrown immediately --
 * retrying those with a different client just wastes time.
 */
export async function withClientFallback<T>(
  fn: (client?: string) => Promise<T>,
  chain: Array<string | undefined> = PLAYER_CLIENT_CHAIN,
): Promise<T> {
  let lastError: unknown;
  for (const client of chain) {
    try {
      return await fn(client);
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!isChallengeError(message)) throw err;
    }
  }
  throw lastError;
}

export interface RunOptions {
  args: string[];
  onLine: (line: string) => void;
  onErrLine?: (line: string) => void;
  cwd?: string;
  /** Abort a probe when the HTTP client goes away. */
  signal?: AbortSignal;
  /**
   * Upper bound for metadata/probe commands. Downloads deliberately leave this
   * unset because a large or rate-limited file can legitimately take hours.
   */
  timeoutMs?: number;
  /** Probe commands don't need ffmpeg; downloads do. */
  withFfmpegLocation?: boolean;
  withJsRuntime?: boolean;
  withCookies?: boolean;
  /**
   * YouTube player client to impersonate. Undefined means "use yt-dlp's
   * default" -- which is deliberately the first choice.
   */
  playerClient?: string;
}

/**
 * Clients to try, in order, when YouTube pushes back.
 *
 * Measured on yt-dlp 2026.08.19 against a live video:
 *   default (no override) -> OK, 48 formats
 *   tv                    -> ERROR "The page needs to be reloaded."
 *   web_safari            -> ERROR "Requested format is not available."
 *   mweb                  -> ERROR "Requested format is not available."
 *
 * The widely-cited advice to force `tv,web_safari` is therefore actively
 * harmful on this build. We keep the other clients as fallbacks rather than
 * defaults so the app heals itself if the default ever stops working.
 */
export const PLAYER_CLIENT_CHAIN: Array<string | undefined> = [
  undefined,
  "web_safari",
  "mweb",
  "tv",
];

export interface BuiltArgs {
  argv: string[];
}

/**
 * Builds the argv for yt-dlp with the flags every invocation needs.
 * Exported so it can be unit-tested without spawning anything.
 */
export async function buildArgs(opts: RunOptions): Promise<string[]> {
  // Metadata probes only need yt-dlp. Requiring ffmpeg for them made the
  // entire UI unusable on a fresh machine where the user had not installed
  // the optional post-processing binary yet.
  const settings = getSettings();
  const runtime = settings.jsRuntime ?? "node";
  const [ytdlp, ffmpeg, node] = await Promise.all([
    resolveBinary("yt-dlp", "--version"),
    opts.withFfmpegLocation === false
      ? Promise.resolve(null)
      : resolveBinary("ffmpeg", "-version"),
    opts.withJsRuntime === false
      ? Promise.resolve(null)
      : resolveBinary(runtime, "--version"),
  ]);
  if (!ytdlp)
    throw new Error(
      "Could not find a working yt-dlp binary. Set its path in Settings.",
    );
  if (opts.withFfmpegLocation !== false && !ffmpeg) {
    throw new Error(
      "Could not find a working ffmpeg binary. Set its path in Settings.",
    );
  }
  if (opts.withJsRuntime !== false && !node)
    throw new Error(
      "Could not find the selected " +
        runtime +
        " runtime. Configure it in Settings.",
    );
  const argv: string[] = [
    ytdlp.path,
    "--newline", // force \n instead of \r, otherwise piped progress is unparseable
    "--ignore-config",
  ];

  // Verified required: without this every run warns that no JS runtime was found.
  if (opts.withJsRuntime !== false && node) {
    argv.push("--no-js-runtimes", "--js-runtimes", runtime + ":" + node.path);
  }

  if (opts.playerClient) {
    argv.push("--extractor-args", `youtube:player_client=${opts.playerClient}`);
  }

  if (opts.withFfmpegLocation !== false) {
    argv.push("--ffmpeg-location", path.dirname(ffmpeg!.path));
  }

  // Windows MAX_PATH is 260; long titles otherwise blow up mid-download.
  argv.push("--windows-filenames", "--trim-filenames", "180");

  if (opts.withCookies !== false && settings.cookiesPath)
    argv.push("--cookies", settings.cookiesPath);
  argv.push(...opts.args);
  return argv;
}

export async function runYtdlp(opts: RunOptions): Promise<RunHandle> {
  opts.signal?.throwIfAborted();
  // One admission point covers every probe, including streaming and previews.
  const release =
    opts.withFfmpegLocation === false
      ? await pools.probe.acquire(opts.signal)
      : () => {};
  try {
    const argv = await buildArgs(opts);
    opts.signal?.throwIfAborted();
    const handle = managedProcess({ ...opts, argv });
    return { ...handle, done: handle.done.finally(release) };
  } catch (error) {
    release();
    throw error;
  }
}
