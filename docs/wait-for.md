# Waiting — hold a job until a condition clears

A trigger fires the moment its event arrives. Usually that is the point. Sometimes it is exactly wrong: the
label went on the issue at 16:40 but the deploy window opens at 09:00, or the ticket is labelled `pi:fix`
while its Jira parent is still in review and the agent would write a patch against a decision nobody has
made yet.

`run.waitFor` holds such a job in the queue, unstarted and unbilled, until every condition it names is
satisfied. Nothing runs, nothing is charged, and the delivery is not dropped: the job sits in the delayed
set, survives a worker restart, and starts exactly once when the last condition clears.

Two kinds of condition, and they cost very different amounts:

- **`after`** — an instant. The worker computes one delay from the clock and sleeps until it. No polling, no
  subprocess, nothing to configure and nothing to install. Bounded by `PI_WAIT_AFTER_MAX_MS` (30 days).
- **`profile`** — the name of a script **you** write, which the worker runs on the host and asks the only
  question it needs: may this job start yet? Bounded by `PI_WAIT_MAX_MS` (24 hours), by `PI_WAIT_MAX_CHECKS`
  (96) and by `PI_WAIT_MAX_FAULTS` (5). At the shipped defaults the **check count** is the one that fires
  first, at roughly 19 hours and 40 minutes, because the interval backs off toward 15 minutes; the 24 hours
  binds only if you lengthen the cadence or raise the count.

Conditions are a **conjunction**: all of them must clear. They are evaluated cheapest first rather than in
writing order, so an unreached instant never costs you a subprocess.


**On more than one machine** ([`multi-host.md`](multi-host.md)): `PI_WAIT_CHECK_SLOTS` is fleet-wide once
a worker name is declared, so the capacity arithmetic below is for the whole deployment rather than per
host. It used to be per process, which meant N hosts ran N times the checks against the same external
system while the only symptom, a denial, got *rarer* per host as you scaled out. A wait profile is also a
script on one machine's disk: a host that does not have it refuses the job, so declare the same profiles
everywhere, or accept that a delivery's fate depends on which host popped it.

## Enable it

`after` needs no configuration at all. `profile` needs the table that says which names exist here:

```sh
# .env
PI_WAIT_PROFILES=jira:/opt/pi/wait-jira.sh,ci:/opt/pi/wait-ci.sh
```

`name:/absolute/path` pairs, comma separated, each entry splitting on its **first** colon so a Windows
`C:\...` path parses. Unset means no profile is declared, and a trigger naming one is refused per delivery
(`wait-profile-unknown`) rather than started without the question ever being asked.

### There is no roots variable, and that is not an oversight

`run.secrets` has `PI_SECRET_RESOLVER_ROOTS`, which exists so the **panel** may declare a resolver without
letting an operator point it at any executable on the box. There is no `PI_WAIT_RESOLVER_ROOTS` because
there is no panel door: wait profiles are declared in `.env` only, by whoever can already edit `.env` and
therefore already owns the worker. Adding a roots variable would gate a door that is not open. Declaring a
profile from the panel is deferred, and it is the change that would need one.

## The condition schema

```jsonc
{
  "on": { "type": "label", "any": ["pi:deploy"] },
  "run": {
    "kind": "github",
    "flow": "deploy",
    "waitFor": [
      { "after": "2026-09-01T09:00:00Z" },
      { "profile": "jira" }
    ]
  }
}
```

- **1 to 4 conditions**, each an object with **exactly one** key. Zero conditions, two keys in one object,
  or a fifth condition all refuse the file at load.
- **`after`** — an ISO 8601 instant that carries **its own zone**: a trailing `Z` or an explicit `+02:00`.
  A bare `2026-09-01T09:00:00` is refused, because "09:00" without a zone means one thing on your laptop
  and another in the container's UTC, and the difference is silent. Impossible dates (`2026-02-31`) and
  out-of-range times (`T24:00:00`) are refused rather than rolled forward into a date you did not write.
  **One `after` per array**: two instants mean the later one, and a file that reads as though both mattered
  is a file that will mislead someone.
- **`profile`** — a name from `PI_WAIT_PROFILES`. Whether it exists is deployment state, not file state, so
  the file loads and the **delivery** refuses. The same name twice is refused: a conjunction cannot change
  its answer on the second ask, and it would double the subprocesses.
- **An unknown key INSIDE a condition is refused, not dropped**, which inverts this file's general rule that
  an unrecognised `run` key is tolerated for forward compatibility. So are the near misses: `run.waitfor`,
  `run.wait_for`, and `on.waitFor` (correct spelling, wrong half of the entry). Elsewhere a dropped key is a
  field that does nothing; here it is a term of a gate that does nothing, and a wait that silently did not
  happen is a paid run that looks exactly like a correct one.
- **`exclusive` is not a condition you write.** The worker already holds at most one local job per folder,
  always on, and `scoped-limits.json` bounds any scope further. See [scoped-limits](scoped-limits.md).

Three combinations are refused at load, each naming why:

| Combination | Why it is refused |
|---|---|
| `waitFor` + `on.once` | the one-shot disarms on every run **record**, so a wait that never cleared would spend it with no container ever started, and re-arming means hand-editing the file |
| `waitFor` + `run.replicas` | replicas fan out at enqueue, so N replicas would hold and poll one external condition N times for one answer |
| `waitFor` on a `cron` trigger | the scheduler advances at pickup, so a held occurrence outlives the teardown that would delete it and still pays, and its surviving hash can fail worker boot on a scheduler id collision. A gap to close, not a limit |

## Writing a check

A check is a program. It gets **one argument**, exits, and that is the entire interface:

```sh
#!/bin/sh
# /opt/pi/wait-jira.sh. Owned by the account the worker runs as and writable by nobody else: whoever can
# edit this file can run code as the worker, on a schedule, while no job is running.
#
# $1 is the id-only target: `acme/web#7` for an issue on any forge, `acme/web!12` for a merge request on
# GitLab or Azure (each forge's own notation for a pull request). Never a title, never a body, never
# anything an issue author typed. Only forge triggers can wait, so the target is always `<repo><sep><n>`.
#
#   exit 0  go. Every other condition permitting, the container starts now.
#   exit 3  not yet. Held, checked again later, nothing counted against you.
#   exit 2  this will NEVER clear. The job is refused for good (`wait-refused`) with a comment.
#   exit 1  you could not tell. Held, but COUNTED: five in a row and the job is refused as
#           `wait-unanswerable`, which is what makes a broken check loud in minutes instead of
#           silent for a day. Anything unrecognised, a crash and a timeout all read as 1.

ticket=$(printf '%s' "$1" | sed 's/.*[#!]//')   # `!` too: GitLab and Azure spell a merge request that way
status=$(jira issue view "PROJ-$ticket" --plain 2>/dev/null) || exit 1
case "$status" in
  *"Status: Done"*)     exit 0 ;;
  *"Status: Won't Do"*) exit 2 ;;
  *)                    exit 3 ;;
esac
```

The distinction that earns its keep is **2 against 1**. Exit 2 costs you a delivery: say it only when you
know. Exit 1 costs you nothing on the first four tries and then costs you the delivery anyway, which is the
point: a `curl` with a typo'd URL exits 6, `jq -e` on a false value exits 1, and without the fault count
either of those would hold the job for a full day, spawn ninety-six processes, and die blaming the ticket.

**The one-liner trap, and it is the mistake to expect.** The obvious first check is a pipeline:

```sh
exec jira issue view "$1" --plain | grep -q '^Status: Done'   # WRONG
```

That is a two-code program in a four-code contract. `grep -q` exits **1** for "no match", so the ordinary,
correct, everything-is-fine answer *not yet* arrives as **could not tell**, is counted as a fault, and five
checks later the job is refused as `wait-unanswerable` naming your script. The exit code a check gives for
"the condition is simply not met" must be **3**, and nothing in a shell pipeline will do that for you: map
the codes yourself, as the sample above does with `case`.

Three shapes cover nearly every check worth writing. The vendor is an instance of the shape, not a shape of
its own:

**Shape 1: a CLI the vendor already ships.** The sample above. `jira`, `linear`, `gh`, `az boards`, `glab`.
Cheapest to write and the most likely to be already installed and already authenticated on the host, since
the worker runs with your environment. Watch the exit codes: most of these CLIs exit non-zero for "not
found" as readily as for "network down", so map explicitly rather than passing `$?` through.

**Shape 2: an HTTP API.** When there is no CLI, or the CLI's exit codes are not worth trusting:

```sh
out=$(mktemp); trap 'rm -f "$out"' EXIT          # NOT a fixed path: raise PI_WAIT_CHECK_SLOTS and two
                                                 # checks would clobber one file and answer for each other
code=$(curl -sS -o "$out" -w '%{http_code}' -H "Authorization: Bearer $LINEAR_TOKEN" ...) || exit 1
[ "$code" = 200 ] || exit 1                      # 5xx, 429, a proxy: could not tell
grep -q '"state":"Done"' "$out" && exit 0
grep -q '"state":"Canceled"' "$out" && exit 2    # it will never clear
exit 3
```

Separate transport failure (exit 1) from a definite negative answer (exit 3 or 2). A `curl` that could not
reach the host has not told you the ticket is open.

**Shape 3: something local.** A lock file a deploy pipeline writes, a `systemctl is-active`, a `test -f`
on an artifact, the exit code of a smoke test. These are the cheapest and the most reliable, and they are
what a check looks like once the question stops being "is this ticket done" and becomes "is the previous
deploy finished".

What the check does **not** get: stdin (it is `/dev/null`, so a script that prompts dies immediately rather
than hanging to its timeout), a shell (the path is executed directly with an argv array, so nothing in the
target can interpolate), or any use for its output. **Both stdout and stderr are counted, never read.** The
log line records how many bytes each produced and the profile's name; it never records the path, the output,
or anything derived from either. Write to stderr freely for your own debugging; nothing this project stores
will ever contain it.

The timeout kills the process the worker started, and only that one. A check that backgrounds something and
returns leaves that grandchild running on your host, outside the ladder and outside the timeout, so do not
start long-lived work from a check. (For the same reason the byte counts are a floor rather than a total.)

## How it works

Every wait is a gate **above** the work, in the same ladder as quiet hours and the scope mutex:

```
pause window → wait → scope acquire → container
```

Nothing has spent anything when a wait decides. A held job returns to the delayed set with a fresh delay and
is re-examined on its next wake; it holds no scope slot and no concurrency slot while it sleeps.

- **An `after` wakes at the exact instant**, once, with no jitter and no polling. Only the profile tier has
  a cadence.
- **That cadence** starts at `PI_WAIT_INTERVAL_MS` (60s, floored at 30s) and **backs off** as the hold
  lengthens, toward 15 minutes — or toward your value if you set a longer one, since an operator who asks
  for hourly checks to save money must not silently get quarter-hourly ones. Each delay is jittered by up
  to +10%, so a hundred jobs held on one outage do not wake in lockstep. The jitter only ever adds: taking
  time off would let a delay fall under the 30s floor, and that floor is what tells a wait deferral apart
  from a scope deferral, which re-checks every 5s. The delay is also clamped to whatever is left of
  `PI_WAIT_MAX_MS`, so an hourly interval under a 15-minute maximum stops at 15 minutes rather than
  overshooting to 60.
- **Checks are leased.** `PI_WAIT_CHECK_SLOTS` (1) bounds how many run at once, and the gate holds it below
  `PI_CONCURRENCY` so a check cannot take the last slot from a paid job. The one exception is stated rather
  than implied: at `PI_CONCURRENCY=1` the floor is one slot and the check does take the only one, because
  that is the configuration where this bound can protect nothing. A job denied the lease re-defers at a
  quarter of the cadence, never less than 11 seconds, without spawning anything. That is enough for roughly
  ninety held jobs once they have backed off to the 15-minute cadence, and only about six while they are
  still checking every minute; past that the log says `wait_capacity_exceeded` and names the three knobs.
- **The clock starts at the first hold**, not at enqueue. A job that spent ten hours in a quiet window
  before its first check has waited zero minutes, not ten hours, and `PI_WAIT_MAX_MS` measures from there.
- **The last check really runs.** On the wake that would expire the job, the check is run once more before
  `wait-expired` is written, so a condition that cleared during the final backoff runs the job rather than
  being recorded as never-cleared.
- **A second delivery does not stack.** Re-labelling a held issue refuses `wait-superseded` rather than
  queueing a second hold on the same conditions, and the refusal is verified against the live delayed set
  first, so a stale key can never refuse a legitimate job. **The refusal outlives the hold by 15 minutes.**
  When a job finishes waiting it leaves a marker for that long, because that is the furthest apart two jobs
  which cleared together can wake, and a sibling must find the answer rather than an empty lease. A delivery
  arriving inside that window is refused `wait-superseded` too, even though the queue's own 10-minute
  semantic dedup would have admitted it as new intent. Deliveries after it are admitted normally.

## Watching and cancelling

A held job is not a mystery entry in the delayed count. The `/dispatch` panel grows a **held** section when
anything is waiting and hides it entirely when nothing is:

```
held · 4 waiting on conditions
  ○ acme/web#7 · after 2026-09-01T09:00:00Z + jira · waited 2h14m
  ○ acme/web#31 · jira · waited 41m
  ○ acme/api#5 · ci · waited 8m
  ↓ 1 more
```

Three rows and a count of the rest, always. (`/dispatch waits`, the plain text renderer, prints the same
rows with `... and N more` instead of the arrow.)

Every cell is chosen by the worker: an id-only target, the operator-authored condition label, and an honest
duration. No issue title and no issue body reaches the panel, which is why the reader takes the worker's own
records rather than the delayed jobs.

- `dispatch_waits` lists what is held, with the job ids.
- `dispatch_wait_cancel` stops one, behind the same operator confirm dialog as every other write. It is the
  only way to stop a held job short of editing redis by hand: nothing else prunes the delayed set, and a
  cancelled job is gone rather than deferred.

`pi-dispatch doctor` reports the rest: a garbled `PI_WAIT_PROFILES` (a worker that will not **boot**, so
this one is asked even when nothing waits), a profile a trigger names that is not declared, a declared path
a trigger names that is absent, a directory, or not executable, and an `after` further out than
`PI_WAIT_AFTER_MAX_MS`. Those are hard failures, because each is a worker that will not start or a delivery
that will refuse. A declared profile **no** trigger names only warns: nothing looks it up, so nothing
refuses today. What doctor does not check is who may edit your check scripts; see trap 2.

## The traps

### 1. A receiver below the floor drops the field, and the job runs

This is the trap. `run.waitFor` needs `@edgehero/pi-dispatch` **1.6.0**, `@edgehero/pi-dispatch-admin`
**1.6.0** and `@edgehero/pi-dispatch-receiver` **1.4.0**; that is the floor. An older receiver matches the
rule, enqueues the job **without** the conditions, and the worker sees an ordinary job. It then runs at
16:40 instead of 09:00, produces a perfectly normal record, a perfectly normal panel row and a perfectly
normal log line, and nothing anywhere says that the wait did not happen. Success is the least detectable
failure available, and the whole premise of a wait is that running now is the destructive option.

So the worker no longer trusts the job alone. At the gate it re-reads `triggers.json`, compares the entry
that fired against what actually arrived, and refuses **`wait-skew`** before any spend when the file says
wait and the job does not.

Two things about that backstop you have to know, because neither announces itself. It **fails open in
silence**: a `triggers.json` it cannot read means the job runs, and nothing is logged and nothing lands in
the record. And it reads `PI_TRIGGERS_FILE`, falling back to `triggers.json` in the worker's *current
directory*, so on a deployment where the variable is unset and the worker's cwd is somewhere else the
detector is a permanent no-op. Set `PI_TRIGGERS_FILE` explicitly and confirm `pi-dispatch doctor` reads the
file you think it does.

Nor is there a canary on the other side. A stale **admin** gives no signal at all: it round-trips the raw
entry when it writes, and `run.waitFor` is just an unknown `run` key to a loader that predates it, which
that loader tolerates by design. Check the installed versions directly. The detector is a backstop; the
thing that actually prevents this is upgrading the receiver in the same `npm install` as the worker, before
you write your first condition.

Skew in the other direction gets its own token rather than sharing this one. A job that arrives carrying a
condition **this worker** cannot read refuses **`wait-unreadable`**: same version drift, opposite remedy.
`wait-skew` means upgrade the receiver, `wait-unreadable` means upgrade the worker, and one token for both
would tell you something is out of step without saying which way to move.

### 2. Your check runs on the host, with the worker's environment, unattended

A resolver script runs when a job is about to start. A wait check runs **on a schedule while nothing is
running**, with the worker's whole environment, for up to a day per job. That is a larger surface than it
looks. Own the file as the worker's account, make it writable by nobody else, and keep it dull: no `eval`,
no interpolation of `$1` into a shell string, no writing anywhere a job can read. Nothing enforces any of
that: `pi-dispatch doctor` checks only that the path resolves to an executable file, which is the same
question the worker will ask at spawn time and not a question about who may edit it.

### 3. Nothing in the spend caps sees a check

`CONST-BUDGET-BEFORE-TOKENS` counts container starts, and a check starts no container, so a wait is free by
every measure the money system takes. `PI_WAIT_MAX_CHECKS` (96 per job) exists because otherwise nothing at
all bounds the count — the other knobs bound duration, cadence and concurrency. If your check calls a
metered API, that cap is your bill's only ceiling.

### 4. The delayed count still lies, and always will

The panel's `delayed` figure mixes cron next-occurrences, retry backoff, quiet-hours deferrals, scope
deferrals and waits. It is not a defect and it will not be split: read the **held** section for what is
actually waiting on a condition, and treat the number in the status line as the undifferentiated total it
has always been.

### 5. Whoever clears the condition chooses the commit

`prepare-github` resolves the default branch's sha at run time, so a job held for a day runs against the
head as it stands a day later, not against what the labeller saw. That is usually what you want. It is also
a wider statement than it looks, and worth saying plainly: a maintainer's label authorizes the run, but the
**moment** it begins is chosen by whoever clears the condition, who may be a Jira user with no permission on
the repository at all. Choosing the moment chooses the commit an authorized agent writes against. The
condition itself is operator-authored in the reviewed file and nothing payload-supplied can reach it, which
is what keeps this bounded rather than open.

The ceiling on that drift is the one for the tier you used: `PI_WAIT_AFTER_MAX_MS` (30 days) for an `after`,
and `PI_WAIT_MAX_MS` / `PI_WAIT_MAX_CHECKS` (about 20 hours at the defaults) for a profile hold. Pinning the
sha at enqueue for held jobs specifically is an open question (`OQ-029`), not a setting.

## Reference

| Piece | Value |
|---|---|
| Field | `run.waitFor`, 1 to 4 conditions, each with exactly one key, all must clear |
| Conditions | `{ "after": "<ISO instant with a zone>" }` (max 1), `{ "profile": "<name>" }` |
| Env vars | `PI_WAIT_PROFILES` (unset = feature off), `PI_WAIT_CHECK_TIMEOUT_MS` 10000, `PI_WAIT_INTERVAL_MS` 60000 (floor 30000), `PI_WAIT_CHECK_SLOTS` 1, `PI_WAIT_MAX_MS` 86400000, `PI_WAIT_AFTER_MAX_MS` 2592000000, `PI_WAIT_MAX_CHECKS` 96, `PI_WAIT_MAX_FAULTS` 5 |
| Check contract | argv[1] is the id-only target; exit `0` go, `3` not yet, `2` never (terminal), `1` could not tell (counted); stdout and stderr counted, never read; 10s timeout, SIGTERM then SIGKILL |
| Refusal reasons | `wait-refused`, `wait-expired`, `wait-unanswerable`, `wait-profile-unknown`, `wait-superseded`, `wait-skew`, `wait-unreadable`, `wait-after-beyond-max` (all pre-spend, never retried) |
| Refused at load | `exclusive`, unknown or misspelled keys, a zone-less `after`, two `after`s, a repeated profile, `on.once`, `run.replicas`, `cron` triggers |
| Panel | the `held` section (appears only when something waits), `dispatch_waits`, `dispatch_wait_cancel` |
| Version floor | worker 1.6.0, admin 1.6.0, receiver 1.4.0 |
| Related | [quiet hours](pause-windows.md), [scoped limits](scoped-limits.md), [secrets](secrets.md), [workflows](workflows.md) |
