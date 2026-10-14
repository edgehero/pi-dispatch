/**
 * Webhook signature verification -- the trust boundary every downstream gate depends on.
 *
 * CONST-HMAC-OVER-RAW-BODY: the raw request bytes are verified against `X-Hub-Signature-256`
 * with `crypto.timingSafeEqual` BEFORE any parse. `@octokit/webhooks` owns that comparison
 * internally, so this module delegates to `Webhooks#verify` and never hand-rolls HMAC nor
 * compares signatures with `===`. A signature computed over different bytes than were sent
 * fails verification, and such a request is rejected 401 before a single field is read.
 *
 * node:http, not express: `express.json()` consumes the stream and re-serializes the body, so
 * the bytes handed to an HMAC check are no longer the bytes GitHub signed -- verification then
 * either always fails or gets quietly stripped to make things work. A hand-rolled node:http
 * handler reads the raw stream once and verifies those exact bytes. This also owns its own
 * status codes, which `createNodeMiddleware` cannot: its 400 is hardcoded and its options
 * expose only `{ timeout, path, log }`, so a 400->401 remap is impossible through it.
 *
 * Status map: 405 non-POST · 415 non-JSON content type · 401 missing or invalid signature ·
 * 400 missing GitHub event/delivery headers · 413 body over limit · 500 unexpected throw.
 */

import { Webhooks } from "@octokit/webhooks";
import { isJsonContentType, readRawBody, respond } from "@edgehero/pi-dispatch/http-body";

/**
 * Thin wrapper delegating to `webhooks.verify(rawBody, signature)`. `rawBody` is the raw UTF-8
 * request body as a string and `signature` is the `X-Hub-Signature-256` header value. Returns a
 * Promise<boolean>; the timing-safe HMAC comparison lives inside `@octokit/webhooks`.
 */
export async function verifySignature(webhooks, rawBody, signature) {
	return webhooks.verify(rawBody, signature);
}

/**
 * Build a `node:http` request handler that verifies GitHub's HMAC over the raw body and hands a
 * verified request off to `onVerified`. The `Webhooks` instance is constructed once, at factory
 * time, so the secret is captured in the closure and never re-read per request.
 *
 * `onVerified` receives `({ rawBody, headers, event, delivery }, res)` only after a good signature.
 * It owns the parse, the trigger filter, the enqueue, and the final response (D4's contract); if it
 * writes no response, that is D4's concern -- this handler's job ends at a successful verify.
 */
export function makeVerifiedHandler({ secret, bodyLimit = 2 * 1024 * 1024 }, onVerified) {
	const webhooks = new Webhooks({ secret });

	return async function verifiedHandler(req, res) {
		let delivery;
		try {
			if (req.method !== "POST") {
				return respond(res, 405, { error: "method not allowed" });
			}

			if (!isJsonContentType(req.headers["content-type"])) {
				return respond(res, 415, { error: "unsupported media type" });
			}

			const signature = req.headers["x-hub-signature-256"];
			if (!signature) {
				return respond(res, 401, { error: "missing signature" });
			}

			const event = req.headers["x-github-event"];
			delivery = req.headers["x-github-delivery"];
			if (!event || !delivery) {
				return respond(res, 400, { error: "missing github event headers" });
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
			const ok = await verifySignature(webhooks, raw, signature);
			if (!ok) {
				return respond(res, 401, { error: "invalid signature" });
			}

			await onVerified({ rawBody: raw, headers: req.headers, event, delivery }, res);
		} catch {
			// Stable id only: never the secret, the body, or a stack that may carry PII.
			process.stderr.write(`${JSON.stringify({ event: "verify_handler_error", delivery: delivery ?? null })}\n`);
			if (!res.headersSent) {
				respond(res, 500, { error: "internal error" });
			}
		}
	};
}
