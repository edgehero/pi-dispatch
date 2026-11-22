import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ReplyError } from "ioredis";
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
test("failed enqueue retains old cursor and is said as the source's ingest stage; retry reuses the same source delivery", async () => {
	// The source's failure is its own line and no longer throws the pass (issue #1027): only Valkey's lease calls do.
	const deps = setup(); const said = [];
	await pollWatchSources({ ...deps, enqueue: async () => { throw new Error("failed"); }, log: (event, fields) => { if (event.startsWith("watch_pull")) said.push([event, fields.stage]); } });
	assert.deepEqual(said, [["watch_pull_source_failed", "ingest"]]); assert.equal([...deps.values.keys()].some(key => key.includes(":cursor:")), false);
	await pollWatchSources(deps); const inputs = deps.calls.filter(value => value.finding); assert.equal(inputs.length, 2); assert.equal(inputs[0].delivery, inputs[1].delivery);
});
test("a source edited in place is due at once and its failure is said again, and a removed one leaves nothing behind (issue #1027)", async () => {
	// The loop's `due` and `failing` are keyed by the source's identity, its name and pull block, as its lease and cursor
	// are: a fix to a failing source's declaration is tried at the next pass, not after the old copy's interval.
	const deps = setup(); const said = []; const polled = []; let at = NOW; const due = new Map(); const failing = new Map();
	const adapterFactory = (pull) => ({ async poll() { polled.push([pull.path, at - NOW]); throw new Error("watch file poll unavailable"); } });
	const pass = () => pollWatchSources({ ...deps, adapterFactory, now: () => at, log: (event, fields) => said.push([event, fields.source, fields.stage]), due, failing });
	await pass(); at += 1_000; await pass();
	assert.deepEqual(polled, [["/reviewed/log", 0]], "not due again before its 30 s");
	deps.cfg.triggers.watchSources.prod.pull = { ...deps.cfg.triggers.watchSources.prod.pull, path: "/srv/other.log" };
	at += 1_000; await pass();
	assert.deepEqual(polled, [["/reviewed/log", 0], ["/srv/other.log", 2_000]]);
	assert.deepEqual(said, [["watch_pull_source_failed", "prod", "poll"], ["watch_pull_source_failed", "prod", "poll"]], "the same stage, said again for the new copy");
	assert.deepEqual([due.size, failing.size], [1, 1], "the old copy's entries are gone");
	delete deps.cfg.triggers.watchSources.prod; await pass();
	assert.deepEqual([due.size, failing.size], [0, 0]);
});
test("a competing source lease prevents duplicate polling and enqueue, and the source stays due (issue #1027)", async () => {
	// Another collector's turn is no failure: nothing is said, and the next pass asks for the lease again.
	const deps = setup(); const original = deps.redis.set; let asked = 0; const said = []; const due = new Map();
	deps.redis.set = async (...args) => { if (args[2] === "NX") { asked++; return null; } return original(...args); };
	const pass = () => pollWatchSources({ ...deps, due, log: (event) => said.push(event) });
	await pass(); await pass();
	assert.equal(deps.calls.length, 0); assert.equal(deps.enqueued.length, 0);
	assert.equal(asked, 2, "a held lease sets no due time"); assert.deepEqual(said, []);
});
test("a source's turn names the stage that failed: its cursor read, its checkpoint when the lease was lost (issue #1027)", async () => {
	const deps = setup(); const said = [];
	const log = (event, fields) => { if (event.startsWith("watch_pull")) said.push([event, fields.stage]); };
	const get = deps.redis.get;
	deps.redis.get = async () => { throw new ReplyError("LOADING Valkey is loading the dataset in memory"); };
	await pollWatchSources({ ...deps, log });
	deps.redis.get = get;
	const evaluate = deps.redis.eval;
	deps.redis.eval = async (script, count, ...args) => (count === 2 ? 0 : evaluate(script, count, ...args));
	await pollWatchSources({ ...deps, log });
	assert.deepEqual(said, [["watch_pull_source_failed", "cursor"], ["watch_pull_source_failed", "checkpoint"]]);
	assert.equal([...deps.values.keys()].some(key => key.includes(":cursor:")), false, "the cursor is kept as it was");
});
test("a release Valkey answers with an error throws the pass after every source had its turn (issue #1027)", async () => {
	const deps = setup(); const said = [];
	deps.cfg.triggers.watchSources.alt = { maxPerDay: 1000, pull: { kind: "file", path: "/srv/alt.log", fields: { service: "checkout" }, intervalSeconds: 30 } };
	const evaluate = deps.redis.eval;
	deps.redis.eval = async (script, count, ...args) => { if (count === 1) throw new ReplyError("OOM command not allowed when used memory > 'maxmemory'."); return evaluate(script, count, ...args); };
	await assert.rejects(pollWatchSources({ ...deps, log: (event, fields) => { if (event.startsWith("watch_pull")) said.push([event, fields.source]); } }), /watch pull lease release unavailable/);
	assert.deepEqual(said, [["watch_pull_cycle", "prod"], ["watch_pull_cycle", "alt"]]);
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

test("a failing pull source is asked once per interval and said once per stage, is collected again at its next due time, and leaves another source on its own pace (issue #1027)", { timeout: 10_000 }, async () => {
	// It stayed due after a failure, so the loop asked it once a second whatever its interval and said it twice each time
	// (the source's line and the pass's). The loop's own passes, a second apart on the injected clock through its sleep
	// seam: `bad` (every 5 s) fails its poll until 10 s, returns a batch out of bounds until 15 s, checkpoints at 15 s and
	// returns a batch out of bounds again from 20 s, which is said again since the checkpoint ended the streak; `good`
	// (every 7 s) checkpoints throughout.
	const dir = tempDir("watch-puller-paced-");
	const path = join(dir, "triggers.json");
	const pull = (file, intervalSeconds) => ({ verify: "hmac-sha256", secretEnv: "WATCH_SIGNING", maxPerDay: 10, pull: { kind: "file", path: file, fields: { service: "checkout" }, intervalSeconds } });
	writeFileSync(path, JSON.stringify({ watchSources: { bad: pull("/var/log/bad.log", 5), good: pull("/var/log/good.log", 7) }, triggers: [] }));
	const deps = setup(); const lines = []; const polled = []; const clock = { ms: NOW }; let passes = 0; let puller;
	const adapterFactory = (declared) => ({
		async poll() {
			const at = clock.ms - NOW;
			polled.push([declared.path, at]);
			if (declared.path === "/var/log/bad.log" && at < 10_000) throw new Error("watch file poll unavailable");
			if (declared.path === "/var/log/bad.log" && at !== 15_000) return { findings: "not a list", deliveries: [], cursor: {} };
			return { findings: [], deliveries: [], cursor: {} };
		},
	});
	const sleep = async () => { passes++; clock.ms += 1_000; if (passes >= 25) puller.stop(); };
	puller = await startWatchPuller({ PI_TRIGGERS_FILE: path }, { redis: deps.redis, store: deps.store, enqueue: deps.enqueue, adapterFactory, now: () => clock.ms, signals: false, out: value => lines.push(value), sleep });
	await puller.done;
	assert.deepEqual(polled, [["/var/log/bad.log", 0], ["/var/log/good.log", 0], ["/var/log/bad.log", 5_000], ["/var/log/good.log", 7_000], ["/var/log/bad.log", 10_000], ["/var/log/good.log", 14_000], ["/var/log/bad.log", 15_000], ["/var/log/bad.log", 20_000], ["/var/log/good.log", 21_000]]);
	const said = lines.map(line => line.event === "watch_pull_source_failed" ? `failed ${line.source} ${line.stage}` : line.event === "watch_pull_cycle" ? `cycle ${line.source}` : line.event);
	assert.deepEqual(said, ["failed bad poll", "cycle good", "cycle good", "failed bad batch", "cycle good", "cycle bad", "failed bad batch", "cycle good"]);
	assert.ok(lines.filter(line => line.event === "watch_pull_source_failed").every(line => line.reason === "source-unavailable-cursor-retained"), JSON.stringify(lines));
});
test("a lease request Valkey answers with an error is said once per streak and is no source's failure; the source is collected once Valkey takes it (issue #1027)", { timeout: 10_000 }, async () => {
	// The pass line is now only for what is no source's. Valkey answers the lease request with the error reply ioredis
	// raises for a Valkey over its memory limit from 5 s to 8 s and at 13 s; the source (every 5 s) stays due through
	// each streak, since nothing asked it, and is polled at the first pass Valkey takes the request. A Valkey that does
	// not answer at all holds the pass instead, which this fake does not model.
	const dir = tempDir("watch-puller-valkey-");
	const path = join(dir, "triggers.json");
	writeFileSync(path, JSON.stringify({ watchSources: { prod: { verify: "hmac-sha256", secretEnv: "WATCH_SIGNING", maxPerDay: 10, pull: { kind: "file", path: "/var/log/shop.log", fields: { service: "checkout" }, intervalSeconds: 5 } } }, triggers: [] }));
	const deps = setup(); const lines = []; const polled = []; const clock = { ms: NOW }; let passes = 0; let puller;
	const down = (at) => (at >= 5_000 && at < 8_000) || at === 13_000;
	const set = deps.redis.set;
	deps.redis.set = async (...args) => { if (down(clock.ms - NOW)) throw new ReplyError("OOM command not allowed when used memory > 'maxmemory'."); return set(...args); };
	const adapterFactory = () => ({ async poll() { polled.push(clock.ms - NOW); return { findings: [], deliveries: [], cursor: {} }; } });
	const sleep = async () => { passes++; clock.ms += 1_000; if (passes >= 17) puller.stop(); };
	puller = await startWatchPuller({ PI_TRIGGERS_FILE: path }, { redis: deps.redis, store: deps.store, enqueue: deps.enqueue, adapterFactory, now: () => clock.ms, signals: false, out: value => lines.push(value), sleep });
	await puller.done;
	assert.deepEqual(polled, [0, 8_000, 14_000]);
	assert.deepEqual(lines.map(line => line.event === "watch_pull_failed" ? `failed ${line.reason}` : line.event), ["watch_pull_cycle", "failed valkey-unavailable-cursor-retained", "watch_pull_cycle", "failed valkey-unavailable-cursor-retained", "watch_pull_cycle"]);
});
