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
