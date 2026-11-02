# Visual evidence for #753 and #754

Unmodified screenshots from fixture deployments, separate from the implementation branch.
Implementation: `1d33530d` (the final commit) for the workbench, watching and run Workspace captures; `2b41c3abea7728f2d594d6d3a5fb7008be4be530` for Zero touch, which has not changed since.
Before: `deb7dfef867d469e0e90279719b3ecc033c60a27`.

Zero touch before and after use the same six sent-draft runs. Gateway captures use a real existing Docker sandbox, production application handlers and CSPs, distinct TLS sites, Secure/Strict cookies, xterm.js, and actual input/output. The driver follows both rendered Run and Sandboxes new-tab entry points. Its isolated certificate allowlist trusts only the generated fixture certificate; an unrelated self-signed certificate is rejected. No system trust store is changed.

References are the repository's published-source components. The remote Claude artifact was inaccessible, so these images do not claim direct remote comparison. Reference probes confirmed loaded tokens.css and bundle.css, correct token colors, configured system font stacks and ready fonts before capture. Final application probes confirmed themes, stylesheets, fonts, terminal sizing and CSP. Light/dark, phone/intermediate/desktop, roles, keyboard, no-JavaScript and exceptional states were exercised. Root and independent reviewers inspected the final rendered screenshots against the styled source references.

These images contain synthetic fixture data and ephemeral sandbox identities. Only synthetic test commands appear in terminal screenshots; no operator token, authorization proof, cookie value or real customer content is included.

The pi TUI examples run the real pinned pi 1.4.0 CLI through the browser gateway, with Docker network mode `none`, no provider credentials, offline mode, and an explicitly unsent draft. The visible warnings are real. Ctrl+C cleared the draft and Ctrl+D returned to the existing bash shell; no model request was submitted. These show current single-session terminal capability, before the proposed multi-terminal workspace.
