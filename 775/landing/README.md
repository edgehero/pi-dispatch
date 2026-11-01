# Landing verification for issue #775

The maintainer requested merging the three PRs after the original ready-for-review handoff. Receiver PR #786 merged at `195c9777ac6bbcb7c9264f8536dacde88d7d1a6d`.

Hook PR #785 now includes that mainline at `0c72eea748ecb61af5e7b0553095838199672840`. Its full local suite with all required flags passes 12,579 tests with zero failures and six platform skips. New shared-publication tests check connection ownership, injected readers without URLs, failure isolation and Setup opt-out. The receiver and hook publishers coexist in all 38 hook browser cases; removing hook observations preserves the receiver. The full receiver matrix and 12 correctly styled reference cases also pass.

This folder holds selected fresh review screenshots, the numeric browser matrices and source/hash provenance. The remote Claude artifact remained inaccessible; references use the verified repository card with shared tokens, styles and native fonts. Final CI is still running at this publication. The PR stays draft until every applicable check is green.

Endpoint reconciliation and its final proof follow separately. Original handoff records under `775/` are historical and retain their original source revisions.


Endpoint integration: final clean commit `84fe5f471db7a2127953dfdd76d3e594465da4ec`, tree `dd60d3cf4df2ece8e96ad820e74bf79a6ba8ce2a`. The complete required-integration local suite passed 12,598 with zero failures with six platform skips and clean temporary-directory oracle. Fresh actual-server/CSP captures cover receiver, hook and endpoint coexistence, plus twelve references with loaded shared tokens, bundle and native glyph fonts. Two deliberate fixture mutations fail the permanent endpoint-deletion checks: deleting the live host and republishing endpoint observations on a later heartbeat. The 800-pixel table intentionally scrolls horizontally; keyboard scrolling and an additional right-edge capture verify access to the full counts. CI is still running at this evidence publication; draft PRs become ready and merge only after all applicable final-commit checks pass. Direct remote-artifact comparison remains unavailable (403/Cloudflare); all references are repository published-source cards. Original handoff records remain historical.


All three PRs are merged in order: receiver #786 at195c9777, hooks #785 atfc7cd9f8, endpoints #787 at39763244. Issue #775 closed automatically from the last PR. All36 final PR checks passed; the final main tree equals actual endpoint CI checkout and final rendered-source tree dd60d3cf. Main push CI is a separate, pending post-merge run. [Final merge audit](final-merge-audit.json) records exact heads, merge commits, all statuses, required protection, skips, clean worktrees and preserved branches. Original screenshots remain pinned to their immutable evidence commits.
