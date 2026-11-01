import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { endpointStatusFields, parseEndpointStatus, readEndpointStatus } from "../src/endpoint-status.mjs";
import { makeInFlight } from "../src/scoped-limits.mjs";
import { makeHostRegistry, HOST_TTL_MS } from "../src/host-registry.mjs";

const AT = Date.UTC(2026, 10, 1, 12);
const endpoint = (id = "model", slots = 2, host = "models.lan") => ({ id, slots, host, port: 11434 });
const fields = (entries) => ({ name: "mini1", beatAt: String(AT), startedAt: String(AT), endpointsStartedAt: String(AT), endpointsVersion: "1", endpointsMore: "0", endpoints: JSON.stringify(entries) });

function memory(names = ["mini1"], rows = {}) {
	const commands = [];
	return {
		commands, rows,
		scard: async () => (commands.push(["scard"]), names.length),
		sscan: async (_key, cursor) => (commands.push(["sscan", cursor]), ["0", names]),
		hgetall: async (key) => (commands.push(["hgetall", key]), rows[key] ?? {}),
		pttl: async (key) => (commands.push(["pttl", key]), rows[key] ? HOST_TTL_MS - 1000 : -2),
		hset: async (key, ...flat) => { rows[key] = { ...rows[key], ...Object.fromEntries(Array.from({ length: flat.length / 2 }, (_, i) => flat.slice(i * 2, i * 2 + 2))) }; },
		pexpire: async () => {}, sadd: async () => {}, del: async (key) => { delete rows[key]; }, srem: async () => {},
	};
}

test("endpoint status reads the admission map, reloads capacity, sorts and bounds names, and carries no address", () => {
	const slots = makeInFlight();
	slots.tryAcquire("model", 2); slots.tryAcquire("model", 2);
	for (const host of ["host.docker.internal", "host.containers.internal."]) {
		assert.deepEqual(JSON.parse(endpointStatusFields([endpoint("model", 1, host)], slots, true).endpoints), [{ id: "model", slots: 1, used: 2, fleet: 0 }]);
	}
	assert.equal(JSON.parse(endpointStatusFields([endpoint()], slots, false).endpoints)[0].used, 2);
	assert.equal(JSON.parse(endpointStatusFields([endpoint()], slots, false).endpoints)[0].fleet, 0);
	assert.equal(JSON.parse(endpointStatusFields([endpoint()], slots, true).endpoints)[0].fleet, 1);
	const many = Array.from({ length: 40 }, (_, i) => endpoint(`model-${String(39 - i).padStart(2, "0")}`));
	const output = endpointStatusFields(many, slots, true);
	assert.equal(output.endpointsMore, 8);
	assert.deepEqual(JSON.parse(output.endpoints).map((e) => e.id), Array.from({ length: 32 }, (_, i) => `model-${String(i).padStart(2, "0")}`));
	assert.doesNotMatch(JSON.stringify(output), /models\.lan|11434/);
	assert.equal(endpointStatusFields([], slots, true).endpoints, "");
	slots.release("model");
	assert.equal(JSON.parse(endpointStatusFields([endpoint()], slots, true).endpoints)[0].used, 1);
});

test("endpoint publication strips unknown fields and refuses newer, corrupt or unbounded records without inventing zero", () => {
	const entry = { id: "model", slots: 1, used: 2, fleet: 1, secret: "PRIVATE", path: "/private" };
	assert.deepEqual(parseEndpointStatus(fields([entry])), { state: "reported", endpoints: [{ id: "model", slots: 1, used: 2, fleet: 1 }], endpointsMore: 0 });
	assert.equal(parseEndpointStatus({}).state, "not-reported");
	const missing = fields([]); delete missing.endpoints;
	assert.equal(parseEndpointStatus(missing).state, "not-reported", "deleting just the optional data field is not a corrupt zero");
	assert.equal(parseEndpointStatus({ ...fields([]), endpointsVersion: "2" }).state, "unsupported");
	for (const row of [
		{ ...fields([]), endpoints: "bad" }, { ...fields([]), endpointsMore: "-1" },
		fields([{ ...entry, id: "/private" }]), fields([{ ...entry, used: -1 }]), fields([{ ...entry, used: 65 }]),
		fields([{ ...entry, slots: 0 }]), fields([{ ...entry, fleet: "1" }]), fields([entry, entry]),
		fields(Array.from({ length: 33 }, () => entry)),
	]) assert.deepEqual(parseEndpointStatus(row), { state: "unreadable", endpoints: null, endpointsMore: null });
});

test("registry publication and deletion have no effect on admission or its held slots", async () => {
	const redis = memory();
	const slots = makeInFlight();
	const registry = makeHostRegistry({ redis, name: "mini1", now: () => AT });
	slots.tryAcquire("model", 1);
	await registry.start({ endpointsVersion: 1, endpointsStartedAt: ({ startedAt }) => startedAt, endpoints: () => endpointStatusFields([endpoint("model", 1)], slots, true).endpoints, endpointsMore: 0 });
	let view = await readEndpointStatus(redis, { now: () => AT });
	assert.equal(view.hosts[0].endpoints[0].used, 1);
	assert.equal(view.hosts[0].ageMs, 1000);
	await redis.del("host:h:mini1");
	view = await readEndpointStatus(redis, { hosts: ["mini1"], now: () => AT });
	assert.equal(view.hosts[0].state, "not-reported");
	assert.equal(slots.tryAcquire("model", 1), false, "removing a display cannot free a slot");
	slots.release("model");
	await registry.publish();
	view = await readEndpointStatus(redis, { now: () => AT });
	assert.equal(view.hosts[0].endpoints[0].used, 0, "a verified idle count is different from deletion");
	await registry.close();
});

test("host discovery and row commands are bounded before reads, prioritizing known hosts and marking every cut", async () => {
	const names = Array.from({ length: 200 }, (_, i) => `host-${i}`);
	const redis = memory(names);
	const result = await readEndpointStatus(redis, { hosts: ["z-known", "host-199", "bad/path"], now: () => AT });
	assert.equal(result.partial, true);
	assert.equal(redis.commands.filter((c) => c[0] === "hgetall").length, 64);
	assert.deepEqual(redis.commands.filter((c) => c[0] === "hgetall").slice(0, 2), [["hgetall", "host:h:host-199"], ["hgetall", "host:h:z-known"]]);
	assert.ok(!JSON.stringify(redis.commands).includes("bad/path"));
	assert.equal(result.more, 136);
	const paging = memory([]);
	paging.scard = async () => 9999;
	let scans = 0;
	paging.sscan = async () => (scans++, [String(scans), []]);
	assert.equal((await readEndpointStatus(paging, { now: () => AT })).partial, true);
	assert.equal(scans, 4, "a sparse set cannot cause an unbounded discovery walk");
});

test("unread expiry, newer schemas and unavailable commands remain unknown, with all row waits bounded together", async () => {
	const redis = memory(["mini1", "mini2"], { "host:h:mini1": fields([{ id: "model", slots: 2, used: 0, fleet: 1 }]), "host:h:mini2": { ...fields([]), name: "mini2", endpointsVersion: "2" } });
	redis.pttl = async () => -1;
	const unknown = await readEndpointStatus(redis, { now: () => AT });
	assert.ok(unknown.hosts.every((h) => h.state === "unreadable" && h.endpoints === null));
	redis.pttl = async () => HOST_TTL_MS;
	assert.equal((await readEndpointStatus(redis, { now: () => AT })).hosts[1].state, "unsupported");
	redis.hgetall = () => new Promise(() => {});
	const timed = await readEndpointStatus(redis, { now: () => AT, timeoutMs: 10 });
	assert.equal(timed.state, "unknown");
	assert.equal(timed.partial, true);
	assert.equal((await readEndpointStatus({}, { now: () => AT })).state, "unknown");
});


test("the registry contract names exactly the endpoint fields the heartbeat publishes", () => {
	const spec = readFileSync(new URL("../../specs/interfaces.md", import.meta.url), "utf8").split("## INT-HOST-REGISTRY-CONTRACT\n")[1].split("\n## ")[0];
	const declared = [...spec.matchAll(/^    (endpoints[A-Za-z]*)\s/gm)].map((match) => match[1]);
	assert.deepEqual(declared.sort(), Object.keys(endpointStatusFields([], makeInFlight(), false)).sort());
});


test("known live hosts beyond the row cap remain counted when the entire index is lost", async () => {
	const known = Array.from({ length: 100 }, (_, i) => `known-${i}`);
	const redis = memory([]);
	const result = await readEndpointStatus(redis, { hosts: known, now: () => AT });
	assert.equal(redis.commands.filter((c) => c[0] === "hgetall").length, 64);
	assert.equal(result.hosts.length, 64);
	assert.equal(result.more, 36);
	assert.equal(result.partial, true);
});


test("an older worker reusing a crashed worker's hash cannot freshen its endpoint occupancy", async () => {
	const redis = memory();
	const slots = makeInFlight(); slots.tryAcquire("model", 2);
	const modern = makeHostRegistry({ redis, name: "mini1", now: () => AT });
	const older = makeHostRegistry({ redis, name: "mini1", now: () => AT + 1000 });
	const restarted = makeHostRegistry({ redis, name: "mini1", now: () => AT + 2000 });
	try {
		await modern.start(endpointStatusFields([endpoint()], slots, true));
		let status = await readEndpointStatus(redis, { now: () => AT });
		assert.equal(status.hosts[0].endpoints[0].used, 1);
		await older.start({ version: "older", concurrency: 2 });
		assert.equal(redis.rows["host:h:mini1"].endpointsStartedAt, String(AT), "the old HSET really preserved unknown fields");
		status = await readEndpointStatus(redis, { now: () => AT + 1000 });
		assert.equal(status.hosts[0].state, "unreadable");
		assert.equal(status.hosts[0].endpoints, null);
		assert.equal(slots.count("model"), 1, "generation checks cannot release admission state");
		await restarted.start(endpointStatusFields([endpoint()], slots, true));
		status = await readEndpointStatus(redis, { now: () => AT + 2000 });
		assert.equal(status.hosts[0].endpoints[0].used, 1);
		assert.equal(redis.rows["host:h:mini1"].endpointsStartedAt, String(AT + 2000));
	} finally { await modern.close(); await older.close(); await restarted.close(); }
});
