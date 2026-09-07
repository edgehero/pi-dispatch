# Polling ingest: GitHub triggers with no public URL

The webhook receiver needs to be reachable from GitHub. A tunnel, a reverse proxy, DNS, an open port,
and a secret to prove that whoever reached the port is really GitHub. `pi-dispatch-receiver poll` does
the same job from the other direction: it reads `api.github.com` with your own credential, on
connections it opens itself, and enqueues exactly the same jobs. No inbound surface at all.

It is the same gate, not a second one (with one addition: a close rule resolves the closer's write
access first, which the webhook arm does too, and which has its own failure mode below). Every object the poller reads is reshaped into the webhook
payload it corresponds to and run through the receiver's own `parseSubset` and the unchanged
`filter()`: the label allowlist, the author gate, the pull request author gate and the bot loop guard
have one implementation, and the poller cannot drift from it because it reimplements none of it. What
the HMAC buys on the inbound path, the outbound TLS handshake buys here.

The cost is latency. A webhook fires in about a second; a cycle is 60 seconds by default.

## Enable it

```
# .env
POLL_REPOS=acme/web,acme/api
GITHUB_AUTH_SOURCE=pat        # or app, see below
GITHUB_PAT=github_pat_...
VALKEY_URL=redis://127.0.0.1:6379
```

```
npx pi-dispatch-receiver poll
```

`WEBHOOK_SECRET` is not needed: there is no inbound delivery to verify, so demanding one would block
exactly the deployment this mode exists for. It is not quite unread, though, and the difference can
stop a boot. `poll` builds its config through the receiver's own loader rather than forking it, so a
`WEBHOOK_SECRET` that is present but blank-ish (spaces) still fails that loader's own check, and a
malformed `RECEIVER_PORT` refuses too, even though `poll` binds no port. A secret with a real value is
simply carried and unused, which is what lets one env file serve both commands.

Everything else is shared with `serve`: the same `triggers.json` (`PI_TRIGGERS_FILE`), the same GitHub
auth block, the same queue. Pair it with `pi-dispatch setup github --no-webhook`, which mints
credentials without asking you for a public URL.

## Which repos, and the two ways to say

`POLL_REPOS` is a comma separated list of `owner/name`. Duplicates are dropped. Each entry must be
exactly one slash with no whitespace, or the receiver refuses at boot and names the entry it could not
read.

Leave it unset **only** under `GITHUB_AUTH_SOURCE=app`. The poller then lists the App installation's
own repositories at boot and re-lists every tenth cycle (about ten minutes at the default interval), so
installing the App on a new repository starts polling it without an edit or a restart.

Unset under any other auth source is a boot refusal, and deliberately so:

> nothing to poll: set POLL_REPOS=owner/name[,owner/name...] or use GITHUB_AUTH_SOURCE=app so the
> poller can list the App installation's repositories

A personal access token names no repository set. A poller watching nothing would cycle forever, log
healthy summaries and trigger nothing, which is indistinguishable from working until somebody labels an
issue and waits.

The App path has the same guard one step later. If the installation grants no repositories, the boot
refuses with:

> the App installation grants no repositories -- install the GitHub App on the repos to poll, or set
> POLL_REPOS=owner/name[,owner/name...] explicitly

And a `POLL_REPOS` that parses to nothing at all, `,` for instance, refuses rather than falling back to
discovery: an empty list is not the same statement as no list.

## What it watches

Four endpoints, covering every trigger type a forge event can fire. `cron` is the worker's own
scheduler and has nothing to do with ingest, so it is not here.

| Endpoint | Serves | Notes |
|---|---|---|
| `GET /repos/{o}/{r}/issues/events` | `label`, and the close action of `pull_request` and `issue` | `labeled` entries cover issues and pull requests alike, because a PR is an issue here. A PR label fetches the PR once so the synthesized payload carries the same author association, labels, head and base a real delivery would. `closed` entries carry the closer as `actor`, and a merged PR emits `closed` too, which is what lets a close trigger release post merge work. The close half is read only when a close rule is armed, so an unarmed deployment's cycle is byte identical to one before close triggers existed |
| `GET /repos/{o}/{r}/issues/comments?since=` | `comment` | PR conversation comments are issue comments, so one endpoint covers both, as one webhook event does. The comment object lacks the issue fields the subset needs, so each new comment fetches its issue once |
| `GET /repos/{o}/{r}/pulls?state=open` | `pull_request`, actions `opened` `synchronize` `reopened` | diffed against a per PR head sha snapshot: an unknown number is `opened`, a known number with a new sha is `synchronize`, a number that left the open list and came back is `reopened` |
| `GET /repos/{o}/{r}/pulls/{n}/reviews` | `pull_request`, action `review_submitted` | per open PR, cursor is the last processed review id. Only open PRs are swept, because a review on a closed PR has nothing left to act on, and at most 50 per cycle, with a `poll_reviews_gap` line when a repository has more open than that |

## How it works

**Cursors, per repository, in Valkey.** Each source keeps its own position: the last event id, the
comment `since` timestamp, the open PR head sha snapshot, the last review id. They carry a 35 day TTL
and are refreshed together after each successful poll of that repository. 35 days deliberately outlives
the 31 day `gh-*` job id retention, so the cursor and the job id stay two coherent dedup layers rather
than one expiring under the other.

**A fresh poller starts from now.** On first boot, and on a repository newly added to the set, cursors
are initialized to the current position without enqueuing anything. A label applied months ago was a
human approval for that moment's issue text and that moment's budget, not a standing order.

**Dedup without a delivery id.** Polling has no `X-GitHub-Delivery`, so each source mints a
deterministic stand in that survives a retried cycle: `poll-e<eventId>`, `poll-c<commentId>`,
`poll-pr<number>-<headSha7>` and `poll-rv<reviewId>`. The PR id is keyed on the sha so a retried cycle
cannot enqueue twice while a real new push still mints a new id.

**Politeness.** Per endpoint, per repository ETags make the idle steady state nearly free, because 304
responses do not count against the rate limit. GitHub's own `x-poll-interval` header is honored as a
minimum cycle delay whenever it arrives, so a busy hour slows the loop rather than the loop hammering
the API. An exhausted rate limit sleeps until the reset, plus jitter, and says so.

**The closer gate, on close rules only.** A close carries the closer as `actor`, and their write
access is resolved before the trigger gate runs, exactly as the webhook arm does it. That lookup can be
indeterminate (GitHub answering neither yes nor no), and when it is, the events feed for that repository
ends for the cycle with a `poll_close_gate_retry` line, leaving the cursor before the event so the next
cycle tries again. After twenty consecutive indeterminate attempts on one event, the close is dropped
with `poll_close_gate_gave_up` and the cursor moves past it. Those two lines are the ones to read when a
close trigger has not fired, and nothing redelivers to a poller, so the second one is a real loss stated
loudly rather than hidden.

**Failure isolation.** One repository's API error skips that repository for the cycle and is logged;
it never kills the loop, because one archived or deleted repository must not stall nine live ones. The
close gate above is the one case that ends a single feed early rather than skipping the whole
repository. Configuration errors exit 2, so a supervisor does not restart loop a config that cannot
parse. `SIGTERM` finishes the repository in flight, prints the cycle summary, and closes cleanly.

## The traps

### 1. It is a producer, not a worker

`poll` enqueues jobs. A worker still has to run somewhere to take them, exactly as with the webhook
path. A deployment with a poller and no worker fills a queue.

### 2. GitHub only

GitLab, Forgejo and Azure DevOps have no polling path at all, and their setup docs say so. A deployment
servicing those forges needs the webhook edge for them, and can still poll GitHub beside it.

### 3. Latency is a cycle, and the floor is 30 seconds

`POLL_INTERVAL_SECONDS` defaults to 60, and a positive value below 30 is raised to 30: a typo'd `1`
must not turn the harness into a hammer. Only a positive integer gets that treatment. `0`, a negative,
a fraction or junk refuses the boot instead, which is the same split `PI_WAIT_INTERVAL_MS` makes. The effective delay is the larger of your interval and any `x-poll-interval`
GitHub asked for, so it can be longer than you configured and never shorter than 30.

### 4. A reopen inside one cycle is invisible

The open PR list shows presence, not transitions. A pull request closed and reopened between two cycles
was never absent from the list, so nothing fires. A reopen that also pushed fires a single `reopened`
where webhooks would fire two events, and the fresh sha still rides the job. Both are stated because
they are the price of diffing a list rather than receiving events.

### 5. A deep backlog is skipped, loudly

The events endpoint has no `since`, so the poller reads at most five pages of it per repository per
cycle. A backlog deeper than that is skipped with an explicit log line rather than stalling the cycle.
Comments self heal, because their cursor advances and the next cycle collects the rest.

## Reference

| Variable | Default | Meaning |
|---|---|---|
| `POLL_REPOS` | unset | comma separated `owner/name`, deduplicated. Unset means discover from the App installation, and is a boot refusal under any auth source but `app` |
| `POLL_INTERVAL_SECONDS` | 60 | seconds between cycles, floored at 30 (a positive value below it is raised; 0, a negative, a fraction or junk refuses at boot), raised further by GitHub's own `x-poll-interval` |

`WEBHOOK_SECRET`, `RECEIVER_PORT` and `RECEIVER_BIND` are `serve` concerns and `poll` uses none of
them, but it does load them, because it reuses the receiver's loader rather than forking it. A
malformed value in any of the three refuses a `poll` boot with that loader's message. Everything in
[`docs/secrets.md`](secrets.md) about the receiver applies here unchanged: the poller holds the same
forge credential and the same queue URL.
