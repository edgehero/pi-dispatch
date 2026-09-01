import assert from "node:assert/strict";
import { test } from "node:test";
import { makeBackendRegistry, reapAll } from "../src/backend-registry.mjs";
import { containerSpec, copyDowngrades, transfersFromSpec } from "../src/container-spec.mjs";

const bundle = (name, calls = []) => ({
	name,
	runContainer: async (args) => (calls.push([name, "runContainer", args?.job?.id]), { code: 0 }),
	imagePreflight: async (job) => (calls.push([name, "imagePreflight", job?.id]), {}),
	egressPreflight: async (job) => (calls.push([name, "egressPreflight", job?.id]), {}),
	stopContainer: async (n, job) => calls.push([name, "stopContainer", n, job?.id]),
	reap: async () => ({ reaped: true }),
	// Required by the registry's shape check: a bundle it will DISPATCH to has to be complete at boot, or
	// the failure lands after the budget reserve as a plain TypeError that refunds nothing.
	neverStartedExits: [125, 126, 127],
});

test("every per-job function resolves the SAME way, so none can be forgotten", () => {
	// The point of a registry rather than a `switch`: `stopContainer` was hard-wired in index.mjs while
	// `runContainer` was injectable, so the abort path could not reach a backend at all. One resolution
	// means a function added later cannot be dispatched on one path and hardcoded on another.
	const calls = [];
	const reg = makeBackendRegistry({ bundles: [bundle("local", calls), bundle("far", calls)], defaultName: "local" });
	const job = { id: "j1", backend: "far" };
	reg.runContainer({ job });
	reg.imagePreflight(job);
	reg.egressPreflight(job);
	reg.stopContainer("pi-job-j1", job);
	assert.deepEqual(
		calls.map((c) => c[0]),
		["far", "far", "far", "far"],
		"every one went to the named venue",
	);
});

test("a job that names no venue runs in the default", () => {
	const calls = [];
	const reg = makeBackendRegistry({ bundles: [bundle("local", calls), bundle("far", calls)], defaultName: "local" });
	reg.imagePreflight({ id: "j2" });
	reg.imagePreflight(undefined);
	assert.deepEqual(
		calls.map((c) => c[0]),
		["local", "local"],
	);
});

test("stopContainer takes the JOB as well as the name, or the abort path cannot find the venue", () => {
	// The reason `index.mjs`'s abort had to change: a container NAME alone cannot say which runtime holds
	// it once there is more than one, and that call is the only thing standing between a runaway job and
	// REQ-JOB-TIMEOUT-30M.
	const calls = [];
	const reg = makeBackendRegistry({ bundles: [bundle("local", calls), bundle("far", calls)], defaultName: "local" });
	reg.stopContainer("pi-job-x", { id: "x", backend: "far" });
	assert.deepEqual(calls[0], ["far", "stopContainer", "pi-job-x", "x"]);
});

test("an unresolvable name THROWS rather than silently falling back to the default", () => {
	// Two gates already refuse this: the loader refuses a name the build does not know, and the processor
	// refuses one the deployment does not bless. A job arriving here with an unknown name means one was
	// bypassed, and running it somewhere the operator did not choose would hide that rather than surface it.
	const reg = makeBackendRegistry({ bundles: [bundle("local")], defaultName: "local" });
	assert.throws(() => reg.imagePreflight({ id: "j", backend: "nope" }), /no backend named "nope" is registered/);
});

test("the registry refuses a broken construction at BOOT rather than at the first pickup", () => {
	assert.throws(() => makeBackendRegistry({ bundles: [], defaultName: "local" }), /at least one backend/);
	assert.throws(() => makeBackendRegistry({ bundles: [bundle("local")], defaultName: "far" }), /default "far" is not among/);
	assert.throws(() => makeBackendRegistry({ bundles: [bundle("a"), bundle("a")], defaultName: "a" }), /registered twice/);
	assert.throws(() => makeBackendRegistry({ bundles: [{ runContainer() {} }], defaultName: "x" }), /must carry its own name/);
	// SHAPE too, and at boot. `makeLocalBackend` enforces this for its own bundle and the registry never
	// calls it, so a hollow bundle used to build fine and fail at the first PICKUP -- after the budget
	// reserve, as a plain TypeError, which is not an InfraRetry and so refunded nothing.
	assert.throws(() => makeBackendRegistry({ bundles: [{ name: "hollow" }], defaultName: "hollow" }), /has no runContainer\(\)/);
	const noExits = { ...bundle("x") };
	delete noExits.neverStartedExits;
	assert.throws(() => makeBackendRegistry({ bundles: [noExits], defaultName: "x" }), /must declare neverStartedExits as an array/);
});

test("reapAll is CONSERVATIVE: one venue that could not enumerate makes the whole answer unproven", async () => {
	// `makeScopeClaimSweeper` reads `reaped` as "this host has established that it holds no job containers",
	// and that claim is only as strong as its weakest venue. Sweeping on a partial answer would free scope
	// slots for containers that may still be running and let another host start more alongside them -- a
	// spend overrun rather than a tidy-up, which is why the tri-state exists.
	assert.deepEqual(await reapAll([async () => ({ reaped: true }), async () => ({ reaped: true })]), { reaped: true });
	assert.deepEqual(await reapAll([async () => ({ reaped: true }), async () => ({ reaped: false })]), { reaped: false });
	assert.deepEqual(await reapAll([async () => ({ reaped: false }), async () => ({ reaped: true })]), { reaped: false }, "order must not matter");
	assert.deepEqual(await reapAll([]), { reaped: true }, "nothing to reap is not an unproven state");
	// A reaper that returns nothing at all is unproven too -- absence is not a proof.
	assert.deepEqual(await reapAll([async () => undefined]), { reaped: false });
});

test("every reaper still RUNS after one fails, and a thrower is logged rather than swallowed", async () => {
	// The sweep is best-effort cleanup: a second venue's strays are worth clearing whether or not the first
	// answered. And a reaper that escapes its own catch used to reach startWorker, which logged it -- so
	// swallowing it here without a word would delete an operator-visible signal about an unswept venue.
	const ran = [];
	const logs = [];
	const out = await reapAll(
		[
			async () => {
				ran.push("a");
				throw new Error("daemon down");
			},
			async () => (ran.push("b"), { reaped: true }),
		],
		{ log: (event, fields) => logs.push([event, fields.reason]) },
	);
	assert.deepEqual(ran, ["a", "b"], "a failure must not stop the sweep");
	assert.deepEqual(out, { reaped: false });
	assert.deepEqual(logs, [["reaper_skipped", "daemon down"]]);
});

test("a transfer says WHO enforces read-only, so a copy declares a downgrade rather than translating", () => {
	// `DES-JOB-FILES-VIA-VOLUME-SUBPATH` recorded the loss in terms: `docker cp` "cannot give /job a
	// kernel-enforced read-only mount, which INT-CONTAINER-JOB-INPUTS depends on" -- and every vendor
	// upload API is `docker cp`-shaped. The word `kernel` is what a conformance suite reads, and what stops
	// "we upload the files" being mistaken for "the agent cannot rewrite its own instructions".
	const spec = containerSpec({ image: "i", name: "n", jobDir: "/j", workspace: "/w", globalPiDir: "/g" });
	const byPath = Object.fromEntries(transfersFromSpec(spec).map((t) => [t.container, t]));
	assert.equal(byPath["/job"].readOnlyEnforcedBy, "kernel");
	assert.equal(byPath["/opt/pi-global"].readOnlyEnforcedBy, "kernel");
	assert.equal(byPath["/workspace"].readOnlyEnforcedBy, null, "the only writable mount claims no enforcement");
	// And the downgrade list is what an adapter that copies must declare.
	assert.deepEqual(copyDowngrades(spec).map((d) => d.container).sort(), ["/job", "/opt/pi-global"]);
	assert.ok(copyDowngrades(spec).every((d) => d.was === "kernel" && d.becomes === "convention"));
});

test("every WRITABLE mount comes back, not just /workspace", () => {
	// An earlier draft hardcoded `/workspace` as the only mount the job changes, and that was wrong in a way
	// that would have been silent. `/outbox` and `/session` are writable too, and the HOST reads both after
	// the container exits: `collectChain` reads jobDir/outbox for the chain requests the agent wrote
	// (INT-OUTBOX-CONTRACT), and `promoteSession` reads jobDir/session for the transcript pi appended
	// (REQ-RESUMABLE-SESSION). An adapter that brought back only /workspace would never enqueue a chained
	// child and would cold-start every resume, both reporting success.
	const spec = containerSpec({ image: "i", name: "n", jobDir: "/j", workspace: "/w", outboxDir: "/o", sessionDir: "/s", globalPiDir: "/g" });
	const dirs = Object.fromEntries(transfersFromSpec(spec).map((t) => [t.container, t.direction]));
	for (const p of ["/workspace", "/outbox", "/session"]) assert.equal(dirs[p], "in-out", p);
	for (const p of ["/job", "/opt/pi-global"]) assert.equal(dirs[p], "in", p);
	// The rule is writability, not a list of paths: read-only in, writable in-out, with no exceptions.
	for (const t of transfersFromSpec(spec)) assert.equal(t.direction, t.readOnly ? "in" : "in-out", t.container);
});

test("a COPYING runtime is told it is downgrading, in a word the binding one never produces", () => {
	// `readOnlyEnforcedBy` was `kernel` or `null` in a draft, so the word the whole abstraction exists to
	// produce -- `convention` -- was unreachable on every input, while the spec claimed "kernel or
	// convention". A two-valued field that can only ever take one value states nothing.
	const spec = containerSpec({ image: "i", name: "n", jobDir: "/j", workspace: "/w" });
	const bound = Object.fromEntries(transfersFromSpec(spec, { binds: true }).map((t) => [t.container, t.readOnlyEnforcedBy]));
	const copied = Object.fromEntries(transfersFromSpec(spec, { binds: false }).map((t) => [t.container, t.readOnlyEnforcedBy]));
	assert.equal(bound["/job"], "kernel");
	assert.equal(copied["/job"], "convention");
	assert.equal(copied["/workspace"], null, "a writable mount claims no read-only enforcement either way");
});

test("NESTING is modelled, because uploading each mount independently duplicates the tree", () => {
	// For a forge job `jobDir` CONTAINS `workspace/` and `session/` on the host, so an adapter that uploads
	// each mount on its own produces a container where /job/workspace also exists with a stale copy --
	// path-equivalent to nothing the local backend produces, and silently divergent rather than broken.
	const spec = containerSpec({ image: "i", name: "n", jobDir: "/j", workspace: "/j/workspace", sessionDir: "/j/session" });
	const byPath = Object.fromEntries(transfersFromSpec(spec).map((t) => [t.container, t]));
	assert.deepEqual(byPath["/job"].contains.sort(), ["/session", "/workspace"]);
	assert.deepEqual(byPath["/workspace"].contains, [], "a leaf contains nothing");
	// A sibling layout has no overlap at all, which is the case that must not report one.
	const flat = containerSpec({ image: "i", name: "n", jobDir: "/j", workspace: "/w" });
	assert.ok(transfersFromSpec(flat).every((t) => t.contains.length === 0));
	// And a prefix that is not a path boundary is NOT containment: /jobs is not inside /job.
	const tricky = containerSpec({ image: "i", name: "n", jobDir: "/job", workspace: "/jobsomething" });
	assert.deepEqual(transfersFromSpec(tricky).find((t) => t.container === "/job").contains, []);
});

test("the never-started exit codes are the BACKEND's, not a constant in the processor", async () => {
	// Docker's 125/126/127 collide with the runner's own exit channel (INT-RUNNER-EXIT-CODE-PROTOCOL), and
	// the worker resolved that collision by ASSUMING the runtime is docker. That assumption is silently
	// wrong for any venue where 125 is a real runner exit, and it was invisible while there was one runtime.
	const { LOCAL_NEVER_STARTED_EXITS, makeLocalBackend } = await import("../src/backend-local.mjs");
	assert.deepEqual([...LOCAL_NEVER_STARTED_EXITS], [125, 126, 127]);
	assert.ok(Object.isFrozen(LOCAL_NEVER_STARTED_EXITS));
	const b = makeLocalBackend({
		runContainer: async () => ({}),
		imagePreflight: async () => ({}),
		egressPreflight: async () => ({}),
		stopContainer: async () => {},
		reap: async () => ({ reaped: true }),
	});
	assert.deepEqual([...b.neverStartedExits], [125, 126, 127], "the bundle carries it, so the registry can resolve it per job");
});

test("a never-started exit REFUNDS the slot; an unknown one does not", async () => {
	// The distinction is money: in the never-started case the runtime never handed control to the runner, so
	// nothing was spent and keeping the slot would burn a second one on the retry. Both throw (infra), and
	// only the first carries the reason the refund is gated on.
	const { runJob } = await import("../src/processor.mjs");
	const run = (code, neverStartedExits) =>
		runJob(
			{ id: "j", kind: "local", folder: "/p", flow: "f", task: "t" },
			{
				neverStartedExits,
				comment: async () => {},
				log: () => {},
				imagePreflight: async () => ({}),
				prepareWorkspace: async () => ({ jobDir: "/j", workspace: "/w" }),
				runContainer: async () => ({ code, aborted: false, turns: null, tokens: null, session: null, usage: null, context: null }),
				cleanup: async () => {},
			},
		).then(
			() => null,
			(e) => e,
		);
	assert.equal((await run(125, () => [125, 126, 127]))?.reason, "container-never-started");
	// The SAME code under a venue that does not use it is an unknown exit, not a refund.
	const unknown = await run(125, () => []);
	assert.notEqual(unknown?.reason, "container-never-started");
	assert.match(unknown?.message ?? "", /unknown container exit 125/);
});

test("the registry refuses a BLESSED but unbuilt backend at boot", async () => {
	// A third set neither gate compares against: the loader refuses a name this build does not know, the
	// processor refuses one PI_BACKENDS does not bless -- and a name that is blessed with no BUNDLE passes
	// both, then throws at the first pickup as a non-InfraRetry that becomes a permanently failed job
	// blaming the operator for a deployment they configured correctly. The registry's own header claims
	// "reaching here means a gate was bypassed", which is only true once this check exists.
	assert.throws(
		() => makeBackendRegistry({ bundles: [bundle("local")], defaultName: "local", blessed: ["local", "far"] }),
		/PI_BACKENDS blesses "far" but no backend by that name is built/,
	);
	assert.doesNotThrow(() => makeBackendRegistry({ bundles: [bundle("local")], defaultName: "local", blessed: ["local"] }));
});

test("the registry refuses a venue with no boot reaper, because an unswept one still reports PROVEN", () => {
	// `reapAll` is conservative over the reapers it is HANDED, not over the venues that exist, and
	// `reapAll([])` is `{reaped: true}`. So a forgotten entry is indistinguishable from a fully-swept host,
	// and `makeScopeClaimSweeper` would then free scope slots for containers that may still be running --
	// the exact spend overrun the tri-state exists to prevent, through the one seam its conservatism misses.
	const reap = async () => ({ reaped: true });
	assert.throws(
		() => makeBackendRegistry({ bundles: [bundle("local"), bundle("far")], defaultName: "local", reaps: { local: reap } }),
		/no boot reaper for far/,
	);
	assert.throws(
		() => makeBackendRegistry({ bundles: [bundle("local")], defaultName: "local", reaps: { local: reap, ghost: reap } }),
		/boot reaper for unregistered backend\(s\) ghost/,
	);
	assert.doesNotThrow(() => makeBackendRegistry({ bundles: [bundle("local")], defaultName: "local", reaps: { local: reap } }));
});

test("neverStartedExits and containerName are ON the registry, not reached for around it", () => {
	// Both are per-job backend FACTS, and an earlier draft left them off the surface: the wiring rebuilt
	// `neverStartedExits` at the call site and index.mjs imported `jobContainerName` from the local adapter
	// directly. That is the "dispatched on one path, hardcoded on another" shape this module exists to make
	// impossible -- and the container NAME is the argument the abort's `stopContainer` receives, so building
	// it locally while resolving the venue per job was that defect in the very call the slice is about.
	const far = { ...bundle("far"), neverStartedExits: [7], containerName: (id) => `far-${id}` };
	const loc = { ...bundle("local"), neverStartedExits: [125], containerName: (id) => `pi-job-${id}` };
	const reg = makeBackendRegistry({ bundles: [loc, far], defaultName: "local" });
	assert.deepEqual(reg.neverStartedExits({ id: "j", backend: "far" }), [7]);
	assert.deepEqual(reg.neverStartedExits({ id: "j" }), [125], "the default venue answers for an unflagged job");
	assert.equal(reg.containerName({ id: "j", backend: "far" }), "far-j");
	assert.equal(reg.containerName({ id: "j" }), "pi-job-j");
});
