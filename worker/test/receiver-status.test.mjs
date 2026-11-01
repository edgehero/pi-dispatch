import assert from "node:assert/strict";
import { test } from "node:test";
import { makeReceiverObservations, makeReceiverPublisher, parseReceiverStatus, readReceiverStatus, receiverBind, receiverForgeFacts, receiverKey, receiverOutcome, RECEIVER_FORGES, RECEIVER_OUTCOMES, RECEIVER_LIVE, RECEIVER_TTL_MS } from "../src/receiver-status.mjs";

const AT = Date.UTC(2026, 10, 1, 12, 30);
const HOUR = 3_600_000;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const record = (name = "mini1", at = AT) => ({ v: 1, name, version: "4.3.1", startedAt: at - 60_000, at, port: 3000, bind: "all", forges: ["github"], deliveries: makeReceiverObservations({ now: () => at }).snapshot() });
function redisFake() {
	const values = new Map(); const members = new Set(); const calls = [];
	return { values, members, calls,
		async set(k, value, px, ttl) { calls.push(["set", k, px, ttl]); values.set(k, value); return "OK"; },
		async sadd(_, name) { calls.push(["sadd", name]); members.add(name); return 1; },
		async sscan(_, cursor) { calls.push(["sscan", cursor]); return ["0", [...members]]; },
		async mget(...keys) { calls.push(["mget", ...keys]); return keys.map((k) => values.get(k) ?? null); },
		async pttl(k) { calls.push(["pttl", k]); return values.has(k) ? 89_000 : -2; },
		async srem(_, ...names) { calls.push(["srem", ...names]); for (const n of names) members.delete(n); },
		async eval(_script, n, _index, ...args) { calls.push(["eval"]); let removed = 0; for (let i = 0; i < n - 1; i++) if (!values.has(args[i])) { removed += members.delete(args[n - 1 + i]) ? 1 : 0; } return removed; },
	};
}

test("closed response mapping distinguishes every accepted/refused word without reading content (#775)", () => {
	for (const word of ["queued", "deduplicated", "held", "steered"]) assert.equal(receiverOutcome(202, word), word);
	for (const [code, expected] of [[204, "dropped"], [401, "unauthorized"], [404, "not-configured"], [400, "malformed"], [405, "malformed"], [413, "malformed"], [415, "malformed"], [500, "error"]]) assert.equal(receiverOutcome(code), expected);
	assert.equal(receiverOutcome(503, "lookup-failed"), "lookup-failed");
	assert.equal(receiverOutcome(503, "enqueue-failed"), "enqueue-failed");
	for (const [code, word] of [[202, "sentinel"], [503, "sentinel"], [200, "queued"]]) assert.equal(receiverOutcome(code, word), null);
});

test("24 UTC-hour buckets roll over, idle away and remain bounded across reversal and floods (#775)", () => {
	let at = AT; const now = () => at;
	const obs = makeReceiverObservations({ now });
	for (let i = 0; i < 10_000; i++) obs.observe("github", 401);
	const before = obs.snapshot();
	assert.equal(before.github.unauthorized.hours.length, 24);
	assert.equal(receiverForgeFacts({ deliveries: before }, "github", now()).counts.unauthorized, 10_000);
	at += 24 * HOUR;
	assert.equal(receiverForgeFacts({ deliveries: obs.snapshot() }, "github", now()).counts.unauthorized, 0);
	assert.equal(obs.snapshot().github.unauthorized.lastAt, AT, "last events are independent of the bucket window");
	at = AT;
	obs.observe("github", 401);
	assert.equal(obs.snapshot().github.unauthorized.hours.reduce((n, r) => n + r[1], 0), 0, "an expired hour is not resurrected when the clock reverses");
	assert.ok(Object.values(obs.snapshot()).every((forge) => Object.values(forge).every((word) => word.hours.length === 24)));
});

test("the record reader rebuilds all fields and refuses newer versions, bad dates, missing counts and excessive bytes (#775)", () => {
	const r = record();
	const parsed = parseReceiverStatus(JSON.stringify({ ...r, address: "PRIVATE_ADDRESS", body: "PRIVATE_BODY" }));
	assert.deepEqual(parsed, r);
	for (const bad of [{ ...r, v: 2 }, { ...r, version: 1 }, { ...r, at: Number.MAX_SAFE_INTEGER }, { ...r, name: "a/b" }, { ...r, forges: ["github", "github"] }, { ...r, deliveries: {} }]) assert.equal(parseReceiverStatus(JSON.stringify(bad)), null);
	assert.equal(parseReceiverStatus(" ".repeat(65537)), null);
});

test("only a closed bind word leaves the listening socket (#775)", () => {
	for (const [address, expected] of [["0.0.0.0", "all"], ["::", "all"], ["::1", "loopback"], ["127.4.5.6", "loopback"], ["::ffff:127.0.0.1", "loopback"], ["192.0.2.1", "address"]]) assert.equal(receiverBind(address), expected);
	assert.equal(receiverBind(undefined), null);
});

test("publisher writes whole JSON with expiry, indexes it, prunes only bounded expired observations and stops (#775)", async () => {
	const redis = redisFake(); redis.members.add("expired");
	let every; let unref = 0; let cleared = 0;
	const publisher = makeReceiverPublisher({ client: () => redis, ...record(), observations: makeReceiverObservations({ now: () => AT }), now: () => AT, setIntervalFn: (fn) => { every = fn; return { unref: () => unref++ }; }, clearIntervalFn: () => cleared++ });
	publisher.start(); await tick();
	assert.deepEqual(redis.calls[0], ["set", receiverKey("mini1"), "PX", 90_000]);
	assert.ok(parseReceiverStatus(redis.values.get(receiverKey("mini1"))));
	assert.equal(redis.members.has("mini1"), true); assert.equal(redis.members.has("expired"), false);
	assert.equal(unref, 1);
	publisher.close(); every(); await tick();
	assert.equal(cleared, 1); assert.equal(redis.calls.filter((c) => c[0] === "set").length, 1);
});

test("a timed out client stays one actual flight; close prevents a late connection from publishing (#775)", async () => {
	let release; let asked = 0; const logs = [];
	const client = new Promise((resolve) => { release = resolve; });
	const publisher = makeReceiverPublisher({ client: () => { asked++; return client; }, ...record(), observations: makeReceiverObservations({ now: () => AT }), now: () => AT, timeoutMs: 5, log: (event, fields) => logs.push({ event, ...fields }) });
	publisher.beat(); await new Promise((resolve) => setTimeout(resolve, 12));
	publisher.beat(); publisher.beat();
	assert.equal(asked, 1); assert.deepEqual(logs, [{ event: "receiver_status_unavailable", reason: "timeout" }]);
	const redis = redisFake(); publisher.close(); release(redis); await tick();
	assert.deepEqual(redis.calls, []);
});

test("invalid identities and throwing sinks never construct a client or throw (#775)", () => {
	let calls = 0;
	const p = makeReceiverPublisher({ client: () => { calls++; throw new Error("PRIVATE"); }, ...record("bad/name"), observations: {}, log: () => { throw new Error("sink"); }, now: () => AT });
	p.start(); p.beat(); p.close(); assert.equal(calls, 0);
});

test("close after SET prevents a late SADD; rejected writes expose no error values (#775)", async () => {
	let finish; const redis = redisFake(); redis.set = () => new Promise((resolve) => { finish = resolve; });
	const p = makeReceiverPublisher({ client: () => redis, ...record(), observations: makeReceiverObservations({ now: () => AT }), now: () => AT });
	p.beat(); await tick(); p.close(); finish("OK"); await tick(); assert.deepEqual(redis.calls, []);
	const logs = [];
	const broken = makeReceiverPublisher({ client: () => { throw new Error("SECRET_ADDRESS"); }, ...record(), observations: {}, now: () => AT, log: (event, fields) => logs.push({ event, ...fields }) });
	broken.beat(); await tick(); assert.deepEqual(logs, [{ event: "receiver_status_unavailable", reason: "write" }]); broken.close();
});

test("read discovery is capped before commands, prioritizes live names and reports incomplete population (#775)", async () => {
	const redis = redisFake();
	for (let i = 0; i < 300; i++) redis.members.add(`a${i}`);
	redis.values.set(receiverKey("live"), JSON.stringify(record("live")));
	const view = await readReceiverStatus(redis, { names: ["live"], now: () => AT });
	assert.equal(view.complete, false); assert.equal(view.hosts[0].name, "live"); assert.equal(view.hosts[0].ageMs, 1000);
	const get = redis.calls.find((c) => c[0] === "mget"); assert.equal(get.length, 65); assert.equal(get[1], receiverKey("live"));
});

test("expiry is authoritative across clock skew; nonexpiring/corrupt data and failed index/read are unknown (#775)", async () => {
	const redis = redisFake(); redis.members.add("mini1"); redis.values.set(receiverKey("mini1"), JSON.stringify(record("mini1", AT - 120_000)));
	let view = await readReceiverStatus(redis, { now: () => AT }); assert.equal(view.complete, true); assert.equal(view.hosts[0].ageMs, 1000);
	redis.pttl = async () => -1;
	view = await readReceiverStatus(redis, { now: () => AT }); assert.equal(view.complete, false); assert.equal(view.hosts[0].unreadable, true);
	redis.sscan = async () => { throw new Error("SECRET"); }; redis.pttl = async () => 90_000;
	view = await readReceiverStatus(redis, { names: ["mini1"], now: () => AT }); assert.equal(view.complete, false); assert.equal(view.hosts[0].name, "mini1"); assert.doesNotMatch(JSON.stringify(view), /SECRET/);
	redis.mget = async () => []; view = await readReceiverStatus(redis, { names: ["mini1"], now: () => AT }); assert.equal(view.complete, false); assert.equal(view.hosts[0].unreadable, true);
});

test("the complete vocabulary is fixed at four forges and eleven words (#775)", () => {
	assert.equal(RECEIVER_FORGES.length, 4); assert.equal(RECEIVER_OUTCOMES.length, 11); assert.equal(RECEIVER_LIVE, "receiver:live"); assert.equal(RECEIVER_TTL_MS, 90_000);
});

test("the interface outcome table is pinned both ways to the exported closed vocabulary (#775)", async () => {
	const { readFileSync } = await import("node:fs");
	const spec = readFileSync(new URL("../../specs/interfaces.md", import.meta.url), "utf8");
	const block = spec.split("<!-- receiver-outcomes:start -->")[1].split("<!-- receiver-outcomes:end -->")[0];
	const words = [...block.matchAll(/^\| ([a-z][a-z-]+) \|/gm)].map((m) => m[1]);
	assert.deepEqual(words, RECEIVER_OUTCOMES);
});

test("one deadline bounds the entire discovery and starts no row commands after slow pages exhaust it (#775)", async () => {
	let scans = 0; let gets = 0;
	const redis = { async sscan() { scans++; await new Promise((resolve) => setTimeout(resolve, 12)); return ["1", ["mini1"]]; }, mget() { gets++; return []; }, pttl() { throw new Error("late read"); } };
	const read = await readReceiverStatus(redis, { now: () => AT, timeoutMs: 20 });
	assert.equal(read.complete, false); assert.equal(read.moreUnknown, true); assert.ok(scans <= 2); assert.equal(gets, 0);
});

test("an index member republished while a prune starts cannot lose its fresh membership (#775)", async () => {
	const redis = redisFake(); redis.members.add("restarted");
	const scan = redis.sscan; redis.sscan = async (...args) => { const answer = await scan(...args); redis.values.set(receiverKey("restarted"), JSON.stringify(record("restarted"))); return answer; };
	const publisher = makeReceiverPublisher({ client: () => redis, ...record(), observations: makeReceiverObservations({ now: () => AT }), now: () => AT });
	publisher.beat(); await tick(); publisher.close();
	assert.equal(redis.members.has("restarted"), true); assert.equal(redis.calls.some((c) => c[0] === "eval"), true);
});
