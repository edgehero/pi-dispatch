import assert from "node:assert/strict";
import { test } from "node:test";
import { buildHookRun, parseHookRun, makeHookRunsPublisher, readHookRuns, hookRunsView, HOOK_HOSTS, hookRunsKey, HOOK_RUNS_TTL_MS, HOOK_PENDING_MAX } from "../src/hook-runs.mjs";

const AT = Date.UTC(2026, 10, 1, 12);
const fields = { jobId: "gh-1", outcome: "failed", reason: "infra", detail: "exit", code: 3 };
const flush = () => new Promise((resolve) => setImmediate(resolve));
function fake({ exec, names = ["mini1"], raw = [JSON.stringify(buildHookRun(fields, AT))], ttl = 1000 } = {}) {
	const calls = [];
	const redis = {
		calls,
		scard: async () => names.length,
		sscan: async () => ["0", names],
		lrange: async (...args) => { calls.push(["lrange", ...args]); return raw; },
		pttl: async () => ttl,
		multi: () => {
			const tx = {};
			for (const name of ["lpush", "ltrim", "pexpire", "sadd"]) tx[name] = (...args) => { calls.push([name, ...args]); return tx; };
			tx.exec = () => { calls.push(["exec"]); return exec ? exec() : Promise.resolve([[null, 1], [null, "OK"], [null, 1], [null, 1]]); };
			return tx;
		},
		pipeline: () => ({ eval() { return this; }, exec: async () => [] }),
	};
	return redis;
}

test("published records project ids, argv reason and closed words only, and reject future/corrupt records", () => {
	const record = buildHookRun({ ...fields, jobId: "../../private/hostile@example.com", outcome: "hostile", reason: "/private/reason", detail: "signal-PRIVATE", code: -1, body: "SECRET" }, AT);
	assert.match(record.jobId, /^sha256:[a-f0-9]{16}$/);
	assert.deepEqual({ ...record, jobId: null }, { v: 1, at: AT, jobId: null, outcome: null, reason: "infra", detail: "signal-unknown", code: null });
	assert.doesNotMatch(JSON.stringify(record), /private|hostile|SECRET/);
	assert.deepEqual(parseHookRun(JSON.stringify({ ...record, body: "SECRET" })), record);
	for (const change of [{ v: 2 }, { at: -1 }, { jobId: "path/private" }, { reason: "Uppercase" }, { detail: "signal-PRIVATE" }, { code: 0x100000000 }, { outcome: "completed" }]) assert.equal(parseHookRun(JSON.stringify({ ...record, ...change })), null);
	for (const code of [1000, 3221225477, 0xffffffff]) assert.equal(parseHookRun(JSON.stringify(buildHookRun({ ...fields, code }, AT))).code, code, "Windows process status remains visible");
	assert.equal(parseHookRun(" ".repeat(1025)), null);
	assert.equal(parseHookRun("{}"), null);
	assert.equal(parseHookRun(JSON.stringify(buildHookRun({ ...fields, detail: "signal-SIGBREAK" }, AT))).detail, "signal-SIGBREAK");
});

test("simultaneous completions are serialized once, with exact transaction trim, expiry and index", async () => {
	let release;
	let call = 0;
	const redis = fake({ exec: () => ++call === 1 ? new Promise((resolve) => { release = resolve; }) : Promise.resolve([[null, 1], [null, "OK"], [null, 1], [null, 1]]) });
	const publisher = makeHookRunsPublisher({ redis, name: "mini1", now: () => AT });
	assert.equal(publisher.publish(fields), undefined);
	publisher.publish({ ...fields, jobId: "gh-2" });
	assert.equal(redis.calls.filter((c) => c[0] === "exec").length, 1);
	release([[null, 1], [null, "OK"], [null, 1], [null, 1]]);
	await flush();
	assert.equal(redis.calls.filter((c) => c[0] === "exec").length, 2);
	assert.deepEqual(redis.calls.filter((c) => c[0] === "lpush").map((c) => JSON.parse(c[2]).jobId), ["gh-1", "gh-2"]);
	assert.deepEqual(redis.calls.slice(1, 4), [["ltrim", hookRunsKey("mini1"), 0, 19], ["pexpire", hookRunsKey("mini1"), HOOK_RUNS_TTL_MS], ["sadd", HOOK_HOSTS, "mini1"]]);
	publisher.close();
});

test("a timed-out actual command retains the drain; overflow is bounded and named, close discards pending", async () => {
	const redis = fake({ exec: () => new Promise(() => {}) });
	const logs = [];
	const publisher = makeHookRunsPublisher({ redis, name: "mini1", now: () => AT, timeoutMs: 5, log: (event, values) => logs.push({ event, ...values }) });
	for (let i = 0; i < HOOK_PENDING_MAX + 2; i++) publisher.publish({ ...fields, jobId: `gh-${i}` });
	await new Promise((resolve) => setTimeout(resolve, 15));
	assert.equal(redis.calls.filter((c) => c[0] === "exec").length, 1, "a promise race cannot free the actual pending command");
	assert.equal(logs.filter((line) => line.reason === "full").length, 2);
	assert.equal(logs.filter((line) => line.reason === "unavailable").length, 1);
	publisher.close();
	publisher.publish(fields);
	assert.equal(logs.length, 3);
});

test("rejections, command tuple failures and invalid names never throw or print client text", async () => {
	for (const exec of [() => { throw Error("private-path"); }, () => Promise.reject(Error("secret-token")), () => Promise.resolve([[Error("private"), null], [null, "OK"], [null, 1], [null, 1]])]) {
		const logs = [];
		const publisher = makeHookRunsPublisher({ redis: fake({ exec }), name: "mini1", now: () => AT, log: (event, values) => logs.push({ event, ...values }) });
		publisher.publish(fields);
		await flush();
		assert.deepEqual(logs, [{ event: "hook_runs_publish_failed", reason: "unavailable" }]);
		publisher.close();
	}
	const redis = fake();
	const publisher = makeHookRunsPublisher({ redis, name: "../bad", now: () => AT, log() { throw Error("sink"); } });
	publisher.publish(fields);
	assert.equal(redis.calls.length, 0);
});

test("readers bound row commands, prefer live names, recover a lost index and expose corrupt TTL/version as unknown", async () => {
	const redis = fake({ names: Array.from({ length: 80 }, (_, i) => `host-${i}`) });
	const read = await readHookRuns(redis, { names: ["live-first"] });
	assert.equal(read.hosts.length, 64);
	assert.ok(read.hosts.some((row) => row.name === "live-first"));
	assert.equal(redis.calls.filter((c) => c[0] === "lrange").length, 64);
	assert.ok(read.more > 0);
	assert.equal(read.partial, true);
	const hundred = Array.from({ length: 100 }, (_, index) => `host-${index}`);
	const overlap = await readHookRuns(fake({ names: hundred }), { names: hundred });
	assert.equal(overlap.more, 36, "live names and the same indexed names are one union");
	assert.equal(overlap.moreUnknown, false);
	const incomplete = fake({ names: hundred }); incomplete.sscan = async () => ["7", hundred.slice(0, 10)];
	const floor = await readHookRuns(incomplete, { names: hundred });
	assert.equal(floor.more, 36);
	assert.equal(floor.moreUnknown, true);
	const lost = await readHookRuns(fake({ names: [] }), { names: ["mini1"] });
	assert.equal(lost.hosts[0].runs[0].code, 3);
	for (const opts of [{ ttl: -1 }, { ttl: HOOK_RUNS_TTL_MS + 1 }, { raw: [JSON.stringify({ ...buildHookRun(fields, AT), v: 2 })] }, { raw: Array(21).fill(JSON.stringify(buildHookRun(fields, AT))) }, { raw: ["x".repeat(1025)] }]) {
		const unknown = hookRunsView(await readHookRuns(fake(opts)));
		assert.equal(unknown.hosts[0].unreadable, true);
		assert.equal(unknown.hosts[0].counts, null);
	}
	const absent = hookRunsView(await readHookRuns(fake({ names: [], raw: [], ttl: -2 }), { names: ["mini1"] }));
	assert.equal(absent.hosts[0].absent, true);
	const down = fake(); down.scard = () => { throw Error("secret"); };
	assert.equal((await readHookRuns(down, { names: ["mini1"] })).partial, true);
});

test("the display/model boundary recomputes counts and strips arbitrary DTO values", () => {
	const view = hookRunsView({ partial: false, more: 2, hosts: [{ name: "mini1", runs: [buildHookRun(fields, AT), buildHookRun({ ...fields, code: 0 }, AT)], counts: { SECRET: 99 }, body: "PRIVATE" }, { name: "../PRIVATE", runs: [] }] });
	assert.equal(view.hosts.length, 1);
	assert.deepEqual(view.hosts[0].counts, { exit: 2 });
	assert.doesNotMatch(JSON.stringify(view), /SECRET|PRIVATE/);
	assert.equal(hookRunsView({ partial: false, hosts: [{ name: "mini1", runs: [{ ...buildHookRun(fields, AT), v: 2 }] }] }).hosts[0].counts, null);
	const over = hookRunsView({ partial: false, hosts: Array.from({ length: 70 }, (_, index) => ({ name: `host-${index}`, runs: [] })) });
	assert.equal(over.hosts.length, 64);
	assert.equal(over.more, 6);
	assert.equal(over.partial, true);
});

test("one deadline covers discovery and rows; late discovery cannot issue further commands", async () => {
	let resolvePage;
	let scans = 0;
	const redis = fake({ names: ["mini1"] });
	redis.sscan = () => { scans++; return new Promise((resolve) => { resolvePage = resolve; }); };
	const result = await readHookRuns(redis, { names: ["mini1"], timeoutMs: 5 });
	assert.equal(result.partial, true);
	assert.deepEqual(result.hosts, []);
	resolvePage(["1", ["mini1"]]);
	await flush();
	assert.equal(scans, 1);
	assert.equal(redis.calls.filter((call) => call[0] === "lrange").length, 0, "the expired read cannot launch rows after discovery settles");
});
