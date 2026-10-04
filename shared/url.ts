const ID = /^[0-9A-Za-z_-]{11}$/;
const HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "www.youtu.be",
]);
function parsed(input: string): URL | null {
  try {
    const u = new URL(input.trim());
    return ["http:", "https:"].includes(u.protocol) &&
      HOSTS.has(u.hostname.toLowerCase()) &&
      !u.username &&
      !u.password &&
      !u.port
      ? u
      : null;
  } catch {
    return null;
  }
}
export function extractVideoId(input: string): string | null {
  if (ID.test(input.trim())) return input.trim();
  const u = parsed(input);
  if (!u) return null;
  const parts = u.pathname.split("/").filter(Boolean);
  const id = u.hostname.endsWith("youtu.be")
    ? parts[0]
    : (u.searchParams.get("v") ??
      (["shorts", "embed", "live", "v"].includes(parts[0]) ? parts[1] : null));
  return id && ID.test(id) ? id : null;
}
export function normalizeUrl(input: string): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  if (ID.test(s)) return "https://www.youtube.com/watch?v=" + s;
  const u = parsed(s);
  if (!u) return null;
  const list = u.searchParams.get("list");
  if (
    !extractVideoId(s) &&
    !(u.pathname === "/playlist" && list && /^[A-Za-z0-9_-]+$/.test(list))
  )
    return null;
  for (const p of [
    "index",
    "pp",
    "t",
    "feature",
    "si",
    "ppwg",
    "src_vid",
    "start_radio",
    "ab_channel",
  ])
    u.searchParams.delete(p);
  u.hash = "";
  u.protocol = "https:";
  return u.toString();
}
export function isPlaylistUrl(input: string): boolean {
  return !!parsed(input)?.searchParams.get("list");
}
export function looksLikeUrl(input: string): boolean {
  return normalizeUrl(input) !== null;
}
export function hadRadioList(input: string): boolean {
  return /^RD/i.test(parsed(input)?.searchParams.get("list") ?? "");
}
