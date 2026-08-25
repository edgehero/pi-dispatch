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

## Egress, and the policy you have to write yourself

`SECURITY.md` says network egress from the job container is unrestricted, and it means that literally. The
worker's `docker run` argv carries no `--network`, no `--dns` and no proxy setting, so a job container
lands on Docker's default bridge with the whole internet in front of it, holding a provider key and a
minted forge token. That is `OQ-004`: an accepted risk, ratified rather than quietly fixed, because what
bounds exfiltration is the short-lived narrowly-scoped credential (`CONST-TOKEN-SCOPED-PER-JOB`), not
network policy.

This section is the policy that disclosure tells you to write. It is yours to apply, on the host, around
the container. Nothing here changes the argv, so installing it needs no new pi-dispatch version, and
nothing here is on by default. It is written for a Linux host, which is what `deploy/` targets. A sandbox
inherits it for free, being the same image on the same bridge.

### What a job actually has to reach

| Destination | Reached by | When |
|---|---|---|
| The provider host, `api.anthropic.com` on the default provider | the runner itself | every turn of every job |
| Your forge: `github.com` and `api.github.com`, or the GitLab/Forgejo/Azure host you configured | the agent, in-container | when it pushes and opens the pull request |
| `registry.npmjs.org` | the agent, in-container | only when the job installs the serviced repo's own dependencies |
| Whatever the flow's tooling reaches | the agent | flow-specific, and the honest answer is that you have to know your flows |

Two things that look like they belong on that list and do not. **Staged pi packages need no network at
all**: `import-pi` installs them on the host and mounts them read-only, and `PI_OFFLINE=1` is set on every
job, so pi's resolver cannot shell out to `npm` even if a path were missed. **Playwright downloads
nothing**: Chromium is baked into the image at build time. A browsing job still reaches whatever site it
browses, and that single case will drive an allowlist wider than everything else combined.

### The shape that works

Deny by default, punch one hole at the network layer for the provider, and send the rest through an
allowlist proxy. The order of the rules is the design, not a detail. Substitute your own bridge subnet;
`172.17.0.0/16` is the common default.

```bash
PROVIDER_IP=$(getent ahostsv4 api.anthropic.com | awk '{print $1}' | head -1)

iptables -F DOCKER-USER
iptables -A DOCKER-USER -i docker0 -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A DOCKER-USER -i docker0 -p udp --dport 53 -j RETURN          # names must still resolve
iptables -A DOCKER-USER -i docker0 -d "$PROVIDER_IP" -j RETURN          # the provider, by address: see below
iptables -A DOCKER-USER -i docker0 ! -d 172.17.0.0/16 -j DROP           # everything else, denied
iptables -A DOCKER-USER -j RETURN
```

The proxy runs on the host and listens on the bridge gateway, filtering `CONNECT` by hostname:

```bash
docker run -d --name egress-proxy --network host \
  -v /etc/pi-dispatch/squid.conf:/etc/squid/squid.conf:ro ubuntu/squid:latest
```

```
# /etc/pi-dispatch/squid.conf
http_port 172.17.0.1:3128
acl CONNECT method CONNECT
acl SSL_ports port 443
acl allowed dstdomain .github.com
acl allowed dstdomain registry.npmjs.org
http_access deny CONNECT !SSL_ports
http_access allow CONNECT allowed
http_access allow allowed
http_access deny all
cache deny all
```

**Bind the proxy to the bridge gateway, not to every interface.** `--network host` puts it in the host's
namespace, so an unbound `http_port 3128` is an open forward proxy on your LAN, which is a worse thing than
the one you set out to fix. Bound as above it is reachable from job containers and from the host, and from
nowhere else.

`PI_FORWARD_ENV` is how the proxy reaches a job, and it is the only channel that will carry it: the
container env is a closed allowlist, so an unnamed variable is simply not forwarded.

```bash
HTTPS_PROXY=http://172.17.0.1:3128   # the gateway, by address: a job cannot resolve names for it
HTTP_PROXY=http://172.17.0.1:3128
PI_FORWARD_ENV=HTTPS_PROXY,HTTP_PROXY,NO_PROXY
```

The proxy filters on the hostname the client asks for and never terminates TLS, so it never sees inside
the tunnel. That boundary is deliberate. A proxy that decrypts provider traffic is `OQ-011`'s mechanism,
a materially larger change, and it is not this.

### The trap, and it is a bad one

**The proxy environment does not steer the runner's provider call.** Every other client in the image
honours it, verified one at a time against a dead proxy port: `git` fails with "Failed to connect to
127.0.0.1 port 9", `gh` reports `proxyconnect tcp`, `npm` retries until it gives up, headless Chromium
returns an empty document. The runner's provider traffic does not. With `HTTPS_PROXY` pointed at a dead
port **and** `NODE_USE_ENV_PROXY=1` set, a job still reached `api.anthropic.com` and came back with the
provider's `401`. Node's own `fetch` in that same image does honour the flag, so this is pi's provider
client, not Node, and no environment variable available to you will move it.

That is why the provider gets a network-layer rule, and why that rule names an address rather than a
hostname. Skip it, expect the proxy to carry the provider, and every job dies at its first turn while the
allowlist looks correct.

**That rule is coarser than you want, and it is the honest gap in this recipe.** It permits an address, so
whatever answers on that address is permitted, and if the provider moves you have a dead deployment until
you re-resolve. At the time of writing `api.anthropic.com` resolved to a single address, which makes this
practical rather than merely possible. Do not assume that holds. Put the re-resolve on a timer, or accept
the maintenance.

### When it is too tight

A job whose provider host is unreachable **starts the container, spends its budget slot, and produces
nothing**. Measured against the real runner behind the rules above, with the provider hole removed: three
provider attempts, `Request timed out.`, container exit `1`, about 40 seconds, zero tokens. A policy that
rejects rather than drops fails the same way in seconds, reporting `Connection error.` instead.

Exit `1` is the retryable class (`INT-RUNNER-EXIT-CODE-PROTOCOL`), the queue is configured for two
attempts, and the reservation is **not** given back: a slot is refunded only when the container never
started, and this container started. So a misconfigured allowlist spends two job-count slots per job, buys
nothing with either, and can do it faster than anyone reads the first failure. A cron-driven deployment
can empty its daily cap this way. That is `CONST-BUDGET-BEFORE-TOKENS` working exactly as specified, on
jobs that were never going to succeed.

Token spend really is zero, so what a too-tight allowlist costs you is the cap, not the money. Set it,
then watch one job complete, before leaving it in front of a schedule.

### What this does not buy you

An allowlist bounds where an induced agent can send your environment. It does not prevent it. The forge is
on the list, the agent holds a token for it, and a repository is a perfectly good place to write a secret
to. `SECURITY.md`'s disclosure stands whether or not you apply any of this, and the credential's scope and
expiry remain what actually bound the damage.

### How this was verified

All of it was run, none of it against a paid completion, and the method is worth knowing because it costs
nothing to repeat. **Reachability is provable without spending**: `api.anthropic.com` answers `401` to an
unauthenticated request, so a job that reaches the provider and is refused for its key has proven the
whole path. The rules were exercised on a real Linux dockerd with the shipped image and the real runner:
with the provider rule in place the job reached the provider and came back `401 API key is invalid`, and
with it removed the same job timed out and exited `1`. An unlisted host was refused in both directions,
`403` through the proxy and dropped without it. A run that reaches the provider and gets a `401` is one
valid key away from a completion, and that is the strongest claim made here.

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
