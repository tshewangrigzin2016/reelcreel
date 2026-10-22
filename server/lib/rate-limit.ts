import type { MiddlewareHandler } from "hono";

/**
 * A fixed-window request budget, keyed by client address.
 *
 * The app is meant to be public and unauthenticated, so the only thing standing
 * between one visitor and the whole machine is a cap on how much work they can
 * ask for. This is deliberately the cheapest possible limiter -- a Map of
 * counters and a periodic prune -- because the alternative (a sliding-window
 * store) buys precision nobody needs for a video downloader and costs memory on
 * a small VPS.
 *
 * Set `YTD_RATE_LIMIT=0` to disable, which is what the test suite does.
 */

interface Window {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Window>();

/** Requests per minute, per client address. */
export function rateLimitPerMinute(): number {
  const raw = process.env.YTD_RATE_LIMIT;
  if (raw === undefined) return 60;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 60;
}

/**
 * The client's address.
 *
 * `X-Forwarded-For` is only trusted when `TRUST_PROXY=1`, because otherwise any
 * client could set it and get a fresh budget per request -- a rate limiter that
 * trusts an unauthenticated header is worse than none, since it looks like it
 * works.
 */
export function clientIp(headers: Headers, fallback: string): string {
  if (process.env.TRUST_PROXY === "1") {
    const forwarded = headers.get("x-forwarded-for");
    if (forwarded) {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first;
    }
    const real = headers.get("x-real-ip")?.trim();
    if (real) return real;
  }
  return fallback;
}

function prune(now: number): void {
  for (const [key, window] of buckets)
    if (window.resetAt <= now) buckets.delete(key);
}

let lastPrune = 0;

/**
 * Counts one request against `key`. Returns 0 when allowed, or the number of
 * seconds until the window resets.
 */
export function consume(key: string, limit = rateLimitPerMinute()): number {
  if (limit <= 0) return 0;
  const now = Date.now();
  if (now - lastPrune > 60_000) {
    prune(now);
    lastPrune = now;
  }
  const window = buckets.get(key);
  if (!window || window.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + 60_000 });
    return 0;
  }
  if (window.count >= limit)
    return Math.max(1, Math.ceil((window.resetAt - now) / 1000));
  window.count += 1;
  return 0;
}

/** Test hook: clears every counter. */
export function resetRateLimits(): void {
  buckets.clear();
  lastPrune = 0;
}

/**
 * Middleware for the expensive routes only.
 *
 * Static assets and the job stream are excluded on purpose: the SSE stream is
 * one long-lived request, and rate-limiting it would drop the queue feed of a
 * user who simply left a tab open.
 */
export function rateLimit(): MiddlewareHandler {
  return async (c, next) => {
    const limit = rateLimitPerMinute();
    if (limit <= 0) return next();
    const ip = clientIp(c.req.raw.headers, socketAddress(c));
    // Keyed by path as well as address, so a burst of job polling cannot use up
    // the budget for starting a download.
    const retryAfter = consume(ip + " " + c.req.path, limit);
    if (retryAfter > 0)
      return c.json(
        { error: "Too many requests. Wait a moment and try again." },
        429,
        { "retry-after": String(retryAfter) },
      );
    await next();
  };
}

/**
 * The peer address from Bun's server, or "unknown".
 *
 * Bun exposes `requestIP(request)` on the server object it passes as the Hono
 * environment. It is optional here because the same app runs under `app.fetch`
 * in tests, where there is no socket at all.
 */
function socketAddress(c: {
  env?: { server?: { requestIP?: (req: Request) => { address?: string } | null } };
  req: { raw: Request };
}): string {
  try {
    return c.env?.server?.requestIP?.(c.req.raw)?.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
