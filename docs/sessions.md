# Resumable sessions

When a pull request a pi-dispatch job opened gets feedback, the follow-up job is a cold start: new
container, fresh clone, empty transcript. The agent re-explores the repository and re-derives the
decisions it made an hour ago before it can act on a two-line comment.

A trigger can opt into continuing that conversation instead.

```jsonc
{ "on": { "type": "comment", "phrase": "@pi" },
  "run": { "kind": "github", "flow": "fix", "resume": true } }
```

Off by default. A deployment that sets nothing writes nothing to disk and its containers are launched
with exactly the arguments they were before this feature existed.

## Setup

`PI_SESSIONS_DIR` has **no default**, deliberately — unlike `PI_LOGS_DIR`, which falls back to your OS
temp dir. That directory is mode `1777` on POSIX and is not where this belongs.

```bash
mkdir -p ~/.pi-dispatch/sessions && chmod 700 ~/.pi-dispatch/sessions
```

```bash
PI_SESSIONS_DIR=/home/you/.pi-dispatch/sessions
PI_SESSIONS_TTL_DAYS=14        # default 14; 0 = keep forever
PI_SESSION_MAX_BYTES=8388608   # default 8 MiB; 0 = no cap
PI_SESSION_MAX_AGE_DAYS=       # unset/0 = no bound; how old the conversation itself may be
PI_SESSION_MAX_RESUME_CHAIN=   # unset/0 = no bound; how many times in a row one key may be resumed
PI_SESSION_MAX_CONTEXT_PCT=    # unset = no bound; 1-100, e.g. 80: refuse a resume into a context already this full
```

`pi-dispatch doctor` reports the store whenever a trigger arms the flag, and fails that check when
`PI_SESSIONS_DIR` is unset. It also prints which of the four bounds are on, because a knob that is silent
when unset gives you no way to tell a deliberate "no bound" from a forgotten one, and it warns when
`PI_SESSION_MAX_CONTEXT_PCT` is set, since that one needs a job image whose runner reports the
measurement and does nothing at all on an older one. On an image that does report it, readings are kept
whether or not the bound is set, so switching the bound on applies from the next job rather than from the
next run of each key. **One case fails closed**: a trigger that sets `"resume": true` with no store
configured is refused **before it costs anything**, as a policy refusal that reserves no budget slot and
starts no container, rather than running unpersisted and looking like it worked. That is the whole reason
the refusal exists: a green run is exactly how an operator comes to believe a feature is on while it is
off. It lands in the run record as `"reason": "sessions-dir-unset"` and comments on the issue naming the
two ways out, set the variable or drop the flag. The refusal is per delivery rather than at load, because
whether a store exists is a property of the deployment and not of the triggers file; `doctor` is what
tells you before the first delivery arrives.

## Read this before you enable it

**A transcript is the most sensitive thing this system stores.** It holds the issue text, the contents of
every file the agent read, its tool output, and its own reasoning. That is strictly more than
`logs/<jobId>.log` holds — and that one is opt-in and off by default for exactly this reason. Unlike the
raw log, a transcript has to exist for the feature to work at all.

Put the store outside every git repository. The shipped `.gitignore` covers the conventional layout
(a `sessions/` directory) and cannot cover a path it has never seen.

**Who can be handed one.** Sessions are keyed by `(forge, repository, branch)`, and a branch name is chosen
by anyone who can push to your repository. It is tempting to reason that `pi/issue-7` names issue 7's
work forever — it does not. That branch name is something the agent was *asked* to use; nothing verifies
it, and branches, unlike issue numbers, can be deleted and re-created by someone else. So the population
that can receive a transcript is your repository's **push-access** population.

That is one step wider than the population pi-dispatch already trusts to put code in a job container, and
what they gain is short: the model's own reasoning, and anything a credential-bearing command echoed.
It is worth being concrete about how small that step is: pi-dispatch already lets anyone who can land a
commit on your default branch **run code inside a job container**, with the job token and open network
egress. This lets a slightly wider group **read a transcript**. Wider population, much narrower capability.

**So: do not enable this if you service repositories whose push access you do not control.** If your
deployment is your own repos, or your team's, the people who could be handed a transcript are people who
can already push code the agent will run — and refusing them a transcript would be a lock on the wrong
door. If you run pi-dispatch for repositories belonging to others, `run.resume` is not for you, in the
same way context discovery is not (`SECURITY.md`). Nothing enforces this: no code here can tell the two
situations apart, which is exactly why it is written down in three places. `specs/open-questions.md`
records the full reasoning as `OQ-014`.

**A fork pull request never resumes.** No key is resolved, no mount is created, and the job is identical
to one run before this feature. That is what stops a stranger forking your repo, naming a branch
`pi/issue-7`, and being handed issue 7's history.

**A `run.resume` job refuses to start under `GITHUB_AUTH_SOURCE=gh`.** That source is your whole `gh`
login: full-scope and non-expiring. An env var dies with the container; a transcript is a **file**, and any
command that echoed an auth header put your token in it, permanently. The refusal happens at mint time, so
it costs no budget slot.

Use `GITHUB_AUTH_SOURCE=app` or a short-expiry fine-grained PAT, so the exposure is bounded by an expiry
rather than by whether an agent ever ran a verbose curl. If you want the trade anyway, take it explicitly:

```bash
PI_SESSIONS_ALLOW_GH_SOURCE=1
```

It is a refusal rather than a warning because the asymmetry decides it: a warning is read once at setup,
and the disclosure is permanent and silent.

## What actually gets resumed

| trigger | key |
|---|---|
| issue label / comment on an issue | the `pi/issue-<n>` branch the job is told to push to |
| comment / activity on a pull request | the PR's head branch, read from the forge API |
| `pi-dispatch run`, chained `/outbox` jobs | nothing — these never resume |

The issue and pull-request cases converge because they are the same branch: issue #7's job opens PR #8 on
`pi/issue-7`, and a later comment on PR #8 resolves that same branch. That join is why a branch is the key
and not a number.

**Cron resume is refused at load, not yet covered.** The session store is handed only to the forge
preparers: a `kind: "local"` job returns from `prepareWorkspace` before that point, so nothing would ever
resolve a key for it. Rather than accept a flag that does nothing, `run.resume` on a cron trigger is
refused fail-loud when the triggers file loads, the same way `run.replicas` is. A key for it exists in
principle (the trigger's own `on.id`, operator-authored and stable across fires), so this is a gap to
close rather than a permanent limit, and the refusal says so.

**Command triggers refuse `resume` the same way, on every kind.** A command job's whole prompt is the
dispatch line `/name args`, and what a resumed session should do with a re-dispatched command is
undesigned — so `run.resume` beside `run.command` is refused fail-loud at load, another gap to close
rather than a permanent limit ([`workflows.md`](workflows.md)).

## When it silently doesn't resume

Every one of these is a **cold start, never a failed job**, and every one is named in the run record's
`session.reason` so you can tell them apart. That last part was not true until recently: a refused read
stages an empty transcript, the container opens it and reports `absent`, and that used to overwrite the
host's answer, so `expired` and `pi-version-changed` never reached a record at all. A gate that refused
now keeps its own name on the record. What the container found is still what you see whenever the
container is the one that found it: `unparseable` below is reported by both, and a run whose transcript
the host resolved and the container could not use reads `absent`. Be careful with that last one, because
in the record it looks exactly like an ordinary first-ever cold start: the record carries the container's
verdict, not the host's intent. The worker's own `session_resolved` log line is where the two halves can
be told apart.

| reason | meaning |
|---|---|
| `absent` | first run for this key, or the previous one produced nothing |
| `expired` | older than `PI_SESSIONS_TTL_DAYS`, measured from the last **completed** run on the key (the promotion is what refreshes the file) |
| `conversation-too-old` | the conversation itself started more than `PI_SESSION_MAX_AGE_DAYS` ago. A different clock from `expired`: that one reads the transcript's mtime, which every completed run refreshes, so a lineage that keeps finishing work never ages out however old its first turn is. A header whose timestamp is missing or unreadable lands here too, because a conversation that cannot say how old it is has not been shown to be young enough. The timestamp is written by the agent's own session, so this bounds accumulation, not an adversary |
| `too-large` | over `PI_SESSION_MAX_BYTES` |
| `unparseable` | the first line is not a pi session header. Nothing is quarantined: the canonical file stays where it is and is re-read and re-rejected on every run, until the TTL reaper sweeps the key or a completed run promotes a replacement over it |
| `not-a-regular-file` | ignored, not refused: the check is an `lstat`, so a symlink planted in `/session` is never followed, and the job runs cold |
| `pi-version-changed` | the job image ships a different pi than wrote the transcript |
| `context-too-full` | the saved session's context was already at or above `PI_SESSION_MAX_CONTEXT_PCT` of its model's window when it was last written. The measurement comes from the job image's runner, so on an image that does not report one this bound does nothing at all; where there is no measurement the gate passes rather than guessing, and it never estimates one from the transcript's size. The reading is stamped with the model that produced it and ignored by a job running a different one, since the same token count is most of a small window and almost none of a large one. A cold start clears it, so a key cannot be refused forever on a number describing a conversation it no longer holds |
| `resume-chain-too-long` | the host has already handed this key's transcript to a container `PI_SESSION_MAX_RESUME_CHAIN` times in a row. It counts deliveries rather than what pi made of them, so an agent cannot reset it by arranging for pi to find nothing usable in a file it still receives. The count is kept for every key whether or not the bound is set, so setting it takes effect on the next job rather than that many jobs later, and the cold start it causes resets the count **once that run completes**: a lineage whose runs keep failing keeps cold-starting, which is the safe direction |

`pi-version-changed` is the one that surprises people. A transcript can outlive the pi that wrote it, and
an older session's stored tool-call arguments may not match a newer pi's tool schema. Rather than fail
mid-run, the resume is refused. **Upgrading the job image costs every key one cold start**, by design:
nothing is deleted, each key simply cold-starts the first time its stamped version fails to match, and its
next completed run rewrites both the transcript and the stamp.

Two further reasons reach `session.reason` without being read-path outcomes at all. Both come from
`promoteSession`, so both appear only on a **completed** run, and both describe the *write* back to the
store rather than the read that started the job. A refused promotion outranks everything else on the
line, because it says why the NEXT run for this key will cold start:

| reason | meaning |
|---|---|
| `locked` | the key was already held by another job's exclusive promotion lock |
| `promote-failed` | the write itself failed: a full disk, or a permissions change under the store mid-promotion |

`locked` is the one with a design behind it. That run discards its own copy rather than clobbering the
other's, and the reason is recorded to explain why the next run for the key will not see this run's work.
Two jobs on one pull request inside one runtime is a real shape (`REQ-QUEUE-BURST-NO-DROP`), and
last-write-wins there would interleave two agents' turns into one transcript. `promote-failed` is the
disk telling you something: the run itself succeeded and its result is already on the forge, but its
transcript did not persist, so the next run for that key cold-starts.

A refused promotion **wins** over whatever the read path said, because on a completed run the more useful
reason is the one that explains the *next* run's cold start rather than this one's.

Two values are not cold starts at all and round out the enum: `resumed`, the transcript loaded and pi
continued it, and `disabled`, which every job that did not arm `run.resume` records.

## Cost

A resumed job starts with the whole prior conversation in its context, so its per-turn token cost is
*higher* even though it should need fewer turns. `PI_MAX_TOKENS` counts that replayed prefill on the first
call, so a long-running key can breach a per-job budget before doing any work.

The run record's `tokens` field already measures this per job. Measure it on your own repository before
assuming resume is cheaper — it is a real trade, not a free win, and `PI_SESSIONS_TTL_DAYS` is the knob
that bounds how long a conversation accumulates.

## What is stored

```
<PI_SESSIONS_DIR>/<hash>/current.jsonl   the transcript
<PI_SESSIONS_DIR>/<hash>/pi-version      which pi wrote it
<PI_SESSIONS_DIR>/<hash>/resume-chain    how many times in a row it has been resumed
<PI_SESSIONS_DIR>/<hash>/context         how full the context was when it was last written
<PI_SESSIONS_DIR>/<hash>/lock            the one-writer promotion lock; absent when free
```

The directory name is a hash, not a readable path, so a branch name never becomes a filesystem path and a
listing of the store names none of your repositories.

The store itself is **never mounted into a container**. Each job gets its own copy, and only a job that
completed successfully has its copy promoted back — so a failed or retried job leaves the stored
transcript exactly as it was.

Deleting the whole directory is always safe: every key degrades to a cold start and nothing else breaks.
