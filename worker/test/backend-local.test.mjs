import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { BACKEND_FUNCTIONS, JOB_NAME_PREFIX, jobContainerName, makeLocalBackend } from "../src/backend-local.mjs";
import { BACKENDS, DEFAULT_BACKEND } from "../src/backends.mjs";

const fns = () => ({ runContainer: async () => ({}), imagePreflight: async () => ({}), egressPreflight: async () => ({}) });

test("container-spec.mjs is a LEAF -- it imports nothing", () => {
	// Not in backends.test.mjs because it is a different module's property, and it is load-bearing from the
	// moment `packages.mjs` started importing CONTAINER_GLOBAL_PI_DIR from here: that comment's whole claim
	// is "this costs no cycle and no weight in the admin's bundle". docker-run.mjs, where the constant used
	// to live, has now GAINED an import, which is exactly the drift this pins against next time.
	const src = readFileSync(new URL("../src/container-spec.mjs", import.meta.url), "utf8");
	assert.equal(/^import\s/m.test(src), false, "container-spec.mjs must import nothing");
	assert.equal(/require\(/.test(src), false);
});

test("the namespace is one fact, and the producer builds names from it", () => {
	// Two boot sweeps in start.mjs match this as a SUBSTRING. A rename that landed in the producer and not
	// in the sweeps would leave every crashed worker's containers behind forever with both suites green.
	assert.equal(JOB_NAME_PREFIX, "pi-job-");
	assert.equal(jobContainerName("abc123"), "pi-job-abc123");
	assert.ok(jobContainerName("x").startsWith(JOB_NAME_PREFIX));
	// The sandbox names itself OUTSIDE this namespace on purpose, so a worker restart cannot tear down a
	// shell an operator is sitting in. A prefix that became a prefix of the sandbox's would silently break
	// that, and it is the one relationship between the two strings that matters.
	assert.equal("pi-sandbox-job1".startsWith(JOB_NAME_PREFIX), false);
});

test("a complete bundle carries the table's declaration, not its own", () => {
	const b = makeLocalBackend(fns());
	assert.equal(b.name, DEFAULT_BACKEND);
	assert.equal(b.declares, BACKENDS.local.declares, "read from the table, so it cannot drift from it");
	assert.equal(b.namePrefix, JOB_NAME_PREFIX);
	assert.equal(b.containerName("j"), "pi-job-j");
});

test("the declaration a bundle hands out cannot be rewritten through the bundle", () => {
	// The alias is deliberate and safe only because the table is frozen. Unfrozen, this assignment would
	// change what doctor, the boot refusal and the receiver are all told, process-wide and invisibly.
	const b = makeLocalBackend(fns());
	assert.throws(() => {
		b.declares.egress = "absent";
	}, TypeError);
	assert.equal(BACKENDS.local.declares.egress, "enforced");
});

test("an incomplete bundle is REFUSED, and the refusal names what is missing", () => {
	// A wiring mistake that would otherwise surface as `undefined is not a function` deep inside a paid job.
	for (const key of BACKEND_FUNCTIONS) {
		const parts = fns();
		delete parts[key];
		assert.throws(() => makeLocalBackend(parts), new RegExp(`missing ${key}`), key);
	}
	assert.throws(() => makeLocalBackend({}), /missing runContainer, imagePreflight, egressPreflight/);
	assert.throws(() => makeLocalBackend(), /missing runContainer/, "no argument at all is the same refusal, not a TypeError");
	assert.throws(() => makeLocalBackend(null), /missing runContainer/);
});

test("a non-callable member is refused even though the key is present", () => {
	for (const bad of ["hello", 42, null, {}, { call() {} }, [], true]) {
		const parts = { ...fns(), egressPreflight: bad };
		assert.throws(() => makeLocalBackend(parts), /missing egressPreflight/, JSON.stringify(bad));
	}
});

test("a DEFERRED member is refused by name, never silently dropped", () => {
	// An adapter author who supplies `stopContainer` has read the issue and expects it wired. Dropping it
	// would leave them believing a runaway job can be stopped through their backend while the abort path
	// still goes straight to the local docker CLI -- the believed-in control, arriving through an ignored
	// argument. The message says "not yet", which is a different instruction from "unknown".
	assert.throws(() => makeLocalBackend({ ...fns(), stopContainer: () => {} }), /stopContainer is not part of the bundle yet/);
	assert.throws(() => makeLocalBackend({ ...fns(), reap: () => {} }), /reap is not part of the bundle yet/);
	assert.throws(() => makeLocalBackend({ ...fns(), nonsense: 1 }), /unknown bundle member "nonsense"/);
});

test("the completeness check proves ARITY and is not credited with more", () => {
	// The comment used to claim it prevented a silently-absent egress gate. It cannot: an unarmed
	// makeEgressPreflight returns a function answering {ok:true} that spawns nothing, so a stub passes.
	// Pinned so the overclaim cannot come back in a later edit.
	const stub = makeLocalBackend({ ...fns(), egressPreflight: async () => ({ ok: true }) });
	assert.equal(typeof stub.egressPreflight, "function", "a gate that does no gating passes this check");
});

test("dockerExtra cannot carry a flag that would supersede the isolation boundary", async () => {
	// `dockerExtra` lands AFTER ISOLATION_FLAGS and docker resolves a repeated option last-wins, so
	// `--privileged` supersedes `--cap-drop=ALL` while every member of the array is still present in the
	// argv. The two standing assertions test MEMBERSHIP, and membership is not effectiveness -- so without
	// this guard `isolation: enforced` would be a claim about an argv that had no boundary left.
	const { DOCKER_EXTRA_FORBIDDEN, buildDockerRunArgs } = await import("../src/docker-run.mjs");
	const base = { image: "i", name: "n", workspace: "/w" };
	// IMPORTED, never re-typed: a hand-written parallel list is the two-literals drift that JOB_NAME_PREFIX
	// and CONTAINER_GLOBAL_PI_DIR are exported to avoid, and it would leave a new entry untested in silence.
	assert.ok(DOCKER_EXTRA_FORBIDDEN.length >= 20);
	for (const flag of DOCKER_EXTRA_FORBIDDEN) {
		// Bare, and as `--flag=value`, because docker accepts both spellings and `--rm=false` is the whole
		// reason `--rm` is on the list at all.
		assert.throws(() => buildDockerRunArgs({ ...base, extraFlags: [flag] }), /supersede the isolation boundary/, flag);
		assert.throws(() => buildDockerRunArgs({ ...base, extraFlags: [`${flag}=x`] }), /supersede the isolation boundary/, `${flag}=x`);
		assert.throws(() => buildDockerRunArgs({ ...base, extraFlags: ["-i", flag, "v"] }), /supersede the isolation boundary/, `mid-array ${flag}`);
	}
	// The four the re-verification proved supersede a real flag, named so a future edit cannot drop them.
	for (const flag of ["--rm", "--init", "--shm-size", "--name"]) {
		assert.ok(DOCKER_EXTRA_FORBIDDEN.includes(flag), `${flag} must stay denied`);
	}
	// A non-string is REFUSED, not skipped: skipping still pushed the value into the argv, so anything that
	// stringifies to a flag reached docker as that flag.
	for (const bad of [new String("--privileged"), { toString: () => "--privileged" }, 1, null]) {
		assert.throws(() => buildDockerRunArgs({ ...base, extraFlags: [bad] }), /must contain only strings/);
	}
	// What the sandbox actually passes stays allowed, or this guard would break the one caller there is.
	const ok = buildDockerRunArgs({ ...base, extraFlags: ["-i", "-t", "--entrypoint", "bash", "-p", "127.0.0.1:3000:3000"] });
	assert.ok(ok.includes("--entrypoint") && ok.includes("-p"));
	// And `--user` stays allowed on purpose: it is the documented Linux-only uid:gid for a bind-mounted
	// local folder, it changes which uid runs rather than what that uid may do, and the property it bears
	// on -- nonRoot -- is declared `asserted` already. Denying it would break local-folder jobs to make a
	// word honest that is already honest. docker-run.test.mjs pins the feature itself.
	assert.ok(buildDockerRunArgs({ ...base, extraFlags: ["--user", "1000:1000"] }).includes("--user"));
});
