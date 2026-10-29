import { createHmac, timingSafeEqual } from "node:crypto";
import { isJsonContentType, readRawBody, respond } from "@edgehero/pi-dispatch/http-body";

export const WATCH_TIMESTAMP_TOLERANCE_MS = 300000;
const DELIVERY_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
export function watchSigningMessage(timestamp, delivery, rawBody) {
	return Buffer.concat([Buffer.from(`v1.${timestamp}.${delivery}.`), Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody)]);
}
export function verifyWatchSignature({ secret, timestamp, delivery, signature, rawBody, now = () => Date.now() }) {
	if (typeof timestamp !== "string" || !/^[1-9][0-9]{0,11}$/.test(timestamp) || typeof delivery !== "string" || !DELIVERY_RE.test(delivery) || typeof signature !== "string" || !/^v1=[a-f0-9]{64}$/.test(signature)) return false;
	if (Math.abs(now() - Number(timestamp) * 1000) > WATCH_TIMESTAMP_TOLERANCE_MS) return false;
	const expected = createHmac("sha256", secret).update(watchSigningMessage(timestamp, delivery, rawBody)).digest();
	return timingSafeEqual(expected, Buffer.from(signature.slice(3), "hex"));
}
export function makeWatchVerifiedHandler({ secret, bodyLimit = 65536, now = () => Date.now(), log = () => {} }, onVerified) {
	if (typeof secret !== "string" || !secret) throw new Error("watch verification requires a non-empty secret");
	if (!Number.isSafeInteger(bodyLimit) || bodyLimit < 1 || bodyLimit > 65536) throw new Error("watch body limit is invalid");
	return async function watchVerifiedHandler(req, res) {
		try {
			if (req.method !== "POST") return respond(res, 405, { error: "method not allowed" });
			if (!isJsonContentType(req.headers["content-type"])) return respond(res, 415, { error: "unsupported media type" });
			const timestamp = req.headers["x-watch-timestamp"];
			const delivery = req.headers["x-watch-id"];
			const signature = req.headers["x-watch-signature"];
			if (typeof timestamp !== "string" || typeof delivery !== "string" || typeof signature !== "string") { log("watch_signature", { verdict: "missing" }); return respond(res, 401, { error: "invalid watch signature" }); }
			const length = Number(req.headers["content-length"]);
			if (Number.isFinite(length) && length > bodyLimit) return respond(res, 413, { error: "payload too large" });
			let raw;
			try { raw = await readRawBody(req, bodyLimit); } catch (error) {
				if (error?.code === "E_PAYLOAD_TOO_LARGE") return respond(res, 413, { error: "payload too large" });
				throw error;
			}
			if (!verifyWatchSignature({ secret, timestamp, delivery, signature, rawBody: raw, now })) { log("watch_signature", { verdict: "invalid" }); return respond(res, 401, { error: "invalid watch signature" }); }
			await onVerified({ rawBody: raw.toString("utf8"), delivery, timestamp, headers: req.headers }, res);
		} catch {
			// Neither body, header values nor exception messages belong in receiver logs.
			if (!res.headersSent) respond(res, 503, { error: "watch delivery unavailable" });
		}
	};
}
