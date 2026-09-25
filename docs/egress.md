# Egress: what a job container may reach

A job container holds a provider key and a minted forge token and runs code from a repository anyone can
open an issue against. For a year it also had the whole internet in front of it, and `SECURITY.md` said so
plainly.

Not any more. Egress is **denied by default**: every job runs on **its own
`--internal` Docker network** whose only other member is an allowlist proxy, with no route off this host,
and a job whose policy cannot serve it is **refused before it costs anything**.

What you have to do, once:

```bash
docker compose -f deploy/docker-compose.yml --profile egress up -d
pi-dispatch doctor
```

**If you are upgrading**, that is the step. Until the proxy is up, every job is refused pre-spend naming it
and naming that command: loud, free (no budget slot, no tokens), and reversible in one line with
`PI_EGRESS=0` if you want the old posture back. `pi-dispatch up` offers to start it, and `doctor` fails
until it is running, so both commands you already run say it before a single job does.

## The hosts, and they are yours

`pi-dispatch init` writes `egress-allowlist.conf` next to your `.env` and never overwrites it. One bare
hostname per line; a leading dot matches subdomains.

```
api.anthropic.com          # the provider: every turn of every job
.github.com                # your forge: the push and the pull request
registry.npmjs.org         # only when a job installs the serviced repo's own dependencies
```

Nothing is special about the provider. It is an ordinary entry, reached through the proxy by name, like
everything else. Earlier versions of this document said otherwise; the correction is below.

Two things that look like they belong on that list and do not. **Staged pi packages need no network at
all**: `import-pi` installs them on the host and mounts them read-only, and `PI_OFFLINE=1` is set on every
job, so pi's resolver cannot shell out to `npm` even if a path were missed. **Playwright downloads
nothing**: Chromium is baked into the image at build time.

And one that does, which nobody can list for you: **whatever your flows reach**. A job that browses, or
calls an API you added, or installs from a private registry, reaches hosts that are not in that file.
`doctor` names what it can. The rest you have to know, and a browsing flow will drive an allowlist wider
than everything else combined.

## The shape

| | |
|---|---|
| One `--internal` network **per job** | `pi-job-<id>-net`, created at job start and removed at job end. Holds exactly two endpoints: the container and the proxy. If the worker dies before it can remove one, the next boot removes it, detaching whatever is still on it first, and says so in the log if it cannot. |
| One long-lived proxy | `pi-dispatch-egress-proxy`, squid, hostname filtering on `CONNECT` to port 443. Publishes no port. |
| One upstream network | `pi-dispatch-egress-out`. Only the proxy is on it. |

**Per job, not one shared network**, and that is the part worth understanding. A shared network is a shared
L2 segment: at `DES-CONCURRENCY-3` that is three mutually-untrusting issue authors who can reach each
other. `enable_icc=false` looks like the fix and is not, because ICC governs *every* container pair on the
bridge and the proxy is a container, so it blocks the very path this design depends on (measured). One
network per job makes job-to-job traffic **structurally impossible** instead. Two job containers on
docker's default bridge can reach each other by IP today, so this removes an adjacency rather than adding
one. It costs about 190 ms to build and 260 ms to tear down, against a container run of minutes.
`pi-dispatch doctor --live` reads this back on your own daemon: a peer on its own job network must reach the
proxy and none of the names and addresses of a second peer on another, while that second peer answers itself
before and after the attempt (`jobToJobIsolation`, one direction, one pair).

**TLS is never terminated.** The proxy sees the name a client asks for and no byte inside the tunnel, so it
cannot read a credential and cannot count a token. A proxy that decrypts provider traffic is `OQ-011`'s
mechanism, a materially larger change, and it is not this.

**Nothing is published.** The hand-written recipe this replaces ran squid with `--network host` and had to
warn, in bold, to bind it to the bridge gateway, because an unbound `http_port` in the host's namespace is
an open forward proxy on your LAN. On a docker network with no ports published, that whole class is gone.

## What it costs when it is wrong, and why you are refused instead

A job that cannot reach its provider **starts the container, spends its budget slot, and produces nothing**:
three provider attempts, `Request timed out.`, exit `1`, about 40 seconds, zero tokens. Exit `1` is the
retryable class, the queue is configured for two attempts, and a slot is refunded only when the container
never started, and this one started. So a misconfigured allowlist spends **two job-count slots per job**,
buys nothing with either, and can do it faster than anyone reads the first failure.

That is why the worker checks the policy **before** it spends. If the proxy is absent or stopped, the job
is refused pre-spend with `egress-proxy-missing` or `egress-proxy-stopped`, no budget slot is consumed,
nothing is retried, and the operator is told which component is down. It costs one `docker inspect` when
the policy is on and nothing at all when it is off.

What that check proves is the structure, not the contents: the proxy is up. It cannot know whether your
allowlist has the right hosts on it, and it deliberately does not try. Proving reachability credential-free
means an unauthenticated request to a third party, and that is not a thing to do before every job on every
deployment. `doctor` does it once, when you ask.

## What `doctor` tells you

```
✓ Egress proxy running (pi-dispatch-egress-proxy)
✓ Egress proxy health: healthy
✓ Egress policy reaches the provider (api.anthropic.com answered, so the whole path works and no key was spent)
✓ Egress policy denies an unlisted host (the deny direction is the half an allowlist can silently lose)
```

### Lines about leftovers

You may also see a line about a leftover. Those are the canary's own objects, `pi-dispatch-egress-doctor-<pid>`
and its two probe containers. The rule is simple enough to rely on: **every one of them is removed at the end
of the run that made it, or reported in that same run** -- so what a later run finds is what a run that was
KILLED left behind, and doctor does not have to guess which. What it knows is that the process in the name is
no longer alive. The next run sweeps whatever belongs to a process that is no longer alive
**on this host**, and only when your docker CLI resolves a daemon on this host: a leftover on a shared or
remote daemon belongs to the doctor that made it, and a pid that is dead here may well be alive there.

Every warning names a command, in the line itself or in the fix line under it. The first column of this
table is the wording of doctor's own line table (`CANARY_LINES`), and a test rebuilds it from that table
and requires this page to match -- so a shape doctor can print and this page describes differently is a
failure rather than a page nobody re-read. The rows are maintained by hand and checked, not written by a
generator.

<!-- CANARY-LINES -->

| Line | What it means | What to do |
|---|---|---|
| `⚠ Egress canary: leftovers from an EARLIER doctor run could not be listed: docker network ls --filter name=pi-dispatch-egress-doctor-` | the listing itself failed, so doctor does not know whether there are any leftovers. The only line here that names no network, because none was ever read | run the command yourself; a daemon that cannot list is usually the real problem |
| `⚠ Egress canary: <net> may be left over from an EARLIER doctor run, and is not swept because this shell's docker CLI <what it resolved>, so a pid that is dead here may be alive there` | there IS a leftover on a daemon this shell cannot show is on this host. It is not swept, because the pid in the name is this host's process table and that is not the one that matters there. The rest of the line says whether your CLI resolved somewhere else or answered nothing at all | check on the host that daemon belongs to, then `docker network rm <net>` there |
| `⚠ Egress canary: the network <net> could not be read: docker network inspect <net>` | the network is still there and `docker network inspect` would not say what is on it | run the inspect yourself. Do not skip to `network rm`: what is attached is exactly what is unknown |
| `⚠ Egress canary: <net> is kept, because the probe <probe> could not be removed and the network is the only way left to find it: docker rm -f <probe>` | a probe container would not go. The network is deliberately **kept**, because nothing in this project searches for probe containers by name, so removing the network would orphan that container permanently | `docker rm -f <probe>`, then re-run doctor |
| `✓ Egress canary: removed <net> (after removing <probes> and detaching <endpoints>), left by an EARLIER doctor run` | the ordinary sweep. The probes named were removed, anything else attached was detached and named, and the network is gone | nothing |
| `✓ Egress canary: removed <probes> and detached <endpoints> on <net>, left by an EARLIER doctor run; the network itself is gone` | what the pass did land, on a network the daemon then said was not there. Either half of the list may be absent; if the pass did nothing at all, there is no line, because a network the daemon says is not there is not news | nothing, unless one of the detached names is yours. `<net>` is doctor's OWN canary network and is not worth recreating: reattach your container to the network it belongs to instead |
| `⚠ Egress canary: the network <net> could not be removed: docker network rm <net>` | the removal failed. Two places produce this line. From the **sweep** it means everything on the network was dealt with first. From doctor's own **teardown** at the end of a run it does not: that path force-removes its probes without reading the result, so a probe the daemon is still wedged on is still attached, and "has active endpoints" is the likeliest reason the removal failed | run the command. If it says the network has active endpoints, `docker network inspect <net>` first and remove what is on it, as in the row above |

<!-- /CANARY-LINES -->

The two policy lines each run a throwaway container on a throwaway network, using **your job image's own node and
its runner's own module** (pi loaded, then the runner's proxy restore, issue #427), so they prove the route your jobs'
provider calls take once the runner has called that module; that it does, before its first request, is checked in CI. (Before #427 they used a plain `fetch`, which never loads pi and stayed green while every job
failed.) They cost nothing: `api.anthropic.com` answers `401` to an
unauthenticated request, so reaching the provider and being refused for the key proves the whole path
without spending a token. The deny probe asks for `example.com`, a host that resolves and answers, so a proxy
that lets everything out is caught; it is only contacted if your proxy lets the request out, which is the
finding. A probe container that does not run at all is reported as not run, never as a deny.

An absent proxy is a **hard failure** in doctor, because every job is refused while it is down. Everything
that needs the network to answer is a **warning**, because a custom provider base URL or a transient blip
would each make a red there a false alarm. So is any leftover the canary could not clear: a network nobody is
using costs nothing but disk, and a doctor that failed over one would be crying wolf. Each of those warnings
names a command, and where something FAILED it is the command that failed rather than a suggestion: `docker
network ls` when the listing did not answer, `docker network inspect` when the membership could not be read,
and `docker rm -f` on the probe when a container would not go. The exception is the foreign-leftover warning,
where nothing failed at all and the `docker network rm` in its fix line is advice for the other host. This
page said `network rm` for every one of them, and following that on the unreadable and stuck-probe lines is
the one thing you should not do.

## The trap that was not one

Earlier versions of this document recorded, in bold, that the runner's provider call does not follow
`HTTPS_PROXY` even with `NODE_USE_ENV_PROXY=1`, and concluded that pi's provider client could not be
steered by any environment variable, so the provider had to be permitted at the network layer by address.

**That was wrong, and the measurement that refuted it is worth keeping.** The observation was real. The
cause was not pi. In the pinned image (Node 22.23.1):

| | |
|---|---|
| plain `fetch`, `HTTPS_PROXY` only | `ENOTFOUND` — straight to DNS |
| plain `fetch`, `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1` | `ECONNREFUSED` to the dead proxy |
| the Anthropic SDK, built exactly as pi builds it, with the flag | `ECONNREFUSED` to the dead proxy |

The SDK resolves `globalThis.fetch` at construction and pi passes it no dispatcher, so the provider call
follows whatever the process's global dispatcher is, and `NODE_USE_ENV_PROXY=1` installs a proxy-aware one.

What actually happened is two paragraphs above the trap the old text recorded: **the container environment
is a closed allowlist**, and the recipe's own line was
`PI_FORWARD_ENV=HTTPS_PROXY,HTTP_PROXY,NO_PROXY`. `NODE_USE_ENV_PROXY` is not in that list. The flag was
set on the host and never reached the runner.

The worker now sets all four itself, in the closed map, so arming the policy cannot half-work. While
the policy is armed, `PI_FORWARD_ENV` refuses those four names at boot: a forwarded value would point every job
at a proxy of your own and would read exactly like the control working.

**And then loading pi took the proxy away (issue #427).** Every measurement above was of `fetch` and the SDK
on their own, never after pi was loaded, which is the runner's case. The pinned pi (0.80.7) depends on npm
`undici` 8.5.0, and loading it replaces the global dispatcher the flag installs with one that ignores the proxy
variables. In the job image, on an internal network with the proxy attached:

| | |
|---|---|
| plain `fetch`, all four variables | `401` from the provider, through the proxy |
| the same `fetch` after `import("@earendil-works/pi-coding-agent")` | `ENOTFOUND`, straight to DNS |

So with egress armed every job went direct and died at its first turn with `Connection error.`. pi's own CLI
repairs this when it starts, and the runner does not start pi through its CLI. The runner now installs an
env-proxy dispatcher itself, from pi's own `undici`, right after pi is loaded, and only when
`NODE_USE_ENV_PROXY=1`. `pi-dispatch doctor`'s canary now loads pi and uses the runner's module the same way.
Before, it was a plain `fetch` and stayed green through all of this. On a job image built before the fix, the
canary says the image cannot find that module, rather than reporting a policy result. That the runner's entrypoint
calls the module, before its first request, is checked in CI, where the job image's contract job runs the real
entrypoint against a stub proxy.

## What this does not buy you

An allowlist bounds **where** an induced agent can send your environment. It does not prevent it. Your
forge is on the list, because a job that cannot push has nothing to do, and a repository is a perfectly
good place to write a secret to. `SECURITY.md`'s disclosure stands whether or not you turn this on, and the
credential's scope and expiry remain what actually bound the damage.

It also accounts for nothing. A staged package that spawns a `pi` subprocess spends against the provider
host, which is on the allowlist by necessity, and a proxy that does not decrypt cannot count tokens
(`OQ-011`).

And it does not hide **this host** from the job. `--internal` stops the network routing anywhere beyond
itself, but its gateway is still the host, so a service listening on `0.0.0.0` there answers a job container
that dials the gateway address. Measured on Docker 27.5.1 and on rootful Podman 5.8.2 alike: a listener on
`0.0.0.0:9999` answered from inside a job, while one bound to `127.0.0.1` gave `ECONNREFUSED`, as did a port
with nothing behind it. That loopback binding, not `--internal`, is what keeps a job out of your queue, which
is why `deploy/docker-compose.yml` publishes Valkey on `127.0.0.1:6379` and never on `0.0.0.0`. Bind your own
host services the same way, or put the firewall layer in the appendix below them.

## How this was verified

All of it was run. The method costs nothing and is worth repeating on your own host.

- **The whole path, end to end**, with the shipped compose profile and a real per-job network: the provider
  answered `401` in 228 ms, an unlisted host was denied in 18 ms, and `api.github.com` answered in 205 ms
  through the `.github.com` rule.
- **The pre-spend refusal**, in both directions: with the proxy stopped the preflight returns
  `proxyStopped`, with it removed `proxyMissing`, and with `PI_EGRESS` unset it returns admit **without
  spawning docker at all**.
- **`enable_icc=false` blocks job-to-job traffic and also job-to-proxy traffic** — the reason this design is
  per-job networks rather than one shared one. Verified against a control network with ICC left at its
  default, where the same connection succeeds.
- **The gateway is reachable from an `--internal` network, on both runtimes**, and a `0.0.0.0` host service with
  it. See "What this does not buy you" above: measured with a listener on `0.0.0.0:9999` (answered) and one on
  `127.0.0.1:9997` (`ECONNREFUSED`), on Docker 27.5.1 and rootful Podman 5.8.2.
- **On rootful Podman 5.8.2** (netavark and aardvark-dns, issue #345) the same shape holds through its Docker API:
  the compose profile starts the proxy unchanged, the proxy resolves by name from a job network, an external name
  fails at once with `ENOTFOUND` where Docker gives `EAI_AGAIN` (aardvark answers NXDOMAIN for a source on an
  internal network; both refusals were immediate in the lab, so this is a different error, not a faster one), and a
  peer on another job network is unreachable by name and by address. See `docs/podman.md`.
- **A denied host fails in about 20 ms, not on a DNS timeout**, because the client hands the name to the
  proxy in a `CONNECT` and never resolves it locally. An external name resolved *directly* from an internal
  network fails without ever reaching the proxy, and how fast depends on the resolver **inside** the
  container rather than on anything this design does. Measured on Docker Desktop 27.4.0 (macOS), an
  `--internal` network, and docker's embedded resolver at `127.0.0.11`, whose upstream on that host is the
  Desktop VM's own resolver and is not reachable from a network with no route off it. So the forward fails
  rather than hanging, and what each client does with that failure is the whole of the difference: the job
  image, which is Debian and glibc, gives up in about 10 ms (six runs, 6 to 23 ms, all `EAI_AGAIN`), taking
  the embedded resolver's answer as final, while a musl image on the same network waits out musl's own 5 s
  resolver timeout instead (five runs, 5013 to 5025 ms). The number that describes a job here is therefore
  milliseconds, since the job image is glibc. The ten-second figure this replaces did not reproduce on this
  host in any client, and what it was measured against is not known, so it is replaced rather than accounted
  for. Either way it is the path a client that bypassed the proxy would take.

## Appendix: a host-firewall layer below docker's rules

The control above is applied by docker, by the worker, and is visible to `doctor`. If you want a second
layer *underneath* it, on the host itself, this is the shape that works on a Linux host. It is not an
alternative to the above and nothing in pi-dispatch reads it.

```bash
PROVIDER_IP=$(getent ahostsv4 api.anthropic.com | awk '{print $1}' | head -1)

iptables -F DOCKER-USER
iptables -A DOCKER-USER -i docker0 -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
iptables -A DOCKER-USER -i docker0 -p udp --dport 53 -j RETURN
iptables -A DOCKER-USER -i docker0 -d "$PROVIDER_IP" -j RETURN
iptables -A DOCKER-USER -i docker0 ! -d 172.17.0.0/16 -j DROP
iptables -A DOCKER-USER -j RETURN
```

Its honest limits, which are why it is an appendix rather than the control: it names an **address**, so
whatever answers on that address is permitted and a provider that moves means a dead deployment until you
re-resolve; it asserts your bridge subnet; it flushes a chain you may share with other workloads; and
**nothing in this tool can see it**, so the worker cannot report it, `doctor` cannot check it, and a Docker
upgrade that rewrites the chain removes it with no signal at all.
