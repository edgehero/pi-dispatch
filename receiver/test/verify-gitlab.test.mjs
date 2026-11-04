import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac, createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { makeGitLabVerifiedHandler, decodeSigningToken, verifyToken } from "../src/verify-gitlab.mjs";

const RAW_KEY = Buffer.from("0123456789abcdef0123456789abcdef");
const SIGNING_TOKEN = `whsec_${RAW_KEY.toString("base64")}`;
const SHARED_TOKEN = "a-shared-secret";
const NOW = 1_700_000_000_000;

/** GitLab's Standard Webhooks signature: HMAC-SHA256 over `{id}.{timestamp}.{body}`, base64, `v1,`-tagged. */
function sign(raw, { id = "wh-1", timestamp = String(NOW / 1000), key = RAW_KEY } = {}) {
	return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`, "utf8").digest("base64")}`;
}

function mockReq({ method = "POST", headers = {} } = {}) {
	const req = new EventEmitter();
	req.method = method;
	req.headers = { "content-type": "application/json", ...headers };
	req.destroyed = false;
	req.destroy = () => {
		req.destroyed = true;
	};
	return req;
}

function mockRes() {
	return {
		statusCode: 0,
		headersSent: false,
		body: undefined,
		writeHead(status) {
			this.statusCode = status;
			this.headersSent = true;
		},
		end(body) {
			this.body = body;
		},
	};
}

async function drive(handler, req, res, raw) {
	const p = handler(req, res);
	req.emit("data", Buffer.from(raw, "utf8"));
	req.emit("end");
	await p;
}

/** Signature-mode headers for `raw`, with the id/timestamp that were actually signed. */
function sigHeaders(raw, over = {}) {
	const id = over.id ?? "wh-1";
	const timestamp = over.timestamp ?? String(NOW / 1000);
	return {
		"x-gitlab-event": "Issue Hook",
		"webhook-id": id,
		"webhook-timestamp": timestamp,
		"webhook-signature": over.signature ?? sign(raw, { id, timestamp }),
	};
}

const sigHandler = (onVerified, over = {}) =>
	makeGitLabVerifiedHandler({ mode: "signature", secret: SIGNING_TOKEN, now: () => NOW, ...over }, onVerified);
const tokenHandler = (onVerified, over = {}) =>
	makeGitLabVerifiedHandler({ mode: "token", secret: SHARED_TOKEN, ...over }, onVerified);

const RAW = JSON.stringify({ object_kind: "issue" });
const ok = async (_ctx, res) => {
	res.writeHead(202);
	res.end();
};

// --- signature mode ---

test("a correctly signed delivery verifies and reaches onVerified with the raw body", async () => {
	let seen = null;
	const req = mockReq({ headers: sigHeaders(RAW) });
	const res = mockRes();
	await drive(sigHandler(async (ctx, r) => ((seen = ctx), r.writeHead(202), r.end())), req, res, RAW);
	assert.equal(res.statusCode, 202);
	assert.equal(seen.rawBody, RAW, "the HMAC is computed over the bytes that arrived, and those bytes are what is passed on");
	assert.equal(seen.delivery, "wh-1");
	assert.equal(seen.event, "Issue Hook");
});

test("a signature computed over DIFFERENT bytes is 401", async () => {
	// The property a token compare cannot give: the body is covered, so tampering after signing is caught.
	const req = mockReq({ headers: sigHeaders("something else entirely") });
	const res = mockRes();
	await drive(sigHandler(ok), req, res, RAW);
	assert.equal(res.statusCode, 401);
});

test("a signature over the body ALONE is rejected -- the id and timestamp are inside the MAC", async () => {
	const bare = `v1,${createHmac("sha256", RAW_KEY).update(RAW, "utf8").digest("base64")}`;
	const req = mockReq({ headers: sigHeaders(RAW, { signature: bare }) });
	const res = mockRes();
	await drive(sigHandler(ok), req, res, RAW);
	assert.equal(res.statusCode, 401, "signing only the body would leave the timestamp forgeable, and the replay window with it");
});

test("a stale timestamp is refused even though its signature is perfectly valid", async () => {
	// This is the point of checking it at all: a captured delivery stays cryptographically good forever,
	// so age is the only thing that can refuse a replay once the queue's dedup key has aged out.
	const old = String((NOW - 10 * 60 * 1000) / 1000);
	const req = mockReq({ headers: sigHeaders(RAW, { timestamp: old }) });
	const res = mockRes();
	await drive(sigHandler(ok), req, res, RAW);
	assert.equal(res.statusCode, 401);
});

test("several space-separated signatures verify when ANY is ours, and none is not a match", async () => {
	const mine = sign(RAW);
	const theirs = sign(RAW, { key: Buffer.from("a-completely-different-key-32byt") });
	for (const header of [`${theirs} ${mine}`, `${mine} ${theirs}`]) {
		const res = mockRes();
		await drive(sigHandler(ok), mockReq({ headers: sigHeaders(RAW, { signature: header }) }), res, RAW);
		assert.equal(res.statusCode, 202, "key rotation sends both; one of them being ours is enough");
	}
	const res = mockRes();
	await drive(sigHandler(ok), mockReq({ headers: sigHeaders(RAW, { signature: `${theirs} ${theirs}` }) }), res, RAW);
	assert.equal(res.statusCode, 401);
});

test("an unknown signature version is skipped, never treated as a match", async () => {
	const res = mockRes();
	await drive(sigHandler(ok), mockReq({ headers: sigHeaders(RAW, { signature: "v9,anything" }) }), res, RAW);
	assert.equal(res.statusCode, 401);
});

// --- token mode ---

test("token mode accepts the configured secret and refuses everything else", async () => {
	const okRes = mockRes();
	await drive(tokenHandler(ok), mockReq({ headers: { "x-gitlab-event": "Issue Hook", "webhook-id": "wh-1", "x-gitlab-token": SHARED_TOKEN } }), okRes, RAW);
	assert.equal(okRes.statusCode, 202);

	for (const presented of ["wrong", "", SHARED_TOKEN + "x", SHARED_TOKEN.slice(0, -1)]) {
		const res = mockRes();
		await drive(tokenHandler(ok), mockReq({ headers: { "x-gitlab-event": "Issue Hook", "webhook-id": "wh-1", "x-gitlab-token": presented } }), res, RAW);
		assert.equal(res.statusCode, 401, `token ${JSON.stringify(presented)} must not verify`);
	}
});

test("verifyToken compares hashes, so a length mismatch is not an early return", () => {
	// timingSafeEqual throws on unequal lengths, and the obvious guard -- compare lengths first -- makes
	// the secret's length a timing oracle. Hashing removes length from the comparison.
	assert.equal(verifyToken("secret", "a-very-much-longer-presented-value").ok, false);
	assert.equal(verifyToken("secret", "secret").ok, true);
	assert.equal(
		createHash("sha256").update("secret").digest().length,
		createHash("sha256").update("a-very-much-longer-presented-value").digest().length,
		"both comparands are fixed-width digests",
	);
});

// --- the mode is declared, never negotiated ---

test("a delivery carrying the OTHER mode's header is refused, even when that header is correct", async () => {
	// The downgrade this forecloses: with auto-negotiation, a sender picks which gate it faces, and it
	// would always pick the weaker one.
	const sigRes = mockRes();
	await drive(
		sigHandler(ok),
		mockReq({ headers: { "x-gitlab-event": "Issue Hook", "webhook-id": "wh-1", "x-gitlab-token": SHARED_TOKEN } }),
		sigRes,
		RAW,
	);
	assert.equal(sigRes.statusCode, 401, "a signature-mode endpoint must not accept a bare token");

	const tokRes = mockRes();
	await drive(tokenHandler(ok), mockReq({ headers: sigHeaders(RAW) }), tokRes, RAW);
	assert.equal(tokRes.statusCode, 401, "a token-mode endpoint must not accept a signature");
});

test("an unknown mode or an empty secret refuses at CONSTRUCTION, so the process cannot boot disarmed", () => {
	assert.throws(() => makeGitLabVerifiedHandler({ mode: "hmac", secret: "x" }, ok));
	assert.throws(() => makeGitLabVerifiedHandler({ mode: "token", secret: "" }, ok));
	assert.throws(() => makeGitLabVerifiedHandler({ mode: "signature", secret: "whsec_" }, ok), "a signing token that decodes to nothing can never verify anything");
});

test("decodeSigningToken strips the whsec_ prefix and base64-decodes the rest", () => {
	assert.deepEqual(decodeSigningToken(SIGNING_TOKEN), RAW_KEY);
	assert.deepEqual(decodeSigningToken(RAW_KEY.toString("base64")), RAW_KEY, "a token pasted without its prefix still works");
});

// --- the delivery id, and the transport floor ---

test("a delivery with no webhook-id or Idempotency-Key is 400 and names the minimum GitLab version", async () => {
	// Refused rather than served on a synthesised key: a key derived from the payload is not stable across
	// a resend, so it would dedup some redeliveries and bill for the rest.
	const res = mockRes();
	const headers = sigHeaders(RAW);
	delete headers["webhook-id"];
    await drive(sigHandler(ok), mockReq({ headers }), res, RAW);
	assert.equal(res.statusCode, 400);
	assert.match(res.body, /17\.4/);
});

test("Idempotency-Key is accepted as webhook-id's older name", async () => {
	// Asserted in TOKEN mode, and not incidentally: `webhook-id` and the signature arrived together in
	// GitLab 19.0, so an instance old enough to send only `Idempotency-Key` is on 17.4-18.x and cannot be
	// running signature mode at all. Testing it under a signature would be testing an impossible delivery.
	let seen = null;
	const res = mockRes();
	await drive(
		tokenHandler(async (ctx, r) => ((seen = ctx), r.writeHead(202), r.end())),
		mockReq({ headers: { "x-gitlab-event": "Issue Hook", "idempotency-key": "idem-1", "x-gitlab-token": SHARED_TOKEN } }),
		res,
		RAW,
	);
	assert.equal(res.statusCode, 202);
	assert.equal(seen.delivery, "idem-1");
});

test("method, content type and event header are refused before the body is read at all", async () => {
	const cases = [
		[{ method: "GET", headers: sigHeaders(RAW) }, 405],
		[{ headers: { ...sigHeaders(RAW), "content-type": "text/plain" } }, 415],
		[{ headers: { ...sigHeaders(RAW), "x-gitlab-event": undefined } }, 400],
	];
	for (const [reqOpts, expected] of cases) {
		const res = mockRes();
		await drive(sigHandler(ok), mockReq(reqOpts), res, RAW);
		assert.equal(res.statusCode, expected);
	}
});

test("an oversize declared content-length destroys the request and answers 413", async () => {
	const res = mockRes();
	const req = mockReq({ headers: { ...sigHeaders(RAW), "content-length": String(5 * 1024 * 1024) } });
	await drive(sigHandler(ok), req, res, RAW);
	assert.equal(res.statusCode, 413);
	assert.equal(req.destroyed, true);
});
