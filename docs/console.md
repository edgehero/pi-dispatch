# The operator console

A web page for managing the deployment, served by a process of its own, `pi-dispatch-console`. It sits beside the
`/dispatch` panel in pi, not in place of it: both read the same files and the same Valkey, and both write through the
same validated functions, so neither can do anything the other would refuse.

It shows the whole deployment, live: what is running and queued on every host, every run with filters, the runs
waiting for an answer, spend and insights for a range of days, the schedules, the configuration and the console's own
audit log. Open pages update themselves about once a second while you watch, and `/api/state` gives a script the same
snapshot as JSON. It has one write so far, the [pause windows](pause-windows.md), with a preview and a confirm; the
other writes (answering a parked run, retrying a failed job, editing the configuration) arrive with issue #642, and
live logs and transcripts with #643.

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
file changed after the preview (the panel, another browser, a hand edit), the confirm is refused and nothing is
written. Preview again.

Writes are refused (403) when:

- the console is read-only (`PI_CONSOLE_READ_ONLY=1`), which turns every write off and leaves reads and sign-in on;
- the session is a viewer's;
- the request did not come from the console's own page (another site, or another app on another `localhost` port);
- the content type is not JSON.

Each such refusal is a line in the audit log. A refused request that carried no session is written one line each up
to 60 a minute; past that, refusals are counted and the count is written as one line, so whoever can reach the port
cannot grow the log without bound. A body too large (413) or not valid JSON (400), and a change the preview refuses
as invalid, are answered and not audited: nothing reached a write.

## The audit log

Every write, every write refused by a guard (as above), every sign-in, failed sign-in, used link and sign-out, every
token change and every `serve` start is a line in `PI_LOGS_DIR/console-audit/YYYY-MM.jsonl`. A line names the token's person and role, a
short digest of the session, the action, its target and its outcome, and for a write the digests of the file before
and after. It never holds a token, a code, a cookie or what was sent.

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

## The screens

Every page is read only. A viewer sees every page except the audit log, and never the reason text of a failed job
(below).

| Page | What it shows |
|---|---|
| `/` | The overview: whether the fleet is paused, the queue counts, the hosts online and how long ago each last checked in, today's spend against the caps, how many runs are waiting for an answer, and the failures of the last 24 hours. |
| `/runs` | Every run this host and the fleet's run mirror know of, newest first, with filters and paging. |
| `/run?id=<job id>` | One run's record: outcome, reason, tokens and dollars, resources, session, chain, and a link to the issue or pull request on its forge. It says whether the record came from this host or from the mirror. |
| `/parked` | The runs waiting for an answer, with a link to where the question was asked, its age, and how many times the session was resumed. |
| `/insights?range=7d` | Spend and insights, the same sections as `/dispatch insights` draws into `insights.html`, for `7d`, `30d` or `mtd` (month to date). |
| `/fleet` | Job counts per queue and state, held waits, each host with its slots, budget and running jobs, every running job, the schedules with their next and last run and whether one has stalled, and the failed jobs. |
| `/config` | The triggers, the settings overlay, the pause windows, the scoped limits, the projects, the envelope and allocation, the MCP servers, the staged packages and the secret profiles (their names only, never where a secret comes from or its value). |
| `/audit` | The console's audit log, newest first. Operator only. A line that is not a valid row is shown as broken in its place, never skipped. |

**Links to the forge** come from your deployment's own settings, never from a guess. A GitHub run links to
`github.com`; a GitLab, Forgejo or Azure DevOps run links to the instance URL in your `.env` (`GITLAB_URL`,
`FORGEJO_URL`, `AZURE_ORG_URL`). When that URL is not set, or the run's target does not look like a repository and a
number on that forge, the page shows the target without a link.

**A parked run** is one that ended asking a person a question (see [sessions](sessions.md)). It shows as answered
once a later run on the same issue exists, because an answer is a new delivery on that issue. The count of resumes
comes from the session store, so the console can read it only when `PI_SESSIONS_DIR` is on its own host; anywhere
else, and for a pull request (whose session the record cannot name), it shows as unknown rather than as 0.
Answering from the console arrives with #642: until then, answer on the forge.

**A failed job's reason** (BullMQ's message for the attempt that failed) is the one free text the screens show. It
is the worker's own message, trimmed and cleaned, but it can still carry a fragment of something a job touched, so
only the operator role sees it, on the fleet page, in a "Why each failed" element below the failed jobs that you
open per job, never in a list row.

No page shows a job's log or transcript yet. Those stay on the host that ran the job, and how the console will show
them is decided with #643.

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

## Live updates

The overview, runs, parked and fleet pages update themselves while open. Run detail, insights, configuration and
the audit log are drawn once per load; reload them to refresh. A small marker in the corner says `live`, or `reconnecting` while the
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
fields are only ever added. A part the console could not read is marked with a boolean (`fleetDegraded`,
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
(this host's run records and the audit log), `PI_PAUSE_WINDOWS_FILE` (the one write), the files the configuration page
shows (the triggers, settings, scoped limits, projects and envelope), `PI_SESSIONS_DIR` when it is on this host (the
parked runs' resume counts) and `GITLAB_URL`, `FORGEJO_URL` and `AZURE_ORG_URL` (the forge links).

The design and its rejected alternatives are `DES-OPERATOR-CONSOLE` in [`specs/design.md`](../specs/design.md); the
testable rules are `REQ-CONSOLE-SECURITY` and `REQ-OPERATOR-CONSOLE-SCREENS` in [`specs/requirements.md`](../specs/requirements.md); the threat model and
what it does not defend are in [`SECURITY.md`](../SECURITY.md#the-operator-console).
