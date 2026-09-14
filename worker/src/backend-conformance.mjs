/**
 * THE CONFORMANCE SUITE a backend runs against itself (issue #227).
 *
 * Every earlier slice of this issue ends with the same sentence: the table's words are a CONTRACT and not a
 * FINDING, because nothing verifies a declaration against behaviour. `backends.mjs` says so in its own
 * header, `backend-local.mjs` says its completeness check "proves ARITY AND NOTHING ELSE", and
 * `container-spec.mjs` says the transfer abstraction is an adapter-facing contract awaiting a consumer.
 * This module is that consumer. It is what turns `enforced` from a word into something that can be wrong.
 *
 * IT SHIPS IN `src/`, NOT IN `test/`, and that is the whole point. A suite that lived beside this repo's own
 * tests could only ever check this repo's own backend. An adapter is written elsewhere, by someone who will
 * never run `npm test` here, and the question they need answered is "does MY backend hold the contract" --
 * so the checks have to be importable. `docs/backends.md` is the page that tells them to import it.
 *
 * WHAT IT CAN AND CANNOT DO, stated at its true size. It verifies the SHAPE of a bundle, the INTERNAL
 * CONSISTENCY of its declaration, and the behaviour of whatever the caller's PROBES produce. It cannot
 * start a real container, reach a real daemon, or prove a kernel enforced anything itself: the six properties a
 * container read can reach arrive through a `readBack` probe (READ_BACK_BY_A_LIVE_PROBE), which for `local` is
 * `doctor --live`.
 *
 * THE PROBES ARE THE ADAPTER'S OWN CODE, and that is a real limit rather than a detail. How you make a
 * container exit 2, or make an enumeration fail, is the runtime's business and cannot be written
 * generically -- so `checkExitCodes` and `checkAbortFlag` verify what your probe REPORTS, and a probe that
 * fabricates its answer instead of routing through your `runContainer` will pass while proving nothing.
 * The suite cannot detect that, which is why it is written here rather than left for a reader to discover.
 * `docs/backends.md` says the same thing where an adapter author will actually read it.
 *
 * `OQ-012`'s line applies to the harness itself: a check that proves intent is not a check that proves
 * conformance, and the difference has to be stated rather than blurred.
 */

import { BACKENDS, PROPERTY_NAMES, isDeclaration } from "./backends.mjs";
import { containerSpec, copyDowngrades } from "./container-spec.mjs";

/** A finding. `ok: false` is a contract violation; `unverifiable` is a property this harness cannot reach. */
const pass = (check, detail) => ({ check, ok: true, detail });
const fail = (check, detail) => ({ check, ok: false, detail });
const abstain = (check, detail) => ({ check, ok: true, unverifiable: true, detail });

/**
 * EXIT-CODE FIDELITY. The runner's integer must reach the processor unmodified.
 *
 * `INT-RUNNER-EXIT-CODE-PROTOCOL` rests on this and so does every retry decision: 0 is completed, 1 is
 * infra (retry), 2 is policy (no retry). A backend that clamped, remapped or swallowed a code would turn a
 * policy refusal into a paid retry loop, or a real failure into a clean success. The zero case matters most
 * -- a backend that returns a falsy code as `null` reads as "unknown exit" downstream.
 */
async function checkExitCodes(backend, { probe }) {
	const out = [];
	for (const code of [0, 1, 2, 3, 137, 255]) {
		const got = await probe(backend, { exitCode: code });
		if (got?.code !== code) {
			out.push(fail("exitCodes", `a runner exit of ${code} arrived as ${JSON.stringify(got?.code)}; every retry decision reads this integer`));
			return out;
		}
	}
	out.push(pass("exitCodes", "0, 1, 2, 3, 137 and 255 all arrive unmodified"));
	return out;
}

/**
 * THE ABORT FLAG must be distinguishable from the exit code.
 *
 * `INT-RUNNER-EXIT-CODE-PROTOCOL`: a worker SIGKILL and a kernel OOM BOTH surface as 137, so the code alone
 * cannot say which happened. The processor classifies an abort as POLICY (no retry) and an OOM as INFRA
 * (retry), so a backend that reports only the integer makes a hung job retry forever and an OOM look like a
 * deliberate stop. This is the single most transferable clause in the contract and the easiest to drop.
 */
async function checkAbortFlag(backend, { probe }) {
	const stopped = await probe(backend, { exitCode: 137, aborted: true });
	const oomed = await probe(backend, { exitCode: 137, aborted: false });
	if (stopped?.aborted !== true) return [fail("abortable", "a container stopped by the worker did not report aborted: true; 137 alone cannot be told from a kernel OOM")];
	if (oomed?.aborted === true) return [fail("abortable", "a container that exited 137 on its own reported aborted: true; an OOM would be classified as a deliberate stop and never retried")];
	return [pass("abortable", "the abort flag is reported independently of the exit code")];
}

/**
 * THE REAPER'S TRI-STATE. `{reaped: true}` means "this host has ESTABLISHED it holds no job containers".
 *
 * `makeScopeClaimSweeper` gates a money decision on it: it may only delete a scope claim naming this host
 * once the host has proven it holds nothing. A backend whose reap returns true after a FAILED enumeration
 * frees slots for containers that may still be running and lets another host start more alongside them --
 * a spend overrun rather than a tidy-up. Returning `[]` on a failed listing is the specific shape that gets
 * this wrong, because an empty list and an unanswerable question look identical.
 */
async function checkReaperTriState(backend, { withBrokenEnumeration }) {
	if (typeof backend?.reap !== "function") return []; // the shape check already said so; do not say it twice
	if (typeof withBrokenEnumeration !== "function") {
		return [abstain("reap", "no `withBrokenEnumeration` probe supplied, so a failed enumeration could not be simulated")];
	}
	const broken = await withBrokenEnumeration(backend);
	if (broken?.reaped !== false) {
		return [fail("reap", `a reap whose enumeration failed returned ${JSON.stringify(broken)}; it must be {reaped:false}, or a scope sweep frees slots for containers that may still be running`)];
	}
	const clean = await backend.reap();
	if (clean?.reaped !== true) return [fail("reap", `a successful reap returned ${JSON.stringify(clean)}; it must be {reaped:true} or no host can ever sweep its own stale claims`)];
	return [pass("reap", "the tri-state distinguishes a failed enumeration from an empty one")];
}

/**
 * THE BUNDLE'S SHAPE, and the name it answers to.
 *
 * Cheap, and it catches the mistake an adapter author actually makes: a bundle whose `name` does not match
 * the table entry it declares against. The registry keys on `name` and the table keys on the same string,
 * so a mismatch silently gives the adapter a different backend's declaration.
 */
function checkShape(backend) {
	const out = [];
	// `containerName` is here because the REGISTRY calls it -- `registry.containerName(job)` builds the
	// name the abort then stops. A bundle without it built at boot and threw at the first pickup, which is
	// exactly the property the registry claims to have.
	for (const fn of ["runContainer", "imagePreflight", "egressPreflight", "stopContainer", "reap", "containerName"]) {
		if (typeof backend?.[fn] !== "function") out.push(fail("shape", `the bundle has no ${fn}()`));
	}
	if (!Array.isArray(backend?.neverStartedExits)) {
		out.push(fail("shape", "neverStartedExits must be an array -- [] if this runtime normalises to container-never-started itself"));
	} else {
		// The set must not CLAIM a code the protocol already means. 137 is the OOM/SIGKILL code, so claiming
		// it turns every kernel OOM into a refunded "never started" -- the container ran, spent its slot, and
		// the refund hands the slot back. 0/1/2 are the runner's own completed/infra/policy codes, so claiming
		// one of those converts a real outcome into an infra retry that can never resolve. Both are money.
		const reserved = backend.neverStartedExits.filter((c) => [0, 1, 2, 137].includes(c));
		if (reserved.length > 0) {
			out.push(fail("shape", `neverStartedExits claims ${reserved.join(", ")}, which INT-RUNNER-EXIT-CODE-PROTOCOL already means (0 completed, 1 infra, 2 policy, 137 OOM/SIGKILL); claiming one refunds a slot the container actually spent`));
		}
	}
	const entry = BACKENDS[backend?.name];
	if (!entry) out.push(fail("shape", `the bundle's name ${JSON.stringify(backend?.name)} has no entry in the backend table, so nothing declares what it guarantees`));
	else {
		// BY VALUE, not by reference. An adapter written outside this repo cannot hold the table's own frozen
		// object, and refusing a faithful copy made `checkDeclaration` below unreachable -- every bundle that
		// passed shape held the table's own words, so the declaration gate could only ever restate a shape
		// failure. What matters is that the words AGREE, since disagreement is what lets an adapter say one
		// thing while doctor prints another.
		const drift = PROPERTY_NAMES.filter((p) => backend.declares?.[p] !== entry.declares[p]);
		if (drift.length > 0) out.push(fail("shape", `the bundle declares ${drift.join(", ")} differently from the table, so doctor would print one answer and the adapter believe another`));
	}
	return out.length > 0 ? out : [pass("shape", "six functions, a declared exit set, and a name the table knows")];
}

/**
 * THE DECLARATION ITSELF, against the closed list and the three words.
 *
 * A backend that omits a property is not admitted for it (`backends.mjs`'s rule), and a word outside the
 * vocabulary ranks with `absent`, so a typo would silently downgrade rather than fail.
 */
function checkDeclaration(backend) {
	const declares = backend?.declares ?? {};
	const out = [];
	for (const property of PROPERTY_NAMES) {
		if (!isDeclaration(declares[property])) out.push(fail("declaration", `${property} is declared ${JSON.stringify(declares[property])}, which is not one of enforced/asserted/absent`));
	}
	for (const property of Object.keys(declares)) {
		if (!PROPERTY_NAMES.includes(property)) out.push(fail("declaration", `${property} is not a property of the closed list, so nothing reads it`));
	}
	// An `asserted` word with no source is not actionable: it says the worker is not providing the property
	// without saying who is, so an operator cannot go and check.
	for (const property of PROPERTY_NAMES) {
		if (declares[property] === "asserted" && !BACKENDS[backend?.name]?.asserts?.[property]) {
			out.push(fail("declaration", `${property} is asserted but nothing names WHO asserts it; "not us" without "them" leaves an operator nothing to check`));
		}
	}
	return out.length > 0 ? out : [pass("declaration", "every property carries one of the three words, and every asserted one names its source")];
}

/**
 * THE TRANSFER CONTRACT, and the check that gives it teeth.
 *
 * This is the consumer `container-spec.mjs` was written for. A backend that COPIES rather than bind-mounts
 * loses the kernel's enforcement of `/job`'s read-only mount -- `DES-JOB-FILES-VIA-VOLUME-SUBPATH` says
 * `docker cp` "cannot give /job a kernel-enforced read-only mount, which INT-CONTAINER-JOB-INPUTS depends
 * on" -- so a backend declaring `binds: false` and `readOnlyJobInputs: enforced` is making exactly the
 * claim `CONST-EGRESS-POLICY-IN-THE-ARGV` calls worse than no claim at all.
 */
function checkTransfers(backend) {
	const declares = backend?.declares ?? {};
	// `binds` is the adapter's own statement about how it moves files. Absent means "bind-mounts", which is
	// what the local backend does and what every reader assumed before this field existed.
	// FAIL-CLOSED on an unstated `binds`. An earlier draft treated "not false" as "binds", so a copying
	// adapter that never set the field got a positive assertion about a property nothing had examined --
	// the believed-in control, produced by the harness written to prevent it. A backend that does not say
	// how it moves files has not earned the word, and this abstains rather than failing because not saying
	// is a documentation gap rather than a false claim.
	if (backend?.binds === undefined) {
		return [abstain("readOnlyJobInputs", "this backend does not declare `binds`, so whether /job's read-only is the kernel's or a convention could not be determined; set binds: true (bind-mounts) or false (copies)")];
	}
	if (backend.binds === true) {
		return [pass("readOnlyJobInputs", "this backend bind-mounts, so /job's read-only is the kernel's")];
	}
	const spec = containerSpec({ image: "i", name: "n", jobDir: "/j", workspace: "/w" });
	const lost = copyDowngrades(spec).map((d) => d.container);
	if (lost.length > 0 && declares.readOnlyJobInputs === "enforced") {
		return [fail("readOnlyJobInputs", `this backend copies, so ${lost.join(", ")} is read-only by convention rather than by the kernel -- declaring it enforced is a control an operator would believe in and not have`)];
	}
	return [pass("readOnlyJobInputs", `this backend copies and declares ${JSON.stringify(declares.readOnlyJobInputs)}, which matches what a copy can hold`)];
}

/**
 * Run every check against one backend bundle.
 *
 * `probe` is the one thing an adapter must supply: `(backend, { exitCode, aborted }) => result`, arranging
 * for the backend's own `runContainer` to produce a container that exits that way. It cannot be written
 * generically -- how you make a container exit 2 is the runtime's business -- and it is the reason this is a
 * function taking probes rather than a fixed suite. `withBrokenEnumeration` drives the reaper's failure path, and
 * `readBack(backend)` reports the six properties read off a live container (see READ_BACK_BY_A_LIVE_PROBE); each
 * one missing abstains.
 *
 * Returns `{ ok, findings }`. `ok` is false if ANY check failed; a check that abstained does not fail the
 * run but is reported, because a property nobody could verify is not a property that was verified.
 */
export async function runBackendConformance(backend, probes = {}) {
	try {
		return await conformance(backend, probes);
	} catch (error) {
		// A backend whose own function THREW is a conformance failure, not a harness crash. An adapter
		// author running this for the first time is the person most likely to hit it, and they need the
		// message rather than a stack trace from someone else's code.
		return { ok: false, findings: [fail("harness", `a backend function threw while being driven: ${error?.message ?? error}`)] };
	}
}

async function conformance(backend, probes) {
	const findings = [
		...checkShape(backend),
		...checkDeclaration(backend),
		...checkTransfers(backend),
	];
	// A bundle that is missing a function cannot be DRIVEN, and a harness that threw here would be useless
	// in exactly the case it exists for: an adapter author's first run, against a bundle they have not
	// finished. The shape findings above already name what is missing.
	const drivable = ["runContainer", "stopContainer", "reap"].every((fn) => typeof backend?.[fn] === "function");
	if (typeof probes.probe === "function" && drivable) {
		findings.push(...(await checkExitCodes(backend, probes)));
		findings.push(...(await checkAbortFlag(backend, probes)));
	} else if (!drivable) {
		findings.push(abstain("exitCodes", "the bundle is incomplete, so nothing could be driven to an exit"));
		findings.push(abstain("abortable", "the bundle is incomplete, so an abort could not be told from an OOM"));
	} else {
		findings.push(abstain("exitCodes", "no `probe` supplied, so no container was driven to an exit"));
		findings.push(abstain("abortable", "no `probe` supplied, so an abort could not be told from an OOM"));
	}
	findings.push(...(await checkReaperTriState(backend, probes)));
	findings.push(...(await checkReadBack(backend, probes)));
	return { ok: findings.every((f) => f.ok), findings };
}

/**
 * The properties a LIVE PROBE reads back off a real container (issue #278), rather than this harness checking a
 * report or the declaration itself. For `local` that probe ships: `doctor --live` (`live-probes.mjs`). For any other
 * runtime the adapter supplies `readBack(backend)`, which must return the same verdicts -- `{ [property]: { ok,
 * warn?, detail } }`, or `live-probes.mjs`'s array of `{ property, ok, warn?, detail }` -- read off a container its
 * own `runContainer` path started. Like `probe`, a readBack that fabricates its answer passes while proving nothing.
 */
export const READ_BACK_BY_A_LIVE_PROBE = Object.freeze(["isolation", "mountSet", "egress", "imagePinning", "nonRoot", "localFolders"]);

/**
 * THE READ-BACK. Abstains without a report, and per property for anything the report does not cover or could not
 * read, because a property nobody read is not one that held. A property read back as NOT holding fails when the
 * backend declares it `enforced` or `asserted` -- both claim it is provided -- and passes against `absent`, which
 * claimed nothing.
 */
async function checkReadBack(backend, { readBack }) {
	if (typeof readBack !== "function") {
		return READ_BACK_BY_A_LIVE_PROBE.map((property) => abstain(property, "no `readBack` probe supplied, so it was not read off a live container (doctor --live reads local's)"));
	}
	const raw = await readBack(backend);
	// OWN properties only, and a property named twice in an array is ambiguous rather than last-wins: a report that
	// says a property both fails and holds must not be read as holding.
	const report = Object.create(null);
	const repeated = new Set();
	if (Array.isArray(raw)) {
		for (const v of raw) {
			const property = v?.property;
			if (typeof property !== "string") continue;
			if (Object.hasOwn(report, property)) repeated.add(property);
			report[property] = v;
		}
	} else if (raw && typeof raw === "object") {
		for (const property of Object.keys(raw)) report[property] = raw[property];
	}
	const declares = backend?.declares ?? {};
	return READ_BACK_BY_A_LIVE_PROBE.map((property) => {
		if (repeated.has(property)) return abstain(property, "the readBack report names it more than once, so which reading holds is not known");
		const got = Object.hasOwn(report, property) ? report[property] : undefined;
		if (!got || typeof got.ok !== "boolean") return abstain(property, "the readBack report does not cover it");
		// `warn` first: a reading marked not-read-back is never a pass, whatever its `ok` says.
		if (got.warn === true) return abstain(property, `${got.detail ?? "not read back"}`);
		if (got.ok === true) return pass(property, `read back off a live container: ${got.detail ?? "holds"}`);
		if (declares[property] === "enforced" || declares[property] === "asserted") {
			return fail(property, `declared ${declares[property]}, and read back off a live container as not holding: ${got.detail ?? "no detail"}`);
		}
		return pass(property, `read back as not holding, which ${JSON.stringify(declares[property])} does not claim`);
	});
}

/**
 * The properties NEITHER this harness NOR a live read-back verifies, and why -- printed alongside the findings so a
 * green run is never mistaken for a conformant backend.
 *
 * Six of the ten that once stood here are now READ_BACK_BY_A_LIVE_PROBE (issue #278). Two of these four are
 * container properties a probe COULD read and none was built for; the other two are not container properties at
 * all, so no container read can reach them.
 */
export const UNVERIFIED_BY_THIS_HARNESS = Object.freeze({
	ephemeral: "a probe could, and none was built: two runs of the same job id and a check that no container survived the first",
	jobToJobIsolation: "a probe could, and none was built: two live containers and an attempted connection between them",
	secretsCustody: "not a container property: needs a canary secret and an audit of every log, record and forge comment the run produced",
	credentialTransit: "not a container property: what crossed the network to the runtime; local's is observed per job from the docker CLI's endpoint instead",
});
