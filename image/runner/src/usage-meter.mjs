// env-internal PI_SUBSCRIPTION_AUTH: host-approved access snapshot metadata, never an operator override.
import { installSubscriptionRegistrationGuard, validateSubscriptionRequest, verifySubscriptionAuthEntries } from "./community-auth-adapter.mjs";
import { installSubscriptionCredentials, subscriptionAccess, subscriptionRequestOverrides } from "./subscription-credentials.mjs";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { types as utilTypes } from "node:util";
import { basename, dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPidNamespace, runnerIdentity } from "./child-route.mjs";
import { parseAllowedModels, parseCostMicros } from "./config.mjs";
import { configError, COST_CAP, COST_CAP_UNENFORCEABLE, COST_REFUSAL_NUMBERS, COST_REFUSALS, MODEL_NOT_ALLOWED, MODEL_POLICY_UNENFORCEABLE, SUBSCRIPTION_ALLOWANCE, TOKEN_BUDGET } from "./outcome.mjs";

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
 * `modelRuntime.streamSimple` (cache-warmer.js:239; at 1.5.2 line 183, with pi-ai's getCacheWarmingRequestOptions), and the ModelRegistry facade an extension sees as
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
 * 1. A BARE pi-ai SPECIFIER IS NOT ASSUMED TO BE THE COPY pi USES. Up to pi 0.99.1, where the WORKER's deps
 *    were installed too (a dev checkout, the contract-tests job), pi-ai was on disk TWICE, with separate
 *    module-level registries: the hoisted one (the WORKER's dependency) and the one nested under
 *    pi-coding-agent by its shrinkwrap, which pi used. pi 1.0.1 dropped the shrinkwrap and the root `overrides`
 *    now pin every pi package to one version, so at the 1.0.3 pin there is one copy; but a layout is a fact
 *    about one install, not a guarantee (issue #587). Hence: no static pi import anywhere in this file. The ModelRuntime CLASS is injected by run-job.mjs, which
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
 *    dedupe them. So each runtime call carries a TOKEN of its own (issue #543): an AsyncLocalStorage shared by
 *    the two halves of one install holds it across the lazyStream setup's awaits, and the call's options carry
 *    it under DISPATCH_MARK (pi spreads the options into the provider's, so the mark reaches the composer's
 *    registry call). The first compat call whose options carry the context's unused token on the SAME (provider,
 *    model) pair is the runtime call's own dispatch (pi's composer), already judged and counted, so the compat
 *    wrapper skips it, once (measured by usage-meter.fidelity.test.mjs: counted once). A token-carrying call on
 *    ANOTHER pair (a provider forwarding to pi-ai's legacy streamSimple with the options spread) is a full call,
 *    judged, prepared, bounded and counted on its own model, and the runtime call stays bound and counted as well:
 *    nothing proves the runtime call's answer is the forward's (a fallback provider answers itself after a failed
 *    forward), so a passthrough proxy is counted for both calls, the safe side. Every other legacy call in that context -- one an
 *    extension makes from a before_provider_request hook or an onPayload, or from a timer or a promise
 *    scheduled there -- is judged and counted like a call from outside. Before the token, the context alone
 *    decided, and such a call was judged and counted by neither half.
 *
 * The TOKEN cap here is still structurally LAGGING for the same reason token-budget.mjs's is: usage is known
 * only after a call completes, so its hard stop is a runaway backstop, not a before-the-spend cap. The COST cap
 * (issue #501) is the opposite shape: the cost guard at the bottom of this file judges each call's worst case
 * BEFORE it is sent, through the same seam and the same hard stop.
 */

/** Where a runtime call's options carry its dispatch token (trap #5 above): a symbol, so it is never serialised. */
export const DISPATCH_MARK = Symbol("pi-dispatch.usage-meter.dispatch");

/**
 * A runtime call's dispatch token: the model it dispatches, whether its one compat re-entry has been seen, and whether
 * it FORWARDED (issue #571): another model call was dispatched under it (a router or proxy provider calling an
 * upstream, through either half). A forwarded call's own zero usage is the router's, not a lost count, so the meter
 * does not count it `costUnreported`; the upstream call is metered on its own.
 */
export function dispatchToken(model) {
	return { provider: model?.provider, id: model?.id, api: model?.api, used: false, forwarded: false };
}

/** Mark the dispatch the current context runs under as forwarded (dispatchToken), when there is one. */
function markForwarded(dispatch) {
	const outer = dispatch?.getStore?.();
	if (outer !== undefined && outer !== null && typeof outer === "object") outer.forwarded = true;
}

/** The call's arguments with its options (the second argument after the model, in all three stream methods) marked. */
function markOptions(args, token) {
	const marked = [...args];
	marked[1] = { ...(marked[1] ?? {}), [DISPATCH_MARK]: token };
	return marked;
}

/**
 * Whether a compat call is the runtime call's own re-entry (trap #5): its options carry the UNUSED token of the
 * context it runs in, on the same (provider, model) pair and the same api. That is pi's composer dispatching the runtime call itself,
 * which the runtime half judged and counts, so it is skipped; the claim uses the token up, so it answers true once.
 * A token-carrying call on ANOTHER pair (an extension provider forwarding to pi-ai's legacy streamSimple with the
 * options spread) is NOT a re-entry: it is a full call, judged, prepared, bounded and counted on its own model, and
 * the runtime call stays bound and counted too. Nothing here can tell that the runtime call's answer is the
 * forward's (a fallback provider answers itself after a failed forward), so a passthrough proxy is counted for both
 * calls: the safe side (PR #547's final review).
 */
function claimReentry(token, model, options) {
	if (token === undefined || token === null || token.used || options?.[DISPATCH_MARK] !== token) return false;
	// The exact (provider, id, api) the runtime call dispatched: a call on the same pair through ANOTHER api (a provider's
	// own legacy call) is not the composer's re-entry, and is judged and counted like any other.
	if (model?.provider !== token.provider || model?.id !== token.id || model?.api !== token.api) return false;
	token.used = true;
	return true;
}

/**
 * Run an admitted call's dispatch, and when it THROWS synchronously, bind `undefined` before rethrowing (issue #571):
 * the guard then settles that call's slot at its bound and counts it `costUnanswered`, rather than a later admit
 * flushing it uncounted. The throw itself is not swallowed: a throw in here is still a provider's or our bug to see.
 */
function dispatchBinding(guard, verdict, run) {
	try {
		return run();
	} catch (error) {
		if (verdict === ADMITTED) guard.bind?.(undefined);
		throw error;
	}
}

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
	// Issue #1008: the job's list-price allowance for subscription calls is used up (createAllowanceGuard).
	[SUBSCRIPTION_ALLOWANCE]: "pi-dispatch: subscription allowance reached",
});

/**
 * Coerce a possibly-absent numeric usage field. Never propagates NaN into the totals, and never a negative (issue
 * #500): an extension's provider may report one, and a negative amount would make the totals fall, which a child
 * ledger's fold reads as a shrink and counts the child unmetered. pi-ai's own providers already clamp at 0.
 */
function finite(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Named-row cap for the exit line's `usage` ledger (INT-RUN-HISTORY-FILE-CONTRACT). Sized against the
 * worker's recovery path, not against taste: the run record is rebuilt from a bounded 8 KiB tail of
 * container stdout (worker/src/run-history.mjs, TAIL_CAP_BYTES), and an exit line the tail truncates
 * loses ALL token accounting at once -- tokens, turns and ledger together, not merely the rows that
 * pushed it over. Eight worst-case named rows keep a completed run's line, with no `message`, `context` or `loaded`, under
 * ~5 KB, which usage-meter.test.mjs asserts against a maximal fixture; a line carrying those too is held to the writer's own
 * limit (exit-line.mjs `EXIT_LINE_MAX_BYTES`). If that line ever grows, shrink THIS cap -- never the test's budget.
 */
const MAX_NAMED_ROWS = 8;

/**
 * The eleven numerics a ledger row accumulates, zeroed. One shape for named rows and the fold bucket.
 *
 * `providerBilled` counts the calls whose `cost` is the provider's own billed total rather than pi's rate-card
 * estimate (pi-ai 1.5.0's `usage.cost.totalFromProvider`, OpenRouter today, with a BYOK key's upstream cost included).
 * A count and not a flag, because a row aggregates many calls and a folded one aggregates many models.
 */
function emptyRow() {
	return { calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 0, cost: 0, unpriced: 0, providerBilled: 0 };
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
	into.providerBilled += row.providerBilled;
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
 *
 * `onChange()` (issue #500) fires after every change a child ledger must carry: when a call is observed (so
 * `calls` and `unresolved` rise before the provider answers, and a child killed mid-call leaves `unresolved`
 * behind), when it settles, and when the meter stops (a guard refusal raises a ledger counter). It never fires on
 * setChildren(): the parent folds on its own tick. A throw from
 * it is swallowed: it is the caller's I/O (a ledger write), and a failed write must not fail a provider call.
 *
 * `setChildren(fold)` (issue #500) hands the meter the children's totals (foldChildLedgers). From then on the
 * snapshot's totals include the children, `rootTotal`, `otherTotal` and `looseTotal` stay the parent's own,
 * and the new `childTotal` closes the partition: root + other + loose + child === total. The token cap is
 * checked against parent plus children, on every record and on every fold.
 *
 * `notionalProviders` (issue #1008) is the job's set of NOTIONAL providers (notionalProviders below: subscription calls
 * with no paid extra usage), or null when the job holds no subscription entry. Each priced call on one of them still
 * lands in `cost` and on its row at list price, and is also summed into `costNotional`, so the worker can settle the
 * dollar windows to the billed part, `cost - costNotional`. The snapshot carries `costNotional` only when the set is
 * given, so every other exit line is byte-identical. It is the very set the cost guard admits without a charge, never a
 * second reading of the entries: a call counted here and charged there would be subtracted from a cost the cap bounded.
 */
export function createUsageMeter({ maxTokens, maxCostMicros = null, allowedModels = null, rootSessionId, onStop, onChange = null, notionalProviders = null } = {}) {
	if (maxTokens !== null && maxTokens !== undefined && (!Number.isInteger(maxTokens) || maxTokens < 1)) {
		throw new Error(`invalid PI_MAX_TOKENS: ${maxTokens}`);
	}
	if (maxCostMicros !== null && (!Number.isSafeInteger(maxCostMicros) || maxCostMicros < 0)) {
		throw new Error(`invalid PI_MAX_COST_MICROS: ${maxCostMicros}`);
	}
	if (allowedModels !== null && (!Array.isArray(allowedModels) || allowedModels.length === 0)) {
		throw new Error("invalid PI_ALLOWED_MODELS: want a non-empty list or null");
	}
	if (notionalProviders !== null && !(notionalProviders instanceof Set)) throw new Error("createUsageMeter: notionalProviders must be a Set or null");
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
		// Calls on a priced model whose answer carried broken usage (issue #571, unreportedUsage): pi recorded them as
		// zeros or a partial count, so `cost` is short. Counted on every run, capped or not; a forward's outer call is not.
		unreported: 0,
		// The part of `cost` priced on notional providers (issue #1008, notionalProviders in the header). Part of `cost`,
		// never beside it: the totals and the rows stay a partition of every call.
		costNotional: 0,
		// Notional calls whose cost could not be read (issue #1008): no cost block, or a total that is not a finite number
		// at or above 0 (a rejected result included). `costNotional` lacks their price, so notionalMicros() reads as
		// unbounded once there is one, and the subscription allowance fails closed rather than judge a total it knows is short.
		notionalUnread: 0,
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
		// A stop is a change a child ledger carries (issue #500): every guard refusal stops the meter, so this is also
		// where a raised costRefused or modelRefused reaches the ledger at once, not at the next call.
		changed();
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
	// Issue #1098: the notional part of each row's cost, by the row's key ("" for the bucket): what a CHILD's ledger rows
	// mark as let through by its own subscription admission (rows() below). Kept apart from the rows themselves, so the
	// exit line's `usage` rows, which the worker reads by a closed key list, never carry it.
	const notionalByKey = new Map();
	// Where a call lands when its ctx names no model: kept OFF the map, so a provider literally named
	// "other" can never merge into it. Same honesty rule as `unpriced` above -- a model-less call is
	// COUNTED here, never guessed onto whichever model a heuristic liked.
	const other = emptyRow();
	// The version of the pi-ai copy the meter priced with, stamped by installProcessUsageMeter once
	// it accepts a compat copy. Pricing PROVENANCE for the run record: history is priced once,
	// and a later pin bump must show as a different stamp on new records, not a silent repricing of
	// old ones. null = unknown, and the exit line says so rather than inventing one.
	let piAiVersion = null;
	// The children's fold (setChildren), or null until the first one. null keeps the exit line exactly as it was
	// before issue #500: the three child keys appear only once a fold was handed over.
	let children = null;

	/** The caller's change hook, never allowed to throw into a provider call or a settle (see the header). */
	function changed() {
		if (onChange === null) return;
		try {
			onChange();
		} catch {
			// The hook owns its failures (a child ledger that is not rewritten reads as stale, then as unmetered).
		}
	}

	/** Parent plus children, the number the token cap is judged on. */
	const combinedTotal = () => state.total + (children?.total ?? 0);

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

		const given = u.cost?.total;
		const priced = typeof given === "number" && Number.isFinite(given);
		// Priced at 0 when negative, never unpriced: the call did report a price (see finite()).
		const price = priced ? Math.max(0, given) : 0;
		if (priced) state.cost += price;
		else state.unpriced += 1;
		// Issue #1008: added in the same order as `cost`, so with every price at or above 0 the sum can never exceed it. A
		// notional call whose cost cannot be read (absent, not finite, or negative, which `cost` takes as 0) is counted
		// apart (`notionalUnread`), so the allowance never judges a notional total that is missing a price.
		if (notionalProviders !== null && notionalProviders.has(ctx.provider)) {
			if (priced) state.costNotional += price;
			if (!priced || given < 0) state.notionalUnread += 1;
		}

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
		if (priced && notionalProviders !== null && notionalProviders.has(ctx.provider)) {
			const mark = row === other ? "" : `${provider}\u0000${modelId}`;
			notionalByKey.set(mark, (notionalByKey.get(mark) ?? 0) + price);
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
			providerBilled: priced && u.cost.totalFromProvider === true ? 1 : 0,
		});

		if (cap !== null && combinedTotal() > cap) stop(TOKEN_BUDGET, combinedTotal());
		// Accumulation continues past the breach on purpose: the overshoot is the interesting number
		// (it is what the lag actually cost), and hiding it would make the cap look tighter than it is.
		changed();
		return state;
	}

	/**
	 * Count `costUnreported` (issue #571) for a settled answer, BEFORE record() writes the change, so a child ledger
	 * written on the settle carries it. Only for a call whose `ctx.model` is priced (pricedModel), and never for a call
	 * that forwarded (`ctx.forwarded()` true: under its dispatch another model call went out, which is metered on its
	 * own, so the outer call's zeros are a router's, not a lost count). A ctx with no model (a caller outside the two
	 * wrappers) is never counted.
	 */
	function judgeUsage(message, ctx) {
		if (ctx.model === undefined || !pricedModel(ctx.model)) return;
		if (typeof ctx.forwarded === "function" && ctx.forwarded()) return;
		if (unreportedUsage(message, ctx.model?.api)) state.unreported += 1;
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
		if (!stream) return stream;
		// A PROMISE of a stream (issue #571): pi-ai's legacy `streamSimple`/`stream` (compat.js) return a registry
		// entry's answer as it is, so an extension's entry that answers with `Promise<stream>` reaches its caller as a
		// promise, and a caller that awaits it (a router forwarding to it) gets a working stream. pi's own paths never
		// hand one on: ModelRuntime and the provider composer wrap every provider call in lazyStream, which awaits it.
		// Counted at once, settled from the resolved stream's result(); a rejection, or a value with no result(), is a
		// call with no usage, `unpriced`, as a rejected result() is.
		if (typeof stream.result !== "function") return typeof stream.then === "function" ? observePending(stream, ctx) : stream;
		if (observed.has(stream)) return stream;
		observed.add(stream);
		state.calls += 1;
		state.unresolved += 1;
		changed();
		stream.result().then(
			(message) => {
				state.unresolved -= 1;
				judgeUsage(message, ctx);
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
	 * Mark a stream as accounted for WITHOUT counting it (issue #985): the placeholder a deferred call answers with
	 * (makeDeferredStream). The call itself is counted once, on the stream its retry dispatches; the placeholder only
	 * carries that stream's events, so an observe() that meets it later (a second layer in the chain, or a promise of a
	 * stream resolving to it, observePending) must not count it as a second call.
	 */
	function adopt(stream) {
		if (stream !== null && typeof stream === "object") observed.add(stream);
		return stream;
	}

	/** observe() for a promise of a stream (see there): the call counts now and settles from the stream it resolves to. */
	function observePending(promise, ctx) {
		if (observed.has(promise)) return promise;
		observed.add(promise);
		state.calls += 1;
		state.unresolved += 1;
		changed();
		promise
			.then((resolved) => {
				if (typeof resolved?.result !== "function") return { message: undefined };
				// A stream already observed (an async entry that forwards and resolves to the forward's own stream, which
				// this meter counted when it was dispatched): its usage is that call's. This call settles as a priced zero,
				// and is not judged for broken usage either, so the spend is counted once.
				if (observed.has(resolved)) return { counted: true };
				observed.add(resolved);
				return resolved.result().then((message) => ({ message }));
			})
			.then(
				({ message, counted }) => {
					state.unresolved -= 1;
					if (counted) {
						record(zeroUsage(), ctx);
						return;
					}
					judgeUsage(message, ctx);
					record(message?.usage, ctx);
				},
				() => {
					state.unresolved -= 1;
					record(undefined, ctx);
				},
			);
		return promise;
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
		changed();
		promise.then(
			(result) => {
				state.unresolved -= 1;
				judgeUsage(result, ctx);
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
		const child = children ?? { input: 0, output: 0, total: 0, cost: 0, calls: 0, unresolved: 0, unpriced: 0, sessions: 0 };
		return {
			input: state.input + child.input,
			output: state.output + child.output,
			total: state.total + child.total,
			cost: state.cost + child.cost,
			metered: true,
			// The parent's own split. With children, childTotal below is the fourth part of the partition.
			rootTotal: state.rootTotal,
			otherTotal: state.otherTotal,
			looseTotal: state.looseTotal,
			sessions: state.sessionIds.size + child.sessions,
			calls: state.calls + child.calls,
			unresolved: state.unresolved + child.unresolved,
			unpriced: state.unpriced + child.unpriced,
			...(children === null ? {} : { childTotal: children.total, childProcesses: children.processes, unmeteredChildren: children.unmetered }),
			// Issue #571: on every metered line, the children's included (their ledgers carry it).
			costUnreported: state.unreported + (children?.unreported ?? 0),
			// Issue #1008: only for a job with subscription entries. Issue #1098: a pi child holds a subscription admission of
			// its own, so the children's rows on this job's notional providers are notional here too (childNotional).
			...(notionalProviders === null ? {} : { costNotional: state.costNotional + childNotional() }),
		};
	}

	/**
	 * The settled list price of this process's notional calls (issue #1008, `costNotional`) in integer micro-dollars,
	 * rounded UP, so an allowance judged against it is reached no later than the dollars say. Settled only: a call in
	 * flight adds nothing until its answer is metered. 0 for a job with no subscription entries. Infinity once any notional
	 * call's cost could not be read (`notionalUnread`): the total is then known to be short, and Infinity is the reading
	 * every comparison with a limit fails closed on. An accessor, not part of snapshot(), so the subscription allowance
	 * (createAllowanceGuard) and anything else that judges the notional part read the one number the exit line's
	 * `costNotional` is made of (that key stays the sum of the prices that were read).
	 */
	function notionalMicros() {
		return state.notionalUnread > 0 ? Infinity : Math.ceil((state.costNotional + childNotional()) * 1e6);
	}

	/**
	 * Issue #1098: the children's notional part, as the last fold counted it (foldChildLedgers `notionalCost`): the cost
	 * each child's ledger marked as let through by its own subscription admission, on a provider of this job's notional
	 * set. 0 without a notional set or a fold. A high-water mark, so it only grows.
	 */
	function childNotional() {
		if (notionalProviders === null || children === null) return 0;
		return children.notional ?? 0;
	}

	/**
	 * Hand over the children's totals (issue #500): a foldChildLedgers result, cumulative. Two rules keep a bad fold
	 * from ever reading as less spend:
	 *   - SATURATE, never zero. A number the meter cannot carry (not a number, negative, not finite, or above
	 *     Number.MAX_SAFE_INTEGER) is taken as MAX_SAFE_INTEGER: "too much to count" must read as a lot, never as
	 *     nothing, or two forged ledgers whose sum overflows would erase a real child's spend.
	 *   - A HIGH-WATER MARK per field. Every total but `unresolved` is the larger of the last one and this one, and so
	 *     is every row field by pair, so a fold that lost its `prev` (a caught throw, a bug) cannot forget spend.
	 *     `unresolved` follows the fold: a call that settled is no longer in flight. So does `unmetered`, which the
	 *     children hook keeps itself (it may un-count a child that was slow to start).
	 * The token cap is judged on parent plus children here too, because a child's spend reaches the parent only
	 * through this call.
	 */
	function setChildren(fold) {
		const carry = (value) => (typeof value === "number" && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : Number.MAX_SAFE_INTEGER);
		const totals = fold?.totals ?? {};
		const held = children;
		const high = (key, value) => Math.max(held?.[key] ?? 0, carry(value));
		const rows = new Map((held?.rows ?? []).map((row) => [rowKey(row), { ...row }]));
		for (const given of Array.isArray(fold?.rows) ? fold.rows : []) {
			const named = typeof given?.provider === "string" && typeof given?.model === "string";
			const row = { provider: named ? given.provider : null, model: named ? given.model : null };
			const into = rows.get(rowKey(row)) ?? { ...row, ...emptyRow() };
			for (const key of Object.keys(emptyRow())) into[key] = Math.max(into[key], carry(given[key]));
			rows.set(rowKey(row), into);
		}
		children = {
			input: high("input", totals.input),
			output: high("output", totals.output),
			total: high("total", totals.total),
			cost: high("cost", totals.cost),
			calls: high("calls", totals.calls),
			unresolved: carry(totals.unresolved),
			unpriced: high("unpriced", totals.unpriced),
			sessions: high("sessions", totals.sessions),
			processes: high("processes", fold?.processes),
			// Not a high-water mark (issue #500 part E's review): the hook's count only grows, except for a child it held
			// `starting` too long and then saw install its meter, which it un-counts.
			unmetered: carry(fold?.unmetered ?? 0),
			// Issue #571: the children's broken-usage calls, a high-water mark like the totals.
			unreported: high("unreported", fold?.costUnreported ?? 0),
			// Issue #1098: the children's notional cost the fold counted (marked rows on the job's own notional set).
			notional: high("notional", fold?.notionalCost ?? 0),
			rows: [...rows.values()],
		};
		if (cap !== null && combinedTotal() > cap) stop(TOKEN_BUDGET, combinedTotal());
	}

	/**
	 * The meter's own rows for a child ledger (issue #500): named rows in FIRST-SEEN order, then at most one
	 * model-less row with `provider` and `model` null. First-seen, not top-by-total, so a row once written stays
	 * named and only grows; a sorted cut could move a row into the bucket, and the parent's fold would read that
	 * as a shrink. Capped at CHILD_LEDGER_ROWS rows: the named rows past CHILD_LEDGER_ROWS - 1, and any row whose
	 * id the worker's pattern refuses (USAGE_ID_PATTERN, after lowercasing as the worker does), fold into the
	 * model-less row, so the file the parent reads is never refused for a row the child could have kept honest.
	 * The rows partition the meter's settled totals, as usageSnapshot's do. Copies: the caller cannot reach state.
	 */
	function rows() {
		const kept = [];
		const bucket = { ...other };
		// Issue #1098: each row's notional mark (notionalByKey), the folded rows' marks into the bucket's, written only when
		// above 0: a mark lands only on a provider of the child's own admitted set, so on at most the model list's 16 models,
		// and the rows of every other call keep the size they had.
		const mark = (value) => (value > 0 ? { notional: value } : {});
		let bucketNotional = notionalByKey.get("") ?? 0;
		for (const [key, row] of byModel) {
			const recordable = recordableId(row.provider) && recordableId(row.model);
			if (recordable && kept.length < CHILD_LEDGER_ROWS - 1) kept.push({ ...row, ...mark(notionalByKey.get(key) ?? 0) });
			else {
				foldRow(bucket, row);
				bucketNotional += notionalByKey.get(key) ?? 0;
			}
		}
		if (bucket.calls > 0) kept.push({ provider: null, model: null, ...bucket, ...mark(bucketNotional) });
		return kept;
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
		if (state.calls + (children?.calls ?? 0) === 0) return null;
		// The children's rows (issue #500) merge BEFORE the cut, onto the parent's row for the same pair or a row of
		// their own, and a model-less child row into the bucket, so the 8-row cut ranks the job's whole spend and the
		// emitted rows still sum to the snapshot's total. Merged on copies: live state is never touched.
		const merged = new Map([...byModel].map(([key, row]) => [key, { ...row }]));
		const overflow = { ...other };
		for (const row of children?.rows ?? []) {
			if (row.provider === null || row.model === null) {
				foldRow(overflow, row);
				continue;
			}
			const key = `${row.provider}\u0000${row.model}`;
			let into = merged.get(key);
			if (!into) {
				into = { provider: row.provider, model: row.model, ...emptyRow() };
				merged.set(key, into);
			}
			foldRow(into, row);
		}
		const named = [...merged.values()].sort((a, b) => b.total - a.total);
		const folded = named.slice(MAX_NAMED_ROWS);
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

	return { state, cap, costCap, allowed, stop, record, observe, adopt, observeResult, snapshot, usageSnapshot, setPiAiVersion, rows, setChildren, notionalMicros };
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
 * The copy of the model a call was made on that the guard judges AND pi is handed (issue #502, PR #538's review; made a
 * data-only deep copy in issue #587's review). pi reads the nested objects (the sampling layers, compat with its
 * fallbacks and maxTokensField, cost with its tiers) after an await, so anything handed over by reference could change
 * between the verdict and the request. THE RULE: every field is copied as plain own data, at any depth (dataCopy):
 * plain objects (prototype Object.prototype or null), arrays, primitives and typed arrays (copied). Anything else, a
 * class instance, a Proxy, an accessor, a property hidden from Object.keys, a symbol key, a function or a symbol where
 * data is expected, makes the copy UNREADABLE (isUnreadable), and both guards refuse it: no field is ever kept by
 * reference. The two sampling fields are copied into null-prototype objects, so a level pi reads by property access
 * (`byLevel?.[level]`) cannot come from Object.prototype either.
 */
function snapshotModel(model) {
	if (model === null || typeof model !== "object") return model;
	try {
		return ownDataObject(model, (key, value) => dataCopy(value, key === "samplingParamsByThinkingLevel" ? 2 : key === "samplingParams" ? 1 : 0), false);
	} catch (error) {
		if (error !== NOT_DATA) throw error;
		const copy = { ...model };
		UNREADABLE_COPIES.add(copy);
		return copy;
	}
}

/**
 * The call's options, copied for the same reason: one read of each own field, and a data-only deep copy of the two pi
 * reads after an await and the guards judge, `samplingParams` and `env` (the per-call deployment map,
 * PI_CACHE_RETENTION). Anything else is handed over as given (a signal, the caller's onPayload). Either of the two that
 * is not plain data makes the options UNREADABLE.
 */
function snapshotOptions(options) {
	if (options === null || typeof options !== "object") return options;
	const copy = { ...options };
	try {
		if (Object.hasOwn(copy, "samplingParams")) copy.samplingParams = dataCopy(copy.samplingParams, 1);
		if (Object.hasOwn(copy, "env")) copy.env = dataCopy(copy.env, 0);
	} catch (error) {
		if (error !== NOT_DATA) throw error;
		UNREADABLE_COPIES.add(copy);
	}
	return copy;
}

/** A call's arguments with its options (the LAST argument on every wrapped method) copied by snapshotOptions. */
function snapshotArgs(args) {
	if (!Array.isArray(args) || args.length === 0) return args;
	return [...args.slice(0, -1), snapshotOptions(args.at(-1))];
}

/** The copies (snapshotModel, snapshotOptions) that held something other than plain data: both guards refuse them. */
const UNREADABLE_COPIES = new WeakSet();
export function isUnreadable(value) {
	return value !== null && typeof value === "object" && UNREADABLE_COPIES.has(value);
}

/** Thrown inside dataCopy for a value that is not plain data; never escapes snapshotModel and snapshotOptions. */
const NOT_DATA = Symbol("not plain data");
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;
const DATA_COPY_DEPTH = 64;

/**
 * A deep copy of plain data, or a throw of NOT_DATA (snapshotModel has the rule). Each property is read ONCE, from its
 * descriptor, so a Proxy's traps or a getter are never consulted twice; a Proxy is refused outright (util.types.isProxy).
 * `nullDepth` levels of plain objects from the top are copied with a null prototype (the sampling fields).
 */
function dataCopy(value, nullDepth = 0, depth = 0) {
	if (value === null || value === undefined) return value;
	const type = typeof value;
	if (type === "string" || type === "number" || type === "boolean" || type === "bigint") return value;
	if (type !== "object" || depth > DATA_COPY_DEPTH || utilTypes.isProxy(value)) throw NOT_DATA;
	if (ArrayBuffer.isView(value)) {
		if (value instanceof DataView) throw NOT_DATA;
		return value.slice();
	}
	if (Array.isArray(value)) {
		if (Object.getPrototypeOf(value) !== Array.prototype) throw NOT_DATA;
		const out = [];
		for (const key of Reflect.ownKeys(value)) {
			const descriptor = Object.getOwnPropertyDescriptor(value, key);
			if (key === "length") {
				out.length = descriptor.value;
				continue;
			}
			if (typeof key !== "string" || !ARRAY_INDEX.test(key) || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw NOT_DATA;
			out[Number(key)] = dataCopy(descriptor.value, 0, depth + 1);
		}
		return out;
	}
	return ownDataObject(value, (_key, inner) => dataCopy(inner, Math.max(0, nullDepth - 1), depth + 1), nullDepth > 0);
}

/** A plain object's own data, each value through `copyValue(key, value)`, or a throw of NOT_DATA. */
function ownDataObject(value, copyValue, nullProto) {
	if (utilTypes.isProxy(value)) throw NOT_DATA;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) throw NOT_DATA;
	const out = nullProto ? Object.create(null) : {};
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (typeof key !== "string" || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw NOT_DATA;
		out[key] = copyValue(key, descriptor.value);
	}
	return out;
}

/**
 * Whether `value` is a plain object of own data: its prototype is Object.prototype or null, and every own key is a
 * string naming an enumerable data property (no getter, nothing hidden from Object.keys). pi reads a level by property
 * access (`byLevel?.[level]`), so an inherited, non-enumerable or accessor level reaches the request while Object.values
 * never sees it (issue #587's review measured `Object.create({ off: { model } })` on the wire, unrefused). The copies
 * pi is handed always pass it; a caller's own object judged without a copy is held to it here.
 */
function isOwnData(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	for (const key of Reflect.ownKeys(value)) {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (typeof key !== "string" || !descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return false;
	}
	return true;
}

/**
 * THE PRICE TABLE (issue #587's review). The cost guard's bound and pi's own settlement both read the model object the
 * CALLER passes, so a caller's `{ ...model, cost: zeros }` would run under a cap at $0, and a live registry can be
 * poisoned mid-run (registerProvider over a builtin id, a rewritten models.json and any refresh, a modelOverrides
 * entry, an extension's own ModelRuntime). So one table is pinned ONCE, from the job's runtime, when the meter installs,
 * which is before any extension loads: the builtin catalog plus the operator's overlay as it was loaded at start.
 * `(provider, id, api)` to `{ api, cost, compat }`, each copied as plain data. Every capped call on every runtime
 * instance, and every legacy call, is held to it (pricedAsPinned). null means no table: the call is judged on its own
 * object (only a caller that wires the meter without one, such as a unit test).
 */
export function pinPriceTable(runtime) {
	if (typeof runtime?.getAllModels !== "function") return null;
	const table = new Map();
	let models;
	try {
		models = runtime.getAllModels();
	} catch {
		return table;
	}
	for (const model of Array.isArray(models) ? models : []) {
		try {
			if (typeof model?.provider !== "string" || typeof model?.id !== "string" || typeof model?.api !== "string") continue;
			table.set(priceKey(model), { api: model.api, cost: dataCopy(model.cost), compat: dataCopy(model.compat) });
		} catch (error) {
			if (error !== NOT_DATA) throw error;
			// A model whose price is not plain data is left out: a capped call on it is refused.
		}
	}
	return table;
}

/** One spelling of a table key: NUL cannot appear in a provider id, a model id or an api id. */
function priceKey(model) {
	return `${model?.provider}\u0000${model?.id}\u0000${model?.api}`;
}

/** The pinned entry for a call's model, null when the table has none, undefined when there is no table. */
function priceEntry(prices, model) {
	if (!(prices instanceof Map)) return undefined;
	return prices.get(priceKey(model)) ?? null;
}

/** The verdict for a call the guard judged and let through: dispatch it, and bind it to its settle. */
const ADMITTED = Symbol("admitted");
/**
 * The verdict for a call the guard told to WAIT (issue #985, COST_WAIT): nothing is stopped and nothing is dispatched;
 * the wrapper answers with a placeholder (makeDeferredStream) and queues the call to be judged again (waitTurn).
 */
const DEFERRED = Symbol("deferred");

/**
 * Marks the dispatch of a call the guard ADMITTED, in both halves of every install (issue #985): an AsyncLocalStorage
 * that is true for everything that dispatch runs, across its awaits, the provider's code, its onPayload hooks and the
 * timers and promises scheduled there. A call made under it never waits: its parent holds a bound in flight, and that
 * parent may be waiting for this very call to answer (a router's forward, a call from an onPayload), so waiting there
 * could wait for its own parent's hold. Not the dispatch token's context (trap #5): a virtual model's physical re-entry
 * runs under the outer call's token, which holds no bound, and may wait. ONE per process, not one per install: a call
 * under one install's admitted dispatch made through another install is still a call its parent may wait on.
 */
const HOLDING = new AsyncLocalStorage();

/** Run an admitted call's dispatch under HOLDING (and any other verdict's as it is). */
function holdWhile(holding, verdict, run) {
	return verdict === ADMITTED ? holding.run(true, run) : run();
}

/** The errorMessage of a call its caller aborted while it waited for room under the cost cap (issue #985). */
export const WAIT_ABORTED_MESSAGE = "pi-dispatch: aborted while waiting for other calls under the cost cap";

/**
 * Queue a call the guard deferred (issue #985) and run `attempt(waiter)` again each time the guard's drain reaches it,
 * until it answers anything but DEFERRED: `done(answer)` gets that answer, `failed(error)` a throw. The retry runs in
 * the caller's own async context (AsyncLocalStorage.snapshot() at the call): it runs from whichever settle or tick
 * drained the queue, and without the snapshot the dispatch token (markForwarded), HOLDING and pi's own async-local
 * state would be that settle's. An abort of the call's `signal` while it waits leaves the queue and calls `aborted()`:
 * the provider is never called and nothing is counted, as for a hard stop. Never throws: the retry runs inside the
 * guard's drain (a microtask or a timer), where a throw would end the runner, so a throw becomes the call's own answer.
 */
/** Whether a call's signal is already aborted. One whose `aborted` cannot be read is not: its provider reads it. */
function signalAborted(signal) {
	try {
		return signal?.aborted === true;
	} catch {
		return false;
	}
}

function waitTurn({ guard, signal, attempt, done, failed, aborted }) {
	if (signalAborted(signal)) {
		aborted();
		return;
	}
	const resume = AsyncLocalStorage.snapshot();
	let waiter = null;
	let finished = false;
	const finish = () => {
		finished = true;
		try {
			signal?.removeEventListener?.("abort", onAbort);
		} catch {
			// Nothing to undo: the listener was never added.
		}
		guard.leave(waiter);
	};
	const onAbort = () => {
		if (finished) return;
		finish();
		aborted();
	};
	waiter = guard.wait(() => {
		if (finished) return;
		let answer;
		try {
			answer = resume(() => attempt(waiter));
		} catch (error) {
			finish();
			failed(error);
			return;
		}
		if (answer === DEFERRED) return;
		finish();
		done(answer);
	});
	try {
		signal?.addEventListener?.("abort", onAbort, { once: true });
	} catch {
		// Without a listener an abort is seen at the retry, by the provider, as for any call.
	}
}

/**
 * The answer of a stream call the guard deferred (issue #985): the placeholder, returned at once, whose events follow
 * the retry's answer (makeDeferredStream).
 */
function deferStream({ meter, guard, deferred, model, signal, attempt }) {
	const placeholder = deferred(model);
	meter.adopt?.(placeholder.stream);
	waitTurn({ guard, signal, attempt, done: (answer) => placeholder.follow(answer), failed: (error) => placeholder.fail(error), aborted: () => placeholder.end(WAIT_ABORTED_MESSAGE) });
	return placeholder.stream;
}

/**
 * What an `isStopped()` answer means (issue #500): null, undefined or false is "go"; a STOP_MESSAGES key is a stop
 * for that reason. Fail closed on everything else: any other truthy answer, or a throw, is a stop as the token cap,
 * the brake's original message. A STOP that cannot be read is still a STOP, and a child that ignored a garbled one
 * would spend past a parent that already stopped.
 */
function externalStop(isStopped) {
	let answer;
	try {
		answer = isStopped();
	} catch {
		return TOKEN_BUDGET;
	}
	if (answer === null || answer === undefined || answer === false) return null;
	return typeof answer === "string" && Object.hasOwn(STOP_MESSAGES, answer) ? answer : TOKEN_BUDGET;
}

/**
 * The stop a final-payload wait ends on (issue #985): this meter's own, or one from outside this process (`isStopped`, a
 * child reading its parent's STOP), made this meter's as judge makes it. A call waiting at its final payload holds the
 * FRONT of its guard's queue, so the drain asks no other call's judge while it waits; without this a parent's STOP would
 * not reach a child's final-payload waiter, which would then be sent once room appeared. Never throws: it runs inside
 * the drain, where a throw would leave the waiting onPayload unanswered for good.
 */
function stopNow(meter, isStopped) {
	if (meter.state.stopReason !== null) return meter.state.stopReason;
	if (isStopped === null) return null;
	const reason = externalStop(isStopped);
	if (reason === null) return null;
	try {
		meter.stop(reason);
	} catch {
		// The reason still ends the wait.
	}
	return meter.state.stopReason ?? reason;
}

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
 *
 * WAITING (issue #985). A call the wrapper can defer (`waitable`: the guard has `wait`, the wrapper has a placeholder to
 * answer with, and the call is not under an admitted dispatch, HOLDING) is offered with `waitable: true` and its
 * `waiter` (null on the call itself, the queued waiter on a retry), and the guard may answer COST_WAIT: judge then
 * answers DEFERRED and stops nothing. COST_WAIT for a call that was not offered as waitable reaches meter.stop() and
 * throws, as any answer outside the contract does.
 */
function judge({ meter, hardStop, guard, method, model, args, skip, isStopped = null, priced, legacy = false, waitable = false, waiter = null }) {
	if (!hardStop) return null;
	if (meter.state.stopReason !== null) return meter.state.stopReason;
	// A stop from OUTSIDE this process (issue #500: a child reads the parent's STOP file), asked before every
	// dispatch, so a parent's stop brakes the child's NEXT call. It becomes this meter's own stop (first wins).
	if (isStopped !== null) {
		const reason = externalStop(isStopped);
		if (reason !== null) {
			meter.stop(reason);
			return meter.state.stopReason;
		}
	}
	if (guard === null || skip) return null;
	const refused = guard.admit({ method, model, args, ...(priced === undefined ? {} : { priced }), ...(legacy ? { legacy: true } : {}), ...(waitable ? { waitable: true, waiter } : {}) });
	if (refused === null || refused === undefined) return ADMITTED;
	if (waitable && refused === COST_WAIT) return DEFERRED;
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
 *      `isStopped()`, when given (issue #500), is asked here too, before the guard and before dispatch: a stop
 *      decided outside this process (a parent's STOP file) becomes this meter's stop (externalStop has the rule).
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
 *      policy is set and the brake is missing (assertPoliciesEnforceable). The guard is createPolicyGuard's: the
 *      model guard (issue #502, only when a list is set) and then the cost guard (issue #501, only when a cap
 *      is set); with neither there is no guard, and every call goes through exactly as before.
 *   4. Everything else is the original method, its stream observed (or its promise, for classify and
 *      generateImages) with the (provider, model) pair read off the Model object dispatched on and the
 *      sessionId off the options -- never parsed back out of a settled message, whose provider/model a
 *      provider is free to normalise, alias or omit.
 *
 * `this` is preserved on every call, because the originals read instance state (credentials, providers).
 * There is deliberately NO swallowing try/catch: a throw in here is OUR bug, and swallowing it would turn a metering
 * defect into a silent provider outage that looks like a model error. The one catch (dispatchBinding) rethrows: it
 * only tells the guard that an admitted dispatch threw before it answered.
 *
 * `restore()` puts back each original only while the prototype still holds OUR wrapper, so a wrapper a
 * later install layered on top is never torn out from under it; in that case this layer is switched to
 * pass-through instead, so it stops counting without breaking the chain.
 *
 * A call the guard DEFERS (issue #985: refused only by other calls' holds, judge's WAITING) is answered at once with a
 * placeholder from `deferred` (makeDeferredStream), and a result method with a promise; the call is queued (waitTurn)
 * and, when the guard's drain reaches it, judged, prepared, dispatched, bound and observed again, in one synchronous
 * block, exactly as above: the single-slot `pending` of both guards and a child's pre-dispatch write still see admit,
 * prepare, dispatch and bind adjacent. The placeholder is adopted by the meter, never observed: the call is counted on
 * the stream its retry dispatched. Without `deferred` (or a guard with `wait`) no call is ever deferred.
 */
export function wrapModelRuntime({ ModelRuntime, meter, hardStop = null, hardStopResult = defaultHardStopResult, guard = null, dispatch = new AsyncLocalStorage(), isStopped = null, prices = null, deferred = null, holding = HOLDING }) {
	const proto = ModelRuntime?.prototype;
	const originals = new Map();
	const wrappers = new Map();
	let active = true;
	// `model` and `forwarded` (issue #571) let the meter judge the settled answer's usage (judgeUsage).
	const ctxOf = (model, options, token) => ({ sessionId: options?.sessionId, provider: model?.provider, modelId: model?.id, model, forwarded: () => token.forwarded });
	// Steps 1 and 3 above, shared by every method: the stop reason that ends this call, or null to dispatch it
	// unjudged, or ADMITTED when the guard judged it and let it through (it is then bound to its settle below).
	// Only streamSimple re-enters with the physical model (trap #4); a virtual model on any other method is judged as
	// itself: under a cost cap that is an unboundable call, refused, and under a list it is refused unless the list
	// names the virtual entry itself (pi then fails such an unrouted call without reaching a provider).
	// The pinned table prices the call (pinPriceTable), whatever instance it was made on, only while a guard judges.
	const verdictFor = (method, model, args, waiter) => judge({ meter, hardStop, guard, method, model, args, isStopped, skip: method === "streamSimple" && model?.api === VIRTUAL_MODEL_API, priced: guard !== null && hardStop ? priceEntry(prices, model) : undefined, waitable: waitable(), waiter });
	// Whether a call made now may wait for room (judge's WAITING): never under an admitted dispatch (HOLDING).
	const waitable = () => deferred !== null && hardStop !== null && typeof guard?.wait === "function" && holding.getStore() !== true;
	// The call's arguments as the guard prepared them for an admitted call (the model guard wraps options.onPayload).
	// `stopped()` (issue #985) lets a final-payload wait end when the job stopped meanwhile, here or outside (stopNow).
	const prepareFor = (verdict, method, model, args) => (verdict === ADMITTED && typeof guard.prepare === "function" ? guard.prepare({ method, model, args, stop: (reason) => meter.stop(reason), stopped: () => stopNow(meter, isStopped) }) : args);
	// Judged and dispatched on ONE copy (issue #502, PR #538's review): a model whose fields are getters could
	// answer the guard with one id and the provider with another. Only while a guard can judge, so a job with no
	// policy dispatches the caller's own object exactly as before.
	const judgedModel = (model) => (guard !== null && hardStop ? snapshotModel(model) : model);
	// The options too, on the same condition (issue #587's review): their sampling parameters and env are read after an await.
	const judgedArgs = (args) => (guard !== null && hardStop ? snapshotArgs(args) : args);
	const dispatchOrUnanswered = (verdict, run) => dispatchBinding(guard, verdict, run);

	for (const name of RUNTIME_STREAM_METHODS) {
		const original = proto?.[name];
		if (typeof original !== "function") continue;
		const wrapper = function (requested, ...passed) {
			if (!active) return original.call(this, requested, ...passed);
			const model = judgedModel(requested);
			const given = judgedArgs(passed);
			// One judgement and its dispatch; `waiter` is null on the call itself and its queued waiter on a retry.
			const attempt = (waiter) => {
				const verdict = verdictFor(name, model, given, waiter);
				if (verdict === DEFERRED) return DEFERRED;
				if (verdict !== null && verdict !== ADMITTED) return hardStop(model, STOP_MESSAGES[verdict]);
				// Trap #5: everything this call dispatches, across its awaits, runs under this call's own token, and its
				// options carry the token, so the compat half can tell this call's re-entry from any other call there.
				const token = dispatchToken(model);
				const rest = markOptions(prepareFor(verdict, name, model, given), token);
				// A call dispatched under another runtime call's dispatch is that call's forward (issue #571).
				markForwarded(dispatch);
				const stream = dispatchOrUnanswered(verdict, () => holdWhile(holding, verdict, () => dispatch.run(token, () => original.call(this, model, ...rest))));
				if (verdict === ADMITTED) guard.bind?.(stream);
				if (model?.api === VIRTUAL_MODEL_API) return stream;
				// streamSimple/stream take (model, context, options); streamDeferred takes (model, handle, options).
				// Options are the LAST argument in all three.
				return meter.observe(stream, ctxOf(model, rest.at(-1), token));
			};
			const answer = attempt(null);
			return answer === DEFERRED ? deferStream({ meter, guard, deferred, model, signal: given.at(-1)?.signal, attempt }) : answer;
		};
		originals.set(name, original);
		wrappers.set(name, wrapper);
	}
	for (const name of RUNTIME_RESULT_METHODS) {
		const original = proto?.[name];
		if (typeof original !== "function") continue;
		const wrapper = function (requested, context, passed) {
			if (!active) return original.call(this, requested, context, passed);
			const model = judgedModel(requested);
			const [, given] = judgedArgs([context, passed]);
			const attempt = (waiter) => {
				const verdict = verdictFor(name, model, [context, given], waiter);
				if (verdict === DEFERRED) return DEFERRED;
				if (verdict !== null && verdict !== ADMITTED) return Promise.resolve(hardStopResult(name, model, STOP_MESSAGES[verdict]));
				const [, options] = prepareFor(verdict, name, model, [context, given]);
				// A token too, though no result method re-enters the compat half: a legacy call made inside it is never its own.
				const token = dispatchToken(model);
				markForwarded(dispatch);
				const promise = dispatchOrUnanswered(verdict, () => holdWhile(holding, verdict, () => dispatch.run(token, () => original.call(this, model, context, options))));
				if (verdict === ADMITTED) guard.bind?.(promise);
				if (model?.api === VIRTUAL_MODEL_API) return promise;
				return meter.observeResult(promise, ctxOf(model, options, token));
			};
			const answer = attempt(null);
			if (answer !== DEFERRED) return answer;
			// A deferred result call (issue #985) answers with a promise of its retry's answer. A throw in the retry rejects
			// it, as a throw in pi's own async method would.
			return new Promise((resolve, reject) => waitTurn({ guard, signal: given?.signal, attempt, done: resolve, failed: reject, aborted: () => resolve(hardStopResult(name, model, WAIT_ABORTED_MESSAGE)) }));
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
 * The ONE call that is a runtime call's own re-entry (`dispatch`, trap #5: its options carry the unused token of the
 * context it runs in, on the same (provider, model) pair) is routed the same way and NOT observed: the runtime half
 * already counted it. Nor is it offered to the guard: the runtime half already judged it, and judging one request
 * twice would count its bound twice. A FORWARD (the token on another pair) is a full call here: judged, prepared,
 * bounded and observed below under its own model, while the runtime call keeps its own bound and count. Every other legacy call, made
 * inside a runtime call's context (a hook, an onPayload, a timer scheduled there) or outside any, is guarded and
 * observed here exactly as wrapModelRuntime's step 3 guards a runtime call (issue #543).
 *
 * There is deliberately NO swallowing try/catch, for the reason wrapModelRuntime gives (dispatchBinding rethrows).
 * A deferred call (issue #985) is answered with a placeholder and retried exactly as in wrapModelRuntime.
 */
export function wrapProviderStreams({ inner, fallbackModels, meter, hardStop, guard = null, dispatch = null, isStopped = null, prices = null, deferred = null, holding = HOLDING }) {
	const dispatchOrUnanswered = (verdict, run) => dispatchBinding(guard, verdict, run);
	function route(kind, requested, context, passed) {
		// One copy, judged and dispatched (wrapModelRuntime's judgedModel has the why), its options likewise.
		const model = guard !== null && hardStop ? snapshotModel(requested) : requested;
		const given = guard !== null && hardStop ? snapshotOptions(passed) : passed;
		// Checked before dispatch, so a stop ends the NEXT call rather than merely recording it.
		// The runtime call's own re-entry is skipped; any other call, a forward to another pair included, is judged.
		// Claimed once, at the call: a deferred call is never a re-entry (a re-entry is not judged, so never deferred).
		const reentry = claimReentry(dispatch?.getStore(), model, given);
		// Whether this call may wait for room (judge's WAITING): never under an admitted dispatch (HOLDING).
		const waitable = deferred !== null && hardStop !== null && typeof guard?.wait === "function" && holding.getStore() !== true;
		const attempt = (waiter) => {
			// A legacy call is priced from the same pinned table as the runtime half (pinPriceTable).
			const verdict = judge({ meter, hardStop, guard, method: kind, model, args: [context, given], skip: reentry, isStopped, legacy: true, priced: guard !== null && hardStop ? priceEntry(prices, model) : undefined, waitable, waiter });
			if (verdict === DEFERRED) return DEFERRED;
			if (verdict !== null && verdict !== ADMITTED) return hardStop(model, STOP_MESSAGES[verdict]);
			const options = verdict === ADMITTED && typeof guard.prepare === "function" ? guard.prepare({ method: kind, model, args: [context, given], stop: (reason) => meter.stop(reason), stopped: () => stopNow(meter, isStopped) })[1] : given;
			const provider = fallbackModels?.getProvider?.(model.provider);
			const builtin = provider?.getModels?.().some((candidate) => candidate.api === model.api) ? provider : null;
			// Any call other than the runtime call's own re-entry, made under a runtime call's dispatch, is that call's forward
			// (issue #571), marked BEFORE it is dispatched as the runtime half does, so a forward that throws marks it too.
			if (!reentry) markForwarded(dispatch);
			const stream = dispatchOrUnanswered(verdict, () =>
				holdWhile(holding, verdict, () =>
					builtin
						? model.provider.startsWith("cloudflare-")
							? fallbackModels[kind](model, context, options)
							: builtin[kind](model, context, options)
						: inner[kind](model, context, options),
				),
			);
			if (verdict === ADMITTED) guard.bind?.(stream);
			if (reentry) return stream;
			return meter.observe(stream, { sessionId: options?.sessionId, provider: model.provider, modelId: model.id, model });
		};
		const answer = attempt(null);
		return answer === DEFERRED ? deferStream({ meter, guard, deferred, model, signal: given?.signal, attempt }) : answer;
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
	return (model, message = defaultMessage) => endStream(createStream(), terminalMessage(model, message, "aborted"));
}

/** The terminal message of a call that ended before it reached a provider: zero usage, `stopReason` as given. */
function terminalMessage(model, message, stopReason) {
	return {
		role: "assistant",
		content: [],
		api: model?.api,
		provider: model?.provider,
		model: model?.id,
		usage: zeroUsage(),
		stopReason,
		errorMessage: message,
		timestamp: Date.now(),
	};
}

/** End `stream` with a terminal error event carrying `message`, the shape both the hard stop and a placeholder end with. */
function endStream(stream, message) {
	// push() resolves result() via the terminal-event predicate; end() covers a stream implementation
	// that does not. Both are idempotent on pi's EventStream (`done` short-circuits push).
	stream.push({ type: "error", reason: message.stopReason, error: message });
	stream.end(message);
	return stream;
}

/**
 * THE PLACEHOLDER of a deferred call (issue #985): a call the cost guard told to wait for other calls' holds is
 * answered at once with a stream from the same `createStream` as the hard stop (pi's own
 * createAssistantMessageEventStream, so pi's consumers see the stream type they already handle), and the call is
 * queued. `(model)` builds one: `{ stream, follow(answer), fail(error), end(message) }`.
 *   - follow: the retry's answer (its admitted stream, a hard stop if the job stopped meanwhile, or a promise of a
 *     stream from a compat entry, observe() has where that comes from). Every event is copied into the placeholder in
 *     order, as pi's own lazyStream forwards a provider's stream, and the placeholder then ends with the answer's own
 *     result(), the message pi reads (push() of the terminal event already resolved it; end() covers an answer whose
 *     events carried none). The answer is read eagerly, so the call settles whether or not anyone reads the placeholder.
 *   - fail: a retry that threw, or an answer that is no stream at all (or whose result() rejected): the placeholder
 *     ends with the error's message, zero usage, and `aborted`, never `error`. pi's lazyStream ends a failed setup
 *     `error`, but `error` is the one stopReason pi auto-retries (pinned), and this meter never builds it: a retry of
 *     a call that failed this way would be a paid one. The guard has already charged what the call may have cost.
 *   - end: the caller aborted while it waited: `aborted`, zero usage, so pi does not retry it, and the provider was
 *     never called.
 * Never throws and never rejects: the retry runs inside the guard's drain.
 */
export function makeDeferredStream({ createStream }) {
	if (typeof createStream !== "function") throw new Error("makeDeferredStream requires createStream");
	return (model) => {
		const stream = createStream();
		const fail = (error) => endStream(stream, terminalMessage(model, error instanceof Error ? error.message : String(error), "aborted"));
		const follow = async (answer) => {
			let result;
			try {
				const source = await answer;
				if (typeof source?.[Symbol.asyncIterator] === "function") {
					for await (const event of source) {
						stream.push(event);
						if (event?.type === "done") result = event.message;
						else if (event?.type === "error") result = event.error;
					}
				}
				if (typeof source?.result === "function") result = await source.result();
				if (result === undefined) throw new Error("pi-dispatch: the deferred call answered with no stream");
			} catch (error) {
				try {
					fail(error);
				} catch {
					// pi's EventStream does not throw; nothing is left to tell the caller.
				}
				return;
			}
			try {
				stream.end(result);
			} catch {
				// As above.
			}
		};
		return {
			stream,
			follow: (answer) => void follow(answer),
			fail: (error) => {
				try {
					fail(error);
				} catch {
					// As above.
				}
			},
			end: (message) => {
				try {
					endStream(stream, terminalMessage(model, message, "aborted"));
				} catch {
					// As above.
				}
			},
		};
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
 * The package directory of the copy of `@earendil-works/<name>` that pi-coding-agent's OWN bare imports resolve
 * to, or null. Found by identity of position, not by a fixed path: pi-coding-agent's package root is located from
 * its resolved entry, and then Node's own lookup for a bare import made from inside that package is walked (its
 * `node_modules`, then each ancestor's, skipping a directory that is itself a `node_modules`). Whatever npm does
 * with the tree, the first hit is the file pi's own `import "@earendil-works/<name>"` loads.
 *
 * Why not a fixed nested path (issue #587): up to pi 0.99.1 pi-coding-agent shipped an npm-shrinkwrap.json, so
 * pi-ai and pi-agent-core were always NESTED under it, and every site that wanted pi's copy hard-coded
 * `pi-coding-agent/node_modules/@earendil-works/...`. pi-coding-agent 1.0.1 dropped the shrinkwrap; at 1.0.3 the
 * siblings dedupe to the top level and every one of those paths named a file that no longer exists. Why not
 * `createRequire(entry).resolve`: pi's packages export only an `import` condition (and no ./package.json), so the
 * CJS resolver throws ERR_PACKAGE_PATH_NOT_EXPORTED. `resolve` and `exists` are injected so this stays pure.
 */
export function piOwnPackageDir(name, { resolve = (spec) => import.meta.resolve(spec), exists = defaultExists } = {}) {
	const agentEntry = tryResolve(resolve, "@earendil-works/pi-coding-agent");
	if (!agentEntry) return null;
	// dist/index.js -> dist -> package root.
	for (let dir = dirname(dirname(fileURLToPath(agentEntry))); ; dir = dirname(dir)) {
		if (basename(dir) !== "node_modules") {
			const candidate = join(dir, "node_modules", "@earendil-works", name);
			if (exists(pathToFileURL(join(candidate, "package.json")).href)) return candidate;
		}
		if (dirname(dir) === dir) return null;
	}
}

/**
 * The ORDERED compat candidate list, most-likely-correct first.
 *
 * WHY pi-ai IS NOT IN THE RUNNER'S package.json, even though this module depends on it. What the
 * meter needs is not "a pi-ai" but pi-coding-agent's OWN pi-ai -- the copy pi hands its extensions (trap
 * #1 above). No dependency declaration can express that: a declared `@earendil-works/pi-ai` is a request
 * for a copy at the runner's own tree position, which npm may satisfy with a different one, and the
 * meter would then have more wrong answers to choose between, not fewer. So the dependency stays
 * deliberately undeclared and the binding is settled where it can actually be settled: at runtime, by the
 * identity check in installProcessUsageMeter. (package.json admits no comment, which is why this note lives
 * here.)
 *
 * pi's OWN copy first (`pi`, piOwnPackageDir): the file pi-coding-agent's own imports resolve to, whatever the
 * layout. A bare specifier from this file (`hoisted`) second, only when it names ANOTHER file, as a degraded
 * fallback. At the 1.0.3 pin the two are one file in a dev checkout (the root `overrides` pin every pi package to
 * one version, so npm keeps one copy) and in the image (only the runner's tree is installed), so the list has one
 * entry. The ordering is a hypothesis, not a conclusion -- installProcessUsageMeter proves a candidate before
 * trusting it, because a resolved path is exactly the thing that lies here. Also read by the image contract job
 * (.github/workflows/pi-upgrade-check.yml), and by loadRetryPredicate for a runner whose compat half did not
 * install.
 *
 * `resolve` and `exists` are injected so this stays pure and testable.
 */
export function resolvePiAiCompat({ resolve = (spec) => import.meta.resolve(spec), exists = defaultExists } = {}) {
	const candidates = [];

	const own = piOwnPackageDir("pi-ai", { resolve, exists });
	if (own) {
		const url = pathToFileURL(join(own, "dist", "compat.js")).href;
		if (exists(url)) candidates.push({ tag: "pi", url });
	}

	const hoisted = tryResolve(resolve, "@earendil-works/pi-ai/compat");
	if (hoisted && !candidates.some((candidate) => candidate.url === hoisted)) candidates.push({ tag: "hoisted", url: hoisted });

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
 * What makes a module "the pi-ai an extension gets". Since pi 1.5.0 extensions import a view, `pi-ai-extension-view.js`,
 * which re-exports pi-ai's compat entry and adds TypeBox's `Type` and a `StringEnum`, so it is a different namespace
 * object with the same functions. Those functions close over the one registry, so they are what must be identical. Two
 * copies of pi-ai export the same names, which is why a match on names proves nothing.
 */
export const PI_AI_REGISTRY_FUNCTIONS = Object.freeze(["registerApiProvider", "getApiProvider", "getApiProviders", "resetApiProviders", "createAssistantMessageEventStream"]);

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
 * The compat half. Each candidate from resolvePiAiCompat is loaded and accepted only when it IS, by object identity,
 * the module pi hands an extension for `@earendil-works/pi-ai` (defaultLoadExtensionModules), or a view of it whose
 * PI_AI_REGISTRY_FUNCTIONS are all identical to the candidate's. pi 1.5.0 hands a view, so a capped job is refused
 * unless this holds.
 * The accepted module also supplies the brake's stream factory and the ledger's pricing provenance (the
 * `version` in the package.json above its dist/), because it is the copy whose providers priced the calls.
 * Registration goes straight through the accepted compat's own `registerApiProvider` (at 0.99.1 the
 * ModelRegistry no longer writes to this registry at all), filed under METER_PROVIDER_PREFIX so one api id
 * is one registration; the unref'd interval re-arms after `resetApiProviders()`.
 *
 * Four options serve a child meter (issue #500), each absent in the runner's own install, which is then exactly as
 * before: `compat: { module, fallbackModels?, version? }`, a compat copy handed over instead of resolved (tag
 * `injected`); `brake: true`, a hard stop with no policy; `isStopped`, a stop read from outside, asked before every
 * call on both halves (judge); and `children`, the detector hook that replaces the Linux sampler.
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
	compat = null,
	brake = false,
	children: childrenHook = null,
	isStopped = null,
	prices,
}) {
	// The price table (pinPriceTable, issue #587's review), pinned HERE, before any extension loads: `prices` when the
	// caller hands one over (a pi child, the parent's table), else the job runtime's, else none.
	const pinnedPrices = prices !== undefined ? prices : pinPriceTable(runtime);
	// --- the compat half's copy, decided first: it supplies the brake's stream factory to BOTH halves ---
	// An INJECTED copy (issue #500, `compat: { module }`) skips resolution and the identity check: a pi child loads
	// child-meter.mjs through pi's virtual modules, so the module it hands over IS the copy pi gives extensions, and in
	// the bundle there is no file to resolve. It still has to be a compat module. It has no sibling on disk either, so
	// its catalog and version come with it or not at all (`fallbackModels`, `version`).
	const injected = compat !== null;
	const candidates = injected ? [] : resolvePiAiCompat({ resolve, exists });
	const tried = [];
	let accepted = null;
	let compatError = null;
	let extensionModules = null;
	if (injected) {
		const mod = compat?.module;
		if (typeof mod?.registerApiProvider === "function" && typeof mod?.getApiProvider === "function" && typeof mod?.getApiProviders === "function") {
			accepted = { candidate: { tag: "injected", url: null }, mod };
		} else compatError = "injected-not-compat";
	} else {
		try {
			extensionModules = await loadExtensionModules();
			if (!extensionModules) compatError = "no-extension-modules";
		} catch (error) {
			compatError = reasonOf(error);
		}
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
		// pi 1.5.0 wraps compat in an extension view. Namespace identity still proves the
		// pinned copy; a view must share every registry/reset/stream function by identity.
		// Matching names (or two absent exports) cannot prove shared module-level state.
		const extensionView = extensionModules["@earendil-works/pi-ai"];
		if (extensionView !== mod && !PI_AI_REGISTRY_FUNCTIONS.every((name) => typeof mod[name] === "function" && extensionView?.[name] === mod[name])) continue;
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
	if (accepted && injected) meter.setPiAiVersion(compat.version);
	else if (accepted) {
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
	// `brake: true` (issue #500) arms it with no policy at all: a child meter has none of its own to arm it, and still
	// needs a hard stop to answer the parent's STOP with.
	const armed = brake === true || meter.cap !== null || meter.costCap !== null || meter.allowed !== null;
	const hardStop = armed && createStream ? makeHardStopStream({ createStream }) : null;
	// The placeholder a call the cost guard defers answers with (issue #985), from the same factory: only a guard with
	// `wait` ever defers a call, so with no cap this is never used.
	const deferred = hardStop !== null ? makeDeferredStream({ createStream }) : null;
	// A meter that was ASKED for a brake (`brake: true`, or an outside stop to answer, `isStopped`) and cannot build
	// one is not a meter (issue #500): judge() never asks isStopped without a hard stop, so a parent's STOP would be
	// silently ignored. ok:false, so the child records itself `metered: false` and the parent counts it unmetered.
	if ((brake === true || isStopped !== null) && hardStop === null) {
		log("usage_meter_unavailable", { reason: "no-hard-stop" });
		return { ok: false, arm: () => {}, uninstall: () => {} };
	}

	// --- the runtime half: THE choke point. Without it there is no process-wide meter. ---
	const methodsPresent = typeof ModelRuntime?.prototype?.streamSimple === "function" && typeof ModelRuntime?.prototype?.stream === "function";
	if (!methodsPresent) {
		// Never log a filesystem path: run logs are shipped, and the image layout is not public data.
		log("usage_meter_unavailable", { reason: "no-runtime-methods" });
		return { ok: false, arm: () => {}, uninstall: () => {} };
	}
	// One per install, shared by both halves (trap #5).
	const dispatch = new AsyncLocalStorage();
	const runtimeLayer = wrapModelRuntime({ ModelRuntime, meter, hardStop, guard, dispatch, isStopped, prices: pinnedPrices, deferred });
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
	if (accepted && injected) {
		fallbackModels = compat.fallbackModels ?? null;
		if (!fallbackModels) fallbackError = "no-builtin-models";
	} else if (accepted) {
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
	// The child-process hook (issue #500): the detector that replaces the diagnostic sampler, `{ sample(), teardown() }`.
	// sample() runs on every re-arm tick; teardown(), if present, at uninstall, and what it returns is added to the
	// teardown line. Absent, the Linux sampler stays, and both lines are exactly as before.
	const children = childrenHook ?? createChildSampler(platform);
	// The hook runs on a timer, where a throw is an uncaught exception that ends the runner with no exit line. So a
	// throw is caught and logged, by name only and once, and the hook owns what a failed tick means.
	// FAIL CLOSED under a policy: in a parent the hook IS the children's fold and detector, and a tick that threw has
	// folded and detected nothing, so the job would run on with its children uncounted. With any policy the meter
	// stops, for the stop an unmetered child gets (cost-cap under a dollar cap, else token_budget under a token cap,
	// else model-not-allowed under a list). With none there is nothing to enforce, and the failure is only logged.
	// Failures are counted on the teardown line (`childrenFailed`).
	let hookFailures = 0;
	function tick(run) {
		try {
			return run();
		} catch (error) {
			if (hookFailures === 0) log("usage_meter_children_failed", { reason: reasonOf(error) });
			hookFailures += 1;
			const reason = meter.costCap !== null ? COST_CAP : meter.cap !== null ? TOKEN_BUDGET : meter.allowed !== null ? MODEL_NOT_ALLOWED : null;
			if (reason !== null) meter.stop(reason, { cause: "children-hook" });
			return null;
		}
	}

	const handle = {
		ok: true,
		// Whether a hard stop exists, and which stops the installed guard can refuse for: the two facts
		// assertPoliciesEnforceable reads before the first prompt. Per policy, not one flag, so a guard that
		// enforces the cost cap cannot pass for one that enforces the model list.
		brake: hardStop !== null,
		enforces: Object.freeze([...(guard?.enforces ?? [])]),
		methods: runtimeLayer.methods,
		// Whether a runtime instance dispatches through this install's wrappers (issue #500): a child meter installs at
		// extension load, before any session exists, and checks the session's own runtime once it does.
		covers: (instance) => runtimeLayer.covers(instance),
		module,
		tag: accepted?.candidate.tag ?? null,
		// The table every capped call is priced from (pinPriceTable): run-job hands it to pi children.
		prices: pinnedPrices,
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
			const streams = wrapProviderStreams({ inner: entry, fallbackModels, meter, hardStop, guard, dispatch, isStopped, prices: pinnedPrices, deferred });
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
		// The same gap under a model list (issue #502): a legacy compat call through the displaced entry reached a
		// provider without the list being asked, so it may have called a model the list forbids. Fail closed the
		// same way. Under a cap as well, the cap's stop above has already won (first wins, with `costUnjudged` as its
		// evidence); under a list alone the stop is `model-not-allowed`, and its record tells it apart from a refused
		// call by `modelRefused: 0`.
		if (displaced > 0 && meter.allowed !== null && meter.state.stopReason === null) {
			log("model_guard_displaced", { apis: displaced });
			meter.stop(MODEL_NOT_ALLOWED);
		}
		return handle;
	}

	let toreDown = false;
	function uninstall() {
		clearInterval(timer);
		if (toreDown) return;
		toreDown = true;
		runtimeLayer.restore();
		// A call still waiting for room (issue #985) no longer keeps the process alive: the session that made it is over.
		try {
			guard?.close?.();
		} catch {
			// A guard's teardown never fails the meter's.
		}
		// THE RE-ARM GAP, made inferable (REQ-TOKEN-ACCOUNTING-AND-CAPS). Compat half only: at 0.99.1 a
		// session's own calls never enter the registry, so this window can hide only a legacy extension call.
		//
		// `resetApiProviders()` wipes the compat wrappers and replays nothing, and the only thing that puts
		// them back is the unref'd `rearmMs` poll. A registry call landing between the wipe and the next arm()
		// is UNMETERED, and nothing else in the run record shows it. `rearms` counts the api IDS arm() found
		// displaced, not the wipes -- one wipe displaces every armed api at once, which is why `apis` is on
		// the same line, and `rearmMs` with it because the window's width is the other half of any estimate.
		// The hook's teardown runs FIRST, so its last fold is in the meter before the caller reads the snapshot.
		const extra = typeof childrenHook?.teardown === "function" ? tick(() => childrenHook.teardown()) : null;
		// The meter's own fields are never the hook's to set: a colliding key from the hook is dropped.
		const own = { rearms: handle.rearms, apis: handle.apis.length, rearmMs, ...(childrenHook === null ? {} : { childrenFailed: hookFailures }) };
		const added = extra !== null && typeof extra === "object" ? Object.fromEntries(Object.entries(extra).filter(([key]) => !Object.hasOwn(own, key))) : {};
		log("usage_meter_teardown", { ...own, ...added });
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
		if (childrenHook === null) children?.sample();
		else tick(() => childrenHook.sample?.());
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
 *     COST_CAP and the model guard (createModelGuard, issue #502) MODEL_NOT_ALLOWED; run-job installs each only
 *     for its own policy (createPolicyGuard), so a guard for one can never pass for the other.
 * Missing any one, the job is refused as a tagged configError: exit 2, not retried, before any spend. The
 * model list is checked first: a job that would be refused for both is named by the policy that decides
 * which provider is called at all. Names only, never values: the cap and the list are not echoed.
 *
 * The subscription allowance (issue #1008, `allowanceMicros`, createAllowanceGuard) is checked last, against
 * SUBSCRIPTION_ALLOWANCE, and refused as `cost-cap-unenforceable`: a dollar limit this runner cannot apply before a
 * call, the cap's own refusal, so an operator reads one reason for both money limits.
 */
export function assertPoliciesEnforceable({ maxCostMicros = null, allowedModels = null, allowanceMicros = null, meterOk, brake, enforces = [] }) {
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
	if (allowanceMicros !== null && missing(SUBSCRIPTION_ALLOWANCE) !== null) {
		throw configError(`PI_SUBSCRIPTION_ALLOWANCE_MICROS is set but cannot be enforced before a call: ${missing(SUBSCRIPTION_ALLOWANCE)}`, COST_CAP_UNENFORCEABLE);
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
		// A stop with a `cause` (issue #500: an unmetered child, a children hook that failed) is not the token cap being
		// passed, whatever its reason: its own line (`unmetered_child`, `usage_meter_children_failed`) says why.
		if (reason === TOKEN_BUDGET && typeof detail?.cause !== "string") onTokenAbort(detail);
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
 * The api ids whose provider prices a call from the model's cost table, at the pin (re-verified at 1.1.0): exactly the
 * dist/api modules that reach pi-ai's `calculateCost` (directly, or through openai-responses-shared.js and
 * classifier-shared.js, which carries the System One classifiers and openai-decisions since pi 1.1.0). pinned-api.test.mjs derives that set from the pinned source and requires it to equal
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
	"openai-decisions",
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
 * The apis whose output the bound takes as the model's own limit, whatever the caller's maxTokens (pinned by needle).
 * Three never put the caller's cap on the request, so the provider answers up to that limit and a small
 * options.maxTokens bounds nothing there. openai-codex-responses does since pi 1.6.0 (`max_output_tokens`, at least
 * 16, unless compat.supportsMaxOutputTokens is false), but it goes to the ChatGPT backend, whose honouring it is not
 * measured, and pi itself drops that field for a ChatGPT sign-in on openai-responses. So the bound keeps the model's
 * limit there, which is never below what the call can cost. Rejected: trusting the cap sent there, which a backend
 * that ignores it would turn into a bound below the bill.
 */
const MAX_TOKENS_UNSENT_APIS = new Set(["openai-codex-responses", "cloudflare-workers-ai-system-one", "openai-decisions", "typesafe-system-one"]);
/**
 * The hosts pi's own catalog serves openai-completions models on (issue #507), GENERATED from the pinned catalog by
 * .github/scripts/pi-derived.mjs (a pi bump reruns it and lists the hosts that came or went) and pinned to the catalog
 * by pinned-api.test.mjs. openai-completions sends the output cap as `max_completion_tokens` unless the model's
 * compat says `max_tokens`, and pi picked that field per host for these hosts only. Any other server is the
 * operator's (Ollama, vLLM, llama.cpp, LM Studio, a proxy), and pi's default is a guess there: Ollama 0.35.0
 * ignores `max_completion_tokens` and answers past it (measured: 20 asked, 440 returned), which let a job settle
 * $3.41 under a $2 cap. Every OpenAI-compatible server reads `max_tokens`, so on any other host only a cap that
 * travels as `max_tokens` bounds the output. Rejected: trusting `model.contextWindow` instead, since it is the
 * operator's number and not the server's (Ollama's own window differs and it shifts context to keep answering).
 */
export const COMPLETIONS_CATALOG_HOSTS = Object.freeze([
	"api.ant-ling.com",
	"api.cerebras.ai",
	"api.cloudflare.com",
	"api.deepseek.com",
	"api.fireworks.ai",
	"api.groq.com",
	"api.individual.githubcopilot.com",
	"api.kimi.com",
	"api.moonshot.ai",
	"api.moonshot.cn",
	"api.together.ai",
	"api.xiaomimimo.com",
	"api.z.ai",
	"gateway.ai.cloudflare.com",
	"inference.baseten.co",
	"integrate.api.nvidia.com",
	"open.bigmodel.cn",
	"opencode.ai",
	"openrouter.ai",
	"router.huggingface.co",
	"token-plan-ams.xiaomimimo.com",
	"token-plan-cn.xiaomimimo.com",
	"token-plan-sgp.xiaomimimo.com",
	"token-plan.maas.qianwenaiapi.com",
	"token-plan.maas.qwencloudapi.com",
]);

/**
 * Hosts trusted beside the catalog's, each pinned with its reason by pinned-api.test.mjs. api.openai.com: pi's catalog
 * serves OpenAI on openai-responses, so the host is not in the derived list, but an overlay model may reach it on
 * openai-completions. pi sends `max_completion_tokens` there (detectCompat has no rule for it), OpenAI honours it, and
 * it REJECTS `max_tokens` for its reasoning models, so refusing it would leave the operator no field that works.
 */
export const COMPLETIONS_EXTRA_HOSTS = Object.freeze(["api.openai.com"]);

/**
 * Whether an openai-completions model talks to a server outside COMPLETIONS_CATALOG_HOSTS and COMPLETIONS_EXTRA_HOSTS,
 * where only a cap sent as `max_tokens` is known to be read. A baseUrl that does not parse counts as such a server.
 */
export function completionsOwnServer(model) {
	if (model?.api !== "openai-completions") return false;
	try {
		const host = new URL(model.baseUrl).hostname;
		return !COMPLETIONS_CATALOG_HOSTS.includes(host) && !COMPLETIONS_EXTRA_HOSTS.includes(host);
	} catch {
		return true;
	}
}

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
 * The steps, each a fact about the pinned pi-ai (re-verified at 1.0.3) that pinned-api.test.mjs holds by needle:
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
 *      (imageAllowance), because providers bill pixels, not base64 bytes. With `body` (the final shaped request the
 *      cost guard's onPayload checks, issue #985) the input is the LARGER of the context's and the body's measures
 *      (bytes plus image allowance each), never their sum: the body is what is sent, built from the context, so the
 *      larger of the two covers both, and a continued request whose prefix the server holds (anthropic-messages'
 *      threads, openai-codex-responses' previous_response_id, both pinned) is covered by the context and the checked
 *      body it was cut from. A body that does not serialise: Infinity.
 *   5. The output bound: options.maxTokens (when positive and the api sends it) else model.maxTokens; raised to
 *      model.maxTokens when options.reasoning is set (adjustMaxTokensForThinking may lift the caller's budget up
 *      to it); at least 16 on openai-responses and azure. 0 for `classify`, which is Infinity if any output rate
 *      is above 0 (pi exposes no output bound for it). No usable number, or a present maxTokens that is not
 *      finite: Infinity. On the three apis that merge samplingParams after the cap, an output-cap key there wins
 *      if larger and `n` multiplies (samplingOutput). On openai-completions to a host outside
 *      COMPLETIONS_CATALOG_HOSTS and COMPLETIONS_EXTRA_HOSTS (issue #507), only the cap the request carries as
 *      `max_tokens` counts: a model whose compat does not set that field is Infinity, and so is a raw `stream` with
 *      no options.maxTokens and a caller's cap of 0. A negative cap on openai-completions is Infinity on every host.
 *   6. The input rate of a table is the highest of input, cacheRead and cacheWrite, and 2 x input when a 1h cache
 *      write can happen: api anthropic-messages or bedrock-converse-stream and retention "long", resolved as pi
 *      does (options.cacheRetention, else options.env.PI_CACHE_RETENTION, else the process env).
 *   7. The service-tier multiplier: 2.5 for gpt-5.5 and 2 otherwise on openai-responses and
 *      openai-codex-responses (pi multiplies the settled cost by the tier the RESPONSE reports, which can be the
 *      account's default, not only the request's); 1 elsewhere, azure included (it applies none).
 *   8. ceil(max over tables of (inputBound x inputRate + output x outputRate) x multiplier). Per table, because
 *      pi prices one call with exactly one table.
 */
export function callCostBound(method, model, context, options, env = process.env, body = undefined) {
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
	let serialisedBody;
	try {
		serialised = JSON.stringify(context);
		if (body !== undefined) serialisedBody = JSON.stringify(body);
	} catch {
		return Infinity;
	}
	const bytes = (text) => (typeof text === "string" ? Buffer.byteLength(text, "utf8") : 0);
	const measured = bytes(serialised) + imageAllowance(model, context);
	const inputBound = (body === undefined ? measured : Math.max(measured, bytes(serialisedBody) + imageAllowance(model, body))) + BOUND_OVERHEAD_TOKENS;
	// 5.
	let output;
	if (method === "classify") {
		const outputRates = bases.flatMap((table) => [table, ...(table.tiers ?? [])]).map((table) => table.output);
		if (outputRates.some((value) => value > 0)) return Infinity;
		output = 0;
	} else {
		// A PRESENT maxTokens that is not a finite number is unboundable: pi's clampMaxTokensToContext turns NaN into a
		// null on the wire (the provider's default) and Infinity into the remaining window. null/undefined is absent,
		// as pi reads it (`options?.maxTokens ?? model.maxTokens`). A finite value of 0 or less is NOT absent: the clamp
		// keeps it (`Math.min`), and openai-completions then sends no cap for 0 (`if (options?.maxTokens)`) and a
		// negative one as it is (Ollama reads `max_tokens: -1` as no limit; measured on the wire, issue #507). On
		// openai-completions a negative cap is Infinity on every host; 0 is Infinity on the operator's own server and
		// the model's limit on a catalog host, where a request with no cap is the hosted server's own limit (the
		// residual named in DES-DOLLAR-RESERVE-AND-SETTLE). The other apis refuse a cap of 0 or less, or raise it
		// (openai-responses' 16 floor), so there it bounds nothing and the model's cap applies.
		const raw = options?.maxTokens;
		if (raw !== undefined && raw !== null && !(typeof raw === "number" && Number.isFinite(raw))) return Infinity;
		const present = typeof raw === "number";
		if (present && raw < 0 && model.api === "openai-completions") return Infinity;
		const asked = present && raw > 0 ? raw : undefined;
		const modelMax = typeof model.maxTokens === "number" && Number.isFinite(model.maxTokens) && model.maxTokens > 0 ? model.maxTokens : undefined;
		if (completionsOwnServer(model)) {
			// Issue #507: on the operator's own server the output is bounded by the cap on the wire, and only when it
			// travels as max_tokens. streamSimple sends `asked`, or `model.maxTokens` when the caller passed none (clamped
			// lower, never to 0 from a positive value); a raw stream sends only the caller's. A caller's 0 sends no cap at
			// all, so the server answers as long as it likes: Infinity, like a raw stream with none.
			const sent = present ? asked : method === "stream" ? undefined : modelMax;
			output = model.compat?.maxTokensField === "max_tokens" ? sent : undefined;
		} else {
			output = sendsMaxTokens(model, options) ? (asked ?? modelMax) : modelMax;
		}
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
 * The apis that merge the resolved sampling parameters into the request AFTER the output cap
 * (`Object.assign(params, samplingParams)` on `resolveSamplingParams(model, level, options?.samplingParams)`, pinned
 * by needle), so a key there overrides it. Issue #501, PR #534's review.
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
 * Every sampling-parameter object that can reach a call's request, or null when one cannot be read (fail closed).
 * pi 1.0.2 added `model.samplingParamsByThinkingLevel` (issue #587): `resolveSamplingParams` merges
 * `{ ...model.samplingParams, ...byLevel[level], ...options.samplingParams }`, with the level clamped per model and
 * chosen per call, and streamSimple resolves twice (buildBaseOptions, then the api), so keys of two levels can meet in
 * one request. The guards track no level: they read EVERY level, the model's own params and the call's, as layers.
 * A key in any layer counts, and an output bound takes the largest value any layer holds.
 */
function samplingLayers(model, options) {
	const layers = [];
	for (const layer of [model?.samplingParams, options?.samplingParams]) {
		if (layer === undefined || layer === null) continue;
		if (!isOwnData(layer)) return null;
		layers.push(layer);
	}
	const byLevel = model?.samplingParamsByThinkingLevel;
	if (byLevel !== undefined && byLevel !== null) {
		// Own data only (isOwnData): an inherited, hidden or accessor level is one pi reads and Object.values does not.
		if (!isOwnData(byLevel)) return null;
		for (const layer of Object.values(byLevel)) {
			if (layer === undefined || layer === null) continue;
			if (!isOwnData(layer)) return null;
			layers.push(layer);
		}
	}
	return layers;
}

/**
 * Whether a call's sampling layers (samplingLayers: the model's, every thinking level's, the call's) hold a key
 * outside SAMPLING_SAFE_KEYS on an api that merges them into the request AFTER it is built, so the key overrides the
 * request itself: its price for the cost guard, and for the model guard its `model` (issue #502, PR #538's review).
 * One rule, read by both guards. A layer that cannot be read counts as such a key.
 */
export function samplingOverridesRequest(model, options) {
	if (!SAMPLING_OVERRIDE_APIS.has(model?.api)) return false;
	const layers = samplingLayers(model, options);
	if (layers === null) return true;
	return layers.some((layer) => Object.keys(layer).some((key) => !SAMPLING_SAFE_KEYS.includes(key)));
}

/**
 * The output bound once the sampling layers have had their say: the larger of the bound and any output-cap key in
 * ANY layer, times the largest `n` in any layer (completions answer n choices, each up to the cap). Taken across
 * layers rather than on one merged object, so whichever level pi picks, and whichever layers meet in the request, the
 * bound is not lower than what is sent. A key that is present but not a positive finite number (null sends the
 * provider's default; a string is whatever the server makes of it) is Infinity.
 */
function samplingOutput(model, options, output) {
	if (!SAMPLING_OVERRIDE_APIS.has(model.api)) return output;
	if (samplingOverridesRequest(model, options)) return Infinity;
	const positive = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
	let bound = output;
	let choices = 1;
	for (const layer of samplingLayers(model, options)) {
		for (const key of SAMPLING_OUTPUT_KEYS) {
			if (!Object.hasOwn(layer, key)) continue;
			if (!positive(layer[key])) return Infinity;
			bound = Math.max(bound, layer[key]);
		}
		if (Object.hasOwn(layer, "n")) {
			if (!positive(layer.n) || !Number.isInteger(layer.n)) return Infinity;
			choices = Math.max(choices, layer.n);
		}
	}
	return bound * choices;
}

/** pi's default image resize box (pi-coding-agent utils/image-resize-core.js, pinned by needle). */
export const IMAGE_RESIZE_MAX = Object.freeze({ width: 2000, height: 2000 });
/**
 * Input tokens one image can cost in pi's resize box (2000 x 2000), per api. Provider billing rules, not pi facts,
 * so each is stated with its arithmetic, for the family each api natively serves:
 *   - the openai apis (completions, responses, azure, codex, decisions): gpt-4o-mini's high-detail tiles, base 2,833 plus
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
	// OpenAI's Decisions classifier (pi 1.1.0) sends a classify call's images as they are, without pi's resize; the
	// tile count is still bounded by OpenAI's own downscale, which is what 48,169 is derived from.
	"openai-decisions": 48_169,
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
		if (["image", "image_url", "input_image"].includes(value.type) || value.image?.source || value.inlineData?.mimeType?.startsWith("image/")) {
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

const PRICE_RATES = Object.freeze(["input", "output", "cacheRead", "cacheWrite"]);

/**
 * Does a call on this model cost money (issue #571)? True when any rate of its cost table, of one of its tiers, or of
 * an allowed fallback model's table (anthropic-messages bills a fallback answer at the fallback's rates) is above 0.
 * The Model object a call is dispatched on carries the cost pi composed (overlay entry, override and tiers applied),
 * so this reads it as it is. Through pi a table is never missing: pi's composer gives a model with no `cost` all zeros
 * (provider-composer.js, modelFromJson), so such a model is zero-rated here as it is in pi's own pricing. A Model
 * object built by hand with no table, or with a rate that is not a number, counts as priced: its price cannot be read,
 * which is not proof of a free call. An absent rate is 0, as pi's own tables never omit one.
 */
export function pricedModel(model) {
	const rateOf = (value) => value === undefined || (typeof value === "number" && value <= 0) ? 0 : 1;
	const priced = (table) => table === null || typeof table !== "object" || PRICE_RATES.some((key) => rateOf(table[key]) > 0);
	const cost = model?.cost;
	if (priced(cost)) return true;
	if (Array.isArray(cost.tiers) && cost.tiers.some(priced)) return true;
	const fallbacks = model?.compat?.allowedFallbackModels;
	return Array.isArray(fallbacks) && fallbacks.some((entry) => priced(entry?.cost) || (Array.isArray(entry?.cost?.tiers) && entry.cost.tiers.some(priced)));
}

/** An answer block that holds something the model produced: non-empty text or thinking, or a tool call. */
function answerContent(message) {
	if (!Array.isArray(message?.content)) return false;
	return message.content.some((block) => (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) || (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) || block?.type === "toolCall");
}

/**
 * Did this settled answer carry BROKEN usage (issue #571)? pi fills a missing usage block with zeros, and keeps the
 * part of a usage it did see, so a priced call's cost reads as about $0 though the provider billed it. True when the
 * answer has a finite `cost.total` (a missing one is the meter's `unpriced`, already a floor) and:
 *   (a) its input side (input + cacheRead + cacheWrite) is 0, and it is not a failed call that never started (that is
 *       the cost guard's `costUnanswered`: nothing came back, and nothing may have been billed);
 *   (b) it failed (`error` or `aborted`) after it started: its usage is partial (openai-completions and
 *       openai-responses report usage only at the stream's end, anthropic-messages what message_start carried);
 *   (c) it succeeded with answer content (answerContent) but an output count of 0, or of at most 1 on
 *       `anthropic-messages`, where pi keeps message_start's `output_tokens` (Anthropic sends 1) when a proxy's
 *       message_delta carries no output count (anthropic-messages.js at the pin). A genuine one-token answer there is
 *       floored too: the safe side.
 * Pure: `api` is the api of the model the call was dispatched on.
 */
export function unreportedUsage(message, api) {
	const usage = message?.usage;
	if (usage === null || typeof usage !== "object") return false;
	if (typeof usage.cost?.total !== "number" || !Number.isFinite(usage.cost.total)) return false;
	const failed = message?.stopReason === "error" || message?.stopReason === "aborted";
	if (failed) return started(message);
	if (finite(usage.input) + finite(usage.cacheRead) + finite(usage.cacheWrite) === 0) return true;
	if (!answerContent(message)) return false;
	const output = finite(usage.output);
	return output === 0 || (api === "anthropic-messages" && output <= 1);
}

/**
 * THE COST GUARD (issue #501; REQ-TOKEN-ACCOUNTING-AND-CAPS (d), DES-DOLLAR-RESERVE-AND-SETTLE). A guard for the
 * meter's seam: `{ enforces: [COST_CAP], admit, bind, snapshot }`.
 *
 * admit(call) refuses a call when `spent + inflight + bound > cap`, where `spent` is what settled calls cost and
 * `inflight` the bounds of calls admitted but not settled. With `external` (issue #500) the sum also holds
 * `external()`, spend in other processes, read at every admit: `spent + inflight + external() + bound > cap`. The in-flight sum is what makes parallel calls safe:
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
 * installer found displaced under the cap (calls there may have run unjudged and unmetered). A call whose dispatch
 * threw synchronously (the wrappers bind `undefined` for it) or returned neither a stream nor a promise stays charged
 * at its bound and, on a bound above 0, counts `costUnanswered` (issue #571): it was never answered, and the meter never
 * saw it. A slot merely flushed by the next admit (a synchronous forward) is charged its bound and not counted. A call
 * whose answer carries broken usage (unreportedUsage, the meter's own predicate) is charged at least its bound; the
 * guard keeps no counter for it: the meter counts it as `costUnreported` on every run, capped or not.
 *
 * WAITING (issue #985). Every parallel call holds its whole bound in flight, so six or seven parallel subagent calls
 * used to hold most of the cap and the next call stopped the job far below it, while each held call then settled at a
 * fraction of its bound. The cap stays a hard bound (CONST-BUDGET-BEFORE-TOKENS): nothing is under-reserved. Instead a
 * call offered as `waitable` (judge's WAITING) that does not fit, and is refused ONLY by holds that will settle, gets
 * COST_WAIT: `spent + (external() - its part in flight) + bound <= cap`, and something to wait for (a hold of ours in
 * flight, a hold in flight elsewhere, or a waiter ahead of it). The wrapper queues it (`wait(retry)`) and answers its
 * caller with a placeholder.
 * The queue is FIFO: a new waitable call queues behind every waiter even when it would fit, so a large call is never
 * starved by small ones. Every settle (and a refusal, which stops the job) schedules a DRAIN with queueMicrotask, never
 * synchronously: flushPending settles inside admit, and a drain there would re-enter admit and break the single pending
 * slot. The drain retries the front waiter and goes on while waiters are admitted or end; a 1 s timer drains too while
 * anyone waits, which picks up what no settle signals (a meter stop that is not a refusal, a STOP from outside, a
 * settle in another process); it is unref'd, but ref'd while nothing of ours is in flight (keepAlive). A waiter that
 * sees no progress (no settle of ours, no settle elsewhere: outsideNow) for COST_WAIT_IDLE_MS is refused `over-cap`, its
 * `cost_refused` line carrying `waited` (ms); so is one whose wait can no longer help (spend rose meanwhile). Log
 * lines, numbers only: `cost_wait` when a call starts waiting, `cost_waited { waitedMs }` when it is admitted. Deadlock: a waiter holds nothing, every hold belongs to a call already sent, whose settle depends only
 * on its own provider stream (result() is memoised and independent of the consumer), and a call that could be what a
 * held call waits for (a forward, a call from a provider or an onPayload) runs under HOLDING and never waits; what is
 * left is caught by the waiter's own 15 minute limit, the job's idle and stall limits, and abort.
 *
 * ACROSS PROCESSES (issue #985's second part). A role's parallel tasks run as pi child processes, each with its own
 * guard judging against the others' and the parent's holds through `external()`. `externalInflight()`, beside it, is
 * the part of that outside spend still IN FLIGHT (a parent: its children's open holds as of the last fold; a child:
 * SPENT's `inflight` less its own folded part), so a call refused only by holds in other processes waits for them as
 * it waits for holds of its own; without it every outside micro-dollar counts as settled and such a call is refused.
 * Admission still judges `external()` whole. Progress elsewhere is read by the timer's drain (every outsideNow). Every
 * process judges the others as of the last fold (up to a tick old), so a room that opens elsewhere is seen by every
 * process in the same reading. While ANY process of the job has a waiter (this queue, or `outsideWaiting()`), every
 * admission in every process, fresh calls included, therefore takes its TURN (`claim(waited)`, claimWait: one process
 * per SPENT generation admits, never in the generation right after another process's turn, and a call that waited
 * never in the first generation that shows the wait). When nobody waits anywhere no turn is taken and admission is what
 * it was, so the only overshoot across processes left is the one DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY names: the
 * pre-existing one-tick residual between fresh calls in different processes, including the tick in which a wait
 * begins and before it is published. Waiting itself adds no overshoot. The queue is per process: across processes there is no
 * order beyond the turns.
 *
 * The final payload may WAIT too: a waitable call whose final shaped request (prepare) does not fit only because of
 * others' holds releases its own hold, waits at the FRONT of the queue holding nothing, and takes the larger hold back
 * when room appears. Each priced api module's single send passes the hook's result, after the hook returns (pinned per
 * module in pinned-api.test.mjs, a write deeper inside the body or by a helper excepted), so releasing breaks no bound.
 * A non-waitable
 * call keeps the refusal. An onPayload that throws (refused, aborted, or the caller's hook threw) WITHHELD its request:
 * the provider awaits it before sending, so the call's settle does not count it `costUnanswered`.
 *
 * WHAT IT SAYS AFTERWARDS (issue #985). The job log was the only place a refusal's numbers were, and a run record's
 * `tokens.cost` could be a quarter of what the cap had charged with nothing saying why. So the guard keeps what it
 * charged (charges(): its spent, the part of it above pi's own price, `lifted`, and the calls that waited) and the first
 * refusal's numbers (refusal()), both read for the exit line and neither in snapshot().
 *
 * NOTIONAL calls (issue #1008). A call on a provider in `notional` (notionalProviders: a subscription with no paid extra
 * usage) is billed to nobody, so the cap does not count it: once its model passes the pinned-price checks it is admitted
 * at once, with no bound, no hold, no wait and no charge, and none of it reaches spend(), the number a child judges the
 * rest of the job by. It is admitted before the turn is read, so it never takes a turn, never waits behind a waiter and
 * never claims one (it takes no room), and it adds nothing to charges() (`costChargedMicros`, `costLiftedMicros`,
 * `costWaited`) or to a refusal's numbers. The meter still prices it into `tokens.cost` and `costNotional`. The checks stay because the price
 * a notional call is metered at must be the pinned one too. In a child process `notional` is the child's own set
 * (issue #1098): empty, so every call counts, unless it holds a subscription admission of its own (startChildMeter `admit`).
 */
/** Whether the call's model carries the pinned entry's api, cost (tiers included) and compat (fallbacks, maxTokensField). */
function pricedAsPinned(model, pinned) {
	if (pinned === null || typeof pinned !== "object") return false;
	return model?.api === pinned.api && samePayloadValue(model?.cost, pinned.cost) && samePayloadValue(model?.compat, pinned.compat);
}

/** The cost guard's answer for a call refused ONLY by other calls' holds (issue #985): wait for them. Never a stop. */
export const COST_WAIT = Symbol("cost-wait");
/** How long a waiter waits with no progress before it is refused `over-cap` (issue #985): pi-dispatch's default idle limit. */
export const COST_WAIT_IDLE_MS = 15 * 60 * 1000;
/** The drain timer's period while anyone waits (issue #985): the child-fold and re-arm tick's. */
export const COST_WAIT_TICK_MS = 1000;

export function createCostGuard({ capMicros, env = process.env, log = () => {}, bound = callCostBound, external = null, externalInflight = null, claim = null, outsideWaiting = null, onQueue = null, now = Date.now, setTimer = setInterval, clearTimer = clearInterval, notional = null }) {
	if (!Number.isSafeInteger(capMicros) || capMicros < 0) throw new Error(`invalid PI_MAX_COST_MICROS: ${capMicros}`);
	if (external !== null && typeof external !== "function") throw new Error("createCostGuard: external must be a function");
	if (externalInflight !== null && (typeof externalInflight !== "function" || external === null)) throw new Error("createCostGuard: externalInflight must be a function, beside external");
	if (claim !== null && typeof claim !== "function") throw new Error("createCostGuard: claim must be a function");
	if (outsideWaiting !== null && typeof outsideWaiting !== "function") throw new Error("createCostGuard: outsideWaiting must be a function");
	if (onQueue !== null && typeof onQueue !== "function") throw new Error("createCostGuard: onQueue must be a function");
	if (notional !== null && !(notional instanceof Set)) throw new Error("createCostGuard: notional must be a Set or null");
	// Issue #985, none of them in snapshot() (charges() and refusal() read them): `waited` counts the calls that waited,
	// each once (at admission, at its final payload, or both); `lifted` what settles charged above pi's own price (settle);
	// `refusal` the first refusal's numbers (refuse).
	const state = { spent: 0, inflight: 0, refused: 0, boundExceeded: 0, longContext: 0, unjudged: 0, unanswered: 0, waited: 0, lifted: 0, refusal: null, why: null };
	let pending = null;
	// The waiters (issue #985), FIFO: `{ retry, since }`, the front retried first. See WAITING in the header.
	const queue = [];
	let timer = null;
	// Whether the drain timer keeps the process alive now (keepAlive), and whether it never may again (close).
	let held = false;
	let closed = false;
	let draining = false;
	let drainScheduled = false;
	// The last progress a waiter could gain room from: a settle of ours, or a change elsewhere (outsideNow).
	let progressAt = now();
	let lastOutside = 0;
	let lastOutsideInflight = 0;
	// Whether onQueue last heard that someone waits here (notifyQueue), and whether a notice is already scheduled.
	let noticed = false;
	let noticeScheduled = false;

	/**
	 * Spend this guard does not see itself (issue #500), in micro-dollars, read at every admit: for a parent, what its
	 * children spent and hold in flight; for a child, what the parent's SPENT file says. Fail closed: anything but a
	 * finite number at or above zero, or a throw, is Infinity, so the call is refused rather than judged against 0.
	 */
	function externalMicros() {
		if (external === null) return 0;
		let value;
		try {
			value = external();
		} catch {
			return Infinity;
		}
		return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : Infinity;
	}

	/**
	 * The outside spend and the part of it still IN FLIGHT (issue #985): `{ outside, outsideInflight }`, read together at
	 * every judgement. `externalInflight()` is asked right after `external()`, and the wiring answers both from ONE
	 * reading (one fold for a parent, one read of SPENT for a child), so the two never come from different moments.
	 * What is in flight elsewhere settles at its real cost, which frees room, so a call refused only by it may WAIT for
	 * it (waitHelps); what is settled elsewhere never comes back. The in-flight part fails toward 0, never toward room: no
	 * reader, a throw, or anything but a finite number at or above zero is 0 (the call is then judged as before issue
	 * #985's second part, every outside micro-dollar settled), and it is never more than `outside`. It decides only
	 * whether a call waits or is refused; admission is judged on `outside` whole, so a wrong in-flight part can never
	 * admit a call the cap has no room for.
	 *
	 * PROGRESS for a waiter's idle limit: the outside spend fell (a hold elsewhere settled below its bound), its in-flight
	 * part fell (a hold settled, or its process ended), or, with the in-flight part known, its settled part rose (a hold
	 * elsewhere settled, its process taking the room again at once, so the in-flight part never showed the drop between
	 * two readings). A rise of the in-flight part alone is not progress: it is a new call taking room.
	 */
	function outsideNow() {
		const outside = externalMicros();
		let outsideInflight = 0;
		if (externalInflight !== null && Number.isFinite(outside)) {
			let value;
			try {
				value = externalInflight();
			} catch {
				value = 0;
			}
			outsideInflight = typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.min(value, outside) : 0;
		}
		if (Number.isFinite(outside)) {
			const settledRose = externalInflight !== null && outside - outsideInflight > lastOutside - lastOutsideInflight;
			if (outside < lastOutside || outsideInflight < lastOutsideInflight || settledRose) progressAt = now();
			lastOutside = outside;
			lastOutsideInflight = outsideInflight;
		}
		return { outside, outsideInflight };
	}

	/**
	 * Refuse a call: `fields` is what `cost_refused` logs. `seen` holds the in-flight sum and the outside spend the call
	 * was judged against, when they are not the log's (a final payload's: the in-flight sum without its own hold).
	 */
	function refuse(fields, seen = null) {
		state.refused += 1;
		// The FIRST refusal's rule (issue #507), the one that stopped the job: a refusal stops the meter, and a stopped
		// meter answers every later call before the guard is asked. The log line below stays as it was (an over-cap
		// refusal logs its `bound`, not a `why`); the exit line names the rule through refusedWhy().
		state.why ??= fields.why ?? "over-cap";
		// And its NUMBERS (issue #985, the exit line's `costRefusal`), so the run record says why the cap refused without
		// the job log: what the job had spent, what other calls held in flight, the spend outside this guard and the call's
		// bound. The first refusal's only, as `why`; none for a refusal with no bound (`unboundable`, `external`: its `why`
		// says why), and none unless each is a whole number once rounded up (rounding up only overstates the refusal).
		if (state.refused === 1 && typeof fields.bound === "number" && Number.isFinite(fields.bound)) {
			const numbers = { spentMicros: state.spent, inflightMicros: seen?.inflight ?? state.inflight, externalMicros: seen?.external ?? fields.external ?? 0, boundMicros: fields.bound };
			const rounded = Object.fromEntries(Object.entries(numbers).map(([key, value]) => [key, Math.ceil(value)]));
			state.refusal = Object.values(rounded).every((value) => Number.isSafeInteger(value) && value >= 0) ? rounded : null;
		}
		log("cost_refused", { ...fields, spent: state.spent, inflight: state.inflight, cap: capMicros });
		// The refusal stops the job: let the waiters see it now (each gets its hard stop) rather than at the next tick.
		scheduleDrain();
		return COST_CAP;
	}

	// ── The waiters (issue #985) ──

	/**
	 * Whether waiting can help a call of bound `b`: it fits once the holds settle (ours, and the in-flight part of the
	 * outside spend), and there is something to wait for: a hold of ours, a hold elsewhere, or a waiter ahead.
	 */
	function waitHelps(b, { outside, outsideInflight }, others, behind) {
		return state.spent + (outside - outsideInflight) + b <= capMicros && (others > 0 || outsideInflight > 0 || behind);
	}

	/**
	 * THE TURN (issue #985). While any process of the job has a waiter, every admission in every process takes a turn:
	 * `claim(waited)` wins the turn of the outside reading's SPENT generation (claimWait: one process per generation;
	 * the wiring also refuses the generation right after another process's turn, and, for a call that WAITED, a
	 * generation whose previous one did not already show someone waiting), asked right after that reading. No claim
	 * reader (no other process to share a room with): always. A throw or anything but true: not now.
	 */
	function claimed(waited) {
		if (claim === null) return true;
		try {
			return claim(waited) === true;
		} catch {
			return false;
		}
	}

	/**
	 * Whether an admission now must take its turn (issue #985): someone waits here (this queue) or in another process
	 * (`outsideWaiting()`, read with the outside reading: SPENT's `waiting` for a child, the fold of its children's
	 * ledgers for the parent). Fails toward taking the turn: a throw or anything but false is "someone waits". When
	 * nobody waits anywhere, admission is exactly what it was, no turn and no delay.
	 */
	function mustTakeTurn() {
		if (claim === null) return false;
		if (queue.length > 0) return true;
		if (outsideWaiting === null) return false;
		try {
			return outsideWaiting() !== false;
		} catch {
			return true;
		}
	}

	/**
	 * Tell `onQueue` (a child's ledger writer) when this process starts or stops having a waiter (issue #985), on a
	 * microtask, so the notice never runs inside admit and sees the queue as admit left it. A child publishes its
	 * waiting through its ledger, so every other process takes its turn while it waits.
	 */
	function notifyQueue() {
		if (onQueue === null || noticeScheduled) return;
		noticeScheduled = true;
		queueMicrotask(() => {
			noticeScheduled = false;
			const waitingNow = queue.length > 0;
			if (waitingNow === noticed) return;
			noticed = waitingNow;
			try {
				onQueue(queue.length);
			} catch {
				// A notice that fails is retried by the next change; the ledger's own writes carry the count too.
			}
		});
	}

	/** Whether a waiter has waited COST_WAIT_IDLE_MS with no progress since it started waiting. */
	function idle(waiter) {
		return now() - Math.max(waiter.since, progressAt) >= COST_WAIT_IDLE_MS;
	}

	function arm() {
		if (timer === null) {
			timer = setTimer(drain, COST_WAIT_TICK_MS);
			held = false;
			// Unref'd: a waiting call must never be the reason the runner stays alive while a call of its own is in flight.
			timer?.unref?.();
		}
		keepAlive();
	}

	/**
	 * Ref the drain timer while someone waits and nothing of this guard's is in flight (issue #985), unref it otherwise.
	 * Such a waiter waits for ANOTHER process's holds (waitHelps: with nothing of ours in flight, only a hold elsewhere is
	 * left to wait for), and nothing else need keep this process alive meanwhile: a call of our own in flight has its
	 * socket, a hold in another process has none here. Unref'd, a pi child in print mode whose one call waits for its
	 * siblings would leave the event loop empty and exit mid-call, its answer never given. Bounded as the wait is (an
	 * abort, a stop, the idle limit). After close() (the meter's teardown) never ref'd again: a waiter nobody answers any
	 * more must not hold the runner past its exit line.
	 */
	function keepAlive() {
		if (timer === null) return;
		const want = !closed && queue.length > 0 && state.inflight === 0;
		if (want === held) return;
		held = want;
		try {
			if (want) timer.ref?.();
			else timer.unref?.();
		} catch {
			// A timer that cannot be ref'd keeps the old behaviour: unref'd.
		}
	}

	/** Take a waiter off the queue; true when it was on it. The timer stops with the last one. */
	function remove(waiter) {
		const index = queue.indexOf(waiter);
		if (index < 0) return false;
		queue.splice(index, 1);
		notifyQueue();
		if (queue.length === 0 && timer !== null) {
			clearTimer(timer);
			timer = null;
			held = false;
		}
		return true;
	}

	/** Drain on a microtask, never synchronously (see WAITING in the header). */
	function scheduleDrain() {
		if (queue.length === 0 || drainScheduled) return;
		drainScheduled = true;
		queueMicrotask(() => {
			drainScheduled = false;
			drain();
		});
	}

	/**
	 * Retry the front waiter; go on while the front changes (admitted, refused, stopped, aborted), stop at the first
	 * that waits again. A retry never throws (waitTurn catches); one that did is dropped so the queue cannot jam.
	 */
	function drain() {
		if (draining) return;
		draining = true;
		try {
			while (queue.length > 0) {
				const front = queue[0];
				try {
					front.retry();
				} catch {
					remove(front);
				}
				if (queue[0] === front) break;
			}
		} finally {
			draining = false;
			// Every settle drains, so here is where an in-flight sum that fell to 0 meets a waiter still queued.
			keepAlive();
		}
	}

	/** Queue a deferred call: `retry()` is run by the drain. Returns the waiter the wrapper hands back on each retry. */
	function wait(retry) {
		const waiter = { retry, since: now() };
		queue.push(waiter);
		notifyQueue();
		state.waited += 1;
		arm();
		return waiter;
	}

	/** A waiter that ended outside admit (a stop, a model refusal, an abort, an admission): off the queue, the next one drained. */
	function leave(waiter) {
		if (remove(waiter)) scheduleDrain();
	}

	function settle(ticket, message) {
		if (ticket.settled) return;
		ticket.settled = true;
		// A settle frees room: the waiters are retried (issue #985).
		progressAt = now();
		scheduleDrain();
		const usage = message?.usage;
		state.inflight -= ticket.bound;
		const price = usage?.cost?.total;
		// `lifted` (issue #985, the exit line's costLiftedMicros): what the cap charges a call above pi's own price, its
		// whole bound for a call with no price, else its charge less that price rounded up, never below zero. So the
		// charge less the lift is what pi priced, call by call, and the lift is what the rules below add.
		if (typeof price !== "number" || !Number.isFinite(price)) {
			state.spent += ticket.bound;
			state.lifted += ticket.bound;
			return;
		}
		// Never below zero: calculateCost's short-write term goes negative when a provider reports more 1h writes
		// than writes (PR #534's review), and a negative charge would hand the cap room nobody paid for.
		const priced = Math.max(0, Math.ceil(price * 1e6));
		let charged = priced;
		// A FAILED or ABORTED call (PR #534's review). Its usage is partial: openai-completions and openai-responses
		// report usage only at the stream's end, anthropic-messages what message_start carried (the input and one
		// output token) until message_delta, so a stream cut after 2,000 output deltas settles at about 0, and pi then
		// auto-retries it. So a failed call that STARTED (the settled message holds any content block; usage counts
		// do not decide it, see started()) is charged at least its bound. One that never
		// started (a 429 or a 5xx before the stream, an in-band error before any content, a connection lost before the
		// answer) is charged its metered cost and counted as `costUnanswered`: charging it the bound would stop a
		// rate-limited job as cost-cap at $0 spent, and the counter tells a settlement the cost may be a floor, because
		// a provider that accepted the request and lost the answer may still bill it. One rule, every api. A call whose
		// onPayload threw (`withheld`, issue #985) never sent its request: it is not counted.
		//
		// Any other call whose usage is BROKEN is charged its bound too: the same predicate the meter counts
		// `costUnreported` by (unreportedUsage, issue #571: no input, a failure after it started, or answer content with
		// no output count), so what the cap charges and what the settlement floors cannot drift apart. The lift is not
		// counted here: the meter's counter is the one. A forwarding call is lifted all the same, though the meter does
		// not count it: the cap judges each call on its own worst case, and a router that answers itself after a failed
		// forward must not run under the cap at $0.
		const failed = message?.stopReason === "error" || message?.stopReason === "aborted";
		if (failed && !started(message)) {
			if (!ticket.withheld) state.unanswered += 1;
		} else if (failed || unreportedUsage(message, ticket.model?.api)) charged = Math.max(charged, ticket.bound);
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
		state.lifted += charged - priced;
	}

	/**
	 * A slot still held at the next admit or the snapshot: charged at its bound, and NOT counted. A call that dispatches
	 * another synchronously (a router's forward) leaves its own slot here when the forward is admitted, and that call
	 * is answered and metered like any other. Only a dispatch that threw, or returned no answer object, is counted
	 * (`bind`, issue #571).
	 */
	function flushPending() {
		if (pending === null) return;
		const ticket = pending;
		pending = null;
		settle(ticket, null);
	}

	/** A refusal of a call that may be a queued waiter: off the queue first, and its wait on the log line. */
	function refuseCall(waiter, fields) {
		if (waiter !== null && remove(waiter)) return refuse({ ...fields, waited: now() - waiter.since });
		return refuse(fields);
	}

	function admit({ method, model, args, priced, waitable = false, waiter = null }) {
		flushPending();
		// Issue #587's review: priced from the table pinned at install (pinPriceTable), never the caller's say-so. A call
		// whose api, cost or compat differs from its entry, or one with no entry, cannot be bounded honestly. `priced` is
		// undefined only when the meter was wired with no table at all, and then the call is judged on its own object.
		if (priced !== undefined && !pricedAsPinned(model, priced)) return refuseCall(waiter, { why: "unboundable" });
		const [context, options] = args ?? [];
		// A copy that held something other than plain data (snapshotModel): what pi would read is not what was judged.
		if (isUnreadable(model) || isUnreadable(options)) return refuseCall(waiter, { why: "unboundable" });
		// A notional call (issue #1008, NOTIONAL in the header): no bound, no hold, no charge. It takes no `pending`
		// slot, so prepare() and bind() leave it alone, and it never queues, since it takes no room.
		if (notional !== null && notional.has(model?.provider)) return null;
		const b = method === "generateImages" || method === "streamDeferred" ? Infinity : bound(method, model, context, options, env);
		if (!Number.isFinite(b)) return refuseCall(waiter, { why: "unboundable" });
		const reading = outsideNow();
		const { outside } = reading;
		if (!Number.isFinite(outside)) return refuseCall(waiter, { why: "external" });
		const queued = waiter !== null && queue.includes(waiter);
		// FIFO (issue #985): a waitable call that is not the front waiter waits behind the queue, even when it fits.
		const behind = waitable && queue.length > 0 && queue[0] !== waiter;
		const fits = !behind && state.spent + state.inflight + outside + b <= capMicros;
		// While someone waits anywhere, a call that fits takes its room only in its turn (THE TURN above): a waiter and a
		// call in another process see the same room in the same reading. Without its turn a call that WAITED waits on
		// (nothing settled, so no progress), and a fresh one that may wait starts waiting. One that may NOT wait (under an
		// admitted dispatch: a router's forward) is refused `over-cap`, as it was before waiting existed: admitted without
		// its turn it would take the room a waiter elsewhere takes in its turn, a way past the cap waiting would open.
		if (fits && (queued || mustTakeTurn()) && !claimed(queued)) {
			if (queued) return idle(waiter) ? refuseCall(waiter, { bound: b, ...outsideFields(reading) }) : COST_WAIT;
			if (waitable) {
				log("cost_wait", { why: "turn", bound: b, spent: state.spent, inflight: state.inflight, ...outsideFields(reading), cap: capMicros, waiting: queue.length });
				return COST_WAIT;
			}
			// Its own rule, `turn` (COST_REFUSALS): the call fits, so `over-cap` would send an operator to raise a cap that
			// cannot help; the exit line and the record say the stop came from a call that may not wait meeting a wait.
			return refuseCall(waiter, { why: "turn", bound: b, ...outsideFields(reading) });
		}
		if (fits) {
			if (queued) {
				remove(waiter);
				log("cost_waited", { waitedMs: now() - waiter.since });
			}
			state.inflight += b;
			pending = { bound: b, model, stream: !RUNTIME_RESULT_METHODS.includes(method), waitable, waited: queued };
			return null;
		}
		if (waitable && waitHelps(b, reading, state.inflight, behind) && !(queued && idle(waiter))) {
			if (!queued) log("cost_wait", { bound: b, spent: state.spent, inflight: state.inflight, ...outsideFields(reading), cap: capMicros, waiting: queue.length });
			return COST_WAIT;
		}
		return refuseCall(waiter, { bound: b, ...outsideFields(reading) });
	}

	/** The outside numbers a cost_wait or cost_refused line carries: `external` with a reader, `externalInflight` with its in-flight reader. */
	function outsideFields({ outside, outsideInflight }) {
		if (external === null) return {};
		return externalInflight === null ? { external: outside } : { external: outside, externalInflight: outsideInflight };
	}

	function bind(result) {
		const ticket = pending;
		pending = null;
		if (ticket === null) return;
		const done = (value) => settle(ticket, value);
		const failed = () => settle(ticket, null);
		// A stream method whose dispatch answered with a PROMISE of a stream (issue #571, observe() has where it comes
		// from) settles from that stream's result(). Its rejection is charged the bound, like a rejected result(), and the
		// meter counts the call `unpriced`, as it does for a result method's rejection: not counted here as well.
		// A stream ticket whose promise resolves to anything but a stream has no usage to settle from: the bound, as the
		// meter counts it `unpriced`.
		const settled = (value) => (!ticket.stream ? done(value) : typeof value?.result === "function" ? value.result().then(done, failed) : failed());
		if (typeof result?.result === "function") result.result().then(done, failed);
		else if (typeof result?.then === "function") result.then(settled, failed);
		else {
			// No answer object (issue #571): the wrappers bind `undefined` when the dispatch threw synchronously, and a
			// dispatch may return neither a stream nor a promise. Charged its bound and, on a bound above 0, counted as
			// `costUnanswered`: it was never answered, the meter never saw it, and a provider may still have received it.
			if (ticket.bound > 0) state.unanswered += 1;
			settle(ticket, null);
		}
	}

	/**
	 * The final-payload WAIT (issue #985): `ticket` has released its hold; wait at the FRONT of the queue until
	 * `enlarged` fits, then take it. Resolves once held; rejects (refusing as `final-payload` when the rule refuses) when
	 * waiting can no longer help, after COST_WAIT_IDLE_MS without progress, when the ticket settled, when the job
	 * stopped meanwhile (`stopped()`), or when the call's signal aborts. A rejection is the onPayload's throw.
	 */
	function waitForFinal({ ticket, enlarged, stop, stopped, signal }) {
		return new Promise((resolve, reject) => {
			let onAbort = null;
			const end = (error) => {
				remove(waiter);
				try {
					if (onAbort !== null) signal?.removeEventListener?.("abort", onAbort);
				} catch {
					// Nothing to undo.
				}
				if (error === null) resolve();
				else reject(error);
				scheduleDrain();
			};
			// The ticket holds nothing while it waits, so the in-flight sum is the others' holds; the outside spend is the
			// last reading's (the record's `costRefusal`, issue #985).
			const refuseFinal = (fields, external = lastOutside) => {
				refuse({ why: "final-payload", ...fields }, { inflight: state.inflight, external });
				stop(COST_CAP);
				end(new Error(STOP_MESSAGES[COST_CAP]));
			};
			const waiter = {
				since: now(),
				retry: () => {
					const reason = stopped?.() ?? null;
					if (reason !== null && Object.hasOwn(STOP_MESSAGES, reason)) return end(new Error(STOP_MESSAGES[reason]));
					if (ticket.settled) return refuseFinal({ bound: enlarged, waited: now() - waiter.since });
					const reading = outsideNow();
					if (!Number.isFinite(reading.outside)) return refuseFinal({ bound: enlarged, waited: now() - waiter.since }, reading.outside);
					if (state.spent + state.inflight + reading.outside + enlarged <= capMicros) {
						// As at admission: a call that waited takes its room only in its turn.
						if (!claimed(true)) return idle(waiter) ? refuseFinal({ bound: enlarged, waited: now() - waiter.since }, reading.outside) : undefined;
						state.inflight += enlarged;
						ticket.bound = enlarged;
						log("cost_waited", { waitedMs: now() - waiter.since });
						return end(null);
					}
					if (waitHelps(enlarged, reading, state.inflight, false) && !idle(waiter)) return undefined;
					return refuseFinal({ bound: enlarged, waited: now() - waiter.since }, reading.outside);
				},
			};
			queue.unshift(waiter);
			notifyQueue();
			// A call counts once: one that already waited at admission is not counted again here.
			if (!ticket.waited) state.waited += 1;
			ticket.waited = true;
			arm();
			onAbort = () => end(new Error(WAIT_ABORTED_MESSAGE));
			try {
				signal?.addEventListener?.("abort", onAbort, { once: true });
			} catch {
				onAbort = null;
			}
		});
	}

	function prepare({ method, model, args, stop, stopped = null }) {
		const ticket = pending;
		if (!ticket) return args;
		const [context, given = {}] = args ?? [];
		const theirs = given.onPayload;
		const onPayload = async function (payload, payloadModel) {
			try {
				const next = typeof theirs === "function" ? await theirs.call(this, payload, payloadModel) : undefined;
				let sent;
				let finalBound = Infinity;
				try {
					// Clone once and send exactly this plain JSON. The bound is the larger of the context's and this body's
					// (callCostBound's `body`, issue #985): the body adds every byte a provider or caller hook introduced,
					// and the context covers what a continued request leaves on the server.
					sent = JSON.parse(JSON.stringify(next === undefined ? payload : next));
					if (!isPlain(sent)) throw new Error("unboundable payload");
					const caps = [sent.max_tokens, sent.max_completion_tokens, sent.max_output_tokens, sent.config?.maxOutputTokens, sent.inferenceConfig?.maxTokens].filter((value) => value !== undefined && value !== null);
					if (caps.some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new Error("unboundable output cap");
					// A hook can remove or disable the cap it was given. The caller's options are no longer evidence of
					// the wire limit. An operator's completions server has no known default, so its missing/zero/negative
					// max_tokens refuses; a hosted adapter falls back to its catalog maximum through callCostBound.
					if (completionsOwnServer(model) && !(typeof sent.max_tokens === "number" && sent.max_tokens > 0)) throw new Error("unboundable output cap");
					const maxTokens = caps.length ? Math.max(...caps) : undefined;
					const longCache = (value) => value && typeof value === "object" && (value.cache_control?.ttl === "1h" || value.cachePoint?.ttl === "1h" || Object.values(value).some(longCache));
					const options = { ...given, maxTokens, ...(longCache(sent) ? { cacheRetention: "long" } : {}), ...(sent.n !== undefined ? { samplingParams: { ...given.samplingParams, n: sent.n } } : {}) };
					finalBound = bound(method, model, context, options, env, sent);
				} catch { /* A body we cannot bound must never reach the transport. */ }
				const enlarged = Math.max(ticket.bound, finalBound);
				const reading = outsideNow();
				const { outside } = reading;
				if (!ticket.settled && Number.isFinite(enlarged) && Number.isFinite(outside)) {
					const others = state.inflight - ticket.bound;
					const fits = state.spent + others + outside + enlarged <= capMicros;
					// A hold that grows is an admission of the growth: while someone waits anywhere it takes its turn too
					// (THE TURN). One that loses it waits at the front like a payload that does not fit, when it may wait;
					// an aborted one gives up unsent; one that may not wait is refused, by the rule `turn` as at admission
					// (grown without its turn, it would take a waiter's room elsewhere).
					const turnLost = fits && enlarged > ticket.bound && mustTakeTurn() && !claimed(false);
					if (turnLost && signalAborted(given.signal)) throw new Error(WAIT_ABORTED_MESSAGE);
					if (turnLost && !ticket.waitable) {
						refuse({ why: "turn", bound: enlarged }, { inflight: others, external: outside });
						stop(COST_CAP);
						throw new Error(STOP_MESSAGES[COST_CAP]);
					}
					if (fits && !turnLost) {
						state.inflight += enlarged - ticket.bound;
						ticket.bound = enlarged;
						ticket.sent = true;
						return sent;
					}
					// Issue #985: refused only by others' holds (or by its turn), on a call that may wait. Release, wait at
					// the front, retake.
					if (ticket.waitable && (turnLost || waitHelps(enlarged, reading, others, false))) {
						// A call whose signal is already aborted never waits, logs no wait and keeps its hold: an abort
						// listener would never fire for it, and its caller, being gone, would hold the front of the queue
						// until room appeared and then be sent.
						if (signalAborted(given.signal)) throw new Error(WAIT_ABORTED_MESSAGE);
						log("cost_wait", { why: turnLost ? "turn" : "final-payload", bound: enlarged, spent: state.spent, inflight: others, ...outsideFields(reading), cap: capMicros, waiting: queue.length });
						state.inflight -= ticket.bound;
						ticket.bound = 0;
						await waitForFinal({ ticket, enlarged, stop, stopped, signal: given.signal });
						ticket.sent = true;
						return sent;
					}
				}
				// The record's numbers (issue #985) are the others' holds: this call's own is the bound it asked to grow.
				refuse({ why: "final-payload", bound: Number.isFinite(enlarged) ? enlarged : null }, { inflight: ticket.settled ? state.inflight : state.inflight - ticket.bound, external: outside });
				stop(COST_CAP);
				throw new Error(STOP_MESSAGES[COST_CAP]);
			} catch (error) {
				// Each priced api module sends only after this hook returns (pinned), so a throw here withheld the request.
				if (!ticket.sent) ticket.withheld = true;
				throw error;
			}
		};
		return [context, { ...given, onPayload }, ...(args ?? []).slice(2)];
	}

	/** The exit line's cost fields, present only when a cap is set (run-job spreads them into `tokens`). */
	function snapshot() {
		flushPending();
		return { costCapMicros: capMicros, costRefused: state.refused, boundExceeded: state.boundExceeded, longContext: state.longContext, costUnjudged: state.unjudged, costUnanswered: state.unanswered };
	}

	/**
	 * What this guard holds (issue #500): `spentMicros` settled and `inflightMicros` admitted but not settled. The two
	 * numbers a child ledger carries and a parent's SPENT is made of. An accessor, NOT part of snapshot(), so the exit
	 * line stays exactly as it was. It settles no pending slot: a pending admission is already in `inflight`. A waiter
	 * holds nothing, so it is in neither.
	 */
	function spend() {
		return { spentMicros: state.spent, inflightMicros: state.inflight };
	}

	/** The installer's report of compat entries found displaced under the cap: calls there may have run unjudged. */
	function unjudged(count) {
		state.unjudged += count;
	}

	/** The first refusal's rule (a COST_REFUSALS member), or null when the guard refused nothing. NOT in snapshot(): `tokens` is numbers only. */
	function refusedWhy() {
		return state.why;
	}

	/**
	 * The first refusal's numbers (issue #985), `{ spentMicros, inflightMicros, externalMicros, boundMicros }` whole
	 * micro-dollars, or null: nothing refused, or a first refusal with none (see refuse). The exit line's `costRefusal`,
	 * beside `why` (costRefusalField), so NOT in snapshot().
	 */
	function refusal() {
		return state.refusal === null ? null : { ...state.refusal };
	}

	/**
	 * What this guard charged against the cap (issue #985): `spentMicros` (its settled spend, spend()'s), `liftedMicros`
	 * (the part of it above pi's own price: calls charged their bound, the long-context tier) and `waited` (the calls that
	 * waited for room). The exit line's costChargedMicros, costLiftedMicros and costWaited are these with the children's
	 * added (child-watch.mjs chargeFields). An accessor, NOT part of snapshot(), so its keys follow `modelRefused` on the
	 * line; like spend() it settles no pending slot, so the exit line reads it after snapshot(), which does.
	 */
	function charges() {
		return { spentMicros: state.spent, liftedMicros: state.lifted, waited: state.waited };
	}

	/**
	 * The meter's teardown (issue #985): the drain timer is never ref'd again (keepAlive), so a waiter left queued past
	 * the session that made it cannot keep the runner up after its exit line. Waiters still drain on the unref'd timer.
	 */
	function close() {
		closed = true;
		keepAlive();
	}

	/** How many calls wait here now (issue #985): what a child's ledger and the parent's SPENT publish as `waiting`. */
	function waiting() {
		return queue.length;
	}

	return { enforces: Object.freeze([COST_CAP]), admit, prepare, bind, wait, leave, close, waiting, snapshot, spend, charges, unjudged, refusedWhy, refusal, state };
}

// ── Issue #502, part 4: the allowed-model list, checked before every provider call ────────────────────────

/** The one spelling of a (provider, model) pair the guard compares: NUL cannot appear in either id. */
function pairKey(provider, model) {
	return `${provider}\u0000${model}`;
}

/**
 * The api that sends a model's `compat.allowedFallbackModels` to the provider (as `params.fallbacks`, model ids only)
 * and names a fallback answer in `responseModel`. Pinned by needle: it is the only api module that reads the field.
 */
const FALLBACK_API = "anthropic-messages";

/**
 * The samplingParams keys that pick, or widen, the model that answers, refused under a list on the three apis that
 * merge samplingParams into the request after it is built: `model` (bedrock's `modelId`), an OpenAI-compatible
 * router's `models` fallback list, anthropic's `fallbacks`, and `providerOptions`, where the Vercel AI Gateway reads
 * its own model fallbacks (`gateway.models`) and upstream order (PR #538's review, round 3).
 */
const SAMPLING_ROUTING_KEYS = Object.freeze(["model", "modelId", "models", "fallbacks", "providerOptions"]);

/**
 * Whether a call's sampling layers (samplingLayers: the model's samplingParams, EVERY samplingParamsByThinkingLevel
 * level, the call's) name a routing key (SAMPLING_ROUTING_KEYS), on the three apis that merge them into the request
 * after it is built (`resolveSamplingParams`, pinned). Every level, because pi picks the level per call (issue #587).
 * Only those keys, by decision (PR #538's review, round 2): any other key (`min_p`, `reasoning_effort`,
 * `chat_template_kwargs`, `service_tier`) changes how the model answers, never which model answers, so it passes under
 * a list alone. The cost guard keeps its own, wider price rule (`samplingOverridesRequest`). A layer that cannot be
 * read routes, so a list refuses it.
 */
function samplingRoutes(model, options) {
	if (!SAMPLING_OVERRIDE_APIS.has(model?.api)) return false;
	const layers = samplingLayers(model, options);
	if (layers === null) return true;
	return layers.some((layer) => SAMPLING_ROUTING_KEYS.some((key) => Object.hasOwn(layer, key)));
}

/**
 * THE ONE TABLE of what a payload hook may change under a list (PR #538's review, round 3, a lead decision): the
 * payload check is DENY BY DEFAULT. After the caller's `onPayload` (the session's `before_provider_request` hooks
 * included) runs, its result is compared with the payload pi built on EVERY key, at every depth, except these. A hook
 * may rewrite what is said and how it is sampled; anything else it adds, removes or changes (a model id, a fallback
 * list, google's `config.httpOptions`, whose URL path picks the model, a gateway's `providerOptions`, a field no one
 * has thought of yet) refuses the call. Enumerating the fields that route a request was tried first and missed two in
 * review; a list of what may change cannot miss a new way to route.
 *   - `top`: the message and content keys (`messages`, openai-responses' `input`, google's `contents`, anthropic's and
 *     bedrock's `system`, google's `systemInstruction`, `instructions`) and the sampling knobs, as TOP-LEVEL names only.
 *     Fail closed: a setting an api keeps elsewhere (bedrock's `inferenceConfig`, mistral's camelCase `maxTokens`,
 *     pi-messages' `context` and `options`) is not editable. Not `prompt` (on openai-responses a reference to a stored
 *     server-side prompt) and not `metadata` (a proxy such as LiteLLM can route on its tags);
 *   - `config`: inside google's `config` (google-generative-ai, google-vertex), only its sampling fields and its system
 *     instruction. Never `httpOptions`, and nothing else in it.
 */
const PAYLOAD_EDITABLE = Object.freeze({
	top: Object.freeze(["messages", "input", "contents", "system", "systemInstruction", "instructions", "temperature", "top_p", "top_k", "min_p", "stop", "seed", "presence_penalty", "frequency_penalty", "max_tokens", "max_output_tokens", "max_completion_tokens"]),
	config: Object.freeze(["temperature", "topP", "topK", "maxOutputTokens", "stopSequences", "systemInstruction"]),
});

/** A plain object: `{}` or `Object.create(null)`, never a class instance (an AbortSignal, a Date). */
function isPlain(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/**
 * A deep copy of pi's payload, taken BEFORE the hook runs, so a hook that edits it in place cannot also edit what it is
 * compared with. Plain objects and arrays are copied, typed arrays (bedrock's image bytes) are copied byte for byte,
 * and anything else (an AbortSignal in google's `config`, a function) is kept by reference, as pi built it. Each value is
 * read once, so a getter cannot answer the copy and the wire differently.
 */
function snapshotPayload(value, seen = new Map()) {
	if (value === null || typeof value !== "object") return value;
	if (ArrayBuffer.isView(value)) return value instanceof DataView ? value : value.slice();
	if (seen.has(value)) return seen.get(value);
	if (Array.isArray(value)) {
		const out = [];
		seen.set(value, out);
		for (const item of value) out.push(snapshotPayload(item, seen));
		return out;
	}
	if (!isPlain(value)) return value;
	const out = {};
	seen.set(value, out);
	for (const key of Object.keys(value)) out[key] = snapshotPayload(value[key], seen);
	return out;
}

/** Deep structural equality, as the wire sees it: plain objects by own keys, arrays and typed arrays by content, the rest by identity. */
function samePayloadValue(a, b, depth = 0) {
	if (Object.is(a, b)) return true;
	if (depth > 64) return false;
	if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
		if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.constructor !== b.constructor || a.byteLength !== b.byteLength) return false;
		return Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));
	}
	if (Array.isArray(a) || Array.isArray(b)) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		return a.every((item, index) => samePayloadValue(item, b[index], depth + 1));
	}
	if (!isPlain(a) || !isPlain(b)) return false;
	// Each value read ONCE (Object.entries), so a nested getter cannot answer the count and the comparison differently.
	const left = Object.entries(a).filter(([, value]) => value !== undefined);
	const right = new Map(Object.entries(b).filter(([, value]) => value !== undefined));
	if (left.length !== right.size) return false;
	return left.every(([key, value]) => right.has(key) && samePayloadValue(value, right.get(key), depth + 1));
}

/**
 * A key whose value is `undefined` is ABSENT, on both sides and at every level (PR #538's final review): pi's payloads
 * carry such keys (openai-completions' `prompt_cache_key`, bedrock's `additionalModelRequestFields`, pi-messages'
 * `options.*`), JSON drops them on the wire, and so does a hook that JSON-clones the payload, the common redaction
 * pattern. Counting them would refuse a hook whose request is byte-identical.
 */
function present(object, key) {
	return Object.hasOwn(object, key) && object[key] !== undefined;
}
function definedKeys(object) {
	return Object.keys(object).filter((key) => object[key] !== undefined);
}

/**
 * The payload to send after a hook, or null to refuse the call (PAYLOAD_EDITABLE has the rule). `before` is pi's payload
 * as snapshotted before the hook; `result` is the hook's return value, or pi's own object when the hook returned
 * nothing (it may have been edited in place). Refused: a result that is not a plain object (an array, a class instance),
 * one with a `toJSON` (own or inherited, which would replace the whole body when serialised) or an accessor on any key,
 * and any difference outside the editable keys. The object returned is FRESH: the editable keys as the hook left them,
 * every other key from the snapshot, which equals what the hook produced and which the hook never held. So the object
 * checked is the object sent, and pi never sends the hook's own object.
 */
function payloadAfterHook(before, result) {
	// A `toJSON` needs no rule of its own: an own one is an added key, an inherited one makes the result not plain.
	if (!isPlain(result)) return null;
	for (const key of Object.keys(result)) {
		if (!Object.hasOwn(Object.getOwnPropertyDescriptor(result, key), "value")) return null;
	}
	const sent = {};
	for (const key of definedKeys(result)) {
		if (PAYLOAD_EDITABLE.top.includes(key)) sent[key] = result[key];
		else if (!present(before, key)) return null;
	}
	for (const key of definedKeys(before)) {
		if (PAYLOAD_EDITABLE.top.includes(key)) continue;
		if (!present(result, key)) return null;
		if (key === "config" && isPlain(before.config) && isPlain(result.config)) {
			const config = {};
			for (const sub of definedKeys(result.config)) {
				if (PAYLOAD_EDITABLE.config.includes(sub)) config[sub] = result.config[sub];
				else if (!present(before.config, sub)) return null;
			}
			for (const sub of definedKeys(before.config)) {
				if (PAYLOAD_EDITABLE.config.includes(sub)) continue;
				if (!present(result.config, sub) || !samePayloadValue(before.config[sub], result.config[sub])) return null;
				config[sub] = before.config[sub];
			}
			sent.config = config;
			continue;
		}
		if (!samePayloadValue(before[key], result[key])) return null;
		sent[key] = before[key];
	}
	// The hook's own key order, so a hook that changes nothing sends the same bytes pi would have.
	const ordered = {};
	for (const key of Object.keys(result)) if (Object.hasOwn(sent, key)) ordered[key] = sent[key];
	return ordered;
}

/**
 * The options that pick the deployed model instead of model.id (`resolveDeploymentName` in pi-ai's
 * api/azure-openai-config.js, pinned): read by the azure-openai-responses api for any provider, and, since pi 1.0.3,
 * by the `azure` provider for EVERY api it serves (providers/azure.js rewrites `payload.model` in an onPayload wrapper
 * of its own, outside this guard's, so the payload check never sees the change; issue #587). Before 1.0.3 the
 * provider was `azure-openai-responses` and served one api.
 */
const AZURE_API = "azure-openai-responses";
const AZURE_PROVIDER = "azure";
const AZURE_DEPLOYMENT_MAP = "AZURE_OPENAI_DEPLOYMENT_NAME_MAP";

/**
 * The fallback that answered a settled call, or null: on anthropic-messages only (the one api that sends fallbacks),
 * a `responseModel` other than the requested id that is one of the requested model's `compat.allowedFallbackModels`.
 * Matched on the model id alone, whatever the entry's provider field says, because pi sends only the ids
 * (`{ model: fallback.model }`), so the provider may answer with any of them. Not every `responseModel` is a fallback:
 * openai-completions sets it for any chunk model other than the requested id, a provider's alias for the model asked
 * for, so other apis are never read here.
 */
function fallbackOf(model, message) {
	if (model?.api !== FALLBACK_API) return null;
	const answered = message?.responseModel;
	if (typeof answered !== "string" || answered === model.id) return null;
	const fallbacks = Array.isArray(model.compat?.allowedFallbackModels) ? model.compat.allowedFallbackModels : [];
	return fallbacks.find((fallback) => fallback?.model === answered) ?? null;
}

/**
 * THE MODEL GUARD (issue #502, part 4; REQ-MODEL-POLICY, DES-MODEL-POLICY-AT-THE-PROVIDER-WRAPPER). A guard for the
 * meter's seam: `{ enforces: [MODEL_NOT_ALLOWED], admit, prepare, bind, snapshot }`.
 *
 * admit(call) refuses a call whose REQUESTED model, `${model.provider}/${model.id}`, is not on the list. Exact and
 * case-sensitive, on BOTH halves of the pair: the same model id under another provider is another route, another
 * credential and another bill. Every method is judged the same way, so a classifier or an image model a flow uses
 * must be on the list like a chat model. A virtual model is never seen here on streamSimple (the wrapper skips it and
 * judges the physical call pi makes next); on any other method it is judged as itself.
 *
 * The id on the call is not the only thing that picks the model that answers (PR #538's review), so admit also refuses
 * a listed call whose request would name another one:
 *   - samplingParams naming a routing key (`samplingRoutes`, SAMPLING_ROUTING_KEYS) on the three apis that merge them
 *     after the request is built: a `model` key there replaces the requested one;
 *   - a call option `fetch`, which sends the request after every hook and so could rewrite it unseen (pi passes none);
 *   - on api azure-openai-responses, and on provider `azure` whatever the api (issue #587), `options.azureDeploymentName`
 *     or a per-call `options.env` deployment map, either of which picks the deployment instead of model.id;
 *   - on anthropic-messages, a `compat.allowedFallbackModels` entry whose pair (the model's provider and the
 *     fallback's id, which is what pi sends) is not on the list: pi sends those ids as `fallbacks`, and the provider
 *     may answer with any of them.
 * prepare(call) wraps the admitted call's `options.onPayload`, always, also when the caller passed none, because pi
 * hands the session's `before_provider_request` hooks to the provider through it. Deny by default (PAYLOAD_EDITABLE):
 * the wrapper snapshots pi's payload, runs the caller's hook, and refuses any difference outside the keys a hook may
 * edit (the messages and the sampling knobs), at any depth; it hands pi a fresh object built from the two
 * (`payloadAfterHook`). A refused payload makes the hook throw, so pi fails the call before it is sent, and the job
 * stops as for any refusal.
 *
 * A refusal counts `modelRefused`, logs `model_refused` with numbers and a fixed token only (`method`, `refused`,
 * `why`; never a model id, which the job chose), and returns or stops with MODEL_NOT_ALLOWED.
 *
 * bind(stream) watches the admitted call's answer for a server-side fallback (fallbackOf) and logs `model_fallback`
 * with the requested and the answering ids. With the fallback rule above every such answer is a listed model; the
 * line says which one answered. Single-slot, like the cost guard's: admit, prepare and the dispatch after them are
 * synchronous and adjacent in both wrappers.
 */
/**
 * pi's parseDeploymentNameMap (api/azure-openai-config.js, pinned by needle): `id=deployment` pairs, comma separated,
 * each side trimmed, an entry missing either side skipped.
 */
export function parseDeploymentNameMap(value) {
	const map = new Map();
	if (!value) return map;
	for (const entry of String(value).split(",")) {
		const trimmed = entry.trim();
		if (!trimmed) continue;
		const [modelId, deploymentName] = trimmed.split("=", 2);
		if (!modelId || !deploymentName) continue;
		map.set(modelId.trim(), deploymentName.trim());
	}
	return map;
}

export function createModelGuard({ allowedModels, log = () => {}, env = process.env, now = Date.now, subscriptionAdmission = null, subscriptions: givenSubscriptions = null, refreshCredentials = () => {} }) {
	if (!Array.isArray(allowedModels) || allowedModels.length === 0) throw new Error("invalid PI_ALLOWED_MODELS: want a non-empty list");
	// The operator's own deployment map, read ONCE, now (issue #587's review): the environment the worker gave the job
	// (PI_FORWARD_ENV, which env-allowlist.mjs tells an Azure operator to use for it). A map that arrives later (a stored
	// credential's env, an edit of process.env) is not this one, and the payload check refuses what it picks.
	// The map is pi-ai's own variable, reserved from run.secrets (provider-steering.mjs).
	const startDeployments = parseDeploymentNameMap(env?.[AZURE_DEPLOYMENT_MAP]);
	const allowed = new Set(allowedModels.map((entry) => pairKey(entry.provider, entry.model)));
	// The job runner hands its own verified entries (issue #888, part 3), the very objects a renewal moves forward
	// (subscription-credentials.mjs `refresh`), so this guard judges a call against the deadline the job holds NOW. A
	// child process reads them from the environment, which the runner rewrites on each renewal.
	let subscriptions;
	if (Array.isArray(givenSubscriptions)) subscriptions = givenSubscriptions;
	else {
		try { subscriptions = JSON.parse(env.PI_SUBSCRIPTION_AUTH ?? "[]"); } catch { subscriptions = null; }
	}
	const subscriptionProviders = new Set((Array.isArray(subscriptions) ? subscriptions : []).map((row) => row.provider));
	// Read at each call, never kept: a renewed access token arrives in the environment (credential-refresh.mjs).
	const subscriptionKeys = { has: (provider) => subscriptionProviders.has(provider), get: (provider) => subscriptionAccess(provider, env) };
	const state = { refused: 0 };
	let pending = null;

	function refuse(method, why) {
		state.refused += 1;
		log("model_refused", { method, why, refused: state.refused });
		return MODEL_NOT_ALLOWED;
	}

	/** Why a call on this model with these options would be answered by a model the list does not name, or null. */
	function offList(model, options) {
		if (!Array.isArray(subscriptions) || (subscriptions.length > 0 && (!model || !validateSubscriptionRequest(model, subscriptions, { now })))) return "subscription";
		if (subscriptionKeys.has(model?.provider)) {
			// Separate pi processes have the access env but no attested extension/runtime. They refuse until a
			// host-wired admission function establishes the same registration contract as this runner.
			if (!subscriptionAdmission || !subscriptionAdmission(model.provider)) return "subscription";
			if (subscriptionRequestOverrides(options, subscriptionKeys.get(model.provider)) || subscriptionRequestOverrides({ headers: model.headers }, subscriptionKeys.get(model.provider))) return "subscription";
		}
		const provider = model?.provider;
		const id = model?.id;
		if (typeof provider !== "string" || typeof id !== "string" || !allowed.has(pairKey(provider, id))) return "unlisted";
		// Issue #587's review: a model or options copy that held something other than plain data (snapshotModel).
		if (isUnreadable(model) || isUnreadable(options)) return "unreadable";
		if (samplingRoutes(model, options)) return "sampling";
		// A caller's own `fetch` sends the request after every hook ran, so it could rewrite the body unseen. pi never
		// passes one itself (only a caller does), so under a list it is refused rather than trusted.
		if (options?.fetch !== undefined) return "fetch";
		if ((model.api === AZURE_API || provider === AZURE_PROVIDER) && (options?.azureDeploymentName !== undefined || options?.env?.[AZURE_DEPLOYMENT_MAP] !== undefined)) return "deployment";
		if (model.api === FALLBACK_API) {
			const fallbacks = Array.isArray(model.compat?.allowedFallbackModels) ? model.compat.allowedFallbackModels : [];
			if (fallbacks.some((fallback) => !allowed.has(pairKey(provider, fallback?.model)))) return "fallback";
		}
		return null;
	}

	function admit({ method, model, args, legacy = false }) {
		// Refresh before reading/injecting the authoritative key; doing this inside prepareRequest
		// instead would make its override guard reject the old key just injected by this guard.
		refreshCredentials();
		if (legacy && model?.provider === "anthropic" && subscriptionKeys.has("anthropic")) return refuse(method, "subscription");
		pending = null;
		if (method === "classify" && model?.provider === "openai" && subscriptionKeys.has("openai")) return refuse(method, "subscription");
		const why = offList(model, args?.[1]);
		if (why !== null) return refuse(method, why);
		pending = model;
		return null;
	}

	function prepare({ method, model, args, stop }) {
		const options = args?.[1];
		const theirs = options?.onPayload;
		// Issue #587's review: on azure the deployment is resolved from options.env MERGED with the credential's own env
		// (ModelRuntime.prepareRequest, after admit), so a deployment map can arrive where admit cannot see it. The api
		// and the azure provider write that deployment as payload.model before this hook runs; it must be model.id.
		const deploymentChecked = model?.api === AZURE_API || model?.provider === AZURE_PROVIDER;
		// A `function`, so the caller's hook runs with the `this` pi gives it: pi calls `options.onPayload(...)` as a method
		// of the options object the provider received, which is this wrapper's `this` too.
		const onPayload = async function (payload, payloadModel) {
			let before = null;
			try {
				before = isPlain(payload) ? snapshotPayload(payload) : null;
			} catch {
				before = null;
			}
			if (deploymentChecked && (before === null || before.model !== (startDeployments.get(model.id) ?? model.id))) {
				refuse(method, "deployment");
				stop(MODEL_NOT_ALLOWED);
				throw new Error(STOP_MESSAGES[MODEL_NOT_ALLOWED]);
			}
			// The backstop (issue #587's review): the fallbacks pi itself put on the request, before any hook, must be on the
			// list under the model's provider, whatever admit read off the model.
			if (before !== null && present(before, "fallbacks") && !(Array.isArray(before.fallbacks) && before.fallbacks.every((fallback) => allowed.has(pairKey(model?.provider, fallback?.model))))) {
				refuse(method, "fallback");
				stop(MODEL_NOT_ALLOWED);
				throw new Error(STOP_MESSAGES[MODEL_NOT_ALLOWED]);
			}
			const next = typeof theirs === "function" ? await theirs.call(this, payload, payloadModel) : undefined;
			// The hook's result, or pi's payload as the hook may have changed it in place: compared, then sent as a fresh object.
			let sent = null;
			try {
				sent = before === null ? null : payloadAfterHook(before, next === undefined ? payload : next);
			} catch {
				sent = null;
			}
			if (sent === null) {
				refuse(method, "payload");
				stop(MODEL_NOT_ALLOWED);
				throw new Error(STOP_MESSAGES[MODEL_NOT_ALLOWED]);
			}
			return sent;
		};
		const prepared = [...(args ?? [])];
		prepared[1] = { ...(options ?? {}), onPayload, ...(subscriptionKeys.has(model?.provider) ? { apiKey: subscriptionKeys.get(model.provider) } : {}) };
		return prepared;
	}

	function bind(stream) {
		const model = pending;
		pending = null;
		if (model === null || typeof stream?.result !== "function") return;
		stream.result().then((message) => {
			const fallback = fallbackOf(model, message);
			if (fallback !== null) log("model_fallback", { provider: model.provider, requested: model.id, answered: fallback.model });
		}, () => {});
	}

	/** The exit line's model field, present only when a list is set (createPolicyGuard spreads it into `tokens`). */
	function snapshot() {
		return { modelRefused: state.refused };
	}

	return { enforces: Object.freeze([MODEL_NOT_ALLOWED]), admit, prepare, bind, snapshot, state };
}

/**
 * The providers whose calls are NOTIONAL in this runner (issue #1008): a subscription with no paid extra usage bills
 * nothing per call, so its list price is not money and leaves the cost cap and the dollar windows. A new Set, EMPTY
 * unless all of these hold, so any doubt counts the call against the cap:
 *   - `subscriptions` is a VERIFIED entry list (verifySubscriptionAuthEntries, adapter content included): the runner's
 *     own (run-job.mjs), or since issue #1098 a pi child's, verified by its own meter, never an unverified copy;
 *   - `subscriptionAdmission` is a function: the process wired the adapter's registration check, without which no call
 *     on that provider is a subscription call (a child without an admission of its own has none, and its model guard
 *     refuses every subscription call);
 *   - a model list is set, so the model guard exists: it refuses a subscription provider's call on another api or base
 *     URL (validateSubscriptionRequest) and injects the subscription's own key (createModelGuard `prepare`), so a call's
 *     provider says which credential carried it;
 *   - the provider's entry says `notional: true`, which the worker writes only for a connection with no paid extra
 *     usage (`extraUsageCreditMicros`): such a connection may bill any call and nothing tells which, so its calls count.
 *     An older worker never writes the key, so under it every call counts, as before.
 * run-job hands the one set to both the meter (`costNotional`) and the cost guard, so they cannot disagree.
 */
export function notionalProviders({ subscriptions = null, subscriptionAdmission = null, allowedModels = null } = {}) {
	if (!Array.isArray(subscriptions) || typeof subscriptionAdmission !== "function" || !Array.isArray(allowedModels) || allowedModels.length === 0) return new Set();
	return new Set(subscriptions.filter((row) => row?.notional === true && typeof row.provider === "string").map((row) => row.provider));
}

/**
 * THE SUBSCRIPTION ALLOWANCE (issue #1008; REQ-TOKEN-ACCOUNTING-AND-CAPS (d)). A guard for the meter's seam:
 * `{ enforces: [SUBSCRIPTION_ALLOWANCE], admit, snapshot }`.
 *
 * A notional call (a subscription with no paid extra usage, notionalProviders) leaves the cost cap, which bounds money,
 * and a subscription job without this allowance has no dollar limit at all. The allowance is the trigger's
 * `run.maxSubscriptionUsd`, sent as PI_SUBSCRIPTION_ALLOWANCE_MICROS: a limit on the LIST PRICE of the job's notional
 * calls. admit(call) refuses a call on a provider in `notional` once `settled()` (the meter's notionalMicros: the
 * settled list price of the notional calls so far, rounded up) is at or above `allowanceMicros`, and the refusal stops
 * the job (the meter's one stop) as SUBSCRIPTION_ALLOWANCE.
 *
 * Checked BETWEEN calls, on settled cost alone, and that is the whole difference from the cap: no bound, no hold, no
 * wait. The calls in flight when the allowance is reached still finish and are counted, so a job can end above its
 * allowance by what those calls cost. A notional call whose cost could not be read (no cost block, a total that is not a
 * finite number at or above 0, a rejected result) leaves the total unknown: `settled()` then reads Infinity and the next
 * notional call is refused, `why: "unreadable"`. A model priced at zero adds 0 and is not bounded, as the cap does not
 * bound it either; an answer whose usage counts are zero with a finite price adds that price. That is the owner's
 * decision for issue #1008: list price is not money, so the allowance is a budget for the work, not a hard ceiling,
 * and a call refused only because others were in flight would stop work the allowance had room for.
 *
 * NEVER a billed call. `notional` is the very set the cost guard admits without a charge, so a call outside it (an
 * API-key call, a call on a connection with paid extra usage, any call of a child process with no admission of its own)
 * passes here untouched and is judged by the cap alone; nothing here can admit a call the cap refused, because a guard
 * only refuses. A notional call's model must also carry its pinned price (pricedAsPinned, the cost guard's check), or
 * the price the meter settles it at, which this guard trusts, would be the caller's: refused, logged `why: "unboundable"`.
 * A `settled` that throws or answers anything but a finite number at or above zero fails closed. Log line
 * `subscription_allowance_refused`, numbers only.
 *
 * A malformed allowance on the queued job reaches the runner as 0 (the worker's fail-closed reading), so its first
 * notional call is refused. With no notional provider the guard refuses nothing.
 */
export function createAllowanceGuard({ allowanceMicros, notional = null, settled, log = () => {} }) {
	if (!Number.isSafeInteger(allowanceMicros) || allowanceMicros < 0) throw new Error(`invalid PI_SUBSCRIPTION_ALLOWANCE_MICROS: ${allowanceMicros}`);
	if (notional !== null && !(notional instanceof Set)) throw new Error("createAllowanceGuard: notional must be a Set or null");
	if (typeof settled !== "function") throw new Error("createAllowanceGuard: settled must be a function");
	const state = { refused: 0 };

	function refuse(fields) {
		state.refused += 1;
		log("subscription_allowance_refused", { ...fields, allowance: allowanceMicros });
		return SUBSCRIPTION_ALLOWANCE;
	}

	function admit({ model, priced }) {
		if (notional === null || !notional.has(model?.provider)) return null;
		if (priced !== undefined && !pricedAsPinned(model, priced)) return refuse({ why: "unboundable" });
		let spent;
		try {
			spent = settled();
		} catch {
			spent = NaN;
		}
		if (!(typeof spent === "number" && Number.isFinite(spent) && spent >= 0)) return refuse({ why: "unreadable" });
		return spent >= allowanceMicros ? refuse({ spent }) : null;
	}

	/** The exit line's allowance field, present only when an allowance is set (run-job spreads it into `tokens`). */
	function snapshot() {
		return { allowanceMicros };
	}

	return { enforces: Object.freeze([SUBSCRIPTION_ALLOWANCE]), admit, snapshot, state };
}

/**
 * The one guard the runner hands both meter halves (issues #501, #502): the model guard and the cost guard, in
 * THAT order, or null when neither policy is set (and then every call goes through exactly as before).
 *
 * MODEL FIRST, then cost. The list decides which provider may be called at all, so a call it forbids must be
 * refused as `model-not-allowed` whatever its price; judged the other way round, an unlisted call that also passed
 * the cap would be recorded as `cost-cap`, and an operator would raise a cap to fix a model choice. The order is
 * also the safe one for the cost guard's single slot: the cost guard is asked only for a call the model guard
 * already admitted, so a bound it takes into flight always belongs to a call that is then dispatched.
 *
 * `enforces` is the union, so assertPoliciesEnforceable sees each policy only when its own guard is here.
 * `snapshot()` is the cost fields (only with a cap) then `modelRefused` (only with a list), the worker's TOKEN_KEYS
 * order, so with no list the exit line is byte-identical to before. `unjudged` reaches the cost guard only: it is
 * the cap's counter of displaced compat entries.
 *
 * `notional` (issue #1008) is notionalProviders' set, which reaches the cost guard only while this guard has its model
 * half and a subscription admission: without them a call's provider does not prove which credential carried it.
 *
 * THE ALLOWANCE THIRD (issue #1008): with `allowanceMicros` set, createAllowanceGuard, given the same gated set and
 * `settledNotional` (the meter's notionalMicros). Its place is no matter for the cap's single slot either way: it
 * refuses only notional calls, which take no slot. It comes after the cost guard so that, under a cap, a notional call
 * off its pinned price is refused by the cap's own rule first (`cost-cap`, `unboundable`), as before the allowance
 * existed; without a cap the allowance refuses it itself. Installed
 * whenever an allowance is set, with no notional provider too (it then refuses nothing), so a job whose calls are all
 * billed is not refused as unenforceable. Its snapshot (`allowanceMicros`) comes after `modelRefused`, TOKEN_KEYS' order.
 */
export function createPolicyGuard({ maxCostMicros = null, allowedModels = null, log = () => {}, env = process.env, external = null, externalInflight = null, claim = null, outsideWaiting = null, onQueue = null, now = Date.now, setTimer = setInterval, clearTimer = clearInterval, subscriptionAdmission = null, subscriptions = null, refreshCredentials = () => {}, notional = null, allowanceMicros = null, settledNotional = null }) {
	const model = allowedModels === null ? null : createModelGuard({ allowedModels, log, env, now, subscriptionAdmission, subscriptions, refreshCredentials });
	const proven = model !== null && typeof subscriptionAdmission === "function" ? notional : null;
	// `external` (issue #500), its in-flight part and the turn's readers (issue #985) reach the cost guard only: they are
	// spend, which only a cap judges. The clock and the timer are its waiters' (issue #985), injected by tests.
	const cost = maxCostMicros === null ? null : createCostGuard({ capMicros: maxCostMicros, env, log, external, externalInflight, claim, outsideWaiting, onQueue, now, setTimer, clearTimer, notional: proven });
	const allowance = allowanceMicros === null ? null : createAllowanceGuard({ allowanceMicros, notional: proven, settled: settledNotional, log });
	const guards = [model, cost, allowance].filter((guard) => guard !== null);
	if (guards.length === 0) return null;
	return {
		enforces: Object.freeze(guards.flatMap((guard) => [...guard.enforces])),
		admit(call) {
			for (const guard of guards) {
				const refused = guard.admit(call);
				if (refused !== null && refused !== undefined) return refused;
			}
			return null;
		},
		prepare(call) {
			const args = model ? model.prepare(call) : call.args;
			return cost ? cost.prepare({ ...call, args }) : args;
		},
		bind(result) {
			for (const guard of guards) guard.bind?.(result);
		},
		// The cost guard's queue (issue #985), only with a cap: a guard without `wait` is never asked to wait.
		...(cost ? { wait: (retry) => cost.wait(retry), leave: (waiter) => cost.leave(waiter), close: () => cost.close(), waiting: () => cost.waiting() } : {}),
		unjudged(count) {
			cost?.unjudged(count);
		},
		/** The cost guard's spend() (issue #500), zeros without a cap. */
		spend() {
			return cost ? cost.spend() : { spentMicros: 0, inflightMicros: 0 };
		},
		/** The cost guard's refusedWhy() (issue #507), null without a cap. */
		refusedWhy() {
			return cost ? cost.refusedWhy() : null;
		},
		/** The cost guard's refusal() and charges() (issue #985), null without a cap. */
		refusal() {
			return cost ? cost.refusal() : null;
		},
		charges() {
			return cost ? cost.charges() : null;
		},
		snapshot() {
			return { ...(cost ? cost.snapshot() : {}), ...(model ? model.snapshot() : {}), ...(allowance ? allowance.snapshot() : {}) };
		},
		model,
		cost,
		allowance,
	};
}

// ── Issue #500: child ledgers, the files a pi child process reports its spend through ──────────────────────
//
// THE LEDGER FILE (issue #500; DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY). A pi child process runs its own meter and
// reports through one file in the run's ledger directory, which the parent folds on its tick (foldChildLedgers).
//   - Name: `<pid>.<nonce>.json` (CHILD_LEDGER_NAME): the child's pid in decimal, a nonce of 16 lowercase hex
//     characters. Any other name is ignored, so the directory can also hold the parent's `STOP` and `SPENT`, a wait
//     claim (`CLAIM.<gen>`, issue #985) and the temporary file of an atomic write (it must not end in `.json`).
//   - Written whole, by rename, as compact JSON of at most CHILD_LEDGER_MAX_BYTES (64 KiB).
//   - Every field is required, in every state:
//       { "v": 3,
//         "state": "starting" | "running" | "done",
//         "metered": true | false,
//         "totals": { "input", "output", "total", "cost", "calls", "unresolved", "unpriced", "sessions" },
//         "rows": [ { "provider", "model", "calls", "input", "output", "cacheRead", "cacheWrite", "cacheWrite1h",
//                     "reasoning", "total", "cost", "unpriced" } ],
//         "spentMicros", "inflightMicros", "costRefused", "modelRefused",
//         "boundExceeded", "costUnanswered", "costUnreported", "longContext", "costUnjudged", "waiting",
//         "waited", "liftedMicros", "refusedWhy", "costRefusal" }
//     `starting` is the preload's stub (zeros, `metered: true`), written before the meter installs; `running` once
//     it has; `done` at exit. `metered: false` says the child's meter did not install. `totals` is the child meter's
//     snapshot, `rows` its rows() (first-seen order, at most CHILD_LEDGER_ROWS written and CHILD_LEDGER_MAX_ROWS
//     read, a model-less row with both ids null), then its cost guard's spend(), both guards' refusal counters, the
//     cost guard's four floor counters (0 without a guard; the parent adds them to its own on the exit line, so a
//     child's partial count floors the job as the parent's would) and the METER's `costUnreported` (issue #571,
//     written with or without a guard; the parent's meter adds it through setChildren). childLedger() builds exactly
//     this object. Version 2 added the four guard counters, version 3 `costUnreported`; a file of an older version is
//     malformed (unmetered), so a child from an older image floors the job rather than hiding a call it did not count.
//     `waiting` (issue #985: how many calls wait in the child) is additive and optional: no version, and a file without
//     it, or with anything but a count, is read whole and counted as WAITING (ledgerWaiting), so every process takes its
//     turn rather than none. `waited` and `liftedMicros` (issue #985: how many of the child's calls waited for room, and
//     what its cost guard charged above pi's own price, both from its guard's charges()) are additive and optional the
//     same way, for the parent's exit line only (costWaited, costLiftedMicros): a file without them, or with anything but
//     a count, is read whole and counts them 0. No rule decides by them, so a floor of them misleads nothing.
//     `refusedWhy` and `costRefusal` (issue #985) are the child's cost guard's FIRST refusal: its rule (a COST_REFUSALS
//     member) and, when it had them, its four numbers (COST_REFUSAL_NUMBERS, whole micro-dollars), written only once the
//     guard refused. Optional the same way: a rule outside the set is absent, numbers that are not four whole ones are
//     absent, numbers without a rule are absent, and the file is read whole. The fold keeps the first one it reads
//     (`refusal`), which the parent records as the job's when that child's refusal is what stopped the job.
//   - Numbers only. Token amounts and `cost` are numbers from 0 to Number.MAX_SAFE_INTEGER; `calls`, `unresolved`,
//     `unpriced`, `sessions` and the guard counters are safe integers at least 0. Ids are printable ASCII and
//     match USAGE_ID_PATTERN after lowercasing, the worker's rule. The rows partition the totals: their calls sum to
//     `calls - unresolved`, and every other amount sums to its total.
//   - A fold reads at most CHILD_LEDGER_MAX_FILES names; any further name counts as unmetered unread.
//
// THE SPENT FILE (spentFile, externalFor). The parent tells each child what the rest of the job has spent, so a child's
// cost guard can judge the whole job without counting itself twice: `{ "v": 1, "total", "byLedger": { <name>: micros } }`,
// where `total` is the parent's own spend plus every ledger's `spentMicros + inflightMicros`, and `byLedger` is each
// ledger's part. A child's external spend is `total - byLedger[its own name]`. Issue #985 added three keys: the part of
// `total` still in flight, `"inflight"` (the parent's own in-flight plus every open, metered ledger's) and
// `"inflightByLedger": { <name>: micros }` (each such ledger's nonzero part), so a child's call refused only by holds
// that will settle waits for them (inflightFor: `inflight - inflightByLedger[its own name]`), and `"gen"`, the parent's
// count of SPENT writes, which names the one turn per generation every admission takes while anyone waits (claimWait),
// with `"waiting"` (how many calls wait anywhere in the job) and `"waitingSince"` (since which generation, only while
// someone waits). `v` stays 1: the keys are additive, a reader from before them ignores them (externalFor reads only the
// three above) and so refuses such a call as it always did (it takes no turn either, which cannot matter: the parent
// and its children run one image's runner), and a reader of them that meets a file without them (a
// parent from before) waits for nothing and takes no turn.
//
// What the fold trusts, and why it is cooperative accounting rather than a boundary: the agent holds the provider key
// and shares the runner's uid, so it can delete or forge these files. The rules make that fail toward a floor or an
// overcharge: a high-water mark per file; a file that shrinks, vanishes, is malformed in any part, or says
// `metered: false` counts ONCE as unmetered and keeps what it had reached; a forged larger number only overcharges.

/** A child ledger's file name: `<pid>.<nonce>.json`. */
export const CHILD_LEDGER_NAME = /^([1-9][0-9]{0,9})\.([0-9a-f]{16})\.json$/;
/** The largest ledger file the fold reads. Larger is malformed. */
export const CHILD_LEDGER_MAX_BYTES = 64 * 1024;
/** The most rows a ledger may carry. More is malformed. */
export const CHILD_LEDGER_MAX_ROWS = 256;
/**
 * The most rows a child meter WRITES (rows()): under half the read cap, so a ledger of worst-case rows (two 64-character
 * ids, every number at its longest) stays under CHILD_LEDGER_MAX_BYTES with 8 KiB to spare. child-ledger.test.mjs
 * builds that ledger through childLedger() and checks.
 */
export const CHILD_LEDGER_ROWS = 120;
/**
 * The most ledger names one fold reads. A job runs at most `--pids-limit=512` processes at once, so 512 ledgers is
 * every child a busy job can have alive; a name past it counts as unmetered without being opened. It bounds the tick's
 * synchronous reads and the marks held in memory against a flood of files in the directory.
 */
export const CHILD_LEDGER_MAX_FILES = 512;
export const CHILD_LEDGER_STATES = Object.freeze(["starting", "running", "done"]);
/**
 * The ledger format's version. 2 since the four floor counters (issue #500 part E's review), 3 since `costUnreported` (issue
 * #571), 4 since each row's `notional` (issue #1098): the part of its cost the child's own subscription admission let
 * through, which the parent counts notional only on a provider of its own verified set. Parent and child are always
 * one image, so no job holds two versions.
 */
export const CHILD_LEDGER_VERSION = 4;
/**
 * A COPY of the worker's id rule (worker/src/model-ref.mjs MODEL_REF_PATTERN, which run-history.mjs imports as
 * USAGE_ID_PATTERN), because the image does not carry the worker. A copy is held to its source by a test that reads
 * both (child-ledger.test.mjs). The worker refuses a whole usage block for one row it refuses, so a child row the fold
 * admits must be a row the worker admits.
 */
export const USAGE_ID_PATTERN = /^(?=.{1,64}$)[~@]?[a-z0-9][a-z0-9._:/@_-]*$/;

/**
 * Whether an id may name a ledger row: printable ASCII first, then the worker's rule after lowercasing. ASCII first
 * because lowercasing is not closed over ASCII (U+212A KELVIN SIGN lowercases to `k`), so a check after lowercasing
 * alone passes a 3-byte character per letter and a row three times the size the byte budgets assume.
 */
function recordableId(id) {
	return typeof id === "string" && /^[!-~]+$/.test(id) && USAGE_ID_PATTERN.test(id.toLowerCase());
}

const LEDGER_AMOUNTS = Object.freeze(["input", "output", "total", "cost"]);
const LEDGER_COUNTS = Object.freeze(["calls", "unresolved", "unpriced", "sessions"]);
const LEDGER_GUARD_COUNTS = Object.freeze(["spentMicros", "inflightMicros", "costRefused", "modelRefused", "boundExceeded", "costUnanswered", "costUnreported", "longContext", "costUnjudged"]);
/** The floor counters a ledger carries (version 3), the exit line's names: the cost guard's four and the meter's `costUnreported`. */
export const CHILD_FLOOR_COUNTERS = Object.freeze(["boundExceeded", "costUnanswered", "costUnreported", "longContext", "costUnjudged"]);
const ROW_AMOUNTS = Object.freeze(["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "total", "cost"]);
const ROW_COUNTS = Object.freeze(["calls", "unpriced", "providerBilled"]);
/** What only ever grows in a live child: everything but `unresolved` and `inflightMicros`. */
const MONOTONE_TOTALS = Object.freeze(["input", "output", "total", "cost", "calls", "unpriced", "sessions"]);
const MONOTONE_GUARD = Object.freeze(["spentMicros", "costRefused", "modelRefused", ...CHILD_FLOOR_COUNTERS]);

/**
 * An amount a ledger may carry: a number from 0 to Number.MAX_SAFE_INTEGER. The upper bound is what keeps a fold's
 * sums finite: two forged files at 1e308 would otherwise sum to Infinity, which no coercion can turn back into the
 * real children's spend. A larger number is malformed, so the file counts as unmetered (a floor).
 */
const amount = (value) => typeof value === "number" && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const whole = (value) => Number.isSafeInteger(value) && value >= 0;
/** Two sums of the same floats in another order agree to rounding, not to the bit. */
const agrees = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
/** A row's key: the pair, or "" for the model-less row (no id can be empty). */
const rowKey = (row) => (row.provider === null ? "" : `${row.provider}\u0000${row.model}`);

/** A ledger with nothing in it: the contribution of a file that was never good. */
function emptyLedger() {
	return { state: null, totals: { input: 0, output: 0, total: 0, cost: 0, calls: 0, unresolved: 0, unpriced: 0, sessions: 0 }, rows: new Map(), spentMicros: 0, inflightMicros: 0, costRefused: 0, modelRefused: 0, boundExceeded: 0, costUnanswered: 0, costUnreported: 0, longContext: 0, costUnjudged: 0, waited: 0, liftedMicros: 0 };
}

/**
 * One ledger's text, validated whole: the ledger (rows as a Map by key, duplicates summed) or null. Null for ANY
 * violation, so no part of a bad file is ever trusted. Unknown keys are ignored, never read.
 */
export function parseChildLedger(text) {
	let raw;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isPlain(raw) || raw.v !== CHILD_LEDGER_VERSION || !CHILD_LEDGER_STATES.includes(raw.state) || typeof raw.metered !== "boolean") return null;
	if (!isPlain(raw.totals)) return null;
	const totals = {};
	for (const key of LEDGER_AMOUNTS) {
		if (!amount(raw.totals[key])) return null;
		totals[key] = raw.totals[key];
	}
	for (const key of LEDGER_COUNTS) {
		if (!whole(raw.totals[key])) return null;
		totals[key] = raw.totals[key];
	}
	if (totals.unresolved > totals.calls) return null;
	const ledger = { state: raw.state, metered: raw.metered, totals, rows: new Map() };
	for (const key of LEDGER_GUARD_COUNTS) {
		if (!whole(raw[key])) return null;
		ledger[key] = raw[key];
	}
	if (!Array.isArray(raw.rows) || raw.rows.length > CHILD_LEDGER_MAX_ROWS) return null;
	const sum = { ...emptyRow() };
	for (const given of raw.rows) {
		if (!isPlain(given)) return null;
		const { provider, model } = given;
		const modelless = provider === null && model === null;
		const named = recordableId(provider) && recordableId(model);
		if (!modelless && !named) return null;
		const row = { provider: modelless ? null : provider, model: modelless ? null : model, ...emptyRow() };
		for (const key of ROW_AMOUNTS) {
			if (!amount(given[key])) return null;
			row[key] = given[key];
		}
		for (const key of ROW_COUNTS) {
			if (!whole(given[key])) return null;
			row[key] = given[key];
		}
		// Issue #1098: the row's notional mark, absent for 0, never above its own cost (a mark of more is not a ledger the
		// meter wrote). Absent is no mark: the row is charged in full.
		if (given.notional !== undefined && (!amount(given.notional) || (given.notional > given.cost && !agrees(given.notional, given.cost)))) return null;
		row.notional = given.notional === undefined ? 0 : Math.min(given.notional, given.cost);
		foldRow(sum, row);
		const key = rowKey(row);
		const into = ledger.rows.get(key);
		if (into) {
			foldRow(into, row);
			into.notional += row.notional;
		} else ledger.rows.set(key, row);
	}
	// The rows partition the totals (the meter's own invariant): a file whose rows say less than its totals, or more,
	// is not a ledger the meter wrote.
	if (sum.calls !== totals.calls - totals.unresolved || sum.unpriced !== totals.unpriced) return null;
	if (!LEDGER_AMOUNTS.every((key) => agrees(sum[key], totals[key]))) return null;
	// `waiting` (issue #985): how many calls wait in the child. Additive, so no version: anything but a safe integer at
	// or above zero, or its absence (a child from before it), is null, unknown, which the fold counts as waiting
	// (ledgerWaiting), never as not; it is not a reason to call the file malformed.
	ledger.waiting = Number.isSafeInteger(raw.waiting) && raw.waiting >= 0 ? raw.waiting : null;
	// `waited` and `liftedMicros` (issue #985), additive too: absent or not a count reads 0 (the exit line's own counts,
	// never a decision), and the file is not malformed for it.
	ledger.waited = whole(raw.waited) ? raw.waited : 0;
	ledger.liftedMicros = whole(raw.liftedMicros) ? raw.liftedMicros : 0;
	// The child's first cost refusal (issue #985), additive too: a malformed part is absent, never a malformed file.
	ledger.refusedWhy = COST_REFUSALS.includes(raw.refusedWhy) ? raw.refusedWhy : null;
	ledger.costRefusal = ledger.refusedWhy !== null && isPlain(raw.costRefusal) && COST_REFUSAL_NUMBERS.every((key) => whole(raw.costRefusal[key])) ? Object.fromEntries(COST_REFUSAL_NUMBERS.map((key) => [key, raw.costRefusal[key]])) : null;
	return ledger;
}

/** Whether `next` reached at least `high` in everything that only grows, row by row included. */
function reached(high, next) {
	if (!MONOTONE_TOTALS.every((key) => next.totals[key] >= high.totals[key])) return false;
	if (!MONOTONE_GUARD.every((key) => next[key] >= high[key])) return false;
	for (const [key, row] of high.rows) {
		const now = next.rows.get(key);
		if (!now || ![...ROW_AMOUNTS, ...ROW_COUNTS, "notional"].every((field) => (now[field] ?? 0) >= (row[field] ?? 0))) return false;
	}
	return true;
}

const GONE = Symbol("gone");
const BAD = Symbol("bad");
const UNCHANGED = Symbol("unchanged");

/**
 * A file's identity and version, from a bigint stat: inode, size, and the change and modify times in nanoseconds.
 * A rename (the format's only way to write) changes the inode; an in-place write changes the ctime, which no user can
 * set back. Equal signatures mean the bytes the last read saw.
 */
function signature(stat) {
	return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

/**
 * One file's `{ text, sig }`, or GONE (it vanished after the listing), BAD, or UNCHANGED (its signature is `known`, so
 * there is nothing new to read). Stat'ed first without following a link, so an unchanged file costs one lstat. Then
 * opened without following a symlink and without blocking (a FIFO opened for reading would hang the runner's event
 * loop, and with it every brake), held to a regular file of at most CHILD_LEDGER_MAX_BYTES, and read through the
 * descriptor so a swap after the check reads nothing new. Strict UTF-8.
 */
function readLedger(fs, path, known, maxBytes = CHILD_LEDGER_MAX_BYTES) {
	try {
		if (known !== null && signature(fs.lstatSync(path, { bigint: true })) === known) return UNCHANGED;
	} catch (error) {
		return error?.code === "ENOENT" ? GONE : BAD;
	}
	let fd;
	try {
		fd = fs.openSync(path, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
	} catch (error) {
		return error?.code === "ENOENT" ? GONE : BAD;
	}
	try {
		const stat = fs.fstatSync(fd, { bigint: true });
		if (!stat.isFile() || stat.size > BigInt(maxBytes)) return BAD;
		const buffer = Buffer.alloc(maxBytes + 1);
		let length = 0;
		while (length < buffer.length) {
			const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
			if (read === 0) break;
			length += read;
		}
		if (length > maxBytes) return BAD;
		return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)), sig: signature(stat) };
	} catch {
		return BAD;
	} finally {
		try {
			fs.closeSync(fd);
		} catch {
			// Nothing to do: the descriptor is gone either way.
		}
	}
}

const DEFAULT_LEDGER_FS = { readdirSync, lstatSync, openSync, fstatSync, readSync, closeSync, constants };

/**
 * Fold every child ledger in `dir` (issue #500): PURE apart from the injected `fs`, and cumulative through `prev`, the
 * last call's result (null the first time). Never throws. The rules (the ledger comment above has the why):
 *   - each file keeps a HIGH-WATER mark, its last good ledger, and contributes that;
 *   - a good ledger that reached its high-water mark in everything that only grows (every total but `unresolved`,
 *     every row, the guard counters but `inflightMicros`) replaces it;
 *   - a file that is malformed in any part, says `metered: false`, shrank in anything, or vanished is counted
 *     unmetered ONCE, keeps the mark it had (nothing, if it was never good) and is never read again;
 *   - a file that vanished between the listing and the read is a vanished file if it was known, and unseen if not;
 *   - a file whose signature has not changed since its last read is not read again (one lstat; it is still listed,
 *     so it can still vanish). A `done` file is read like any other: `state` is not a number the mark holds, so a
 *     forged `done` with unchanged numbers would otherwise blind the fold to a live child's later writes;
 *   - RETIREMENT (issue #500 part E's review): a file, in ANY state, whose process `retire(pid, name, entry)` says is
 *     gone is folded into the `retired` aggregate as it stands (its mark, its charge, its pid; a `running` file's
 *     unresolved calls stay counted) and its name is kept in a set, so it is never read or listed again; a file of a
 *     live process, an unmetered one, or any with no `retire`, stays tracked. A child killed with SIGKILL never
 *     writes `done`, and must not hold an open slot for the rest of the job. A dead child's file cannot change
 *     what it reported, and a job that runs thousands of short pi children over its life must not flood;
 *   - at most CHILD_LEDGER_MAX_FILES OPEN names (tracked, not `done`, not already unmetered) are read; a new name past
 *     that is counted in `flooded`, unmetered and unread. `flooded` is a high-water mark of how many such names one
 *     listing held.
 * Returns `{ processes, unmetered, flooded, totals, rows, spentMicros, inflightMicros, costRefused, modelRefused,
 * boundExceeded, costUnanswered, costUnreported, longContext, costUnjudged, settledMicros, chargeMicros,
 * liveInflightMicros, liveWaiting, waited, liftedMicros, refusal, missing, files, retired }`:
 * `processes` the ledger files ever seen (flooded and retired ones included), `unmetered` those counted unmetered
 * (flooded ones included), `totals` and the counters summed over every file's mark and the retired aggregate, `rows`
 * merged by pair (the model-less row last, ids null), `settledMicros` the sum of each ledger's ledgerSettled() and
 * `chargeMicros` of its ledgerCharge(), `liveInflightMicros` of each tracked file's ledgerInflight() (issue #985: the
 * part of `chargeMicros` a settle can still free) and `liveWaiting` of its ledgerWaiting(), `missing` true when the directory could not be listed, `files` the per-file
 * state for the next call (a Map by name of `{ pid, state, unmetered, why, high, sig }`, `why` one of `malformed`,
 * `unmetered`, `shrank`, `vanished`), which the detector reads for a file's pid and state, and `retired` the
 * aggregate (`{ count, names, pids, high, charge, settled }`). `refusal` is the first child cost refusal a fold read,
 * `{ why, numbers }` (issue #985), or null. `meter.setChildren()` takes the result as it is.
 */
export function foldChildLedgers({ dir, fs = DEFAULT_LEDGER_FS, prev = null, retire = null, notional = null } = {}) {
	const files = new Map(prev?.files ?? []);
	const retired = prev?.retired
		? { ...prev.retired, names: new Set(prev.retired.names), pids: new Set(prev.retired.pids), high: cloneLedger(prev.retired.high) }
		: { count: 0, names: new Set(), pids: new Set(), high: emptyLedger(), charge: 0, settled: 0, notional: 0 };
	let names = [];
	let missing = false;
	try {
		names = [...fs.readdirSync(dir)].map(String).sort();
	} catch {
		missing = true;
	}
	const present = new Set();
	// The first child cost refusal any fold read (issue #985), kept through `prev`; in one pass, the first by file name.
	let refusal = prev?.refusal ?? null;
	let open = 0;
	for (const entry of files.values()) if (!entry.unmetered && entry.state !== "done") open += 1;
	let beyond = 0;
	for (const name of names) {
		const match = CHILD_LEDGER_NAME.exec(name);
		if (!match || retired.names.has(name)) continue;
		const before = files.get(name) ?? null;
		if (before === null && open >= CHILD_LEDGER_MAX_FILES) {
			beyond += 1;
			continue;
		}
		if (before?.unmetered) {
			present.add(name);
			continue;
		}
		const read = readLedger(fs, join(dir, name), before?.sig ?? null);
		if (read === GONE) continue;
		present.add(name);
		if (read === UNCHANGED) continue;
		const ledger = read === BAD ? null : parseChildLedger(read.text);
		const high = before?.high ?? emptyLedger();
		const pid = Number(match[1]);
		const why = ledger === null ? "malformed" : !ledger.metered ? "unmetered" : before !== null && !reached(high, ledger) ? "shrank" : null;
		const next = why === null
			? { pid, state: ledger.state, unmetered: false, why: null, high: ledger, sig: read.sig }
			: { pid, state: ledger?.state ?? before?.state ?? null, unmetered: true, why, high, sig: null };
		if (why === null && refusal === null && ledger.refusedWhy !== null) refusal = { why: ledger.refusedWhy, numbers: ledger.costRefusal };
		const wasOpen = before !== null && !before.unmetered && before.state !== "done";
		const isOpen = !next.unmetered && next.state !== "done";
		open += (isOpen ? 1 : 0) - (wasOpen ? 1 : 0);
		files.set(name, next);
	}
	for (const [name, entry] of files) {
		if (!present.has(name) && !entry.unmetered) files.set(name, { ...entry, unmetered: true, why: "vanished" });
	}
	if (typeof retire === "function") {
		for (const [name, entry] of files) {
			let gone = false;
			try {
				gone = !entry.unmetered && retire(entry.pid, name, entry) === true;
			} catch {
				gone = false;
			}
			if (!gone) continue;
			files.delete(name);
			retired.names.add(name);
			retired.pids.add(entry.pid);
			retired.count += 1;
			addLedger(retired.high, entry.high);
			retired.charge = saturatingAdd(retired.charge, ledgerCharge(entry.high, notional));
			retired.settled = saturatingAdd(retired.settled, ledgerSettled(entry.high, notional));
			retired.notional = (retired.notional ?? 0) + ledgerNotional(entry.high, notional);
		}
	}
	const flooded = Math.max(prev?.flooded ?? 0, beyond);

	const sum = cloneLedger(retired.high);
	let unmetered = flooded;
	let chargeMicros = retired.charge;
	let settledMicros = retired.settled;
	// Issue #1098: the children's notional cost, in dollars, the part of `totals.cost` ledgerNotional counts.
	let notionalCost = retired.notional ?? 0;
	let liveInflightMicros = 0;
	let liveWaiting = 0;
	for (const entry of files.values()) {
		if (entry.unmetered) unmetered += 1;
		addLedger(sum, entry.high);
		chargeMicros = saturatingAdd(chargeMicros, ledgerCharge(entry.high, notional));
		settledMicros = saturatingAdd(settledMicros, ledgerSettled(entry.high, notional));
		notionalCost += ledgerNotional(entry.high, notional);
		liveInflightMicros = saturatingAdd(liveInflightMicros, ledgerInflight(entry));
		liveWaiting = saturatingAdd(liveWaiting, ledgerWaiting(entry));
	}
	// The model-less row last, as usageSnapshot emits its bucket.
	const merged = new Map(sum.rows);
	const modelless = merged.get("");
	merged.delete("");
	const rows = [...merged.values(), ...(modelless ? [modelless] : [])];
	const counters = Object.fromEntries(LEDGER_GUARD_COUNTS.map((key) => [key, sum[key]]));
	return { processes: files.size + flooded + retired.count, unmetered, flooded, totals: sum.totals, rows, ...counters, settledMicros, chargeMicros, notionalCost, liveInflightMicros, liveWaiting, waited: sum.waited, liftedMicros: sum.liftedMicros, refusal, missing, files, retired };
}

/** A copy of a ledger mark, its rows copied too. */
function cloneLedger(ledger) {
	return { ...ledger, totals: { ...ledger.totals }, rows: new Map([...ledger.rows].map(([key, row]) => [key, { ...row }])) };
}

/** Add `from`'s totals, counters and rows into `into`, in place. */
function addLedger(into, from) {
	for (const key of Object.keys(into.totals)) into.totals[key] += from.totals[key];
	for (const key of LEDGER_GUARD_COUNTS) into[key] += from[key];
	// Issue #985's two optional counts: a mark from before them (none) adds nothing.
	for (const key of ["waited", "liftedMicros"]) into[key] = saturatingAdd(into[key] ?? 0, from[key] ?? 0);
	for (const [key, row] of from.rows) {
		const there = into.rows.get(key);
		if (there) {
			foldRow(there, row);
			there.notional = (there.notional ?? 0) + (row.notional ?? 0);
		} else into.rows.set(key, { ...row });
	}
}

const saturatingAdd = (a, b) => Math.min(Number.MAX_SAFE_INTEGER, a + b);

/**
 * What a ledger has SETTLED, in whole micro-dollars (issue #500 part E's review): the larger of its cost guard's
 * `spentMicros` and its metered `totals.cost`, rounded up. A child with no cost guard (its spawner dropped
 * PI_MAX_COST_MICROS from its environment) reports `spentMicros: 0` while its meter still prices every call, so the
 * cost is what counts it. Saturates at Number.MAX_SAFE_INTEGER.
 */
export function ledgerSettled(high, notional = null) {
	// Issue #1098: a child's calls on the job's notional providers are notional, as the runner's own are: they leave the
	// cap (the child's own cost guard admitted them without a charge), so they leave what the parent charges it too.
	const cost = Math.ceil(Math.max(0, (high?.totals?.cost ?? 0) - ledgerNotional(high, notional)) * 1e6);
	const value = Math.max(high?.spentMicros ?? 0, Number.isFinite(cost) ? cost : Number.MAX_SAFE_INTEGER);
	return Math.min(Number.MAX_SAFE_INTEGER, value);
}

/** What a ledger holds against a cap: ledgerSettled() plus its in-flight bounds. */
export function ledgerCharge(high, notional = null) {
	return saturatingAdd(ledgerSettled(high, notional), high?.inflightMicros ?? 0);
}

/**
 * Issue #1098: the notional part of a ledger mark's cost: what its rows on the job's `notional` providers (the runner's
 * notionalProviders set) marked as notional (CHILD_LEDGER_VERSION 4), 0 with none. A row's provider is the model's it
 * dispatched on; the model-less row names none and is never notional.
 */
export function ledgerNotional(high, notional = null) {
	if (!(notional instanceof Set) || notional.size === 0 || !(high?.rows instanceof Map)) return 0;
	let sum = 0;
	// Both, never one: the child MARKED the row's cost as let through by its own subscription admission (a child with no
	// admission marks nothing, whatever provider its billed key is filed under), AND the row's provider is in the
	// runner's own verified set (a mark on a provider the runner does not hold notional is a billed call).
	for (const row of high.rows.values()) if (typeof row?.provider === "string" && notional.has(row.provider) && amount(row.cost) && amount(row.notional)) sum += Math.min(row.notional, row.cost);
	return sum;
}

/**
 * The part of a tracked ledger's charge still IN FLIGHT that its process can still settle (issue #985), from a fold's
 * per-file entry: its mark's `inflightMicros`, but 0 for a file counted unmetered (never read again, so its mark cannot
 * fall) and for a `done` one (its process is ending: a call it still held never settles). A call that waited for such
 * a hold would wait for nothing, so it counts as settled here, like every retired file's charge.
 */
export function ledgerInflight(entry) {
	if (!entry || entry.unmetered || entry.state === "done") return 0;
	const value = entry.high?.inflightMicros ?? 0;
	return typeof value === "number" && value >= 0 ? Math.min(value, Number.MAX_SAFE_INTEGER) : 0;
}

/**
 * How many calls wait in a tracked ledger's child (issue #985), from a fold's per-file entry: its mark's `waiting`, 0 for
 * a file counted unmetered or `done` (as ledgerInflight), and 1 when it is unknown (a child from before the key, or a
 * value that is not a count): a child that may be waiting makes every process take its turn, never the reverse.
 */
export function ledgerWaiting(entry) {
	if (!entry || entry.unmetered || entry.state === "done") return 0;
	const value = entry.high?.waiting;
	return Number.isSafeInteger(value) && value >= 0 ? value : 1;
}

/**
 * The SPENT file the parent writes for its children (issue #500; the ledger comment above has the format): `total` is
 * `parentMicros` (the parent's own spent plus in-flight) plus every ledger's ledgerCharge() (retired ones included),
 * and `byLedger` each tracked ledger's part, by file name. Since issue #985 also the IN-FLIGHT part of that total:
 * `inflight` is `parentInflightMicros` (the parent's own in-flight, part of `parentMicros`) plus every tracked
 * ledger's ledgerInflight(), and `inflightByLedger` each tracked ledger's nonzero part, by file name, so a child can
 * wait for holds that will settle instead of being refused by them (inflightFor). Each part is at most the matching
 * charge, so `inflight` never passes `total`. And `gen`, the parent's count of SPENT writes (`generation`, from 1), which
 * names the TURN an admission takes against this file while anyone waits (claimWait), with `waiting`, how many calls
 * wait anywhere in the job (the parent's own and its children's, ledgerWaiting), and `waitingSince`, the generation
 * since which someone has waited without a break (only while someone waits). A number that cannot be carried
 * saturates at Number.MAX_SAFE_INTEGER.
 */
export function spentFile(fold, parentMicros, parentInflightMicros = 0, generation = null, waiting = 0, waitingSince = null, notional = null) {
	// Whole micro-dollars, rounded UP: externalFor() reads only safe integers, so the writer must never emit a file its
	// own reader refuses, and rounding up only overcharges.
	const carry = (value) => (typeof value === "number" && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? Math.ceil(value) : Number.MAX_SAFE_INTEGER);
	const byLedger = {};
	const inflightByLedger = {};
	let total = saturatingAdd(carry(parentMicros), carry(fold?.retired?.charge ?? 0));
	let inflight = Math.min(carry(parentInflightMicros), carry(parentMicros));
	for (const [name, entry] of fold?.files ?? []) {
		// Issue #1098: its notional calls are no charge, as in the fold (`notional`, the job's set; null outside a subscription job).
		const part = carry(ledgerCharge(entry.high, notional));
		byLedger[name] = part;
		total = saturatingAdd(total, part);
		// Only a nonzero part is written: a name absent is 0, and the file stays inside CHILD_LEDGER_MAX_BYTES with every
		// open ledger in flight (ledgerInflight is 0 for a `done` file, the only kind the open-file cap does not bound).
		const live = Math.min(carry(ledgerInflight(entry)), part);
		if (live > 0) inflightByLedger[name] = live;
		inflight = saturatingAdd(inflight, live);
	}
	if (!(Number.isSafeInteger(generation) && generation >= 1)) return { v: 1, total, byLedger, inflight, inflightByLedger };
	// The turn's two facts (issue #985), with the generation they belong to: how many calls wait anywhere in the job, and
	// since which generation someone has waited without a break. A count that cannot be carried is written as waiting.
	const count = Number.isSafeInteger(waiting) && waiting >= 0 ? waiting : 1;
	const since = count > 0 && Number.isSafeInteger(waitingSince) && waitingSince >= 1 && waitingSince <= generation ? { waitingSince } : {};
	return { v: 1, total, byLedger, inflight, inflightByLedger, gen: generation, waiting: count, ...since };
}

/**
 * A child's external spend from a parsed SPENT file: the job's total less its own ledger's part, so the child's cost
 * guard never counts its own spend twice (once as its own, once a tick late through SPENT). Anything malformed is
 * Infinity, which the cost guard refuses: a SPENT that cannot be read is no licence to spend. A missing file is the
 * caller's case (nothing written yet), not this one. It reads `v`, `total` and `byLedger` only: the in-flight keys
 * (issue #985) are inflightFor's, and a reader from before them reads a file that has them exactly as before.
 */
export function externalFor(spent, ownName) {
	const whole = (value) => Number.isSafeInteger(value) && value >= 0;
	if (!isPlain(spent) || spent.v !== 1 || !whole(spent.total) || !isPlain(spent.byLedger)) return Infinity;
	const own = Object.hasOwn(spent.byLedger, ownName) ? spent.byLedger[ownName] : 0;
	if (!whole(own) || own > spent.total) return Infinity;
	return spent.total - own;
}

/**
 * The IN-FLIGHT part of a child's external spend (issue #985), from the same parsed SPENT: `inflight` less its own
 * ledger's `inflightByLedger` part (what the parent folded of this child's own holds, which its guard already counts
 * live), and never above externalFor(). 0 when SPENT is malformed, when either key is missing (a parent from before
 * issue #985's second part), or when either is malformed in any part: the child's guard then counts every outside
 * micro-dollar as settled, as it did, which can only refuse a call that could have waited, never admit one.
 */
export function inflightFor(spent, ownName) {
	const external = externalFor(spent, ownName);
	if (!Number.isFinite(external)) return 0;
	const whole = (value) => Number.isSafeInteger(value) && value >= 0;
	if (!whole(spent.inflight) || !isPlain(spent.inflightByLedger)) return 0;
	const own = Object.hasOwn(spent.inflightByLedger, ownName) ? spent.inflightByLedger[ownName] : 0;
	if (!whole(own) || own > spent.inflight) return 0;
	return Math.min(spent.inflight - own, external);
}

/**
 * A child ledger object, ready for JSON.stringify (issue #500; the format in the ledger comment above), built from the
 * child's meter and its policy guard (or null). `metered` false is the record of a meter that did not install, written
 * with zeros. Every number comes from the meter and the guard as they are: the writer adds nothing of its own.
 */
export function childLedger({ state, metered = true, meter = null, guard = null }) {
	const snap = metered && meter ? meter.snapshot() : null;
	const spend = metered && guard?.spend ? guard.spend() : { spentMicros: 0, inflightMicros: 0 };
	const refused = metered && guard ? guard.snapshot() : {};
	const charges = metered && typeof guard?.charges === "function" ? guard.charges() : null;
	// Issue #985: the cost guard's first refusal, its rule and its numbers, only once it refused.
	const refusedWhy = metered && typeof guard?.refusedWhy === "function" ? guard.refusedWhy() : null;
	const numbers = COST_REFUSALS.includes(refusedWhy) && typeof guard?.refusal === "function" ? guard.refusal() : null;
	return {
		v: CHILD_LEDGER_VERSION,
		state,
		metered,
		totals: {
			input: snap?.input ?? 0,
			output: snap?.output ?? 0,
			total: snap?.total ?? 0,
			cost: snap?.cost ?? 0,
			calls: snap?.calls ?? 0,
			unresolved: snap?.unresolved ?? 0,
			unpriced: snap?.unpriced ?? 0,
			sessions: snap?.sessions ?? 0,
		},
		rows: snap ? meter.rows() : [],
		spentMicros: spend.spentMicros,
		inflightMicros: spend.inflightMicros,
		costRefused: refused.costRefused ?? 0,
		modelRefused: refused.modelRefused ?? 0,
		boundExceeded: refused.boundExceeded ?? 0,
		costUnanswered: refused.costUnanswered ?? 0,
		costUnreported: snap?.costUnreported ?? 0,
		longContext: refused.longContext ?? 0,
		costUnjudged: refused.costUnjudged ?? 0,
		// Issue #985: the calls waiting in this child, so every other process takes its turn while it waits.
		waiting: metered && typeof guard?.waiting === "function" ? guard.waiting() : 0,
		// Issue #985: the calls that waited and the charge above pi's price, for the parent's exit line (0 without a cap).
		waited: charges?.waited ?? 0,
		liftedMicros: charges?.liftedMicros ?? 0,
		...(COST_REFUSALS.includes(refusedWhy) ? { refusedWhy, ...(numbers !== null ? { costRefusal: numbers } : {}) } : {}),
	};
}

// ── Issue #500: the child side, the ledger directory a runner opens and the meter a pi child runs ─────────────────
//
// THE ROUTE (DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY). Before it installs its own meter, the runner opens a ledger
// directory (openChildLedger) and puts three things in its own environment, which every descendant inherits: the
// directory, its own pid, and a NODE_OPTIONS `--import` of child-preload.mjs. In each Node child the preload decides
// whether the child is a pi session; if so, the child's own meter is started (startChildMeter) on the child's own
// ModelRuntime class and writes the child's ledger file. The parent folds those files (foldChildLedgers).
//
// THE CONTROL FILES. The parent writes two files into the same directory, each whole by temp file and rename:
//   - `STOP`: `{ "v": 1, "reason": <a STOP_MESSAGES key> }` (stopFile). Once it exists, a child's next call is braked
//     with that reason. Present but not readable as that shape, it is a stop as the token cap: a garbled STOP is still a
//     STOP (externalStop). Missing means go.
//   - `SPENT`: spentFile's object. A child's cost guard adds externalFor(SPENT, its own name) to what it judges, and
//     waits for inflightFor(SPENT, its own name) (issue #985). Missing means 0 (the parent has written nothing yet),
//     malformed or unreadable means Infinity (the call is refused).
// Both are read on every call, without blocking and without following a link (readLedger), so a FIFO or a symlink
// planted under either name refuses rather than hangs. Every file in the directory is written by writeFileAtomic, whose
// temporary file is created exclusively under a random name, so nothing planted there can block or redirect a writer.
// The one other file, a turn's claim (WAIT_CLAIM_PREFIX, issue #985), is created the same way by any process, the
// parent's included, and only ever created or checked for, never written or read.

/** The ledger directory, set by the runner for every descendant. */
export const CHILD_LEDGER_ENV = "PI_DISPATCH_CHILD_LEDGER";
/** The runner's own pid, so a process can tell the runner from a nested copy of it. */
export const RUNNER_PID_ENV = "PI_DISPATCH_RUNNER_PID";
export const STOP_FILE = "STOP";
export const SPENT_FILE = "SPENT";
/**
 * THE TURN (issue #985): the file a process creates, EXCLUSIVELY, to admit calls against one SPENT generation while
 * anyone in the job waits: `CLAIM.<gen>`, empty. Every process judges the others as of the last SPENT (or, for the
 * parent, the fold it was written from), so when a hold settles every process sees that room in the same generation:
 * without turns a waiter and any other call, in two processes, would each take it, and a call that would have been
 * refused before waiting existed would pass the cap. So, while any process has a waiter (SPENT's `waiting`, a child's
 * own queue, the parent's fold of its children's ledgers), every admission in every process, fresh or not, takes the
 * turn of its generation: one process per generation admits (as many of its own calls as fit), the others wait, and
 * a call that may not wait (a forward) and has no turn is refused, as before waiting existed. A turn won on an older
 * SPENT is lost: the claimer reads the generation again once its claim exists (startChildMeter has why that suffices).
 * Two more rules close the moment between the parent's fold and its SPENT write, where an admission can land unseen by
 * the next SPENT though always by the one after: no process admits in the generation right after another process's
 * turn (waitClaimTaken), and a call that WAITED is not admitted in the first generation that shows the wait
 * (`waitingSince`), so no call admitted without a turn, before anyone knew of the wait, can be missed. When nobody
 * waits no turn is taken: admission and its timing are what they were. A claim names a generation, so a claimer that
 * dies leaves nothing to clear; the parent removes each claim three generations on. Created like every file here
 * (writeFileAtomic's flags), never opened: `O_CREAT|O_EXCL|O_NOFOLLOW|O_NONBLOCK`, so a FIFO or a link planted at the
 * name only loses the turn. Not a ledger name, so the fold never reads it.
 */
export const WAIT_CLAIM_PREFIX = "CLAIM.";

/** The claim file's name for SPENT generation `gen`. */
export function waitClaimName(gen) {
	return `${WAIT_CLAIM_PREFIX}${gen}`;
}

/**
 * Win generation `gen`'s turn in `dir` (WAIT_CLAIM_PREFIX): true when this call created the file, false when it exists
 * or cannot be created (fail closed: the call waits, never admitted without its turn). Never throws.
 */
export function claimWait({ dir, gen, fs = DEFAULT_WRITE_FS }) {
	if (typeof dir !== "string" || !Number.isSafeInteger(gen) || gen < 1) return false;
	const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
	let fd;
	try {
		fd = fs.openSync(join(dir, waitClaimName(gen)), flags, 0o600);
	} catch {
		return false;
	}
	try {
		fs.closeSync(fd);
	} catch {
		// Created: the claim is won whether or not the descriptor closes cleanly.
	}
	return true;
}

/**
 * Whether generation `gen`'s turn was taken (its claim file exists, whatever it is), for the rule that no process admits
 * in the generation right after another process's turn (issue #985: an admission made in that turn can land between
 * the parent's fold and its SPENT write, so the next SPENT may not show it; the one after always does). A name that
 * cannot be checked is taken: fail toward waiting a generation.
 */
export function waitClaimTaken({ dir, gen, lstat = lstatSync }) {
	if (typeof dir !== "string" || !Number.isSafeInteger(gen) || gen < 1) return false;
	try {
		lstat(join(dir, waitClaimName(gen)));
		return true;
	} catch (error) {
		return error?.code !== "ENOENT";
	}
}
/**
 * The parent's pinned price table (pinPriceTable, issue #587's review), for pi children: written ONCE by the runner into
 * the ledger directory, read-only (0444), its sha256 in PRICE_TABLE_ENV, which the runner sets in its own environment
 * for its descendants. A child prices every capped call from it; a file that is missing, unreadable, malformed or does
 * not match the hash is an EMPTY table, which refuses every capped call (never "unchecked"). RESIDUAL, named: the job's
 * own processes run as the runner's uid, so one that rewrites the file AND exports a matching hash to a child it starts
 * itself defeats the check; it stops an extension or a model in a pi child from forging a price in passing.
 */
export const PRICE_TABLE_FILE = "PRICES";
export const PRICE_TABLE_ENV = "PI_DISPATCH_PRICE_TABLE";
const PRICE_TABLE_MAX_BYTES = 8 * 1024 * 1024;
/**
 * The globalThis key the preload hands its state over on: `{ dir, name, meter, library, child }`. A Symbol.for key,
 * because the preload, the child-meter extension (loaded by pi's own loader) and code appended to pi's
 * model-runtime.js (library mode) each reach it from a different module graph, and only the global is shared by all.
 */
export const CHILD_METER_HANDOFF = Symbol.for("pi-dispatch.child-meter");

/**
 * Open the run's child ledger directory and point every descendant at it (issue #500). `mkdtemp` makes it mode 0700
 * under the OS temp directory, made absolute (a relative TMPDIR would give each child a different directory), never
 * `/workspace` (the operator's tree) or `/job` (read-only). Sets, in `env`:
 *   - CHILD_LEDGER_ENV, the directory;
 *   - RUNNER_PID_ENV, `pid`, with this process's pid namespace where it can be read (`<pid>:<namespace>`,
 *     child-route.mjs runnerIdentity), so a process in another pid namespace that happens to have this pid is nested;
 *   - NODE_OPTIONS, what it held plus ` --import=<preloadUrl>` (once: a value that already carries it is left alone).
 *     `--import`, not `--require`: a load hook registered from a `--require` preload breaks every child that then uses
 *     asynchronous loader hooks (`module.register`, `--loader`). The price is named in DES: a Node older than 18.19
 *     refuses `--import` in NODE_OPTIONS and does not start.
 * The process that calls this is unaffected: NODE_OPTIONS is read when a Node process starts. Returns `{ dir }`, or
 * `{ error }` (a code, never a path) with CHILD_LEDGER_ENV DELETED from `env` and NODE_OPTIONS untouched, so with no
 * directory no child is pointed anywhere, not even at an inherited one, and every pi child stays unmetered, which the
 * parent's detector then counts. RUNNER_PID_ENV is set either way (issue #500 part D): it is what tells a nested copy
 * of the runner that it is one, and a nested runner with no directory stops with exit 2 instead of running the job
 * again. Never throws.
 */
export function openChildLedger({ env, pid, preloadUrl, mkdtemp = mkdtempSync, tmp = tmpdir, pidNamespace = readPidNamespace }) {
	// env-internal PI_DISPATCH_RUNNER_PID: set by the runner in its own environment, never by the worker.
	env.PI_DISPATCH_RUNNER_PID = runnerIdentity(pid, pidNamespace());
	let dir;
	try {
		dir = resolvePath(mkdtemp(join(tmp(), "pi-dispatch-meter-")));
	} catch (error) {
		// env-internal PI_DISPATCH_CHILD_LEDGER: set by the runner in its own environment, never by the worker.
		delete env.PI_DISPATCH_CHILD_LEDGER;
		return { error: reasonOf(error) };
	}
	env.PI_DISPATCH_CHILD_LEDGER = dir;
	// A file URL carries no whitespace (it is percent-encoded), so NODE_OPTIONS splits it as one argument.
	const flag = `--import=${preloadUrl}`;
	// env-internal NODE_OPTIONS: Node's own variable, extended here for the runner's descendants, never a deployment key.
	const existing = typeof env.NODE_OPTIONS === "string" ? env.NODE_OPTIONS.trim() : "";
	if (!existing.includes(flag)) env.NODE_OPTIONS = existing === "" ? flag : `${existing} ${flag}`;
	return { dir };
}

/** The STOP file's object for `reason`, a STOP_MESSAGES key. */
export function stopFile(reason) {
	if (!Object.hasOwn(STOP_MESSAGES, reason)) throw new Error(`unknown meter stop: ${reason}`);
	return { v: 1, reason };
}

/**
 * Write `text` to `<dir>/<name>` whole: a temporary file beside it, then a rename, so a reader sees the old file or the
 * new one and never half of one. Every writer of the ledger directory uses this: the child's ledger now, the parent's
 * STOP and SPENT (issue #500 part E). The directory is shared with the agent's own processes, so the temporary file is
 * CREATED, never opened: `O_CREAT|O_EXCL|O_NOFOLLOW|O_NONBLOCK` under a random name, so a FIFO planted there cannot
 * block the writer (the parent's event loop, and with it every brake) and a symlink cannot send the bytes elsewhere.
 * A name that exists is retried under a new one, a few times. The descriptor must be a regular file. The temporary name
 * ends in `.tmp`, which no reader matches. Throws what the fs throws, and leaves no temporary file behind it.
 */
export function writeFileAtomic({ dir, name, text, fs = DEFAULT_WRITE_FS, random = (bytes) => globalThis.crypto.getRandomValues(bytes) }) {
	const path = join(dir, name);
	const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
	let temporary;
	let fd;
	for (let attempt = 0; ; attempt += 1) {
		temporary = `${path}.${[...random(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, "0")).join("")}.tmp`;
		try {
			fd = fs.openSync(temporary, flags, 0o600);
			break;
		} catch (error) {
			if (error?.code !== "EEXIST" || attempt >= 7) throw error;
		}
	}
	try {
		try {
			if (!fs.fstatSync(fd).isFile()) throw Object.assign(new Error("not a regular file"), { code: "EFTYPE" });
			const bytes = Buffer.from(text, "utf8");
			let written = 0;
			while (written < bytes.length) written += fs.writeSync(fd, bytes, written, bytes.length - written);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(temporary, path);
	} catch (error) {
		try {
			fs.rmSync(temporary, { force: true });
		} catch {
			// The temporary file is the directory's to lose with it.
		}
		throw error;
	}
}

const DEFAULT_WRITE_FS = { openSync, fstatSync, writeSync, closeSync, renameSync, rmSync, constants };

/**
 * A control file's text, or null when it does not exist. Read like a ledger (readLedger: no link, no blocking open, a
 * regular file of at most CHILD_LEDGER_MAX_BYTES, strict UTF-8); anything else throws, and the caller fails closed.
 */
function readControl(fs, dir, name) {
	const read = readLedger(fs, join(dir, name), null);
	if (read === GONE) return null;
	if (read === BAD || read === UNCHANGED) throw new Error(`unreadable ${name}`);
	return read.text;
}

/**
 * The child's `isStopped` (issue #500): null while `<dir>/STOP` does not exist, its reason once it does. A STOP that is
 * not `{ v: 1, reason: <a STOP_MESSAGES key> }` answers true, and an unreadable one throws: externalStop turns both into
 * a stop as the token cap.
 */
export function readStop({ dir, fs = DEFAULT_LEDGER_FS }) {
	const text = readControl(fs, dir, STOP_FILE);
	if (text === null) return null;
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return true;
	}
	return isPlain(parsed) && parsed.v === 1 && typeof parsed.reason === "string" && Object.hasOwn(STOP_MESSAGES, parsed.reason) ? parsed.reason : true;
}

/**
 * The child cost guard's outside readings from ONE read of `<dir>/SPENT` (issues #500, #985): `external`,
 * externalFor(SPENT, own ledger name) in micro-dollars, `inflight`, inflightFor() of the same parse, `gen`, the file's
 * generation (null when it has none: a parent from before issue #985's second part), `present`, `waiting` (whether
 * anyone in the job may be waiting, true unless the file says 0) and `waitingSince`. Zeros, null and false while the
 * file does not exist; `external` Infinity (and `waiting` true) when it is malformed. An unreadable one throws, which
 * the cost guard also reads as Infinity: a SPENT that cannot be read is no licence to spend.
 */
export function readSpent({ dir, name, fs = DEFAULT_LEDGER_FS }) {
	const text = readControl(fs, dir, SPENT_FILE);
	if (text === null) return { external: 0, inflight: 0, gen: null, present: false, waiting: false, waitingSince: null };
	let parsed;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { external: Infinity, inflight: 0, gen: null, present: true, waiting: true, waitingSince: null };
	}
	const gen = isPlain(parsed) && Number.isSafeInteger(parsed.gen) && parsed.gen >= 1 ? parsed.gen : null;
	// A file with a generation and no readable count says someone may be waiting: take the turn (fail toward it). One
	// with no generation (a parent from before the turn) has none to take.
	const waiting = gen !== null && !(Number.isSafeInteger(parsed.waiting) && parsed.waiting === 0);
	const since = gen !== null && Number.isSafeInteger(parsed.waitingSince) && parsed.waitingSince >= 1 && parsed.waitingSince <= gen ? parsed.waitingSince : null;
	return { external: externalFor(parsed, name), inflight: inflightFor(parsed, name), gen, present: true, waiting, waitingSince: since };
}

/** The child cost guard's `external` (issue #500): readSpent()'s `external`, which throws what it throws. */
export function readExternal({ dir, name, fs = DEFAULT_LEDGER_FS }) {
	return readSpent({ dir, name, fs }).external;
}

/** The table's file text: `{ v: 1, entries: [[key, { api, cost, compat }], ...] }`, in key order. */
function priceTableText(table) {
	return JSON.stringify({ v: 1, entries: [...table].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)) });
}

/**
 * Write the parent's table for its children (PRICE_TABLE_FILE) and set its hash in `env` (the runner's own environment,
 * which every descendant inherits). Throws what the fs throws; the caller logs it, and a child then finds no table.
 */
export function publishPriceTable({ dir, table, env, fs = DEFAULT_WRITE_FS, chmod = chmodSync }) {
	const text = priceTableText(table instanceof Map ? table : new Map());
	writeFileAtomic({ dir, name: PRICE_TABLE_FILE, text, fs });
	try {
		chmod(join(dir, PRICE_TABLE_FILE), 0o444);
	} catch {
		// Read-only is a convenience, not the check: the hash is.
	}
	// The hash variable (PRICE_TABLE_ENV) is set by the runner in its own environment for its descendants, never by the worker.
	env[PRICE_TABLE_ENV] = createHash("sha256").update(text).digest("hex");
}

/** A child's copy of the parent's table, or an EMPTY Map when it cannot be had intact (PRICE_TABLE_FILE has the rule). */
export function readPriceTable({ dir, env, fs = DEFAULT_LEDGER_FS }) {
	// The hash variable (PRICE_TABLE_ENV) is set by the runner in its own environment and inherited, never by the worker.
	const want = env?.[PRICE_TABLE_ENV];
	if (typeof want !== "string" || !/^[0-9a-f]{64}$/.test(want) || typeof dir !== "string") return new Map();
	const read = readLedger(fs, join(dir, PRICE_TABLE_FILE), null, PRICE_TABLE_MAX_BYTES);
	if (read === GONE || read === BAD || read === UNCHANGED) return new Map();
	if (createHash("sha256").update(read.text).digest("hex") !== want) return new Map();
	try {
		const parsed = JSON.parse(read.text);
		if (!isPlain(parsed) || parsed.v !== 1 || !Array.isArray(parsed.entries)) return new Map();
		const table = new Map();
		for (const entry of parsed.entries) {
			if (!Array.isArray(entry) || typeof entry[0] !== "string" || !isPlain(entry[1])) return new Map();
			table.set(entry[0], entry[1]);
		}
		return table;
	} catch {
		return new Map();
	}
}

/** A fresh ledger name for `pid`: `<pid>.<16 lowercase hex>.json`. */
export function childLedgerName(pid, random = (bytes) => globalThis.crypto.getRandomValues(bytes)) {
	const nonce = [...random(new Uint8Array(8))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${pid}.${nonce}.json`;
}

/**
 * Start the meter a pi child process runs (issue #500), on the child's OWN ModelRuntime class, and keep its ledger
 * file. Called by child-meter.ts (a pi CLI or rpc child, at extension load) and by the preload's library hook (a Node
 * child that loads pi's unbundled model-runtime.js). Never throws.
 *
 *   - `ModelRuntime`: the class the child's sessions dispatch through. Never the runner's import of dist/index.js: a
 *     child started from the bundle runs the bundle's own copy, and wrapping another one counts nothing.
 *   - `compat`: `{ module, fallbackModels }`, the child's own pi-ai compat copy (installProcessUsageMeter `compat`). Its
 *     stream factory is the brake's.
 *   - `env`: the policies come from it as the runner reads them: PI_ALLOWED_MODELS (the model guard) and
 *     PI_MAX_COST_MICROS (a cost guard whose `external` and `externalInflight` are one readSpent, so a call refused
 *     only by holds that will settle waits for them, issue #985). The token cap is not the child's: the parent
 *     judges it on its own spend plus every child's, and answers through STOP. A policy that does not parse leaves the
 *     child unmetered (`metered: false`), the floor, rather than unguarded.
 *   - `dir`, `name`: the ledger directory and this child's file in it.
 *   - `lazy`: write nothing until the first call is about to go out (the library route: a process that only imports pi
 *     and never calls leaves no file, so a test suite that imports pi hundreds of times cannot flood the directory).
 *     The file is born with the pre-dispatch write of that first call.
 *   - `state`: an object kept across calls in one process (the handoff's), so a second class handed over (two copies
 *     of pi in one process) is installed with the same meter and guard and the ledger stays one file.
 *   - `now`, `setTimer`, `clearTimer`: the cost guard's clock and drain timer (issue #985), for tests.
 *
 * The install is `brake: true` (a hard stop with no policy, so a STOP can be answered) and `isStopped` reads STOP before
 * every call. The ledger is written whole (writeFileAtomic) after the install (unless `lazy`), on every change the meter
 * reports, BEFORE every call is dispatched with that call counted in flight (the child's guard, below), again as a
 * capped call's onPayload returns with the hold it is sent under (issue #985), and once more as `done` when the process
 * exits. FAIL CLOSED ON A WRITE: the pre-dispatch write that fails refuses its call, so no
 * call goes out that the ledger does not already show; and once any write has failed (a full or unwritable /tmp, a
 * directory the agent removed), the child is unmetered and STOPPED: isStopped answers the token cap for every later
 * call, and every later write that still succeeds says `metered: false`. With the install failed, the ledger says `metered: false` and carries zeros. Returns
 * the state: `{ ok, metered, meter, guard, handles, write, verify }`, where `verify(runtime)` marks the child unmetered
 * unless that runtime dispatches through an install (a session's runtime, checked at session_start).
 */
export async function startChildMeter({
	ModelRuntime,
	compat,
	env,
	dir,
	name,
	lazy = false,
	admit = false,
	state = {},
	fs = DEFAULT_LEDGER_FS,
	writeFs = DEFAULT_WRITE_FS,
	onExit = (listener) => process.on("exit", listener),
	install = installProcessUsageMeter,
	now = Date.now,
	setTimer = setInterval,
	clearTimer = clearInterval,
}) {
	try {
		if (state.child) {
			// A second class in one process (two copies of pi, or the library hook and then the extension on one class):
			// the same meter, the same guard, one ledger. A class already installed is not installed twice.
			const child = state.child;
			if (!child.metered || child.classes.has(ModelRuntime)) return child;
			if (typeof ModelRuntime !== "function" || !compat) {
				child.unmetered();
				return child;
			}
			child.classes.add(ModelRuntime);
			await child.installOn(ModelRuntime, compat);
			return child;
		}
		const child = { ok: false, metered: false, failed: false, live: !lazy, meter: null, guard: null, handles: [], classes: new Set([ModelRuntime]), write: () => {}, verify: () => false, installOn: async () => {}, unmetered: () => {} };
		state.child = child;
		let done = false;
		// The call count the ledger must show at least: the meter's own count, or one more while an admitted call is
		// between its pre-dispatch write and the meter seeing it. The gap is synchronous (admit, dispatch, observe), so
		// one reservation is the most there can be; a call that was admitted and never observed stays counted, unresolved.
		let floor = 0;
		child.write = (ledgerState) => {
			if (done) return;
			// A lazy child that never called writes nothing at all, not even at exit.
			if (!child.live) return;
			if (ledgerState === "done") done = true;
			try {
				const ledger = childLedger({ state: ledgerState, metered: child.metered, meter: child.meter, guard: child.guard });
				const reserved = child.metered ? Math.max(0, floor - ledger.totals.calls) : 0;
				ledger.totals.calls += reserved;
				ledger.totals.unresolved += reserved;
				writeFileAtomic({ dir, name, text: JSON.stringify(ledger), fs: writeFs });
			} catch {
				// The fold has no notion of a stale file, so a write that failed would leave an older, smaller ledger
				// that still says metered. Instead the child stops (isStopped below) and is unmetered from here on.
				child.failed = true;
				child.metered = false;
			}
		};
		child.unmetered = () => {
			child.metered = false;
			child.live = true;
			child.write("running");
		};
		onExit(() => child.write("done"));
		let maxCostMicros;
		let allowedModels;
		try {
			// env-internal PI_MAX_COST_MICROS: the worker's per-job cap, inherited from the runner, read here as the runner reads it.
			maxCostMicros = parseCostMicros(env, "PI_MAX_COST_MICROS");
			allowedModels = parseAllowedModels(env, "PI_ALLOWED_MODELS");
		} catch {
			child.unmetered();
			return child;
		}
		// No class, or no compat copy to build the brake from: nothing to install on (the library hook found a
		// model-runtime.js it does not recognise, or a bundle it cannot reach). Unmetered, without trying the runner's
		// own resolution.
		if (typeof ModelRuntime !== "function" || !compat) {
			child.unmetered();
			return child;
		}
		child.metered = true;
		// Issue #1098: the child's OWN subscription admission, the contract the job's runner runs (run-job.mjs), never one
		// borrowed from it: verify the entries the runner keeps current in PI_SUBSCRIPTION_AUTH, adapter content included,
		// and install the credential and registration guards on this child's class, here, at the meter's load, which comes
		// before every other extension's (the preload puts the meter first): so the approved adapter's registration, loaded
		// right after the meter (child-route.mjs subscriptionAdapterRoots), is the one the guard selects, and any other
		// registration of that provider latches the conflict. The seal waits for the session's runtime (verify() below, on
		// session_start). Only for the extension's route (`admit`): a library child (the preload's hook) has no session
		// start to seal at, and stays refused. Nothing here throws: whatever fails (entries that do not verify, an adapter
		// that is not the approved one, a guard pi cannot take) leaves no admission, and the model guard, which reads the
		// entries from the environment itself, refuses every subscription call, as before.
		let subscriptions = null;
		let registration = null;
		if (admit) {
			try {
				const verified = verifySubscriptionAuthEntries(JSON.parse(env.PI_SUBSCRIPTION_AUTH ?? "[]"));
				if (verified.length > 0) {
					installSubscriptionCredentials({ ModelRuntime, entries: verified, env });
					registration = installSubscriptionRegistrationGuard({ ModelRuntime, entries: verified });
					subscriptions = verified;
				}
			} catch {
				registration = null;
				subscriptions = null;
			}
		}
		const subscriptionAdmission = registration ? (provider) => registration.admitted(provider) : null;
		// Its notional providers by the runner's own rule (notionalProviders): only with the admission and a model list.
		const notional = notionalProviders({ subscriptions, subscriptionAdmission, allowedModels });
		child.meter = createUsageMeter({ maxTokens: null, maxCostMicros, allowedModels, onChange: () => child.write("running"), ...(subscriptions ? { notionalProviders: notional } : {}) });
		// ONE read of SPENT per judgement (issue #985): `external` reads the file, and `externalInflight`, which the cost
		// guard asks right after it, answers from that same read, so a total from one tick is never paired with an
		// in-flight part from the next. A read that throws leaves the in-flight part at 0 (the guard refuses anyway).
		let spentRead = { external: 0, inflight: 0, gen: null, present: false, waiting: false, waitingSince: null };
		const external = () => {
			spentRead = { external: Infinity, inflight: 0, gen: null, present: true, waiting: true, waitingSince: null };
			spentRead = readSpent({ dir, name, fs });
			return spentRead.external;
		};
		// THE TURN (issue #985), against the SPENT generation the call was judged by, from the same read: no generation
		// yet (SPENT not written) is no turn; a SPENT with none at all (a parent from before the turn) takes none, as
		// before. A call that WAITED needs a generation whose previous one already showed someone waiting (so no process
		// admitted then without its turn); no call takes the generation right after another process's turn; and the
		// turn itself is the generation's claim file (claimWait), kept for every admission of this child in it.
		let claimedGen = null;
		const claim = (waited) => {
			const gen = spentRead.gen;
			if (gen === null) return spentRead.present && !spentRead.waiting;
			if (waited && !(spentRead.waitingSince !== null && spentRead.waitingSince <= gen - 1)) return false;
			if (gen === claimedGen) return true;
			if (claimedGen !== gen - 1 && waitClaimTaken({ dir, gen: gen - 1, lstat: fs.lstatSync ?? lstatSync })) return false;
			if (!claimWait({ dir, gen, fs: writeFs })) return false;
			claimedGen = gen;
			// THE GENERATION MOVED? Read SPENT's generation again AFTER the claim file exists: if the parent wrote a newer
			// one meanwhile, this turn is lost and the call waits for the next. Without this a turn could be won twice
			// across the boundary: a process B that read the newer SPENT found no claim for this generation (checked
			// before it was created), took the next one and was admitted, and this call, judged on the older SPENT, was
			// admitted too, neither seeing the other. With it: if B's check came before this claim was created, the
			// parent's newer SPENT was written before that check, so before this re-read, which sees it and gives up; if
			// B's check came after, B saw this claim and gave up the generation after it. A re-read that fails loses too.
			try {
				return readSpent({ dir, name, fs }).gen === gen;
			} catch {
				return false;
			}
		};
		// The clock and the timer are the cost guard's waiters' (issue #985), injected by tests. `onQueue` publishes this
		// child's waiting the moment it starts or stops (a lazy child's file is born for it: its call is about to go out).
		const policy = createPolicyGuard({
			maxCostMicros,
			allowedModels,
			env,
			subscriptionAdmission,
			subscriptions,
			notional,
			external,
			externalInflight: () => spentRead.inflight,
			claim,
			outsideWaiting: () => spentRead.waiting,
			onQueue: () => {
				child.live = true;
				child.write("running");
			},
			now,
			setTimer,
			clearTimer,
		});
		// THE FINAL-PAYLOAD WRITE (issue #985). The cost guard may change an admitted call's hold in its onPayload, after the
		// pre-dispatch write: grow it to the final body's bound, or give it back while the call waits for room and take
		// it again. The provider sends only after onPayload returns (pinned per priced api module), so the ledger is
		// written once more as the hook returns, with the hold the call is sent under: the parent, and every sibling
		// through SPENT, judge against that hold from the next tick, not from this call's settle. As the pre-dispatch write
		// does, a write that fails refuses the call (the hook throws, so nothing is sent) and stops the child; a hook that
		// threw is written too, its hold given back.
		const finalWrite = (args) => {
			const options = args?.[1];
			const theirs = options?.onPayload;
			if (!policy?.cost || typeof theirs !== "function") return args;
			const onPayload = async function (...given) {
				let sent;
				try {
					sent = await theirs.apply(this, given);
				} catch (error) {
					child.write("running");
					throw error;
				}
				child.write("running");
				if (child.failed) throw new Error(STOP_MESSAGES[TOKEN_BUDGET]);
				return sent;
			};
			return [args[0], { ...options, onPayload }, ...args.slice(2)];
		};
		// THE PRE-DISPATCH WRITE. The guard is the last thing a call passes before it is dispatched (judge), so the child's
		// guard wraps the policy guard (or stands alone, with no policy): once the policy admits a call, the ledger is
		// written with that call already counted, in flight (`unresolved`), and a write that fails refuses the call. So
		// every call that goes out is on disk before it does, at least as a floor; the settle then updates it. One write
		// per call, on top of the observe and settle writes. A lazy child's file is born here, at its first call.
		child.guard = {
			enforces: Object.freeze([...(policy?.enforces ?? [])]),
			admit(call) {
				const refused = policy ? policy.admit(call) : null;
				if (refused !== null && refused !== undefined) return refused;
				const before = floor;
				floor = Math.max(floor, child.meter.state.calls + 1);
				child.live = true;
				child.write("running");
				if (!child.failed) return null;
				floor = before;
				return TOKEN_BUDGET;
			},
			...(policy ? { prepare: (call) => finalWrite(policy.prepare(call)) } : {}),
			bind: (result) => policy?.bind?.(result),
			// The cost guard's queue (issue #985): a call refused only by holds that will settle (its siblings', the
			// parent's, its own) waits for them, as in the parent. COST_WAIT is not an admission, so admit() above writes
			// nothing for it: the pre-dispatch write is made by the retry that is admitted, still the last step before its
			// dispatch, so one reservation is still the most there can be.
			...(policy?.wait ? { wait: (retry) => policy.wait(retry), leave: (waiter) => policy.leave(waiter), close: () => policy.close(), waiting: () => policy.waiting() } : {}),
			unjudged: (count) => policy?.unjudged?.(count),
			// The refusal counters only. Not policy.snapshot(): the cost guard's snapshot settles a pending admission at its
			// bound, and the pre-dispatch write runs between an admission and its bind.
			// The cost guard's floor counters too (issue #500 part E's review), read off its state for the same reason.
			snapshot: () => ({
				...(policy?.cost ? { costRefused: policy.cost.state.refused, boundExceeded: policy.cost.state.boundExceeded, costUnanswered: policy.cost.state.unanswered, longContext: policy.cost.state.longContext, costUnjudged: policy.cost.state.unjudged } : {}),
				...(policy?.model ? { modelRefused: policy.model.snapshot().modelRefused } : {}),
			}),
			spend: () => (policy ? policy.spend() : { spentMicros: 0, inflightMicros: 0 }),
			// Issue #985: what the ledger's `waited` and `liftedMicros` are made of (null without a cap: written as 0), and
			// its first refusal (the ledger's `refusedWhy` and `costRefusal`, none without a cap or a refusal).
			charges: () => (policy ? policy.charges() : null),
			refusedWhy: () => (policy ? policy.refusedWhy() : null),
			refusal: () => (policy ? policy.refusal() : null),
		};
		// After a failed write, nothing more goes out: the ledger can no longer record it.
		const isStopped = () => (child.failed ? TOKEN_BUDGET : readStop({ dir, fs }));
		// The parent's pinned price table (issue #587's review): a child prices from it, never from its own runtime.
		const prices = readPriceTable({ dir, env, fs });
		child.installOn = async (Class, copy) => {
			const handle = await install({
				ModelRuntime: Class,
				meter: child.meter,
				guard: child.guard,
				compat: copy,
				brake: true,
				isStopped,
				prices,
				// The parent's detector is the parent's; a child samples nothing.
				children: { sample() {} },
			});
			if (!handle?.ok) {
				child.unmetered();
				return;
			}
			child.handles.push(handle);
		};
		await child.installOn(ModelRuntime, compat);
		if (!child.metered) return child;
		child.ok = true;
		child.verify = (runtime) => {
			if (!child.metered) return false;
			// Issue #1098: the seal, on the runtime the session dispatches through, once every extension has registered. One
			// that cannot be sealed (the adapter missing or not the approved one, a conflict) admits nothing.
			try {
				registration?.seal(runtime);
			} catch {
				// registration.admitted() stays false, so every subscription call of this child is refused.
			}
			if (child.handles.some((handle) => handle.covers?.(runtime))) return true;
			child.unmetered();
			return false;
		};
		child.write("running");
		return child;
	} catch {
		state.child?.unmetered?.();
		return state.child ?? null;
	}
}
