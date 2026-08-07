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
  `worker/src`, `receiver/src` and `image/runner` for `pulls.merge`, `gh pr merge`, `autoMerge` and friends,
  so even a comment mentioning one fails the build.
- **`CONST-BUDGET-BEFORE-TOKENS`.** Free, determinate refusals go before anything that spends: before the
  token mint, the clone, the token-cap read and the budget reservation.
- **`CONST-RETRY-INFRA-ONLY`.** A determinate policy refusal **returns** a result; only infrastructure
  failure **throws** so the queue retries. Getting this backwards means either paying to retry something
  that can never succeed, or dropping real work behind a silent success.
- **Exact pins only** (`CONST-PI-VERSION-PINNED`). No `^`, `~`, `latest` or a floating tag for pi, for
  staged pi packages, or for image bases. A floating range turns an upstream release into every queued job
  quietly losing a tool while the queue still reports success.
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
- `admin/dist/` is gitignored and built by `node admin/build.mjs`. Never commit it.
- Two mirrors must stay **byte-identical**, pinned by tests: `worker/.env.example` to the root
  `.env.example`, and `worker/deploy/*` to `deploy/*`. Edit both.
- The wizard's `RUNTIME_VERSION` and `RECEIVER_VERSION` are bolted to the workspace versions by anti-drift
  tests. A release bump moves all of them together.

## Commits and PRs

- Conventional subjects citing the issue number. The body explains *why*, names the spec IDs touched, and
  states what was checked and left unchanged.
- DCO sign-off (`git commit -s`). Branch names are `type/short-slug`.
- One PR per issue where possible; stacked PRs are merged one at a time, parent first, never with
  `--delete-branch` until the whole chain has landed.

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
  fails either, fix the mirror, never the assertion.

## One note on this file

`CLAUDE.md` is read by the agent working on **this repository**. It is not `AGENTS.md`: pi discovers
`AGENTS.md` natively, so a root `AGENTS.md` here would also be loaded into every job that services this
repo. Keep instructions meant for maintenance out of the job containers.
