<!--
Launch copy for pi-dispatch. Drafts to copy-paste and post. Every claim here traces to the README /
SECURITY.md / the code — keep it that way when you edit. Be honest about maturity (v0.x, solo-maintained,
self-host, read SECURITY.md); overclaiming burns a launch faster than underclaiming.

Repo: https://github.com/edgehero/pi-dispatch
npm: scoped packages only — @edgehero/pi-dispatch (worker+CLI), @edgehero/pi-dispatch-receiver,
@edgehero/pi-dispatch-admin (the console). The BARE name `pi-dispatch` is an unrelated squatted package:
never write bare `npx pi-dispatch` in launch copy; always the scoped form, and link the GitHub repo.
-->

# pi-dispatch — launch kit

## The one-liner

> Run the [pi](https://github.com/earendil-works/pi) coding agent as a service: on demand, on a cron, or on a
> label, comment or PR in GitHub, GitLab, Forgejo or Azure DevOps, in a container you control, with a durable
> queue and a spend cap.

## The elevator pitch (3 sentences)

pi is a minimal coding agent with no queue, no concurrency control, no spend limit, and — by its own README —
no permission system. pi-dispatch is exactly that missing operational layer: every job runs in an ephemeral
`--cap-drop=ALL` non-root container (pi's missing permissions, enforced by Docker), spend is bounded *before*
a container starts (per-job turn budget + a daily cap), and the same job runs whether you trigger it from the
CLI, a cron schedule, or a label, `@pi` comment or PR event on GitHub, GitLab, Forgejo or Azure DevOps. You
bake your own toolchain into the image (it ships Playwright + Chromium, so a flow can build a frontend,
screenshot it, and iterate on the render), and a live `/dispatch` admin panel shows the queue, spend meters,
run history, and triggers.

**The install line** (use this everywhere; the scoped form only, per the naming rule above):

```
pi install npm:@edgehero/pi-dispatch-admin      # then, in pi:  /dispatch
```

With nothing configured, `/dispatch` walks the whole setup with a consent per step. For servers and
headless hosts, `npx @edgehero/pi-dispatch up` in a fresh folder does the host half of it (pull and tag the
job image, start Valkey, scaffold config, run doctor); the worker service, the trigger edge and your first
trigger stay separate commands.

---

## Show HN

**Title** (≤ 80 chars):
`Show HN: pi-dispatch – run the pi coding agent as a self-hosted service`

**Body:**
```
pi (github.com/earendil-works/pi) is a minimal coding-agent CLI. It has no job queue, no
concurrency control, no spend limit, and — by its own README — no permission system. I kept
wanting to run it *unattended* — on a cron, on GitHub issues, on my own hardware — and every
one of those gaps is a reason you can't.

pi-dispatch is the operational layer that closes them, and nothing else:

- The container is the boundary. Every job runs in an ephemeral --cap-drop=ALL, non-root,
  no-new-privileges container; the agent's instructions are mounted read-only. That's pi's
  missing permission system, enforced by Docker.
- Spend is bounded BEFORE a container starts — a per-job turn budget and a daily cap (plus
  week/month ceilings and a soft-hold band) checked before a single token is spent.
- One job, many ways in: a CLI command, a cron schedule, or a label, @pi comment or PR event on
  GitHub, GitLab, Forgejo or Azure DevOps. Same queue, same box, same budget. Cron is the
  unattended one. A confirm-free tool in the operator's own pi session and a finished job's
  outbox can each enqueue one more, both behind their own gates.
- Your image, your tools. Bake a project's toolchain into the Dockerfile; it ships Playwright +
  Chromium so a flow can build a frontend, screenshot it, and iterate on the rendered result.
- A live admin panel (a pi extension): queue state, day/week/month spend meters, run history
  with per-job token+cost accounting, and editable triggers — plus per-repo "quiet hours" that
  defer runs between certain times and resume automatically.

Setup is the panel's job too. `pi install npm:@edgehero/pi-dispatch-admin`, then `/dispatch`:
with nothing configured it walks the whole deployment with a consent per step, and lands you in
the panel. Servers and headless hosts do the host half as plain commands
(`npx @edgehero/pi-dispatch up`: image, Valkey, config, doctor), with the worker service, the
trigger edge and the first trigger as their own commands.

I've tried to be honest about the threat model rather than hand-wave it: the whole thing runs
untrusted, adversarial input through an unrestricted agent on purpose, so SECURITY.md states
plainly what is and isn't defended (short version: the trust model is the same as a GitHub
Action — whoever can merge to your default branch can instruct the agent).

It's MIT, solo-maintained, v0.x, self-hosted (needs Docker + Node 22.19 + a provider key).
Feedback very welcome, especially on the security model.

https://github.com/edgehero/pi-dispatch
```

*Posting tips: post Tue–Thu ~8–10am ET; reply to every comment for the first few hours; don't seed upvotes
(HN detects it). Lead the top comment with the honest threat-model paragraph — it's your credibility.*

---

## pi community (Discord / GitHub Discussions) + showcase submission

<!--
POSTING LOGISTICS, UNVERIFIED. The channels named in this section (a pi Discord, GitHub Discussions on
earendil-works/pi, a package/showcase directory at pi.dev) trace to nothing in this repository, unlike every
product claim below them. Confirm each channel exists, and that it welcomes a post like this, before using
any of it. The message body itself is traceable copy and can be reused as is.
-->

If those channels exist, they are the warmest, highest-intent audience: start there, before the cold channels.

**Discord / Discussions post:**
```
Built a thing on top of pi some of you might want: pi-dispatch — a harness to run pi as a
*service* (on-demand / cron / a label, comment or PR on GitHub, GitLab, Forgejo or Azure
DevOps) with the operational bits pi deliberately leaves out: a durable Valkey+BullMQ queue,
a container-per-job boundary (--cap-drop=ALL, non-root), and a spend cap checked before any
container starts.

The admin side is itself a pi extension: a /dispatch command + overlay (queue, spend meters,
run history, editable triggers) and confirm-gated tools so an agent can operate the deployment
with a human approving each *config* change. Two tools skip that dialog on purpose: pause and
resume (reversible, spend nothing), and the paid dispatch_run (bounded by six limits instead,
spelled out in SECURITY.md). Newest bit: per-repo scheduled pause windows ("quiet hours")
that defer runs between certain times via BullMQ moveToDelayed and auto-resume.

Repo: https://github.com/edgehero/pi-dispatch — feedback and pokes at the security model welcome.
```

**pi.dev showcase / packages submission:** the operator extension already ships as a scoped `pi-package`
(see [Packaging the extension](#packaging-the-extension) for what makes it one), so a submission is a
pointer at the published package rather than work. If pi maintains a showcase list (OpenClaw, etc.), open
an issue/PR on earendil-works/pi proposing pi-dispatch as an integration entry.

---

## Packaging the extension

Nothing here is a build step you have to run: `@edgehero/pi-dispatch-admin` is already packaged and
published this way, and this section exists so a submission, or a second package, does not have to
reverse-engineer it from `admin/package.json`.

**What makes it a pi package** is the `pi` block in `admin/package.json`. pi reads it on install and
registers what it names:

```json
"pi": {
  "extensions": ["./dist/index.mjs"],
  "skills": ["./skills"],
  "image": "https://raw.githubusercontent.com/edgehero/pi-dispatch/main/docs/images/banner.png?v=0.5.0"
}
```

- `extensions` points at the **bundle**, not at source. `admin/build.mjs` inlines the worker subpaths with
  esbuild into a single self-contained `dist/index.mjs`; pi itself is a `peerDependency`, so the operator's
  own pi satisfies it rather than the package shipping a second copy. `prepublishOnly` runs that build, so
  `dist/` exists in the tarball even though it is gitignored and never committed.
- `skills` points at a directory that ships beside the bundle. `files: ["dist", "skills"]` is what puts
  both in the tarball, and the build preserves `import.meta.url` so `../skills` still resolves from inside
  `dist/`.
- `image` is the gallery card's artwork. `pi.video` would be new here (nothing in this repo sets it); see
  [demo.md](demo.md) for what to point either at.
- The `pi-package` keyword is what a package directory would index on.

**The name is not negotiable.** Scoped only, `@edgehero/pi-dispatch-admin`, per the naming rule at the top
of this file: the bare `pi-dispatch` on npm is an unrelated squatted package. Everything a reader can
copy, the install line included, has to carry the scope.

**What `pi install npm:@edgehero/pi-dispatch-admin` needs** is therefore just the published package: pi
resolves it from npm, reads the `pi` block, and registers the extension and skills from it. There is no
registration step anywhere else, which is why the install line and `/dispatch` are the whole quickstart.

**Publishing is automatic and idempotent.** `release.yml` publishes each workspace whose version changed
on `main` (`npm publish --workspace admin --access public`, gated on `npm view` returning a 404), and tags
its GitHub release `admin-v<version>`. There is no `publishConfig` in the manifest: `--access public` lives
in the workflow, because a scoped package is private by default and a first publish would otherwise fail
on a paid-plan error rather than say what it wanted. To ship a change, bump `version` in
`admin/package.json` inside the PR; merging is what publishes.

---

## X / Twitter thread

*(tag the pi / earendil accounts; attach the /dispatch panel image)*

```
1/ pi is a great minimal coding agent. But it has no queue, no spend limit, and no permission
system — so you can't really run it *unattended*.

pi-dispatch is the missing operational layer. Run pi as a service: on-demand, on a cron, or on a
label, comment or PR in GitHub, GitLab, Forgejo or Azure DevOps. 🧵

2/ The container is the boundary.
Every job → an ephemeral --cap-drop=ALL, non-root container, instructions mounted read-only.
That's pi's missing permission system, enforced by Docker.

3/ Spend is bounded BEFORE a container starts.
A per-job turn budget + a daily cap (plus week/month + a soft-hold band), checked before a single
token is spent. A runaway costs you a refusal, not a bill.

4/ Your image, your tools.
Bake the toolchain into the Dockerfile — it ships Playwright + Chromium, so a flow can build a
frontend, screenshot it, and iterate on the render.

5/ A live admin panel (itself a pi extension): queue, day/week/month spend meters, run history w/
per-job token+cost, editable triggers, and per-repo "quiet hours" that pause runs between certain
times and auto-resume. [image]

6/ MIT, self-hosted, v0.x. Honest about the threat model (SECURITY.md). Built on @earendil pi.
https://github.com/edgehero/pi-dispatch
```

---

## Reddit (r/selfhosted, r/LocalLLaMA)

**Title:** `pi-dispatch: run a coding agent unattended on your own hardware, with a spend cap and container isolation`

**Body:**
```
I wanted to run a coding agent (pi) on a cron and on GitHub issues without (a) it running loose
with my shell's permissions or (b) waking up to a surprise API bill. pi-dispatch is the harness
that makes that safe-ish and boring:

- One ephemeral container per job (--cap-drop=ALL, non-root); the agent can't reach the host
  outside its declared mounts (/job read-only and /workspace always, plus /outbox on local
  jobs, /session when you arm resumable sessions, and a read-only global pi overlay if you
  configure one).
- Spend capped before a container even starts (per-job + daily/weekly/monthly).
- Durable queue (Valkey + BullMQ) so a burst or a reboot doesn't drop jobs.
- Bring your own Docker image (Playwright/Chromium included for frontend work).
- A TUI admin panel for queue/spend/runs/triggers, plus per-repo scheduled pause windows.

Self-hosted, MIT, needs Docker + Node 22.19 + a provider key. Threat model is written down
honestly in SECURITY.md (it's the GitHub-Actions trust model: whoever can merge can instruct it).

https://github.com/edgehero/pi-dispatch
```
*r/selfhosted dislikes anything that smells like an ad — keep it first-person, lead with the self-host angle,
and engage in comments.*

---

## Blog post outline (dev.to / personal blog)

Working title: **"Giving a coding agent an off-switch: containers, spend caps, and quiet hours"**

1. **The gap.** pi (and most agent CLIs) assume a human is watching. No queue, no spend limit, no permission
   system. What breaks when you try to run one unattended.
2. **The container is the boundary.** Why `--cap-drop=ALL` + non-root + ephemeral is the honest answer to "no
   permission system," and why per-*job* (not per-session) isolation matters against mutually-untrusting issue
   authors. (Screenshot: the security section.)
3. **Spend before tokens.** The one ordering that makes a cap real: check-and-increment *before* the container,
   not after the bill. Day/week/month windows + a soft-hold band.
4. **Quiet hours without dropping work.** The scoped pause-window design: defer a repo's runs with BullMQ's
   `moveToDelayed` *before* the budget reservation, so a paused job costs nothing and auto-resumes — vs.
   dropping it (which loses a GitHub job that has no re-trigger). Timezone-correct via built-in `Intl`.
5. **An agent that can operate itself, safely.** Confirm-gated tools: the model proposes a *config* change
   (raise a cap, add a trigger), a human approves a dialog it can't answer, and it's fail-closed without a
   human. Why "operator-approved" beats "no tool at all" here, and then the honest half: where that gate
   deliberately stops. Pause and resume carry no confirm (reversible, spend nothing), and the paid
   `dispatch_run` carries none either, bounded by six independent limits instead of a dialog.
6. **What I got wrong / what's not defended.** Link SECURITY.md's honest list. Invite scrutiny.

---

## GitHub Release notes (TEMPLATE — for `gh release create vX.Y.Z`)

<!--
TEMPLATE, NOT the current release. This block is v0.2.0-era copy and its feature list predates the GitLab,
Forgejo and Azure DevOps arms, the resurrectable sandbox, run.replicas, resumable sessions, the cost analytics,
the setup wizard, polling mode and `setup github`. Re-cut it per release against that release's own changes,
keeping the shape (Admin / AI-operable / feature area / Docs & safety / the maturity footer) and nothing
else. Versions at the time of writing: root 0.8.0, @edgehero/pi-dispatch 0.1.2,
@edgehero/pi-dispatch-admin 0.5.0, @edgehero/pi-dispatch-receiver 0.1.1.
-->

**Title:** `v0.2.0 — admin panel, AI-operable controls, scoped pause windows`

```
The operational layer, filled in.

Admin
- A theme-colored /dispatch TUI panel (a pi extension): live queue, day/week/month spend meters +
  a daily token counter, run history with per-job token & cost, and a unified triggers pane.
- Trigger CRUD (cron / label / comment / pull_request) from the overlay, applied live (no restart).

AI-operable, safely
- Confirm-gated model tools: an agent can change limits and manage triggers/pause windows, and every
  *config* write pops an operator confirmation dialog it can't answer — fail-closed without a human.
  Pause and resume are reversible and spend nothing, so they carry no confirm.
- Bundled `operate-pi-dispatch` skill documenting the human-in-the-loop gates.

Scheduled pause windows (quiet hours)
- Pause a folder's or repo's runs between certain times (recurring daily, with weekday + date-range
  bounds and a per-window IANA timezone) and resume automatically. Deferred via BullMQ, never dropped,
  at zero budget cost.

Docs & safety
- Expanded SECURITY.md threat model; specs/ (constitution/requirements/design/interfaces) kept in lockstep.

Self-hosted, MIT. Needs Docker + Node ≥ 22.19 + a provider API key. See the README quickstart.
```
