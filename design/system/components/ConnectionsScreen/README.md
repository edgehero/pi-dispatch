Where jobs come from and what they may reach: forges and their webhooks, egress per host, model endpoints and provider keys, MCP servers, staged packages, the deployment environment, and how failures reach people.

**How a person uses it.**
- **Problems first.** A banner names the host whose egress proxy is missing and the run it refused, with the command that fixes it.
- **Forges.**
  - For each armed forge: which triggers arm it, the auth source and per-job token, how deliveries are verified and de-duplicated, polling, and who may fire.
  - An unconfigured forge collapses to one line saying its path answers 404. GitHub is enabled by a trigger or an explicit auth source; each other forge by any of its receiver variables. GitHub's implicit default auth source is shown as such.
  - One line says delivery health is not published and where to look instead.
- **Egress.** The posture, the allowlist (first hosts, then "and N more"), and each host's proxy with its last doctor check.
- **Model endpoints.** Each endpoint's host and port, whether it is keyless, its declared slots and fleet occupancy where counted. Per-machine aliases and deployments without a declared PI_WORKER_NAME say not counted; unread metadata or leases stay unknown. A banner covers the case where a host's own copy of the file does not load, quoting doctor. Provider keys are listed by variable name and where they come from.
- **Notifications.** Forge comments and the `PI_ON_FAILURE` hook. Its runs are in the worker's log; their history is not published.
- **MCP servers, Deployment environment, Staged pi packages.** All read-only, each with the command or file that changes it. Caps set only in the .env read "unknown (worker env or default)".

Viewers see the same page; nothing on it writes.

**Panels.** `p-connection-problems`, `p-forges`, `p-egress`, `p-endpoints`, `p-notify`, `p-mcp`, `p-env`, `p-packages`.

**The server provides.**
- Per forge: the triggers naming it, the auth source, whether verification secrets are set (names only), the webhook mode and path, and the polling settings.
- Per host: the egress proxy state and the newest egress doctor lines.
- The model endpoints file, declared slots and whether fleet leases count that endpoint, and the provider key sources.
- The overlay MCP servers with their refusals, and the staged packages receipt.
- The `PI_ON_FAILURE` hook by its last folder, its timeout and the fact that its runs are in the worker's log.
- The .env keys the console reads, and any shell-versus-.env disagreement.

**Why it works this way.**
- **Delivery health.** The receiver has no health check of its own, so the console cannot say whether deliveries arrive. Use the forge's delivery history for 401/404 refusals. The receiver log can help with 503 or enqueue failures; signature, route and early request refusals do not write a log line, and not every 503 is logged.
- **Endpoint slots.** Fleet leases count endpoints only when PI_WORKER_NAME is declared and the endpoint is not host.docker.internal or host.containers.internal. These aliases use per-machine capacity; without a host queue, the worker takes no fleet lease. Both cases say not counted and retain the declared capacity, rather than claiming zero. A failed lease read remains unknown.
- **Egress.** With egress on, each local or podman job gets its own internal network and reaches out only through its host's proxy: HTTPS (443) and plain HTTP (80) to listed hosts, plus the declared model endpoints. OpenShell applies its own sandbox policy from the same sources. A leading dot covers subdomains.
- **Notifications.** pi-dispatch sends none of its own. Forge comments are always on: one fixed sentence on the issue for a paid failure, and one when a run stops to ask. The failure hook runs once per paid failure with "job, outcome, reason, host" and has 10 s to answer; it never runs for completions, free refusals, recovered retries or a cancel.
- **MCP servers** are named by reference only; values never reach the page, and there is no form for them here.

**Fixture note.**
- **From the fixture:** build3's missing proxy, gh-e9a0, the linear MCP server, and the forges named by triggers 1 to 7.
- **Sample:** the receiver port, the allowlist hosts, both model endpoints and mini2's broken copy, the docs and dispatch-notes servers, the two staged packages, the hook path. Receiver location and hook history are not published, so the card says where to look rather than inventing them.
- **Known repo gaps:** webhook health is not published, and there is no notification setting beyond the hook.
