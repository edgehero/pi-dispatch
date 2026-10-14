/**
 * The GitLab trust boundary (issue #42), the counterpart of verify.mjs. Nothing downstream -- not the
 * access-level gate, not the label predicate, not the enqueue -- means anything unless this ran first and
 * said yes: every one of them reads fields from a body somebody has to have authenticated
 * (CONST-HMAC-OVER-RAW-BODY).
 *
 * GitLab offers TWO mechanisms, and which one a deployment gets depends on its version:
 *
 *   - `signature` -- a real HMAC-SHA256, `webhook-signature: v1,<base64>`, over the Standard Webhooks
 *     message `{webhook-id}.{webhook-timestamp}.{raw body}`. Available from GitLab 19.0 (GA 19.1).
 *   - `token` -- `X-Gitlab-Token` compared against a shared secret. Available on every version, and
 *     STRICTLY WEAKER: it proves the sender knew a secret, and says nothing about whether the body
 *     arrived as it was sent. It is offered because most self-hosted instances cannot do better yet, not
 *     because it is adequate.
 *
 * The mode is DECLARED in config and verified exactly, never negotiated from what the request happens to
 * carry. That is the whole reason it is a config field: a handler that accepted whichever header showed up
 * would let the sender choose which gate it faced, and an attacker would choose the weaker one every time.
 * A delivery arriving without the declared mode's header is refused, even when the other one is present
 * and correct.
 *
 * Raw-body-then-verify-then-parse holds exactly as in verify.mjs: `readRawBody` returns bytes, the HMAC is
 * computed over those bytes, and `onVerified` gets the string. Nothing calls JSON.parse before the 401.
 */

import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { isJsonContentType, readRawBody, respond } from "@edgehero/pi-dispatch/http-body";

/**
 * Standard Webhooks' replay window. The dedup layer already refuses a repeated delivery id, but that
 * guarantee is RETENTION-bounded (REQ-DEDUP-BY-DELIVERY-GUID states this explicitly): once the job key
 * ages out, a captured delivery replays as new work and is billed. The timestamp is the unbounded half of
 * that defence, so it is checked here rather than left to the queue.
 *
 * Five minutes is the spec's tolerance and is generous next to any plausible clock skew between a forge
 * and its own webhook target.
 */
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/** The signing token's documented wrapper: `whsec_` then the base64 of the actual key. */
const SIGNING_TOKEN_PREFIX = "whsec_";

/**
 * Build the verified GitLab handler. `mode` is `"signature"` or `"token"`; `secret` is the signing token
 * (signature mode) or the shared secret token (token mode).
 *
 * `onVerified` receives `({ rawBody, headers, event, delivery }, res)` only after verification -- the same
 * shape verify.mjs passes, so the receiver's two arms differ in how a delivery is trusted and not in what
 * a trusted delivery looks like.
 */
export function makeGitLabVerifiedHandler({ mode, secret, bodyLimit = 2 * 1024 * 1024, now = () => Date.now() }, onVerified) {
	if (mode !== "signature" && mode !== "token") {
		throw new Error(`gitlab webhook mode must be "signature" or "token" (got ${JSON.stringify(mode)})`);
	}
	if (typeof secret !== "string" || secret === "") {
		throw new Error("gitlab webhook verification requires a non-empty secret");
	}
	const key = mode === "signature" ? decodeSigningToken(secret) : null;

	return async function gitlabVerifiedHandler(req, res) {
		let delivery;
		try {
			if (req.method !== "POST") {
				return respond(res, 405, { error: "method not allowed" });
			}
			if (!isJsonContentType(req.headers["content-type"])) {
				return respond(res, 415, { error: "unsupported media type" });
			}

			const event = req.headers["x-gitlab-event"];
			if (!event) {
				return respond(res, 400, { error: "missing gitlab event header" });
			}

			// The delivery id is stable across GitLab's own retries, which is exactly the property dedup
			// needs (REQ-DEDUP-BY-DELIVERY-GUID). `webhook-id` is the Standard Webhooks name (19.0+);
			// `Idempotency-Key` is the same value under its original name (17.4+).
			//
			// An instance too old for either is REFUSED rather than served on a synthesised key. A key
			// derived from the payload -- object id plus action, say -- is not stable across a retry that
			// changes nothing an operator can see, so it would dedup some redeliveries and bill for the
			// rest. Naming the minimum version is a message; a weaker key would be a silent second charge.
			delivery = req.headers["webhook-id"] ?? req.headers["idempotency-key"];
			if (!delivery) {
				return respond(res, 400, {
					error: "missing delivery id",
					detail: "no webhook-id or Idempotency-Key header; pi-dispatch needs GitLab 17.4 or later to dedup redeliveries",
				});
			}

			const declaredLength = Number(req.headers["content-length"]);
			if (Number.isFinite(declaredLength) && declaredLength > bodyLimit) {
				req.destroy();
				return respond(res, 413, { error: "payload too large" });
			}

			let buf;
			try {
				buf = await readRawBody(req, bodyLimit);
			} catch (err) {
				if (err && err.code === "E_PAYLOAD_TOO_LARGE") {
					return respond(res, 413, { error: "payload too large" });
				}
				throw err;
			}
			const raw = buf.toString("utf8");

			const verdict =
				mode === "signature"
					? verifySignature({ key, headers: req.headers, raw, nowMs: now() })
					: verifyToken(secret, req.headers["x-gitlab-token"]);
			if (!verdict.ok) {
				return respond(res, verdict.status ?? 401, { error: verdict.error });
			}

			await onVerified({ rawBody: raw, headers: req.headers, event, delivery }, res);
		} catch {
			// Stable id only: never the secret, the body, or a stack that may carry PII.
			process.stderr.write(`${JSON.stringify({ event: "gitlab_verify_handler_error", delivery: delivery ?? null })}\n`);
			if (!res.headersSent) {
				respond(res, 500, { error: "internal error" });
			}
		}
	};
}

/**
 * `whsec_<base64>` -> the raw key bytes. Refused at CONSTRUCTION, not per request: a signing token this
 * cannot decode can never verify anything, so the process must not come up believing it has a gate.
 */
export function decodeSigningToken(token) {
	const body = token.startsWith(SIGNING_TOKEN_PREFIX) ? token.slice(SIGNING_TOKEN_PREFIX.length) : token;
	const key = Buffer.from(body, "base64");
	if (key.length === 0) {
		throw new Error("gitlab signing token did not base64-decode to any key bytes");
	}
	return key;
}

/**
 * Verify `webhook-signature` over the Standard Webhooks message. Returns `{ ok: true }` or
 * `{ ok: false, error, status }`.
 *
 * The signed message is `{webhook-id}.{webhook-timestamp}.{body}` -- the id and timestamp are INSIDE the
 * MAC, which is what makes the timestamp trustworthy enough to enforce a replay window against. Checking
 * a timestamp that was not covered by the signature would be theatre.
 *
 * The header may carry several space-separated signatures (key rotation). Every `v1,` entry is tried, and
 * each compare is timing-safe; an unknown version prefix is skipped rather than treated as a match.
 */
export function verifySignature({ key, headers, raw, nowMs }) {
	const header = headers["webhook-signature"];
	const id = headers["webhook-id"];
	const timestamp = headers["webhook-timestamp"];
	if (!header || !id || !timestamp) {
		return { ok: false, error: "missing signature" };
	}

	const sentMs = Number(timestamp) * 1000;
	if (!Number.isFinite(sentMs) || Math.abs(nowMs - sentMs) > TIMESTAMP_TOLERANCE_MS) {
		// Outside the window the signature is still valid -- which is the point. A captured delivery stays
		// cryptographically good forever, so age is the only thing that can refuse a replay once the
		// queue's dedup key has aged out.
		return { ok: false, error: "stale or invalid timestamp" };
	}

	const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${raw}`, "utf8").digest();
	for (const candidate of String(header).split(" ")) {
		const [version, value] = candidate.split(",");
		if (version !== "v1" || !value) continue;
		const got = Buffer.from(value, "base64");
		if (got.length === expected.length && timingSafeEqual(got, expected)) {
			return { ok: true };
		}
	}
	return { ok: false, error: "invalid signature" };
}

/**
 * Compare `X-Gitlab-Token` against the configured secret in constant time.
 *
 * Both sides are hashed first so the comparands are always 32 bytes: `timingSafeEqual` throws on a length
 * mismatch, and the obvious guard -- return early when the lengths differ -- turns the secret's LENGTH
 * into a timing oracle. Hashing removes length from the comparison entirely.
 */
export function verifyToken(secret, presented) {
	if (typeof presented !== "string" || presented === "") {
		return { ok: false, error: "missing token" };
	}
	const a = createHash("sha256").update(presented, "utf8").digest();
	const b = createHash("sha256").update(secret, "utf8").digest();
	return timingSafeEqual(a, b) ? { ok: true } : { ok: false, error: "invalid token" };
}
