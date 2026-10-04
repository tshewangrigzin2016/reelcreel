import type { SearchKind, SearchResult } from "@shared/types";

export type ExploreFilter =
  | "all"
  | "video"
  | "short"
  | "channel"
  | "playlist"
  | "live";

export const FILTERS: { id: ExploreFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "video", label: "Videos" },
  { id: "short", label: "Shorts" },
  { id: "channel", label: "Channels" },
  { id: "playlist", label: "Playlists" },
  { id: "live", label: "Live" },
];

export function filterResults(
  results: SearchResult[],
  filter: ExploreFilter,
): SearchResult[] {
  if (filter === "all") return results;
  return results.filter((r) => r.kind === (filter as SearchKind));
}

/** Client-side re-rank: exact phrase in title first, then score, then views. */
export function rankResults(
  results: SearchResult[],
  query: string,
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return results;
  return [...results].sort((a, b) => {
    const aExact = a.title.toLowerCase().includes(q) ? 1 : 0;
    const bExact = b.title.toLowerCase().includes(q) ? 1 : 0;
    if (aExact !== bExact) return bExact - aExact;
    if (b.score !== a.score) return b.score - a.score;
    return (b.viewCount ?? 0) - (a.viewCount ?? 0);
  });
}
