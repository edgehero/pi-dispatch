# Visual evidence for #753, #754, #792, #793 and #796

Unmodified screenshots from fixture deployments, separate from the implementation branch.
Implementation: `f34497701964c4ff0097b808efc37cf5ca9ab403` (the final commit), which the Updates captures are from. The workbench, watching and run Workspace captures were taken at `be89961f13516a8de1bdaaddf8bcdd6d76c9bf03`; the commits after it change tests, a test harness's wait, the design index and the words of the Adopt preview, and nothing those captures draw. Zero touch is from `2b41c3abea7728f2d594d6d3a5fb7008be4be530`, and has not changed since.
Before: `deb7dfef867d469e0e90279719b3ecc033c60a27`.

Zero touch before and after use the same six sent-draft runs. Gateway captures use a real existing Docker sandbox, production application handlers and CSPs, distinct TLS sites, Secure/Strict cookies, xterm.js, and actual input/output. The driver follows both rendered Run and Sandboxes new-tab entry points. Its isolated certificate allowlist trusts only the generated fixture certificate; an unrelated self-signed certificate is rejected. No system trust store is changed.

References are the repository's published-source components. Before the final publish, every file of the remote design artifact was compared by hash with the repository: it held nothing the repository lacks. Reference probes confirmed loaded tokens.css and bundle.css, correct token colors, configured system font stacks and ready fonts before capture. Final application probes confirmed themes, stylesheets, fonts, terminal sizing and CSP. Light/dark, phone/intermediate/desktop, roles, keyboard, no-JavaScript and exceptional states were exercised. Root and independent reviewers inspected the final rendered screenshots against the styled source references.

These images contain synthetic fixture data and ephemeral sandbox identities. Only synthetic test commands appear in terminal screenshots; no operator token, authorization proof, cookie value or real customer content is included.

The pi TUI examples run the real pinned pi 1.5.0 CLI through the browser gateway, with Docker network mode `none`, no provider credentials, offline mode, and an explicitly unsent draft. The visible warnings are real. Ctrl+C cleared the draft and Ctrl+D returned to the existing bash shell; no model request was submitted. These show current single-session terminal capability, before the proposed multi-terminal workspace.

The `updates-*` captures are the real page's panels, drawn by the real readers from fixture facts, in the console's real stylesheet at each named theme and width. Probes confirmed the design tokens, `bundle.css` and fonts loaded and the canvas colours before capture. Their data is synthetic: package names, versions, hosts and costs are from the fixture deployment.
