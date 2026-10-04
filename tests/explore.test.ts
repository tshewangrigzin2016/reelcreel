import { test, expect } from "bun:test";
import { scoreResult } from "../server/lib/search";
import { toListableUrl } from "../server/lib/listing";
import { filterResults, rankResults } from "../src/lib/search";
import type { SearchResult } from "../shared/types";

const base: SearchResult = {
  id: "x",
  kind: "video",
  title: "t",
  thumbnail: "th",
  url: "u",
  score: 0,
};

test("scoreResult rewards exact title matches over popularity alone", () => {
  const exact = scoreResult(["lofi", "beats"], "Lofi Beats to Relax", "Chill", undefined, 1000);
  const popularMiss = scoreResult(["lofi", "beats"], "Cooking Show", "Food", undefined, 50_000_000);
  expect(exact).toBeGreaterThan(popularMiss);
});

test("scoreResult gives channel match partial credit", () => {
  const withChannel = scoreResult(["mkbhd"], "Some Phone Review", "MKBHD", undefined, undefined);
  const without = scoreResult(["mkbhd"], "Some Phone Review", "Other", undefined, undefined);
  expect(withChannel).toBeGreaterThan(without);
});

test("filter + rank keeps exact phrase first", () => {
  const results: SearchResult[] = [
    { ...base, id: "a", kind: "video", title: "Cooking Show", score: 90 },
    { ...base, id: "b", kind: "short", title: "lofi beats mix", score: 70 },
    { ...base, id: "c", kind: "channel", title: "Lofi Girl", score: 60 },
  ];
  expect(filterResults(results, "short").map((r) => r.id)).toEqual(["b"]);
  expect(rankResults(results, "lofi beats")[0].id).toBe("b");
});

test("toListableUrl normalizes channels to /videos and keeps playlists", () => {
  expect(toListableUrl("https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw")).toBe(
    "https://www.youtube.com/channel/UC_x5XG1OV2P6uZZ5FSM9Ttw/videos",
  );
  expect(toListableUrl("https://www.youtube.com/@LofiGirl")).toBe(
    "https://www.youtube.com/@LofiGirl/videos",
  );
  expect(toListableUrl("https://www.youtube.com/@LofiGirl/videos")).toBe(
    "https://www.youtube.com/@LofiGirl/videos",
  );
  expect(
    toListableUrl("https://www.youtube.com/playlist?list=PL123"),
  ).toContain("list=PL123");
  expect(() =>
    toListableUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"),
  ).toThrow();
});
