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
 * The cap here is still structurally LAGGING for the same reason token-budget.mjs's is: usage is known
 * only after a call completes. The hard stop is a runaway backstop, not a before-the-spend cap.
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
				// accounting hook into an unhandled rejection that kills the container.
				state.unresolved -= 1;
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
 *      braked. The guard is consulted only while a brake exists, because a refusal with no hard stop to
 *      answer with would have to dispatch the call it just refused; the runner refuses before the first
 *      prompt when a policy is set and the brake is missing (assertPoliciesEnforceable). No guard exists in
 *      this build (null), so every call goes through exactly as before.
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
	// Steps 1 and 3 above, shared by every method: the stop reason that ends this call, or null to dispatch it.
	const stopFor = (method, model, args) => {
		if (!hardStop) return null;
		if (meter.state.stopReason !== null) return meter.state.stopReason;
		if (guard === null || model?.api === VIRTUAL_MODEL_API) return null;
		const refused = guard.admit({ method, model, args });
		if (refused === null || refused === undefined) return null;
		meter.stop(refused);
		return meter.state.stopReason;
	};

	for (const name of RUNTIME_STREAM_METHODS) {
		const original = proto?.[name];
		if (typeof original !== "function") continue;
		const wrapper = function (model, ...rest) {
			if (!active) return original.call(this, model, ...rest);
			const stopped = stopFor(name, model, rest);
			if (stopped !== null) return hardStop(model, STOP_MESSAGES[stopped]);
			// Trap #5: everything this call dispatches, across its awaits, runs marked as ours.
			const stream = dispatch.run(true, () => original.call(this, model, ...rest));
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
			const stopped = stopFor(name, model, [context, options]);
			if (stopped !== null) return Promise.resolve(hardStopResult(name, model, STOP_MESSAGES[stopped]));
			const promise = dispatch.run(true, () => original.call(this, model, context, options));
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
		if (hardStop && meter.state.stopReason !== null) return hardStop(model, STOP_MESSAGES[meter.state.stopReason]);
		if (hardStop && guard !== null && dispatch?.getStore() !== true) {
			const refused = guard.admit({ method: kind, model, args: [context, options] });
			if (refused !== null && refused !== undefined) {
				meter.stop(refused);
				return hardStop(model, STOP_MESSAGES[meter.state.stopReason]);
			}
		}
		const provider = fallbackModels?.getProvider?.(model.provider);
		const builtin = provider?.getModels?.().some((candidate) => candidate.api === model.api) ? provider : null;
		const stream = builtin
			? model.provider.startsWith("cloudflare-")
				? fallbackModels[kind](model, context, options)
				: builtin[kind](model, context, options)
			: inner[kind](model, context, options);
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
			if (armedApis.has(api)) handle.rearms += 1;
			else armedApis.add(api);
		}
		handle.apis = [...armedApis].sort();
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
 *     refuse for: COST_CAP for the cap, MODEL_NOT_ALLOWED for the list). No guard ships in this build, so
 *     every cap or list refuses.
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
