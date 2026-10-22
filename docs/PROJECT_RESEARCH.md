# Project research and implementation record

Created September 10, 2026 before further investigation. The supplied review is the source of intent. Entries in the following section were previously collected by another agent, not discovered contemporaneously here. Implementation evidence and acceptance results will be appended as work proceeds.

## Previously collected findings

| Finding / evidence                                                                                                       | Impact                                            | Recommendation                                                | Priority | Effort | Acceptance check                                                 |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------- | -------- | ------ | ---------------------------------------------------------------- |
| Settings update binds undefined to a non-null column (server/lib/db.ts).                                                 | Blank overrides cannot save.                      | Explicit nullable clearing; visible errors.                   | P0       | Small  | Save defaults, set and clear overrides.                          |
| Conversion planner reused a 10-second clip for a 600-second request (server/lib/plan.ts).                                | Incomplete output reported successful.            | Require known, compatible transformation provenance.          | P0       | Medium | Clips and unknown/lossy sources never qualify as full originals. |
| Mocked zero exit without output became Done; startup cancellation missed its process.                                    | Incorrect status and orphan work.                 | Verify output and persistence; cancel across lifecycle.       | P0       | Large  | Missing output fails; cancellation covers every stage.           |
| API accepted malformed URLs, unknown presets, foreign Host/Origin and 99,999 fragments.                                  | Invalid work reaches processes.                   | Shared validation and local request boundary.                 | P0       | Medium | Reject each before spawning.                                     |
| Every jobs update refreshes history after one completion (src/App.tsx).                                                  | Excess fetches/probes.                            | Library-change events and targeted query invalidation.        | P1       | Medium | Progress alone causes zero library requests.                     |
| Inspection timeout waits for streams; sync checks budget before admission.                                               | Deadlines ineffective.                            | Terminate/drain at deadline; check after admission.           | P1       | Medium | Hung fixture killed; queued checks respect deadline.             |
| In-memory jobs; removals unbroadcast; history/sync limited to 200.                                                       | Lost queue and incomplete/divergent library.      | Durable paused recovery, events, pagination, background sync. | P1       | Large  | Restart fixture, two subscribers, >200 records.                  |
| AAC 256 label mismatches args; native Opus container unclear; WebM codecs unconstrained.                                 | Output violates preset contract.                  | Accurate labels and constrained selection.                    | P1       | Medium | Inspect args and actual fixture output.                          |
| Missing field labels and faint contrast near 2.78:1.                                                                     | Keyboard/screen-reader and readability barriers.  | Associated labels, semantics, >=4.5:1 ordinary text.          | P2       | Medium | Both themes and keyboard flows checked.                          |
| Duplicate unused download implementations.                                                                               | Maintenance drift.                                | Remove unused paths after reference checks.                   | P2       | Small  | Typecheck/build/tests.                                           |
| Stale or uncancelled planning responses.                                                                                 | Wrong plan shown for changed input.               | Abort superseded requests and guard response identity.        | P1       | Medium | Rapid input/options changes fixture.                             |
| Client discards playlist truncation information.                                                                         | Hidden omitted items.                             | Retain and display cap metadata.                              | P2       | Small  | Truncated stream visible.                                        |
| Settings/health errors swallowed.                                                                                        | Failures invisible.                               | Actionable errors preserving edits.                           | P1       | Small  | Failure UI check.                                                |
| Conversion pool follows CPU count, ignoring encoder threads.                                                             | Resource overload.                                | Separate heavy-work limit, default one.                       | P1       | Medium | Both download encodes and direct conversion share admission.     |
| Review baseline: typecheck, 45 tests, pool checks, build passed; audit clear; 114 history rows, 30 without fingerprints. | Reference only; not rerun in this implementation. | Reverify with isolated data; legacy rows remain unverified.   | P1       | Medium | Tests and additive backup-backed migrations.                     |

## Roadmap and scope

Implement in order: correctness/local API; lifecycle/performance; durable controllable queue; source-aware quality; batch/library; profiles, subtitles, chapter ranges, scheduling and optional local cookies. Retain React/Bun/Hono/SQLite/yt-dlp/FFmpeg and strict final duplicate verification. Preserve unrelated files and retain job-owned partials. Bind loopback. Capture source provenance from actual downloads when possible. Do not invent provenance for legacy records.

## Prior research sources (checked by previous agent September 10, 2026)

- yt-dlp README at release 2026.08.19: https://github.com/yt-dlp/yt-dlp/blob/2026.08.19/README.md
- EJS runtimes: https://github.com/yt-dlp/yt-dlp/wiki/EJS
- Bun subprocess: https://github.com/oven-sh/bun/blob/main/docs/runtime/child-process.mdx
- Hono CSRF: https://github.com/honojs/website/blob/main/docs/middleware/builtin/csrf.md
- TanStack invalidation: https://github.com/TanStack/query/blob/main/docs/framework/react/guides/query-invalidation.md
- Zustand: https://github.com/pmndrs/zustand
- FFmpeg: https://ffmpeg.org/ffmpeg.html
- YTDLnis: https://github.com/deniscerri/ytdlnis
- WCAG contrast: https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html

## Implementation discoveries and verification

Entries below are collected during implementation.

- **2026-09-10, installed-binary verification:** Offline format selection caught a WebM filter syntax error that unit assertions could not catch: yt-dlp requires the regex value to be quoted inside its filter expression. Corrected both video/audio filters and constrained the combined-stream fallback. A reserved fixture format id was also renamed (yt-dlp prefixes reserved extension names). Priority P1; effort small; acceptance: real installed yt-dlp selects the expected WebM pair, capped H.264 and preferred-language AAC from offline catalogs.

- **2026-09-10, implementation:** Re-read db.ts, runner.ts, queue.ts and API handlers. Confirmed swallowed history-write failures, completion before inspection, cancellation deleting reported output paths, absent queue persistence, and mutation handlers trusting casts. Impact: false completion, unsafe ownership, restart loss. Recommendation implemented in this pass: propagate storage errors, stage outputs, persist lifecycle, and validate requests. Priority P0/P1; effort large; acceptance: isolated regression and restart fixtures plus typecheck/build.
- **2026-09-10, implementation:** Probe normalization handed unparseable strings to yt-dlp; settings validation was normalization only. Shared URL parsing now restricts supported YouTube hosts and validates identity. Priority P0; effort medium; acceptance: hostile host/scheme/id and option boundary tests.

- **2026-09-10, implementation:** The first regression run passed 39/45 original tests. Four positive conversion fixtures lacked the newly required original provenance, so their fixture was updated explicitly (the production rule stays conservative). Added negative clip, SponsorBlock and unknown/encoded provenance cases. Two sync compatibility differences identified: missing URL error code and counting already-active work. Priority P0/P1; effort medium; acceptance: original tests plus new transformation and cancellation tests.
- **2026-09-10, implementation:** Re-read binary resolver: timeout only covered stdout and stderr was not drained. Replaced with managed process cancellation/deadline/drain logic. Configured binary paths now fail explicitly rather than silently choosing another PATH binary. Priority P1; effort medium; acceptance: hung process and startup cancellation fixtures.
- **2026-09-10, implementation:** Library was still tied to the 200-row legacy response. Added a separate paginated query endpoint and UI, preserving legacy history. Sync now reads all rows and reports checked/failed/unchecked separately; background preview precedes apply in UI. Priority P1; effort large; acceptance: 245-row traversal and interrupted sync fixture.

- **2026-09-10, implementation:** Checked the installed release README through its raw GitHub source and local --help. The format sort field lang is an extractor's numeric preference, not a user language code. Replaced the initial language-sort implementation with preferred-language format branches and explicit fallback to ordinary selection. Priority P1; effort small; acceptance: installed yt-dlp format-selection fixture verifies preferred language and resolution caps without network.
- **2026-09-10, implementation:** Original planner suite now passes 51 cases. Isolated suites pass 10 core and 10 lifecycle cases, using a generated one-second FFmpeg video and temporary SQLite directories. Covered missing/invalid output, actual inspection, history-failure recovery, collision safety, admission/startup/probe/conversion cancellation, retained partials, and a separate-process paused restart. No existing library or media files were modified by these tests. Production build and typecheck passed before subsequent browser-test refinements.

- **2026-09-10, implementation:** A local health call exposed that --verbose --version suppresses yt-dlp's dependency diagnostics, incorrectly reporting EJS absent. The no-URL --verbose --simulate diagnostic reports bundled yt_dlp_ejs-0.8.0. Health now uses that offline diagnostic and explicitly selects the configured runtime after clearing yt-dlp runtime defaults. Priority P1; effort small; acceptance: local health reports the bundled EJS component and selected Node runtime.
- **2026-09-10, implementation:** Browser automation passed settings round-trip and failed-save value preservation, batch duplicate/invalid URL review, library search/pagination, and two-tab removal convergence. Twenty progress frames at 10 Hz produced zero library/ownership requests; twenty library events coalesced to one request for each ownership query. Screenshots captured in both themes. Priority P1/P2; effort medium; acceptance met in isolated Chromium session.

## Final implementation coverage

| Roadmap                          | Delivered                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correctness and local boundaries | Nullable settings clears, errors preserved, shared runtime validation, local Host/Origin and JSON checks, deterministic argv, provenance restrictions, measured output/history commit, exclusive publication and job-owned cleanup.                                                                                                               |
| Lifecycle and performance        | Abortable admission/process startup/transfer/conversion, killed deadline fixtures, one probe admission point, shared in-flight probes/inspections, separate heavy-work limit, structured progress, bounded/redacted logs, first-download preflight avoidance, cancellable UI planning, targeted Query invalidation and selector-based queue rows. |
| Durable queue                    | Versioned backup-backed SQLite migration, saved requests/order/attempts/staging, paused restart recovery, pause/resume/reorder/retry/bulk actions, partial retention, removal/library events and reconnect snapshots.                                                                                                                             |
| Quality and diagnostics          | Source format/codec/FPS/HDR/language/size discovery, resolution cap, preferred audio language, native AAC and WebM Opus contracts, output-affecting request identity, container warnings, Node/Deno configuration and EJS/ffprobe diagnostics.                                                                                                    |
| Batch and library                | Multiline/text import with review and deduplication, one shared format selector for the whole batch, full-library search/filter/pagination, open/reveal/source/missing status, separate record/media deletion, cancellable sync preview/apply with honest unchecked counts, playlist truncation display, legacy unverified provenance.              |
| Secondary features               | Manual/automatic and sidecar/embedded captions, scheduled queue times with paused restart review, explicit local cookie-file authentication.                                                                                                                                                                                     |
| Maintenance/accessibility        | Associated field labels, named dialog close/progress controls, improved faint/status text contrast, focus styles, removal of three unused server implementations and legacy library component, setup/API/test documentation, ignored runtime artifacts, project-local Git repository on main.                                                     |

## Final verification (September 10, 2026)

- **2026-09-10, final verification follow-up:** A cold ffprobe resolution took 7.1 seconds and exceeded Bun's default five-second test deadline, causing cascading lifecycle-fixture failures. The isolated suite passed all 12 cases with a 20-second test deadline. Inspection also unnecessarily resolved yt-dlp through the aggregate binary resolver. Impact: slow local inspection and brittle integration checks. Recommendation: resolve only FFmpeg/ffprobe for local inspection and give real-process tests a 20-second deadline while retaining subprocess deadlines. Priority P1; effort small; acceptance: complete isolated lifecycle suite and normal test command pass.

- **2026-09-10, final review:** Sync apply counted every returned queue ID as newly queued and used a nonzero count to identify an applied preview. The legacy apply path also matched busy work by video/preset without considering options. Impact: inflated queue counts, repeated zero-work apply, and suppression of different requests. Recommendation: use the runner's full request identity, count only newly created IDs, and track applied state explicitly. Priority P1; effort small; acceptance: duplicate and different-option work, zero-work repeated apply, and enqueue-failure accounting regression cases.

- 82 regression cases passed: 56 original/extended planner and sync cases, 14 isolated core cases, and 12 isolated lifecycle cases. The outer Bun runner reports 58 tests because the isolated suites each appear as one wrapper test. The final normal test command passed in 38 seconds, with the lifecycle suite completing in 5.5 seconds after removing unnecessary yt-dlp resolution from local inspection.
- Actual installed yt-dlp selected capped H.264, preferred-language AAC and codec-constrained WebM from offline metadata. A real yt-dlp transfer from a temporary local HTTP server emitted structured source/progress/final-path records and produced valid video/audio inspected by ffprobe.
- Generated FFmpeg media and temporary SQLite databases exercised collisions, sidecar naming, completed staging cleanup, missing/invalid output, history-write recovery, all cancellation stages, cancelled retry timers and separate-process paused recovery.
- Browser suite passed settings round-trip/error preservation, named native and Radix dropdowns with keyboard interaction, reviewed batch validation, 245-record search/pagination, two-tab removal convergence, 10 Hz progress without library fetches, and coalesced library invalidation. Both themes were visually inspected from screenshots.
- Type checking and production build passed. Library UI is loaded in a separate chunk. Test servers created during verification were shut down; existing user data and media were not used as test targets.
- The production database has not been migrated during this implementation session. Its backup and additive migration occur on the next normal service startup.
- Live YouTube transfers, account-specific cookies, and provider-specific captions were not exercised. The optional authentication and caption paths need suitable authorized live content for provider acceptance testing. No claim of live-provider verification is made.

- Final sync checks passed for existing-job reuse, different options on the same active video, failed enqueue accounting, repeated zero-work apply, repeated successful apply, and recovery from a partially applied preview. Typecheck and production build passed; the final browser run reported no page errors. Transient Prettier use did not add a project dependency.

## UI and concurrency rework (September 29, 2026)

### Concurrency

- **2026-09-29, analysis:** Three defects compounded behind a "Concurrent downloads" setting that never delivered it. `pump()` gated admission on `pools.download.limit` while `active` held jobs for their whole pipeline, so a job spent its slot running `planDownload()` and `verifyOutput()` rather than transferring. `execute()` wrapped the transfer in `pools.ffmpeg.run`, whose limit defaults to 1, so any preset where `needsEncoder()` is true — including `mp3-320`, the default audio preset — transferred strictly one at a time. And `fragmentConcurrency: 8` expanded each transfer into eight parallel range requests, so three downloads really opened roughly twenty-four connections. Impact: the setting was decorative, and the symptom users described as "everything downloads at once" was fragment fan-out rather than concurrency. Recommendation: make the transfer pool the sole authority on transfers, lift the CPU gate off the transfer, and remove per-request fan-out. Priority P0; effort medium; acceptance: a pool regression test asserting peak concurrent transfers equal the configured limit for both a remux and an encoder preset.
- **2026-09-29, implementation:** Admission now uses `pipelineCap() = pools.probe.limit + pools.download.limit` so the pipeline can run ahead of the transfer slots; both pools already bound the work that happens outside a transfer, so process count stays bounded and a 500-item backlog waits in `queued`. The ffmpeg wrapper around the transfer was removed: yt-dlp transfers and then encodes inside one process, so a CPU gate either blocks before the process spawns — holding a slot across the whole transfer — or does not gate that job at all, and the latter was chosen. `pools.ffmpeg` now bounds only the `action === "convert"` remux path and library-sync conversions, and its Settings hint was corrected to say so. Its maximum was deliberately left at 4 rather than raised, since raising it was optional and only loosens a bound. Combined with dropping `-N 8`, total connection count is now exactly the configured number. Priority P0; effort medium; acceptance: three new lifecycle cases, each confirmed to fail on the pre-fix code with a clear assertion rather than a timeout.
- **2026-09-29, correction:** The planned phase label used `pools.download.pending > 0` to decide a job was waiting. That is a snapshot of *other* waiters, so the first job to enqueue saw an empty queue and kept reporting "probing" while it sat in the pool — the exact mislabelling the change was meant to fix. Replaced with `pools.download.running >= pools.download.limit`, which is evaluated in the same synchronous block as the `acquire` that follows and therefore means precisely "this job is about to wait". Impact: one job per saturated batch was mislabelled. Priority P1; effort small; acceptance: a lifecycle case asserting no job reports "probing" while another is transferring.

### Clip and limits removal

- **2026-09-29, analysis:** Chapter-range clipping, the accurate-cut toggle, per-request speed limit and per-request fragment count were removed end to end. `DownloadOptions` lost all five keys and `Settings` lost two. `RequestKeyParts` deliberately keeps `clipStart`/`clipEnd`/`accurateClips`, marked legacy read-only: `plan.ts:untouchedSourceCopy()` still reads them to classify rows already in SQLite, and a clipped file is not an untouched copy of its source, so those rows must keep being rejected rather than silently reclassified as convertible.
- **2026-09-29, defect found while removing the feature:** `normalizedSettings()` returned `{ ...merged, ...overrides }`, so a `fragmentConcurrency` row already in an existing database survived `GET /api/settings`, the client echoed the whole form back in `PUT /api/settings`, and `settingsUpdate()` rejected it as `Unknown setting` — saving Settings would have broken outright for anyone who had opened the app before this change. Rewritten to build the returned object key by key from the known `Settings` keys, which also closes the same latent hole for any future retired key. Priority P0; effort small; acceptance: a browser assertion that the retired keys are absent from `GET /api/settings` after a save round trip.

### Interface

- **2026-09-29, implementation:** Queue rows were rebuilt as thumbnail, title, a live speed/size/ETA line, a progress bar and two icon actions. The action matrix is phase-first rather than `running`-first: an early draft tested "is this an active phase" and so offered Retry for a paused row, where the browser suite requires a control named exactly "Resume". Per-row Cancel, Move up and the text buttons are gone; bulk actions are unchanged. The removal of per-row Move up leaves `api.reorder` without a UI caller — `POST /api/queue/reorder` is untouched on the server.
- **2026-09-29, implementation:** The selection summary, Download button and re-validation banner moved out of the playlist card into a sticky action bar under the selection table, rendered through a `footer?: ReactNode` slot so the table owns markup and positioning while `App` owns content. The bar sits outside the table's internal scroller, so it behaves identically in both layouts. The count and duration were left in the existing stats bar rather than duplicated into the bar. A single video has no table to scroll past, so its button stayed in the video card.
- **2026-09-29, implementation:** The profile strip and the format picker were hoisted under the URL box and the format card is now always rendered, which is what makes a single format choice drive batch paste. Previously the picker only existed inside a probe result, so pasting a batch left the page with no format control at all and the composer had to carry its own per-row dropdown. The profile selector also gained reverse sync — it compares request keys, so "the profile I picked" and "the profile that produces this file" cannot disagree — and saving re-uses the id of a same-named profile instead of minting a duplicate row.
- **2026-09-29, interface consolidation:** The saved-profile strip and the separate "Quality, captions and source formats" panel were removed at the user's request, and the batch/txt panel was moved up to sit under the URL box, directly above the format card. Rationale: the batch panel was the one place where a per-row format dropdown made the applied format disagree with the format selected elsewhere, and it sat at the bottom of the page, below everything it described. Impact: the resolution cap, preferred audio language and caption source/output controls would have been lost with the panel, so they were folded into the format card as a "Quality and captions" section beside the preset they modify, and the source-format/caption diagnostic became a `Source formats and captions` disclosure inside the same card rather than its own top-level menu. Removing the profile strip also removed the only writer of the per-request destination override, so that state was deleted and downloads fall back to the configured output folder. Priority P1; effort medium; acceptance: typecheck, build, browser suite asserting the two panels are gone, their controls now belong to the format card, and the batch readout tracks the shared format selector; plus a visual pass confirming the new order.
- **2026-09-29, boundary decision recorded:** The `/api/profiles` routes and their SQLite storage were kept even though nothing in the interface calls them any more, mirroring how `POST /api/queue/reorder` was kept when the per-row Move up control was dropped. Removing them would delete a documented endpoint and stored user data, which is a separate decision from removing the interface. Priority P2; effort small; acceptance: README records both endpoints as kept-but-uncalled. The browser suite cannot cover the Section E action bar, because the playlist path needs a live probe and the suite runs offline. The bar was verified manually instead: with the page scrolled past the table, the Download button's box measured `top: 944, bottom: 988` in a 1000px viewport, confirming it pins to the viewport bottom. The queue thumbnail fallback was verified the same way, with image requests forced to fail so all eight rows swapped to the placeholder.

### Verification

- Typecheck, `bun test tests` (62), isolated core (14) and lifecycle (15) suites, the production build and the browser suite all pass with no page errors. The browser suite now also covers retired-key removal on read, the always-present format selector, the profile save/reverse-sync/tab-restore cycle, the batch composer's read-only format with no per-row dropdown, and the grid/list toggle surviving a reload.

## Browser delivery and VPS hosting (October 22, 2026)

The app was built as a loopback-only downloader: a job ended by copying a
finished file into `outputDir`, and every interesting feature — skip-existing,
convert-instead, open/reveal, the library's `missing` flag — read that file back
off disk later. Hosting it on a small VPS meant the finished file had to reach
the visitor's machine and then stop existing on the server. Decision recorded in
[`adr/0001-browser-delivery.md`](adr/0001-browser-delivery.md); vocabulary fixed
in [`../GLOSSARY.md`](../GLOSSARY.md).

- **2026-10-22, design:** The file cannot avoid the server disk. YouTube refuses
  to serve a merged audio+video stream to a browser, and MP4 merging plus FFmpeg
  post-processing can only happen server-side, so a direct-to-browser URL would
  cap quality at the progressive formats and break the preset contract. Piping
  yt-dlp's stdout into the response was rejected for the same reason plus losing
  pause/retry and resume. "Not on the VPS" therefore means *not retained*: the
  media is streamed out and deleted, with peak usage of one in-flight file per
  concurrent transfer. Priority P0; effort large.
- **2026-10-22, implementation — delivery state is orthogonal to phase:**
  `done` keeps its existing meaning ("produced and verified"). Delivery is a
  separate `JobState.delivery` record (`pending` / `streaming` / `failed` /
  `delivered` / `expired`), so the terminal-phase set at `runner.ts:44`, the row
  badge ladder in `src/lib/rows.ts` and every phase-based test were left
  untouched. It rides the existing coalesced `delta` SSE frame, so no new event
  type and no client stream change were needed. Acceptance: the whole existing
  suite passes unchanged.
- **2026-10-22, implementation — the redirect belongs in `startDownload`:** A
  first draft pointed the output directory at the temp dir inside the HTTP
  handler. The lifecycle suite then failed because a job started directly
  through `startDownload` still wrote into the real media folder. Browser mode
  must not depend on a caller remembering to pass the right directory, so the
  redirect moved to `startDownload` — the one choke point every job passes
  through — and `effectiveOutputDir()` derives from the same setting.
  Priority P0; effort small; acceptance: a lifecycle case asserting the job's
  `stagingDir` is under the temp dir even when the request names the media
  folder.
- **2026-10-22, implementation — deleting only staging leaks the media:** The
  first `removeJobMedia` deleted the staging directory and nothing else.
  `publishFile` *copies* out of staging into the output folder, so that left
  every delivered file behind — exactly the leak the feature exists to prevent.
  The delivery tests caught it (a file still present after the third failed
  attempt). Both halves are now removed: the published files by name, and the
  staging directory by path. Priority P0; effort small.
- **2026-10-22, implementation — completion detection:** The browser cannot
  report whether it kept a file, and a response that ends normally is
  indistinguishable from one the client tore down. The response body is wrapped
  in a counting stream and a delivery completes only when every promised byte
  was handed to the socket; a short or cancelled body counts as a failed
  attempt. Attempts are counted server-side because a crashed tab reports
  nothing, which is why the time limit exists as well. Priority P0.
- **2026-10-22, implementation — ranged requests are not attempts:** A
  `Range` continuation is a resume, not a failure. Counting it would let three
  resumed chunks delete a file nobody ever failed to fetch. Only a fresh
  whole-file request starts a stream, and only a whole-file response can
  complete the delivery, so a media-element range probe cannot delete the media.
  Acceptance: a lifecycle case asserting a `206` leaves `attempts` at 0 and a
  `416` for an unsatisfiable range.
- **2026-10-22, implementation — public binding needs an origin:** Binding a
  public interface while keeping the loopback Host allowlist yields a working
  page with a dead API, so the boundary now has two modes chosen by the bind
  address. Loopback keeps its behaviour verbatim. Public mode requires
  `PUBLIC_ORIGIN` and refuses to boot without it, then requires `Origin` to equal
  that origin exactly — a stricter rule, not a looser one. Everything below the
  host/origin check is shared. Priority P0; effort medium; acceptance: the
  existing loopback assertions pass unchanged, plus public-mode accept/reject
  cases and a boot-refusal case.
- **2026-10-22, implementation — abuse limits replace authentication:** By
  explicit decision the app has no user authentication; access control is
  delegated to the hosting provider. The app's own guards are the origin check,
  a per-address fixed-window rate limit on the routes that spawn processes or
  read thousands of rows, and a per-address cap on unfinished jobs. The SSE
  stream is deliberately exempt: throttling it would freeze the queue of anyone
  who left a tab open. `X-Forwarded-For` is only trusted when `TRUST_PROXY=1`,
  because a rate limiter that trusts an unauthenticated header is worse than
  none.
- **2026-10-22, implementation — delivery is claimed per tab:** The set of jobs
  to fetch lives in memory in the client and is never persisted, so reloading
  cannot trigger a burst of downloads for a batch that finished while the tab
  was closed. Those rows render a Download button instead. Fetches are strictly
  sequential with an "N of M" readout, because browsers block or silently drop
  simultaneous downloads.
- **2026-10-22, implementation — Linux bootstrap:** `scripts/setup-linux.sh` is
  idempotent, probes every tool with its version flag first, and never fails
  startup. It installs into `./.bin` and relies on `resolve-binary.ts` walking
  `PATH` — no database writes and no override plumbing. One trap found while
  writing it: validating an install with `command -v` is unsound, because on
  musl/Alpine a glibc binary downloads and `chmod +x` fine but cannot exec, and
  a PATH check can still pass by finding a *different* system copy — leaving a
  dead binary in `./.bin` that shadows everything. The script now executes the
  exact file before moving it into place and prunes an unusable existing one.
- **2026-10-22, pre-existing breakage fixed:** `verification/browser.mjs` still
  clicked a **Library** button that commit `7e0d034` removed when Explore
  replaced that page. Confirmed against a stashed pristine tree: the suite
  failed before any of this work. The block now asserts the paginated
  `/api/library` contract directly (245 fixture rows, search, and the page-2
  remainder), which is what any future library UI would consume.

### Verification

- Typecheck, `bun test tests` (148 across 7 files), the isolated core and
  lifecycle suites (19, including four browser-delivery cases against the real
  runner), the production build and the browser suite all pass with no page
  errors.
- New coverage: `tests/media.test.ts` (MIME table, Range parsing including
  suffix and malformed headers, `Content-Disposition` with non-ASCII and
  quote-breaking names, client address resolution, rate-limit windows),
  `tests/delivery.test.ts` (attempt limit, TTL expiry, size-cap eviction oldest
  first, orphan sweep that spares staging, server-mode no-op, restart recovery,
  and `missing` not being reported for a delivered row), and public-mode
  boundary cases in `tests/startup.test.ts`.
- The lifecycle suite's browser-mode cases prove the central promise end to end:
  the job lands in the temp directory even when the request names the media
  folder, the bytes are fetchable with `Content-Disposition: attachment`, the
  server copy and its staging are gone afterwards, a second fetch is a `409`,
  a ranged request does not consume an attempt, and server mode has no download
  route at all.
- Not verified: no live VPS deployment was performed. The setup script was
  syntax-checked and exercised hermetically with stubbed package managers, and
  the systemd/nginx examples in [`DEPLOYMENT.md`](DEPLOYMENT.md) are written from
  the code's actual requirements — notably that the proxy must forward the
  original `Host`, since the Origin check compares against `PUBLIC_ORIGIN` — but
  they were not run against a real host. Live YouTube transfer behaviour remains
  dependent on the installed yt-dlp release.
