Where jobs come from and what they may reach: forges and their webhooks, egress per host, model endpoints and provider keys, MCP servers, staged packages, the deployment environment, and how failures reach people.

**How a person uses it.**
- **Problems first.** A banner names the host whose egress proxy is missing and the run it refused, with the command that fixes it.
- **Forges.**
  - For each armed forge: which triggers arm it, the auth source and per-job token, how deliveries are verified and de-duplicated, polling, and who may fire.
  - Forges no trigger names collapse to one line saying their path answers 404.
  - One line says delivery health is not published and where to look instead.
- **Egress.** The posture, the allowlist (first hosts, then "and N more"), and each host's proxy with its last doctor check.
- **Model endpoints.** Each endpoint's host and port, whether it is keyless, and its slots in use. A banner covers the case where a host's own copy of the file does not load, quoting doctor. Provider keys are listed by variable name and where they come from.
- **Notifications.** Forge comments and the `PI_ON_FAILURE` hook, and when the hook last ran.
- **MCP servers, Deployment environment, Staged pi packages.** All read-only, each with the command or file that changes it. Caps set only in the .env read "unknown (worker env or default)".

Viewers see the same page; nothing on it writes.

**Panels.** `p-forges`, `p-egress`, `p-endpoints`, `p-notify`, `p-mcp`, `p-env`, `p-packages`.

**The server provides.**
- Per forge: the triggers naming it, the auth source, whether verification secrets are set (names only), the webhook mode and path, and the polling settings.
- Per host: the egress proxy state and the newest egress doctor lines.
- The model endpoints file and live slot leases, and the provider key sources.
- The overlay MCP servers with their refusals, and the staged packages receipt.
- The `PI_ON_FAILURE` hook path and its last `on_failure` log line.
- The .env keys the console reads, and any shell-versus-.env disagreement.

**Why it works this way.**
- **Delivery health.** The receiver has no health check of its own, so the console cannot say whether deliveries arrive. The forge's delivery history (401, 404 and 503 answers) and the receiver's log can.
- **Egress.** With egress on, each job gets its own internal network and reaches out only through the proxy: HTTPS (443) and plain HTTP (80) to listed hosts, plus the declared model endpoints. A leading dot covers subdomains.
- **Notifications.** pi-dispatch sends none of its own. Forge comments are always on: one fixed sentence on the issue for a paid failure, and one when a run stops to ask. The failure hook runs once per paid failure with "job, outcome, reason, host" and has 10 s to answer; it never runs for completions, free refusals, recovered retries or a cancel.
- **MCP servers** are named by reference only; values never reach the page, and there is no form for them here.

**Fixture note.**
- **From the fixture:** build3's missing proxy, gh-e9a0, the linear MCP server, and the forges named by triggers 1 to 7.
- **Sample:** the receiver port, the allowlist hosts, both model endpoints and mini2's broken copy, the docs and dispatch-notes servers, the two staged packages, the hook path, and its last run for gh-f0c2.
- **Known repo gaps:** webhook health is not published, and there is no notification setting beyond the hook.
