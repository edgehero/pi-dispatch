# @edgehero/pi-dispatch-receiver

The trigger edge of **[pi-dispatch](https://github.com/edgehero/pi-dispatch)**, which runs the
[pi](https://github.com/earendil-works/pi) coding agent as a self hosted background service.

The receiver turns forge activity into queued jobs for the
[worker](https://www.npmjs.com/package/@edgehero/pi-dispatch). It reads the same `triggers.json` as the
worker, checks each delivery, and queues at most one job per event (one per replica when a trigger sets
`run.replicas`). It never runs a job itself.

## Two ways to run it

```bash
npx @edgehero/pi-dispatch-receiver         # serve: the webhook receiver (the default)
npx @edgehero/pi-dispatch-receiver poll    # poll: no public URL, reads GitHub with your own credential
```

- **`serve`** verifies GitHub, GitLab, Forgejo and Azure DevOps webhooks (at `/`, `/gitlab`, `/forgejo`
  and `/azure`). It listens on all interfaces by default (`RECEIVER_BIND=0.0.0.0`); set
  `RECEIVER_BIND=127.0.0.1` when a local reverse proxy or tunnel does the public exposure. `pi-dispatch
  service install --receiver`
  runs it as a service, and a container image is published as `ghcr.io/edgehero/pi-dispatch-receiver`.
- **`poll`** fetches GitHub issue events, comments and pull requests about once a minute, over TLS, with
  the same gates and the same queue. A new poller starts from now and never replays old labels.

The receiver checks each delivery's signature, the bot loop guard, the forge's own permission check and
dedup. The worker then applies quiet hours, the image preflight, branch protection and the spend caps.
Who may fire a trigger is decided by your forge. See
[`SECURITY.md`](https://github.com/edgehero/pi-dispatch/blob/main/SECURITY.md) for each forge's rule.

Configuration comes from the environment (the worker's `.env.example` lists all of it). The main settings
are `WEBHOOK_SECRET`, `VALKEY_URL` and `VALKEY_PASSWORD`, `PI_TRIGGERS_FILE`, `RECEIVER_PORT` and
`RECEIVER_BIND`, `POLL_REPOS` with `POLL_INTERVAL_SECONDS` for polling, and each forge's token and
webhook secret (see its setup guide). It needs `@edgehero/pi-dispatch` of the same major
version, which it installs as a dependency.

Setup guides: [GitHub](https://github.com/edgehero/pi-dispatch/blob/main/docs/github.md),
[GitLab](https://github.com/edgehero/pi-dispatch/blob/main/docs/gitlab.md),
[Forgejo](https://github.com/edgehero/pi-dispatch/blob/main/docs/forgejo.md),
[Azure DevOps](https://github.com/edgehero/pi-dispatch/blob/main/docs/azure-devops.md),
[polling](https://github.com/edgehero/pi-dispatch/blob/main/docs/polling.md). MIT licensed.
