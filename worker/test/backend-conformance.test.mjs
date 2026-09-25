import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { READ_BACK_BY_A_LIVE_PROBE, UNVERIFIED_BY_THIS_HARNESS, runBackendConformance } from "../src/backend-conformance.mjs";
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
	// Two of the thirteen properties are reached by neither this harness nor a live read-back (issue #344 moved
	// ephemeral and jobToJobIsolation to the read-back). Listing them, with why, is what stops the suite overclaiming.
	assert.deepEqual(Object.keys(UNVERIFIED_BY_THIS_HARNESS), ["secretsCustody", "credentialTransit"]);
	assert.deepEqual([...READ_BACK_BY_A_LIVE_PROBE], ["isolation", "ephemeral", "mountSet", "egress", "jobToJobIsolation", "imagePinning", "nonRoot", "localFolders"], "the read-back list in PROPERTY_NAMES order, pinned literally");
	for (const property of Object.keys(UNVERIFIED_BY_THIS_HARNESS)) {
		assert.ok(PROPERTY_NAMES.includes(property), `${property} must be a real property`);
		assert.ok(UNVERIFIED_BY_THIS_HARNESS[property].length > 20, `${property} must say WHY it is unreachable`);
	}
	// Three lists, PAIRWISE DISJOINT and together covering all thirteen (issue #278): checked here, read back off a
	// live container, or named as unverified. A property in two is double-counted; one in none is one nobody is
	// thinking about.
	const checked = ["exitCodes", "abortable", "readOnlyJobInputs"];
	const lists = [checked, [...READ_BACK_BY_A_LIVE_PROBE], Object.keys(UNVERIFIED_BY_THIS_HARNESS)];
	for (let i = 0; i < lists.length; i++) {
		for (let j = i + 1; j < lists.length; j++) {
			assert.deepEqual(lists[i].filter((p) => lists[j].includes(p)), [], `lists ${i} and ${j} overlap`);
		}
	}
	assert.deepEqual(lists.flat().sort(), [...PROPERTY_NAMES].sort());
	for (const property of READ_BACK_BY_A_LIVE_PROBE) assert.ok(PROPERTY_NAMES.includes(property));
});

test("a readBack report is read per property: held passes, unread abstains, a failed read of a claimed word fails (#278)", async () => {
	const base = { probe: honestProbe, withBrokenEnumeration: async () => ({ reaped: false }) };
	const holds = Object.fromEntries(READ_BACK_BY_A_LIVE_PROBE.map((p) => [p, { ok: true, detail: "held" }]));
	const honest = await runBackendConformance(referenceBackend(), { ...base, readBack: async () => holds });
	assert.equal(honest.ok, true);
	for (const p of READ_BACK_BY_A_LIVE_PROBE) assert.equal(findings(honest, p)[0].unverifiable, undefined, `${p} was read back, not abstained`);

	// DISHONEST: local declares isolation enforced and nonRoot asserted; a read-back saying neither holds fails both.
	const dishonest = await runBackendConformance(referenceBackend(), { ...base, readBack: async () => ({ ...holds, isolation: { ok: false, detail: "CapBnd a80425fb" }, nonRoot: { ok: false, detail: "Uid 0" } }) });
	assert.equal(dishonest.ok, false);
	assert.deepEqual(failed(dishonest).sort(), ["isolation", "nonRoot"]);

	// An array of live-probes verdicts is accepted as it is, and a property it does not cover abstains.
	const partial = await runBackendConformance(referenceBackend(), { ...base, readBack: async () => [{ property: "mountSet", ok: true, detail: "x" }, { property: "egress", ok: false, warn: true, detail: "not read back: off" }] });
	assert.equal(partial.ok, true);
	assert.equal(findings(partial, "mountSet")[0].unverifiable, undefined);
	assert.equal(findings(partial, "egress")[0].unverifiable, true, "not read back is an abstention, never a pass");
	assert.equal(findings(partial, "isolation")[0].unverifiable, true, "a property the report omits abstains");

	// ABSENT readBack: every one abstains, and the run does not fail for it.
	const absent = await runBackendConformance(referenceBackend(), base);
	assert.equal(absent.ok, true);
	for (const p of READ_BACK_BY_A_LIVE_PROBE) assert.equal(findings(absent, p)[0].unverifiable, true, p);
});

test("a readBack report cannot pass what it did not read: warn beats ok, a repeated property never passes, inherited keys do not count (#278)", async () => {
	const base = { probe: honestProbe, withBrokenEnumeration: async () => ({ reaped: false }) };
	const warned = await runBackendConformance(referenceBackend(), { ...base, readBack: async () => ({ isolation: { ok: true, warn: true, detail: "not read back: cgroup v1" } }) });
	assert.equal(findings(warned, "isolation")[0].unverifiable, true, "a reading marked not-read-back is never a pass");
	const repeated = await runBackendConformance(referenceBackend(), { ...base, readBack: async () => [{ property: "isolation", ok: false, detail: "CapBnd a80425fb" }, { property: "isolation", ok: true, detail: "fine" }] });
	assert.equal(findings(repeated, "isolation")[0].ok, false, "a failure cannot be overwritten by a later pass");
	assert.match(findings(repeated, "isolation")[0].detail, /more than once/);
	const inherited = await runBackendConformance(referenceBackend(), { ...base, readBack: async () => Object.create({ nonRoot: { ok: true, detail: "from the prototype" } }) });
	assert.equal(findings(inherited, "nonRoot")[0].unverifiable, true, "only the report's own properties are read");
	// Ambiguity is not in the backend's favour: a failing reading among repeats still fails a claimed property.
	for (const readings of [[{ ok: false }, { ok: false }], [{ ok: true }, { ok: false }]]) {
		const r = await runBackendConformance(referenceBackend(), { ...base, readBack: async () => readings.map((v) => ({ property: "isolation", detail: "x", ...v })) });
		assert.equal(findings(r, "isolation")[0].ok, false, JSON.stringify(readings));
	}
	// Otherwise a repeat abstains: never a pass, and never a failure of a word that claims nothing, or of a reading
	// that was not read back.
	const abstaining = [
		[[{ ok: true }, { ok: true }], "local"],
		[[{ ok: true }, { ok: true, warn: true }], "local"],
		[[{ ok: false, warn: true }, { ok: true }], "local"],
		[[{ ok: false }, { ok: false }], "absent"],
	];
	for (const [readings, declared] of abstaining) {
		const backend = declared === "absent" ? referenceBackend({ declares: { ...BACKENDS.local.declares, isolation: "absent" } }) : referenceBackend();
		const r = await runBackendConformance(backend, { ...base, readBack: async () => readings.map((v) => ({ property: "isolation", detail: "x", ...v })) });
		assert.equal(findings(r, "isolation")[0].unverifiable, true, `${JSON.stringify(readings)} against ${declared}`);
	}
	const inheritedFail = await runBackendConformance(referenceBackend(), { ...base, readBack: async () => [{ property: "isolation", ok: true }, Object.assign(Object.create({ ok: false }), { property: "isolation" })] });
	assert.equal(findings(inheritedFail, "isolation")[0].unverifiable, true, "an inherited ok:false is not a failing reading either");
	const truthyWarn = await runBackendConformance(referenceBackend(), { ...base, readBack: async () => ({ isolation: { ok: true, warn: 1, detail: "not read back" } }) });
	assert.equal(findings(truthyWarn, "isolation")[0].unverifiable, true, "any truthy warn is not read back");
	const inheritedOk = await runBackendConformance(referenceBackend(), { ...base, readBack: async () => ({ isolation: Object.create({ ok: true }) }) });
	assert.equal(findings(inheritedOk, "isolation")[0].unverifiable, true, "a reading's own ok, not its prototype's");
});

test("a read-back that does not hold passes against a backend that declares the property absent", async () => {
	const absentIsolation = { ...BACKENDS.local.declares, isolation: "absent" };
	const r = await runBackendConformance(referenceBackend({ declares: absentIsolation }), { readBack: async () => ({ isolation: { ok: false, detail: "CapBnd a80425fb" } }) });
	const f = findings(r, "isolation")[0];
	assert.equal(f.ok, true);
	assert.match(f.detail, /does not claim/);
});

// Issue #354: the REAL podman bundle, built by `makePodmanBackend` from the shipped factories, driven through the harness
// with a fake `podman` child in place of the CLI. It imports run-container, which imports pi-ai, so it skips below the
// node floor as run-container's own tests do (and CI, requiring worker tests, runs it).
let podman;
let podmanImportError;
try {
	podman = await import("../src/backend-podman.mjs");
} catch (error) {
	podmanImportError = error;
}
if (!podman && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`the podman conformance test is REQUIRED here but backend-podman could not import.\n${podmanImportError}`);
}
const podmanSkip = podman ? false : `backend-podman could not import (${podmanImportError?.message ?? "unknown"}); CI runs this`;

/**
 * A fake `podman`: every spawn is recorded; `run` exits with whatever the probe set and, for a worker stop, aborts the
 * job's signal first (the stop landing while the container runs); `ps` and `network ls` answer empty, or `ps` fails when
 * the enumeration is to be broken.
 */
function fakePodmanCli({ brokenPs = false } = {}) {
	const state = { calls: [], exit: 0, abort: null };
	const spawnFn = (cmd, args) => {
		state.calls.push([cmd, ...args]);
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.kill = () => {};
		const code = args[0] === "run" ? state.exit : args[0] === "ps" && brokenPs ? 125 : 0;
		queueMicrotask(() => {
			if (args[0] === "run" && state.abort) state.abort();
			child.emit("close", code);
		});
		return child;
	};
	return { state, spawnFn };
}

function realPodmanBundle(fake) {
	return podman.makePodmanBackend({
		image: "pi-job:x",
		hostEnv: { ANTHROPIC_API_KEY: "sk-real" },
		onOutput: () => {},
		readInfo: async () => ({ answered: false, reason: "not-asked", transient: true }),
		platform: "linux",
		euid: 1234,
		egid: 1234,
		home: "/home/op",
		env: {},
		spawnFn: fake.spawnFn,
	});
}

test("the REAL podman bundle passes the harness's shape, declaration, exit, abort and reaper checks with a fake podman (#354)", { skip: podmanSkip }, async () => {
	const fake = fakePodmanCli();
	const backend = realPodmanBundle(fake);
	// The probe drives the bundle's OWN runContainer (the real makeRunContainer, podman argv and all) to the exit the
	// harness asks for; a worker stop is the signal aborted while the container runs, as index.mjs's onAbort does.
	const probe = async (b, { exitCode, aborted = false }) => {
		const ac = new AbortController();
		fake.state.exit = exitCode;
		fake.state.abort = aborted ? () => ac.abort() : null;
		return b.runContainer({ job: { id: "j1", kind: "local", provider: "anthropic", model: "m", maxTurns: 5 }, prepared: { workspace: "/host/folder", jobDir: "/host/jobs/j1" }, name: "pi-job-j1", signal: ac.signal, user: "1234:1234", home: "/home/pi" });
	};
	const withBrokenEnumeration = async () => realPodmanBundle(fakePodmanCli({ brokenPs: true })).reap();
	const r = await runBackendConformance(backend, { probe, withBrokenEnumeration });
	assert.equal(r.ok, true, `podman failed: ${JSON.stringify(r.findings.filter((f) => !f.ok))}`);
	for (const check of ["shape", "declaration", "readOnlyJobInputs", "exitCodes", "abortable", "reap"]) {
		assert.ok(findings(r, check).length > 0 && findings(r, check).every((f) => f.ok && !f.unverifiable), check);
	}
	// And it was podman that ran, every time, keep-id as the worker's uid.
	const runs = fake.state.calls.filter((c) => c[1] === "run");
	assert.equal(runs.length, 8, "six exit codes and two 137s");
	for (const call of fake.state.calls) assert.equal(call[0], "podman", call.join(" "));
	for (const run of runs) assert.ok(run.includes("--userns=keep-id") && run.includes("--user=1234:1234"));
	// The read-back is the live conformance script's (a real container); offline, all eight abstain rather than pass.
	for (const property of READ_BACK_BY_A_LIVE_PROBE) assert.equal(findings(r, property)[0].unverifiable, true, property);
});
