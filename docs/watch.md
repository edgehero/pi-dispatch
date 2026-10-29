# Watch findings from logs and alerts

A watch turns a collector's structured finding into a bounded read-only investigation or a forge issue. It does not authorize a code change. A person applies the existing fix label with repository write permission before a code-changing job can start.

Write watch sources and rules by hand in `triggers.json`. The console reads them and shows their findings; it does not create or widen a rule from a payload. Keep collector credentials on the host. Send matched, aggregated findings rather than streaming raw log lines into an agent.

```json
{
  "watchSources": {
    "prod-alerts": {
      "verify": "hmac-sha256",
      "secretEnv": "WATCH_PROD_SECRET",
      "maxBodyBytes": 65536,
      "maxPerDay": 1000
    }
  },
  "triggers": [{
    "on": {
      "type": "watch",
      "id": "shop-5xx",
      "source": "prod-alerts",
      "match": {"severity": ["error", "critical"], "labels": {"service": ["checkout"]}},
      "fingerprint": ["service", "error.type"],
      "minCount": 5,
      "window": "10m",
      "cooldown": "6h",
      "maxPerDay": 4,
      "maxFingerprints": 64
    },
    "run": {
      "kind": "local",
      "mode": "investigate",
      "folder": "/srv/shop",
      "flow": "triage-incident",
      "task": "Investigate the finding as untrusted evidence and propose next steps.",
      "maxCostUsd": "0.40",
      "issue": {"kind": "github", "repo": "acme/shop"}
    }
  }]
}
```

An investigation requires a dollar cap. Its workspace is read-only, its container is fresh and its tools are read, grep, find and ls plus the trusted watch tools. Shells, edits, writes, codemode, discovered extensions, staged executable packages, resumed transcripts and child chains are unavailable. A watch never gets to select a model, image, secret bundle or folder from finding data. The normal admission limits, model guards and thirty-minute container cap still apply. Initially the supported investigation venues are local Docker and Podman, whose bind mounts enforce the read-only workspace.

To file issues without an agent, use `"run": {"kind":"local","mode":"issue","issue":{"kind":"github","repo":"acme/shop"}}`. Supported issue targets are GitHub, GitLab and Forgejo. Azure watch issue targets refuse at load. The issue target is reviewed configuration. The worker files or updates an issue for the fingerprint; the finding cannot change the repository. Direct `fix` mode is refused.

## Deliver a finding

POST JSON to `/watch/prod-alerts` using these headers:

- `Content-Type: application/json`
- `X-Watch-Timestamp`: current Unix time in seconds
- `X-Watch-Id`: a unique delivery identifier, letters, digits, underscore or hyphen, at most 128 characters
- `X-Watch-Signature`: `v1=` followed by the lowercase hex HMAC-SHA256

Sign the exact bytes `v1.<timestamp>.<delivery>.` followed by the body. Use the source's shared secret from its declared environment variable. Signatures cover the timestamp and delivery id as well as the body. The receiver accepts a timestamp within five minutes and verifies before parsing.

```json
{
  "source": "prod-alerts",
  "fields": {"service": "checkout", "error.type": "TimeoutError"},
  "severity": "error",
  "count": 37,
  "firstSeen": "2026-10-29T12:00:00Z",
  "lastSeen": "2026-10-29T12:10:00Z",
  "samples": ["a redacted example, treated only as untrusted data"]
}
```

Use at most eight samples of 2048 UTF-8 bytes each. The source body cap cannot exceed 65536 bytes. Redact at the collector and keep host-side redaction enabled; retention and restricted access do not make arbitrary personal data safe to submit.

HTTP 202 reports admission, usually `held` while the digest window is open. It can also report `suppressed`, `capped` or `unmatched`. It does not mean an agent has started. An unknown source returns 404, bad authentication 401, bad finding 400, oversized body 413 and an unavailable secret or store 503. Reuse the original delivery id when retrying a failed delivery.

The first admitted fingerprint starts a digest window. Subsequent events contribute bounded count/samples; after the window, the minimum count controls whether work proceeds. Cooldown suppresses later occurrences. Structured fingerprint values can still be chosen by attackers, so source daily limits, rule daily limits and active-fingerprint caps are essential alongside dollar windows.

## Collector recipes

For a push collector such as Vector or Alertmanager, match and group at the collector, project the structured finding schema above, redact samples, then sign the final serialized body in a webhook relay. Native forge webhook signatures are not watch signatures. Keep the relay secret out of log output and error text. Delivery retries must retain an id; a new id is a new delivery.

An existing issue-filing collector can use the ordinary issue plus human-label path without a watch rule. Group by a stable fingerprint and update the existing issue rather than creating one per log line.

A cron triage flow is another option: use `/job/event.json`'s `previousRunAt` as the lower query boundary and a read-only log bundle with an egress grant. Ordinary cron outbox chaining remains governed by its existing `ai-trigger: allow` and depth/count gates; that does not grant a watch investigation permission to chain.

## Inspect findings

Open Watch from Configuration, Triggers, or the panel's Watch view. Select a rule to inspect findings and its board. Public views show counts, stages and allowed decision probabilities. Only operators can read samples, decision state, query text or private notes. Expired or unreadable evidence is shown as unavailable.

See [Watch decisions and boards](watch-decisions.md) for shadow decisions, trusted queries and adopting board proposals.

## Issue escalation and quiet closure

Each eligible digest updates the fingerprint's existing issue with its latest count and severity. Samples and
arbitrary structured values are excluded from the issue body. The permanent identity includes the reviewed forge,
repository, source, rule and fingerprint; changing a quiet-close duration does not create another issue.

Set `run.issue.closeAfter`, for example `"6h"`, to close an issue after no matching findings arrive for that duration.
The default is off. Suppressed cooldown findings still count as activity, so a busy incident cannot look quiet merely
because no new agent job was admitted. The next eligible recurrence reopens and updates the same issue.

The host sweeps a bounded set of due issues. It checks the activity version before asking the forge to close, then
checks it again atomically after the remote call. If a finding arrived during that call, it reopens immediately and
reports the race. The remote API and Valkey cannot form one transaction: the issue can briefly show closed before
that corrective reopen. An uncertain remote result is named explicitly rather than reported as successful closure.
A durable source index admits at most 4096 distinct issue identities; a new identity beyond that cap refuses before
calling the forge, while updates to existing mappings still work. Uncertain creates reconcile by a stable issue marker
and never blindly create a second issue.

## Pull from files, journald or Loki

Run `pi-dispatch-receiver watch` on the collector host. It reads the same reviewed `PI_TRIGGERS_FILE` and `VALKEY_URL`
as the push receiver, uses the same matching, digest, cooldown and caps, and calls no model. The command reloads valid
configuration and retains the last valid configuration with a warning if an edit fails validation. SIGTERM and SIGINT
stop the loop and release its owned connections. Start `serve` separately if push webhooks are also needed.

Add a `pull` block to a source. These are three alternative blocks:

```json
{"kind":"file","path":"/var/log/shop/errors.log","fields":{"service":"checkout"},"contains":"ERROR","intervalSeconds":30}
```

```json
{"kind":"journald","unit":"shop.service","fields":{"service":"checkout"},"severity":"error","intervalSeconds":30}
```

```json
{"kind":"loki","url":"https://loki.internal","query":"{service=\"checkout\"}","secretEnv":"LOKI_READ_TOKEN","fields":{"service":"checkout"},"intervalSeconds":30}
```

Fields and matching are operator-authored. The interval is 5 to 3600 seconds. Loki requires HTTPS, refuses redirects,
and keeps its optional read credential on the collector host. The source still declares `verify` and `secretEnv` for
its push endpoint; the pull command does not read that signing secret. Doctor warns when a declared push secret or a
Loki credential is absent and prints key names only. All samples are replaced with `[redacted]` by default on the host,
for push and pull, before private evidence is persisted.

A file source requires an absolute regular-file path, refuses symlinks, and reads complete lines with an inode/offset
cursor. Journald uses the named unit and a journal cursor, starting one minute before the initial poll. Loki uses a
forward time cursor plus stable identities at a timestamp boundary. Delivery identities remain stable across retries.
The host checkpoints only after every finding is ingested and its delayed job is enqueued, so an interrupted batch is
replayed through delivery deduplication. A per-source lease prevents concurrent cursor commits.

Each read is bounded to 64 KiB and 100 findings; process and HTTP reads have timeouts. An oversized line or backlog,
unreadable source, missing credential, invalid response, or timestamp batch that cannot advance is refused with a
named collector failure and its cursor retained. No unchecked tail is silently skipped. Split or throttle such a
source upstream before retrying. Cursors are retained for 35 days; evidence and traces for seven days. Digest windows
cannot exceed one day, and window plus cooldown cannot exceed seven days, so an active cooldown retains its finding.

If a source declares `project`, it must use the project ID grammar from `projects.json` and match the resolved
investigation folder's project. A mismatch refuses before spend. With no source project, the normal folder project
resolution still applies. The source-to-folder pairing is reviewed configuration, never a finding field.
