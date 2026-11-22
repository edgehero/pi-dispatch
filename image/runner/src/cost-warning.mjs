/**
 * Issue #985: the warning before a cost limit stops the job.
 *
 * A job that reaches its cost cap is stopped between two calls (`cost-cap`), and with it went the report and the push of
 * everything it had done: three jobs on one evening lost theirs. Nothing told the agent the end was near. The turn and
 * time limits have no warning either (they are hard stops); the only channel from the runner to a running agent was the
 * steer inbox, which exists only for a steerable job. So this extension, armed for every job with a limit above 0, tells
 * the ROOT session once, at 70% of the limit, to write its report now and, if its flow pushes, commit and push, and to
 * start no new parallel work.
 *
 * GENERIC. One hook watches any number of limits, each `{ name, limit, settled }`: a name from LIMIT_WARNINGS (which
 * holds each limit's fixed text), the limit in micro-dollars, and a reader of the SETTLED measure against it. The cost
 * cap is wired by run-job.mjs: its measure is the job's settled charge, the cost guard's spent plus the children's
 * settled spend, never what calls hold in flight (a hold settles far below its bound, so counting it would warn a job
 * of parallel calls at a fraction of its real spend). Another limit is one row in LIMIT_WARNINGS and one `watch` call:
 * the subscription allowance (issue #1008, `run.maxSubscriptionUsd`) is one, watched on the meter's settled notional
 * total when a job has an allowance above 0.
 *
 * WHEN. On the root session's `turn_end` (its session id is the runner's root id: an in-process subagent session that
 * loads this factory gets its own handlers, and never fires), only when:
 *   - the turn ran tools (`toolResults` not empty). pi polls its steering queue right after turn_end and goes on to the
 *     next model call anyway, so the warning is read before that call and adds no turn. A turn with no tool calls is
 *     the agent stopping: a steer there would start another turn after its last answer;
 *   - pi says the session is busy (`ctx.isIdle() === false`), so the message is queued on the agent and not appended
 *     unread (src/inbox.mjs says why);
 *   - the run is not parked (await_human_input or request_approval ran): a queued message would un-park it;
 *   - no other STEER is queued for the agent that this one would wait behind (`queuedElsewhere`: the inbox's `queued()`
 *     and pi's steering queue, `steersQueued`). pi drains its steering queue one message at a time, so a warning behind
 *     another would be read only after the NEXT turn's tool results, and if that turn parked the run (an approval
 *     request, a question) it would land after that result and un-park it; the approval resume check
 *     (worker/src/approval-session.mjs) refuses a transcript with a custom message after the request. Queued into an
 *     empty steering queue, it is drained at the poll right after this turn's end, before anything else runs. A queued
 *     FOLLOW-UP does not hold it back: pi delivers follow-ups only when the agent would stop, after every steer, so one
 *     queued early would otherwise hold the warning for the whole run. Held back, it is tried at the next turn's end,
 *     and after HELD_TURNS_MAX turns held in a row it is sent anyway: a warning behind a steer beats no warning;
 *   - the measure has reached 70% of the limit (warningThreshold, exact in whole micro-dollars).
 * Then ONE message per limit per run, and at most one per turn, through `api.sendMessage` with `deliverAs: "steer"`
 * (pi's `sendCustomMessage`, pinned for the inbox: no input handlers, no template expansion), `customType`
 * LIMIT_WARNING_CUSTOM_TYPE, the fixed text, and `details.limit` naming the limit. A send that throws (a disposed
 * context) is tried again at the next turn's end. The exit line says whether it was queued (`costWarned`, run-job.mjs).
 *
 * THE TEXT IS FIXED, like the reason catalog's sentences: no number, no model id, nothing read from the job, so nothing a
 * run produced can reach the model through it. "About 70%" is the only figure, and it is this module's constant.
 *
 * RESIDUALS. Sent anyway after HELD_TURNS_MAX held turns, the warning can wait behind a steer, as above. A steer
 * another extension queues from a turn_end handler that runs after this one is not seen. A turn whose tools all ended the run on purpose (an
 * extension's terminating tool other than the two that park, which `isParked` covers) still gets the warning, so pi asks
 * the model once more. A job whose spend goes from under 70% to a refusal within one turn gets no warning: the measure is
 * read at turn ends only. And the message persists in the session's transcript: a resumed or recovered run reads an
 * earlier attempt's warning though its own cap starts afresh, and may be warned again at its own 70%.
 *
 * NOT IN classifier runs (watch decisions and question grouping build no extension loader) nor in a read-only watch or
 * answer-draft run (its loader takes only its own factories), nor in a pi child process: a child never runs main().
 * Logs carry the limit's name and numbers, never the text.
 */

export const LIMIT_WARNING_FACTORY = "job-cost-warning";
export const LIMIT_WARNING_CUSTOM_TYPE = "pi-dispatch-cost-warning";
/** The share of a limit at which its warning is sent, in percent. */
export const LIMIT_WARNING_PERCENT = 70;
/** How many turn ends in a row a due warning waits for a clear steering queue before it is sent anyway. */
export const HELD_TURNS_MAX = 3;

/**
 * Whether pi holds a STEER for `session`'s agent that is not yet delivered: its steering queue, which takes the
 * session's own steers and every custom message queued with `deliverAs: "steer"` (the inbox's included), and never a
 * follow-up. pi exposes no reader of that queue alone (`hasQueuedMessages()` and the extension context's
 * `hasPendingMessages()` count follow-ups too), so this reads the agent's `steeringQueue.hasItems()`, pinned in
 * pinned-api.test.mjs. Anything that cannot be read is no steer: the pin is what keeps it true.
 */
export function steersQueued(session) {
	try {
		return session?.agent?.steeringQueue?.hasItems?.() === true;
	} catch {
		return false;
	}
}

/**
 * Each limit's fixed text, by the limit's name (the stop reason it would end the job with). A watch of a name not here
 * is refused, so a limit cannot be wired without its words.
 */
export const LIMIT_WARNINGS = Object.freeze({
	"cost-cap": "pi-dispatch: about 70% of this job's cost limit is used. Write your report now and, if your flow pushes, commit and push your work; start no new parallel work. The job is stopped when the limit is reached.",
	// Issue #1008: the trigger's list-price allowance for subscription calls (run.maxSubscriptionUsd), watched by run-job.mjs
	// on the meter's settled notional total.
	"subscription-allowance": "pi-dispatch: about 70% of this job's subscription allowance is used. Write your report now and, if your flow pushes, commit and push your work; start no new parallel work. The job is stopped when the allowance is reached.",
});

/** Whether `value` is a whole number of micro-dollars. */
const whole = (value) => Number.isSafeInteger(value) && value >= 0;

/**
 * The measure at which a limit's warning is due: `percent` of `limit`, rounded UP, exact for every safe integer
 * (`limit = 100q + r`, so `percent x limit / 100 = percent x q + percent x r / 100`, neither product past the limit).
 */
export function warningThreshold(limit, percent = LIMIT_WARNING_PERCENT) {
	if (!whole(limit)) throw new Error("warningThreshold: the limit must be a whole number of micro-dollars");
	return Math.floor(limit / 100) * percent + Math.ceil(((limit % 100) * percent) / 100);
}

/**
 * The hook. `rootSessionId` is the runner's root session id; `isParked()` says the run has parked (the inbox's own
 * reader); `queuedElsewhere()` says a steer is queued in pi and not yet delivered (the inbox's `queued()`, and
 * `steersQueued` of the session); `log(event, fields)` is the runner's. Returns `{ watch, armed, warned, factory }`: `watch({ name, limit,
 * settled })` adds a limit (a name from LIMIT_WARNINGS, a limit above 0, a reader that returns micro-dollars; a reader that
 * throws or answers anything but a finite number has not reached it), `armed()` whether any limit is watched (the factory
 * is loaded only then), `warned(name)` whether that limit's warning was queued, and `factory`, the named inline extension.
 */
export function createCostWarnings({ rootSessionId, isParked = () => false, queuedElsewhere = () => false, log = () => {} }) {
	const watches = [];
	// Turn ends in a row at which a due warning was held back by a queued steer (HELD_TURNS_MAX).
	let held = 0;

	function watch({ name, limit, settled }) {
		if (!Object.hasOwn(LIMIT_WARNINGS, name)) throw new Error("createCostWarnings: a limit needs its fixed text in LIMIT_WARNINGS");
		if (!whole(limit) || limit === 0) throw new Error("createCostWarnings: the limit must be a whole number of micro-dollars above 0");
		if (typeof settled !== "function") throw new Error("createCostWarnings: settled must be a function");
		if (watches.some((entry) => entry.name === name)) throw new Error("createCostWarnings: a limit is watched once");
		watches.push({ name, limit, threshold: warningThreshold(limit), settled, warned: false });
	}

	/** The measure, or null when its reader cannot say. */
	function measure(entry) {
		let value;
		try {
			value = entry.settled();
		} catch {
			return null;
		}
		return typeof value === "number" && Number.isFinite(value) ? value : null;
	}

	/** Whether a handler's context is the root session's, busy: a context pi has invalidated is neither. */
	function rootAndBusy(context) {
		try {
			return context?.sessionManager?.getSessionId?.() === rootSessionId && context.isIdle() === false;
		} catch {
			return false;
		}
	}

	function parked() {
		try {
			return isParked() === true;
		} catch {
			// A reader that cannot say is a run that may be parked: no message.
			return true;
		}
	}

	/** Whether a steer is queued for the agent (see WHEN); a reader that cannot say is one that may be. */
	function queued() {
		try {
			return queuedElsewhere() === true;
		} catch {
			return true;
		}
	}

	const factory = {
		name: LIMIT_WARNING_FACTORY,
		factory: (api) => {
			api.on("turn_end", (event, context) => {
				const due = watches.filter((entry) => !entry.warned);
				if (due.length === 0) return;
				if (!Array.isArray(event?.toolResults) || event.toolResults.length === 0) return;
				if (!rootAndBusy(context) || parked()) return;
				for (const entry of due) {
					const settled = measure(entry);
					if (settled === null || settled < entry.threshold) continue;
					if (held < HELD_TURNS_MAX && queued()) {
						held += 1;
						return;
					}
					held = 0;
					try {
						api.sendMessage({ customType: LIMIT_WARNING_CUSTOM_TYPE, content: [{ type: "text", text: LIMIT_WARNINGS[entry.name] }], display: true, details: { limit: entry.name } }, { deliverAs: "steer" });
					} catch {
						// Tried again at the next turn's end.
						return;
					}
					entry.warned = true;
					log("cost_warning", { limit: entry.name, settled, threshold: entry.threshold, cap: entry.limit });
					// One message a turn: a second one would wait in pi's steering queue (WHEN above).
					return;
				}
			});
		},
	};

	return {
		watch,
		armed: () => watches.length > 0,
		warned: (name) => watches.some((entry) => entry.name === name && entry.warned),
		factory,
	};
}
