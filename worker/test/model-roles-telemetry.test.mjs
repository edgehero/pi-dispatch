import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import { makeLogSink, modelRolesTelemetryOf, parseExitModelRoles } from "../src/run-history.mjs";
const telemetry = { refusals: [{ agentHash: "a".repeat(64), reason: "unknown-role" }] };
const line = (value) => JSON.stringify({ event: "exit", code: 0, reason: "completed", modelRoles: value });

test("role telemetry reconstructs only hashes and closed refusal reasons", () => {
	assert.deepEqual(parseExitModelRoles(line({ ...telemetry, attacker: "private", refusals: [{ ...telemetry.refusals[0], name: "private" }] })), telemetry);
	for (const value of [null, {}, { refusals: [{ agentHash: "private", reason: "unknown-role" }] }, { refusals: [{ agentHash: "a".repeat(64), reason: "private" }] }, { refusals: Array(9).fill(telemetry.refusals[0]) }]) assert.equal(modelRolesTelemetryOf(value), null);
	assert.equal(parseExitModelRoles(line(telemetry) + "\n" + line({})), null, "decisive line does not resurrect old diagnostics");
});

test("role telemetry reaches the log sink only on a verified signed line", async () => {
	const key = "a1".repeat(32);
	const body = line(telemetry);
	const signed = `${body.slice(0, -1)},"auth":"${createHmac("sha256", key).update(body).digest("hex")}"}`;
	for (const [text, options, expected] of [[body, {}, undefined], [body, { exitKey: key }, undefined], [signed, { exitKey: key }, telemetry], [signed, { exitKey: "b2".repeat(32) }, undefined]]) {
		const sink = makeLogSink({ logsDir: "/unused", enabled: false })("roles", options);
		sink.write(Buffer.from(text + "\n"));
		const result = await sink.close();
		assert.deepEqual(result.modelRoles, expected);
	}
});
