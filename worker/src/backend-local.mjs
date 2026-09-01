/**
 * THE `local` BACKEND: the Docker daemon on this worker's own host (issue #227).
 *
 * `backends.mjs` says WHAT each backend guarantees; this module is the first thing that has to be true.
 * It bundles the functions that actually build and run a container into one value, so that "a backend" is
 * a thing the worker holds rather than a shape spread across four `deps` keys nobody names together.
 *
 * WHY THE TABLE DOES NOT HOLD A `make()`. The obvious design is one entry per backend carrying its own
 * factory, and it cannot work here: `backends.mjs` imports NOTHING on purpose, because `doctor`, the config
 * loader and the receiver all have to read a declaration without pulling the Docker implementation into
 * their graph. A `make()` in the table is an import edge from the leaf to every adapter, which is the leaf
 * property gone. So the table declares and this module implements, and the two are joined by NAME -- the
 * same split `forges.mjs` uses against the forge hosts.
 *
 * FIVE FUNCTIONS, and the last two arrived late on purpose. `stopContainer` was a one-line literal inside
 * `index.mjs`'s `createWorker` and unreachable from `startWorker`; `reap` lived in `start.mjs` and returns a
 * TRI-STATE that `makeScopeClaimSweeper` gates a money decision on. Neither could move without its reasoning
 * moving too, so an earlier slice declared `abortable` in the table, named both as deferred, and REFUSED a
 * bundle that tried to supply them -- because an adapter author who passes `stopContainer` and has it
 * silently dropped believes a runaway job can be stopped through their backend when the abort path still
 * calls docker directly. That refusal is now gone because the seam is real.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { BACKENDS, DEFAULT_BACKEND, DOCKER_NEVER_STARTED_EXITS } from "./backends.mjs";

const execDocker = promisify(execFile);

/**
 * `pi-job-` -- the container-name namespace, and a LOAD-BEARING string rather than a prefix chosen for
 * readability. TWO sweeps match it as a SUBSTRING, both at boot in `start.mjs`: the container reaper's
 * `docker ps` filter and the network reaper's `docker network ls` filter. The sandbox tooling is the
 * counterpart rather than a third sweep -- it names itself `pi-sandbox-` precisely to stay OUTSIDE this
 * namespace, so a worker restart cannot tear down the shell an operator is sitting in, and it reaps its own
 * by job id rather than by name.
 *
 * Exported and imported rather than re-typed at each site for the reason `CONTAINER_GLOBAL_PI_DIR` is: the
 * namespace and the filters that sweep it are ONE fact, and two literals in two modules is how a rename
 * lands in the producer and not in the reaper, leaving every crashed worker's containers behind forever with
 * both test suites green.
 */
export const JOB_NAME_PREFIX = "pi-job-";

/**
 * `pi-job-<jobId>`. The name a running job answers to, for `docker stop` on the 30-minute timeout, for the
 * per-job egress network derived from it, and for the reaper's filter.
 *
 * Not sanitised here: BullMQ ids are already `[A-Za-z0-9._-]`, and the one place a job id comes from
 * anywhere else (a sandbox) goes through `sanitizeJobId` under its own prefix.
 */
export function jobContainerName(jobId) {
	return `${JOB_NAME_PREFIX}${jobId}`;
}

/**
 * Bundle the local backend's already-built functions into one checked value.
 *
 * Takes them BUILT rather than building them from config, because each is constructed in `start.mjs` from a
 * different slice of the deployment and behind its own injectable factory that the wiring tests drive. This
 * function's job is not to own that construction; it is to be the one place that says these functions
 * together are a backend, and to REFUSE a bundle that is missing one.
 *
 * The refusal is worth having and worth not overselling. It catches a bundle assembled with a key MISSING or
 * not callable, which is a wiring mistake that would otherwise surface as an unhelpful `undefined is not a
 * function` deep inside a paid job. It proves ARITY AND NOTHING ELSE: `makeEgressPreflight({ armed: false })`
 * returns a function that answers `{ ok: true }` and spawns nothing, so a bundle can pass this check with a
 * gate that does no gating. Distinguishing a gate from a stub needs a conformance suite that drives the
 * backend and reads the property back, which is this issue's last slice.
 */
/** The functions a bundle carries today. Deferred members are refused BY NAME below, never ignored. */
export const BACKEND_FUNCTIONS = ["runContainer", "imagePreflight", "egressPreflight", "stopContainer", "reap"];

/**
 * Non-function members every bundle must also carry. Separate from the list above because the completeness
 * check tests callability, and these are values -- but they are just as required: `neverStartedExits` gates
 * a budget REFUND, so a bundle that omitted it would keep the slot and let BullMQ retry, burning a second
 * one per never-started job. That is the exact bug the explicit `case 125/126/127` was added to fix,
 * reachable again by an adapter simply not setting a property.
 */
export const BACKEND_VALUES = ["neverStartedExits"];

export function makeLocalBackend(parts = {}) {
	const { runContainer, imagePreflight, egressPreflight, stopContainer, reap } = parts ?? {};
	const missing = Object.entries({ runContainer, imagePreflight, egressPreflight, stopContainer, reap })
		.filter(([, fn]) => typeof fn !== "function")
		.map(([k]) => k);
	if (missing.length > 0) {
		throw new Error(`backend "${DEFAULT_BACKEND}": cannot build a backend missing ${missing.join(", ")}`);
	}

	// An unknown key is REFUSED rather than dropped, and the two this slice defers are named as deferred.
	// An adapter author who supplies `stopContainer` has read the issue and reasonably expects it to be
	// wired; silently ignoring it would leave them believing a runaway job can be stopped through their
	// backend while the abort path still goes straight to the local docker CLI. That is the believed-in
	// control again, arriving through a dropped argument.
	for (const key of Object.keys(parts ?? {})) {
		if (BACKEND_FUNCTIONS.includes(key) || BACKEND_VALUES.includes(key)) continue;
		throw new Error(`backend "${DEFAULT_BACKEND}": unknown bundle member ${JSON.stringify(key)} (known: ${BACKEND_FUNCTIONS.join(", ")})`);
	}

	return {
		name: DEFAULT_BACKEND,
		// The declaration is READ from the table, never re-typed here. An adapter that stated its own
		// guarantees inline could drift from what `doctor` prints and what the boot refusal checks, and an
		// operator would then be told one thing by the thing that decides and another by the thing that ran.
		// This is the SAME object the table holds, and that is safe only because the table is deeply FROZEN:
		// an unfrozen alias would let any holder of a bundle rewrite what `doctor`, the boot refusal and the
		// receiver are all told about this backend, process-wide and invisibly, while the source still read
		// `enforced`. A defensive copy would hide such a mutation rather than prevent it.
		declares: BACKENDS[DEFAULT_BACKEND].declares,
		namePrefix: JOB_NAME_PREFIX,
		containerName: jobContainerName,
		runContainer,
		imagePreflight,
		egressPreflight,
		stopContainer,
		reap,
		// The integers this runtime uses for "the runner never ran". The processor asks the BACKEND rather
		// than assuming docker's triple, because those numbers collide with the runner's own exit channel.
		neverStartedExits: LOCAL_NEVER_STARTED_EXITS,
	};
}

/**
 * The exit codes that mean THE RUNNER NEVER RAN, as this runtime spells them.
 *
 * Docker's own convention, and defined in `backends.mjs` rather than here so the processor can default to
 * it without importing this module. Re-exported under the local backend's name because that is what the
 * bundle carries and what an adapter author reads.
 */
export const LOCAL_NEVER_STARTED_EXITS = DOCKER_NEVER_STARTED_EXITS;

/**
 * `docker stop` on the job's container name, fired by the abort (the 30-minute timeout or a shutdown).
 *
 * MOVED HERE from `index.mjs`'s `createWorker`, where it was a one-line literal inside the processor's
 * construction and could not be reached from `startWorker` at all. That is why `abortable` was declared in
 * the table two slices before this function existed: a second backend could have passed every other check
 * with no way to stop a runaway container, and nothing in the table would have moved.
 *
 * `-t 5` is SIGTERM then SIGKILL after five seconds. The runner exits, `docker run` returns, and
 * `runContainer`'s promise resolves -- so the abort's effect reaches the processor through the container's
 * own exit rather than through this call's return value, which is why nothing awaits it.
 *
 * `INT-RUNNER-EXIT-CODE-PROTOCOL` is what makes this transferable: the discriminator is the abort FLAG the
 * processor already holds, not the exit code, because a worker SIGKILL and a kernel OOM both surface as
 * 137. An adapter implements "stop this job" however its runtime spells it and the classification is
 * unchanged.
 */
export function makeStopContainer({ exec = execDocker } = {}) {
	return async function stopContainer(name) {
		return exec("docker", ["stop", "-t", "5", name]);
	};
}

/**
 * Boot-time reaper: clear stray `pi-job-*` containers a previous worker crash left behind.
 *
 * MOVED HERE from `start.mjs` (issue #227). It belongs to the backend because the containers it sweeps are
 * that backend's, and a second backend's crashed containers are unreachable by this one's `docker ps`.
 *
 * THE TRI-STATE IS THE POINT and moved with it: `{ reaped: true }` means this host has ESTABLISHED that it
 * holds no job containers, `{ reaped: false }` means it could not establish that. `makeScopeClaimSweeper`
 * gates a money decision on the difference -- it may only delete a scope claim naming this host once the
 * host has proven it holds nothing -- so returning `[]` or `true` on a failed enumeration would free slots
 * for containers that may still be running and let another host start more alongside them. That is a spend
 * overrun rather than a tidy-up, which is why the catch below returns false rather than swallowing.
 */
export function makeReaper({ log, exec = execDocker }) {
	return async function reap() {
		try {
			const { stdout } = await exec("docker", ["ps", "--filter", `name=${JOB_NAME_PREFIX}`, "--format", "{{.Names}}"]);
			const names = stdout
				.split("\n")
				.map((n) => n.trim())
				.filter(Boolean);
			for (const name of names) {
				await exec("docker", ["rm", "-f", name]);
				log("reaped_container", { name });
			}
			// REQ-EGRESS-ALLOWLIST: the per-job networks those containers were on. Swept AFTER the containers,
			// because a network with a member still attached cannot be removed -- and swept by the SAME
			// `pi-job-` filter, so the namespace rule that keeps an operator's live sandbox safe from the
			// container reaper keeps their sandbox NETWORK safe too, with no second rule to remember.
			//
			// A crashed worker is the case this exists for: `runContainer`'s own finally removes the network
			// on every ordinary path, so anything still here outlived a process that did not get to run it.
			// A network still in use by something else fails to remove and is skipped, which is correct: this
			// is a best-effort sweep and never a reason not to boot.
			const { stdout: nets } = await exec("docker", ["network", "ls", "--filter", `name=${JOB_NAME_PREFIX}`, "--format", "{{.Name}}"]);
			for (const net of nets.split("\n").map((n) => n.trim()).filter(Boolean)) {
				try {
					await exec("docker", ["network", "rm", net]);
					log("reaped_network", { network: net });
				} catch {} // still in use, or already gone -- either way not this boot's problem
			}
			// Whether the enumeration HAPPENED, which the scope-claim sweep depends on: it may only delete a
			// claim naming this host once this host has actually established that it holds no containers.
			return { reaped: true };
		} catch (err) {
			// The `docker ps` is inside this try, so this path CANNOT establish that this host holds no
			// containers -- whether it failed before listing anything or after reaping some and then losing
			// the daemon. Either way the claim "I hold nothing" is unproven, and sweeping on it would free
			// slots for containers that may STILL BE RUNNING, letting another host start more alongside
			// them: a money overrun rather than a tidy-up. Conservative in the only safe direction.
			log("reaper_skipped", { reason: err?.message });
			return { reaped: false };
		}
	};
}

