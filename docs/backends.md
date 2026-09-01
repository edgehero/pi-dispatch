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

Each carries the question an operator is actually asking; read them in `worker/src/backends.mjs`. Two are
worth calling out because they are the ones adapters get wrong:

- **`egress` and `jobToJobIsolation` carry `armedBy: "PI_EGRESS"`.** A declaration is a **capability**, not a
  posture. `local` can enforce egress; a deployment with `PI_EGRESS=0` is not getting it. Those are two
  different sentences and doctor prints both.
- **`abortable`** is the 30-minute kill. Declaring it means `stopContainer` actually ends the container.

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
the budget slot. If your runtime has no such codes, declare `[]` and normalise to that outcome yourself.

## Running the conformance suite

```js
import { runBackendConformance, UNVERIFIED_BY_THIS_HARNESS } from "@edgehero/pi-dispatch/backend-conformance";

const { ok, findings } = await runBackendConformance(myBackend, {
  // Arrange for YOUR runContainer to produce a container that exits this way.
  probe: async (backend, { exitCode, aborted }) => { /* ... */ },
  // Arrange for your reap to run with its enumeration FAILING. This is not `backend.reap()` -- that is the
  // working path, and passing it fails the check with a message about a bug you do not have.
  withBrokenEnumeration: async (backend) => myBackend.reapWith({ listContainers: () => { throw new Error("down"); } }),
});
```

It checks the bundle's shape, the declaration's consistency, exit-code fidelity, the abort flag, the
reaper's tri-state and the transfer downgrade. That is **three of the thirteen properties** plus two
structural checks. **It cannot check the other ten**: they need a live container on your runtime, and
`UNVERIFIED_BY_THIS_HARNESS` names each one and what it would take. Print it beside your findings; nothing
prints it for you.

**The probes are your own code, and that is a real limit.** How you make a container exit 2, or make an
enumeration fail, cannot be written generically, so those checks verify what your probe REPORTS. A probe
that fabricates its answer instead of routing through your `runContainer` will pass while proving nothing.
The harness cannot detect that. A green run is not a conformant backend.

## Registering it

```js
import { makeBackendRegistry } from "@edgehero/pi-dispatch/backend-registry";
import { BACKENDS } from "@edgehero/pi-dispatch/backends";

const backends = makeBackendRegistry({
  bundles: [localBackend, myBackend],
  defaultName: config.defaultBackend,
  blessed: config.backends,   // refuses a name PI_BACKENDS blesses but nothing builds
  reaps: backendReaps,        // refuses a venue with no boot reaper
});
```

Then an operator blesses it with `PI_BACKENDS=local,mine` (which requires the table entry from step 1) and
a trigger selects it with `run.backend`.

## What is deliberately not yours to decide

- **A trigger selects a venue; it never configures a posture.** `run.network` was rejected outright, and
  `run.backend` must not become a way back to it.
- **`PI_BACKEND_FLOOR` bounds you.** An operator can require a minimum of every blessed backend, and a floor
  naming a switched-off control refuses at boot.
- **The sandbox is local-only.** `pi-dispatch sandbox` opens a shell on this host's daemon against a
  retained job directory, so it cannot reach a job that ran anywhere else.
- **A local or cron trigger cannot run remotely.** The operator's own folder has to be bind-mounted and
  edited in place. There is no volume to hide behind.
