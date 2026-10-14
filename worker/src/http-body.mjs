/**
 * The forge-neutral half of a webhook endpoint: read a bounded raw body, recognise a JSON content type,
 * and write a small JSON response.
 *
 * Extracted from verify.mjs when a second forge arrived (issue #42), and extracted rather than copied for
 * one reason: `readRawBody`'s per-chunk accounting is a memory bound on attacker-controlled input. Two
 * copies of a security limit drift -- one gets the fix, the other keeps the bug -- and the copy that keeps
 * it is the one nobody is looking at. Verification itself is NOT here; each forge's gate owns its own,
 * because that is exactly the part that differs.
 *
 * Nothing here reads a header that identifies a forge, and nothing here decides whether a request is
 * trusted. A caller must still verify before parsing a single field (CONST-HMAC-OVER-RAW-BODY).
 *
 * Moved from the receiver to the worker's exports (issue #640) for the same reason it was extracted: the operator
 * console reads request bodies too, and the console must not import the receiver (its only export is `./start`, and an
 * admin surface on the receiver is the rejected option `DES-OPERATOR-CONSOLE` keeps). `respond` sets no security
 * headers; the console wraps every response in its own header set and never calls it directly.
 */

/** Accept `application/json`, ignoring any parameters and case. */
export function isJsonContentType(contentType) {
	return String(contentType ?? "").split(";")[0].trim().toLowerCase() === "application/json";
}

/**
 * Collect the request stream into a Buffer, bounded by `limit`. Accumulation is checked on every
 * chunk so the buffer can never grow past the cap: exceeding it destroys the request and rejects
 * with `code: "E_PAYLOAD_TOO_LARGE"` rather than reading an unbounded body into memory.
 */
export function readRawBody(req, limit) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let settled = false;

		const cleanup = () => {
			req.removeListener("data", onData);
			req.removeListener("end", onEnd);
			req.removeListener("error", onError);
		};
		const onData = (chunk) => {
			if (settled) return;
			size += chunk.length;
			if (size > limit) {
				settled = true;
				cleanup();
				req.destroy();
				const err = new Error("payload too large");
				err.code = "E_PAYLOAD_TOO_LARGE";
				reject(err);
				return;
			}
			chunks.push(chunk);
		};
		const onEnd = () => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(Buffer.concat(chunks));
		};
		const onError = (err) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(err);
		};

		req.on("data", onData);
		req.on("end", onEnd);
		req.on("error", onError);
	});
}

/** Write a small JSON body with an explicit status. `writeHead` sets the status code on the response. */
export function respond(res, status, body) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}
