# Replica runs — two sandboxes racing one event

Some work is urgent enough that token cost stops mattering, and the useful thing to buy with it is not a
longer run but a **second opinion**: two agents solving one issue independently, two pull requests, one
human picking. `run.replicas` is the opt-in that does exactly that.

```jsonc
{ "on": { "type": "label", "any": ["pi:urgent"] },
  "run": { "kind": "github", "flow": "fix-issue", "replicas": 2 } }
```

It works on **every forge**: github, gitlab, forgejo and azure. Swap the `kind` and the nouns follow, a
merge request on GitLab and a pull request everywhere else. One limit worth knowing up front: on the three
non-GitHub forges this is **webhook only**, because the poller is GitHub-only, so a replica set is minted by
a delivery and never by a poll.

Label an issue `pi:urgent` and you get **two** containers, **two** branches, and **two** review requests.
Neither replica knows what the other did. That is the point — a comparison is only worth something if the
runs were independent.

Absent, nothing changes: one delivery, one run, byte-identically to before this feature existed.

## What actually diverges

Four layers of this system exist to collapse repeated attempts into one run — correctly, and by default.
Each is handed the replica index, and nothing else moves.

| Layer | Unreplicated | With `replicas: 2` |
|---|---|---|
| BullMQ job id | `<prefix><id>` | `<prefix><id>-r1`, `-r2` (`gh-`/`gl-`/`fj-`/`az-`, from the forge table) |
| Semantic dedup key | `repo<sep>7:fix-issue` | `…:r1`, `…:r2` (`#` for an issue, `!` where the forge numbers merge/pull requests separately) |
| Branch | `pi/issue-7` | `pi/issue-7-r1`, `pi/issue-7-r2` |
| Container name | `pi-job-<jobid>` | `pi-job-<jobid>-r1`, `-r2` (and one egress network each, named after it) |
| Review-request title (agent-honored, issue path only) | whatever the flow chose | `[r1/2] …`, `[r2/2] …` |
| Run record | `replica: null` | `replica: 1` / `2`, `replicas: 2` |

Every row but the PR title is host-enforced. The `[r1/2]` marker is prompt text the agent is asked to
carry into the title it writes, and it is emitted on the **issue** path only: the host mints the branch,
which is the only replica identity it actually enforces. A `pull_request` target has no branch and no
title to mint, so its prompt asks each replica to say "replica *i* of *n*" in whatever it posts instead.

The **branch suffix is symmetric** — there is no unsuffixed "original" and no "copy". A scheme where
replica 1 kept `pi/issue-7` would make the pair read as an original and a duplicate, which is the framing
that makes people stop comparing them.

**Redelivery still dedups**, by the same two mechanisms an unreplicated job uses. An *exact* redelivery
(the same webhook guid) is stopped by the job id: `<prefix><id>-r<i>` is already in the queue's history,
which is retained for 31 days. The 10-minute semantic window does a different job: it coalesces
*distinct* guids landing on the same `repo#7:fix-issue`, which is what absorbs re-label bursts. The
`:r<i>` suffix is added to that semantic key *only* when a replica is set, so each replica coalesces
against **itself**, never against its sibling.

## The budget arithmetic

This is the part to read before arming it.

Each replica is an ordinary job. It reserves **its own** budget slot before **its own** tokens, in its own
processor. So:

- `replicas: 2` on a trigger that fires 10 times a day consumes **20** slots of `dailyCap`, not 10.
- Token cost roughly doubles per delivery, and the daily token cap divides accordingly.
- Nothing is exempted or discounted. The caps remain the ceiling — **that is the feature**, not a
  limitation. Softening them for replicas would have turned a cost multiplier into a cap bypass.

`pi-dispatch doctor` reports how many triggers set the field, so a deployment can see the multiplier
without reading the file.

## Concurrency — replicas race only if there is room

`PI_CONCURRENCY` defaults to **3**, and replicas share that pool with every other job. Three replicas on a
busy worker will **serialise**, which still produces two comparable results but not at the same time. That
is why the cap is `2..3`: a fourth replica would queue rather than race, promising a comparison the
deployment could not deliver.

If you raise `PI_CONCURRENCY`, `REPLICAS_MAX` in `worker/src/triggers.mjs` is the literal to raise with it.

## Rebuild your image first

Replica support is half prompt and half **safety floor**. A replica's user prompt names
`pi/issue-7-r2`, but an image built before this feature bakes a `HARD_RULES.md` whose rule 3 hard-codes
`pi/issue-<n>` — and that is the **system** prompt, which the model treats as authoritative. Both replicas
would push to one branch. Nothing would error; you would pay for two runs and get one pull request.

So an image must declare it:

```dockerfile
LABEL dev.pi-dispatch.capabilities="replicas"
```

A replica job on an image that does not is refused **pre-spend** with reason
`job-image-replicas-unsupported` — no credential minted, no repo cloned, no budget slot burned — and the
refusal comments on the issue naming the fix.

Note the polarity, which is the **opposite** of `dev.pi-dispatch.forges`: that label is an *exclusion* list,
so an image declaring nothing is allowed every forge. `capabilities` is an *inclusion* list, so an image
declaring nothing is refused every replica. One rule underlies both — an image that declares nothing gets no
benefit of the doubt about what it contains.

`./image/verify-image.sh <tag>` checks that a label claiming `replicas` is backed by baked guardrails that
actually name the prompt's branch, so the label cannot lie.

## Where it is refused, and why

Each refusal is at config load, fail-loud, naming the field and the reason. Which service refuses depends
on which one reads the file: the receiver always loads it, so a webhook deployment refuses on every start;
the worker loads it only when `PI_TRIGGERS_FILE` is set (unset means cron is simply disabled there). A
worker without that variable will therefore start happily on a file its receiver rejects.

| Refused | Why |
|---|---|
| `kind: "local"` (a cron trigger) | A local job's `/workspace` **is** your folder, bind-mounted read-write and edited in place. Two replicas would edit one working tree with no gate and no undo. A forge job gets its own `mkdtemp`'d clone — that is the whole reason it is safe there. This is also the ONLY kind check left, so it is what keeps a cron entry out. |
| `replicas: 1` | A one-member replica set is a field that does nothing — and a field that does nothing is one you set and then trust. |
| `replicas: 4` or more | `REPLICAS_MAX` is the literal `3`, chosen because `PI_CONCURRENCY` defaults to 3 and a fourth replica would queue instead of racing. It is not a read of the concurrency setting: raising `PI_CONCURRENCY` does not raise the cap, so the literal is the line to edit (see above). |
| alongside `"resume": true` | A resumed run continues **one** lineage; replicas exist to fork it. Without this refusal every replica of an issue would resolve the same session key, share one transcript, and contend for the store's one-writer lock. |

## The review-request hazard

`replicas` is allowed on `pull_request` triggers, and there the guarantee is weaker — honestly so. A
**comment** trigger reaches the same state: a comment on a merge or pull request routes to that target, and
the loader allows one comment rule per forge, so arming `replicas` there arms this path too.

An **issue** target is fully bounded: the host mints a branch per replica and each is told to push only to
its own. A **pull_request** target has no branch to mint. The pull request's head branch belongs to a human,
and every replica sees the same one. If your flow only reviews or comments, nothing is written and two
independent reviews are exactly what you wanted. If your flow **pushes**, the harness bounds nothing — the
prompt asks each replica not to overwrite its sibling, and `--force-with-lease` (the only force `HARD_RULES`
permits) will refuse when a sibling has pushed, so a collision surfaces as a failed push rather than as lost
work.

This is tracked as `OQ-017` in [`specs/open-questions.md`](../specs/open-questions.md).

## What this deliberately does not do

- **No sibling cancellation.** A half-cancelled run has already spent its tokens, so the saving is
  illusory — and it destroys the comparison the feature exists to produce.
- **No auto-judging.** Ranking two agents' pull requests with a third paid agent, to save a human one diff
  read, is not a trade worth making. Two pull requests, one human, done.
- **No panel key and no AI tool.** `dispatch_trigger_add`/`_edit` carry no `replicas` parameter, for a
  sharper version of the reason they carry no `image` one: a spend multiplier is plainly a capability a
  model would *gain*. It is a file edit.

## Seeing the pair

The `/dispatch` panel badges each run `r1/2` in the runs list, and a run's detail screen names its sibling
by job id. `/dispatch runs` shows a `REPLICA` column. A trigger carrying the field renders `[x2]` in the
trigger list, and its drill-in states the multiplier alongside the trust model.

The run records themselves carry `replica` and `replicas` as plain integers — which is why they may be
there at all: the record is PII-free by construction and holds no attacker-chosen string, and a
host-assigned index is not one. The branch name they imply is deliberately **not** stored.

## Related

- [`REQ-REPLICA-RUNS`](../specs/requirements.md) — the requirement and its acceptance criteria
- [`DES-REPLICA-INDEX-REACHES-THE-BRANCH`](../specs/design.md) — the design and what was rejected
- [`docs/job-image.md`](job-image.md) — the image conformance checklist
- [`SECURITY.md`](../SECURITY.md) — the spend multiplier under "what is NOT defended"

## Two things that are not the same on every forge

- **Forgejo's "is there already a pull request?" step is a client-side scan.** `tea pr list` takes no
  branch filter, where `gh`, `glab` and `az` all filter server-side. Under replicas that listing shows your
  siblings' pull requests, whose branches differ from yours by a single character, so the replica prompt
  says so explicitly and tells the agent to match the `-r<i>` suffix exactly.
- **Only the GitHub App path mints a token per job.** On gitlab, forgejo and azure one operator-supplied
  token serves every project, so a replica set is N concurrent containers holding the SAME credential while
  working on one target. Nothing about that is new to replicas (any two concurrent jobs already share it)
  and `PI_CONCURRENCY` still bounds how many are live, but it is worth knowing before arming a set of three.

## Upgrading, and rolling back

The console bundles the trigger validator at build time, so a published `/dispatch` older than this feature
will **refuse every trigger edit** while a non-github `replicas` entry sits in the file, including the edit
that would remove it. Upgrade the admin extension together with the worker and receiver, not after.

Rolling back is the mirror image: an earlier worker or receiver refuses to load a file carrying non-github
`replicas` at all, loudly and at boot. There is no operator surface to unset the field (deliberately: it is
a spend multiplier, so it is a reviewed file edit only), so recovery is editing `triggers.json` by hand.
