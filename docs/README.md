# Documentation

Supporting research and design records for Reelcreel. The product documentation
itself lives in the top-level [`README.md`](../README.md); these files record how
decisions were reached and what was verified.

| File | Contents |
|------|----------|
| [`PROJECT_RESEARCH.md`](PROJECT_RESEARCH.md) | Implementation record: architecture, job lifecycle, storage, verification evidence. |
| [`downloader-ui-and-concurrency.md`](downloader-ui-and-concurrency.md) | Downloader UI and concurrency design: the pool model, presets, accepted feature trade-offs. |
| [`BRANDING_RESEARCH.md`](BRANDING_RESEARCH.md) | Naming and logo system research, ending in the `Reelcreel` name and the "Reely" bobber-reel mark. |

These records are historical: they cite line numbers and a former
`docs/design/design.html` static mock that has since been removed. Treat the
source in [`../src/`](../src/) as authoritative over any quoted line reference.

Brand assets themselves (favicons, app icon, OG hero, mono mark) live in
[`../brand/`](../brand/), which has its own [file-to-use-case map](../brand/README.md).
