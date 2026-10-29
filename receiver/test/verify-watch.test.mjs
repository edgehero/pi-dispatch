import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { Readable } from "node:stream";
import { test } from "node:test";
import { makeWatchVerifiedHandler, verifyWatchSignature, watchSigningMessage } from "../src/verify-watch.mjs";
const NOW = 1767225600000;
const now = () => NOW;
const secret = "test-watch-secret";
const timestamp = String(NOW / 1000);
const delivery = "delivery-1";
function sign(rawBody, ts = timestamp, id = delivery) { return "v1=" + createHmac("sha256", secret).update(watchSigningMessage(ts, id, rawBody)).digest("hex"); }
function response() { return { headersSent: false, writeHead(status) { this.statusCode = status; this.headersSent = true; }, end(body) { this.body = body; } }; }
async function request({ raw = "{}", headers = {}, method = "POST", limit = 65536, callback } = {}) {
	let called = 0; const req = Readable.from([Buffer.from(raw)]); req.method = method;
	req.headers = { "content-type": "application/json", "x-watch-id": delivery, "x-watch-timestamp": timestamp, "x-watch-signature": sign(raw), ...headers };
	const res = response();
	await makeWatchVerifiedHandler({ secret, bodyLimit: limit, now }, async (value, reply) => { called++; if (callback) return callback(value, reply); reply.writeHead(202); reply.end(); })(req, res);
	return { res, called };
}
test("signed raw bytes are passed through without parsing, including malformed JSON", async () => {
	const raw = "{ bad json";
	const result = await request({ raw, callback: (value, res) => { assert.equal(value.rawBody, raw); assert.equal(value.delivery, delivery); res.writeHead(202); res.end(); } });
	assert.equal(result.called, 1); assert.equal(result.res.statusCode, 202);
});
test("signature binds version, timestamp, delivery and exact body bytes", () => {
	const base = { secret, timestamp, delivery, signature: sign("{}"), rawBody: "{}", now };
	assert.equal(verifyWatchSignature(base), true);
	for (const patch of [{ rawBody: "{ }" }, { delivery: "other" }, { timestamp: String(Number(timestamp) + 1) }, { signature: "v2=" + "a".repeat(64) }, { signature: "v1=abc" }, { timestamp: [timestamp] }, { delivery: "has.dot" }]) assert.equal(verifyWatchSignature({ ...base, ...patch }), false);
});
test("signed timestamp accepts exact skew bounds and refuses outside them with injected clock", () => {
	for (const offset of [-300, 300, -301, 301]) {
		const ts = String(Number(timestamp) + offset);
		assert.equal(verifyWatchSignature({ secret, timestamp: ts, delivery, signature: sign("{}", ts), rawBody: "{}", now }), Math.abs(offset) <= 300);
	}
});
test("invalid signature and absent headers never reach downstream", async () => {
	for (const headers of [{ "x-watch-signature": "v1=" + "0".repeat(64) }, { "x-watch-id": undefined }, { "x-watch-timestamp": undefined }, { "x-watch-signature": undefined }]) {
		const result = await request({ headers }); assert.equal(result.res.statusCode, 401); assert.equal(result.called, 0);
	}
});
test("method, media type, declared and streamed body limits refuse before callback", async () => {
	for (const [options, status] of [[{ method: "GET" }, 405], [{ headers: { "content-type": "text/plain" } }, 415], [{ headers: { "content-length": "999" }, limit: 10 }, 413], [{ raw: "x".repeat(11), limit: 10 }, 413]]) {
		const result = await request(options); assert.equal(result.res.statusCode, status); assert.equal(result.called, 0);
	}
});
test("downstream infrastructure failure returns a retryable response without exposing exception text", async () => {
	const result = await request({ callback: () => { throw new Error("sensitive body value"); } });
	assert.equal(result.res.statusCode, 503); assert.doesNotMatch(result.res.body, /sensitive/);
});
test("unconfigured secret and invalid configured body limits refuse construction", () => {
	assert.throws(() => makeWatchVerifiedHandler({ secret: "", now }, () => {}));
	assert.throws(() => makeWatchVerifiedHandler({ secret, bodyLimit: 65537, now }, () => {}));
});
