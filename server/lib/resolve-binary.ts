import { managedProcess } from "./process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { BinaryInfo } from "../../shared/types";

/**
 * PATH on this machine is genuinely unstable: the Chocolatey yt-dlp shim was
 * silently replaced mid-session, and the ffmpeg shim was dead for ~50 minutes
 * during a `choco upgrade`. Bun.which() returns whatever is first on PATH,
 * including broken shims, so we never trust it alone -- we spawn `--version`
 * and keep the first candidate that actually exits 0.
 */

const cache = new Map<string, BinaryInfo | null>();
const overrides = new Map<string, string>();

const PROBE_TIMEOUT_MS = 8000;

export function setOverride(name: string, value: string | undefined): void {
  if (value && value.trim()) overrides.set(name, value.trim());
  else overrides.delete(name);
  cache.delete(name);
  // resolveBinaries() caches the aggregate as well; changing one override must
  // force sibling tools (ffprobe beside ffmpeg in particular) to re-resolve.
  cached = null;
}

export function getOverride(name: string): string | undefined {
  return overrides.get(name);
}

function pathDirs(): string[] {
  return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
}

function extensions(): string[] {
  if (process.platform !== "win32") return [""];
  const pathext = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return [
    "",
    ...pathext
      .split(";")
      .filter(Boolean)
      .map((e) => e.toLowerCase()),
  ];
}

function candidates(name: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (p: string) => {
    const norm = path.normalize(p);
    if (!seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  };

  const override = overrides.get(name);
  if (override) return [override];

  for (const dir of pathDirs()) {
    for (const ext of extensions()) push(path.join(dir, name + ext));
  }
  return out;
}

function extractVersion(raw: string): string | null {
  const s = raw.trim();
  // yt-dlp prints a bare date-version: 2026.08.19
  const ymd = s.match(/(\d{4}[.\-]\d{2}[.\-]\d{2})/);
  if (ymd) return ymd[1];
  // ffmpeg prints: ffmpeg version 9.0.1-full_build-www.gyan.dev ...
  const v = s.match(/version\s+([0-9][^\s,]*)/i);
  if (v) return v[1].split("-")[0];
  const first = s.split(/\s+/).find(Boolean);
  return first && /[0-9]/.test(first) ? first.split("-")[0] : null;
}

export async function probeOne(
  candidate: string,
  versionFlag: string,
): Promise<BinaryInfo | null> {
  if (!candidate || !existsSync(candidate)) return null;
  try {
    let out = "";
    const handle = managedProcess({
      argv: [candidate, versionFlag],
      timeoutMs: PROBE_TIMEOUT_MS,
      onLine: (line) => {
        out += line + "\n";
      },
    });
    if ((await handle.done) !== 0) return null;
    const version = extractVersion(out);
    return version ? { path: candidate, version } : null;
  } catch {
    return null;
  }
}

export async function resolveBinary(
  name: string,
  versionFlag = "--version",
  force = false,
): Promise<BinaryInfo | null> {
  if (!force && cache.has(name)) return cache.get(name) ?? null;

  for (const candidate of candidates(name)) {
    const info = await probeOne(candidate, versionFlag);
    if (info) {
      cache.set(name, info);
      return info;
    }
  }

  cache.set(name, null);
  return null;
}

export interface Binaries {
  ytdlp: BinaryInfo;
  ffmpeg: BinaryInfo;
  node: BinaryInfo | null;
}

let cached: Binaries | null = null;

export async function resolveBinaries(force = false): Promise<Binaries> {
  if (cached && !force) return cached;

  const [ytdlp, ffmpeg, node] = await Promise.all([
    resolveBinary("yt-dlp", "--version", force),
    resolveBinary("ffmpeg", "-version", force),
    resolveBinary("node", "--version", force),
  ]);

  if (!ytdlp || !ffmpeg) {
    const missing = [
      !ytdlp ? "yt-dlp" : null,
      !ffmpeg ? "ffmpeg" : null,
    ].filter(Boolean);
    throw new Error(
      `Could not find a working ${missing.join(" or ")}. Install it, or set the path in Settings.`,
    );
  }

  cached = { ytdlp, ffmpeg, node };
  return cached;
}

/** Called when a spawn fails in a way that suggests the shim went stale. */
export function invalidateBinaries(): void {
  cached = null;
  cache.clear();
}
