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
  Podman (measured: `pids.max` 512 and `memory.max` 4 GiB in a job container, a fork run stopped at 504 children, a 64
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
   drop-ins, and install no OCI hooks, or the worker gives `mountSet` no credit. Two more conditions it checks: the
   worker must be able to READ those files, and FIPS mode must be off, because a FIPS host mounts its crypto policy
   into every container. No restart is needed: the worker reads these files before each job.
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
   `docker compose -f deploy/docker-compose.yml up -d` for Valkey, and `--profile egress` as well if you use the
   egress policy. Podman serves it through the same Docker API, and compose needs no adaptation (measured with
   v2.33.0 in the lab and 5.5.1 on Fedora 44). Its config mounts carry `:ro,z` for an SELinux host (see SELinux
   below), which does nothing where SELinux is off. `podman compose` is not a second implementation: it executes
   whatever compose provider it finds, which on a host set up this way is that same binary, and it says so on stderr.
   One file for both daemons is not one file for two stacks: it fixes the proxy's container name, the egress
   network's name and Valkey's published port, so one host runs one of these stacks (true on Docker too).
8. **Run `pi-dispatch up`, then `pi-dispatch doctor --live`.** doctor names the runtime (`local: the daemon is Podman
   5.8.2, through its Docker API`), and `--live` reads the declarations back off real containers on this daemon.
   On an SELinux host, read the next section before the first job.

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
`provider-auth-refused` (the one the record names itself); the worker's log carries its exit line, where
`job-inputs-unreadable` and the path are named.

`:Z` relabels a directory recursively on every run, so a forge job whose clone is large pays for relabelling it
before the container starts. That cost was not measured.

The compose file's config mounts (`egress-proxy.conf`, `egress-allowlist.conf`, `triggers.json`), and the two mounts of
the proxy that `pi-dispatch up` starts, carry `:ro,z`:
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
and whether the worker is root; then, per job, whether the worker's primary group is gid 0 and whether the image
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
   and then `podman system migrate`. The worker must not run as root: the venue refuses it.
2. **Linger**, so the account's runtime directory and its systemd user instance exist without anyone logged in:
   `sudo loginctl enable-linger <account>`. Measured: with linger, a system unit running as that account
   (`deploy/worker.service` with `User=` set to it) runs `podman` with or without `XDG_RUNTIME_DIR` in its
   environment, since Podman then falls back to `/run/user/<uid>`.
3. **cgroup v2 with the controllers delegated.** `podman info --format '{{.Host.CgroupControllers}}'` must list `cpu`,
   `memory` and `pids`. Fedora delegates all of them to user sessions (measured: `cpuset cpu io memory pids`); where a
   distribution does not, a drop-in for `user@.service` with `Delegate=cpu cpuset io memory pids` does. Leave `cgroups`
   unset in every containers.conf the account reads: measured with `--cgroups=disabled`, `--memory` and `--pids-limit`
   are accepted and silently not applied, and the bounds read back as `max`. The worker credits `isolation` only while
   it observes the delegation (`podmanBoundsDelegated`), and `pi-dispatch doctor --live` reads `pids.max` and
   `memory.max` back off a real container.
4. **No mounts of Podman's own.** `mkdir -p ~/.config/containers && : > ~/.config/containers/mounts.conf`. For a
   rootless account the user's `mounts.conf` replaces `/etc/containers/mounts.conf`, and an EMPTY file at whichever
   of the two applies stops the default `/run/secrets` mount (both measured). Leave `volumes`, `mounts`, `devices`
   and `hooks_dir` unset in every containers.conf the account reads, install no OCI hooks, and keep FIPS mode off,
   or the worker gives `mountSet` no credit (`podmanAddsNoMounts`). Leave `CONTAINERS_CONF` and
   `CONTAINERS_CONF_OVERRIDE` unset for the worker too: with either set, the files the worker reads are not the ones
   Podman reads, so it credits neither `isolation` nor `mountSet`.
   Leave `pasta_options` and `network_cmd_options` without a host-loopback mapping (`--map-host-loopback`,
   `allow_host_loopback=true`), and `annotations` without `run.oci.keep_original_groups`. Nothing observes either yet
   (issue #428), and the argv cannot pin the first back: Podman appends containers.conf's network options to the
   command line's, so a loopback mapping there gives every job without egress the host's `127.0.0.1` services, a
   local Valkey among them (measured). The namespaces, `env_host` and `http_proxy` it can pin, and does.
5. **The job image, in this account's own store.** A rootless account does not see root's images or another
   user's: `podman pull ghcr.io/edgehero/pi-job:latest` as the account, then set `PI_JOB_IMAGE` to the name
   `podman images` shows. `--pull=never` resolves a short name such as `pi-job:latest` to `localhost/pi-job:latest`
   with no registry lookup (measured). The image must declare `anyUid` unless the account is uid 1001; releases
   since issue #341 do.
6. **The egress proxy, under the same rootless Podman, on a named bridge network.** The worker attaches the proxy to
   each job's `--internal` network by name, and only a container on a named network can be attached: measured, a
   container on Podman's default rootless network (pasta or slirp4netns) is refused with `"pasta" is not supported:
   invalid network mode`. The compose file is docker-only, so start it by hand, from the directory holding your
   `.env` and the `egress-allowlist.conf` that `pi-dispatch init` wrote, with `egress-proxy.conf` from `deploy/`:

   <!-- PODMAN-NATIVE-PROXY -->
   ```sh
   podman network create pi-dispatch-egress-out
   podman run -d --name pi-dispatch-egress-proxy --network pi-dispatch-egress-out \
     -v "$PWD/deploy/egress-proxy.conf:/etc/squid/squid.conf:ro,z" \
     -v "$PWD/egress-allowlist.conf:/etc/pi-dispatch/allowlist.conf:ro,z" \
     docker.io/ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029
   ```
   <!-- /PODMAN-NATIVE-PROXY -->

   The image is the compose file's, by the same digest, and `:ro,z` is there for SELinux as in the compose file.
   Measured from a job's `--internal` network: the proxy answers by name, and nothing on the host does (the host's
   own addresses, `host.containers.internal` and the gateway all refuse or are unreachable), which is stricter than
   the Docker API route, where a host service listening on `0.0.0.0` answers a job. Bringing the proxy back after a
   reboot was not measured.
7. **Valkey** is unchanged and can run anywhere the worker reaches through `VALKEY_URL`. `pi-dispatch up` and the
   compose file are docker-only, so on a host without Docker run it another way (a distribution package, or a
   container under this account with its port published on `127.0.0.1`).
8. **`PI_BACKENDS=podman`** in `.env`, then start the worker, and run `pi-dispatch doctor` and
   `pi-dispatch doctor --live` as the same account. doctor's podman section checks that `podman info` answered, that
   the service is rootless and not remote, that the controllers are delegated, whether SELinux relabelling applies,
   that the job image is in this account's store, and, with the egress policy armed, that the proxy is running under
   this Podman. `--live` reads the declarations back off real containers and says it read them back on podman,
   except `egress`: doctor's egress canary runs on docker only, so on this venue doctor says the allowlist was not
   read back. `.github/scripts/podman-conformance.mjs` reads it, with a canary of its own under this account's Podman.

On an SELinux host, the worker's own per-job directories carry `:Z` exactly as on the Docker API route, decided from
`podman info`'s `selinuxEnabled`, and an operator's local folder and `PI_GLOBAL_PI_DIR` need the one-time
`semanage fcontext` label the SELinux section above gives.

The first job on an image this account has never run pays once for keep-id: on an overlay store that cannot shift
ids (`podman info` says `Supports shifting: false`), Podman copies the image's layers to the mapped ids before the
container starts. Measured on Fedora 44 for the job image: 27.1 s for that first run, then 0.15 s, against 0.12 s
without keep-id. `doctor --live` and the conformance script give a container start 120 s on this venue for that
reason. Running `podman run --rm --userns=keep-id --user=$(id -u):$(id -g) --entrypoint true <image>` once after a
pull pays it ahead of the first job.

### What the venue does not do yet

- **`pi-dispatch sandbox` is refused** for a run on this venue, by name: a sandbox opens only through `local`, and a
  Docker shell over a directory rootless Podman ran would reproduce nothing of that run. A follow-up issue.
- **`pi-dispatch up`, the compose file and the setup wizard are docker-only.** A follow-up issue; steps 6 and 7 above
  are the manual equivalent.
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
| isolation | enforced | asserted (bounds applied, not credited) | refused: rootless | refused: rootless | asserted | refused: rootless | enforced while the pids, memory and cpu controllers are observed delegated, else asserted |
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
| `pi-dispatch doctor` | names Docker Engine | names Podman through its Docker API; `isolation` asserted, `mountSet` per the override | ✗ `rootless` | ✗ `rootless` | ⚠ names podman-docker and the context fix | ✗ `rootless` | names the podman venue: `podman info`, rootless, not remote, controllers, the image in this account's store |
| `pi-dispatch doctor --live` | reads the declarations back | reads the declarations back | not run (a local job is refused) | not run | not run (the endpoint is not observed on this host) | not run | reads the declarations back on podman, `egress` excepted |
| `pi-dispatch sandbox` | opens as the run's own uid | opens as the run's own uid | refused `rootless` | refused `rootless` | opens as the run's own uid (unmeasured) | refused `rootless` | refused: a sandbox opens only through `local` (a follow-up) |
| `pi-dispatch up` | runs doctor at the end | runs doctor at the end | as doctor | as doctor | as doctor | as doctor | docker-only (a follow-up); the native venue's setup steps instead |
| `docker compose --profile egress` | runs unchanged | runs unchanged through the real docker CLI | unmeasured (a job is refused anyway) | unmeasured (a job is refused anyway) | unmeasured | unmeasured | docker-only; the proxy runs under this account's podman instead |

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
