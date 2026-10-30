# Console configuration evidence, issue #751

Implementation commit: `5e17f674d02240460a3cecbdcdced8381c33ffb7`.
Baseline: Configuration from main `0c9ef5e9d3c9d583871b828295dd29fbaed58174`, served with that revision's stylesheet, script and security headers. The later main changes incorporated by the implementation concern design documentation.

The after images show the served console against a synthetic deployment. Captures follow the last relevant UI changes. Size-add and size-edit previews came from actual browser interactions through the normal preview/confirmation funnel; the confirmed file changes were checked. The members-only preview was exercised and cancelled without a file mutation. The 375-pixel chart and 390-pixel forge table are close captures of the actual panels.

Paired images put the repository source card on the left and the actual served console on the right. Datasets differ. These references include this PR's generator corrections. Shared tokens, bundle stylesheet, system fonts and themes loaded before captures. All three cards passed 114 cases over nineteen widths in both themes, measuring label words, table text, chart axes and viewport bounds. The four-slot reference graphic has four markers.

The two `fixture-endpoints-*` images are **production-rendered exceptional-state fixtures**, served under the application's CSP with verified assets and fonts. They are not direct observations of the synthetic deployment: that deployment declares a worker name and legitimately reports fleet zero. The viewer fixture demonstrates an absent file worker-name declaration with retained capacity and no invented zero. The operator fixture shows two uncounted per-machine aliases beside a genuinely counted shared endpoint.

The final capture set contains 112 service captures (104 JavaScript captures with computed-style/font/CSP metadata and eight no-JavaScript captures with disabled-write and native-disclosure proof), 37 exceptional-state fixture screenshots, 36 selected styled reference captures and five paired comparisons. Selected images are retained here. The actual-CSP application sweep passed 2,551 page runs over 329 documents and 1,841 shell runs over 93 documents. Keyboard previews, cancellation/focus restoration, resolver validation, no-JavaScript behavior and exact size confirmations were exercised separately.

The remote Claude artifact returned a Cloudflare challenge and was inaccessible to the web tool. These images do not claim direct remote-artifact comparison. Evidence data contains no secret values, resolver lookup references or private home paths.

This separate evidence branch is not implementation code. The implementation branch contains no screenshot binaries, scratch scripts, planning notes or generated build output.
