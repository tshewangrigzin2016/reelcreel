import { describe, expect, test } from "bun:test";
import {
  contentDisposition,
  contentTypeForExt,
  fileSize,
  isMediaExt,
  parseRangeHeader,
} from "../server/lib/media";
import { clientIp, consume, resetRateLimits } from "../server/lib/rate-limit";

describe("content types", () => {
  test("maps every container the presets can produce", () => {
    expect(contentTypeForExt("mp4")).toBe("video/mp4");
    expect(contentTypeForExt(".mkv")).toBe("video/x-matroska");
    expect(contentTypeForExt("WEBM")).toBe("video/webm");
    expect(contentTypeForExt("m4a")).toBe("audio/mp4");
    expect(contentTypeForExt("mp3")).toBe("audio/mpeg");
    expect(contentTypeForExt("opus")).toBe("audio/ogg");
    expect(contentTypeForExt("flac")).toBe("audio/flac");
  });

  test("maps sidecar caption formats", () => {
    expect(contentTypeForExt("vtt")).toBe("text/vtt");
    expect(contentTypeForExt("srt")).toBe("application/x-subrip");
    expect(contentTypeForExt("ass")).toBe("text/x-ssa");
    expect(contentTypeForExt("ttml")).toBe("application/ttml+xml");
    expect(contentTypeForExt("json3")).toBe("application/json");
  });

  test("returns null for anything it should not serve", () => {
    expect(contentTypeForExt("exe")).toBeNull();
    expect(contentTypeForExt("")).toBeNull();
    expect(contentTypeForExt("html")).toBeNull();
  });

  test("separates media extensions from caption extensions", () => {
    expect(isMediaExt("mp4")).toBe(true);
    expect(isMediaExt(".flac")).toBe(true);
    expect(isMediaExt("vtt")).toBe(false);
  });
});

describe("range parsing", () => {
  test("no header means send the whole file", () => {
    expect(parseRangeHeader(null, 100)).toBeNull();
    expect(parseRangeHeader(undefined, 100)).toBeNull();
    expect(parseRangeHeader("", 100)).toBeNull();
  });

  test("parses a closed range", () => {
    expect(parseRangeHeader("bytes=0-99", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRangeHeader("bytes=10-19", 100)).toEqual({
      start: 10,
      end: 19,
    });
  });

  test("clamps an end beyond the file instead of trusting it", () => {
    expect(parseRangeHeader("bytes=90-500", 100)).toEqual({
      start: 90,
      end: 99,
    });
  });

  test("parses an open-ended range", () => {
    expect(parseRangeHeader("bytes=50-", 100)).toEqual({
      start: 50,
      end: null,
    });
  });

  test("parses a suffix range, which is how players probe duration", () => {
    expect(parseRangeHeader("bytes=-10", 100)).toEqual({ start: 90, end: null });
    // A suffix larger than the file is the whole file.
    expect(parseRangeHeader("bytes=-500", 100)).toEqual({ start: 0, end: null });
  });

  test("rejects what it does not serve so the caller can send everything", () => {
    // Multi-range: not worth implementing, and answering it wrongly is worse.
    expect(parseRangeHeader("bytes=0-10,20-30", 100)).toBeNull();
    expect(parseRangeHeader("items=0-10", 100)).toBeNull();
    expect(parseRangeHeader("bytes=", 100)).toBeNull();
    expect(parseRangeHeader("bytes=abc-def", 100)).toBeNull();
    // Start at or past the end: a 416, not a clamp to an empty body.
    expect(parseRangeHeader("bytes=100-200", 100)).toBeNull();
    expect(parseRangeHeader("bytes=-0", 100)).toBeNull();
    // Reversed range.
    expect(parseRangeHeader("bytes=50-10", 100)).toBeNull();
  });

  test("tolerates surrounding whitespace", () => {
    expect(parseRangeHeader("  bytes=5-9  ", 100)).toEqual({ start: 5, end: 9 });
  });
});

describe("content disposition", () => {
  test("always asks the browser to save rather than navigate", () => {
    expect(contentDisposition("video.mp4")).toStartWith("attachment;");
  });

  test("keeps an ASCII name in both parameters", () => {
    const header = contentDisposition("Big Buck Bunny [dQw4w9WgXcQ].mp4");
    expect(header).toContain('filename="Big Buck Bunny [dQw4w9WgXcQ].mp4"');
    expect(header).toContain(
      "filename*=UTF-8''Big%20Buck%20Bunny%20%5BdQw4w9WgXcQ%5D.mp4",
    );
  });

  test("a non-ASCII title must not produce an invalid header", () => {
    // YouTube titles are full of these; a raw value would throw when the
    // response headers are constructed.
    const header = contentDisposition("日本語のタイトル 🎬.mp4");
    expect(header).not.toMatch(/[^\x20-\x7e]/);
    // The real name survives percent-encoded, so modern browsers still get it.
    expect(header).toContain("filename*=UTF-8''");
    expect(header).toContain(encodeURIComponent("日本語のタイトル 🎬.mp4"));
  });

  test("quotes and backslashes cannot break out of the parameter", () => {
    const header = contentDisposition('evil"; rm -rf /.mp4');
    // The quote that would have terminated the parameter early is replaced, so
    // the value stays a single quoted string.
    expect(header).toContain('filename="evil_; rm -rf /.mp4"');
    expect(header.match(/"/g)?.length).toBe(2);
  });

  test("control characters are stripped", () => {
    const header = contentDisposition("bad\r\nname.mp4");
    expect(header).not.toContain("\r");
    expect(header).not.toContain("\n");
  });

  test("an empty name still produces a usable filename", () => {
    expect(contentDisposition("")).toContain('filename="media"');
  });
});

describe("fileSize", () => {
  test("reports null for a path that cannot be read", () => {
    expect(fileSize("C:/definitely/not/here.mp4")).toBeNull();
  });
});

describe("client address", () => {
  const headers = (init: Record<string, string>) => new Headers(init);

  test("ignores forwarding headers unless the proxy is trusted", () => {
    delete process.env.TRUST_PROXY;
    expect(
      clientIp(headers({ "x-forwarded-for": "1.2.3.4" }), "127.0.0.1"),
    ).toBe("127.0.0.1");
  });

  test("uses the first forwarded address when the proxy is trusted", () => {
    process.env.TRUST_PROXY = "1";
    try {
      expect(
        clientIp(
          headers({ "x-forwarded-for": "1.2.3.4, 10.0.0.1" }),
          "127.0.0.1",
        ),
      ).toBe("1.2.3.4");
      expect(clientIp(headers({ "x-real-ip": "5.6.7.8" }), "127.0.0.1")).toBe(
        "5.6.7.8",
      );
      expect(clientIp(headers({}), "127.0.0.1")).toBe("127.0.0.1");
    } finally {
      delete process.env.TRUST_PROXY;
    }
  });
});

describe("rate limiting", () => {
  test("allows up to the limit then reports a wait", () => {
    resetRateLimits();
    for (let i = 0; i < 3; i++) expect(consume("k", 3)).toBe(0);
    const wait = consume("k", 3);
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(60);
  });

  test("counts each key separately, so one visitor cannot spend another's budget", () => {
    resetRateLimits();
    expect(consume("a", 1)).toBe(0);
    expect(consume("b", 1)).toBe(0);
    expect(consume("a", 1)).toBeGreaterThan(0);
  });

  test("a limit of zero disables limiting entirely", () => {
    resetRateLimits();
    for (let i = 0; i < 100; i++) expect(consume("k", 0)).toBe(0);
  });
});
