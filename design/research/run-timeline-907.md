# Runs by project: library decision and evidence

Issue [#907](https://github.com/edgehero/pi-dispatch/issues/907), 2026-11-15.

The Overview uses vis-timeline 8.5.6. Its HTML range items, grouped rows, read-only panning and editable DOM templates
fit individual runs without introducing a frontend framework. Apache ECharts 6.1.0 rendered the comparison fixture
faster, but would require custom overlap lanes, group expansion and individual keyboard navigation. The decision is
about the complete interaction, not raw chart construction speed.

## Comparison

Both exact npm artifacts were run under the console's production CSP, with the same 100-project fixture, 1,000,
10,000 and 50,000 intervals, overlapping 15-minute runs, sub-second runs and a six-hour initial window. These are
construction times from a local Apple M5 Pro, not end-to-end loading times or universal performance guarantees.

| Browser | vis, 1k / 10k / 50k (ms) | ECharts, 1k / 10k / 50k (ms) |
| --- | --- | --- |
| Chromium | 77 / 265 / 537 | 28 / 30 / 40 |
| Firefox | 169 / 594 / 846 | 18 / 25 / 39 |
| WebKit | 114 / 354 / 593 | 33 / 33 / 45 |

Both prototypes panned successfully at all three sizes in all three browsers, with no CSP violations or page errors.
The earlier unsuccessful vis drag probe hit its loading overlay before that overlay disappeared. The integration
makes that temporary overlay ignore pointer events. This comparison did not establish keyboard or touch suitability;
the actual application's browser tests establish those separately.

The vis peer/ESM distribution and external CSS work under the existing policy. The standalone distribution injects
style elements and is unsuitable unchanged. The production bundle pins vis-data 8.0.6 and Moment 2.31.0. Moment's
newer version replaces vis's exact 2.30.1 dependency through a root override, avoiding the older locale traversal
advisory. The browser bundle contains no locale input API exposed to run data. The repository's existing unrelated
undici audit finding is outside this dependency change.

The integrated browser script measures approximately 161 KiB gzip including license notices, plus 3.6 KiB gzip of vendor CSS. It loads
only on Overview, from the console itself. `.github/scripts/timeline-assets.mjs --write` regenerates the committed
asset module; a test rebuilds it and compares the exact output. The server serves strings and imports no browser
package or bundler at runtime. Package versions and licenses stay in the lockfile and retained license comments.

Primary references: [vis documentation](https://visjs.github.io/vis-timeline/docs/timeline/),
[ECharts custom series](https://echarts.apache.org/handbook/en/how-to/custom-series/),
[Bryntum layouts](https://bryntum.com/products/scheduler/examples/layouts/) and
[Grafana state timeline](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/state-timeline/).
Bryntum's stacking and Grafana's restrained time controls informed the design; neither is a dependency.

## Archive measurement and bounds

The existing `makeHistoryReader`, real temporary JSON files and an injected clock were used to scan a one-day window.
Files were generated one minute apart; the 10k and 50k archives each returned 1,442 overlapping records. Two runs per
size included normal filesystem caching; the operating system's disk cache was not flushed.

| Archive | First scan | Second scan | Pages | Slowest page |
| --- | --- | --- | --- | --- |
| 1,000 files | 56 ms | 61 ms | 11 | 7 ms |
| 10,000 files | 505 ms | 482 ms | 26 | 29 ms |
| 50,000 files | 2,472 ms | 2,544 ms | 126 | 29 ms |

These local measurements justify retaining the bounded asynchronous reader for this change. Remote hosts add network
latency; their unavailable/partial state remains explicit. The UI yields between requests, permits cancellation,
prefetches neighbouring ranges and keeps up to eight ranges with at most 5,000 records each. A new scan does not replace
the chart. Oversized ranges require explicit continuation; the interface states that more records remain. A new
reader under cursor pressure evicts only an idle reader and closes its handle, so repeated abandoned pans remain usable.
No persistent index, database, changed retention or run-record migration is introduced.

The chart draws at most 50 groups per group page and 600 individual collapsed marks plus one summary per group.
Expanding a group draws 200 individual runs per visual page. Thus even concurrent runs at an identical timestamp can
be reached in the chart. Each bar has a usable minimum hit width while its preview preserves the recorded timestamps
and duration. A supplementary list contains the current visual page, not an alternative hiding omitted runs.

## Integrated browser measurement

`node .github/scripts/console-timeline-browser.mjs --require --benchmark` runs the actual console with 100 projects,
30 days of synthetic history, 250 overlapping runs, short runs, and paginated metadata. On the same Apple M5 Pro,
Chrome 157.0.8103.51, at the default desktop viewport:

| Retained runs | Initial view ready | Heap after 12 / 24 pans | DOM nodes after 12 / 24 pans | Frame interval, p95 / maximum |
| --- | --- | --- | --- | --- |
| 1,000 | 447 ms | 3.15 / 3.31 MiB | 2,194 / 2,194 | 17 / 17 ms |
| 10,000 | 466 ms | 4.27 / 4.38 MiB | 3,522 / 3,522 | 17 / 17 ms |
| 50,000 | 585 ms | 8.93 / 8.98 MiB | 6,958 / 6,958 | 17 / 50 ms |

Each cycle pans six windows earlier and six later. Heap is sampled after explicit browser garbage collection, outside
the frame measurements. DOM includes the whole page, not just visible bars. This fixture isolates browser integration
and does not include disk scanning or remote-network latency; the real-file reader measurements above cover scanning.
The measured frame intervals are a local sample, not a universal frame-rate guarantee. The bounded cache, 50-group
pages, 600 collapsed marks, incremental item updates, shared time formatter and lazy supplementary list avoid work
proportional to the entire archive. Dense expansion still exposes 200 individual runs at a time.

## Verification

`node .github/scripts/console-timeline-browser.mjs --require --shots <directory>` exercises the real console, session,
CSP, locally bundled library and interval API with injected archive/host data. CI runs it in the pinned Chrome lane.
It covers pointer, horizontal-wheel and touch pan/load boundaries, zoom, dense-group expansion and paging, keyboard
preview, details and Back, stable SSE and focus, cancelled reads, UTC and seasonal/DST offsets, offline sources/retry
and hostile text. The synthetic fixture is
`admin/test/helpers/timeline-browser.mjs`.

Additional local Playwright checks exercised Chromium, Firefox and WebKit at 1440 and 390 pixels in Europe/Amsterdam.
Phone widths and touch input are emulated, not a claim of testing physical phones. WebKit exposed its history-write
rate limit; state writes are now throttled, with a synchronous save before opening details. Layout notifications also
must not reset the current dense-group page. Browser tests cover those interaction boundaries directly.

Before/after desktop and phone screenshots in both themes and a pan/zoom/open recording accompany the PR. Design
cards are static sample geometry; actual library behavior is judged from the browser evidence, not from golden HTML.
