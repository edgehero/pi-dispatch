/**
 * The Azure DevOps trust boundary.
 *
 * WHAT AZURE CANNOT DO, stated first because everything here follows from it: Service Hooks offer no HMAC.
 * The only authentication a subscription can carry is HTTP Basic credentials or a static custom header. A
 * bare credential proves the sender knew a secret and COVERS NO BYTES -- it says nothing about whether the
 * body arrived as it was sent.
 *
 * So `CONST-HMAC-OVER-RAW-BODY` is satisfied here in one half and not the other, and this is not a new
 * class of exception: it is exactly GitLab's `token` mode, which that entry already admits BY NAME. What
 * does NOT vary, and is preserved exactly, is the ordering the whole downstream depends on -- raw bytes,
 * then verify, then parse -- and the refusal to let the request choose which mechanism it faces.
 *
 * TWO CONSEQUENCES AN OPERATOR HAS TO KNOW ABOUT, both documented rather than papered over:
 *
 *   - The DELIVERY ID IS IN THE BODY. Azure sends no delivery-id header at all, so the dedup key
 *     (`REQ-DEDUP-BY-DELIVERY-GUID`) is read from the verified payload. `verify-gitlab.mjs` explicitly
 *     REFUSES to do this -- it 400s rather than synthesise a key from payload content -- and that refusal
 *     is right for a forge that HAS a header and wrong for one that has none. The distinction is the
 *     difference between an exception and an erosion, so it is written down rather than inferred. Note the
 *     ordering is unaffected: the id is read inside `onVerified`, after the credential check.
 *   - There is NO REPLAY WINDOW. GitLab pairs its dedup with a signed 5-minute timestamp precisely because
 *     dedup is retention-bounded. Azure signs no timestamp and no body, so a captured delivery replays as
 *     new paid work once the job key ages out, and there is no second line of defence. `OQ-015` records it.
 *
 * HTTPS is the operator's obligation and the docs say so: over plain HTTP the credential is on the wire in
 * base64, which is not encryption.
 */

import { timingSafeEqual } from "node:crypto";
import { isJsonContentType, readRawBody, respond } from "@edgehero/pi-dispatch/http-body";

const MAX_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Constant-time string compare. Length is leaked (it always is, by the early return), but the CONTENT is
 * not: a byte-by-byte `===` on a secret is a timing oracle, and this is the only thing standing between a
 * stranger and a paid job on this forge.
 */
export function secretEquals(a, b) {
	const left = Buffer.from(String(a ?? ""), "utf8");
	const right = Buffer.from(String(b ?? ""), "utf8");
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

/**
 * Whether the request carries the configured credential.
 *
 * `mode` is chosen by the operator when they create the subscription, never negotiated from the request:
 *   - `basic`  -- `Authorization: Basic base64(user:pass)`, compared against the whole configured string.
 *   - `header` -- a custom header name and value, for deployments fronted by something that consumes the
 *                 Authorization header before pi-dispatch sees it.
 *
 * A delivery presenting the wrong mechanism's credential is refused even when that credential is correct:
 * a sender able to choose which gate it faces chooses the weakest available one.
 */
export function credentialOk({ mode, secret, headerName }, headers) {
	if (mode === "basic") {
		const raw = headers?.authorization;
		if (typeof raw !== "string" || !raw.startsWith("Basic ")) return false;
		return secretEquals(raw.slice("Basic ".length).trim(), secret);
	}
	if (mode === "header") {
		const raw = headers?.[String(headerName ?? "").toLowerCase()];
		return typeof raw === "string" && secretEquals(raw, secret);
	}
	return false;
}

/**
 * Wrap `onVerified({ rawBody }, res)` so it only ever runs for an authenticated delivery.
 *
 * The preamble mirrors the other two verifiers exactly -- method, content type, declared length, bounded
 * read, then the credential check -- because that ordering is the part every downstream gate depends on
 * and it must not vary per forge.
 */
export function makeAzureVerifiedHandler({ mode, secret, headerName = null }, onVerified) {
	return async function handler(req, res) {
		try {
			if (req.method !== "POST") return respond(res, 405, { error: "method-not-allowed" });
			if (!isJsonContentType(req.headers["content-type"])) return respond(res, 415, { error: "unsupported-media-type" });

			const declared = Number(req.headers["content-length"] ?? NaN);
			if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return respond(res, 413, { error: "payload-too-large" });

			let buf;
			try {
				buf = await readRawBody(req, MAX_BODY_BYTES);
			} catch (err) {
				if (err?.code === "E_PAYLOAD_TOO_LARGE") return respond(res, 413, { error: "payload-too-large" });
				throw err;
			}
			const rawBody = buf.toString("utf8");

			// The credential is checked against the RAW bytes having already been read and NOT yet parsed --
			// the same ordering the HMAC forges use. It buys less here (the credential covers no bytes), but
			// the property it does buy is real: no field of an unauthenticated body is ever read.
			if (!credentialOk({ mode, secret, headerName }, req.headers)) {
				return respond(res, 401, { error: "unauthorized" });
			}

			return await onVerified({ rawBody }, res);
		} catch (err) {
			process.stderr.write(`${JSON.stringify({ event: "azure_verify_handler_error", reason: err?.message })}\n`);
			if (!res.headersSent) respond(res, 500, { error: "internal" });
		}
	};
}
