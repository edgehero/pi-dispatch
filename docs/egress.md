# Egress: what a job container may reach

A job container holds a provider key and a minted forge token and runs code from a repository anyone can
open an issue against. For a year it also had the whole internet in front of it, and `SECURITY.md` said so
plainly.

Not any more. Egress is **denied by default**: every job runs on **its own
`--internal` Docker network** with no route anywhere except an allowlist proxy, and a job whose policy
cannot serve it is **refused before it costs anything**.

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
| One `--internal` network **per job** | `pi-job-<id>-net`, created at job start and removed at job end. Holds exactly two endpoints: the container and the proxy. |
| One long-lived proxy | `pi-dispatch-egress-proxy`, squid, hostname filtering on `CONNECT` to port 443. Publishes no port. |
| One upstream network | `pi-dispatch-egress-out`. Only the proxy is on it. |

**Per job, not one shared network**, and that is the part worth understanding. A shared network is a shared
L2 segment: at `DES-CONCURRENCY-3` that is three mutually-untrusting issue authors who can reach each
other. `enable_icc=false` looks like the fix and is not, because ICC governs *every* container pair on the
bridge and the proxy is a container, so it blocks the very path this design depends on (measured). One
network per job makes job-to-job traffic **structurally impossible** instead. Two job containers on
docker's default bridge can reach each other by IP today, so this removes an adjacency rather than adding
one. It costs about 190 ms to build and 260 ms to tear down, against a container run of minutes.

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

The last two each run a throwaway container on a throwaway network, using **your job image's own node**, so
they prove the path your jobs actually take. They cost nothing: `api.anthropic.com` answers `401` to an
unauthenticated request, so reaching the provider and being refused for the key proves the whole path
without spending a token.

An absent proxy is a **hard failure** in doctor, because every job is refused while it is down. Everything
that needs the network to answer is a **warning**, because a custom provider base URL or a transient blip
would each make a red there a false alarm.

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

## What this does not buy you

An allowlist bounds **where** an induced agent can send your environment. It does not prevent it. Your
forge is on the list, because a job that cannot push has nothing to do, and a repository is a perfectly
good place to write a secret to. `SECURITY.md`'s disclosure stands whether or not you turn this on, and the
credential's scope and expiry remain what actually bound the damage.

It also accounts for nothing. A staged package that spawns a `pi` subprocess spends against the provider
host, which is on the allowlist by necessity, and a proxy that does not decrypt cannot count tokens
(`OQ-011`).

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
- **A denied host fails in about 20 ms, not on a DNS timeout**, because the client hands the name to the
  proxy in a `CONNECT` and never resolves it locally. An external name resolved *directly* from an internal
  network takes about 10 seconds to fail, which is the cost you would pay if a client bypassed the proxy.

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
