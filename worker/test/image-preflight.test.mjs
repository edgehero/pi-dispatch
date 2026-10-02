import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { CAPABILITY_GATES, FIELD_SEP, makeImagePreflight, normalizeImageId, resolveJobImage } from "../src/image-preflight.mjs";

// No skip guard, deliberately: unlike run-container.mjs this module imports nothing but node:child_process,
// and it decides whether a budget slot is spent. A money gate must not have skippable tests.

/**
 * A fake `docker` that records each argv and exits with the code the plan gives for that subcommand.
 * `plan` is keyed on the first arg ("image" | "info"); a missing key means "not launchable" (error event),
 * which is how a docker binary that is not on PATH behaves.
 */
function fakeSpawn(calls, plan, stdout = "") {
	return (cmd, args, opts) => {
		calls.push({ cmd, args, opts });
		const child = new EventEmitter();
		// The inspect probe captures stdout (it carries the pi-version label); `docker info` deliberately
		// does not, so only wire a stream when the caller asked to pipe one.
		if (opts?.stdio?.[1] === "pipe") {
			const out = new EventEmitter();
			out.setEncoding = () => {};
			child.stdout = out;
			queueMicrotask(() => out.emit("data", stdout));
		}
		const code = plan[args[0]];
		queueMicrotask(() => (code === undefined ? child.emit("error", new Error("ENOENT")) : child.emit("close", code)));
		return child;
	};
}

test("resolveJobImage refuses, as a config error, an image the one image rule refuses, whoever queued it (#471)", () => {
	for (const bad of ["--privileged", " img", "img\u001b"]) {
		assert.throws(() => resolveJobImage({ image: bad }, "pi-job:latest"), (e) => e.piDispatchConfig === true && /the job image must/.test(e.message), JSON.stringify(bad));
	}
	assert.throws(() => resolveJobImage({}, "-x"), (e) => e.piDispatchConfig === true, "the default too");
	assert.equal(resolveJobImage({ image: "ok:1" }, "pi-job:latest"), "ok:1");
	assert.equal(resolveJobImage({}, null), null, "no default and no job image stays nothing, as prepare's unwired stamp needs");
});

test("the image preflight refuses a queued bad image before it spawns anything (#471)", async () => {
	const calls = [];
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: (...a) => (calls.push(a), null) });
	await assert.rejects(() => preflight({ image: "--privileged" }), (e) => e.piDispatchConfig === true);
	assert.equal(calls.length, 0, "no inspect was run with a flag where the image belongs");
});

test("resolveJobImage prefers the job's own image and falls back to the deployment default", () => {
	assert.equal(resolveJobImage({ image: "my-python:1.2.0" }, "pi-job:latest"), "my-python:1.2.0");
	assert.equal(resolveJobImage({}, "pi-job:latest"), "pi-job:latest", "a job that names none runs the deployment default");
	assert.equal(resolveJobImage(undefined, "pi-job:latest"), "pi-job:latest", "and a jobless call still resolves");
});

test("an image that inspects clean is ok, and costs exactly ONE spawn", async () => {
	const calls = [];
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn(calls, { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7\n`) });
	assert.deepEqual(await preflight({}), { ok: true, image: "pi-job:latest", piVersion: "0.80.7", imageDigest: "sha256:abc", capabilities: [] });
	// The `docker info` disambiguation runs ONLY on the failure path. Every job pays this check, so the
	// happy path must not pay for the diagnosis of a case it is not in. The pi-version label rides this
	// same inspect for the same reason -- a second spawn would have doubled what every job pays.
	assert.equal(calls.length, 1, "the happy path does not probe the daemon a second time");
	assert.deepEqual(calls[0].args, [
		"image",
		"inspect",
		`--format={{.Id}}${FIELD_SEP}{{index .Config.Labels "dev.pi-dispatch.pi-version"}}${FIELD_SEP}{{index .Config.Labels "dev.pi-dispatch.forges"}}${FIELD_SEP}{{index .Config.Labels "dev.pi-dispatch.capabilities"}}`,
		"pi-job:latest",
	]);
});

test("an image that declares no pi version reports null, which downstream means never resume", async () => {
	// Go's text/template renders a missing map key as the literal "<no value>". An operator-built image
	// (OQ-012) that omits the label must run cold rather than resume into a pi whose tool schemas may have
	// moved -- null is the SAFE answer here, never "assume it matches".
	for (const out of [`sha256:abc${FIELD_SEP}<no value>\n`, `sha256:abc${FIELD_SEP}\n`, "sha256:abc\n", "", "   "]) {
		const preflight = makeImagePreflight({ image: "i", spawnFn: fakeSpawn([], { image: 0, info: 0 }, out) });
		// The digest travels the same short-line rule as the version: a truncated pipe or an older docker
		// yields null on EVERY field rather than a fragment of one.
		const imageDigest = out.trim() === "" ? null : "sha256:abc";
		assert.deepEqual(await preflight({}), { ok: true, image: "i", piVersion: null, imageDigest, capabilities: [] }, `stdout ${JSON.stringify(out)} must not become a version`);
	}
});

test("a missing image with a live daemon is {missing}, disambiguated by docker info", async () => {
	const calls = [];
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn(calls, { image: 1, info: 0 }) });
	assert.deepEqual(await preflight({}), { missing: "pi-job:latest" });
	assert.deepEqual(
		calls.map((c) => c.args[0]),
		["image", "info"],
		"a non-zero inspect is ambiguous, so the daemon is confirmed POSITIVELY rather than by matching docker's stderr",
	);
});

test("a down daemon is {unavailable}, never {missing} -- a transient fault must not become a permanent refusal", async () => {
	// Both probes exit non-zero: an absent image and an unreachable daemon are indistinguishable from the
	// inspect alone, and calling this one `missing` would refuse the job with no retry over a daemon blip.
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn([], { image: 1, info: 1 }) });
	assert.deepEqual(await preflight({}), { unavailable: "pi-job:latest" });
});

test("a docker binary that cannot be launched at all is {unavailable}", async () => {
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn([], {}) });
	assert.deepEqual(await preflight({}), { unavailable: "pi-job:latest" }, "no docker is no answer, not a verdict about the image");

	// The synchronous-throw form of the same fault (spawn itself throwing, not emitting `error`).
	const throwing = makeImagePreflight({
		image: "pi-job:latest",
		spawnFn: () => {
			throw new Error("EPERM");
		},
	});
	assert.deepEqual(await throwing({}), { unavailable: "pi-job:latest" });
});

test("the preflight checks the JOB's image, not the deployment default", async () => {
	const calls = [];
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn(calls, { image: 1, info: 0 }) });
	assert.deepEqual(await preflight({ image: "my-python:1.2.0" }), { missing: "my-python:1.2.0" }, "the refusal names the tag the job asked for");
	assert.ok(calls[0].args.includes("my-python:1.2.0"), "and the tag it inspected is the one it will run");
});

test("a job whose forge the image excludes is refused PRE-SPEND, with no container and no budget slot", async () => {
	// `run.image` is optional, so a trigger for a forge whose CLI the default image does not ship would
	// otherwise run there, find no such command, and fail INSIDE a paid container -- on every delivery,
	// looking exactly like a bad agent run rather than a missing tool.
	const calls = [];
	const preflight = makeImagePreflight({
		image: "pi-job:latest",
		spawnFn: fakeSpawn(calls, { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}github,gitlab,forgejo\n`),
	});
	const r = await preflight({ kind: "azure" });
	assert.equal(r.forgeUnsupported, "pi-job:latest");
	assert.equal(r.kind, "azure");
	assert.deepEqual(r.declared, ["github", "gitlab", "forgejo"]);
	assert.equal(calls.length, 1, "one inspect, and nothing else -- the refusal costs no second spawn");
});

test("a job whose forge the image DOES declare runs, and the label rides the same single inspect", async () => {
	const calls = [];
	const preflight = makeImagePreflight({
		image: "i",
		spawnFn: fakeSpawn(calls, { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}github,gitlab,forgejo\n`),
	});
	for (const kind of ["github", "gitlab", "forgejo"]) {
		assert.deepEqual(await preflight({ kind }), { ok: true, image: "i", piVersion: "0.80.7", imageDigest: "sha256:abc", capabilities: [] }, kind);
	}
	assert.equal(calls.length, 3, "one spawn per call, still -- the forge list is a second field, not a second probe");
});

test("an image declaring NO forges admits every job -- absent is allowed, not refused", async () => {
	// The polarity is the opposite of what "declare your capabilities" suggests, and deliberately so: every
	// operator-built image predating this label (OQ-012) declares nothing, and refusing those would break
	// working deployments with no warning first. Only a PRESENT list that excludes the forge refuses.
	for (const out of [`sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}<no value>\n`, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}\n`, `sha256:abc${FIELD_SEP}0.80.7\n`, "sha256:abc\n", ""]) {
		const preflight = makeImagePreflight({ image: "i", spawnFn: fakeSpawn([], { image: 0, info: 0 }, out) });
		const r = await preflight({ kind: "azure" });
		assert.equal(r.ok, true, `stdout ${JSON.stringify(out)} must admit, not refuse`);
	}
});

test("a malformed forges label is treated as absent, not as 'serves no forge'", async () => {
	// Refusing every job on an image whose label was merely mistyped would be a worse failure than the one
	// the label exists to prevent.
	const preflight = makeImagePreflight({ image: "i", spawnFn: fakeSpawn([], { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP} , ,\n`) });
	assert.equal((await preflight({ kind: "github" })).ok, true);
});

test("a local job is never refused on forge grounds -- it has no forge to check", async () => {
	const preflight = makeImagePreflight({ image: "i", spawnFn: fakeSpawn([], { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}github\n`) });
	assert.equal((await preflight({ kind: "local" })).ok, true);
	assert.equal((await preflight({})).ok, true, "and neither is a job whose kind is not set at all");
});

test("the pi version still parses now that a third field follows it", async () => {
	const preflight = makeImagePreflight({ image: "i", spawnFn: fakeSpawn([], { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}github\n`) });
	assert.equal((await preflight({ kind: "github" })).piVersion, "0.80.7");
});

// --- the capabilities label: the stale-image gate for replicas (REQ-REPLICA-RUNS) ---

test("a replica job on an image that declares no capabilities is REFUSED pre-spend", async () => {
	// The OPPOSITE polarity to the forges label directly above, deliberately. `forges` is an EXCLUSION list,
	// so no claim excludes nothing; `capabilities` is an INCLUSION list, so no claim includes nothing. An
	// image built before this feature bakes a HARD_RULES.md whose rule 3 hard-codes `pi/issue-<n>` -- a
	// SYSTEM rule, which the model treats as authoritative over the user prompt naming `-r2`. Both replicas
	// would push to one branch: nothing errors, and you pay twice for one pull request.
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn([], { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}github${FIELD_SEP}\n`) });
	assert.deepEqual(await preflight({ kind: "github", replica: 2, replicas: 2 }), { replicaUnsupported: "pi-job:latest", declared: [] });
});

test("an UNFLAGGED job on that same image is ok -- the gate costs a non-replica job nothing", async () => {
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn([], { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}github${FIELD_SEP}\n`) });
	assert.deepEqual(await preflight({ kind: "github" }), { ok: true, image: "pi-job:latest", piVersion: "0.80.7", imageDigest: "sha256:abc", capabilities: [] });
});

test("a replica job on an image that declares `replicas` runs", async () => {
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn([], { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}github${FIELD_SEP}replicas\n`) });
	assert.deepEqual(await preflight({ kind: "github", replica: 1, replicas: 2 }), { ok: true, image: "pi-job:latest", piVersion: "0.80.7", imageDigest: "sha256:abc", capabilities: ["replicas"] });
	// A multi-item list parses the same way the forges list does.
	const multi = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn([], { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}github${FIELD_SEP} replicas , something-else \n`) });
	assert.deepEqual(await multi({ kind: "github", replica: 1, replicas: 2 }), { ok: true, image: "pi-job:latest", piVersion: "0.80.7", imageDigest: "sha256:abc", capabilities: ["replicas", "something-else"] });
});

test("`<no value>`, an empty list and a SHORT line all read as no claim, and all refuse a replica job", async () => {
	// Go's text/template renders a missing map key as the literal "<no value>"; an older docker or a
	// truncated pipe yields a line with fewer fields. Every one of them is "declares nothing", and on this
	// label that means refuse -- the same direction a genuinely unlabelled image goes.
	for (const stdout of [
		`sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}github${FIELD_SEP}<no value>\n`,
		`sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}github${FIELD_SEP}  ,  \n`,
		`sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}github\n`,
		"sha256:abc\n",
	]) {
		const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn([], { image: 0, info: 0 }, stdout) });
		assert.deepEqual(await preflight({ kind: "github", replica: 2, replicas: 2 }), { replicaUnsupported: "pi-job:latest", declared: [] }, `stdout=${JSON.stringify(stdout)}`);
	}
});

// --- the capabilities label again: the stale-image gate for commands (issue #189) ---

test("a command job on an image that does not declare `commands` is REFUSED pre-spend", async () => {
	// Same inclusion-list polarity as replicas: a runner that predates run.command reads no PI_COMMAND,
	// so the bare `/name args` prompt reaches the model as PROSE -- no handler, an improvised run, and a
	// clean exit 0 the queue records as success.
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn([], { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}github${FIELD_SEP}replicas\n`) });
	assert.deepEqual(await preflight({ kind: "local", command: "wf run" }), { commandUnsupported: "pi-job:latest", declared: ["replicas"] });
});

test("a command job on an image declaring `commands` runs", async () => {
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn([], { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}github${FIELD_SEP}replicas,commands\n`) });
	assert.deepEqual(await preflight({ kind: "local", command: "wf run" }), { ok: true, image: "pi-job:latest", piVersion: "0.80.7", imageDigest: "sha256:abc", capabilities: ["replicas", "commands"] });
});

test("an UNFLAGGED job on a wholly unlabelled image still passes -- the inclusion-list polarity costs it nothing", async () => {
	// The branch is unreachable unless the job actually carries a command, so the pre-label fleet
	// (OQ-012 operator-built images included) keeps running every ordinary job untouched.
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn([], { image: 0, info: 0 }, "sha256:abc\n") });
	assert.deepEqual(await preflight({ kind: "local" }), { ok: true, image: "pi-job:latest", piVersion: null, imageDigest: "sha256:abc", capabilities: [] });
});

test("a command job on an unlabelled image refuses with declared: [] -- no claim includes nothing", async () => {
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn([], { image: 0, info: 0 }, "sha256:abc\n") });
	assert.deepEqual(await preflight({ kind: "local", command: "wf run" }), { commandUnsupported: "pi-job:latest", declared: [] });
});

// --- the capabilities label again: the stale-image gate for excludeTools (issue #291) ---

test("a job carrying exclusions on an image that does not declare `excludeTools` is REFUSED pre-spend", async () => {
	// The command gate's twin, and the quietest failure of the three: a runner that predates the field
	// reads no PI_EXCLUDE_TOOLS, so a "read-only" trigger's job runs with a working editor and shell and
	// records a clean exit -- a permission quietly not enforced.
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn([], { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}github${FIELD_SEP}replicas,commands\n`) });
	assert.deepEqual(await preflight({ kind: "local", excludeTools: ["bash"] }), { excludeToolsUnsupported: "pi-job:latest", declared: ["replicas", "commands"] });
});

test("a job carrying exclusions on an image declaring `excludeTools` runs", async () => {
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn([], { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}github${FIELD_SEP}replicas,commands,excludeTools\n`) });
	assert.deepEqual(await preflight({ kind: "local", excludeTools: ["bash", "edit"] }), { ok: true, image: "pi-job:latest", piVersion: "0.80.7", imageDigest: "sha256:abc", capabilities: ["replicas", "commands", "excludeTools"] });
});

test("a job WITHOUT exclusions on an unlabelled image is untouched -- the branch is unreachable for the existing fleet", async () => {
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn([], { image: 0, info: 0 }, "sha256:abc\n") });
	assert.deepEqual(await preflight({ kind: "local" }), { ok: true, image: "pi-job:latest", piVersion: null, imageDigest: "sha256:abc", capabilities: [] });
});

test("the forge refusal still outranks the replica one -- a job that cannot run at all is the first thing to say", async () => {
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn([], { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}gitlab${FIELD_SEP}replicas\n`) });
	const r = await preflight({ kind: "github", replica: 2, replicas: 2 });
	assert.equal(r.forgeUnsupported, "pi-job:latest");
	assert.equal(r.replicaUnsupported, undefined);
});

test("the capabilities gate is FORGE-BLIND: a non-github replica is refused and admitted on the same terms (#187)", async () => {
	// Every assertion in this section was written when replicas were github-only, so the gate's
	// forge-blindness was true by construction and untested. It is REQ-REPLICA-RUNS' acceptance clause
	// "the image capability gate refuses per replica set exactly as on GitHub", and until #187 there was no
	// non-github replica for it to be exactly-as-on-github about.
	for (const kind of ["gitlab", "forgejo", "azure"]) {
		const forges = "github,gitlab,forgejo,azure";
		const bare = makeImagePreflight({ image: "pi-job:v", spawnFn: fakeSpawn([], { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}${forges}${FIELD_SEP}\n`) });
		assert.deepEqual(await bare({ kind, replica: 2, replicas: 2 }), { replicaUnsupported: "pi-job:v", declared: [] }, `${kind} replica on an unlabelled image`);
		assert.deepEqual(await bare({ kind }), { ok: true, image: "pi-job:v", piVersion: "0.80.7", imageDigest: "sha256:abc", capabilities: [] }, `${kind} unflagged pays nothing`);

		const capable = makeImagePreflight({ image: "pi-job:v", spawnFn: fakeSpawn([], { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}${forges}${FIELD_SEP}replicas\n`) });
		assert.deepEqual(await capable({ kind, replica: 1, replicas: 2 }), { ok: true, image: "pi-job:v", piVersion: "0.80.7", imageDigest: "sha256:abc", capabilities: ["replicas"] }, `${kind} replica on a capable image`);
	}
});

test("the FORGE refusal still outranks the replica one on a non-github replica job", async () => {
	// Ordering matters for the message an operator gets: an azure replica on the default image should be
	// told to set run.image, not told to rebuild for replica support. The image-preflight checks forges
	// first, and this pins that it still does once the replica gate can fire on azure at all.
	const preflight = makeImagePreflight({ image: "pi-job:latest", spawnFn: fakeSpawn([], { image: 0, info: 0 }, `sha256:abc${FIELD_SEP}0.80.7${FIELD_SEP}github,gitlab,forgejo${FIELD_SEP}replicas\n`) });
	const r = await preflight({ kind: "azure", replica: 2, replicas: 2 });
	assert.equal(r.forgeUnsupported, "pi-job:latest", "the forge gate answers first");
	assert.equal("replicaUnsupported" in r, false);
});

// --- issue #354: the runtime binary seam, and one spelling of an image id ---------------------------------------------

test("bin names BOTH probes, the inspect and the info that disambiguates it, and defaults to docker (#354)", async () => {
	for (const [seam, want] of [[{ bin: "podman" }, "podman"], [{}, "docker"]]) {
		const calls = [];
		const preflight = makeImagePreflight({ image: "i", spawnFn: fakeSpawn(calls, { image: 125, info: 0 }), ...seam });
		assert.deepEqual(await preflight({}), { missing: "i" });
		assert.deepEqual(calls.map((c) => [c.cmd, c.args[0]]), [[want, "image"], [want, "info"]]);
	}
});

test("Podman's bare-hex image id is published in docker's sha256: spelling, and nothing else is rewritten (#354)", async () => {
	const hex = "a".repeat(64);
	const preflight = makeImagePreflight({ image: "i", bin: "podman", spawnFn: fakeSpawn([], { image: 0 }, `${hex}${FIELD_SEP}0.80.7\n`) });
	assert.equal((await preflight({})).imageDigest, `sha256:${hex}`, "a podman host and a docker host running one image must agree");
	assert.equal(normalizeImageId(`sha256:${hex}`), `sha256:${hex}`, "docker's own form is untouched");
	for (const other of ["a".repeat(63), "a".repeat(65), "A".repeat(64), `sha512:${hex}`, "abc", null]) {
		assert.equal(normalizeImageId(other), other, JSON.stringify(other));
	}
});

// --- the capability gates are ONE table (issues #501, #502) ---

test("CAPABILITY_GATES: the old three in their old order, then modelPolicy (#502), then costCap (#501), each keyed once, each free for a job without its feature", async () => {
	assert.deepEqual(CAPABILITY_GATES.map((gate) => gate.token), ["replicas", "commands", "excludeTools", "modelPolicy", "costCap"], "the order the branches had, so a job carrying several is refused for the same one; a new row appends, in the order the features landed");
	for (const key of ["token", "result", "reason", "event"]) {
		assert.equal(new Set(CAPABILITY_GATES.map((gate) => gate[key])).size, CAPABILITY_GATES.length, `${key} is unique per row`);
	}
	const label = (caps) => `sha256:abc${FIELD_SEP}0.99.1${FIELD_SEP}github${FIELD_SEP}${caps}\n`;
	// A job carrying EVERY gated feature, on an image that declares none: the first row refuses.
	const all = { kind: "local", replica: 2, replicas: 2, command: "wf run", excludeTools: ["bash"], models: ["anthropic/claude-x"], maxCostMicros: 2_500_000 };
	const none = makeImagePreflight({ image: "i", spawnFn: fakeSpawn([], { image: 0, info: 0 }, label("")) });
	assert.deepEqual(await none(all), { replicaUnsupported: "i", declared: [] });
	// Declare tokens one at a time: each declaration moves the refusal to the next row, then passes.
	for (let i = 0; i < CAPABILITY_GATES.length; i++) {
		const declared = CAPABILITY_GATES.slice(0, i + 1).map((gate) => gate.token);
		const preflight = makeImagePreflight({ image: "i", spawnFn: fakeSpawn([], { image: 0, info: 0 }, label(declared.join(","))) });
		const next = CAPABILITY_GATES[i + 1];
		assert.deepEqual(await preflight(all), next ? { [next.result]: "i", declared } : { ok: true, image: "i", piVersion: "0.99.1", imageDigest: "sha256:abc", capabilities: declared });
	}
	for (const gate of CAPABILITY_GATES) {
		assert.equal(gate.needed({ kind: "github" }), false, `${gate.token}: an unflagged job pays nothing`);
		assert.equal(gate.needed({ kind: "github", models: null }), false, `${gate.token}: a null list is unrestricted, not a feature`);
		assert.match(gate.comment("img", "is absent"), /^Refused: the job image "img" does not declare .* \(`dev\.pi-dispatch\.capabilities` is absent\).* Rebuild the image from a version that has this feature\. Not run\.$/);
	}
});

test("modelPolicy (#502): a job with an effective allowed-model list on an image without the token is refused, an unrestricted one is not", async () => {
	const label = (caps) => `sha256:abc${FIELD_SEP}0.99.1${FIELD_SEP}github${FIELD_SEP}${caps}\n`;
	const old = makeImagePreflight({ image: "i", spawnFn: fakeSpawn([], { image: 0, info: 0 }, label("replicas,commands,excludeTools,anyUid")) });
	assert.deepEqual(await old({ kind: "github", models: ["openai/gpt-x"] }), { modelPolicyUnsupported: "i", declared: ["replicas", "commands", "excludeTools", "anyUid"] });
	assert.equal((await old({ kind: "github" })).ok, true, "no list, no gate: the image's age costs an unrestricted job nothing");
	const row = CAPABILITY_GATES.find((gate) => gate.token === "modelPolicy");
	assert.equal(row.reason, "job-image-model-policy-unsupported");
	const fresh = makeImagePreflight({ image: "i", spawnFn: fakeSpawn([], { image: 0, info: 0 }, label("modelPolicy")) });
	assert.equal((await fresh({ kind: "github", models: ["openai/gpt-x"] })).ok, true);
});

test("costCap (issue #501): any job carrying a dollar cap, 0 included, needs it; a job with none never does", async () => {
	const label = (caps) => `sha256:abc${FIELD_SEP}0.99.1${FIELD_SEP}github${FIELD_SEP}${caps}\n`;
	const old = makeImagePreflight({ image: "i", spawnFn: fakeSpawn([], { image: 0, info: 0 }, label("replicas,commands,excludeTools,anyUid")) });
	// An image built before the cost guard: its runner reads no PI_MAX_COST_MICROS, so a capped job would run
	// UNCAPPED and record a clean exit. Refused pre-spend for every cap, the tightest (0) included.
	for (const maxCostMicros of [0, 1, 2_500_000]) {
		assert.deepEqual(await old({ kind: "github", maxCostMicros }), { costCapUnsupported: "i", declared: ["replicas", "commands", "excludeTools", "anyUid"] }, `cap ${maxCostMicros}`);
	}
	// No cap: the row costs nothing, so a deployment that set no dollar cap runs its old image as before.
	for (const job of [{ kind: "github", maxCostMicros: null }, { kind: "github" }]) {
		assert.equal((await old(job)).ok, true, JSON.stringify(job));
	}
	// The image that declares it runs the capped job.
	const current = makeImagePreflight({ image: "i", spawnFn: fakeSpawn([], { image: 0, info: 0 }, label("replicas,commands,excludeTools,anyUid,costCap")) });
	assert.equal((await current({ kind: "github", maxCostMicros: 0 })).ok, true);
	const row = CAPABILITY_GATES.find((gate) => gate.token === "costCap");
	assert.equal(row.reason, "job-image-cost-cap-unsupported");
	assert.equal(row.event, "refused_image_cost_cap_unsupported");
	assert.match(row.comment("img", "is absent"), /per-job dollar cap/);
});
