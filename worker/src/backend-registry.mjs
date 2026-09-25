// The one import this module takes, and it is an import-free leaf for that reason (issue #339).
import { scrubCredentials } from "./redact.mjs";

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
			log("reaper_skipped", { reason: scrubCredentials(err?.message) });
			reaped = false;
		}
	}
	return { reaped };
}

/**
 * The `code` on the error the registry throws for a venue it does not hold, and ONLY that error.
 *
 * A CODE, not a message match: the processor catches this one refusal at pickup (a venue this worker never
 * built is refused and recorded rather than retried) and must let every OTHER throw through -- a registered
 * venue's own `containerName` failing is a broken adapter, and swallowing that would run the job under a
 * null container name that nothing could stop by name.
 */
export const BACKEND_NOT_REGISTERED = "BACKEND_NOT_REGISTERED";

/**
 * The per-venue preflights a bundle MAY carry (issue #354), each with what a venue that carries none answers.
 *
 * OPTIONAL, not in the required list, because requiring them would break every adapter written against the
 * five-function contract `docs/backends.md` publishes, and because the absent answer is not a guess: it is what
 * every non-local venue got before this, when both were `start.mjs` closures that returned exactly these for
 * any venue but `local`. `observationPreflight` admits (nothing about this host is observed for a venue with no
 * `observedBy`), and `jobUserPreflight` runs the image's own USER. Kept equal to the processor's own defaults for
 * those two deps, so a wiring that omits the registry and one whose venue omits the member agree.
 *
 * What absence cannot be is SAFE for a venue whose table entry is observation-gated: that venue's words would
 * then hold with nothing observing them. `start.mjs` refuses such a bundle at boot, because this module cannot
 * read the table (it imports only the redactor).
 */
export const OPTIONAL_PREFLIGHT_DEFAULTS = Object.freeze({
	observationPreflight: () => ({ ok: true }),
	jobUserPreflight: () => ({ user: null, home: null }),
});

/** The venue's own member when it carries one, else the absent answer, as a promise either way. */
async function optionalPreflight(bundle, fn, ...args) {
	return typeof bundle[fn] === "function" ? bundle[fn](...args) : OPTIONAL_PREFLIGHT_DEFAULTS[fn]();
}

/**
 * The NAME of the venue a job resolves to: its own `run.backend`, else the deployment default.
 *
 * ONE DERIVATION FOR DISPATCH AND FOR EVERY STORE THAT RECORDS A VENUE (issue #277). The registry dispatches
 * on it and the run record writes it down. A copy of the expression per store would be one more place a
 * later change could land in one and not the others, and the whole value of a recorded venue is that it IS
 * what dispatched: a record naming a venue the registry did not choose is an audit trail that lies.
 *
 * ABSENT MEANS THE KEY IS ABSENT, `undefined` and nothing else. The loader writes no `backend` key for a
 * trigger that names no venue, and the processor's blessed gate tests `!== undefined`, so an explicit `null`
 * is a NAME the gate refuses rather than a request for the default. Resolving it with `??` would record the
 * default on a job the processor refused for naming something else. No producer writes a null today; this
 * keeps the three readers agreeing if one ever does.
 *
 * TAKES JOB DATA, NEVER THE BULLMQ WRAPPER. A wrapper's own keys are `id` and `data`, so `wrapper.backend`
 * is always undefined and every job would resolve to the default in silence -- the defect `index.mjs`
 * records beside `containerName`, which shipped once. Callers holding a wrapper pass `wrapper.data`.
 *
 * `null` WHEN NEITHER IS KNOWN, never a guessed `local`. Only a dependency-injection seam reaches that (every
 * wired caller is handed `config.defaultBackend`), and a consumer must fail closed on it: the record stores
 * the null, and the registry refuses a job it cannot name. A default here would hide a dropped wire today and
 * become a wrong answer the day `PI_BACKENDS` names a remote venue first.
 *
 * HERE rather than in `backends.mjs`, whose `backendFor(name)` falls back to the TABLE's default -- a
 * different question, and putting the two side by side invites answering one with the other. And a free
 * function rather than a registry method, because a store constructed in `startWorker` before any bundle
 * exists could not reach one -- the temporal dead zone `reapAll` above already records.
 */
export function resolveBackendName(data, defaultName) {
	const named = data?.backend;
	return named !== undefined ? named : (defaultName ?? null);
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
		// `containerName` is in this list because THIS MODULE calls it: `registry.containerName(job)` builds
		// the name the abort then stops. Omitting it built fine and threw at the first pickup, which is the
		// property this constructor claims to have and did not.
		for (const fn of ["runContainer", "imagePreflight", "egressPreflight", "stopContainer", "reap", "containerName"]) {
			if (typeof bundle[fn] !== "function") throw new Error(`backend registry: ${JSON.stringify(bundle.name)} has no ${fn}()`);
		}
		if (!Array.isArray(bundle.neverStartedExits) || !bundle.neverStartedExits.every(Number.isInteger)) {
			// INTEGERS, checked: the processor compares against the container's numeric exit code, so `["125"]`
			// would pass a bare Array.isArray and then never match -- silently keeping the budget slot on
			// exactly the case the list exists to refund.
			throw new Error(`backend registry: ${JSON.stringify(bundle.name)} must declare neverStartedExits as an array of integers ([] if it normalises to container-never-started itself)`);
		}
		// OPTIONAL, but a present one must be callable (issue #354). Absent is a real answer, today's non-local
		// behaviour (see `OPTIONAL_PREFLIGHT_DEFAULTS`); a truthy non-function is a typo'd adapter, and admitting it would
		// land as a TypeError on the pre-spend path at the first pickup, the failure the required list above exists for.
		for (const fn of Object.keys(OPTIONAL_PREFLIGHT_DEFAULTS)) {
			if (bundle[fn] !== undefined && typeof bundle[fn] !== "function") throw new Error(`backend registry: ${JSON.stringify(bundle.name)} has a ${fn} that is not a function`);
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
		const name = resolveBackendName(job, defaultName);
		const bundle = byName.get(name);
		if (!bundle) {
			const err = new Error(`backend registry: no backend named ${JSON.stringify(name)} is registered (have: ${[...byName.keys()].join(", ")})`);
			err.code = BACKEND_NOT_REGISTERED;
			throw err;
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
		// The two OPTIONAL per-venue preflights (issue #354), dispatched through the same resolution as every
		// required one, so an unregistered name still throws BACKEND_NOT_REGISTERED rather than being waved
		// through by a default. A venue that carries none gets the answer the processor's own defaults give.
		observationPreflight: (job) => optionalPreflight(backendFor(job), "observationPreflight", job),
		jobUserPreflight: (job, opts) => optionalPreflight(backendFor(job), "jobUserPreflight", job, opts),
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
