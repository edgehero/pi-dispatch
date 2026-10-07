# Podman

pi-dispatch runs jobs on Podman two ways. Rootful Podman is reached through Podman's Docker API, with the real
`docker` CLI pointed at Podman's socket, and is the `local` venue. Rootless Podman is a venue of its own, `podman`,
where the worker runs the `podman` CLI itself, as its own account, and every job runs as that account's uid with
`--userns=keep-id` (issue #354). Rootless Podman reached through its Docker API is still refused by name, and
Podman's `podman-docker` emulation of the `docker` command runs jobs but is not supported. Every rule below is about
a runtime on the worker's own host: a docker endpoint somewhere else is a different question, and the last row of
the next table says what happens there. This page says what each setup gets, how that was measured, and how to set
up the two supported ones. `docs/backends.md` explains the words used below.

## Supported and refused

| Setup | What happens |
|---|---|
| Rootful Podman on Linux, real docker CLI through a docker context | **Supported.** Jobs run as the worker's own uid (`--user`), unless the worker is uid 1001, where the image already runs as that uid and no `--user` is passed. One rootful setup is still refused as `rootless`: a socket this worker's own uid owns (a `SocketUser=` override), which reads exactly like a rootless daemon's socket. Give the worker access through a GROUP, not by owning the socket. |
| Rootless Podman on Linux, through the native `podman` venue (`PI_BACKENDS=podman`) | **Supported** (issue #354). The worker spawns `podman` as its own account, and every job runs as that account's `<uid>:<gid>` with `--userns=keep-id`, so the uid that owns the job's `0700` directories on the host is the uid inside the container. The job image must declare `anyUid` unless the worker is uid 1001. Setup is under "Rootless Podman, the native venue" below. |
| Rootful Podman, or a Podman service on another machine, through the native `podman` venue | **Refused**, `podman-rootful` and `podman-remote`. A rootful Podman is the `local` venue through its Docker API (above), and measured, a rootful `podman run --userns=keep-id` is not refused by Podman: it runs with the identity map and adds root's group to the process. A remote service would take the provider key and the forge token off this host. The venue also refuses a worker running as root (`worker-is-root`), a host that is not Linux (`podman-platform`: Podman machine is unmeasured), and an account with no `podman` to run (`podman-not-found`). |
| Rootless Podman through its Docker API | **Refused**, cause `rootless`. The only uid that can use the job's `0700` job directory there is container root, which `nonRoot` forbids. Use the native `podman` venue instead. |
| Rootless Podman with `userns = "keep-id"`, through its Docker API | **Refused the same way**, and this one is a limitation rather than a verdict: keep-id would map the worker's uid into the container, but set in containers.conf it is a per-container mapping that `docker info` does not report, so the worker cannot tell it from plain rootless. The native `podman` venue passes `--userns=keep-id` on each job's own argv instead, which is why it can use it. |
| Rootful Podman reached through `podman-docker` (the `docker` package that emulates the command) | **Runs, not supported.** The job user decides `worker` mode and jobs run as your uid, but it resolves no docker context, so `credentialTransit` is never observed and `pi-dispatch doctor --live` does not run. doctor warns. |
| Rootful Docker Engine | The reference. Every word the backend table declares. |
| Podman on ANOTHER machine (`DOCKER_HOST=ssh://...`, or a service reached over TCP) | **Not refused, and not the same thing.** The bind-mount sources are that machine's paths, so no rule about this host's uids applies: the job runs as the image's own user, `credentialTransit` degrades to `asserted`, and doctor says the endpoint is not on this host. A rootless daemon reached that way is NOT refused by name. One client escapes this row: Podman's own, through `podman-docker` with a `podman system connection` over ssh, which resolves no docker context and reports the remote service's own unix path. That reads like a local socket, so the ordinary rules decide instead, and a rootless daemon there is refused as `rootless` (a residual `DES-JOB-USER-INFERRED-READ-BACK-ON-REQUEST` names). |

Refused for the same reason on either runtime: **rootless Docker** (`rootless`) and **a Docker daemon with
userns-remap** (`userns-remap`), both of which map container uids away from the worker's, exactly as rootless Podman
does. Podman never reports `name=userns` (measured: the compat API's `SecurityOptions` carries `name=seccomp`,
`name=selinux` on a host with SELinux enabled, and `name=rootless` when rootless, and never `name=userns`; on an
enforcing Fedora 44 host it is `["name=seccomp,profile=default","name=selinux"]`), so a rootful Podman configured with `userns = "auto"`
is not refused by name. What a job does there is **unmeasured** (`OQ-037`): the container either fails to create,
because `--user` names a uid outside the namespace Podman allocated, or it starts and the runner's own `/job` check
stops it at exit 2 (`job-inputs-unreadable`). Those two differ in what they cost a job, so the page does not claim
one until it is measured.

Refused per job, on the `--user` path only, so a worker that would otherwise boot still refuses each local job: a
worker whose primary group is gid 0 (`root-group`) or the container socket's group (`docker-group`), and a job image
that does not declare `anyUid` (`job-image-any-uid-unsupported`). All three are on the `--user` path, so a worker
that runs as **uid 1001** meets none of them: the image already runs as that uid, nothing is passed, and a uid-1001
worker whose primary group is the socket's group is not refused. That is deliberate, so hosts that worked before
issue #341 keep working. A worker running as root (`worker-is-root`) is refused too, and belongs to the harder set:
`BOOT_REFUSING_JOB_USER_CAUSES` in `worker/src/job-user.mjs` names the causes no job on this venue can get past, and
`pi-dispatch doctor` marks those ✗ and everything else ⚠ on your own host -- ✗ only while `local` is the default
venue, which is the condition `DES-JOB-USER-INFERRED-READ-BACK-ON-REQUEST` states and this page used to read
straight past. Since issue #354 the condition is a real one: `PI_BACKENDS=podman,local` makes `podman` the default,
and a worker configured that way boots and refuses each local job instead. Everything in this section is the
`local` venue's; the native `podman` venue decides its job user from `podman info`, and its refusals are listed in
its own section below.

### What a refusal says

The worker prints the refusal it acts on, so an operator can match a line against this page. These are its sentences,
verbatim from `worker/src/job-user.mjs`, which a test pins to the page:

<!-- PODMAN-REFUSAL-TEXTS -->
```
# rootless Docker or Podman (at boot when local is the default venue, else per job)
Refused: the container runtime runs rootless (a user namespace between the job and this worker), so no uid a job may run as can read the worker's 0700 job dir; run jobs on a rootful Docker or Podman daemon. If this was inferred from a socket this worker's uid owns on a rootful daemon (a systemd SocketUser= override), point the worker at the daemon's own socket (issue #341).

# a Docker daemon with userns-remap (at boot when local is the default venue, else per job)
Refused: the Docker daemon remaps container uids (userns-remap), so no uid a job may run as can read the worker's 0700 job dir; run jobs on a daemon without userns-remap (issue #341).

# a worker running as root (at boot when local is the default venue, else per job)
Refused: the worker runs as root, and a job must not run as root (nonRoot); run the worker as an unprivileged account, as deploy/worker.service's User= does (issue #341).

# a worker whose primary group is gid 0 (per job, on the --user path)
Refused: the worker's primary group is gid 0, and a job runs with that group; run the worker with an unprivileged primary group (issue #341).

# a worker whose primary group is the socket's (per job, on the --user path)
Refused: the worker's primary group is the docker socket's group, and a job runs with that group; make docker a supplementary group (log out and back in rather than `newgrp docker`) (issue #341).

# a job image without anyUid, and a worker that is not uid 1001 (per job)
Refused: the job image does not declare `anyUid` (`dev.pi-dispatch.capabilities`), so it cannot run as this worker's own uid, which this host's container runtime requires; rebuild it from a release that has this feature, or run the worker as uid 1001 (issue #341).

# Docker Desktop on Linux outside WSL (at boot when local is the default venue, else per job)
Refused: Docker Desktop on Linux maps container uids like a rootless daemon, so no uid a job may run as can read the worker's 0700 job dir; use Docker Engine on this host (WSL2 is not affected) (issue #341).

# a daemon whose answer no rule reads (per job)
Refused: the docker CLI answered `docker info` with something no rule can read, so which uid a job may run as is unknown; point the real docker CLI at a Docker or Podman daemon (issue #341).
```
<!-- /PODMAN-REFUSAL-TEXTS -->

`pi-dispatch doctor` prints the same fix text beside its own ✗ or ⚠ line, without the `Refused:` prefix and without
the issue number. `pi-dispatch sandbox` prints it with the issue number for the daemon causes, and substitutes its
own wording for a missing `anyUid` and for a run whose manifest carries no job user. A forge job gets a shorter
fixed comment instead, because a comment's reader may not be the operator, and no refusal text carries a path, an
endpoint or CLI output.

Which of them is a ✗ and which a ⚠ is one list in the code, `BOOT_REFUSING_JOB_USER_CAUSES`, under the same
condition as above: a cause no job on this venue can get past fails doctor while `local` is the default venue,
and the rest warn. What each does to a worker and to a job is the job-user rule's
and is written down there, not here. Five of the eight
were seen on a terminal in the lab (`rootless`, `worker-is-root`, `root-group`, `docker-group` and the missing
`anyUid`); the other three are that same list, not a separate claim.

Degraded on the Docker API route, never refused unless a `PI_BACKEND_FLOOR` asks for the word (the native venue
observes its own, see its section):

- **`isolation` is `asserted` on every Podman host reached through its Docker API.** The rule stops at "the daemon is
  Podman" and reads no further, because what it would read carries no information: Podman's Docker API reports
  `PidsLimit` and `MemoryLimit` whether or not a container's bounds apply. The bounds themselves DO apply on rootful
  Podman (measured at the default size: `pids.max` 512 and `memory.max` 4 GiB in a job container, a fork run stopped at 504 children, a 64
  MiB job killed with 137), and `pi-dispatch doctor --live` reads them back off a real container, which is the way to
  earn the word here.
- **`mountSet` is `asserted` without an empty `/etc/containers/mounts.conf`.** Stock Fedora and RHEL Podman mounts
  `/run/secrets` into every container, with the host's subscription files where they exist, and `docker inspect`
  does not show it. The empty override removes it, and the worker then credits `mountSet` (see Setup). The files it
  reads are **this host's**, so a client talking to a Podman service on another machine over a unix path can be
  credited for files that daemon never reads. `pi-dispatch doctor --live` is what settles it: it reads the
  container's own `/proc/self/mountinfo`.
- **`credentialTransit` is `asserted` under `podman-docker`.** The shim resolves no docker context, so the worker
  never observes that the CLI sends containers to a daemon on this host. Measured: through the shim
  `docker context ls` prints a header row and nothing else, and `docker context inspect` prints nothing at all.

## Setup (rootful Podman, through its Docker API)

Steps 1 to 3 are the documented route on a systemd host, which the nested lab could not exercise (its Podman ran as
a bare `podman system service` with a hand-made socket group, because a container has no systemd). On a Fedora 44
host on 2026-09-25 steps 1 and 2 were followed literally: step 1 works as written, and step 2 did not give the worker
the socket until the `tmpfiles.d` override it now carries. Step 3 was done with Fedora's own packages in place of
Docker's. Steps 4 to 8 were measured in the lab; on that host steps 4, 5 and 7 were followed as written, the image
was pulled with root's `podman pull` in place of step 6's `docker pull`, and of step 8 `pi-dispatch doctor --live` was run
and `pi-dispatch up` was not.

1. **Start Podman's socket as root:** `sudo systemctl enable --now podman.socket`. It listens on
   `/run/podman/podman.sock`, owned by root.
2. **Give the worker's account access to it through a GROUP.** Access to this socket is root on the host, exactly as
   the docker group is. Fedora ships no `podman` group and its unit sets no `SocketGroup`, so make both:

   ```sh
   sudo groupadd --system podman
   sudo systemctl edit podman.socket          # writes the drop-in below
   ```

   ```ini
   [Socket]
   SocketMode=0660
   SocketGroup=podman
   ```

   `systemctl edit` needs a terminal (without one it says `Cannot edit units interactively if not on a tty`); from a
   script, pipe the same three lines into `sudo systemctl edit --stdin podman.socket`. Then
   `sudo systemctl daemon-reload && sudo systemctl restart podman.socket` (editing the drop-in changes nothing
   until the unit is restarted), `sudo usermod -aG podman <worker account>`, and log in again.

   **The socket's directory needs the group too.** Podman's own `/usr/lib/tmpfiles.d/podman.conf` creates
   `/run/podman` as `0700 root root`, so a group on the socket inside it reaches nobody. Measured on Fedora 44 with
   Podman 5.8.1: after every step above and a fresh login, the worker still got `Permission denied` on the socket, and
   `ausearch -m avc` was empty, so this is file modes, not SELinux. Override that one line, so it holds after a reboot:

   ```sh
   sed 's|^D! /run/podman 0700 root root$|D! /run/podman 0710 root podman|' /usr/lib/tmpfiles.d/podman.conf \
     | sudo tee /etc/tmpfiles.d/podman.conf >/dev/null
   sudo chgrp podman /run/podman && sudo chmod 0710 /run/podman    # the same, now, without a reboot
   ```

   A file in `/etc/tmpfiles.d` replaces the vendor file of the same name whole, which is why this is a copy with one
   line changed rather than that line alone. `0710` lets the group reach the socket by its name and list nothing.
   Measured: the worker reached the socket at once, and again after a reboot.

   Two rules about that
   group: it must not be the account's PRIMARY group, because a job runs with the worker's primary group and the
   worker refuses one that can reach the socket (`docker-group`); and do not give the worker the socket by making it
   the socket's OWNER (a `SocketUser=` override), because a socket owned by the worker's own uid is what a rootless
   daemon looks like, and the worker refuses it as `rootless`.
3. **Install the real docker CLI and its compose plugin** (`docker-ce-cli` and `docker-compose-plugin` from Docker's
   repository), not `podman-docker`. If `podman-docker` is installed, remove it first: it owns `/usr/bin/docker`, so
   the two packages conflict over that path. Fedora's own `docker-cli` and `docker-compose` packages work too
   (measured on Fedora 44: docker-cli 29.7.2 and compose 5.5.1, installed with `--setopt=install_weak_deps=False`,
   which pulled in no daemon and no `docker.service`).
4. **Remove Podman's default mounts** so `mountSet` holds: `sudo sh -c ': > /etc/containers/mounts.conf'`. The file
   must exist and be EMPTY. Leave `volumes`, `mounts`, `devices` and `hooks_dir` unset in containers.conf and its
   drop-ins, and install no OCI hooks, or the worker gives `mountSet` no credit. It reads the same containers.conf
   files the check below reads (root's own, `--module` files and the `CONTAINERS_CONF` files included), and the
   worker must be able to READ every one of them but root's own config home, which it names rather than judges; it
   must also read `mounts.conf` and the hook directories, and FIPS mode must be off, because a FIPS host mounts its
   crypto policy into every container. A change to `mounts.conf` needs no restart: the running service reads it for
   each container (measured). A change to a containers.conf does: the running service keeps the one it started with
   (measured with `volumes`), so until `sudo systemctl restart podman.service` the worker gives `mountSet` no credit
   and holds local jobs back (a hold, not a refusal). More keys are refused outright on this route: see "What rootful
   Podman's containers.conf must not set" below.
5. **Point the docker CLI at Podman with a context**, as the worker's account:

   ```sh
   docker context create podman --docker host=unix:///run/podman/podman.sock
   docker context use podman
   ```

   A context rather than `DOCKER_HOST`, so the worker, the CLI you type into and the panel all resolve the same
   daemon. `DOCKER_HOST` set in one environment and not another is how two of them end up on different daemons.
   Either works for the daemon itself: the lab's measurements were taken with `DOCKER_HOST` set and the Fedora 44
   host's through this context, and nothing failed for either, `credentialTransit` included. The context is about the
   three surfaces agreeing with each other.
6. **Load the job image and name it as Podman stores it.** `docker pull ghcr.io/edgehero/pi-job:latest`, then set
   `PI_JOB_IMAGE` to the name `docker images` shows for it.
7. **Start the stack the same way you would on Docker.** It is the same compose file:
   `docker compose --env-file .env -f deploy/docker-compose.yml up -d` for Valkey, and `--profile egress` as well if you use the
   egress policy. That file is in a clone's `deploy/`; a folder made without a clone does not have it, and
   `pi-dispatch up` there starts Valkey and the proxy through the same docker CLI the worker uses instead (not
   separately measured on this venue). Podman serves it through the same Docker API, and compose needs no adaptation (measured with
   v2.33.0 in the lab and 5.5.1 on Fedora 44). Its config mounts carry `:ro,z` for an SELinux host (see SELinux
   below), which does nothing where SELinux is off. `podman compose` is not a second implementation: it executes
   whatever compose provider it finds, which on a host set up this way is that same binary, and it says so on stderr.
   `--env-file .env` is how compose reads the deployment's `VALKEY_PASSWORD` (issue #468) into the Valkey's
   environment. Measured on Fedora 44 through root's Podman socket with compose 5.5.1: a first `up -d` from a `.env`
   without the key started Valkey with no password as before; the same command after the key was added recreated the
   container, which then answered `NOAUTH` to a client with no password and kept the key written before (the volume
   is kept), and no command line on the host carried the password meanwhile.
   In a folder `/dispatch setup` laid out (PR #475's review), the file sits in `deploy/` of that folder and every
   command names the folder's project, `docker compose -p <folder name> ...`, since compose otherwise names the
   project after `deploy/` and every such folder would share one. The name is the folder's, as compose normalises a
   directory name: lower case, only letters, digits, `_` and `-`, no leading `_` or `-` ("My Deploy.v2" is
   `mydeployv2`). Two edge cases: a folder whose name has none of those characters (all non-ASCII, "日本") gets
   `pi-dispatch`, where compose itself would refuse the folder's name; and a `COMPOSE_PROJECT_NAME` in the folder's
   `.env` named the project of an earlier setup's copy, which `-p` overrides, so set `-p` to that value if you
   relied on it. Where `pi-dispatch up` had already started the deployment's Valkey, setup also writes
   `deploy/docker-compose.valkey.yml`, which gives compose's Valkey that same volume (`pi-dispatch-valkey-data`); the
   commands then carry `-f deploy/docker-compose.valkey.yml` too, and `up` itself starts compose's Valkey there. The
   Valkey is published on `PI_VALKEY_PORT` (VALKEY_URL's port, 6379 unset), which `up` and setup write into `.env`
   when it is not 6379. Neither ever stops, removes or starts beside a Valkey that is not this folder's: `up` labels
   its `pi-dispatch-valkey` with the folder, and a container on `pi-dispatch-valkey-data` that another deployment
   started makes both refuse, naming it (stop that deployment's Valkey first, or give this folder a Valkey of its own:
   compose without the override keeps its own volume). The volume itself carries the folder that created it, and
   the queue inside records it too (`pi-dispatch:owner`): another folder's is never used, and a volume from before the
   label is used only after `up` asks (even under `--yes`), since its queue cannot be attributed to a folder; `up`
   then reads whose queue it holds with a Valkey that has no network before publishing one, and records the adoption
   in `.pi-dispatch-valkey-volume.json` (by the volume's creation time), so it does not ask about that volume again.
   One file for both daemons is not one file for two stacks: it fixes the proxy's container name, the egress
   network's name and Valkey's published port, so one host runs one of these stacks (true on Docker too).
8. **Run `pi-dispatch up`, then `pi-dispatch doctor --live`.** doctor names the runtime (`local: the daemon is Podman
   5.8.2, through its Docker API`), and `--live` reads the declarations back off real containers on this daemon.
   On an SELinux host, read the next section before the first job.

### What rootful Podman's containers.conf must not set

Rootful Podman's API service applies its own containers.conf to every container it starts, a local job's included,
and no flag on the job's command line takes some keys back. Measured on the Fedora 44 host (rootful Podman 5.8.1
behind `podman.socket`, the job argv the worker builds, on the default network and on an `--internal` one, issue
#448), each key alone in a `containers.conf.d` drop-in (the first two also in `/etc/containers/containers.conf`),
the service started fresh for each, and again on Ubuntu 24.04 with rootful Podman 4.9.3 (`apparmor_profile` there
alone, since Fedora runs no AppArmor; `label` reached a job on Fedora alone, since Ubuntu runs no SELinux).

The rule: a key is **refused** when what the job saw crossed a boundary the worker's argv sets (what the job may reach,
run, read or be limited by), or when it could not be measured; **inert** when the argv, or the Docker API request it
becomes, overrode it; **harmless** when it reached the job and moved nothing that is a boundary (the job's time zone,
or Podman writing no `/etc/hosts` at all), which is documented and not refused.

<!-- PODMAN-ROOTFUL-KEY-TABLE -->
| Key | What the job saw | Decision |
|---|---|---|
| `annotations` | `run.oci.keep_original_groups=1`: the API service's own supplementary groups (with `SupplementaryGroups=podman` on the unit it read a `root:podman 0640` file) | refused |
| `env` | its variable, past the worker's closed environment | refused |
| `helper_binaries_dir` | the netavark and aardvark-dns set up for its network were the named directory's, run as root | refused |
| `default_sysctls` | the sysctl it named (`ip_unprivileged_port_start` 77), in place of the vendor's own | refused, except the vendor's own block |
| `default_ulimits` | the limit it named (`nofile` 333) | refused |
| `userns` | `auto` with no subordinate range: the container could not be created | refused |
| `pidns` | `host`: the container could not be created (against the argv's `--init`) | refused |
| `ipcns` | `host`: the container could not be created (against the argv's `--shm-size`) | refused |
| `utsns` | `host`: the host's UTS namespace and hostname | refused |
| `cgroupns` | `host`: the host's cgroup namespace | refused |
| `netns` | `host`: the host's network namespace, on the default network | refused |
| `seccomp_profile` | the named profile (one denying `uname` aborted the job's node) | refused |
| `apparmor_profile` | `unconfined` in place of its `containers-default` profile (on Ubuntu) | refused |
| `init_path` | the named binary as its PID 1 | refused |
| `dns_servers` | the named nameserver, on the default network | refused |
| `dns_options` | the named resolver option | refused |
| `dns_searches` | the named search domain | refused |
| `base_hosts_file` | the named file's lines in its `/etc/hosts` | refused |
| `label` | `false`: it ran as `spc_t`, unconfined by SELinux (on Fedora) | refused |
| `cgroup_conf` | `pids.max=max`: its pids limit gone, past the argv's `--pids-limit` | refused |
| `host_containers_internal_ip` | the named address as `host.containers.internal` | refused |
| `runtimes` | a runtime in the `[engine.runtimes]` table: that wrapper created every job (the stock header alone, every entry commented, passes) | refused |
| `conmon_path` | that wrapper monitored every job | refused |
| `cgroups` | `disabled`: its pids and memory bounds unapplied | refused |
| `pasta_options` | nothing: rootful Podman runs no pasta for these networks | inert |
| `network_cmd_options` | nothing: nor slirp4netns | inert |
| `network_cmd_path` | nothing: no slirp4netns ran | inert |
| `default_capabilities` | nothing: the argv's `--cap-drop=ALL` | inert |
| `no_new_privileges` | nothing: the argv's `no-new-privileges` | inert |
| `init` | nothing: the argv's `--init` | inert |
| `oom_score_adj` | nothing: the Docker API request sets its own (on Fedora and on Ubuntu) | inert |
| `pids_limit` | nothing: the argv's `--pids-limit` | inert |
| `shm_size` | nothing: the argv's `--shm-size` | inert |
| `privileged` | nothing: the Docker API request sets its own (on Fedora and on Ubuntu) | inert |
| `env_host` | nothing: the service's own environment did not reach it | inert |
| `umask` | nothing: its umask stayed 0022 | inert |
| `http_proxy` | nothing: a proxy in the service's environment reached no job, the key absent, true or false | inert |
| `tz` | the named time zone | harmless |
| `no_hosts` | no `/etc/hosts` at all | harmless |
<!-- /PODMAN-ROOTFUL-KEY-TABLE -->

So the `local` venue refuses to run a job while any containers.conf the service reads sets a key the table marks
refused, whatever the value, at boot when `local` is the default venue and before each local job's spend otherwise, as
`podman-conf-widens-job`. The one exception is the vendor's own `default_sysctls = ["net.ipv4.ping_group_range=0 0"]`,
uncommented in the stock containers.conf of Fedora 44 and Ubuntu 24.04: exactly that block is accepted, because
refusing every stock host would be worse and the exception is exact, and any other value, spelling or a second sysctl
beside it is refused. `pi-dispatch doctor` prints the refusal beside its `local: the daemon is Podman` line. The check
runs only where the docker CLI reaches rootful Podman through a unix socket on this host: a Docker daemon, a rootless
Podman and a Podman service on another machine read no file and get what they got before.

**The files it reads are the ones the service reads** (containers/common v0.67.0, each place measured with a drop-in):
`/usr/share/containers/containers.conf`, `/etc/containers/containers.conf` and every `*.conf` in
`/etc/containers/containers.conf.d` (not `/usr/share/containers/containers.conf.d`, nor either
`containers.rootful.conf.d`, which neither Podman read); root's own `~/.config/containers/containers.conf` and its
`containers.conf.d` (honoured with no `HOME` in the unit); every `--module` the service is started with, in its
`ExecStart` or in a variable such as `LOGGING=` (measured honoured), resolved under
`/etc/containers/containers.conf.modules` and `/usr/share/containers/containers.conf.modules`; and any file
`CONTAINERS_CONF` or `CONTAINERS_CONF_OVERRIDE` names in `podman.service`'s `Environment=`, an `EnvironmentFile=`
(wildcards expanded, as systemd does) or the systemd manager's own environment (`systemctl show-environment`, which
`DefaultEnvironment=` and `set-environment` fill; measured honoured). All of it through `systemctl`, which any account
may run. That environment is read as it is now: a `set-environment` undone with `unset-environment` after the service
started still reaches jobs until the service restarts, and only root can see it (`/proc/<pid>/environ`), so it is not
judged (measured, gate round 1 of PR #473). An `[engine] env` naming `CONTAINERS_CONF_OVERRIDE` was measured NOT honoured by the service, and `env` is
refused anyway. The `mountSet` observation (step 4) reads the same files for its own four keys.

**podman.service is trusted only for its own socket.** The worker compares its docker endpoint with the socket
`podman.socket` listens on (`systemctl show -p Listen podman.socket`), both with their symlinks resolved, so
`/var/run/podman/podman.sock` is `/run/podman/podman.sock`. A second rootful API service on another socket,
with an environment of its own, was measured applying its own `CONTAINERS_CONF_OVERRIDE` to jobs, and its environment is
another process's, readable by root alone: the worker still judges the files every rootful Podman on the host reads, and
names that service in doctor's ⚠ line rather than judging it by `podman.service`'s environment.

**What the worker cannot read refuses, except root's own config home.** A part of that chain that exists and that the
worker's account cannot read refuses the job and withholds `mountSet` (measured: a `0600` drop-in in `/etc` setting
`env` reached every job), with its own ✗ in doctor. The one exception is root's own config home (`/root/.config`, or
the `HOME` or `XDG_CONFIG_HOME` the unit sets), which is `0550` or `0700` on every stock host: a worker that is not
root reads none of it, so doctor names each such path in a ⚠ line and the worker logs `local_podman_conf_unread` once,
and again when the list changes. Check those files yourself as root. A `systemctl` that does not answer (a worker in a
container, a host without systemd) is named the same way, and then the unit's environment, its modules and the running
service below are not judged.

**A running service keeps the containers.conf it started with.** Measured: with the service held up, a key written
to `/etc` did not reach a job started through it, and a key removed still did, for `env` and for `volumes` alike;
only once the service exited and the socket started it again did the files apply. (`mounts.conf` is different: the
running service read it for each container, measured.) So while `podman.service` runs, the worker compares the
**change time** of every chain file, every drop-in directory (a drop-in added, removed or renamed changes it), the
module and environment files and the unit's own files with the service's start. Change time, not modification time:
the kernel sets it, and no `cp -p` or `touch -d` can set it back (both were measured hiding a change from an mtime).
A chain file's parent directory is NOT watched, since unrelated files live there (a `sed -i` of
`/etc/containers/registries.conf` held every local job back until this was fixed); a chain file replaced by a rename
already has a new change time. A chain file the worker saw while the same service start ran and that is gone now is a
deletion the service may still hold, and counts too, whether the worker last saw it refused, unreadable or clean. The
one change nothing shows is a chain file deleted before the worker first looked, while an older service still runs:
restart the service after deleting one. Doctor keeps no such memory, so its ✓ says only that no file changed, and names
the deletion it cannot see.

Change time moves for more than an edit, and each of these holds local jobs until the service restarts or idles out,
though nothing Podman reads changed: a `chmod` or `chown` of a chain file; any file created in a drop-in directory, a
`.conf` or not (an editor's swap file, a `.rpmnew`, a backup); and a package update that rewrites `podman.service` or
one of its drop-ins. Restart the service after such a change, or let it idle out.

While any of that holds, the worker does not run local jobs, and gives `mountSet` no credit, until the service
restarts: **a hold, not a refusal**. A job goes back to the queue and is checked again every minute without spending
an attempt; if the service is still running with an older configuration after an hour of holding, the job fails, its
run record and comment naming the restart (`podman-service-restart-hold-expired`). The hour counts only while the
worker keeps checking: a job that comes back after a queue pause (`pi-dispatch pause`) or while no worker ran starts
its hour afresh. A boot exits 1 to be restarted. The service exits on its own within twelve seconds of
its last request (measured) and the socket starts it fresh, but a running local job holds it up, so a steady stream of
jobs can keep it up past its change; restart it while no local job runs:

```sh
sudo systemctl restart podman.service
```

A change time later than the host's clock is the clock's problem, said as such (fix the clock or wait), and held the
same way.

A `--module` the service passes that names no file refuses local jobs: `systemctl` prints the service's arguments
unquoted, so a module path holding a space cannot be read whole, and the worker refuses it rather than judge half a
path. Give modules paths without spaces. A directory named `*.conf` in a drop-in directory is skipped, as Podman skips
it.

The worker's sentences, which a test rebuilds from the code:

<!-- PODMAN-ROOTFUL-CONF-TEXTS -->
```
# a containers.conf rootful Podman's service reads that sets a refused key, here annotations (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets annotations, which rootful Podman adds to every container, where run.oci.keep_original_groups=1 gives a local job the supplementary groups of the Podman service that starts it (root's, and any SupplementaryGroups= on podman.service); remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, env (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets env, which under [containers] adds variables to every local job past the worker's own closed environment, and under [engine] is the Podman service's own environment; remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, helper_binaries_dir (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets helper_binaries_dir, which is where rootful Podman finds the netavark and aardvark-dns it runs as root to set up every local job's network, so another program can stand in for them; remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, default_sysctls (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets default_sysctls, which rootful Podman sets in every local job (any value but the vendor's own ping_group_range block); remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, default_ulimits (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets default_ulimits, which rootful Podman sets on every local job's processes; remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, userns (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets userns, which puts every local job in a user namespace the worker's argv does not name (with auto and no subordinate range, the job cannot even be created); remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, pidns (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets pidns, which asks for a PID namespace the worker's argv does not name (the host's was refused at create against the job's --init); remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, ipcns (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets ipcns, which asks for an IPC namespace the worker's argv does not name (the host's was refused at create against the job's --shm-size); remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, utsns (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets utsns, which gives every local job the UTS namespace it names, the host's hostname with host; remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, cgroupns (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets cgroupns, which gives every local job the cgroup namespace it names, the host's with host; remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, netns (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets netns, which gives a local job with no network of its own the network namespace it names, the host's with host; remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, seccomp_profile (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets seccomp_profile, which replaces the seccomp filter of every local job; remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, apparmor_profile (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets apparmor_profile, which replaces every local job's AppArmor profile where AppArmor runs (unconfined removed the containers-default profile, measured); remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, init_path (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets init_path, which names the binary that runs as every local job's PID 1; remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, dns_servers (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets dns_servers, which writes the nameservers of a local job with no network of its own; remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, dns_options (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets dns_options, which writes every local job's resolver options; remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, dns_searches (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets dns_searches, which writes every local job's resolver search list; remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, base_hosts_file (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets base_hosts_file, which names the file every local job's /etc/hosts starts from; remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, label (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets label, which with false runs every local job unconfined by SELinux (spc_t, measured); remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, cgroup_conf (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets cgroup_conf, which writes cgroup files of every local job past its own bounds (pids.max=max outlasted --pids-limit, measured); remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, host_containers_internal_ip (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets host_containers_internal_ip, which names the address every local job reaches as host.containers.internal; remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, runtimes (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets runtimes, which as the [engine.runtimes] table names the OCI runtime binary that creates every local job (a wrapper there ran for every job, measured); remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, conmon_path (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets conmon_path, which names the conmon that monitors every local job (a wrapper there ran for every job, measured); remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# the same, cgroups (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf sets cgroups, which with disabled runs every local job outside its cgroup with its pids and memory bounds unapplied (measured); remove that key from that file, then sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request. The local venue refuses any containers.conf rootful Podman's service reads that sets annotations, env, helper_binaries_dir, default_sysctls, default_ulimits, userns, pidns, ipcns, utsns, cgroupns, netns, seccomp_profile, apparmor_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path or cgroups, whatever the value, because no flag on a job's command line takes it back. A setting you need for your own containers goes on their own command line instead, not host-wide (issue #448).

# a part of that chain the worker's account cannot read, outside root's own config home (at boot when local is the default venue, else per job)
Refused: /etc/containers/containers.conf.d/zz.conf could not be read (EACCES); make that file readable by the worker's account (only root's own config home may stay unreadable, and is then named, not judged): the local venue must read every other containers.conf rootful Podman's service reads to know that none of them widens a job, and refuses what it cannot read (issue #448).

# podman.service running since before a containers.conf it reads changed (a hold: boot exits 1, a job waits)
Not run yet: /etc/containers/containers.conf changed after the running podman.service started, and a running Podman service keeps the containers.conf it started with, so a key removed since may still reach every local job; sudo systemctl restart podman.service while no local job runs (a running job's docker run holds the service up), or stop it and let podman.socket start it again on the next request, so the service reads the files as they are now; until it does, each local job is held, never refused: it goes back to the queue and is checked again every minute without spending an attempt, and fails, with a comment naming this, only after an hour of holding; a boot exits 1 to be restarted. It heals by itself once the service idles out (issue #448).
```
<!-- /PODMAN-ROOTFUL-CONF-TEXTS -->

A forge job gets a fixed comment instead, which names no path. A file the check cannot decode (an escaped key, a
non-ASCII character, a multi-line string) is refused the same way, as the native venue's check does.

## SELinux

With SELinux enforcing (stock Fedora and RHEL), a bind mount keeps its host label, and a container may only use files
labelled for containers. Measured on Fedora 44 with rootful Podman 5.8.1 and container-selinux 2.247.0
(2026-09-25): every unlabelled source was denied to the container, `ls` included, with or without `:ro`, whether it
sat under `/tmp` (`user_tmp_t`), under a home directory (`user_home_t`), under `/var/lib` (`var_lib_t`) or under
`/srv` (`var_t`). Before this release every job on the Docker API route therefore stopped at `/job` before it spent
anything, and `.github/scripts/job-user-e2e.mjs` failed for a jobs directory under `/tmp` and under `$HOME` alike
(`ls: cannot open directory '/job': Permission denied`).

Two mount options fix that, and they are not interchangeable (both measured):

- `:z` relabels the source `container_file_t`, shared, so every container may use it.
- `:Z` relabels it with a category pair private to one container (`container_file_t:s0:c542,c700`). A second
  container that mounts the same folder afterwards is denied.

**What the worker does.** When the daemon is Podman, reports SELinux (`name=selinux`), is on this host, and the worker
runs on Linux, the directories the worker makes for one job carry `:Z`: `/job` (`:ro,Z`), `/outbox`, `/session`, and
`/workspace` when it is the worker's own (a forge job's clone). Private is right for a directory one container ever
sees, and it keeps each job's inputs out of every other container. On any other daemon the argv is exactly what it was.
The native `podman` venue follows the same rule off its own fact, `podman info`'s `selinuxEnabled`, which rootless
Podman needs as much as rootful (measured on the same Fedora 44 host: an unlabelled source is denied, and `:Z` works).
`pi-dispatch doctor --live` and `pi-dispatch sandbox` follow the same rule: the probe's fixture and a sandbox's retained
workspace are the worker's own, so they carry `:Z` too.

**What it never relabels, and what you do instead.** A local trigger's folder is yours, and `PI_GLOBAL_PI_DIR` (the
overlay mounted at `/opt/pi-global`) is mounted into every job. `:Z` on either would take it from every other
container, the next job included, and `:z` would replace a label you chose on every run. So neither is relabelled,
and each needs a label once, as root:

```sh
semanage fcontext -a -t container_file_t '/srv/repo(/.*)?'
restorecon -R /srv/repo
```

Measured: after that the folder is readable and writable in a container with no mount option, and readable with
`:ro`. `semanage` records a rule, so the label survives a full relabel of the filesystem, which a bare `chcon` does
not.

`pi-dispatch doctor` checks this where it applies. It prints a ✓ line saying jobs' own directories are relabelled
(`:Z`), and reads the label of every local trigger's folder and of `PI_GLOBAL_PI_DIR` with `stat -L --format=%C`. Its fix names
the directory `restorecon` actually meets: the folder resolved through every link (its own, a chain, or a linked
parent; a rule on the configured path matched nothing in each case, measured), then mapped back through the policy's
path equivalences in `file_contexts.subs_dist` and `.subs`, because `semanage` refuses a rule on the aliased side of
one (measured for `/var/home /home`, `/var/opt /opt` and `/var/roothome`). A type
other than `container_file_t` or `container_ro_file_t`, or one carrying a private category pair (some container's
`:Z`), is a ⚠ naming the folder and the fix above; a label it cannot read is a "not checked" line, never a warning.
On an NFS, CIFS or FUSE mount, or one mounted with `context=`, the label comes from the mount and `restorecon` cannot
change it; the container-selinux booleans `virt_use_nfs`, `virt_use_samba` and `virt_use_fusefs`, or the mount's own
context, are what decide there. The warning says so; none of those was measured here. A
job that meets such a folder anyway is refused before it spends: the runner checks that it can read `/job`,
`/opt/pi-global` and `/workspace`, and exits 2 as `job-inputs-unreadable`, naming the path. A `/workspace` the job
can read but not write still runs, with the advisory `workspace_not_writable`, because a read-only review of such a
folder is a legitimate job. The run record of such a refusal says `runner-policy`, as every runner reason does except
the reasons in the worker's `RUNNER_POLICY_REASONS` (the ones the record names itself); the worker's log carries its exit line, where
`job-inputs-unreadable` and the path are named.

`:Z` relabels a directory recursively on every run, so a forge job whose clone is large pays for relabelling it
before the container starts. That cost was not measured.

The compose file's config mounts (`egress-proxy.conf`, `egress-allowlist.conf`, `model-endpoints.conf`, `triggers.json`),
and the three mounts of the proxy that `pi-dispatch up` starts, carry `:ro,z`:
shared, because they are single files the services read, not a job's directory. Measured: without it squid
crash-looped with `FATAL: Unable to open configuration file: /etc/squid/squid.conf: (13) Permission denied`; with it
the proxy reached `healthy`. The receiver's `triggers.json` and `pi-dispatch up`'s proxy carry it for the same reason
and were not started on that host.

Docker Engine with `selinux-enabled` is out of scope. It reports the same `name=selinux`, but the worker adds `:Z`
on Podman only, so the argv there is what it always was, and nothing about that route was measured. Expect the same
denials there: a job on such a daemon stops at the runner's `/job` check before it spends, exactly as every job on
Podman did before this release.

## Rootless Podman, the native venue

`podman` is a venue of its own (issue #354), beside `local` in the backend table, and it is the route for rootless
Podman. The worker runs the `podman` CLI itself, as the account it runs under, so each job lands in that account's
own container store. Every job runs as that account's `<uid>:<gid>` with `--userns=keep-id` and `HOME=/home/pi`:
keep-id maps the worker's uid into the container unchanged, so the uid that owns the job's `0700` directories is the
uid the agent runs as, which is what rootless Podman through its Docker API cannot give a job. The argv is the job
argv every other job gets, from the same builder, with `--userns=keep-id` right after `--user=`.

The venue decides from one `podman info --format json`, never from a probe container. It asks, in this order,
whether the host is Linux, whether `podman info` answered, whether the service is remote, whether it is rootless,
and whether the worker is root; then whether a containers.conf the account reads widens a job (step 4 below); then,
per job, whether the worker's primary group is gid 0 and whether the image
declares `anyUid`. These are its refusals, verbatim from `worker/src/backend-podman.mjs`, and a test pins each line
and each heading's timing to the code:

<!-- PODMAN-NATIVE-REFUSALS -->
```
# a worker that is not on Linux (at boot when podman is the default venue, else per job)
Refused: the podman venue runs only on Linux (Podman machine on macOS and Windows was not measured); use the local venue with Docker Desktop, or run the worker on a Linux host (issue #354).

# no podman to run (at boot when podman is the default venue, else per job)
Refused: no podman CLI was found on the worker's PATH; install Podman for the worker account, or remove podman from PI_BACKENDS (issue #354).

# a podman info nothing can read (per job)
Refused: podman info answered with something no rule can read, so which uid a job may run as is unknown; check that `podman info --format json` works as the worker account (issue #354).

# a remote Podman service (at boot when podman is the default venue, else per job)
Refused: podman runs its containers through a remote service (CONTAINER_HOST, --remote or a containers.conf service destination), where a job's mounts and secrets are another machine's; unset it for the worker account (issue #354).

# a rootful Podman (at boot when podman is the default venue, else per job)
Refused: podman is not rootless for this account, and the podman venue runs only on rootless Podman (rootful keep-id adds the root group); run the worker as an unprivileged account, or use rootful Podman through the local venue's Docker API route (docs/podman.md) (issue #354).

# a worker running as root (at boot when podman is the default venue, else per job)
Refused: the worker runs as root, and a job must not run as root (nonRoot); run the worker as an unprivileged account with its own rootless Podman (issue #354).

# a worker whose primary group is gid 0 (per job)
Refused: the worker's primary group is gid 0, and a podman job runs with that group; run the worker with an unprivileged primary group (issue #354).

# a job image without anyUid, and a worker that is not uid 1001 (per job)
Refused: the job image does not declare `anyUid` (`dev.pi-dispatch.capabilities`), so it cannot run as this worker's own uid, which the podman venue always uses; rebuild it from a release that has this feature, or run the worker as uid 1001 (issue #354).

# a containers.conf the account reads that sets pasta_options, network_cmd_options, annotations, env, helper_binaries_dir, network_cmd_path, default_sysctls, default_ulimits, seccomp_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, oom_score_adj, privileged, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path, cgroups or umask, here the user's own (at boot when podman is the default venue, else per job)
Refused: /home/pdjob/.config/containers/containers.conf sets pasta_options, which Podman hands to the pasta behind every job's network, where a host-loopback mapping (--map-host-loopback, --map-gw, -T) gives the job this host's 127.0.0.1 services; remove that key from that file, then stop every running container of this account that is on a bridge network, all of them at once, then start them again, since the rootless network they share lives until the last of them stops and a container started meanwhile joins it as it is: with this project's units, systemctl --user stop pi-dispatch-worker.service pi-dispatch-egress-proxy.service pi-dispatch-netns-keeper.service pi-dispatch-valkey.service, then podman stop any other container `podman ps` still lists, then systemctl --user start pi-dispatch-valkey.service pi-dispatch-netns-keeper.service pi-dispatch-egress-proxy.service pi-dispatch-worker.service (a worker installed at system scope is stopped and started with sudo systemctl stop and start pi-dispatch-worker.service instead; for containers started by hand, podman stop them all, then podman start them). Stop the keeper with systemctl, not podman stop: its unit starts it again a second later, and it then rejoins the network as it is while any other bridge container still runs. A unit this account does not have is reported as not loaded, and the others still stop and start. The podman venue refuses any containers.conf this account's Podman reads that sets pasta_options, network_cmd_options, annotations, env, helper_binaries_dir, network_cmd_path, default_sysctls, default_ulimits, seccomp_profile, init_path, dns_servers, dns_options, dns_searches, base_hosts_file, oom_score_adj, privileged, label, cgroup_conf, host_containers_internal_ip, runtimes, conmon_path, cgroups or umask, whatever the value, because no flag on a job's command line takes it back, and it refuses a rootless network still running with such an option after the key is gone. A setting you need for your own containers (a pasta MTU, say) goes on their own command line (--network=pasta:...) or Quadlet unit instead, not account-wide (issue #428).

# this account's rootless network still running with an option a removed key gave it, here Podman 5's pasta (at boot when podman is the default venue, else per job)
Refused: this account's running rootless network (pasta, pid 398902), which every container on a bridge network shares, the egress proxy's among them, still carries --map-host-loopback, which maps this host's 127.0.0.1 into it: it keeps the options it started with, whatever containers.conf says now; stop every running container of this account that is on a bridge network, all of them at once, then start them again, since the rootless network they share lives until the last of them stops and a container started meanwhile joins it as it is: with this project's units, systemctl --user stop pi-dispatch-worker.service pi-dispatch-egress-proxy.service pi-dispatch-netns-keeper.service pi-dispatch-valkey.service, then podman stop any other container `podman ps` still lists, then systemctl --user start pi-dispatch-valkey.service pi-dispatch-netns-keeper.service pi-dispatch-egress-proxy.service pi-dispatch-worker.service (a worker installed at system scope is stopped and started with sudo systemctl stop and start pi-dispatch-worker.service instead; for containers started by hand, podman stop them all, then podman start them). Stop the keeper with systemctl, not podman stop: its unit starts it again a second later, and it then rejoins the network as it is while any other bridge container still runs. A unit this account does not have is reported as not loaded, and the others still stop and start. A worker this stopped at boot exits 2 and stays down until that start brings it back; a running one reads this network again before every podman job and admits the next once it no longer carries the option (issue #450).
```
<!-- /PODMAN-NATIVE-REFUSALS -->

A `podman info` that has not answered yet is none of these: the decision is `unknown`, and a job picked up meanwhile
is retried, never refused. Rootful Podman is refused here because it is already served, as `local`, and because
Podman does not refuse keep-id there itself: measured, a rootful `podman run --userns=keep-id` exits 0 with the
identity uid map and gives the process root's group as a supplementary group, which no job should have.

### Setup

Measured on Fedora 44 (kernel 6.19.10, SELinux enforcing, systemd 259.5, cgroup v2) with rootless Podman 5.8.1 as
an unprivileged account (uid 1234), on 2026-09-25. Run everything below as the worker's account unless it says
`sudo`.

1. **A dedicated account with subordinate ids.** Rootless Podman needs a range in `/etc/subuid` and `/etc/subgid` for
   the account (`grep <account> /etc/subuid /etc/subgid`). `useradd` adds one for an ordinary account and none for a
   `--system` one; where it is missing, `sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 <account>`
   and then `podman system migrate`. The worker must not run as root: the venue refuses it. Act as the account through a
   real login (or `machinectl shell <account>@`), not `sudo -iu <account>`: that gives no `XDG_RUNTIME_DIR` and no
   user bus, so every `systemctl --user` fails (measured), and `up` and `service install` refuse to write the stack's
   units there, naming this remedy. While the account's manager runs (linger on),
   `sudo -iu <account> env XDG_RUNTIME_DIR=/run/user/<uid> pi-dispatch ...` works too.
2. **Linger**, so the account's runtime directory and its systemd user instance exist without anyone logged in:
   `sudo loginctl enable-linger <account>`. **Keep it on once Podman has run under it.** Podman stores the run root it
   first used (`/run/user/<uid>/containers`), and `loginctl disable-linger` removes `/run/user/<uid>` with the user
   manager; from then on every `podman` command as the account fails before doing anything (measured on Fedora 44
   with 5.8.1 and Ubuntu 24.04 with 4.9.3: exit 125, `Error: default OCI runtime "crun" not found: invalid argument`,
   after a warning that the RunRoot is not writable; exit 1 on 5.8.1 with `XDG_RUNTIME_DIR` set to the missing
   directory). `podman system migrate` fails the same way and does not help, and `--runroot` elsewhere is refused as
   a database mismatch. Turning linger back on recreates the directory and Podman answers again (measured on both); a
   login session of the account does too, but only while it lasts. `pi-dispatch doctor` names this state (issue
   #464) when three things hold: `podman info` fails with an exit status, `/run/user/<uid>` does not exist, and
   Podman's own database (`db.sql`, or `libpod/bolt_state.db` on older installs, under
   `~/.local/share/containers/storage`) records a run root there, which is the evidence that Podman ran under it
   before. It then names linger as the fix. An account that never had a session has no such record, and doctor
   says only that `podman info` failed.

   Measured: with linger, a system unit running as that account
   (`deploy/worker.service` with `User=` set to it) runs `podman` with or without `XDG_RUNTIME_DIR` in its
   environment, since Podman then falls back to `/run/user/<uid>`. That hand-written system unit still works, but
   `pi-dispatch service install` installs this venue's worker in USER scope (it refuses `--system` here, step 6),
   and linger is then also what starts the user manager, and with it the worker and the Quadlet units, at boot.
   A hand-written SYSTEM unit with `User=` must also be ordered after that user manager, which nothing else orders
   it after: add `Wants=user@<uid>.service` and `After=user@<uid>.service` to its `[Unit]` section. Measured (issue
   #453, Fedora 44): without them, with `PI_BACKEND_FLOOR=isolation=enforced`, the worker started before
   `user@<uid>.service`, found no user manager, refused to boot with exit 2, and stayed failed after the manager came
   up, since `RestartPreventExitStatus=2` keeps a configuration refusal from restarting; with the two lines it started
   after the manager and ran. Without an isolation floor the same race costs the jobs picked up before the manager
   runs their bounds (step 3). The user-scope worker `service install` writes runs inside the manager and needs neither.
3. **cgroup v2, a systemd user manager running for the account with the controllers delegated to it, and Podman
   putting its containers under it.** `cat /sys/fs/cgroup/user.slice/user-<uid>.slice/user@<uid>.service/cgroup.controllers`
   must list `cpu`, `memory` and `pids`. Fedora delegates all of them to user managers (measured: `cpuset cpu io
   memory pids`); where a distribution does not, a drop-in for `user@.service` with `Delegate=cpu cpuset io memory
   pids` does. With a controller missing a job cannot have that bound: measured for cpu, Podman 5.8.1 refused to
   start a container carrying `--cpus` (exit 126, "controller `cpu` is not available"). Every job carries
   `--cpu-shares` too (its size's CPU weight), which needs the same controller. The file is absent while the
   account's `user@<uid>.service` is inactive (measured, issue #453; systemd removes a stopped unit's cgroup). What
   decided the bounds in every case measured (Fedora 44, Podman 5.8.1, the venue's own argv; issue #453):
   - **no user manager** (linger off, the account reached through `sudo -iu`, which starts none): Podman put the job in
     the caller's own root-owned cgroup, `pids.max`, `memory.max` and `cpu.max` read back `max`, and the run exited 0,
     whether Podman's cgroup manager was `systemd` (it fell back to `cgroupfs` with a warning) or `cgroupfs`;
   - **a user manager Podman reaches** (`podman info --format '{{.Host.CgroupManager}}'` says `systemd`): applied. A
     plain ssh login started the manager (pam_systemd), and so does linger (step 2);
   - **a user manager Podman does not reach** over the account's user bus (no `/run/user/<uid>/bus` socket, as without
     the dbus-user-session package on Debian and Ubuntu; a `DBUS_SESSION_BUS_ADDRESS` pointing nowhere; a system unit
     with `User=` and no user bus): Podman fell back to `cgroupfs` and the job again landed in the caller's own cgroup,
     unbounded;
   - **`cgroupfs` from a process inside `user@<uid>.service`** (the worker as a systemd user service): applied.
   So the worker credits `isolation` (`podmanBoundsDelegated`) only while that file lists the three controllers AND
   either Podman reports the `systemd` cgroup manager or the worker itself runs inside the user manager. One measured
   case is applied and still not credited, since nothing the worker can read tells it apart from the unbounded ones:
   an explicit `cgroup_manager = "cgroupfs"` used from a shell outside the manager. Not measured, and not credited: no
   user manager, with the worker in a cgroup of its own that the account owns (a system unit with `User=` and
   `Delegate=yes`, linger off). `podman info`'s `CgroupControllers` answers none of this: it is the calling process's
   own cgroup, which listed every controller with nothing applied. Leave `cgroups` unset in every containers.conf the
   account reads: measured with `--cgroups=disabled`, `--memory` and `--pids-limit` are accepted and silently not
   applied, and the bounds read back as `max`.

   `pi-dispatch doctor`'s isolation line names which of these it saw, with its fix (⚠; the `PI_BACKEND_FLOOR` line is
   the ✗ when the floor asks for `isolation`), and `pi-dispatch doctor --live` reads `pids.max`, `memory.max`,
   `memory.swap.max`, `cpu.max` and `cpu.weight` back off a real container. With linger off, doctor's ✓ holds only while a login session of the account is open, from
   whatever shell it runs in: measured, a `sudo -iu` doctor saw the manager another login session had started and
   gave ✓. The manager stops with the last session, so doctor says linger is off in a ⚠ of its own. Without a floor
   on `isolation` a missed observation changes only the word: podman jobs still run, unbounded. With one (say
   `PI_BACKEND_FLOOR=isolation=enforced`) the worker refuses to boot, naming the cause.
4. **No mounts of Podman's own.** `mkdir -p ~/.config/containers && : > ~/.config/containers/mounts.conf`. For a
   rootless account the user's `mounts.conf` replaces `/etc/containers/mounts.conf`, and an EMPTY file at whichever
   of the two applies stops the default `/run/secrets` mount (both measured). Leave `volumes`, `mounts`, `devices`
   and `hooks_dir` unset in every containers.conf the account reads, install no OCI hooks, and keep FIPS mode off,
   or the worker gives `mountSet` no credit (`podmanAddsNoMounts`). Leave `CONTAINERS_CONF` and
   `CONTAINERS_CONF_OVERRIDE` unset for the worker too: with either set, the files the worker reads are not the ones
   Podman reads, so the worker refuses the whole venue (below), and so it does when a containers.conf or a drop-in
   directory exists and cannot be read.
   Leave `pasta_options`, `network_cmd_options`, `annotations`, `env`, `helper_binaries_dir`, `network_cmd_path`, `default_sysctls`, `default_ulimits`, `seccomp_profile`, `init_path`, `dns_servers`, `dns_options`, `dns_searches`, `base_hosts_file`, `oom_score_adj`, `privileged`, `label`, `cgroup_conf`, `host_containers_internal_ip`, `runtimes`, `conmon_path`, `cgroups` and `umask`
   (`helper_binaries_dir` and `network_cmd_path` swap the program behind every job's network for another, issue #450;
   the seventeen after them are issue #448's, in the table below) unset in every containers.conf the account
   reads, whatever you would set them to: while any of them is present the worker refuses the venue (issue #428), at
   boot when `podman` is the default venue and each podman job otherwise, as `podman-conf-widens-job`, naming the
   file and the key, and `pi-dispatch doctor` says the same. Write the files in plain ASCII with no `"""` or `'''`
   multi-line strings, or they are refused too: such spellings were measured hiding a key from this check while
   Podman honoured it. A read that fails for a moment (out of file descriptors, an I/O error) is retried, not
   refused. Measured on Fedora 44 with Podman 5.8.1: a host-loopback
   mapping there (`--map-host-loopback`, `--map-gw`, `-T <port>`, or slirp4netns's `allow_host_loopback=true`) gave
   a job without egress, a job on its own bridge and the egress proxy's network the host's `127.0.0.1` services, a
   local Valkey among them, `run.oci.keep_original_groups=1` kept the account's groups inside the job, and
   `[engine] env = ["CONTAINERS_CONF_OVERRIDE=..."]` made Podman read a file the worker never reads. No flag
   on the job's command line takes those options back (Podman puts them first, and a `-T` survives any pin), which
   is why the key's presence is refused rather than its value judged. The cost: a setting you wanted for every
   container of the account, a pasta MTU say, goes on those containers' own command line
   (`--network=pasta:...`) or Quadlet unit instead. After removing one of the keys that shape the account's rootless network
   (`pasta_options`, `network_cmd_options`, `env`, `helper_binaries_dir` and `network_cmd_path`), stop every running
   container of the account that is on a bridge network, all at once, and start them again (the refusal names the
   commands); every other key is applied per container, and the next podman job runs once it is gone: the
   rootless network they share keeps the options it started with until the last of them stops, and a container
   started meanwhile joins it as it is (measured on Podman 5.8.1 and 4.9.3). So the worker reads that live network
   too (issue #450), from Podman's own record: on Podman 5 the process whose pid it keeps in
   `<runRoot>/networks/rootless-netns/rootless-netns-conn.pid` (`runRoot` is `podman info`'s `store.runRoot`), and on
   4.9, which keeps no record `podman info` points to, the slirp4netns in the worker's own pid namespace whose
   arguments name `netns/rootless-netns-<hex>`. Never by a process's name, so a renamed helper is found, and never a
   job's own process or a container's own helper. It is refused while it still carries
   `--map-host-loopback`, lacks Podman's own `--no-map-gw` (a conf `--map-gw` shows only as that), has a `-T` or
   `-U` other than `none`, or on slirp4netns lacks `--disable-host-loopback`, with the same cause, at boot, before
   each podman job, in a sandbox and in doctor, and admitted from the next job once it is narrow. A container's own
   pasta or slirp4netns is not judged: that is where a setting for your own containers belongs. The keeper is one of
   those bridge containers: stop it with `systemctl --user stop`, not `podman stop`, which its unit undoes a second
   later, rejoining the old network if anything else on a bridge still runs. A unit your account does not have is
   reported as not loaded, and the others still stop and start.
   The namespaces, `env_host` and `http_proxy` the argv can pin, and does.

   Issue #448 measured the rest of the keys containers.conf can set for every container, with this venue's own argv,
   each alone in the account's own containers.conf, on `--network=private` and on an `--internal` network, on Fedora
   44 with Podman 5.8.1 and on Ubuntu 24.04 with Podman 4.9.3, which answered alike. The whole list, the first six
   from issues #428 and #450:

   <!-- PODMAN-ROOTLESS-KEY-TABLE -->
   | Key | What the job saw | Decision |
   |---|---|---|
   | `pasta_options` | a host-loopback mapping gave it the host's `127.0.0.1` services (issue #428) | refused |
   | `network_cmd_options` | slirp4netns's `allow_host_loopback=true`, the same (issue #428) | refused |
   | `annotations` | `run.oci.keep_original_groups=1` kept the account's groups (issue #428) | refused |
   | `env` | its variable, and under `[engine]` Podman's own environment (issue #428) | refused |
   | `helper_binaries_dir` | another program behind its network (issue #450) | refused |
   | `network_cmd_path` | another slirp4netns behind its network (issue #450) | refused |
   | `default_sysctls` | the sysctl it named (`ip_unprivileged_port_start` 77), in place of the vendor's own | refused, except the vendor's own block |
   | `default_ulimits` | the limit it named (`nofile` 333) | refused |
   | `seccomp_profile` | the named profile (one denying `uname` aborted the job's node) | refused |
   | `init_path` | the named binary as its PID 1 | refused |
   | `dns_servers` | the named nameserver, on `--network=private` | refused |
   | `dns_options` | the named resolver option | refused |
   | `dns_searches` | the named search domain | refused |
   | `base_hosts_file` | the named file's lines in its `/etc/hosts` | refused |
   | `oom_score_adj` | the OOM score it named | refused |
   | `privileged` | a full capability bounding set, no seccomp filter, the host's devices, an unconfined SELinux label | refused |
   | `label` | `false`: it ran as `spc_t`, unconfined by SELinux (on Fedora) | refused |
   | `cgroup_conf` | `pids.max=max`: its pids limit gone, past the argv's `--pids-limit` | refused |
   | `host_containers_internal_ip` | the named address as `host.containers.internal` | refused |
   | `runtimes` | a runtime in the `[engine.runtimes]` table: that wrapper created every job (the stock header alone passes) | refused |
   | `conmon_path` | that wrapper monitored every job | refused |
   | `cgroups` | `disabled`: its pids and memory bounds unapplied | refused |
   | `umask` | the umask it named (`0000`), so what it writes to this host is that open | refused |
   | `userns` | nothing: the argv's `--userns=keep-id` | inert |
   | `pidns` | nothing: the argv's `--pid=private` | inert |
   | `ipcns` | nothing: the argv's `--ipc=private` | inert |
   | `utsns` | nothing: the argv's `--uts=private` | inert |
   | `cgroupns` | nothing: the argv's `--cgroupns=private` | inert |
   | `netns` | nothing: the argv's `--network` | inert |
   | `apparmor_profile` | nothing: rootless Podman applies no AppArmor profile (`crun (unconfined)` either way, on Ubuntu) | inert |
   | `default_capabilities` | nothing: the argv's `--cap-drop=ALL` | inert |
   | `no_new_privileges` | nothing: the argv's `no-new-privileges` | inert |
   | `init` | nothing: the argv's `--init` | inert |
   | `pids_limit` | nothing: the argv's `--pids-limit` | inert |
   | `shm_size` | nothing: the argv's `--shm-size` | inert |
   | `env_host` | nothing: the argv's `--env-host=false` | inert |
   | `http_proxy` | nothing: the argv's `--http-proxy=false` (a proxy in the account's environment did not reach it) | inert |
   | `tz` | the named time zone | harmless |
   | `no_hosts` | no `/etc/hosts` at all | harmless |
   <!-- /PODMAN-ROOTLESS-KEY-TABLE -->

   The rule is the rootful route's (below, in "What rootful Podman's containers.conf must not set"): refused when the job
   saw a boundary the argv sets crossed, inert when the argv overrode the key, harmless when the key reached the job and
   moved nothing that is a boundary. The rows from `label` on, and `tz` and `no_hosts`, were measured in gate round 1 of
   PR #473 and after it. Every key refused here but a network helper's (`pasta_options`, `network_cmd_options`, `env`,
   `helper_binaries_dir`, `network_cmd_path`) is applied per container, so the next podman job runs once the key is
   gone, with no network reset.

   The vendor's own `default_sysctls = ["net.ipv4.ping_group_range=0 0"]`, uncommented in the stock containers.conf of
   both distributions, is accepted exactly as it ships, on this venue as on the rootful route: refusing it would refuse
   every stock host, and the exception is exact, so any other value, spelling or a second sysctl beside it is refused.
5. **The job image, in this account's own store.** A rootless account does not see root's images or another
   user's: `podman pull ghcr.io/edgehero/pi-job:latest` as the account, then set `PI_JOB_IMAGE` to the name
   `podman images` shows. `--pull=never` resolves a short name such as `pi-job:latest` to `localhost/pi-job:latest`
   with no registry lookup (measured). With `PI_BACKENDS=podman` and `PI_JOB_IMAGE` left unset, `pi-dispatch doctor
   --fix` run as the account offers the pull for you: `podman pull ghcr.io/edgehero/pi-job:latest`, then `podman tag`
   to `pi-job:latest`, which is the default `PI_JOB_IMAGE`, so there is nothing to set. It offers nothing while
   `local` is also listed, or for a `PI_JOB_IMAGE` you chose. The image must declare `anyUid` unless the account is uid 1001; releases
   since issue #341 do. Pull it as the account; doctor's fix line names only that, since a podman-only host has no
   docker to save an image from (issue #453). `pi-dispatch init` run with `PI_BACKENDS=podman` (in the shell or the
   folder's `.env`) prints these steps as its next steps, in place of the docker ones.
6. **The egress proxy and Valkey, as Quadlet units in this account's user manager.** Put `PI_BACKENDS=podman` in
   `.env` first (step 8), then from the deployment folder run `pi-dispatch up`, which pulls the job image into this
   account's store and offers the stack, or `pi-dispatch service install`, which installs the same units beside the
   worker's own and orders the worker after them. Both use one installer: it writes up to six files from `deploy/`
   into `~/.config/containers/systemd/` (`pi-dispatch-valkey.network`, `pi-dispatch-valkey.container`, and while the
   egress policy is armed `pi-dispatch-egress-out.network`, `pi-dispatch-egress-proxy.container`,
   `pi-dispatch-netns-keeper.network` and `pi-dispatch-netns-keeper.container`), runs `systemctl --user
   daemon-reload`, and starts `pi-dispatch-valkey.service`, `pi-dispatch-egress-proxy.service` and
   `pi-dispatch-netns-keeper.service` (the keeper is explained below).
   `up` shows every one of those lines before it asks, and `--yes` runs exactly those lines. Both read `PI_BACKENDS`,
   `PI_EGRESS` and `PI_EGRESS_PROXY` from `.env`. `up` also takes a key your shell sets that `.env` does not, and
   REFUSES when the two set one differently, naming both, because it would stand up one venue while the service ran
   the other; `service install` reads the file alone. A line touching one of them that the loaders read differently
   (`PI_BACKENDS =podman`, `export PI_BACKENDS=podman`, a `$` in the value, or a key line INSIDE a quoted value that
   opens on an earlier line and has not closed yet, which systemd reads as part of that value) stops both: write it as
   a plain `PI_BACKENDS=podman`. A multi-line value that closes, such as the documented inline
   `GITHUB_APP_PRIVATE_KEY="-----BEGIN ...-----"`, is fine with the key above or below it (measured on systemd 259).
   Both also refuse the WHOLE file, naming the line and what to change, when a line anywhere in it is one systemd
   splits into lines differently from `pi-dispatch` (a lone carriage return, a quote reopened right after a closing
   quote, a quoted value under a key that is not a variable name, a trailing backslash after a mid-value quote or a
   `#`) and a venue key is spelled outside a comment, when systemd would refuse to load the file at all (a NUL byte,
   or a key or value that is not valid UTF-8 or holds a Unicode noncharacter such as U+FFFF, or more environment
   than systemd can start the service with), and when a venue value is longer than 4096 bytes, pi-dispatch's own cap.
   The setup wizard refuses the same lines before it runs `up`, and writes `PI_BACKENDS=podman` only when the edited
   file reads back that way; otherwise it changes nothing. Neither ever overwrites a key the service already reads,
   and `up` names a key that only a shell reads (an `export WEBHOOK_SECRET=` line, which systemd ignores) instead of
   calling it set.

   The proxy's rules are mounted from `~/.config/pi-dispatch/egress-proxy.conf`, a copy of the package's own
   `egress-proxy.conf` that the installer writes (shown, compared and forced like the unit files). Never the package
   file itself: the mount's `z` relabels what it mounts, and measured on Fedora 44 with the package installed by
   `sudo npm i -g`, rootless Podman could not relabel the root-owned file (`lsetxattr ... operation not permitted`,
   exit 126) and the unit failed. A copy this account owns can always be relabelled. A changed copy restarts the
   proxy, since squid reads it only at start.

   An upgrade does not rewrite that copy on its own. After one that changed the shipped rules, `doctor` warns that
   `~/.config/pi-dispatch/egress-proxy.conf` differs from the package's copy (⚠: the old rules still enforce the
   allowlist, and the difference could be an edit of yours, which `diff` against the package's file shows). `service
   install` lists it among the files that differ from what this version renders, and `service install --force`
   replaces it and restarts the proxy; `--force` replaces every other item that list names too, so read the list
   first. `up`, when it has a unit to install, installs nothing while a stack file differs, and says so.

   Both refuse, installing nothing, when this account's user manager runs with another account's `XDG_RUNTIME_DIR`
   or `XDG_CONFIG_HOME` (`systemctl --user show-environment` shows it; a line in `/etc/environment`, which Ubuntu's
   user managers read, is the usual source). Every unit inherits that environment: measured on Podman 4.9.3, another
   account's `XDG_CONFIG_HOME` made the generator look for the units there, so they were "not found", and another
   account's `XDG_RUNTIME_DIR` made every podman command in them fail with "XDG_RUNTIME_DIR directory ... is not owned
   by the current user". The fix is a file in `~/.config/environment.d/` setting this account's own values, then a
   restart of the user manager.

   A container that already has a unit's name and was not started by that unit (the hand-started proxy below, or an
   older setup's Valkey) is never replaced silently: the unit's `podman run --replace` would remove it, and a proxy
   takes every running job's per-job network with it. Both commands say so and install nothing; remove it yourself
   (`podman rm -f -v pi-dispatch-egress-proxy`), or let `service install --force` replace it. A podman that cannot say
   whether such a container exists (anything but "no such container", a locked store say) installs nothing, `--force`
   or not. `service install --force` over a Quadlet file that changed RESTARTS that unit (a `start` would do nothing to
   a running one) and warns first when that unit is the proxy. `service install` lists every reason it refuses at once
   (the worker unit existing, a changed file, a foreign container), so `--force` accepts exactly what it printed.

   What was measured, on the Fedora 44 host with Podman 5.8.1:
   - The units get exactly the names the worker attaches by: `ContainerName=` and `NetworkName=` add no `systemd-`
     prefix, and `Network=pi-dispatch-egress-out.network` resolves to that network.
   - `systemctl --user enable` is refused for a generated unit ("transient or generated"). Nothing here enables
     one: the generator reads each file's own `[Install] WantedBy=default.target`.
   - **After a reboot, with linger on** (step 2), the units were active 25 s after boot with nobody logged in.
     **With linger off they did not start at all.** `service install` and `up` read
     `loginctl show-user <account> -p Linger` afterwards and warn when it is off. Do not check with
     `systemctl --machine=<account>@ --user status`: measured, that probe itself starts the user manager, and the
     units with it.
   - **Restarting the proxy drops every per-job network it was on.** The generated unit runs `podman run --replace
     --rm`, so `systemctl --user restart pi-dispatch-egress-proxy` makes a new container, and the job networks the
     worker had connected to the old one are gone from it. A job started afterwards connects the new proxy and is
     fine; a job already running has lost its only route out for the rest of that run. Restart the proxy when no job
     is running (`pi-dispatch pause`, wait, restart, `pi-dispatch resume`).

   Which parts are installed: Valkey only when `PI_BACKENDS` does not list `local` (with `local`, docker's Valkey is
   the queue, as before) and nothing already listens on the queue's port, `127.0.0.1:6379` unless `VALKEY_URL` names
   another loopback port (step 7 says whose listener is taken as the queue); the proxy only while the policy is armed
   and `PI_EGRESS_PROXY` is unset or names `pi-dispatch-egress-proxy`. A different name is your own proxy, and neither
   command installs a unit for it, because the unit's `--replace` would remove your container of that name. The
   keeper whenever the policy is armed, whatever `PI_EGRESS_PROXY` names, since the worker detaches your own proxy
   from every job network just the same; `up` leaves a keeper that is already running alone.
   `service install` reads these keys from `.env`, the file the unit loads, not from your shell and not from an
   `--env-setup` script. It refuses `--system` on this venue: the units belong to this account's user manager, which
   a system unit cannot order itself after, so install in user scope with linger on. `service uninstall` stops the
   container and network units, removes them and the rules copy, clears their failed state, and keeps the
   networks and, when a Valkey unit was installed, the `pi-dispatch-valkey-data` volume; it refuses without a user manager (as install does) and reports a
   stop or disable that failed instead of claiming success; `service status` lists each
   unit and whether it is active. Every `.container` sets `Network=` explicitly (Valkey on a bridge network of its
   own), because a containers.conf `netns = "host"` puts a container started without one into the host's network
   namespace (measured), where Valkey's `127.0.0.1` port mapping would mean nothing.

   A WRITE that fails part way leaves no file of the run behind (issue #464), from `up` too, which journals its
   Quadlet writes the same way. `service install` writes every file (the Quadlet files, the proxy's rules copy, the
   worker unit) before it runs any command, and when a write fails (a root-owned `~/.config`, say) it puts back every
   file it wrote in that run, removing new ones and restoring the old bytes of replaced ones, and names any it could
   not. A COMMAND that fails after the writes (a `daemon-reload` or a unit that does not start) is different: the
   stack's files stay, since their units run from them, and the refusal names each one; only the worker unit is put
   back, as it was never enabled. `service uninstall` removes those files even when their units were never loaded
   (a failed `daemon-reload`): `systemctl --user stop` of such a unit exits 5, and uninstall then asks the manager
   unit by unit and goes on when none of them is running.

   Measured again on 2026-09-27, on the same host, with these units as they ship: Valkey on its own bridge network,
   published on `127.0.0.1:6379` and healthy; the proxy's exec-form health check running under a systemd timer and
   reaching healthy; each container labelled `PODMAN_SYSTEMD_UNIT=<its unit>`, which the foreign-container check
   reads; a real job reaching the provider through the proxy; reboots with and without linger; uninstall. Not
   exercised: `Restart=` and `TimeoutStartSec=` doing their work. `.github/workflows/deploy-lint.yml` runs Podman
   4.9.3's generator in dry-run over the rendered files: it accepts all six, and passes the health check through as
   the JSON array it is.

   **The rootless network keeper** (`pi-dispatch-netns-keeper`, issue #458) is one idle container on an
   `--internal`, DNS-disabled network of its own. It is there for a defect in Podman 4.9, the version Ubuntu 24.04
   ships: when the worker detaches the proxy from a finished job's network (`podman network disconnect`), Podman 4.9
   tears down this account's shared rootless network namespace and its `slirp4netns` while the proxy is still running,
   whenever no other running container is on a bridge network. The next job's container starts a new namespace, the
   proxy's route out goes with the old one, and from then on every egress job gets `503 Service Unavailable` from the
   proxy until the proxy restarts. Measured on 4.9.3 with the worker's own network code: job 1 got 200, jobs 2 to 5
   got 503. The cause is upstream: v4.9.3's `libpod/networking_linux.go` counts the disconnecting container as the
   caller and cleans up when it finds one container; 4.9.4 and 4.9.5 are the same, and it went away with Podman 5.0's
   rootless network rewrite ([containers/podman#20772](https://github.com/containers/podman/pull/20772),
   [containers/common#1761](https://github.com/containers/common/pull/1761)), which counts attachments. Podman 5.8.1
   was measured unaffected. A running Valkey unit happens to prevent it too, since it is a bridge container, which is
   why a full default stack could look fine; a deployment with `local` in `PI_BACKENDS`, an external Valkey, or a
   Valkey restart had no such cover.

   With the keeper running, 4.9.3 gave five sequential egress jobs 200 each, and the two-network teardown
   `doctor --live` performs stayed clean. It is installed on every Podman version: on 5.x it is one idle container
   (measured harmless on 5.8.1), and one rule is simpler than a version read at install time. It widens nothing: no
   published port, no mount, `--cap-drop=all`, a read-only root, `no-new-privileges`, uid and gid 65534, and a
   network with no route out and no DNS (measured from inside it: the proxy and `1.1.1.1` are both unreachable). It
   runs the proxy's own image, by the same digest, with `sleep` as its entrypoint, so it pulls nothing new;
   `--image-volume=ignore` stops that image's `VOLUME`s from making anonymous volumes. `Restart=always` brings it back
   from a `podman stop`, a `podman stop -a` or a `podman rm -f` behind systemd's back (measured: back on its bridge
   network 1.2 to 1.3 s after a kill, with `RestartSec=1s`), and `StartLimitIntervalSec=0` means a keeper that
   keeps failing never ends `failed` (measured: 10 quick kills in a row, and 15 s of a keeper whose network was gone,
   stayed `active` and `activating`); a clean `systemctl --user stop` leaves it `inactive`, not `failed`. It counts only running ON ITS OWN BRIDGE
   NETWORK: a container of its name on `--network none`, `slirp4netns`, `pasta` or `host` runs and holds nothing open
   (measured), and doctor, `up` and the worker all read the network mode and the networks, not only the state.

   **It protects only while it runs.** Stopped, the next job's teardown breaks the proxy again (measured). So does a
   teardown while it is restarting: measured on 4.9.3, a keeper killed behind systemd's back and a job teardown right
   after the kill left the proxy with no route out; the keeper came back (1.2 to 1.3 s with `RestartSec=1s`) and
   holding, and the proxy still had no route out until the proxy itself restarted. Nothing outside shows that damage,
   so the worker and doctor go by order instead: on Podman 4.x a keeper that started more than 15 s after the
   proxy is taken to have been down under it (a joint start, by `service install`, `up` or a boot, measured 4 to 63 ms
   apart), and each egress job is retried before anything is spent, with a reason
   that says to restart the proxy, until the proxy is started again. For the same reason start the keeper BEFORE the
   proxy (the units and the by-hand commands below do), and a keeper counts only once it has run for 3 s, since one
   that keeps dying reads as running for a moment at a time (measured: 57 of 224 back-to-back reads of a keeper killed
   every 0.5 s). A stopped keeper under a proxy that has been up longer than that needs two steps, and the fix says
   both: start the keeper, then restart the proxy. What the order cannot see is a keeper death and a teardown both
   within the first 15 s after a joint start.

   Its network is made again before every start (`ExecStartPre`, the same flags as the `.network` unit), so a
   `podman network prune` or `podman system prune` run while the keeper is stopped (which removes the network;
   running, both leave it), or a `podman network rm -f` under it, heals on the keeper's next start (measured). If its
   unit ever is `failed` anyway, the repair is:

   ```sh
   systemctl --user reset-failed pi-dispatch-netns-keeper-network.service pi-dispatch-netns-keeper.service
   systemctl --user restart pi-dispatch-netns-keeper-network.service pi-dispatch-netns-keeper.service
   ```

   No pi-dispatch sweep touches it: its names are outside every prefix they remove. `pi-dispatch doctor` reads it
   with the egress policy armed, and on Podman 4.x (or a version `podman info` did not give) a keeper that does not
   hold (not running, running off its own bridge network, running for under 3 s, or started more than 15 s after
   the proxy) is ✗, naming what is wrong and what to run; on 5.x it is ✓ either way. It also reads the keeper's
   network as it is (`podman network inspect`): its units create it with `--ignore`, which keeps an existing network of
   that name whatever its options, so one made by hand without `--internal` or with DNS on is ✗ on every version, with
   the fix (remove the network, restart the keeper units). `service install` and `up` say to restart the egress proxy,
   by its real name, whenever they start or restart the keeper beside a proxy they leave running (an operator's own
   `PI_EGRESS_PROXY`, or ours already up). The worker reads it too, at boot
   (a `netns_keeper_not_holding_at_boot` log line with the whole sentence) and before every egress job on 4.x: while
   it does not hold, each such job is retried before anything is spent, its run record says `netns-keeper-not-holding`,
   the whole sentence is logged as `egress_keeper_not_holding`, and a job that runs out of retries gets a comment
   saying the proxy did not pass its pre-start check and to run `pi-dispatch doctor`, rather than being started into a proxy the job's own teardown would
   break.

   **A keeper that is only young is waited for, not failed** (issue #476). When the whole stack starts together (a
   fresh `service install`, or a boot with linger) the worker reads the keeper less than a second after it started.
   A keeper running on its own bridge network whose only fault is being up for under 3 s is waited out: at boot the
   worker waits until it is 3 s old plus 1 s (at most 4 s, a `netns_keeper_young_at_boot` line saying so) and judges
   it again, logging `netns_keeper_not_holding_at_boot` only if it still does not hold; a job is put back on the queue's delayed set
   for as long, without spending an attempt (a `netns_keeper_young_hold` log line), and runs on the same attempt once
   the keeper holds; a sandbox open waits once too. A keeper that keeps dying is young at every start, so that wait is
   bounded: if, while a job waited, the keeper started again or left its bridge, or the job has waited 30 s, the job
   is retried (spending an attempt) with its run record saying `netns-keeper-crash-loop`, the whole sentence logged as
   `job_failed_netns_keeper`, and a job that runs out of retries gets a comment naming the loop. Once a job has seen
   the loop, any later attempt of it that fails on the keeper (a minute later the keeper has usually restarted out of
   order against the proxy, or is between restarts) is named the loop too. Look at why it exits
   with `journalctl --user -u pi-dispatch-netns-keeper.service`. `pi-dispatch doctor` judges the keeper as before, so
   right after a start it can say ✗ for a keeper under 3 s old: run it again a few seconds later.

   When doctor says ✗ for the keeper, `doctor --live` also tears down nothing the proxy is on, because its own teardowns are the
   same trigger: it runs no egress canary (a second ✗ line says so), no jobToJobIsolation peer networks, and leaves a
   stale probe network that still has the proxy attached, and it reads `egress` and `jobToJobIsolation` as not read
   back, naming the keeper. Fix what the line says and re-run it.

   **Upgrading a Podman 4.x deployment from before the keeper** (issue #458): pause the worker (`pi-dispatch
   pause`, wait for running jobs), re-run `pi-dispatch service install --force` as the worker's account, then
   `pi-dispatch resume`. It installs and starts the keeper and restarts the proxy after it (a keeper started beside a
   proxy that has been up all along would otherwise read as one that restarted under it), with the usual warning that
   a running job loses its route out. `pi-dispatch up` starts the keeper too, and since it leaves a running proxy
   alone, it says to restart the proxy. Until the keeper holds, every egress job is retried and none runs, the worker
   logs `netns_keeper_not_holding_at_boot`, and `pi-dispatch doctor` says why. On Podman 5.x nothing changes.

   **An account that is already damaged** is not healed by starting the keeper, which only prevents the next
   teardown. Start the keeper, then restart the proxy, clearing any failed state first (a squid stop ends `failed`,
   below):

   ```sh
   systemctl --user reset-failed pi-dispatch-netns-keeper-network.service pi-dispatch-netns-keeper.service pi-dispatch-egress-proxy.service
   systemctl --user restart pi-dispatch-netns-keeper-network.service pi-dispatch-netns-keeper.service
   systemctl --user restart pi-dispatch-egress-proxy.service   # after the keeper
   ```

   (`podman restart pi-dispatch-egress-proxy` for a hand-started proxy.) If jobs still cannot reach the proxy or the
   provider, the account's `aardvark-dns` is still running in the torn-down namespace: it logs `os error 99` in the
   journal and keeps a stale DNS record for the old proxy. With nothing of this account running, kill it and clear its
   state, then start everything again (upstream's reset,
   [containers/podman#20396](https://github.com/containers/podman/issues/20396)). Stop the units with `systemctl`,
   not `podman stop -a`: the keeper's `Restart=always` undoes a `podman stop` within seconds (measured), so the
   account would not be left with nothing running.

   ```sh
   systemctl --user stop pi-dispatch-worker.service   # or however this account runs the worker
   systemctl --user stop pi-dispatch-netns-keeper.service pi-dispatch-egress-proxy.service pi-dispatch-valkey.service
   podman stop -a   # anything else of this account's, started by hand
   pkill -u "$(id -u)" -x aardvark-dns
   rm -f "/run/user/$(id -u)/containers/networks/aardvark-dns/"*
   systemctl --user reset-failed pi-dispatch-netns-keeper.service pi-dispatch-egress-proxy.service pi-dispatch-valkey.service
   systemctl --user start pi-dispatch-valkey.service pi-dispatch-netns-keeper.service
   systemctl --user start pi-dispatch-egress-proxy.service   # after the keeper
   systemctl --user start pi-dispatch-worker.service
   ```

   A reboot does the same, since `/run` is a tmpfs.

   A proxy stop takes 10 s: squid does not exit on SIGTERM, so systemd waits out podman's stop timeout, kills it, and
   the unit ends `failed` with exit 137 (measured). Harmless; `service uninstall` clears the failed state.

   The proxy needs a named bridge network: the worker attaches it to each job's `--internal` network by name, and
   measured, a container on Podman's default rootless network (pasta or slirp4netns) is refused with `"pasta" is not
   supported: invalid network mode`. To start it by hand instead of as a unit (it will not come back after a reboot,
   and `up` and `service install` will then refuse to install the unit over it until you remove it),
   from the directory holding your `.env` and the `egress-allowlist.conf`, `model-endpoints.conf` and
   `deploy/egress-proxy.conf` that `pi-dispatch init` wrote, and the keeper FIRST with the same flags its unit generates (a keeper started
   more than 15 s after the proxy reads as one that restarted under it):

   <!-- PODMAN-NATIVE-PROXY -->
   ```sh
   podman network create --internal --disable-dns pi-dispatch-netns-keeper
   podman run -d --name pi-dispatch-netns-keeper --network pi-dispatch-netns-keeper \
     --read-only --cap-drop=all --security-opt=no-new-privileges --user=65534:65534 \
     --init --entrypoint=sleep --image-volume=ignore \
     docker.io/ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029 infinity
   podman network create pi-dispatch-egress-out
   podman run -d --name pi-dispatch-egress-proxy --network pi-dispatch-egress-out \
     -v "$PWD/deploy/egress-proxy.conf:/etc/squid/squid.conf:ro,z" \
     -v "$PWD/egress-allowlist.conf:/etc/pi-dispatch/allowlist.conf:ro,z" \
     -v "$PWD/model-endpoints.conf:/etc/pi-dispatch/model-endpoints.conf:ro,z" \
     docker.io/ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029
   ```
   <!-- /PODMAN-NATIVE-PROXY -->

   The image is the compose file's, by the same digest, and `:ro,z` is there for SELinux as in the compose file.
   `model-endpoints.conf` must exist, even with no endpoints declared: the rules include it, and squid will not start
   without it. After `pi-dispatch egress render`, reload with `podman exec pi-dispatch-egress-proxy squid -k
   reconfigure` (docs/egress.md, "Local model servers").
   Measured from a job's `--internal` network: the proxy answers by name, and nothing on the host does (the host's
   own addresses, `host.containers.internal` and the gateway all refuse or are unreachable), which is stricter than
   the Docker API route, where a host service listening on `0.0.0.0` answers a job. The units in the previous
   paragraphs are what bring the proxy and the keeper back after a reboot; started by hand, neither comes back.
7. **Valkey** can still run anywhere the worker reaches through `VALKEY_URL`. The Quadlet unit in step 6 is the
   default on a host without Docker. **A Valkey that already answers is used only when it is this account's**
   (issue #464): on a host with several accounts, a second account's install used to take the first account's
   Valkey on 6379 as its own, and its worker then drained that account's queue. One rule decides it, and the
   WORKER applies it itself at every start, before it talks to Valkey; `up`, `service install` and doctor apply the
   same function:
   - `VALKEY_URL`'s host is resolved once, as the worker's client resolves it (every address, in the order it tries
     them: `localhost` is `::1` then `127.0.0.1` on Fedora, `127.0.0.1` alone on Ubuntu 24.04, measured). An
     unspecified address is this host: `0.0.0.0` (or anything in `0.0.0.0/8`) reaches `127.0.0.1`, `::` reaches `::1`
     (measured: `redis://0.0.0.0:<port>` reached another account's Valkey). `127.0.0.0/8` and this host's own
     interface addresses are judged too; any other host adds no Valkey here and is not judged.
   - Who holds each address that answers is read from `/proc/net/tcp` and `/proc/net/tcp6`, which every account can
     read. It is this account's when the socket's uid is the account's own (a rootless container's published port,
     measured on Fedora 44 and Ubuntu 24.04) or one of its subordinate uids (a container run with `--network host`),
     taken from `getsubids(1)` where it is installed, which also answers for ranges an SSSD provider serves, else
     from `/etc/subuid`; a refusal says which.
   - The worker then connects to that address as a literal (`127.0.0.1`, not `localhost`; its `worker_started` log
     line names it beside the URL as written), with a `rediss:` URL's
     name kept for the certificate check, so no later DNS answer or address order can send it elsewhere. When
     several addresses answer, the first that is this account's is used, and another account's listener on another
     address of the same name (someone publishing `[::1]` beside your `127.0.0.1`) is named as a ⚠ by doctor and in
     the worker's log, never dialled. Refusing there instead would let any account stop your worker by publishing a
     port.
   - When no answering address is this account's, it is refused, naming the owner: another account (a container of
     one is named by its account, from `/etc/subuid`) or a system service such as a distribution package's Valkey,
     on every venue; and, where `PI_BACKENDS` names `podman` without `local`, root (docker-proxy or a rootful
     container any account with sudo can start) or a listener no socket row explains (only the kernel's NAT answers
     with no socket, as docker without its proxy does). With `local` blessed, root's is docker's Valkey and is taken.
     No uid range decides this, since an LDAP account sits above `UID_MAX` and Lima's default user at 501,
     below `UID_MIN`. The worker exits 2 with that sentence (not restarted), `service install` refuses before it
     writes anything, `up` adds and adopts nothing and exits non-zero, and doctor prints a ✗ and neither PINGs that
     Valkey nor reads its fleet. When nothing answers at all, the worker waits 20 s for a Valkey still starting,
     then exits 1 and systemd starts it again; a name that does not resolve (or a resolver that does not answer) is
     waited for the same way, never taken for another host. A Valkey restart under a running worker is survived:
     each reconnect is judged again, and a judgement that fails meanwhile is retried, not the end of the client.
   - The way out is this account's own port, `VALKEY_URL=redis://127.0.0.1:6380` in that deployment's `.env`:
     `service install` and `up` publish the Quadlet Valkey there (`PublishPort=127.0.0.1:6380:6379`). An `[::1]` URL
     cannot reach that Quadlet Valkey, which publishes on `127.0.0.1` only, and is refused with that reason.
   - A Valkey that is shared ON PURPOSE (a distribution package several deployments use, say) is taken only with
     `PI_VALKEY_SHARED=1` in the deployment's `.env`, and the commands then say whose it is. Every account using it
     can read and drain the others' jobs. It is read from `.env` ONLY, by the worker (from its working directory, the
     deployment folder), `service install`, `up`, doctor and every other client; one set in a shell is ignored and
     said to be, and a command run from a folder with no `.env` takes no opt-in from its environment either. The
     `.env` is read with the same reader as the service's other keys: a line systemd reads differently (a lone CR, a
     NUL, invalid UTF-8) is named, and then only this account's own Valkey is used. `--force`
     does not take it: it replaces changed files, and taking another account's queue must never ride along with that.
     A shared Valkey also takes its owner's password (below).
   - **The password** (issue #468). The owner rule stops an accident; it does not stop another account that
     connects on purpose, since every account on the host shares loopback, and a Valkey without a password let it
     read the queued jobs (their task text, their repositories), enqueue work this account's worker runs with this
     account's provider key, or delete the queue. So the Valkey this project starts has a password of its own,
     `VALKEY_PASSWORD` in the deployment's `.env`. `pi-dispatch init` writes a new one (64 hex characters) into the
     `.env` it creates, which it creates readable by the account alone (mode 0600); `service install` and `up` add
     one to a deployment that has none, never over a value, and narrow the file to its owner. The value is never
     printed: doctor and the worker's log say only whether one is set. Both commands copy it into
     `~/.config/pi-dispatch/valkey.env` (0600, the one key), which the Quadlet unit reads
     (`EnvironmentFile=%h/.config/pi-dispatch/valkey.env`); the container gets it in its ENVIRONMENT, and its start
     command hands it to `valkey-server` as configuration on stdin (`valkey-server -`), written by the shell's own
     `echo` to a 0600 temp file that is opened and deleted before the image's entrypoint runs. Never as
     `--requirepass`: the image's PID 1 is `tini`, which keeps its whole command line for the life of the container,
     and every account on the host read `--requirepass <password>` in `/proc/<pid>/cmdline` (measured on Podman 5.8.1
     and 4.9.3; the image's `VALKEY_EXTRA_FLAGS` appends to that same command line). With the value empty or unset
     the same command starts Valkey without one, as before. Copying the unit by hand? Create that file first
     (`install -m 600 /dev/null ~/.config/pi-dispatch/valkey.env`, then one line `VALKEY_PASSWORD=<the .env's value>`):
     the unit does not start without it. Every client sends the password through the one connection module: the
     worker and the receiver from their environment (the service's loader puts the `.env` there), a CLI command run
     in the deployment folder from its `.env`, the admin panel from the `.env` of the deployment its pointer names
     (the pointer itself never holds it). Another account connecting without it gets `NOAUTH`, and a client of this
     deployment that lacks it, or sends the wrong one, is refused as a configuration error naming
     `VALKEY_PASSWORD`: the worker exits 2, `pi-dispatch run` and the receiver say so, doctor prints a ✗.
   - **The upgrade** of a deployment installed before the password: `pi-dispatch service install --force` as the
     account. It writes a password into `.env`, the password file and the new unit, restarts the Valkey with it
     (the queue in the `pi-dispatch-valkey-data` volume is kept: the stop is a SIGTERM, on which Valkey writes its AOF
     out), then restarts the worker and receiver units that were running, since they read the password only at
     start. A job running at that moment is interrupted, so pause first (`pi-dispatch pause`, wait for active jobs,
     then `resume`). `up` on this venue leaves a running Valkey alone, as it always has, so doctor names
     `service install --force` as the step, and until then warns that the Valkey answers a client that sends no
     password.
   - **A shared Valkey** (`PI_VALKEY_SHARED=1`): put `VALKEY_PASSWORD=<that Valkey's password>` in the deployment's
     `.env`; its owner gives it. `service install` and `up` generate none for a shared Valkey, since one made here
     would reach no Valkey. Without it every command refuses, naming the missing password.
   - An operator's own `VALKEY_URL` (another host, TLS, a managed Valkey with its password in the URL) is left as it
     is: the URL's password wins, none is generated for it, and the `.env`'s `VALKEY_PASSWORD` is sent only to a
     Valkey on this machine's loopback, never to one a shell's `VALKEY_URL` names elsewhere.

   A `VALKEY_URL` line in `.env` that the loaders may read differently is a ✗ of its own in doctor, which then contacts
   no Valkey at all (no reachability probe, no fleet read), since the default it would fall back to may be another
   account's. An installed Quadlet Valkey is kept only while what the worker will use is this account's; with the
   opt-in, a shared Valkey on the port is the queue instead. `up` and `service install` read `VALKEY_URL` from `.env`,
   as the service does (`up` takes this shell's value only where the file sets none, and stops when the two
   disagree). An `[::1]` URL in `.env` must be quoted, `VALKEY_URL="redis://[::1]:6379"`: the macOS wrapper sources the
   file with sh, which may read an unquoted `[` as a pattern. With `local` in `PI_BACKENDS`, docker's Valkey is the
   queue, published by root's docker-proxy, and root's listener is taken; another account's is refused there too.
   Every OTHER Valkey client applies the same rule when it connects, wherever it runs from: `pi-dispatch run`,
   `pause`, `resume`, `status` and `cancel`, the receiver, the admin panel and doctor all build their connections
   through one module, which resolves the name once per process, connects to the literal address judged (this
   account's first, else root's where root may hold it), and refuses another account's Valkey on every venue. Only
   whether root's is refused depends on the deployment (the environment's `PI_BACKENDS`, else the `.env` in the folder
   the command runs in). The receiver judges before it listens and exits 2 on a refusal. The compose file is docker-only. Without `local` in `PI_BACKENDS`, doctor's fix for an unreachable Valkey points at `up` and
   `service install`, and `doctor --fix` offers no `docker run` for it (on no venue since issue #468: its Valkey needs the deployment's password in a child's environment, and doctor hands no program anything from `.env`).
8. **`PI_BACKENDS=podman`** in `.env` (the setup wizard, `/dispatch setup`, writes it when you choose rootless Podman
   at its runtime step), then start the worker, and run `pi-dispatch doctor` and
   `pi-dispatch doctor --live` as the same account, from the deployment folder. doctor reads `PI_BACKENDS`,
   `PI_EGRESS` and `PI_EGRESS_PROXY` as `up` and `service install` do: this shell's value where it sets one, else
   `.env`'s, and a line naming the file when it supplied one; a shell and a `.env` that set one differently is a ✗,
   since the service runs the file (issue #453). It takes every other service setting it judges from `.env` the same
   way where this shell does not set it (`VALKEY_URL`, `PI_PROVIDER`, the provider key's presence, and since issue #471
   `PI_JOB_IMAGE`, `PI_TRIGGERS_FILE`, the dirs and the rest), and says so; a shell and a `.env` that set one
   differently is a ✗ there too, a credential named without its value; it never prints a key. doctor's podman section checks that `podman info` answered, that
   the service is rootless and not remote, that a user manager runs with the controllers delegated and Podman puts
   containers under it (step 3), whether SELinux relabelling applies,
   that the job image is in this account's store, and, with the egress policy armed, that the proxy is running under
   this Podman and that its rootless network keeper holds (not holding is ✗ on Podman 4.x only, step 6). `--live`
   reads the declarations back off real containers and says it read them back on podman,
   `egress` included: with the policy armed it first runs doctor's egress canary under this account's Podman, three
   containers built like a podman job (your uid as `--user`, `--userns=keep-id`, the venue's pinned flags, a job's
   proxy variables) on a job-shaped `--internal` network with the proxy attached, one that must reach the provider
   through the runner's own route, one that must not reach an unlisted host, and one whose plain HTTP to a listed
   host off port 80 must be refused (issue #508). Its lines start `podman: Egress`,
   before the read-back's. A plain `pi-dispatch doctor` does not run it on this venue, and says so in a ⚠ line
   pointing at `--live`. A canary network a killed `--live` left behind is removed by the next `--live`, on
   Podman 4.9 and 5.x alike: the sweeps read what is on a network with `podman ps -a --filter network=<net>`,
   because Podman 4.9's `network inspect` has no member list (issue #452), and a probe or proxy that has stopped
   is dealt with too, because Podman will not remove a network while any container, running or not, is still on it.
   On Podman 4.x nothing RUNNING is ever detached from a network while the rootless network keeper does not hold,
   whichever CLI reaches it (`podman`, `podman-docker`, or the real docker CLI on its API socket): a leftover is then
   kept and said, and doctor runs no canary and no peer networks, with a line saying why (issue #452).
   `.github/scripts/podman-conformance.mjs` runs the same canary, and then the same sweep over two leftovers it
   makes.
   With `PI_BACKENDS=podman` (no `local`), doctor runs no `docker` command at all, so a host without Docker reads
   no Docker failure: one line says `Docker: not checked -- PI_BACKENDS lists no docker venue (local), so no job
   here runs on Docker`, and the podman section's image line is the image check (✗ while the job image is not in
   this account's store). A trigger's `run.image` is looked for in the store of the venue that trigger runs on
   (`run.backend`, else the first venue in `PI_BACKENDS`), and the in-image `gh auth status` check runs through
   `podman` once the job image is in this account's store and a podman job could run there, with the venue's pinned
   flags, so an `env_host = true` in containers.conf copies nothing of doctor's environment into it. A trigger whose
   `run.backend` names a venue `PI_BACKENDS` does not list fails doctor with that trigger named: the worker refuses
   every one of its jobs (`backend-unblessed`). A cron trigger is judged only when this host's worker schedules it:
   `PI_TRIGGERS_FILE` is set, and on a fleet its folder is on this machine (another machine's is left to that
   machine's doctor). Every forge trigger is judged.

On an SELinux host, the worker's own per-job directories carry `:Z` exactly as on the Docker API route, decided from
`podman info`'s `selinuxEnabled`, and an operator's local folder and `PI_GLOBAL_PI_DIR` need the one-time
`semanage fcontext` label the SELinux section above gives.

The first job on an image this account has never run pays once for keep-id: on an overlay store that cannot shift
ids (`podman info` says `Supports shifting: false`), Podman copies the image's layers to the mapped ids before the
container starts. Measured on Fedora 44 for the job image: 27.1 s for that first run, then 0.15 s, against 0.12 s
without keep-id. `doctor --live` and the conformance script give a container start 120 s on this venue for that
reason. Running `podman run --rm --userns=keep-id --user=$(id -u):$(id -g) --entrypoint true <image>` once after a
pull pays it ahead of the first job.

### The sandbox on this venue

`pi-dispatch sandbox <jobId>` (and `b` on an opened run in the panel) reopens a run this venue ran under this account's rootless Podman,
never under Docker: every step of the session goes through the `podman` CLI, the running check, the session's
egress network and its removal, the launch and `podman attach` after a detach. It opens only where the shell you run it
from has `PI_BACKENDS` naming `podman`, because that is read from your environment and not from the deployment's
`.env`; without it the run is refused and the message says so (`--list` shows `not here (PI_BACKENDS lacks podman)`).

The shell's container is a job's on this venue, by the same builder: `--userns=keep-id` with `--user=<uid>:<gid>` and
`HOME=/home/pi`, the pinned namespaces, and always a named network, the session's own `--internal` one with egress on
and `--network=private` with it off, so a `netns = "host"` default cannot put it on the host's. It is refused for what
a job on this venue is refused for, in the same order and by the same check: not Linux, no `podman`, a remote
service, rootful Podman, a containers.conf that sets `pasta_options`, `network_cmd_options`, `annotations`, `env`, `helper_binaries_dir`, `network_cmd_path`, `default_sysctls`, `default_ulimits`, `seccomp_profile`, `init_path`, `dns_servers`, `dns_options`, `dns_searches`, `base_hosts_file`, `oom_score_adj`, `privileged`, `label`, `cgroup_conf`, `host_containers_internal_ip`, `runtimes`, `conmon_path`, `cgroups` or `umask`, or a rootless network still running with such an option, found from
`/proc` and Podman's pid file for it under `podman info`'s `store.runRoot` (`podman-conf-widens-job`, also when
`podman info` reports no `store.runRoot`; or `podman-conf-unread` when a containers.conf, `/proc` or that pid file
could not be read just now: try again), and a
`PI_BACKEND_FLOOR` the observations miss. With egress armed on Podman 4.x it is also refused while the rootless
network keeper (step 6) does not hold, by the same check a job gets (`netns-keeper-not-holding`, with the command to
run; a keeper only under 3 s old is waited for once, at most 4 s, and then judged again): closing the shell removes its network, and that disconnect of the running proxy is what cuts the proxy's route
out on 4.x without the keeper (issue #458). Then the sandbox's own: it runs as the account that opens it (keep-id maps
that account, and the run's image is in that account's store), so open it as the account the worker runs as, never
with `sudo`; a run opened under another container store is refused (`podman-store-mismatch`, below); and a run
recorded as another uid is refused rather than reopened as one.

`--publish` works with egress off, and says something alarming while it does: Podman prints `Port mappings have been
discarded because "private" network namespace mode does not support them`, yet the port IS published on
`127.0.0.1` and answers (measured on Podman 5.8.1; pasta holds the listener). With egress armed `--publish` is
refused, as on docker, though for a different reason: Podman would bind the port on the session's `--internal`
network (measured), a way into the one network the policy means to confine.

Open the sandbox as the account the worker runs as, with the worker's CONTAINER STORAGE: the same `HOME`, the same
`XDG_DATA_HOME` (or none, as the worker's service has) and no `storage.conf` of your own. Measured on Podman 5.8.1: a
rootless Podman with another `HOME` or `XDG_DATA_HOME` uses another store, and `podman ps -a` there answers with an
empty list and exit 0, so a sandbox opened from it is one the worker's retention sweep read as not open, and it deleted
the retained directory under the open shell. So the worker records each podman run's store (`podman info`'s
`graphRoot`) in the retained manifest; `pi-dispatch sandbox` refuses to open the run under another store
(`podman-store-mismatch`, naming both paths), and the sweep holds the run while the podman it asks uses another store
or cannot say which. A different `XDG_RUNTIME_DIR` was measured harmless: Podman takes the runtime directory from its
own database, or fails, which the sweep treats as a runtime that did not answer.

If the worker's own `HOME` or `XDG_DATA_HOME` changes, every podman run retained before the change recorded the old
store, and the sweep holds each one on every pass (`sandbox_reaper_skipped` with `podman-store-mismatch`), because
the new store's `podman ps` cannot say whether a sandbox is open on it. Once you know none is, remove them by hand,
as for a local run on a host without docker (`docs/backends.md`): `pi-dispatch sandbox --list` shows their ids, and
`rm -rf "$PI_SANDBOX_DIR/<jobId>"` removes each. A retained directory whose manifest could not be read for a moment
(EMFILE, EIO) is held on every pass it stays unreadable (`manifest-unread`, said each pass).

On an SELinux host the retained job directory and the retained clone carry `:Z`, decided from `podman info`'s
`selinuxEnabled` as a job's are, so the shell reads them under `container_file_t` the way the job did; a local run's
own folder is never relabelled and needs the `semanage fcontext` label from the SELinux section.

### The CPU reserve on this venue

How to choose sizes and a budget is in [sizing jobs](sizing.md); this section is what differs on this venue.

Every job gets the size its project sets (see [job sizes](scoped-limits.md#job-sizes-version-3)) and a `--cpus`
ceiling of the host's CPU budget ([the host budget](multi-host.md#the-host-budget)), which on this venue also takes
a `cpu.max` or `memory.max` set on the account's systemd user service into account. The ceiling bounds one job; what
holds all of them together to the budget is the parent cgroup every job, sandbox and doctor probe runs under,
`pidispatch.slice`, which on this venue sits under the account's user manager
(`/sys/fs/cgroup/user.slice/user-<uid>.slice/user@<uid>.service/pidispatch.slice`). The worker sets its quota itself,
when it starts and whenever the budget changes, with no root:

```sh
systemctl --user set-property pidispatch.slice CPUQuota=300%
systemctl --user show -P CPUQuotaPerSecUSec pidispatch.slice   # 3s
```

It is kept in `~/.config/systemd/user.control/` and survives a reboot (measured on Podman 4.9.3 and 5.8.1). It needs
the `cpu` controller delegated to the user manager, which this venue already requires (step 3). `pi-dispatch doctor`
reads it back and warns "no host CPU reserve across jobs" when it is missing or differs from the budget;
`pi-dispatch doctor --live` reads a probe container's own cgroup and finds it under the parent, with the parent's
`cpu.max`. With `PI_HOST_CPU_BUDGET=off` the worker clears the quota (`CPUQuota=`). Where Podman uses the `cgroupfs`
cgroup manager instead of `systemd`, jobs run without the parent and each job's CPU weight is capped at
`--cpu-shares=1024`, so the egress proxy gets a fair share of the CPU, not a reserve; doctor says so. Inside the parent
the job sizes still order the jobs under contention; on Fedora's kernel 6.19 the split between sizes is smaller than
the sizes (1:1.3:1.8 for 1:2:4, measured rootless), the order holds. Fedora also applies systemd-oomd's per-slice
defaults to every user slice, the parent included; the worker sets no memory limit on it.

### What the venue does not do yet

- **The compose file is docker-only**, and the setup wizard explains rather than runs its receiver answer on this
  venue. `pi-dispatch up`, `pi-dispatch service install` and the wizard start the stack as Quadlet units (step 6).
- **A proxy restart is not repaired for jobs already running**: the worker does not re-attach their networks to the
  new container (step 6).
- **Exit 1 from a container that never started.** The job argv carries `--init`, so a missing or non-executable
  entrypoint arrives as exit 1 with catatonit's `failed to exec pid1` on stderr (measured), which a job's own process
  could print too. It is retried as an infrastructure failure and not refunded, exactly as on the Docker API route.
  A name conflict and an absent image are 125 and refunded as never started (measured: `already in use`, and
  `<ref>: image not known`).
- **`podman machine`** (macOS, Windows) is refused as `podman-platform`, since nothing about it was measured.

## Property table

Each cell is the word a job gets, or the refusal. "Observed" means the worker checks it at boot and before each job.
Measured on Podman 5.8.2 (netavark 1.17.2, aardvark-dns 1.17.1, crun 1.27.1, conmon 2.2.1, Fedora 42) and Docker
Engine 27.5.1, in nested labs, and re-run against this page on 2026-09-21. On the Fedora 44 host (Podman 5.8.1,
2026-09-25) `doctor --live` read `isolation`'s bounds, `imagePinning`, `nonRoot`, `egress` and `jobToJobIsolation`
back as holding; see "Measured on a real host" for what else was measured there. The first six columns are the
`local` venue on each runtime; the last is the native `podman` venue, measured with rootless Podman 5.8.1 on that
same host.

<!-- PODMAN-PROPERTY-TABLE -->
| Property | Docker Engine, rootful | Podman rootful | Podman rootless, keep-id, Docker API | Podman rootless, Docker API | podman-docker, rootful | podman-docker, rootless | podman (native, rootless) |
|---|---|---|---|---|---|---|---|
| isolation | enforced | asserted (bounds applied, not credited) | refused: rootless | refused: rootless | asserted | refused: rootless | enforced while this account's systemd user manager is observed running with the pids, memory and cpu controllers delegated to it and Podman putting containers under it, else asserted |
| ephemeral | enforced | enforced | refused: rootless | refused: rootless | enforced | refused: rootless | enforced |
| mountSet | enforced | enforced with the empty override, else asserted | refused: rootless | refused: rootless | enforced with the empty override, else asserted | refused: rootless | enforced while the mounts.conf that applies is observed empty, else asserted |
| egress | enforced (PI_EGRESS) | enforced (PI_EGRESS) | refused: rootless | refused: rootless | enforced (PI_EGRESS) | refused: rootless | enforced (PI_EGRESS) |
| jobToJobIsolation | enforced (PI_EGRESS) | enforced (PI_EGRESS) | refused: rootless | refused: rootless | enforced (PI_EGRESS) | refused: rootless | enforced (PI_EGRESS) |
| imagePinning | enforced | enforced | refused: rootless | refused: rootless | enforced | refused: rootless | enforced |
| exitCodes | enforced | enforced, see below | refused: rootless | refused: rootless | enforced, see below | refused: rootless | enforced, with the exit 1 its section names |
| abortable | enforced | enforced | refused: rootless | refused: rootless | enforced | refused: rootless | enforced |
| readOnlyJobInputs | enforced | enforced | refused: rootless | refused: rootless | enforced | refused: rootless | enforced |
| nonRoot | asserted | asserted (the worker's uid, passed as --user) | refused: rootless | refused: rootless | asserted | refused: rootless | enforced (the worker's non-zero uid as --user, with --userns=keep-id) |
| secretsCustody | enforced | enforced | refused: rootless | refused: rootless | enforced | refused: rootless | enforced |
| credentialTransit | enforced (observed) | enforced (observed) | refused: rootless | refused: rootless | asserted (no context to observe) | refused: rootless | enforced while podman info is observed saying the service is local, else asserted |
| localFolders | enforced | enforced (as the worker's uid) | refused: rootless | refused: rootless | enforced | refused: rootless | enforced (as the worker's uid) |
<!-- /PODMAN-PROPERTY-TABLE -->

How each column is known:

- **Docker Engine, rootful**: the backend table itself, which a test bolts this column to
  (`worker/test/podman-doc.test.mjs`).
- **Podman rootful**: measured in the lab, rows listed under "How this was measured".
- **Podman rootless, Docker API** and **Podman rootless, keep-id, Docker API**: measured, through the real docker CLI
  and through the shim. Setting `userns = "keep-id"` in the user's own containers.conf changes nothing `docker info`
  reports, and the refusal is identical: keep-id is a per-container mapping rather than a property of the daemon, so it
  cannot reach the decision at all, which is why a keep-id host needs the native backend `OQ-037` describes. In both
  columns every word after the refusal is moot, because no job runs. Cgroup readings taken there are lab-limited (a
  nested lab without systemd delegation) and nothing here rests on them.
- **podman-docker, rootful and rootless**: the job user, the doctor lines, the two observations and the rootless
  refusal are measured; no job was run through the shim. Through it `docker context ls` prints a header row and
  nothing else and `docker context inspect` prints nothing at all, which is why `credentialTransit` reads asserted.
  The rootful column's `mountSet` row still reads this host's Podman files, so the empty override credits it there
  too. Every other word in that column is the rootful column's, because it is the same daemon reached by a different
  command, and where that inheritance is not safe the page says so.
- **podman (native, rootless)**: the backend table's `podman` entry, which a test bolts this column to the way the
  Docker Engine column is bolted to `local`'s: each word is what the entry declares, "else asserted" where the word
  holds only while observed, and `(PI_EGRESS)` where the switch arms it. What the words rest on was measured with
  rootless Podman 5.8.1 on the Fedora 44 host (2026-09-25), and `.github/scripts/podman-conformance.mjs` reads the
  eight container properties back off containers the venue's own `runContainer` path started.

## Entry points

| Entry point | Docker Engine, rootful | Podman rootful | Podman rootless, keep-id, Docker API | Podman rootless, Docker API | podman-docker, rootful | podman-docker, rootless | podman (native, rootless) |
|---|---|---|---|---|---|---|---|
| worker | runs jobs as `--user` | runs jobs as `--user` | refused `rootless` | refused `rootless` | runs jobs as `--user`; `credentialTransit` asserted | refused `rootless` | runs jobs as the worker's uid, with `--userns=keep-id` |
| `pi-dispatch doctor` | names Docker Engine | names Podman through its Docker API; `isolation` asserted, `mountSet` per the override | ✗ `rootless` | ✗ `rootless` | ⚠ names podman-docker and the context fix | ✗ `rootless` | names the podman venue: `podman info`, rootless, not remote, controllers, the image in this account's store; without `local`, runs no docker |
| `pi-dispatch doctor --live` | reads the declarations back | reads the declarations back | not run (a local job is refused) | not run | not run (the endpoint is not observed on this host) | not run | reads the declarations back on podman, `egress` through a canary under this account's Podman |
| `pi-dispatch sandbox` | opens as the run's own uid | opens as the run's own uid | refused `rootless` | refused `rootless` | opens as the run's own uid (unmeasured) | refused `rootless` | opens as the opening account's uid with `--userns=keep-id` through `podman`, where `PI_BACKENDS` names podman; a run recorded as another uid does not open |
| `pi-dispatch up` | runs doctor at the end | runs doctor at the end | as doctor | as doctor | as doctor | as doctor | pulls the job image into this account's store, starts Valkey and the proxy as Quadlet units (setup step 6), then runs doctor |
| `docker compose --profile egress` | runs unchanged | runs unchanged through the real docker CLI | unmeasured (a job is refused anyway) | unmeasured (a job is refused anyway) | unmeasured | unmeasured | docker-only; the proxy runs as this account's Quadlet unit instead |

None of this is Podman's: which refusals stop a worker booting, which refuse each job, and what a job that cannot
be decided yet does instead are the job-user rule's, the same on every daemon, and
`DES-JOB-USER-INFERRED-READ-BACK-ON-REQUEST` owns them. The last column is the exception: the native venue decides
from `podman info` with rules of its own, `DES-PODMAN-NATIVE-ROOTLESS-BACKEND` owns those, and its section above
lists them. What holds here whatever the timing: no refused job spends,
because the decision is read before the budget slot is reserved, and `pi-dispatch doctor` on your own host tells you
which of these you are in.

## Health checks need systemd

Podman schedules a container's health check with a transient systemd timer, so it runs on a systemd host and nowhere
else.

**On a systemd host the status is live.** Measured on Fedora 44 with systemd 259.5 (2026-09-25): after
`docker compose --profile egress up -d` the proxy reached `healthy` in about 35 s with no manual
`podman healthcheck run`, its health log shows the check running on its own 30 s schedule (a first
`Connection refused` while squid started, then exit 0), and `systemctl list-timers` lists the transient
`<container id>-<hash>.timer`. Valkey reached `healthy` in 10 s. doctor's `Egress proxy health` line is then a
current answer.

**Without systemd nothing ever runs one** (a container, a minimal image). Measured in the lab, where PID 1 is not systemd: the compose
file's Valkey, six days up and declaring a 10 s interval, reports `starting` with an empty log, because the check
has never run. The squid proxy beside it reports `healthy` off a single log entry from the day the lab was built,
when the check was run by hand; a second `podman healthcheck run` adds a second entry and nothing else moves it.
Recreating both services from the compose file puts them back at `{"Status":"starting","Log":null}`, so a fresh
start is where every container on such a host stays.

So on such a host the status Podman stores is whatever the last manual run left, and doctor prints that stored word:
`Egress proxy health: starting` as a warning where no check has run, and a `healthy` that may be days old where one
has. Read it as the last answer, not a live one. The worker's egress gate reads only whether the proxy is running,
so no job is refused for a health status, on either kind of host.

## exitCodes on Podman

On the Docker API route the worker reads the container's exit code through the docker CLI, and four Podman
differences matter (the native venue's, which runs no API service, are in its own section above):

- **A container that cannot start arrives as exit 1**, not 126 or 127. Measured on the attached path, with the job
  argv and with a bare `docker run`, for an entrypoint that does not exist and for one that exists and is not
  executable: all four exit 1. Docker gives 127 and 126 for the same two. The worker retries exit 1 as an
  infrastructure failure rather than refunding it as never-started, so such a job costs a retry instead of being
  declared free.
- **What it prints depends on `--init`, the exit code does not.** The job argv carries `--init`, so the message is
  catatonit's (`ERROR (catatonit:2): failed to exec pid1: No such file or directory`, or `Permission denied`).
  Without `--init` the same failures print `unable to upgrade to tcp, received 500`, which is the attached API's
  own shape and what other container-creation failures surface as. Both measured.
- **A name conflict and an absent image stay 125**, refunded as never-started, exactly as on Docker (measured: `the
  container name "..." is already in use by <id>`, and `no such image: ...: image not known`).
- **A lost API service mid-job** makes the CLI exit 125 while the container keeps running (measured last round, when
  the rootful service was killed mid-job; it is recorded in `DES-PODMAN-THROUGH-ITS-DOCKER-API` and the observations
  entry rather than re-run here). The worker finds that container through the run's cidfile, stops and removes it,
  and retries the job as `container-detached` without refunding it. A service still down after 10 s cannot be asked
  to stop it, and the container then keeps its name until it exits.

## Measured on a real host

What the nested lab could not answer, measured on a Fedora 44 host (issue #355). Each row's Result is one of four
words: `measured` (it holds as this page describes it, with nothing changed), `argv: <option>` (it holds with that
mount option, which the argv or the compose file now carries), `refused: <reason>` (a job there is refused before it
spends, with that reason), or `doc: <what changed>` (it holds once the setup step this page now gives is followed).
`worker/test/podman-doc.test.mjs` pins the vocabulary, and pins the two `argv:` words to what the job argv builder
and the compose file actually say.

<!-- PODMAN-HOST-ROWS -->
| Row | Result | Podman | Date |
|---|---|---|---|
| SELinux: the worker's own per-job mounts | argv: :Z | 5.8.1 | 2026-09-25 |
| SELinux: an operator's local folder, unlabelled | refused: job-inputs-unreadable | 5.8.1 | 2026-09-25 |
| SELinux: the global overlay, unlabelled | refused: job-inputs-unreadable | 5.8.1 | 2026-09-25 |
| SELinux: SecurityOptions carries name=selinux | measured | 5.8.1 | 2026-09-25 |
| nftables: egress reaches the provider and denies an unlisted host | measured | 5.8.1 | 2026-09-25 |
| nftables: jobToJobIsolation | measured | 5.8.1 | 2026-09-25 |
| Health checks under systemd | measured | 5.8.1 | 2026-09-25 |
| SELinux: the compose file's config mounts | argv: :ro,z | 5.8.1 | 2026-09-25 |
| Setup step 2, the socket for the worker's group | doc: /run/podman tmpfiles override | 5.8.1 | 2026-09-25 |
<!-- /PODMAN-HOST-ROWS -->

The host: Fedora 44, kernel 6.19.10, SELinux enforcing (selinux-policy 43.3, container-selinux 2.247.0), systemd
259.5, cgroup v2 with the systemd cgroup manager, rootful Podman 5.8.1 behind `podman.socket`, netavark 1.17.2 using
its nftables firewall driver (its log says `Using nftables firewall driver`, and the rules are in `table inet
netavark`), aardvark-dns 1.17.0, crun 1.27, conmon 2.2.1, and Fedora's docker-cli 29.7.2 and docker-compose 5.5.1
through a docker context, as an unprivileged worker account (uid 1234). A Lima virtual machine on a Mac, so a whole
Fedora with its own kernel and systemd, not a container.

What each row rests on:

- **The SELinux rows**: a `docker run --user=1234:1234` of the job image against folders under `/tmp`, a home
  directory, `/var/lib` and `/srv`, each with no option, `:ro`, `:z` and `:Z`, the labels read before and after; the
  job-user end-to-end script and `doctor --live` failing at `/job` on the worker before this release; and a folder
  labelled with `semanage fcontext` then read and written with no option. The per-job row's `:Z` and the two refused
  rows are this release's worker and runner, run on that host against an image built from them:
  `.github/scripts/podman-host-check.mjs` passed every check, the job-user end-to-end script included, for a jobs
  directory under `/tmp` and under a home directory, and `doctor --live` read every property back as holding once
  `/etc/containers/mounts.conf` was emptied (Setup covers that file).
- **The nftables rows**: `pi-dispatch doctor --live` with `PI_EGRESS` armed and the allowlist `pi-dispatch init`
  writes: the provider answered through the proxy with no key, an unlisted host was denied, and a job network's peer
  was unreachable by its container name, its hostname and its address (`enotfound`, `enotfound`, `enetunreach`) while it answered
  itself before and after.
- **Health checks** and **the compose file's config mounts**: the compose egress profile brought up from scratch, with
  the health log and `systemctl list-timers` read, first as the file was (squid crash-looping) and then with `:ro,z`.
- **Setup step 2**: steps 1 to 3 of Setup followed literally, then the `tmpfiles.d` override, then a reboot.

To add a row or re-measure one, run `.github/scripts/podman-host-check.mjs` on an enforcing SELinux host with systemd,
as the worker's account, from the deployment directory. It refuses to record anything unless SELinux is enforcing,
systemd is running, netavark uses nftables and cgroups are v2, and it prints the rows that held in this table's
shape, ready to paste between the markers.

## Reaching a model server on the host

A job's own `--internal` network still reaches nothing on the host. The egress proxy does, and that is how a job
reaches a model server on the host (issue #503). Measured on 2026-09-30 with a CONNECT tunnel through the proxy,
the way pi sends. The rootless 5.8.1 rows were re-run independently the same day; the 4.9.3 and rootful rows were
not:

- `host.containers.internal` works on rootless Podman with no flag and no containers.conf key. The server
  listens on the host's LAN address or on `0.0.0.0`.
- On rootful Podman `host.containers.internal` is the network gateway, and the server listens on `0.0.0.0` only.
- The host's own LAN address works under slirp4netns and on rootful Podman, and is refused under pasta. So
  "LAN endpoints only for Podman 4.x" is not needed: 4.9.3 reaches the host too.
- Another machine on the LAN was reachable on all three. That is an ordinary outbound route, not a route to the
  host. A server that listens on loopback only is never reached.
- `host.docker.internal` was not measured as a route on Podman, so it has no Podman row.

`HOST_ROUTES` in `worker/src/backends.mjs` holds these rows with what each needs, and `docs/backends.md` lists the
Docker ones too. A version not in the table is unmeasured.

<!-- PODMAN-MODEL-ROUTES -->
| Podman | Mode | Endpoint host | Route | Date |
|---|---|---|---|---|
| 5.8.1 | rootful | `host.containers.internal` | works | 2026-09-30 |
| 5.8.1 | rootful | this host's own LAN address | works | 2026-09-30 |
| 5.8.1 | rootful | another machine on the LAN | reachable | 2026-09-30 |
| 4.9.3 | rootless, slirp4netns | `host.containers.internal` | works | 2026-09-30 |
| 4.9.3 | rootless, slirp4netns | this host's own LAN address | works | 2026-09-30 |
| 4.9.3 | rootless, slirp4netns | another machine on the LAN | reachable | 2026-09-30 |
| 5.8.1 | rootless, pasta | `host.containers.internal` | works | 2026-09-30 |
| 5.8.1 | rootless, pasta | this host's own LAN address | refuted | 2026-09-30 |
| 5.8.1 | rootless, pasta | another machine on the LAN | reachable | 2026-09-30 |
<!-- /PODMAN-MODEL-ROUTES -->

## Not measured

`podman machine` on macOS or Windows, Podman Desktop, Docker Desktop for Linux, OrbStack and Colima. Each is unmeasured,
not refused, except Docker Desktop on Linux outside WSL, which is refused from its vendor documentation
(`desktop-linux-userns`), and `podman machine` on the native venue, which refuses any host that is not Linux
(`podman-platform`). `OQ-037` tracks what would close each. Docker Engine with `selinux-enabled` is out of scope and
unmeasured: the worker relabels job mounts on Podman only, so a job there gets the argv it always did.

## How this was measured

In nested labs on a Mac: a privileged `docker:27-dind` for Docker Engine, and a privileged Fedora 42 container
running rootful and rootless Podman services, the real docker CLI and `podman-docker`. The job image, the worker and
`doctor --live` ran inside them as an unprivileged account (uid 1234), against the worker at commit a69b9a6, the
last commit before this page and the one that carries every line of worker code it describes (this PR changes no
worker code). Rows that nesting can distort (rootless cgroup bounds) were labelled lab-limited and not relied on.
The
lab was configured with netavark's iptables firewall driver, because the LinuxKit kernel rejects its nftables rules,
and with `cgroup_manager = "cgroupfs"` and a file event logger, because it has no systemd. Those three settings are
carried over from the lab's build rather than re-read this round. A real Fedora host uses nftables, systemd cgroups
and journald, and that was measured separately on 2026-09-25, on a Fedora 44 host with SELinux enforcing: see
"Measured on a real host", which lists its versions. It left `firewall_driver` unset in containers.conf, and netavark
chose nftables on its own.

Every sentence above that says "measured" of the lab was re-run on 2026-09-21 against this page, one command log per
claim, and the decisive output is quoted in the closing comment on issue #345, where it stays readable after the lab
is gone. The Fedora 44 host's measurements were taken on 2026-09-25 for issue #355, which carries their command logs. The
native venue's were taken on the same host on the same day, with rootless Podman 5.8.1 as uid 1234, for issue #354:
keep-id with and without `--user`, a rootful keep-id run, the full isolation flags and their bounds read back, the
exit codes, `--rm` and the cidfile, the job and proxy networks, name filters, image resolution, `.Mounts`, a system
unit under linger, `serviceIsRemote` with and without `CONTAINER_HOST`, the `mounts.conf` chain and SELinux.
The one exception is the lost API service under exitCodes, which says so where it stands: it was measured when the
behaviour was found, and re-running it means killing a daemon mid-job.
What the lab could not answer says "unmeasured" instead, and every refusal quoted here is pinned to the worker's own
text by `worker/test/podman-doc.test.mjs`, so a quote cannot drift away from the code it claims to repeat.
