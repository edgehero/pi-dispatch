# Resurrectable sandboxes

A run finishes, opens a pull request, and says it built the thing. Sometimes you want to *see* it — click
through the page, start the app, read the file it wrote. The container that built it is already gone:
job containers run with `--rm` and are disposed the moment they exit, and that is not going to change.

So the container is not kept alive. It is made **resurrectable**.

```bash
pi-dispatch sandbox --list          # what is still re-openable, and for how long
pi-dispatch sandbox gh-12345        # a shell in that run's workspace
pi-dispatch sandbox gh-12345 --publish 3000
```

A fresh container starts from the **same image** with the **same workspace** and the **same isolation
flags** — and no credentials at all. The agent is not running. You are.

You can also open one from the admin panel: `/dispatch`, Enter on a finished run, then `b`. The panel
suspends itself, hands the terminal to the shell, and comes back when you exit.

Two refusals land before anything else runs, and they are the two an operator meets first. The command
**needs a terminal**: it opens an interactive shell, so from a pipe, a TTY-less script or CI it refuses by
name rather than letting docker fail with "the input device is not a TTY". And if a sandbox for that id is
**already running**, it refuses and points at it: `docker attach pi-sandbox-<jobId>`, or exit that one
first.

## What is preserved, and what is not

| | |
|---|---|
| The image the run used | ✅ the exact tag, from the run's own manifest |
| `/workspace` | ✅ the clone the agent worked in, or your own folder for a local run |
| `/job` | ✅ read-only, the run's `prompt.md`, `event.json` and materialised `pi/` |
| Processes | ❌ nothing is still running; you start what you want |
| Anything the run installed outside `/workspace` | ❌ that belongs in the image |
| Credentials | ❌ **deliberately** — see below |

Same image plus same workspace, fresh processes. That contract covers "run it and click through it",
which is the case worth serving. It does not pretend to be a snapshot, because it is not one.

## Setup

On by default, with a 24-hour window:

```bash
PI_SANDBOX_RETENTION_HOURS=24   # 0 = OFF. Note: not "keep forever" — see below
PI_SANDBOX_DIR=                 # default <PI_JOBS_DIR>/sandboxes, created mode 0700
PI_SANDBOX_PIN_DAYS=7           # what --pin extends a run to
PI_SANDBOX_IDLE_MINUTES=30      # TMOUT inside the sandbox; 0 = no idle logout
```

**The `0` sentinel is inverted here, and that is on purpose.** `PI_LOG_RETENTION_DAYS=0` and
`PI_SESSIONS_TTL_DAYS=0` mean *keep forever*. `PI_SANDBOX_RETENTION_HOURS=0` means **off** — nothing is
retained, and teardown deletes exactly as it did before this feature existed. There is deliberately no
keep-forever value: one repository clone per run with no ceiling is a disk bomb. Setting it to `0` also
sweeps what an earlier setting retained, so turning it off actually turns it off.

`pi-dispatch doctor` reports how many directories are being kept and where.

## Read this before you leave it on

**A retained directory holds issue text.** It is the run's whole per-job directory: the clone, plus
`prompt.md` and `event.json`, which for a forge job carry the issue or comment body verbatim. That is
the same data class as `logs/<jobId>.log`, which is opt-in and off by default. The directory is mode
`0700`, host-only, and never mounted into a job container — but it is on your disk for 24 hours by
default, so put `PI_JOBS_DIR` somewhere you would put issue text.

**The transcript is not kept.** If a job persisted a session (`docs/sessions.md`), its per-job copy is
deleted *before* the directory is retained. Transcripts live under `PI_SESSIONS_DIR` and expire on
`PI_SESSIONS_TTL_DAYS`; carrying one into a directory with a different, pin-extendable lifetime would
quietly extend that policy.

**A forge workspace can contain adversarial code.** It is whatever the run produced from an issue anyone
could open. Opening a shell next to it is your deliberate act — the same act as checking out a stranger's
pull request on your own machine — and the container still applies every isolation flag a job gets:
`--cap-drop=ALL`, `--security-opt no-new-privileges`, memory/CPU/pids limits, non-root, `--rm`.

## No credentials, and why

A sandbox carries no `GITHUB_TOKEN`, no `GH_TOKEN`, no GitLab/Forgejo/Azure token, and no provider API
key. The env is at most two variables: `TERM` and `TMOUT`. Both are dropped when they have nothing to say,
so an unset host `TERM` or `PI_SANDBOX_IDLE_MINUTES=0` emits nothing rather than an empty string.

This is not a precaution that could be relaxed with a flag. A job's credential is minted for that job,
scoped to that repository, and short-lived (`CONST-TOKEN-SCOPED-PER-JOB`); a shell you can type into is
not a job, and handing it a harness credential would make it a different security object entirely. If
you need to push from inside a sandbox, authenticate yourself — `gh auth login` is in the image.

## Egress

A sandbox lands on **whatever network the job did**. By default that is its own `--internal` network with
no route anywhere except the allowlist proxy; with `PI_EGRESS=0` it is Docker's default bridge and the
whole internet, which is what `SECURITY.md` discloses. The policy, how to change it, and a
host-firewall layer for a deployment that wants one underneath are all in [`docs/egress.md`](egress.md).

Leaving sandboxes on the open bridge was the tempting alternative and it is the wrong one: it reads as a
convenience (install a missing dependency while debugging) and it is a **wider reach than the run the
sandbox exists to reproduce**. A shell that can go where the run could not is not reproducing the run.
Nothing you want is lost, because the forge and the registry are on the allowlist a job needed anyway. If
you really need the open bridge for one session, that is your own deliberate act from another terminal:
`docker network connect bridge pi-sandbox-<jobId>`.

One thing here is genuinely different from a job. A sandbox carries **no credentials** (above), so egress
from it is a different object: there is no minted forge token and no provider key to send anywhere. What it
can still reach is whatever the workspace's code reaches when you run it, and that workspace is whatever a
run produced from an issue anyone could open. The network is the same; the stakes are not.

## Publishing a port

```bash
pi-dispatch sandbox gh-12345 --publish 3000        # host 3000 -> container 3000
pi-dispatch sandbox gh-12345 --publish 8080:3000   # host 8080 -> container 3000
```

**Always bound to `127.0.0.1`.** An explicit bind address is refused rather than honoured — there is no
flag that puts a container full of agent-written code on your LAN. Ports exist only while the sandbox
does; nothing is published by a job container, ever.

## How it ends

Exit the shell and the container is gone (`--rm`). The workspace stays retained until its window closes.

A forgotten sandbox closes itself after `PI_SANDBOX_IDLE_MINUTES` of no input, via bash's own `TMOUT`.
**Honest gap: `TMOUT` does not tick while a foreground command is running.** A sandbox left with
`npm run dev` in the foreground stays up until you stop it. `pi-dispatch sandbox --list` marks anything
running so you can find it:

```
gh-12345  github   RUNNING
gh-12002  github   19h left
local-77  local    pinned, 6d left
```

There is no wall-clock kill. A hard timeout would end a session you were still working in, which is
worse than a container you can see and stop.

## Keeping one longer

```bash
pi-dispatch sandbox gh-12345 --pin
```

Extends *that* run to `now + PI_SANDBOX_PIN_DAYS`. A pin is a timestamp, never a boolean — it survives a
change to the retention window, and it still expires. The pin is written before the shell opens, so a
session that ends in a closed laptop still keeps the workspace.

## Known limitations

- **Linux bind-mount ownership.** A local-folder sandbox runs as the image's non-root `pi` user (uid
  1001) against files owned by your host account, so writes may fail with `EACCES` on Linux. This is not
  new to sandboxes — local *jobs* have the same shape — and it does not arise on Docker Desktop, which
  maps ownership for you.
- **Sandbox *containers* are not reaped by the worker.** They are named `pi-sandbox-*`, outside the
  `pi-job-*` filter the boot reaper uses, precisely so a worker restart cannot kill a shell you are
  sitting in. The cost is that stopping a forgotten one is yours: `docker stop pi-sandbox-<jobId>`. The
  retained **directories** are swept, and by a separate reaper: every worker boot deletes the ones past
  their window, skipping any id whose container is live so a mount is never pulled out from under a shell.
  That boot sweep is what actually enforces the 24-hour window, which is worth knowing in both
  directions: a worker that never restarts never sweeps, and a restart after you lower the retention
  setting sweeps what the old one kept.
- **The retention window is bounded but not quota'd.** At the default daily cap that is roughly 25
  directories at a time. There is no byte ceiling; `doctor` reports the count.
