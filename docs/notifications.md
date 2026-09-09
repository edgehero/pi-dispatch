# Notifications — being told when a paid job dies

Every free refusal already announces itself: the pre-spend ladder posts a comment on the issue that
asked for the job, saying why nothing ran. This page is the other half, added by issue #288, and it
covers exactly the failures that used to be silent: the ones that already cost a container and tokens.

Two independent pieces. The comments are always on (they discharge a promise the spec already made);
only the hook has a knob, and a deployment that leaves `PI_ON_FAILURE` unset gets no hook,
byte-identically. So the one visible change on upgrading, with nothing configured, is that these
previously-silent failures now comment.

## The worker's own terminal comments

These are always on, because they discharge a promise the spec already made ("exactly one completion or
failure comment exists on the issue", REQ-JOB-STATUS-COMMENTS):

| What happened | The comment |
|---|---|
| the 30-minute kill timer (or a worker shutdown) stopped the run | `Stopped: the worker ended this run before it finished ... Not retried.` |
| the operator cancelled the run (`pi-dispatch cancel`) | `Stopped: the operator cancelled this run. ... Not retried.` |
| the run ended inside the container (turn or token budget, an in-container config refusal, exit 2) | `Stopped: the run ended inside the container before finishing ... Not retried.` |
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
- `reason` is a fixed token, never a message: `worker-abort`, `runner-policy`,
  `container-never-started`, `secret-resolver-unreachable`, any other fixed token a failure legitimately
  carries, or `infra` when it carried none. Anything message-shaped is flattened to `infra` before it can
  reach your argv.
- `host` is the worker's declared name, possibly empty.

It fires for: the 30-minute kill, an in-container policy stop (exit 2), and the final infrastructure
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
