import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKENDS, OPENSHELL_BACKEND, OPENSHELL_BIND_BACKEND } from "../src/backends.mjs";
import { runBackendConformance } from "../src/backend-conformance.mjs";
import { containerSpec } from "../src/container-spec.mjs";
import { gatewayTomlFor, judgeBindAnswer, UPSTREAM_BIND_WARNING } from "../src/openshell-cli.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #686 part 3: the `openshell-bind` venue, the openshell bundle built with `mode: "bind"`, driven against a fake
 * `openshell` CLI whose answers are the shapes the issue #686 lab measured on OpenShell 0.1.4 (Docker driver): the binds
 * as `--driver-config-json` mounts, the policy listing every target and read back unchanged, and the three settings
 * refusals a default gateway answers a bind create with.
 */

let mod;
let importError;
try {
	mod = await import("../src/backend-openshell.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error(`backend-openshell could not import.\n${importError}`);
const skip = mod ? false : `backend-openshell could not import (${importError?.message ?? "unknown"}); CI runs this`;

const IMAGE_ID = `sha256:${"b".repeat(64)}`;
const SENTENCES = {
	allow_driver_config: "Error:   × caller driver config is disabled; a gateway administrator must enable\n  │ allow_driver_config",
	enable_bind_mounts: "Error: docker bind mounts require enable_bind_mounts = true in [openshell.drivers.docker]",
	resource_admission: "Error: host bind or image mount cannot be attached while resource admission is enabled: no trusted label resolver",
	// Measured: with all three settings on, the probe fails at PROVISIONING, and its sandbox stays listed in phase Error.
	admitted: "Error:   × sandbox entered error phase while provisioning: ContainerCreateFailed: mount target\n  │ '/sandbox' is reserved for the OpenShell workspace",
	garbled: "Error: something nobody measured",
};

/**
 * A fake CLI. `probe` is how the gateway answers the bind probe (a key of SENTENCES, or `created`); `createRefusal` a
 * settings sentence the job's own create meets; `imageMissing` an engine without the image.
 */
function fakeOpenshell({ probe = "admitted", createRefusal = null, imageMissing = false, sandboxes = [], deleteLag = 0, probeGate = null, facts = { rootless: false, userns: false } } = {}) {
	// `live`: the job sandboxes the fake gateway holds, each listed until `deleteLag` listings after its delete (a delete
	// is asynchronous, measured), `Infinity` for one that never goes. `probeGate`: a promise the probe create waits on.
	const state = { calls: [], exit: 0, stdin: [], creates: [], probes: 0, leftover: new Map(), live: new Map(), deleted: [] };
	const reject = (stderr) => Promise.reject(Object.assign(new Error("exit 1"), { code: 1, stdout: "", stderr }));
	const exec = async (bin, args) => {
		if ((bin === "docker" || bin === "podman") && args[0] === "info") {
			state.calls.push([bin, ...args]);
			// `docker info --format={{json .}}`, the shape parseDaemonFacts reads.
			const securityOptions = [...(facts.rootless ? ["name=rootless"] : []), ...(facts.userns ? ["name=userns"] : []), "name=seccomp,profile=builtin"];
			return { stdout: `${JSON.stringify({ ServerVersion: "28.0.4", OperatingSystem: "Ubuntu 24.04", SecurityOptions: securityOptions, NCPU: 4 })}\n`, stderr: "" };
		}
		if (bin === "docker" || bin === "podman") {
			state.calls.push([bin, ...args]);
			if (imageMissing) return reject("No such image");
			return { stdout: args.includes("{{.Id}}") ? `${IMAGE_ID}\n` : `${IMAGE_ID}|/opt/pi-dispatch/runner-node\n`, stderr: "" };
		}
		state.calls.push([bin, ...args]);
		const rest = args[0] === "--gateway" ? args.slice(2) : args;
		const [a, b] = rest;
		if (a === "status") return { stdout: JSON.stringify({ status: "connected", server: "https://127.0.0.1:17670", version: "0.1.4" }), stderr: "" };
		if (a === "policy" && rest.includes("--global")) return reject("no global policy revision found");
		if (a === "sandbox" && b === "create") {
			const config = rest.includes("--driver-config-json") ? JSON.parse(rest[rest.indexOf("--driver-config-json") + 1]) : null;
			const isProbe = config?.docker?.mounts?.some((m) => m.target === "/sandbox") === true;
			if (isProbe) {
				if (probeGate) await probeGate;
				state.probes += 1;
				state.probeArgs = rest;
				const probeName = rest[rest.indexOf("--name") + 1];
				// What the gateway holds afterwards: nothing for a settings refusal (measured), a sandbox otherwise.
				if (probe === "created") {
					state.leftover.set(probeName, "Provisioning");
					return { stdout: JSON.stringify({ phase: "Provisioning" }), stderr: "" };
				}
				if (probe === "admitted") state.leftover.set(probeName, "Error");
				return reject(SENTENCES[probe]);
			}
			state.creates.push({ args: rest, config });
			if (createRefusal) return reject(SENTENCES[createRefusal]);
			state.policy = JSON.parse(readFileSync(rest[rest.indexOf("--policy") + 1], "utf8"));
			// Issue #704 part 3: what the read-back adds, one layer per attached provider (measured in #684 for one).
			state.layers = Object.fromEntries(rest.flatMap((x, i) => (x === "--provider" ? [`_provider_${rest[i + 1].replace(/-/g, "_")}`] : [])).map((k) => [k, { name: k }]));
			const labels = Object.fromEntries(rest.flatMap((x, i) => (x === "--label" ? [rest[i + 1].split(/=(.*)/s).slice(0, 2)] : [])));
			const created = rest[rest.indexOf("--name") + 1];
			state.live.set(created, { name: created, phase: "Ready", labels, lag: null });
			return { stdout: JSON.stringify({ phase: "Ready" }), stderr: "" };
		}
		if (a === "policy" && b === "get") return { stdout: JSON.stringify({ policy_source: "sandbox", policy: state.layers && Object.keys(state.layers).length > 0 ? { ...state.policy, network_policies: { ...state.policy.network_policies, ...state.layers } } : state.policy }), stderr: "" };
		if (a === "sandbox" && b === "delete") {
			state.leftover.delete(rest[2]);
			state.deleted.push(rest[2]);
			const held = state.live.get(rest[2]);
			if (held && held.lag === null) held.lag = deleteLag;
			if (held && held.lag === 0) state.live.delete(rest[2]);
			return { stdout: "", stderr: "" };
		}
		if (a === "sandbox" && (b === "upload" || b === "download")) return { stdout: "", stderr: "" };
		if (a === "sandbox" && b === "list") {
			const out = [...sandboxes, ...[...state.live.values()].map(({ name, phase, labels }) => ({ name, phase, labels }))];
			for (const [name, held] of state.live) {
				if (held.lag === null) continue;
				held.lag -= 1;
				if (held.lag <= 0) state.live.delete(name);
			}
			return { stdout: JSON.stringify({ sandboxes: out, next_page_token: "" }), stderr: "" };
		}
		if (a === "provider") {
			if (b === "create") (state.made ??= []).push({ args: rest });
			return { stdout: JSON.stringify({ providers: [] }), stderr: "" };
		}
		return reject(`unexpected ${args.join(" ")}`);
	};
	const spawnFn = (cmd, args) => {
		state.calls.push([cmd, ...args]);
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = { on() {}, write: () => true, end: (chunk) => state.stdin.push(String(chunk ?? "")) };
		child.kill = () => {};
		queueMicrotask(() => {
			if (state.abort) state.abort();
			child.emit("close", state.exit);
		});
		return child;
	};
	return { state, exec, spawnFn };
}

function jobDirs({ local = false } = {}) {
	const root = tempDir("pd-openshell-bind-");
	const jobDir = join(root, "job-1");
	mkdirSync(join(jobDir, "session"), { recursive: true });
	writeFileSync(join(jobDir, "prompt.md"), "do it\n");
	writeFileSync(join(jobDir, "session", "current.jsonl"), "");
	if (local) {
		// A folder job: the operator's folder, outside the job dir, and an outbox inside it.
		const folder = join(root, "folder");
		mkdirSync(folder);
		mkdirSync(join(jobDir, "outbox"));
		return { jobDir, workspace: folder, outboxDir: join(jobDir, "outbox"), live: { hostDir: join(jobDir, "session") } };
	}
	mkdirSync(join(jobDir, "workspace"));
	return { jobDir, workspace: join(jobDir, "workspace"), live: { hostDir: join(jobDir, "session") } };
}

let clock = 1_000_000;
// The settle loop's wait, which advances the injected clock, so a sandbox that never goes times out at once.
const delay = async (ms) => {
	clock += ms;
};
function bundle(fake, over = {}) {
	return mod.makeOpenshellBackend({ mode: "bind", image: "pi-job:x", hostEnv: { ANTHROPIC_API_KEY: "sk-real" }, onOutput: () => {}, exec: fake.exec, spawnFn: fake.spawnFn, platform: "linux", readLsm: () => "landlock", euid: 1234, egid: 1235, now: () => clock, delay, ...over });
}

const JOB = { id: "j1", kind: "github", provider: "anthropic", model: "m", maxTurns: 5 };
const steps = (calls) => calls.filter((c) => c[0] === "openshell").map((c) => c.slice(1, 3).join(" "));

test("the binds and the policy of a bind job, golden: every spec mount at its mounts-layout path, read-only where the spec says, each listed in the policy (#686 part 3)", { skip }, () => {
	const spec = containerSpec({ image: "i", name: "pi-job-j1", jobDir: "/jobs/j1", workspace: "/jobs/j1/workspace", sessionDir: "/jobs/j1/session", steerInboxDir: "/jobs/j1.inbox", globalPiDir: "/srv/pi-global" });
	const binds = mod.bindMountsOf(spec);
	assert.deepEqual(binds, [
		{ source: "/jobs/j1", target: "/job", readOnly: true },
		{ source: "/jobs/j1/workspace", target: "/workspace", readOnly: false },
		{ source: "/jobs/j1/session", target: "/session", readOnly: false },
		{ source: "/jobs/j1.inbox", target: "/inbox", readOnly: true },
		{ source: "/srv/pi-global", target: "/opt/pi-global", readOnly: true },
	]);
	assert.deepEqual(mod.sandboxPolicy({ uid: 1234, gid: 1235, binds }), {
		version: 1,
		filesystem_policy: {
			include_workdir: true,
			read_only: ["/usr", "/lib", "/lib64", "/etc", "/bin", "/sbin", "/opt", "/app", "/ms-playwright", "/sys/fs/cgroup", "/dev/urandom", "/entrypoint.sh", "/job", "/inbox", "/opt/pi-global"],
			read_write: ["/tmp", "/dev/null", "/home/pi", "/proc", "/workspace", "/session"],
		},
		landlock: { compatibility: "hard_requirement" },
		process: { run_as_user: "1234", run_as_group: "1235" },
	});
	// Copy mode's body is byte-identical to before: no binds, nothing appended.
	assert.deepEqual(mod.sandboxPolicy(), mod.sandboxPolicy({ binds: [] }));
	assert.equal(JSON.stringify(mod.sandboxPolicy()).includes("/workspace"), false);
	// A target OpenShell reserves is refused at the stage, never handed to the gateway.
	for (const container of ["/sandbox", "/sandbox/job", "/opt/openshell", "/etc/openshell/x", "/run", "relative", "/"]) {
		assert.throws(() => mod.bindMountsOf({ mounts: [{ host: "/h", container, readOnly: true }] }), /not a target OpenShell admits/, container);
	}
});

test("one bind run: create with the binds and the mode label, read back, exec the entrypoint in /workspace, delete; nothing uploaded or downloaded (#686 part 3)", { skip }, async () => {
	const fake = fakeOpenshell();
	const dirs = jobDirs();
	writeFileSync(join(dirs.workspace, "kept.txt"), "before\n");
	const result = await bundle(fake).runContainer({ job: JOB, prepared: { jobDir: dirs.jobDir, workspace: dirs.workspace, live: dirs.live }, name: "pi-job-j1", signal: new AbortController().signal, exitAuth: true, user: "1234:1235", home: "/home/pi" });
	assert.equal(result.code, 0);
	// The delete, then the listing until it no longer names the sandbox (M1), BEFORE the run returned; the teardown's
	// own delete is skipped once that is confirmed.
	assert.deepEqual(steps(fake.state.calls), ["sandbox create", "policy get", "sandbox exec", "sandbox delete", "sandbox list"]);
	const [{ args: create, config }] = fake.state.creates;
	assert.ok(create.includes("pi.dispatch.openshell-mode=bind"), "labelled as a bind-mode sandbox");
	assert.ok(create.includes(`pi.dispatch.job-dir=${dirs.jobDir.split("/").at(-1)}`), "and with its job dir, for a salvage");
	assert.ok(create.includes("pi.dispatch.owner=pi-dispatch"));
	assert.deepEqual(config, {
		docker: {
			mounts: [
				{ type: "bind", source: dirs.jobDir, target: "/job", read_only: true },
				{ type: "bind", source: dirs.workspace, target: "/workspace", read_only: false },
				{ type: "bind", source: join(dirs.jobDir, "session"), target: "/session", read_only: false },
			],
		},
	});
	assert.deepEqual(fake.state.policy.process, { run_as_user: "1234", run_as_group: "1235" }, "the job user, as the policy's uid");
	assert.deepEqual(fake.state.policy.filesystem_policy.read_write.slice(-2), ["/workspace", "/session"]);
	assert.ok(fake.state.policy.filesystem_policy.read_only.includes("/job"));
	const execCall = fake.state.calls.find((c) => c[2] === "exec");
	assert.deepEqual(execCall.slice(execCall.indexOf("--") + 1), ["/entrypoint.sh"], "no pi-landlock: /job is a read-only bind");
	assert.equal(execCall[execCall.indexOf("--workdir") + 1], "/workspace");
	const env = Object.fromEntries(execCall.flatMap((a, i) => (a === "--env" ? [execCall[i + 1].split(/=(.*)/s).slice(0, 2)] : [])));
	assert.equal(env.PI_JOB_LAYOUT, undefined, "the mounts layout, which the runner reads by default");
	assert.equal(env.PI_SESSION_FILE, "/session/current.jsonl");
	assert.equal(env.HOME, "/home/pi");
	assert.equal(readFileSync(join(dirs.workspace, "kept.txt"), "utf8"), "before\n", "the host tree is the job's own, never replaced");
	for (const suffix of [".openshell-policy.json", ".openshell-up", ".openshell-down"]) assert.equal(existsSync(`${dirs.jobDir}${suffix}`), false, suffix);
});

test("a folder job binds the operator's folder read-write as /workspace and its outbox; a steer job binds /inbox read-only and steers through the file (#686 part 3)", { skip }, async () => {
	const fake = fakeOpenshell();
	const dirs = jobDirs({ local: true });
	await bundle(fake).runContainer({ job: { ...JOB, kind: "local" }, prepared: dirs, name: "pi-job-l1", signal: new AbortController().signal });
	const mounts = fake.state.creates[0].config.docker.mounts;
	assert.deepEqual(mounts.find((m) => m.target === "/workspace"), { type: "bind", source: dirs.workspace, target: "/workspace", read_only: false });
	assert.deepEqual(mounts.find((m) => m.target === "/outbox"), { type: "bind", source: dirs.outboxDir, target: "/outbox", read_only: false });

	// Steering: the registry says this venue binds, so the relay is opened on the inbox DIRECTORY (no stdin frames).
	const steerFake = fakeOpenshell();
	const steerDirs = jobDirs();
	const opened = [];
	const relay = { start: async () => {}, stop: async () => {}, delivered: async () => {} };
	const live = { start() {}, finish: async () => {}, push() {} };
	const transcripts = [];
	const b = bundle(steerFake, { openInboxRelay: (args) => (opened.push(args), relay), openLiveTranscript: (args) => (transcripts.push(args), live) });
	assert.equal(b.binds, true);
	await b.runContainer({ job: { ...JOB, steer: true }, prepared: steerDirs, name: "pi-job-s1", signal: new AbortController().signal, exitAuth: true, binds: b.binds, steerStdin: true, jobId: "run-1" });
	assert.equal(opened.length, 1);
	assert.equal(opened[0].inboxDir, `${steerDirs.jobDir}.inbox`, "the file inbox, as on local");
	assert.equal(opened[0].frames, undefined, "never stdin frames on a binding venue");
	assert.deepEqual(steerFake.state.creates[0].config.docker.mounts.find((m) => m.target === "/inbox"), { type: "bind", source: `${steerDirs.jobDir}.inbox`, target: "/inbox", read_only: true });
	// The live transcript: the host file, tailed, never the stderr records.
	assert.equal(transcripts.length, 1);
	assert.equal(transcripts[0].source, undefined);
	assert.equal(transcripts[0].file, join(steerDirs.jobDir, "session", "current.jsonl"));
	const execCall = steerFake.state.calls.find((c) => c[2] === "exec");
	const env = Object.fromEntries(execCall.flatMap((a, i) => (a === "--env" ? [execCall[i + 1].split(/=(.*)/s).slice(0, 2)] : [])));
	assert.equal(env.PI_STEER, "1");
	assert.equal(env.PI_EXIT_AUTH, "stdin", "the key alone on stdin; no frames");
	assert.equal(env.PI_TRANSCRIPT, undefined, "no stderr mirror: the host file is tailed");
});

test("the REAL bind bundle passes the harness: it binds, its declarations are the table's, and every step is the openshell CLI (#686 part 3)", { skip }, async () => {
	const fake = fakeOpenshell();
	const backend = bundle(fake);
	const probe = async (b, { exitCode, aborted = false }) => {
		const ac = new AbortController();
		fake.state.exit = exitCode;
		fake.state.abort = aborted ? () => ac.abort() : null;
		const dirs = jobDirs();
		return b.runContainer({ job: JOB, prepared: dirs, name: "pi-job-j1", signal: ac.signal });
	};
	const withBrokenEnumeration = async () => bundle({ ...fakeOpenshell(), exec: async () => Promise.reject(new Error("gateway down")) }).reap();
	const r = await runBackendConformance(backend, { probe, withBrokenEnumeration });
	assert.equal(r.ok, true, JSON.stringify(r.findings.filter((f) => !f.ok)));
	assert.equal(backend.name, OPENSHELL_BIND_BACKEND);
	assert.equal(backend.binds, true);
	assert.deepEqual(backend.declares, BACKENDS[OPENSHELL_BIND_BACKEND].declares);
	assert.equal(typeof backend.jobUserPreflight, "function");
	assert.equal(backend.pause, undefined, "no pause verb: live checkpoints stay off");
	const copy = mod.makeOpenshellBackend({ image: "pi-job:x", exec: fake.exec, spawnFn: fake.spawnFn });
	assert.equal(copy.name, OPENSHELL_BACKEND);
	assert.equal(copy.jobUserPreflight, undefined, "copy mode keeps the registry's default user");
	assert.throws(() => mod.makeOpenshellBackend({ image: "i", mode: "mount" }), /mode must be "copy" or "bind"/);
});

test("the job user (#686 part 3, review round 1): local's rule over the engine's docker info: the worker's ids, the image's on 1001 and on a desktop VM, refused for root, without anyUid, and for a rootless or remapped engine", { skip }, async () => {
	const answered = (facts) => ({ answered: true, facts: { shape: "docker", os: "Ubuntu", rootless: false, userns: false, ...facts } });
	const decide = (over) => mod.decideOpenshellBindUser({ platform: "linux", euid: 1234, egid: 1235, capabilities: ["anyUid"], daemon: answered({}), ...over });
	assert.deepEqual(decide({}), { user: "1234:1235", home: "/home/pi" });
	assert.deepEqual(decide({ euid: 1001, egid: 1001, capabilities: [] }), { user: null, home: null }, "the image's own uid needs no anyUid");
	assert.deepEqual(decide({ capabilities: [] }), { refused: "job-image-any-uid-unsupported", cause: "any-uid-unsupported" });
	assert.deepEqual(decide({ euid: 0, egid: 0 }), { refused: "job-user-unmappable", cause: "worker-is-root" });
	assert.deepEqual(decide({ egid: 0 }), { refused: "job-user-unmappable", cause: "root-group" });
	for (const platform of ["darwin", "win32"]) assert.deepEqual(decide({ platform, daemon: null }), { user: null, home: null }, `${platform}: a VM's file sharing maps ownership (local's row)`);
	assert.deepEqual(decide({ daemon: answered({ rootless: true }) }), { refused: "job-user-unmappable", cause: "rootless" });
	assert.deepEqual(decide({ daemon: answered({ userns: true }) }), { refused: "job-user-unmappable", cause: "userns-remap" });
	assert.equal(decide({ daemon: null }).unavailable, true, "no engine answer: not decidable, retried");
	assert.equal(decide({ euid: null }).unavailable, true, "no ids: not decidable, retried");
	// Through the bundle: the engine's `docker info`, read once and cached; a rootless engine refused before spend.
	const fake = fakeOpenshell();
	const b = bundle(fake);
	assert.deepEqual(await b.jobUserPreflight({}, { capabilities: ["anyUid"] }), { user: "1234:1235", home: "/home/pi" });
	await b.jobUserPreflight({}, { capabilities: ["anyUid"] });
	assert.equal(fake.state.calls.filter((c) => c[0] === "docker" && c[1] === "info").length, 1, "one docker info, cached");
	assert.deepEqual(await bundle(fakeOpenshell({ facts: { rootless: true } })).jobUserPreflight({}, { capabilities: ["anyUid"] }), { refused: "job-user-unmappable", cause: "rootless" });
	assert.deepEqual(await bundle(fakeOpenshell({ facts: { userns: true } })).jobUserPreflight({}, { capabilities: ["anyUid"] }), { refused: "job-user-unmappable", cause: "userns-remap" });
	// A desktop VM reads nothing.
	const mac = fakeOpenshell();
	assert.deepEqual(await bundle(mac, { platform: "win32" }).jobUserPreflight({}, { capabilities: [] }), { user: null, home: null });
	assert.equal(mac.state.calls.length, 0);
});

test("review round 2: the engine's docker info is kept for its age and no longer, and an unanswered read is never kept", { skip }, async () => {
	clock = 60_000_000;
	const { JOB_USER_FACTS_MAX_AGE_MS } = await import("../src/job-user.mjs");
	const fake = fakeOpenshell();
	const reads = () => fake.state.calls.filter((c) => c[0] === "docker" && c[1] === "info").length;
	const b = bundle(fake);
	await b.jobUserPreflight({}, { capabilities: ["anyUid"] });
	clock += JOB_USER_FACTS_MAX_AGE_MS - 1;
	await b.jobUserPreflight({}, { capabilities: ["anyUid"] });
	assert.equal(reads(), 1, "kept within its age");
	clock += 2;
	await b.jobUserPreflight({}, { capabilities: ["anyUid"] });
	assert.equal(reads(), 2, "read again once it is older");
	// An engine that did not answer: unavailable now, and asked again on the next job.
	let answers = 0;
	const flaky = fakeOpenshell();
	const exec = async (bin, args, o) => (bin === "docker" && args[0] === "info" && answers++ === 0 ? Promise.reject(Object.assign(new Error("timeout"), { killed: true })) : flaky.exec(bin, args, o));
	const f = bundle({ ...flaky, exec });
	assert.equal((await f.jobUserPreflight({}, { capabilities: ["anyUid"] })).unavailable, true);
	assert.deepEqual(await f.jobUserPreflight({}, { capabilities: ["anyUid"] }), { user: "1234:1235", home: "/home/pi" });
	assert.equal(answers, 2, "the unanswered read was not kept");
});

test("M1 (review rounds 1 and 2): a bind run returns only once its sandbox is gone; one not confirmed gone rides the result as lingering, its exit code unchanged", { skip }, async () => {
	clock = 20_000_000;
	const fake = fakeOpenshell({ deleteLag: 3 });
	const dirs = jobDirs();
	const marker = `${dirs.jobDir}.openshell-bind`;
	const result = await bundle(fake).runContainer({ job: JOB, prepared: dirs, name: "pi-job-m1", signal: new AbortController().signal });
	assert.equal(result.code, 0);
	assert.equal(result.lingering, undefined, "gone: nothing to say");
	assert.equal(fake.state.live.size, 0, "the gateway no longer lists the sandbox when the run returns");
	const order = steps(fake.state.calls);
	assert.deepEqual(order.slice(order.indexOf("sandbox exec")), ["sandbox exec", "sandbox delete", "sandbox list", "sandbox list", "sandbox list", "sandbox list"], "deleted after the exec, then polled until gone (listed three more times), and not deleted again");
	assert.equal(existsSync(marker), false, "the bind marker beside the job dir goes once the sandbox is gone");

	for (const exit of [0, 1, 2]) {
		const stuck = fakeOpenshell({ deleteLag: Infinity });
		stuck.state.exit = exit;
		const logs = [];
		const before = clock;
		const d = jobDirs();
		const r = await bundle(stuck, { log: (e, f) => logs.push([e, f]) }).runContainer({ job: JOB, prepared: d, name: "pi-job-m1b", signal: new AbortController().signal });
		assert.deepEqual([r.code, r.lingering], [exit, true], `exit ${exit} is never rewritten (CONST-RETRY-INFRA-ONLY), it is marked`);
		const waited = clock - before;
		assert.ok(waited >= mod.BIND_SETTLE_MS && waited < 2 * mod.BIND_SETTLE_MS, `waited the bound once, not again at teardown (${waited} ms)`);
		assert.equal(logs.filter(([e]) => e === "openshell_bind_sandbox_lingering").length, 1, "said once, by name");
		assert.equal(existsSync(`${d.jobDir}.openshell-bind`), true, "the marker stays while the sandbox may write the tree");
		// Every listing is bounded by what is left of the deadline.
		const lists = stuck.state.calls.filter((c) => c[1] === "sandbox" && c[2] === "list");
		assert.ok(lists.length > 1);
	}

	// A gateway that stops answering the listing is not "gone": the bound runs out and the result is marked.
	const down = fakeOpenshell();
	const downExec = async (bin, args, o) => (args.includes("list") ? Promise.reject(new Error("gateway down")) : down.exec(bin, args, o));
	const r2 = await bundle({ ...down, exec: downExec }).runContainer({ job: JOB, prepared: jobDirs(), name: "pi-job-m1c", signal: new AbortController().signal });
	assert.equal(r2.lingering, true);

	// An aborted run (a timeout, a shutdown) is asked once and not waited for; the stop stays the stop.
	const stuck = fakeOpenshell({ deleteLag: Infinity });
	const ac = new AbortController();
	stuck.state.exit = 143;
	stuck.state.abort = () => ac.abort();
	const before = clock;
	const r3 = await bundle(stuck).runContainer({ job: JOB, prepared: jobDirs(), name: "pi-job-m1d", signal: ac.signal });
	assert.equal(r3.aborted, true);
	assert.equal(r3.lingering, true);
	assert.ok(clock - before < mod.BIND_SETTLE_MS, "not waited out");
});

test("review round 2: each settle listing carries the time left as its bound", { skip }, async () => {
	clock = 25_000_000;
	const fake = fakeOpenshell({ deleteLag: 2 });
	const seen = [];
	const exec = async (bin, args, o) => (args.includes("list") && seen.push(o?.timeoutMs), fake.exec(bin, args, o));
	await bundle({ ...fake, exec }).runContainer({ job: JOB, prepared: jobDirs(), name: "pi-job-b1", signal: new AbortController().signal });
	assert.ok(seen.length >= 2 && seen.every((t) => Number.isInteger(t) && t > 0 && t <= mod.BIND_SETTLE_MS), JSON.stringify(seen));
	assert.ok(seen[1] < seen[0], "shrinking with the deadline");
});

test("M1 (review round 1): a salvage's settle ends the sandbox that bound the job dir, by its label, and says false while it lingers", { skip }, async () => {
	clock = 30_000_000;
	const bindLabels = (jobDir) => ({ "pi.dispatch.owner": "pi-dispatch", "pi.dispatch.openshell-mode": "bind", "pi.dispatch.job-dir": jobDir });
	const fake = fakeOpenshell({ deleteLag: 2 });
	fake.state.live.set("pi-job-s00000000001", { name: "pi-job-s00000000001", phase: "Ready", labels: bindLabels("job-abc123"), lag: null });
	fake.state.live.set("pi-job-s00000000002", { name: "pi-job-s00000000002", phase: "Ready", labels: bindLabels("job-other1"), lag: null });
	const b = bundle(fake);
	assert.equal(await b.settleJobDir("job-abc123"), true);
	assert.deepEqual(fake.state.deleted, ["pi-job-s00000000001"], "only the sandbox that bound this job dir");
	assert.ok(fake.state.live.has("pi-job-s00000000002"));
	assert.equal(await b.settleJobDir("job-none"), true, "nothing bound it: nothing to wait for");
	const stuck = fakeOpenshell({ deleteLag: Infinity });
	stuck.state.live.set("pi-job-s00000000003", { name: "pi-job-s00000000003", phase: "Ready", labels: bindLabels("job-stuck1"), lag: null });
	assert.equal(await bundle(stuck).settleJobDir("job-stuck1"), false);
	assert.equal(await bundle({ ...fake, exec: async () => Promise.reject(new Error("down")) }).settleJobDir("job-abc123"), false, "an unread listing is not gone");
	// Copy mode has no such member: its tree is a download, read after the run alone.
	assert.equal(mod.makeOpenshellBackend({ image: "i", exec: fake.exec }).settleJobDir, undefined);
});

test("review round 1: SELinux private relabel reaches the bind as selinux_label, and the probe's source sits under the jobs dir", { skip }, async () => {
	const spec = containerSpec({ image: "i", name: "pi-job-z", jobDir: "/jobs/j", workspace: "/jobs/j/workspace", sessionDir: "/jobs/j/session", globalPiDir: "/srv/g", relabel: true, workspaceOwned: true });
	const binds = mod.bindMountsOf(spec);
	assert.deepEqual(binds.filter((m) => m.selinuxLabel === "private").map((m) => m.target), ["/job", "/workspace", "/session"], "the worker's own directories only, never the overlay");
	const { driverConfigFor } = await import("../src/openshell-cli.mjs");
	assert.deepEqual(JSON.parse(driverConfigFor("docker", binds)).docker.mounts[0], { type: "bind", source: "/jobs/j", target: "/job", read_only: true, selinux_label: "private" });
	assert.equal(JSON.parse(driverConfigFor("docker", binds)).docker.mounts[3].selinux_label, undefined);
	const jobsDir = tempDir("pd-openshell-jobs-");
	const fake = fakeOpenshell();
	await bundle(fake, { jobsDir }).observationPreflight(JOB);
	const mount = JSON.parse(fake.state.probeArgs[fake.state.probeArgs.indexOf("--driver-config-json") + 1]).docker.mounts[0];
	assert.ok(mount.source.startsWith(join(jobsDir, "bind-probe-")), mount.source);
});

test("the bind gate: each settings refusal is a policy refusal before spend with the setting logged; an admitting answer passes; anything else retries (#686 part 3)", { skip }, async () => {
	for (const setting of ["allow_driver_config", "enable_bind_mounts", "resource_admission"]) {
		const logs = [];
		const answer = await bundle(fakeOpenshell({ probe: setting }), { log: (e, f) => logs.push([e, f]) }).observationPreflight(JOB);
		assert.deepEqual(answer.venueRefused, { reason: "openshell-bind-mounts-disabled", comment: mod.OPENSHELL_REFUSALS["openshell-bind-mounts-disabled"] }, setting);
		assert.ok(logs.some(([e, f]) => e === "openshell_bind_mounts_disabled" && f.setting === setting && f.at === "probe"), setting);
	}
	const fake = fakeOpenshell({ probe: "admitted" });
	const probedLogs = [];
	assert.deepEqual(await bundle(fake, { log: (e, f) => probedLogs.push([e, f]) }).observationPreflight(JOB), { observations: { openshellGatewayLocal: true } });
	assert.ok(probedLogs.some(([e, f]) => e === "openshell_bind_probed" && f.answer === "admitted"), "a probe that ran says so");
	// The probe: by image ID, one read-only bind onto the reserved /sandbox, owner- and mode-labelled, in the job namespace.
	const probeArgs = fake.state.probeArgs;
	assert.equal(probeArgs[probeArgs.indexOf("--from") + 1], IMAGE_ID);
	assert.match(probeArgs[probeArgs.indexOf("--name") + 1], /^pi-job-s[0-9a-f]{11}$/);
	assert.ok(probeArgs.includes("pi.dispatch.owner=pi-dispatch") && probeArgs.includes("pi.dispatch.openshell-mode=bind"));
	const mount = JSON.parse(probeArgs[probeArgs.indexOf("--driver-config-json") + 1]).docker.mounts[0];
	assert.equal(mount.target, "/sandbox");
	assert.equal(mount.read_only, true);
	assert.equal(existsSync(mount.source), false, "the probe's empty source directory is removed");
	// Measured: an admitting gateway LEAVES the probe's sandbox (phase Error); it is deleted, by its own name.
	const probeName = probeArgs[probeArgs.indexOf("--name") + 1];
	assert.ok(fake.state.calls.some((c) => c[1] === "sandbox" && c[2] === "delete" && c[3] === probeName), "the probe's sandbox is deleted");
	assert.equal(fake.state.leftover.size, 0, "nothing of the probe is left on the gateway");
	// A settings refusal creates nothing, and is deleted anyway (a no-op): one rule for every answer.
	const refusing = fakeOpenshell({ probe: "enable_bind_mounts" });
	await bundle(refusing).observationPreflight(JOB);
	const refusedName = refusing.state.probeArgs[refusing.state.probeArgs.indexOf("--name") + 1];
	assert.ok(refusing.state.calls.some((c) => c[2] === "delete" && c[3] === refusedName));
	// Should the worker die between the create and the delete, the boot reaper finds it: owner-labelled, in the namespace.
	const { isJobNamespace } = await import("../src/backend-local.mjs");
	assert.ok(isJobNamespace(probeName) && mod.SANDBOX_NAME.test(probeName), probeName);
	const crashed = fakeOpenshell({ sandboxes: [{ name: probeName, phase: "Error", labels: { "pi.dispatch.owner": "pi-dispatch", "pi.dispatch.openshell-mode": "bind" } }] });
	assert.deepEqual(await mod.makeOpenshellReaper({ exec: crashed.exec })(), { reaped: true });
	assert.ok(crashed.state.calls.some((c) => c[1] === "sandbox" && c[2] === "delete" && c[3] === probeName), "the reaper deletes a crash's probe leftover");
	// A probe the gateway made after all is deleted at once, and counts as admitting.
	const created = fakeOpenshell({ probe: "created" });
	assert.deepEqual(await bundle(created).observationPreflight(JOB), { observations: { openshellGatewayLocal: true } });
	assert.ok(created.state.calls.some((c) => c[2] === "delete" && /^pi-job-s/.test(c[3])));
	assert.equal(created.state.leftover.size, 0);
	// Words nobody measured: not knowing, retried, never a pass.
	assert.equal((await bundle(fakeOpenshell({ probe: "garbled" })).observationPreflight(JOB)).unavailable, true);
	// An image the engine does not hold asks nothing: the image preflight refuses that job next.
	const missing = fakeOpenshell({ imageMissing: true, probe: "allow_driver_config" });
	assert.deepEqual(await bundle(missing).observationPreflight(JOB), { observations: { openshellGatewayLocal: true } });
	assert.equal(missing.state.probes, 0);
	// Copy mode never probes.
	const copy = fakeOpenshell({ probe: "allow_driver_config" });
	await mod.makeOpenshellBackend({ image: "pi-job:x", exec: copy.exec, spawnFn: copy.spawnFn, platform: "linux", readLsm: () => "landlock" }).observationPreflight(JOB);
	assert.equal(copy.state.probes, 0);
});

test("the bind gate's cache: an admitting answer is kept ten minutes, a refusing one a minute, per bundle (#686 part 3)", { skip }, async () => {
	clock = 5_000_000;
	const fake = fakeOpenshell({ probe: "admitted" });
	const b = bundle(fake);
	await Promise.all([b.observationPreflight(JOB), b.observationPreflight(JOB)]);
	assert.equal(fake.state.probes, 1, "jobs picked up together share one probe");
	clock += mod.BIND_GATE_ADMITTED_MS - 1;
	await b.observationPreflight(JOB);
	assert.equal(fake.state.probes, 1);
	clock += 2;
	await b.observationPreflight(JOB);
	assert.equal(fake.state.probes, 2, "read again once the answer is old");

	const refusing = fakeOpenshell({ probe: "allow_driver_config" });
	const r = bundle(refusing);
	await r.observationPreflight(JOB);
	clock += mod.BIND_GATE_REFUSED_MS - 1;
	assert.equal((await r.observationPreflight(JOB)).venueRefused.reason, "openshell-bind-mounts-disabled");
	assert.equal(refusing.state.probes, 1);
	clock += 2;
	await r.observationPreflight(JOB);
	assert.equal(refusing.state.probes, 2, "a refusal is re-read within a minute, so a fixed gateway is seen");
});

test("the backstop: a create refused with a settings sentence after an admitting probe retries this attempt once and refuses the next before spend (#686 part 3)", { skip }, async () => {
	clock = 9_000_000;
	const fake = fakeOpenshell({ probe: "admitted", createRefusal: "enable_bind_mounts" });
	const logs = [];
	const b = bundle(fake, { log: (e, f) => logs.push([e, f]) });
	assert.deepEqual(await b.observationPreflight(JOB), { observations: { openshellGatewayLocal: true } });
	const dirs = jobDirs();
	await assert.rejects(b.runContainer({ job: JOB, prepared: dirs, name: "pi-job-j1", signal: new AbortController().signal }), (err) => err.reason === "container-never-started");
	assert.ok(logs.some(([e, f]) => e === "openshell_bind_mounts_disabled" && f.setting === "enable_bind_mounts" && f.at === "create"));
	// Even past the admitting answer's age, the probe cannot re-admit into the same refusal while the hold stands.
	clock += mod.BIND_GATE_REFUSED_MS + 1;
	const next = await b.observationPreflight(JOB);
	assert.equal(next.venueRefused.reason, "openshell-bind-mounts-disabled");
	assert.equal(fake.state.probes, 1, "the held refusal answers without a probe");
});

test("review round 1: a create-time refusal is held the full ten minutes, and a probe in flight when it lands cannot re-admit", { skip }, async () => {
	clock = 40_000_000;
	const fake = fakeOpenshell({ probe: "admitted", createRefusal: "enable_bind_mounts" });
	const b = bundle(fake);
	await b.observationPreflight(JOB);
	await assert.rejects(b.runContainer({ job: JOB, prepared: jobDirs(), name: "pi-job-h1", signal: new AbortController().signal }));
	clock += mod.BIND_GATE_ADMITTED_MS - 1;
	assert.equal((await b.observationPreflight(JOB)).venueRefused?.reason, "openshell-bind-mounts-disabled", "still held just before ten minutes");
	assert.equal(fake.state.probes, 1);
	clock += 2;
	await b.observationPreflight(JOB);
	assert.equal(fake.state.probes, 2, "read again once the hold is over");

	// The race: a probe in flight, a job's create refused meanwhile, then the probe answers admitting.
	clock = 50_000_000;
	let release;
	const gate = new Promise((r) => (release = r));
	const racing = fakeOpenshell({ probe: "admitted", createRefusal: "allow_driver_config", probeGate: gate });
	const r = bundle(racing);
	const pending = r.observationPreflight(JOB);
	await assert.rejects(r.runContainer({ job: JOB, prepared: jobDirs(), name: "pi-job-h2", signal: new AbortController().signal }));
	release();
	assert.equal((await pending).venueRefused?.reason, "openshell-bind-mounts-disabled", "the held refusal stands over the probe that began before it");
});

test("bind mode serves run.recover; copy mode still refuses it (#686 part 3)", { skip }, async () => {
	const job = { ...JOB, recover: true };
	assert.deepEqual(await bundle(fakeOpenshell()).observationPreflight(job), { observations: { openshellGatewayLocal: true } });
	const copy = fakeOpenshell();
	const refused = await mod.makeOpenshellBackend({ image: "pi-job:x", exec: copy.exec, spawnFn: copy.spawnFn, platform: "linux", readLsm: () => "landlock" }).observationPreflight(job);
	assert.equal(refused.venueRefused.reason, "openshell-recover-unsupported");
});

test("each mode lists, counts and deletes only its own sandboxes; copy mode's create carries no mode label or binds (#686 part 3)", { skip }, async () => {
	const [copyRun, copyNew, bindRun, bindNew] = ["pi-job-c1", "pi-job-c2", "pi-job-b1", "pi-job-b2"].map((n) => mod.sandboxNameOf(n));
	const bindLabel = { "pi.dispatch.openshell-mode": "bind" };
	const sandboxes = [
		{ name: copyRun, phase: "Ready", labels: { "pi.dispatch.mem": "1024", "pi.dispatch.cpu": "100" } },
		{ name: copyNew, phase: "Provisioning", labels: {} },
		{ name: bindRun, phase: "Ready", labels: { ...bindLabel, "pi.dispatch.mem": "2048", "pi.dispatch.cpu": "200" } },
		{ name: bindNew, phase: "Provisioning", labels: bindLabel },
	];
	const fake = fakeOpenshell({ sandboxes });
	const bind = bundle(fake);
	const copy = mod.makeOpenshellBackend({ image: "pi-job:x", exec: fake.exec, spawnFn: fake.spawnFn });
	assert.deepEqual((await bind.listJobContainers()).map((s) => s.name).sort(), [bindRun, bindNew].sort());
	assert.deepEqual((await copy.listJobContainers()).map((s) => s.name).sort(), [copyRun, copyNew].sort());
	// The other mode's unstarted sandbox is never deleted as an orphan: it may be that bundle's live attempt.
	assert.equal(await copy.containerGone(bindNew), false);
	assert.equal(await bind.containerGone(copyNew), false);
	assert.ok(!fake.state.calls.some((c) => c[2] === "delete"), "nothing deleted across modes");
	assert.equal(await bind.containerGone(bindNew), true, "its own unstarted one: deleted, then gone");
	// Copy mode's create is exactly what it was.
	const plain = fakeOpenshell();
	const dirs = jobDirs();
	await mod.makeOpenshellBackend({ image: "pi-job:x", hostEnv: { ANTHROPIC_API_KEY: "sk-real" }, onOutput: () => {}, exec: plain.exec, spawnFn: plain.spawnFn }).runContainer({ job: JOB, prepared: dirs, name: "pi-job-j9", signal: new AbortController().signal });
	const create = plain.state.creates[0].args;
	assert.equal(create.includes("--driver-config-json"), false);
	assert.equal(create.some((a) => a.startsWith("pi.dispatch.openshell-mode")), false);
	assert.ok(plain.state.calls.some((c) => c[2] === "upload"), "copy mode still uploads");
});

test("the bind-settings reader and the gateway.toml: the three sentences, the admitting one, nothing else (#686 part 3)", () => {
	for (const [key, text] of Object.entries(SENTENCES)) {
		const want = key === "admitted" ? { admitted: true } : key === "garbled" ? {} : { setting: key };
		assert.deepEqual(judgeBindAnswer(text), want, key);
	}
	assert.deepEqual(judgeBindAnswer("podman bind mounts require enable_bind_mounts = true in [openshell.drivers.podman]"), { setting: "enable_bind_mounts" });
	assert.equal(gatewayTomlFor("docker"), "[openshell]\nversion = 2\n\n[openshell.drivers.docker]\nallow_driver_config = true\nenable_bind_mounts = true\n\n[openshell.drivers.docker.resource_admission]\nenabled = false\n");
	assert.match(gatewayTomlFor("podman"), /\[openshell\.drivers\.podman\]/);
	assert.equal(UPSTREAM_BIND_WARNING, "Bind mounts expose gateway-host files to the sandbox and can bypass workspace isolation and filesystem policy.");
});

test("a bundle on the bind venue (#704 part 3): the same per-host provider as copy mode, and the plain variable in the bound job dir's file, never the exec", { skip }, async () => {
	const fake = fakeOpenshell();
	const dirs = jobDirs();
	// What the bound /job holds when the exec starts (review round 1, H1).
	const spawnFn = (cmd, args) => {
		const file = join(dirs.jobDir, "bundle-env.json");
		fake.state.bundleEnv = existsSync(file) ? readFileSync(file, "utf8") : null;
		return fake.spawnFn(cmd, args);
	};
	const b = bundle({ ...fake, spawnFn }, { readAllowlist: () => ["api.anthropic.com", "api.stripe.com"] });
	const result = await b.runContainer({ job: JOB, prepared: { jobDir: dirs.jobDir, workspace: dirs.workspace, live: dirs.live }, name: "pi-job-j1", signal: new AbortController().signal, user: "1234:1235", home: "/home/pi", secrets: { STRIPE_KEY: "sk_bind_0005", DB_URL: "plain_bind_0006" }, bundleKeys: { endpoints: { STRIPE_KEY: { host: "api.stripe.com", auth: "bearer" } }, plain: ["DB_URL"] } });
	assert.equal(result.code, 0);
	const sb = mod.sandboxNameOf("pi-job-j1");
	assert.deepEqual(fake.state.made.map((m) => m.args[m.args.indexOf("--name") + 1]), [sb, `${sb}-b0`]);
	const [{ args: create }] = fake.state.creates;
	assert.deepEqual(create.flatMap((a, i) => (a === "--provider" ? [create[i + 1]] : [])), [sb, `${sb}-b0`]);
	for (const rule of Object.values(fake.state.policy.network_policies)) for (const e of rule.endpoints) assert.equal(e.credential_binding.provider, e.host === "api.stripe.com" ? `${sb}-b0` : sb);
	const execCall = fake.state.calls.find((c) => c[2] === "exec");
	assert.equal(fake.state.bundleEnv, `${JSON.stringify({ DB_URL: "plain_bind_0006" })}\n`);
	assert.ok(execCall.includes("PI_BUNDLE_ENV=1"));
	assert.ok(!execCall.join(" ").includes("sk_bind_0005") && !execCall.join(" ").includes("plain_bind_0006"));
	assert.equal(existsSync(join(dirs.jobDir, "bundle-env.json")), false, "removed at teardown");
	assert.equal(typeof b.bundleGate, "function", "the bind bundle judges bundles as the copy one does");
	// Issue #712: the record's facts, from bind mode's early return out of collectRun too. The job's provider binds
	// ANTHROPIC_API_KEY (no token: JOB has none), the host's STRIPE_KEY; DB_URL is plain.
	assert.deepEqual(result.openshell, { mode: "bind", ruleHosts: ["api.anthropic.com", "api.stripe.com"], providers: 2, placeholders: 2 });
});
