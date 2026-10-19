# Development scaffolding

One-off probes, smoke scripts and exploratory harnesses used while building the
app. These are **not** part of the test suite — the maintained tests live in
[`../tests/`](../tests/) and [`../verification/`](../verification/), and run with
`bun test tests` / `bun run test:browser`.

Keep this directory out of the critical path. Scripts here may assume a running
dev server, real binaries (`yt-dlp`, FFmpeg), or live YouTube access.

## Contents

| File | Purpose |
|------|---------|
| `runner-concurrency-test.ts` | End-to-end concurrency check through the real `runner.ts` + `queue.ts`, stubbing only the yt-dlp spawn layer and history DB. |
| `pool-test.ts` | Standalone assertions for the bounded-concurrency `Pool` in `server/lib/queue.ts`. |
| `smoke-plan.ts` | Hits a running API to check the skip/convert/download planner decision matrix. |
| `smoke-matrix.ts` | Runs the planner over every preset for real library entries; spawns its own API server. |
| `smoke-convert.ts` | Exercises the FFmpeg conversion path against real files. |
| `test-api.mjs`, `test-formats.mjs`, `test-history.mjs`, `test-actions.mjs`, `test-e2e.mjs` | Playwright browser/API smoke tests. |
| `select-smoke.mjs`, `preview-smoke.mjs`, `select-debug.mjs`, `debug-pl.mjs`, `debug-err.mjs` | Playwright UI probes used while iterating on selection, preview and error states. |

## Running

Most scripts are run directly with Bun and expect the app to be available at
`http://127.0.0.1:8787` (the API) unless they spawn their own server:

```sh
bun run dev            # in another terminal, for the scripts that need it
bun dev/scaffolding/runner-concurrency-test.ts
bun dev/scaffolding/pool-test.ts
```

The `.mjs` scripts use `playwright-core` and need a local Chrome/Edge
installation. Screenshots and `fake-output/` written by these scripts are
git-ignored.
