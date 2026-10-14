# Forgejo (and Gitea) triggers

A Forgejo issue labelled by someone holding `write`, `admin` or `owner` on the repository starts the same job a
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

**1. Give the harness two tokens from two accounts.** The jobs and the author gate need different things,
and one token cannot serve both safely.

- **The job token, `FORGEJO_TOKEN`.** Make the harness account a **Write** collaborator of each repository,
  and mint a **repository-scoped** token ("Specific repositories") carrying only `write:repository` and
  `write:issue`. That is genuinely narrower than GitLab's equivalent: there is no all-or-nothing `api` scope
  to fall back to. Every forgejo job carries this token, and nothing a job does needs it to be an admin's:
  the worker reads the default branch's protection from the branch itself
  (`GET /repos/{owner}/{repo}/branches/{branch}`, whose `protected` Forgejo computes with its own rule
  matching, wildcards included), not from the rule list, which only an admin may read.
- **The lookup token, `FORGEJO_PERMISSION_TOKEN`.** The author gate asks Forgejo for the permission of
  whoever triggered the job (`GET /repos/{owner}/{repo}/collaborators/{user}/permission`), and Forgejo
  answers that question about another user only to a site admin or an admin of the repository. A `write`
  collaborator gets 403 ("Only admins can query all permissions, repo admins can query all repo
  permissions, collaborators can query only their own"), and then every trigger fails closed and nothing
  ever runs. So use a **different** account that is an admin (or the owner) of each repository, and mint a
  token from it carrying **`read:repository` only**. Only the receiver reads this variable. It is never
  handed to a job: `PI_FORWARD_ENV` refuses it, a trigger's `run.secrets` cannot bind it, and the worker
  removes it from the job's environment besides.

Why `read:repository` is enough, and why it is safe, from Forgejo 14.0.5's source. The permission route is a
GET inside the repository routes that `tokenRequiresScopes(AccessTokenScopeCategoryRepository)` wraps, and
that check asks for the READ level on a GET and the WRITE level only on POST, PUT, PATCH and DELETE
(`routers/api/v1/api.go`). The admin requirement is checked against the token's **user**, not its scope:
`GetRepoPermissions` (`routers/api/v1/repo/collaborators.go`) admits a caller for whom `IsUserRepoAdmin()`
holds, and that is the permission `GetUserRepoPermission` computes for the account behind the token. So a
read scoped token of an admin answers the gate, and cannot write anything.

**What it costs to skip the second token.** Without `FORGEJO_PERMISSION_TOKEN` the lookup uses
`FORGEJO_TOKEN`, and that account then has to be an admin. The token's scopes do not narrow an admin: the
settings, webhook, collaborator and branch protection endpoints all sit in the same `repository` scope
category behind a repository admin check, so that `write:repository` token can edit the repository's
settings, add webhooks and collaborators, and change or delete branch protection (only deleting or
transferring the repository needs the owner). Forgejo has no per-job mint, so every forgejo job would carry
it, held by an agent that reads issue text anyone can write, and branch protection is what stands between
that agent and your default branch (`REQ-BRANCH-PROTECTION-PRECONDITION`). It works, and `pi-dispatch
doctor` warns for as long as it is set up that way (`OQ-043` in [`specs/open-questions.md`](../specs/open-questions.md)).

**2. Tell the harness who it is.** A repository-scoped token **cannot call `GET /user`**, because
`read:user` is not among the four permissions such a token may carry. So set the harness account's numeric
id explicitly:

```bash
FORGEJO_URL=https://forgejo.example.com
FORGEJO_TOKEN=...            # the harness account (a write collaborator): every job carries it
FORGEJO_PERMISSION_TOKEN=... # an admin account's read:repository token: the receiver's alone
FORGEJO_BOT_ID=42          # the harness account's numeric id, from its profile page
FORGEJO_WEBHOOK_SECRET=... # a long random string
```

With the egress policy on (the default), Forgejo must be served over `https://` on port 443. git in a job never
sends an `http://` remote through the proxy, and the proxy refuses a `CONNECT` to any other port (issue #508,
`docs/egress.md`). With Forgejo's default `http://forgejo.example:3000` a job's git push and fetch fail, and its
API calls too, since the port is not 80. Plain `http://` works only with `PI_EGRESS=0`. `pi-dispatch doctor` warns when `FORGEJO_URL` is anything
but `https://` on 443.

There is no source to choose here either. `FORGEJO_AUTH_SOURCE` accepts only `pat` and defaults to it,
for the same reason GitLab's does: Forgejo has no App or installation token, so the variable exists to
refuse a wrong assumption of symmetry with `GITHUB_AUTH_SOURCE` rather than to offer an alternative, and it
is read only once `FORGEJO_TOKEN` is set ([`docs/gitlab.md`](gitlab.md#set-it-up) states it once).

If you use an account-scoped token that *can* read `/user`, leave `FORGEJO_BOT_ID` unset and it is looked
up. What must not happen is neither: the receiver **refuses to boot** without an identity, because the
bot-loop guard compares the sender against it, and an unresolved identity never matches — so it would fail
open silently, and the harness's own status comments would start more jobs.

It refuses either way, but **how** it refuses depends on why. A token that cannot read `/user`, an
instance behind a CA the host does not trust, or a URL that redirects (an `http://` address for an https
instance) is something you have to fix: the receiver exits 2, and a supervisor leaves it stopped rather
than looping on a configuration that can never resolve. An instance that was merely unreachable —
restarting, answering 502, refusing the connection — exits 1 instead, and the supervisor retries.

**How long it retries is the receiver's own setting, the same under every supervisor.** A transient
failure at boot is retried inside the process for `RECEIVER_IDENTITY_RETRY_SECONDS` (default 600 seconds,
floored at 60; see `.env.example`), starting at 5 seconds between attempts and backing off to 30, and only
then does the receiver exit 1 for the supervisor to start another window. A Forgejo restart that takes
minutes is therefore ridden out inside one window, where the old unit-imposed bound (roughly 25 seconds of
`RestartSec=5` against `StartLimitBurst=5`) outlasted nothing but a blip and then left the unit in
systemd's `failed` state. Raise the variable if your instance takes longer than ten minutes to come back;
leave `StartLimitBurst` alone, because that limit now bounds only real crash loops (a process dying in
milliseconds), and widening it would just let a broken receiver spin longer.

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
(`docker compose --env-file .env -f deploy/docker-compose.yml --profile receiver up -d`, which needs
`deploy/docker-compose.yml`: a clone carries it, and `/dispatch setup` copies it in when you choose the receiver
container), and [`docs/github.md`](github.md#three-ways-to-run-the-trigger-edge) lays out the choice. The third way it offers, `pi-dispatch-receiver poll`, cannot serve this forge: the poller
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
`GET /repos/{owner}/{repo}/collaborators/{user}/permission`, and must be `owner`, `admin` or `write` — for
**every** trigger type, labels included. `owner` is what Forgejo answers for the owner of a personal
repository; up to 4.3.0 the receiver refused it, so the owner's own label or comment never started a job.

Labels on Forgejo very probably *are* self-gating, as they are on GitHub: applying one needs write access.
The gate deliberately does not rest on that. It has not been verified against a running instance across
versions, and the cost of being wrong is a stranger starting paid jobs — so if the label really is the
approval, this check is redundant rather than wrong, which is the cheaper direction to be wrong in.

A lookup that **could not be completed** — a 5xx, a dead socket, a revoked token — answers **503**, not
204. Forgejo redelivers, and the stable delivery GUID dedups the retry. Answering 204 there would drop real
work during an outage behind a response indistinguishable from a stranger being correctly refused.

**Know what that looks like, because 403 lands there too.** Only two answers from the permission endpoint
are determinate: a 200 carrying a permission string, and a 404 (no such user or repository), which is the
refusal. Every other status, **403 included**, is indeterminate. A 403 is almost always setup: the token that asked
belongs to an account that is not an admin of the repository (step 1), or lacks `read:repository`. Nothing
fires and nothing is silently dropped: the receiver logs `forgejo_permission_lookup_failed` with a reason that
names the variable to fix (`FORGEJO_PERMISSION_TOKEN` when it is set; otherwise it says to set it) and answers
**503**, so the delivery shows as failed in the webhook's delivery history rather than as delivered. That is
deliberate. A retry cannot fix a 403, but it costs nothing (nothing is minted or spent before this answer),
while answering 204 would record every trigger as delivered while none ran. The receiver also logs, at boot,
which variable the lookup uses (`forgejo_permission_token`). Fix the account, then trigger again whatever you still want run.

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

The job's token reaches `tea` as `GITEA_TOKEN` and the instance as `GITEA_INSTANCE_URL` (your `FORGEJO_URL`,
scheme included). That pair is the only one the pinned tea 0.15.0 logs in from without a stored login:
`GITEA_SERVER_TOKEN` is only the default of `tea login add --token`, and with it alone every `tea` command
fails with "no available login". The job also carries the token as `FORGEJO_TOKEN` and `GITEA_SERVER_TOKEN`,
and the URL as `FORGEJO_HOST`, for scripts and skills. The worker sets all five itself: a trigger's
`run.secrets` cannot bind any of them, and `PI_FORWARD_ENV` refuses the three token names.

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
