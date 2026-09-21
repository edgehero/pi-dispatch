# Container backends

A **backend** is where a job's container gets built. There is one today, `local`, which is the Docker daemon
on the worker's own host and is what every deployment has always used.

This page is the contract. If you are adding a venue, everything you need is here: you should not have to
read the worker's source.

## The shape

### Step 1: add a table entry

**Do this first.** Nothing else works without it. Add your venue to `BACKENDS_TABLE` in
`worker/src/backends.mjs`:

```js
mine: {
  describe: "the Acme container service",
  remote: true,                  // true unless the container runs on the worker's own host
  declares: { /* all thirteen properties, see below */ },
  asserts: { nonRoot: "the Acme image spec's USER field" },   // required for every `asserted` word
  // observedBy: only for a word earned by observing THIS host (see `credentialTransit` below)
},
```

`parseBackendList` refuses a `PI_BACKENDS` naming a venue with no entry, `validateBackend` refuses a
trigger naming one, and the conformance harness refuses a bundle whose name the table does not know. This
is deliberate: the declaration is what an operator reads, so a venue that runs jobs without one would be a
venue nobody can reason about. **An adapter is therefore not purely out-of-tree today** — the code can live
anywhere, but the declaration lands here.

### Step 2: build the bundle

```js
{
  name: "mine",                        // must match the table entry
  declares: BACKENDS.mine.declares,    // READ from the table, never re-typed
  neverStartedExits: [],               // integers this runtime uses for "the runner never ran"
  containerName: (jobId) => `acme-${jobId}`,   // the registry calls this; the abort stops what it returns
  namePrefix: "acme-",                 // your own sweep filter, if you have one
  binds: false,                        // true if you bind-mount, false if you copy. REQUIRED to earn
                                       // readOnlyJobInputs: enforced; omitting it makes the harness abstain

  runContainer,     // start one job container
  imagePreflight,   // free, credential-less: is the image usable on this venue?
  egressPreflight,  // free: is the egress policy serviceable here?
  stopContainer,    // stop a running job by name (the 30-minute timeout, and shutdown)
  reap,             // boot sweep: clear strays, and say whether you ENUMERATED
}
```

`worker/src/backend-local.mjs` is the worked example, though note that `makeLocalBackend` is a factory for
*that* backend: it takes the five functions and sets the rest itself. Your adapter builds the whole object.

### What each function must return

The worker reads specific keys. Returning a different shape does not error; it is **ignored**, which is
worse.

| Function | Called with | Must return |
|---|---|---|
| `imagePreflight` | the job | `{ missing }` when the image is absent (a string, the ref, refuses pre-spend), `{ forgeUnsupported, kind, declared }` when the image cannot serve that forge, `{ piVersion }` with the image's pi version or absent. **`ok` is not read.** A bare `{ ok: true }` cold-starts every resume, because a null `piVersion` means "never resume". |
| `egressPreflight` | the job | `{ proxyMissing }` or `{ proxyStopped }` to refuse; anything else admits. `ok` is not read here either. |
| `runContainer` | `{ job, token, prepared, secrets, name, signal }` | `{ code, aborted, turns, tokens, session, usage, context }`. `code` is the container's integer; `aborted` says the WORKER stopped it. The last five may be `null`, but a missing `session` breaks resume silently. Must honour `signal`. |
| `stopContainer` | `(name, job)` | anything. It is not awaited for its value: the abort's effect arrives through the container's own exit. |
| `reap` | nothing | `{ reaped: true }` only if you ENUMERATED. See below. |
| `containerName` | the job id | the name `stopContainer` will be given |

## What a backend declares

Every backend declares thirteen properties, each in one of three words. The words are not a rating. They say
**who is asserting the property**:

| Word | Meaning |
|---|---|
| `enforced` | this worker builds it, in its own code, and a test can read it back off what was produced |
| `asserted` | something outside the worker provides it (an image's `USER`, a vendor's documentation). Unverifiable from here |
| `absent` | not provided at all. A deployment that needs it is refused rather than silently downgraded |

An unknown or misspelled word ranks with `absent`: a backend that declares nothing gets no benefit of the
doubt. A property you omit is a property you are not admitted for, which is why the list is closed.

`asserted` must name **who** asserts it, in the entry's `asserts` map. "Not us" without "them" leaves an
operator nothing to go and check, and `pi-dispatch doctor` prints the source beside the word.

### The thirteen

`isolation`, `ephemeral`, `mountSet`, `egress`, `jobToJobIsolation`, `imagePinning`, `exitCodes`,
`abortable`, `readOnlyJobInputs`, `nonRoot`, `secretsCustody`, `credentialTransit`, `localFolders`.

Each carries the question an operator is actually asking; read them in `worker/src/backends.mjs`. These are the
ones adapters get wrong:

- **`egress` and `jobToJobIsolation` carry `armedBy: "PI_EGRESS"`.** A declaration is a **capability**, not a
  posture. `local` can enforce egress; a deployment with `PI_EGRESS=0` is not getting it. Those are two
  different sentences and doctor prints both.
- **`abortable`** is the 30-minute kill. Declaring it means `stopContainer` actually ends the container.
- **`local`'s `credentialTransit` is `enforced` only while observed.** It holds while the docker CLI sends
  containers to a daemon on this host, which the worker checks at boot and before each job. On a CLI pointed
  elsewhere it counts as `asserted`, by you, and doctor says so. The table entry says this with
  `observedBy: { credentialTransit: "dockerEndpointLocal" }`. That observation is a fact about this host's
  docker CLI, so an entry for a remote venue leaves `observedBy` out and declares its own word.
- **Podman**: rootful Podman through its Docker API is the `local` backend, with the differences
  [`docs/podman.md`](podman.md) measures. Rootless Podman is refused.
- **`local`'s `isolation` and `mountSet` are `enforced` only while observed too** (issue #345). `isolation` needs
  the daemon to report that it applies pid and memory bounds, and to be neither rootless nor Podman, whose Docker
  API reports those booleans whether or not they apply (`daemonAppliesBounds`). `mountSet` needs the runtime to add
  no mounts of its own: always on Docker, and on rootful Podman only with an empty `/etc/containers/mounts.conf`,
  no `volumes`, `mounts`, `devices` or `hooks_dir` key (in any spelling or letter case) in containers.conf or its
  drop-ins, no OCI hook installed, those files readable, FIPS off, and the service's socket on this host
  (`runtimeAddsNoMounts`). Where either is not observed the word
  counts as `asserted`, doctor prints what it saw, and a floor asking for `enforced` refuses. `pi-dispatch doctor
  --live` reads what these cannot: `pids.max` and `memory.max` inside a real container, and its
  `/proc/self/mountinfo`.
- **`local`'s `nonRoot` and `localFolders` depend on which uid the job runs as** (issue #341). On macOS, Windows
  and Docker Desktop the image's own `USER` runs. On a daemon that enforces bind-mount ownership (native Linux
  Docker, rootful Podman) the worker runs the job as its own uid with `--user` and `HOME=/home/pi`, because
  only the uid that owns the job's files can use them (a uid-1001 worker, the image's own uid, needs no flag).
  The worker decides this from facts at boot and before each job, never by starting a probe container. It
  refuses by name what no uid can serve: rootless Docker or Podman, userns-remap, a root worker, Docker
  Desktop on Linux (WSL is not affected), an image without the `anyUid` capability for another uid, and a
  `--user` whose primary group is 0 or the docker socket's. `pi-dispatch doctor` names the answer for the shell
  it runs in, and `pi-dispatch doctor --live` runs its probe as that user and reads it back. An adapter for
  another runtime answers the same question in its own terms.

## A declaration is not a claim that the property holds

It is a claim about who is asserting it. The reason is in the constitution, and it is the sentence this
whole feature is built around:

> A control whose presence is unobservable to the thing that starts the containers is indistinguishable,
> from every angle this project can see, from no control at all, and an operator who believes they have one
> is in a **worse** position than one who knows they do not, because the belief displaces the credential
> bound `CONST-TOKEN-SCOPED-PER-JOB` says is what actually bounds the damage.

So the value of the table is not that a vendor is verified. It is that a **mismatch becomes a refusal**
instead of a silent downgrade.

## Three conflicts no vendor resolves

Be honest with yourself about these before you start. They are not obstacles to work around; they are
properties you will have to declare `absent`, which makes your backend unusable until an operator
explicitly accepts the degradation.

1. **`--pull=never` cannot survive.** A third-party runtime fetches from a registry by definition. That is
   `imagePinning`.
2. **`ENTRYPOINT`-as-runner breaks on some vendors**, which reaches `exitCodes` and the runner protocol.
3. **The root-owned `HARD_RULES.md` floor dies wherever the agent runs as root.** That is `nonRoot`, which
   `local` already declares `asserted` for its own reasons.

A fourth, if you copy files rather than bind-mount them: `/job`'s read-only is the **kernel's** on a bind and
**convention's** on a copy. See below.

## Moving files: state the downgrade

`worker/src/container-spec.mjs` gives you the mounts as transfers:

```js
import { containerSpec, transfersFromSpec, copyDowngrades } from "@edgehero/pi-dispatch/container-spec";

const spec = containerSpec(opts);
const transfers = transfersFromSpec(spec, { binds: false }); // false = you copy
```

Each transfer carries:

- `direction`: `in` for a read-only mount, `in-out` for a writable one. **Every writable mount comes back**,
  not just `/workspace`: the host reads `/outbox` for chain requests and `/session` for the transcript after
  the run. An adapter that returned only `/workspace` would never enqueue a chained child and would
  cold-start every resume, both reporting success.
- `readOnlyEnforcedBy`: `kernel` if you bind, `convention` if you copy. If you copy, `copyDowngrades(spec)`
  is the list you are losing, and declaring `readOnlyJobInputs: enforced` anyway is exactly the believed-in
  control the constitution warns about.
- `contains`: the other container paths whose **host** path is nested inside this one. On a forge job
  `jobDir` contains `workspace/` and `session/`, so uploading each mount independently leaves a stale tree
  under `/job/workspace`. Exclude them.

## Exit codes

The runner's integer must reach the processor unmodified: `0` completed, `1` infra (retried), `2` policy
(never retried). The **abort flag is separate and load-bearing**: a worker SIGKILL and a kernel OOM both
surface as `137`, so the code alone cannot say which happened. Report `aborted` independently.

`neverStartedExits` is your runtime's set for "the runner never ran" (Docker's is 125/126/127). Those refund
the budget slot. If your runtime has no such codes, declare `[]` and normalise to that outcome yourself. If your
runtime can exit one of those codes while the container it created runs on (a lost API connection, measured on
Podman), stop that container and add `detached: true` to the result: the processor then retries the job as
`container-detached` and keeps the slot (issue #345).

## Running the conformance suite

```js
import { runBackendConformance, UNVERIFIED_BY_THIS_HARNESS } from "@edgehero/pi-dispatch/backend-conformance";

const { ok, findings } = await runBackendConformance(myBackend, {
  // Arrange for YOUR runContainer to produce a container that exits this way.
  probe: async (backend, { exitCode, aborted }) => { /* ... */ },
  // Arrange for your reap to run with its enumeration FAILING. This is not `backend.reap()` -- that is the
  // working path, and passing it fails the check with a message about a bug you do not have.
  withBrokenEnumeration: async (backend) => myBackend.reapWith({ listContainers: () => { throw new Error("down"); } }),
  // Start containers through YOUR runContainer path and read the eight READ_BACK_BY_A_LIVE_PROBE properties
  // off them: { isolation: { ok, warn?, detail }, ephemeral: ..., ... }. Leave it out and all eight abstain.
  readBack: async (backend) => { /* ... */ },
});
```

It checks the bundle's shape, the declaration's consistency, exit-code fidelity, the abort flag, the
reaper's tri-state and the transfer downgrade. That is **three of the thirteen properties** plus two
structural checks. **Eight more are read back off live containers** (`READ_BACK_BY_A_LIVE_PROBE`: isolation,
ephemeral, mountSet, egress, jobToJobIsolation, imagePinning, nonRoot, localFolders), but only through the
`readBack` probe you write, because only your runtime can start your containers. A property read back as not
holding fails when you declare it `enforced` or `asserted`; one your report leaves out, or could not read,
abstains. **The remaining two it cannot reach at all** (they are not container properties), and
`UNVERIFIED_BY_THIS_HARNESS` names each one and what it would take. Print it beside your findings; nothing prints
it for you.

**The `local` backend's read-back is `pi-dispatch doctor --live`.** It starts short-lived containers from the job
builder (no environment, fixture folders, a constant script in place of the entrypoint): one it reads isolation,
mountSet, nonRoot and localFolders off, a refused absent image for imagePinning, two runs under one name for
ephemeral (each must be gone before the next), and, with `PI_EGRESS` armed, two peers on their own job networks
for jobToJobIsolation (the first must reach the proxy and not the second, which must answer itself before and
after the attempt). It folds in the egress canary and removes every container it
started by ID, the peer networks after their peers (issue #344). The canary's own probes and network are not on
that list: they are removed by the canary itself, which runs on every doctor with the policy armed, and a later
run clears what a killed one left behind (issue #350). It runs as the job user a local job on this host gets
(issue #341), in a job's own folder modes, and checks that what it wrote is owned by you on the host; where a local job
would be refused, or the job user cannot be decided, it runs nothing and says so. It runs only when the docker CLI
is observed pointing at this host. Its verdicts are about that fixture and `PI_JOB_IMAGE`, not about your own
folders or the images your triggers name, and doctor prints those limits beside a green result.
`worker/src/live-probes.mjs` is the worked example of a `readBack`: its verdicts are the shape the harness takes.

**The probes are your own code, and that is a real limit.** How you make a container exit 2, or make an
enumeration fail, cannot be written generically, so those checks verify what your probe REPORTS. A probe
that fabricates its answer instead of routing through your `runContainer` will pass while proving nothing.
The harness cannot detect that. A green run is not a conformant backend.

## Registering it

Pass your bundle to `startWorker` as an extra backend. It is registered after `local`, and its own `reap`
joins the boot sweep automatically. **There is no published import for `startWorker` today**: it lives in
`worker/src/start.mjs`, which the package's export map does not name, so this works from a checkout of this
repository and not from an installed package. Its first argument is the environment, and the backends ride
the second:

```js
import { startWorker } from "./worker/src/start.mjs"; // from a checkout; not an export of @edgehero/pi-dispatch

await startWorker(process.env, { extraBackends: [myBackend] });
```

`startWorker` builds the registry itself:

```js
makeBackendRegistry({
  bundles: [localBackend, ...extraBackends],
  defaultName: config.defaultBackend,
  blessed: config.backends,   // refuses a name PI_BACKENDS blesses but nothing builds
  reaps: backendReaps,        // refuses a venue with no boot reaper
});
```

Both cross-checks fire at boot rather than at the first pickup, so a venue you blessed but did not register,
or registered without a reaper, is a startup error rather than a job that fails hours later.

Then an operator blesses it with `PI_BACKENDS=local,mine` (which requires the table entry from step 1) and
a trigger selects it with `run.backend`.

## What is deliberately not yours to decide

- **A trigger selects a venue; it never configures a posture.** `run.network` was rejected outright, and
  `run.backend` must not become a way back to it.
- **`PI_BACKEND_FLOOR` bounds you.** An operator can require a minimum of every blessed backend, and a floor
  naming a switched-off control, or a guarantee this host is not observed to provide, refuses at boot (and,
  for an observation, before each job).
- **The sandbox is local-only, per job.** `pi-dispatch sandbox` and the panel open a shell on this host's
  daemon against a retained job directory, so a run whose retained record names another backend is refused
  by name. That refusal is per run, not per deployment: blessing a remote venue does not stop local runs
  from reopening.
- **Every job's venue is recorded, and your adapter supplies nothing for it.** The run record's `backend`,
  the session store's venue stamp and the sandbox manifest all record the venue the registry resolved, so a
  job that landed on the wrong venue shows it, and a resumed transcript is refused to a venue that did not
  write it (outside the narrow residuals `INT-SESSION-STORE-CONTRACT` names).
- **A local or cron trigger cannot run remotely.** The operator's own folder has to be bind-mounted and
  edited in place. There is no volume to hide behind.
