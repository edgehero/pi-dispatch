import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { FORGE_WEBHOOK_NAMES } from "../src/config.mjs";
import { collectChecks } from "./helpers/doctor.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
// Worker tests may read the receiver's source (worker/src may not): doctor's forge lines are held to the loaders the
// receiver, the poller and the watch collector really run.
import { loadReceiverConfig } from "../../receiver/src/config.mjs";
import { loadPollerConfig } from "../../receiver/src/poller-config.mjs";
import { startWatchPuller } from "../../receiver/src/watch-puller.mjs";

// Issue #1006: only `serve` reads the GitLab, Forgejo and Azure DevOps webhook settings, so only it refuses them, and
// doctor says a refusal exactly where `serve` makes one: whenever a forge's block is named, rules or none, and never
// where nothing names it.

/** A spawn every probe sees exit 0 at once, so doctor's own commands answer and say nothing. */
const quietSpawn = () => {
	const stream = () => ({ on() { return this; } });
	const handlers = {};
	queueMicrotask(() => handlers.close?.(0));
	return { stdout: stream(), stderr: stream(), stdin: { on() { return this; }, end() {} }, kill() {}, on(ev, cb) { handlers[ev] = cb; return this; } };
};
const doctorIn = (dir, env) => collectChecks(env, { cwd: dir, home: tempDir("pd-1006-doctor-home-"), out: () => {}, spawn: quietSpawn, probeValkey: async () => true, readHosts: async () => ({ hosts: [] }), dollarKeysExist: async () => false, fileExists: existsSync, readEnvFile: (p) => readFileSync(p), nodeVersion: "22.19.0", serviceEnvFile: null });

const RULES = {
	gitlab: { on: { type: "label", any: ["pi:fix"] }, run: { kind: "gitlab", flow: "fix" } },
	forgejo: { on: { type: "label", any: ["pi:fix"] }, run: { kind: "forgejo", flow: "fix" } },
	azure: { on: { type: "label", any: ["pi:fix"] }, run: { kind: "azure", flow: "fix", repository: "webapp" } },
};
const PULL = { prod: { verify: "hmac-sha256", secretEnv: "WATCH_PROD", maxPerDay: 10, pull: { kind: "file", path: "/var/log/shop.log", fields: { service: "shop" } } } };
const GOOD = { GITLAB_WEBHOOK_MODE: "token", GITLAB_WEBHOOK_SECRET: "s", GITLAB_TOKEN: "t", FORGEJO_WEBHOOK_SECRET: "s", FORGEJO_TOKEN: "t", FORGEJO_URL: "https://code.example.org", AZURE_WEBHOOK_MODE: "basic", AZURE_WEBHOOK_SECRET: "s", AZURE_TOKEN: "t", AZURE_ORG_URL: "https://dev.azure.com/o" };

/** A deployment folder whose triggers file holds `kinds`' rules and a pull source, and the env every reader starts on. */
function deployment(kinds) {
	const dir = tempDir("pd-1006-forge-");
	const path = join(dir, "triggers.json");
	writeFileSync(path, JSON.stringify({ watchSources: PULL, triggers: kinds.map((k) => RULES[k]) }));
	return { dir, env: { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", VALKEY_URL: "redis://127.0.0.1:1", PI_TRIGGERS_FILE: path, GITHUB_INGEST: "poll", POLL_REPOS: "o/r", WATCH_PROD: "w" } };
}

/** Each receiver command's start on `env`, by its own loader: "takes", or the message it refuses with. */
async function readers(env) {
	const result = {};
	const tries = {
		serve: async () => loadReceiverConfig(env, { command: "serve" }),
		poll: async () => loadPollerConfig(env),
		// A collector its loader took goes on to judge Valkey: that is refused here, so it never connects to anything.
		watch: () => startWatchPuller(env, { judgeValkey: async () => { throw new Error("collector started"); }, signals: false, out: () => {} }),
	};
	for (const [name, start] of Object.entries(tries)) {
		try {
			await start();
			result[name] = "takes";
		} catch (error) {
			result[name] = error.message === "collector started" ? "takes" : error.message;
		}
	}
	return result;
}

test("GITLAB_TOKEN alone, with no GitLab rule: serve refuses and doctor says so, naming serve alone; poll and watch start (issue #1006)", async () => {
	const { dir, env } = deployment([]);
	const withToken = { ...env, GITLAB_TOKEN: "glpat-x" };
	const got = await readers(withToken);
	assert.match(got.serve, /^GITLAB_WEBHOOK_MODE must be/);
	assert.deepEqual([got.poll, got.watch], ["takes", "takes"]);
	const line = (await doctorIn(dir, withToken)).find((c) => c.label.startsWith("gitlab webhook settings:"));
	assert.ok(line, "doctor said nothing while serve exits 2");
	assert.equal(line.label, "gitlab webhook settings: GITLAB_WEBHOOK_MODE is unset or blank, GITLAB_WEBHOOK_SECRET is unset or blank -- with any of GITLAB_WEBHOOK_MODE, GITLAB_WEBHOOK_SECRET, GITLAB_TOKEN set, the receiver (`pi-dispatch-receiver serve`) arms /gitlab and will refuse to start on these; the poller and the watch collector do not read them");
	assert.deepEqual([line.ok, line.warn], [false, true]);
	assert.match(line.fix, /GITLAB_TOKEN set for gitlab jobs alone still arms \/gitlab/);
	assert.doesNotMatch(JSON.stringify(line), /glpat-x/);
});

test("a GitLab rule with no GITLAB_* set: serve starts, so doctor claims no refusal and says the rule never fires (issue #1006)", async () => {
	const { dir, env } = deployment(["gitlab"]);
	assert.deepEqual(await readers(env), { serve: "takes", poll: "takes", watch: "takes" });
	const labels = (await doctorIn(dir, env)).map((c) => c.label);
	assert.ok(!labels.some((l) => /refuse to start|webhook settings:/.test(l) && /GITLAB/.test(l)), labels.filter((l) => /GITLAB/.test(l)).join("\n"));
	assert.ok(labels.includes("triggers.json has gitlab triggers but none of GITLAB_WEBHOOK_MODE, GITLAB_WEBHOOK_SECRET, GITLAB_TOKEN is set, so `pi-dispatch-receiver serve` serves no /gitlab route and they never fire (nothing refuses to start)"));
});

test("doctor's forge lines follow serve's real loader over every forge setting, rules or none, and poll and watch never refuse one (issue #1006)", async () => {
	// Every subset of each forge's naming variables, each set or blank, plus the values a mode refuses and Azure's header.
	const extras = { gitlab: [{ GITLAB_WEBHOOK_MODE: "bogus" }], forgejo: [{ FORGEJO_URL: "   " }], azure: [{ AZURE_WEBHOOK_MODE: "header" }, { AZURE_WEBHOOK_MODE: "header", AZURE_WEBHOOK_HEADER: "X-Hook" }, { AZURE_WEBHOOK_MODE: "hmac" }] };
	let rows = 0;
	for (const kind of Object.keys(FORGE_WEBHOOK_NAMES)) {
		const names = FORGE_WEBHOOK_NAMES[kind];
		const subsets = [];
		for (let mask = 0; mask < 1 << names.length; mask++) {
			subsets.push(Object.fromEntries(names.filter((_, i) => mask & (1 << i)).map((n) => [n, GOOD[n]])));
			if (mask > 0) subsets.push(Object.fromEntries(names.filter((_, i) => mask & (1 << i)).map((n, i) => [n, i === 0 ? " " : GOOD[n]])));
		}
		for (const settings of [...subsets, ...extras[kind].map((e) => ({ ...Object.fromEntries(names.map((n) => [n, GOOD[n]])), ...e }))]) {
			for (const withRule of [false, true]) {
				const { dir, env } = deployment(withRule ? [kind] : []);
				const full = { ...env, ...settings };
				const label = `${kind} ${JSON.stringify(settings)} rule=${withRule}`;
				const got = await readers(full);
				assert.deepEqual([got.poll, got.watch], ["takes", "takes"], `poll and watch read no forge setting: ${label}`);
				const checks = (await doctorIn(dir, full)).filter((c) => c.label.startsWith(`${kind} webhook settings:`) || c.label.startsWith(`triggers.json has ${kind} triggers but none of`));
				const refusal = checks.find((c) => c.label.startsWith(`${kind} webhook settings:`));
				assert.equal(Boolean(refusal), got.serve !== "takes", `doctor says a refusal exactly where serve makes one: ${label}`);
				// The first fault doctor names is the one serve refuses with.
				if (refusal) assert.equal(refusal.label.split(" ")[3], got.serve.split(" ")[0], label);
				const named = names.some((n) => Boolean(settings[n]));
				assert.equal(checks.some((c) => c.label.startsWith(`triggers.json has ${kind} triggers but none of`)), withRule && !named, `the no-route line: ${label}`);
				rows++;
			}
		}
	}
	assert.ok(rows >= 80, `${rows} rows`);
});

test("a malformed RECEIVER_PORT is said wherever it is set, forge triggers or none, naming serve alone, which alone refuses it (issue #1006)", async () => {
	// A deployment with no forge rule and no GITHUB_INGEST may still run serve, for watch pushes: its port refuses it.
	const { dir, env } = deployment([]);
	const { GITHUB_INGEST: _ingest, ...plain } = env;
	const bad = { ...plain, RECEIVER_PORT: "http" };
	const got = await readers(bad);
	assert.match(got.serve, /^invalid RECEIVER_PORT/);
	assert.deepEqual([got.poll, got.watch], ["takes", "takes"]);
	const lines = (await doctorIn(dir, bad)).filter((c) => c.label.startsWith("RECEIVER_PORT"));
	assert.deepEqual(lines.map((c) => [c.label, c.ok, c.warn]), [['RECEIVER_PORT is "http", which is not a positive integer -- the receiver will refuse to start', false, true]]);
	assert.deepEqual((await doctorIn(dir, { ...plain, RECEIVER_PORT: "3000" })).filter((c) => c.label.startsWith("RECEIVER_PORT")), []);
});

test("an empty forge variable names no block, as .env.example ships several empty: serve starts and doctor says nothing of it (issue #1006)", async () => {
	// GITLAB_TOKEN=, GITLAB_WEBHOOK_MODE=, FORGEJO_URL=, FORGEJO_TOKEN=, AZURE_TOKEN= and AZURE_WEBHOOK_MODE= are scaffolded
	// uncommented and empty, so "set" must mean a non-empty value, or every fresh deployment's serve would refuse.
	const { dir, env } = deployment([]);
	const each = Object.entries(FORGE_WEBHOOK_NAMES).flatMap(([kind, names]) => names.map((name) => [kind, { [name]: "" }]));
	const all = Object.entries(FORGE_WEBHOOK_NAMES).map(([kind, names]) => [kind, Object.fromEntries(names.map((name) => [name, ""]))]);
	for (const [kind, settings] of [...each, ...all]) {
		const full = { ...env, ...settings };
		assert.deepEqual(await readers(full), { serve: "takes", poll: "takes", watch: "takes" }, JSON.stringify(settings));
		assert.deepEqual((await doctorIn(dir, full)).filter((c) => c.label.includes(`${kind} webhook settings`)), [], JSON.stringify(settings));
	}
});
