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
| `gateway/` | optional sandbox browser attachment, a separately hosted process with local terminal assets |
| `image/` | the job image and the in-container runner that implements the exit-code protocol |
| `deploy/` | service units, wrappers and the compose file; `worker/deploy/` is the published mirror |
| `specs/` | constitution, requirements, design, interfaces, open questions. The source of truth |
| `docs/` | operator-facing reference, one file per feature or forge |
| `design/` | the console's design system (#737): `system/` is the published cards, tokens and stylesheet; `tools/` the Python generators that build them (`design/README.md`) |
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
  `worker/src`, `receiver/src`, `image/runner`, `gateway/src`, `.github/workflows/pi-bump.yml` and `.github/scripts` for
  `pulls.merge`, `gh pr merge`, any spelling of auto merge, a self-approval and friends, so even a comment
  mentioning one fails the build.
- **`CONST-BUDGET-BEFORE-TOKENS`.** Free, determinate refusals go before anything that spends: before the
  token mint, the clone, the token-cap read and the budget reservation.
- **`CONST-RETRY-INFRA-ONLY`.** A determinate policy refusal **returns** a result; only infrastructure
  failure **throws** so the queue retries. Getting this backwards means either paying to retry something
  that can never succeed, or dropping real work behind a silent success.
- **Exact pins only** (`CONST-PI-VERSION-PINNED`). No `^`, `~`, `latest` or a floating tag for pi, for
  staged pi packages, or for image bases. A floating range turns an upstream release into every queued job
  quietly losing a tool while the queue still reports success. pi shipped sibling ranges without a shrinkwrap from 1.0.1; 1.4.0 uses exact sibling pins.
  The root `package.json` still pins every resolved `@earendil-works` package in
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
- **No README uses dashes as punctuation** (no em dash, no ` - `). Use commas, colons or parentheses. Keep the images:
  they carry more than the prose does. The root README's top half is for someone who does not write code, so its words
  stay plain until the "For engineers" heading (`admin/test/readmes.test.mjs` holds both).

## The design folder

- **Edit a generator, never a card.** Every card in `design/system/components/` but the hand-written Cover is
  written by `design/tools/gen_*.py`, and
  `python3 design/tools/build.py` rebuilds and checks every card (Python and Playwright, not part of `npm test`).
  Commit the generator and the rebuilt cards together.
- **The console pastes, it never reads.** A change to the look lands in `design/` first, and a console pull request
  pastes `tokens.json` or `bundle.css` into `pulse-tokens.mjs` or `pulse-css.mjs` with its new hash
  (`DES-OPERATOR-CONSOLE`, "The visual system").
- **Render to look, not only to pin.** A golden holds bytes, not whether a page looks right. `node launch/render-images.mjs
  --console --only <golden>` draws any state, and `--console` re-renders the READMEs' images, which no test can tell are
  stale, so re-render them in the pull request that changes the look.
- **A card's design status is a claim about this repository.** When a pull request builds a planned screen, move its
  card to *Built* in `STATUS` (`design/tools/fix_markers.py`) in the same pull request.

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
  - `the openshell venue holds its declarations` (`openshell-conformance.yml`, issue #683) reports on every PR and is
    **advisory**: the `openshell` venue is blessable since #684 (and its bind mode, `openshell-bind`, since #686, whose
    pass runs in the same job after the gateway is restarted with bind mounts enabled), the lane stays advisory until
    it has passed across a round, and its gateway (OpenShell, pinned in
    `.github/openshell.json`) is a 0.1.x vendor release. Read a red run as a finding. It becomes required in a later
    issue once it has passed across a round, as the podman lane did, and its `pull_request` trigger is already
    unfiltered so that change is branch protection alone.
  - Three PR-reporting checks are deliberately **not** required. `host-pi mirrors survive latest pi (canary)`
    is green-on-drift by design, so its red means pi failed to install (upstream flake, not a defect);
    `the job's MCP survives latest pi (canary)` is red on drift in a pi release the repository does not run yet,
    which the bump pull request fixes; and
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
  `INT-TRIGGERS-FILE-CONTRACT`'s forge vocabularies against `PR_ACTIONS` (two of the tests that read a spec
  file); the admin's forge, action and settings vocabularies against `worker/src/triggers.mjs` and
  `runtime-settings.mjs`; `EXIT_POLICY`'s copies in the runner and the `deploy/` units; the receiver
  filters' action sets as the loader's set minus their own named exclusions; the git hardening flags,
  which live in `worker/src/git-hardening.mjs` because seven files carried them by hand and one had
  quietly lost a flag; the pi tables that can be derived (`.github/scripts/pi-derived.mjs`, each checked-in
  copy held to its generation by `worker/test/pi-derived.test.mjs`); `docs/egress.md`'s canary rows, whose first column is rebuilt from
  `CANARY_LINES` by a test and required to match between markers (the count-the-source test it replaced
  could not see four spellings and could go false red on a comment); and every spec revision row, which
  must split into exactly two cells on unescaped pipes, because such a row is CUT on the rendered page
  while looking whole in the diff, and four had silently lost between 1,100 and 2,800 characters each; and the
  console's five hand-written lists in `admin/test/console-doc-tables.test.mjs`: `docs/console.md`'s `ended` table
  against `ENDED_REASONS` and the sign-in page's titles, its error-page table against `ERROR_KINDS` and their statuses,
  its runs filter table against `RUN_FILTER_FIELDS` and `RUN_OUTCOME_VALUES`, the requirements' destructive actions
  against the actions whose write rules set `danger`, and `docs/triggers.md`'s
  `pull_request` fields against the trigger add's `TRIGGER_ADD_FIELDS.pull_request`; and `INT-DEFER-REASON-KEY`'s
  reason table, fields block and bucket lists against `worker/src/defer-reasons.mjs`, both ways, in
  `worker/test/defer-reasons.test.mjs`; and the design folder's `tokens.json` and `components/bundle.css` against
  the console's pasted copies (`admin/test/design-folder.test.mjs`: the tokens equal, the stylesheet equal or exactly
  the version recorded as waiting to be pasted); and `docs/console.md`'s screens table against `PAGES`
  (`console-doc-tables.test.mjs`); and each ledger's panels and words against its design card (`console-ledger.test.mjs`,
  `onCard` for a fragment a test keeps), so a rebuilt card fails until its ledger is re-read; and the READMEs: the docs
  index against `docs/`, the worker's commands against the CLI, every image and cache tag, links to the root README's
  headings, and `launch/console-picks.mjs` against `docs/images/console/` and what shows them (`readmes.test.mjs`); and the record shape each release's `buildRecord` makes from the
  shared cases, `worker/test/fixtures/run-records/` (`INT-RUN-HISTORY-FILE-CONTRACT`), which `buildRecord` must equal
  for every case (`worker/test/run-record-fixtures.test.mjs`): when `buildRecord` changes, run
  `node .github/scripts/run-record-fixtures.mjs --next-only` and commit the `next.*` files with the change, and after a
  release run `--write` from a clone that has the release tags, so that release's shape gets its tag's name; and the
  store version tables (`DES-STORE-VERSION-WHEN-NEEDED`: `SETTINGS_KEY_VERSIONS`,
  `PAUSE_WINDOW_FIELD_VERSIONS`, `TRIGGER_RUN_FIELD_VERSIONS`, `TRIGGERS_BLOCK_VERSIONS`, `JOB_DATA_FIELD_VERSIONS`,
  `SANDBOX_MANIFEST_FIELD_VERSIONS`, `PROJECTS_FIELD_VERSIONS`), each held to its store's known fields and to its
  `*_VERSION` by `versionTableProblems`, and the value tables beside them (`SETTINGS_VALUE_VERSIONS`,
  `JOB_DATA_VALUE_VERSIONS`, `PAUSE_WINDOW_VALUE_VERSIONS`, `TRIGGER_VALUE_VERSIONS`, `TRIGGER_RUN_VALUE_VERSIONS`,
  `TRIGGERS_BLOCK_VALUE_VERSIONS`), each held to its store's known fields by `valueTableProblems`, with
  `PAUSE_WINDOW_FIELDS` held to the normalizer's own reads, any `AUTHORED_NARROWING_FIELDS` row added after issue #761
  to an entry in both the trigger-run and the job-data table, each exported closed list whose new member an older
  build refuses pinned at its issue #761 members, a new member needing a value rule in every store that carries it
  (`WAIT_CONDITION_KEYS`: `waitFor` in the trigger-run and job-data value tables; `FORGE_KINDS` as a pause scope's
  prefix and `DAYS`: `scope` and `days` in the pause window value table; `RUN_KINDS`: `kind` in the trigger-run and
  job-data value tables; `ON_TYPES`, `PR_ACTIONS`, `ISSUE_ACTIONS` and `REVIEW_STATES`: `on` in the trigger value
  table; `EXCLUDABLE_TOOL_NAMES` and `MCP_EXCLUDABLE_TOOL_NAMES`: `excludeTools` in the trigger-run value table;
  `BACKEND_NAMES`: `backend` in the trigger-run and job-data value tables; `FORGE_MCP_KINDS`: `run` in the trigger
  value table and `mcp` in the job-data value table; `ANSWER_CATEGORIES`: `answerRules` and `WATCH_SEVERITIES`:
  `watchSources` in the triggers block value table, `WATCH_SEVERITIES` also `on` in the trigger value table;
  `FORK_THINKING_LEVELS`: `thinkingLevel` in the job-data value table; `BUNDLE_FORMATS`: `secretBundles` in the
  settings value table), a list written inline being a residual of `DES-STORE-VERSION-WHEN-NEEDED`, and doctor's
  `STORE_FLEET_LINES` to the four version fields a worker publishes (`worker/test/store-version.test.mjs`,
  `store-versions-files.test.mjs`, `start-wiring.test.mjs`, `admin/test/store-versions-admin.test.mjs`). The first
  row in any of those tables, field or value, ships only once every host and every panel and console runs issue #761's
  release or later. The tolerant readers, the retention module and the upgrade path of the same issue add these:
  - `INT-CONSOLE-AUDIT-LOG`'s action, outcome and actor role lists against `CONSOLE_AUDIT_ACTIONS`,
    `CONSOLE_AUDIT_OUTCOMES` and the roles the console writes, and every member of both code lists against
    `CONSOLE_AUDIT_ACTION_RE` and `CONSOLE_AUDIT_OUTCOME_RE` (`worker/test/console-audit.test.mjs`). The writer stays
    closed and only the verifier reads the shape: a value a release adds outside it would make every older verifier
    call an intact chain broken, so that release fails its own build. `TOKEN_ROLES` is held to `TOKEN_ROLE_RE` the
    same way (`console-tokens.test.mjs`): an older console keeps an entry of a shaped role and refuses the whole file
    for any other. A field of an entry or a key of the tokens file that would narrow who may sign in raises its
    `version`.
  - The checkpoint version tables, `CHECKPOINT_POINTER_SHAPES` (`run-checkpoint.mjs`) and `CHECKPOINT_MANIFEST_READS`
    (`workspace-checkpoint.mjs`), each reading exactly its newest version and the one before it, with the version its
    writer writes among them (so a release may read v + 1 while it still writes v, and the next release writes v + 1),
    and the pointer's TTL equal to the store's (`run-checkpoint.test.mjs`). The rule no test can check: a release that
    adds a version only reads it, and the writer of it ships a release later, and an older reader is dropped only in a
    release shipped at least 7 days after the writers stopped writing its version. A later pointer version keeps
    `host` and `jobDir` as they are, since the boot sweep's keep-list (`pointerKeepEntry`) reads every version and its
    "no" deletes.
  - The job retention: a forge job's 31 days and a local job's day and week live in `worker/src/retention.mjs`
    (`@edgehero/pi-dispatch/retention`, a leaf the receiver and the admin import too), every value that must move with
    them is derived from it (a marker that stands in for a job key, the console's re-run windows and their sentences,
    the dashboard's FAILED header), and a source scan
    (`worker/test/retention.test.mjs`) refuses a 31-day literal in `worker/src`, `receiver/src` or `admin/src` outside
    its named exemptions (the watch ceiling plus a day, the OAuth lifetime bounds), each of which must match exactly
    one line. A 31-day literal is 31 times a day's factor (24, 1440, a day in seconds or milliseconds written 86400,
    86_400, 864e2, 8.64e4, 86400000, 86_400_000, 86400e3, 864e5, 86.4e6 or 8.64e7, or a name with "day" in it), in
    either order and through other factors, or 2678400 in seconds or milliseconds (2_678_400, 2.6784e6, 2.6784e9),
    with `_` between any digit groups and a capital `E` taken as well. The scan reads one line at a time and misses
    every other spelling (`8.64e+7`, a BigInt) and a product split across lines. Put a new retention-shaped value
    there, never in the file that uses it.
  - BullMQ's internals, `worker/test/bullmq-internals.test.mjs`: a single-owner scan of `worker/src`, `receiver/src`,
    `admin/src`, `image/runner` and `gateway/src` (comments stripped, a line at a time) refuses a second spelling of a
    BullMQ key, job field, the delayed score, the `repeat:`/`manual:` run id grammar, the three-part custom id rule or
    a scheduler key's bound outside `worker/src/bullmq-internals.mjs`, with named exemptions that must each match
    exactly one line and a planted spelling per pattern so the scan is not vacuous; text pins hold every file the
    module cites to the installed BullMQ, and `customJobIdAllowed` to BullMQ's own `validateOptions`; and the pins
    agree ("BullMQ bumps" below). The scan catches the shapes the trees have used (each pattern is one found in them
    before issue #761: quoted key prefixes and suffixes, quoted job fields, the parser shapes), not every spelling: a
    meta flag read by name, a spelling built across lines or from variables, or one in a shape no tree has used is
    caught only by reading the change.
  - The Valkey image, `worker/test/valkey-image.test.mjs`: every place that names it (`up`'s `docker run` and owner
    check, `deploy/docker-compose.yml` and the Quadlet unit and their `worker/deploy/` mirrors, `service.mjs`'s
    `TEMPLATE_PINS`, CI's Valkey services, the image job's pull and the canary smoke script) is held to `VALKEY_IMAGE`,
    the constant is a minor and is not in `OLDER_VALKEY_IMAGES`, and no source names a Valkey image anywhere else.
  - The upgrade guide and the backup page. `worker/test/upgrading-doc.test.mjs`: every release notes step of
    `release.yml` and `repo-release.yml` (found from the files, one per `gh release create`) appends the
    `**Upgrading**` line to `docs/upgrading.md` at its own tag, after both the AI and the fallback path and outside
    the `PREV` test; every guide with an upgrade heading or bold upgrade lead, plus a pinned list, links the guide
    and is linked back from it; and every link out of it or into it resolves, anchors included. The release numbers
    on it come from `git tag --contains` in a clone with tags, and no test can check them (only their shape and
    order). `worker/test/backup-doc.test.mjs`: every `*_FILE`, `*_DIR`, `*_DIRS` or `*_PATH` setting in
    `.env.example` or read from the environment by host-side source, every subfolder the source makes in the run
    history or the session store, every store with a fixed file or folder name in `FIXED_STORES` (pinned by a source
    file and a literal), and every Valkey key family (pinned the same way, every exported constant with a key's shape
    inside one, whatever its name) is named in `docs/backup.md` or excluded with its reason. Two things it cannot see
    are caught only by reading the change: a store with a fixed name `FIXED_STORES` does not list, and a key family
    built inline with no exported constant.
  Add a table, add its bolt. Where the relation is NOT real, say so in the test
  rather than manufacturing one: `PR_ACTION_VOCAB.dflt` is deliberately unpinned, with a line explaining
  that gitlab's default is not its set's first member.

## Stored state across releases

- **A change to what pi-dispatch stores** (a file, a run record, job data, a Valkey key, the Valkey image, the BullMQ
  pin) adds its row to `docs/upgrading.md` under the release it ships in. When the older shape stays readable it also
  registers a detector in `worker/src/older-state.mjs` (doctor's `state.older`), gated so that it retires itself once
  nothing is left in the older shape, and firing only on an exact older reference, never on something an operator
  chose. A new store or key family goes in `docs/backup.md`. Its bolt fails until it does for a path setting, a
  subfolder of the run history or the session store, and an exported constant with a key's shape; it cannot see a
  store with a fixed file or folder name that its `FIXED_STORES` does not list, or a key family built inline, so add
  those to its tables by hand.
- **Valkey moves only by changing `VALKEY_IMAGE`** (`worker/src/valkey-auth.mjs`). Every other place that names the
  image (`up`'s `docker run` and owner check, the compose file and the Quadlet and their `worker/deploy/` mirrors,
  `service.mjs`'s `TEMPLATE_PINS`, the CI services and the canary smoke) is held to it by a test. A new minor is a
  release with an upgrade guide row, never a floating tag: the value it leaves goes in `OLDER_VALKEY_IMAGES` in both
  spellings, and the facts the specs measured on it (`HEXPIRE`, `/bin/sh`) and a volume loading in both directions
  are measured again. A step that recreates the Valkey container stops it first (`docker stop`, never
  `docker rm -f`): the normal stop is what makes Valkey write its AOF out and save a final snapshot.

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
  - If `admin/test/provider-key-names.test.mjs` is red, read the new pinned pi-ai artifact's
    `dist/env-api-keys.js` and the worker's `providerKeyCandidates` before running
    `node .github/scripts/provider-key-names.mjs --write`. The console's generated data-only table carries that
    whole-file source hash and every provider's candidate order, so re-generation follows verification, never
    replaces it. Keep provider SDKs out of the console; its bundle guard checks that boundary.
  - If `worker/test/store-versions-files.test.mjs` is red because `EXCLUDABLE_TOOL_NAMES` gained a tool, add a
    `TRIGGER_RUN_VALUE_VERSIONS.excludeTools` rule answering 2 for a trigger that excludes it: an older loader refuses
    such a file as broken.
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
  `chore(pi): run on pi X`, by Rob Boerman, committed as `6673123+edgehero@users.noreply.github.com` (the ID form of
  the maintainer's noreply address, which only the workflow commits as), changing only the pin files and the lockfile
  (`fixupsOn` in `pi-bump.mjs`). Anything else is a fix, including the bump commit amended, rebased or squashed, which
  rewrites its committer. Then a run for a newer pi pushes nothing and comments once per version on the pull request
  ("pi Y is out. ... Merge or close it, and the next run bumps to Y."). There is no flag to
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

## BullMQ bumps

Every BullMQ fact read past its public API (key names, job hash fields, the meta flags, the delayed score, the
`repeat:`/`manual:` run id grammar, the custom id rules) lives in `worker/src/bullmq-internals.mjs`, each beside the
shipped file it was read from; `worker/test/bullmq-internals.test.mjs` refuses a second spelling, in the shapes the
trees have used, in `worker/src`, `receiver/src`, `admin/src`, `image/runner` and `gateway/src`. A bump moves
together: the three exact `bullmq` pins (worker, receiver, admin), `ioredis` (those and gateway) and admin's
`cron-parser` to bullmq's own dependencies, the lockfile (no nested copy), and `BULLMQ_VERIFIED_VERSION`. Then
re-read every file the module cites in the new tarball (`npm pack bullmq@X`, `package/dist/esm/...`) and
`moveStalledJobsToWait-9.lua` for `STALLED_FAILED_REASON`
(`index.mjs`, pinned by `lost-lock.test.mjs`), and run the unit test (text pins, pins agree, BullMQ's own
`validateOptions`) and `bullmq-internals.integration.test.mjs` (a real Valkey). A red pin is a fact that moved: fix
the module, never the assertion. The meta `version` field flips in a mixed fleet; never build a warning on it. A
bump is stored state too: it gets its row in `docs/upgrading.md`, which says never to roll back across it while jobs
are queued.

## Commits and PRs

- Conventional subjects citing the issue number. The body explains *why*, names the spec IDs touched, and
  states what was checked and left unchanged.
- DCO sign-off (`git commit -s`). Branch names are `type/short-slug`.
- **No personal email address in any commit message**, nor in a pull request, an issue or a comment. The
  maintainer's commits are authored, committed and signed off as `Rob Boerman <edgehero@users.noreply.github.com>`
  (set as the repository's `user.email` before committing): `git commit -s` writes the committer's address into
  the `Signed-off-by` line, so a personal address in the git config ends up in the message. The pi bump workflow
  authors as the same noreply address and is committed (so signed off) as its ID form, `BUMP_AUTHOR` and
  `BUMP_COMMITTER` in `pi-bump.mjs`.
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
  default-branch sha, so it is merge-gated content, never a fork's branch. A recovered `run.recover` run is the
  exception that keeps the rule: its workspace is restored to its own run's `baseSha` (not a fresh default-branch
  resolve) with the lost attempt's tree written over it, and `worker/src/trust-paths.mjs` then resets `.pi/`,
  `.agents/` and the root `AGENTS.md`/`CLAUDE.md` files to `baseSha`'s content before the container starts, so what
  pi loads is still merge-gated and never what the agent wrote (`DES-RECOVERY-TRUST-PATHS-FROM-BASE`). The reset
  cannot see what an extension IMPORTS (a file outside `.pi/`, a package from `/workspace/node_modules`, both
  agent-written in a restored tree), so a run whose base commit holds anything under `.pi/extensions/` is never
  armed for recovery (`recoverSkipped: "workspace-extensions"`, `baseHasExtensions`), and a recovery that meets one
  anyway is refused (`recovery-unsafe-extensions`).
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

`AGENTS.md` is read by the agent working on **this repository**, and by pi in every job that services it: pi loads
a directory's first context file of `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md` and `CLAUDE.MD`
(`loadContextFileFromDir` at the pinned version), so it did the same when this file was called `CLAUDE.md`. Write it
for whoever maintains the repository, knowing that the jobs on this repository read it as context too.
