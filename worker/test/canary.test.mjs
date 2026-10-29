import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, writeFileSync, mkdirSync, symlinkSync, readdirSync, existsSync } from "node:fs";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { canaryOptions, selectCanarySources, executeCanary, canaryText } from "../src/canary.mjs";
import { runCanary } from "../src/canary-cli.mjs";
import { createCanaryRuntime, canaryProxyPolicy, copyCanaryObjects, CANARY_PROXY_IMAGE } from "../src/canary-runtime.mjs";
import { builtinChatModels } from "../src/model-catalog.mjs";
import { recordedCanary, buildRecord } from "../src/run-history.mjs";
import { acquireCanaryLease, canaryQueueNames, readBusy, CANARY_LOCK_KEY } from "../src/canary-lock.mjs";

const instant = Date.parse("2026-10-28T12:00:00Z");
const now = () => instant;
const options = canaryOptions({ role: "editor", model: "anthropic/model", flow: "edit", capUsd: "1", count: 3 });
const original = (id, extra = {}) => ({ jobId: id, flow: "edit", modelRole: "editor", provider: "anthropic", model: "old", outcome: "completed", endedAt: new Date(instant - 1000).toISOString(), tokens: { cost: 0.1 }, ...extra });

test("canary requires explicit valid role, physical candidate, flow and aggregate dollar cap", () => {
	for (const update of [{ capUsd: undefined }, { capUsd: "0" }, { role: "inherit" }, { role: "../editor" }, { model: "role:editor" }, { count: "1.5" }, { count: "11" }, { flow: "../flow" }]) assert.throws(() => canaryOptions({ role: "editor", model: "anthropic/model", flow: "edit", capUsd: "1", ...update }));
});

test("source selection binds flow and main-session role, excludes canaries/future/expired/failures", () => {
	const good = original("one");
	assert.deepEqual(selectCanarySources([good, original("other-role", { modelRole: "planner" }), original("other-flow", { flow: "plan" }), original("canary", { canary: {} }), original("future", { endedAt: new Date(instant + 1).toISOString() }), original("old", { endedAt: new Date(instant - 8 * 86400_000).toISOString() }), original("failed", { outcome: "failed" })], options, { now: instant }), [good]);
});

test("all sources are verified before paying; aggregate cap never recycles an unreported cost", async () => {
	const records = [original("one"), original("two"), original("three")], snapshot = JSON.stringify(records), events = [];
	let next = 0;
	const report = await executeCanary(options, { records, now, deploymentCapUsd: "0.2", id: () => `new-${++next}`, inspectSource: async (r) => { events.push(`inspect:${r.jobId}`); return r; }, execute: async ({ maxCostMicros }) => { events.push("execute"); assert.equal(maxCostMicros, 200000); return { outcome: "completed", tokens: null }; } });
	assert.deepEqual(events.slice(0, 3), ["inspect:one", "inspect:three", "inspect:two"]);
	assert.equal(report.allocatedMicros, 600000);
	assert.equal(JSON.stringify(records), snapshot);
	assert.equal(report.rows[0].sourceJobId, "one");
	assert.match(canaryText(report), /one.*0.100000.*completed.*new-1.*unknown.*completed/);
	assert.match(report.whatIf, /whatif=anthropic%2Fmodel&flow=edit/);
	let paid = 0;
	await assert.rejects(executeCanary(options, { records, now, inspectSource: async () => { throw new Error("expired"); }, execute: async () => { paid++; } }), /expired/);
	assert.equal(paid, 0);
});

test("CLI runs the real orchestration and closes the runtime on success and refusal", async () => {
	let closed = 0, output = "", errors = "";
	const runtimeFactory = async () => ({ records: [original("one")], inspectSource: async (r) => r, execute: async () => ({ outcome: "completed" }), close: async () => closed++ });
	const args = ["--role", "editor", "--model", "anthropic/model", "--flow", "edit", "--cap-usd", "1", "--json"];
	assert.equal(await runCanary(args, { now, runtimeFactory, write: (s) => output += s }), 0);
	assert.equal(JSON.parse(output).rows.length, 1);
	assert.equal(closed, 1);
	assert.equal(await runCanary(args.filter((v) => v !== "--json"), { now, runtimeFactory: async () => ({ ...await runtimeFactory(), inspectSource: async () => { throw new Error("source missing"); } }), errWrite: (s) => errors += s }), 1);
	assert.match(errors, /source missing/);
	assert.equal(closed, 2);
	assert.match(readFileSync(new URL("../src/cli.mjs", import.meta.url), "utf8"), /cmd === "canary"[\s\S]*runCanary\(argv.slice\(1\)/);
});

test("CLI credential reconciliation never prints either credential or a Valkey password", async () => {
	let output = "", created = false;
	const result = await runCanary(["--role", "editor", "--model", "anthropic/model", "--flow", "edit", "--cap-usd", "1"], { now, deploymentEnv: (env, keys) => keys.includes("ANTHROPIC_API_KEY") ? { problem: "secret-first differs from secret-second at redis://user:password@host" } : { env }, runtimeFactory: async () => { created = true; }, errWrite: (s) => output += s });
	assert.equal(result, 1); assert.equal(created, false);
	assert.match(output, /cannot be reconciled/); assert.doesNotMatch(output, /secret-first|secret-second|password/);
});

test("unsupported venue and budget admission refuse before any Docker or provider operation", async () => {
	const root = tempDir("canary-refusal-");
	let operations = 0;
	for (const extra of [{ PI_ENVELOPE_FILE: join(root, "envelope.json") }, { PI_SCOPED_LIMITS_FILE: join(root, "limits.json") }, { PI_PAUSE_WINDOWS_FILE: join(root, "pause.json") }, { PI_HOST_MEMORY_BUDGET: "8g" }, { PI_MODEL_ENDPOINTS_FILE: join(root, "endpoints.json") }]) await assert.rejects(createCanaryRuntime({ env: { PI_SETTINGS_FILE: join(root, "settings.json"), ...extra }, options, now, execCommand: async () => { operations++; } }), /cannot bypass|cannot use declared/);
	assert.equal(operations, 0);
});

test("provider-only policy is exact-host TLS-only and rejects gateways before Docker", () => {
	const policy = canaryProxyPolicy("anthropic");
	assert.match(policy, /dstdomain api\.anthropic\.com\n/);
	assert.match(policy, /http_access allow CONNECT tls provider\nhttp_access deny all/);
	assert.doesNotMatch(policy, /github|gitlab|forgejo|dev\.azure|http_access allow all/);
	assert.throws(() => canaryProxyPolicy("openrouter"), /cannot establish a no-forge boundary/);
	assert.ok(readFileSync(new URL("../../deploy/docker-compose.yml", import.meta.url), "utf8").includes(CANARY_PROXY_IMAGE));
});

test("object copy refuses links and alternates without reading host data", () => {
	const root = tempDir("canary-objects-"), source = join(root, "source"), dest = join(root, "dest");
	mkdirSync(source); mkdirSync(join(source, "info"));
	writeFileSync(join(source, "info", "alternates"), "/private/objects");
	assert.throws(() => copyCanaryObjects(source, dest), /alternate object stores/);
	const linked = join(root, "linked"); mkdirSync(linked);
	writeFileSync(join(root, "secret"), "private"); symlinkSync(join(root, "secret"), join(linked, "object"));
	assert.throws(() => copyCanaryObjects(linked, join(root, "dest-two")), /unsupported/);
	assert.ok(!existsSync(join(root, "dest-two", "object")));
});

test("run lineage is rebuilt and rejects task text, paths and malformed candidates", () => {
	const value = { sourceJobId: "one", role: "editor", candidate: "anthropic/model", task: "private" };
	assert.deepEqual(recordedCanary(value), { sourceJobId: "one", role: "editor", candidate: "anthropic/model" });
	for (const update of [{ sourceJobId: "../secret" }, { role: "inherit" }, { candidate: "unknown" }, { sourceJobId: "x".repeat(201) }]) assert.equal(recordedCanary({ ...value, ...update }), null);
	assert.deepEqual(buildRecord({ job: { id: "canary-one", data: { kind: "local", canary: value } }, result: { outcome: "completed" } }).canary, recordedCanary(value));
	assert.equal(recordedCanary({ ...value, sourceJobId: "repeat:cron:123" }).sourceJobId, "repeat:cron:123");
});

test("canary admission is exclusive and a stale owner cannot erase or renew a successor", async () => {
	let held = null;
	const redis = { async get(key) { assert.equal(key, CANARY_LOCK_KEY); return held; }, async set(_key, token) { if (held) return null; held = token; return "OK"; }, async eval(script, _n, _key, token) { if (held !== token) return 0; if (script.includes("DEL")) held = null; return 1; }, async scan() { return ["0", ["bull:pi-jobs:meta", "bull:pi-jobs@host:meta", "bull:pi-jobs-malformed:meta"]]; } };
	assert.equal(await readBusy(redis), false);
	const first = await acquireCanaryLease(redis, { token: "first" });
	assert.equal(await readBusy(redis), true);
	assert.equal(await acquireCanaryLease(redis, { token: "second" }), null);
	assert.equal(await first.renew(), true);
	held = "second";
	assert.equal(await first.renew(), false);
	assert.equal(await first.release(), false);
	assert.equal(held, "second");
	assert.deepEqual(await canaryQueueNames(redis), ["pi-jobs", "pi-jobs@host"]);
});

test("local runtime restores only base objects, passes only provider credentials and reserves through runJob", async () => {
	const root = tempDir("canary-runtime-"), workspace = join(root, "original"), retained = join(root, "sandboxes", "one"), logs = join(root, "logs"), jobs = join(root, "jobs");
	mkdirSync(workspace); mkdirSync(retained, { recursive: true }); mkdirSync(logs);
	const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
	git(["init", "--template=", workspace]); writeFileSync(join(workspace, "file"), "base"); mkdirSync(join(workspace, ".pi", "skills", "edit"), { recursive: true }); writeFileSync(join(workspace, ".pi", "skills", "edit", "SKILL.md"), "---\nname: edit\ndescription: Fixture editing flow\n---\nEdit the repository.\n"); git(["-C", workspace, "add", "."]); git(["-C", workspace, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]);
	const sha = git(["-C", workspace, "rev-parse", "HEAD"]);
	git(["-C", workspace, "remote", "add", "origin", "https://forge.invalid/private"]);
	writeFileSync(join(workspace, "file"), "original edits");
	const model = builtinChatModels("anthropic").find((m) => new URL(m.baseUrl).hostname === "api.anthropic.com").id;
	const candidate = `anthropic/${model}`;
	writeFileSync(join(retained, "manifest.json"), JSON.stringify({ jobId: "one", backend: "local", baseSha: sha, workspace, createdAt: new Date(instant - 1000).toISOString(), retainUntil: new Date(instant + 86400_000).toISOString() }));
	writeFileSync(join(retained, "prompt.md"), "Original task, kept private"); writeFileSync(join(retained, "event.json"), "{}"); writeFileSync(join(retained, "model-roles.json"), JSON.stringify({ version: 1, roles: { editor: candidate } }));
	writeFileSync(join(logs, "one.json"), JSON.stringify(original("one", { session: { resumed: false, reason: "disabled", bytes: null } })));
	writeFileSync(join(root, "triggers.json"), JSON.stringify({ triggers: [], modelRoles: { default: { editor: candidate } } }));
	const counters = new Map(), dockerCalls = [], factoryOptions = [];
	const redis = { on() {}, async ping() {}, disconnect() {}, async scan() { return ["0", []]; }, async set(k, v) { if (counters.has(k)) return null; counters.set(k, v); return "OK"; }, async eval(script, _n, key, token) { if (counters.get(key) !== token) return 0; if (script.includes("DEL")) counters.delete(key); return 1; }, async get(k) { return counters.get(k) ?? null; }, async incr(k) { return this.incrby(k, 1); }, async incrby(k, n) { const value = Number(counters.get(k) ?? 0) + Number(n); counters.set(k, value); return value; }, async decr(k) { return this.incrby(k, -1); }, async decrby(k, n) { return this.incrby(k, -n); }, async expire() {} };
	const realExec = promisify(execFile);
	const runtime = await createCanaryRuntime({ env: { PI_LOGS_DIR: logs, PI_JOBS_DIR: jobs, PI_SANDBOX_DIR: join(root, "sandboxes"), PI_TRIGGERS_FILE: join(root, "triggers.json"), PI_SETTINGS_FILE: join(root, "settings.json"), PI_MAX_COST_USD: "1", PI_DAILY_COST_USD: "10", PI_DAILY_TOKEN_CAP: "1000", ANTHROPIC_API_KEY: "provider-only", GITHUB_TOKEN: "never-pass", PI_AUTH_FROM_PI: "0" }, options: { ...options, model: candidate }, now, execCommand: async (bin, args, opts) => { if (bin === "git") return realExec(bin, args, opts); dockerCalls.push(args); return { stdout: "", stderr: "" }; }, redisFactory: () => redis, queueFactory: () => ({ async getJobCounts() { return { active: 0 }; }, async isPaused() { return false; }, async close() {} }), imagePreflightFactory: () => async () => ({ ok: true, capabilities: ["costCap", "modelPolicy", "modelRoles", "exitAuth", "anyUid"] }), containerFactory: (opts) => { factoryOptions.push(opts); return async (args) => {
		assert.equal(readFileSync(join(args.prepared.workspace, "file"), "utf8"), "base");
		assert.throws(() => git(["-C", args.prepared.workspace, "remote", "get-url", "origin"]));
		assert.ok(!existsSync(join(args.prepared.workspace, ".git", "hooks")));
		assert.equal(args.home, "/home/pi");
		assert.equal(args.prepared.outboxDir, undefined); assert.equal(args.token, null); assert.deepEqual(args.secrets, {});
		return { code: 0, aborted: false, exitLineCode: 0, exitAuth: "verified", tokens: { total: 10, cost: 0.1, metered: 0.1 }, usage: null };
	}; } });
	try {
		const report = await executeCanary({ ...options, model: candidate }, { ...runtime, now, id: () => "canary-one" });
		assert.equal(report.rows[0].candidate.outcome, "completed");
		assert.ok([...counters.keys()].some((k) => k.startsWith("budget:usd:")), "real dollar reservation executed");
		assert.ok([...counters.keys()].some((k) => /^budget:\d/.test(k)), "real count reservation executed");
		assert.ok([...counters.keys()].some((k) => k.startsWith("budget:t:")), "real token ledger executed");
		assert.deepEqual(factoryOptions[0].hostEnv, { ANTHROPIC_API_KEY: "provider-only" }); assert.equal(factoryOptions[0].globalPiDir, undefined); assert.equal(factoryOptions[0].egress, true);
		assert.equal(readFileSync(join(workspace, "file"), "utf8"), "original edits");
		assert.equal(JSON.parse(readFileSync(join(logs, "canary-one.json"))).canary.sourceJobId, "one");
		assert.ok(!dockerCalls.some((args) => args.includes("--privileged")));
	} finally { await runtime.close(); }
	assert.deepEqual(readdirSync(jobs), []);
});
