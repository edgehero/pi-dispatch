/**
 * Reap several backends and combine the tri-state CONSERVATIVELY.
 *
 * `reaped` is true only when EVERY backend enumerated successfully. `makeScopeClaimSweeper` reads it as
 * "this host has established that it holds no job containers", and that claim is only as strong as its
 * weakest venue: one backend that could not list its containers leaves the host unable to prove it holds
 * none, whatever the others managed. Sweeping on a partial answer would free scope slots for containers
 * that may still be running and let another host start more alongside them -- a spend overrun rather than a
 * tidy-up, which is the reason the tri-state exists at all.
 *
 * Every reaper runs even after one fails, because the sweep is best-effort cleanup and a second venue's
 * strays are worth clearing whether or not the first venue answered.
 *
 * A FREE FUNCTION rather than a method on the registry, and the reason is a defect this replaced: the boot
 * sweep runs far earlier in `startWorker` than any backend BUNDLE can be built -- the bundles need the log
 * sink, the package resolver and the image preflight, all of which are constructed later. A first attempt
 * called `registry.reap()` at the boot sweep, which is a temporal dead zone; the boot try/catch swallowed
 * the ReferenceError and the reaper silently stopped running. So the combination lives where both callers
 * can reach it, and `startWorker` holds its reapers in one map that the bundles then read from by name.
 */
export async function reapAll(reaps = [], { log = () => {} } = {}) {
	let reaped = true;
	for (const reap of reaps) {
		try {
			if ((await reap())?.reaped !== true) reaped = false;
		} catch (err) {
			// A reaper that THREW is the same unproven state as one that returned false -- but it is NOT the
			// same silence. Each backend's own reap logs the faults it catches; one that escapes its own
			// catch reached the caller before this function existed, and the caller logged it. Swallowing it
			// here without a word would delete an operator-visible signal about a venue that could not be
			// swept, so the log seam is threaded through rather than assumed to be somebody else's job.
			log("reaper_skipped", { reason: err?.message });
			reaped = false;
		}
	}
	return { reaped };
}

/**
 * WHICH backend runs THIS job, and the one place that decides (issue #227).
 *
 * The three earlier slices built a table, taught the deployment to read it, and let a trigger name a venue.
 * None of them dispatched: `start.mjs` built the local bundle and passed its functions straight into the
 * processor, so `run.backend` was a validated, gated LABEL and every job ran on `local` whatever it said.
 * This module is what makes the label mean something.
 *
 * IT IS DELIBERATELY NOT A `switch`. Every per-job function a backend owns is dispatched through the SAME
 * resolution, so a future function cannot be added on one path and forgotten on another -- which is exactly
 * how `stopContainer` came to be hard-wired in `index.mjs` while `runContainer` was injectable, and how the
 * abort path ended up unable to reach a backend at all.
 *
 * RESOLUTION IS TOTAL AND FAIL-CLOSED-BY-CONSTRUCTION. `backendFor` returns the DEFAULT bundle for a job
 * that names nothing, and for a name the registry does not hold it returns... nothing, and throws. That is
 * not a policy decision made here: the processor already REFUSES a job naming an unblessed backend
 * pre-spend, and the loader already refuses a name this build does not know, so a job reaching this point
 * with an unknown name means one of those two gates was bypassed. Throwing is right for a state the design
 * says is unreachable -- a silent fallback to the default would run the job somewhere the operator did not
 * choose, which is the believed-in control this whole issue exists to prevent, and it would hide the
 * bypassed gate rather than surface it.
 *
 * @param bundles  the blessed backend bundles (each from a `make<Name>Backend`), keyed by their own `name`
 * @param defaultName  the venue a job that names none runs in -- `PI_BACKENDS[0]`
 */
export function makeBackendRegistry({ bundles = [], defaultName, blessed = null, reaps = null } = {}) {
	const byName = new Map();
	for (const bundle of bundles) {
		if (!bundle?.name) throw new Error("backend registry: every bundle must carry its own name");
		if (byName.has(bundle.name)) throw new Error(`backend registry: ${JSON.stringify(bundle.name)} is registered twice`);
		// SHAPE, at boot. `makeLocalBackend` enforces this for its own bundle and the registry never calls
		// it, so a hollow bundle used to build fine and fail at the first PICKUP -- as a plain TypeError
		// after the budget reserve, which is not an InfraRetry, so the slot was never refunded. The
		// "refuse at boot rather than at first pickup" property this constructor already claims for names
		// and duplicates has to hold for the functions it is going to call.
		for (const fn of ["runContainer", "imagePreflight", "egressPreflight", "stopContainer", "reap"]) {
			if (typeof bundle[fn] !== "function") throw new Error(`backend registry: ${JSON.stringify(bundle.name)} has no ${fn}()`);
		}
		if (!Array.isArray(bundle.neverStartedExits)) {
			throw new Error(`backend registry: ${JSON.stringify(bundle.name)} must declare neverStartedExits as an array ([] if it normalises to container-never-started itself)`);
		}
		byName.set(bundle.name, bundle);
	}
	if (byName.size === 0) throw new Error("backend registry: at least one backend must be registered");
	// The default has to BE one of them. Without this, `defaultName` could name a venue nothing implements
	// and every unflagged job -- which is nearly all of them -- would throw at pickup rather than at boot.
	if (!byName.has(defaultName)) {
		throw new Error(`backend registry: the default ${JSON.stringify(defaultName)} is not among the registered backends (${[...byName.keys()].join(", ")})`);
	}
	// A name can be BLESSED AND UNBUILT, and no other gate catches it. The loader refuses a name this build
	// does not know and the processor refuses one `PI_BACKENDS` does not bless -- but the registry's own set
	// is a third set neither compares against, so a blessed name with no bundle passes both and then throws
	// at the first pickup, as a non-InfraRetry that becomes a permanently failed job blaming the operator
	// for a deployment they configured correctly. The header's "reaching here means a gate was bypassed" is
	// only true once this check exists, which is why it does.
	for (const name of blessed ?? []) {
		if (!byName.has(name)) {
			throw new Error(`backend registry: PI_BACKENDS blesses ${JSON.stringify(name)} but no backend by that name is built (built: ${[...byName.keys()].join(", ")})`);
		}
	}
	// The boot sweep is handed a list of reapers rather than the registry (see `reapAll`), so the two sets
	// can drift -- and a missing reaper is INVISIBLE, because `reapAll` is conservative over the reapers it
	// receives, not over the venues that exist. A forgotten entry would report `{reaped: true}` while a
	// venue went unswept, and the scope sweep would then free slots for containers that may still be
	// running: the exact spend overrun the tri-state exists to prevent, arriving through the one seam its
	// conservatism does not cover.
	if (reaps) {
		const missing = [...byName.keys()].filter((n) => typeof reaps[n] !== "function");
		if (missing.length > 0) throw new Error(`backend registry: no boot reaper for ${missing.join(", ")} -- an unswept venue would still report the host as proven clean`);
		const extra = Object.keys(reaps).filter((n) => !byName.has(n));
		if (extra.length > 0) throw new Error(`backend registry: a boot reaper for unregistered backend(s) ${extra.join(", ")}`);
	}

	/** The bundle this job runs in. Throws for a name no gate should have let through. */
	function backendFor(job) {
		const name = job?.backend ?? defaultName;
		const bundle = byName.get(name);
		if (!bundle) {
			throw new Error(`backend registry: no backend named ${JSON.stringify(name)} is registered (have: ${[...byName.keys()].join(", ")})`);
		}
		return bundle;
	}

	return {
		backendFor,
		names: [...byName.keys()],
		defaultName,
		/**
		 * The per-job functions, each resolving the venue from the job it was handed. These are what the
		 * processor and the abort path receive, so neither of them needs to know a registry exists.
		 *
		 * `stopContainer` takes the JOB as well as the name, and that second argument is the whole reason
		 * the abort path had to change: the container's NAME is not enough to find the runtime that holds
		 * it once there is more than one, and `index.mjs` had only the name.
		 */
		runContainer: (args) => backendFor(args?.job).runContainer(args),
		imagePreflight: (job) => backendFor(job).imagePreflight(job),
		egressPreflight: (job) => backendFor(job).egressPreflight(job),
		stopContainer: (name, job) => backendFor(job).stopContainer(name, job),
		// ON THE SURFACE, not reached for through `backendFor` by a call site. Both are per-job backend
		// FACTS rather than functions, and an earlier draft left them off: the wiring rebuilt
		// `neverStartedExits` at the call site and `index.mjs` imported `jobContainerName` from the local
		// adapter directly. That is precisely the "dispatched on one path, hardcoded on another" shape this
		// module's header says is structurally impossible -- and the container NAME is the argument the
		// abort's `stopContainer` receives, so building it locally while resolving the venue per job was the
		// same defect in the one call the slice exists to make dispatchable.
		neverStartedExits: (job) => backendFor(job).neverStartedExits,
		containerName: (job) => backendFor(job).containerName(job?.id),
		// The reaper map, validated above against the registered set, so the boot sweep can be handed
		// something that cannot silently under-enumerate.
		reaps: reaps ? Object.values(reaps) : [],
	};
}
