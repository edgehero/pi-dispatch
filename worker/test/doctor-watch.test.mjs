import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CHECK_ID_RE } from "../src/doctor-results.mjs";
import { watchDoctorChecks } from "../src/doctor.mjs";
import { serviceEnvFileOf, serviceEnvLoader } from "../src/service-env.mjs";
import { collectChecks } from "./helpers/doctor.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
test("doctor lists watch source and rule counts and warns on missing signing and pull secrets", () => {
	const checks = watchDoctorChecks({ sources: { prod: { secretEnv: "WATCH_SIGNING", pull: { secretEnv: "LOKI_TOKEN" } } }, rules: 2 });
	assert.match(checks[0].label, /1 watch source\(s\), 2 watch rule/);
	assert.equal(checks.filter(c => c.warn && !c.ok).length, 2);
	assert.ok(checks.every(c => CHECK_ID_RE.test(c.id)));
	assert.match(checks.find(c => c.id.startsWith("watch.secret-")).fix, /WATCH_SIGNING/);
});
test("doctor secret availability never prints secret values and is silent without watch sources", () => {
	const checks = watchDoctorChecks({ sources: { prod: { secretEnv: "WATCH_SIGNING", pull: { secretEnv: "LOKI_TOKEN" } } }, rules: 1, env: { WATCH_SIGNING: "private-signing-value", LOKI_TOKEN: "private-query-token" } });
	assert.ok(checks.every(c => c.ok)); assert.doesNotMatch(JSON.stringify(checks), /private-signing-value|private-query-token/);
	assert.deepEqual(watchDoctorChecks(), []);
});
test("a signing secret is judged by the receiver loader's rule: blank is missing, and the line names who refuses to start (issue #970)", () => {
	const line = (sources, env) => watchDoctorChecks({ sources, rules: 1, env }).find(c => c.id.startsWith("watch.secret-"));
	const pulled = { prod: { secretEnv: "WATCH_SIGNING", pull: { kind: "journald" } } };
	// A secret of spaces refuses the receiver (`.trim()`), so it is missing here too, where `length > 0` called it available.
	const blank = line(pulled, { WATCH_SIGNING: "   " });
	assert.deepEqual([blank.ok, blank.warn], [false, true], "a warning: doctor may run where none of the three runs");
	assert.equal(blank.label, "watch source prod: signing secret WATCH_SIGNING is unset or blank, so the receiver, the poller and the watch collector refuse to start on this triggers file (exit 2), and one already running keeps the last copy that loaded");
	assert.equal(blank.fix, "Set WATCH_SIGNING to a non-blank value wherever the receiver, the poller or the watch collector runs, or remove the source from the triggers file.");
	assert.doesNotMatch(blank.label + blank.fix, /503|pull source without serving/);
	// No pull source: the watch collector reads none of it. WEBHOOK_SECRET unset: the poller stands in for it.
	assert.match(line({ prod: { secretEnv: "WATCH_SIGNING" } }, {}).label, /, so the receiver and the poller refuse to start/);
	assert.match(line({ prod: { secretEnv: "WEBHOOK_SECRET" } }, {}).label, /, so the receiver refuses to start/);
	assert.match(line({ prod: { secretEnv: "WEBHOOK_SECRET" } }, { WEBHOOK_SECRET: " " }).label, /, so the receiver and the poller refuse to start/);
});
test("doctor reads a watch source's signing secret from the deployment .env when this shell sets none, as the service does (issue #970)", async () => {
	const dir = tempDir("pd-970-doctor-watch-");
	const triggersFile = join(dir, "triggers.json");
	writeFileSync(triggersFile, JSON.stringify({ watchSources: { prod: { verify: "hmac-sha256", secretEnv: "WATCH_SIGNING", maxPerDay: 10 } }, triggers: [] }));
	const envPath = join(dir, ".env");
	writeFileSync(envPath, "WATCH_SIGNING=private-signing-value\n");
	const env = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", VALKEY_URL: "redis://x", PI_TRIGGERS_FILE: triggersFile };
	const spawn = () => {
		const stream = () => ({ on() { return this; } });
		const handlers = {};
		queueMicrotask(() => handlers.close?.(0));
		return { stdout: stream(), stderr: stream(), stdin: { on() { return this; }, end() {} }, kill() {}, on(ev, cb) { handlers[ev] = cb; return this; } };
	};
	const run = (file) => collectChecks(env, { cwd: dir, home: tempDir("pd-970-doctor-home-"), out: () => {}, spawn, probeValkey: async () => true, readHosts: async () => ({ hosts: [] }), dollarKeysExist: async () => false, fileExists: existsSync, readEnvFile: (p) => readFileSync(p), nodeVersion: "22.19.0", serviceEnvFile: file });
	const withFile = await run(serviceEnvFileOf(readFileSync(envPath), envPath, serviceEnvLoader(process.platform)));
	const secret = withFile.find(c => c.id?.startsWith("watch.secret-"));
	assert.deepEqual([secret.ok, secret.label], [true, "watch source prod: signing secret is available"]);
	assert.doesNotMatch(JSON.stringify(withFile), /private-signing-value/);
	const without = (await run(null)).find(c => c.id?.startsWith("watch.secret-"));
	assert.equal(without.ok, false, "neither this shell nor a .env sets it");
});
