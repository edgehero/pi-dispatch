import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import * as nodeFs from "node:fs";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { test } from "node:test";
import { createChildWatch } from "../src/child-watch.mjs";
import { childLedgerName, createPolicyGuard, createUsageMeter, makeDeferredStream, makeHardStopStream, resolvePiAiCompat, startChildMeter, wrapModelRuntime } from "../src/usage-meter.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #985, part 2: waiting ACROSS processes under random schedules. One parent and three pi children, each as the
 * runner builds it, in one Node process for the test's sake: the parent's REAL createPolicyGuard wired to a REAL
 * createChildWatch (fold, SPENT, STOP) over a real ledger directory, as run-job.mjs wires them; each child a REAL
 * startChildMeter (its policy guard reading SPENT, its pre-dispatch and final-payload ledger writes, its STOP check), its
 * install captured so both are wrapped by the real wrapModelRuntime with pi's own AssistantMessageEventStream. Every
 * bound is the real callCostBound's (input free, output at $1 per million tokens, so a bound in micro-dollars is the
 * output limit), and a final body's `max_tokens` above the model's grows the hold at its onPayload. A fake provider
 * awaits onPayload before it "sends", the order every priced api module keeps (pinned in pinned-api.test.mjs). Each
 * seed runs random steps: calls in any process (some aborted, some growing at their final payload), settles (some at
 * their whole bound, some failed after they started), each process's drain timer with the clock moved (past the idle
 * limit now and then), the parent's tick (fold, judge, SPENT, STOP), and a parent stop now and then. Then everything
 * left is settled.
 *
 * THE CAP ACROSS PROCESSES. Each process's true holding is its guard's spent plus in flight; the job's is their sum.
 * - FRESH seeds run the parent's tick after every step, so every process judges the others as they are: the job's sum
 *   never passes the cap, at every step and every flush.
 * - WAITING seeds run the tick at random while one child waits from the first tick to the end (a call of 1200 behind its
 *   own held 900), so every admission anywhere, fresh calls of the parent and the other children included, takes its
 *   turn: the job's sum never passes the cap, with no residual, at every step and every flush. They also land steps
 *   where no tick of the real runner could be watched: a child's call, settle or drain INSIDE the parent's tick
 *   (between its ledger reads and its SPENT write), the parent's tick and another process's call INSIDE a child's claim
 *   (between its reading of SPENT and its claim file), and forwards made under HOLDING, which may not wait.
 * - STALE seeds run the tick at random, and the named residual of DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY applies: a
 *   process judges the others as of the last tick. The check is that residual, exactly: the job's sum is within the cap
 *   plus what the other processes grew since the tick the last admission judged against (a process's growth since a
 *   tick is the most that tick's SPENT, or fold, could have missed). A ledger that lagged its guard (a hold grown at a
 *   final payload and never written) would break it.
 * In both, every SENT call is held at its true worst case in its own process, and at the end every answer ended,
 * nothing is held, nothing waits, and every call reached its provider in its caller's async context.
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
if (!compat && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw new Error(`the cross-process fuzz is REQUIRED here but pi-ai could not be imported.\n${importError}`);
const skip = compat ? false : `pi not installed (node ${process.version}); CI runs these`;

const SEEDS = 160;
const STEPS = 110;
const CAP = 2000;
const CHILDREN = 3;
const IDLE_JUMP = 16 * 60 * 1000;

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
/** Input free, output at $1 per million tokens: callCostBound's bound in micro-dollars is the output limit. */
const modelOf = (id, bound) => ({ id, name: id, provider: "fake", api: "openai-completions", baseUrl: "http://127.0.0.1:1", reasoning: false, input: ["text"], cost: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: bound, compat: { maxTokensField: "max_tokens" } });

async function scenario(seed) {
	const createStream = compat.createAssistantMessageEventStream;
	const r = rng(seed);
	const pick = (n) => Math.floor(r() * n);
	// Three kinds of seed (see the header): fresh ticks, stale ticks, and stale ticks while a child waits throughout.
	const kind = ["waiting", "fresh", "stale"][seed % 3];
	const fresh = kind === "fresh";
	const waitingSeed = kind === "waiting";
	const trace = [];
	const say = (line) => trace.push(line);
	const clock = { now: 0 };
	const dir = tempDir("pi-dispatch-child-wait-fuzz-");
	const caller = new AsyncLocalStorage();
	const calls = [];
	const processes = [];
	let violation = null;

	/** One simulated process: its guard (spend()), its runtime class, its drain timer, and the calls it made. */
	function makeProcess(label, { meter, guard, isStopped = null }) {
		const proc = { label, meter, guard, timerRun: null, layer: null, Runtime: null };
		class Runtime {
			streamSimple(model, context, options) {
				return provide(proc, model, options);
			}
		}
		proc.Runtime = Runtime;
		proc.runtime = new Runtime();
		// Each process's own HOLDING, so a call can be made under an admitted dispatch (a forward: it may not wait).
		proc.holding = new AsyncLocalStorage();
		proc.layer = wrapModelRuntime({ ModelRuntime: Runtime, meter, guard, isStopped, hardStop: makeHardStopStream({ createStream }), deferred: makeDeferredStream({ createStream }), holding: proc.holding });
		processes.push(proc);
		return proc;
	}
	const timerFor = (box) => ({ setTimer: (run) => ((box.timerRun = run), { unref() {}, ref() {} }), clearTimer: () => (box.timerRun = null) });

	// The parent, wired as run-job.mjs wires it.
	const parentBox = { timerRun: null };
	let hook = null;
	const parentMeter = createUsageMeter({ maxTokens: null, maxCostMicros: CAP, rootSessionId: "root", onStop: (reason) => hook?.stopped(reason) });
	const parentLog = [];
	const parentGuard = createPolicyGuard({ maxCostMicros: CAP, env: {}, log: (event, fields) => (parentLog.push(event), say(`  parent ${event} ${JSON.stringify(fields)}`)), external: () => hook.external(), externalInflight: () => hook.externalInflight(), claim: (waited) => hook.claim(waited), outsideWaiting: () => hook.outsideWaiting(), now: () => clock.now, ...timerFor(parentBox) });
	// The parent's fold reads ledgers through this fs: `hooks.foldOpen(name)` runs right after a ledger is opened, so a
	// step can land INSIDE the parent's tick, between its ledger reads and its SPENT write, where the turn's rules for
	// that moment matter. A child's claim is created through `hooks.claimOpen(label)` first, so a step can land between a
	// child's reading of SPENT and its claim.
	const hooks = { foldOpen: null, claimOpen: null };
	const foldFs = { ...nodeFs, readdirSync: nodeFs.readdirSync, lstatSync: nodeFs.lstatSync, fstatSync: nodeFs.fstatSync, readSync: nodeFs.readSync, closeSync: nodeFs.closeSync, constants: nodeFs.constants, openSync: (path, flags) => {
		const fd = nodeFs.openSync(path, flags);
		hooks.foldOpen?.(basename(String(path)));
		return fd;
	} };
	hook = createChildWatch({ dir, meter: parentMeter, guard: () => parentGuard, proc: null, now: () => 0, foldFs });
	const parent = makeProcess("parent", { meter: parentMeter, guard: parentGuard });
	parent.box = parentBox;

	// The children, each started as a pi child starts its meter, its install captured.
	for (let k = 0; k < CHILDREN; k++) {
		const box = { timerRun: null };
		let captured = null;
		const install = async (options) => {
			captured = options;
			return { ok: true, covers: () => true };
		};
		const name = childLedgerName(7000 + k, (bytes) => bytes.fill(k + 1));
		const label = `child${k}`;
		const writeFs = { openSync: (path, ...rest) => {
			if (basename(String(path)).startsWith("CLAIM.")) hooks.claimOpen?.(label);
			return nodeFs.openSync(path, ...rest);
		}, fstatSync: nodeFs.fstatSync, writeSync: nodeFs.writeSync, closeSync: nodeFs.closeSync, renameSync: nodeFs.renameSync, rmSync: nodeFs.rmSync, constants: nodeFs.constants };
		const child = await startChildMeter({ ModelRuntime: class {}, compat: { module: {}, fallbackModels: null }, env: { PI_MAX_COST_MICROS: String(CAP) }, dir, name, install, onExit: () => {}, now: () => clock.now, writeFs, ...timerFor(box) });
		if (!child?.ok || captured === null) throw new Error(`child ${k} did not start`);
		const proc = makeProcess(label, { meter: captured.meter, guard: captured.guard, isStopped: captured.isStopped });
		proc.box = box;
		proc.ledgerName = name;
	}
	const holding = (proc) => {
		const { spentMicros, inflightMicros } = proc.guard.spend();
		return spentMicros + inflightMicros;
	};

	// The residual's bookkeeping: each process's holding at the last tick, and at the tick the last admission judged against.
	let snapshotNow = processes.map(holding);
	let snapshotAdmission = snapshotNow;
	let lastTotals = processes.map(holding);
	const tick = () => {
		hook.sample();
		snapshotNow = processes.map(holding);
		say(`  tick: holdings ${snapshotNow.join(" ")} stop ${parentMeter.state.stopReason}`);
	};

	const sentHeld = (proc) => calls.filter((c) => c.proc === proc && c.state === "sent").reduce((sum, c) => sum + c.finalBound, 0);
	const check = (label) => {
		if (violation) return;
		const now = processes.map(holding);
		// A process whose holding rose since the last check admitted (or grew) a call against the current tick's view.
		if (now.some((value, i) => value > lastTotals[i])) snapshotAdmission = snapshotNow;
		lastTotals = now;
		const total = now.reduce((a, b) => a + b, 0);
		const allowance = fresh || waitingSeed ? 0 : now.reduce((sum, value, i) => sum + Math.max(0, value - Math.min(snapshotNow[i], snapshotAdmission[i])), 0);
		if (total > CAP + allowance) violation = `cap ${label}: ${now.join(" + ")} = ${total} > ${CAP}${allowance === 0 ? "" : ` + the residual ${allowance}`}`;
		for (const proc of processes) {
			const held = sentHeld(proc);
			if (held > proc.guard.spend().inflightMicros) violation ??= `held ${label}: ${proc.label} sent, unsettled worst cases ${held} > in flight ${proc.guard.spend().inflightMicros}`;
		}
	};

	// The provider: awaits onPayload, then "sends" what the hook returned.
	function provide(proc, model, options) {
		const rec = { id: calls.length + 1, proc, model, state: "building", finalBound: null, ctx: caller.getStore(), stream: createStream() };
		calls.push(rec);
		(async () => {
			await Promise.resolve();
			let payload = { model: model.id, max_tokens: model.grow ?? model.maxTokens };
			try {
				const next = await options?.onPayload?.(payload, model);
				if (next !== undefined) payload = next;
			} catch (error) {
				rec.state = "withheld";
				const reason = options?.signal?.aborted ? "aborted" : "error";
				const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zero(), stopReason: reason, errorMessage: String(error?.message ?? error), timestamp: 0 };
				rec.stream.push({ type: "error", reason, error: message });
				rec.stream.end();
				return;
			}
			if (options?.signal?.aborted) {
				rec.state = "withheld";
				const message = { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: zero(), stopReason: "aborted", errorMessage: "aborted before send", timestamp: 0 };
				rec.stream.push({ type: "error", reason: "aborted", error: message });
				rec.stream.end();
				return;
			}
			rec.state = "sent";
			rec.finalBound = Math.max(model.maxTokens, payload.max_tokens);
			say(`  send #${rec.id} in ${proc.label} worst ${rec.finalBound}`);
			check(`send #${rec.id}`);
		})();
		return rec.stream;
	}

	const settle = (c, micros, failed) => {
		const cost = micros / 1e6;
		c.state = "settled";
		const final = { role: "assistant", content: [{ type: "text", text: "ok" }], api: c.model.api, provider: c.model.provider, model: c.model.id, usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11, cost: { input: 0, output: cost, cacheRead: 0, cacheWrite: 0, total: cost } }, stopReason: failed ? "error" : "stop", ...(failed ? { errorMessage: "cut" } : {}), timestamp: 0 };
		c.stream.push({ type: "start", partial: final });
		c.stream.push({ type: "text_delta", contentIndex: 0, delta: "ok", partial: final });
		if (failed) c.stream.push({ type: "error", reason: "error", error: final });
		else c.stream.push({ type: "done", reason: "stop", message: final });
		c.stream.end();
	};

	const answers = [];
	try {
		if (fresh) tick();
		if (waitingSeed) {
			// A child that waits for the whole schedule: its long call holds 900 (never settled until the end), and its next
			// call of 1200 waits for it (900 + 1200 > 2000; it fits once the 900 settles while settled spend stays small).
			// From the first tick on every process knows someone waits, so every admission anywhere takes its turn.
			const child0 = processes[1];
			caller.run("long", () => child0.runtime.streamSimple({ ...modelOf("long", 900), tag: "long" }, { messages: [] }, {}));
			await flush();
			const long = calls.at(-1);
			long.pinned = true;
			let blocked;
			caller.run("blocked", () => (blocked = child0.runtime.streamSimple({ ...modelOf("blocked", 1200), tag: "blocked" }, { messages: [] }, {})));
			answers.push({ step: -1, answer: blocked, controller: null, tag: "blocked", proc: child0, deferred: true, cross: false });
			await flush();
			tick();
			check("the waiting child published");
			say(`  waiting seed: long #${long.id} held, the blocked call waits (SPENT waiting ${JSON.parse(readFileSync(join(dir, "SPENT"), "utf8")).waiting})`);
		}
		// One call in `proc`; in a waiting seed sometimes under the process's own HOLDING, as a forward is made: such a
		// call may not wait, so without its turn it is refused, never admitted.
		let calln = 0;
		const doCall = (label, proc) => {
			calln += 1;
			const bound = 100 + pick(7) * 100;
			const growKind = pick(4);
			const grow = growKind === 0 ? bound + (1 + pick(5)) * 100 : bound;
			const controller = r() < 0.2 ? new AbortController() : null;
			const forward = waitingSeed && r() < 0.04;
			const tag = `ctx${calln}`;
			const model = { ...modelOf(`m${calln}`, bound), grow, tag };
			const before = calls.length;
			const ownInflight = proc.guard.spend().inflightMicros;
			let answer;
			const run = () => caller.run(tag, () => {
				answer = proc.runtime.streamSimple(model, { messages: [] }, controller ? { signal: controller.signal } : {});
			});
			if (forward) proc.holding.run(true, run);
			else run();
			// Not dispatched and nothing stopped: the call waits, answered with a placeholder.
			const deferred = calls.length === before && proc.meter.state.stopReason === null;
			answers.push({ step: label, answer, controller, tag, proc, deferred, cross: deferred && ownInflight === 0, forward, inside: label.includes("[inside") });
			say(`${label}: call in ${proc.label} bound ${bound} grow ${grow}${controller ? " abortable" : ""}${forward ? " forward" : ""}${deferred ? " waits" : ""}`);
			check(`${label} call`);
		};
		const doSettle = (label) => {
			const sent = calls.filter((c) => c.state === "sent" && !c.pinned);
			if (!sent.length) return;
			const c = sent[pick(sent.length)];
			// A waiting seed settles small, so the blocked call's wait can help to the end.
			const mode = waitingSeed ? 2 : pick(12);
			const micros = mode === 0 ? c.finalBound : Math.floor(r() * c.finalBound * (waitingSeed ? 0.02 : 0.05));
			say(`${label}: settle #${c.id} in ${c.proc.label} mode ${mode} micros ${micros}`);
			settle(c, micros, mode === 1);
		};
		const doDrain = (label, proc) => {
			clock.now += r() < 0.15 && !waitingSeed ? IDLE_JUMP : 500;
			say(`${label}: drain timer of ${proc.label}, clock ${clock.now}`);
			proc.box.timerRun?.();
			check(`${label} drain`);
		};
		const children = processes.slice(1);
		if (waitingSeed) {
			// A step between a child's reading of SPENT and its claim: the parent ticks and another process calls, so a
			// turn could be won twice across the generation boundary unless the claimer reads the generation again.
			let inside = false;
			hooks.claimOpen = (label) => {
				if (inside || r() > 0.25) return;
				inside = true;
				try {
					say(`  [inside ${label}'s claim] the parent's tick, then a call elsewhere`);
					tick();
					const others = processes.filter((proc) => proc.label !== label);
					doCall(`  [inside ${label}'s claim]`, others[pick(others.length)]);
				} finally {
					inside = false;
				}
			};
		}
		for (let step = 0; step < STEPS && !violation; step++) {
			const roll = r();
			if (roll < 0.34) doCall(`step ${step}`, processes[pick(processes.length)]);
			else if (roll < 0.6) doSettle(`step ${step}`);
			else if (roll < 0.68) {
				const live = answers.filter((a) => a.controller && !a.controller.signal.aborted);
				if (live.length) {
					const a = live[pick(live.length)];
					say(`step ${step}: abort the call of ${a.step}`);
					a.controller.abort();
				}
			} else if (roll < 0.86) doDrain(`step ${step}`, processes[pick(processes.length)]);
			else if (roll < 0.985) {
				if (waitingSeed && r() < 0.5) {
					// A child's call, settle or drain INSIDE the parent's tick, between its ledger reads and its SPENT write,
					// most often in the child whose ledger the fold has just opened, so what it admits is missing from this
					// SPENT (the fold read the file as it was) and shows only in the next: the moment the turn's two
					// schedule rules exist for.
					const target = children[pick(children.length)];
					const at = target.ledgerName;
					const kind = pick(3);
					let fired = false;
					hooks.foldOpen = (file) => {
						if (fired || file !== at) return;
						fired = true;
						const label = `step ${step} [inside the tick]`;
						const who = r() < 0.75 ? target : children[pick(children.length)];
						if (kind === 0) doCall(label, who);
						else if (kind === 1) doSettle(label);
						else doDrain(label, who);
					};
					say(`step ${step}: the parent's tick, a step inside it`);
					tick();
					hooks.foldOpen = null;
				} else if (!fresh) {
					say(`step ${step}: the parent's tick`);
					tick();
				}
			} else if (!waitingSeed) {
				say(`step ${step}: parent meter stop`);
				parentMeter.stop("token_budget");
			}
			check(`after step ${step}`);
			await flush();
			check(`flush after step ${step}`);
			if (fresh) {
				tick();
				check(`tick after step ${step}`);
			}
		}
		hooks.claimOpen = null;
		// Settle everything still sent, then run every drain timer, until nothing moves. One process acts at a time, with
		// the parent's tick after each, as in a fresh step: a settle or a drain in one process admits only its own waiters.
		const settled = async (label) => {
			await flush();
			check(label);
			tick();
			check(`${label}, tick`);
		};
		for (let pass = 0; pass < 1500 && !violation; pass++) {
			await settled(`drain pass ${pass}`);
			const sent = calls.filter((c) => c.state === "sent");
			for (const c of sent) {
				settle(c, Math.floor(c.finalBound * 0.1), false);
				await settled(`drain pass ${pass}, #${c.id} settled`);
			}
			if (sent.length === 0) {
				if (processes.every((proc) => proc.box.timerRun === null) && calls.every((c) => c.state !== "building")) break;
				clock.now += 1000;
				for (const proc of processes) {
					proc.box.timerRun?.();
					await settled(`drain pass ${pass}, ${proc.label}'s timer`);
				}
			}
		}
		await flush();
		let unended = 0;
		for (const a of answers) {
			const outcome = await Promise.race([a.answer.result().then(() => "ended", () => "ended"), flush().then(flush).then(() => "hung")]);
			if (outcome === "hung") unended += 1;
		}
		const building = calls.filter((c) => c.state === "building").length;
		if (!violation && unended > 0) violation = `ended: ${unended} answers never ended (building ${building})`;
		for (const proc of processes) {
			if (!violation && proc.guard.spend().inflightMicros !== 0) violation = `held at the end: ${proc.label} in flight ${proc.guard.spend().inflightMicros}`;
			if (!violation && proc.box.timerRun !== null) violation = `${proc.label}: a drain timer still armed with nothing to wait for`;
		}
		const foreign = calls.filter((c) => c.ctx !== c.model.tag);
		if (!violation && foreign.length) violation = `context: ${foreign.length} calls reached the provider outside their caller's context`;
	} finally {
		for (const proc of processes) proc.layer.restore();
	}
	const ran = new Set(calls.map((c) => c.ctx));
	const count = (predicate) => answers.filter(predicate).length;
	return {
		violation,
		trace,
		kind,
		sends: calls.filter((c) => c.state === "settled").length,
		childWaits: count((a) => a.deferred && a.proc !== parent),
		childCrossWaits: count((a) => a.cross && a.proc !== parent),
		childRanAfterWait: count((a) => a.cross && a.proc !== parent && ran.has(a.tag)),
		parentCrossWaits: count((a) => a.cross && a.proc === parent),
		parentFinalWaits: trace.filter((line) => line.startsWith("  parent cost_wait") && line.includes('"why":"final-payload"')).length,
		refusals: parentLog.filter((event) => event === "cost_refused").length,
		waitingSeedSends: waitingSeed ? calls.filter((c) => c.state === "settled" && !c.pinned && c.model.tag !== "blocked").length : 0,
		turnWaits: trace.filter((line) => line.startsWith("  parent cost_wait") && line.includes('"why":"turn"')).length,
		blockedRan: waitingSeed && calls.some((c) => c.model.tag === "blocked") ? 1 : 0,
		forwards: count((a) => a.forward),
		forwardsSent: count((a) => a.forward && ran.has(a.tag)),
		insideCalls: count((a) => a.inside),
		insideSent: count((a) => a.inside && ran.has(a.tag)),
		claimRaces: trace.filter((line) => line.includes("claim] the parent's tick")).length,
	};
}

test(`issue #985: ${SEEDS} random schedules of a parent and ${CHILDREN} pi children waiting for each other never pass the cap beyond the named residual, never leave a call unended, and dispatch each call in its caller's context`, { skip, timeout: 240_000 }, async () => {
	const failures = [];
	const totals = { sends: 0, childWaits: 0, childCrossWaits: 0, childRanAfterWait: 0, parentCrossWaits: 0, parentFinalWaits: 0, refusals: 0, waitingSeedSends: 0, turnWaits: 0, blockedRan: 0, forwards: 0, forwardsSent: 0, insideCalls: 0, insideSent: 0, claimRaces: 0 };
	for (let seed = 1; seed <= SEEDS; seed++) {
		const out = await scenario(seed);
		for (const key of Object.keys(totals)) totals[key] += out[key];
		if (out.violation) failures.push(`seed ${seed} (${out.kind}): ${out.violation}\n${out.trace.slice(-40).join("\n")}`);
	}
	assert.equal(failures.length, 0, `${failures.length} of ${SEEDS} seeds broke an invariant; the first:\n${failures.slice(0, 1).join("\n")}`);
	// The schedules must exercise what they claim to: children waiting for holds elsewhere and then running, the parent
	// waiting for its children (at admission and at a final payload), and refusals.
	// The waiting seeds must have run fresh calls in several processes beside the waiting child, taken turns, raced claims
	// across a generation boundary, made calls inside the parent's tick and forwards that may not wait (some admitted in
	// their turn, the rest refused), and let the blocked call run at the end of some.
	assert.ok(totals.sends > 1000 && totals.childCrossWaits > 100 && totals.childRanAfterWait > 50 && totals.parentCrossWaits > 20 && totals.parentFinalWaits > 5 && totals.refusals > 5, JSON.stringify(totals));
	assert.ok(totals.waitingSeedSends > 300 && totals.turnWaits > 20 && totals.blockedRan > 10 && totals.claimRaces > 50 && totals.insideCalls > 40 && totals.insideSent > 20 && totals.forwards > 40 && totals.forwardsSent > 10, JSON.stringify(totals));
});
