/**
 * Where the API listens.
 *
 * Defaults to loopback, which is what the app has always done and what every
 * existing test asserts. A deployment that wants to be reachable sets `HOST`
 * (typically `0.0.0.0`) and must then also set `PUBLIC_ORIGIN`, because the
 * request boundary needs to know which origin is the real one once loopback is
 * no longer the answer.
 */
export const serverAddress = {
  hostname: process.env.HOST?.trim() || "127.0.0.1",
  port: Number(process.env.PORT ?? 8787),
};

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * The bind address, read from the environment.
 *
 * Read at call time rather than captured once at import, so the request
 * boundary's mode can be exercised in both configurations by the test suite.
 * In a running server the value never changes, so the two are equivalent.
 */
export function bindHostname(): string {
  return process.env.HOST?.trim() || serverAddress.hostname;
}

/** True when this process is bound to something other than loopback. */
export function isPublicBinding(): boolean {
  const host = bindHostname().toLowerCase().replace(/^\[|\]$/g, "");
  return !LOOPBACK.has(host);
}

/**
 * The origin a public instance is served from, e.g. `https://reel.example.com`.
 *
 * Returns null when unset. Deliberately validated rather than trusted: a
 * trailing slash or a path in this value would silently reject every request,
 * and the failure would look like a broken app rather than a config typo.
 */
export function publicOrigin(): string | null {
  const raw = process.env.PUBLIC_ORIGIN?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.pathname !== "/" || url.search || url.hash) return null;
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Refuses to start a configuration that cannot be safe.
 *
 * Binding a public interface without knowing the real origin would leave the
 * request boundary with nothing to compare against, so every same-origin check
 * would have to be dropped. Failing loudly at boot is much better than starting
 * a service that looks fine and is defenceless.
 */
export function configurationError(): string | null {
  if (!isPublicBinding()) return null;
  const origin = publicOrigin();
  if (process.env.PUBLIC_ORIGIN && !origin)
    return `PUBLIC_ORIGIN is not a valid origin: "${process.env.PUBLIC_ORIGIN}". Use the form https://example.com with no path or trailing slash.`;
  if (!origin)
    return `HOST is set to ${serverAddress.hostname}, which is reachable from outside this machine, but PUBLIC_ORIGIN is not set. Set PUBLIC_ORIGIN to the address browsers use (for example https://reel.example.com) so the API can reject cross-origin requests, or leave HOST unset to stay loopback-only.`;
  return null;
}

export function startupError(error: unknown): string {
  const code = (error as { code?: string } | null)?.code;
  if (code === "EADDRINUSE") {
    return `API port ${serverAddress.port} is already in use. Stop the existing app with Ctrl+C in its terminal before running bun dev again, or choose a different PORT (and YTD_DATA_DIR for a separate instance).`;
  }
  if (code === "EADDRNOTAVAIL" || code === "EACCES") {
    return `Cannot bind ${serverAddress.hostname}:${serverAddress.port} (${code}). Check the HOST value and that the port is permitted.`;
  }
  const config = configurationError();
  if (config) return config;
  return error instanceof Error ? error.message : String(error);
}
