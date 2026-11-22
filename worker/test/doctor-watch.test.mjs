import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CHECK_ID_RE } from "../src/doctor-results.mjs";
import { watchDoctorChecks } from "../src/doctor.mjs";
import { serviceEnvFileOf, serviceEnvLoader } from "../src/service-env.mjs";
import { loadConfig } from "../src/config.mjs";
import { collectChecks } from "./helpers/doctor.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
// Worker tests may read the receiver's source (worker/src may not): the reader lists below are held to the loaders the
// receiver, the poller and the watch collector really run.
import { loadReceiverConfig } from "../../receiver/src/config.mjs";
import { loadPollerConfig } from "../../receiver/src/poller-config.mjs";
import { startWatchPuller } from "../../receiver/src/watch-puller.mjs";

/** A spawn every probe sees exit 0 at once, so doctor's own commands answer and say nothing. */
const quietSpawn = () => {
	const stream = () => ({ on() { return this; } });
	const handlers = {};
	queueMicrotask(() => handlers.close?.(0));
	return { stdout: stream(), stderr: stream(), stdin: { on() { return this; }, end() {} }, kill() {}, on(ev, cb) { handlers[ev] = cb; return this; } };
};
/** Doctor's checks for the deployment folder `dir`, on `env` and `serviceEnvFile` (a parsed .env, or null). */
const doctorIn = (dir, env, serviceEnvFile = null) => collectChecks(env, { cwd: dir, home: tempDir("pd-970-doctor-home-"), out: () => {}, spawn: quietSpawn, probeValkey: async () => true, readHosts: async () => ({ hosts: [] }), dollarKeysExist: async () => false, fileExists: existsSync, readEnvFile: (p) => readFileSync(p), nodeVersion: "22.19.0", serviceEnvFile });
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
test("a signing secret is judged by the receiver loader's rule: blank is missing, and the line names the receiver alone as refusing to start (issues #970, #994)", () => {
	const line = (sources, env) => watchDoctorChecks({ sources, rules: 1, env }).find(c => c.id.startsWith("watch.secret-"));
	const pulled = { prod: { secretEnv: "WATCH_SIGNING", pull: { kind: "journald" } } };
	// A secret of spaces refuses the receiver (`.trim()`), so it is missing here too, where `length > 0` called it available.
	const blank = line(pulled, { WATCH_SIGNING: "   " });
	assert.deepEqual([blank.ok, blank.warn], [false, true], "a warning: doctor may run where no serve runs");
	assert.equal(blank.label, "watch source prod: signing secret WATCH_SIGNING is unset or blank, so the receiver (`pi-dispatch-receiver serve`) refuses to start on this triggers file (exit 2), and one already running keeps the last copy that loaded; the poller and the watch collector do not read it");
	assert.equal(blank.fix, "Set WATCH_SIGNING to a non-blank value wherever `pi-dispatch-receiver serve` runs, or remove the source from the triggers file.");
	assert.doesNotMatch(blank.label + blank.fix, /503|pull source without serving/);
	// Only serve verifies pushes with it: a pull source, a push source and one naming WEBHOOK_SECRET, set blank or not at
	// all, are refused by the receiver alone (the poller's stand-in for WEBHOOK_SECRET no longer decides anything here).
	for (const [sources, env] of [[{ prod: { secretEnv: "WATCH_SIGNING" } }, {}], [{ prod: { secretEnv: "WEBHOOK_SECRET" } }, {}], [{ prod: { secretEnv: "WEBHOOK_SECRET" } }, { WEBHOOK_SECRET: " " }], [pulled, {}]]) {
		assert.match(line(sources, env).label, /, so the receiver \(`pi-dispatch-receiver serve`\) refuses to start on this triggers file/, JSON.stringify([sources, env]));
	}
});
test("doctor reads a watch source's signing secret from the deployment .env when this shell sets none, as the service does (issue #970)", async () => {
	const dir = tempDir("pd-970-doctor-watch-");
	const triggersFile = join(dir, "triggers.json");
	writeFileSync(triggersFile, JSON.stringify({ watchSources: { prod: { verify: "hmac-sha256", secretEnv: "WATCH_SIGNING", maxPerDay: 10 } }, triggers: [] }));
	const envPath = join(dir, ".env");
	writeFileSync(envPath, "WATCH_SIGNING=private-signing-value\n");
	const env = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", VALKEY_URL: "redis://x", PI_TRIGGERS_FILE: triggersFile };
	const run = (file) => doctorIn(dir, env, file);
	const withFile = await run(serviceEnvFileOf(readFileSync(envPath), envPath, serviceEnvLoader(process.platform)));
	const secret = withFile.find(c => c.id?.startsWith("watch.secret-"));
	assert.deepEqual([secret.ok, secret.label], [true, "watch source prod: signing secret is available"]);
	assert.doesNotMatch(JSON.stringify(withFile), /private-signing-value/);
	const without = (await run(null)).find(c => c.id?.startsWith("watch.secret-"));
	assert.equal(without.ok, false, "neither this shell nor a .env sets it");
});
test("a GitHub auth setting, WEBHOOK_SECRET, RECEIVER_PORT and the identity retry window name every reader whose loader refuses them, and never the watch collector, pull source or none (issues #1001, #1006)", async () => {
	const dir = tempDir("pd-1001-doctor-readers-");
	const triggersFile = join(dir, "triggers.json");
	const label = { on: { type: "label", any: ["pi:fix"] }, run: { kind: "github", flow: "fix" } };
	const text = (pull) => JSON.stringify({ watchSources: { prod: { verify: "hmac-sha256", secretEnv: "WATCH_SIGNING", maxPerDay: 10, ...(pull ? { pull: { kind: "journald", unit: "shop.service", fields: { service: "shop" } } } : {}) } }, triggers: [label] });
	const base = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", VALKEY_URL: "redis://x", PI_TRIGGERS_FILE: triggersFile, WATCH_SIGNING: "s" };
	// Each setting alone, bad: the line's start, the readers it must name with a pull source and without, and the loader's
	// own refusal, which every named reader makes and no other.
	const cases = [
		{ env: { GITHUB_AUTH_SOURCE: "token", WEBHOOK_SECRET: "w" }, line: 'GITHUB_AUTH_SOURCE is "token", which is none of pat, gh or app: ', pulled: "the worker, the receiver and the poller refuse to start on it (exit 2)", pushed: "the worker, the receiver and the poller refuse to start on it (exit 2)", refusal: /^invalid GITHUB_AUTH_SOURCE/ },
		{ env: { GITHUB_AUTH_SOURCE: "pat", WEBHOOK_SECRET: "w" }, line: "GITHUB_AUTH_SOURCE=pat but GITHUB_PAT is unset: ", pulled: "the worker, the receiver and the poller refuse to start (exit 2)", pushed: "the worker, the receiver and the poller refuse to start (exit 2)", refusal: /^GITHUB_AUTH_SOURCE=pat requires/ },
		// An inline App key cut short after its header (issue #1028): doctor judges it by the loaders' own rule, so it names
		// every reader of the auth block, and the collector, which loads none, is not one.
		{ env: { GITHUB_AUTH_SOURCE: "app", GITHUB_APP_ID: "4242", GITHUB_APP_INSTALLATION_ID: "987654", GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----", WEBHOOK_SECRET: "w" }, line: 'GITHUB_APP_PRIVATE_KEY is not a PEM private key (it must begin "-----BEGIN ... PRIVATE KEY-----" and end "-----END ... PRIVATE KEY-----") -- ', pulled: "the worker, the receiver and the poller refuse to start (exit 2)", pushed: "the worker, the receiver and the poller refuse to start (exit 2)", refusal: /^GITHUB_APP_PRIVATE_KEY is not a PEM private key/ },
		// What only a listener reads is the receiver's alone (issue #1006): the poller and the collector load without it, a
		// WEBHOOK_SECRET of spaces and a port they never bind included. The secret's words are the same for both rows,
		// "unset or blank", since the receiver trims it: doctor said "unset" of a line that sets it to spaces.
		{ env: {}, line: "triggers.json has github triggers but WEBHOOK_SECRET is unset or blank -- ", pulled: "the receiver will refuse to start", pushed: "the receiver will refuse to start", refusal: /^WEBHOOK_SECRET is required/ },
		{ env: { WEBHOOK_SECRET: "   " }, line: "triggers.json has github triggers but WEBHOOK_SECRET is unset or blank -- ", pulled: "the receiver will refuse to start", pushed: "the receiver will refuse to start", refusal: /^WEBHOOK_SECRET is required/ },
		{ env: { WEBHOOK_SECRET: "w", RECEIVER_PORT: "http" }, line: 'RECEIVER_PORT is "http", which is not a positive integer -- ', pulled: "the receiver will refuse to start", pushed: "the receiver will refuse to start", refusal: /^invalid RECEIVER_PORT/ },
		// The identity retry window: serve and the poller resolve an identity at their start, the collector none (issue #1006).
		// A value that is not short and plain is never shown: a token pasted into the wrong line is a token.
		{ env: { WEBHOOK_SECRET: "w", RECEIVER_IDENTITY_RETRY_SECONDS: "x" }, line: 'RECEIVER_IDENTITY_RETRY_SECONDS is "x", which is not a positive integer: ', pulled: "the receiver and the poller refuse to start on it (exit 2)", pushed: "the receiver and the poller refuse to start on it (exit 2)", refusal: /^invalid RECEIVER_IDENTITY_RETRY_SECONDS/ },
		{ env: { WEBHOOK_SECRET: "w", RECEIVER_IDENTITY_RETRY_SECONDS: `ghp_${"x".repeat(36)}` }, line: "RECEIVER_IDENTITY_RETRY_SECONDS is an unrecognised value (40 characters, not shown), which is not a positive integer: ", pulled: "the receiver and the poller refuse to start on it (exit 2)", pushed: "the receiver and the poller refuse to start on it (exit 2)", refusal: /^invalid RECEIVER_IDENTITY_RETRY_SECONDS/ },
	];
	const fs = (pull) => ({ readFile: () => text(pull), fileExists: () => true });
	const readers = {
		worker: async (env) => loadConfig(env),
		// `serve` loads as the listener, the loader's default (receiver/src/start.mjs says so explicitly).
		receiver: async (env, pull) => loadReceiverConfig(env, fs(pull)),
		poller: async (env, pull) => loadPollerConfig({ ...env, POLL_REPOS: "o/r" }, fs(pull)),
		// The collector with its own loader, on the file written above. One its loader took would go on to judge Valkey:
		// that is refused here, so it never connects to anything.
		"watch collector": (env) => startWatchPuller(env, { judgeValkey: async () => { throw new Error("started"); }, signals: false, out: () => {} }),
	};
	for (const { env, line, pulled, pushed, refusal } of cases) {
		for (const pull of [true, false]) {
			writeFileSync(triggersFile, text(pull));
			const want = pull ? pulled : pushed;
			const found = (await doctorIn(dir, { ...base, ...env })).find((c) => c.label.startsWith(line));
			assert.ok(found, `${line} pull=${pull}`);
			assert.equal(found.label.slice(line.length, line.length + want.length), want, `${line} pull=${pull}: ${found.label}`);
			assert.doesNotMatch(found.label, /x{36}/, "a long value is never printed");
			for (const [reader, load] of Object.entries(readers)) {
				let message = null;
				try {
					await load({ ...base, ...env }, pull);
				} catch (error) {
					message = error.message;
				}
				// The collector with no pull source refuses every file, so only its answer with one says anything here.
				if (reader === "watch collector" && !pull) continue;
				assert.equal(message !== null && refusal.test(message), want.includes(`the ${reader}`), `${reader} ${line} pull=${pull}: ${message}`);
			}
		}
	}
});

