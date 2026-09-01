import assert from "node:assert/strict";
import { test } from "node:test";
import { UNVERIFIED_BY_THIS_HARNESS, runBackendConformance } from "../src/backend-conformance.mjs";
import { makeLocalBackend } from "../src/backend-local.mjs";
import { BACKENDS, PROPERTY_NAMES } from "../src/backends.mjs";

/**
 * The REFERENCE ADAPTER: a backend that exists only to be driven through the harness.
 *
 * No vendor adapter ships in this repo -- none can be exercised in offline CI, and this project has twice
 * refused to bless one. So the second thing the harness runs against is a fake whose behaviour is a
 * parameter, which is what lets every REFUSAL path be tested. A harness only ever run against a conformant
 * backend proves that it says yes, not that it can say no.
 */
function referenceBackend(over = {}) {
	const local = makeLocalBackend({
		runContainer: async () => ({ code: 0, aborted: false }),
		imagePreflight: async () => ({}),
		egressPreflight: async () => ({ ok: true }),
		stopContainer: async () => {},
		reap: async () => ({ reaped: true }),
	});
	return { ...local, ...over };
}

/** A probe that reports back exactly what it was asked to produce -- an honest runtime. */
const honestProbe = async (_backend, { exitCode, aborted = false }) => ({ code: exitCode, aborted });

const findings = (r, check) => r.findings.filter((f) => f.check === check);
const failed = (r) => r.findings.filter((f) => !f.ok).map((f) => f.check);

test("the local backend PASSES its own conformance suite", async () => {
	// The floor: if the shipped backend cannot pass, the contract is describing something that does not
	// exist. It is also the only backend this repo can drive end to end.
	const r = await runBackendConformance(referenceBackend(), {
		probe: honestProbe,
		withBrokenEnumeration: async () => ({ reaped: false }),
	});
	assert.equal(r.ok, true, `local failed: ${JSON.stringify(failed(r))}`);
});

test("a backend that CLAMPS an exit code is caught", async () => {
	// Every retry decision reads this integer: 0 completed, 1 infra (retry), 2 policy (no retry). A backend
	// that normalised non-zero to 1 would turn a determinate policy refusal into a paid retry loop.
	const r = await runBackendConformance(referenceBackend(), {
		probe: async (_b, { exitCode, aborted = false }) => ({ code: exitCode === 0 ? 0 : 1, aborted }),
		withBrokenEnumeration: async () => ({ reaped: false }),
	});
	assert.equal(r.ok, false);
	assert.match(findings(r, "exitCodes")[0].detail, /arrived as 1/);
});

test("a backend that reports only the exit code, and not the abort FLAG, is caught", async () => {
	// The single most transferable clause in the contract and the easiest to drop: a worker SIGKILL and a
	// kernel OOM both surface as 137, so the code alone cannot say which happened. Without the flag a hung
	// job retries forever and an OOM looks like a deliberate stop.
	const r = await runBackendConformance(referenceBackend(), {
		probe: async (_b, { exitCode }) => ({ code: exitCode }), // no `aborted` at all
		withBrokenEnumeration: async () => ({ reaped: false }),
	});
	assert.equal(r.ok, false);
	assert.match(findings(r, "abortable")[0].detail, /cannot be told from a kernel OOM/);
});

test("a backend that reports an ORDINARY 137 as an abort is caught too", async () => {
	// The other direction, and the one that costs money the other way: an OOM classified as a deliberate
	// stop is a POLICY outcome, so it is never retried and the work is silently dropped.
	const r = await runBackendConformance(referenceBackend(), {
		probe: async (_b, { exitCode }) => ({ code: exitCode, aborted: true }),
		withBrokenEnumeration: async () => ({ reaped: false }),
	});
	assert.equal(r.ok, false);
	assert.match(findings(r, "abortable")[0].detail, /classified as a deliberate stop and never retried/);
});

test("a reaper that returns TRUE after a failed enumeration is caught", async () => {
	// The specific bug `fleet-lease.mjs` defends a money decision against: an empty list and an unanswerable
	// question look identical, so a backend returning `[]` on a failed listing reports the host as proven
	// clean and the scope sweep frees slots for containers that may still be running.
	const r = await runBackendConformance(referenceBackend(), {
		probe: honestProbe,
		withBrokenEnumeration: async () => ({ reaped: true }),
	});
	assert.equal(r.ok, false);
	assert.match(findings(r, "reap")[0].detail, /frees slots for containers that may still be running/);
});

test("a COPYING backend that declares readOnlyJobInputs enforced is caught", async () => {
	// The transfer contract's teeth, and the consumer container-spec.mjs was written for.
	// DES-JOB-FILES-VIA-VOLUME-SUBPATH: `docker cp` "cannot give /job a kernel-enforced read-only mount,
	// which INT-CONTAINER-JOB-INPUTS depends on". Declaring it enforced anyway is the believed-in control.
	const copier = referenceBackend({ binds: false });
	const r = await runBackendConformance(copier, { probe: honestProbe, withBrokenEnumeration: async () => ({ reaped: false }) });
	assert.equal(r.ok, false);
	assert.match(findings(r, "readOnlyJobInputs")[0].detail, /read-only by convention rather than by the kernel/);
});

test("a copying backend cannot borrow a BINDING backend's declaration, and the two checks say so together", async () => {
	// The point is not that copying is forbidden; it is that a copy has to SAY it is a copy, and that its
	// declaration has to be ITS OWN. These two checks look like they conflict and do not: `checkTransfers`
	// refuses a copying backend that declares `readOnlyJobInputs: enforced`, while `checkShape` refuses a
	// declaration that differs from the table's. For a venue with its own BACKENDS_TABLE entry -- which
	// `docs/backends.md` makes step 1 for exactly this reason -- both are satisfied at once: the entry says
	// `asserted` and the bundle reads it. For a bundle borrowing `local`'s name they cannot both be, and
	// that is correct rather than a contradiction: this backend is not local.
	//
	// An earlier version of this test was named "...declares the truth PASSES" and asserted only that
	// `readOnlyJobInputs` had no failures. It went GREEN while the run it described was RED on two other
	// checks -- a false green of exactly the kind this whole feature is about.
	const borrowed = referenceBackend({
		binds: false,
		declares: { ...BACKENDS.local.declares, readOnlyJobInputs: "asserted" },
		name: "local",
	});
	const r = await runBackendConformance(borrowed, { probe: honestProbe, withBrokenEnumeration: async () => ({ reaped: false }) });
	assert.equal(r.ok, false, "borrowing local's name while declaring something else is refused");
	assert.ok(findings(r, "shape").some((f) => !f.ok && f.detail.includes("readOnlyJobInputs")), "the drift is named");
	// And the transfer check is SATISFIED, which is the half that shows the two rules are compatible: a
	// copy declaring `asserted` is exactly what the downgrade requires.
	assert.deepEqual(findings(r, "readOnlyJobInputs").filter((f) => !f.ok), [], "declaring asserted is what a copy must do");
});

test("a neverStartedExits that claims a code the protocol already means is caught", async () => {
	// Declaring 137 would make every kernel OOM a refunded "never started": the container DID run, spent
	// its slot, and the refund hands it back. 0/1/2 are the runner's own completed/infra/policy codes, so
	// claiming one of those turns a real outcome into an infra retry that never resolves.
	for (const code of [0, 1, 2, 137]) {
		const b = referenceBackend({ neverStartedExits: [code] });
		const r = await runBackendConformance(b, { probe: honestProbe, withBrokenEnumeration: async () => ({ reaped: false }) });
		assert.equal(r.ok, false, `${code} must not be claimable as never-started`);
		assert.ok(findings(r, "shape").some((f) => !f.ok && f.detail.includes("neverStartedExits")), String(code));
	}
	// Docker's own triple is fine, and so is an empty set (an adapter that normalises itself).
	for (const set of [[125, 126, 127], []]) {
		const r = await runBackendConformance(referenceBackend({ neverStartedExits: set }), { probe: honestProbe, withBrokenEnumeration: async () => ({ reaped: false }) });
		assert.deepEqual(failed(r), [], JSON.stringify(set));
	}
});

test("a bundle whose NAME has no table entry is caught", async () => {
	// The registry keys on `name` and the table keys on the same string, so a mismatch silently hands the
	// adapter a different backend's declaration -- or none at all.
	const r = await runBackendConformance(referenceBackend({ name: "vapour" }), { probe: honestProbe, withBrokenEnumeration: async () => ({ reaped: false }) });
	assert.equal(r.ok, false);
	assert.ok(failed(r).includes("shape"));
});

test("a bundle missing a function, or an exit set, is caught", async () => {
	for (const missing of ["runContainer", "imagePreflight", "egressPreflight", "stopContainer", "reap"]) {
		const b = referenceBackend();
		delete b[missing];
		const r = await runBackendConformance(b, { probe: honestProbe, withBrokenEnumeration: async () => ({ reaped: false }) });
		assert.equal(r.ok, false, missing);
		assert.ok(
			findings(r, "shape").some((f) => !f.ok && f.detail.includes(missing)),
			missing,
		);
	}
	const noExits = referenceBackend({ neverStartedExits: undefined });
	assert.equal((await runBackendConformance(noExits, { probe: honestProbe, withBrokenEnumeration: async () => ({ reaped: false }) })).ok, false);
});

test("a declaration outside the vocabulary or the closed list is caught", async () => {
	const typo = referenceBackend({ declares: { ...BACKENDS.local.declares, egress: "enfroced" } });
	const r1 = await runBackendConformance(typo, { probe: honestProbe, withBrokenEnumeration: async () => ({ reaped: false }) });
	assert.equal(r1.ok, false);
	assert.match(findings(r1, "declaration")[0].detail, /not one of enforced\/asserted\/absent/);

	const extra = referenceBackend({ declares: { ...BACKENDS.local.declares, madeUp: "enforced" } });
	const r2 = await runBackendConformance(extra, { probe: honestProbe, withBrokenEnumeration: async () => ({ reaped: false }) });
	assert.equal(r2.ok, false);
	assert.match(
		findings(r2, "declaration").find((f) => !f.ok).detail,
		/not a property of the closed list/,
	);
});

test("an ASSERTED property that names no asserter is caught", async () => {
	// "not us" without "them" leaves an operator nothing to go and check, which is the whole reason doctor
	// prints the asserter beside the word.
	const anon = referenceBackend({ name: "local", declares: { ...BACKENDS.local.declares, isolation: "asserted" } });
	const r = await runBackendConformance(anon, { probe: honestProbe, withBrokenEnumeration: async () => ({ reaped: false }) });
	assert.equal(r.ok, false);
	assert.match(
		findings(r, "declaration").find((f) => !f.ok).detail,
		/nothing names WHO asserts it/,
	);
});

test("a backend that does not say HOW it moves files abstains, rather than being credited with a bind", async () => {
	// The fail-open this replaced: `binds !== false` treated silence as "bind-mounts", so a copying adapter
	// that never set the field got a positive assertion about a property nothing had examined. That is the
	// believed-in control, produced by the harness written to prevent it. Abstention rather than failure,
	// because not saying is a documentation gap rather than a false claim.
	const quiet = referenceBackend({ binds: undefined });
	const r = await runBackendConformance(quiet, { probe: honestProbe, withBrokenEnumeration: async () => ({ reaped: false }) });
	const f = findings(r, "readOnlyJobInputs")[0];
	assert.equal(f.unverifiable, true, "silence must not read as a bind");
	assert.match(f.detail, /does not declare `binds`/);
});

test("a bundle without containerName is caught, because the REGISTRY calls it", async () => {
	// It built at boot and threw at the first pickup -- the exact property the registry claims to have --
	// and the harness gave the same bundle a full green run while its own pass text said "five functions".
	const b = referenceBackend();
	delete b.containerName;
	const r = await runBackendConformance(b, { probe: honestProbe, withBrokenEnumeration: async () => ({ reaped: false }) });
	assert.equal(r.ok, false);
	assert.ok(findings(r, "shape").some((f) => !f.ok && f.detail.includes("containerName")));
});

test("a FAITHFUL COPY of the table's declaration is accepted, so checkDeclaration is reachable at all", async () => {
	// Comparing `declares` by REFERENCE refused a copy an out-of-repo adapter cannot avoid producing, and it
	// made the declaration gate dead: every bundle that passed shape held the table's own frozen words, so
	// that gate could only ever restate a shape failure. What matters is that the words AGREE.
	const copy = referenceBackend({ declares: { ...BACKENDS.local.declares } });
	const r = await runBackendConformance(copy, { probe: honestProbe, withBrokenEnumeration: async () => ({ reaped: false }) });
	assert.deepEqual(failed(r), [], "a word-for-word copy is not drift");
	// And a genuine disagreement still fails, naming the property.
	const drifted = referenceBackend({ declares: { ...BACKENDS.local.declares, egress: "absent" } });
	const r2 = await runBackendConformance(drifted, { probe: honestProbe, withBrokenEnumeration: async () => ({ reaped: false }) });
	assert.equal(r2.ok, false);
	assert.ok(findings(r2, "shape").some((f) => !f.ok && f.detail.includes("egress")));
});

test("a run with no probes ABSTAINS rather than passing the checks it could not make", async () => {
	// The difference between a suite that is honest about its reach and one that lets a green tick stand
	// for something it never checked. `OQ-012`'s line: a check that proves intent is not one that proves
	// conformance, and the difference has to be stated rather than blurred.
	const r = await runBackendConformance(referenceBackend());
	assert.equal(r.ok, true, "abstention is not failure");
	for (const check of ["exitCodes", "abortable", "reap"]) {
		assert.equal(findings(r, check)[0].unverifiable, true, check);
	}
});

test("the harness NAMES what it cannot verify, so a green run is not mistaken for a conformant backend", () => {
	// Ten of the thirteen properties need a live container on the target runtime, which offline CI cannot
	// have. Listing them is what stops the suite overclaiming.
	for (const property of Object.keys(UNVERIFIED_BY_THIS_HARNESS)) {
		assert.ok(PROPERTY_NAMES.includes(property), `${property} must be a real property`);
		assert.ok(UNVERIFIED_BY_THIS_HARNESS[property].length > 20, `${property} must say WHY it is unreachable`);
	}
	// And every property is accounted for: either the harness checks it, or it says why it cannot.
	const checked = ["exitCodes", "abortable", "reap", "readOnlyJobInputs"];
	for (const property of PROPERTY_NAMES) {
		assert.ok(
			checked.includes(property) || property in UNVERIFIED_BY_THIS_HARNESS,
			`${property} is neither checked nor declared unverifiable -- a property in neither list is one nobody is thinking about`,
		);
	}
});
