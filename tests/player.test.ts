import { test, expect } from "bun:test";
import {
  contentTypeForExt,
  parseRangeHeader,
} from "../server/lib/media";
import {
  normalizePreviewQuality,
  previewFormatFor,
} from "../server/lib/preview";

test("contentTypeForExt maps streamable containers", () => {
  expect(contentTypeForExt("mp4")).toBe("video/mp4");
  expect(contentTypeForExt("MP3")).toBe("audio/mpeg");
  expect(contentTypeForExt("webm")).toBe("video/webm");
  expect(contentTypeForExt("exe")).toBeNull();
  expect(contentTypeForExt("srt")).toBeNull();
});

test("parseRangeHeader handles open, closed, and suffix ranges", () => {
  expect(parseRangeHeader("bytes=0-", 100)).toEqual({ start: 0, end: null });
  expect(parseRangeHeader("bytes=10-20", 100)).toEqual({ start: 10, end: 20 });
  // End clamps to the file size.
  expect(parseRangeHeader("bytes=90-999", 100)).toEqual({ start: 90, end: 99 });
  // Suffix range: last 10 bytes.
  expect(parseRangeHeader("bytes=-10", 100)).toEqual({ start: 90, end: null });
  expect(parseRangeHeader(null, 100)).toBeNull();
  expect(parseRangeHeader("bytes=200-300", 100)).toBeNull();
  expect(parseRangeHeader("garbage", 100)).toBeNull();
});

test("previewFormatFor requests a single progressive stream", () => {
  const best = previewFormatFor("best");
  expect(best).toContain("[acodec!=none]");
  expect(best).toContain("[vcodec!=none]");
  const capped = previewFormatFor("720");
  expect(capped).toContain("height<=720");
  expect(capped).toContain("[acodec!=none]");
  expect(previewFormatFor("nonsense")).toBe(previewFormatFor("best"));
});

test("normalizePreviewQuality accepts only known values", () => {
  expect(normalizePreviewQuality("720")).toBe("720");
  expect(normalizePreviewQuality("best")).toBe("best");
  expect(normalizePreviewQuality("1080p")).toBe("best");
  expect(normalizePreviewQuality(undefined)).toBe("best");
});
