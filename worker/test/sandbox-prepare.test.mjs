import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { tempDir } from "./helpers/temp-dir.mjs";
import { createSandboxPinHandler, createSandboxPreparer, observeSandboxPreparation, planSandboxPreparation, sandboxTriggerDigest } from "../src/sandbox-prepare.mjs";
import { listSandboxes, readManifest, sandboxDeadline, makeSandboxReaper } from "../src/sandbox-store.mjs";

const instant = 1_800_000_000_000;
const id = `sb-${"a".repeat(32)}`;
const sha = "b".repeat(40);
const triggers = JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi:human"] }, run: { kind: "github", flow: "fix", image: "job:one", backend: "local", secrets: { PRIVATE: "env:PRIVATE" } } }, { on: { type: "label", any: ["pi:podman"] }, run: { kind: "github", flow: "fix", image: "job:two", backend: "podman" } }] });
const configOf = (dir) => ({ workerName: "worker-a", backends: ["local", "podman"], defaultBackend: "local", jobImage: "job:default", sandboxRetentionHours: 24, sandboxPinDays: 7, sandboxDir: join(dir, "sandboxes"), jobsDir: join(dir, "jobs"), triggersFile: join(dir, "triggers.json"), egress: true, egressProxy: "pi-dispatch-egress", github: { source: "app" } });
const requestOf = (index = 0) => ({ id, host: "worker-a", repo: "owner/repo", ref: "feature/human", triggerIndex: index, triggerDigest: sandboxTriggerDigest(triggers, index), pin: false, by: "operator" });

function world(extra = {}) {
	const dir = tempDir("sandbox-prepare-test-");
	const config = { ...configOf(dir), ...extra.config };
	let clock = instant;
	let text = extra.text ?? triggers;
	const calls = [];
	const mint = [];
	const clone = async (args) => {
		calls.push(["clone", args]);
		fs.mkdirSync(args.workspace, { recursive: true });
		fs.writeFileSync(join(args.workspace, "human.txt"), "a checkout for the human");
		return { sha, workspace: args.workspace };
	};
	const opts = { config, env: { PI_JOB_MEMORY: "2g", PI_JOB_CPUS: "1" }, readTriggers: () => text, projects: () => [{ id: "web", members: ["github:owner/repo"] }], limits: () => [{ scope: "project:web", memory: "1536m", cpus: 0.75 }], forgeFor: async (job) => { calls.push(["forge", job]); return { auth: { mintToken: async (job) => { mint.push(job); return "private-clone-token"; } } }; }, clone, observe: async ({ backend }) => { calls.push(["observe", backend]); return { jobUser: { user: "1234:1234", home: "/home/pi" }, ...(backend === "podman" ? { podmanStore: "/home/worker/.local/share/containers/storage" } : {}) }; }, now: () => clock, ...extra.deps };
	const prepare = createSandboxPreparer(opts);
	return { dir, config, calls, mint, prepare, opts, clock: (value) => { clock = value; }, text: (value) => { text = value; } };
}

test("the selected trigger's image, project size and host egress are resolved together; sibling triggers differ", () => {
	const config = configOf("/test");
	const input = { config, env: { PI_JOB_MEMORY: "2g", PI_JOB_CPUS: "1" }, triggersText: triggers, projects: [{ id: "web", members: ["github:owner/repo"] }], limits: [{ scope: "project:web", memory: "1536m", cpus: 0.75 }] };
	const one = planSandboxPreparation({ ...input, request: requestOf(0) }).plan;
	const two = planSandboxPreparation({ ...input, request: requestOf(1) }).plan;
	assert.deepEqual([one.image, one.backend, two.image, two.backend], ["job:one", "local", "job:two", "podman"]);
	assert.deepEqual(one.size, { memMiB: 1536, cpuCenti: 75, source: "project" });
	assert.deepEqual(one.egress, { armed: true, proxy: "pi-dispatch-egress" });
	assert.notEqual(one.planDigest, two.planDigest);
	assert.equal(planSandboxPreparation({ ...input, config: { ...config, egress: false }, request: { ...requestOf(), planDigest: one.planDigest } }).refused, "sandbox-plan-changed");
});

test("every free determinate gate precedes identity observation, mint and clone", async () => {
	for (const [patch, cfg, reason] of [
		[{ host: "other" }, {}, "sandbox-host-mismatch"],
		[{ id: "../../outside" }, {}, "sandbox-id-invalid"],
		[{ triggerIndex: 99 }, {}, "sandbox-trigger-unavailable"],
		[{ triggerDigest: "c".repeat(64) }, {}, "sandbox-trigger-changed"],
		[{ repo: "https://attacker/x" }, {}, "sandbox-repo-invalid"],
		[{ ref: "--upload-pack=evil" }, {}, "sandbox-ref-invalid"],
		[{}, { sandboxRetentionHours: 0 }, "sandbox-retention-off"],
		[{}, { backends: ["podman"] }, "sandbox-venue-unblessed"],
		[{ planDigest: "c".repeat(64) }, {}, "sandbox-plan-changed"],
	]) {
		const w = world({ config: cfg });
		assert.equal((await w.prepare({ ...requestOf(), ...patch })).refused, reason);
		assert.deepEqual(w.calls, [], `${reason} touched no identity, credential or clone`);
		assert.deepEqual(w.mint, []);
	}
	const w = world({ text: JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi:human"] }, run: { kind: "github", flow: "fix", backend: "openshell" } }] }) });
	assert.equal((await w.prepare({ ...requestOf(), triggerDigest: undefined })).refused, "sandbox-venue-unsupported");
	assert.deepEqual(w.calls, []);
});

test("cross-filesystem publication refuses before credentials, while an unread device is infrastructure", async () => {
	for (const unreadable of [false, true]) {
		const w = world();
		const deviceFs = { ...fs, statSync(path, options) {
			if (path === w.config.jobsDir) {
				if (unreadable) throw Object.assign(new Error("device unreadable"), { code: "EIO" });
				const stat = fs.statSync(path, options);
				return { ...stat, dev: stat.dev + 1 };
			}
			return fs.statSync(path, options);
		} };
		const prepare = createSandboxPreparer({ ...w.opts, fs: deviceFs });
		if (unreadable) await assert.rejects(prepare(requestOf()), /preparation directories could not be secured/);
		else {
			const result = await prepare(requestOf());
			assert.equal(result.refused, "sandbox-config-invalid");
			assert.match(result.message, /PI_JOBS_DIR and PI_SANDBOX_DIR.*same filesystem/);
		}
		assert.deepEqual(w.calls, [], "neither known EXDEV nor unreadable devices can mint or clone");
		assert.deepEqual(w.mint, []);
	}
});

test("a real retention sweep during cloning cannot remove the live preparation lock or admit a second owner", async () => {
	const w = world();
	let release;
	let entered;
	const started = new Promise((resolve) => { entered = resolve; });
	const wait = new Promise((resolve) => { release = resolve; });
	let clones = 0;
	const prepare = createSandboxPreparer({ ...w.opts, clone: async ({ workspace }) => {
		clones++;
		fs.mkdirSync(workspace, { recursive: true });
		entered();
		await wait;
		return { sha };
	} });
	const first = prepare(requestOf());
	await started;
	try {
		assert.deepEqual(listSandboxes({ sandboxDir: w.config.sandboxDir }), [], "in-progress preparation has no retained row");
		const reap = makeSandboxReaper({ sandboxDir: w.config.sandboxDir, retentionHours: 24, listRunning: async () => [], now: () => instant });
		await reap();
		assert.equal(fs.existsSync(join(w.config.jobsDir, `${id}.lock`)), true, "retention cannot erase preparation authority");
		assert.equal((await prepare(requestOf())).refused, "sandbox-preparation-busy");
		assert.equal(clones, 1);
		assert.equal(w.mint.length, 1, "a rival never obtains another credential");
	} finally { release(); }
	assert.equal((await first).id, id);
	assert.deepEqual(fs.readdirSync(w.config.jobsDir), [], "publication cleans both staging and its lock");
	assert.equal(listSandboxes({ sandboxDir: w.config.sandboxDir }).length, 1);
});

test("a prepared clone is kept atomically, read-only token scoped to contents, and no agent inputs or secret capability copied", async () => {
	const w = world();
	const result = await w.prepare({ ...requestOf(1), pin: true });
	assert.deepEqual(w.mint, [{ kind: "github", repo: "owner/repo", permissions: { contents: "read" } }]);
	assert.equal(result.id, id);
	assert.equal(result.pinned, true);
	assert.equal(result.until, instant + 7 * 86_400_000);
	assert.equal(result.backend, "podman");
	assert.match(result.generation, /^[a-f0-9]{64}$/);
	const manifest = readManifest({ sandboxDir: w.config.sandboxDir, jobId: id });
	assert.equal(manifest.origin, "prepared");
	assert.equal(manifest.image, "job:two");
	assert.deepEqual(manifest.sandboxEgress, { armed: true, proxy: "pi-dispatch-egress" });
	assert.equal(manifest.podmanStore, "/home/worker/.local/share/containers/storage");
	assert.equal(manifest.workspace, join(w.config.sandboxDir, id, "workspace"));
	assert.deepEqual(fs.readdirSync(manifest.dir).sort(), ["manifest.json", "workspace"]);
	assert.deepEqual(fs.readdirSync(w.config.jobsDir), [], "the staging tree is moved, not left behind");
	assert.equal(fs.readFileSync(join(manifest.workspace, "human.txt"), "utf8"), "a checkout for the human");
	const stored = fs.readFileSync(join(manifest.dir, "manifest.json"), "utf8");
	assert.doesNotMatch(stored, /private-clone-token/);
	// Match forbidden input fields, not the incidental '/private' in a legitimate macOS temporary path.
	assert.doesNotMatch(stored, /"(?:PRIVATE|prompt|provider|session|mcp)"\s*:/i);
	assert.deepEqual(w.calls.map(([what]) => what), ["observe", "forge", "clone"], "no materialiser, model, container, comment, paid enqueue, reserve or slot collaborator exists on this path");
	assert.equal(listSandboxes({ sandboxDir: w.config.sandboxDir })[0].jobId, id);
});

test("replayed request reconciles the final incarnation without a credential or second clone; a foreign collision is preserved", async () => {
	const w = world();
	const req = requestOf();
	const first = await w.prepare(req);
	const calls = w.calls.length;
	assert.deepEqual(await w.prepare(req), first);
	assert.equal(w.calls.length, calls);
	const path = join(w.config.sandboxDir, id, "workspace", "human.txt");
	fs.writeFileSync(path, "human edits stay");
	assert.equal((await w.prepare({ ...req, repo: "owner/another" })).refused, "sandbox-id-collision");
	assert.equal(fs.readFileSync(path, "utf8"), "human edits stay");
	assert.equal(w.calls.length, calls);
});

test("a process killed mid-clone leaves tracked staging which its immediate restart reclaims before retrying", async () => {
	const w = world();
	const source = new URL("../src/sandbox-prepare.mjs", import.meta.url).href;
	const script = `
import * as fs from "node:fs";
import { join } from "node:path";
import { createSandboxPreparer } from ${JSON.stringify(source)};
const prepare = createSandboxPreparer({
 config: ${JSON.stringify(w.config)}, env: { PI_JOB_MEMORY:"2g", PI_JOB_CPUS:"1" }, readTriggers:()=>${JSON.stringify(triggers)},
 projects:()=>[{id:"web",members:["github:owner/repo"]}], limits:()=>[{scope:"project:web",memory:"1536m",cpus:0.75}],
 now:()=>${instant}, observe:async()=>({jobUser:null}), forgeFor:()=>({auth:{mintToken:async()=>"fixture-token"}}),
 clone:async({workspace})=>{fs.mkdirSync(workspace,{recursive:true});fs.writeFileSync(join(workspace,"partial"),"partial clone");process.exit(73);}
});
await prepare(${JSON.stringify(requestOf())});
`;
	const code = await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		child.stderr.on("data", (part) => { output += part; });
		child.once("error", reject);
		child.once("exit", (status) => status === 73 ? resolve(status) : reject(new Error(`fixture child failed: ${status}: ${output}`)));
	});
	assert.equal(code, 73);
	const before = fs.readdirSync(w.config.jobsDir).filter((name) => name.startsWith("job-sb-"));
	assert.equal(before.length, 1);
	const lock = JSON.parse(fs.readFileSync(join(w.config.jobsDir, `${id}.lock`), "utf8"));
	assert.equal(lock.stageName, before[0], "the lock recorded the stage before the clone could create partial files");
	assert.equal(fs.existsSync(join(w.config.jobsDir, before[0], "workspace", "partial")), true);
	assert.equal((await w.prepare(requestOf())).id, id);
	assert.deepEqual(fs.readdirSync(w.config.jobsDir), [], "the young abandoned directory is reclaimed now, not at a later host reboot");
	assert.equal(listSandboxes({ sandboxDir: w.config.sandboxDir }).length, 1);
});

test("a half-published workspace never appears: clone policy/infra failures clean staging and have different outcomes", async () => {
	for (const [failure, policy] of [[new Error("fatal: couldn't find remote ref branch"), true], [new Error("socket reset"), false]]) {
		const w = world({ deps: { clone: async ({ workspace }) => { fs.mkdirSync(workspace, { recursive: true }); fs.writeFileSync(join(workspace, "partial"), "partial"); throw failure; } } });
		if (policy) assert.equal((await w.prepare(requestOf())).refused, "sandbox-ref-unavailable");
		else await assert.rejects(w.prepare(requestOf()), /sandbox clone failed/);
		assert.deepEqual(fs.readdirSync(w.config.jobsDir), []);
		assert.deepEqual(fs.readdirSync(w.config.sandboxDir), []);
		assert.deepEqual(listSandboxes({ sandboxDir: w.config.sandboxDir }), []);
	}
});

test("a failed staging cleanup still releases this process's lock so a bounded infrastructure retry can run", async () => {
	const w = world();
	let failed = false;
	const broken = { ...fs, rmSync(path, options) { if (!failed && String(path).startsWith(w.config.jobsDir)) { failed = true; throw Object.assign(new Error("cleanup unavailable"), { code: "EIO" }); } return fs.rmSync(path, options); } };
	const prepare = createSandboxPreparer({ ...w.opts, fs: broken, clone: async () => { throw new Error("fetch failed"); } });
	await assert.rejects(prepare(requestOf()), /cleanup unavailable/);
	assert.equal(fs.existsSync(join(w.config.jobsDir, `${id}.lock`)), false);
	assert.equal((await w.prepare(requestOf())).id, id, "the next attempt can acquire the same request id");
});

test("an observation refusal costs no credential and a live lock never overwrites an in-progress preparation", async () => {
	const w = world({ deps: { observe: async () => ({ refused: "job-user-mismatch", message: "use the worker account" }) } });
	assert.equal((await w.prepare(requestOf())).refused, "job-user-mismatch");
	assert.deepEqual(w.mint, []);
	const lock = join(w.config.jobsDir, `${id}.lock`);
	fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
	assert.equal((await w.prepare(requestOf())).refused, "sandbox-preparation-busy");
	assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, process.pid);
	fs.unlinkSync(lock);
	fs.writeFileSync(lock, JSON.stringify({ pid: 99999999 }));
	const resumed = createSandboxPreparer({ ...w.opts, pidAlive: () => false, observe: async () => ({ jobUser: null }) });
	assert.equal((await resumed(requestOf())).id, id, "a dead process's lock is recoverable");
	assert.equal(fs.existsSync(lock), false);
});

test("stale takeover and owner release never delete a rival's new lock generation", async () => {
	for (const phase of ["stale", "release"]) {
		const w = world();
		fs.mkdirSync(w.config.sandboxDir, { recursive: true });
		fs.mkdirSync(w.config.jobsDir, { recursive: true });
		const lock = join(w.config.jobsDir, `${id}.lock`);
		if (phase === "stale") fs.writeFileSync(lock, JSON.stringify({ pid: 9999999, tag: "old" }));
		const rival = JSON.stringify({ pid: process.pid, tag: "rival-live-owner" });
		let raced = false;
		const raceFs = { ...fs, renameSync(from, to) {
			if (from === lock && to.includes(`.${phase}.`) && !raced) { raced = true; fs.writeFileSync(lock, rival); }
			return fs.renameSync(from, to);
		} };
		const prepare = createSandboxPreparer({ ...w.opts, fs: raceFs, pidAlive: (pid) => pid === process.pid });
		const result = await prepare(requestOf());
		assert.equal(raced, true);
		if (phase === "stale") {
			assert.equal(result.refused, "sandbox-preparation-busy");
			assert.equal(w.mint.length, 0);
		} else assert.equal(result.id, id);
		assert.equal(fs.readFileSync(lock, "utf8"), rival, `${phase} preserves the successor instead of unlinking its reusable path`);
		assert.deepEqual(fs.readdirSync(w.config.jobsDir).filter((p) => p.includes(".stale.") || p.includes(".release.")), []);
	}
});

test("preparation observes image presence before uid shortcuts or credentials on every platform", async () => {
	const { readPodmanStore } = await import("../src/sandbox.mjs");
	assert.equal(await readPodmanStore({ read: async () => ({ answered: true, info: { graphRoot: "/actual/worker/store" } }) }), "/actual/worker/store", "the default preparation dependency is an actual exported bounded store reader");
	assert.equal(await readPodmanStore({ read: async () => ({ answered: false }) }), null);
	const calls = [];
	const decideUser = async () => { calls.push("user"); return { user: null, home: null }; };
	const options = { backend: "local", image: "absent:image", config: { backendFloor: {} }, decideUser };
	assert.equal((await observeSandboxPreparation({ ...options, inspectImage: async () => ({ missing: "absent:image" }) })).refused, "sandbox-image-unavailable");
	assert.deepEqual(calls, [], "a baked uid/macOS/Windows shortcut cannot skip the separate image gate");
	await assert.rejects(observeSandboxPreparation({ ...options, inspectImage: async () => ({ unavailable: "absent:image" }) }), /did not answer/);
	const okay = await observeSandboxPreparation({ ...options, inspectImage: async () => ({ ok: true }) });
	assert.deepEqual(okay, { jobUser: { user: null, home: null } });
	assert.deepEqual(calls, ["user"]);
	const podman = await observeSandboxPreparation({ ...options, backend: "podman", inspectImage: async () => ({ ok: true }), readStore: async () => "/rootless/store" });
	assert.equal(podman.podmanStore, "/rootless/store");
	await assert.rejects(observeSandboxPreparation({ ...options, backend: "podman", inspectImage: async () => ({ ok: true }), readStore: async () => null }), /store could not be read/);
	for (const reason of ["job-user-unknown", "podman-conf-unread", "podman-unobserved", "job-user-image"]) {
		await assert.rejects(observeSandboxPreparation({ ...options, inspectImage: async () => ({ ok: true }), decideUser: async () => ({ refused: reason, message: "unread observation" }) }), /could not be read/, reason);
	}
	for (const reason of ["job-user-unmappable", "backend-floor", "job-image-any-uid-unsupported", "podman-conf-widens-job"]) {
		assert.equal((await observeSandboxPreparation({ ...options, inspectImage: async () => ({ ok: true }), decideUser: async () => ({ refused: reason, message: "determinate policy" }) })).refused, reason);
	}
	let imageAsks = 0;
	assert.equal((await observeSandboxPreparation({ ...options, inspectImage: async () => ++imageAsks === 1 ? { ok: true } : { missing: "gone" }, decideUser: async () => ({ refused: "job-user-image" }) })).refused, "sandbox-image-unavailable", "a positively missing image is policy even when it disappeared after the first read");
});

test("prepared workspaces obey the same deadline, pin and sweep; pin confirmation rejects a replaced incarnation", async () => {
	const w = world();
	const first = await w.prepare(requestOf());
	const pin = createSandboxPinHandler({ config: w.config, now: () => instant + 10_000 });
	const expect = { generation: first.generation, until: first.until, pin: false };
	const changed = readManifest({ sandboxDir: w.config.sandboxDir, jobId: id });
	assert.equal(sandboxDeadline(changed, 24).until, instant + 24 * 3_600_000);
	const result = await pin({ host: "worker-a", runId: id, expect });
	assert.equal(result.pinned, true);
	assert.equal(result.until, instant + 10_000 + 7 * 86_400_000);
	assert.equal((await pin({ host: "worker-a", runId: id, expect })).refused, "sandbox-changed", "the old deadline cannot authorize a second pin");
	const file = join(w.config.sandboxDir, id, "manifest.json");
	const current = JSON.parse(fs.readFileSync(file, "utf8"));
	fs.writeFileSync(file, JSON.stringify({ ...current, baseSha: "d".repeat(40) }));
	assert.equal((await pin({ host: "worker-a", runId: id, expect: { ...expect, until: result.until, pin: true } })).refused, "sandbox-changed");
	const reap = makeSandboxReaper({ sandboxDir: w.config.sandboxDir, retentionHours: 24, listRunning: async () => [], now: () => result.until + 1 });
	await reap();
	assert.deepEqual(listSandboxes({ sandboxDir: w.config.sandboxDir }), []);
});

test("standalone CLI fills a fresh id and current trigger digest without spending on any agent path", async () => {
	const w = world();
	const result = await w.prepare({ host: "worker-a", repo: "owner/repo", ref: "HEAD", triggerIndex: 0 });
	assert.match(result.id, /^sb-[a-f0-9]{32}$/);
	assert.notEqual(result.id, id);
	assert.equal(w.calls.find(([what]) => what === "clone")[1].ref, "HEAD");
});

test("a long configured jobs path does not turn this request's lock into an unreadable permanent claim", async () => {
	const w = world();
	w.config.jobsDir = join(w.dir, "long".repeat(45), "jobs");
	const prepare = createSandboxPreparer(w.opts);
	assert.equal((await prepare(requestOf())).id, id);
	assert.equal(fs.existsSync(join(w.config.jobsDir, `${id}.lock`)), false);
});
