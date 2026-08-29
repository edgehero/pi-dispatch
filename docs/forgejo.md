# Forgejo (and Gitea) triggers

A Forgejo issue labelled by someone holding `write` or `admin` on the repository starts the same job a
GitHub one does: same queue, same container, same budget, same pause windows, same run history. A `read`
collaborator is refused.

```jsonc
{ "on": { "type": "label", "any": ["pi:fix"] },
  "run": { "kind": "forgejo", "flow": "fix" } }
```

The distinguishing fact, and the reason this arm is small: **Forgejo's webhook transport is byte-compatible
with GitHub's.** It signs the raw body with HMAC-SHA256 and sends `X-Hub-Signature-256`,
`X-GitHub-Delivery` and `X-GitHub-Event`. `receiver/src/verify.mjs` — the trust boundary every downstream
gate depends on — needed **zero changes**, and a forged signature still returns 401 through it. Delivery
dedup transfers unchanged for the same reason.

## Set it up

**1. Mint a token.** Use a **repository-scoped** token ("Specific repositories") carrying only
`write:repository` and `write:issue`. That is genuinely narrower than GitLab's equivalent — there is no
all-or-nothing `api` scope to fall back to.

**2. Tell the harness who it is.** A repository-scoped token **cannot call `GET /user`**, because
`read:user` is not among the four permissions such a token may carry. So set the harness account's numeric
id explicitly:

```bash
FORGEJO_URL=https://forgejo.example.com
FORGEJO_TOKEN=...
FORGEJO_BOT_ID=42          # the harness account's numeric id, from its profile page
FORGEJO_WEBHOOK_SECRET=... # a long random string
```

If you use an account-scoped token that *can* read `/user`, leave `FORGEJO_BOT_ID` unset and it is looked
up. What must not happen is neither: the receiver **refuses to boot** without an identity, because the
bot-loop guard compares the sender against it, and an unresolved identity never matches — so it would fail
open silently, and the harness's own status comments would start more jobs.

**3. Point the webhook at `/forgejo`.** Type "Gitea", content type `application/json`, secret as above,
events: Issues, Issue Comment, Pull Request.

The path matters. Forgejo sends `X-Forgejo-*`, `X-Gitea-*` **and** `X-GitHub-*` on every delivery, so a
header cannot tell it apart from GitHub — and a sender that could choose which gate it faced would choose
the weakest one available. You pick the path when you configure the hook; the sender never picks.

**4. A Forgejo-only deployment needs nothing from GitHub.** Every forge arm is conditional: the receiver
mounts a forge's route, resolves its identity for the bot-loop guard, and requires its credentials only
when your triggers name that forge. So no `WEBHOOK_SECRET` and no `gh` login are needed here, and `/`
(the GitHub endpoint) answers 404 rather than 401, because an endpoint that answers is one you could
believe is armed. Add a `github` trigger later and both become required again, as they should.

**5. Start it.** `pi-dispatch-receiver` from your deployment folder; `serve` is the default command, so
there is nothing to type after the name. A container profile is the alternative
(`docker compose -f deploy/docker-compose.yml --profile receiver up -d`), and the README lays out the
choice. The third way the README offers, `pi-dispatch-receiver poll`, cannot serve this forge: the poller
reads api.github.com and has no Forgejo path at all.

## Actions are Forgejo's own words

This is the one that would otherwise cost you an afternoon. Forgejo reports a label change as
`X-GitHub-Event: issues` with `"action": "label_updated"` — GitHub's event name, its own action word.

| GitHub says | Forgejo says |
|---|---|
| `labeled` | `label_updated` |
| `synchronize` | `synchronized` |
| `opened`, `reopened`, `closed` | the same |

Write Forgejo's words in your triggers file; the loader refuses the other forge's, so a wrong one is a
message at load rather than a trigger that never fires.

**`label_cleared` fires nothing, ever.** Removing a label must not start a paid run, and it has no GitHub
counterpart to inherit that rule from. It drops under its own reason, so you can see it was recognised and
refused rather than not understood.

It is not alone in that bucket. `edited`, `assigned`, `unassigned`, `milestoned`, `demilestoned`,
`reviewed`, `review_requested` and `review_request_removed` are recognised and deliberately not actionable
too, and all of them drop as `action-not-actionable`. A trigger that never fires on one of those was seen
and refused, not misunderstood. `closed` left that bucket with issue #231: a close-only rule (the `issue`
trigger type, or `closed` alone on `pull_request`) now catches it, gated on the resolved permission of the
actor who closed the item, with a merged PR counting as closed.

## Labels match the whole current set, not the diff

The label route fires on `opened`, `labeled` and `reopened`, and the set your predicate is tested against is
**the labels the issue carries at that moment**, not the labels the event added. This is the one place
Forgejo differs from the GitLab and Azure arms in a way that costs money: both of those match the diff
precisely so that later activity on an already-labelled item cannot fire again. Here it can.

- Adding your trigger label fires, as expected.
- Adding a **second, unrelated** label to an already-labelled issue fires **again**: the current set still
  matches your predicate.
- **Reopening** an already-labelled issue fires **again**, for the same reason.
- An issue **opened** with the label already on it fires once.
- Removing a label fires nothing (`label_cleared`, above).

Each of those is a separate paid run, and delivery dedup does not help: they are distinct deliveries, not
retries of one. What does bound it is the ignored bucket above, so a retitle or a reassignment of a labelled
issue fires nothing. If the re-fires matter to your budget, take the trigger label off once the job has
started.

## Who can trigger a job

The actor's repository permission is resolved from
`GET /repos/{owner}/{repo}/collaborators/{user}/permission`, and must be `admin` or `write` — for **every**
trigger type, labels included.

Labels on Forgejo very probably *are* self-gating, as they are on GitHub: applying one needs write access.
The gate deliberately does not rest on that. It has not been verified against a running instance across
versions, and the cost of being wrong is a stranger starting paid jobs — so if the label really is the
approval, this check is redundant rather than wrong, which is the cheaper direction to be wrong in.

A lookup that **could not be completed** — a 5xx, a dead socket, a revoked token — answers **503**, not
204. Forgejo redelivers, and the stable delivery GUID dedups the retry. Answering 204 there would drop real
work during an outage behind a response indistinguishable from a stranger being correctly refused.

**Know what that looks like, because 403 lands there too.** Only two answers from the permission endpoint
are determinate: a 200 carrying a permission string, and a 404 (no such collaborator here), which is the
refusal. Every other status, **403 included**, is indeterminate. So if the harness token cannot read another
user's permission on that endpoint, nothing fires and nothing is silently dropped either: the receiver logs
`forgejo_permission_lookup_failed` with the status in the reason, answers **503**, and Forgejo redelivers,
for as long as its retry policy allows. Repeated 503s against one delivery id are the signature. Look at the
token's permissions before you look at the trigger.

## The scope trade-off

`CONST-TOKEN-SCOPED-PER-JOB` wants a credential that is repo-scoped, minimally-permissioned **and**
short-lived. Forgejo gives you the first two and **cannot give you the third**: there is no App, no
installation token, no automatic expiry. You mint it by hand and it lives until you revoke it.

Unlike GitHub, there is no stronger path to prefer, so rotation is the whole mitigation. Rotate it, and
scope it to the repositories this deployment actually services.

## What runs in the container

`tea`, not `gh`. The envelope instructs the agent in `tea` prose, because `gh` implements the GitHub API
and a Forgejo job following the GitHub envelope fails at its first `gh pr create` on every run. Forgejo's
*nouns* being GitHub's — issue, pull request, `#n` — is exactly what would make that failure look like a
bad agent rather than a missing tool.

`tea` is pinned to an exact version and verified against a per-architecture sha256, like `glab` and unlike
`gh`. `image/verify-image.sh` checks it is present and that the image's `dev.pi-dispatch.forges` label
agrees.

**`run.replicas` works here** (issue #187). `"replicas": 2` on a `label`, `comment` or `pull_request` rule
races two independent sandboxes on one delivery, each on its own `pi/issue-<n>-r<i>` branch, each opening
its own pull request titled `[r1/2] …`. It is **webhook only**: there is no Forgejo poller.

One wrinkle is Forgejo's alone. `tea pr list` takes no branch filter, where `gh`, `glab` and `az repos` all
filter server-side, so the "is there already a pull request for my branch?" step is a client-side scan of a
listing that, under replicas, contains your siblings' pull requests on branches differing by one character.
The replica prompt says so and tells the agent to match the `-r<i>` suffix exactly, but it is worth knowing
that this step is a request rather than a filter here.

## What is not supported

- **Gogs.** Same header family, different and less-maintained project.
- **Forgejo Actions.** pi-dispatch is the trigger and the box; CI stays the repo's business.
- **A GitHub App equivalent**, because none exists — see the scope trade-off above.
- **Inferring the author gate from the payload.** Permission comes from the API, or the trigger does not
  fire.

The residual risk this arm shares with GitLab's — a gate that depends on a lookup that can fail — is
`OQ-013` in [`specs/open-questions.md`](../specs/open-questions.md).
