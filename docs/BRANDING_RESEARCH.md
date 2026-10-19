# Branding Research — Unique Name + Logo System

> Living doc. Updated chunk-by-chunk, not one-shot.
> Goal: give this project (`yt-downloader` / working title "Down") a unique, ownable name + a logo system for different purposes/use-cases.
> Status: **DONE — `Reelcreel` with v2 "Reely" mark.** Bobber-reel character (16px-clean favicon, smiling app-icon/OG/mono); build verified. See Chunk 11 + `brand/`.

---

## Chunk 1 — Project DNA, constraints, naming directions (2026-10-04)

### 1.1 What this project actually is (from repo)

- Personal, **loopback-only** YouTube downloader: React 19 + Vite + Bun + Hono + SQLite + yt-dlp + FFmpeg.
- Not a SaaS / not public-hosted. Binds `127.0.0.1`, same-Origin checks, local SQLite, `./downloads` + `.yt-staging`.
- Core jobs: single video, playlist (with cap + truncation UI), **batch paste / .txt import** → resolves to real titles/thumbs before queueing, format card (video/audio presets, resolution cap, audio lang, captions), queue with pause/resume/retry/bulk, library with search/pagination/sync-preview, scheduled runs, optional local cookies file.
- Concurrency model is a differentiator: `Concurrent downloads` = exact simultaneous transfers, no fragment fan-out.
- UI DNA: minimal dark (`#0b0b0c` bg, `#141416` card, `#232326` border), Inter, red-dot + "Down" header, white Fetch button, thumbnail rows + thin progress bar, "Not affiliated with YouTube" footer.
- Current branding: `package.json:name = yt-downloader`, `<title>Down — YouTube downloader</title>`, inline SVG favicon (dark rounded square + red download arrow), `docs/design/design.html` title "Down — YouTube". `Down` is unownable (dictionary word, 1000s of collisions).

### 1.2 Naming constraints (non-negotiable)

1. **No "YouTube", "YT", "Tube" as prefix/suffix that implies affiliation.** Footer already says "Not affiliated". Keep it that way. `Yt-dlp`, `YTDLnis` exist; `Tube*` is crowded + trademark-adjacent.
2. **No generic `*Downloader*` alone.** `Video Downloader`, `YT Downloader`, `Down` all unsearchable.
3. **Must be unique on GitHub / npm / Bun / domain-ish.** Target: 0 exact-match repos + no active same-name Electron/Tauri app.
4. **Pronounceable, ≤3 syllables, typeable, no weird spelling.** Works in terminal (`bunx <name>`), window title, dock.
5. **Evokes at least 2 of:** local-first / loopback / vault / queue / fetch / archive / offline.
6. **Avoid:** `Tube`, `Grab`+`Tube`, `SaveFrom`-style, `MP3/MP4` in name (preset-specific), aggressive piracy vibe (`rip`, `steal`, `leech`).

### 1.3 Seven naming directions (with why)

| # | Direction | Idea | Example seeds |
|---|-----------|------|---------------|
| A | **Loopback / local-first** — biggest true differentiator (127.0.0.1 only) | name says "yours, at home" | Loopback, Loophole, Homebase, Localhost |
| B | **Vault / stash / keep** — library + SQLite + provenance = archive, not just download | name says "kept, verified" | Vault, Stash, Cache, Hoard (careful: negative) |
| C | **Fetch / pull / pluck** — single-gesture action, sticky footer button | verb, fast | Fetch, Pluck, Spool, Reel |
| D | **Queue / spool / stack** — durable queue, pause/resume, bulk, scheduling | backend strength | Queue, Spool, Stack, Docket |
| E | **Signal / offline** — works despite network, retains partials, resumes | resilience | Offline, Signal, Relay, North |
| F | **Minimal / quiet** — UI is quiet, monochrome + one red dot | short, calm | Drowse, Hush, Lull, Mute |
| G | **Myth / object metaphor** — ownable invented word, zero collisions | bucket, magnet, trap, loop | Magnet, Funnel, Sieve, Creel |

### 1.4 Candidate pool — 36 names (raw, unscreened)

Grouped by direction. Screening for collisions/trademark comes in Chunk 2. Do NOT pick from here yet.

**A — loopback/local:**
1. `Loopkeep` — loop + keep, says local + archive
2. `Loophost` — localhost pun, dev-familiar
3. `Homespun` — home + spun (media), warm
4. `Offloop` — offline + loopback
5. `Innloop` — inn (stay local) + loop

**B — vault/stash/keep:**
6. `Videovault` (too generic, likely taken — placeholder for screening)
7. `Clipkeep` — clip + keep
8. `Keepdeck` — keep + deck (queue deck)
9. `Stashline` — stash + line (queue line)
10. `Coldstash` — cold storage vibe, durable SQLite

**C — fetch/pull/pluck:**
11. `Pluck` — short, memorable, "pluck a video off the web"
12. `Fetchfolk` — fetch + folk (personal, not SaaS)
13. `Reelfetch` — reel + fetch
14. `Downspout` — playful, water metaphor, ownable
15. `Siphon` — sucks media down a straw, short

**D — queue/spool/stack:**
16. `Spool` — thread spool = queue + reel, 5 letters
17. `Docket` — list of jobs, calm professional
18. `Stacktray` — stack + tray (downloads tray)
19. `Queuest` — queue + quest (risky spelling)
20. `Batchling` — batch +ling, friendly

**E — signal/offline/resilient:**
21. `Northkeep` — north star + keep
22. `Relayroom` — relay + room (local room)
23. `Deadband` — radio term, too obscure — screening will likely kill
24. `Stillfetch` — still (calm + still image) + fetch
25. `Lowbar` — thin progress bar in UI, minimal

**F — minimal/quiet:**
26. `Hushdrop` — hush + drop (download drop)
27. `Lullaby` (taken everywhere — placeholder, will fail screening, kept to show why)
28. `Drowse` — sleepy minimal, risky (sounds inactive)
29. `Palelight` — faint UI text `text-faint`, poetic
30. `Dotred` — the red dot in header, ultra-minimal

**G — invented / object metaphor (highest ownability):**
31. `Creel` — fisherman's wicker basket (you keep what you catch), 5 letters, rare word
32. `Funneljet` — funnel + jet, fast intake
33. `Magnetbox` — magnet + box (local box)
34. `Sieve` — filter/select metaphor (pick rows, skip duplicates)
35. `Tubecreel` — REJECT (violates constraint 1, kept as negative example)
36. `Yankbank` — yank + bank ( Yank = pull, Bank = vault) — playful, check collisions

> Note: Chunk 2 will kill ~70% of these on GitHub/npm/existing-app collisions + trademark + "sounds like malware" test. That's expected.

### 1.5 What "different logos for different purposes" means (preview for Chunk 4)

This app needs not one logo but a **system**:

- `favicon.svg` (16/32px, dark rounded square, must read at 16px)
- `header wordmark` (red-dot + name, like current `● Down`, but ownable)
- `app icon` (512px, dock/taskbar/installer, macOS squircle + Windows ICO safe)
- `social / OG` (1200×630, README hero, GitHub social preview)
- `mono` (single-color for print, terminal `--version`, settings "About", laser-etch vibe)
- `empty/loading/error states` (queue empty, probing spinner, failed row — friendly, not corporate)
- `badge/chip` (tiny `chip` class in App.tsx header next to yt-dlp/ffmpeg versions)

Each gets different constraints (pixel legibility vs. storytelling). Chunk 4 will propose 3 logo concepts × these 7 slots, all as inline SVG so no binary assets needed yet.

---

## Chunk 2 — collision / trademark screen [DONE — 29 web-screened + npm registry (§2.3) + GitHub existence (§2.4) 2026-10-04]

Method: web exact-match search (GitHub/npm/app store) + cursory TM risk. Full USPTO/TMview + domain-handle pass still queued.

| Name | Verdict (early) | Evidence |
|------|-----------------|----------|
| `Loopkeep` | **KILL — direct collision** | `loopkeep.app` live household tracker, iOS + Google Play, Terms at loopkeep.app/terms. Different space but exact name + active mobile apps = unownable. |
| `Creel` | **PROMISING — keep** | No video-downloader / npm-package exact collision found. Only: R `CreelSurvey` package, `scoop-creel` bucket (unrelated tooling), surname/news noise. Rare dictionary word (fish basket) = ownable. Needs deeper GitHub exact + USPTO pass. |
| `Spool` | **RISKY — likely kill, 1 more check needed** | Word is load-bearing in print/CNC (`spool files`), `nano` npm exposes `.spool()`, generic industrial noun. Even if npm `spool` free, searchability ~zero. Prefer `Spool*` variant or drop. |
| `Pluck` | **KILL as bare word, KEEP as variant root** | Bare `Pluck` crowded: `Video Plucker` (xyruscode downloader, playlist pluck + resume — direct overlap), `Pluck` CMS, `pluckrecipes.com`, Chrome `Pluck — YouTube Transcripts`. `Clipkeep`-style compound (`Pluckdeck`, `Pluckbox`) could survive — to test. |

Early pattern: bare verbs (`Pluck`, `Spool`, `Sieve`) all crowded; compounds + rare nouns (`Creel`, `Yankbank`, `Downspout`, `Hushdrop`) look more ownable.

### 2.1 Second screening wave (2026-10-04, +12 names)

| Name | Verdict | Evidence |
|------|---------|----------|
| `Siphon` | **KILL — direct competitor** | `ghall89/Siphon` = SwiftUI front-end for yt-dlp (same job). Plus `Sound Siphon` (Mac audio, Mac App Store subscription), Unidata `Siphon` (Python remote-data downloader). Triple overlap, one exact-purpose. |
| `Docket` | **KILL — heavily crowded** | `Docket` immunization records (App Store, millions of users), Clarivate Docket (legaltech), Docket Alarm, `docket.care`. Legal/health dense. |
| `Hushdrop` | **RISKY — likely kill** | `Hushdrop` = open-source encrypted artifact sharing for AI agents (MCP directory, active), `HushDrop.com` premium domain for sale, anonymous-text connotation (`Burner, Hushdrop, Google Voice`). Wrong vibe (secrecy) + sharing overlap. |
| `Downspout` | **PROMISING — keep** | Only gutter/construction meanings (SMACNA calculator, BIM, roofer software). Zero software-downloader collisions. Playful water metaphor, ownable. |
| `Yankbank` | **KILL — dev-tool collision** | `ptdewey/yankbank-nvim` Neovim yank-history plugin with real traction (Reddit release thread, persistent storage). Exact name in dev tools = unownable. |
| `Stashline` | **KILL** | `trishume/stashline` iOS personal-finance app + GitHub repo, YouTube demo. Active indie app. |
| `Coldstash` | **KILL** | `ColdStash` cryo/lab brand (dewars, IVF Store $1795 unit, X @ColdStash, biorepository). Wrong connotation (cord blood). |
| `Sieve` | **KILL — funded video AI** | `sieve.ai` = YC W22 multimodal video API (petabytes, Fortune 100), plus `File Sieve` (MS Store), `Screen Sieve` (Mac). Video-space funded startup = fatal. |
| `Offloop` | **KILL — active AI startup** | `OffloopHQ` (GitHub org, ProductHunt, LinkedIn) = AI agent workspace, unfunded but active 2025-26. Plus OFFLOOP Web MIDI sequencer. |
| `Loophost` | **KILL — localhost-tool overlap** | `loophost.dev` live = "use your laptop as a server" local-dev tool. Conceptually adjacent (loopback) + exact-name tooling. |
| `Reelfetch` | **KILL — direct downloader** | `reelfetch.app` / `.online` = Instagram Reel downloader, Android app, Softonic listing. Same category. |
| `Fetchfolk` | **PROMISING — keep** | Only collision: textile artist's `Fetchfolk` art dolls (Polly Lind, craft, no software). No npm/GitHub/app collision. Friendly, personal (fits loopback-only, not SaaS). |
| `Homespun` | **KILL** | `Homespun Instant Access` music-lesson software (Mac/Win), Australian Homespun magazine iOS app, music-shop platform. Dense. |
| `Clipkeep` | **KILL — triple collision** | `ClipKeep: VIDEO DOWNLOADER` (Google Play, 100k+ downloads, Draken Wear) = direct category; `clipkeepapp.com` clipboard manager; `clipkeep.cc` TikTok download guides. Fatal. |
| `Northkeep` | **KILL** | `NorthKeep Security Inc.` (24/7 monitoring), Barony of Northkeep (SCA), Moonsea D&D city. Security/fantasy crowded. |
| `Keepdeck` | **KILL — dev-tool double** | `keepdeck.ai` = agentic dev environment running Claude Code / Codex / OpenCode side-by-side (direct dev-tool overlap); `KeepDeck: Swipe Photo Cleaner` on Play Store. Double kill. |
| `Batchling` | **KILL — trending GH** | `vienneraphael/batchling` = GenAI batch plugin ("save 50% off GenAI costs"), trending on Reddit/Twitter. Active. |
| `Innloop` | **KILL** | `innLoop` hotel PMS (+Food ordering), Fortnite `Innloop Labs`, innLoop biofuel startup. Triple unrelated but crowded. |
| `Stillfetch` | **PROMISING — keep** | Zero software collisions found. `still` (calm + still-image) + `fetch`. Needs USPTO/domain pass but clean so far. |
| `Relayroom` | **WEAK KEEP** | `relayroom.com` = type-design site (FontsInUse), NRC `RelayRoom` nuclear term. No app-store collision, but long (3 syllables) + relay implies network service (wrong for loopback-only). Backup only. |
| `Stacktray` | **WEAK KEEP (spelling variant)** | Only `StackTray` (capital T, 2010 StackOverflow tray app, dormant). `Stacktray` one-word spelling appears free. But tray = system-tray implication; app has no tray. Backup only. |

**Tally: 24/36 screened. Killed: 19. Promising: 4 (`Creel`, `Downspout`, `Fetchfolk`, `Stillfetch`). Weak: 2 (`Relayroom`, `Stacktray`). Unscreened remainder (`Queuest`, `Funneljet`, `Magnetbox`, `Lowbar`, `Dotred`, `Palelight`, `Drowse`, `Deadband`, `Offloop`-adjacent `Offloop` done, `Coldstash` done): low priority, likely killed on next pass for genericness.**

> Kill-rate ~79% as predicted. Bare words die; rare-noun + compound verbs survive.

---

## Chunk 3 — shortlist 8 → top 3 (2026-10-04)

### 3.1 Shortlist of 8 (4 screened survivors + 4 second-wave fresh, honestly flagged)

Second-wave names are built from what survived screening (rare noun + verb compounds). They are **NOT yet screened** — marked `[UNSCREENED]`.

| # | Name | Pronunciation | Why it fits this app | Status |
|---|------|---------------|----------------------|--------|
| 1 | **Creel** | /kriːl/ (like "reel") | Fisherman's keep-basket: you catch, you keep. Matches library + verified provenance + "keep what you catch". 5 letters, rare word, calm, no downloader collision. Terminal: `creel add <url>`. | Screened PROMISING |
| 2 | **Downspout** | down-spout | Rain-gutter+Noun: everything you fetch funnels into one local tray (`./downloads`). Playful, memorable, zero software collision. Matches UI funnel (URL → format card → queue → library). | Screened PROMISING |
| 3 | **Fetchfolk** | fetch-folk | "Fetch for folks, not SaaS". Loopback-only = yours. Warm where competitors sound industrial. Art-doll collision is non-software. | Screened PROMISING |
| 4 | **Stillfetch** | still-fetch | Calm + still-image + fetch. Minimal UI (`text-faint`, thin bar) in one word. Zero collisions. Verb + adjective, searchable. | Screened PROMISING |
| 5 | **Creelcast** `[UNSCREENED]` | creel-cast | Creel + cast (media casting). Keeps rare root, adds media signal. Fallback if bare `Creel` hits a trademark. | Needs screen |
| 6 | **Loopcreel** `[UNSCREENED]` | loop-creel | Loopback + creel. Says the differentiator (127.0.0.1) out loud. Longer but explicit. | Needs screen |
| 7 | **Fetchdeck** `[UNSCREENED]` | fetch-deck | Fetch + deck (queue deck / sticky action bar). Shorter than Fetchfolk, more "control room". | Needs screen |
| 8 | **Spouttray** `[UNSCREENED]` | spout-tray | Downspout shortened + tray (queue/library tray). If Downspout feels too gutter-y, this is the drier variant. | Needs screen |

### 3.2 Top-3 recommendation (provisional, pending Chunk-2 completion + user taste)

1. **`Creel`** — most ownable, shortest, best logo potential (basket/tray/weave). Risk: obscure word, needs one-line explainer ("Creel — keep what you catch"). Tagline: *"Catch it. Keep it. Yours."* Window title: `Creel — YouTube downloader`. README H1: `# Creel`.
2. **`Downspout`** — most memorable/fun, best story (funnel → tray). Risk: gutter association, slightly jokey for a tool that handles provenance seriously. Tagline: *"Everything flows home."* Window: `Downspout — local media intake`.
3. **`Fetchfolk`** — warmest, clearest "personal not SaaS" signal. Risk: longest (9 chars), folksy may undersell the serious queue/SQLite engine. Tagline: *"Fetch for one."* Window: `Fetchfolk — personal media keeper`.

Runner-up: `Stillfetch` (cleanest screen, calmest, but weakest visual metaphor — hard to draw "still").

> No final pick yet — awaiting user reaction + remaining screens (USPTO cursory, npm exact `npm view`, GitHub exact code search, domain/handle). Do NOT rename code on this basis.

### 3.3 How each sounds in situ (so the choice is concrete)

- Terminal: `bunx creel`, `bunx downspout`, `bunx fetchfolk`
- Header (replacing `● Down` in `src/App.tsx:960-963`): `● Creel` / `▼ Downspout` / `✦ Fetchfolk`
- Toast (`startDownload`): `Queued 3 downloads.` → `Creeled 3.` / `Spouted 3.` / `Fetched 3 for you.` (Creel verb is nicest: "creeled")
- Footer disclaimer stays regardless: `Not affiliated with YouTube.`

---

## Chunk 4 — logo system: 3 concepts × 7 use-cases (2026-10-04, DRAFT SVG)

Design language carried over: bg `#0b0b0c`, card `#141416`, border `#232326`, accent red `#ef4444`, Inter. All concepts ship dark + light + mono. SVGs are inline so they can be pasted into `index.html` favicon, README hero, or a future `public/` icon set without binaries.

### Concept A — "Loopback Dot" (evolution, lowest risk)

Keeps today's `● Down` + red-arrow favicon, but the dot becomes a loopback arrow (127.0.0.1 story). Works with ANY name. Safest if rename stalls.

- Favicon (32px, reads at 16px): dark rounded square + red loop-arrow + down-tick.
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0b0b0c"/><path d="M16 7v12m0 0l-5-5m5 5l5-5M9.5 24h13" stroke="#ef4444" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="24.5" cy="8.5" r="3" fill="none" stroke="#ef4444" stroke-width="1.6" opacity=".55"/></svg>
```
- Header wordmark: `● Creel` — 8px red dot stays, name in Inter 600, tagline `Video, audio, playlists, captions, thumbs.` unchanged (`App.tsx:967-969`).
- App icon (512): same mark centered on `#0b0b0c` squircle, 28% padding (macOS safe), white `C`/`D`/`F` letterform optional.
- Social/OG (1200×630): left wordmark + tagline, right giant loop-arrow glyph at 8% opacity.
- Mono: loop-arrow only, single stroke, no fill — for `--version`, Settings → About, laser-etch.
- Empty/loading/error: loop-arrow draws itself (SVG stroke-dashoffset animation) while `probing`; failed row shows broken loop (gap at 45°).
- Chip: 12px loop-arrow + `yt-dlp x.y` text, reuses `.chip` class.

### Concept B — "Creel Weave" (paired with `Creel` / `Loopcreel` / `Creelcast`, highest ownability)

Basket-weave tray + down-arrow. Tells library/archive story. Most distinctive at large sizes; simplified to 3 slats at favicon size.

- Favicon (weave simplified to 3 bars so it survives 16px):
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0b0b0c"/><g stroke="#ececec" stroke-width="2.2" stroke-linecap="round"><path d="M9 13h14M9 17.5h14M9 22h14"/></g><path d="M16 6v6m0 0l-2.5-2.5M16 12l2.5-2.5" stroke="#ef4444" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>
```
- Header: weave-slats glyph (14px) + `Creel`, red arrow as the `ee` tittle? No — keep type clean; red lives only in glyph.
- App icon: weave tray in `#ececec` on dark, red arrow dropping into it; light variant inverts (tray `#0b0b0c` on `#f5f5f4`).
- Social/OG: full basket illustration (6 slats + side stakes), arrow mid-drop, caption *"Catch it. Keep it. Yours."*
- Mono: 3 slats + arrow, one weight, no rounded rect — survives photocopy/fax/test-artifact print.
- Empty/loading/error: empty queue = empty creel outline (friendly, not scolding); probing = arrow bobbing into basket (CSS translateY loop); failed = arrow bounces out.
- Chip: mini 3-slat glyph.

### Concept C — "Spout Drop" (paired with `Downspout` / `Spouttray`, most playful)

Funnel + drop + tray. Tells intake story (URL → format card → queue). Friendliest; riskiest for serious/provenance tone.

- Favicon (funnel triangle + drop):
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0b0b0c"/><path d="M8 9h16l-6.5 7.5V22a1.5 1.5 0 0 1-3 0v-5.5L8 9z" fill="none" stroke="#ececec" stroke-width="2.2" stroke-linejoin="round"/><circle cx="16" cy="24.5" r="1.8" fill="#ef4444"/></svg>
```
- Header: funnel glyph + `Downspout`, tagline *"Everything flows home."*
- App icon: funnel centered, red drop below lip; generous padding so drop doesn't clip on Windows ICO.
- Social/OG: funnel pouring a stream of thumbnails (3 rounded rects) into a tray; caption + `Not affiliated with YouTube` footer.
- Mono: funnel outline only.
- Empty/loading/error: empty = dry spout; loading = drip animation (drop falls every 1.2s); error = splash (3 short strokes).
- Chip: drop-dot + version text.

### 4.1 Which concept for which purpose (recommendation matrix)

| Use-case | Recommended concept | Why |
|----------|---------------------|-----|
| favicon / tab icon | A (Loopback Dot) regardless of name | Only one readable at 16px today; B/C need simplification passes |
| header wordmark (`App.tsx`) | B if `Creel*`, C if `*spout*`, A otherwise | Wordmark must match name story |
| dock / installer icon | B or C (full illustration) | Large canvas rewards storytelling; A looks empty at 512px |
| README / GitHub social preview | B (basket) or C (funnel + thumbs) | Shows what the app does without words |
| mono / terminal / About | A | Single stroke, zero fill, survives anywhere |
| empty / loading / error | B (basket fill level) or C (drip) | State can be a fill level — intuitive progress metaphor |
| version chip | A (dot/loop) | Smallest, quietest, matches existing `.chip` |

> Next: user picks a name lane (Creel vs Spout vs Fetch) + a logo lane (A/B/C or A+B hybrid: A for favicon/mono, B/C for hero/icon). Then Chunk 5 specs exact color/type/voice + rename checklist, and Chunk 6 implements behind approval.

### 2.2 Third screening wave — second-wave names (2026-10-04)

| Name | Verdict | Evidence |
|------|---------|----------|
| `Creelcast` | **PROMISING — keep** | Zero exact hits (web search clean). Keeps rare `Creel` root + media signal. Fallback if bare `Creel` hits TM. |
| `Loopcreel` | **PROMISING — keep** | Zero exact hits. Explicit loopback story. Longer but searchable. |
| `Fetchdeck` | **KILL — software consultancy collision** | `Fetchdeck Technologies Private Limited` (Hyderabad, Tracxn/funded profile, F6S). Exact name in software = unownable. |
| `Spouttray` | **RISKY — niche-tool near-collision** | `SpoutTray` = Spout FFGL video-sharing tray utility (`leadedge/SpoutWallpaper`, TroikaTronix docs). Different space (VJ tooling) but `Spout*` + `*Tray` both load-bearing there. Prefer bare `Downspout`. |
| `Stillfetch` | **PROMISING — confirmed clean** | No app/software exact hits; only generic verb phrases ("still fetch tags", "still fetch mails"). Zero-collision compound. |

**Final tally: 29 screened. Killed: 21. Promising: 6 (`Creel`, `Downspout`, `Fetchfolk`, `Stillfetch`, `Creelcast`, `Loopcreel`). Weak/risky: 3 (`Relayroom`, `Stacktray`, `Spouttray`).** Revised shortlist: drop `Fetchdeck` → promote `Creelcast` (see §3.1 amendment below).

> **§3.1 amendment:** slot 7 `Fetchdeck [UNSCREENED]` is now **KILLED**; replacement slot 7 = **`Creelcast`** (screened PROMISING). Slot 8 `Spouttray` downgraded to backup; preferred slot 8 = **`Loopcreel`** (screened PROMISING).

### 2.3 Registry screen — npm exact (2026-10-04, `npm view <name> version`)

| Name | npm result | Consequence |
|------|------------|-------------|
| `creel` | **404 — FREE** (`Not Found - GET https://registry.npmjs.org/creel`) | Clear. `bunx creel` / `npm i creel` publishable. |
| `downspout` | **TAKEN — `0.0.4`** (`A framework to serialize the execution of event handlers for disorderly event emitting`, `kjirou/downspout`, modified 2022-06-15) | **Downgraded PROMISING → RISKY.** Stale (4y) but npm names are first-come: cannot publish bare `downspout`. Product name still legally usable without npm publish (this app is `private:true`, not published), but `bunx downspout` / future `npm i -g downspout` is blocked unless scoped (`@scope/downspout`) or negotiated. Prefer `Creel*` if a public CLI matters. |
| `fetchfolk` | **404 — FREE** | Clear. |
| `stillfetch` | **404 — FREE** | Clear. |
| `creelcast` | **404 — FREE** | Clear. Fallback if bare `Creel` hits TM. |
| `loopcreel` | **404 — FREE** | Clear. |

**Revised tally: 29 web-screened + 6 registry-checked. Killed: 21. Promising + registry-clear: 5 (`Creel`, `Fetchfolk`, `Stillfetch`, `Creelcast`, `Loopcreel`). Risky-but-usable: 1 (`Downspout` — web-clean, npm-blocked).** Top-3 implication: `Creel` becomes the clear frontrunner on registry grounds; `Downspout` stays in top 3 on memorability but carries the npm caveat above.

### 2.4 GitHub existence screen (2026-10-04, web exact + repo-page verify)

| Name | GitHub result | Consequence |
|------|---------------|-------------|
| `creel` (bare) | **EXISTS — `tliron/creel`** (verified via repo page): "lightweight and lightning-fast library for resolving and downloading JVM dependencies from Maven repositories", CLI/Ant/Eclipse, LGPL-3.0, Three Crickets era (JVM 7, `190Kb` jar, Maven Central `com.threecrickets.creel`). **1 star, 2 forks — dormant.** Same verb ("downloading") but different domain (Maven jars vs YouTube media) and different audience (Java devs, 2010s). Repo names are per-owner, not globally exclusive, so this does not block use — but GitHub search for `creel` surfaces it first. | **Downgraded PROMISING → RISKY-lite.** Still npm-free (§2.3) and web-clean (§2), but no longer "zero collisions". The repo page itself corroborates the metaphor ("A creel is a basket for fish" + Monty Python fish sketch — usable brand story). Prefer `Creelcast`/`Loopcreel` if GitHub-search ownability matters. |
| `creelcast` | **Zero hits** | Fully clear (web + npm + GitHub). Strongest TM-fallback. |
| `loopcreel` | **Zero hits** | Fully clear. Strongest explicit-loopback pick. |
| `stillfetch` | **Zero hits** (only generic "still fetch" phrases) | Fully clear. |
| `fetchfolk` | **Zero hits** (software) — only textile-artist dolls (non-software, §2.1) | Fully clear in software. |
| `downspout` (re-check) | Known: `kjirou/downspout` (npm owner repo, event-handler framework) + `leadedge/SpoutTray` (VJ tooling). No change. | Stays RISKY (npm-blocked). |

**Final availability matrix (web + npm + GitHub): fully clear: `Creelcast`, `Loopcreel`, `Stillfetch`, `Fetchfolk` (4). Single-caveat: `Creel` (dormant GitHub JVM downloader, 1 star), `Downspout` (stale npm package + adjacent repos).** Frontrunner revision: if the priority is zero-collision ownability, pick `Creelcast` (keeps the basket story, adds media signal) or `Loopcreel` (says loopback); if the priority is shortest/most memorable and a dormant 1-star JVM tool from another decade is acceptable noise, bare `Creel` still works — npm is free and audiences do not overlap.

### 2.5 Trademark-strength cursory (2026-10-04, web only — NOT a clearance search)

No USPTO filing by the project exists; nothing below substitutes for a TESS/TMview check or counsel before commercial use. Method: exact-phrase web search for each finalist + `creel` software-mark noise.

- `creel` (bare, dictionary word = weakest mark): noise is surname/fishing only — `Creel, García-Cuéllar, Aiza y Enríquez` (Mexican law firm, `creel.mx`), state fishing "creel limit" regulations, a 2001 USPTO Gazette entry "A CREEL FULL OF INFORMATION" (Class 35, demographic-data collection — different class, 25 years old). No live software mark surfaced. Risk: descriptive-word weakness + the dormant `tliron/creel` prior use (§2.4) in adjacent downloader-CLI space. Ownable in practice for a personal local tool; weakest of the set on paper.
- `creelcast`, `loopcreel`, `stillfetch`: **zero exact hits anywhere** — coined compounds = strongest marks in the set by construction. No action needed beyond a pre-launch TESS pass.
- `fetchfolk`: zero software hits; only Polly Lind's `Fetchfolk` art dolls (craft, non-software, no mark evidence). Different class, no conflict signal; note the dolls if ever merchandising plush (half-joking, half-serious).
- Pre-launch clearance checklist (run for the picked name before any store listing or `npm publish`): (1) USPTO TESS exact + related-classes 9/42 search, (2) TMview/EUIPO if distributing abroad, (3) App Store + Play Store exact search, (4) `<name>.com/.app/.dev` + GitHub org handle availability. Links: `https://www.uspto.gov/trademarks/search` and `https://www.tmdn.org/tmview/`.

### 2.6 Handle screen — GitHub org/user names (2026-10-04, live `GET github.com/<name>`)

| Handle | Result | Meaning |
|--------|--------|---------|
| `github.com/creelcast` | **404** | Free — org/user creatable. |
| `github.com/loopcreel` | **404** | Free. |
| `github.com/stillfetch` | **404** | Free. |
| `github.com/fetchfolk` | **404** | Free. |

(All four: `StatusCode: non 2xx status code (404 GET ...)` — GitHub serves the name as available. Re-verify at claim time; handles are first-come.)

### 2.7 Final decision matrix (all screens combined — the research verdict)

Score: ● clear / ◐ single caveat / ○ blocked-or-crowded.

| Name | Web | npm | GitHub repo | GitHub handle | TM strength | Memorability | Verdict |
|------|-----|-----|-------------|---------------|-------------|--------------|---------|
| `Creelcast` | ● zero | ● 404 free | ● zero | ● 404 free | ● coined | ● says basket + media | **Cleanest overall. Recommended zero-collision pick.** |
| `Loopcreel` | ● zero | ● 404 free | ● zero | ● 404 free | ● coined | ● says loopback explicitly, longer | **Co-recommended if loopback story matters most.** |
| `Stillfetch` | ● zero | ● 404 free | ● zero | ● 404 free | ● coined | ◐ calm but weak visual metaphor (§3.2) | Backup — clean but harder to draw. |
| `Fetchfolk` | ● non-software only | ● 404 free | ● zero (software) | ● 404 free | ● coined-ish | ● warmest | Backup — longest, softest vs the SQLite engine. |
| `Creel` | ● rare-word noise only | ● 404 free | ◐ `tliron/creel` (1★ dormant JVM downloader) | n/a (common word) | ◐ dictionary word | ●● shortest, best verb ("creeled") | **Shortest pick — accept 1-star JVM noise.** |
| `Downspout` | ● gutter only | ○ TAKEN v0.0.4 | ◐ adjacent (`kjirou`, SpoutTray) | — | ◐ dictionary | ●● most fun | Usable as product name, npm-blocked. Needs scope or concede CLI. |

Research bottom line: no further screening can separate `Creelcast` vs `Loopcreel` vs `Creel` — all remaining differences are taste (short vs explicit vs story). That choice is the only thing standing between this file and §6.3.

---

## Chunk 5 — color / type / voice spec + rename checklist (2026-10-04, grounded in repo)

Grounded in `src/index.css`, `src/App.tsx`, `index.html` (read this turn). No new dependencies.

### 5.1 Palette (keep — do not rebrand colors with the name)

Exact tokens from `src/index.css:39-89`. The brand inherits the app; the app does not change for the brand.

| Token | Light (`:root`) | Dark (`.dark`, default in `index.html:2`) | Brand role |
|-------|-----------------|---------------------------------------------|------------|
| `--background` | `#f6f6f7` | `#0b0b0c` | favicon rect, OG bg, app-icon bg |
| `--card` | `#ffffff` | `#141416` | cards, toasts (`[data-sonner-toaster]`), OG panel |
| `--border` / `--input` | `#e5e5e9` / `#dcdce1` | `#232326` / `#2a2a2e` | hairlines, chip border, funnel/weave strokes (dark) |
| `--foreground` | `#17171a` | `#ececec` | wordmark, weave/funnel glyph strokes |
| `--muted-foreground` | `#6b6b73` | `#8a8a93` | tagline, `.opt` idle |
| `--faint` | `#686870` | `#9898a2` | footer microcopy, `.chip`, `.micro` eyebrows |
| `--primary` | `#17171a` (white text) | `#ffffff` (black text) | Fetch/Download buttons — **never recolor brand red** |
| `--destructive` | `#dc2626` | `#f2616b` | errors only |

Accent decision: **keep `#ef4444` (current favicon arrow, header dot `bg-red-500`) as the *brand* red, distinct from `--destructive`.** Rationale: red already means "record/catch" in header + favicon; destructive has its own tokens in both themes, so no confusion. Logo SVGs use `#ef4444` for the single action element (arrow / drop / loop) and `--foreground` for structure. Light-variant logos swap structure to `#17171a` on `#f5f5f4`-ish paper; red stays `#ef4444` (passes on white; on dark it is the current favicon and already ships).

### 5.2 Type (keep Inter, already loaded)

- Already in `index.html:12-17` (Inter 400/500/600, preconnect). `@theme inline` maps `--font-sans` to Inter (`index.css:7-8`).
- Wordmark: Inter 600, `tracking-tight` (matches `App.tsx:964` H1), sentence case (`Creel`, not `CREEL`). Tagline stays 14px regular muted (`App.tsx:967-969` pattern: `text-sm text-muted-foreground`).
- Eyebrows/labels: `.micro` (`11px uppercase tracking-[0.08em] text-faint`); chips: `.chip` (pill, `11px text-faint`). Logo lockups reuse these classes instead of inventing new styles.
- Never add a display font for the wordmark — the product voice is quiet; a novelty font would fight `docs/design/design.html`'s minimal mock.

### 5.3 Voice + footer (name-independent, ships regardless)

- Voice: quiet, provenance-honest, local-first. Say what was verified ("inspected", "retained staging", "paused for review"), never "fastest/free unlimited". Toasts stay factual (`Queued N downloads.` — §3.3 verb play like `Creeled N.` is **rejected** for production; keep verbs standard, let the name live in the header/title only).
- Footer stays (`App.tsx:1167-1177` pattern + `docs/design/design.html:257`): `Not affiliated with YouTube.` + live-status pill. Any new name must keep this line verbatim; it is the trademark-distance mechanism alongside constraint §1.2(1).
- About/Settings: add one line under binaries (`SettingsDialog` health area): `<Name> · local-only build · yt-dlp <v> · ffmpeg <v>` — reuses health query, no new endpoint.

### 5.4 Rename checklist (do NOT execute — awaiting §6 approval)

Brand touches code in 7 places. Ordered so each step is verifiable:

| # | File | Line(s) (current) | Change | Verify |
|---|------|-------------------|--------|--------|
| 1 | `package.json` | `:2` `"name": "yt-downloader"` | `"creel"` (or picked name, lowercase, no spaces) | `bun install && bun run typecheck` |
| 2 | `index.html` | `:6` `<title>Down — YouTube downloader</title>`, `:8-11` favicon data-URI | new title + Concept A/B/C favicon SVG data-URI | open tab, check 16px legibility |
| 3 | `src/App.tsx` | `:960-969` header (`Down` + `YouTube downloader` + tagline + chips) | wordmark + tagline per §3.2 (e.g. `Creel` + `Catch it. Keep it. Yours.` as tagline? or keep functional `Video, audio, playlists, captions, thumbs.`) | `bun run dev`, screenshot both themes |
| 4 | `src/components/ThemeToggle.tsx` | `:5` `KEY = "yt-downloader-theme"` | `"creel-theme"` (migrate: read old key once, write new) | toggle persists across reload |
| 5 | `README.md` | `:1` `# YouTube Downloader` | `# Creel` + one-line explainer + keep setup verbatim | `bun run build` |
| 6 | `docs/design/design.html` | `:6` title, `:48-54` header mock | mirror App header change (mock only) | visual diff |
| 7 | `server/` data-dir default + docs | `YTD_DATA_DIR` default `./data`, `PORT`, `README` storage section | only docs mention if name appears in paths; **do not migrate user `./data`/`./downloads`** | restart with existing db, confirm backup+migration path untouched |

Explicit non-goals: no color/token changes, no font swap, no user-data migration, no endpoint renames (`/api/*` unchanged), no package publish under new name until USPTO-cursory + `npm view <name>` + GitHub exact-code-search pass recorded in §2.

---

## Chunk 6 — implementation-ready kit (2026-10-04, NO rename applied — pick first)

Nothing below is wired into code yet (per §5.4 gate). Copy-paste ready so the chosen lane ships in one pass.

### 6.1 Favicon data-URIs (paste into `index.html:8-11` `href`)

URL-encoded (`#` → `%23`, quotes single). All on `#0b0b0c` rounded square to match current tab look.

- **A — Loopback Dot** (works with any name):
```
data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%230b0b0c'/><path d='M16 7v12m0 0l-5-5m5 5l5-5M9.5 24h13' stroke='%23ef4444' stroke-width='2.6' stroke-linecap='round' stroke-linejoin='round' fill='none'/><circle cx='24.5' cy='8.5' r='3' fill='none' stroke='%23ef4444' stroke-width='1.6' opacity='.55'/></svg>
```
- **B — Creel Weave** (pairs with `Creel` / `Creelcast` / `Loopcreel`):
```
data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%230b0b0c'/><g stroke='%23ececec' stroke-width='2.2' stroke-linecap='round'><path d='M9 13h14M9 17.5h14M9 22h14'/></g><path d='M16 6v6m0 0l-2.5-2.5M16 12l2.5-2.5' stroke='%23ef4444' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round' fill='none'/></svg>
```
- **C — Spout Drop** (pairs with `Downspout`; note §2.3 npm caveat):
```
data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='7' fill='%230b0b0c'/><path d='M8 9h16l-6.5 7.5V22a1.5 1.5 0 0 1-3 0v-5.5L8 9z' fill='none' stroke='%23ececec' stroke-width='2.2' stroke-linejoin='round'/><circle cx='16' cy='24.5' r='1.8' fill='%23ef4444'/></svg>
```

### 6.2 Title + header strings per lane (for `index.html:6`, `App.tsx:960-969`, `docs/design/design.html`, `README.md:1`)

| Lane | `<title>` | Header wordmark | H1 | Tagline (pick one) |
|------|-----------|-----------------|----|--------------------|
| Creel (frontrunner) | `Creel — local media keeper` | `● Creel` (keep red dot) | `Creel` + sub `YouTube downloader`? NO — sub becomes tagline | `Catch it. Keep it. Yours.` OR keep functional `Video, audio, playlists, captions, thumbs.` |
| Downspout (npm-blocked) | `Downspout — local media intake` | `▼ Downspout` | `Downspout` | `Everything flows home.` |
| Fetchfolk | `Fetchfolk — personal media keeper` | `✦ Fetchfolk` | `Fetchfolk` | `Fetch for one.` |
| Stillfetch (backup) | `Stillfetch — calm media keeper` | `● Stillfetch` | `Stillfetch` | `Quietly yours.` |
| Creelcast (TM-fallback) | `Creelcast — local media keeper` | `● Creelcast` | `Creelcast` | `Catch it. Keep it. Yours.` |
| Loopcreel (explicit) | `Loopcreel — loopback media keeper` | `● Loopcreel` | `Loopcreel` | `Home is the server. (127.0.0.1)` |
| Reelcreel (fit-pick, §7) | `Reelcreel — keep every reel` | weave glyph + `Reelcreel` | `Reelcreel` | keep `Video, audio, playlists, captions, thumbs.` (locked) |
| Listkeep (backup, §7) | `Listkeep — keep every list` | weave glyph + `Listkeep` | `Listkeep` | keep functional (locked) |

Rules when applying: keep `Not affiliated with YouTube.` footer verbatim (§5.3); keep button/toast verbs standard (`Download`, `Queued N downloads.`); migrate `yt-downloader-theme` → `<name>-theme` with one-time read of old key (§5.4 row 4); do not touch `./data`/`./downloads` or `/api/*`.

### 6.3 Apply-order (when approved)

1. §5.4 rows 1–2 (`package.json`, `index.html` incl. §6.1 URI) → `bun run typecheck`, tab check.
2. Row 3 (`App.tsx` header) → `bun run dev`, screenshot light + dark.
3. Rows 4–6 (theme key, README, docs/design/design.html) → reload-persist check, `bun run build`.
4. Row 7 (docs only) → restart against existing db, confirm backup+migration untouched.
5. Record USPTO-cursory + GitHub exact-code-search for the picked name in §2 before any `npm publish` (app is currently `private:true`, so publish is optional).

### 6.4 Favicon URI validation (2026-10-04, executed — evidence, not intent)

All 3 §6.1 data-URIs were extracted from this file, URL-decoded, and XML-parsed (`python validate-uris.py`, script removed after run):

| URI | Chars (as pasted) | Decoded bytes | Root / viewBox | Elements | Brand red | rect + paths |
|-----|-------------------|---------------|----------------|----------|-----------|--------------|
| A — Loopback Dot | 381 | 356 | `svg` / `0 0 32 32` | 4 | yes | yes / yes |
| B — Creel Weave | 388 | 363 | `svg` / `0 0 32 32` | 5 | yes | yes / yes |
| C — Spout Drop | 324 | 299 | `svg` / `0 0 32 32` | 4 | yes | yes / yes |

All parse clean, carry `viewBox 0 0 32 32`, stay under 400 chars (safe for an `href` attribute), and keep the single dark rounded-square look so any of them drops into `index.html:8-11` unchanged. Visual 16px legibility + light/dark tab check still belong to the §6.3 apply pass (human eyes required).

---

## Chunk 7 — fit-for-purpose wave: names that say video-downloader (2026-10-04, user redirect)

User verdict on the abstract shortlist: *"give me a name that fits a video downloader tool, not just any random names."* Locked this turn: **logo = Hybrid A+B** (A favicon/mono/chip + B header/hero/app-icon), **tagline = keep current** (`Video, audio, playlists, captions, thumbs.`). So: 12 new candidates built from video nouns (`reel`, `clip`, `frame`, `play`, `watch`, `vid`, `list`) + keeper nouns (`keep`, `stock`, `cache`, `stash`, `deck`, `vault`, `creel`). Screened same way: web exact + `npm view` + GitHub handle (survivors only).

### 7.1 npm screen — all 12 FREE (no blocker anywhere)

`reelkeep reelstock clipcache framekeep framecache playstash reeldeck clipdeck reelcreel listkeep watchvault vidstash` → every `npm view <n> version` = 404. npm never the filter in this wave.

### 7.2 Web screen — 10 killed, 2 survive

| Name | Verdict | Evidence |
|------|---------|----------|
| `Reelkeep` | **KILL — direct downloader** | `ReelKeep` Android video downloader (Play Store `ReelKeep Pro`, reelkeep.xyz Instagram downloader, Softonic/Uptodown/APKPure). Exact category. |
| `Clipcache` | **KILL — exact software** | `ClipCache Pro` (xrayz.co.uk, v3.8.0, Windows clipboard manager). Different space, exact name. |
| `Framekeep` | **KILL — video-adjacent SaaS** | `Framekeep` (framekeep.app, MS Store): video proofing/redaction, "frames… on your own machine". Same local-video vocabulary. |
| `Framecache` | **KILL — broadcast infra** | Grass Valley `FrameCache` (AMPP/MXL broadcast media infra). Video-infra dense. |
| `Playstash` | **KILL — game collision** | `r/PlayStash` (roguelike looter game "Stash"). Gaming owns the word. |
| `Clipdeck` | **KILL ×4** | `clipdeck.app` (YouTube clip-to-shareable-link — direct YouTube overlap) + Premiere launcher + Mac clipboard manager + podcast clips. Densest collision yet. |
| `Watchvault` | **KILL — collector app** | `WatchVault` (Play Store, offline watch-collector app). "Watch collection" confusion with video library. |
| `Vidstash` | **KILL ×2 — direct downloader** | `VidStash - All Video Downloader` (APKPure APK) + `VidStash HD Fullscreen Status` (Play Store). Exact category + sibling app. |
| `Reeldeck` | **KILL — desktop app** | `ReelDeck` (reeldeck.net desktop app) + itch.io ReelDeck + Amiga ReelDeck player. Desktop-app collision. |
| `Reelstock` | **KILL — footage download** | `Reelstock` (stock film/video footage site for immediate download, Adweek). Video-download-adjacent commerce. |
| `Reelcreel` | **PROMISING — fully clear** | Zero web hits. Says video (`reel` = film reel / IG-reel-era word for short video) + keep-basket (`creel`). Keeps the §2 basket story while answering the fit complaint. npm 404 free. `github.com/reelcreel` → 404 free. 9 chars, 2 syllables (reel-creel), rhymes — memorable. |
| `Listkeep` | **PROMISING — fully clear** | Zero software hits (only generic "list keep…" prose fragments). Says playlist/queue (the app's strongest UI: selection table, batch lists, library lists). Calm, functional. npm 404 free. `github.com/listkeep` → 404 free. Risk: drier than Reelcreel, less ownable rhythm. |

### 7.3 Revised recommendation (fit-weighted)

1. **`Reelcreel`** — fits a video-downloader (`reel`), keeps the ownable basket metaphor, fully clear on all four screens, rhymes. Header: weave glyph (B) + `Reelcreel`; favicon/mono: loop-dot (A). Tagline stays functional. README H1: `# Reelcreel — keep every reel.`
2. **`Loopcreel`** (from §2.7) — still the most explicit about loopback-local; less video-obvious than Reelcreel but zero-collision.
3. **`Creelcast`** (from §2.7) — zero-collision fallback with media signal (`cast`).
4. `Listkeep` — backup: clearest about playlists, weakest poetry.

> Awaiting user pick from this fit-weighted list (or a new direction). Rename still NOT applied — §5.4/§6.3 gate holds.

---

## Chunk 8 — user proposal `vid-dl` (2026-10-04, screened → KILLED)

Proposal fits the tool (`vid` = video, `dl` = download) and is npm-free (404) with a free GitHub handle (404). Killed anyway on exact-name collisions in the exact category:

- **`cristhianflo/vid-dl`** — exact repo name, exact job: "yt-dlp wrapper written in Golang… CLI tool to download videos from your terminal… YouTube". Fatal overlap (same wrapper lineage as this app's backend).
- **`truelockmc/vid-dl-cli-only`** + shipped `vid-dl.exe` (issue #62) — same name shipping binaries.
- **WinGet `ProjectVid.VidDl`** — "modern desktop video downloader" under the same spoken name.
- **`viddl` family** — `arirusso/viddl` (Ruby CLI, requires youtube-dl+ffmpeg), `rb2k/viddl-rb`, `IgorVaryvoda/viddl.me` (YouTube/TikTok downloader), `llnz/inviddl`. Spoken-name collision cluster.
- Secondary: `-dl` suffix reads as youtube-dl/yt-dlp lineage, working against constraint §1.2(1) (trademark distance) — the footer "Not affiliated" would sit next to a name that implies a fork.

Verdict: **do not take `vid-dl`.** Closest clear alternatives already screened: `Reelcreel` (video-fitting, fully clear), `Loopcreel`, `Creelcast`, `Listkeep` (Chunk 7 / §2.7).

---

## Chunk 9 — user proposals `vidfetch` / `mediaporter` (2026-10-04)

### `vidfetch` → **KILL — saturated exact-category collision**

- Play Store `Video Downloader - VidFetch` (v7.0.558, `com.rocks.video.downloader`) + MS Store `VidFetch Video Downloader` + `VidFetch: 4K Video Downloader` — three store apps in the exact job.
- GitHub `MAHMOUDELSAYED7/VidFetch` (Flutter YouTube downloader) + itch.io `VidFetch` (yt-dlp Windows desktop, "powered by yt-dlp") — same backend lineage as this app.
- GitHub org `github.com/vidfetch` exists (empty, squatted). npm `vidfetch` = 404 **"Unpublished on 2026-08-11"** — previously published then pulled; republishing the name may be blocked or flagged.

### `mediaporter` → **RISKY — one active adjacent project, otherwise clear**

- npm 404 free (true Not Found). GitHub handle 404 free. No store apps found.
- Collision: **`faeton/mediaporter`** (verified via repo page): open-source "iTunes alternative for video sync" — transfers videos Mac→iPhone/iPad with ffmpeg transcode, SwiftUI Mac app + CLI, signed DMG from `porter.md`, 155 commits, active. **Different job** (device sync of your own files vs downloading internet video) and tiny (2 stars, 0 forks), but actively maintained, has `brand/` + a distribution site. GitHub search for `mediaporter` surfaces it first.
- Older noise: `MediaPorter` TV-tuner open source, ant-society "media-porter" — irrelevant.
- Fit: excellent word (`porter` = one who carries; matches queue/carry semantics), 11 chars. Verdict: usable only if the user accepts confusion risk with an active video-tooling project. Ranked below the fully-clear `Reelcreel` / `Loopcreel` / `Creelcast` / `Listkeep`.

---

## Chunk 10 — APPLIED: `Reelcreel` (2026-10-04, user pick)

### Files changed

| File | Change |
|------|--------|
| `package.json:2` | `"yt-downloader"` → `"reelcreel"` |
| `index.html:6-11` | title → `Reelcreel — keep every reel`; favicon → Concept A URI (Hybrid: A for favicon) |
| `src/App.tsx:962` | header eyebrow `Down` → `Reelcreel` (red dot kept; H1 stays functional `YouTube downloader`, footer disclaimer stays verbatim) |
| `src/components/ThemeToggle.tsx:5-6,12` | `KEY = "reelcreel-theme"` + `LEGACY_KEY` one-time read (existing users keep their theme) |
| `README.md:1-3` | `# Reelcreel — keep every reel.` |
| `docs/design/design.html:6,51` | title + header mock mirrored |
| `brand/` (new) | `favicon.svg` (A), `weave-mark.svg` (B glyph, `currentColor` slats), `app-icon.svg` (512 squircle), `og-hero.svg` (1200×630), `mono.svg` (single-color), `README.md` (file→use-case map) |

### Deliberately untouched

- `server/lib/db.ts:21` `yt-downloader.db` + related tests/fixtures — user data path, no migration (§5.4 non-goal).
- `bun.lock` name field — regenerates on next install.
- `/api/*` routes, colors, fonts, toasts/verbs.

### Verification (executed)

- `bun run typecheck` → clean (`tsc --noEmit`, no errors).
- `bun run build` → success (1979 modules; only pre-existing >500kB chunk warning).
- Built `dist/index.html:6` contains `<title>Reelcreel — keep every reel</title>`.

---

## Chunk 11 — v2 mark "Reely": bobber-reel with a face (2026-10-04, user: "generic → life/character/unique")

Retired the generic Concept A arrow (it could belong to any downloader). New mark fuses three stories: **fishing bobber** (the creel catch), **film reel** (sprocket holes), **catch buoyancy** (stem + red tip). Red/cream split + stem reads at 16px; eyes + smile + gloss appear only at large sizes (face would muddy the favicon).

- `brand/favicon.svg` + `index.html` data-URI: plain bobber-reel, no face.
- `brand/app-icon.svg` / `og-hero.svg`: full character (eyes, smile, highlight) + wordmark on OG.
- `brand/mono.svg`: single-color bobber with face. `weave-mark.svg` retired to alternate.
- Verified: `bun run build` succeeds.

---

## Chunk 12 — user proposal `vidgrep` (2026-10-04, screened → KILLED)

- npm 404 free, GitHub handle 404 free — but the web is fatal: **`vidgrep.com` is live** ("VidGrep — grep for video | AI agent video search", searches local/S3 video speech + visual, `hello@vidgrep.com`). Active product, exact name, video space. Observed since 2026-09-07.
- Fit note: `grep` semantics (search/filter) suit the library, but the name is taken where it matters most (the .com + a shipping product). Verdict: **do not take.**

---

## Next chunks (queued)

- [x] **Chunk 2** — collision screen 29 names (§2–§2.2) + npm registry exact (§2.3) + GitHub existence + repo-verify (§2.4) + TM-strength cursory (§2.5, web-only) + handle screen + final matrix (§2.6–§2.7).
- [x] **Chunk 3** — shortlist 8 → top 3 (§3, amended: `Fetchdeck` killed, `Creelcast`/`Loopcreel` in).
- [x] **Chunk 4** — 3 logo concepts × 7 use-cases with draft SVG (§4).
- [x] **Chunk 5** — color/type/voice spec + rename checklist (§5, grounded in `src/index.css` + `App.tsx` + `index.html`).
- [x] **Chunk 6** — kit was ready (§6.1–§6.4); **APPLIED for `Reelcreel`** (see Chunk 10: code rename + `brand/` assets + typecheck/build verified).
- [x] **Chunk 7** — fit-for-purpose wave (12 video-fitting names, 10 killed with evidence, survivors `Reelcreel` + `Listkeep` fully clear). Locked: logo Hybrid A+B, tagline keep-current.
- [x] **Chunk 8** — `vid-dl` proposal screened → KILLED (exact-name `cristhianflo/vid-dl` yt-dlp-wrapper CLI + WinGet `VidDl` + `viddl` cluster; `-dl` hurts trademark distance).
- [x] **Chunk 9** — `vidfetch` → KILLED (3 store apps + Flutter/itch downloaders + squatted org + unpublished npm); `mediaporter` → RISKY (active `faeton/mediaporter` video-sync tool, different job, 2★) but npm/handle/store-free.

---
*Chunk 1 source: local repo read (`package.json`, `README.md`, `docs/PROJECT_RESEARCH.md`, `src/App.tsx`, `index.html`, `docs/design/design.html`). No web lookups yet — those start Chunk 2.*
