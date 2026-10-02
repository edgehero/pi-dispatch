import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { configError, COST_CAP, COST_CAP_UNENFORCEABLE, MODEL_NOT_ALLOWED, MODEL_POLICY_UNENFORCEABLE, TOKEN_BUDGET } from "./outcome.mjs";

/**
 * Process-wide usage meter (issue #58; REQ-TOKEN-ACCOUNTING-AND-CAPS, CONST-BUDGET-BEFORE-TOKENS).
 *
 * WHY THIS EXISTS -- the negative fact that forces it:
 *
 * token-budget.mjs meters by subscribing to ONE AgentSession's event bus. That bus is PER INSTANCE:
 * `AgentSession._eventListeners` is an array on the instance and `Agent.listeners` a Set on the
 * instance, and no event carries a sessionId. A subagent session an extension spawns through
 * `createAgentSession` therefore emits NOTHING on the parent's bus. A 16-wide fanout shows up on our
 * bus as roughly ONE turn, so both the token cap and the run record understate spend precisely on
 * the most expensive jobs -- the opposite of what a spend control is for.
 *
 * THE CHOKE POINT, at the 0.99.1 pin (issue #509): `ModelRuntime.prototype`. Every model call an
 * in-process session makes goes through a ModelRuntime instance: createAgentSession's streamFn returns
 * `modelRuntime.streamSimple(...)` (sdk.js:260), compaction and branch summaries reuse that streamFn
 * (agent-session.js, `streamFn: this.agent.streamFunction`), the cache warmer calls
 * `modelRuntime.streamSimple` (cache-warmer.js:239), and the ModelRegistry facade an extension sees as
 * `ctx.modelRegistry` forwards stream/streamSimple/complete/classify to its runtime (model-registry.js).
 * complete/completeSimple/fetchDeferred call the instance's own stream/streamSimple/streamDeferred, so they
 * are counted through those. Wrapping the PROTOTYPE covers every instance, the runner's and any a subagent
 * extension builds with `ModelRuntime.create`, and `options.sessionId` (a declared field on pi-ai's
 * StreamOptions) still reaches it, so per-session attribution comes free. A "call" (`calls`) is a stream,
 * or a classify/images promise, the meter observed, including one that then ended as aborted before sending
 * anything; a call the meter's own brake answered never reaches a provider and is not counted.
 *
 * What moved, and why the old choke point is dead: at 0.80.7 every session dispatched through pi-ai's
 * MODULE-LEVEL api-provider registry (compat's streamSimple resolved `model.api` in it), and the meter
 * wrapped each registry entry. At 0.99.1 a session never touches that registry: ModelRuntime calls each
 * builtin provider's own api object, and ModelRegistry.registerProvider no longer writes to it. Measured:
 * the 0.80.7 meter run against 0.99.1 logged `usage_meter_unavailable`, and had it installed it would
 * have counted nothing.
 *
 * The registry still exists (pi-ai/compat, "temporary"), and it is what an extension reaches when it calls
 * pi-ai's legacy global `streamSimple`/`completeSimple` directly: pi hands extensions the compat entry for a
 * bare `@earendil-works/pi-ai` import (virtual-modules.js, and loader.js's jiti aliases). So the registry
 * half is KEPT, as the second half, for exactly those legacy paths. The two never overlap: a ModelRuntime
 * call never enters the registry, and a registry call never enters a ModelRuntime.
 *
 * Traps, each verified by probe rather than by reading source:
 *
 * 1. A BARE pi-ai SPECIFIER IS NEVER THE COPY pi USES. Where the WORKER's deps are installed too (a dev
 *    checkout, the contract-tests job) pi-ai is on disk TWICE, with separate module-level registries: the
 *    hoisted `node_modules/@earendil-works/pi-ai` (the WORKER's dependency) and the nested
 *    `node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai`, which pi uses. The
 *    job image installs the runner's deps only, and there the nested copy is the only copy. Hence: no
 *    static pi import anywhere in this file. The ModelRuntime CLASS is injected by run-job.mjs, which
 *    imports it from pi-coding-agent itself, so there is no candidate to choose between; and the compat
 *    half's copy is decided at runtime by IDENTITY with the module pi hands its extensions
 *    (installProcessUsageMeter), never by a resolved path.
 * 2. `resetApiProviders()` -- which `AgentSession.reload()` still calls -- WIPES the registry. So the compat
 *    half cannot be install-once; it is RE-ARMABLE, hence the unref'd re-arm interval. The prototype half
 *    has no such hazard: nothing in pi reassigns ModelRuntime's methods.
 * 3. Overriding a BUILTIN api id changes compat's own dispatch: `getBuiltinProviderForModel` answers
 *    undefined once `getApiProvider(api)` is no longer the builtin instance, so compat calls US instead of
 *    its builtin provider. The compat wrapper therefore REPRODUCES that branch (fallbackModels) rather than
 *    blindly delegating to the registry entry -- the cloudflare providers substitute baseUrl placeholders in
 *    their auth layer, and bypassing it would break exactly those.
 * 4. A virtual model (`model.api === "pi-virtual"`, 0.99.0 experimental) re-enters: ModelRuntime.streamSimple
 *    routes it and calls `this.streamSimple(physicalModel, ...)`. Only the PHYSICAL call is counted, so one
 *    request is never counted twice and the ledger names the model that actually answered.
 * 5. The two halves DO meet on one path, and it is a common one: a provider with no builtin base for the
 *    model's api -- an operator's overlay models.json provider on `openai-completions`, say -- is composed by
 *    pi so that its stream resolves `getApiProvider(model.api)` in the compat registry
 *    (provider-composer.js, `streamWith`), which is our compat wrapper. The runtime half observes the
 *    outer stream and the compat wrapper the inner one, two different objects, so the `observed` set cannot
 *    dedupe them. An AsyncLocalStorage shared by the two halves of one install marks "inside this meter's
 *    runtime dispatch" (it follows the lazyStream setup across its awaits), and the compat wrapper routes
 *    such a call without counting it again. Measured by usage-meter.fidelity.test.mjs: counted once. The
 *    residual this buys, named rather than hidden: a LEGACY compat call an extension makes from inside a
 *    provider hook of a runtime call (before_provider_request, after_provider_response, a credential
 *    resolver) runs in that marked context and is counted by neither half. Extension code is the same trust
 *    class as a raw fetch to the provider, which no meter sees either; this meter is accounting, not a
 *    boundary against the code it runs beside.
 *
 * The TOKEN cap here is still structurally LAGGING for the same reason token-budget.mjs's is: usage is known
 * only after a call completes, so its hard stop is a runaway backstop, not a before-the-spend cap. The COST cap
 * (issue #501) is the opposite shape: the cost guard at the bottom of this file judges each call's worst case
 * BEFORE it is sent, through the same seam and the same hard stop.
 */

/** The sourceId the compat half's per-api registrations are filed under in pi-ai's registry. */
export const METER_PROVIDER_PREFIX = "pi-dispatch-usage-meter";
/** pi's api id for a virtual catalog entry (pi-coding-agent 0.99.1, dist/core/virtual-models.js:3). */
export const VIRTUAL_MODEL_API = "pi-virtual";
/**
 * The ModelRuntime methods the runtime half wraps. The three stream methods return an event stream; the
 * two result methods return a Promise of a result that carries `usage` (pi-ai 0.99.1 ClassifierResult,
 * AssistantImages), and both cost money on a paid provider. Every other model call on a ModelRuntime goes
 * through one of these five.
 */
export const RUNTIME_STREAM_METHODS = Object.freeze(["streamSimple", "stream", "streamDeferred"]);
export const RUNTIME_RESULT_METHODS = Object.freeze(["classify", "generateImages"]);

/**
 * The one table of the meter's stops (issues #501, #502): each reason the meter can stop a job for, and the
 * `errorMessage` its hard stop carries. One table so every stopped call says WHICH policy stopped it, in the
 * session's own transcript as well as on the exit line, and so a new stop is a row here rather than a new
 * flag beside `breached`. Frozen: the meter refuses a reason that is not a key (meter.stop throws), so a typo
 * cannot become a stop with an `undefined` message.
 */
export const STOP_MESSAGES = Object.freeze({
	[TOKEN_BUDGET]: "pi-dispatch: token cap exceeded",
	[COST_CAP]: "pi-dispatch: cost cap reached",
	[MODEL_NOT_ALLOWED]: "pi-dispatch: model not allowed",
});

/** Coerce a possibly-absent numeric usage field. Never propagates NaN into the totals. */
function finite(value) {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Named-row cap for the exit line's `usage` ledger (INT-RUN-HISTORY-FILE-CONTRACT). Sized against the
 * worker's recovery path, not against taste: the run record is rebuilt from a bounded 8 KiB tail of
 * container stdout (worker/src/run-history.mjs, TAIL_CAP_BYTES), and an exit line the tail truncates
 * loses ALL token accounting at once -- tokens, turns and ledger together, not merely the rows that
 * pushed it over. Eight worst-case named rows keep the whole line under ~5 KB with headroom, which
 * usage-meter.test.mjs asserts against a maximal fixture; if the line ever grows, shrink THIS cap --
 * never the test's budget.
 */
const MAX_NAMED_ROWS = 8;

/** The ten numerics a ledger row accumulates, zeroed. One shape for named rows and the fold bucket. */
function emptyRow() {
	return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 0, cost: 0, unpriced: 0 };
}

/**
 * Add every counter of one row into another. This ONE routine is both how a call lands on its row and
 * how usageSnapshot() folds overflow rows into "other", so the ledger's invariant -- the rows partition
 * state.total exactly -- holds by construction rather than by two pieces of arithmetic agreeing.
 */
function foldRow(into, row) {
	into.calls += row.calls;
	into.input += row.input;
	into.output += row.output;
	into.cacheRead += row.cacheRead;
	into.cacheWrite += row.cacheWrite;
	into.cacheWrite1h += row.cacheWrite1h;
	into.reasoning += row.reasoning;
	into.total += row.total;
	into.cost += row.cost;
	into.unpriced += row.unpriced;
}

/**
 * The accumulator. Pure: no pi contact, no I/O, no timers -- everything pi-shaped is injected by
 * installProcessUsageMeter, so this is the part that is fully testable and always exercised.
 *
 * `maxTokens` is validated with attachTokenBudget's exact semantics and error text, because both read
 * the same PI_MAX_TOKENS env knob and an operator must not get two different verdicts on one value.
 * null/undefined means uncapped -- the meter is ALWAYS on so totals land in run history either way.
 *
 * `maxCostMicros` (issue #501) and `allowedModels` (issue #502) are the two policies the brake must also
 * serve. This meter only CARRIES them (as `costCap` and `allowed`) so the installer arms the brake for them
 * and the exit decision can name their stops; the per-call checks that act on them are the guard's
 * (wrapModelRuntime's `guard`). Each is null when unset, which is today's behaviour.
 *
 * ONE STOP, FIRST WINS. `state.stopReason` is null until the first stop and is never overwritten: a job that
 * a cost refusal stopped and whose late settles then cross the token cap is a cost-cap stop, and the exit
 * line must name the cause rather than the last thing to notice. `onStop(reason, detail)` fires once, on
 * that first stop. `state.breached` stays, read-only, as "the stop was the token cap", so every reader of
 * the old flag keeps its meaning.
 */
export function createUsageMeter({ maxTokens, maxCostMicros = null, allowedModels = null, rootSessionId, onStop } = {}) {
	if (maxTokens !== null && maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1)) {
		throw new Error(`invalid PI_MAX_TOKENS: ${maxTokens}`);
	}
	if (maxCostMicros !== null && (!Number.isSafeInteger(maxCostMicros) || maxCostMicros < 0)) {
		throw new Error(`invalid PI_MAX_COST_MICROS: ${maxCostMicros}`);
	}
	if (allowedModels !== null && (!Array.isArray(allowedModels) || allowedModels.length === 0)) {
		throw new Error("invalid PI_ALLOWED_MODELS: want a non-empty list or null");
	}
	const cap = maxTokens ?? null;
	const costCap = maxCostMicros;
	const allowed = allowedModels === null ? null : Object.freeze(allowedModels.map((entry) => Object.freeze({ ...entry })));
	// Only a non-empty string can be the root. An undefined rootSessionId must NOT match an undefined
	// options.sessionId -- that would file every unattributed call as root and hide the fanout.
	const root = typeof rootSessionId === "string" && rootSessionId.length > 0 ? rootSessionId : null;

	const state = {
		input: 0,
		output: 0,
		// totalTokens is the BILLED total (input + output + cache read/write), so total >= input + output
		// -- deliberately, exactly as in token-budget.mjs. The cap keys on billed tokens; do not "fix".
		total: 0,
		cost: 0,
		// The attribution split. INVARIANT: rootTotal + otherTotal + looseTotal === total, because every
		// record() adds its billed tokens to exactly one of the three. otherTotal > 0 is spend the
		// per-session bus could not attribute to the root: a subagent session's, and at the 0.99.1 pin also
		// compaction and branch summaries, which pi sends under a FRESH session id when the caller passes
		// none (compaction.js completeSummarization, `sessionId: options.sessionId ?? uuidv7()`; measured
		// for issue #509). So otherTotal alone no longer proves a fanout; `sessions` counts the ids.
		rootTotal: 0,
		otherTotal: 0,
		looseTotal: 0,
		calls: 0,
		// Streams observed but not yet settled when the job ends. A non-zero value on the exit line means
		// the totals are a floor, not a total -- better surfaced than silently rounded down.
		unresolved: 0,
		// Calls whose usage carried no finite cost.total. Counted, never guessed: a silent 0 would read
		// as "this call was free", which is the one thing a spend control must never claim.
		unpriced: 0,
		// The first stop's reason (a STOP_MESSAGES key), or null. Set once by stop(), never overwritten.
		stopReason: null,
		// The pre-#501 flag, kept as a read-only view: true exactly when the stop was the token cap.
		get breached() {
			return this.stopReason === TOKEN_BUDGET;
		},
		sessionIds: new Set(),
	};

	/**
	 * Stop the job for `reason`: the brake answers every later call with that reason's hard stop. First wins,
	 * and `onStop` fires only for the stop that won. SYNCHRONOUS, for record()'s reason below. A reason with
	 * no STOP_MESSAGES row throws: it is a bug in this file, and a stop with no message would brake with
	 * nothing to say.
	 */
	function stop(reason, detail) {
		if (!Object.hasOwn(STOP_MESSAGES, reason)) throw new Error(`unknown meter stop: ${reason}`);
		if (state.stopReason !== null) return false;
		state.stopReason = reason;
		onStop?.(reason, detail);
		return true;
	}

	// Streams already accounted for. Two meters can sit in one dispatch chain -- a compat-half wrapper
	// re-armed over a third party's re-registration of it, or a prototype wrapper a second install layered
	// over the first -- and every link in such a chain hands us the SAME stream object; this makes the
	// double count impossible instead of merely unlikely.
	const observed = new WeakSet();

	// The per-(provider,model) ledger (issue #53; REQ-TOKEN-ACCOUNTING-AND-CAPS,
	// INT-RUN-HISTORY-FILE-CONTRACT). The flat totals above deliberately collapse the cache split --
	// `total` is the billed sum -- but WHICH model spent what is exactly the question the flat numbers
	// cannot answer, so every record also lands on a row keyed by the (provider, model) pair. NUL as
	// the separator because it is a byte neither id can carry; the ids themselves live on the row, so
	// the key never has to be parsed back apart.
	const byModel = new Map();
	// Where a call lands when its ctx names no model: kept OFF the map, so a provider literally named
	// "other" can never merge into it. Same honesty rule as `unpriced` above -- a model-less call is
	// COUNTED here, never guessed onto whichever model a heuristic liked.
	const other = emptyRow();
	// The version of the pi-ai copy the meter priced with, stamped by installProcessUsageMeter once
	// it accepts a compat copy. Pricing PROVENANCE for the run record: history is priced once,
	// and a later pin bump must show as a different stamp on new records, not a silent repricing of
	// old ones. null = unknown, and the exit line says so rather than inventing one.
	let piAiVersion = null;

	/**
	 * SYNCHRONOUS by design, like attachTokenBudget's listener: the breach flag must be set before the
	 * caller's next line runs, or the next provider call slips through under the cap.
	 */
	function record(usage, ctx = {}) {
		const u = usage ?? {};
		state.input += finite(u.input);
		state.output += finite(u.output);
		const billed = finite(u.totalTokens);
		state.total += billed;

		const price = u.cost?.total;
		const priced = typeof price === "number" && Number.isFinite(price);
		if (priced) state.cost += price;
		else state.unpriced += 1;

		const id = typeof ctx.sessionId === "string" ? ctx.sessionId : "";
		if (id.length > 0) state.sessionIds.add(id);
		if (root !== null && id === root) state.rootTotal += billed;
		else if (id.length > 0) state.otherTotal += billed;
		else state.looseTotal += billed;

		// The ledger landing. BOTH ids or neither: a provider without a model id (or the reverse) is
		// not a pair, and a half-attributed row would be a guess wearing a label, so it goes to the
		// bucket with the other model-less calls. `billed` and `priced` are the very values already
		// accumulated above, which is what makes the rows a PARTITION of the flat totals rather than a
		// second opinion on them. The cache split (cacheRead/cacheWrite/cacheWrite1h/reasoning) is kept
		// only here -- it is precisely what `total` collapses.
		const provider = typeof ctx.provider === "string" && ctx.provider.length > 0 ? ctx.provider : null;
		const modelId = typeof ctx.modelId === "string" && ctx.modelId.length > 0 ? ctx.modelId : null;
		let row = other;
		if (provider !== null && modelId !== null) {
			const key = `${provider}\u0000${modelId}`;
			row = byModel.get(key);
			if (!row) {
				row = { provider, model: modelId, ...emptyRow() };
				byModel.set(key, row);
			}
		}
		foldRow(row, {
			calls: 1,
			input: finite(u.input),
			output: finite(u.output),
			cacheRead: finite(u.cacheRead),
			cacheWrite: finite(u.cacheWrite),
			cacheWrite1h: finite(u.cacheWrite1h),
			reasoning: finite(u.reasoning),
			total: billed,
			cost: priced ? price : 0,
			unpriced: priced ? 0 : 1,
		});

		if (cap !== null && state.total > cap) stop(TOKEN_BUDGET, state.total);
		// Accumulation continues past the breach on purpose: the overshoot is the interesting number
		// (it is what the lag actually cost), and hiding it would make the cap look tighter than it is.
		return state;
	}

	/**
	 * Attach accounting to a provider stream WITHOUT consuming it.
	 *
	 * `EventStream.result()` is a memoised promise resolved from push()/end() on the terminal event,
	 * completely independent of the async iterator. Awaiting it observes; it does not steal events from
	 * pi. The stream object is returned untouched -- no proxy, no wrapper -- so identity comparisons and
	 * `instanceof` checks downstream in pi keep working.
	 */
	function observe(stream, ctx = {}) {
		if (!stream || typeof stream.result !== "function") return stream;
		if (observed.has(stream)) return stream;
		observed.add(stream);
		state.calls += 1;
		state.unresolved += 1;
		stream.result().then(
			(message) => {
				state.unresolved -= 1;
				record(message?.usage, ctx);
			},
			() => {
				// A rejected result() is pi's problem to report; swallow it here so we never turn an
				// accounting hook into an unhandled rejection that kills the container. Recorded as a call with
				// no usage (issue #501), so it counts as `unpriced` on its own row: what it spent is unknown, and
				// "unknown" is the one thing a dollar settlement must not read as zero.
				state.unresolved -= 1;
				record(undefined, ctx);
			},
		);
		return stream;
	}

	/**
	 * The same accounting for a call that answers with a PROMISE of a result rather than a stream:
	 * ModelRuntime.classify and generateImages (pi-ai 0.99.1), both of which carry `usage` on the result
	 * and cost money on a paid provider. Both are documented never to reject; a rejection is swallowed
	 * all the same, for observe()'s reason. The promise is returned untouched.
	 */
	function observeResult(promise, ctx = {}) {
		if (!promise || typeof promise.then !== "function") return promise;
		state.calls += 1;
		state.unresolved += 1;
		promise.then(
			(result) => {
				state.unresolved -= 1;
				record(result?.usage, ctx);
			},
			() => {
				state.unresolved -= 1;
				record(undefined, ctx);
			},
		);
		return promise;
	}

	/** The exit-line shape. `metered: true` marks totals that came from here, not from the session bus. */
	function snapshot() {
		return {
			input: state.input,
			output: state.output,
			total: state.total,
			cost: state.cost,
			metered: true,
			rootTotal: state.rootTotal,
			otherTotal: state.otherTotal,
			looseTotal: state.looseTotal,
			sessions: state.sessionIds.size,
			calls: state.calls,
			unresolved: state.unresolved,
			unpriced: state.unpriced,
		};
	}

	/**
	 * The exit line's `usage` block (INT-RUN-HISTORY-FILE-CONTRACT), or null when the meter observed no
	 * provider call at all. run-job.mjs OMITS the key on null rather than emitting `usage: null`, so a
	 * zero-call run keeps the exit line a pre-ledger reader already knows -- absence IS the signal, the
	 * same way `metered: false` is for the fallback meter.
	 *
	 * Emission is bounded to MAX_NAMED_ROWS named rows -- top by billed total; sort() is stable, so
	 * ties keep first-seen order and re-emission is deterministic -- plus at most one "other" row that
	 * absorbs BOTH the folded overflow and the model-less calls. `truncated` counts only the folded
	 * NAMED rows: a model-less call was never a row to lose, merely a call that refused to be guessed
	 * about. The fold targets a COPY of the bucket, so calling this twice cannot compound overflow into
	 * live state, and because the fold is numeric the emitted rows still sum to state.total exactly.
	 */
	function usageSnapshot() {
		if (state.calls === 0) return null;
		const named = [...byModel.values()].sort((a, b) => b.total - a.total);
		const folded = named.slice(MAX_NAMED_ROWS);
		const overflow = { ...other };
		for (const row of folded) foldRow(overflow, row);
		const models = named.slice(0, MAX_NAMED_ROWS).map((row) => ({ ...row }));
		if (overflow.calls > 0) models.push({ provider: "other", model: "other", ...overflow });
		return { v: 1, piAi: piAiVersion, truncated: folded.length, models };
	}

	/**
	 * Stamp the pricing provenance. Only a non-empty string is stored: the installer's version probe is
	 * best-effort, and `piAi` on the exit line must be a real version or null -- never "", never some
	 * object that would serialise into the run record as a shape its readers have to defend against.
	 */
	function setPiAiVersion(version) {
		if (typeof version === "string" && version.length > 0) piAiVersion = version;
	}

	return { state, cap, costCap, allowed, stop, record, observe, observeResult, snapshot, usageSnapshot, setPiAiVersion };
}


/** The zero usage a call the meter's brake answered carries: nothing was spent, so nothing may be recorded as spent. */
function zeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** The verdict for a call the guard judged and let through: dispatch it, and bind it to its settle. */
const ADMITTED = Symbol("admitted");

/**
 * One call's verdict, for both halves: the stop reason that ends it, null to dispatch it unjudged, or ADMITTED.
 *
 * THE GUARD CONTRACT (issues #501, #502). `guard.admit({ method, model, args })` answers null or undefined to let
 * the call through, or a STOP_MESSAGES key to refuse it. Nothing else: a falsy non-null answer (false, 0, "")
 * reaches meter.stop() and throws, on purpose, because a guard that meant "pass" and said `false` would otherwise
 * stop a job with a reason no table names. `guard.bind(result)`, when the guard has one, is called synchronously
 * with what the call it just admitted returned (a stream, or a promise for the two result methods), so the
 * guard can hold the call's bound until it settles. A call is judged only while a brake exists, because a refusal
 * with no hard stop to answer with would have to dispatch the call it refused; `skip` is a call the guard must
 * not judge (a virtual model, whose physical re-entry is judged instead, or a compat call already judged by
 * the runtime half).
 */
function judge({ meter, hardStop, guard, method, model, args, skip }) {
	if (!hardStop) return null;
	if (meter.state.stopReason !== null) return meter.state.stopReason;
	if (guard === null || skip) return null;
	const refused = guard.admit({ method, model, args });
	if (refused === null || refused === undefined) return ADMITTED;
	meter.stop(refused);
	return meter.state.stopReason;
}

/**
 * THE RUNTIME HALF: wrap ModelRuntime's model-calling methods on its PROTOTYPE, so every instance -- the
 * runner's own and any an extension creates -- is metered, and return how to undo it.
 *
 * Per call, in this order:
 *   1. The brake. Checked before dispatch, so a stop ends the NEXT call rather than merely recording it.
 *      A stream method answers with `hardStop(model, message)` (makeHardStopStream below), the message
 *      being the stop reason's STOP_MESSAGES row; a result method answers with an aborted result of its own
 *      kind, zero usage, and never calls the provider. Virtual or not: once stopped nothing is dispatched.
 *   2. A virtual model passes straight through UNOBSERVED and UNGUARDED (trap #4 in the header):
 *      ModelRuntime routes it and calls `this.streamSimple` again with the physical model, which is the call
 *      that is guarded and counted, so one request is judged once and on the model that will answer it.
 *   3. THE GUARD SEAM (issues #501, #502). A physical call is offered to `guard.admit({ method, model, args })`
 *      before dispatch (a guard is `{ enforces, admit }`, `enforces` listing the stop reasons it can refuse
 *      for, which is what assertPoliciesEnforceable reads). It answers null to let the call through, or a STOP_MESSAGES reason to refuse it: the
 *      meter stops with that reason and this call gets the hard stop, so the refused call is the first one
 *      braked. An admitted call is handed to `guard.bind` once dispatched (judge() above has the contract).
 *      The guard is consulted only while a brake exists, because a refusal with no hard stop to answer with
 *      would have to dispatch the call it just refused; the runner refuses before the first prompt when a
 *      policy is set and the brake is missing (assertPoliciesEnforceable). The cost guard (createCostGuard) is
 *      the one guard this build ships, installed only when a cost cap is set; with no guard every call goes
 *      through exactly as before.
 *   4. Everything else is the original method, its stream observed (or its promise, for classify and
 *      generateImages) with the (provider, model) pair read off the Model object dispatched on and the
 *      sessionId off the options -- never parsed back out of a settled message, whose provider/model a
 *      provider is free to normalise, alias or omit.
 *
 * `this` is preserved on every call, because the originals read instance state (credentials, providers).
 * There is deliberately NO try/catch: a throw in here is OUR bug, and swallowing it would turn a metering
 * defect into a silent provider outage that looks like a model error.
 *
 * `restore()` puts back each original only while the prototype still holds OUR wrapper, so a wrapper a
 * later install layered on top is never torn out from under it; in that case this layer is switched to
 * pass-through instead, so it stops counting without breaking the chain.
 */
export function wrapModelRuntime({ ModelRuntime, meter, hardStop = null, hardStopResult = defaultHardStopResult, guard = null, dispatch = new AsyncLocalStorage() }) {
	const proto = ModelRuntime?.prototype;
	const originals = new Map();
	const wrappers = new Map();
	let active = true;
	const ctxOf = (model, options) => ({ sessionId: options?.sessionId, provider: model?.provider, modelId: model?.id });
	// Steps 1 and 3 above, shared by every method: the stop reason that ends this call, or null to dispatch it
	// unjudged, or ADMITTED when the guard judged it and let it through (it is then bound to its settle below).
	// Only streamSimple re-enters with the physical model (trap #4); a virtual model on any other method is judged as
	// itself, and under a cost cap that is an unboundable call, refused.
	const verdictFor = (method, model, args) => judge({ meter, hardStop, guard, method, model, args, skip: method === "streamSimple" && model?.api === VIRTUAL_MODEL_API });

	for (const name of RUNTIME_STREAM_METHODS) {
		const original = proto?.[name];
		if (typeof original !== "function") continue;
		const wrapper = function (model, ...rest) {
			if (!active) return original.call(this, model, ...rest);
			const verdict = verdictFor(name, model, rest);
			if (verdict !== null && verdict !== ADMITTED) return hardStop(model, STOP_MESSAGES[verdict]);
			// Trap #5: everything this call dispatches, across its awaits, runs marked as ours.
			const stream = dispatch.run(true, () => original.call(this, model, ...rest));
			if (verdict === ADMITTED) guard.bind?.(stream);
			if (model?.api === VIRTUAL_MODEL_API) return stream;
			// streamSimple/stream take (model, context, options); streamDeferred takes (model, handle, options).
			// Options are the LAST argument in all three.
			return meter.observe(stream, ctxOf(model, rest.at(-1)));
		};
		originals.set(name, original);
		wrappers.set(name, wrapper);
	}
	for (const name of RUNTIME_RESULT_METHODS) {
		const original = proto?.[name];
		if (typeof original !== "function") continue;
		const wrapper = function (model, context, options) {
			if (!active) return original.call(this, model, context, options);
			const verdict = verdictFor(name, model, [context, options]);
			if (verdict !== null && verdict !== ADMITTED) return Promise.resolve(hardStopResult(name, model, STOP_MESSAGES[verdict]));
			const promise = dispatch.run(true, () => original.call(this, model, context, options));
			if (verdict === ADMITTED) guard.bind?.(promise);
			if (model?.api === VIRTUAL_MODEL_API) return promise;
			return meter.observeResult(promise, ctxOf(model, options));
		};
		originals.set(name, original);
		wrappers.set(name, wrapper);
	}
	for (const [name, wrapper] of wrappers) proto[name] = wrapper;

	return {
		methods: [...wrappers.keys()],
		/** True when `runtime` dispatches through this layer: an instance of the class, no own-property shadow. */
		covers(runtime) {
			if (!(runtime instanceof ModelRuntime)) return false;
			return [...wrappers].every(([name, wrapper]) => runtime[name] === wrapper);
		},
		restore() {
			active = false;
			for (const [name, wrapper] of wrappers) {
				if (proto[name] === wrapper) proto[name] = originals.get(name);
			}
		},
	};
}

/**
 * The aborted result a braked classify or generateImages call answers with: the shape pi-ai's own
 * classifierErrorResult/imageErrorResult build (pi-ai 0.99.1, utils/model-operations.js), with zero usage
 * and `stopReason: "aborted"`, for the reason makeHardStopStream gives.
 */
export function defaultHardStopResult(method, model, message = STOP_MESSAGES[TOKEN_BUDGET]) {
	const base = { api: model?.api, provider: model?.provider, model: model?.id, usage: zeroUsage(), stopReason: "aborted", errorMessage: message, timestamp: Date.now() };
	return method === "generateImages" ? { ...base, output: [] } : { ...base, answers: {} };
}

/**
 * THE COMPAT HALF: a registry-entry-shaped `{ stream, streamSimple }` that mirrors compat's OWN dispatch and
 * meters the result, for extensions that call pi-ai's legacy global stream functions.
 *
 * Once we override an api id, compat's `getBuiltinProviderForModel` answers undefined and compat routes
 * catalog models to us instead of to its builtin provider. Reproducing that branch here is not
 * belt-and-braces (trap #3). It mirrors pi-ai 0.99.1 compat.js exactly: a model whose PROVIDER the builtin
 * catalog knows, with some model on the same api, goes to that provider's own stream function; the
 * cloudflare providers go through the catalog collection itself, whose auth layer substitutes their baseUrl
 * placeholders. compat decides the cloudflare case on whether the caller passed an explicit credential, and
 * it applies the env key BEFORE calling a registry entry, so by the time we are called that distinction is
 * gone; the collection's auth layer is correct whichever it was (it lets an explicit key win), so cloudflare
 * always takes it here.
 *
 * A call made from inside the same install's runtime dispatch (`dispatch`, trap #5) is routed the same way
 * and NOT observed: the runtime half already counted it. Nor is it offered to the `guard`: the runtime half
 * already judged it, and judging one request twice would count its bound twice. A legacy call from outside
 * that dispatch is guarded here exactly as wrapModelRuntime's step 3 guards a runtime call.
 *
 * There is deliberately NO try/catch, for the reason wrapModelRuntime gives.
 */
export function wrapProviderStreams({ inner, fallbackModels, meter, hardStop, guard = null, dispatch = null }) {
	function route(kind, model, context, options) {
		// Checked before dispatch, so a stop ends the NEXT call rather than merely recording it.
		const verdict = judge({ meter, hardStop, guard, method: kind, model, args: [context, options], skip: dispatch?.getStore() === true });
		if (verdict !== null && verdict !== ADMITTED) return hardStop(model, STOP_MESSAGES[verdict]);
		const provider = fallbackModels?.getProvider?.(model.provider);
		const builtin = provider?.getModels?.().some((candidate) => candidate.api === model.api) ? provider : null;
		const stream = builtin
			? model.provider.startsWith("cloudflare-")
				? fallbackModels[kind](model, context, options)
				: builtin[kind](model, context, options)
			: inner[kind](model, context, options);
		if (verdict === ADMITTED) guard.bind?.(stream);
		if (dispatch?.getStore() === true) return stream;
		return meter.observe(stream, { sessionId: options?.sessionId, provider: model.provider, modelId: model.id });
	}
	return {
		stream: (model, context, options) => route("stream", model, context, options),
		streamSimple: (model, context, options) => route("streamSimple", model, context, options),
	};
}

/**
 * A terminal stream that ends a call before it reaches a provider.
 *
 * Shape mirrors pi-ai's `createSetupErrorMessage` (dist/api/lazy.js) so pi's consumers see something
 * they already understand, with two deliberate differences: zero usage (nothing was spent, and
 * inventing usage here would corrupt the very totals this module exists to get right) and
 * `stopReason: "aborted"` rather than `"error"`. That second one matters: pi's
 * `isRetryableAssistantError` returns false whenever stopReason !== "error", so an aborted terminal
 * message will NOT spin pi's auto-retry. An "error" here would make the cap trigger paid retries.
 *
 * `createStream` is injected -- that is what keeps this function pure and this file free of any static
 * pi import. installProcessUsageMeter passes the real `createAssistantMessageEventStream` it pulled off
 * the accepted compat module; tests pass a fake.
 *
 * The returned function is `(model, message)`: the wrappers pass the stop reason's STOP_MESSAGES row, so one
 * brake serves every stop. `message` given here is only the default for a caller that passes none.
 */
export function makeHardStopStream({ createStream, message: defaultMessage = STOP_MESSAGES[TOKEN_BUDGET] }) {
	if (typeof createStream !== "function") throw new Error("makeHardStopStream requires createStream");
	return (model, message = defaultMessage) => {
		const stream = createStream();
		const aborted = {
			role: "assistant",
			content: [],
			api: model?.api,
			provider: model?.provider,
			model: model?.id,
			usage: zeroUsage(),
			stopReason: "aborted",
			errorMessage: message,
			timestamp: Date.now(),
		};
		// push() resolves result() via the terminal-event predicate; end() covers a stream implementation
		// that does not. Both are idempotent on pi's EventStream (`done` short-circuits push).
		stream.push({ type: "error", reason: "aborted", error: aborted });
		stream.end(aborted);
		return stream;
	};
}

/** Resolve a specifier to a URL string, or null when the package is not installed. */
function tryResolve(resolve, specifier) {
	try {
		const url = resolve(specifier);
		return typeof url === "string" && url.length > 0 ? url : null;
	} catch {
		return null;
	}
}

/**
 * The ORDERED compat candidate list, most-likely-correct first.
 *
 * WHY pi-ai IS NOT IN THE RUNNER'S package.json, even though this module depends on it. What the
 * meter needs is not "a pi-ai" but pi-coding-agent's OWN pi-ai -- the copy pi hands its extensions (trap
 * #1 above). No dependency declaration can express that: a declared `@earendil-works/pi-ai` is a request
 * for a copy at the runner's own tree position, which npm may satisfy by hoisting a THIRD one, and the
 * meter would then have more wrong answers to choose between, not fewer. So the dependency stays
 * deliberately undeclared and the binding is settled where it can actually be settled: at runtime, by the
 * identity check in installProcessUsageMeter. (package.json admits no comment, which is why this note lives
 * here.)
 *
 * NESTED first because pi-coding-agent's own imports resolve there. HOISTED second only as a degraded
 * fallback for a flattened install tree where the nested copy does not exist. This ordering is a
 * hypothesis, not a conclusion -- installProcessUsageMeter proves a candidate before trusting it, because
 * `import.meta.resolve` is exactly the thing that lies here. Also read by the image contract job
 * (.github/workflows/pi-upgrade-check.yml), and by loadRetryPredicate for a runner whose compat half did
 * not install.
 *
 * `resolve` and `exists` are injected so this stays pure and testable.
 */
export function resolvePiAiCompat({ resolve = (spec) => import.meta.resolve(spec), exists = defaultExists } = {}) {
	const candidates = [];

	const agentEntry = tryResolve(resolve, "@earendil-works/pi-coding-agent");
	if (agentEntry) {
		// dist/index.js -> dist -> package root.
		const packageDir = dirname(dirname(fileURLToPath(agentEntry)));
		const nested = pathToFileURL(
			join(packageDir, "node_modules", "@earendil-works", "pi-ai", "dist", "compat.js"),
		).href;
		if (exists(nested)) candidates.push({ tag: "nested", url: nested });
	}

	const hoisted = tryResolve(resolve, "@earendil-works/pi-ai/compat");
	if (hoisted) candidates.push({ tag: "hoisted", url: hoisted });

	return candidates;
}

function defaultExists(url) {
	try {
		return existsSync(fileURLToPath(url));
	} catch {
		return false;
	}
}

/**
 * The module map pi hands its extensions, read from pi-coding-agent's own dist by FILE URL: the exports map
 * constrains bare specifiers only, and this file is not exported (the tools.mjs allToolNames trick). At the
 * 0.99.1 pin `VIRTUAL_MODULES["@earendil-works/pi-ai"]` IS the compat namespace pi's own code imports
 * (virtual-modules.js: `import * as bundledPiAiCompat from "@earendil-works/pi-ai/compat"`), which makes it
 * the one oracle for "the compat copy an extension gets": the Node build's jiti aliases resolve the same
 * specifier from the same package (loader.js getAliases). pinned-api.test.mjs pins both spellings.
 */
async function defaultLoadExtensionModules({ resolve = (spec) => import.meta.resolve(spec), load = (url) => import(url) } = {}) {
	const agentEntry = resolve("@earendil-works/pi-coding-agent");
	const modules = await load(new URL("./core/extensions/virtual-modules.js", agentEntry).href);
	return modules?.VIRTUAL_MODULES ?? null;
}

/**
 * Linux-only child-process sampler.
 *
 * A subagent fanout that shells out shows up as child processes long before it shows up as settled
 * usage, so this is the cheapest early signal that a job went wide. Purely diagnostic: it degrades to
 * null off Linux (macOS has no /proc) and its sample() swallows everything, because a metering
 * accessory must never be able to fail a job.
 */
function createChildSampler(platform) {
	if (platform !== "linux") return null;
	const seen = new Set();
	const children = { distinct: 0, peak: 0, ticks: 0, sample };
	function sample() {
		try {
			children.ticks += 1;
			let live = 0;
			for (const tid of readdirSync("/proc/self/task")) {
				let raw;
				try {
					raw = readFileSync(`/proc/self/task/${tid}/children`, "utf8");
				} catch {
					continue; // A thread can exit between readdir and read. Expected, not an error.
				}
				for (const pid of raw.split(/\s+/)) {
					if (!pid) continue;
					live += 1;
					seen.add(pid);
				}
			}
			children.distinct = seen.size;
			if (live > children.peak) children.peak = live;
		} catch {
			// Diagnostics only.
		}
		return children;
	}
	return children;
}

/** A code or name for a failure, never `error.message`: a module-resolution message carries a path, and run logs ship. */
function reasonOf(error) {
	return error?.code ?? error?.name ?? "unknown";
}

/**
 * Install both halves of the meter. Returns `ok: false` -- and the caller falls back to the per-session
 * token budget -- ONLY when the RUNTIME half cannot meter, because that half is the one every session
 * dispatches through. A compat half that could not install degrades the meter without disabling it, and is
 * named on the `usage_meter` line (`compat: false` with a reason) rather than hidden behind a plain ok:true.
 *
 * The runtime half. `ModelRuntime` is the class run-job.mjs imports from pi-coding-agent (injected, trap
 * #1). `runtime`, when given, is the instance the session will be created with, and it is the acceptance
 * test: after wrapping, the instance must dispatch through the wrappers (an instance of the class, no own
 * property shadowing a method). That is the runtime analogue of the old mutation probe -- it fails when the
 * class run-job imported is not the one the instance was built from, the wrong-copy failure trap #1 names.
 * A class with no streamSimple/stream is refused outright (ok:false, reason `no-runtime-methods`).
 *
 * The compat half. Each candidate from resolvePiAiCompat is loaded and accepted only when it IS, by object
 * identity, the module pi hands an extension for `@earendil-works/pi-ai` (defaultLoadExtensionModules).
 * The accepted module also supplies the brake's stream factory and the ledger's pricing provenance (the
 * `version` in the package.json above its dist/), because it is the copy whose providers priced the calls.
 * Registration goes straight through the accepted compat's own `registerApiProvider` (at 0.99.1 the
 * ModelRegistry no longer writes to this registry at all), filed under METER_PROVIDER_PREFIX so one api id
 * is one registration; the unref'd interval re-arms after `resetApiProviders()`.
 */
export async function installProcessUsageMeter({
	ModelRuntime,
	runtime = null,
	meter,
	log = () => {},
	rearmMs = 1000,
	resolve,
	load = (url) => import(url),
	exists,
	loadExtensionModules = () => defaultLoadExtensionModules({ ...(resolve ? { resolve } : {}), load }),
	readText = (path) => readFileSync(path, "utf8"),
	platform = process.platform,
	guard = null,
}) {
	// --- the compat half's copy, decided first: it supplies the brake's stream factory to BOTH halves ---
	const candidates = resolvePiAiCompat({ resolve, exists });
	const tried = [];
	let accepted = null;
	let compatError = null;
	let extensionModules = null;
	try {
		extensionModules = await loadExtensionModules();
		if (!extensionModules) compatError = "no-extension-modules";
	} catch (error) {
		compatError = reasonOf(error);
	}
	for (const candidate of extensionModules ? candidates : []) {
		tried.push(candidate.tag);
		let mod;
		try {
			mod = await load(candidate.url);
		} catch {
			continue;
		}
		if (typeof mod?.registerApiProvider !== "function" || typeof mod?.getApiProvider !== "function" || typeof mod?.getApiProviders !== "function") continue;
		// Identity, not equality of shape: two copies export the same names. Only the copy pi hands its
		// extensions is the registry a legacy extension call goes through.
		if (extensionModules["@earendil-works/pi-ai"] !== mod) continue;
		accepted = { candidate, mod };
		break;
	}
	if (!accepted && !compatError) compatError = "no-candidate-matched";
	const module = accepted?.mod ?? null;

	// Stamp the ledger's pricing provenance from the ACCEPTED copy's package.json, a path built RELATIVE TO
	// the accepted compat url so it can only ever name that copy (resolving the package by specifier would
	// reopen trap #1). Best-effort and SILENT on any failure: `piAi` is null when unknown, and an error
	// logged here would carry the resolved path, which the no-path rule forbids shipping. `readText` is
	// injected so the pure tests need no disk.
	if (accepted) {
		try {
			meter.setPiAiVersion(JSON.parse(readText(fileURLToPath(new URL("../package.json", accepted.candidate.url)))).version);
		} catch {
			// piAi stays null on the exit line; the ledger itself is unaffected.
		}
	}

	// Armed only when a POLICY exists -- a token cap, a cost cap or a model list -- so a job with none of them
	// can never have a call stopped. All three, not the token cap alone (issues #501, #502): the cost cap and
	// the list are enforced BEFORE a call, by the guard, and a refusal needs this hard stop to answer with.
	// The stream factory comes from the accepted compat copy, so a compat half that did not install leaves no
	// brake for either half, and the runner then refuses a cost cap or a list before the first prompt.
	const createStream = typeof module?.createAssistantMessageEventStream === "function"
		? module.createAssistantMessageEventStream
		: typeof module?.AssistantMessageEventStream === "function"
			? () => new module.AssistantMessageEventStream()
			: null;
	const armed = meter.cap !== null || meter.costCap !== null || meter.allowed !== null;
	const hardStop = armed && createStream ? makeHardStopStream({ createStream }) : null;

	// --- the runtime half: THE choke point. Without it there is no process-wide meter. ---
	const methodsPresent = typeof ModelRuntime?.prototype?.streamSimple === "function" && typeof ModelRuntime?.prototype?.stream === "function";
	if (!methodsPresent) {
		// Never log a filesystem path: run logs are shipped, and the image layout is not public data.
		log("usage_meter_unavailable", { reason: "no-runtime-methods" });
		return { ok: false, arm: () => {}, uninstall: () => {} };
	}
	// One per install, shared by both halves (trap #5).
	const dispatch = new AsyncLocalStorage();
	const runtimeLayer = wrapModelRuntime({ ModelRuntime, meter, hardStop, guard, dispatch });
	if (runtime !== null && !runtimeLayer.covers(runtime)) {
		runtimeLayer.restore();
		log("usage_meter_unavailable", { reason: "runtime-not-covered" });
		return { ok: false, arm: () => {}, uninstall: () => {} };
	}

	// --- the compat half, armed only on an accepted copy ---
	// The catalog path compat would have taken for builtin models, loaded as a SIBLING of the accepted
	// compat url so it comes from the same copy. Resolving it by specifier would reopen trap #1.
	let fallbackModels = null;
	let fallbackError = null;
	if (accepted) {
		try {
			const all = await load(new URL("./providers/all.js", accepted.candidate.url).href);
			fallbackModels = all?.builtinModels?.() ?? null;
			// A module that loaded but exposes no builtinModels() is the same loss as a module that did not
			// load, and it is the shape a pin bump would produce -- so it gets its own reason, not silence.
			if (!fallbackModels) fallbackError = "no-builtin-models";
		} catch (error) {
			// Degraded but still metering: without the catalog every compat call goes to the registry entry,
			// which is WRONG for the builtin providers (compat itself would have called their own provider)
			// and breaks the cloudflare ones outright.
			fallbackModels = null;
			fallbackError = reasonOf(error);
		}
	}

	// Object identity, not api id: the registry hands back a FRESH provider object on every registration,
	// so "did we install this one?" is answerable only by identity.
	const wrapped = new Set();
	const armedApis = new Set();
	const children = createChildSampler(platform);

	const handle = {
		ok: true,
		// Whether a hard stop exists, and which stops the installed guard can refuse for: the two facts
		// assertPoliciesEnforceable reads before the first prompt. Per policy, not one flag, so a guard that
		// enforces the cost cap cannot pass for one that enforces the model list.
		brake: hardStop !== null,
		enforces: Object.freeze([...(guard?.enforces ?? [])]),
		methods: runtimeLayer.methods,
		module,
		tag: accepted?.candidate.tag ?? null,
		apis: [],
		arm,
		rearms: 0,
		children,
		uninstall,
	};

	function arm() {
		if (!module) return handle;
		let entries;
		try {
			entries = module.getApiProviders();
		} catch {
			return handle;
		}
		let displaced = 0;
		for (const entry of entries ?? []) {
			const api = entry?.api;
			if (typeof api !== "string") continue;
			if (wrapped.has(entry)) continue;
			const streams = wrapProviderStreams({ inner: entry, fallbackModels, meter, hardStop, guard, dispatch });
			// One sourceId per api id, and registerApiProvider keys the registry by api id, so re-arming
			// replaces our entry instead of piling up registrations.
			module.registerApiProvider({ api, ...streams }, `${METER_PROVIDER_PREFIX}:${api}`);
			const installed = module.getApiProvider(api);
			if (installed) wrapped.add(installed);
			if (armedApis.has(api)) {
				handle.rearms += 1;
				displaced += 1;
			} else armedApis.add(api);
		}
		handle.apis = [...armedApis].sort();
		// THE RE-ARM GAP UNDER A COST CAP (issue #501). An api id this half had wrapped was found replaced: by
		// resetApiProviders() (AgentSession.reload()), or by an extension re-registering it. Between that and this
		// arm, a legacy compat call on that api reached a provider UNGUARDED, and nothing can tell whether one did:
		// the call went through an entry that is not ours. For the token cap that is a gap in a lagging count; for
		// a cap that is checked BEFORE a call it is a call that may have passed the cap unseen. So under a cost
		// cap a displacement stops the job, fail closed. Judging cost in the runtime half alone would not close
		// it: a legacy compat call never enters a ModelRuntime (header, trap #5's converse). A job with no cost cap
		// keeps today's behaviour: re-wrap and count the re-arm.
		// The stop alone leaves no trace a settlement can read (the exit reason is the same `cost-cap` a plain refusal
		// gives), so the guard also counts the displaced entries as `costUnjudged` on the exit line: a non-zero value
		// says calls may have run unjudged and unmetered, and the job's cost is a floor.
		if (displaced > 0 && meter.costCap !== null) {
			guard?.unjudged?.(displaced);
			if (meter.state.stopReason === null) {
				log("cost_guard_displaced", { apis: displaced });
				meter.stop(COST_CAP);
			}
		}
		return handle;
	}

	let toreDown = false;
	function uninstall() {
		clearInterval(timer);
		if (toreDown) return;
		toreDown = true;
		runtimeLayer.restore();
		// THE RE-ARM GAP, made inferable (REQ-TOKEN-ACCOUNTING-AND-CAPS). Compat half only: at 0.99.1 a
		// session's own calls never enter the registry, so this window can hide only a legacy extension call.
		//
		// `resetApiProviders()` wipes the compat wrappers and replays nothing, and the only thing that puts
		// them back is the unref'd `rearmMs` poll. A registry call landing between the wipe and the next arm()
		// is UNMETERED, and nothing else in the run record shows it. `rearms` counts the api IDS arm() found
		// displaced, not the wipes -- one wipe displaces every armed api at once, which is why `apis` is on
		// the same line, and `rearmMs` with it because the window's width is the other half of any estimate.
		log("usage_meter_teardown", { rearms: handle.rearms, apis: handle.apis.length, rearmMs });
	}

	arm();
	// Once, on success. Tags and names -- never a path.
	//
	// `methods` is what the runtime half wrapped. `compat` is the compat half's accepted copy (a tag, or
	// false with `compatError`), and `fallback` whether its builtin catalog loaded; without it the compat
	// half sends builtin models to the wrong entry. `brake` is whether a hard-stop stream exists; `capped`
	// rides along because it is what makes `brake` readable: an uncapped job has no brake BY DESIGN, so
	// `capped:true` with `brake:false` is the alarm -- a cap that can only be enforced after the fact.
	// `costCapped` and `listed` (issues #501, #502) are the other two policies that arm the brake, so the
	// same reading holds for them: either true beside `brake:false` is a policy the runner then refuses.
	// Reporting a plain `ok:true` over any of these would be a degraded meter calling itself healthy.
	log("usage_meter", {
		ok: true,
		methods: handle.methods,
		compat: handle.tag ?? false,
		...(compatError ? { compatError, tried } : {}),
		apis: handle.apis,
		...(accepted ? { fallback: fallbackModels !== null } : {}),
		...(fallbackError ? { fallbackError } : {}),
		capped: meter.cap !== null,
		costCapped: meter.costCap !== null,
		listed: meter.allowed !== null,
		brake: hardStop !== null,
	});

	const timer = setInterval(() => {
		arm();
		children?.sample();
	}, rearmMs);
	// Unref'd: this must never be the reason the container stays alive after the job finishes.
	timer.unref?.();

	return handle;
}

/**
 * Refuse, before the first prompt, a cost cap or a model list this runner cannot enforce BEFORE a call
 * (issues #501, #502; INT-RUNNER-EXIT-CODE-PROTOCOL). Both policies are pre-call by definition: a cost cap
 * checked after a call has already let one call past it, and one call can cost more than the cap, and a model
 * list checked after a call has already paid the model it forbids. So each needs, together:
 *   - the process-wide meter installed (`meterOk`). The fallback bus meter (run-job's attachTokenBudget) sees a
 *     call only after it settled, which is exactly the after-the-fact enforcement these policies rule out;
 *   - a hard stop to answer a refused call with (`brake`), which needs the compat copy's stream factory;
 *   - a guard that judges each call FOR THAT POLICY (`enforces` lists the stop reasons the installed guard can
 *     refuse for: COST_CAP for the cap, MODEL_NOT_ALLOWED for the list). The cost guard (createCostGuard) enforces
 *     COST_CAP; no model guard ships in this build, so every list still refuses (issue #502 adds it).
 * Missing any one, the job is refused as a tagged configError: exit 2, not retried, before any spend. The
 * model list is checked first: a job that would be refused for both is named by the policy that decides
 * which provider is called at all. Names only, never values: the cap and the list are not echoed.
 */
export function assertPoliciesEnforceable({ maxCostMicros = null, allowedModels = null, meterOk, brake, enforces = [] }) {
	const missing = (stop) => (!meterOk
		? "the process-wide usage meter did not install"
		: !brake
			? "the usage meter has no hard-stop stream"
			: !enforces.includes(stop)
				? "this runner has no pre-call guard for it"
				: null);
	if (allowedModels !== null && missing(MODEL_NOT_ALLOWED) !== null) {
		throw configError(`PI_ALLOWED_MODELS is set but cannot be enforced before a call: ${missing(MODEL_NOT_ALLOWED)}`, MODEL_POLICY_UNENFORCEABLE);
	}
	if (maxCostMicros !== null && missing(COST_CAP) !== null) {
		throw configError(`PI_MAX_COST_MICROS is set but cannot be enforced before a call: ${missing(COST_CAP)}`, COST_CAP_UNENFORCEABLE);
	}
}

/**
 * The stop handler run-job.mjs gives the meter (issues #501, #502). Every stop aborts the root session, the same
 * synchronous way, whichever policy it was; only a TOKEN stop logs `token_budget_exceeded`, because that line
 * means "the token cap", and a cost or model stop that wrote it would send an operator to the wrong knob. Pure,
 * so the wiring is tested here rather than only read off run-job's source.
 */
export function meterStopHandler({ onTokenAbort, abort }) {
	return (reason, detail) => {
		if (reason === TOKEN_BUDGET) onTokenAbort(detail);
		abort();
	};
}

/**
 * The three facts assertPoliciesEnforceable reads, off an install handle. `brake` is true only for an installed
 * meter that has a hard stop: a handle with ok:false is the fallback bus meter, whose brake (if any field said
 * so) could never answer a call before it is sent.
 */
export function policyEnforcement(handle) {
	const ok = handle?.ok === true;
	return { meterOk: ok, brake: ok && handle.brake === true, enforces: ok ? handle.enforces ?? [] : [] };
}

// ── Issue #501: the per-job cost cap, checked before every provider call ──────────────────────────────────
//
// Every number below is an INTEGER of micro-dollars (1 USD = 1,000,000), the unit of PI_MAX_COST_MICROS.
// pi-ai rates are dollars per million tokens, so tokens x rate is already micro-dollars.

/**
 * The api ids whose provider prices a call from the model's cost table, at the 0.99.1 pin: exactly the
 * dist/api modules that reach pi-ai's `calculateCost` (directly, or through openai-responses-shared.js and
 * system-one-shared.js). pinned-api.test.mjs derives that set from the pinned source and requires it to equal
 * this list, so a new priced api fails the pin rather than the budget. An api NOT here prices itself or not at
 * all (`pi-messages` and the Radius providers report their own cost; images and classifiers have their own
 * modules), so the catalog's table says nothing about what its call costs, and the bound is Infinity.
 */
export const PRICED_APIS = Object.freeze([
	"anthropic-messages",
	"azure-openai-responses",
	"bedrock-converse-stream",
	"cloudflare-workers-ai-system-one",
	"google-generative-ai",
	"google-vertex",
	"mistral-conversations",
	"openai-codex-responses",
	"openai-completions",
	"openai-responses",
	"typesafe-system-one",
]);
/** Added to the request's byte length for what the provider adds around it (system framing, tool schemas). */
export const BOUND_OVERHEAD_TOKENS = 8192;
/** Anthropic's long-context threshold, in input tokens (user decision, issue #501). */
export const LONG_CONTEXT_TOKENS = 200_000;
/**
 * The two apis that report `cacheWrite1h` (so a 1h write is priced at 2 x input) and that carry Anthropic's
 * models, which is where the synthetic long-context tier applies. Pinned by needle.
 */
const ANTHROPIC_PRICED_APIS = new Set(["anthropic-messages", "bedrock-converse-stream"]);
/** The apis that multiply the settled cost by the service tier the RESPONSE reports (pinned by needle). */
const SERVICE_TIER_APIS = new Set(["openai-responses", "openai-codex-responses"]);
/** The apis that raise max_output_tokens to 16 (OPENAI_RESPONSES_MIN_OUTPUT_TOKENS, pinned by needle). */
const MIN_OUTPUT_APIS = new Set(["openai-responses", "azure-openai-responses"]);
const MIN_OUTPUT_TOKENS = 16;
/**
 * The apis that never put the caller's maxTokens on the request (pinned by needle): the provider then answers up
 * to the model's own limit, so a small options.maxTokens bounds nothing there.
 */
const MAX_TOKENS_UNSENT_APIS = new Set(["openai-codex-responses", "cloudflare-workers-ai-system-one", "typesafe-system-one"]);

/** A rate that is a finite, non-negative number. Anything else makes the table unusable for a bound. */
function rate(value) {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Every cost table that could price this call: the model's own, then each allowed fallback's (pi-ai prices a fallback answer at the fallback's table). */
function baseTables(model) {
	const fallbacks = Array.isArray(model?.compat?.allowedFallbackModels) ? model.compat.allowedFallbackModels : [];
	return [model?.cost, ...fallbacks.map((fallback) => fallback?.cost)];
}

/** Whether the request carries options.maxTokens as its output cap. See MAX_TOKENS_UNSENT_APIS. */
function sendsMaxTokens(model, options) {
	if (MAX_TOKENS_UNSENT_APIS.has(model.api)) return false;
	if (model.api === "openai-responses") {
		if (model.compat?.supportsMaxOutputTokens === false) return false;
		// Sign in with ChatGPT drops max_output_tokens (openai-responses.js isChatGPTSignIn). The key is resolved
		// AFTER this wrapper (ModelRuntime.prepareRequest), so unless the caller passed an `sk-` key itself, the
		// openai provider on its own baseUrl may be that case.
		const apiKey = options?.apiKey;
		if (model.provider === "openai" && model.baseUrl === "https://api.openai.com/v1" && !(typeof apiKey === "string" && apiKey.startsWith("sk-"))) return false;
	}
	return true;
}

/**
 * The most one provider call can cost, in integer micro-dollars: a number, 0 for a zero-rated model, or
 * Infinity when the call cannot be bounded (the guard refuses those under a cap). Pure. `env` is the process
 * environment, injected (PI_CACHE_RETENTION).
 *
 * The steps, each a fact about pi-ai 0.99.1 that pinned-api.test.mjs holds by needle:
 *   1. An api outside PRICED_APIS: Infinity.
 *   2. The rate tables: model.cost, each compat.allowedFallbackModels cost (anthropic-messages bills a fallback
 *      answer at the fallback's rates), each table's `tiers` entry that the input could reach, and, for a table
 *      with no tiers on the two Anthropic apis, a SYNTHETIC long-context tier above 200k input tokens (2 x input,
 *      cache read and cache write, 1.5 x output). The catalog carries no Anthropic long-context prices, and the
 *      user decision was a generic tier rather than a hand-kept price table. A rate that is not a finite
 *      non-negative number: Infinity.
 *   3. Every rate 0: 0, so a zero-rated local model runs under a cap of 0.
 *   4. inputBound = UTF-8 bytes of JSON.stringify(context) + BOUND_OVERHEAD_TOKENS. ASSUMPTION: one token is at
 *      least one UTF-8 byte; `boundExceeded` on the exit line is the evidence if a tokenizer breaks it. NOT capped
 *      by model.contextWindow: pi does not enforce the window (gpt-5.4 lists 272k and prices a tier above it).
 *      A context that does not serialise: Infinity. Each image block counts at least a per-image pixel ceiling
 *      (imageAllowance), because providers bill pixels, not base64 bytes.
 *   5. The output bound: options.maxTokens (when positive and the api sends it) else model.maxTokens; raised to
 *      model.maxTokens when options.reasoning is set (adjustMaxTokensForThinking may lift the caller's budget up
 *      to it); at least 16 on openai-responses and azure. 0 for `classify`, which is Infinity if any output rate
 *      is above 0 (pi exposes no output bound for it). No usable number, or a present maxTokens that is not
 *      finite: Infinity. On the three apis that merge samplingParams after the cap, an output-cap key there wins
 *      if larger and `n` multiplies (samplingOutput).
 *   6. The input rate of a table is the highest of input, cacheRead and cacheWrite, and 2 x input when a 1h cache
 *      write can happen: api anthropic-messages or bedrock-converse-stream and retention "long", resolved as pi
 *      does (options.cacheRetention, else options.env.PI_CACHE_RETENTION, else the process env).
 *   7. The service-tier multiplier: 2.5 for gpt-5.5 and 2 otherwise on openai-responses and
 *      openai-codex-responses (pi multiplies the settled cost by the tier the RESPONSE reports, which can be the
 *      account's default, not only the request's); 1 elsewhere, azure included (it applies none).
 *   8. ceil(max over tables of (inputBound x inputRate + output x outputRate) x multiplier). Per table, because
 *      pi prices one call with exactly one table.
 */
export function callCostBound(method, model, context, options, env = process.env) {
	// 1.
	if (!PRICED_APIS.includes(model?.api)) return Infinity;
	// 2. The tables before tiers; each must be usable.
	const bases = baseTables(model);
	const fields = ["input", "output", "cacheRead", "cacheWrite"];
	for (const table of bases) {
		if (!table || !fields.every((field) => rate(table[field]))) return Infinity;
		const tiers = table.tiers ?? [];
		if (!Array.isArray(tiers)) return Infinity;
		for (const tier of tiers) {
			if (!tier || !fields.every((field) => rate(tier[field])) || !rate(tier.inputTokensAbove)) return Infinity;
		}
	}
	// 3.
	const everyRate = bases.flatMap((table) => [table, ...(table.tiers ?? [])]).flatMap((table) => fields.map((field) => table[field]));
	if (everyRate.every((value) => value === 0)) return 0;
	// 4.
	let serialised;
	try {
		serialised = JSON.stringify(context);
	} catch {
		return Infinity;
	}
	const inputBound = (typeof serialised === "string" ? Buffer.byteLength(serialised, "utf8") : 0) + BOUND_OVERHEAD_TOKENS + imageAllowance(model, context);
	// 5.
	let output;
	if (method === "classify") {
		const outputRates = bases.flatMap((table) => [table, ...(table.tiers ?? [])]).map((table) => table.output);
		if (outputRates.some((value) => value > 0)) return Infinity;
		output = 0;
	} else {
		// A PRESENT maxTokens that is not a finite number is unboundable: pi's clampMaxTokensToContext turns NaN into a
		// null on the wire (the provider's default) and Infinity into the remaining window. null/undefined is absent,
		// as pi reads it (`options?.maxTokens ?? model.maxTokens`); a finite value of 0 or less is not sent by
		// openai-completions and is refused by the others, so it bounds nothing and the model's cap applies.
		const raw = options?.maxTokens;
		if (raw !== undefined && raw !== null && !(typeof raw === "number" && Number.isFinite(raw))) return Infinity;
		const asked = typeof raw === "number" && raw > 0 ? raw : undefined;
		const modelMax = typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : undefined;
		output = sendsMaxTokens(model, options) ? (asked ?? modelMax) : modelMax;
		if (options?.reasoning) output = modelMax === undefined || output === undefined ? undefined : Math.max(output, modelMax);
		if (output === undefined) return Infinity;
		if (MIN_OUTPUT_APIS.has(model.api)) output = Math.max(output, MIN_OUTPUT_TOKENS);
		output = samplingOutput(model, options, output);
		if (!Number.isFinite(output)) return Infinity;
	}
	// 6.
	const anthropic = ANTHROPIC_PRICED_APIS.has(model.api);
	// pi's own order and truthiness (anthropic-messages.js resolveCacheRetention, provider-env.js getProviderEnvValue).
	// env-internal PI_CACHE_RETENTION: pi-ai's own knob, read here only to bound a call the way pi will price it.
	const retention = options?.cacheRetention || ((options?.env?.PI_CACHE_RETENTION || env?.PI_CACHE_RETENTION) === "long" ? "long" : "short");
	const longWrite = anthropic && retention === "long";
	// 7.
	const multiplier = SERVICE_TIER_APIS.has(model.api) ? (model.id === "gpt-5.5" ? 2.5 : 2) : 1;
	// 2 and 8: every table that could price this call, the dearest of them.
	let dearest = 0;
	for (const table of bases) {
		const tiers = table.tiers ?? [];
		const candidates = [table, ...tiers.filter((tier) => inputBound > tier.inputTokensAbove)];
		if (anthropic && tiers.length === 0 && inputBound > LONG_CONTEXT_TOKENS) candidates.push(longContextTier(table));
		for (const rates of candidates) {
			const inputRate = Math.max(rates.input, rates.cacheRead, rates.cacheWrite, longWrite ? 2 * rates.input : 0);
			dearest = Math.max(dearest, inputBound * inputRate + output * rates.output);
		}
	}
	const bound = Math.ceil(dearest * multiplier);
	return Number.isFinite(bound) ? bound : Infinity;
}

/**
 * The apis that merge `model.samplingParams` and `options.samplingParams` into the request AFTER the output cap
 * (`Object.assign(params, model.samplingParams, options?.samplingParams)`, pinned by needle), so a key there
 * overrides it. Issue #501, PR #534's review.
 */
const SAMPLING_OVERRIDE_APIS = new Set(["openai-completions", "openai-responses", "azure-openai-responses"]);
const SAMPLING_OUTPUT_KEYS = Object.freeze(["max_tokens", "max_completion_tokens", "max_output_tokens"]);
/**
 * The samplingParams keys a bound can reason about. Because the merge comes LAST, any other key overrides the
 * request itself (`model`, `service_tier`, `tools`...), so a samplingParams holding a key outside this list makes
 * the call unboundable under a cap. The sampling knobs here change which tokens come out, never the price of one.
 */
export const SAMPLING_SAFE_KEYS = Object.freeze(["temperature", "top_p", "top_k", "seed", "stop", "presence_penalty", "frequency_penalty", ...SAMPLING_OUTPUT_KEYS, "n"]);

/**
 * The output bound once samplingParams have had their say: the larger of the bound and any output-cap key there,
 * times `n` (completions answer n choices, each up to the cap). A key that is present but not a positive finite
 * number (null sends the provider's default; a string is whatever the server makes of it) is Infinity.
 */
function samplingOutput(model, options, output) {
	if (!SAMPLING_OVERRIDE_APIS.has(model.api)) return output;
	const merged = { ...(model.samplingParams ?? {}), ...(options?.samplingParams ?? {}) };
	if (Object.keys(merged).some((key) => !SAMPLING_SAFE_KEYS.includes(key))) return Infinity;
	const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
	let bound = output;
	for (const key of SAMPLING_OUTPUT_KEYS) {
		if (!Object.hasOwn(merged, key)) continue;
		if (!positive(merged[key])) return Infinity;
		bound = Math.max(bound, merged[key]);
	}
	if (Object.hasOwn(merged, "n")) {
		if (!positive(merged.n) || !Number.isInteger(merged.n)) return Infinity;
		bound *= merged.n;
	}
	return bound;
}

/** pi's default image resize box (pi-coding-agent utils/image-resize-core.js, pinned by needle). */
export const IMAGE_RESIZE_MAX = Object.freeze({ width: 2000, height: 2000 });
/**
 * Input tokens one image can cost in pi's resize box (2000 x 2000), per api. Provider billing rules, not pi facts,
 * so each is stated with its arithmetic, for the family each api natively serves:
 *   - the openai apis (completions, responses, azure, codex): gpt-4o-mini's high-detail tiles, base 2,833 plus
 *     5,667 per 512 px tile. Inside a 2000 box the most tiles is 4 x 2 = 8 (a 2000 x 750 image: no side over
 *     2048, the shortest side under 768 so not scaled), so 2,833 + 8 x 5,667 = 48,169. gpt-4o's 85 + 170 per tile
 *     and the 32 px patch counts (2000 x 2000 is 3,969 patches) are below it;
 *   - mistral-conversations: Pixtral's 16 px patches plus one break token per row, unscaled at 2000:
 *     125 x 125 + 125 = 15,750;
 *   - every other priced api: Anthropic's w x h / 750 = 2000 x 2000 / 750 = 5,334 (Claude direct and on Bedrock;
 *     Gemini's 768 px tiles at 258 each, 9 x 258 = 2,322, are below it).
 * The ceiling is the larger of the api's and the model FAMILY's (familyImageCeiling): a gateway serves one
 * family over another family's api (vercel-ai-gateway's gpt-4o-mini on anthropic-messages, Bedrock's Pixtral on
 * bedrock-converse-stream), and the family decides how its images are billed.
 * A model that declares a larger resize box scales the ceiling by the area ratio.
 */
export const IMAGE_TOKEN_CEILINGS = Object.freeze({
	"openai-completions": 48_169,
	"openai-responses": 48_169,
	"azure-openai-responses": 48_169,
	"openai-codex-responses": 48_169,
	"mistral-conversations": 15_750,
	default: 5_334,
});

/** The family ceiling a model id implies, by name: OpenAI's (48,169) or Mistral's (15,750), else 0. */
/** Any `gpt-` id (gpt-4o, gpt-4.1, gpt-5...), or an o-series id (`o1`, `o3-mini`, `openai/o4-mini`). */
const OPENAI_FAMILY = /gpt-|(?:^|[/:.])o\d/i;
const MISTRAL_FAMILY = /pixtral|mistral|ministral|magistral|devstral|codestral/i;
function familyImageCeiling(id) {
	if (typeof id !== "string") return 0;
	if (OPENAI_FAMILY.test(id)) return IMAGE_TOKEN_CEILINGS["openai-completions"];
	if (MISTRAL_FAMILY.test(id)) return IMAGE_TOKEN_CEILINGS["mistral-conversations"];
	return 0;
}

/**
 * Input tokens an image costs beyond its own bytes (PR #534's review). Providers bill an image by its PIXELS,
 * not by its base64 length: a 2000 x 2000 one-bit PNG is 756 bytes and about 1,590 Anthropic tokens. So each
 * image block in the request counts as the larger of its serialised bytes and a per-image ceiling: the larger of
 * its api's (IMAGE_TOKEN_CEILINGS) and its model family's, for pi's 2000 x 2000 resize box, scaled up for a model
 * that declares a larger box.
 * Limits, named in DES-DOLLAR-RESERVE-AND-SETTLE: an image an extension adds without pi's resize can be larger
 * than the box, and the ceilings are provider billing rules for the families catalogued today.
 */
function imageAllowance(model, context) {
	const resize = model?.inputLimits?.images?.resize;
	const width = Number.isFinite(resize?.maxWidth) && resize.maxWidth > 0 ? Math.max(resize.maxWidth, IMAGE_RESIZE_MAX.width) : IMAGE_RESIZE_MAX.width;
	const height = Number.isFinite(resize?.maxHeight) && resize.maxHeight > 0 ? Math.max(resize.maxHeight, IMAGE_RESIZE_MAX.height) : IMAGE_RESIZE_MAX.height;
	const perApi = Math.max(IMAGE_TOKEN_CEILINGS[model?.api] ?? IMAGE_TOKEN_CEILINGS.default, familyImageCeiling(model?.id));
	const ceiling = Math.ceil((perApi * width * height) / (IMAGE_RESIZE_MAX.width * IMAGE_RESIZE_MAX.height));
	let extra = 0;
	// Every occurrence counts, shared references included: JSON.stringify sends a block once per reference, and a
	// cycle has already made the context unboundable before this runs.
	const walk = (value) => {
		if (value === null || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) walk(item);
			return;
		}
		if (value.type === "image") {
			extra += Math.max(0, ceiling - Buffer.byteLength(JSON.stringify(value) ?? "", "utf8"));
			return;
		}
		for (const item of Object.values(value)) walk(item);
	};
	walk(context);
	return extra;
}

/** The synthetic Anthropic long-context tier of one table (user decision, issue #501). */
function longContextTier(table) {
	return { input: 2 * table.input, output: 1.5 * table.output, cacheRead: 2 * table.cacheRead, cacheWrite: 2 * table.cacheWrite };
}

/**
 * Whether a settled call had STARTED answering: its message holds any content block (text, thinking, a tool call,
 * an image), or an images result has output. Usage counts do not count, output included: anthropic-messages copies
 * message_start's `output_tokens` (Anthropic sends 1) into usage.output before an in-band `overloaded_error`, so a
 * call that never answered reports one output token.
 */
function started(message) {
	const blocks = (value) => Array.isArray(value) && value.length > 0;
	return blocks(message?.content) || blocks(message?.output);
}

/**
 * THE COST GUARD (issue #501; REQ-TOKEN-ACCOUNTING-AND-CAPS (d), DES-DOLLAR-RESERVE-AND-SETTLE). A guard for the
 * meter's seam: `{ enforces: [COST_CAP], admit, bind, snapshot }`.
 *
 * admit(call) refuses a call when `spent + inflight + bound > cap`, where `spent` is what settled calls cost and
 * `inflight` the bounds of calls admitted but not settled. The in-flight sum is what makes parallel calls safe:
 * two sessions calling at once are judged against each other's worst case, not against a total neither has
 * added to yet. `generateImages` and `streamDeferred` have no bound pi exposes, and neither has a call
 * callCostBound answers Infinity for: under a cap those are refused, logged `why: "unboundable"`. A refusal
 * counts `costRefused`, logs `cost_refused` with numbers only (never a model id, never task content), and
 * returns COST_CAP, which stops the job (the meter's one stop) and answers this call with the hard stop.
 *
 * bind(result) ties the admission just made to its settle. Single-slot by design: admit and the dispatch that
 * follows it are synchronous and adjacent in both wrappers, and the only re-entry (a virtual model's physical
 * call) is never admitted on the outer call. A slot still held at the next admit means the dispatch threw
 * synchronously; that call stays charged at its bound, because a throw after a request started is not proof
 * that nothing was sent.
 *
 * Settle: the bound leaves `inflight` and the call's real cost joins `spent`, as ceil(cost x 1e6). A cost above
 * the bound counts `boundExceeded` (the evidence the one-byte-per-token assumption broke). On the two Anthropic
 * apis, a model with no catalog tiers whose settled input + cache read + cache write passed 200k counts
 * `longContext`, and is charged at the synthetic tier (2 x the input-side costs, 1.5 x output) because pi priced
 * it at the base rates the provider does not bill; a dollar settlement treats such a job's cost as incomplete. A
 * call whose cost is unknown (no finite cost.total, or a rejected result) stays charged at its BOUND, and the meter
 * counts it unpriced; a call that ended `error` or `aborted` after it STARTED (any content block) is charged at
 * least its bound, because its usage is partial, and one that never started is charged its metered cost and counted
 * as `costUnanswered`; a successful call that reports no input at all is charged its bound. A charge is never below zero. `costUnjudged` counts the compat entries the
 * installer found displaced under the cap (calls there may have run unjudged and unmetered).
 */
export function createCostGuard({ capMicros, env = process.env, log = () => {}, bound = callCostBound }) {
	if (!Number.isSafeInteger(capMicros) || capMicros < 0) throw new Error(`invalid PI_MAX_COST_MICROS: ${capMicros}`);
	const state = { spent: 0, inflight: 0, refused: 0, boundExceeded: 0, longContext: 0, unjudged: 0, unanswered: 0 };
	let pending = null;

	function refuse(fields) {
		state.refused += 1;
		log("cost_refused", { ...fields, spent: state.spent, inflight: state.inflight, cap: capMicros });
		return COST_CAP;
	}

	function settle(ticket, message) {
		const usage = message?.usage;
		state.inflight -= ticket.bound;
		const price = usage?.cost?.total;
		if (typeof price !== "number" || !Number.isFinite(price)) {
			state.spent += ticket.bound;
			return;
		}
		// Never below zero: calculateCost's short-write term goes negative when a provider reports more 1h writes
		// than writes (PR #534's review), and a negative charge would hand the cap room nobody paid for.
		let charged = Math.max(0, Math.ceil(price * 1e6));
		// A FAILED or ABORTED call (PR #534's review). Its usage is partial: openai-completions and openai-responses
		// report usage only at the stream's end, anthropic-messages what message_start carried (the input and one
		// output token) until message_delta, so a stream cut after 2,000 output deltas settles at about 0, and pi then
		// auto-retries it. So a failed call that STARTED (the settled message holds any content block; usage counts
		// do not decide it, see started()) is charged at least its bound. One that never
		// started (a 429 or a 5xx before the stream, an in-band error before any content, a connection lost before the
		// answer) is charged its metered cost and counted as `costUnanswered`: charging it the bound would stop a
		// rate-limited job as cost-cap at $0 spent, and the counter tells a settlement the cost may be a floor, because
		// a provider that accepted the request and lost the answer may still bill it. One rule, every api.
		//
		// A SUCCESSFUL call that reports no input at all is broken usage reporting, and is charged its bound.
		const failed = message?.stopReason === "error" || message?.stopReason === "aborted";
		const noInput = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) === 0;
		if (failed && !started(message)) state.unanswered += 1;
		else if (failed || noInput) charged = Math.max(charged, ticket.bound);
		const catalogTiers = ticket.model?.cost?.tiers ?? [];
		const inputSide = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
		if (ANTHROPIC_PRICED_APIS.has(ticket.model?.api) && catalogTiers.length === 0 && inputSide > LONG_CONTEXT_TOKENS) {
			state.longContext += 1;
			const cost = usage.cost;
			const synthetic = 2 * ((cost.input ?? 0) + (cost.cacheRead ?? 0) + (cost.cacheWrite ?? 0)) + 1.5 * (cost.output ?? 0);
			if (Number.isFinite(synthetic)) charged = Math.max(charged, Math.ceil(synthetic * 1e6));
		}
		if (charged > ticket.bound) state.boundExceeded += 1;
		state.spent += charged;
	}

	/** A slot left by a dispatch that threw: its call stays charged at its bound. */
	function flushPending() {
		if (pending === null) return;
		const ticket = pending;
		pending = null;
		settle(ticket, null);
	}

	function admit({ method, model, args }) {
		flushPending();
		const [context, options] = args ?? [];
		const b = method === "generateImages" || method === "streamDeferred" ? Infinity : bound(method, model, context, options, env);
		if (!Number.isFinite(b)) return refuse({ why: "unboundable" });
		if (state.spent + state.inflight + b > capMicros) return refuse({ bound: b });
		state.inflight += b;
		pending = { bound: b, model };
		return null;
	}

	function bind(result) {
		const ticket = pending;
		pending = null;
		if (ticket === null) return;
		const done = (value) => settle(ticket, value);
		const failed = () => settle(ticket, null);
		if (typeof result?.result === "function") result.result().then(done, failed);
		else if (typeof result?.then === "function") result.then(done, failed);
		else failed();
	}

	/** The exit line's cost fields, present only when a cap is set (run-job spreads them into `tokens`). */
	function snapshot() {
		flushPending();
		return { costCapMicros: capMicros, costRefused: state.refused, boundExceeded: state.boundExceeded, longContext: state.longContext, costUnjudged: state.unjudged, costUnanswered: state.unanswered };
	}

	/** The installer's report of compat entries found displaced under the cap: calls there may have run unjudged. */
	function unjudged(count) {
		state.unjudged += count;
	}

	return { enforces: Object.freeze([COST_CAP]), admit, bind, snapshot, unjudged, state };
}
