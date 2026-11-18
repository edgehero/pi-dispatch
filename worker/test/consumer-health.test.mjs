import assert from "node:assert/strict";
import { test } from "node:test";
import { consumerHealthOf, parseConsumerHealth } from "../src/consumer-health.mjs";

const consumer = (over = {}) => ({ role: "shared", state: "running", connection: "ready", active: 0, rateLimited: false, lastFetchAt: 1000, lastSuccessAt: 1000, lastTakenAt: null, fetchAgeMs: 10, successAgeMs: 10, ...over });
const row = (c = consumer(), over = {}) => ({ startedAt: "1000", ttlAgeMs: 20, consumers: JSON.stringify({ v: 1, startedAt: 1000, rows: [c] }), ...over });
test("idle, busy, paused, rate limited, reconnecting, terminal and stalled consumers are distinct", () => {
	for (const [changes, demand, want] of [
		[{}, {}, "idle"], [{ active: 1, successAgeMs: 900000 }, {}, "busy"],
		[{}, { paused: true, overdue: true }, "paused"], [{ rateLimited: true }, {}, "rate-limited"],
		[{ connection: "reconnecting" }, {}, "reconnecting"], [{ connection: "ended" }, {}, "failed"],
		[{ state: "failed" }, {}, "failed"], [{ state: "closing", connection: "ended" }, {}, "stopping"],
		[{ active: 1, connection: "reconnecting" }, {}, "reconnecting"], [{ successAgeMs: 130000 }, { paused: false, overdue: true }, "stalled"],
		[{ successAgeMs: 130000 }, { paused: false, overdue: false }, "unknown"],
	]) assert.equal(consumerHealthOf(row(consumer(changes)), { shared: demand }).rows[0].verdict, want);
});
test("missing, stale, unsupported and previous-generation observations cannot claim health", () => {
	for (const h of [{}, row(consumer(), { ttlAgeMs: 60001 }), row(consumer(), { startedAt: "2000" }), row(consumer(), { noExpiry: true }), row(consumer(), { consumers: JSON.stringify({ v: 2, startedAt: 1000, rows: [consumer()] }) })]) assert.equal(consumerHealthOf(h).state, "unknown");
	assert.equal(parseConsumerHealth(row(consumer({ role: "attacker text" }))), null);
	assert.equal(parseConsumerHealth(row(consumer({ successAgeMs: -1 }))), null);
});
test("reader clock skew and old last-taken time do not turn a responding idle consumer into failure", () => {
	assert.equal(consumerHealthOf(row(consumer({ lastTakenAt: 1 }), { staleMs: 99999999, skewMs: 99999999 })).state, "healthy");
});

test("a missing owned consumer leaves health unknown, and extra properties never cross the projection", () => {
	assert.equal(consumerHealthOf(row(consumer(), { routes: "true" })).state, "unknown");
	assert.equal(consumerHealthOf(row(consumer(), { routes: "false" })).state, "unknown");
	assert.equal(parseConsumerHealth(row(consumer({ secret: "not telemetry" })))[0].secret, undefined);
});

test("the consumer contract's vocabularies and projection match the reader in both directions", async () => {
	const { readFileSync } = await import("node:fs");
	const { CONSUMER_ROLES, CONSUMER_STATES, CONSUMER_CONNECTIONS, CONSUMER_VERDICTS, CONSUMER_FIELDS } = await import("../src/consumer-health.mjs");
	const spec = readFileSync(new URL("../../specs/interfaces.md", import.meta.url), "utf8").split("## INT-HOST-CONSUMERS\n")[1].split("\n## ")[0];
	for (const [name, values] of Object.entries({ role: CONSUMER_ROLES, state: CONSUMER_STATES, connection: CONSUMER_CONNECTIONS, verdict: CONSUMER_VERDICTS })) {
		const line = spec.split("\n").find((line) => line.startsWith(`| ${name} |`));
		assert.deepEqual([...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]), values);
	}
	const fields = spec.split("| Field | Meaning |")[1].split("\n\n")[0];
	assert.deepEqual(fields.split("\n").filter((l) => /^\| [A-Za-z]/.test(l)).map((l) => l.split("|")[1].trim()), CONSUMER_FIELDS);
	assert.deepEqual(Object.keys(parseConsumerHealth(row())[0]), CONSUMER_FIELDS);
});
