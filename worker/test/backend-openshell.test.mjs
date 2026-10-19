import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKENDS, OPENSHELL_BACKEND } from "../src/backends.mjs";
import { READ_BACK_BY_A_LIVE_PROBE, runBackendConformance } from "../src/backend-conformance.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #683: the `openshell` bundle, driven against a fake `openshell` CLI. Two seams, because the adapter has two
 * kinds of call: the bounded steps (`exec`: create, policy read-back, upload, download, delete, list, status) and the
 * one long-lived child (`spawnFn`: the `sandbox exec` the run waits on, through the real `makeRunContainer`). Every
 * answer below is the shape the issue #683 lab measured on OpenShell 0.1.4.
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

/** A fake CLI: `calls` records every step and spawn; `answers` override a step by its first two args. */
function fakeOpenshell({ phase = "Ready", policyBack = null, sandboxes = [], failDownload = false, failCreate = false, globalPolicy = false, status = { status: "connected", server: "https://127.0.0.1:17670", version: "0.1.4" } } = {}) {
	const state = { calls: [], exit: 0, abort: null, stdin: [], written: {} };
	const reject = (message, stderr = "") => Promise.reject(Object.assign(new Error(message), { code: 1, stdout: "", stderr }));
	const exec = async (bin, args) => {
		if (bin === "docker" || bin === "podman") {
			state.engine = [bin, ...args];
			return { stdout: `sha256:${"a".repeat(64)}\n`, stderr: "" };
		}
		state.calls.push([bin, ...args]);
		const rest = args[0] === "--gateway" ? args.slice(2) : args;
		const [a, b] = rest;
		if (a === "status") return { stdout: JSON.stringify(status), stderr: "" };
		if (a === "policy" && rest.includes("--global")) return globalPolicy ? { stdout: JSON.stringify({ policy: {} }), stderr: "" } : reject("no global", "Error:   × code: 'Some requested entity was not found', message: \"no global policy\n  │ revision found\"");
		if (a === "sandbox" && b === "create") {
			if (failCreate) return reject("create failed", "ImagePullFailed");
			const file = rest[rest.indexOf("--policy") + 1];
			state.written.policy = JSON.parse(readFileSync(file, "utf8"));
			return { stdout: JSON.stringify({ name: rest[rest.indexOf("--name") + 1], phase }), stderr: "" };
		}
		if (a === "policy" && b === "get") return { stdout: JSON.stringify({ policy_source: "sandbox", policy: policyBack ?? state.written.policy }), stderr: "" };
		if (a === "sandbox" && b === "upload") return { stdout: "", stderr: "" };
		if (a === "sandbox" && b === "download") {
			if (failDownload) return reject("download failed");
			// What the sandbox holds after the run: the agent rewrote one file and deleted another.
			const dest = rest[4];
			writeFileSync(join(dest, rest[3].endsWith("workspace") ? "changed.txt" : "current.jsonl"), "after\n");
			return { stdout: "", stderr: "" };
		}
		if (a === "sandbox" && b === "delete") return { stdout: "", stderr: "" };
		if (a === "sandbox" && b === "list") {
			const page = rest.includes("--page-token") ? 2 : 1;
			const all = sandboxes;
			const doc = page === 1 && all.length > 1 ? { sandboxes: all.slice(0, 1), next_page_token: "p2" } : { sandboxes: page === 1 ? all : all.slice(1), next_page_token: "" };
			return { stdout: JSON.stringify(doc), stderr: "" };
		}
		return reject(`unexpected ${args.join(" ")}`);
	};
	const spawnFn = (cmd, args) => {
		state.calls.push([cmd, ...args]);
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		child.stdin = { on() {}, end: (chunk) => state.stdin.push(String(chunk)) };
		child.kill = () => {};
		queueMicrotask(() => {
			if (state.abort) state.abort();
			child.emit("close", state.exit);
		});
		return child;
	};
	return { state, exec, spawnFn };
}

function jobDirs() {
	const root = tempDir("pd-openshell-");
	const jobDir = join(root, "job-1");
	mkdirSync(join(jobDir, "workspace"), { recursive: true });
	mkdirSync(join(jobDir, "session"), { recursive: true });
	writeFileSync(join(jobDir, "prompt.md"), "do it\n");
	writeFileSync(join(jobDir, "workspace", "deleted.txt"), "before\n");
	writeFileSync(join(jobDir, "session", "current.jsonl"), "");
	return { jobDir, workspace: join(jobDir, "workspace"), live: { hostDir: join(jobDir, "session") } };
}

function bundle(fake, over = {}) {
	return mod.makeOpenshellBackend({ image: "pi-job:x", hostEnv: { ANTHROPIC_API_KEY: "sk-real" }, onOutput: () => {}, exec: fake.exec, spawnFn: fake.spawnFn, platform: "linux", readLsm: () => "lockdown,capability,landlock,yama", ...over });
}

const JOB = { id: "j1", kind: "github", provider: "anthropic", model: "m", maxTurns: 5 };

test("the REAL openshell bundle passes the harness's shape, declaration, transfer, exit, abort and reaper checks (#683)", { skip }, async () => {
	const fake = fakeOpenshell();
	const backend = bundle(fake);
	const probe = async (b, { exitCode, aborted = false }) => {
		const ac = new AbortController();
		fake.state.exit = exitCode;
		fake.state.abort = aborted ? () => ac.abort() : null;
		const dirs = jobDirs();
		return b.runContainer({ job: JOB, prepared: { jobDir: dirs.jobDir, workspace: dirs.workspace, live: dirs.live }, name: "pi-job-j1", signal: ac.signal });
	};
	const withBrokenEnumeration = async () => bundle({ ...fakeOpenshell(), exec: async () => Promise.reject(new Error("gateway down")) }).reap();
	const r = await runBackendConformance(backend, { probe, withBrokenEnumeration });
	assert.equal(r.ok, true, JSON.stringify(r.findings.filter((f) => !f.ok)));
	for (const check of ["shape", "declaration", "readOnlyJobInputs", "exitCodes", "abortable", "reap"]) {
		assert.ok(r.findings.some((f) => f.property === check || f.check === check), check);
	}
	assert.equal(backend.binds, false);
	assert.deepEqual(backend.declares, BACKENDS[OPENSHELL_BACKEND].declares);
	for (const call of fake.state.calls) assert.equal(call[0], "openshell", call.join(" "));
	for (const property of READ_BACK_BY_A_LIVE_PROBE) assert.ok(r.findings.find((f) => f.property === property || f.check === property)?.unverifiable, property);
});

test("one run: create sized and labelled under the generated policy, read it back, upload, exec through pi-landlock, download, delete (#683)", { skip }, async () => {
	const fake = fakeOpenshell();
	const dirs = jobDirs();
	const result = await bundle(fake, { gateway: "lab" }).runContainer({ job: JOB, prepared: { jobDir: dirs.jobDir, workspace: dirs.workspace, live: dirs.live }, name: "pi-job-j1", signal: new AbortController().signal, size: { memMiB: 2048, cpuCenti: 150 }, exitAuth: true });
	assert.equal(result.code, 0);
	const steps = fake.state.calls.map((c) => (c[1] === "--gateway" ? c.slice(3, 5) : c.slice(1, 3)).join(" "));
	assert.deepEqual(steps, ["sandbox create", "policy get", "sandbox upload", "sandbox upload", "sandbox upload", "sandbox exec", "sandbox download", "sandbox download", "sandbox delete"]);
	for (const call of fake.state.calls) assert.deepEqual(call.slice(0, 3), ["openshell", "--gateway", "lab"], "every step names the deployment's gateway");
	const create = fake.state.calls[0];
	for (const pair of [["--name", "pi-job-j1"], ["--from", `sha256:${"a".repeat(64)}`], ["--cpu", "1.5"], ["--memory", "2048Mi"]]) assert.equal(create[create.indexOf(pair[0]) + 1], pair[1], pair[0]);
	assert.deepEqual(fake.state.engine, ["docker", "image", "inspect", "--format", "{{.Id}}", "pi-job:x"], "the ID is read from the gateway's own engine, by the job's image name");
	assert.ok(create.includes("pi.dispatch.owner=pi-dispatch") && create.includes("pi.dispatch.mem=2048") && create.includes("pi.dispatch.cpu=150"));
	assert.ok(create.includes("--no-auto-providers"));
	assert.deepEqual(fake.state.written.policy, mod.sandboxPolicy(), "the policy written is the generated one");
	assert.equal(fake.state.written.policy.network_policies, undefined, "deny-all until #684");
	// The uploads: the job dir staged WITHOUT the workspace and session nested in it, each to /sandbox.
	const uploads = fake.state.calls.filter((c) => c[4] === "upload");
	assert.deepEqual(uploads.map((c) => [c[6].split("/").at(-1), c[7]]), [["job", "/sandbox"], ["workspace", "/sandbox"], ["session", "/sandbox"]]);
	for (const u of uploads) assert.ok(u.includes("--no-git-ignore"), "a copy keeps what .gitignore names, as a bind shows it");
	// The exec: the entrypoint through pi-landlock, writes confined to the workspace, session, scratch, home, null, /proc.
	const execCall = fake.state.calls.find((c) => c[4] === "exec");
	const tail = execCall.slice(execCall.indexOf("--") + 1);
	assert.deepEqual(tail, [mod.PI_LANDLOCK, "--rw", "/sandbox/workspace", "--rw", "/sandbox/session", "--rw", "/tmp", "--rw", "/home/pi", "--rw", "/dev/null", "--rw", "/proc", "--", "/entrypoint.sh"]);
	assert.ok(!tail.includes("/sandbox/job"), "never the job inputs");
	const env = Object.fromEntries(execCall.flatMap((a, i) => (a === "--env" ? [execCall[i + 1].split(/=(.*)/s).slice(0, 2)] : [])));
	assert.equal(env.PI_JOB_LAYOUT, "sandbox");
	assert.equal(env.PI_SESSION_FILE, "/sandbox/session/current.jsonl");
	assert.equal(env.HOME, "/home/pi");
	assert.equal(env.PI_EXIT_AUTH, "stdin");
	for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "NODE_USE_ENV_PROXY"]) assert.equal(env[name], undefined, `${name}: the layer is the egress control`);
	assert.equal(execCall[execCall.indexOf("--workdir") + 1], "/sandbox/workspace");
	assert.equal(execCall[execCall.indexOf("--timeout") + 1], "0", "the worker owns the job's timeout");
	assert.match(fake.state.stdin[0], /^[0-9a-f]{64}\n$/, "the exit key on the exec's stdin, never its argv");
	assert.ok(!execCall.some((a) => a.includes(fake.state.stdin[0].trim())), "nor its env");
	// The download REPLACED the host trees: the agent's deletion stands, its new file is there.
	assert.equal(existsSync(join(dirs.workspace, "deleted.txt")), false);
	assert.equal(readFileSync(join(dirs.workspace, "changed.txt"), "utf8"), "after\n");
	assert.equal(readFileSync(join(dirs.jobDir, "session", "current.jsonl"), "utf8"), "after\n");
	// Nothing left beside the job dir.
	for (const suffix of [".openshell-policy.json", ".openshell-up", ".openshell-down"]) assert.equal(existsSync(`${dirs.jobDir}${suffix}`), false, suffix);
});

test("a policy read back different from the one written never starts the job, and the sandbox is deleted (#683)", { skip }, async () => {
	const fake = fakeOpenshell({ policyBack: { version: 1 } });
	const logs = [];
	const dirs = jobDirs();
	await assert.rejects(
		bundle(fake, { log: (e, f) => logs.push([e, f]) }).runContainer({ job: JOB, prepared: { jobDir: dirs.jobDir, workspace: dirs.workspace, live: dirs.live }, name: "pi-job-j1", signal: new AbortController().signal }),
		(err) => err.name === "InfraRetry" && err.reason === "container-never-started",
	);
	assert.ok(!fake.state.calls.some((c) => c[2] === "exec" || c[2] === "upload"), "no upload and no exec");
	assert.ok(fake.state.calls.some((c) => c[2] === "delete"), "the sandbox it made is deleted");
	assert.ok(logs.some(([e]) => e === "openshell_policy_mismatch"));
});

test("a create that fails or is not Ready is never-started, refunded and retried, and the name is deleted anyway (#683)", { skip }, async () => {
	for (const fake of [fakeOpenshell({ failCreate: true }), fakeOpenshell({ phase: "Error" })]) {
		const dirs = jobDirs();
		await assert.rejects(bundle(fake).runContainer({ job: JOB, prepared: { jobDir: dirs.jobDir, workspace: dirs.workspace, live: dirs.live }, name: "pi-job-j1", signal: new AbortController().signal }), (err) => err.reason === "container-never-started");
		assert.ok(fake.state.calls.some((c) => c[2] === "delete"));
		assert.ok(!fake.state.calls.some((c) => c[2] === "exec"));
	}
});

test("a download that fails after the job ran is an infrastructure failure, never the job's clean exit; an aborted run downloads nothing (#683)", { skip }, async () => {
	const failing = fakeOpenshell({ failDownload: true });
	const dirs = jobDirs();
	await assert.rejects(bundle(failing).runContainer({ job: JOB, prepared: { jobDir: dirs.jobDir, workspace: dirs.workspace, live: dirs.live }, name: "pi-job-j1", signal: new AbortController().signal }), (err) => err.reason === "sandbox-download-failed");
	assert.ok(failing.state.calls.some((c) => c[2] === "delete"));
	const stopped = fakeOpenshell();
	const ac = new AbortController();
	stopped.state.exit = 143;
	stopped.state.abort = () => ac.abort();
	const dirs2 = jobDirs();
	const result = await bundle(stopped).runContainer({ job: JOB, prepared: { jobDir: dirs2.jobDir, workspace: dirs2.workspace, live: dirs2.live }, name: "pi-job-j2", signal: ac.signal });
	assert.equal(result.aborted, true);
	assert.ok(!stopped.state.calls.some((c) => c[2] === "download"));
	assert.ok(stopped.state.calls.some((c) => c[2] === "delete"));
});

test("two jobs at once: each attempt's teardown deletes its own sandbox only (#683)", { skip }, async () => {
	const fake = fakeOpenshell();
	const b = bundle(fake);
	const a = jobDirs();
	const c = jobDirs();
	await Promise.all([
		b.runContainer({ job: JOB, prepared: { jobDir: a.jobDir, workspace: a.workspace, live: a.live }, name: "pi-job-a", signal: new AbortController().signal }),
		b.runContainer({ job: { ...JOB, id: "c" }, prepared: { jobDir: c.jobDir, workspace: c.workspace, live: c.live }, name: "pi-job-c", signal: new AbortController().signal }),
	]);
	const deletes = fake.state.calls.filter((call) => call[2] === "delete").map((call) => call[3]);
	assert.deepEqual(deletes.sort(), ["pi-job-a", "pi-job-c"], "one delete each, of its own name");
});

test("the per-job venue checks: a gateway not connected retries, one not on this host or with a global policy refuses, and so does a host without Landlock (#683)", { skip }, async () => {
	const ok = await bundle(fakeOpenshell()).observationPreflight({});
	assert.deepEqual(ok, { observations: { openshellGatewayLocal: true } });
	assert.equal((await bundle(fakeOpenshell({ status: { status: "error" } })).observationPreflight({})).unavailable, true);
	const remote = await bundle(fakeOpenshell({ status: { status: "connected", server: "https://gw.example.com:17670" } })).observationPreflight({});
	assert.equal(remote.venueRefused.reason, "openshell-gateway-not-local");
	assert.equal(remote.venueRefused.comment, mod.OPENSHELL_REFUSALS["openshell-gateway-not-local"]);
	assert.equal((await bundle(fakeOpenshell({ globalPolicy: true })).observationPreflight({})).venueRefused.reason, "openshell-global-policy");
	// A global-policy read that fails any other way is not knowing: infrastructure, never a pass.
	const fake = fakeOpenshell();
	const flaky = { ...fake, exec: async (bin, args) => (args.includes("--global") ? Promise.reject(Object.assign(new Error("x"), { stderr: "connection refused" })) : fake.exec(bin, args)) };
	assert.equal((await bundle(flaky).observationPreflight({})).unavailable, true);
	assert.equal((await bundle(fakeOpenshell(), { readLsm: () => "lockdown,capability,yama" }).observationPreflight({})).venueRefused.reason, "openshell-landlock-missing");
	const logs = [];
	assert.deepEqual(await bundle(fakeOpenshell(), { platform: "darwin", log: (e, f) => logs.push([e, f]) }).observationPreflight({}), { observations: { openshellGatewayLocal: true } });
	assert.deepEqual(logs, [["openshell_landlock_unknown", { reason: "not-linux" }]], "said, never silent");
	// The CLI not answering at all is infrastructure too.
	assert.equal((await bundle({ ...fake, exec: async () => Promise.reject(new Error("ENOENT")) }).observationPreflight({})).unavailable, true);
});

test("judgeGatewayStatus: loopback and unix sockets are local, anything else is not (#683)", { skip }, () => {
	for (const server of ["https://127.0.0.1:17670", "https://localhost:17670", "https://[::1]:17670", "unix:/run/openshell.sock", "https://127.0.0.2:1"]) assert.equal(mod.judgeGatewayStatus({ status: "connected", server }).local, true, server);
	for (const server of ["https://10.0.0.5:17670", "https://gw.example.com", "not a url", null]) assert.equal(mod.judgeGatewayStatus({ status: "connected", server }).local, false, String(server));
	assert.equal(mod.judgeGatewayStatus({ status: "error", server: "https://127.0.0.1:17670" }).connected, false);
	assert.equal(mod.judgeGatewayStatus({ status: "connected_http", server: "http://127.0.0.1:8080" }).connected, true);
});

test("the host budget's reads: every page, the size labels, gone and unstarted phases; the reaper's tri-state (#683)", { skip }, async () => {
	const sandboxes = [
		{ name: "pi-job-run", phase: "Ready", labels: { "pi.dispatch.mem": "4096", "pi.dispatch.cpu": "200" } },
		{ name: "pi-job-done", phase: "Completed", labels: {} },
		{ name: "pi-job-new", phase: "Provisioning", labels: { "pi.dispatch.mem": "x" } },
		{ name: "someone-else", phase: "Ready", labels: {} },
	];
	const fake = fakeOpenshell({ sandboxes });
	const b = bundle(fake);
	assert.deepEqual(await b.listJobContainers(), [
		{ name: "pi-job-run", memMiB: 4096, cpuCenti: 200 },
		{ name: "pi-job-new", memMiB: null, cpuCenti: null },
	]);
	assert.ok(fake.state.calls.some((c) => c.includes("--page-token") && c.includes("p2")), "the second page is read");
	assert.ok(fake.state.calls.every((c) => c[2] !== "list" || c.includes("pi.dispatch.owner=pi-dispatch")), "selected by the owner label");
	assert.equal(await b.containerGone("pi-job-done"), true);
	assert.equal(await b.containerGone("pi-job-absent"), true);
	assert.equal(await b.containerGone("pi-job-run"), false);
	assert.equal(await b.containerGone("pi-job-new"), true, "unstarted: deleted, then gone");
	assert.ok(fake.state.calls.some((c) => c[2] === "delete" && c[3] === "pi-job-new"));
	assert.equal(await b.containerGone("someone-else"), null, "outside the namespace: not this worker's to answer");
	assert.equal(await bundle({ ...fake, exec: async () => Promise.reject(new Error("down")) }).containerGone("pi-job-run"), null);
	await assert.rejects(bundle({ ...fake, exec: async () => Promise.reject(new Error("down")) }).listJobContainers(), "an unanswered listing throws");
	const reaping = fakeOpenshell({ sandboxes });
	assert.deepEqual(await bundle(reaping).reap(), { reaped: true });
	assert.deepEqual(reaping.state.calls.filter((c) => c[2] === "delete").map((c) => c[3]).sort(), ["pi-job-done", "pi-job-new", "pi-job-run"]);
	assert.deepEqual(await bundle({ ...reaping, exec: async () => Promise.reject(new Error("down")) }).reap(), { reaped: false });
});

test("the image preflight reads the gateway's own engine and needs sandboxLayout on every job (#683)", { skip }, async () => {
	const calls = [];
	const spawnFn = (cmd, args) => {
		calls.push([cmd, ...args]);
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stderr = new EventEmitter();
		queueMicrotask(() => {
			child.stdout.emit("data", "sha256:abc|1.2.0|github|exitAuth,anyUid\n");
			child.emit("close", 0);
		});
		return child;
	};
	const b = mod.makeOpenshellBackend({ image: "pi-job:x", engine: "podman", spawnFn, exec: fakeOpenshell().exec });
	const answer = await b.imagePreflight({ kind: "github" });
	assert.equal(answer.sandboxLayoutUnsupported, "pi-job:x");
	assert.equal(calls[0][0], "podman");
});

test("the bundle refuses what it was not built for: another engine, a malformed gateway name, an unknown option (#683)", { skip }, () => {
	assert.throws(() => mod.makeOpenshellBackend({ image: "i", engine: "vm" }), /docker" or "podman/);
	assert.throws(() => mod.makeOpenshellBackend({ image: "i", gateway: "--evil" }), /registered gateway/);
	assert.throws(() => mod.makeOpenshellBackend({ image: "i", egress: true }), /unknown option "egress"/);
});

test("the sandbox policy lists the image's trees read-only, its writable ones read-write, no network rule, and the image's uid (#683)", { skip }, () => {
	const policy = mod.sandboxPolicy();
	assert.equal(policy.filesystem_policy.include_workdir, true);
	for (const path of ["/opt", "/app", "/sys/fs/cgroup", "/entrypoint.sh", "/ms-playwright"]) assert.ok(policy.filesystem_policy.read_only.includes(path), path);
	assert.deepEqual(policy.filesystem_policy.read_write, ["/tmp", "/dev/null", "/home/pi", "/proc"]);
	assert.equal(policy.landlock.compatibility, "hard_requirement");
	assert.deepEqual(policy.process, { run_as_user: "1001", run_as_group: "1001" });
	assert.ok(!("network_policies" in policy));
	// pi-landlock's --rw set is the policy's writable set plus the job's two writable outputs, and never the job inputs.
	assert.deepEqual([...mod.OPENSHELL_WRITABLE].sort(), ["/sandbox/workspace", "/sandbox/session", ...policy.filesystem_policy.read_write].sort());
});
