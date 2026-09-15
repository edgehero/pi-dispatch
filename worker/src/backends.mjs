/**
 * THE BACKEND TABLE -- the one place that says where a job's container can run, and what each place is
 * ABLE to guarantee (issue #227).
 *
 * A backend is where the box is built. Today there is one, `local`, which is the Docker daemon on the
 * worker's own host and is what every deployment has always used. The table exists so a second one can be
 * added without reading the worker's source, and so that adding one cannot quietly weaken a control.
 *
 * This module imports NOTHING, deliberately, for `forges.mjs`'s reason: it is a leaf, and `doctor`, the
 * config loader and (later) the receiver all need to read a declaration without pulling the Docker
 * implementation into their graph. A lookup returns `undefined` for an unknown name and the CALLER decides
 * how loudly to fail, because the answer differs -- a config value refuses boot, a trigger field refuses
 * the file.
 *
 * A DECLARATION IS A CAPABILITY, NOT A POSTURE. This is the distinction the first draft of this file got
 * wrong, and it is worth stating first because everything else depends on it.
 *
 * `CONST-EGRESS-POLICY-IN-THE-ARGV` does not say egress is denied, and its revision row says exactly why
 * it refuses to: "an operator can set `PI_EGRESS=0` ... so a 'shall' over denial would be the
 * constraint-that-ships-unenforced `OQ-004` refused for in the first place." The rejected ID
 * `CONST-EGRESS-DENIED-BY-DEFAULT` is named inside that entry so it is not re-proposed. A table that said
 * `egress: enforced` as a flat statement of what a running job gets would be re-proposing it in one word --
 * and in a vocabulary whose whole purpose is that the word is the thing that gets PRINTED.
 *
 * So a declaration answers "can this backend be asked for this, and does it build it itself?", never "is
 * this deployment currently getting it?". Those are two axes and this table is one of them. A property a
 * deployment switch gates carries `armedBy`, naming the switch, so a reader is never handed the capability
 * word alone where it could be mistaken for the posture. Whether that switch is on is the deployment's own
 * answer, which `egressArmed` owns; `doctor` joins the two and prints them together, and `unarmedFloor`
 * below makes the boot refusal read the switch as well -- a floor asking for a gated property is not met by
 * capability alone. `declarationOf` is the one definition of that join, so a consumer never has to
 * reconstruct it and never prints a capability word bare.
 *
 * The capability axis is the one a floor compares against, which is what makes the axis the right choice
 * rather than a convenient one: the refusal it has to produce is "this deployment ARMED egress and the
 * backend it selected cannot do egress at all", and that question is answered by capability. A posture word
 * could not express it, because a deployment that armed nothing needs no refusal.
 *
 * WHY DECLARING IS NOT CLAIMING.
 *
 * `CONST-EGRESS-POLICY-IN-THE-ARGV` states the objection this table has to answer, and it is worth quoting
 * because it is easy to answer the weaker version by accident:
 *
 *   "A control whose presence is unobservable to the thing that starts the containers is indistinguishable,
 *    from every angle this project can see, from no control at all -- and an operator who believes they have
 *    one is in a WORSE position than one who knows they do not, because the belief displaces the credential
 *    bound CONST-TOKEN-SCOPED-PER-JOB says is what actually bounds the damage."
 *
 * The tail is the operative half. The danger is not an unobservable control; it is a BELIEVED-IN one, which
 * displaces the bound that is really holding. So a declaration is never a claim that a property holds. It
 * is a claim about WHO IS ASSERTING IT, in three words that must stay distinguishable everywhere they are
 * printed:
 *
 *   enforced -- this worker CAN build it, in its own code, and a test in this repo reads it back off what
 *               was actually produced. The only word that means the property is ours.
 *   asserted -- something outside this worker provides it: an image's `USER`, a vendor's documentation.
 *               Unverifiable from here. `doctor` prints it differently for exactly that reason.
 *   absent   -- not provided at all. A deployment whose configuration needs it is REFUSED rather than
 *               silently downgraded.
 *
 * `OQ-012` already draws this line for images -- "a required OCI label proves INTENT, not conformance" --
 * and the same is true one level out. The value of the table is not that a vendor is verified; it is that a
 * MISMATCH becomes a refusal instead of a silent downgrade. `backend-conformance.mjs` verifies THREE of the
 * thirteen -- exit-code fidelity, the abort flag's independence from the code, and the read-only downgrade a
 * copying runtime takes -- plus the shape of a bundle and the internal consistency of its declaration. EIGHT more
 * are read back off a live container (issues #278 and #344): for `local` by `doctor --live` (`live-probes.mjs`), for
 * any other runtime through the harness's `readBack` probe, which the adapter supplies. The remaining TWO the harness
 * names with what each would take rather than passing them in silence. So a backend can still declare all of this
 * and do most of it: these words are a contract with three of them checked and eight readable, which is more than
 * none and less than proof -- the read-back is of a fixture with the job image, not of every job.
 *
 * THE PROPERTIES ARE NOT A RENDERING OF `ISOLATION_FLAGS`, and must not become one. That array is the
 * literal, value-free, unconditional set the local argv splices in, and two tests assert every member of it
 * reaches the sandbox argv AGAINST THE IMPORTED ARRAY. Issue #261 explicitly rejected "expressing isolation
 * as semantic spec fields (`dropCapabilities`, `pidsLimit`), which is more portable", because it would
 * retire those assertions. So a property here names a GUARANTEE an operator can reason about, and the flags
 * that deliver it stay where they are.
 */

/**
 * The exit codes a DOCKER-shaped runtime uses for "the runner never ran": 125 is `docker run` itself
 * failing, 126 an entrypoint that is not executable, 127 an entrypoint that was not found. In all three the
 * daemon never handed control to the runner, so nothing was spent -- which is what `container-never-started`
 * means, and why they refund the budget slot instead of keeping it.
 *
 * HERE, in the leaf, rather than in `backend-local.mjs`, so `processor.mjs` can default to them without
 * importing the local adapter and dragging `node:child_process` and the docker CLI machinery into its
 * module graph. The local bundle declares the same constant; a second backend declares its own, or declares
 * `[]` and normalises to the outcome itself.
 */
export const DOCKER_NEVER_STARTED_EXITS = Object.freeze([125, 126, 127]);

/** The three words. Ordered weakest-last so a floor can be expressed as "at least this". */
export const ENFORCED = "enforced";
export const ASSERTED = "asserted";
export const ABSENT = "absent";

/**
 * Strength order, for the floor comparison. `absent` is 0 so an unknown or missing declaration sorts with
 * it: a backend that declares nothing gets no benefit of the doubt, which is the polarity
 * `dev.pi-dispatch.capabilities` already uses for images and for the same reason.
 */
const RANK = { [ABSENT]: 0, [ASSERTED]: 1, [ENFORCED]: 2 };

/**
 * Whether `have` is at least as strong as `want`.
 *
 * ASYMMETRIC ABOUT AN UNKNOWN WORD, and the asymmetry is the whole subtlety of this function. On the HAVE
 * side an unknown word ranks 0, so a backend declaring gibberish gets no credit -- a failure, as intended.
 * On the WANT side the same rule INVERTS: a floor of `{ egress: "enfroced" }` ranks 0 and is therefore met
 * by everything, so the typo yields the open posture while an operator believes they have a floor.
 *
 * This function does not and cannot fix that, because "met by everything" is also the correct answer for a
 * floor that genuinely asks for `absent`. `isDeclaration` is the guard, and whatever parses a floor must
 * call it -- `PI_EGRESS` refuses a third value for exactly this reason. `shortfall` below does call it.
 */
export function meets(have, want) {
	return (RANK[have] ?? 0) >= (RANK[want] ?? 0);
}

/**
 * Is `word` one of the three? `Object.hasOwn`, never `in` or a truthy index, so `"constructor"` and
 * `"toString"` are not declarations.
 */
export function isDeclaration(word) {
	// `typeof` first: `Object.hasOwn` coerces via ToPropertyKey, so `["enforced"]` and
	// `{ toString: () => "absent" }` would otherwise be declarations. A floor value that is not a string is
	// a malformed floor, and this function is what stops one being ranked.
	return typeof word === "string" && Object.hasOwn(RANK, word);
}

/**
 * The properties every backend declares, each with the question an operator is really asking. A bare
 * property name is the un-actionable amber this project's design rejects elsewhere.
 *
 * A CLOSED LIST, because a backend that simply omits one would otherwise be admitted for it. That rule is
 * only sound if the list is COMPLETE, so it is derived from what the specs say the container boundary
 * provides rather than from what the local implementation happens to have flags for. The five properties
 * after `localFolders` exist because without them a backend could declare every other word `enforced`,
 * be fully conformant, and still bind-mount the docker socket, reuse one container across mutually
 * untrusting issue authors, or have no way to stop a runaway job.
 *
 * `armedBy` names the deployment switch that gates a property, or null when nothing does. A capability is
 * not a posture (see the header), and a reader must never be handed one where they could take it for the
 * other.
 */
const PROPERTIES_TABLE = {
	isolation: {
		question: "capabilities dropped, no-new-privileges, pid and memory bounds on the job container",
		armedBy: null,
	},
	ephemeral: {
		// CONST-ISOLATION-CONTAINER-PER-JOB's core sentence, and NOT covered by `isolation`: a backend
		// reusing one long-lived container satisfies every flag above word for word and still leaks state
		// between mutually untrusting issue authors, which is the whole reason that constraint exists.
		question: "one container per job, destroyed after it, never reused across jobs",
		armedBy: null,
	},
	mountSet: {
		// The Acceptance clause of CONST-ISOLATION-CONTAINER-PER-JOB: "the agent has no filesystem path to
		// the host outside the declared mounts", and it names PI_SESSIONS_DIR as never bind-mounted into any
		// container. Without this property a backend could declare everything else enforced and mount the
		// docker socket, which is not a weakened boundary but no boundary at all.
		question: "only the declared mounts exist; no docker socket, no home dir, no shared session store",
		armedBy: null,
	},
	egress: {
		// ARMED, not unconditional, and the table would be re-proposing a rejected constitution entry if it
		// said otherwise. See the header.
		question: "the job reaches only what the allowlist proxy permits (CONST-EGRESS-POLICY-IN-THE-ARGV)",
		armedBy: "PI_EGRESS",
	},
	jobToJobIsolation: {
		// The measured half of REQ-EGRESS-ALLOWLIST. `egress` is about OUTBOUND reach; this is about whether
		// two jobs can reach each other, which a backend could fail while passing the egress question by
		// routing every job through the proxy on one shared segment. Also armed: with PI_EGRESS=0 both job
		// containers sit on docker's default bridge, where egress.mjs records they can reach each other by
		// IP today.
		question: "two jobs cannot reach each other, structurally rather than by policy",
		armedBy: "PI_EGRESS",
	},
	imagePinning: {
		question: "the image cannot be fetched at run time, so a typo'd name is unreachable (--pull=never)",
		armedBy: null,
	},
	exitCodes: {
		// Narrowed deliberately. An earlier draft also claimed "un-interleaved stdout arrives undistorted",
		// which this project does not have: run-container.mjs tees two independently buffered pipes into one
		// sink, run-history.mjs reads only the last 8KB, and `OQ-003` records that anything sharing the
		// container's stdout can land a partial write inside a runner line. The integer is the part that is
		// actually guaranteed, and it is the part every retry decision rests on.
		question: "the container's integer exit code reaches the processor unmodified (INT-RUNNER-EXIT-CODE-PROTOCOL)",
		armedBy: null,
	},
	abortable: {
		// REQ-JOB-TIMEOUT-30M. Declared two slices before the seam existed, on purpose: `stopContainer` was
		// hard-wired in index.mjs's abort path, so a second backend could have passed every other check with
		// no way to stop a runaway container and nothing in this table would have moved. A gap that is
		// declared is a refusal; a gap that is unnamed is a surprise. The seam landed in slice 4.
		question: "a running job can be stopped on the 30-minute timeout or a shutdown, and the abort is distinguishable from a crash",
		armedBy: null,
	},
	readOnlyJobInputs: {
		question: "/job is read-only by the kernel, not by convention (INT-CONTAINER-JOB-INPUTS)",
		armedBy: null,
	},
	nonRoot: {
		question: "the agent runs as a non-root user",
		armedBy: null,
	},
	secretsCustody: {
		// Stated as what the code actually earns and a test can read back, rather than as "values stay on the
		// operator's host", which is a topological fact about `remote: false` and not something the worker
		// builds. The host-side argv exposure under a default `hidepid` is real, pre-existing, disclosed in
		// SECURITY.md, and deliberately outside this sentence rather than denied by it. WHETHER THE VALUES
		// CROSS A NETWORK is deliberately not asked here either -- that is `credentialTransit`, which answers
		// it honestly, and folding the two would let this one's verified half carry the other's unverified.
		question: "no resolved secret VALUE reaches a log, a run record or a forge comment",
		armedBy: null,
	},
	credentialTransit: {
		// CONST-TOKEN-SCOPED-PER-JOB is what CONST-EGRESS-POLICY-IN-THE-ARGV calls "what actually bounds the
		// damage", and the first draft of this table had no property for it at all. A remote backend must
		// ship the provider key and the per-job forge token to a daemon it does not own; that is a different
		// question from secretsCustody, which is about this host's own logs and records.
		question: "the provider key and the per-job forge token reach the container without crossing a network this deployment does not own",
		armedBy: null,
	},
	localFolders: {
		question: "a local folder can be bind-mounted and edited in place (DES-WORKER-ON-HOST finding 2)",
		armedBy: null,
	},
};

/**
 * FROZEN for the reason `BACKENDS` is, and it is the sharper of the two. `isProperty` reads THIS object,
 * and `isProperty` is the whole of `shortfall`'s validation gate -- so an unfrozen `PROPERTIES` means one
 * assignment can delete a property (every floor naming it then throws "unknown property"), add one
 * (a floor naming it validates and ranks against `absent`), or null out an `armedBy` so the capability word
 * is printable bare again. That last one is the exact fix this table just made, undone from inside.
 */
export const PROPERTIES = Object.freeze(
	Object.fromEntries(Object.entries(PROPERTIES_TABLE).map(([name, entry]) => [name, Object.freeze({ ...entry })])),
);

export const PROPERTY_NAMES = Object.freeze(Object.keys(PROPERTIES));

/**
 * One property's declaration on one backend, joined with what qualifies it: `{ property, word, armedBy,
 * question }`. `undefined` for an unknown backend or property.
 *
 * Exists because `declares` is a bare `{ property: word }` map, and a consumer that prints a word without
 * its `armedBy` reintroduces the defect the `armedBy` field was added to fix -- a capability read as a
 * posture. One definition of the join, so the first consumer does not have to remember to write it.
 */
export function declarationOf(name, property) {
	const entry = backendFor(name);
	if (!entry || !isProperty(property)) return undefined;
	const word = entry.declares[property];
	return {
		property,
		word,
		armedBy: PROPERTIES[property].armedBy,
		question: PROPERTIES[property].question,
		// Only meaningful for an asserted word, and null otherwise rather than absent, so a consumer that
		// prints it unconditionally renders nothing rather than "undefined".
		assertedBy: word === ASSERTED ? (entry.asserts?.[property] ?? null) : null,
		// The observation this word holds only while (#278), or null. A consumer that prints the word without it
		// would print `enforced` for a daemon that is elsewhere.
		observedBy: entry.observedBy?.[property] ?? null,
	};
}

/**
 * The word a backend EARNS for a property given what is observed on this host (issue #278). The declared word
 * when the property is not observation-gated or its observation is `true`; otherwise at most `asserted`, since
 * the guarantee then rests on whoever arranged for the observation to be false. `undefined` observations get no
 * credit, this file's standing polarity. `undefined` for an unknown backend or property.
 */
export function effectiveWord(name, property, observations = {}) {
	const entry = backendFor(name);
	if (!entry || !isProperty(property)) return undefined;
	const word = entry.declares[property] ?? ABSENT;
	const observation = entry.observedBy?.[property];
	if (!observation || observations?.[observation] === true) return word;
	return (RANK[word] ?? 0) > RANK[ASSERTED] ? ASSERTED : word;
}

/**
 * Which floored properties a backend declares strongly enough but does not EARN given the observations, as
 * `[{ backend, property, have, want, observedBy }]` -- the floor misses the observation alone causes. The
 * capability misses stay `floorShortfall`'s, checked at config load; this is the half only a live read can
 * answer, so it is checked where the read happens (boot, and before each job's spend).
 */
export function unobservedFloor(backends, floor, observations = {}) {
	const out = [];
	for (const backend of backends ?? []) {
		const entry = backendFor(backend);
		if (!entry) continue;
		for (const [property, want] of Object.entries(floor ?? {})) {
			if (!isProperty(property) || !isDeclaration(want) || want === ABSENT) continue;
			const declared = entry.declares[property] ?? ABSENT;
			const have = effectiveWord(backend, property, observations);
			if (meets(declared, want) && !meets(have, want)) out.push({ backend, property, have, want, observedBy: entry.observedBy[property] });
		}
	}
	return out;
}

/**
 * The refusals `unobservedFloor` implies, as operator-facing messages; empty when the floor holds. Outside
 * `backendRefusals` because `loadConfig` is synchronous and cannot observe anything; the caller that made the
 * observation passes it, with `evidence` -- `{ [observation]: "what was seen" }` -- for the message.
 */
export function observationRefusals({ backends = [], backendFloor = {}, observations = {}, evidence = {}, only = null } = {}) {
	// `only` narrows the check to the named observations, for a caller that has read just those so far (boot reads the
	// endpoint before the daemon, and must not refuse on an observation it has not asked yet).
	const misses = unobservedFloor(backends, backendFloor, observations).filter((m) => !only || only.includes(m.observedBy));
	if (misses.length === 0) return [];
	const lines = misses.map((m) => `  ${m.backend}: ${m.property}=${m.want} holds only while ${OBSERVATIONS[m.observedBy] ?? m.observedBy}; ${evidence[m.observedBy] ?? "that was not observed"}`);
	// One remedy per observation that missed, in the closed list's order, so a bounds miss is never told to repoint the CLI.
	const remedies = Object.keys(OBSERVATION_FIX).filter((o) => misses.some((m) => m.observedBy === o)).map((o) => OBSERVATION_FIX[o]);
	return [`PI_BACKEND_FLOOR asks for something this host is not observed to provide:\n${lines.join("\n")}\n${remedies.join("\n")}`];
}

/**
 * Whether the floor misses `observationRefusals` would report rest ONLY on observations that were not answered (`null`
 * or `undefined`, as opposed to an answered `false`): a daemon still starting, a read that timed out. Such a refusal is
 * transient, and the caller retries rather than refusing for good. `false` when nothing misses.
 */
export function observationRefusalIsTransient({ backends = [], backendFloor = {}, observations = {} } = {}) {
	const missed = unobservedFloor(backends, backendFloor, observations).map((m) => m.observedBy);
	return missed.length > 0 && missed.every((o) => typeof observations?.[o] !== "boolean");
}

/** Is `name` one of the closed list? `Object.hasOwn`, so `"toString"` is not a property. */
export function isProperty(name) {
	return Object.hasOwn(PROPERTIES, name);
}

/** The observation that the docker CLI on this host resolves an endpoint on this host (issue #278). */
export const DOCKER_ENDPOINT_LOCAL = "dockerEndpointLocal";

/**
 * The observation that the daemon reports it applies a container's pid and memory bounds (issue #345), from the same
 * `docker info` read the job user is decided from. `true` only for `PidsLimit` and `MemoryLimit` both true on a daemon
 * that is neither rootless nor Podman: Podman's Docker API hard-codes `PidsLimit` and derives `MemoryLimit` from the root
 * cgroup, so on Podman the booleans say nothing about a container (source; measured true on a rootless host applying
 * neither). CPU is never read: rootful Podman reports `CpuCfsQuota: false` while applying `--cpus` (measured).
 */
export const DAEMON_APPLIES_BOUNDS = "daemonAppliesBounds";

/**
 * The observation that the container runtime mounts nothing of its own into a job container (issue #345). Docker adds
 * none; rootful Podman mounts `/run/secrets` from its default `mounts.conf` into every container, invisible in
 * `.Mounts` (measured: host subscription files readable by the job user). On Podman it holds only with the documented
 * empty `/etc/containers/mounts.conf` override and no `volumes`/`mounts` key in any containers.conf this host reads
 * (`runtime-observations.mjs`).
 */
export const RUNTIME_ADDS_NO_MOUNTS = "runtimeAddsNoMounts";

/**
 * The closed list of observations a backend's `observedBy` may name, each with what it means. Closed for the
 * reason `PROPERTIES` is: a typo in a table entry must not become an observation nobody makes, which would
 * degrade a word forever with nothing saying why.
 */
export const OBSERVATIONS = Object.freeze({
	[DOCKER_ENDPOINT_LOCAL]: "the docker endpoint this host's docker CLI resolves is on this host",
	[DAEMON_APPLIES_BOUNDS]: "the daemon reports that it applies a container's pid and memory bounds, and is neither rootless nor Podman",
	[RUNTIME_ADDS_NO_MOUNTS]: "the container runtime adds no mounts of its own to a job container",
});

/** What to do about each observation that a floor needed and did not get, keyed like `OBSERVATIONS` and pinned to it. */
export const OBSERVATION_FIX = Object.freeze({
	[DOCKER_ENDPOINT_LOCAL]: "Point the docker CLI back at this host (DOCKER_HOST, DOCKER_CONTEXT or `docker context use`), or lower that entry to `asserted` if the redirect is deliberate.",
	[DAEMON_APPLIES_BOUNDS]: "Run jobs on a rootful Docker Engine that reports PidsLimit and MemoryLimit, or lower that entry to `asserted`: on Podman and rootless daemons `pi-dispatch doctor --live` reads pids.max and memory.max off a real container instead.",
	[RUNTIME_ADDS_NO_MOUNTS]: "On Podman, create an empty /etc/containers/mounts.conf and remove any `volumes` or `mounts` key from containers.conf, or lower that entry to `asserted`.",
});

const BACKENDS_TABLE = {
	local: {
		/**
		 * The Docker daemon on the worker's own host -- what every deployment has always used, and what
		 * `DES-WORKER-ON-HOST` chose deliberately: the worker runs on the host and shells out to the real
		 * `docker` CLI, inheriting its cross-platform path translation rather than reimplementing it.
		 */
		describe: "the Docker daemon on this worker's host",
		remote: false,
		declares: {
			// Built by this worker's own argv, in `ISOLATION_FLAGS`, and asserted back member-by-member
			// against the imported array by two tests. `dockerArgsFromSpec` additionally refuses a
			// `dockerExtra` carrying a flag that would supersede one of them -- membership in an argv is not
			// effectiveness of that argv, and without that guard those two assertions would pass on an argv
			// with no boundary left. The deny-list only NARROWED that gap; since issue #341 an allow-list of what
			// the callers pass (`DOCKER_EXTRA_ALLOWED`) closes it, and every caller still passes fixed literals.
			//
			// AND ONLY WHILE OBSERVED (issue #345): the pid and memory bounds in those flags are the daemon's to apply, and a
			// rootless daemon without cgroup delegation accepts `--pids-limit` and applies nothing (measured). So the word is
			// earned by `daemonAppliesBounds` below, and degrades to `asserted` where the daemon is not observed applying them.
			isolation: ENFORCED,
			// `--rm` leads ISOLATION_FLAGS and the container name carries the job id, so no container is
			// reachable to reuse even in principle.
			ephemeral: ENFORCED,
			// The mount list is built by `containerSpec` from a fixed set of named host paths and nothing
			// else. There is no pass-through, and the shared session store under PI_SESSIONS_DIR is never
			// among them -- only this job's own copy. AND ONLY WHILE OBSERVED (issue #345): a runtime can mount things of
			// its own that no argv names (rootful Podman's `/run/secrets`), so the word is earned by `runtimeAddsNoMounts`.
			mountSet: ENFORCED,
			// CAPABILITY, gated by PI_EGRESS. When armed: `--network=pi-job-<id>-net`, `--internal`, created
			// before the spawn and removed in a finally. When PI_EGRESS=0 the flag is absent and the job is
			// on docker's default bridge -- which is why this word is `armedBy` rather than flat.
			egress: ENFORCED,
			// Same switch, and the same reason: an `--internal` network holding exactly two endpoints is what
			// makes job-to-job structurally impossible. Unarmed, egress.mjs records the opposite is true.
			jobToJobIsolation: ENFORCED,
			// `--pull=never`, which makes the fetch branch unreachable rather than merely unlikely. Every
			// path that starts a container from the job image carries it, doctor's probes included.
			imagePinning: ENFORCED,
			// `spawn` on the CLI: the integer comes from the `close` event and is passed to `decideRetry`
			// unmodified.
			exitCodes: ENFORCED,
			// `docker stop` on the name, and the abort FLAG rather than the code is the discriminator -- a
			// worker SIGKILL and a kernel OOM both surface as 137. The worker also BOUNDS the wait after the
			// abort, so a stop that does not take frees the slot instead of holding it forever.
			abortable: ENFORCED,
			// `-v <host>:/job:ro` -- the kernel enforces it. `verify-image.sh` proves it with a live write
			// attempt rather than trusting the flag.
			readOnlyJobInputs: ENFORCED,
			// ASSERTED, not enforced, and this is the honest one. Non-root is `USER pi` in the IMAGE, not in
			// the worker's argv -- SECURITY.md says so in terms: "Non-root is not in that argv." An
			// operator-built image can run as root and nothing here would refuse it (`OQ-012`).
			nonRoot: ASSERTED,
			// Traced end to end: the resolver logs a stderr BYTE COUNT and never the bytes, the refusal
			// comment carries neither the reference nor the resolver's path nor a byte of what it printed,
			// and `buildRecord` is an explicit literal with no spread. Where the values GO is
			// `credentialTransit`'s question, not this one's.
			secretsCustody: ENFORCED,
			// ENFORCED, AND ONLY WHILE OBSERVED (issue #278). Every spawn is `docker` with the worker's own
			// environment inherited, and `DOCKER_HOST`, `DOCKER_CONTEXT` or a context selected in the CLI's config
			// can send that connection to another machine with the provider key and the per-job forge token riding
			// along as `-e NAME=VALUE`. This was `asserted` while nothing in the repository looked. Now the worker
			// asks the CLI which endpoint it resolves (`backend-local.mjs`, `makeDockerEndpointResolver`) at boot
			// and before every job's spend, and the word is what that answer earns: `observedBy` below names the
			// observation, and `effectiveWord` degrades this to `asserted` -- asserted by the operator who pointed
			// the CLI elsewhere -- whenever the endpoint is not observed on this host. A floor asking for
			// `enforced` then refuses; a floor asking for `asserted` holds, because pointing the worker at a daemon
			// is the operator's call. That split is `unarmedFloor`'s lesson: a floor is not met by capability alone.
			//
			// WHAT THE OBSERVATION CANNOT SEE, stated rather than claimed away: it judges the endpoint's FORM, so a
			// unix socket or a loopback port that is really a tunnel (`ssh -L`, socat) to another machine reads as
			// local, as does a `localhost` this host's resolver maps elsewhere; and a redirect that lands between the per-job read and that job's `docker run` spawn is not
			// caught for that job. That window is not small: the read sits before the spend, so it spans the secret
			// resolution, the token mint, the clone and the reservation.
			credentialTransit: ENFORCED,
			// The whole reason `DES-WORKER-ON-HOST` reversed the containerised worker.
			localFolders: ENFORCED,
		},
		/**
		 * WHO is asserting each `asserted` property. Required for every property this backend declares
		 * ASSERTED and meaningless for the others, which a test pins both ways.
		 *
		 * Exists because "asserted" alone is not actionable: it tells an operator the worker is not the one
		 * providing the property without telling them who is, so they cannot go and check. `doctor` prints
		 * this beside the word, which is what lets the claim "asserted names who is asserting it" be true
		 * rather than aspirational. For a vendor adapter this is where "the vendor's documentation" goes.
		 */
		asserts: {
			// Issue #341: on a daemon that enforces bind-mount ownership the argv supplies the uid instead, validated
			// non-zero by the builder; the word stays asserted because on Docker Desktop, and for a uid-1001 worker, the
			// image still provides it.
			nonRoot: "the job image's USER directive (this repo's builds `USER pi`; an operator-built image may not), or on a daemon that enforces bind-mount ownership and a worker uid other than 1001 the worker's own non-zero uid passed as `--user`",
		},
		/**
		 * Which declared words hold only while something about THIS HOST is observed (issue #278), as
		 * `{ property: observation }`. A per-BACKEND map rather than a field on `PROPERTIES` like `armedBy`:
		 * `armedBy` names a deployment switch that means the same thing for every venue, while an observation of
		 * this host's docker CLI means nothing for a remote venue, whose `credentialTransit` a vendor might assert.
		 */
		observedBy: {
			isolation: DAEMON_APPLIES_BOUNDS,
			mountSet: RUNTIME_ADDS_NO_MOUNTS,
			credentialTransit: DOCKER_ENDPOINT_LOCAL,
		},
	},
};

/**
 * FROZEN, deeply. `makeLocalBackend` hands `BACKENDS[name].declares` out on the bundle it returns, so
 * without this a consumer holding a backend could assign one word and silently rewrite what every later
 * reader -- `doctor`, the boot refusal, the receiver -- is told about that backend. A shared mutable
 * security declaration is the believed-in control this file exists to prevent, arriving from inside.
 */
export const BACKENDS = Object.freeze(
	Object.fromEntries(
		// EVERY nested map, not just `declares`: `asserts` is what `doctor` prints beside a word and `observedBy` is
		// what decides whether the word holds, and an unfrozen one is the shared mutable declaration this freeze
		// exists to prevent (#278 found `asserts` had been left mutable).
		Object.entries(BACKENDS_TABLE).map(([name, entry]) => [
			name,
			Object.freeze({ ...entry, declares: Object.freeze({ ...entry.declares }), asserts: Object.freeze({ ...(entry.asserts ?? {}) }), observedBy: Object.freeze({ ...(entry.observedBy ?? {}) }) }),
		]),
	),
);

export const BACKEND_NAMES = Object.freeze(Object.keys(BACKENDS));

/** The default, and the name a deployment that has never heard of this table is running. */
export const DEFAULT_BACKEND = "local";

/**
 * The venue an artifact that NAMES NO VENUE was produced in (issue #277): a session transcript with no stamp
 * beside it, or a sandbox manifest with no `backend` key. Both are written with a venue from #277 on, so one
 * without was written before venues were recorded, when `local` was the only entry this table had -- a fact
 * about the past rather than a setting.
 *
 * DELIBERATELY NOT THE DEPLOYMENT DEFAULT, though today the two spell the same word. The default is
 * `PI_BACKENDS[0]`, which a deployment can change; reading an unstamped transcript as "whatever the default
 * is now" would hand a local transcript to a remote venue the day `PI_BACKENDS` lists that venue first. The
 * past does not move when the configuration does.
 */
export const UNATTRIBUTED_BACKEND = "local";

/**
 * One backend's entry, or `undefined`. The caller decides how loudly an unknown name fails.
 *
 * `Object.hasOwn` rather than a bare index, because the callers this module's header describes are written
 * as `if (!backendFor(name)) refuse()` -- and a bare index walks the prototype chain, so `constructor` and
 * `toString` would return a truthy function and walk straight past that guard.
 */
export function backendFor(name) {
	const key = name ?? DEFAULT_BACKEND;
	return Object.hasOwn(BACKENDS, key) ? BACKENDS[key] : undefined;
}

/**
 * Which declared properties fall short of `want`, as `[{ property, have, want }]`. Empty means it meets it.
 *
 * Returns the SHORTFALL rather than a boolean because every caller has to name what is missing: a refusal
 * that says only "this backend does not meet the floor" sends an operator to read a table, and the whole
 * point of the three words is that the failing one can be printed.
 *
 * THROWS on a floor this module cannot read: an unknown property name, or a value that is not one of the
 * three words. Both are the same failure -- a typo that would otherwise be INVISIBLE. Iterating the closed
 * property list would silently drop `{ egres: "enforced" }`, and ranking an unknown word would silently
 * admit `{ egress: "enfroced" }`; either way the caller gets `[]` back, which is indistinguishable from a
 * satisfied floor, and an operator believes they have a bound they do not have. A config error at boot is
 * the loud, correct end of that, and it is why this validates rather than tolerates.
 */
export function shortfall(name, want = {}) {
	const entry = backendFor(name);
	const out = [];
	// `?? {}` as well as the parameter default: the default only fires for `undefined`, and a floor that
	// arrived as JSON `null` is the same "asked for nothing" case, not a TypeError.
	for (const property of Object.keys(want ?? {})) {
		if (!isProperty(property)) {
			throw new Error(`backend floor: unknown property ${JSON.stringify(property)} (known: ${PROPERTY_NAMES.join(", ")})`);
		}
		const need = (want ?? {})[property];
		if (!isDeclaration(need)) {
			throw new Error(`backend floor: ${property} must be one of ${ENFORCED}, ${ASSERTED}, ${ABSENT}; got ${JSON.stringify(need)}`);
		}
		const have = entry?.declares?.[property] ?? ABSENT;
		if (!meets(have, need)) out.push({ property, have, want: need });
	}
	return out;
}

/**
 * `PI_BACKENDS` -- which backends this deployment blesses, comma separated. Unset means `[local]`, which is
 * what every deployment that has never heard of this table is already running.
 *
 * ENV-ONLY, never the settings overlay and never the deployment pointer, on `config.mjs`'s rule for
 * `PI_SECRET_RESOLVER_ROOTS`: "a bound that can be widened from the surface it bounds is not a bound". The
 * pointer needs no change to enforce that -- `POINTER_ENV_ALLOWLIST` is an ALLOWLIST (of the path and URL
 * variables `resolvePaths` reads), so a name absent from it is refused by omission.
 *
 * An unknown name is REFUSED rather than dropped. Dropping it would leave an operator who misspelled their
 * one entry with a silently empty set, and a deployment that blesses nothing is a deployment where every
 * trigger naming a backend is refused for a reason that names the trigger rather than the typo.
 *
 * Throws a plain Error; `config.mjs` re-tags it as a config error, which is `egressArmed`'s arrangement and
 * for its reason: this module imports nothing, so it cannot reach for that tagger itself.
 */
export function parseBackendList(raw) {
	const names = (raw ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (names.length === 0) return [DEFAULT_BACKEND];
	for (const name of names) {
		if (!Object.hasOwn(BACKENDS, name)) {
			throw new Error(`PI_BACKENDS names an unknown backend ${JSON.stringify(name)} (known: ${BACKEND_NAMES.join(", ")})`);
		}
	}
	// Deduplicated, order preserved: the first entry is what a deployment means by "the default one".
	const unique = [...new Set(names)];
	// The DEFAULT backend must stay in the set. A trigger that names no venue is dispatched to
	// `backends[0]`, and the boot registry refuses a default it does not hold -- so a set excluding it would
	// describe a deployment whose unflagged triggers, which is nearly all of them, have nowhere to run.
	if (!unique.includes(DEFAULT_BACKEND)) {
		throw new Error(`PI_BACKENDS must include ${JSON.stringify(DEFAULT_BACKEND)}: a trigger that names no backend is dispatched there, so a set without it leaves every unflagged trigger nowhere to run`);
	}
	return unique;
}

/**
 * `PI_BACKEND_FLOOR` -- the minimum every blessed backend must declare, as `property=word` pairs, comma
 * separated. Example: `egress=enforced,nonRoot=asserted`. Unset means no floor.
 *
 * PARSED HERE, IN THE LEAF, which is `egressArmed`'s pattern and its reason: `doctor`, `up` and the worker
 * must not be able to disagree about what the floor says. One parse, one answer, and a typo throws at the
 * one place that reads the string rather than defaulting three consumers to three different open postures.
 *
 * Every part is validated and NOTHING is skipped. A pair with no `=`, an unknown property name, an unknown
 * word: each throws. That strictness is the whole point of the variable existing -- `shortfall` returning
 * `[]` is indistinguishable from a satisfied floor, so a floor this module cannot read must never be
 * allowed to become one it reads as empty. `PI_EGRESS` refuses a third value for the same reason.
 */
export function parseBackendFloor(raw) {
	const floor = {};
	for (const pair of (raw ?? "").split(",").map((s) => s.trim()).filter((s) => s.length > 0)) {
		const at = pair.indexOf("=");
		if (at <= 0) {
			throw new Error(`PI_BACKEND_FLOOR entry ${JSON.stringify(pair)} must be property=word (e.g. egress=enforced)`);
		}
		const property = pair.slice(0, at).trim();
		const word = pair.slice(at + 1).trim();
		if (!isProperty(property)) {
			throw new Error(`PI_BACKEND_FLOOR names an unknown property ${JSON.stringify(property)} (known: ${PROPERTY_NAMES.join(", ")})`);
		}
		if (!isDeclaration(word)) {
			throw new Error(`PI_BACKEND_FLOOR: ${property} must be one of ${ENFORCED}, ${ASSERTED}, ${ABSENT}; got ${JSON.stringify(word)}`);
		}
		if (Object.hasOwn(floor, property)) {
			// Last-wins would be a silent choice between two things an operator wrote down deliberately.
			throw new Error(`PI_BACKEND_FLOOR names ${property} twice`);
		}
		floor[property] = word;
	}
	return floor;
}

/**
 * Which floored properties this deployment is NOT getting because their switch is off, as
 * `[{ property, want, armedBy }]`.
 *
 * THE FLOOR IS NOT MET BY CAPABILITY ALONE, and reading it that way was the defect this function exists to
 * close. `shortfall` compares a floor against what a backend CAN do, which is right for the question "could
 * this deployment's jobs ever get this here". It is not the question an operator asks by writing a floor.
 * `local` declares `egress: enforced` whether or not `PI_EGRESS` is armed, so `PI_BACKEND_FLOOR=egress=enforced`
 * on a `PI_EGRESS=0` deployment passed `shortfall` and booted -- and `doctor` then printed "this deployment
 * is not getting it" two lines above "PI_BACKEND_FLOOR holds". Every job ran on docker's default bridge
 * while the operator had asked, in writing, for the opposite.
 *
 * That is the believed-in control `CONST-EGRESS-POLICY-IN-THE-ARGV` describes, arriving through the very
 * mechanism added to discharge it, so the floor reads the switch too. Anything above `absent` on a gated
 * property requires the switch to be ON: a floor asking for `absent` is asking for nothing and is met.
 *
 * `switches` maps an `armedBy` name to whether it is armed. `undefined` means "not known" and is treated as
 * NOT armed, on this file's standing polarity: a thing that cannot be shown to be on gets no credit.
 */
export function unarmedFloor(floor, switches = {}) {
	const out = [];
	for (const [property, want] of Object.entries(floor ?? {})) {
		if (!isProperty(property) || want === ABSENT) continue;
		const armedBy = PROPERTIES[property].armedBy;
		if (armedBy && switches[armedBy] !== true) out.push({ property, want, armedBy });
	}
	return out;
}

/**
 * Every reason the blessed set fails the floor, as `[{ backend, property, have, want }]`. Empty means the
 * deployment is admissible.
 *
 * WHY EVERY BACKEND RATHER THAN THE SELECTED ONE: a floor is a statement about where this deployment's jobs
 * may run, and any blessed backend is somewhere they may run. Checking only the default would let an
 * operator bless a backend that fails the floor and reach it from a trigger, which is the floor widened
 * from the surface it bounds.
 */
export function floorShortfall(names, floor) {
	const out = [];
	for (const backend of names ?? []) {
		for (const miss of shortfall(backend, floor)) out.push({ backend, ...miss });
	}
	return out;
}

/**
 * Every reason this deployment's configuration is inadmissible, as a list of operator-facing messages.
 * Empty means it may boot.
 *
 * THE LADDERS LIVE HERE, IN THE LEAF, rather than in `config.mjs`, for the reason the parsers do: a rule
 * reachable only through `loadConfig` can only be tested through whatever backend names `parseBackendList`
 * currently accepts -- which today is exactly one. Three separate mutations of these rules survived a
 * mutation pass for precisely that reason: the tests could not construct a deployment that violated them.
 * As a pure function over an explicit backend list, each rule can be driven against a backend that fails
 * it, so the rule is pinned rather than merely present. `config.mjs` re-tags these as config errors.
 *
 * Three questions, in the order an operator can act on them:
 *
 *   1. Does every blessed backend clear the floor the operator wrote? Checked against EVERY member rather
 *      than the default alone, because any blessed backend is somewhere this deployment's jobs may run.
 *   2. Is the operator's floor asking for something they have themselves switched off? Capability is not
 *      posture, and a floor met only in principle is the belief this whole vocabulary exists to prevent.
 *   3. Has the deployment armed a control its backend cannot provide at all? Implied rather than written:
 *      arming egress IS asking for egress, whatever the floor says.
 */
export function backendRefusals({ backends = [], backendFloor = {}, egress = false } = {}) {
	const out = [];

	const misses = floorShortfall(backends, backendFloor);
	if (misses.length > 0) {
		const lines = misses.map((m) => `  ${m.backend}: ${m.property} is ${m.have}, PI_BACKEND_FLOOR wants ${m.want}`);
		out.push(`PI_BACKEND_FLOOR is not met by every backend in PI_BACKENDS:\n${lines.join("\n")}`);
	}

	const unarmed = unarmedFloor(backendFloor, { PI_EGRESS: egress });
	if (unarmed.length > 0) {
		const lines = unarmed.map((u) => `  ${u.property}=${u.want} requires ${u.armedBy}, which is off`);
		out.push(
			`PI_BACKEND_FLOOR asks for something this deployment has switched off:\n${lines.join("\n")}\n` +
				"Arm the switch, or lower that entry to `absent` if you did not mean to require it.",
		);
	}

	// EVERY property the armed switch gates, not just `egress`. `armedBy` is a general field and
	// `jobToJobIsolation` carries the same switch -- the table calls it "the measured half of
	// REQ-EGRESS-ALLOWLIST" -- so naming one property here would have let a backend that cannot keep two
	// jobs apart be blessed under an armed policy with nothing said. Hardcoding one variable is the defect
	// `armedBy` was added to prevent, and it had crept back in one function over.
	const switches = { PI_EGRESS: egress };
	for (const property of PROPERTY_NAMES) {
		const armedBy = PROPERTIES[property].armedBy;
		if (!armedBy || switches[armedBy] !== true) continue;
		const unarmable = floorShortfall(backends, { [property]: ASSERTED });
		if (unarmable.length === 0) continue;
		const names = unarmable.map((m) => m.backend);
		out.push(
			`${armedBy} is armed but ${names.join(", ")} ${names.length === 1 ? "declares" : "declare"} ${property} absent, so that control cannot exist there. ` +
				`Set ${armedBy}=0 to run without it, or remove that backend from PI_BACKENDS.`,
		);
	}

	return out;
}
