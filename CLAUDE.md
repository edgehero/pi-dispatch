# Working on pi-dispatch

Notes for an AI agent working in this repository. Short on purpose: `specs/` is the authority, and this file
exists to stop you from having to discover the load-bearing parts by breaking them.

## What this project is

pi-dispatch runs the [pi](https://github.com/earendil-works/pi) coding agent as a service. It **lives in the
background** and, on a cron schedule or a forge event (an issue, a comment, a pull request), opens a
container that runs a flow against a repository, does the work, and shuts the container down. A panel shows
the triggers, the history of every past run and the spend, and can turn the whole thing off.

pi has no queue, no concurrency control, no spend limit and, by its own README, no permission system.
**This project is exactly that missing operational layer and nothing else.** When a change would make
pi-dispatch smarter about *what the agent does*, it probably belongs in a skill or a flow, not here.

Two consequences worth internalising before you design anything:

- **The container is the boundary.** Isolation is built by the worker's own `docker run` argv, so nothing an
  image contains can weaken it.
- **Money is the other boundary.** Every gate that costs nothing runs before every gate that costs
  something, and a paid container starts only after all of them pass.

## The shape

| Path | What it is |
|---|---|
| `worker/` | the queue consumer, the CLI (`pi-dispatch`), the forge hosts, doctor, service installer |
| `receiver/` | the always-on trigger edge (`pi-dispatch-receiver`): webhook routes and the poller |
| `admin/` | the operator console, a pi extension (`/dispatch`), TypeScript, bundled to `dist/` |
| `image/` | the job image and the in-container runner that implements the exit-code protocol |
| `deploy/` | service units, wrappers and the compose file; `worker/deploy/` is the published mirror |
| `specs/` | constitution, requirements, design, interfaces, open questions. The source of truth |
| `docs/` | operator-facing reference, one file per feature or forge |
| `launch/` | launch copy and the demo recording recipe. Maintainer material, deliberately not in `docs/` |

## Read these before changing behaviour

1. `specs/constitution.md` — the non-negotiables. A change that violates one must justify **the
   constraint**, not the code, and amend that file in the same PR.
2. `specs/design.md` — decisions that could have gone another way, and what was rejected.
3. `specs/interfaces.md` — the file and container contracts, including the run-record shape.
4. The revision history at the end of each spec file. It records corrections, not just additions, and
   several entries exist because a previous claim was refuted.

## Rules that bite

- **Specs change in the same PR as the code**, with a revision-history row. When a spec entry is unaffected,
  say so explicitly ("UNCHANGED, checked") rather than silently leaving it. Cite spec IDs
  (`CONST-*`, `REQ-*`, `DES-*`, `INT-*`) in commit bodies; they are permanent addresses.
- **Verify against the pinned artifact, not against HEAD.** pi is pinned to an exact npm version. A sha is
  not a version, and this rule is in the constitution because ignoring it once nearly shipped a runner that
  imported an export the pinned release did not have. Docs are a hint; source at the pin is evidence.
- **`CONST-MERGE-NEVER-AUTOMATIC`.** Nothing in this project merges anything, ever. CI greps
  `worker/src`, `receiver/src`, `image/runner`, `.github/workflows/pi-bump.yml` and `.github/scripts` for
  `pulls.merge`, `gh pr merge`, any spelling of auto merge, a self-approval and friends, so even a comment
  mentioning one fails the build.
- **`CONST-BUDGET-BEFORE-TOKENS`.** Free, determinate refusals go before anything that spends: before the
  token mint, the clone, the token-cap read and the budget reservation.
- **`CONST-RETRY-INFRA-ONLY`.** A determinate policy refusal **returns** a result; only infrastructure
  failure **throws** so the queue retries. Getting this backwards means either paying to retry something
  that can never succeed, or dropping real work behind a silent success.
- **Exact pins only** (`CONST-PI-VERSION-PINNED`). No `^`, `~`, `latest` or a floating tag for pi, for
  staged pi packages, or for image bases. A floating range turns an upstream release into every queued job
  quietly losing a tool while the queue still reports success. pi depends on its own sibling packages by a
  range and ships no shrinkwrap since 1.0.1, so the root `package.json` pins every `@earendil-works` package in
  `overrides`; `.github/scripts/pi-pin-check.mjs` holds those, the lockfile and every hand-written copy of the
  pin to the runner's. A copy of a pi file's logic is pinned by that file's content hash, not by pi's version.
- **No secrets or PII in logs.** Log key *names*, never values, and never payload text. The run record is
  PII-free by construction: it holds no attacker-chosen string.
- **Fail loudly, or fail open and say which.** A silent no-op is the worst outcome available here. If a
  feature cannot do what it was asked, it refuses with a reason an operator can act on. Where it fails open,
  the reason is named in the record.

## Style

- **Tabs** in `worker/`, `receiver/`, `image/`. **Two spaces** in `admin/`. Double quotes, semicolons.
  There is no linter, so match the file you are in.
- Node 22.19 or newer.
- Tests are `node:test` with hand-rolled, dependency-injected fakes. No mocking framework, no network, no
  Docker in unit tests. Inject a seam rather than reaching for a global.
- Comments explain **why**, and especially why the obvious alternative is wrong. This codebase is dense with
  them on purpose; a comment that merely restates the code is noise, one that records a rejected approach is
  the most valuable line in the file.
- **Both READMEs avoid dashes as punctuation** (no em dash, no ` - `). Use commas, colons or parentheses.
  Keep the images: they carry more than the prose does.

## Tests and CI

- `npm test` at the root runs every workspace. Run the whole suite before committing, not just the file you
  touched: the workspaces share the triggers schema and the queue.
- CI runs the same suite with `PI_DISPATCH_REQUIRE_{LOADER,WORKER,RECEIVER}_TESTS=1` and a live Valkey, which
  is where the integration tests that skip locally actually execute.
- **Six checks are REQUIRED on `main`**. Five come from `pi-upgrade-check.yml` (issue #105): `pins are exact
  (CONST-PI-VERSION-PINNED)`, `no automatic merge (CONST-MERGE-NEVER-AUTOMATIC)`, `pinned assumptions still
  hold (offline, no API key)`, `the job image holds its contract`, `the admin extension survives latest pi
  (canary)`. The sixth is `the rootless podman venue holds its declarations` from `podman-conformance.yml`
  (issue #432; it ran advisory under #354 until it had passed on every PR of a round). `enforce_admins` is
  **on**, so a red build is unmergeable by the owner too.
  - Both workflows' **`pull_request` triggers are deliberately unfiltered**. A required check that never
    reports blocks a merge forever, and the old path filter meant a docs-only PR reported nothing at all.
    Do not add `paths:` to either. The `push:` filters are unaffected and stay.
  - A job's `name:` IS its required context string: renaming either workflow's job renames the check, and
    the branch protection must be updated in the same breath or every PR waits forever on the old name.
  - Two PR-reporting checks are deliberately **not** required. `host-pi mirrors survive latest pi (canary)`
    is green-on-drift by design, so its red means pi failed to install (upstream flake, not a defect); and
    `deploy/ artifacts are syntactically valid` (with the Quadlet generator job beside it) is still
    path-filtered to `deploy/**`, so requiring it would deadlock every PR that does not touch `deploy/`.
  - If Actions is down or a workflow file breaks, `main` is frozen. Escape hatch: `gh api -X DELETE
    repos/edgehero/pi-dispatch/branches/main/protection/enforce_admins`, merge, then `gh api -X POST` the
    same path to put it back.
- **A test that touches retention, a TTL or a window takes an injected clock, always.** A fixed instant
  in the test beside a subject built on the default `Date.now` is a fuse: it passes until the wall clock
  drifts past that subject's own window, then fails in CI on a tree nobody touched (issue #284 blocked
  every merge that way, from a file that had carried the fuse since the day it was written). Two guards
  run in `contract-tests`: `.github/scripts/dated-fixture-check.mjs` flags the pairing in a second, and
  the suite is re-run with `Date` shifted 399 days forward, which is the oracle. They catch different
  things on purpose and neither subsumes the other. Pass `now`; never move the fixture date forward.
- **A test directory comes from the workspace helper, always** (issue #351):
  `import { tempDir } from "./helpers/temp-dir.mjs"`, which removes every directory the file made in an
  `after()` hook, and again at process exit for any made after it ran (node:test runs root hooks early when a
  file declares tests before a top-level await). A bare `mkdtempSync(join(tmpdir(), ...))` in a test file is refused by
  `.github/scripts/temp-dir-check.mjs`, and the same job runs the suite under a `TMPDIR` of its own and
  fails if anything is left in it (two fixed-name tooling caches, `jiti` and `node-compile-cache`, are
  excluded by exact name; `mkdtemp` always appends random characters, so no test directory can match one). Same fast-hint-plus-oracle pairing as the clock guards above, and for
  the same reason: the grep sees a call shape, only the count sees a missing cleanup. A directory rooted
  somewhere the helper already made (`join(jobsDir, "job-")`) is fine and is not matched.
- `admin/dist/` is gitignored and built by `node admin/build.mjs`. Never commit it.
- Two mirrors must stay **byte-identical**, pinned by tests: `worker/.env.example` to the root
  `.env.example`, and `worker/deploy/*` to `deploy/*`. Edit both.
- The wizard's `RUNTIME_VERSION` and `RECEIVER_VERSION` are bolted to the workspace versions by anti-drift
  tests. A release bump moves all of them together.
- **A hand-written table that restates a derivable source is either derived or pinned, never trusted.**
  Every instance found so far had drifted, and every one was load-bearing. Current bolts: the
  model-callable tool list in `REQ-`/`DES-ADMIN-VIA-PI-EXTENSION` against the registrations, and
  `INT-TRIGGERS-FILE-CONTRACT`'s forge vocabularies against `PR_ACTIONS` (the two tests that read a spec
  file); the admin's forge, action and settings vocabularies against `worker/src/triggers.mjs` and
  `runtime-settings.mjs`; `EXIT_POLICY`'s copies in the runner and the `deploy/` units; the receiver
  filters' action sets as the loader's set minus their own named exclusions; the git hardening flags,
  which live in `worker/src/git-hardening.mjs` because seven files carried them by hand and one had
  quietly lost a flag; the pi tables that can be derived (`.github/scripts/pi-derived.mjs`, each checked-in
  copy held to its generation by `worker/test/pi-derived.test.mjs`); `docs/egress.md`'s canary rows, whose first column is rebuilt from
  `CANARY_LINES` by a test and required to match between markers (the count-the-source test it replaced
  could not see four spellings and could go false red on a comment); and every spec revision row, which
  must split into exactly two cells on unescaped pipes, because such a row is CUT on the rendered page
  while looking whole in the diff, and four had silently lost between 1,100 and 2,800 characters each.
  Add a table, add its bolt. Where the relation is NOT real, say so in the test
  rather than manufacturing one: `PR_ACTION_VOCAB.dflt` is deliberately unpinned, with a line explaining
  that gitlab's default is not its set's first member.

## pi bumps

`.github/workflows/pi-bump.yml` turns every new pi release into one DRAFT pull request (issue #587). It makes the
mechanical part of the upgrade commit that `CONST-PI-VERSION-PINNED` asks for; a person reviews it, makes it ready
and merges it.

- **What it does.** Daily, and on demand (Actions, "pi bump", Run workflow; the version input defaults to npm's
  latest). One job, which runs no pi code: `.github/scripts/pi-bump.mjs <version>` moves every pin from one table and
  re-resolves pi's tree in the lockfile with `npm install --package-lock-only --ignore-scripts` (registry metadata
  only, nothing extracted or run). It refuses a lockfile entry not from the npm registry with an integrity hash, a
  package whose registry metadata gains an install script, a `package.json` that changed beyond its pin, and any
  file other than the pin files and the lockfile. The install-script check cannot see a tarball's `binding.gyp`
  (npm builds one with node-gyp at install whatever the metadata says), so the review and the pull request's CI are
  the real check on what a new package runs. Then it commits exactly those files as Rob Boerman with `-s`, force-pushes
  `chore/pi-bump` (leased to the tip it judged), and opens or updates the one pull request titled
  `chore(pi): run on pi X`. It skips a target that is the pin, older than it, not an exact release, already carried
  by the open pull request (unless the base changed a pin file or the lockfile under it: then it rebuilds), or closed
  unmerged.
- **The pull request is ALWAYS a draft.** The workflow cannot know whether the bump holds; the pull request's own
  required checks say so (the suite, the pinned-assumption tests and the image job's zero-spend smoke, on the new pi).
  Each red check names what broke. When everything is fixed and green, a person marks it ready.
- **Those checks run the new pi's code with no review yet.** That is why `pi-upgrade-check.yml` is read-only and no
  `pull_request` job references a secret. Keep it so: a future `pull_request` job that references a secret would
  hand it to a bump pull request's pi code.
- **Reviewing a bump.** Work through the body's checklist (it is OQ-005's).
  - If `worker/test/pi-derived.test.mjs` is red, run `node .github/scripts/pi-derived.mjs --write` on the branch and
    commit the result. It prints the catalog hosts added and removed: **a new host widens the cost guard**, so check
    which output field pi sends there.
  - Read the linked pi releases (linked, never pasted). Check the human-judged copies their tests name (steering
    variables, pricing pins, the width table).
  - Every other red test is a pinned assumption that no longer holds: fix the code or the copy against the new
    release, never the assertion.
- **Updating a content hash.** Nothing moves one automatically: a red hash test is the prompt to re-verify. Read
  the named pi code in the new tarball (`npm pack @earendil-works/<pkg>@<version>`, never HEAD) and re-check the
  copy that test guards against it. Two kinds:
  - the `pinned-api.test.mjs` hashes are of single FUNCTIONS cut out by `piFunction`; the failing assertion prints
    the new values, so copy them from there;
  - the whole-file hashes (`models-json.test.mjs`'s `MIRRORED_PI_FILES`, `pricing.test.mjs`'s `models.js`,
    `admin/test/helpers/renderer.mjs`'s `PI_TUI_UTILS_SHA256`) are `shasum -a 256` of the named file.

  Put the new value in the same commit as any fix.
- **Fixes go on `chore/pi-bump`,** as ordinary signed-off commits, and the workflow never overwrites them. It rebuilds
  the branch only while it holds nothing but its own commit: one commit on the merge base, subject
  `chore(pi): run on pi X`, by Rob Boerman, committed as `robboerman+pi-bump@live.nl` (only the workflow uses that
  committer), changing only the pin files and the lockfile (`fixupsOn` in `pi-bump.mjs`). Anything else is a fix,
  including the bump commit amended, rebased or squashed, which rewrites its committer. Then a run for a newer pi pushes nothing and comments once per version
  on the pull request ("pi Y is out. ... Merge or close it, and the next run bumps to Y."). There is no flag to
  force it, also not on a manual run: merge or close the pull request, or delete the branch. A branch left without
  a pull request is rebuilt only when a closed pull request still holds its tip (GitHub keeps those commits);
  otherwise the run warns and leaves it. A rebuild puts a ready pull request back to draft.
- **The `PI_BUMP_TOKEN` secret** is a fine-grained personal access token of the owner's account, so the push and
  the pull request run every required check (a pull request opened with the workflow's own token runs none).
  Create it at GitHub, Settings, Developer settings, Fine-grained tokens: resource owner `edgehero`, repository
  access "Only select repositories" with `pi-dispatch` alone, permissions **Contents read and write** and **Pull
  requests read and write**, and nothing else (no Workflows permission: a bump touches no workflow file), with an
  expiry (90 days is a good default). Store it as the repository secret `PI_BUMP_TOKEN` (Settings, Secrets and
  variables, Actions). Without it the run warns and does nothing; once it has expired the push fails with an
  authentication error. Either way no pull request appears until a new token is stored.

## Commits and PRs

- Conventional subjects citing the issue number. The body explains *why*, names the spec IDs touched, and
  states what was checked and left unchanged.
- DCO sign-off (`git commit -s`). Branch names are `type/short-slug`.
- One PR per issue where possible; stacked PRs are merged one at a time, parent first, never with
  `--delete-branch` until the whole chain has landed.
- **`gh pr merge --admin` is no longer the merge path.** It was, while `main` required an approving review
  that a solo author cannot give themselves. `main` now requires a PR and green checks instead of an
  approval, so a green PR merges with a plain `gh pr merge`. Reach for `--admin` and you are bypassing the
  contract tests, not a paperwork rule.

## Things that look like bugs and are not

- **`resolveSession` returning `null` when no store is configured** is a DI-seam backstop; the processor
  refuses such a job before it spends, so the store's own branch is unreachable in a wired worker.
- **The overlay's `extensions/` load by default** while staged packages are withheld per trigger. Two
  different switches, deliberately: see `docs/global-pi-overlay.md`.
- **A serviced repo's `.pi/extensions` really does load in a job.** `/workspace` is the base repo's
  default-branch sha, so it is merge-gated content, never a fork's branch.
- **The staged-package manifest is read at each job start**, not once at boot. It *was* a boot read, and
  that was right while the staged set only changed when an operator edited a reviewed file; issue #102 made
  `pi install` then re-stage routine, and under a boot read a re-stage that drops a package makes every
  later job refuse at container start with the budget already reserved. A failed read keeps last-known-good
  rather than degrading to none, because an empty set runs the job toolless on a clean exit 0.
- **`worker/src/host-pi.mjs` mirrors private pi internals on purpose**, and pi exports no public
  alternative. It is pinned twice: `worker/test/host-pi.pinned.test.mjs` gates the pinned version, and
  `.github/scripts/host-pi-canary.mjs` warns against `latest`. Both share one needle list. If a pi bump
  fails either, fix the mirror, never the assertion. The residual is `OQ-018`.

## One note on this file

`CLAUDE.md` is read by the agent working on **this repository**. It is not `AGENTS.md`: pi discovers
`AGENTS.md` natively, so a root `AGENTS.md` here would also be loaded into every job that services this
repo. Keep instructions meant for maintenance out of the job containers.
