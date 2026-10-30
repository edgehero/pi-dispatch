# Console configuration evidence, issue #751

Implementation commit: `000505bd05dca1ad1152c85fbebf4ba59e303907`.
Baseline: Configuration from main `0c9ef5e9d3c9d583871b828295dd29fbaed58174`, served with that revision's stylesheet, script and security headers.

The after images are the actual served console against a synthetic deployment, captured after the last source change. Size-add and size-edit previews came from real browser interactions through the normal preview/confirmation funnel; confirmed file changes were checked separately. The paired images put repository-published source cards on the left and the served console on the right. Their data differs. The 375-pixel chart is a close capture of the actual rendered panel.

Shared tokens and stylesheets, resolved fonts, both themes, CSP and full panel inventories were checked before captures. Browser capture matrix: 104 actual/read-only captures with computed style, font and CSP metadata, 8 no-JavaScript captures with disabled-write proof, 17 explicitly labelled exceptional-state fixture screenshots and 24 source-card references with per-capture token/style/font proof; selected images are retained here for the PR.

The remote Claude artifact returned a Cloudflare challenge. These images do not claim direct comparison with that remote artifact. No secret values, references or private home paths are evidence data.

This separate evidence branch is not implementation code. The implementation branch contains no screenshot binaries, scratch scripts, planning notes or generated build output.
