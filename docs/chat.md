# Terminal chat

A run's conversation is usually something you read on its run page in the operator console. `pi-dispatch chat`
opens it in a terminal instead, and lets you talk to it (in pi, [`/dispatch chat`](#in-pi-dispatch-chat) does the same):

```bash
pi-dispatch chat 1234                                   # a run, by its job id
pi-dispatch chat https://github.com/o/r/issues/7        # the newest run on an issue or pull request
pi-dispatch chat 0123456789abcdef0123456789abcdef       # a stored session, by its key
```

What happens depends on the run, and the console decides, by the same rule its run page's Chat panel uses:

| The run is | `chat` |
|---|---|
| running (or going on as a [recovery](durable-runs.md) job) | follows its live transcript; you can steer it |
| parked, waiting for an answer | shows its question; you can answer it |
| finished | opens its stored conversation in **your own pi**, as a fork, on the host that keeps the sessions |
| queued (or its recovery job is queued and has not started) | says so in a sentence and exits 1 |
| parked, and already answered by a later run, or being answered right now (a run on its issue is queued or running) | says so in a sentence and exits 1; open that run's chat instead |
| unknown, or a park whose answer cannot be told right now (also when the queue is too deep to check; answer it on the forge) | says so in a sentence and exits 1 |

A park that is being answered is one whose answer was already sent: the run that resumes it has no record until it
ends, so the console looks for it in the queue. The console's run lookup names that run (`pendingRunOnTarget`), and
the run page's Chat panel links it; `chat` prints the console's sentence. "The same issue" ignores the case of the
repository path and leading zeros in the number, so `https://github.com/Acme/Web/issues/007` finds the runs on
`acme/web#7`.

A session key (32 lowercase hex characters) always opens the fork, on this host, without asking the console. `--fork`
forces the fork for a run.

The argument is read by its shape alone: 32 lowercase hex is a session key, an `http://` or `https://` link is an
issue or pull request, anything else in the job id charset (letters, digits and `. _ : -`) is a job id.

## What it needs

**The console.** The live and reply modes, and the lookup of a run by its id or link, go through the operator
console's HTTP API, the same way a browser does: a token sign-in, the session cookie held in memory for the life of
the command and never written anywhere, the console's own run lookup (`GET /api/run`) and its own actions. A terminal
on another machine needs nothing but the SSH tunnel the browser would use ([console.md](console.md#from-another-machine));
it never talks to Valkey or reads the session folder.

- **Which console.** `--console <addr>`, else `PI_CONSOLE_URL` in your shell, else the deployment's
  `PI_CONSOLE_LISTEN` (your shell's, else the `.env` of the folder you run this in; the two must agree), else
  `127.0.0.1:4790`. An address is `host:port`, `http://host:port` or `unix:/abs/path` (the console's unix socket). The
  console speaks plain http, so an `https:` address is refused: through a tunnel, give the tunnel's local end
  (`--console localhost:8080`). A wildcard listen (`0.0.0.0`, `[::]`) is dialled on its loopback address.
  `PI_CONSOLE_LISTEN` from the deployment (your shell or the folder's `.env`) is only used when it is loopback
  (`127.x.x.x`, `::1`, `localhost`, a wildcard) or a unix socket, since the `.env` of a folder you happen to stand in
  must not send your token elsewhere; name any other console with `--console` or `PI_CONSOLE_URL`. A value from the
  folder's `.env` (your shell sets none) is used only when that file is yours (or root's), is not a symbolic link, and
  neither it nor a folder above it can be written by a group or another account, the rule the panel reads a `.env`
  by: another account on this machine could otherwise listen on a loopback port and collect the token. Otherwise
  `chat` refuses and names `--console` and `PI_CONSOLE_URL`.
- **A console on another machine.** Before signing in to an address that is not on this machine, `chat` warns that
  the token travels over plain HTTP to that host, readable to anything on the path, and asks `y/N` (the default is
  no). `--yes` answers that question for a script; the warning still prints. Prefer a tunnel, which keeps the token on
  loopback: `ssh -L 4790:127.0.0.1:4790 <host>` and `--console 127.0.0.1:4790`.
- **Which token.** `PI_CONSOLE_TOKEN` in your shell, else a hidden prompt (in a terminal only; without one, `chat`
  refuses). It is never read from the deployment's `.env`: that file is the service's, and a console token is yours.
  Make one with `pi-dispatch-console token add --name <you> --role operator`
  ([console.md](console.md#create-the-first-token)).
- **The role.** An operator token can watch, steer and answer. A viewer token sees the status line only, as on the run
  page: transcripts and messages are an operator's.

The token, the cookie and what you type are never printed to standard output or standard error and never logged. The
one place your message appears is the preview on the screen before you confirm it.

If the console drops the connection, `chat` reconnects on its own, waiting 500 ms and doubling up to 30 seconds, and
gives up after 8 failures in a row. A stream that sends nothing for 45 seconds (three of the console's pings) is
treated as dropped and resumed. A console that ends the sign-in (an expired session, a revoked or rotated token) is
signed in to again, at most once a minute; a second end within a minute of a fresh sign-in is the end of the command.
A refusal or status the console sends is always printed on one line, and refusals go to standard error.

## Live: watch and steer a running job

The screen shows the transcript as the run writes it (the agent's text as markdown, everything else as plain text,
tool calls and results folded to eight lines), a status line asked for again every 5 seconds, and a message box.

| Key or input | What it does |
|---|---|
| Enter | sends the message as a **steer**: the agent reads it after its current tool calls |
| `/later <text>` | sends a **follow-up**: read once the agent would otherwise stop |
| `/withdraw <id>` | takes a message back (guaranteed while it is queued, best effort once written) |
| `//text` | sends a message that begins with a slash (`/text`) |
| Shift+Enter | a new line in the message |
| Esc | moves between the message box and the transcript |
| `e` (transcript focused) | expands or folds every tool call and result |
| PgUp, PgDn, arrows (transcript focused) | scroll |
| Ctrl+C | detaches; **the run goes on** |

The screen turns on the terminal's mouse tracking (pi-tui does), so a plain drag no longer selects text: hold your
terminal's override key while you drag (often Option on macOS, Shift elsewhere) to select and copy.

A steer sent after a `/later` follow-up still reaches the agent at its next turn: follow-ups wait until the agent would
stop, and each kind keeps its own order.

Any other word after a slash is refused rather than sent, so a typo like `/latr` never reaches the agent.

Every message is previewed first, as on the run page: the screen shows what the console will do and asks `y/n`. A
refused or declined message stays in the box. A message spends from the run's existing reservation; no new reserve is
taken. The console refuses what `pi-dispatch steer` refuses, and the refusal is shown as the console wrote it. See
[steering.md](steering.md) for turning steering on (`"steer": true` on the trigger).

The message box is hidden, with a sentence saying why in its place, when you are signed in with a viewer token, when
the console is read-only (`PI_CONSOLE_READ_ONLY=1`), when the run's trigger does not take messages, while the run's
inbox is closed (not yet open, or the run is ending), and while whether it is open cannot be read. When the console
could not read the run's inbox at all, its lookup says `steer.armed: null` (unknown, not "off"); `chat` keeps the box
hidden then with a sentence saying that it could not be read, and the status line asks again every 5 seconds.

The agent's text is drawn as markdown only while the markdown renderer can draw it safely: an entry that nests quotes
or list markers more than 8 deep on one line, or holds more than 2000 emphasis or link marks, is shown as plain text
(its header says so), and LaTeX is drawn only when its braces nest at most 16 deep and the entry holds at most 256
backslashes (each LaTeX command starts with one; past that the formula shows as its source). If the screen fails, or the
command is killed, the terminal is given back (the normal screen, the cursor, line editing) before it exits.

When the run ends while you watch, `chat` asks the console again (up to 5 times, 2 seconds apart, until the run is no
longer shown as running) and carries on: a run that parked drops into its answer box, and a finished one offers the
fork. A viewer's screen learns that the run ended from the status line.

## Reply: answer a parked run

A run that asked a question and parked ([sessions.md](sessions.md#parked-jobs-the-agent-asks-then-waits)) shows that
question, taken from the last thing the agent said in its transcript (kept 24 hours after the run). Without a
transcript to read it from (a viewer token, an expired transcript), the screen points at the issue where the run
posted it.

Type the answer (Shift+Enter for new lines) and press Enter. The console previews it, you confirm with `y`, and it is
queued as the run's resume, exactly as the console's answer form does
([console.md](console.md#answering-a-parked-run)). A refusal (a pull request's park, job data that has expired, no
comment trigger that would route the reply, an answer already queued or running on that issue, or a queue the console
could not fully read to tell) is shown as the console sent it, and your answer stays in the box.
Ctrl+C leaves without answering. After an answer, `chat` prints the new job and the command that follows it.

## Fork: continue a finished run in your own pi

A finished run's conversation is in the deployment's session store (`PI_SESSIONS_DIR`, see
[sessions.md](sessions.md)). `chat` opens it in the pi on your machine with `pi --fork`, so you can read it and keep
talking to it locally.

**It runs on the host that keeps the sessions.** The console never serves a stored transcript, because the stored one
is not redacted. So the fork reads the store directly: run the command on that host, from the deployment folder (that
is where `PI_SESSIONS_DIR` comes from). A session key needs nothing else. For a run id or a link, `chat` first asks
the console which mode the run is in, then judges the fork on this host's own record of the run when its run history
(`PI_LOGS_DIR`) holds one, and on the console's copy otherwise. `--fork` with a run id this host's history holds
needs no console at all.

**The stored transcript is never changed.** `chat` copies it to `~/.pi-dispatch/chat/<key>/source-<ms>.jsonl` (the
file 0600, the folders 0700, never following a link and never overwriting a file already there) and forks the copy;
pi writes your continued conversation into its own sessions folder. Nothing goes back to the store or the forge, and
the next job on that issue resumes from the job's own transcript, not yours. The copy is deleted again when the
command ends: on a no, on Ctrl+C or a kill from the moment the copy starts until you answer, and once pi exits; the
`<key>` folder goes with it when that leaves it empty. Without a terminal for the question, nothing is copied at all.
A SIGTERM or SIGHUP while pi runs is passed on to pi, and the command then exits 143 or 129. pi's own fork, in its sessions folder,
is as unredacted as the source and stays there; it is yours to keep or delete. `~/.pi-dispatch` and its chat folders
must be yours: one owned by another user is refused, and one of yours that others can read is made private (0700).

Before anything is copied, `chat` checks, and refuses with the reason:

1. the run kept a session at all (a forge issue's or a cron trigger's runs; a `pi-dispatch run` job has none);
2. it is not a pull or merge request (their session key needs the request's branch, which the run record does not
   carry; open those by their session key);
3. `PI_SESSIONS_DIR` is set;
4. the session's folder exists and is a plain folder;
5. its transcript is a plain file (not a link), not empty, of at most 64 MiB;
6. no promotion is replacing it right now;
7. a pi to run is found (below);
8. the pi version that wrote it: an older one is fine (pi reads older sessions) and is noted; a newer one, a stamp
   that cannot be read, or your own pi's version that cannot be read is refused unless you pass `--force`.

It also refuses when `~/.pi-dispatch/chat` is inside `PI_SESSIONS_DIR` (the store's reaper owns everything there),
and warns when a newer run on the same issue shares the session: the store keeps one conversation per issue, so the
file then holds that run's turns too.

Then it says how many bytes the transcript is, that it is **unredacted** (anything a tool printed during the job is
in it, a secret included), and which provider your pi will send it to, and asks `y/N`. When your pi's own
`settings.json` (in its agent folder, `PI_CODING_AGENT_DIR`) names both `defaultProvider` and `defaultModel`, the fork
passes both to pi (`--provider`, `--model`) and names them. A `.pi/settings.json` in your current folder is never read
for this: that folder may be a repository someone else wrote, and these two settings decide where the transcript
goes. Otherwise pi continues on the
run's own model if it knows that model and has a key for its provider, and falls back to its default if not; the
question says both. Every message you send in the fork goes to that provider with the whole conversation. Without a
terminal to answer on, the fork is refused before anything is copied. Your console token (`PI_CONSOLE_TOKEN` and every other `PI_CONSOLE_*`
variable) is never passed to pi.

pi starts in **your current folder, not the job's workspace**, with its **tools off** (`--no-tools`): the
conversation is text an agent wrote while reading untrusted input, and a forked agent with tools would act on your
machine. Pass `--tools` to turn them on. Taking `PI_CONSOLE_*` out of pi's environment is hygiene, not a boundary:
with tools on, the forked agent can read whatever your shell and your files allow, the forge tokens in your shell's
environment, the deployment's `.env`, `~/.ssh`, the console token in a file, and that is why tools are off by
default.

**Which pi.** `--pi <path>`, else `pi` on your `PATH`, else the pi installed beside pi-dispatch. Without one, `chat`
says how to install it.

## Hostile text stays text

Everything on the screen came from an agent that read issues, files and web pages anyone could have written. The
console redacts and escapes it, and `chat` cleans it again before your terminal sees it: every control character but
a newline is removed (a tab becomes four spaces, a carriage return a newline), and so are DEL, the C1 controls and the
bidi controls that reorder text, and characters that are invisible or drawn at a width the screen does not expect
(zero-width spaces and joiners, the soft hyphen, tag characters, Hangul fillers). An entry is cut at 64 KiB, and an
event over 256 KiB is left out and said to be.
Links are never made clickable: a markdown link prints its target beside its text, so nothing on the screen can point
somewhere it does not say.

## In the web console

The run page has a **Chat** panel, between Progress and Inbox, that offers the same three modes for an operator:

- a running run: a link to its live transcript and the **Steer** and **Follow-up** forms (they move here from the
  Inbox panel while the run takes messages, so the page never holds them twice);
- a parked run: the answer form, the same one the parked page draws, but only where the console would accept the
  answer (otherwise the reason it would refuse, in its place); a park already being answered links the run that
  answers it;
- a finished run: the `pi-dispatch chat <id>` command to run on the host that keeps the sessions, or why its session
  cannot be found from its record.

A viewer sees the run's state only, and a read-only console draws no form. The running and parked modes show the
`pi-dispatch chat <id>` command too. See [console.md](console.md#the-chat-panel).

## In pi: `/dispatch chat`

The pi extension has the same command, for the operator sitting in pi on the deployment's host:

```text
/dispatch chat <run-id | issue-or-PR-url | session-key>
```

It reads the argument by the same three shapes, and asks the same rule which chat the run has. It does not go
through the console's HTTP API and needs no console token: the panel already reads the deployment's queue and run
history for its other views, and it looks the run up through the very function the console's run lookup answers with,
so the mode is the one the run page and `pi-dispatch chat` show.

| The run is | `/dispatch chat` |
|---|---|
| running | opens the panel on that job's live transcript (its recovery job's, when the run goes on as one). `Esc` lands on the job's row in the list, where `t` sends a steer and `T` a follow-up, as in the panel ([steering.md](steering.md)). If the run ended while you watched, `Esc` leaves the cursor on no row and says the run is no longer active, so a `t` cannot reach another job; the arrows pick a row again |
| parked | shows its question (the last thing the agent said in its transcript, else where it was posted; each line behind `  \| `, at most 40 lines), asks for your answer in a dialog, then shows what the answer starts (the queue, the trigger's run fields and what it holds of the budget) and asks you to confirm. It is queued like the console's answer form, recorded in the console's audit log as written from the panel (the answer's digest, never its text), and the worker's comment on the issue quotes it under "Answered from an operator's /dispatch panel". A refusal is shown as the planner or the queue said it, and nothing is queued |
| finished, or a session key | checks the fork exactly as `pi-dispatch chat` does, then hands the terminal to your pi: pi's screen stops, the fork's question and pi run in the terminal, and pi's screen comes back when pi exits, also if the fork failed. A refusal, a failure or an interrupted question printed there is held on screen for a moment before the screen is redrawn |
| anything else | says why, in the rule's sentence |

The fork reads `PI_SESSIONS_DIR` from the deployment: your pi's environment, else the deployment's `.env` (the folder
the deployment pointer names, read under the same ownership checks as the panel's other settings), a relative path
taken from the deployment folder. The fork's question takes a line: type `y` or `yes` and press Enter to open the
fork; any other answer, Ctrl+C, Ctrl+D or Esc is a no (an arrow key too, since it starts with Esc). Keys typed before
the question shows are thrown away, so a key meant for pi cannot answer it, and so are keys typed right after your
answer, so they reach neither the fork nor pi. While the terminal is handed over, Ctrl+C never ends pi, and pi's keyboard works again when its screen
comes back. If pi's screen cannot be stopped or started again, the panel says so ("chat: failed (...)") instead of
reporting a fork; nothing is forked after a failed stop. A SIGTERM or SIGHUP to pi in that time removes the transcript's copy first, whatever then exits. The fork
runs with its tools off; for `--tools`, `--force` or another pi binary, use `pi-dispatch chat` in a shell.

The panel's answers are signed `panel`, so the console refuses to answer as a console token of that name: give such
a token another name.

`/dispatch chat` is a command you type, never a tool the model can call: each mode queues a paid answer, sends a
message into a running agent or hands the terminal to another program. Completion offers the run ids in this host's
history after `/dispatch chat `.

## Known limits

- **A link whose only run is still running** answers that there is no run on that target yet: a running job has no
  record until it ends. Give its job id instead.
- **An Azure DevOps work item** whose runs are in more than one repository of its project is listed, newest run per
  repository, and you name one by its job id.
- **The fork needs the session store on this machine.** A remote fork was decided against, since it would need a
  route that serves an unredacted transcript.

## Reference

```text
pi-dispatch chat <run-id | issue-or-PR-url | session-key> [--fork] [--force] [--tools] [--pi <path>] [--console <addr>] [--yes]
```

| Flag | Meaning |
|---|---|
| `--fork` | open the run as a fork whatever its state |
| `--force` | fork a session whose pi-version stamp is newer than your pi, or unreadable, or when your pi's version cannot be read |
| `--tools` | leave pi's tools on in the fork |
| `--pi <path>` | the pi binary to run for the fork |
| `--console <addr>` | the console to use (`host:port`, `http://host:port`, `unix:/abs/path`) |
| `--yes` | answer yes to the plain-HTTP question asked before signing in to a console that is not on this machine |

| Variable | Where it is read |
|---|---|
| `PI_CONSOLE_TOKEN` | your shell only |
| `PI_CONSOLE_URL` | your shell only |
| `PI_CONSOLE_LISTEN` | your shell, else the deployment's `.env` (only one no other account can change); used only when loopback or a unix socket |
| `PI_SESSIONS_DIR`, `PI_LOGS_DIR` | your shell, else the deployment's `.env` (the fork) |
| `PI_CODING_AGENT_DIR` | your shell: where your pi's own `settings.json` is (the fork's provider and model) |

Exit codes: 0 after a detach, an answer, leaving without one, or a declined fork; a fork exits with pi's own exit
code, or 143 or 129 when a SIGTERM or SIGHUP was passed on to it; 130, 143 or 129 when SIGINT, SIGTERM or SIGHUP ends a
chat screen or the fork's question; 1 for a refusal (also a fork with no terminal for its question).

The rules are `REQ-TERMINAL-CHAT` in [`specs/requirements.md`](../specs/requirements.md) and the design and its rejected
alternatives `DES-TERMINAL-CHAT` in [`specs/design.md`](../specs/design.md).
