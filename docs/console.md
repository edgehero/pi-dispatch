# The operator console

A web page for managing the deployment, served by a process of its own, `pi-dispatch-console`. It sits beside the
`/dispatch` panel in pi, not in place of it: both read the same files and the same Valkey, and both write through the
same validated functions, so neither can do anything the other would refuse.

It shows the whole deployment, live: what is running and queued on every host, every run with filters, the runs
waiting for an answer, spend and insights for a range of days, the schedules, the configuration and the console's own
audit log. Open pages update themselves about once a second while you watch, and `/api/state` gives a script the same
snapshot as JSON. It can also change all of it: cancel, retry, remove and re-run jobs, answer a parked run, pause
the fleet or one queue, and edit the configuration, each with a preview and a confirm ([Actions](#actions)). An
operator can watch a running job's transcript live on its run page, whichever host runs it
([The live transcript](#the-live-transcript)).

The first half of this page is about access, because the console is the most powerful surface after a shell on the
host. [The screens](#the-screens) starts below that.

## Install

The console ships in the admin package, the same one that gives pi the `/dispatch` panel:

```bash
npm i -g @edgehero/pi-dispatch-admin
```

Run every `pi-dispatch-console` command as the account that runs the deployment, on the deployment's host. It finds
the deployment the way the panel does: `--deployment <dir>` if you pass it, else the folder the deployment pointer
names (written by `/dispatch setup`), else the current folder. It reads its settings from that deployment's `.env`;
a value exported in your shell wins, as it does for the panel.

## Create the first token

Nobody can sign in until there is a token, and `serve` refuses to start without at least one operator:

```bash
pi-dispatch-console token add --name rob --role operator
```

It prints the token **once**, on one line, starting with `pdc_`. Put it in your password manager now: the file keeps
only its sha256 hash, so it cannot be shown again. If you lose it, rotate it.

Give each person their own token, named after them. The audit log names the token behind every action, so a shared
token turns "who changed this" into "someone did". A second role, `viewer`, can sign in and read but every write
answers 403:

```bash
pi-dispatch-console token add --name sam --role viewer
```

The tokens live in `console-tokens.json` in the deployment folder (`PI_CONSOLE_TOKENS_FILE` moves it). It must be a
regular file at mode 0600, owned by the account that runs the console: `serve` refuses a symlink, a file anyone else
can read, or one another account owns, and says which. `token add` creates it that way.

## Start it

```bash
pi-dispatch-console serve
```

`serve` runs in the foreground and listens on `127.0.0.1:4790`. Open `http://127.0.0.1:4790/` and paste your token.
Only one `serve` runs per deployment: a second one refuses, naming the first one's lock, because two of them would
fork the audit log's chain.

To listen somewhere else, set `PI_CONSOLE_LISTEN`:

| Value | What it does |
|---|---|
| `127.0.0.1:4790` | The default. Loopback only. |
| `[::1]:4790` | IPv6 loopback. |
| `unix:/home/pi/.pi-dispatch/console/console.sock` | A unix socket at mode 0600. The folder must exist, belong to you and be closed to everyone else (`chmod 700`). The path must fit the platform's limit: at most 103 bytes on macOS, 107 on Linux. |
| any other IP literal | Refused, unless `PI_CONSOLE_BIND_PUBLIC=1`. Doctor then warns. |

Hostnames are refused: a name can resolve somewhere you did not mean. The console never terminates TLS. That is the
tunnel's job, below.

**Prefer the unix socket on a shared machine.** A loopback port is open to every account on the host, and, on Docker
Desktop, a job container can reach it through `host.docker.internal`. The console refuses a request whose Host is
that name, which stops a browser or a client that keeps the name it dialled, but a program in the job can send any
Host it likes, so against a job the token is what holds. A socket only you can open removes the path entirely; on
Docker Desktop, use it. It also stops another
account from spending the login rate limit and slowing your own sign-in.

## Keep it running as a service

`serve` stops with its terminal. To keep the console running, install it as a service from the deployment folder:

```bash
pi-dispatch service install --console
```

That is a LaunchAgent on macOS, a `systemctl --user` unit on Linux (`--system` prints the sudo commands instead) and
an nssm service on Windows, like the worker's ([`README.md`](../README.md#run-as-a-service)). The unit runs
`pi-dispatch-console serve --deployment <this folder>`, so it reads this folder's `.env` and tokens file.
`service status --console`, `start`, `stop`, `restart` and `uninstall` take the same flag.

`install` refuses in two cases, before it writes anything:

- the console is not installed where it can find it. Install the admin package where the worker is installed:
  `npm install -g @edgehero/pi-dispatch-admin` beside a global worker, or `npm install @edgehero/pi-dispatch-admin` in
  the folder whose `node_modules` holds the worker. A `pi-dispatch-console` on your PATH is used only when it is that
  package's own file (a pnpm or Volta shim is not), and on Windows the PATH is not searched;
- the tokens file holds no operator token: `serve` would refuse to start, so the service would never run. Add one
  with `pi-dispatch-console token add --name <you> --role operator` first.

When `serve` refuses (exit 2: no operator token, another console holding the lock, an unusable address), the service
stays stopped instead of restarting. Fix the cause, then `pi-dispatch service start --console`.

After a crash the lock (`console-audit/.console.lock` in your logs folder) still names the dead console's pid, and the
next start takes it over. If another process has taken that pid since, every start refuses and names it: when that
pid is not a console, remove the lock file and start the service again.

The service does not load your `.env` into its environment: `serve --deployment` reads the file itself and takes only
the console's own settings from it, so the worker's secrets never reach the console process.

`pi-dispatch doctor` says whether a console service is installed for the deployment and whether the console answers
on its address (one `GET /healthz` to the loopback address or the socket, never anywhere else). An installed service
that does not answer is a failure; no service and nothing running is a warning. `pi-dispatch up` names the install
command once an operator token exists.

## From another machine

Forward a local port over SSH and open it in your browser. To a console on the default TCP port:

```bash
ssh -L 4790:127.0.0.1:4790 host
```

To a console on a unix socket:

```bash
ssh -L 4790:/home/pi/.pi-dispatch/console/console.sock host
```

Then open `http://localhost:4790/` on your own machine. The local port can be anything: the console checks the
hostname your browser sends (`127.0.0.1`, `localhost` or `[::1]`), not the port, so `ssh -L 8080:...` works too.
Any other hostname is refused with 421, which is what defeats DNS rebinding. If you reach the console through a name
of your own, list it in `PI_CONSOLE_ALLOWED_HOSTS`. The container gateway names (`host.docker.internal`,
`host.containers.internal`, `gateway.docker.internal`) can never be listed: the console refuses to start if you try.

Whoever can use the forwarded port on your machine can reach the console's sign-in page. They still need a token.

## Sign in without pasting the token

On the host, as the deployment's account:

```bash
pi-dispatch-console link --name rob
```

It prints a link like `http://127.0.0.1:4790/login/code#<code>`. Open it within 60 seconds (through a tunnel, keep
the path and the part after `#`, and use your tunnel's host and port). The code is not your token: it signs in `rob`
once and is then gone, and it sits after the `#`, which your browser never sends to a server, so it does not land in
a request log or a `Referer`. A small script on the page posts it. The codes are files in `console-login-codes/`
beside the tokens file, a folder only the deployment's account can open.

## Sessions

Signing in sets one cookie, `pdc_session` (`HttpOnly`, `SameSite=Strict`). A session ends:

- after `PI_CONSOLE_IDLE_MINUTES` without a request (default 60);
- `PI_CONSOLE_MAX_HOURS` after sign-in, however busy (default 12);
- when you sign out;
- when its token is revoked or rotated, or its role changes, on the next request;
- for everyone, when you run `pi-dispatch-console sessions end-all`;
- for everyone, when `serve` restarts, because sessions live in the process.

## Managing tokens

| Command | What it does |
|---|---|
| `token add --name <n> --role operator\|viewer` | Creates a token and prints it once. Refuses a name that exists. |
| `token list` | Names, roles and creation dates. Never a token or a hash. |
| `token rotate --name <n>` | A new secret for that name, printed once. Its sessions end. |
| `token revoke --name <n>` | Removes the name. Its sessions end. |
| `sessions end-all` | Ends every session; every token stays valid. |

Each of these except `token list` appends a row to the audit log, with the actor `shell`.

Your pi session's `write` and `edit` tools cannot touch the tokens file: the `/dispatch` extension guards it, so a
prompt injection in the operator's session cannot mint itself a login that way. Its `bash` tool can, which is the
same residual every guarded file has ([`SECURITY.md`](../SECURITY.md)).

## Writes

A write is two steps. The preview shows the change as a diff; the confirm applies it. The confirm carries only a
ticket the preview handed out, which works once, for your session, for 5 minutes, and only for that change: if the
file changed after the preview (the panel, another browser, a hand edit), or a job is no longer as the preview showed
it, the confirm is refused and nothing is written. Preview again. [Actions](#actions) lists every write.

Writes are refused (403) when:

- the console is read-only (`PI_CONSOLE_READ_ONLY=1`), which turns every write off and leaves reads and sign-in on;
- the session is a viewer's;
- the request did not come from the console's own page (another site, or another app on another `localhost` port);
- the content type is not JSON.

Each such refusal is a line in the audit log. A refused request that carried no session is written one line each up
to 60 a minute; past that, refusals are counted and the count is written as one line, so whoever can reach the port
cannot grow the log without bound. A signed-in write whose body is too large (413) or not valid JSON (400) is a line
too, with a fixed reason and nothing of the body; a change the preview refuses as invalid is answered and not
audited, since nothing reached a write.

## The audit log

Every write, every write refused by a guard (as above), every sign-in, failed sign-in, used link and sign-out, every
token change and every `serve` start is a line in `PI_LOGS_DIR/console-audit/YYYY-MM.jsonl`. A line names the token's person and role, a
short digest of the session, the action, which write it was (`kind`, such as `failed-retry` or `trigger-edit`), its
target and its outcome, and for a write the digests of the file before and after. A paid action's line also holds
the reserve it showed (`reserve`, in micro-dollars), and a bulk action writes one line per job, each with the size of
the batch (`count`). It never holds a token, a code, a cookie or what was sent: an answer to a parked run is recorded
by its sha256, never its text.

**Writes from pi are in the same log.** What you change from the `/dispatch` panel, its commands and dialogs, or what
the pi extension's tools change after your confirm, is written to this log too, with the role `panel` and your
account's login name, so one log says what changed whichever surface changed it. The line is written before the
change, and if it cannot be written (a full disk, a logs folder you cannot write) the change is refused with a
sentence saying so. Fix the folder and try again. The one exception is `/dispatch setup`, which builds the deployment
before there is a log to write to.

Each line carries the sha256 of the line before it, so an edit shows:

```bash
pi-dispatch-console audit verify
```

It names the first file and line where the chain breaks. The worker's retention sweep (`PI_LOG_RETENTION_DAYS`)
removes month files past the retention, never the newest one; when it has removed older months, it says where the chain now starts rather than calling that a break. The chain shows an edit;
it does not prevent one, since whoever can write the file can rewrite every line after the one they changed. The rows
`serve` writes are also copied to the Valkey list `console:audit` (the newest 500), best effort; the file is the
record.

## What doctor checks

`pi-dispatch doctor` checks the console only once you have set it up (a tokens file exists, or any `PI_CONSOLE_*` is
set). It then checks:

- the tokens file is a regular file, mode 0600, yours, and holds at least one operator;
- the tokens file is not inside any path a job container can see (a local trigger's `run.folder` or
  `run.skillsDir`, a `PI_DISPATCH_RUN_ROOTS` root, `PI_GLOBAL_PI_DIR`);
- `PI_CONSOLE_LISTEN` is a value `serve` would accept;
- `PI_CONSOLE_BIND_PUBLIC=1` (a warning, every time);
- the audit chain verifies (a warning when it does not).
- whether a console service is installed for this folder (`pi-dispatch service install --console`) and whether the
  console answers on its address: a failure when the service is installed and nothing answers, a warning when there
  is no service and nothing runs.

## The screens

A viewer sees every page except the audit log, never the reason text of a failed job (below), and never a full local
folder path on the insights page (an operator can ask for those with `?paths=full`). The buttons and
forms that change something ([Actions](#actions)) are shown to operators only, and not at all on a read only
console.

| Page | What it shows |
|---|---|
| `/` | The overview: whether the fleet is paused, the queue counts, the hosts online and how long ago each last checked in, today's spend against the caps, how many runs are waiting for an answer (and how many of those are being answered now), and the failures of the last 24 hours. |
| `/runs` | Every run this host and the fleet's run mirror know of, newest first, with filters and paging. |
| `/run?id=<job id>` | One run's record: outcome, reason, tokens and dollars, resources, session, chain, and a link to the issue or pull request on its forge. In a project with a secret bundle, the variable names the run received and from which bundle, the names its trigger's `run.secrets` shadowed and, on an OpenShell venue, how many were placeholders; or why it ran without the bundle. It says whether the record came from this host or from the mirror. Its **Chat** panel, between Progress and Inbox, says what chat the run can have now ([The Chat panel](#the-chat-panel)). For a steer-armed job, its inbox ([Steering a running job](#steering-a-running-job)). For an operator, the run's live transcript below it ([The live transcript](#the-live-transcript)). |
| `/parked` | The runs waiting for an answer, with a link to where the question was asked, its age, how many times the session was resumed, and an **Answer** column: waiting, being answered by a run (linked), or unknown. |
| `/insights?range=30d` | Spend and insights, the deployment's one analytics page ([`insights.md`](insights.md)), for `7d`, `30d` (the default) or `mtd` (month to date): the charts, the budget and its split, job sizes, capacity, plans, the breakdowns and the interactive trigger/flow topology, plus a what-if form (`&whatif=<provider>/<model>&flow=<flow>`) that every role may use, since it only reads. `/dispatch insights` in pi prints this page's URL. |
| `/fleet` | Job counts per queue and state, held waits, each host with its slots, budget, running jobs and the venues it blesses (its default first), each host's last doctor run ([Doctor results](#doctor-results)), every running job, the venues, the schedules with their next and last run and whether one has stalled, and the failed jobs. |
| `/config` | The triggers, the settings overlay, the pause windows, the scoped limits, the projects, the envelope and allocation, the MCP servers, the staged packages, the secret profiles (their names only, never where a secret comes from or its value; those `PI_SECRET_PROFILES` declares are listed beside the overlay's, and a name in both is marked ambiguous; a "Secret profiles in use" table gives each profile's source, where its resolver stands against `PI_SECRET_RESOLVER_ROOTS`, the triggers and projects that use it, the last resolve a run recorded and the live hosts that advertise it, still with no path: [`secrets.md`](secrets.md#from-the-panel)), and the secret bundles: each project bundle in `triggers.json` with its project, its profile and whether this deployment declares it, fork reviews, its endpoint names and hosts, the triggers that opt out and the variable names the newest run received, plus the bundle resolvers by name and format ([`secrets.md`](secrets.md#from-the-panel)). Never a bundle's reference or a value. |
| `/audit` | The console's audit log, newest first. Operator only. A line that is not a valid row is shown as broken in its place, never skipped. |

**The Venues panel** on `/fleet` lists every venue this release knows, and any venue a newer worker blesses that it does
not. For each one: the hosts that bless it and the ones whose default it is, each host's
`PI_BACKEND_FLOOR`, every property the venue declares (the question it answers, its word, and what the word means:
`enforced`, `asserted` or `absent`, with the switch or the check it depends on), what it serves, who holds the job's
credentials, and for the OpenShell venues each host's engine, mode and whether its gateway was on that host when
its worker started. The hosts' parts are what each worker published about itself when it started; the rest is the
release's own table.
Nothing is checked live from the console, so a word is the venue's declared one: `pi-dispatch doctor` on a host says
whether it holds there. A host running a worker older than this console shows "not published". The runs table has a
Venue column, and in pi, `/dispatch` shows the same view: `u` for the hosts, then `v`.

**Links to the forge** come from your deployment's own settings, never from a guess. A GitHub run links to
`github.com`; a GitLab, Forgejo or Azure DevOps run links to the instance URL in your `.env` (`GITLAB_URL`,
`FORGEJO_URL`, `AZURE_ORG_URL`). When that URL is not set, or the run's target does not look like a repository and a
number on that forge, the page shows the target without a link.

**A parked run** is one that ended asking a person a question (see [sessions](sessions.md)). It shows as answered
once a later run on the same issue exists, because an answer is a new delivery on that issue. "The same issue" ignores
the case of the repository path and leading zeros in the number. Until that later run ends it has no record, so the
console also looks in the queue: a park with a run queued or running on its issue is **being answered**, its Answer
column links that run, and it gets no answer form. The console reads the queue for this at most every 15 seconds
while something is parked, up to 10,000 queued and running jobs in all (it reads each job's kind and issue, never its
text). When that look cannot see everything, the column says unknown and the park gets no answer form, as the run
page's Chat panel draws none: a queue too deep to check says so ("answer it on the forge, or wait until the queue is
shorter"), because on such a queue an answer already sent can wait longer than the ten minutes in which a second one
would be dropped as a duplicate. The overview's waiting count leaves out the parks being answered and says how many there
are. The count of resumes
comes from the session store, so the console can read it only when `PI_SESSIONS_DIR` is on its own host; anywhere
else, and for a pull request (whose session the record cannot name), it shows as unknown rather than as 0.
An operator can answer an issue's parked run from this page ([Answering a parked run](#answering-a-parked-run)).

**A failed job's reason** (BullMQ's message for the attempt that failed) is the one free text the screens show. It
is the worker's own message, trimmed and cleaned, but it can still carry a fragment of something a job touched, so
only the operator role sees it, on the fleet page, in a "Why each failed" element below the failed jobs that you
open per job, never in a list row.

### Doctor results

Every `pi-dispatch doctor` run publishes what it found to the deployment's Valkey, one result per host, and each
worker runs doctor itself a minute after it starts and then every `PI_DOCTOR_INTERVAL_HOURS` (24 by default; `0`
turns the worker's own runs off). The fleet page's **Doctor** panel shows each host's last result: how long ago it
ran, how many checks failed, warned and passed, and every failing and warning check with its fix, failing first. A
result older than two of that host's doctor intervals is marked stale. A live host that has published nothing is
named, so a host nobody checked never looks healthy.

What a result holds is doctor's own sentences with the private parts cut out before they leave the host: a path
becomes `<path>`, a URL keeps only its scheme and host, the value of every variable named like a secret (a token, a
key, a password) and every known token shape becomes `[redacted]`, and the file text a JSON parse error quotes becomes
`<content>`. A secret held under a name that does not look like one, with no known shape, is not recognised, so do not
rely on this to hide one. A passing check is published as its name only. A result is kept for 7 days after its last run. Both roles see
it.

When a file on the configuration page does not load (the triggers, the pause windows, the scoped limits, the projects
or the settings overlay), the sentence quotes the newest published doctor check about that file and names the host
and how long ago it ran. Without one it still says to run `pi-dispatch doctor` for the reason. Run
`pi-dispatch doctor --no-publish` to check a host without publishing. The `/dispatch` panel shows the same lines in
its hosts view (`u`).

### Run progress

Every running job shows where it is. The overview's and the fleet page's running jobs have a Progress column: the
turn, the steps done and failed, the tool running now and for how long, and the phase (2 of 4) when the job reports
phases. The run page has a Progress panel at the top: the same counters, the tools running, the last steps with how
long each took, and the phase as numbers ("Phase 2 of 4: 3 of 10 done"). An operator also sees the phase names the
agent gave, a bar for the current phase and the note the agent gave with its latest report (a report without a note
clears it); a viewer sees the numbers and the tool names only. A finished run shows the summary its run record
keeps: the turns and steps, the "Sum of step durations" (steps the agent ran side by side overlap, so this can be
longer than the run), the longest step and the "Longest interrupted step" (a step still
running when the run ended, such as a command that hung until the job timeout). A job that resumed a session shows
what the earlier runs did as "Earlier runs of this session". A job with nothing yet says "No live progress: not published
(PI_RUN_PROGRESS=0), expired, or no step has been recorded yet." The panel updates itself about every 2 seconds, so a
run page is now a live page: with the live transcript open, an operator's run tab holds two of your token's
live-page slots.

- **The counts are automatic.** They need no trigger change and no new job image: the worker reads them from the
  job's transcript.
- **Phases are opt in.** A trigger with `"progress": true` gives its jobs a `report_progress` tool, and the agent
  names its phases with it ([triggers](triggers.md#optional-run-fields)).
- **It is advisory.** The agent can write its own transcript, so a phase or a count can be wrong on purpose. Nothing
  decides anything from it.
- **Phase names and notes are the agent's words.** They are redacted like the transcript and shown to operators
  only, and never in a list, in `/api/state` or in the run record, which keeps numbers only.
- **Where it comes from**: each worker writes one small Valkey key per running job, kept 24 hours after the run
  ends. `PI_RUN_PROGRESS=0` on a worker stops it.
- **A stale job says so.** The worker rewrites a running job's key at least every 30 seconds. When it has not changed
  for 3 minutes the worker has probably stopped (a crash, a kill, a lost Valkey): the run page says "Stale: no update
  for 4 min; the worker may be gone.", the Progress column ends with "no update for 4 min; the worker may be gone",
  and the running ages stop counting.
- **A retried job.** A retry keeps the job's id. While the next attempt runs, the run page shows it live under "An
  earlier attempt of this run ended (failed); this is the attempt after it." A running job's row never shows the
  final numbers of the attempt before it.
- **A recovered run** (`run.recover`). A recovery has its own job id (`<run>.r1`), so it is not a retry: its page
  shows the run's live progress, and the page of the attempt it continues shows that attempt's own numbers with
  "This run continues as" and a link to the recovery job.

The `/dispatch` panel's running rows show the same, with the phase name clipped.

### The live transcript

An operator's run page shows what the run is doing: what the agent said, each tool it called with its arguments,
and what the tool returned, as the run goes. It works for a run on any host, because each worker publishes its
running jobs' transcripts to Valkey, and for 24 hours after the run ends. New entries appear about a second after
the agent writes them; the view follows the bottom unless you scroll up, and says whether the run is live or ended,
and how it ended. Tool calls and their results are folded; open one to read it. A viewer sees "Transcripts are shown
to operators only." A run with no transcript says "No live transcript: not published (PI_LIVE_TRANSCRIPTS=0), expired,
or not started yet."

- **Operators only.** A viewer sees a sentence saying transcripts are shown to operators, and nothing of the text.
- **It is the transcript, not the raw log.** The model's thinking is not shown, and a job's `.log`
  (`PI_CAPTURE_JOB_LOGS`) still stays on its host and is shown by no page.
- **Secrets are taken out before it leaves the worker**: the job's own tokens and keys, and anything shaped like a
  known token, read `[redacted]`. A secret the agent re-encoded is not caught, and issue text and tool output are
  shown on purpose ([`SECURITY.md`](../SECURITY.md)).
- **Long runs are trimmed**: Valkey keeps the last 2,000 entries of a run, and a long message or tool result is cut
  and marked.
- **No transcript** means one of: the worker has `PI_LIVE_TRANSCRIPTS=0`, the run has not started writing yet, or
  its transcript expired (24 hours after the end, or 7 days after the start if its worker died). The page cannot
  tell these apart and says so. Two more causes are said when they apply. A run whose record names why it had none
  (`liveSkipped`) gets that reason instead: its venue copies the job's files and does not stream the transcript back,
  its job image lacks `transcriptStderr`, or the image declares no `exitAuth`. And a run on a venue that does not
  always stream (the `openshell` copy mode, which needs an image with that capability), or a running job whose venue
  the page cannot name yet, adds "or its venue or job image does not stream it". The Progress panel follows the same
  rule, since progress is read from the live transcript. The run's own page also shows a "Steering" row when a
  steer-armed run took no message, and a "Live transcript" row when it had none, each with the reason.
- **An OpenShell run's sandbox.** A run on `openshell` or `openshell-bind` shows a "Sandbox policy" row (copy or bind
  mode, how many credential providers the sandbox was given and how many placeholders they bound) and a "Rule hosts"
  row (the hosts its network policy admitted, from your allowlist, model endpoints and the forge; up to 32 listed, the
  rest counted). A run that armed `run.secrets` shows a "Secrets profile" row with the profile's name. The `/dispatch`
  panel's run detail has the same lines. Whether an MCP server connected is not recorded on any venue, so no row says it.
- The transcript holds one of your token's live-page slots while it is open, like any live page.

The `/dispatch` panel's live tail (`l`) reads the same transcript.

## Finding runs

The runs page takes these filters in its query string. Each one is matched exactly, except `q`:

| Filter | Matches the run's |
|---|---|
| `repo` | repository, such as `acme/web` |
| `kind` | forge: `github`, `gitlab`, `forgejo`, `azure`, or `local` |
| `flow` | flow name |
| `trigger` | trigger: its position in the triggers file, or a schedule's id |
| `project` | project id |
| `host` | worker name |
| `backend` | venue, as the Venues panel on `/fleet` names it (a run recorded before venues were recorded counts as `local`) |
| `outcome` | outcome: `completed`, `policy` or `failed` |
| `reason` | reason, such as `awaiting-input` or `over-budget` |
| `model` | model id |
| `q` | target, any part of it, ignoring case (`web#12`) |

For example, `/runs?kind=gitlab&outcome=failed` or `/runs?q=web%2312` (a `#` in a query is written `%23`). A value
is checked against the characters that field can hold and refused by name if it does not fit; the page never repeats
the refused value back.

**Paging** goes by time, not by position. The "older" link carries `before`, the moment of the last run on the page,
so runs that finish while you page do not shift anything or show a run twice. A page holds up to 50 runs. To keep a filter that matches almost nothing from reading the whole history in one request, one page
examines at most 2000 runs; when it stops there it says so, and its "older" link carries on from where it stopped.

The runs come from two places, merged as the panel merges them: this host's run records, and the fleet's run mirror
in Valkey, which holds every host's recent runs (see [multi-host](multi-host.md)). When the mirror cannot be reached,
the page shows this host's runs and says so. Reading the pages never changes the mirror.

## Actions

Operators can change the deployment from the pages that show it. Every action is the same two steps as any write
([Writes](#writes)): **Preview** shows exactly what will happen (a diff for a file, the list of jobs for a job
action) and **Confirm** does it. Nothing happens on a preview. If something changed in between, the confirm is
refused with "changed since the preview" and nothing is done; preview again and you see the new state. Every action
goes through the same functions as the `/dispatch` panel and the pi extension's tools, so a value the panel refuses
is refused here with the same words, and every action lands in the [audit log](#the-audit-log).

| Where | Action | What it does |
|---|---|---|
| Fleet | Cancel | Stops a running job on whichever host runs it, or removes a held one. A running job that no worker acknowledges is reported as not cancelled, never as done. |
| Fleet | Retry | Puts a failed job back in the queue. The worker runs it again from the start, through every budget check, so it can cost money. |
| Fleet | Remove | Deletes a failed job from the queue. Its run record stays. |
| Fleet | Pause, Resume | The whole fleet, as `p` and `r` do in the panel, or one queue. A fleet resume is refused while the console's environment and the deployment's `.env` name different Valkeys, as in the panel and the tools. |
| Fleet | Retry all, Remove all, Cancel all held | The bulk actions (below). |
| Parked | Answer | Sends your answer to a run that is waiting on an issue ([below](#answering-a-parked-run)). Costs money. |
| Run | Re-run | Runs the same thing again ([below](#re-running-a-run)). Costs money. |
| Run | Steer, Follow-up, Withdraw | Sends a message to a running, steer-armed job, or takes one back ([below](#steering-a-running-job)). Spends from the run's own reservation. |
| Run | Sandbox | Shows the command that opens the run's sandbox on the host ([below](#opening-a-sandbox)). |
| Configuration | Edit | Triggers, settings, pause windows, scoped limits, projects, the envelope, priorities, reverting the budget split, secret profile names, and bundle resolvers (a name, a path and a format). |

**Paid actions show what they reserve.** A re-run, an answer and a retry start a paid job, so their preview shows what the
worker will hold for it before it runs: one job from the job count, and in dollars the per-job cap (the trigger's
`maxCostUsd` or the deployment's, whichever is smaller), $0 for a job that can only call free local models, or "no
cap" when neither is set. It is the worker's own rule, so the figure is what the worker will hold, and the worker
still checks every cap when it picks the job up: a job the budget does not admit is refused then, as any job is. A
bulk retry shows each job's reserve and the sum, and "reserve unknown" for a job whose data cannot be read, never $0.
Resuming the fleet or a queue shows how many jobs are waiting to start, each of which reserves up to its own cap. A
message to a running job is paid too, but reserves nothing new: it spends from what its run already holds, and the
run's turn, dollar and token caps still bind, so its preview says so instead of showing a figure.

**Configuration edits** change the same files the panel writes (`triggers.json`, the settings overlay, the money
files) and nothing else. Nothing is committed to git: if you keep the deployment folder in git, commit the change
yourself. A secret profile is a name and the path of its resolver script, and a bundle resolver also says the format its script
prints; the console never asks for or shows a secret's value, nor a bundle's reference. A project edit refused because
a secret bundle names the project shows that refusal in the form, and nothing is written. If another session (the panel, a tool, a hand edit) wrote the file after your preview, the confirm is
refused and the file is left as it is.

### Bulk actions

Retry all failed jobs, remove all failed jobs (optionally only one queue or one repository), and cancel all held
jobs. The preview lists every job the action will touch, at most 100; when more match, it says how many more, and
you run it again for the rest. The confirm acts on exactly that list and re-checks each job: a job that was retried,
removed or failed again since the preview is skipped and reported, and the others go ahead. The answer lists what
happened to each job, and the audit log has one line per job. A bulk retry can start up to 100 paid jobs from one
confirm, each still held to every cap.

### Answering a parked run

On the parked page, an operator can type an answer under a run that is waiting on an issue and send it. The console
does not comment on the issue itself: it queues the same job a reply on the issue would have queued, through your
comment trigger, with your answer as the reply text. The run resumes from where it stopped, and reads your answer as
data, exactly as it reads a comment.

What the issue shows: once the worker has checked that the issue really is waiting, and before anything is spent, it
posts one comment as the deployment:

> Answered from the operator console by rob:
>
> > your answer, quoted

The name is your token's name. An answer from pi's [`/dispatch chat`](chat.md#in-pi-dispatch-chat) reads "Answered
from an operator's /dispatch panel" instead, so a token named `panel` is refused here: give it another name. Any
`@name` in your answer is changed so it does not notify anyone. That comment is
the record of what the agent was told, for anyone who reads the issue later.

An answer is at most 8 KiB of text; control characters are removed, and an empty answer or a longer one is refused,
never cut. The console refuses, before queueing anything, a run that is not waiting any more (answered already, or a
later run on the same issue), a run being answered right now (an answer or another run on the same issue is queued or
running), a run for which that could not be told (the queue could not be read, try again; or it holds more than
10,000 queued and running jobs, answer on the forge or wait), a run that parked on
a pull request (answer it on the forge, with your trigger phrase),
a run whose queue data has expired (31 days), and a deployment whose comment trigger would not route a reply (none for
that forge, a command, or no `run.resume`). The audit log records the run and a hash of your answer, never the text.
Answering needs a worker of the same release as the console: an older worker runs the answer but posts no comment.

### Re-running a run

Re-run on a run's page queues the same work again:

- **A local run** (from `/dispatch run` or `pi-dispatch run`) runs its folder, flow and task again on this host,
  refused when the folder has uncommitted changes, as `/dispatch run` refuses. Its queue data is kept a day after it
  completes and a week after it fails.
- **A scheduled run** fires its trigger once, as the triggers file says now, like `pi-dispatch run --trigger <id>`.
- **A forge run** runs again on the same issue as a new delivery, so it gets a new job id, on the queue the receiver
  would choose. Its issue and the trigger it matched come from its queue data (kept 31 days), but what the run may do
  (flow, model, cost cap, secret profile, image, backend) comes from that trigger as the triggers file says now, and
  the preview lists it. If the trigger was deleted, changed kind, stopped matching that label or action, or runs
  another flow, the re-run is refused: start it again from the forge.

A run whose data has expired, a `/command` run, and an answer to a parked run (answer the parked run again instead)
are refused by name. The same issue and flow run or queued within the last 10 minutes take a forge re-run as a
duplicate, and a local or scheduled re-run within the same minute likewise; the console says so and nothing is
queued.

### Steering a running job

The page of a running job whose trigger has `steer` has an **Inbox** panel: the messages sent to the run (id, steer
or follow-up, where it came from, state, when, size), never their text, for both roles. An operator also gets a
**Steer** and a **Follow-up** form while the job is running and its run takes messages, and a **Withdraw** button on
each message that is still queued or written. The preview shows your message as the run will get it and says that it
spends from the run's existing reservation; Confirm sends it, signed with your token's name. The console refuses,
before sending, what `pi-dispatch steer` refuses (the job is not running, the run takes no messages, the text is empty
or above 8 KiB), and a confirm after the run finished is refused with nothing sent. A withdraw is guaranteed for a
queued message and best effort for a written one, and its preview says which. The audit log records the job, the
message id and a hash of the message, never the text. In the `/dispatch` panel the same is `t` (steer) and `T` (follow-up) on the
ACTIVE row, offered only while the run's inbox takes a message (a steer-armed run whose loop has not started, has
ended, or whose venue or image cannot deliver says so instead). All of it is in [`steering.md`](steering.md#from-the-console-and-the-panel).

### The Chat panel

A run's page has a **Chat** panel, between Progress and Inbox, that says what the run is (running, queued, parked,
answered by a later run, being answered, finished or unknown) and offers the chat it can have now, by the same rule
`pi-dispatch chat` uses ([`chat.md`](chat.md)):

- **A running run** (or one going on as a [recovery](durable-runs.md) job, which the panel links): a link to its live
  transcript, and the **Steer** and **Follow-up** forms while the run takes messages. The forms then move here from
  the Inbox panel, so the page never holds two of either; the Inbox panel keeps the list and the Withdraw buttons.
  A run that is not steer-armed, or whose inbox is closed, says so instead, and when the run's inbox could not be
  read at all the panel warns that it cannot tell (rather than saying "not steer-armed").
- **A parked run**: the answer form, the very one the parked page draws ([Answering a parked run](#answering-a-parked-run)),
  and a pointer to the question. The form is drawn only where the console would accept the answer: for a pull
  request's park, job data that has expired, or a comment trigger that would not route a reply, the panel shows the
  sentence the console would refuse with instead of the form (and no terminal command). When that check could not be
  read, the form stays and the panel says the preview will check again.
- **A finished run**: the command `pi-dispatch chat <job id>`, to copy and run on the host that keeps the session
  store, which opens the run's stored conversation in your own pi as a fork. When the run's trigger kept no session,
  or the run was a pull request (whose session the record cannot name), the panel says why instead.
- **Queued, unknown, answered or being answered**: one sentence saying why there is nothing to chat with. A park
  being answered links the run taking the answer, and a run whose [recovery](durable-runs.md) job is queued links
  that job.

The running and parked modes show `pi-dispatch chat <job id>` too, which opens the same chat in a terminal. A viewer sees the run's
state only, never a form or a command, and a read-only console draws no form for anyone. When the queue cannot be
read the panel says so rather than guess.

### Opening a sandbox

A run's page shows the command that reopens its sandbox, `pi-dispatch sandbox <job id>`, to copy and run in a shell on
the host that ran the job. Only for a run whose venue has a sandbox shell (`local` and `podman`): an `openshell` run says "Its workspace is not
reopenable (openshell has no sandbox shell)" instead, and an `openshell-bind` run "Its workspace is not reopenable
(openshell-bind has no sandbox shell)", the words the panel's sandbox pane uses. The console never opens a shell or starts a container itself: a terminal in the browser
would put an interactive shell one stolen session away from anyone.

## Live updates

The overview, runs, parked, fleet and run pages update themselves while open; the run page reads its data about
every 2 seconds, for its progress ([Run progress](#run-progress)), and its live transcript streams on its own
([The live transcript](#the-live-transcript)). Insights, configuration and the audit log are drawn once per load;
reload them to refresh. A small marker in the corner says `live`, or `reconnecting` while the
browser reconnects. The console reads Valkey once a second for every open page together, and only while a page is
open, so ten open tabs cost the deployment what one does; the runs page, whose filters make each view its own read,
refreshes every 5 seconds. Only the parts of the page that changed are sent.

A live page holds one connection open. Each token may hold `PI_CONSOLE_MAX_STREAMS` of them (default 4) across all
its sign-ins, and the console 32 in all, of which 8 are kept for operators. A page opened past either limit still loads, but stays still until you reload it after closing
another tab; its marker then says `not live`.

**An open page does not keep you signed in.** Only a page load or a request counts as activity. A page left open
signs out after `PI_CONSOLE_IDLE_MINUTES`, and its updates stop and send you to the sign-in page when:

- you sign out, in this tab or another (at once);
- your token is revoked or rotated, or its role changes;
- someone runs `pi-dispatch-console sessions end-all`;
- the session passes the idle limit or `PI_CONSOLE_MAX_HOURS`.

All but sign-out take effect within a second, with no request needed. A browser that falls far behind (2 MiB of
updates it has not read) is cut off and reconnects to a fresh copy of the page.

## The state API

`GET /api/state` returns the deployment's live snapshot as JSON, so a script never has to read a page. It needs a
session like every page; both roles may read it, and a viewer's copy leaves out the failed jobs' reasons. The fields
are described in `INT-CONSOLE-STATE-API` ([`specs/interfaces.md`](../specs/interfaces.md)): within its `version`,
fields are only ever added. Each running job in `active` carries a `progress` object of numbers and the running
tool's name (never a phase name or note), or null when it has none, and `steer` (whether its trigger arms steering)
with `inbox`, that job's messages as `{id, mode, source, state, at, bytes}` and never their text (null when the job is
not steer-armed or its inbox could not be read). A part the console could not read is marked with a boolean (`fleetDegraded`,
`parkedUnknown`, `unreachable`), never with the error, and when Valkey cannot be read at all the answer is `503` with
a short `error` sentence.

Sign in once with a token and keep the session in a cookie file. Never put the token on a command line, where the
process list and your shell history can see it: read it into a variable and send it on standard input instead. The
console checks that a sign-in comes from its own origin, so the request names it.

```bash
umask 077   # the cookie file holds a live session
read -rs PDC_TOKEN   # paste the token; nothing is shown
printf '{"token":"%s"}' "$PDC_TOKEN" | curl -sS -c ~/.pdc-cookies \
  -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:4790' \
  --data-binary @- http://127.0.0.1:4790/login
unset PDC_TOKEN

curl -sS -b ~/.pdc-cookies http://127.0.0.1:4790/api/state
```

`printf` is built into the shell, so the token never becomes a process argument. On a unix socket, add
`--unix-socket /path/to/console.sock` to both commands and keep the `http://127.0.0.1:4790` part as written (the
console checks the hostname in it, not the address). The session ends like any other: after
`PI_CONSOLE_IDLE_MINUTES` without a request, or when you sign out:

```bash
curl -sS -b ~/.pdc-cookies -X POST -H 'Content-Type: application/json' \
  -H 'Origin: http://127.0.0.1:4790' --data '{}' http://127.0.0.1:4790/logout
rm ~/.pdc-cookies
```

Each parked run in `parked` carries its `jobId` as well, so a script can open it or answer it without a second
lookup. Whether a park is being answered is not in `/api/state`; `/api/run` says it per run (`pendingRunOnTarget`).

`GET /api/run?id=<job id>` (or `?url=<issue or pull request link>`, which finds the newest run on that target) returns
one run and the chat it can have now: its state, `mode` (`live`, `reply`, `fork`, or null with a fixed `says`
sentence), the running job it goes on as, whether it takes messages, whether a live transcript exists, its progress
numbers, its forge link, whether a newer run on its target exists, and for a parked run the job queued or running on
its target that takes its answer (`pendingRunOnTarget`). `steer.armed` is null when the run's inbox could not be read
(unknown, not "off"). A link finds the same run whatever the case of the repository path or leading zeros in the
number, among the newest 2000 runs it searches. Both roles may read it: it carries ids, fixed
words, times and numbers only, never a record's free text, a job's data, transcript text or a session key. This is what
`pi-dispatch chat` asks. The fields are `INT-CONSOLE-STATE-API`'s.

Without a session, `/api/state` answers 401 with a JSON error, never a redirect to the sign-in page. Give a script
its own token, named after the script, with the `viewer` role, so the audit log names it and a revoke ends only its
access.

## Parked runs in pi

The `/dispatch` panel in pi shows the same parked runs: press `k` in the list to open the PARKED
view, with each run's target, forge, age and resume count (`?` when this host cannot see the session store). Enter
opens the run's detail. The panel and the console read the deployment
through the same code, so the two never disagree about what is waiting.

## Reference

| Setting | Default | What it does |
|---|---|---|
| `PI_CONSOLE_LISTEN` | `127.0.0.1:4790` | Where `serve` listens: `127.0.0.1:<port>`, `[::1]:<port>` or `unix:/abs/path`. |
| `PI_CONSOLE_TOKENS_FILE` | `console-tokens.json` | The tokens file, relative to the deployment folder. |
| `PI_CONSOLE_ALLOWED_HOSTS` | none | Extra hostnames the console answers to, comma separated. |
| `PI_CONSOLE_READ_ONLY` | off | `1` refuses every write. |
| `PI_CONSOLE_BIND_PUBLIC` | off | `1` allows a non-loopback IP literal in `PI_CONSOLE_LISTEN`. |
| `PI_CONSOLE_IDLE_MINUTES` | 60 | Idle limit of a session, 5 to 1440. |
| `PI_CONSOLE_MAX_HOURS` | 12 | Absolute limit of a session, 1 to 168. |
| `PI_CONSOLE_MAX_STREAMS` | 4 | Live pages one token may hold open across its sign-ins, 1 to 32. The whole console holds at most 32, 8 of them kept for operators. |

The console also reads, from the same deployment, `VALKEY_URL` (the queues, hosts and run mirror), `PI_LOGS_DIR`
(this host's run records and the audit log), `PI_PAUSE_WINDOWS_FILE`, the files the configuration page shows and
edits (the triggers, settings, scoped limits, projects and envelope), `PI_SESSIONS_DIR` when it is on this host (the
parked runs' resume counts) and `GITLAB_URL`, `FORGEJO_URL` and `AZURE_ORG_URL` (the forge links). The live
transcripts and the run progress come from Valkey; whether a worker publishes them is that worker's
`PI_LIVE_TRANSCRIPTS` and `PI_RUN_PROGRESS`.

`pi-dispatch chat`, the terminal client, reads two more variables, from your own shell only and never from the
deployment's `.env`: `PI_CONSOLE_TOKEN` (your token, else it asks) and `PI_CONSOLE_URL` (which console to dial, else
`PI_CONSOLE_LISTEN`). See [`chat.md`](chat.md#reference).

The design and its rejected alternatives are `DES-OPERATOR-CONSOLE` in [`specs/design.md`](../specs/design.md); the
testable rules are `REQ-CONSOLE-SECURITY`, `REQ-OPERATOR-CONSOLE-SCREENS`, `REQ-OPERATOR-CONSOLE-ACTIONS`,
`REQ-LIVE-TRANSCRIPT` and `REQ-RUN-PROGRESS` in [`specs/requirements.md`](../specs/requirements.md); the threat model and
what it does not defend are in [`SECURITY.md`](../SECURITY.md#the-operator-console).
