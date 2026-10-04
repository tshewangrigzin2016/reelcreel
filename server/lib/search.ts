import { thumbnailFor } from "../../shared/format";
import type {
  SearchResponse,
  SearchResult,
  SearchSort,
} from "../../shared/types";
import { runYtdlp } from "./spawn";
import { lastError } from "./probe";

const SEARCH_TIMEOUT_MS = 60_000;
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_CACHE_LIMIT = 32;

const cache = new Map<string, { at: number; value: SearchResponse }>();

function cacheGet(key: string): SearchResponse | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.at > SEARCH_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function cacheSet(key: string, value: SearchResponse): void {
  cache.set(key, { at: Date.now(), value });
  while (cache.size > SEARCH_CACHE_LIMIT) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length > 1);
}

/**
 * Relevance score 0-100 for one result against the query tokens.
 *
 * - 60 pts: title token coverage (exact word matches beat partials)
 * - 20 pts: channel-name match (so "channel: X" style queries surface channels)
 * - 10 pts: description match (weak signal, only when title missed)
 * - 10 pts: popularity boost (log10 views, capped) — popular exact matches win,
 *   but popularity alone cannot outrank a title match.
 */
export function scoreResult(
  queryTokens: string[],
  title: string,
  channel: string | undefined,
  description: string | undefined,
  viewCount: number | undefined,
): number {
  if (queryTokens.length === 0) return 0;
  const titleLow = title.toLowerCase();
  const titleWords = new Set(tokens(title));
  let hits = 0;
  let partials = 0;
  for (const t of queryTokens) {
    if (titleWords.has(t)) hits++;
    else if (titleLow.includes(t)) partials++;
  }
  const coverage = (hits + partials * 0.5) / queryTokens.length;
  let score = Math.min(1, coverage) * 60;

  if (channel) {
    const channelWords = new Set(tokens(channel));
    let chHits = 0;
    for (const t of queryTokens) if (channelWords.has(t)) chHits++;
    score += (chHits / queryTokens.length) * 20;
  }

  if (description && coverage < 1) {
    const descLow = description.toLowerCase().slice(0, 2000);
    let dHits = 0;
    for (const t of queryTokens) if (descLow.includes(t)) dHits++;
    score += (dHits / queryTokens.length) * 10;
  }

  if (viewCount && viewCount > 0) {
    score += Math.min(10, Math.log10(viewCount + 1) * 1.5);
  }

  return Math.round(Math.min(100, score) * 10) / 10;
}

function toSearchResult(
  raw: Record<string, unknown>,
  queryTokens: string[],
  index: number,
): SearchResult | null {
  const ieKey = str((raw as { ie_key?: unknown }).ie_key);
  const type = str((raw as { _type?: unknown })._type);

  // Channel / playlist records from a flat search.
  if (ieKey === "YoutubeTab" || type === "playlist") {
    const url =
      str(raw.webpage_url) ??
      str(raw.url) ??
      (str(raw.id) ? `https://www.youtube.com/@${raw.id}` : undefined);
    if (!url) return null;
    const title =
      str(raw.title) ?? str(raw.channel) ?? str(raw.uploader) ?? "Untitled";
    const id = String(raw.channel_id ?? raw.id ?? `playlist-${index}`);
    return {
      id,
      kind: /list=/.test(url) || str(raw.playlist_id) ? "playlist" : "channel",
      title,
      channel: str(raw.channel) ?? str(raw.uploader),
      channelId: str(raw.channel_id),
      channelUrl: url,
      thumbnail: thumbnailFor(String(raw.id ?? "")),
      url,
      subscriberCount: num(raw.subscriber_count),
      videoCount:
        num(raw.playlist_count) ?? num((raw as { n_entries?: unknown }).n_entries),
      description: str(raw.description)?.slice(0, 300),
      score: scoreResult(queryTokens, title, str(raw.channel), str(raw.description), undefined),
    };
  }

  const id = str(raw.id);
  if (!id) return null;

  const title = str(raw.title) ?? "Untitled";
  const liveStatus = str(raw.live_status);
  const isLive = liveStatus !== undefined && liveStatus !== "not_live";
  const duration = num(raw.duration);
  const viewCount =
    num(raw.view_count) ?? num((raw as { viewCount?: unknown }).viewCount);
  const webpageUrl =
    str(raw.webpage_url) ?? `https://www.youtube.com/watch?v=${id}`;
  const channel = str(raw.channel) ?? str(raw.uploader);
  const channelId = str(raw.channel_id);
  const description = str(raw.description)?.slice(0, 300);

  // Shorts heuristic: flat search rarely marks them, so a short runtime plus a
  // /shorts/ URL is the reliable signal. 90s keeps music clips out of Shorts.
  const rawUrl = str(raw.url) ?? "";
  const isShort =
    webpageUrl.includes("/shorts/") ||
    rawUrl.includes("/shorts/") ||
    (duration !== undefined && duration <= 90 && duration > 0 && title.length < 120
      ? duration <= 62
      : false);

  let kind: SearchResult["kind"] = "video";
  if (isLive) kind = "live";
  else if (isShort) kind = "short";

  return {
    id,
    kind,
    title,
    channel,
    channelId,
    channelUrl: channelId
      ? `https://www.youtube.com/channel/${channelId}`
      : undefined,
    thumbnail: thumbnailFor(id),
    url: webpageUrl,
    duration,
    viewCount,
    description,
    liveStatus,
    score: scoreResult(queryTokens, title, channel, description, viewCount),
  };
}

function synthesizeChannels(
  results: SearchResult[],
  queryTokens: string[],
): SearchResult[] {
  // Flat ytsearch returns videos, not channel cards. Grouping by channel gives
  // a usable channel row without a second network pass.
  const byChannel = new Map<string, SearchResult[]>();
  for (const r of results) {
    if (r.kind !== "video" && r.kind !== "short" && r.kind !== "live") continue;
    const key = r.channelId ?? r.channel ?? "";
    if (!key) continue;
    const list = byChannel.get(key) ?? [];
    list.push(r);
    byChannel.set(key, list);
  }
  const out: SearchResult[] = [];
  for (const [key, videos] of byChannel) {
    if (videos.length < 2) continue;
    const first = videos[0];
    const views = videos.reduce((n, v) => n + (v.viewCount ?? 0), 0);
    out.push({
      id: `channel-${key}`,
      kind: "channel",
      title: first.channel ?? key,
      channel: first.channel,
      channelId: first.channelId,
      channelUrl:
        first.channelUrl ??
        (first.channelId
          ? `https://www.youtube.com/channel/${first.channelId}`
          : undefined),
      thumbnail: first.thumbnail,
      url:
        first.channelUrl ??
        (first.channelId
          ? `https://www.youtube.com/channel/${first.channelId}`
          : first.url),
      viewCount: views || undefined,
      videoCount: videos.length,
      description: `${videos.length} videos in results`,
      score: scoreResult(
        queryTokens,
        first.channel ?? "",
        first.channel,
        undefined,
        views || undefined,
      ),
    });
    if (out.length >= 5) break;
  }
  return out;
}

export async function searchYouTube(
  query: string,
  limit: number,
  sort: SearchSort,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const q = query.trim().slice(0, 200);
  if (!q) throw new Error("No search query provided.");
  const capped = Math.min(Math.max(limit || 25, 1), 50);
  const cacheKey = `${q}\n${capped}\n${sort}`;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  if (signal?.aborted) throw new Error("Search cancelled.");
  const lines: string[] = [];
  // ytsearchN: is the no-API-key path — same yt-dlp binary the downloads use.
  // --flat-playlist keeps it to ~1 request per result instead of a full extract.
  const handle = await runYtdlp({
    args: [
      "--flat-playlist",
      "--lazy-playlist",
      "--dump-json",
      "--no-playlist",
      `ytsearch${capped}:${q}`,
    ],
    onLine: (line) => {
      if (line.startsWith("{")) lines.push(line);
    },
    signal,
    timeoutMs: SEARCH_TIMEOUT_MS,
    withFfmpegLocation: false,
    withCookies: false,
  });

  const code = await handle.done;
  if (code !== 0 || lines.length === 0) {
    throw new Error(lastError(handle.stderrText()) ?? "Search returned no results.");
  }

  const queryTokens = tokens(q);
  const results: SearchResult[] = [];
  lines.forEach((line, i) => {
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const r = toSearchResult(raw, queryTokens, i);
      if (r) results.push(r);
    } catch {
      /* skip a malformed line */
    }
  });

  // Add grouped channel rows so "channels" is searchable without a 2nd query.
  for (const c of synthesizeChannels(results, queryTokens)) {
    if (!results.some((r) => r.kind === "channel" && r.id === c.id)) results.push(c);
  }

  // Match algorithm: primary sort is relevance score, ties break by views.
  // Explicit sort=views / recent overrides for users who want charts.
  const sorted = [...results].sort((a, b) => {
    if (sort === "views") return (b.viewCount ?? 0) - (a.viewCount ?? 0);
    if (sort === "recent") return b.score - a.score;
    if (b.score !== a.score) return b.score - a.score;
    return (b.viewCount ?? 0) - (a.viewCount ?? 0);
  });

  const response: SearchResponse = {
    query: q,
    count: sorted.length,
    truncated: lines.length >= capped,
    results: sorted,
  };
  cacheSet(cacheKey, response);
  return response;
}
