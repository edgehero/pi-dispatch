import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../src/cli.mjs";
import { WATCH_PULL_CURSOR_TTL_MS, pollWatchSources, startWatchPuller } from "../src/watch-puller.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
const NOW = Date.parse("2026-01-01T00:00:00Z"); const now = () => NOW;
const finding = { fields: { service: "checkout" }, severity: "error", count: 1, firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-01T00:00:00Z", samples: ["private source text"] };
function setup() {
	const values = new Map(); const calls = []; const enqueued = [];
	const cfg = { valkeyUrl: "redis://unused", triggers: { watchSources: { prod: { maxPerDay: 1000, pull: { kind: "file", path: "/reviewed/log", fields: { service: "checkout" }, intervalSeconds: 30 } } }, watch: [{ on: { id: "rule", source: "prod", fingerprint: ["service"], match: {} } }] } };
	const redis = { async set(key, value, nx) { if (nx === "NX" && values.has(key)) return null; values.set(key, value); return "OK"; }, async get(key) { return values.get(key); }, async eval(script, count, leaseKey, ...args) { if (count === 1) { if (values.get(leaseKey) === args[0]) return values.delete(leaseKey) ? 1 : 0; return 0; } const [cursorKey, token, cursor] = args; if (values.get(leaseKey) !== token) return 0; values.set(cursorKey, cursor); return 1; } };
	const store = { async ingest(input) { calls.push(input); return { status: "held", id: "a".repeat(64), dueAt: NOW + 1000 }; }, async appendTrace() {}, async recordVerdict() {} };
	const adapterFactory = () => ({ async poll(cursor) { calls.push({ cursor }); return { findings: [finding], deliveries: ["delivery-1"], cursor: { offset: 12 } }; } });
	return { cfg, redis, values, calls, enqueued, store, adapterFactory, enqueue: async input => { enqueued.push(input); }, now, env: {} };
}
test("pull checkpoint follows successful ingest and enqueue; collector text is redacted", async () => {
	const deps = setup(); await pollWatchSources(deps);
	assert.equal(deps.enqueued.length, 1); assert.deepEqual(JSON.parse([...deps.values.entries()].find(([key]) => key.includes(":cursor:"))[1]), { offset: 12 });
	assert.equal(deps.calls.find(value => value.finding).finding.samples[0], "[redacted]"); assert.equal(deps.calls.find(value => value.finding).sourceMaxPerDay, 1000);
});
test("a checkpoint keeps the cursor 35 days, in milliseconds (PX): a resume point, not the forge job retention (#761)", async () => {
	const deps = setup(); const ttls = []; const evaluate = deps.redis.eval;
	deps.redis.eval = async (script, count, ...args) => { if (count === 2) ttls.push(args.at(-1)); return evaluate(script, count, ...args); };
	await pollWatchSources(deps);
	assert.deepEqual(ttls, [WATCH_PULL_CURSOR_TTL_MS]); assert.equal(WATCH_PULL_CURSOR_TTL_MS, 35 * 86_400_000);
});
test("failed enqueue retains old cursor; retry reuses the same source delivery", async () => {
	const deps = setup(); await assert.rejects(pollWatchSources({ ...deps, enqueue: async () => { throw new Error("failed"); } })); assert.equal([...deps.values.keys()].some(key => key.includes(":cursor:")), false);
	await pollWatchSources(deps); const inputs = deps.calls.filter(value => value.finding); assert.equal(inputs.length, 2); assert.equal(inputs[0].delivery, inputs[1].delivery);
});
test("a competing source lease prevents duplicate polling and enqueue", async () => {
	const deps = setup(); const original = deps.redis.set; deps.redis.set = async (...args) => args[2] === "NX" ? null : original(...args);
	await pollWatchSources(deps); assert.equal(deps.calls.length, 0); assert.equal(deps.enqueued.length, 0);
});
test("watch CLI awaits puller's done and passes the supplied environment", async () => {
	const env = { ONLY: "test" }; let completed = false;
	assert.equal(await main(["watch"], env, { startWatch: async received => { assert.equal(received, env); return { done: Promise.resolve().then(() => { completed = true; }) }; } }), 0); assert.equal(completed, true);
});
test("puller stops promptly and removes its timer without owning injected clients", async () => {
	const deps = setup(); let disconnected = false; deps.redis.disconnect = () => { disconnected = true; };
	const puller = await startWatchPuller({}, { ...deps, loadConfig: () => deps.cfg, fsDeps: { fileExists: () => false, readFile: () => "" }, signals: false, out: () => {} });
	puller.stop(); await puller.done; assert.equal(disconnected, false);
});
test("the collector starts on its real loader where a source's push secret is unset, and its reload takes the file too (issue #994)", { timeout: 10_000 }, async () => {
	// It pulls and reads no push secret, so nothing it loads judges one: only `serve`, which verifies pushes, refuses it.
	// The edit after the first pass adds a second source whose secret is unset, which its follower takes for `watch`.
	const dir = tempDir("watch-puller-secret-");
	const path = join(dir, "triggers.json");
	const pull = (file) => ({ verify: "hmac-sha256", secretEnv: "WATCH_SIGNING", maxPerDay: 10, pull: { kind: "file", path: file, fields: { service: "checkout" }, intervalSeconds: 30 } });
	writeFileSync(path, JSON.stringify({ watchSources: { prod: pull("/var/log/shop.log") }, triggers: [] }));
	const deps = setup(); const lines = []; const clock = { ms: NOW }; let passes = 0; let puller;
	const adapterFactory = () => ({ async poll() { return { findings: [], deliveries: [], cursor: {} }; } });
	const sleep = async () => {
		passes++;
		if (passes === 1) writeFileSync(path, JSON.stringify({ watchSources: { prod: pull("/var/log/shop.log"), alt: pull("/var/log/alt.log") }, triggers: [] }));
		clock.ms += 31_000;
		if (passes >= 2) puller.stop();
	};
	puller = await startWatchPuller({ PI_TRIGGERS_FILE: path }, { redis: deps.redis, store: deps.store, enqueue: deps.enqueue, adapterFactory, now: () => clock.ms, signals: false, out: value => lines.push(value), sleep });
	await puller.done;
	assert.deepEqual(lines.map(line => [line.event, line.source]), [["watch_pull_cycle", "prod"], ["triggers_reloaded", undefined], ["watch_pull_cycle", "prod"], ["watch_pull_cycle", "alt"]], "no refusal at start or on the reload");
});
test("the collector starts whatever the settings it never reads say: serve's, and the GitHub auth and identity retry the poller reads (issue #1006)", { timeout: 10_000 }, async () => {
	// It pulls, listens on nothing, resolves no identity and calls no forge, so its own loader judges none of them; each
	// used to stop it at its start through serve's loader. The file holds a GitHub rule, so with GITHUB_INGEST unset
	// serve would need the webhook secret.
	const dir = tempDir("watch-puller-listener-");
	const path = join(dir, "triggers.json");
	writeFileSync(path, JSON.stringify({ watchSources: { prod: { verify: "hmac-sha256", secretEnv: "WATCH_SIGNING", maxPerDay: 10, pull: { kind: "file", path: "/var/log/shop.log", fields: { service: "checkout" }, intervalSeconds: 30 } } }, triggers: [{ on: { type: "label", any: ["pi:fix"] }, run: { kind: "github", flow: "fix" } }] }));
	for (const setting of [{ GITLAB_TOKEN: "glpat-x" }, { GITLAB_WEBHOOK_MODE: "bogus" }, { FORGEJO_TOKEN: "t" }, { AZURE_TOKEN: "t" }, { RECEIVER_PORT: "http" }, {}, { WEBHOOK_SECRET: "   " }, { GITHUB_AUTH_SOURCE: "pat" }, { GITHUB_AUTH_SOURCE: "app" }, { GITHUB_AUTH_SOURCE: "bogus" }, { RECEIVER_IDENTITY_RETRY_SECONDS: "x" }]) {
		const deps = setup(); const lines = []; let cycled; const cycle = new Promise(resolve => { cycled = resolve; });
		const adapterFactory = () => ({ async poll() { return { findings: [], deliveries: [], cursor: {} }; } });
		const out = value => { lines.push(value); if (value.event === "watch_pull_cycle") cycled(); };
		const puller = await startWatchPuller({ PI_TRIGGERS_FILE: path, ...setting }, { redis: deps.redis, store: deps.store, enqueue: deps.enqueue, adapterFactory, now, signals: false, out });
		await cycle; puller.stop(); await puller.done;
		assert.deepEqual(lines.map(line => line.event), ["watch_pull_cycle"], JSON.stringify(setting));
	}
	// GITHUB_INGEST is the one setting it does not read and still judges, a stated residual (receiver/src/config.mjs).
	await assert.rejects(startWatchPuller({ PI_TRIGGERS_FILE: path, GITHUB_INGEST: "sometimes" }, { ...setup(), signals: false, out: () => {} }), (e) => e.piDispatchConfig === true && /^GITHUB_INGEST must be/.test(e.message));
});
test("the collector follows triggers.json by its text: one line each time the invalid text changes, one triggers_reloaded on recovery, none for a file that did not change (issue #995)", { timeout: 10_000 }, async () => {
	// It reloaded the file on every pass and logged watch_pull_config_invalid each time it was invalid, about a line a
	// second. Each pass here is the loop's own: its sleep seam edits the file between passes and advances the clock past
	// every source's interval, so each pass polls each source.
	const dir = tempDir("watch-puller-follow-");
	const path = join(dir, "triggers.json");
	const pull = (file) => ({ verify: "hmac-sha256", secretEnv: "WATCH_SIGNING", maxPerDay: 10, pull: { kind: "file", path: file, fields: { service: "checkout" }, intervalSeconds: 30 } });
	const good = (sources) => JSON.stringify({ watchSources: sources, triggers: [] });
	writeFileSync(path, good({ prod: pull("/var/log/shop.log") }));
	// Written after the numbered pass, read at the top of the next. A source whose push secret is unset is the collector's
	// to take, as it is the poller's: its follower judges for `watch`, never for `serve`.
	const edits = { 1: "{ not json", 3: "{ also not json", 4: good({ prod: pull("/var/log/shop.log"), alt: pull("/var/log/alt.log") }) };
	const deps = setup(); const lines = []; const clock = { ms: NOW }; let passes = 0; let puller;
	const adapterFactory = () => ({ async poll() { return { findings: [], deliveries: [], cursor: {} }; } });
	const sleep = async () => { passes++; if (edits[passes] !== undefined) writeFileSync(path, edits[passes]); clock.ms += 31_000; if (passes >= 6) puller.stop(); };
	puller = await startWatchPuller({ PI_TRIGGERS_FILE: path }, { redis: deps.redis, store: deps.store, enqueue: deps.enqueue, adapterFactory, now: () => clock.ms, signals: false, out: value => lines.push(value), sleep });
	await puller.done;
	// Pass by pass: the cycles mark each pass's end, and the triggers lines fall between them.
	const said = lines.map(line => line.event === "watch_pull_cycle" ? `cycle ${line.source}` : line.event === "triggers_reload_invalid" ? `invalid kept=${line.kept}` : line.event);
	assert.deepEqual(said, [
		"cycle prod",
		"invalid kept=true", "cycle prod",
		"cycle prod",
		"invalid kept=true", "cycle prod",
		"triggers_reloaded", "cycle prod", "cycle alt",
		"cycle prod", "cycle alt",
	]);
	assert.ok(lines.filter(line => line.event === "triggers_reload_invalid").every(line => /not valid JSON/.test(line.reason)), JSON.stringify(lines));
	assert.ok(!lines.some(line => line.event === "watch_pull_config_invalid"), "the old line is gone");
});
test("stop() while the collector waits between passes wakes it at once and leaves no timer behind (issue #995)", { timeout: 5_000 }, async () => {
	// Parked on the default wait, a REAL one second timer: stop() must clear it and wake the loop, or `done` waits out
	// the second (a stop that only cleared the timer would never settle at all). async_hooks counts the timers, the
	// poller's pattern: a cleared timer's destroy fires a macrotask later, hence the two setImmediates before counting.
	const { createHook } = await import("node:async_hooks");
	const live = new Set();
	const hook = createHook({ init(id, type) { if (type === "Timeout") live.add(id); }, destroy(id) { live.delete(id); } });
	const dir = tempDir("watch-puller-stop-");
	const path = join(dir, "triggers.json");
	writeFileSync(path, JSON.stringify({ watchSources: { prod: { verify: "hmac-sha256", secretEnv: "WATCH_SIGNING", maxPerDay: 10, pull: { kind: "file", path: "/var/log/shop.log", fields: { service: "checkout" }, intervalSeconds: 30 } } }, triggers: [] }));
	const deps = setup(); let cycled; const cycle = new Promise(resolve => { cycled = resolve; });
	const adapterFactory = () => ({ async poll() { return { findings: [], deliveries: [], cursor: {} }; } });
	hook.enable();
	let puller;
	try {
		const before = new Set(live);
		const liveDelta = () => [...live].filter(id => !before.has(id));
		puller = await startWatchPuller({ PI_TRIGGERS_FILE: path }, { redis: deps.redis, store: deps.store, enqueue: deps.enqueue, adapterFactory, now, signals: false, out: value => { if (value.event === "watch_pull_cycle") cycled(); } });
		await cycle;
		await new Promise(resolve => setImmediate(resolve));
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(liveDelta().length, 1, "the loop is parked on its one armed wait");
		const stoppedAt = performance.now();
		puller.stop();
		await puller.done;
		assert.ok(performance.now() - stoppedAt < 250, `done settled ${Math.round(performance.now() - stoppedAt)} ms after stop()`);
		await new Promise(resolve => setImmediate(resolve));
		await new Promise(resolve => setImmediate(resolve));
		assert.deepEqual(liveDelta(), [], "the wait's timer is destroyed, not left to fire");
	} finally {
		puller?.stop();
		hook.disable();
	}
});

