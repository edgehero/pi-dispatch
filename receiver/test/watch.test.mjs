import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import { makeWatchHandler } from "../src/watch.mjs";
import { watchSigningMessage } from "../src/verify-watch.mjs";
const NOW = Date.parse("2026-01-01T00:00:00Z");
const now = () => NOW;
const finding = { fields: { service: "checkout" }, severity: "error", count: 1, firstSeen: "2026-01-01T00:00:00Z", lastSeen: "2026-01-01T00:00:00Z", samples: ["private attacker text"] };
const config = () => ({ watchSources: { prod: { secretEnv: "WATCH_SECRET", maxBodyBytes: 65536, maxPerDay: 1000 } }, watchTriggers: [{ index: 0, on: { type: "watch", id: "errors", source: "prod", fingerprint: ["service"], match: { severity: ["error"] } }, run: { flow: "triage", folder: "/reviewed" } }] });
async function deliver({ cfg = config(), url = "/watch/prod", raw = JSON.stringify(finding), secret = "secret", mutate, ingest, enqueue, log } = {}) {
	const req = Readable.from([Buffer.from(raw)]); req.method = "POST"; req.url = url;
	const timestamp = String(NOW / 1000); const delivery = "delivery-1";
	req.headers = { "content-type": "application/json", "x-watch-id": delivery, "x-watch-timestamp": timestamp, "x-watch-signature": "v1=" + createHmac("sha256", secret).update(watchSigningMessage(timestamp, delivery, raw)).digest("hex") };
	if (mutate) mutate(req);
	const res = { headersSent: false, writeHead(status) { this.statusCode = status; this.headersSent = true; }, end(body) { this.body = body; } };
	const enqueued = []; const ingested = [];
	await makeWatchHandler({ cfg, now, env: { WATCH_SECRET: "secret" }, store: { ingest: async value => { ingested.push(value); return ingest ? ingest(value) : { status: "held", id: "finding-1", fingerprint: "abcdef", dueAt: NOW + 1000 }; } }, enqueue: enqueue ?? (async value => { enqueued.push(value); }), log })(req, res);
	return { res, enqueued, ingested };
}
test("watch signed finding queues only an evidence reference with reviewed trigger identity", async () => {
	const result = await deliver(); assert.equal(result.res.statusCode, 202);
	assert.deepEqual(result.enqueued, [{ id: "finding-1", ruleId: "errors", dueAt: NOW + 1000 }]);
	assert.doesNotMatch(JSON.stringify(result.enqueued), /private attacker|samples|folder|flow/);
	assert.equal(result.ingested[0].sourceMaxPerDay, 1000);
});
test("unknown source, invalid signature, malformed payload and source mismatch never ingest", async () => {
	for (const [options, status] of [[{ url: "/watch/unknown" }, 404], [{ secret: "wrong" }, 401], [{ raw: "{bad" }, 400], [{ raw: JSON.stringify({ ...finding, flow: "evil" }) }, 400], [{ raw: JSON.stringify({ ...finding, source: "other" }) }, 400]]) {
		const result = await deliver(options); assert.equal(result.res.statusCode, status); assert.equal(result.ingested.length, 0); assert.equal(result.enqueued.length, 0);
	}
});
test("unmatched, capped and suppressed findings never enqueue", async () => {
	const unmatched = await deliver({ raw: JSON.stringify({ ...finding, severity: "info" }) }); assert.equal(JSON.parse(unmatched.res.body).status, "unmatched"); assert.equal(unmatched.ingested.length, 0);
	for (const status of ["capped", "suppressed"]) { const result = await deliver({ ingest: () => ({ status }) }); assert.equal(JSON.parse(result.res.body).status, status); assert.equal(result.enqueued.length, 0); }
});
test("enqueue infrastructure failure is retryable and errors disclose no sample text", async () => {
	const result = await deliver({ enqueue: async () => { throw new Error("private attacker text"); } }); assert.equal(result.res.statusCode, 503); assert.doesNotMatch(result.res.body, /private attacker/);
});
test("watch logs contain only reviewed identities, digest prefix and verdict", async () => {
	const logs = []; await deliver({ log: (...args) => logs.push(args) }); assert.doesNotMatch(JSON.stringify(logs), /private attacker|samples|checkout/); assert.equal(logs[0][1].verdict, "held");
});
test("host redaction removes samples before private persistence and bad signatures log fixed verdicts", async () => {
	const accepted = await deliver(); assert.deepEqual(accepted.ingested[0].finding.samples, ["[redacted]"]);
	const logs = []; const rejected = await deliver({ secret: "wrong", log: (...args) => logs.push(args) });
	assert.equal(rejected.res.statusCode, 401); assert.deepEqual(logs, [["watch_signature", { source: "prod", verdict: "invalid" }]]);
});
test("missing configured fingerprint fields return determinate bad input rather than retryable failure", async () => {
	const result = await deliver({ ingest: () => { const error = new Error("missing fingerprint field"); error.piDispatchConfig = true; throw error; } });
	assert.equal(result.res.statusCode, 400); assert.equal(result.enqueued.length, 0);
});
