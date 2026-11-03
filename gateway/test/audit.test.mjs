import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { gatewayRandom } from "@edgehero/pi-dispatch/sandbox-gateway-protocol";
import { makeGatewayAudit } from "../src/audit.mjs";

test("opening and applied receipts are separate, crash recovery closes metadata without recording bytes", async () => {
	const logsDir = tempDir("gateway-audit-"), rows = [], now = () => 0;
	const intent = { actor: { name: "ops", role: "operator", session: "a".repeat(12) }, target: { host: "host-a", id: "run-a", nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "local" }, question: "PRIVATE", token: "SECRET" };
	const journal = makeGatewayAudit({ logsDir, now, audit: { append: row => { rows.push(row); } }, pidAlive: () => false });
	const id = gatewayRandom(); await journal.record("opening", intent, id); await journal.record("open", intent, id);
	assert.equal(readdirSync(join(logsDir, "sandbox-gateway-active")).length, 1);
	journal.recover(); assert.deepEqual(rows.map(r => r.kind), ["sandbox-browser-opening", "sandbox-browser-open", "sandbox-browser-end"]);
	assert.equal(rows[2].reason, "gateway-stopped"); assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|SECRET/); assert.equal(readdirSync(join(logsDir, "sandbox-gateway-active")).length, 0);
});
test("a second gateway cannot invent an end for another live process's attachment", async () => {
	const logsDir = tempDir("gateway-audit-live-"), rows = [], now = () => 0;
	const intent = { actor: { name: "ops", role: "operator", session: "a".repeat(12) }, target: { host: "host-a", id: "run-a", nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "local" } };
	const first = makeGatewayAudit({ logsDir, now, pid: 12345, audit: { append: row => { rows.push(row); } } });
	await first.record("opening", intent, gatewayRandom());
	const second = makeGatewayAudit({ logsDir, now, pid: 12346, pidAlive: id => id === 12345, audit: { append: row => { rows.push(row); } } });
	second.recover(); assert.deepEqual(rows.map(r => r.kind), ["sandbox-browser-opening"]); assert.equal(readdirSync(join(logsDir, "sandbox-gateway-active")).length, 1);
});

test("watch audit journals preserve both safe identities across crash recovery while control receipts never consume the live journal", async () => {
	const logsDir = tempDir("gateway-watch-audit-"), rows = [], now = () => 0;
	const actor = { name: "lee", role: "operator", session: "b".repeat(12) }, driverActor = { name: "ops", role: "operator", session: "a".repeat(12) };
	const intent = { kind: "watch", actor, driverActor, runFacts: { target: "PRIVATE RUN CONTEXT" }, token: "SECRET", target: { host: "host-a", id: "run-a", nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "local" } };
	const journal = makeGatewayAudit({ logsDir, now, pidAlive: () => false, audit: { append: row => rows.push(row) } });
	const id = gatewayRandom(); await journal.record("opening", intent, id); await journal.record("open", intent, id);
	assert.deepEqual(rows.map(r => r.kind), ["sandbox-watch-opening", "sandbox-watch-start"]);
	assert.ok(rows.every(r => JSON.stringify(r.driver) === JSON.stringify(driverActor)));
	journal.recover();
	assert.deepEqual(rows.at(-1), { actor, action: "write", kind: "sandbox-watch-end", target: `host-a/${"b".repeat(64)}`, outcome: "ok", reason: "gateway-stopped", driver: driverActor });
	assert.doesNotMatch(JSON.stringify(rows), /PRIVATE|SECRET|runFacts|nonce/);
	const drive = { ...intent, kind: "drive" }; await journal.record("opening", drive, id); await journal.record("open", drive, id);
	for (const [kind, reason] of [["policy-intent", "watch-enabled-requested"], ["policy", "watch-enabled"], ["remove-intent", "watch-removed-requested"], ["remove", "watch-removed"]]) await journal.record(kind, drive, id, reason);
	assert.equal(readdirSync(join(logsDir, "sandbox-gateway-active")).length, 1, "driver policy accounting cannot erase the crash-ending receipt");
	assert.deepEqual(rows.slice(-4).map(r => [r.kind, r.reason, r.driver]), [["sandbox-watch-policy", "watch-enabled-requested", undefined], ["sandbox-watch-policy", "watch-enabled", undefined], ["sandbox-watch-remove", "watch-removed-requested", undefined], ["sandbox-watch-remove", "watch-removed", undefined]]);
	await journal.record("end", drive, id, "disconnected"); assert.equal(readdirSync(join(logsDir, "sandbox-gateway-active")).length, 0);
});

test("a watch without a strictly safe driver cannot create even an opening journal", async () => {
	const logsDir = tempDir("gateway-watch-audit-bad-"), rows = [];
	const journal = makeGatewayAudit({ logsDir, now: () => 0, audit: { append: row => rows.push(row) } });
	const intent = { kind: "watch", actor: { name: "lee", role: "operator", session: "a".repeat(12) }, target: { host: "host-a", id: "run-a", nonce: "a".repeat(32), containerId: "b".repeat(64), venue: "local" } };
	for (const driverActor of [undefined, { name: "ops", role: "viewer", session: "a".repeat(12) }, { name: "ops", role: "operator", session: "a".repeat(12), rawSession: "SECRET" }]) await assert.rejects(journal.record("opening", { ...intent, driverActor }, gatewayRandom()), /driver identity/);
	assert.deepEqual(rows, []);
});
