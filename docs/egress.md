# Egress: what a job container may reach

A job container holds a provider key and a minted forge token and runs code from a repository anyone can
open an issue against. For a year it also had the whole internet in front of it, and `SECURITY.md` said so
plainly.

Not any more. Egress is **denied by default**: every job runs on **its own
`--internal` Docker network** whose only other member is an allowlist proxy, with no route off this host,
and a job whose policy cannot serve it is **refused before it costs anything**.

What you have to do, once, from your deployment folder:

```bash
pi-dispatch up
pi-dispatch doctor
```

`up` shows the proxy's `docker run` and asks before it runs it, and it works in any folder `pi-dispatch init`
made, since init writes the three files the proxy mounts. From a clone, or a folder holding `deploy/docker-compose.yml`,
compose starts the same proxy instead:

```bash
docker compose --env-file .env -f deploy/docker-compose.yml --profile egress up -d
```

In a folder `/dispatch setup` laid out, name the folder's project and, when setup wrote it, its Valkey override, so
compose addresses the containers it already runs:
`docker compose -p <folder name> --env-file .env -f deploy/docker-compose.yml -f deploy/docker-compose.valkey.yml --profile egress up -d`
(the project name rule, and its edge cases, are in [podman.md](podman.md), step 7). `pi-dispatch up` prints the
command for its own folder.

**If you are upgrading**, that is the step. Until the proxy is up, every job is refused pre-spend naming it
and naming `pi-dispatch up` as the way to start it: loud, free (no budget slot, no tokens), and reversible in one line with
`PI_EGRESS=0` if you want the old posture back. `pi-dispatch up` offers to start it (on the rootless Podman venue,
as a Quadlet unit that comes back at boot: [`podman.md`](podman.md)), and `doctor` fails
until it is running, so both commands you already run say it before a single job does.

## The hosts, and they are yours

`pi-dispatch init` writes `egress-allowlist.conf` next to your `.env` and never overwrites it. One bare
hostname per line; a leading dot matches subdomains. Beside it init writes `deploy/egress-proxy.conf`, the
proxy's rules, copied from the installed package and also never overwritten: the Docker proxy mounts both
from the deployment folder, so a folder made without a clone gets them too. You edit the allowlist, never
the rules.

**An upgrade does not rewrite the rules.** Never overwritten means a newer version's rules stay in the
package until you take them, so `doctor` compares this folder's `deploy/egress-proxy.conf` with the installed
package's copy and warns (⚠, not ✗: a differing copy still enforces the allowlist, and the difference may be
an edit of yours) naming both files, so `diff` shows which it is. `pi-dispatch up` offers the refresh: it
shows how the two differ, asks (`--yes` does not answer this one, since only you know whether the difference
is yours), keeps your copy as `deploy/egress-proxy.conf.bak-<timestamp>`, and writes the package's copy
beside it before renaming it into place; it refuses a `deploy/egress-proxy.conf` or a `deploy/` that is a
symlink. squid reads its rules only at start, and a running or paused container still holds the file it
started with, so `up` then offers `docker restart pi-dispatch-egress-proxy` for a proxy already running, and
`docker unpause` followed by that restart for a paused one (asked, not taken by `--yes`, while jobs are
attached to it); a stopped proxy it starts, or one it creates or replaces, in the same pass reads the new
file anyway. **Rules that include `model-endpoints.conf` (issue #503) go in only together with a proxy that
mounts it**: a proxy made before #503 mounts two files, and a restart on the new rules would exit on the
missing include. So for such a proxy `up` asks once for both, the refresh and the proxy's replacement. If you
decline, or the replace cannot happen, the rules are not written; if the new proxy fails to start, the old
rules are put back. On the Podman venue the rules live in an account-owned
copy instead, which `doctor` compares the same way and `pi-dispatch service install --force` refreshes
([`podman.md`](podman.md)).

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

## Local model servers

A job can reach a model server on your own machine or LAN (Ollama, vLLM, llama.cpp, LM Studio) through the
proxy, one host and one port at a time. Each one you declare becomes a `CONNECT` tunnel to exactly that host and
port, and nothing else: no other port of that host, and no plain forward request to it.

A job can use a local model as its main model. A model server that takes no key is declared `"keyless": true`, and
then its provider needs no key at all ("A provider with no key" below).

### Declare, render, reload

1. **Declare it** in `model-endpoints.json` in the deployment folder. `pi-dispatch init` writes it empty.

   ```json
   { "version": 1, "endpoints": [ { "id": "mac-ollama", "host": "host.docker.internal", "port": 11434, "slots": 2, "keyless": true } ] }
   ```

   `id` names the endpoint in every line about it. `host` is the name or address the proxy dials: never
   `localhost` or `127.0.0.1`, which inside the proxy is the proxy itself. `slots` is how many requests the server
   runs at once. `keyless` says the server takes no key (default `false`). The file's full rules are in
   `INT-MODEL-ENDPOINTS-FILE-CONTRACT` (specs/interfaces.md).

2. **Render** the proxy's rules for it, from the deployment folder:

   ```sh
   pi-dispatch egress render
   ```

   It writes `model-endpoints.conf` in the deployment folder (also when `PI_MODEL_ENDPOINTS_FILE` names a JSON
   file elsewhere), in place, and prints the reload. The file is the proxy's include. It must exist even with
   nothing declared, because squid will not start without it. `init` writes it. Do not edit it by hand, and do
   not replace it with another file (an editor that saves by rename does that): the running proxy keeps reading
   the old one.

3. **Reload** the proxy with the command it printed:

   ```sh
   docker exec pi-dispatch-egress-proxy squid -k reconfigure   # Docker
   podman exec pi-dispatch-egress-proxy squid -k reconfigure   # the rootless podman venue
   ```

   A reload keeps running jobs and their tunnels. Do not restart the proxy for this: a restart cuts every running
   job off.

4. **Check it** with `pi-dispatch doctor` (on the rootless podman venue, `pi-dispatch doctor --live`). The lines
   are below.

Then point the model at it in the overlay `models.json`, with the same host and port as the declaration:

```json
{"providers":{"local-ollama":{"api":"openai-completions","baseUrl":"http://host.docker.internal:11434/v1","apiKey":"$PI_DISPATCH_KEYLESS","models":[{"id":"qwen2.5:0.5b","contextWindow":32768,"maxTokens":2048}]}}}
```

A model uses an endpoint when its `baseUrl` (its own, else its provider's) has the endpoint's host and port. Host
alone does not match.

### A provider with no key

pi needs some key for a provider, even when the server ignores it. So the worker sets one fixed variable,
`PI_DISPATCH_KEYLESS=keyless`, in a job whose provider qualifies, and the provider names it as
`"apiKey": "$PI_DISPATCH_KEYLESS"`, as in the `models.json` above. A provider qualifies when all of these hold:

- pi does not know it (it is your own name, like `local-ollama`, not `openai` or `anthropic`);
- the overlay `models.json` defines it, with at least one model;
- every one of its models is served by a declared endpoint marked `"keyless": true`. One model elsewhere, or on an
  endpoint without the flag, and the provider needs a key like any other;
- its `apiKey` is exactly `"$PI_DISPATCH_KEYLESS"`. A literal key, another variable or a `!command` is refused;
- it carries no other credential of any kind: no `headers` (on the provider, on a model, or in `modelOverrides`), no
  `oauth`, and no `user:password@` in a `baseUrl`. Keyless means no credentials at all;
- every model entry has a non-empty string `id`. pi refuses the whole file over one bad entry.

The worker reads `models.json` as plain JSON. pi also accepts comments and a byte order mark; the worker does not, so
a file with either is unreadable here and no provider in it is keyless.

If the worker cannot read the file (no permission on it or its folder, a disk error, too many open files), the job
is tried again later rather than refused, and `doctor` warns `could not read models.json (EACCES)` with the error code.

Then `--provider local-ollama` runs with no key in `.env` and none in pi's `auth.json`. A provider that does not
qualify is refused before anything is spent, and the refusal names both ways in: a key, or a keyless endpoint.
`doctor` says which, with the same rules:

```
✓ Provider key: none needed (local-ollama is keyless: served by declared endpoint mac-ollama)
```

A provider pi knows (`openai`, say) still needs its key, even with its `baseUrl` pointed at your server.

With `PI_EGRESS=0` the job is on the default network and dials the server directly, by the same `baseUrl`. The worker
adds nothing to the job for it, so the name must resolve inside the container (`host.docker.internal` does on Docker
Desktop; on Docker Engine use an address the job can reach).

### How the proxy reaches your own machine

- **Docker Desktop**: `host.docker.internal` just works, and it reaches the Mac's loopback too, so a server bound
  to `127.0.0.1` answers (measured).
- **Docker Engine (Linux)**: the proxy is started with `host.docker.internal:host-gateway`, which is the bridge
  gateway, so the server must listen on that address (`172.17.0.1`, for Ollama `OLLAMA_HOST=172.17.0.1:11434`) or
  on `0.0.0.0`. A server bound to `127.0.0.1` cannot be reached.
- **Rootless Podman**: use `host.containers.internal`, with the server bound to the host's LAN address or to
  `0.0.0.0`. A server bound to `127.0.0.1` cannot be reached.
- **Another machine on your LAN**: declare its name or address. That is an ordinary route out through the proxy.

The measured routes, per runtime and version, with what each needs, are in
[`backends.md`, "Reaching a model server on the host"](backends.md#reaching-a-model-server-on-the-host). `doctor`
reads the same table.

### Slots: how many jobs use a server at once

`slots` is how many requests the server runs at once (Ollama's `OLLAMA_NUM_PARALLEL`, llama.cpp's
`--parallel`, vLLM's `--max-num-seqs`, LM Studio's default of 4). A job whose model is served by the endpoint takes
one slot when it is picked up and keeps it until it ends. When every slot is taken, the next such job waits: the
log says `endpoint_busy_deferred` with the endpoint id, and the job is tried again 7 seconds later. It is never
refused and never fails for this, and it spends nothing while it waits. Local and forge jobs both take a slot.

The worker rereads the file when you edit it, so a new `slots` applies to the next job; a broken edit is logged as
`model_endpoints_reload_invalid` and the last good file stays in force. It watches the file only when
`PI_MODEL_ENDPOINTS_FILE` names it or it existed when the worker started. If you create `model-endpoints.json`
later, restart the worker: until then `pi-dispatch egress render` has already opened the route, but no job takes a
slot.

**One server, one id.** A server on a LAN machine that several workers use (with `PI_WORKER_NAME` set on each) must
be declared with the same `id` and `slots` in every worker's file. The slots are counted under the id, so two ids
for one server, or different `slots` values, give it separate or uneven bounds. The two names
`host.docker.internal` and `host.containers.internal` are different: each one is a server on that worker's own
machine, so its slots are counted on that machine only, whatever the id. Every address, `169.254.x.x` included, is
counted across workers: a link-local address can be one neighbour that several machines share. If other workers
reach a server by its address, declare it on its own machine by that same address and id too: under the name its
slots would be counted twice, once on that machine and once across the others. Use the name only for a server no
other worker uses.

What the slots do not cover:

- **One slot per job, for the whole run.** A job that sends several requests at once (sub-agents, parallel tool
  calls) can go over `slots`. The server then queues them, or refuses past its own limit (Ollama answers 503 past
  `OLLAMA_MAX_QUEUE`).
- **Only the job's main model counts.** A model the agent switches to during the run takes no slot.
- **Across machines only with a worker name.** With `PI_WORKER_NAME` set, the slots are shared by every worker on
  the same Valkey. Without it, each worker counts only its own jobs, so two machines can each fill the server.
- If Valkey does not answer, a job takes the slot anyway (`endpoint_lease_degraded` in the log), and the count on
  this machine still holds.
- If the overlay `models.json` cannot be parsed, jobs run without taking a slot, and the log says
  `endpoint_models_unreadable`.
- Lowering `slots` while jobs run: a new job can take a lower slot while an older job still holds a higher one, so
  for a short while more jobs run than the new value. It settles as those jobs end.
- Removing or renaming an endpoint while a job holds its slot: that slot is not released by name any more and
  expires on its own, at most 35 minutes after it was taken.

### What `doctor` says about them

With nothing declared, `doctor` says nothing about model endpoints and starts no extra container. With
`mac-ollama` above declared, on Docker Desktop:

```
✓ Model endpoint mac-ollama (host.docker.internal:11434): host.docker.internal works from the proxy (measured 2026-09-30, ...). Nothing to add. ...
✓ Model endpoints: the include inside the running proxy matches model-endpoints.json (mac-ollama)
✓ Model endpoint mac-ollama answers through the proxy (GET http://host.docker.internal:11434/v1/models through a CONNECT tunnel: 200)
✓ Model endpoint mac-ollama's rule is port-exact (a CONNECT to host.docker.internal:11435, a port nobody declared, got the proxy's 403)
✓ Model endpoint mac-ollama admits no plain forward request (GET http://host.docker.internal:11434/v1/models without a tunnel got the proxy's 403 ERR_ACCESS_DENIED)
```

What each line means:

| Line | What it checks | When it fails |
|---|---|---|
| the route | whether the proxy can reach that host on this runtime, from the measured table. On rootless Podman the table is per network helper, which Podman 5 names in `podman info`; when this Podman names none, the line says so | ✗ when the table says it cannot (for example `host.containers.internal` on Docker Engine, where that name does not exist). A route nobody measured on your runtime version is said, not warned: the probes are the proof. Another machine on your LAN is said as the ordinary route out it is |
| the include | the include file as the running proxy sees it. It is compared with the file the proxy mounts (from the proxy's own inspect), and then byte for byte with what your declaration renders | ✗ when the mounted file differs from the proxy's copy: the file was replaced (a rename, an editor's save) instead of written in place, and the proxy still reads the old one, so recreate the proxy. ✗ when the proxy's copy differs from the render: run `pi-dispatch egress render`, then the reload |
| answers | a `GET /v1/models` sent the way a job sends it, through a tunnel. Ollama, llama-server, vLLM and LM Studio all serve that path | ⚠ with the proxy's status. **503** means the proxy let the tunnel through and nothing answered: the server is down, or listens where the proxy cannot reach it. **403** from the proxy means its rules do not allow it: render and reload. A **401 or 403 from the server** means the route works and the server wants a key. **No answer within 15 s** means the server took the connection and is stuck or busy |
| port-exact | a tunnel to the same host on the nearest port above yours that you did not declare for that host (never 80 or 443, which the allowlist opens for a listed host) | ⚠ when the proxy lets it through (a 503 there means it tried to connect): the rules allow more than you declared |
| plain request | a plain forward `GET` to the declared port, as a tool that does not tunnel would send it | ⚠ when anything but squid's own refusal comes back: the rules allow more than a tunnel |

A job never sees the proxy's status. Both a refused tunnel (403) and a server that is down (503) reach it as
`Connection error`, which is why `doctor` shows the number.

Two more warnings, whatever you declared:

- **An overlay model whose `baseUrl` is `localhost` or a loopback address.** Inside a job that address is the
  job's own container, with egress on or off, so no job ever reaches that server. Serve it where the proxy reaches
  it, declare it, and point the `baseUrl` there.
- **`host.docker.internal` or `host.containers.internal` in `egress-allowlist.conf`**, or an entry such as
  `.internal` that covers it. That opens the host's port 443 and port 80 to every job, and no model server port.
  Remove it and declare the server instead.

On the rootless podman venue a plain `doctor` reads the route and the include, and `doctor --live` runs the three
probes, beside the egress canary and on its network. The probe containers are named
`pi-dispatch-egress-probe-endpoint-<probe>-<id>-<pid>` and are removed with the canary's own; a run that was
killed leaves them to the next run's sweep, like the canary's.

### Walkthrough: Ollama on a Mac with Docker Desktop

Zero spend.

1. On the Mac: `ollama pull qwen2.5:0.5b`.
2. Put the overlay `models.json` above in your overlay folder (`PI_GLOBAL_PI_DIR`).
3. Declare `mac-ollama` as in step 1 of "Declare, render, reload", with `"slots": 1`.
4. `pi-dispatch egress render`, then the reload it prints.
5. `pi-dispatch doctor`. Expect the five lines above: the route, the include, a 200, a 403 for the CONNECT to port
   11435, and a 403 for the plain `GET` to port 11434, and the provider line `keyless: served by declared endpoint
   mac-ollama` when `PI_PROVIDER=local-ollama`.
6. Run a job on it with `--provider local-ollama --model qwen2.5:0.5b`. It needs no key. Its record shows cost `$0`.
   A worker you start by hand reads your shell's environment, not `.env` (`doctor` says so): export the `.env`
   first, or run the installed service.
7. Start two such jobs at once. They share the one slot: the second logs `endpoint_busy_deferred` until the first
   ends, then runs.

### Upgrading a deployment from before #503

An existing deployment needs the new file, the new rules and the new mount: run `pi-dispatch init` (it only adds
what is missing), then `pi-dispatch up`, which offers the rules refresh and the proxy's replacement as one step.
On the rootless podman venue `pi-dispatch service install --force` refreshes the account's rules and the unit
together. With compose, use the new compose file (see "Right after an upgrade" below), then
`docker compose ... --profile egress up -d` recreates the proxy. Until the rules include the file, `up`, `doctor`
and `egress render` all say the endpoints stay unreachable until the rules are refreshed, and `doctor` says
nothing more about them.

## The shape

| | |
|---|---|
| One `--internal` network **per job** | `pi-job-<id>-net`, created at job start and removed at job end. Holds exactly two endpoints: the container and the proxy. If the worker dies before it can remove one, the next boot removes it, detaching whatever is still on it first, and says so in the log if it cannot. |
| One long-lived proxy | `pi-dispatch-egress-proxy`, squid, filtering by hostname. Exactly two shapes pass, both to a listed host: a `CONNECT` tunnel to port 443, or a plain (untunnelled) request to port 80. Nothing else passes (issue #508), except a model server you declare, which is a `CONNECT` tunnel to its one host and port ("Local model servers" above, issue #503). "A plain request to port 80" also covers squid's own gateways for other schemes, but only to port 80 (`ftp://host:80/`, `https://host:80/`); every other scheme and port is refused. A plain forward request for an `https://` URL on 443, where the proxy would open the TLS itself, is refused too. A listed name that resolves to one of this host's fixed loopback or link-local addresses (or slirp4netns's `10.0.2.2`) is refused (issue #428). The allowlist is matched as written (`dstdomain -n`): an IP-literal request is refused unless that literal is itself listed, and the proxy makes no reverse lookup of it. A host mapped to another address (pasta's `--map-host-loopback <address>` or `--map-gw`, slirp4netns's `cidr=`) is not covered here; on the `podman` venue the worker refuses the containers.conf that would do that, and the account's running rootless network while it still does after the key is gone (issue #450). Publishes no port. |
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
✓ Egress policy refuses plain HTTP to a listed host off port 80 (api.anthropic.com:443 without a tunnel; only a CONNECT reaches 443)
```

### On the native `podman` venue

A deployment whose `PI_BACKENDS` lists `podman` gets the same canary for that venue, run by
`pi-dispatch doctor --live` under the worker account's own rootless Podman (issue #431), because that is where
the proxy its jobs use lives and where their containers start. Its probe containers are built the way a podman
job is (your uid as `--user`, `--userns=keep-id`, the venue's pinned flags, a job's proxy variables and HOME, no
mount), so a pass is about what a job gets. Its lines carry the section's prefix and come before the read-back's:

```
✓ podman: Egress policy reaches the provider (api.anthropic.com answered, so the whole path works and no key was spent)
✓ podman: Egress policy denies an unlisted host (the deny direction is the half an allowlist can silently lose)
✓ podman: Egress policy refuses plain HTTP to a listed host off port 80 (api.anthropic.com:443 without a tunnel; only a CONNECT reaches 443)
✓ read back on podman: egress holds (the provider was reached, an unlisted host was not, and plain HTTP off port 80 was refused)
```

A plain `pi-dispatch doctor` does not run it there: the first keep-id start of an image copies its layers, which
takes half a minute, and `--live` is where this venue already starts job-shaped containers. It says so in one ⚠
line pointing at `--live`. The leftover lines below apply on that venue too, with `podman` in place of `docker` and
the same prefix, and a canary network a killed `--live` left behind is removed by the next `--live`. Two differences
there (issue #452). Podman 4.9's `network inspect` shows no containers, so what is on a network is read with
`podman ps -a --filter network=<net>`, and the "could not be read" line names that command instead of the inspect.
And Podman will not remove a network while any container is on it, stopped ones included, so the sweep also removes
a probe that has stopped and detaches anything else that has, where docker would have removed the network around
them.

### Lines about leftovers

You may also see a line about a leftover. Those are the canary's own objects, `pi-dispatch-egress-doctor-<pid>`
and its three probe containers, plus three more per declared model endpoint. The rule is simple enough to rely on: **every one of them is removed at the end
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
| `⚠ Egress canary: <net> is kept with what is running on it, because <why>` | the daemon behind your `docker` CLI is a rootless Podman 4.x (reached through `podman-docker`, or its Docker API) or could not be identified, and the rootless network keeper does not hold, so nothing was detached: detaching the running egress proxy there cuts its route out for every job until it restarts (issue #458) | start the keeper as docs/podman.md step 6 shows, then re-run doctor, which removes the network once the keeper holds |

<!-- /CANARY-LINES -->

The provider and unlisted-host lines each run a throwaway container on a throwaway network, using **your job image's own node and
its runner's own module** (pi loaded, then the runner's proxy restore, issue #427), so they prove the route your jobs'
provider calls take once the runner has called that module; that it does, before its first request, is checked in CI. (Before #427 they used a plain `fetch`, which never loads pi and stayed green while every job
failed.) They cost nothing: `api.anthropic.com` answers `401` to an
unauthenticated request, so reaching the provider and being refused for the key proves the whole path
without spending a token. The deny probe asks for `example.com`, a host that resolves and answers, so a proxy
that lets everything out is caught; it is only contacted if your proxy lets the request out, which is the
finding. A probe container that does not run at all is reported as not run, never as a deny.

The third line (issue #508) runs a third container the same way, but not the runner's route: that route tunnels
every request, so it would only ever send a `CONNECT`. This one sends a plain forward request with raw `node:http`,
`GET http://api.anthropic.com:443/`, the way a tool that forwards plain HTTP would (npm undici's `EnvHttpProxyAgent`
without `proxyTunnel`, a package manager, or a `curl -x` a job brings). It asks for port
443 because that host certainly listens there, so a proxy that lets the request through gets an answer (a `400` for
clear text on a TLS port) instead of a timeout, and nothing extra has to be listed. It counts as refused only when
squid itself refuses it: a `403` with an `X-Squid-Error` header starting `ERR_ACCESS_DENIED`. Any other answer means
the proxy let it through. A proxy that cannot be reached or never answers is no reading. The check is best effort:
an upstream on port 443 that answered clear text with a `403` and a forged `X-Squid-Error` header would read as
refused, which needs control of the provider's own answer.

**Right after an upgrade this line can fail.** squid reads its rules only at start, so until the proxy restarts on
the refreshed `egress-proxy.conf` it still runs the old rules: the line reads `Egress policy lets plain HTTP through
to api.anthropic.com on port 443, ...` and `--live`'s egress verdict fails. `pi-dispatch up` refreshes the file and
restarts the proxy (or replaces it, when it lacks the third mount); on the `podman` venue `pi-dispatch service
install --force` does. A proxy you started by hand must be RECREATED, never just restarted, since the new rules
include `model-endpoints.conf` and it does not mount that file: remove it (`docker rm -f -v
pi-dispatch-egress-proxy`, or `podman rm -f -v`) and start it again with the third mount (`pi-dispatch up` does
this, or the recipe in [podman.md](podman.md)). With compose, the compose file must be the new one too: in a
folder `/dispatch setup` laid out, `deploy/docker-compose.yml` is a create-only copy no upgrade refreshes, so copy
it again from the installed package (or pull the clone), or use `pi-dispatch up` instead.

**With the policy on, a forge must be served over `https://` on port 443.** A job gets the proxy variables in
uppercase only, and git ignores `HTTP_PROXY` for an `http://` remote, so it never sends one through the proxy: from
behind the job's `--internal` network an `http://` forge fails on any port, 80 included (measured in the job image,
git 2.39.5; this was so before issue #508 too). An `https://` remote is a `CONNECT`, which the proxy refuses to any
port but 443. The clone runs on the host before the container exists, so with an `http://` forge it is a job's
git push and fetch that fail; on a port other than 80 its API calls fail too (glab and tea do use `HTTP_PROXY`, and
port 80 is allowed). `pi-dispatch doctor` warns when `GITLAB_URL` or `FORGEJO_URL` is anything but `https://` on 443. The ways
out are `https://` on 443, or `PI_EGRESS=0`.

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
on their own, never after pi was loaded, which is the runner's case. The pinned pi (0.80.7 at the time) depended on npm
`undici` 8.5.0 (0.99.1, the pin now, carries 8.10.2 and does the same, issue #509), and loading it replaces the global dispatcher the flag installs with one that ignores the proxy
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
entrypoint against a stub proxy. pi and the runner always tunnel (`proxyTunnel: true`, as pi's own CLI does
since undici 8.7 stopped tunnelling `http://`). So a provider configured with an `http://` URL is a CONNECT to
that URL's port, and the shipped policy refuses it unless the port is 443. A tool that forwards plain HTTP
instead, such as npm undici's `EnvHttpProxyAgent` without `proxyTunnel` or a package manager, gets port 80 of a
listed host and nothing else (issue #508).

## What this does not buy you

An allowlist bounds **where** an induced agent can send your environment. It does not prevent it. Your
forge is on the list, because a job that cannot push has nothing to do, and a repository is a perfectly
good place to write a secret to. `SECURITY.md`'s disclosure stands whether or not you turn this on, and the
credential's scope and expiry remain what actually bound the damage.

It also accounts for nothing. A staged package that spawns a `pi` subprocess spends against the provider
host, which is on the allowlist by necessity, and a proxy that does not decrypt cannot count tokens
(`OQ-011`).

Plain HTTP to port 80 of a listed host is allowed, because some package mirrors and redirects still use it
(issue #508). Whatever a job sends that way crosses the network in clear text.

And it does not hide **this host** from the job. `--internal` stops the network routing anywhere beyond
itself, but its gateway is still the host, so a service listening on `0.0.0.0` there answers a job container
that dials the gateway address. Measured on Docker 27.5.1 and on rootful Podman 5.8.2 alike: a listener on
`0.0.0.0:9999` answered from inside a job, while one bound to `127.0.0.1` gave `ECONNREFUSED`, as did a port
with nothing behind it. That loopback binding, not `--internal`, is what keeps a job out of your queue, as long
as nothing maps the host's loopback into a container's network; on the native `podman` venue an account's
containers.conf can, and the worker refuses the venue while it does (issue #428, docs/podman.md step 4). That is
why `deploy/docker-compose.yml` publishes Valkey on `127.0.0.1:6379` and never on `0.0.0.0`. Bind your own
host services the same way, or put the firewall layer in the appendix below them.

## How this was verified

All of it was run. The method costs nothing and is worth repeating on your own host.

- **The whole path, end to end**, with the shipped compose profile and a real per-job network: the provider
  answered `401` in 228 ms, an unlisted host was denied in 18 ms, and `api.github.com` answered in 205 ms
  through the `.github.com` rule.
- **The port rule for plain HTTP** (issue #508), measured on 2026-09-30 with the pinned squid (6.13) on Docker
  29.1.3, rootless Podman 4.9.3 and rootless Podman 5.8.1 (SELinux enforcing), all three alike. Before the rule, a
  plain `GET` to a listed host on port 8080 answered `200`; after it, `403`. Port 80 answered `200` before and after.
  A `CONNECT` to port 8080 was `403` both times. A plain `GET http://api.anthropic.com:443/`, the canary's third
  probe, got Cloudflare's `400` before and squid's `403` with `X-Squid-Error: ERR_ACCESS_DENIED` after. A plain
  forward `GET https://api.anthropic.com/` made squid open the TLS itself before (`503`), and is `403` after. An
  unlisted name was never resolved, before or after. npm undici 8.10.0's `EnvHttpProxyAgent` without
  `proxyTunnel` went from `200` to `403` on port 8080 and stayed `200` on 80. Node 22's built-in `fetch` with
  `NODE_USE_ENV_PROXY=1` sends a `CONNECT` even for `http://`, so it was already refused off port 443.
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
