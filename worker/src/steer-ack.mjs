import { createHmac, timingSafeEqual } from "node:crypto";
import { STEER_ID_RE } from "./steer-framing.mjs";

/**
 * The worker's half of a steer delivery ack (issue #646, INT-STEER-INBOX-CONTRACT): a third `onParsed` consumer of the
 * live transcript tail (live-transcript.mjs `makeLiveTranscriptOpener`, beside the progress sink and the checkpoint
 * handle), which turns each `pi-dispatch-inbox` custom message the runner delivered into `delivered` in the run's inbox.
 *
 * WHY A MAC AND NOT THE LINE ITSELF. `/session` is mounted read-write into the job, so the agent can append a
 * `custom_message` of our type to its own transcript, naming any message id. A delivery counts only when the line's
 * `details.ack` is `HMAC-SHA256(exitKey, "pi-dispatch-inbox-ack\0" + PI_JOB_ID + "\0" + id)`, compared in constant
 * time, under the exit key this attempt minted (issue #545): handed to the runner on stdin, held in its non-dumpable
 * process, never in the agent's reach. A line that does not verify is ignored and counted (`steer_ack_unverified`).
 * The domain string is the runner's (image/runner/src/inbox.mjs `inboxAck`), and `ackRunId` is exactly the string the
 * worker put in PI_JOB_ID for this container (run-container.mjs passes the container name), so both sides MAC one
 * message by construction rather than by two call sites that happen to agree.
 *
 * PRIOR LINES. A line that ended at or before the tail's BASELINE (the file's size when this attempt began: a resumed
 * or a #645-restored transcript) was written by an EARLIER attempt, whose exit key is gone, so its MAC cannot be
 * checked here. Such a line is never counted as a delivery. Its id only joins the "already in this transcript" set
 * the relay re-baselines against (inbox-relay.mjs): a message the inbox says is `delivered` whose id is NOT in that
 * set goes back to `written`, so a recovery from a checkpoint older than the delivery hands it over again. The
 * residual is deliberate and narrow: the agent can write a prior-looking line only into a transcript a later attempt
 * restores, and all it buys is that a message which WAS delivered (verified, under that attempt's key) stays so.
 *
 * Never throws; the tail swallows a throw anyway, and nothing here may cost the run. Logs carry ids and counts only.
 */

export const INBOX_CUSTOM_TYPE = "pi-dispatch-inbox";
const ACK_DOMAIN = "pi-dispatch-inbox-ack";

/** The ack for one message: the runner's `inboxAck`, restated (the worker cannot import the image). Pinned by a test. */
export function inboxAck(key, ackRunId, id) {
	return createHmac("sha256", key).update(`${ACK_DOMAIN}\0${ackRunId}\0${id}`, "utf8").digest("hex");
}

/** Whether `ack` is the ack for `id` under `key`, in constant time. False on any malformed input, never a throw. */
export function ackVerifies(key, ackRunId, id, ack) {
	if (typeof key !== "string" || key === "" || typeof ackRunId !== "string" || ackRunId === "") return false;
	if (typeof id !== "string" || !STEER_ID_RE.test(id)) return false;
	if (typeof ack !== "string" || !/^[0-9a-f]{64}$/.test(ack)) return false;
	return timingSafeEqual(Buffer.from(inboxAck(key, ackRunId, id), "hex"), Buffer.from(ack, "hex"));
}

/**
 * `makeSteerAck({ exitKey, ackRunId, relay, jobId, log })` -> `{ consume, onBaseline, reset, drain, stats }`.
 *
 *   - `consume(parsed, ts, flags)`: the tail's `onParsed`. A prior line feeds the prior set; any other line of our type
 *     is verified and, when it verifies, handed to `relay.delivered(id)` (which marks the inbox and unlinks the file).
 *   - `onBaseline()`: the tail's first pass over the staged transcript is done; calls `relay.afterBaseline(prior)`, so
 *     the relay re-baselines and only then starts writing files.
 *   - `drain()`: waits for every mark in flight (runContainer awaits it after the tail's final read, before it stops the
 *     relay, so a last-moment ack is counted before the settle step reads the states). Bounded by the relay's own calls.
 */
export function makeSteerAck({ exitKey, ackRunId, relay, jobId = null, log = () => {} } = {}) {
	const prior = new Set();
	const priorVerified = new Set();
	const acked = new Set();
	const inFlight = new Set();
	const counts = { verified: 0, unverified: 0, prior: 0 };
	let baselined = false;
	let unverifiedSaid = false;

	const hand = (id) => {
		if (typeof relay?.delivered !== "function") return;
		let p;
		try {
			p = Promise.resolve(relay.delivered(id)).catch(() => {});
		} catch {
			return;
		}
		inFlight.add(p);
		p.finally(() => inFlight.delete(p));
	};

	return {
		consume(parsed, _ts, flags) {
			if (parsed?.type !== "custom_message" || parsed.customType !== INBOX_CUSTOM_TYPE) return;
			const details = parsed.details !== null && typeof parsed.details === "object" ? parsed.details : {};
			const id = typeof details.id === "string" && STEER_ID_RE.test(details.id) ? details.id : null;
			if (flags?.prior === true) {
				if (id !== null && !prior.has(id)) {
					prior.add(id);
					counts.prior += 1;
				}
				// F5: a prior line whose ack verifies under THIS attempt's key is a delivery the inbox may not have recorded;
				// the relay marks it at the baseline instead of writing it again. NOTE the reach: the exit key is minted per
				// attempt, so a line an EARLIER attempt wrote never verifies here, and such a message is handed over again
				// (a duplicate, framed, never a loss). Counting an unverified prior line instead would let the agent mark a
				// message delivered that it was never sent, by writing a line into a transcript a recovery restores.
				if (id !== null && ackVerifies(exitKey, ackRunId, id, details.ack)) priorVerified.add(id);
				return;
			}
			if (id === null || !ackVerifies(exitKey, ackRunId, id, details.ack)) {
				counts.unverified += 1;
				// Said once per attempt, then counted: a job that writes forged lines in a loop must not flood the log.
				if (!unverifiedSaid) {
					unverifiedSaid = true;
					log("steer_ack_unverified", { jobId, ...(id !== null ? { id } : {}) });
				}
				return;
			}
			if (acked.has(id)) return;
			acked.add(id);
			counts.verified += 1;
			hand(id);
		},
		onBaseline() {
			if (baselined) return;
			baselined = true;
			try {
				relay?.afterBaseline?.(new Set(prior), new Set(priorVerified));
			} catch {}
		},
		// A rewritten transcript (the tail's reset) keeps what was already verified: a delivery that happened stays one.
		reset() {},
		async drain() {
			while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
		},
		stats: () => ({ ...counts }),
	};
}
