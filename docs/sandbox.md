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
suspends itself, hands the terminal to the shell, and comes back when you exit. If the container never
starts, the panel stops and tells you the exit code before it redraws, rather than painting over the one
line docker printed.

The command **needs a terminal**: it opens an interactive shell, so from a pipe, a TTY-less script or CI it
refuses by name before anything else, rather than letting docker fail with "the input device is not a
TTY". And if a sandbox for that id is **already running**, both the CLI and the panel refuse and point at
it: `docker attach pi-sandbox-<jobId>` (`podman attach` for a run on the podman venue), or exit that one first.

A sandbox reopens a run **in the runtime that ran it**. The retained record says which backend ran the job: a
`local` run opens through this host's docker CLI, and a run on the native `podman` venue through this account's
rootless Podman, with that venue's own flags (`--userns=keep-id`, `--user`, the pinned namespaces) and its own
refusals (`docs/podman.md`, "The sandbox on this venue"). Either opens only where `PI_BACKENDS`, read from the
shell you run the command or the panel from, names that venue; a run from any other backend, or from one this
shell does not bless, is refused by name from the CLI and the panel alike (the panel does not offer `b` for it,
and `--list` shows it as `not here`). Open it on the venue that ran it. A run retained before backends were
recorded ran locally and opens as it always did.

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
PI_SANDBOX_DIR=                 # default <PI_JOBS_DIR>/sandboxes, created mode 0700 (PI_JOBS_DIR: <tmp>/pi-dispatch-<uid>/jobs)
PI_SANDBOX_PIN_DAYS=7           # what --pin extends a run to
PI_SANDBOX_IDLE_MINUTES=30      # TMOUT inside the sandbox; 0 = no idle logout
PI_SWEEP_INTERVAL_HOURS=24      # how often the sweep re-runs while the worker is up; 0 = boot-only
```

**The `0` sentinel is inverted here, and that is on purpose.** `PI_LOG_RETENTION_DAYS=0` and
`PI_SESSIONS_TTL_DAYS=0` mean *keep forever*. `PI_SANDBOX_RETENTION_HOURS=0` means **off** — nothing is
retained, and teardown deletes exactly as it did before this feature existed. There is deliberately no
keep-forever value: one repository clone per run with no ceiling is a disk bomb. Setting it to `0` also
sweeps what an earlier setting retained, so turning it off actually turns it off, and lowering it applies to runs
already retained too. A pinned run is the exception: it keeps its pin either way.

Since issue #446 the worker also writes each run's deadline into its manifest (`retainUntil`) when it retains it,
and a run ends at the EARLIER of that and its creation time plus the current window. The written deadline is what
keeps a shell with a longer window than the worker's (the admin panel is the usual one) from calling a run open
that the worker is about to delete. The other side of the same rule: **raising** the window does not extend a run
that is already retained, which keeps the deadline it was retained with; only runs retained after the change get
the longer one. Pin a run to keep it longer.

`pi-dispatch doctor` reports how many directories are being kept and where.

## Read this before you leave it on

**A retained directory holds issue text.** It is the run's whole per-job directory: the clone, plus
`prompt.md` and `event.json`, which for a forge job carry the issue or comment body verbatim. That is
the same data class as `logs/<jobId>.log`, which is opt-in and off by default. The directory is mode
`0700`, host-only, and never mounted into a job container — but it is on your disk for 24 hours by
default, so put `PI_JOBS_DIR` somewhere you would put issue text.

**One directory per account** (issue #464). `PI_JOBS_DIR` defaults to `<OS temp dir>/pi-dispatch-<uid>/jobs`, and
the retained runs sit under it. Before that the default was `<OS temp dir>/pi-dispatch/jobs` for every account on the
host: the first account to run a job created it, and every other account's jobs then failed with `EACCES`. The worker
creates `pi-dispatch-<uid>` mode `0700` and refuses to start (exit 2) when that name is a symlink or belongs to another
account, since any account can create a name under the temp dir first; doctor fails on the same with the fix. A
`TMPDIR` in `.env` moves that root for the service, and doctor judges the root the service will use. Runs
retained under the OLD path before you upgraded are no longer re-opened or swept: doctor names this account's with a
⚠ and the move (`mkdir -m 700 -p` of the new root and its `sandboxes/`, then `mv` them in, same filesystem), or
delete them. A plain `mkdir -p` would leave the new root `755`; the worker tightens it to `0700` at its next boot
either way.

A `PI_SANDBOX_DIR` you set yourself must be this account's too. Its owner can rename a retained run and put one of
its own, manifest and all, in its place, which `pi-dispatch sandbox` would then list and open. The worker refuses to
start (exit 2) when that directory belongs to another account, asks again each time it keeps a run (a directory made
by someone else after boot deletes the run instead of keeping it there), and doctor fails on it, naming the owner.

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
key. The env is `TERM` and `TMOUT`, plus four proxy variables when egress is on, plus `HOME=/home/pi` when the
sandbox runs with `--user` (see *Known limitations*). `TERM` and `TMOUT` are
dropped when they have nothing to say, so an unset host `TERM` or `PI_SANDBOX_IDLE_MINUTES=0` emits nothing
rather than an empty string.

This is not a precaution that could be relaxed with a flag. A job's credential is minted for that job,
scoped to that repository, and short-lived (`CONST-TOKEN-SCOPED-PER-JOB`); a shell you can type into is
not a job, and handing it a harness credential would make it a different security object entirely. If
you need to push from inside a sandbox, authenticate yourself — `gh auth login` is in the image.

## Egress

A sandbox lands on **the network your egress setting gives a job**, whether you open it from the CLI or from
the panel. By default that is its own `--internal` network whose only other member is the allowlist proxy, with no
route off this host (`docs/egress.md` says what that does and does not bound); with `PI_EGRESS=0` it is Docker's
default bridge and the whole internet (for a run on the podman venue, the job's own `--network=private`, which
reaches the internet too), which is what `SECURITY.md` discloses. The setting is read from the
environment of whatever opens the sandbox: the shell you run
`pi-dispatch sandbox` in, or the environment pi was started in for the panel. Neither reads your
deployment's `.env`, so if you set `PI_EGRESS` or `PI_EGRESS_PROXY` only there, export them where you open
sandboxes too (otherwise the sandbox is refused rather than guessed at, and the refusal says so).

**The panel now shows you which posture it would use, before you press `b`.** RUN_DETAIL's sandbox block
carries two more lines, `egress on via <proxy>` (or `egress off (docker's default bridge)`, `egress off
(podman's private network)` for a run on the podman venue, or `egress unreadable`) and `read from this shell, not the deployment`. The parenthetical on the off state is not
decoration: on docker `PI_EGRESS=0` omits `--network` entirely, so the shell lands on the default bridge and
the whole internet, which "off" on its own reads as the opposite of (on podman it names `--network=private`,
which reaches the internet as well). The second is the part that matters: the panel reports what IT resolved,
and it has no way to see what your deployment's `.env` sets, so the two can disagree and only you can
tell. The same is true of the other sandbox settings the panel resolves from its own environment, which
`OQ-038` records in full: the retention window it reports, the idle timeout your shell gets, which
directory of retained runs it can see at all, and `DOCKER_HOST`, which on a Podman deployment can point
the panel at a different daemon than the one your jobs ran on. (Before #277 a sandbox opened from the panel
skipped the network and got the whole internet even with the policy on. If you rely on the policy for
sandboxes, run a version that carries #277.)

If you detach from a sandbox shell (Ctrl-P Ctrl-Q), it keeps running with its network, and the network is left
in place after it exits. A network left that way, or by a terminal closed mid-session, makes the next open of
that run refuse and print the two commands that remove it. The **open** still never removes it for you, because
a second open cannot safely tell a leftover from a session starting at the same moment; what does remove it is
the retention sweep, once the run's retained directory is gone (issue #337). So a leftover on a run you can
still re-open stays until you run those two commands or the window closes, and after that it is reclaimed
without you doing anything: by the sweep AFTER the one that removed the directory, because the pass that
deletes a directory still counts that run as retained. The policy, how to change it, and a
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
pi-dispatch sandbox gh-12345 --publish 3000        # host 3000 -> container 3000; needs PI_EGRESS=0
pi-dispatch sandbox gh-12345 --publish 8080:3000   # host 8080 -> container 3000
```

**Only with the egress policy off.** With `PI_EGRESS` armed, which is the default, the sandbox joins its
own `--internal` network, and a container attached only to one publishes nothing: docker accepts `-p`,
exits 0 and binds no host port. Measured on docker 27.4.0, `docker ps --format {{.Ports}}` is empty and
`docker port` prints nothing. So `--publish` is **refused** on the armed posture rather than accepted and
ignored, and the refusal names `PI_EGRESS=0` as the opt-out. Run that one session with `PI_EGRESS=0` if you
need the port on the host, and know what it buys: that shell lands on docker's default bridge, with the
whole internet.

**Attaching the bridge afterwards behaves differently on Docker Desktop and on Linux**, so it is worth
knowing which one you are on before you reach for it. On **native Linux docker** (measured on 27.5.1) the
attach does rescue the port: docker installs the DNAT rule at attach time and removes it again on detach,
and the port answers. On **Docker Desktop for macOS** (measured on 27.4.0) it does not: `docker port` starts
reporting a binding and nothing answers there. In both cases a control container published on the default
bridge at create time answers immediately, so the listener is not what is missing.

Either way this is the escape hatch rather than the route: it hands that session the whole internet.

One ordering note, since the refusal comes early: with `--publish` set on an armed deployment you get the
publish refusal even when the sandbox is already running or its job user cannot be resolved, and `--pin`
does not take, because pinning happens just before the shell opens. Drop the flag, or set `PI_EGRESS=0`,
and those speak for themselves again.

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

**A run at the end of its window opens only with `--pin`** (issue #446). A run whose deadline has passed, or is
less than five minutes away, is refused without it, and the refusal names the window and the command:
`pi-dispatch sandbox <jobId> --pin`. The deadline is worked out the way the sweep works it out: the pin while one
is set, else the earlier of the deadline the worker wrote when it retained the run and its creation time plus the
`PI_SANDBOX_RETENTION_HOURS` of the shell you open it from. So a shell whose window is larger than the worker's is
still refused. The reason is that an open is not in any runtime's `ps`
until its container starts, and a sweep that asked just before that could delete the directory under the new
shell. With `--pin` the new deadline is written first, before any `docker` or `podman` call, and the sweep reads
the manifest again before it deletes anything, so a pin that lands mid-sweep holds the run. A pin that cannot be
written refuses the open (it used to print a warning and open anyway). The admin panel has no pin, so it does not
offer `b` for such a run, and says to use the CLI.

The one case this cannot see: the worker's window was LOWERED after the run was retained, while the shell you
open from still has the old, longer one. That shell then opens a run the worker's next sweep may delete. The sweep
asks the run's runtime once more right before it deletes anything, so once your container is up it holds the run.
What is left is a container starting in the moment between that ask and the delete. The opener checks the run
as your shell starts, and if it is already gone (or its directory replaced) it removes the container at once and
tells you it was swept, rather than leaving you working over an empty directory (your shell may have printed its
prompt by then). It then keeps checking while the shell is open, but from then on it never touches your shell: a
run lost later is reported when you exit (`note: ...`), because by then the container may hold work outside the
run's directories that removing it would destroy. The run is checked once more when your shell exits, so a loss
the watch missed is still reported. This is accepted rather than closed. Lower the window in both
places, or pin the run.

**The worker and the shell you open from must use the same container runtime endpoint.** The sweep asks the
worker's `docker` (its `DOCKER_HOST` or context) which sandboxes are open; a sandbox you open from a shell pointed
at another daemon is invisible to it, and only the rules above protect it.

## Known limitations

- **Which user the shell runs as.** A sandbox runs as the uid the job ran as: the worker's own on a native
  Linux daemon, the image's `pi` user on Docker Desktop (issue #341). The retained files are owned by that
  uid and readable only by it, so open the sandbox as the worker's account, or with `sudo -E`: the uid the
  run recorded is used either way. A run retained before this was recorded has no uid on file, so it opens as
  the account you run the command as, and as root it is refused; open such a run as the worker's account. A
  rootless daemon, userns-remap or Docker Desktop on Linux is refused with the reason. A run on the native
  podman venue is the exception to `sudo -E`: keep-id maps the account that runs `podman`, and the run's image
  is in that account's own store, so it opens only as the account the worker runs as, with the worker's container
  storage (the same `HOME` and `XDG_DATA_HOME`, no `storage.conf` of your own). Another store's `podman ps` answers
  empty (measured), so the run records its store and the sandbox refuses another one (`podman-store-mismatch`;
  `docs/podman.md` lists the podman refusals in order, `podman-conf-unread` among them).
- **A pin keeps the manifest the worker's.** `--pin` rewrites the manifest by renaming a new file over it, with the
  old one's owner and mode, so `sudo -E pi-dispatch sandbox --pin` on a `local` run does not leave a root-owned
  manifest the worker cannot read (a `podman` run refuses root before any pin); a pin that cannot keep the owner is
  refused. A manifest that cannot be read for a moment holds its directory on every sweep pass it stays unreadable,
  said each pass (`manifest-unread` in the worker log), rather than reading as missing; and a manifest that changes
  while a pass is running (a pin, a retry's fresh run) is read again before anything is deleted, and holds the
  directory for that pass (`manifest-changed`). The sweep renames a run it is about to delete to `.reap-<pid>-<time>-<n>`
  in the same directory first, reads its manifest once more there (a pin that landed in between puts it back), and
  only then deletes it, so from that rename on an open or a pin of the run finds nothing instead of a directory that
  is half deleted (issue #446). Putting a run back displaces an EMPTY directory that has appeared at its name (Docker
  creates one when it is asked to mount a path that is not there; Podman refuses the mount instead, and the open
  then says the run was swept) and nothing else, and a
  `.reap-` directory holding a pin that has not run out is never deleted: it is put back under its run's name as
  soon as it can be, and said in the worker log (`tombstone-pinned`) until then. In the one moment this cannot
  cover (a sandbox starting inside the sweep's own rename and put-back), that sandbox's shell shows an empty
  `/job` and `/workspace` while the pinned run is intact on disk; exit and open it again. Names starting `.reap-`
  are the sweep's own and never a run (a job id whose safe form starts with `.` or `_` is kept under one more `_`
  in front, `.x` as `_.x` and `_x` as `__x`, so two ids never meet in one directory; a run retained before that
  rule under `_x` is still found, opened and swept under that name); one a crash left behind is removed by the next
  pass.
- **Sandbox *containers* are not reaped by the worker.** They are named `pi-sandbox-*`, outside the
  `pi-job-*` filter the boot reaper uses, precisely so a worker restart cannot kill a shell you are
  sitting in. The cost is that stopping a forgotten one is yours: `docker stop pi-sandbox-<jobId>` (or
  `podman stop`). The retained **directories** are swept, and by a separate reaper: it deletes the ones past
  their window, skipping any id whose container is live. For each retained run it asks the runtime that
  run's manifest records (docker for `local`, podman for `podman`), and a runtime that does not answer
  holds its own runs for that pass rather than sweeping as though none of their sandboxes were open. An open
  racing a sweep is covered three ways (issue #446): a run at the end of its window opens only with `--pin`,
  whose deadline is written before anything starts; a pin that lands while a directory is being deleted finds
  it already renamed aside and reports it gone rather than pinned; the sweep asks each expired run's runtime once
  more right before it deletes it, and holds one whose sandbox has opened meanwhile; and once the sandbox shows in
  `ps`, the opener checks the run's directory, and if the run is already gone or its directory replaced it
  removes the container at once (on Podman with `--time=0`, since an interactive shell ignores the polite stop)
  and says so rather than leaving you in a shell over an empty mount; after that first check it keeps watching but
  only reports a loss when you exit. That check runs beside the shell, not ahead of it, so in that case the shell
  may already have printed its prompt. It runs at
  every worker boot and then every `PI_SWEEP_INTERVAL_HOURS` while the worker is up (24 by default; set
  `0` for the boot-only behaviour, where a worker that never restarts never sweeps). Three things follow.
  The window is a **floor** rather than a ceiling: a directory dies on the first sweep after its window
  closes, so at both defaults a retained workspace can live up to 48 hours. A restart after you lower
  the retention setting still sweeps what the old one kept. And since issue #337 that reaper also removes
  the run's `pi-sandbox-<jobId>-net` network, on the directory's own clock: a network whose id the pass no
  longer finds on disk, with nothing running, no `pi-sandbox-` container attached, and no container of its
  own that has not finished, is disconnected from whatever is left on it and removed. Your shell is held
  three ways: by the retained directory from before the container starts until the window closes, by its own
  container from the moment docker creates it, and by the endpoint list once it is up;
  a network the sweep looked at and would not take is named in the worker log with the reason, while one
  it skipped because the run is still retained or still running is passed over in silence.
- **The retention window is bounded but not quota'd.** At the default daily cap that is roughly 25
  directories at a time. There is no byte ceiling; `doctor` reports the count.
- **One worker per retention directory.** `PI_SANDBOX_DIR` belongs to one worker, as a Docker daemon does
  (`DES-CONCURRENCY-3`): two workers sweeping one directory each decide on their own window and their own view of
  what is running, and nothing coordinates them. A second worker only leaves alone a `.reap-` directory another
  process that is still running created in the last ten minutes, so it cannot delete a run the first is putting
  back; that is a guard, not support for sharing. (One left by a worker that has since died is cleared at once.)
- **A run the worker cannot delete stays a tombstone.** The usual cause on Linux is files a job left in its clone
  that the worker's account does not own. The rename aside still works (it needs only the retention directory), so
  the run is no longer re-openable and its session network is reclaimed on the next pass, but the disk is still in
  use. Every pass retries the delete and says so in the worker log once a day (`tombstone-stuck`), and `doctor`
  warns about each one older than ten minutes ("the sweep could not remove it; if the worker is running it retries
  each pass"), with the command to remove that one directory as the files' owner. The one kind it never offers to
  remove is a directory holding a PINNED run whose name was taken when it was put back: the sweep puts it back once
  the name is free, so do not remove it.
