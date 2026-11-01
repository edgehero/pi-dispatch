# Issue #775 review evidence

This branch holds review images and verification evidence for PRs [#786](https://github.com/edgehero/pi-dispatch/pull/786), [#785](https://github.com/edgehero/pi-dispatch/pull/785) and [#787](https://github.com/edgehero/pi-dispatch/pull/787). Each implementation PR targets `main` and includes permanent automated verification. Planning notes, scratch capture scripts, temporary files and generated admin build output remain outside the implementation branches.

## Source and capture provenance

| Slice | Final implementation commit | Last rendered implementation revision |
| --- | --- | --- |
| Receiver | `c3f0884c8891762f21804be02bc92b973a9e60d2` | `57390f856d4c1f92e7b84c9749f76052b38b371d` |
| Hook history | `06732c0f13d161bf681c063e28efed8195db7864` | `077af5493eb9bbb0167cb62bf09f5e84011b3189` |
| Endpoint slots | `a6d861edfb1f14dece63ba6af1eaf7cd496780ff` | `0065c8ae206508de6054f554ed9b914cbdade158` |

Before captures use main at `b9279bfada39ea151823b11bbc792592f9db8e4c`, except the explicitly labelled broken maximum-name capture from the earlier receiver feature revision `0b3c239ba09f4238e54a15fc2f93c4001e76cdc9`. The manifest records the source revision and SHA-256 for every image. Its listed follow-up changes affect verification only. Seven render-source Git objects per slice were independently compared and remain identical between the captured and final revisions. All 62 image hashes were verified against disk.

Captures use the production console server, authentication, CSP, renderers, readers and live Valkey 8.0.2 publishers, with synthetic service data and an injected clock. No paid agent run was made. Chrome for Testing is the repository-pinned `155.0.8059.39`. Its mac-arm64 archive SHA-256 is `529a71bd61aaa2ef266a4d4bd300ae9572ba6a3468a8d55c3023ffeffb5b6b4e`; the extracted executable was compared with the archive member. Full-page images should be inspected at native size when reading small counts; section captures improve legibility.

Each independent PR's browser lane covers 38 core combinations across operator, viewer and read-only operator access; light and dark themes; and widths 320, 375, 390, 760, 761, 800, 1024 and 1440. It tests actual values, links, keyboard interactions, no-JavaScript rendering and exceptional observations. Deliberately blocked inline code and removed styles are failing controls. Stylesheet rules, loaded fonts and native glyph fonts are verified before captures are used.

## Reference comparison

The remote Claude artifact was inaccessible (403/Cloudflare). References therefore use this repository's generated `design/system/components/ConnectionsScreen` published-source card, served over HTTP with its shared tokens and `bundle.css`. Each `reference-proof.json` records successful stylesheet loading, token colours, fonts, card geometry and native glyph fonts across 12 width/theme combinations. These are published-source comparisons. Different synthetic examples account for different rows and values in reference and application images.

## Behavior demonstrated

Receiver evidence includes all eleven outcomes, last taken/refused times and the 24-hour disclosure with explicit unobserved pre-start hours. Two extra real-publisher cases advance the clock 25 hours and retain an unserved route's exact refusal time while every rolling count is zero. Epoch-zero retention has a behavior regression. Valid 64-character names are checked character by character in 32 additional width/theme/role cases, plus two unavailable-record phone cases. Removing only the scoped wrapping rule reproduces the clipped text; restoring it makes every character visible. The disclosure's named region scrolls by keyboard with whole UTC labels.

Hook evidence shows distinct retained counts for exit 3 and timeout, plus keyboard access to host/run links and the longest permitted host name. A synthetic child exit passes through the real completion callback. Historical timeout data is seeded through the publisher; timeout escalation and unresolvable commands are exercised by injected unit/start integration tests. A successful hook exit is not a notification-delivery guarantee.

Endpoint evidence holds three real shared leases and displays local host usage of 1/1/2, including a conflicting capacity. Deleting observation fields preserves all three leases. Per-machine/unnamed workers, reduced capacities and modern-to-old-to-modern registry generations have behavior tests. The desktop table scrolls within its card at 800 pixels; phone rows stack with complete labels and ports.

Verification also covers a dirty ordinary database versus the isolated browser service, preserving the strict empty-database assertion and a foreign sentinel; a real recovery helper's late background credential refresh, including an untracked failing control; and initial live-panel races in existing browser checks. The receiver follow-up also makes the native Sandbox workspace GET parse gap deterministic, using the real response bytes and CSP. The same destination predicate is false while the panel is missing and true after release; removing only its guard reproduces the null read. All original 18 normal and 56 exceptional renders/interactions pass. The Answerer counterexample records structural native-event/node states and preview path/status counts only. A controlled panel replacement between press and release loses the click, submit and request. The paired applied-panel control passes the original stale-draft and exact-drop assertions.

## Verification records

All three PRs are ready for review on the recorded final commits. All 12 reporting checks on each commit are SUCCESS, including all six required contexts; admin enforcement remains enabled. Both Linux root-suite runs per PR have zero failures and five skips: four platform/filesystem cases and unavailable optional zsh (the local zsh round trip passed). No required integration flag was disabled.

- `775/final-remote-audit.json`: final heads, ready/clean PR states, all 36 successful reporting contexts, required contexts, commit/DCO/file audits and recognized closing reference.
- `775/manifest.json`: final/captured revisions, per-image hashes and source revisions, verification-only deltas and unchanged render objects.
- `775/combined-verification.json` and `775/combined-source-provenance.json`: the manually reconciled final union passed both 12,600-test root runs, the 615-file reporting oracle, real-CSP browser cases and the complete 4,163-page-render plus 2,241-shell-render sweep.
- `775/local-verification.json`: final full local suites, required integration flags, pinned local dependencies, browser matrices, counterexamples and final CI links.
- `775/pr-render-proof.json`: all 29 embedded images decoded successfully on the actual public GitHub pages (13 receiver, eight hooks, eight endpoints), with positive native dimensions after the final screenshots were embedded.
- `775/sandbox-native-get-counterexample.json`: committed destination URL before its panel parses, original exception, null-safe wait and exact reviewed workspace after release.
- `775/answerer-initial-panel-counterexample.json`: controlled native-interaction evidence without private draft content.
- Slice measurement/provenance files: actual rendered values, loaded reference styles/fonts and receiver boundary/lifetime cases.

All three independent PRs are validated against the same main baseline. Their shared source/spec/design/fixture files need reconciliation as the PRs land. The separate combined checkout validates a manually reconciled union; it does not claim conflict-free Git merges. Nothing has been merged.
