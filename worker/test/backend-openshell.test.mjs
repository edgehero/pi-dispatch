import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { BACKENDS, OPENSHELL_BACKEND } from "../src/backends.mjs";
import { READ_BACK_BY_A_LIVE_PROBE, runBackendConformance } from "../src/backend-conformance.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { transcriptRecord } from "../../image/runner/src/transcript-mirror.mjs";

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
	const exec = async (bin, args, opts = {}) => {
		if (bin === "docker" || bin === "podman") {
			state.engine = [bin, ...args];
			return { stdout: `sha256:${"a".repeat(64)}|/opt/pi-dispatch/runner-node,/usr/local/bin/node\n`, stderr: "" };
		}
		state.calls.push([bin, ...args]);
		const rest = args[0] === "--gateway" ? args.slice(2) : args;
		const [a, b] = rest;
		if (a === "status") return { stdout: JSON.stringify(status), stderr: "" };
		if (a === "policy" && rest.includes("--global")) return globalPolicy ? { stdout: JSON.stringify({ policy: {} }), stderr: "" } : reject("no global", "Error:   × code: 'Some requested entity was not found', message: \"no global policy\n  │ revision found\"");
		if (a === "provider" && b === "profile") {
			if (rest[2] === "import") state.written.profile = JSON.parse(readFileSync(rest[rest.indexOf("-f") + 1], "utf8"));
			return { stdout: "", stderr: "" };
		}
		if (a === "provider" && b === "create") {
			state.provider = { args: rest, env: opts.env ?? null };
			return { stdout: "", stderr: "" };
		}
		if (a === "provider" && b === "list") return { stdout: JSON.stringify({ providers: state.providers ?? [], next_page_token: "" }), stderr: "" };
		if (a === "provider" && b === "delete") return { stdout: "", stderr: "" };
		if (a === "sandbox" && b === "create") {
			if (failCreate) return reject("create failed", "ImagePullFailed");
			const file = rest[rest.indexOf("--policy") + 1];
			state.written.policy = JSON.parse(readFileSync(file, "utf8"));
			state.attached = rest.includes("--provider") ? rest[rest.indexOf("--provider") + 1] : null;
			return { stdout: JSON.stringify({ name: rest[rest.indexOf("--name") + 1], phase }), stderr: "" };
		}
		if (a === "policy" && b === "get") {
			// What OpenShell reads back: the body, plus an attached provider's own layer (measured).
			const body = policyBack ?? JSON.parse(JSON.stringify(state.written.policy));
			if (!policyBack && state.attached) { const key = `_provider_${state.attached.replace(/-/g, "_")}`; body.network_policies = { ...body.network_policies, [key]: { name: key } }; }
			return { stdout: JSON.stringify({ policy_source: "sandbox", policy: body }), stderr: "" };
		}
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
			// Issue #686: what the exec's stderr carries, given the key the exec was handed on its stdin.
			for (const chunk of state.stderr?.(state.stdin.at(-1)?.trim() ?? null) ?? []) child.stderr.emit("data", Buffer.from(chunk));
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
	// Held, not abstained: an abstention is `ok` too, so each driven check must have been VERIFIED.
	for (const check of ["exitCodes", "abortable", "reap", "shape", "declaration", "readOnlyJobInputs"]) {
		const found = r.findings.filter((f) => f.property === check || f.check === check);
		assert.ok(found.length > 0 && found.every((f) => f.ok && !f.unverifiable), `${check}: ${JSON.stringify(found)}`);
	}
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
	const sb = mod.sandboxNameOf("pi-job-j1");
	assert.match(sb, /^pi-job-s[0-9a-f]{11}$/);
	assert.equal(sb.length, 19, "OpenShell refuses a sandbox name past 19 characters (measured)");
	for (const pair of [["--name", sb], ["--from", `sha256:${"a".repeat(64)}`], ["--cpu", "1.5"], ["--memory", "2048Mi"]]) assert.equal(create[create.indexOf(pair[0]) + 1], pair[1], pair[0]);
	assert.deepEqual(fake.state.engine, ["docker", "image", "inspect", "--format", '{{.Id}}|{{index .Config.Labels "dev.pi-dispatch.net-binaries"}}', "pi-job:x"], "the ID and the network binaries are read from the gateway's own engine, by the job's image name");
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

test("a download that fails after the job ran keeps the run's result (its spend counted) and is never its clean exit; exit 2 stays exit 2; an aborted run downloads nothing (#683)", { skip }, async () => {
	for (const [ran, reported] of [[0, 1], [3, 1], [2, 2]]) {
		const failing = fakeOpenshell({ failDownload: true });
		failing.state.exit = ran;
		const logs = [];
		const dirs = jobDirs();
		const result = await bundle(failing, { log: (e, f) => logs.push([e, f]) }).runContainer({ job: JOB, prepared: { jobDir: dirs.jobDir, workspace: dirs.workspace, live: dirs.live }, name: "pi-job-j1", signal: new AbortController().signal });
		assert.equal(result.code, reported, `exit ${ran} is reported as ${reported}`);
		assert.equal(result.aborted, false);
		assert.ok("tokens" in result && "turns" in result, "the run's own fields ride the result, so the processor records the spend");
		assert.ok(failing.state.calls.some((c) => c[2] === "delete"));
		assert.ok(logs.some(([e, f]) => e === "openshell_download_failed" && f.code === ran));
	}
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
	assert.deepEqual(deletes.sort(), [mod.sandboxNameOf("pi-job-a"), mod.sandboxNameOf("pi-job-c")].sort(), "one delete each, of its own sandbox");
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
	const [run, done, fresh] = ["pi-job-run", "pi-job-done", "pi-job-new"].map((n) => mod.sandboxNameOf(n));
	const sandboxes = [
		{ name: run, phase: "Ready", labels: { "pi.dispatch.mem": "4096", "pi.dispatch.cpu": "200" } },
		{ name: done, phase: "Completed", labels: {} },
		{ name: fresh, phase: "Provisioning", labels: { "pi.dispatch.mem": "x" } },
		{ name: "someone-else", phase: "Ready", labels: {} },
	];
	const fake = fakeOpenshell({ sandboxes });
	const b = bundle(fake);
	// Listed by their sandbox names, which the gone-check maps to themselves, so a seeded leftover is swept.
	assert.deepEqual(await b.listJobContainers(), [
		{ name: run, memMiB: 4096, cpuCenti: 200 },
		{ name: fresh, memMiB: null, cpuCenti: null },
	]);
	assert.equal(await b.containerGone(run), false, "a sandbox name maps to itself");
	assert.ok(fake.state.calls.some((c) => c.includes("--page-token") && c.includes("p2")), "the second page is read");
	assert.ok(fake.state.calls.every((c) => c[2] !== "list" || c.includes("pi.dispatch.owner=pi-dispatch")), "selected by the owner label");
	assert.equal(await b.containerGone("pi-job-done"), true);
	assert.equal(await b.containerGone("pi-job-absent"), true);
	assert.equal(await b.containerGone("pi-job-run"), false);
	assert.equal(await b.containerGone("pi-job-new"), true, "unstarted: deleted, then gone");
	assert.ok(fake.state.calls.some((c) => c[2] === "delete" && c[3] === fresh));
	assert.equal(await b.containerGone("someone-else"), null, "outside the namespace: not this worker's to answer");
	assert.equal(await bundle({ ...fake, exec: async () => Promise.reject(new Error("down")) }).containerGone("pi-job-run"), null);
	await assert.rejects(bundle({ ...fake, exec: async () => Promise.reject(new Error("down")) }).listJobContainers(), "an unanswered listing throws");
	const reaping = fakeOpenshell({ sandboxes });
	assert.deepEqual(await bundle(reaping).reap(), { reaped: true });
	assert.deepEqual(reaping.state.calls.filter((c) => c[2] === "delete").map((c) => c[3]).sort(), [run, done, fresh].sort());
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

test("sandboxNameOf: 19 characters in the job namespace, stable, distinct per container, and a sandbox name maps to itself (#683)", { skip }, () => {
	const long = `pi-job-${"repeat_sched-ul.e_1792391515419".repeat(3)}`;
	const name = mod.sandboxNameOf(long);
	assert.equal(name.length, 19);
	assert.ok(name.startsWith("pi-job-"));
	assert.equal(mod.sandboxNameOf(long), name, "stable: the stop and the gone-check reach the sandbox the run made");
	assert.notEqual(mod.sandboxNameOf("pi-job-1"), mod.sandboxNameOf("pi-job-2"));
	assert.equal(mod.sandboxNameOf(name), name);
	assert.match(mod.sandboxNameOf("pi-job-1"), /^[a-z0-9-]+$/, "lower-case letters, digits and hyphens only");
});

test("a stop that lands while the sandbox is still being made ends the run as stopped, before any exec, and the sandbox is deleted (#683)", { skip }, async () => {
	const fake = fakeOpenshell();
	const ac = new AbortController();
	const slowExec = async (bin, args) => {
		const answer = await fake.exec(bin, args);
		// The job's timeout fires while the create is answering: abort, then the venue's own stop, as index.mjs sends them.
		if (args.includes("create")) {
			ac.abort();
			// The stop goes through the SAME bundle that runs the job, as in production.
			await slow.stopContainer("pi-job-j1");
		}
		return answer;
	};
	const slow = bundle({ ...fake, exec: slowExec });
	const dirs = jobDirs();
	const result = await slow.runContainer({ job: JOB, prepared: { jobDir: dirs.jobDir, workspace: dirs.workspace, live: dirs.live }, name: "pi-job-j1", signal: ac.signal });
	assert.deepEqual([result.code, result.aborted], [137, true]);
	assert.ok(!fake.state.calls.some((c) => c[2] === "exec" || c[2] === "upload"), "no upload and no exec after the stop");
	assert.ok(fake.state.calls.filter((c) => c[2] === "delete" && c[3] === mod.sandboxNameOf("pi-job-j1")).length >= 1, "the sandbox the create made is deleted");
});

test("the gone-check never calls a live attempt's sandbox an orphan, by either of its names (#683)", { skip }, async () => {
	const name = mod.sandboxNameOf("pi-job-live");
	const fake = fakeOpenshell({ sandboxes: [{ name, phase: "Provisioning", labels: {} }] });
	let answer;
	const b = bundle({
		...fake,
		exec: async (bin, args) => {
			// While this attempt is creating, the host budget's sweep asks about the same sandbox.
			if (args.includes("create")) answer = [await b.containerGone(name), await b.containerGone("pi-job-live")];
			return fake.exec(bin, args);
		},
	});
	const dirs = jobDirs();
	await b.runContainer({ job: JOB, prepared: { jobDir: dirs.jobDir, workspace: dirs.workspace, live: dirs.live }, name: "pi-job-live", signal: new AbortController().signal });
	assert.deepEqual(answer, [false, false], "live: not gone, not deleted");
	assert.equal(fake.state.calls.filter((c) => c[2] === "delete").length, 1, "only the attempt's own teardown deleted it");
	assert.equal(await b.containerGone(name), true, "once the attempt is over, the same unstarted leftover is deleted and gone");
});

test("a job's network policy (#684): generated from the deployment's allowlist and endpoints, written, and read back with OpenShell's one baseline addition", { skip }, async () => {
	const fake = fakeOpenshell();
	// What OpenShell 0.1.4 reads back for a policy with a network rule (measured): /var/log added read-only.
	const exec = async (bin, args) => {
		const answer = await fake.exec(bin, args);
		if (args.includes("--full")) {
			const doc = JSON.parse(answer.stdout);
			doc.policy.filesystem_policy.read_only.push("/var/log");
			return { ...answer, stdout: JSON.stringify(doc) };
		}
		return answer;
	};
	const dirs = jobDirs();
	const b = bundle({ ...fake, exec }, { readAllowlist: () => ["api.anthropic.com", ".github.com"], readEndpoints: () => [{ id: "o", host: "host.docker.internal", port: 11434, slots: 1 }] });
	const result = await b.runContainer({ job: { ...JOB, repo: "acme/widget" }, prepared: { jobDir: dirs.jobDir, workspace: dirs.workspace, live: dirs.live }, name: "pi-job-j1", signal: new AbortController().signal });
	assert.equal(result.code, 0);
	const rules = Object.values(fake.state.written.policy.network_policies);
	assert.deepEqual(rules.map((r) => `${r.endpoints[0].host}:${r.endpoints[0].port}`).sort(), ["*.github.com:443", "api.anthropic.com:443", "github.com:443", "host.docker.internal:11434"]);
	assert.deepEqual(rules[0].binaries, [{ path: "/opt/pi-dispatch/runner-node" }, { path: "/usr/local/bin/node" }], "the runner's node, then the image's own declared binaries");
	// The same written body without the baseline addition would be a mismatch, and is: never started.
	const strict = fakeOpenshell();
	const dirs2 = jobDirs();
	const exact = bundle({ ...strict, exec: async (bin, args) => { const a = await strict.exec(bin, args); if (args.includes("--full")) { const d = JSON.parse(a.stdout); d.policy.filesystem_policy.read_only.push("/var/log", "/srv"); return { ...a, stdout: JSON.stringify(d) }; } return a; } }, { readAllowlist: () => ["api.anthropic.com"] });
	await assert.rejects(exact.runContainer({ job: JOB, prepared: { jobDir: dirs2.jobDir, workspace: dirs2.workspace, live: dirs2.live }, name: "pi-job-j2", signal: new AbortController().signal }), (err) => err.reason === "container-never-started", "anything beyond the measured addition refuses");
});

test("an egress source the venue cannot translate refuses the job before spend, with the entry in the log only (#684)", { skip }, async () => {
	const logs = [];
	const refused = await bundle(fakeOpenshell(), { readAllowlist: () => [".com"], log: (e, f) => logs.push([e, f]) }).observationPreflight({ kind: "github", repo: "a/b" });
	assert.equal(refused.venueRefused.reason, "openshell-egress-untranslatable");
	assert.equal(refused.venueRefused.comment, mod.OPENSHELL_REFUSALS["openshell-egress-untranslatable"]);
	assert.doesNotMatch(refused.venueRefused.comment, /\.com/, "the entry never reaches a forge comment");
	assert.ok(logs.some(([e, f]) => e === "openshell_policy_untranslatable" && f.entry === ".com"));
	const unread = await bundle(fakeOpenshell(), { readAllowlist: () => { throw new Error("EACCES"); } }).observationPreflight({ kind: "github" });
	assert.equal(unread.unavailable, true, "a source that cannot be read is infrastructure");
});

test("the staged job's mcp.json moves overlay commands to the sandbox layout; the host's file is untouched (#684)", { skip }, async () => {
	const fake = fakeOpenshell();
	const dirs = jobDirs();
	const doc = { version: 1, servers: { local: { command: "/opt/pi-global/mcp/bin/server", args: ["--root", "/opt/pi-global/mcp/data", "-v"] }, forge: { command: "/usr/local/bin/forge-mcp-github" } } };
	writeFileSync(join(dirs.jobDir, "mcp.json"), JSON.stringify(doc), { mode: 0o444 });
	let staged = null;
	const exec = async (bin, args) => {
		if (args.includes("upload") && args.some((a) => a.endsWith("/job"))) staged = JSON.parse(readFileSync(join(args.find((a) => a.endsWith("/job")), "mcp.json"), "utf8"));
		return fake.exec(bin, args);
	};
	await bundle({ ...fake, exec }).runContainer({ job: JOB, prepared: { jobDir: dirs.jobDir, workspace: dirs.workspace, live: dirs.live }, name: "pi-job-j1", signal: new AbortController().signal });
	assert.deepEqual(staged.servers.local, { command: "/sandbox/pi-global/mcp/bin/server", args: ["--root", "/sandbox/pi-global/mcp/data", "-v"] });
	assert.deepEqual(staged.servers.forge, { command: "/usr/local/bin/forge-mcp-github" }, "a baked command is not the overlay's");
	assert.deepEqual(JSON.parse(readFileSync(join(dirs.jobDir, "mcp.json"), "utf8")), doc, "the host's own copy is as the preparer wrote it");
});

test("an image without /var/log reads back as written, which is also accepted; any other difference is not (#684)", { skip }, async () => {
	const fake = fakeOpenshell();
	const dirs = jobDirs();
	const result = await bundle(fake, { readAllowlist: () => ["api.anthropic.com"] }).runContainer({ job: JOB, prepared: { jobDir: dirs.jobDir, workspace: dirs.workspace, live: dirs.live }, name: "pi-job-j1", signal: new AbortController().signal });
	assert.equal(result.code, 0, "the fake reads back exactly the body written");
	assert.deepEqual(mod.expectedPolicies({ version: 1 }), [{ version: 1 }], "no rule, nothing added");
});

test("credentials (#684): every secret goes into a per-job provider by the CLI's ENV, none onto any argv, and every endpoint is bound to it", { skip }, async () => {
	const fake = fakeOpenshell();
	const dirs = jobDirs();
	const b = bundle(fake, { readAllowlist: () => ["api.anthropic.com", ".github.com"], hostEnv: { ANTHROPIC_API_KEY: "sk-ant-real-provider-key-0001" } });
	const result = await b.runContainer({ job: { ...JOB, repo: "acme/widget" }, token: "ghs_real_forge_token_0002", prepared: { jobDir: dirs.jobDir, workspace: dirs.workspace, live: dirs.live }, name: "pi-job-j1", signal: new AbortController().signal, exitAuth: true });
	assert.equal(result.code, 0);
	const sb = mod.sandboxNameOf("pi-job-j1");
	// The profile names the secrets; the provider is made of it with the values in the child's ENV only.
	const names = fake.state.written.profile.credentials.map((c) => c.env_vars[0]).sort();
	assert.deepEqual(names, ["ANTHROPIC_API_KEY", "GH_TOKEN", "GITHUB_TOKEN"]);
	assert.equal(fake.state.written.profile.id, sb);
	assert.deepEqual(fake.state.written.profile.credentials.map((c) => Object.keys(c).sort()), names.map(() => ["env_vars", "name", "required"]), "endpointless: no endpoint, no binary");
	assert.equal(fake.state.provider.env.ANTHROPIC_API_KEY, "sk-ant-real-provider-key-0001");
	assert.equal(fake.state.provider.env.GH_TOKEN, "ghs_real_forge_token_0002");
	for (const call of fake.state.calls) {
		const flat = call.join(" ");
		assert.ok(!flat.includes("sk-ant-real-provider-key-0001") && !flat.includes("ghs_real_forge_token_0002"), `no value on any argv: ${call.slice(0, 4).join(" ")}`);
	}
	assert.ok(fake.state.calls.find((c) => c[2] === "create" && c[1] === "sandbox").includes("--provider"));
	for (const rule of Object.values(fake.state.written.policy.network_policies)) for (const e of rule.endpoints) assert.deepEqual(e.credential_binding, { provider: sb });
	// The exec carries no secret name, and the git helper names the token's placeholder.
	const execCall = fake.state.calls.find((c) => c[2] === "exec");
	const env = Object.fromEntries(execCall.flatMap((a, i) => (a === "--env" ? [execCall[i + 1].split(/=(.*)/s).slice(0, 2)] : [])));
	for (const name of names) assert.equal(env[name], undefined, name);
	assert.equal(env.GIT_CONFIG_KEY_0, "credential.helper");
	assert.match(env.GIT_CONFIG_VALUE_0, /username=x-access-token; echo "password=\$GITHUB_TOKEN"/);
	// A leftover of an earlier attempt removed first (review M2); teardown: the sandbox, then its provider and profile.
	const order = fake.state.calls.map((c) => c.slice(1, 4).join(" ")).filter((s) => /delete/.test(s));
	assert.deepEqual(order, [`provider delete ${sb}`, `provider profile delete`, `sandbox delete ${sb}`, `provider delete ${sb}`, `provider profile delete`]);
	assert.ok(fake.state.calls.findIndex((c) => c[1] === "provider" && c[2] === "profile" && c[3] === "import") > fake.state.calls.findIndex((c) => c[1] === "provider" && c[2] === "profile" && c[3] === "delete"), "the stale removal comes before the import");
	for (const suffix of [".openshell-profile.json", ".openshell-policy.json"]) assert.equal(existsSync(`${dirs.jobDir}${suffix}`), false, suffix);
});

test("no rule, no provider: a deny-all job's secrets go nowhere, said in the log (#684)", { skip }, async () => {
	const fake = fakeOpenshell();
	const logs = [];
	const dirs = jobDirs();
	await bundle(fake, { log: (e, f) => logs.push([e, f]) }).runContainer({ job: JOB, prepared: { jobDir: dirs.jobDir, workspace: dirs.workspace, live: dirs.live }, name: "pi-job-j1", signal: new AbortController().signal });
	assert.equal(fake.state.provider, undefined);
	assert.ok(logs.some(([e]) => e === "openshell_secrets_unbound"));
	assert.ok(!fake.state.calls.find((c) => c[2] === "create" && c[1] === "sandbox").includes("--provider"));
});

test("a provider still attached is deleted again until its sandbox's cleanup lets it; the reaper deletes a crashed job's (#684)", { skip }, async () => {
	const fake = fakeOpenshell();
	let refusals = 2;
	const exec = async (bin, args, opts) => {
		if (args[0] === "provider" && args[1] === "delete" && refusals-- > 0) return Promise.reject(Object.assign(new Error("attached"), { stderr: "is attached to sandbox(es)" }));
		return fake.exec(bin, args, opts);
	};
	const dirs = jobDirs();
	await bundle({ ...fake, exec }, { readAllowlist: () => ["api.anthropic.com"], delay: async () => {} }).runContainer({ job: JOB, prepared: { jobDir: dirs.jobDir, workspace: dirs.workspace, live: dirs.live }, name: "pi-job-j1", signal: new AbortController().signal });
	assert.equal(fake.state.calls.filter((c) => c[1] === "provider" && c[2] === "delete").length, 1, "the third try, the first the fake recorded, took");
	const reaping = fakeOpenshell();
	reaping.state.providers = [{ name: mod.sandboxNameOf("pi-job-old") }, { name: "someone-elses" }];
	assert.deepEqual(await bundle(reaping, { delay: async () => {} }).reap(), { reaped: true });
	assert.deepEqual(reaping.state.calls.filter((c) => c[1] === "provider" && c[2] === "delete").map((c) => c[3]), [mod.sandboxNameOf("pi-job-old")], "only this worker's namespace");
});

test("gitCredentialEnv: the forge whose token the env carries, its placeholder by name, never a value (#684)", { skip }, () => {
	assert.equal(mod.gitCredentialEnv({ ANTHROPIC_API_KEY: "x" }), null);
	assert.match(mod.gitCredentialEnv({ GITLAB_TOKEN: "glpat-x" }).GIT_CONFIG_VALUE_0, /username=oauth2; echo "password=\$GITLAB_TOKEN"/);
	assert.match(mod.gitCredentialEnv({ FORGEJO_TOKEN: "f" }).GIT_CONFIG_VALUE_0, /password=\$FORGEJO_TOKEN/);
	assert.ok(!JSON.stringify(mod.gitCredentialEnv({ GH_TOKEN: "ghs_secret" })).includes("ghs_secret"));
	assert.deepEqual(mod.secretNamesOf({ PI_PROVIDER: "anthropic", PI_JOB_LAYOUT: "sandbox", HOME: "/home/pi", ANTHROPIC_API_KEY: "k", EMPTY: "", "bad-name": "v" }), ["ANTHROPIC_API_KEY"]);
});

test("the boot's reaper on its own sweeps what the bundle's would, through the gateway it names (#684)", { skip }, async () => {
	const reaping = fakeOpenshell({ sandboxes: [{ name: mod.sandboxNameOf("pi-job-old"), phase: "Ready", labels: {} }] });
	reaping.state.providers = [{ name: mod.sandboxNameOf("pi-job-old") }];
	const seen = [];
	const exec = (bin, args, opts) => (seen.push(args), reaping.exec(bin, args.slice(2), opts));
	assert.deepEqual(await mod.makeOpenshellReaper({ gateway: "lab", exec, delay: async () => {} })(), { reaped: true });
	assert.ok(seen.every((a) => a[0] === "--gateway" && a[1] === "lab"));
	assert.ok(reaping.state.calls.some((c) => c[1] === "sandbox" && c[2] === "delete"));
	assert.ok(reaping.state.calls.some((c) => c[1] === "provider" && c[2] === "delete"));
	assert.deepEqual(await mod.makeOpenshellReaper({ exec: async () => Promise.reject(new Error("down")) })(), { reaped: false });
});

test("the boot's release judgement: the tested CLI and gateway pass, another release refuses, a silent CLI is transient, a gateway down refuses nothing (#684)", { skip }, async () => {
	const answers = (version, status) => async (_bin, args) => {
		if (args.includes("--version")) return version === null ? Promise.reject(new Error("ENOENT")) : { stdout: `openshell ${version}\n` };
		if (args.includes("status")) return { stdout: JSON.stringify(status) };
		throw new Error(`unexpected ${args.join(" ")}`);
	};
	const up = { status: "connected", server: "https://127.0.0.1:17670", version: mod.OPENSHELL_TESTED_VERSION };
	assert.deepEqual(await mod.openshellBootVersions({ exec: answers(mod.OPENSHELL_TESTED_VERSION, up) }), {});
	const cli = await mod.openshellBootVersions({ exec: answers("0.1.5", up) });
	assert.equal(cli.transient, false);
	assert.match(cli.refusal, /CLI is 0\.1\.5, not 0\.1\.4/);
	const gw = await mod.openshellBootVersions({ exec: answers(mod.OPENSHELL_TESTED_VERSION, { ...up, version: "0.2.0" }) });
	assert.equal(gw.transient, false);
	assert.match(gw.refusal, /gateway runs 0\.2\.0/);
	assert.equal((await mod.openshellBootVersions({ exec: answers(null, up) })).transient, true);
	assert.deepEqual(await mod.openshellBootVersions({ exec: answers(mod.OPENSHELL_TESTED_VERSION, { status: "error" }) }), { gatewayDown: true });
	const calls = [];
	await mod.openshellBootVersions({ gateway: "lab", exec: async (bin, args) => (calls.push(args), answers(mod.OPENSHELL_TESTED_VERSION, up)(bin, args)) });
	assert.ok(calls.every((a) => a[0] === "--gateway" && a[1] === "lab"));
});

test("a provider that reads its key's value is refused before spend; recover is refused unless the job is local; an untested gateway is refused per job (#684 review)", { skip }, async () => {
	for (const provider of mod.VALUE_READING_PROVIDERS) {
		const r = await bundle(fakeOpenshell()).observationPreflight({ ...JOB, provider });
		assert.equal(r.venueRefused?.reason, "openshell-credential-reads-value", provider);
	}
	assert.equal((await bundle(fakeOpenshell(), { hostEnv: { ANTHROPIC_API_KEY: "sk-ant-oat01-x" } }).observationPreflight(JOB)).venueRefused?.reason, "openshell-credential-reads-value");
	assert.equal((await bundle(fakeOpenshell(), { hostEnv: { ANTHROPIC_OAUTH_TOKEN: "t" } }).observationPreflight(JOB)).venueRefused?.reason, "openshell-credential-reads-value");
	assert.equal((await bundle(fakeOpenshell(), { hostEnv: { ANTHROPIC_API_KEY: "sk-ant-api03-x" } }).observationPreflight(JOB)).venueRefused, undefined, "an API key is sent as it is");
	assert.equal((await bundle(fakeOpenshell()).observationPreflight({ ...JOB, recover: true })).venueRefused?.reason, "openshell-recover-unsupported");
	assert.equal((await bundle(fakeOpenshell()).observationPreflight({ ...JOB, kind: "local", recover: true })).venueRefused, undefined, "a local job runs unarmed, as everywhere");
	const untested = await bundle(fakeOpenshell({ status: { status: "connected", server: "https://127.0.0.1:17670", version: "0.1.5" } })).observationPreflight(JOB);
	assert.equal(untested.venueRefused?.reason, "openshell-gateway-untested");
	for (const reason of ["openshell-credential-reads-value", "openshell-gateway-untested", "openshell-recover-unsupported"]) assert.equal(typeof mod.OPENSHELL_REFUSALS[reason], "string", reason);
});

test("a secret no provider can carry reaches neither the provider nor the exec argv, and is named in the log (#684 review H1)", { skip }, async () => {
	const long = "A".repeat(130);
	const args = mod.openshellExecArgs({ name: "pi-job-sx", env: { PI_PROVIDER: "anthropic", "bad-name": "secretvalue", [long]: "longsecret", ANTHROPIC_API_KEY: "k" } });
	assert.ok(!args.join(" ").includes("secretvalue") && !args.join(" ").includes("longsecret") && !args.join(" ").includes("=k"));
	assert.ok(args.includes("PI_PROVIDER=anthropic"));
	assert.deepEqual(mod.unbindableSecretNamesOf({ "bad-name": "v", [long]: "v", OK_NAME: "v", PI_PROVIDER: "x" }), ["bad-name", long]);
});

test("a gone sandbox's provider is deleted by the gone-check (#684 review M3)", { skip }, async () => {
	const fake = fakeOpenshell({ sandboxes: [] });
	assert.equal(await bundle(fake).containerGone("pi-job-gone"), true);
	await new Promise((r) => setImmediate(r));
	assert.ok(fake.state.calls.some((c) => c[1] === "provider" && c[2] === "delete" && c[3] === mod.sandboxNameOf("pi-job-gone")));
});

test("the live transcript over the exec's stderr (#686): PI_TRANSCRIPT on --env, the opener on the stdio source, the records verified and kept out of the output", { skip }, async () => {
	const fake = fakeOpenshell();
	fake.state.stderr = (key) => {
		const records = transcriptRecord(key, "pi-job-j1", 1, "b", 0) + transcriptRecord(key, "pi-job-j1", 2, "l", 19, Buffer.from('{"type":"session"}'));
		return ["openshell: a line of its own\n", records.slice(0, 9), records.slice(9)];
	};
	const opened = [];
	const pushed = [];
	const output = [];
	const openLiveTranscript = (args) => (opened.push(args), { start() {}, finish: async () => {}, push: (l) => pushed.push(l.toString()), skip() {}, reset() {}, progressSummary: () => null });
	const dirs = jobDirs();
	const b = bundle(fake, { openLiveTranscript, onOutput: (c) => output.push(String(c)) });
	await b.runContainer({ job: JOB, prepared: { jobDir: dirs.jobDir, workspace: dirs.workspace, live: dirs.live }, name: "pi-job-j1", signal: new AbortController().signal, exitAuth: true, transcriptStderr: true, jobId: "j1" });
	const execOf = (state) => state.calls.find((c) => c[1] === "sandbox" && c[2] === "exec");
	const execCall = execOf(fake.state);
	assert.ok(execCall.includes("PI_TRANSCRIPT=stderr"), "a structural name, so it rides the exec's --env and is never a provider placeholder");
	assert.equal(opened.length, 1);
	assert.equal(opened[0].source, "stdio");
	assert.deepEqual(pushed, ['{"type":"session"}']);
	assert.equal(output.join(""), "openshell: a line of its own\n");
	// Without the image's capability: no variable, no publisher, and the skip said by name.
	const logs = [];
	const fake2 = fakeOpenshell();
	await bundle(fake2, { openLiveTranscript, log: (e, f) => logs.push([e, f]) }).runContainer({ job: JOB, prepared: { jobDir: dirs.jobDir, workspace: dirs.workspace, live: dirs.live }, name: "pi-job-j2", signal: new AbortController().signal, exitAuth: true, jobId: "j2" });
	assert.ok(!execOf(fake2.state).includes("PI_TRANSCRIPT=stderr"));
	assert.deepEqual(logs.filter(([e]) => e === "live_transcript_skipped"), [["live_transcript_skipped", { container: "pi-job-j2", reason: "no-capability" }]]);
	assert.equal(opened.length, 1);
});
