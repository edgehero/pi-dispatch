import assert from "node:assert/strict";
import { test } from "node:test";
import { BACKEND_NAMES, BACKENDS, DEFAULT_BACKEND, OPENSHELL_BACKEND, OPENSHELL_BIND_BACKEND, PODMAN_BACKEND, SERVES, SERVES_WORDS, servesOf } from "../src/backends.mjs";
import { makeLocalBackend } from "../src/backend-local.mjs";
import { SANDBOX_LAUNCHERS } from "../src/sandbox.mjs";
import { recoverVenueProblem } from "../src/triggers.mjs";

/**
 * Issue #712: each venue's `serves` block is a hand-written table that RESTATES derivable sources, so it is held to them
 * here (CLAUDE.md, "derived or pinned, never trusted"): the bundle's own `binds`, the `transcript` its runContainer is
 * built with, `SANDBOX_LAUNCHERS`, and the copy mode's pre-spend recovery refusal. The console and the panel word these
 * facts from the table, so a venue whose bundle changed and whose table did not would put a wrong sentence on both.
 *
 * The podman and openshell adapters import pi's model loader, so they are imported dynamically, as their own test files
 * do, and the halves that need them skip where pi is not installed (CI runs them).
 */
let podman = null;
let openshell = null;
let importError;
try {
	podman = await import("../src/backend-podman.mjs");
	openshell = await import("../src/backend-openshell.mjs");
} catch (error) {
	importError = error;
}
if ((!podman || !openshell) && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error(`a backend adapter could not import.\n${importError}`);
const skip = podman && openshell ? false : `a backend adapter could not import (${importError?.message ?? "unknown"}); CI runs this`;

const localParts = () => ({ runContainer: async () => ({}), imagePreflight: async () => ({}), egressPreflight: async () => ({}), stopContainer: async () => {}, reap: async () => ({ reaped: true }) });

/** Each venue's bundle and the options its runContainer was built with (null for local, whose runContainer is passed in). */
function bundles() {
	const out = { [DEFAULT_BACKEND]: { bundle: makeLocalBackend(localParts()), made: null } };
	let made = null;
	const p = podman.makePodmanBackend({ image: "pi-job:x", readInfo: async () => ({ answered: false }), platform: "linux", euid: 1234, egid: 1234, fs: {}, home: "/home/op", env: {}, onOutput: () => {}, log: () => {}, makeRunContainer: (o) => ((made = o), async () => ({ code: 0 })) });
	out[PODMAN_BACKEND] = { bundle: p, made };
	for (const [venue, mode] of [
		[OPENSHELL_BACKEND, "copy"],
		[OPENSHELL_BIND_BACKEND, "bind"],
	]) {
		let built = null;
		const b = openshell.makeOpenshellBackend({ mode, image: "pi-job:x", hostEnv: {}, onOutput: () => {}, exec: async () => ({ code: 0, stdout: "", stderr: "" }), spawnFn: () => {
			throw new Error("no spawn in this test");
		}, platform: "linux", readLsm: () => "landlock", log: () => {}, makeRunContainer: (o) => ((built = o), async () => ({ code: 0 })) });
		out[venue] = { bundle: b, made: built };
	}
	return out;
}

test("every venue declares every serves entry, in the closed words, and the block is frozen (#712)", () => {
	for (const name of BACKEND_NAMES) {
		assert.deepEqual(Object.keys(BACKENDS[name].serves).sort(), [...SERVES].sort(), name);
		for (const key of SERVES) assert.ok(SERVES_WORDS.includes(BACKENDS[name].serves[key]), `${name}.${key}`);
		assert.equal(Object.isFrozen(BACKENDS[name].serves), true, name);
		assert.equal(servesOf(name), BACKENDS[name].serves, name);
	}
	assert.equal(servesOf("toString"), null);
	assert.equal(servesOf(undefined), null);
});

test("serves.sandboxShell is yes exactly where SANDBOX_LAUNCHERS has a row (#712)", () => {
	for (const name of BACKEND_NAMES) assert.equal(BACKENDS[name].serves.sandboxShell, Object.hasOwn(SANDBOX_LAUNCHERS, name) ? "yes" : "no", name);
});

test("serves.liveTranscript and serves.steering follow each bundle's binds and transcript (#712)", { skip }, () => {
	const all = bundles();
	assert.deepEqual(Object.keys(all).sort(), [...BACKEND_NAMES].sort(), "a venue added to the table must be built here too");
	for (const [name, { bundle, made }] of Object.entries(all)) {
		// `transcript: "stdio"` is the copying venue's stderr mirror, which needs the image's `transcriptStderr`; any other
		// value (or none: makeRunContainer's default) is a host file the tail reads.
		const stdio = made?.transcript === "stdio";
		assert.equal(BACKENDS[name].serves.liveTranscript, stdio ? "image" : "yes", `${name}.liveTranscript`);
		// A binding venue steers through the `/inbox` mount; a copying one only over stdin frames, which needs `steerStdin`.
		assert.equal(BACKENDS[name].serves.steering, bundle.binds === true ? "yes" : "image", `${name}.steering`);
	}
});

test("serves.recovery is no exactly where the venue's preflight refuses a job FOR arming run.recover, and the loader refuses that pairing (#712)", { skip }, async () => {
	const all = bundles();
	const job = (recover) => ({ id: "j1", kind: "github", provider: "anthropic", model: "m", ...(recover ? { recover: true } : {}) });
	for (const [name, { bundle }] of Object.entries(all)) {
		// A venue with no per-job preflight has nothing that could refuse recovery there; every other one is ASKED, and a
		// throw fails the test rather than reading as "admitted". The flag's own effect is what is judged: the same job
		// without `recover` is the baseline, so a refusal for any other reason (a gateway the fake does not answer) is
		// not mistaken for a recovery refusal, and any recovery refusal counts, whatever its reason word.
		let refusesRecover = false;
		if (typeof bundle.observationPreflight === "function") {
			const armed = await bundle.observationPreflight(job(true));
			const plain = await bundle.observationPreflight(job(false));
			const reason = (r) => r?.venueRefused?.reason ?? null;
			refusesRecover = reason(armed) !== null && reason(armed) !== reason(plain);
		} else assert.equal(name, DEFAULT_BACKEND, `${name}: every venue but local has a per-job preflight to ask`);
		assert.equal(BACKENDS[name].serves.recovery, refusesRecover ? "no" : "yes", `${name}.recovery`);
		assert.equal(recoverVenueProblem(name) !== null, refusesRecover, name);
	}
});

test("docs/backends.md's serves table is the table's, row for row (#712)", async () => {
	const { readFileSync } = await import("node:fs");
	const doc = readFileSync(new URL("../../docs/backends.md", import.meta.url), "utf8");
	const at = doc.indexOf("| Venue | Live transcript | Steering | Recovery | Sandbox shell |");
	assert.ok(at !== -1, "the table is there");
	const rows = doc
		.slice(at)
		.split("\n")
		.slice(2)
		.filter((l, i, all) => l.startsWith("|") && all.slice(0, i).every((p) => p.startsWith("|")))
		.map((l) => l.split("|").slice(1, -1).map((c) => c.trim().replace(/`/g, "")));
	assert.deepEqual(
		rows,
		BACKEND_NAMES.map((name) => [name, ...SERVES.map((key) => BACKENDS[name].serves[key])]),
		"every venue, in table order, with its words",
	);
});
