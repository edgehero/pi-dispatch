import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { test } from "node:test";
import { createCostGuard, createUsageMeter, makeDeferredStream, makeHardStopStream, resolvePiAiCompat, wrapModelRuntime, wrapProviderStreams } from "../src/usage-meter.mjs";

/**
 * Issue #985: the waiting path under random schedules. The REAL createCostGuard, both halves of the meter's seam
 * (wrapModelRuntime's stream and classify methods, wrapProviderStreams), pi's own AssistantMessageEventStream for every
 * stream and placeholder, and a fake provider that awaits onPayload before it "sends" (the order every priced api
 * module keeps, pinned in pinned-api.test.mjs). Each seed runs 120 random steps: calls (some aborted, some growing at
 * their final payload, a few forwarding under their own dispatch), settles (some charged their bound), aborts, ticks
 * of the drain timer with the clock moved (past the idle limit a third of the time), the outside spend moving within
 * the cap, and a meter stop now and then; then everything left is settled. Checked after every step and every flush,
 * and at each send:
 *   - the cap: spent + in flight + outside <= cap;
 *   - every call that was SENT and has not settled is held at its true worst case (its bound with its final body):
 *     the sum of those is at most what the guard holds in flight, and spent + that sum + outside is within the cap;
 * and at the end:
 *   - every answer (stream, placeholder, classify promise) ended, nothing is held, nothing waits;
 *   - every call reached the provider in its own caller's async context (a forward in its parent's).
 * Fixed seeds, so a failure is reproducible: the message names the seed and the end of its trace.
 *
 * Gated like loader.test.mjs (it needs pi-ai's stream class): a skip is NOT a pass, and CI sets
 * PI_DISPATCH_REQUIRE_LOADER_TESTS=1.
 */
let compat;
let importError;
try {
	compat = await import(resolvePiAiCompat()[0].url);
} catch (error) {
	importError = error;
}
if (!compat && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw new Error(`the cost guard fuzz is REQUIRED here but pi-ai could not be imported.\n${importError}`);
const skip = compat ? false : `pi not installed (node ${process.version}); CI runs these`;

const SEEDS = 300;
const STEPS = 120;
const CAP = 2000;

/** A small seeded PRNG (mulberry32): the same seed gives the same schedule on every run. */
function rng(seed) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const flush = () => new Promise((resolve) => setImmediate(resolve));
const zero = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
const BASE = Object.freeze({ api: "openai-completions", provider: "local", baseUrl: "http://127.0.0.1:1", cost: { input: 1, output: 2, cacheRead: 0.5, cacheWrite: 0 }, maxTokens: 1000, compat: { maxTokensField: "max_tokens" } });
/** A call's worst case: its model's bound, or its final body's `grow` when larger. */
const trueBound = (model, body) => (body === undefined ? model.bound : Math.max(model.bound, body.grow ?? 0));

async function scenario(seed) {
	const createStream = compat.createAssistantMessageEventStream;
	const r = rng(seed);
	const pick = (n) => Math.floor(r() * n);
	const trace = [];
	const say = (line) => trace.push(line);
	const clock = { now: 0 };
	let timerRun = null;
	let outside = 0;
	const guard = createCostGuard({
		capMicros: CAP,
		bound: (method, model, context, options, env, body) => trueBound(model, body),
		external: () => outside,
		log: (event, fields) => say(`  log ${event} ${JSON.stringify(fields)}`),
		now: () => clock.now,
		setTimer: (run) => ((timerRun = run), { unref() {} }),
		clearTimer: () => (timerRun = null),
	});
	const meter = createUsageMeter({ maxCostMicros: CAP });
	const hardStop = makeHardStopStream({ createStream });
	const deferred = makeDeferredStream({ createStream });
	const dispatch = new AsyncLocalStorage();
	const caller = new AsyncLocalStorage();
	const calls = [];
	let violation = null;
	const sentHeld = () => calls.filter((c) => c.state === "sent").reduce((sum, c) => sum + c.finalBound, 0);
	const check = (label) => {
		if (violation) return;
		const total = guard.state.spent + guard.state.inflight + outside;
		if (total > CAP) violation = `cap ${label}: spent ${guard.state.spent} + in flight ${guard.state.inflight} + outside ${outside} = ${total} > ${CAP}`;
		const held = sentHeld();
		if (held > guard.state.inflight) violation = `held ${label}: sent, unsettled worst cases ${held} > in flight ${guard.state.inflight}`;
		if (guard.state.spent + held + outside > CAP) violation = `sent ${label}: spent ${guard.state.spent} + sent ${held} + outside ${outside} > ${CAP}`;
	};
	let runtimeRef = null;
	// The provider: builds a payload, awaits onPayload, then "sends" what the hook returned.
	function provide(kind, model, context, options) {
		const rec = { id: calls.length + 1, kind, model, state: "building", finalBound: null, ctx: caller.getStore(), stream: kind === "classify" ? null : createStream(), resolve: null };
		calls.push(rec);
		const promise = kind === "classify" ? new Promise((resolve) => (rec.resolve = resolve)) : null;
		const fail = (reason, error) => {
			rec.state = "withheld";
			const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zero(), stopReason: reason, errorMessage: String(error?.message ?? error), timestamp: 0 };
			if (rec.stream) {
				rec.stream.push({ type: "error", reason, error: message });
				rec.stream.end();
			} else rec.resolve({ usage: zero(), stopReason: reason, answers: {} });
		};
		(async () => {
			await Promise.resolve();
			// A forward under this call's dispatch: it runs under HOLDING, and must never wait.
			if (model.forward && runtimeRef) rec.forwardStream = runtimeRef.streamSimple({ ...BASE, id: "fwd", bound: model.forwardBound, tag: model.tag }, {}, {});
			let payload = { grow: model.grow, n: rec.id, max_tokens: 1000 };
			try {
				const next = await options?.onPayload?.(payload, model);
				if (next !== undefined) payload = next;
			} catch (error) {
				fail(options?.signal?.aborted ? "aborted" : "error", error);
				return;
			}
			if (options?.signal?.aborted) {
				fail("aborted", "aborted before send");
				return;
			}
			rec.state = "sent";
			rec.finalBound = trueBound(model, payload);
			say(`  send #${rec.id} worst ${rec.finalBound} in flight ${guard.state.inflight}`);
			check(`send #${rec.id}`);
		})();
		return rec.stream ?? promise;
	}
	class Runtime {
		streamSimple(model, context, options) {
			return provide("stream", model, context, options);
		}
		stream(model, context, options) {
			return provide("stream", model, context, options);
		}
		classify(model, context, options) {
			return provide("classify", model, context, options);
		}
	}
	const layer = wrapModelRuntime({ ModelRuntime: Runtime, meter, hardStop, guard, dispatch, deferred });
	const legacy = wrapProviderStreams({ inner: { streamSimple: (m, c, o) => provide("stream", m, c, o), stream: (m, c, o) => provide("stream", m, c, o) }, fallbackModels: null, meter, hardStop, guard, dispatch, deferred });
	const runtime = new Runtime();
	runtimeRef = runtime;
	const answers = [];
	const settle = (c, micros, failed = false) => {
		const cost = micros / 1e6;
		c.state = "settled";
		if (c.kind === "classify") {
			c.resolve({ usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 10, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } }, stopReason: "stop", answers: { ok: true } });
			return;
		}
		const final = { role: "assistant", content: [{ type: "text", text: "ok" }], api: c.model.api, provider: c.model.provider, model: c.model.id, usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } }, stopReason: failed ? "error" : "stop", ...(failed ? { errorMessage: "cut" } : {}), timestamp: 0 };
		c.stream.push({ type: "start", partial: final });
		c.stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: final });
		if (failed) c.stream.push({ type: "error", reason: "error", error: final });
		else c.stream.push({ type: "done", reason: "stop", message: final });
		c.stream.end();
	};
	try {
		for (let step = 0; step < STEPS && !violation; step++) {
			const roll = r();
			if (roll < 0.34) {
				const bound = 100 + pick(8) * 100;
				const growKind = pick(4);
				const grow = growKind === 0 ? bound + (1 + pick(6)) * 100 : growKind === 1 ? bound - 50 : bound;
				const controller = r() < 0.25 ? new AbortController() : null;
				const forward = r() < 0.01;
				const tag = `ctx${step}`;
				const model = { ...BASE, id: `m${step}`, bound, grow, tag, ...(forward ? { forward: true, forwardBound: 100 } : {}) };
				const how = pick(10);
				let answer;
				caller.run(tag, () => {
					const options = controller ? { signal: controller.signal } : {};
					if (how < 6) answer = runtime.streamSimple(model, {}, options);
					else if (how < 8) answer = legacy.streamSimple(model, {}, options);
					else answer = runtime.classify(model, {}, options);
				});
				answers.push({ step, answer, controller });
				say(`step ${step}: call ${how < 6 ? "runtime" : how < 8 ? "compat" : "classify"} bound ${bound} grow ${grow}${controller ? " abortable" : ""}${forward ? " forward" : ""}: in flight ${guard.state.inflight} spent ${guard.state.spent}`);
			} else if (roll < 0.62) {
				const sent = calls.filter((c) => c.state === "sent");
				if (sent.length) {
					const c = sent[pick(sent.length)];
					const mode = pick(12);
					// One in twelve settles at its whole worst case, one in twelve fails after it started (charged its bound).
					const micros = mode === 0 ? c.finalBound : Math.floor(r() * c.finalBound * 0.05);
					say(`step ${step}: settle #${c.id} mode ${mode} micros ${micros}`);
					settle(c, micros, mode === 1);
				}
			} else if (roll < 0.72) {
				const live = answers.filter((a) => a.controller && !a.controller.signal.aborted);
				if (live.length) {
					const a = live[pick(live.length)];
					say(`step ${step}: abort the call of step ${a.step}`);
					a.controller.abort();
				}
			} else if (roll < 0.8) {
				clock.now += r() < 0.33 ? 16 * 60 * 1000 : 500;
				say(`step ${step}: tick, clock ${clock.now}`);
				timerRun?.();
			} else if (roll < 0.9) {
				const before = outside;
				const delta = (r() < 0.5 ? -1 : 1) * pick(2) * 100;
				// A child's own guard admits its spend against the parent's: the outside spend rises only within the cap.
				if (delta <= 0 || guard.state.spent + guard.state.inflight + outside + delta <= CAP) outside = Math.min(300, Math.max(0, outside + delta));
				say(`step ${step}: outside ${before} -> ${outside}`);
			} else if (roll < 0.91) {
				say(`step ${step}: meter stop`);
				meter.stop("token_budget");
			} else {
				await Promise.resolve();
			}
			check(`after step ${step}`);
			if (r() < 0.7) {
				await flush();
				check(`flush after step ${step}`);
			}
		}
		// Settle everything still sent, until nothing moves; tick the timer when nothing is sent.
		for (let pass = 0; pass < 200 && !violation; pass++) {
			await flush();
			check(`drain pass ${pass}`);
			const sent = calls.filter((c) => c.state === "sent");
			for (const c of sent) {
				settle(c, Math.floor(c.finalBound * 0.1));
				check(`drain settle #${c.id}`);
			}
			if (sent.length === 0) {
				clock.now += 1000;
				timerRun?.();
			}
		}
		await flush();
		let unended = 0;
		for (const a of answers) {
			const ended = typeof a.answer?.result === "function" ? a.answer.result() : a.answer;
			const outcome = await Promise.race([Promise.resolve(ended).then(() => "ended", () => "ended"), flush().then(flush).then(() => "hung")]);
			if (outcome === "hung") unended += 1;
		}
		const building = calls.filter((c) => c.state === "building").length;
		if (!violation && unended > 0) violation = `ended: ${unended} answers never ended (building ${building}, in flight ${guard.state.inflight}, timer ${timerRun !== null})`;
		if (!violation && guard.state.inflight !== 0) violation = `held at the end: in flight ${guard.state.inflight} (building ${building})`;
		if (!violation && timerRun !== null) violation = "a drain timer still armed with nothing to wait for";
		const foreign = calls.filter((c) => c.ctx !== c.model.tag);
		if (!violation && foreign.length) violation = `context: ${foreign.length} calls reached the provider outside their caller's context (#${foreign[0].id}: ${foreign[0].ctx} for ${foreign[0].model.tag})`;
	} finally {
		layer.restore();
	}
	return { violation, trace, waited: guard.state.waited, refused: guard.state.refused, finalWaits: trace.filter((line) => line.includes('"why":"final-payload"') && line.includes("log cost_wait")).length };
}

test(`issue #985: ${SEEDS} random schedules of waiting calls never pass the cap, never leave a call unended, and dispatch each call in its caller's context`, { skip, timeout: 120_000 }, async () => {
	const failures = [];
	let waited = 0;
	let refused = 0;
	let finalWaits = 0;
	for (let seed = 1; seed <= SEEDS; seed++) {
		const out = await scenario(seed);
		waited += out.waited;
		refused += out.refused;
		finalWaits += out.finalWaits;
		if (out.violation) failures.push(`seed ${seed}: ${out.violation}\n${out.trace.slice(-30).join("\n")}`);
	}
	assert.equal(failures.length, 0, `${failures.length} of ${SEEDS} seeds broke an invariant; the first:\n${failures.slice(0, 1).join("\n")}`);
	// The schedules must exercise what they claim to: waits at admission and at the final payload, and refusals.
	assert.ok(waited > 500 && finalWaits > 50 && refused > 50, `the schedules waited ${waited} times (${finalWaits} at a final payload) and refused ${refused}`);
});
