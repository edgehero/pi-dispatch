# Replica runs — two sandboxes racing one event

Some work is urgent enough that token cost stops mattering, and the useful thing to buy with it is not a
longer run but a **second opinion**: two agents solving one issue independently, two pull requests, one
human picking. `run.replicas` is the opt-in that does exactly that.

```jsonc
{ "on": { "type": "label", "any": ["pi:urgent"] },
  "run": { "kind": "github", "flow": "fix-issue", "replicas": 2 } }
```

Label an issue `pi:urgent` and you get **two** containers, **two** branches, and **two** pull requests.
Neither replica knows what the other did. That is the point — a comparison is only worth something if the
runs were independent.

Absent, nothing changes: one delivery, one run, byte-identically to before this feature existed.

## What actually diverges

Four layers of this system exist to collapse repeated attempts into one run — correctly, and by default.
Each is handed the replica index, and nothing else moves.

| Layer | Unreplicated | With `replicas: 2` |
|---|---|---|
| BullMQ job id | `gh-<guid>` | `gh-<guid>-r1`, `gh-<guid>-r2` |
| Semantic dedup key | `repo#7:fix-issue` | `repo#7:fix-issue:r1`, `…:r2` |
| Branch | `pi/issue-7` | `pi/issue-7-r1`, `pi/issue-7-r2` |
| Container name | `pi-job-gh-<guid>` | `pi-job-gh-<guid>-r1`, `-r2` |
| PR title | whatever the flow chose | `[r1/2] …`, `[r2/2] …` |
| Run record | `replica: null` | `replica: 1` / `2`, `replicas: 2` |

The **branch suffix is symmetric** — there is no unsuffixed "original" and no "copy". A scheme where
replica 1 kept `pi/issue-7` would make the pair read as an original and a duplicate, which is the framing
that makes people stop comparing them.

**Redelivery still dedups.** The `:r<i>` on the semantic key is added *only* when a replica is set, so
GitHub redelivering the same webhook inside the 10-minute window enqueues nothing new — each replica
coalesces against **itself**, never against its sibling.

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

Each refusal is at config load, fail-loud, in both services, naming the field and the reason.

| Refused | Why |
|---|---|
| `kind: "local"` (a cron trigger) | A local job's `/workspace` **is** your folder, bind-mounted read-write and edited in place. Two replicas would edit one working tree with no gate and no undo. A GitHub job gets its own `mkdtemp`'d clone — that is the whole reason it is safe there. |
| `gitlab` / `forgejo` / `azure` | **Not yet covered**, not impossible. Every forge mints its branch through the same function, so extending this is mechanical. |
| `replicas: 1` | A one-member replica set is a field that does nothing — and a field that does nothing is one you set and then trust. |
| `replicas: 4` or more | Above `PI_CONCURRENCY`'s default they queue instead of racing. |
| alongside `"resume": true` | A resumed run continues **one** lineage; replicas exist to fork it. Without this refusal every replica of an issue would resolve the same session key, share one transcript, and contend for the store's one-writer lock. |

## The pull-request hazard

`replicas` is allowed on `pull_request` triggers, and there the guarantee is weaker — honestly so.

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
