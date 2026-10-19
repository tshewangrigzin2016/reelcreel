# Downloader v0.0.1 — UI + concurrency rework

Six changes to the YouTube downloader:

1. Remove the "Clip & limits" feature (clip range, speed limit, fragments, accurate cuts) entirely.
2. Redesign the queue card to match the video-selection card (thumbnail, title, speed underneath, icon actions on the right).
3. Fix the **Concurrent downloads** setting so the configured number of transfers actually happens.
4. Add a shared Grid/List view controller for the video-selection section and the queue.
5. **Move the selection summary, Download button and re-validation banner out of the format card and into the video-selection table**, as a sticky action bar — so selecting videos and starting them are the same gesture, with no scroll back up.
6. **Hoist the profile dropdowns and the format selector to the top, under the URL box**, and make batch paste / .txt import use that one selector instead of a per-video dropdown.

Stack: React 19 + Vite + Tailwind v4 (frontend), Bun + Hono + SQLite + yt-dlp/FFmpeg (backend), `bun test` + Playwright verification.

---

## Root causes found during exploration

### Concurrency

Three separate defects compound, in `server/lib/runner.ts` and `server/lib/queue.ts`:

1. **`pump():154` gates on job count, not transfer count.**
   `if (active.size >= pools.download.limit) break;` — `active` holds every job inside `execute()`, which spans the *whole* pipeline. A job occupies its "download slot" while running `planDownload()` (a network probe of the source) and while `verifyOutput()` runs ffprobe (`server/lib/ffprobe.ts:484` also goes through `pools.probe`). So the configured N rarely has N real transfers in flight.

2. **`execute():285-287` holds a CPU slot across the entire network transfer.**
   ```ts
   result = needsEncoder(req.presetId, req.options)
     ? await pools.ffmpeg.run(download, signal)
     : await download();
   ```
   `pools.ffmpeg` defaults to **1** (`server/lib/db.ts:343` → `conversionConcurrency: 1`). `needsEncoder()` is true for `mp3-320`, `mp3-v0`, `flac`, plus any job with SponsorBlock or accurate clips. MP3 is the *default audio preset* (`DEFAULT_AUDIO_PRESET = "mp3-320"`), so audio downloads run strictly one at a time no matter what Concurrent downloads says.

3. **Default fragment fan-out dominates the connection budget.**
   `fragmentConcurrency: 8` → `-N 8` (`server/lib/presets.ts:204-206`). 3 downloads × 8 fragments ≈ 24 parallel HTTP range requests. This is the "it feels like everything downloads at once" symptom.

### Queue rows

`src/components/QueuePanel.tsx` renders plain text buttons, no thumbnail, and no speed line. `JobState.thumbnail` is already populated by the server (`server/index.ts:530`) and sent over SSE — it is simply never rendered.

### Grid/List

`PlaylistTable` is virtualized by fixed 64px rows (`ROW_HEIGHT = 64`, line 61). A grid needs row-based virtualization plus a measured column count, and the fixed-row-height assumption has to branch on layout.

---

## A. Remove the clip & limits feature entirely

### Shared types & validation

| File | Change |
| --- | --- |
| `shared/types.ts` | Drop `clipStart`, `clipEnd`, `rateLimit`, `fragmentConcurrency`, `accurateClips` from `DownloadOptions`; drop `rateLimit` and `fragmentConcurrency` from `Settings`. **Keep** `clipStart`/`clipEnd` on `RequestKeyParts`, marked legacy-read-only — `plan.ts:666` reads them to classify rows already in SQLite, and those rows must keep working. |
| `shared/validation.ts` | `DEFAULT_OPTIONS` loses `fragmentConcurrency`. `options()`: remove the 5 keys from `allowed`, from the text-key loop, the `fragmentConcurrency` integer block, the rate regex, and the clip start/end ordering check. `settingsUpdate()`: remove `fragmentConcurrency: 16` from `limits` and `rateLimit` from the string list plus its `options({ rateLimit })` re-validation. Delete the now-unused `seconds()` (only caller was `runner.ts:398,401`). |
| `shared/request-key.ts` | Stop writing the `accurateClips`/`clipStart`/`clipEnd` spreads. Update the doc comment (it currently names rate limit + fragment concurrency as the excluded "how fast" fields). |

### Server

| File | Change |
| --- | --- |
| `server/lib/presets.ts` | Remove the `--download-sections` + `--force-keyframes-at-cuts` block (196-202), the `-N` block (204-206) and the `--limit-rate` block (208-211). `needsEncoder()` drops `options.accurateClips`. |
| `server/lib/plan.ts` | `conversionAllowed()` (157-165) drops `clipStart`/`clipEnd`. `untouchedSourceCopy()` (664-672) **keeps** reading legacy `stored.clipStart`/`stored.clipEnd` with a comment explaining why. |
| `server/lib/runner.ts` | `verifyOutput()` (394-412) simplifies to a whole-video duration comparison. `downloadOnce()`'s `transformed` provenance (490-491) now means SponsorBlock only. |
| `server/lib/db.ts` | Drop `fragmentConcurrency: 8` and `rateLimit` from `DEFAULT_SETTINGS` (342-353) and from `normalizedSettings()` (369-424). |
| `server/index.ts` | `DEFAULT_DOWNLOAD_OPTIONS` (117-125) and the two `fragmentConcurrency` fallbacks (382-383, 510-511). |

**`normalizedSettings()` must stop spreading.** It currently returns `{ ...merged, ...overrides }`, so a `fragmentConcurrency` key already in an existing database survives `GET /api/settings`, the client echoes the whole form back in `PUT /api/settings`, and `settingsUpdate()` rejects it as `Unknown setting: fragmentConcurrency` — saving Settings would break outright. Rewrite it to build the returned object key-by-key from the known `Settings` keys. This also closes the same latent hole for any other retired key.

### Frontend

| File | Change |
| --- | --- |
| `src/components/FormatPicker.tsx` | Delete the "Clip & limits" block (165-224) and the `Scissors` / `Gauge` imports. `Field`, `Input`, `Select` are all still used elsewhere in the file. |
| `src/components/QualityTools.tsx` | Remove `queueChapters()` (61-81), the chapter checkbox fieldset (322-363) and the "Accurate cuts" switch (341-350). Keep the format table, caption summary and profile controls. |
| `src/App.tsx` | `DEFAULT_OPTIONS` (61-69) loses `fragmentConcurrency`. The settings→options effect (185-192) and the `onSaved` copy (1017-1023) become no-ops; delete both. |
| `src/components/SettingsDialog.tsx` | Remove the "Default fragments" field (340-356) and `rateLimit: form.rateLimit || null` from the save payload (93). |

### Tests and docs

- `tests/skip-logic.test.ts:136` — remove `fragmentConcurrency: 8` from `OPTIONS`.
- `tests/skip-logic.test.ts:1140-1153` — drop the `"clip"` case from the "stored transformation provenance" loop (SponsorBlock case stays).
- `verification/core.test.ts:106` — replace the `fragmentConcurrency: 99999` assertion with another invalid option.
- `verification/core.test.ts:108` — remove the `clipStart`/`clipEnd` ordering assertion.
- `verification/core.test.ts:271` — remove `{ clipStart: "5" }` from the "request key changes" list.
- `dev/scaffolding/runner-concurrency-test.ts:98` — remove `fragmentConcurrency: 8` (kept type-correct for `tsc --noEmit`).
- `README.md` — the Downloading section, the "Accurate clip cuts" sentence, the queue/settings wording.
- `docs/PROJECT_RESEARCH.md` — implementation record.

### Accepted feature loss

Chapter-range clipping, the "Accurate cuts" toggle, per-request speed limit, and per-request fragment count all go away. `POST /api/queue/reorder` and the rest of the HTTP surface are untouched. Dropping `-N 8` is what makes the concurrency fix behave as expected: total parallelism becomes exactly *Concurrent downloads*.

---

## B. Queue card redesign

Rewrite `src/components/QueuePanel.tsx` around a `<article aria-label={job.title}>` — kept because `verification/browser.mjs:102` locates rows by that role/name pair.

### List mode

Mirrors the `PlaylistTable` row language (64×36 rounded thumbnail, same border/hover treatment):

```
┌────────────────────────────────────────────────────────────────┐
│ [thumb 64×36]  Never Gonna Give You Up                    [⏸] [🗑] │
│                ▸ 3.4 MB/s · 45.2 MB · 1m 20s left                │
│                ▓▓▓▓▓▓▓▓░░░░░░░░░░░                               │
└────────────────────────────────────────────────────────────────┘
```

- **Line 1** — title, `truncate`, `title` attribute for the full string.
- **Line 2** — `role="status"`: `job.speed · job.size · job.eta` while transferring, otherwise the phase label (`labels[job.phase]`, the existing map).
- **Progress bar** — thin `Progress` for active phases only, indeterminate for `probing`/`postprocessing`, as today.
- **Right edge** — two icon buttons, vertically centred, at the far right.

### Right-hand icon matrix

One state icon plus a trash icon. Needs a new `size="xs"` button variant (`h-7 w-7 rounded-md`) in `src/components/ui/button.tsx` — the existing `size="icon"` is `h-9 w-9`, too heavy for an inline card action.

| Phase | Left icon | Right icon |
| --- | --- | --- |
| `queued` / `scheduled` / `probing` / `downloading` / `postprocessing` / `converting` | `Pause` → `api.pauseJob(id)` | `Trash2` "Delete" → `api.cancelJob(id)` then `api.removeJob(id)` |
| `paused` | `Play` — accessible name **exactly `"Resume"`** | `Trash2` "Delete" |
| `error` / `cancelled` | `RotateCcw` "Retry" → `api.retryJob(id)` | `Trash2` "Delete" |
| `done` / `skipped` | `FolderOpen` "Reveal file" → `api.openFile(id, true)` | `Trash2` "Remove from queue" → `api.removeJob(id)` |

"Resume" is a hard requirement: `verification/browser.mjs:109-113` pauses a job over the API and then waits for `getByRole("button", { name: "Resume", exact: true })` inside the article. Icon buttons get that name from `aria-label` + `title`.

This is literally *pause + delete* while running, becoming *reveal + remove* once finished.

### Kept vs dropped

- **Kept:** phase label fallback, progress bar, `job.error`, `job.planNote`, `job.recoveryNote`, scheduled timestamp, Diagnostics `<details>`.
- **Dropped from the card:** per-row Cancel, Move up, and all text buttons. `api.reorder` loses its only caller; `POST /api/queue/reorder` remains on the server.
- **Bulk bar unchanged** (Pause all / Resume paused / Retry failed / Cancel all / Clear finished) — confirmed with the user.
- **Open:** keep per-row Move up as a third icon for queued/paused rows, or leave it out?

### Thumbnail resolution

```
job.thumbnail
  ?? (job.videoId ? `https://i.ytimg.com/vi/${job.videoId}/mqdefault.jpg` : undefined)
  ?? placeholder
```

`onError` swaps to the placeholder. The fallback is needed because `BatchComposer` queues rows with no thumbnail (`src/components/BatchComposer.tsx:44` sends only `url` + `videoId`) and so does the library sync path. The fallback is safe because `shared/validation.ts:items()` forces every URL through `youtubeUrl(..., individual: true)`, so any `videoId` present is a real YouTube id.

---

## C. Concurrency fix

Goal: *Concurrent downloads* is the number of real, simultaneous transfers — for every preset, including MP3.

### C1. Decouple pipeline admission from transfer count

`pumps.download` becomes the sole authority on transfers. The pipeline gets headroom to run ahead of it.

```ts
// server/lib/runner.ts
const pipelineCap = () => pools.probe.limit + pools.download.limit;

function pump(): void {
  /* scheduled -> queued promotion unchanged */
  for (const job of queued) {
    if (active.size >= pipelineCap()) break;   // was: pools.download.limit
    /* ... unchanged ... */
  }
}
```

7 jobs in flight by default (3 + 4). The extra 4 exist to keep `pools.probe` (limit 4) busy while the 3 transfer slots are full — probes and ffprobe verification are both already bounded by that pool, so nothing new is exposed. A 500-item batch still cannot spawn unbounded processes: `pools.download` caps transfers at 3, `pools.probe` caps concurrent yt-dlp probes and ffprobe runs at 4, and a large backlog stays in `queued` rather than in flight.

### C2. Honest phase while waiting for a slot

A job parked on the download pool is queued, not probing. The row has to say so:

```ts
// in execute(), immediately before the transfer
if (pools.download.pending > 0) update({ phase: "queued" });
const result = await pools.download.run(() => downloadOnce(...), signal);
```

`Pool.pending` already exists (`server/lib/queue.ts:122-124`). `pump` will not re-admit the job because it is already in `active`; `downloadOnce` flips it to `downloading` on acquisition, and a cancel while parked aborts the `acquire` and leaves the phase at whatever `stop()` set.

### C3. Stop holding a CPU slot across the network

Delete the ffmpeg wrapper around the transfer:

```ts
// before
const download = () => pools.download.run(() => downloadOnce(...), signal);
result = needsEncoder(req.presetId, req.options)
  ? await pools.ffmpeg.run(download, signal)
  : await download();

// after
const result = await pools.download.run(
  () => downloadOnce(id, req, staging, signal, update),
  signal,
);
```

**Trade-off, stated plainly:** yt-dlp does transfer-then-encode inside a single process, so the CPU gate cannot be moved after the fact. It either blocks *before* the process spawns (today, which is the bug — it blocks the whole transfer) or it does not gate that job at all. We choose the latter.

Consequence: `pools.ffmpeg` — "Heavy conversions at once" — now gates only the `plan.action === "convert"` remux/re-encode path in `execute()` (244-270) and the library-sync conversions. Its Settings hint (225-227) is updated to say so, and its `max` may be raised from 4 since it no longer throttles downloads. `verification/lifecycle.test.ts:306` (`pools.ffmpeg.running === 0` after cancelling a conversion) still passes because that path is untouched.

`needsEncoder` stays imported in `runner.ts` — `downloadOnce` still uses it for `provenance`.

### Result

3 transfers for `downloadConcurrency: 3`, for all presets. Combined with removing `-N 8` in section A, total connection count is now predictable: 3.

---

## D. Grid / List view controller

### Shared state

- `src/components/ViewToggle.tsx` — segmented control using `LayoutGrid` and `List` from `lucide-react`. `role="group" aria-label="Layout"`, `aria-pressed` on the active button, `title` on each. Styled to match the existing `role="group" aria-label="Selection mode"` pill group in `PlaylistTable.tsx:258-276`.
- `src/lib/store.ts` — add `layout: "list" | "grid"` and `setLayout`. Seeded from `localStorage["ytd:layout"]`, written on every change. Deliberately **not** zustand's `persist` middleware, which would try to serialize `jobs`, `health` and `connected`.
- `App.tsx` — `<ViewToggle />` in the header icon row next to Theme/Settings.

### Layout-aware shell width

```tsx
className={cn(
  "mx-auto w-full px-5 py-12 transition-[max-width] duration-300 sm:py-14",
  layout === "grid" ? "max-w-5xl" : "max-w-2xl",
)}
```

Without this, a multi-column grid inside the current 672px column looks broken. **Open:** confirm the widening, or keep the narrow shell and cap the grid at 2 columns.

### `PlaylistTable.tsx`

New `layout` prop. A single `useVirtualizer` whose `count` and `estimateSize` branch on layout, so hooks stay unconditional:

```ts
const columns = layout === "grid" ? measuredColumns : 1;
const rowCount = layout === "grid" ? Math.ceil(view.length / columns) : view.length;
const virtualizer = useVirtualizer({
  count: rowCount,
  getScrollElement: () => scrollRef.current,
  estimateSize: () => (layout === "grid" ? GRID_ROW_HEIGHT : ROW_HEIGHT),
  overscan: 6,
});
```

Each virtual item is a **row**: one entry in list mode, `columns` entries in grid mode.

- Column count from a `ResizeObserver` on the scroll container: `Math.max(1, Math.floor(width / 260))`. Needed because the shell width itself changes with layout, and because `max-w-5xl` is a `max-width`, not a fixed width.
- Grid card: 16:9 thumbnail carrying the selection checkbox and duration badge, playlist index, 2-line clamped title (fixed clamp keeps card height deterministic for the virtualizer), status badge, progress badge, view count.
- `toggle()` / shift-click / `lastIndexRef` are unchanged — they already index into the filtered+sorted `view` array.
- Toolbar (search, sort, Asc/Desc), the Selection mode group, the stats bar and the footer hint are all layout-independent and stay as they are.

### `QueuePanel.tsx`

Same switch. The queue is short, so a plain responsive CSS grid (`sm:grid-cols-2 lg:grid-cols-3`) is enough — no virtualization. Card = thumbnail on top, title, speed/phase line, progress, icons bottom-right. In list mode the icons stay vertically centred at the far right edge.

---

## E. Move the selection action bar into the video-selection table

### The problem

`App.tsx` puts the whole "you selected things, here is the button" group in the **format card**, which sits *above* the table (`App.tsx:893-940`):

```tsx
{/* selection summary: "4 of 19 selected" + "16:55" */}
{/* <Button size="lg">Download 4 · FLAC</Button> */}
<RevalidationBanner … />
```

So the interaction is split across a long scroll: pick rows in the table, scroll back up to the format card, press Download. The format card is tall — tabs, preset select, the compatibility note, the audio-quality note, the Options grid — and the table below it is another ~700px of card.

### The move

The three pieces relocate into `PlaylistTable`'s own `Card`, as a **sticky bottom action bar**, below the scroll container and below the existing hint row:

```
┌─ PlaylistTable card ────────────────────────────────────────────┐
│ [filter…] [sort ▾] [Asc]                                        │
│ Selection  [Single|Multiple|Select all]          [Invert][Clear]│
│ 4  of 19 videos selected  ▓▓▓▓░░  16:55 total  [4 already dl]  │
│ ┌ rows (own 380/440px scroller) ──────────────────────────────┐ │
│ └──────────────────────────────────────────────────────────────┘ │
│ Click to toggle. Shift-click to select a range.      15 skipped │
│ ──────────────────────────────────────────────────────────────── │
│ ┌ action bar — sticky bottom-0, bg-card/95 backdrop-blur ────┐ │
│ │ 4 of 4 already on disk need updating · 4 re-download  Dismiss│ │
│ │              [ ↻  Update 4 ]                                │ │
│ │ [            ⬇  Download 4 · FLAC            ]              │ │
│ └──────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────┘
```

Because the bar sits **outside** the table's internal scroller, it stays put while rows scroll and works identically in list and grid mode. `sticky bottom-0` also keeps it pinned to the viewport bottom while the page is scrolled past the table, which is the actual complaint: you never have to travel back up.

### Files

| File | Change |
| --- | --- |
| `src/components/PlaylistTable.tsx` | New props and a new last child of the root `Card`. |
| `src/App.tsx` | Delete the summary + `Download` + `RevalidationBanner` block from the playlist card (893-940); pass the equivalents down. |
| `src/components/RevalidationBanner.tsx` | Unchanged. Its `className` prop already takes `mt-2.5`; pass `mb-2.5` instead inside the bar. |

`RevalidationBanner` needs no change — the three states (planning spinner, error, counts + Dismiss + Update N) all drop into the bar as-is.

### New `PlaylistTable` props

```ts
onDownload: () => void;
formatLabel: string;                              // "FLAC" / "MP4"
planning: boolean;
counts: PlanBatchResult["counts"] | null;
checked: number;                                  // selectionPlan.length
planError?: string | null;
onApplyUpdate: () => void;                        // applySelection()
onDismissUpdate: () => void;
selection: { count: number; total: number; seconds: number } | null;
```

This is nine props on top of the existing nine. The alternative — a `footer?: ReactNode` slot rendered by `PlaylistTable` — keeps the markup and padding owned by the table and the content owned by `App`. **Worth preferring** if the prop list is getting unwieldy; noted rather than decided.

### Avoid duplicating the stats bar

⚠️ `PlaylistTable` already has a stats bar (301-338) showing `4` + "of 19 videos selected", a progress bar, `16:55 total`, `4 already downloaded`, `4 need updating`. A verbatim copy of the format card's summary in the action bar would print the count and duration twice on one screen.

**Recommended:** the action bar carries only the Download button and the re-validation banner. The count is already in the button label (`Download 4 · FLAC`) and the duration in the stats bar directly above it. The information moves down without duplicating.

**If you want the summary line kept as well**, drop the count, duration and the two badges from the stats bar instead and let the action bar own them.

### Single video is unaffected

`App.tsx:818-848` renders the same summary/Download/banner group for a single video. There is no table to scroll past there, so it **stays where it is**. Only the playlist path moves.

### Verification note

`verification/browser.mjs` never touches the Download button or the banner (its only `Download` match is the "Download folder" settings field at `browser.mjs:52`), so the move breaks no assertion. Worth adding a check that the button is reachable and clickable after selecting rows without scrolling.

---

## F. Hoist the profile + format selector above the fold, and make batch paste use it

### What was asked, restated

Two related moves, both about making one format choice drive everything:

1. **Move the profile dropdowns** out of the bottom of the page (`QualityTools`, behind a collapsed `<details>`) to sit **directly under the URL input / paste box and above the format selection section**, so choosing a saved profile visibly drives the format picker instead of being buried below the playlist table.
2. **Batch paste and .txt import should use that same built-in format selector**, instead of presenting a separate per-video format dropdown on every pasted row.

### The blocker behind (2)

`FormatPicker` only renders *inside a probe result card* — `App.tsx:809` (single video) and `App.tsx:883` (playlist). Paste nothing, and there is **no format selector on the page at all**. So "use the built-in format selector for the batch paste" is not currently possible: the only format control reachable in that state is the per-row `<select>` inside `BatchComposer` (lines 112-125).

`BatchComposer` even hard-codes its own copy of the list, ignoring the `Video`/`Audio` grouping the real picker has.

The fix is structural: **`FormatPicker` becomes its own always-rendered card**, sitting under the URL box. One selector, always present, feeding the single `presetId` / `options` state that `App.tsx` already shares with the single-video path, the playlist path, `BatchComposer` and `LibraryManager`.

### Resulting page order

```
┌ URL input + [Paste] [Fetch] ────────────────────────┐
│ Profile: [ Choose profile ▾ ] [ name ] [Save] [⚙]  │  ← new, always visible
├────────────────────────────────────────────────────┤
│ ┌ Format card ──────────────────────────────────┐  │  ← new, always visible
│ │ [Video│Audio]  [Format ▾]                     │  │
│ │ Options: embed thumb / metadata / chapters /  │  │
│ │   sponsorblock / subtitles …                  │  │
│ │ Saves to: C:\...\downloads                    │  │
│ └───────────────────────────────────────────────┘  │
├────────────────────────────────────────────────────┤
│  video card  → MetadataCard only                  │
│  playlist card → title + uploader + count only    │
│  PlaylistTable → rows …                           │
│  ┌ sticky action bar: Update 4 / Download 4 · FLAC┐│  ← section E
├────────────────────────────────────────────────────┤
│  QualityTools  (discover formats / captions)      │
│  BatchComposer  (paste + .txt, no per-row select) │
│  QueuePanel                                        │
└────────────────────────────────────────────────────┘
```

Sections D and E both shrink the cards this replaces, so the page gets shorter overall rather than longer.

### F1 — `src/components/ProfileBar.tsx` (new)

Extracted from `QualityTools.tsx:88-153` and promoted to a top-level strip.

- **Saved profile** `<Select>` — options are `Custom — not saved` (value `""`) plus every profile by name.
- **Reverse sync (new).** Today the selector is write-only. It now also *reflects* the current state by comparing request keys:
  ```ts
  const key = buildRequestKey(presetId, options);
  const match = profiles.find(
    (p) => buildRequestKey(p.presetId, p.options) === key &&
           (p.outputDir ?? null) === (outputOverrides.outputDir ?? null),
  );
  ```
  Selecting a profile sets `presetId` + `options` + `outputDir`/`outputTemplate` (already implemented at `QualityTools.tsx:99-107`, keep it), **and** switches `group` to the profile's `Video`/`Audio` tab (already at `App.tsx:966-969`, keep it). Changing the format by hand flips the selector to `Custom — not saved`.
  `buildRequestKey` is already shared (`shared/request-key.ts`), so no new comparison logic is needed.
- **Save / Update.** `POST /api/profiles` mints a fresh `randomUUID()` on every call (`server/routes/library.ts:127`), so saving the same name twice today creates two identically-named rows. Fix client-side: send the existing `id` when a profile of that name already exists — the server already honours `raw.id`. Button label becomes `Update` when the name matches. On success, select the returned profile.
- **Manage.** The nested `<details>` list becomes a `⚙ Manage` ghost button opening a `Dialog` listing each profile with a trash icon-button. (`Dialog` already exists in `src/components/ui/dialog.tsx`; there is no `Popover` primitive in this codebase, hence `Dialog`.)

Placement in `App.tsx`: immediately after the source-chip row and its hint (780-790), before the probing / probe-error cards. That is "below the URL box, above the format section" while keeping the transient playlist-preview strip attached to the field it describes.

### F2 — `FormatPicker` becomes a standalone always-rendered card

- Rendered once, outside the result cards, directly under `ProfileBar`.
- **"Saves to"** moves here too (`App.tsx:818-825`) — `outputOverrides` feeds every download path, so it belongs with the selector rather than inside one of the cards.
- Props unchanged. The two `presetSelect("preset-video" / "preset-audio")` instances and their distinct ids keep working unchanged.
- **Optional consolidation:** the option controls that live in `QualityTools` today — `Maximum height` (154-182), `Preferred audio language` (183-203), `Caption source` / `Caption output` (210-243) — are plain `DownloadOptions` fields and arguably belong beside the preset they modify. Moving them would leave `QualityTools` with only the expensive "discover source formats and chapters" tool. Not required by the ask; flagged as a follow-on.

### F3 — `src/components/BatchComposer.tsx`

- **Remove** the per-row `<select>` (112-125) and the `formats` state (19). `submit()` (40-48) sends `presetId` for every row, which is what the dropdown already defaulted to.
- **Remove** the `presets` prop; add a `presetLabel: string` prop so the composer can state which format it will use:
  > `Format: MP3 · 320 kbps — from the selector above`
  rendered as a read-only `field-box` beside the textarea, matching the existing `field-box` idiom.
- **Keep** per-row `Invalid video URL` / `Duplicate omitted` feedback and the 500-item cap — `verification/browser.mjs:78-87` asserts both messages and the disabled queue button.
- **Optional escape hatch:** an `Override per video` checkbox that reveals the old per-row selects for the rare mixed-format batch. Defaults to off, since the request is to stop needing it.

### Files

| File | Change |
| --- | --- |
| `src/components/ProfileBar.tsx` | New. |
| `src/components/QualityTools.tsx` | Delete the profile block (88-153), `profileQuery`, `save`, `name` state, and the `presetId` / `onPresetChange` / `onDestinationChange` props. After section A, `options` is also unused here. |
| `src/components/FormatPicker.tsx` | No internal change; it is simply relocated and always rendered. |
| `src/components/BatchComposer.tsx` | Per-row select removed, `presetLabel` prop added. |
| `src/App.tsx` | Render `ProfileBar` + standalone `FormatPicker` card; strip both `FormatPicker` instances and the "Saves to" block out of the two result cards; pass `presetLabel` to `BatchComposer`. |

### Verification note

`verification/browser.mjs` depends on the batch `<summary>` text (`browser.mjs:72`) and the `Duplicate omitted` / `Invalid video URL` strings (`browser.mjs:78-81`) — all preserved. Nothing in the suite touches the profile selector or the per-row format select, so both removals are safe.

Worth adding: a browser check that a profile chosen under the URL box immediately changes the format picker's preset, and that a batch paste queues with that preset without any per-row interaction.

---

## Verification

```sh
bun run typecheck
bun test tests
bun run build
bun run test:browser
```

Constraints the browser suite imposes, all preserved above:
- queue rows stay `<article aria-label={job.title}>` (`browser.mjs:102`)
- a paused row exposes a button named exactly `"Resume"` (`browser.mjs:112`)
- removal converges across two tabs (`browser.mjs:117-122`)

New coverage to add:
- a `pump`/pool regression test asserting **peak concurrent transfers equals the configured limit** for a non-encoder preset (`mp4-h264`), since that is the invariant that was silently broken
- the same for an encoder preset (`mp3-320`) — fails on today's code, passes after C3
- a test that a job waiting on the download pool reports `queued`, not `probing`
- a browser check that the Download button is present in the selection table and clickable after picking rows, with no scroll back to the format card (section E)
- a browser check that picking a profile under the URL box immediately changes the format picker's preset, and that a batch paste queues with that preset (section F)

## Open decisions

1. Per-row **Move up** — keep as a third icon on queued/paused rows, or leave it out? (`/api/queue/reorder` stays on the server either way.)
2. **Shell width** — widen to `max-w-5xl` in grid mode, or keep `max-w-2xl` and cap the grid at 2 columns?
3. **Action bar summary** (section E) — keep the count/duration in the stats bar and let the bar hold only Download + re-validation (recommended), or move them into the bar and strip them from the stats bar?
4. **`PlaylistTable` prop shape** (section E) — nine explicit props, or a `footer?: ReactNode` slot?
5. **Action bar placement** — sticky bottom of the selection table (as drawn), or a sticky top bar just under the filter toolbar?
6. **Profile bar placement** (F1) — after the source chips and hint (recommended, keeps the preview strip attached to the URL field), or immediately below the URL card with nothing in between?
7. **Option consolidation** (F2) — also move Maximum height / audio language / caption controls out of `QualityTools` into the standalone format card, or leave them where they are?
8. **Batch override escape hatch** (F3) — keep an off-by-default "Override per video" toggle that reveals the per-row selects, or delete that capability outright?
