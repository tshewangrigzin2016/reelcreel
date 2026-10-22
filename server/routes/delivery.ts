import { Hono } from "hono";
import path from "node:path";
import {
  beginStream,
  completeStream,
  deliveryEnabled,
  deliveryFile,
  deliveryInfo,
  failStream,
} from "../lib/delivery";
import { contentDisposition, contentTypeForExt, parseRangeHeader } from "../lib/media";

/**
 * Handing a finished file to the browser.
 *
 * Deliberately a plain navigation download rather than a `fetch` in the client:
 * `Content-Disposition: attachment` lets the browser's own download manager
 * stream the body straight to disk, so a 4K file never sits in a JavaScript
 * blob and a dropped connection is resumed with a Range request instead of
 * starting over.
 *
 * The one thing the browser cannot tell us is whether it kept the file, so
 * completion is detected here, from the stream itself: the response body is
 * wrapped in a counting stream and the delivery is marked complete only when
 * every promised byte has been handed to the socket. If the client disconnects
 * first the stream errors or cancels, and the attempt is counted against the
 * job. That is the only signal a crashed tab leaves.
 */
export const deliveryRoutes = new Hono();

deliveryRoutes.get("/jobs/:id/download", (c) => {
  const id = c.req.param("id");
  if (!/^[0-9a-f-]{36}$/i.test(id))
    return c.json({ error: "Unknown job." }, 404);
  if (!deliveryEnabled())
    return c.json(
      { error: "This server saves files instead of sending them to the browser." },
      404,
    );

  const index = Math.max(0, Math.floor(Number(c.req.query("file") ?? "0")) || 0);
  const info = deliveryInfo(id);
  if (!info) return c.json({ error: "Nothing to download for this job." }, 404);
  if (info.state === "delivered" || info.state === "expired")
    return c.json(
      {
        error: "This download is no longer available on the server.",
        deliveryState: info.state,
      },
      409,
    );
  if (index >= info.files.length)
    return c.json({ error: "Unknown file for this job." }, 404);

  const file = deliveryFile(id, index);
  if (!file)
    return c.json(
      { error: "The finished file is no longer on the server." },
      404,
    );

  const ext = path.extname(file.name);
  const contentType = contentTypeForExt(ext) ?? "application/octet-stream";
  const size = file.sizeBytes;

  const range = parseRangeHeader(c.req.header("range"), size);
  if (c.req.header("range") && !range)
    return new Response(null, {
      status: 416,
      headers: { "content-range": `bytes */${size}` },
    });

  const start = range ? range.start : 0;
  const end = range ? (range.end ?? size - 1) : size - 1;
  const length = end - start + 1;
  // A ranged continuation is the same delivery attempt, not a new one. Only a
  // fresh whole-file request starts a new stream, so a resumed download does not
  // burn through the attempt limit.
  if (!range || start === 0) beginStream(id);

  const stream = countStream(
    Bun.file(file.path).slice(start, end + 1).stream(),
    length,
    {
      // Only a request that promised the whole file can complete the delivery;
      // a range probe from a media element must not delete the media.
      onComplete: () => {
        if (start === 0 && end === size - 1) completeStream(id, index);
      },
      onAbort: (reason) => {
        // A dropped connection mid-body is a real failure. A client that
        // disconnects before any byte moves is usually a cancelled navigation,
        // which is still worth counting -- it is exactly the crashed-tab case.
        failStream(id, reason);
      },
    },
  );

  const headers: Record<string, string> = {
    "content-type": contentType,
    "content-disposition": contentDisposition(file.name),
    "accept-ranges": "bytes",
    "content-length": String(length),
    // Transient by definition: caching would defeat the delete-on-delivery
    // rule and leak media into a shared proxy.
    "cache-control": "no-store",
  };
  if (range)
    headers["content-range"] = `bytes ${start}-${end}/${size}`;

  return new Response(stream, { status: range ? 206 : 200, headers });
});

/**
 * Wraps a byte stream so delivery completion can be observed.
 *
 * `Bun.file().stream()` gives no signal for "the consumer read everything", and
 * the HTTP layer gives none either -- a response that ends normally and one the
 * client tore down look identical from inside the handler unless the body is
 * instrumented. Counting is the only reliable way to distinguish "sent" from
 * "started".
 */
function countStream(
  source: ReadableStream<Uint8Array>,
  expected: number,
  hooks: { onComplete: () => void; onAbort: (reason: string) => void },
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let sent = 0;
  let settled = false;

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    fn();
  };

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          settle(() => {
            if (sent >= expected) hooks.onComplete();
            else hooks.onAbort("The connection closed before the file was sent.");
          });
          controller.close();
          return;
        }
        sent += value.byteLength;
        controller.enqueue(value);
      } catch (error) {
        settle(() =>
          hooks.onAbort(
            error instanceof Error
              ? "The transfer was interrupted."
              : "The transfer failed.",
          ),
        );
        controller.error(error);
      }
    },
    cancel(reason) {
      settle(() => hooks.onAbort("The browser cancelled the download."));
      void reader.cancel(reason).catch(() => undefined);
    },
  });
}
