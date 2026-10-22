# Media is delivered to the browser, not kept on the server

Reelcreel was written as a loopback-only downloader: a job ended by copying a
finished file into `outputDir`, and every interesting feature — skip-existing,
convert-instead, open/reveal, the library's `missing` flag — reads that file back
off the disk later. To host it on a small VPS, the finished file has to reach the
visitor's machine and then stop existing on the server. So a job's media is
streamed out through `GET /api/jobs/:id/download` and deleted once the last byte
has been sent, with the attempt limit, time limit, size cap and startup sweep
covering the case where the browser never asks for it.

The file does transit the VPS disk. That is unavoidable: YouTube refuses to serve
a merged audio+video stream to a browser, and MP4 merging plus ffmpeg
post-processing can only happen server-side. What "not on the VPS" means here is
*not retained* on the VPS, with peak usage of one in-flight file per concurrent
transfer.

## Considered Options

- **Hand the browser a direct YouTube URL.** No server bandwidth and no file at
  all, but anything above 720p needs separate audio and video streams merged,
  the URLs are IP-bound and expire, and CORS blocks most of them. Rejected
  because it caps quality hard and the merge is impossible client-side.
- **Pipe yt-dlp's stdout straight to the response.** No disk usage at all, but
  there is no MP4 merge, no ffmpeg post-processing, no subtitle or thumbnail
  embedding, and no resume — and pause/retry stop working, since there is
  nothing on disk to resume from.
- **Keep files and let the user delete them.** This is the current behaviour and
  it is what fills the VPS disk.
- **Zip a playlist into one download.** One browser download per batch, at the
  cost of building the archive on the VPS, losing per-file progress and resume,
  and making partial failures opaque.

## Consequences

- Skip-existing and convert-instead are meaningless in browser mode and are
  hidden rather than left inert; every browser-mode request fetches fresh.
- `done` keeps its existing meaning ("media produced and verified"). Delivery is
  a separate `deliveryState` field, so the terminal-phase set, the row badge
  ladder and every phase-based test are unaffected.
- Sidecar captions cannot be embedded in a stream, so they are delivered as
  additional sequential downloads rather than being silently dropped.
- The library degrades to a history log. No React surface reads it today, so
  nothing had to be removed.
- Access control is delegated to the hosting provider by explicit decision. The
  app's own guards are the `PUBLIC_ORIGIN` same-origin check, a per-IP rate
  limit and a per-IP queue cap — anyone with the URL can download video.
