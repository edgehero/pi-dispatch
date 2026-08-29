# GitLab triggers

pi-dispatch services GitLab projects the same way it services GitHub repositories: an issue label, an
`@pi` comment, or merge-request activity starts a job that clones the project at its default-branch SHA,
runs your flow in a container, and comments back.

Triggers live in the same `triggers.json`, with the same `{any, all, none}` label predicates and the same
`flow` / `packages` / `image` options. The only new field is `run.kind`:

```jsonc
{ "triggers": [
  { "on": { "type": "label", "any": ["pi:fix"] },
    "run": { "kind": "gitlab", "flow": "fix" } },

  { "on": { "type": "comment", "phrase": "@pi" },
    "run": { "kind": "gitlab", "flow": "triage" } },

  { "on": { "type": "pull_request", "action": ["open", "update"] },
    "run": { "kind": "gitlab", "flow": "review" } }
] }
```

You can serve both forges from one deployment. Rules are grouped per forge, so a GitHub delivery never
matches a rule you wrote for GitLab even when both select the same label — and you may have one `@pi`
comment trigger on each.

## Set it up

**1. Mint a project access token.** Project Settings → Access tokens. Scope it `api` (see
[the scope trade-off](#the-scope-trade-off) below), give it the **Developer** role or above, and set the
shortest expiry you will tolerate re-minting.

```bash
GITLAB_TOKEN=glpat-xxxxxxxxxxxx
GITLAB_URL=https://gitlab.com          # your instance, if self-hosted
```

**2. Add the webhook.** Project Settings → Webhooks, URL `https://<your-host>/gitlab` — note the path;
`/` is the GitHub endpoint. Subscribe to **Issues events**, **Comments**, and **Merge request events**.

**3. Choose a verification mode.** This is required and has no default, because the two are not equally
strong:

| Mode | What it proves | Needs |
|---|---|---|
| `signature` | The body arrived exactly as GitLab sent it (HMAC-SHA256, replay-windowed) | GitLab **19.0+** |
| `token` | The sender knew a secret. **Nothing about the body.** | any version |

```bash
GITLAB_WEBHOOK_MODE=signature
GITLAB_WEBHOOK_SECRET=whsec_...        # the "Signing token" GitLab shows you
```

or

```bash
GITLAB_WEBHOOK_MODE=token
GITLAB_WEBHOOK_SECRET=<the "Secret token" you set on the webhook>
```

The receiver verifies **exactly** the mode you declared. A delivery carrying the other mode's header is
refused even if it is correct — otherwise a sender could pick which gate it faced, and it would always
pick the weaker one.

**4. A GitLab-only deployment needs nothing from GitHub.** Every forge arm is conditional: the receiver
mounts a forge's route, resolves its identity for the bot-loop guard, and requires its credentials only
when your triggers name that forge. So no `WEBHOOK_SECRET` and no `gh` login are needed here, and `/`
(the GitHub endpoint) answers 404 rather than 401, because an endpoint that answers is one you could
believe is armed. Add a `github` trigger later and both become required again, as they should.

**5. Check it.** `pi-dispatch doctor` reports whether the token, the verification mode and the webhook
secret are set when your triggers name GitLab, plus `WEBHOOK_SECRET` for any forge at all.

**6. Start it.** `pi-dispatch-receiver` from your deployment folder; `serve` is the default command, so
there is nothing to type after the name. A container profile is the alternative
(`docker compose -f deploy/docker-compose.yml --profile receiver up -d`), and the README lays out the
choice. The third way the README offers, `pi-dispatch-receiver poll`, cannot serve this forge: the poller
reads api.github.com and has no GitLab path at all.

## Self-hosted instances

Set `GITLAB_URL` to your instance root and everything follows it: the receiver's member lookup, the
worker's API calls and clone URL, and `GITLAB_HOST` inside the job container so `glab` talks to your
instance rather than gitlab.com. Nothing is hardcoded to gitlab.com; that value is only the default.
(Webhook verification is the exception that needs nothing here, because it reads the delivery's own headers
and the configured mode and secret, never an instance URL.)

```bash
GITLAB_URL=https://gitlab.internal.example.com
```

Two things are worth knowing before you point it at a private instance.

**A private CA needs to be trusted, in two places.** The worker and receiver run on the host, so a CA that
your OS trusts is not automatically one Node trusts:

```bash
NODE_EXTRA_CA_CERTS=/etc/ssl/certs/your-internal-ca.pem
```

Without it, every call fails, and the log names the reason rather than the bare `fetch failed` Node rejects
with. The receiver's boot-time identity check reports `gitlab identity: GET /user failed (...)`, and inside
those parentheses is the fetch's whole cause chain, joined with colons, so the certificate error itself is
what you read. That message is the diagnosis; if you see it, this is what it means.

The **job container** is a separate trust store: `git clone` and `glab` run inside it, so the CA has to be
in the image. Add it to your own image (`docs/job-image.md`) — a `COPY` of the cert into
`/usr/local/share/ca-certificates/` plus `update-ca-certificates`. The stock image trusts only the public
roots.

**Redirects are refused, not followed.** If `GITLAB_URL` is `http://…` and your instance redirects to
HTTPS, calls fail rather than silently following — a redirect is somewhere to send a credential, and
following one is how a token ends up at a host you did not name. Set `GITLAB_URL` to the final URL.

Plain `http://` does work if that is genuinely what you run. It sends the token in the clear on every API
call and every clone, so it is only reasonable on a trusted network, and it is not what the isolation
model assumes elsewhere.

## Minimum GitLab version: 17.4

pi-dispatch dedups redeliveries on GitLab's own `webhook-id` (called `Idempotency-Key` before 19.0), which
GitLab keeps constant across its retries. Older instances send neither, and a delivery without one is
**refused with 400** rather than run.

That refusal is deliberate. The alternative — synthesising a key from the payload — produces something
that is *not* stable across a retry, so it would dedup some redeliveries and bill you for the rest. A
clear error beats a guarantee that silently only half holds.

## Who can trigger a job

**A project member with Developer access or above — resolved from the API, for every trigger type.**

This is stricter than the GitHub arm, and it has to be. On GitHub, applying a label requires write access,
so the label *is* the approval step. On GitLab that reasoning fails three ways:

- the minimum role for managing labels has differed across GitLab versions;
- Ultimate's **custom roles** let you grant it at any level;
- **a Guest can set labels on an issue they are creating** — so a stranger can open an issue with your
  trigger label already on it.

So a GitLab label is a routing hint, never an approval, and the actor's `access_level` is checked on every
delivery. Group-inherited membership counts (the lookup uses `members/all`), so a maintainer who holds
their role at the group level is not refused.

If that lookup cannot complete — a 5xx, a dead socket, a revoked token — the receiver answers **503** and
GitLab redelivers. It does not silently drop the event: "we could not tell" and "you are not allowed" are
different answers, and only one of them should look like a refusal.

## Labels: the diff is the trigger

GitLab has no `labeled` event. Adding a label arrives as `action: "update"` carrying a before/after diff,
so pi-dispatch fires on **the labels an event added**, not on the labels an issue currently has.

This matters more than it sounds. If it matched the current set, then every later edit of a labelled issue
— retitling it, reassigning it, changing its milestone — would start another paid run, forever.

Practical consequences:

- Adding your trigger label fires exactly once.
- Editing the issue afterwards fires nothing.
- **Removing** the label fires nothing.
- An issue **opened** with the label already on it fires once (there is no previous set to diff against),
  which is safe only because the access gate above already ran.

## Merge-request actions are GitLab's own words

| GitHub | GitLab |
|---|---|
| `opened` | `open` |
| `reopened` | `reopen` |
| `synchronize` | `update` (carrying `oldrev`) |
| `labeled` | — *(a label add is `update` with a `changes.labels` diff)* |
| `review_submitted` | `approved` *(near, not equal — see below)* |
| `closed` | `close` |

`approved` and `review_submitted` are the closest the two vocabularies come, and treating them as the same
word would mislead in both directions. `approved` is **one verdict**: GitLab emits it when an approval
lands, and nothing at all for a comment-only review. `review_submitted` is **every verdict** — an approve,
a request-changes and a plain commented review alike — which is why the GitHub side has an
`on.reviewState` narrowing and GitLab has no need of one. The gates differ too: a GitLab trigger is
access-gated by an API lookup on the actor whatever the action, while `review_submitted` is gated on the
reviewer's `author_association` specifically (see `SECURITY.md`).

Writing a GitHub word on a GitLab trigger is **refused when the file loads**. It would not crash anything
otherwise — it would simply never match an event, and the trigger would sit there looking configured and
doing nothing.

`close` is close-only: it never shares a rule with other actions, because a close is gated on the actor
who closed the MR rather than on the author, and it takes `on.number` (the **iid**, the number in the MR's
own URL, not the global id) and `on.once` — see the README's close-triggers section. `merge` is still not
offered, and a merged MR does not fire the close rule either: GitLab reports a merge as its own
`merge` action, which drops unhandled, so a close rule fires on an explicit close only.

An MR rule with a label predicate fires on the labels that event added. An MR rule without one fires on
its named actions, which is safe here because every GitLab trigger is access-gated regardless.

## The scope trade-off

A GitLab project access token needs the **`api`** scope to post a note, and `api` grants full read/write
to that project's API. GitLab offers no narrower split — no equivalent of GitHub's `contents` vs
`pull-requests`, and no short-expiry per-job token like a GitHub App's.

So on the credential axis, GitLab is weaker than GitHub's App path, and equal to its `gh` / PAT paths.
`CONST-TOKEN-SCOPED-PER-JOB` states this rather than papering over it. What you can do:

- **Use a project token, not a group token.** A group token reaches every project in the group.
- **Rotate it.** The expiry bound the constitution names as the blast-radius limit is yours to enforce
  here, because no GitLab mechanism enforces it for you.
- **Protect your default branch.** The worker refuses a job whose default branch is unprotected, before
  spending anything — wildcard protection rules (`release/*`, `*`) count.

The token reaches the container as `GITLAB_TOKEN` / `GL_TOKEN` only, never under the GitHub names: `gh`
would send a GitLab credential to github.com on its first invocation.

## What runs in the container

A GitLab job gets `glab`, not `gh`, and its prompt envelope is written in `glab mr` terms. Both CLIs ship
in the job image; `image/verify-image.sh` checks for both, because a missing one fails silently — the
agent follows an envelope naming a command that is not there, explains itself in prose, and exits 0.

Everything else is identical to a GitHub job: the same isolation flags, the same `/job:ro` inputs, the
same budget and pause windows, the same run history, and the same rule that **the harness never merges**.

**`run.replicas` works here** (issue #187). `"replicas": 2` on a `label`, `comment` or `pull_request` rule
races two independent sandboxes on one delivery, each on its own `pi/issue-<iid>-r<i>` branch, each opening
its own merge request titled `[r1/2] …`. Two caveats specific to this arm. It is **webhook only**: there is
no GitLab poller, so nothing fans out on a poll. And GitLab's `update` action is a firehose: a merge request
edit, a label change, a description tweak and a push all arrive as `update`, and unlike GitHub's `labeled`
there is no positive-selector requirement to narrow it, so `replicas: 2` on `action: ["update"]` multiplies
every edit rather than every push. See [`docs/replicas.md`](replicas.md) for the budget arithmetic.

## What is not supported

- **Group-level webhooks.** Untested, and nothing refuses one: verification reads only the delivery's
  headers, and the gate routes on the project id the payload carries. So do not expect an error if you
  configure one; expect behaviour nobody has checked. Configure the webhook per project.
- **Chaining from a GitLab job.** A forge job gets no `/outbox`, exactly as a GitHub job does not — its
  task text is adversarial input (`OQ-009`).
- **Multiple GitLab instances in one deployment.** One `GITLAB_URL`.
- **Per-job token minting.** GitLab can mint project tokens by API, but only from a personal access token
  and only with a date-granular expiry. Not shipped; see `CONST-TOKEN-SCOPED-PER-JOB`.

`OQ-013` in [`specs/open-questions.md`](../specs/open-questions.md) is the honest statement of where this
arm is weaker than the GitHub one, and what would close the gap.
