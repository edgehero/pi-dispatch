# Landing verification for issue #775

The maintainer requested merging the three PRs after the original ready-for-review handoff. Receiver PR #786 merged at `195c9777ac6bbcb7c9264f8536dacde88d7d1a6d`.

Hook PR #785 now includes that mainline at `0c72eea748ecb61af5e7b0553095838199672840`. Its full local suite with all required flags passes 12,579 tests with zero failures and six platform skips. New shared-publication tests check connection ownership, injected readers without URLs, failure isolation and Setup opt-out. The receiver and hook publishers coexist in all 38 hook browser cases; removing hook observations preserves the receiver. The full receiver matrix and 12 correctly styled reference cases also pass.

This folder holds selected fresh review screenshots, the numeric browser matrices and source/hash provenance. The remote Claude artifact remained inaccessible; references use the verified repository card with shared tokens, styles and native fonts. Final CI is still running at this publication. The PR stays draft until every applicable check is green.

Endpoint reconciliation and its final proof follow separately. Original handoff records under `775/` are historical and retain their original source revisions.
