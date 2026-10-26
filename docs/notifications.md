# Notifications — being told when a paid job dies

Every free refusal already announces itself: the pre-spend ladder posts a comment on the issue that
asked for the job, saying why nothing ran. This page is the other half, added by issue #288, and it
covers exactly the failures that used to be silent: the ones that already cost a container and tokens.

Two independent pieces. The comments are always on (they discharge a promise the spec already made);
only the hook has a knob, and a deployment that leaves `PI_ON_FAILURE` unset gets no hook,
byte-identically. So the one visible change on upgrading, with nothing configured, is that these
previously-silent failures now comment.

Every reason a run record can carry, and what to do about it, is explained in [reasons.md](reasons.md). Each
reason below has its own entry there.

## The worker's own terminal comments

These are always on, because they discharge a promise the spec already made ("exactly one completion or
failure comment exists on the issue", REQ-JOB-STATUS-COMMENTS):

| What happened | The comment |
|---|---|
| the 30-minute kill timer (or a worker shutdown) stopped the run | `Stopped: the worker ended this run before it finished ... Not retried.` |
| the operator cancelled the run (`pi-dispatch cancel`) | `Stopped: the operator cancelled this run. ... Not retried.` |
| the run ended inside the container (turn or token budget, an in-container config refusal, exit 2), for every runner reason except the ones named below | `Stopped: the run ended inside the container before finishing ... Not retried.` |
| the AI provider refused the key as an authentication or permission error (exit 2, reason `provider-auth-refused`): a bad or revoked key, or a key that may not use this model or route | `Stopped: the AI provider refused this worker's credentials or access (an authentication or permission error). The operator needs to check the provider key and what it is allowed to use. Not retried.` |
| a per-job cost limit or an allowed-model list stopped the next AI call (exit 2, reasons `cost-cap` and `model-not-allowed`; `cost-cap` is live on a job image that declares `costCap`, `model-not-allowed` on one that declares `modelPolicy`. The worker also uses `model-not-allowed` for a job it refuses before starting, when the model it would run on is not on the job's list; that refusal posts its own comment, spends nothing and pages nobody. A runner stop whose record has `modelRefused: 0` means the runner could no longer judge calls (its provider registry was replaced mid-run), not that a listed call was refused) | `Stopped: the next AI call could have taken this run past its cost limit ...` or `Stopped: the run tried to call an AI model this trigger does not allow, or to change an AI request in a way it does not allow ...`, each ending `Not retried.` |
| the job image could not enforce a cost limit or an allowed-model list before each AI call, so it refused before calling the provider (exit 2, reasons `cost-cap-unenforceable` and `model-policy-unenforceable`) | `Stopped: this run has a cost limit, and the job image could not enforce it ...` or `Stopped: this run is limited to certain AI models, and the job image could not enforce that ...`, each ending `The operator needs to update the job image. Not retried.` |
| the worker refused a job before starting because the deployment's overlay `models.json` cannot be used (reason `model-unknown`, with a `why` starting `overlay-` in the worker log and the run record: a file pi would drop, a folder, a file the worker cannot read, a link, a named pipe or device, or a provider entry pi will not put together). Spends nothing and pages nobody | `Refused before starting: the deployment's model settings file (models.json in the overlay) cannot be used for this job, so no container was started and nothing was spent. The operator needs to fix that file. Not run.` |
| a server the trigger names in `run.mcp` stopped the job before its prompt (exit 2, reasons `mcp-unavailable`, `mcp-config-invalid`, `mcp-config-mismatch`, `mcp-secret-missing`, `mcp-command-missing` and `mcp-shadowed`, [mcp.md](mcp.md)). The pickup's own `mcp-config-invalid`, for an overlay `mcp.json` it cannot read, is a refusal before starting: it posts its own comment, spends nothing and pages nobody | one fixed sentence per reason, such as `Stopped: an MCP server this trigger names could not be used (...), so the run ended before the agent started. The operator needs to check that server and the job image. Not retried.` None names the server, a host or a variable; the worker's log has them, on the job's `exit` line |
| a job armed with `run.awaitInput` stopped before its prompt (exit 2): another extension registers the tool a parked run ends on (`await-input-shadowed`), or the job had no transcript to park (`await-input-without-session`, a worker and image of different releases) | `Stopped: another extension in this job registers the tool a run uses to stop and wait for an answer, ...` and `Stopped: this run may stop to wait for an answer but had nowhere to keep its work, ...`, each ending `Not retried.` |
| a job armed with `run.progress` stopped before its prompt (exit 2): another extension registers the tool a run reports its progress with (`report-progress-shadowed`) | `Stopped: another extension in this job registers the tool a run uses to report its progress, so the run ended before the agent started. The operator needs to remove that extension or this trigger's run.progress. Not retried.` |
| a job armed with `run.awaitInput` asked a question and ended to wait for the answer (exit 0, reason `awaiting-input`). The agent posts the question itself; this is the one comment pi-dispatch adds on a completed run | On an issue: `This run stopped to wait for an answer to the question above. Reply here, and the next run continues from here.` On a pull request the reply must start with the comment phrase, and the comment says so |
| the job's container ran out of memory and the kernel killed the runner (exit 137, reason `oom-killed`). Only on a job image whose supervisor reports it: the worker reads it from the signed exit line, never from Docker's events (which also fire when only a child was killed), and only when the job's memory peak reached 90% of its limit (a kill by the host's own out-of-memory killer retries instead) | `Stopped: the job's container ran out of memory and was stopped. Partial work may exist. Not retried, because the same size would stop the same way. The operator can raise this job's memory size.` The comment names no size and no project; the run record and the worker log carry them |
| the FINAL infrastructure failure (retries exhausted, a stalled worker's job, an internal error) | `Failed: an error stopped this job and it will not be retried further. Ask the operator to check the worker log.` |

What deliberately does NOT comment here:

- **A completed run.** Exit 0 is where the agent's own status comment lives; the flow instructs it,
  including for "I looked and cannot fix this".
- **A retried attempt.** Only the final failed attempt comments, once, so a flaky docker daemon cannot
  post three comments for one recovery. The worker reads BullMQ's own terminal decision (`finishedOn`),
  never its own retry arithmetic.
- **The prepare-stage policy refusals** (`sha-gone`, the `.pi/` size caps). That silence is a separately
  recorded accepted risk (`OQ-023`), with its own hazard: a repo whose `.pi/` breaches a cap would
  comment on every delivery.

Every sentence is fixed text. No error message, no path, no payload word ever rides a comment: for a
local (cron) job the same text lands as a `comment` line in the worker's own log, which is a persistent
file on a shared host.

One more comment exists only when a trigger asks for it: with `"statusComment": true` the worker posts a status
comment when the container starts and edits it as the run goes, ending with how the run ended (as its run record
says) or, when the attempt will be retried, that it ended and is being retried
([triggers](triggers.md#optional-run-fields)). It holds numbers and fixed words only and comes on top of the comments
above; it is not the completion or failure comment, and it pages nobody.

## `PI_ON_FAILURE`: one command, wired by you

```sh
# .env
PI_ON_FAILURE=/opt/pi/notify.sh
```

When a paid job reaches a terminal failure, the worker runs your command, once, with four id-only
arguments:

```
/opt/pi/notify.sh <jobId> <outcome> <reason> <host>
```

- `outcome` is `failed` (final infrastructure failure) or `policy` (a worker abort or an in-container
  policy stop).
- `reason` is a fixed token, never a message: `worker-abort`, `runner-policy`, `provider-auth-refused`
  (the AI provider refused the key as an authentication or permission error: the key is bad, revoked, or
  not allowed this model or route, and every job fails the same way until the operator fixes it),
  `cost-cap`, `model-not-allowed`, `cost-cap-unenforceable`, `model-policy-unenforceable` (the cost limit and
  allowed-model rows above; the hook fires only for a run that took its budget slot, so the worker's free
  `model-not-allowed` refusal never reaches it), `mcp-unavailable`, `mcp-config-invalid`, `mcp-config-mismatch`,
  `mcp-secret-missing`, `mcp-command-missing`, `mcp-shadowed` (a job's MCP server stopped it before its prompt, above;
  the pickup's free `mcp-config-invalid` never reaches it), `await-input-shadowed`, `await-input-without-session` (a job
  armed with `run.awaitInput` stopped before its prompt, below), `report-progress-shadowed` (a job armed with
  `run.progress` stopped before its prompt, above), `oom-killed` (the job ran out of memory, above), `container-never-started`, `container-detached`, `secret-resolver-unreachable`,
  `container-infra-exit` (the job's container ended on the runner's infrastructure exit: a provider error or rate
  limit, a lost network, a crash inside the container), `container-exit-unknown` (it ended with an exit code the
  runner never uses), any other fixed token a failure legitimately carries, or `infra` when it carried no token (a
  forge call that failed, or a fault in the worker: the run record says `worker-error` for those). A reason reaches
  your argv only as a run record's reason token (lowercase letters, digits and `-`, starting with a letter or digit, at
  most 64 characters), so every reason the run record keeps arrives as itself; anything else, a message included, is
  flattened to `infra` first. A script that matched `infra` for a container that ended on exit 1 or an unknown code now
  sees one of those two tokens instead, and one that matched `infra` for a token longer than 40 characters (which was
  flattened before) now sees the token.
- `host` is the worker's declared name, possibly empty.

It fires for: the 30-minute kill, an in-container policy stop (exit 2, including a provider's refusal of
the key), a job killed for memory (`oom-killed`), and the final infrastructure
failure, including a job killed by a worker crash (the stall path fails it at the next pickup, and the
observing worker fires the hook). It does NOT fire for completions, for free pre-spend refusals (they
are free, they already comment, and a delivery storm against a spent cap must not page anyone), for
retried attempts that later recover, or for an operator's own cancel.

The whole notification feature is that argv. You wire the transport yourself:

```sh
#!/bin/sh
# ntfy
exec curl -fsS -d "pi-dispatch: job $1 ended $2 ($3) on ${4:-this host}" ntfy.sh/my-topic
```

```sh
#!/bin/sh
# Slack incoming webhook
exec curl -fsS -X POST -H 'Content-type: application/json' \
  --data "{\"text\":\"pi-dispatch: job $1 ended $2 ($3) on ${4:-this host}\"}" "$SLACK_WEBHOOK_URL"
```

## The contract, precisely

- **Exec'd, never a shell.** An argv array with `shell: false`; nothing interpolates.
- **Fire and forget.** The job's outcome is decided before the hook runs, and a hook fault cannot change
  it. A hook that cannot spawn, times out (`PI_ON_FAILURE_TIMEOUT_MS`, default 10s, then SIGTERM and
  SIGKILL 2s later), or exits nonzero produces one `on_failure` log line and nothing else.
- **All three stdio streams are ignored.** Nothing is entitled to read a notification's output.
- **At most once per job, best effort.** Delivery is not guaranteed: a whole-deployment death in the
  instant between the terminal transition and the listener loses the notification (a single crashed
  worker does not; the stall path covers it). Your exit code is logged and unread; a broken script loses
  notifications silently except for that line. Both residuals are recorded in the spec register.
- **Runs as the worker, with the worker's environment.** The same blast radius as a wait profile or a
  secret resolver, bounded the same way: only someone who can already edit `.env` can name the script.
