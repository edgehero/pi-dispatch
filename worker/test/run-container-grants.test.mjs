import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { grantText } from "../src/endpoint-grants.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #918 (DES-PRIVATE-ENDPOINT-GRANTS): the grant at the container's start. run-container imports env-allowlist ->
// @earendil-works/pi-ai, so this skips below the node floor and runs in CI, as run-container.test.mjs does.
let mod;
let importError;
try {
	mod = await import("../src/run-container.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error(`run-container tests are REQUIRED here but pi-ai could not import.\n${importError}`);
const skip = mod ? false : `pi-ai not installed (node ${process.version} < 22.19.0); CI runs these`;

const HOST = { ANTHROPIC_API_KEY: "sk-real" };
const JOB = { kind: "local", provider: "anthropic", model: "m", maxTurns: 5 };
const PREPARED = { workspace: "/host/folder", jobDir: "/host/jobs/j1" };
const NAME = "pi-job-j1";
const NETWORK = `${NAME}-net`;
const BENCH = { id: "bench-device", host: "10.0.5.20", port: 22, slots: 1 };
const CID = "d".repeat(64);

/** An in-memory fs for the cidfile only; the grants go to a real folder. */
function cidFs() {
	const files = {};
	return {
		files,
		readFileSync: (p) => {
			if (files[p] === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
			return files[p];
		},
		rmSync: (p) => {
			delete files[p];
		},
	};
}

/**
 * A docker that answers every step of an armed job: the network both ways, the proxy's address on the job's network,
 * the helper's read back (`readBack`: "ok", "err"), the run. `onRun` sees the grant folder at the moment of the run.
 */
function docker({ fs, readBack = "ok", dir, onRun = () => {} }) {
	const atNetworkRm = [];
	const steps = [];
	const spawnFn = (cmd, args) => {
		steps.push(`${args[0]} ${args[1] ?? ""}`.trim());
		const child = new EventEmitter();
		child.stdout = new EventEmitter();
		child.stdout.setEncoding = () => {};
		child.stderr = new EventEmitter();
		child.kill = () => {};
		// The helper's read back answers what it is asked on stdin, a line per question; every other step ignores stdin.
		child.stdin = {
			write: () => {},
			on: () => {},
			end: (input = "") => {
				if (args[0] !== "exec") return;
				queueMicrotask(() => {
					const asked = String(input).split("\n").filter(Boolean);
					child.stdout.emit("data", asked.map(() => (readBack === "ok" ? "OK" : "ERR")).join("\n") + "\n");
					child.emit("close", 0);
				});
			},
		};
		if (args[0] === "exec") return child;
		if (args[0] === "network" && args[1] === "rm") atNetworkRm.push(readdirSync(dir).length);
		queueMicrotask(() => {
			if (args[0] === "inspect") child.stdout.emit("data", JSON.stringify({ [NETWORK]: { IPAddress: "192.168.148.2", IPPrefixLen: 24 } }));
			if (args[0] === "run") {
				onRun(readdirSync(dir).map((n) => [n, readFileSync(join(dir, n), "utf8")]));
				const cidFile = args.find((a) => a.startsWith("--cidfile="))?.slice("--cidfile=".length);
				if (cidFile) fs.files[cidFile] = CID;
			}
			if (args[0] === "ps") child.stdout.emit("data", `${CID} exited\n`);
			if (args[0] === "info") child.stdout.emit("data", JSON.stringify({ ServerVersion: "27.4.0", OperatingSystem: "Ubuntu", SecurityOptions: [] }));
			child.emit("close", 0);
		});
		return child;
	};
	return { spawnFn, steps, atNetworkRm };
}

const instantCheck = () => {
	let t = 0;
	return { now: () => t, delay: async (ms) => (t += ms) };
};

test("a granted job's grant is written and read back before the run, and removed before its network", { skip }, async () => {
	const dir = tempDir("pi-grants-run-");
	writeFileSync(join(dir, "192.168.148.2"), grantText("pi-job-gone-net", ["lab"]));
	const fs = cidFs();
	let atRun = null;
	const rec = docker({ fs, dir, onRun: (seen) => (atRun = seen) });
	const run = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn: rec.spawnFn, fs, egress: true, grantsDir: dir, detachedCheck: instantCheck() });
	const result = await run({ job: JOB, prepared: { ...PREPARED }, name: NAME, signal: new AbortController().signal, privateEndpoints: [BENCH] });
	assert.equal(result.code, 0);
	assert.deepEqual(atRun, [["192.168.148.2", grantText(NETWORK, ["bench-device"])]], "the stale grant replaced by this job's, before the run");
	assert.deepEqual(readdirSync(dir), [], "gone after the run");
	assert.deepEqual(rec.atNetworkRm, [0], "and gone BEFORE its network, so the freed subnet never meets it");
	const order = (verb) => rec.steps.findIndex((s) => s.startsWith(verb));
	assert.ok(order("network create") < order("inspect") && order("inspect") < order("exec") && order("exec") < order("run"), rec.steps.join(", "));
});

test("a granted job is never started when its grant does not read back: the network goes, and the attempt is retried", { skip }, async () => {
	const dir = tempDir("pi-grants-run-");
	const fs = cidFs();
	const logs = [];
	const rec = docker({ fs, dir, readBack: "err" });
	const run = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn: rec.spawnFn, fs, egress: true, grantsDir: dir, detachedCheck: instantCheck(), log: (e, f) => logs.push([e, f]) });
	await assert.rejects(run({ job: JOB, prepared: { ...PREPARED }, name: NAME, signal: new AbortController().signal, privateEndpoints: [BENCH] }), (e) => e.reason === "container-never-started");
	assert.ok(!rec.steps.some((s) => s.startsWith("run")), "no container");
	assert.ok(rec.steps.some((s) => s.startsWith("network rm")), "its network removed");
	assert.deepEqual(readdirSync(dir), [], "the grant it wrote removed too");
	assert.deepEqual(logs.find(([e]) => e === "endpoint_grant_failed")?.[1], { network: NETWORK, why: "grant-unreadable" });
});

test("a job with no grant on an empty grant folder asks the proxy nothing, and one with a grant but no folder is refused", { skip }, async () => {
	const dir = tempDir("pi-grants-run-");
	const fs = cidFs();
	const rec = docker({ fs, dir });
	const run = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn: rec.spawnFn, fs, egress: true, grantsDir: dir, detachedCheck: instantCheck() });
	await run({ job: JOB, prepared: { ...PREPARED }, name: NAME, signal: new AbortController().signal });
	assert.ok(!rec.steps.some((s) => s.startsWith("inspect") || s.startsWith("exec")), rec.steps.join(", "));
	const bare = docker({ fs: cidFs(), dir });
	const noFolder = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn: bare.spawnFn, fs: cidFs(), egress: true, detachedCheck: instantCheck() });
	await assert.rejects(noFolder({ job: JOB, prepared: { ...PREPARED }, name: NAME, signal: new AbortController().signal, privateEndpoints: [BENCH] }), (e) => e.reason === "container-never-started");
	assert.ok(!bare.steps.some((s) => s.startsWith("run")));
	assert.equal(existsSync(join(dir, "192.168.148.2")), false);
});

test("the granted job's env names each endpoint's host and port, and nothing else does", { skip }, async () => {
	const dir = tempDir("pi-grants-run-");
	const fs = cidFs();
	let runArgs = null;
	const rec = docker({ fs, dir });
	const spawnFn = (cmd, args) => {
		if (args[0] === "run") runArgs = args;
		return rec.spawnFn(cmd, args);
	};
	const run = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn, fs, egress: true, grantsDir: dir, detachedCheck: instantCheck() });
	await run({ job: JOB, prepared: { ...PREPARED }, name: NAME, signal: new AbortController().signal, privateEndpoints: [BENCH] });
	const env = runArgs.flatMap((a, i, all) => (a === "-e" ? [all[i + 1]] : [])).filter((e) => e.startsWith("PI_DISPATCH_ENDPOINT_"));
	assert.deepEqual(env.sort(), ["PI_DISPATCH_ENDPOINT_BENCH_DEVICE_HOST=10.0.5.20", "PI_DISPATCH_ENDPOINT_BENCH_DEVICE_PORT=22"]);
});

test("a job granted nothing still has a stale grant in its subnet cleared before it runs: the guarantee, not only granted jobs' (#918 review)", { skip }, async () => {
	const dir = tempDir("pi-grants-run-");
	writeFileSync(join(dir, "192.168.148.2"), grantText("pi-job-gone-net", ["bench-device"]));
	writeFileSync(join(dir, "10.9.0.2"), grantText("pi-job-other-net", ["lab"]));
	const fs = cidFs();
	let atRun = null;
	const rec = docker({ fs, dir, onRun: (seen) => (atRun = seen) });
	const run = mod.makeRunContainer({ image: "pi-job:x", hostEnv: HOST, spawnFn: rec.spawnFn, fs, egress: true, grantsDir: dir, detachedCheck: instantCheck() });
	await run({ job: JOB, prepared: { ...PREPARED }, name: NAME, signal: new AbortController().signal });
	assert.deepEqual(atRun.map(([n]) => n), ["10.9.0.2"], "the gone network's grant at this job's address was gone before the run; another subnet's stays");
	assert.ok(!rec.steps.some((s) => s.startsWith("exec")), "nothing to read back for a job granted nothing");
});
