# Reelcreel — keep every reel.

A personal, loopback-only YouTube downloader using React, Bun, Hono, SQLite, yt-dlp and FFmpeg.

## Setup

Install Bun, yt-dlp, FFmpeg (including ffprobe), and Node.js. Deno is an optional alternative JavaScript runtime. Use a yt-dlp distribution containing its EJS component, or install its default Python dependencies. Settings → Binaries reports the detected tools and solver component.

From this directory:

```sh
bun install
bun run dev
```

Open the Vite address printed in the terminal (normally localhost:5173). The API listens on 127.0.0.1:8787. The development proxy preserves the browser origin; exposing this service on a public interface is not supported.

If Vite selects another frontend port, such as 5174, use that printed address. API requests and the live queue stream also work through the alternate port. Run one `bun dev` session per data directory. If the API port is occupied, startup reports the conflict and stops the new frontend; use the existing session or stop it with Ctrl+C before restarting. `PORT` changes both the API listener and the development proxy target. For a separate instance, also set a separate `YTD_DATA_DIR`.

For one process serving the production build:

```sh
bun run build
bun start
```

Open 127.0.0.1:8787. Set PORT to change the API port. YTD_DATA_DIR selects a separate SQLite data directory; the default is ./data. The default media destination is ./downloads and can be changed in Settings.

## Downloading

- Paste a YouTube video or playlist URL. Playlist caps and truncation remain visible. Each selected entry becomes an individual job.
- Presets choose the container and codecs. M4A copies native AAC; native Opus is delivered as WebM. Native bitrate depends on the source.
- **Batch paste and text import** sits directly under the URL box, as a second way to supply links. Pasting a list **loads** those videos into the selection table instead of queueing them: each URL is resolved to a real title, duration, thumbnail and view count, so you pick the rows you want, choose the format and quality from the format card, and only then press Download. It is the same table, format card, re-check and download button a playlist URL gets. A link the server cannot read is listed under the batch heading rather than becoming a failed job. Duplicate and invalid rows are still reported per line, and an optional run time schedules the whole batch.
- The format card sits immediately below it and is always present. It carries the preset tabs, the option switches, **Quality and captions** (resolution cap, preferred audio language, caption source, caption output), the destination, and a **Source formats and captions** disclosure that inspects what a loaded single video actually offers. Language preference falls back to available audio when the preferred language is unavailable. One format choice therefore drives the URL box, a pasted batch, .txt import, a single video, a playlist selection and the library alike.
- Subtitle controls distinguish manual/automatic captions and embedded/separate output. Audio-only presets require separate captions.
- In the selection table, the **Download** button and the re-validation banner sit in a sticky action bar beneath the rows. Selecting videos and starting them are the same gesture, with no scroll back up. For a single video there is no table to scroll past, so its Download button stays in the video card.
- The header toggle switches the selection table and the queue between **list** and **grid**; the choice is remembered.
- Authentication is optional. Settings accepts an explicitly chosen local Netscape-format cookies file. Cookie contents are never stored in job requests, and diagnostic lines redact credentials and URLs.

## Queue and files

Requests, order, attempts and lifecycle transitions are stored in SQLite. Pause and cancel terminate active work and preserve partial transfers. Resume and retry use the saved request. Bulk actions — Pause all, Resume paused, Retry failed, Cancel all and Clear finished — are above the queue. Each row shows a thumbnail, the title, a live speed/size/ETA line while transferring, a progress bar, and two icon actions on the right: pause plus delete while work is in flight, becoming reveal plus remove once the row has settled, and resume or retry for a paused or failed row.

**Concurrent downloads** is the number of real, simultaneous network transfers, for every preset including MP3 and FLAC. Transfers are not additionally split into parallel fragments, so the total connection count is exactly this number. **Concurrent probes** separately bounds source probes and file inspection. **Heavy conversions at once** applies only to FFmpeg remux/re-encode jobs that reuse a file already on disk; downloads encode the media they transfer and are not gated by it.

After restart, every unfinished or scheduled job is **paused for review**. Resume continues transfers supported by yt-dlp; interrupted post-processing may restart from retained source files. Scheduled jobs run only while the service is running. Missed schedules do not automatically start on restart.

Each job owns a directory under the selected output folder's .yt-staging directory. A successful process must report a final file, pass media inspection and save history before the job becomes Done. Final filenames are allocated with exclusive creation, preserving existing files. Completed staging is cleaned only after its canonical job ownership is verified; failed or paused staging is retained. Removing a queue row does not delete retained files or completed media.

Do not manually modify staging while its job is active. After removing an unwanted paused/cancelled job, its retained staging folder can be removed manually to reclaim space.

Duplicate skips require fresh source verification and a matching inspected file. Conversion additionally requires explicit original stream provenance; SponsorBlock cuts, previously encoded media and legacy unknowns do not qualify as untouched full sources. Older records remain marked **Unverified source**.

## Library

The Library supports search, preset filtering and pagination across all records. Open and Reveal act on a recorded media file. **Remove history record** leaves the file on disk; **Delete media** explicitly deletes the verified file and leaves the record marked missing.

**Preview library updates** starts a cancellable background check. Review the checked, failed and unchecked counts before applying verified updates. Applying queues jobs that perform their own final verification. The legacy /api/history endpoint still returns its original maximum of 200 rows; /api/library is the paginated interface.

## Storage and API compatibility

SQLite migration version 1 adds queue, profile and provenance storage. Existing databases receive a consistent before-v1-TIMESTAMP.db backup through SQLite before migration. Existing history and settings are preserved. Keep backups separately before manual database maintenance.

All API mutations require Content-Type: application/json, including empty POST/DELETE requests. Browser requests must have the same local Origin and Host. Local CLI requests without Origin are supported. Only recognized YouTube video/playlist URLs and preset IDs are accepted; invalid batches are rejected before any jobs start. `POST /api/probe/batch` takes `{ urls: string[] }` of individual video URLs (1–500; a playlist link is rejected, since a batch line is one video) and returns `{ entries, errors }` without queueing anything.

Existing cancel/retry routes remain. Retry uses the saved request; submit a new job to change a request. Added routes include:

| Route                                       | Purpose                                         |
| ------------------------------------------- | ----------------------------------------------- |
| POST /api/probe/batch                       | Resolve a pasted list of video URLs to entries  |
| POST /api/jobs/:id/pause, /resume           | Pause or resume a job                           |
| POST /api/queue/reorder                     | Set queue order with an ids array               |
| POST /api/queue/bulk                        | pause, resume, retry-failed or cancel           |
| GET /api/library?q=&preset=&page=&pageSize= | Search and paginate records                     |
| POST /api/library/:id/open                  | Open file; reveal:true selects it in its folder |
| DELETE /api/library/:id/media               | Explicitly delete a verified media file         |
| GET /api/formats?url=                       | Source formats and captions                    |
| GET/POST/DELETE /api/profiles               | Saved profiles (see note)                      |
| POST /api/sync/start                        | Start a preview                                 |
| GET /api/sync/:id                           | Preview progress and result                     |
| POST /api/sync/:id/cancel, /apply           | Cancel or apply a preview                       |

The SSE job feed sends reconnect snapshots, job deltas, removal events and library-change events. Progress does not invalidate library queries.

Two endpoints are kept but have no interface: `POST /api/queue/reorder` lost its last caller when the per-row Move up control was dropped, and the `/api/profiles` routes have no UI since the saved-profile strip was removed. They still work and the storage is still there.

## Verification

```sh
bun run typecheck
bun test tests
bun run build
bun run test:browser
```

The normal suite includes isolated SQLite, subprocess and runner tests. Integration fixtures require yt-dlp, FFmpeg, ffprobe and Node on PATH. They generate a one-second test video and use offline format metadata; they do not download YouTube media or modify the user's library. Restart recovery is checked in a separate Bun process.

The browser suite starts its own service with temporary data and a free port. It currently uses the Windows Chrome installation at C:/Program Files/Google/Chrome/Application/chrome.exe; adjust verification/browser.mjs for another installation. It checks settings errors, accessible dropdown names and keyboard interaction, two-tab removal convergence, progress-fetch behavior, batch review, library traversal, keyboard dialog dismissal and screenshots in both themes. Screenshots are written to the ignored .test-artifacts directory.

Live YouTube transfer behavior, account-specific authentication, and provider-specific captions remain dependent on the installed yt-dlp release and source availability. These are not exercised by the offline regression suite. See [docs/PROJECT_RESEARCH.md](docs/PROJECT_RESEARCH.md) for the implementation record and verification evidence.

## Project layout

```
src/            React frontend (components, hooks, client state)
server/         Bun + Hono API, job runner, SQLite storage
shared/         Types and validation shared by both sides
tests/          Maintained Bun test suite
verification/   Browser verification harness
brand/          Logo and icon assets
docs/           Research and design records
data/           Runtime SQLite data (ignored)
downloads/      Default media destination (ignored)
```

See [docs/README.md](docs/README.md) for the contents of that directory.
