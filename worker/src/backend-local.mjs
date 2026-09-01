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
 * WHAT IS AND IS NOT HERE YET. Three of the functions a backend owns are already injectable and are bundled
 * below. Two are not, and pretending otherwise would be the believed-in control this whole issue is trying
 * to avoid:
 *
 *   `stopContainer` is HARD-WIRED in index.mjs's abort path and cannot be reached from `startWorker`.
 *   `reap()` returns a TRI-STATE that `makeScopeClaimSweeper` gates a money decision on, so it is not a
 *   function that can be moved without moving that reasoning with it.
 *
 * Both are the next slice's work, not this one's, and the bundle's own completeness check names exactly the
 * set it currently claims rather than a set it wishes it had.
 */

import { BACKENDS, DEFAULT_BACKEND } from "./backends.mjs";

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
export const BACKEND_FUNCTIONS = ["runContainer", "imagePreflight", "egressPreflight"];

/** Named so the refusal can say "not yet" rather than "unknown", which is a different instruction. */
const DEFERRED_FUNCTIONS = ["stopContainer", "reap"];

export function makeLocalBackend(parts = {}) {
	const { runContainer, imagePreflight, egressPreflight } = parts ?? {};
	const missing = Object.entries({ runContainer, imagePreflight, egressPreflight })
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
		if (BACKEND_FUNCTIONS.includes(key)) continue;
		if (DEFERRED_FUNCTIONS.includes(key)) {
			throw new Error(`backend "${DEFAULT_BACKEND}": ${key} is not part of the bundle yet (issue #227 defers it); the abort and reap paths still call docker directly`);
		}
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
	};
}
