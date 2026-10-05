import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { test } from "node:test";
// Both of these are pure -- no static pi import anywhere in their module graph -- so they load
// unconditionally and the gate below applies only to pi itself.
import { attachTokenBudget } from "../src/token-budget.mjs";
import { createJobModelRuntime } from "../src/model-runtime.mjs";
import { assertPoliciesEnforceable, callCostBound, createCostGuard, createPolicyGuard, createUsageMeter, foldChildLedgers, installProcessUsageMeter, policyEnforcement, resolvePiAiCompat } from "../src/usage-meter.mjs";
import { decideExit, EXIT_POLICY, MODEL_NOT_ALLOWED } from "../src/outcome.mjs";
import { dollarSettlement } from "../../../worker/src/dollar-budget.mjs";
import { parseExitTokens } from "../../../worker/src/run-history.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { trackPiRefreshes } from "./helpers/track-pi-refreshes.mjs";

/**
 * THE PROOF for issue #58 (REQ-TOKEN-ACCOUNTING-AND-CAPS, CONST-BUDGET-BEFORE-TOKENS).
 *
 * usage-meter.test.mjs verifies the accumulator with everything pi-shaped injected. That is the right
 * shape for the arithmetic and the wrong shape for the CLAIM this commit rests on, which is about the
 * real SDK: that two AgentSessions alive in one process are invisible to each other's event bus, and
 * that metering at ModelRuntime.prototype (the 0.99.1 choke point, issue #509) sees both. A fake class
 * cannot falsify either half -- only a real `createAgentSession` can. The two sessions run on two
 * SEPARATE ModelRuntime instances, as a subagent extension that builds its own would, because "the
 * prototype covers every instance" is the claim the redesign rests on.
 *
 * Every install here must report ok:true AND count what reached the provider: a meter degraded to
 * ok:false would make run-job fall back to the per-session bus meter, and a test that tolerated that
 * would pass exactly when the process-wide meter had silently died, which is what happened at the pin
 * bump before this rewrite (`usage_meter_unavailable`).
 *
 * There is NO API credential here and none is needed. The fixture declares a CUSTOM provider whose
 * api id is served by a `streamSimple` we register ourselves (the extension-provider path,
 * ModelRuntime.registerProvider), so the whole run is offline: nothing is dialled, and the baseUrl
 * points at a port that is not listening precisely so a regression that DOES try to dial fails loudly
 * instead of quietly reaching the internet.
 *
 * Gated exactly like loader.test.mjs: a skip is NOT a pass. CI sets PI_DISPATCH_REQUIRE_LOADER_TESTS=1,
 * which turns a skip into a hard failure, because "the proof did not run" must never read as green.
 */
let pi;
let importError;
try {
	pi = await import("@earendil-works/pi-coding-agent");
	trackPiRefreshes(pi.ModelRuntime);
} catch (error) {
	importError = error;
}

const required = process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1";
if (!pi && required) {
	throw new Error(
		`the usage-meter integration proof is REQUIRED here but pi could not be imported -- a skip would hide the gap #58 names.\n${importError}`,
	);
}
const skip = pi ? false : `pi not installed (node ${process.version} < 22.19.0); CI runs these`;

/** Distinctive enough that no coincidental sum of real numbers could produce it. */
const SENTINEL_TOTAL = 4242;
const SENTINEL_COST = 0.0042;
const SENTINEL_USAGE = {
	input: 3000,
	output: 1000,
	cacheRead: 242,
	cacheWrite: 0,
	// The BILLED total, which is why it exceeds input+output -- the same convention token-budget.mjs
	// and the meter both key their caps on.
	totalTokens: SENTINEL_TOTAL,
	cost: { input: 0.003, output: 0.001, cacheRead: 0.0002, cacheWrite: 0, total: SENTINEL_COST },
};

const PROVIDER = "pi-dispatch-fake";
const MODEL_ID = "fake-1";
/**
 * A LITERAL key. resolve-config-value treats a string with no "$" and no leading "!" as a literal, so
 * this reads nothing from the environment and spawns no shell -- the fixture cannot pick up a real
 * credential from the machine running it.
 */
const FAKE_KEY = "pi-dispatch-fake-key-sentinel";

/**
 * A temp agent root whose models.json declares the custom provider.
 *
 * `api` is parameterised so each test's provider is its own: the compat half wraps every api id in the
 * registry at arm() time and never unwraps (re-registering the builtin would need a resetApiProviders()),
 * and a per-test api id keeps one test's registrations out of the next test's way.
 */
async function fixture(api, modelOverrides = {}, extraModelIds = []) {
	const root = tempDir("pi-dispatch-meter-");
	const modelsPath = join(root, "models.json");
	writeFileSync(
		modelsPath,
		`${JSON.stringify(
			{
				providers: {
					[PROVIDER]: {
						apiKey: FAKE_KEY,
						// Port 1 is privileged and unbound. Never dialled -- our streamSimple returns a
						// settled stream before any transport is constructed -- so a regression that
						// reaches the wire fails here instead of silently talking to something.
						baseUrl: "http://127.0.0.1:1",
						api,
						// `extraModelIds`: more models on the same provider and api (issue #502's tests switch to one).
						models: [MODEL_ID, ...extraModelIds].map((id) => ({
							id,
							name: "pi-dispatch fake",
							api,
							reasoning: false,
							input: ["text"],
							cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 100000,
							maxTokens: 4096,
							...modelOverrides,
						})),
					},
				},
			},
			null,
			"\t",
		)}\n`,
	);

	// Built the way run-job.mjs builds it. Each call makes a NEW runtime on the same files.
	const runtime = () => createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, agentDir: root, modelsPath });
	const modelRuntime = await runtime();
	const model = modelRuntime.getModel(PROVIDER, MODEL_ID);
	assert.ok(model, "the fixture's custom model must resolve out of models.json");
	assert.ok(modelRuntime.hasConfiguredAuth(model.provider), "the fixture's literal apiKey must count as configured auth");
	return { root, modelRuntime, runtime, model, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Register the provider that serves the fixture's api id, on one runtime.
 *
 * Through `ModelRuntime.registerProvider`, which is exactly where an extension's `pi.registerProvider`
 * lands at 0.99.1 (agent-session.js, `this._modelRuntime.registerProvider`): the composed provider then
 * calls this streamSimple for the api (provider-composer.js). `calls` records what actually reached the
 * provider, which is how the hard-stop test proves a capped call never got there.
 */
function registerFakeProvider({ modelRuntime, compat, api, calls, usage = SENTINEL_USAGE, delayMs = 0 }) {
	modelRuntime.registerProvider(PROVIDER, {
		api,
		streamSimple(model, _context, options) {
			calls.push({ sessionId: options?.sessionId, apiKey: options?.apiKey, model: model.id });
			const stream = compat.createAssistantMessageEventStream();
			// A terminal "done" resolves result() via EventStream's completion predicate -- the exact
			// channel meter.observe() reads, and the one the agent loop awaits. `delayMs` holds the call in
			// flight, which is how the cost-cap test makes two sessions' calls overlap.
			const finish = () => stream.push({
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage,
					stopReason: "stop",
					timestamp: Date.now(),
				},
			});
			if (delayMs > 0) setTimeout(finish, delayMs);
			else finish();
			return stream;
		},
	});
	// registerProvider starts a refresh it does not await (model-runtime.js, `void this.refresh(...)`), and that
	// refresh writes auth.json into the fixture root. Settle it here so it can neither race the prompt nor
	// recreate the root after cleanup (a leaked temp dir the suite's TMPDIR check would name).
	return modelRuntime.refresh({ allowNetwork: false });
}

/**
 * A session on the fixture's model.
 *
 * The SessionManager is passed IN rather than created here because the root one must exist before the
 * meter does -- rootSessionId is what splits rootTotal from otherTotal, and a meter built without it
 * files every call as unattributed. That ordering constraint is exactly why run-job.mjs hoists it.
 *
 * A minimal DefaultResourceLoader is supplied so the test stays hermetic: with none, createAgentSession
 * builds its own and discovers context files, skills and extensions from cwd and ~/.pi -- which would
 * make this proof depend on whatever is installed on the machine running it.
 *
 * THE THREE FLAGS BELOW DELIBERATELY DO NOT MATCH image/runner/src/loader.mjs, and this is the note that
 * keeps them from being "fixed". The runner runs pi-normal (noContextFiles:false, noExtensions:false,
 * noSkills:true) because a job's /workspace is merge-gated (CONST-NO-CONTEXT-FILES-MANDATORY, amended).
 * This file is not a job: it runs on a developer's box and on CI, where noExtensions:false would discover
 * ~/.pi/agent/extensions and RUN their factories inside a test that counts provider calls -- an extension
 * registering its own api provider is precisely what trap (h) in INT-SDK-SESSION-OPTIONS is about, so a
 * synced config would let the machine's pi setup change the number under assertion. Suppressing all three
 * is what makes `calls` mean what the assertions say it means. The loader posture is pinned where it IS
 * the subject -- image/runner/test/loader.test.mjs, which builds through buildResourceLoader itself.
 */
async function openSession({ fx, modelRuntime, sessionManager, settings = {}, model = fx.model, extensionFactories = [] }) {
	const settingsManager = pi.SettingsManager.inMemory(settings);
	const resourceLoader = new pi.DefaultResourceLoader({
		cwd: fx.root,
		agentDir: pi.getAgentDir(),
		settingsManager,
		noContextFiles: true,
		noSkills: true,
		noExtensions: true,
		// Inline factories only: an extension a test defines itself, never one discovered on the machine.
		extensionFactories,
	});
	await resourceLoader.reload();
	const { session } = await pi.createAgentSession({
		cwd: fx.root,
		agentDir: pi.getAgentDir(),
		modelRuntime,
		model,
		settingsManager,
		sessionManager,
		resourceLoader,
		// "all", not `true`: CreateAgentSessionOptions.noTools is the union "all" | "builtin" at the
		// 0.99.1 pin, as at 0.80.7. No tools at all keeps every prompt to exactly one provider call, so `calls` counts what
		// it claims to count.
		noTools: "all",
	});
	return session;
}

/** Let the meter's result()-handler microtasks settle before reading totals. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("two concurrent sessions: the process-wide meter sees both, the session bus sees one", { skip }, async () => {
	// THE assertion this commit exists for. Two live AgentSessions stand in for the subagent fanout a
	// staged package's extension creates: same process, same provider, separate event buses. If pi ever
	// starts forwarding a child session's events onto its parent's bus, the CONTROL below goes red and
	// tells you the per-session meter is no longer blind -- rather than leaving usage-meter.mjs in place
	// as unexplained ballast.
	const API = "pi-dispatch-fake-api-concurrent";
	const fx = await fixture(API);
	const sessions = [];
	let installed;
	try {
		// The root SessionManager FIRST: its id must exist before the meter is constructed.
		const rootManager = pi.SessionManager.inMemory(fx.root);
		const otherManager = pi.SessionManager.inMemory(fx.root);
		const rootSessionId = rootManager.getSessionId();
		assert.notEqual(rootSessionId, otherManager.getSessionId(), "the two sessions must have distinct ids");

		const meter = createUsageMeter({ maxTokens: null, rootSessionId });
		const logged = [];
		installed = await installProcessUsageMeter({ ModelRuntime: pi.ModelRuntime, runtime: fx.modelRuntime, meter, log: (event, fields) => logged.push({ event, fields }) });
		assert.equal(installed.ok, true, `the runtime half must install at the pin; logged ${JSON.stringify(logged)}`);
		// Both halves healthy at the pin: the compat copy proven by identity, and the brake present, so a
		// degraded install cannot pass here while reporting itself fine.
		assert.equal(installed.tag, "pi", `the compat half must accept pi's own copy; logged ${JSON.stringify(logged)}`);
		assert.equal(logged[0]?.fields?.compat, "pi");

		// The OTHER session's runtime is built AFTER the install, as a subagent extension's would be: the
		// prototype wrapper must cover it without any re-arm.
		const otherRuntime = await fx.runtime();
		const calls = [];
		await registerFakeProvider({ modelRuntime: fx.modelRuntime, compat: installed.module, api: API, calls });
		await registerFakeProvider({ modelRuntime: otherRuntime, compat: installed.module, api: API, calls });

		const rootSession = await openSession({ fx, modelRuntime: fx.modelRuntime, sessionManager: rootManager });
		const otherSession = await openSession({ fx, modelRuntime: otherRuntime, sessionManager: otherManager });
		sessions.push(rootSession, otherSession);

		// THE CONTROL: the OLD mechanism, attached to the root session exactly as run-job.mjs used to
		// attach it. null cap -- it is here to count, not to abort.
		const sessionBudget = attachTokenBudget(rootSession, null);

		await Promise.all([rootSession.prompt("root prompt"), otherSession.prompt("other prompt")]);
		await flush();

		const snapshot = meter.snapshot();

		// Both calls reached the provider, one per session.
		assert.equal(calls.length, 2, "each session must have made exactly one provider call");
		assert.equal(snapshot.calls, 2, `the meter must have observed both calls; got ${JSON.stringify(snapshot)}`);
		assert.equal(snapshot.total, 2 * SENTINEL_TOTAL, "the meter must total BOTH sessions' billed tokens");
		assert.equal(snapshot.cost, 2 * SENTINEL_COST);
		assert.equal(snapshot.sessions, 2, "the meter must have attributed the calls to two distinct sessions");
		assert.equal(snapshot.unresolved, 0, "every observed stream must have settled before the job ended");
		assert.equal(snapshot.unpriced, 0);
		assert.equal(snapshot.metered, true, "the exit line must be able to tell a metered total from a bus total");

		// The attribution split, and the invariant that makes it trustworthy.
		assert.equal(snapshot.rootTotal, SENTINEL_TOTAL, "the root session's own spend must be attributed to it");
		assert.ok(
			snapshot.otherTotal > 0,
			`otherTotal must be non-zero -- it IS the spend the per-session bus cannot see (issue #58); got ${JSON.stringify(snapshot)}`,
		);
		assert.equal(snapshot.otherTotal, SENTINEL_TOTAL, "the non-root session's spend, in full");
		assert.equal(snapshot.looseTotal, 0, "every call carried a sessionId, so nothing may land unattributed");
		assert.equal(
			snapshot.rootTotal + snapshot.otherTotal + snapshot.looseTotal,
			snapshot.total,
			"the three-way split must partition the total exactly",
		);

		// The per-model ledger, driven through the REAL dispatch chain (issue #53): both sessions' calls
		// must land on the ONE (provider, model) pair the fixture declares -- read off the Model object
		// the runtime dispatched on, not off the settled message -- with the cache split intact that the flat
		// totals above collapse. And `piAi` must carry a real version, because in THIS test the installer
		// read it from the accepted copy's own package.json on disk: the one claim the injected-readText
		// tests in usage-meter.test.mjs cannot make.
		const ledger = meter.usageSnapshot();
		assert.equal(ledger.v, 1);
		assert.equal(ledger.truncated, 0);
		assert.match(ledger.piAi ?? "", /^\d+\.\d+\.\d+/, "piAi must be the accepted copy's on-disk version");
		assert.deepEqual(ledger.models, [
			{
				provider: PROVIDER,
				model: MODEL_ID,
				calls: 2,
				input: 2 * SENTINEL_USAGE.input,
				output: 2 * SENTINEL_USAGE.output,
				cacheRead: 2 * SENTINEL_USAGE.cacheRead,
				cacheWrite: 0,
				cacheWrite1h: 0,
				reasoning: 0,
				total: 2 * SENTINEL_TOTAL,
				cost: 2 * SENTINEL_COST,
				unpriced: 0,
			},
		]);

		// ...and the control, which is the negative half: the old mechanism saw HALF the spend, because
		// the second session never emitted on the first session's bus. A cap built on this number would
		// let a job spend twice its budget and a run record built on it would understate by the same.
		assert.equal(
			sessionBudget.state.total,
			SENTINEL_TOTAL,
			"attachTokenBudget must see ONLY the session it subscribed to -- if this grew, pi now forwards child events",
		);
		assert.ok(
			sessionBudget.state.total < snapshot.total,
			"the per-session bus must undercount relative to the process-wide meter",
		);
		assert.equal(sessionBudget.state.aborted, false);
		sessionBudget.unsubscribe();
	} finally {
		for (const session of sessions) session.dispose();
		installed?.uninstall();
		fx.cleanup();
	}
});

test("the brake: past the cap, the next call is stopped before it reaches the provider", { skip }, async () => {
	// The cap is structurally LAGGING (OQ-010): usage is known only after a call settles, so the two
	// concurrent calls both dispatch before either is counted. What the hard stop guarantees is that the
	// call AFTER the breach never reaches a provider -- a runaway backstop, not a before-the-spend cap.
	// Asserted on the fake provider's own call log, because "the meter recorded zero" would also be true
	// if the request had gone out and simply returned nothing.
	const API = "pi-dispatch-fake-api-brake";
	const fx = await fixture(API);
	const sessions = [];
	let installed;
	try {
		const rootManager = pi.SessionManager.inMemory(fx.root);
		const otherManager = pi.SessionManager.inMemory(fx.root);

		// One token below what two calls cost, so the SECOND settled call trips it and the third is
		// refused. Chosen against the sentinel rather than a round number so an off-by-one in the
		// `> cap` comparison cannot pass.
		const breaches = [];
		const meter = createUsageMeter({
			maxTokens: 2 * SENTINEL_TOTAL - 1,
			rootSessionId: rootManager.getSessionId(),
			onStop: (reason, total) => breaches.push([reason, total]),
		});
		const logged = [];
		installed = await installProcessUsageMeter({ ModelRuntime: pi.ModelRuntime, runtime: fx.modelRuntime, meter, log: (event, fields) => logged.push({ event, fields }) });
		assert.equal(installed.ok, true, `logged ${JSON.stringify(logged)}`);
		// The brake is the subject: a capped install without one would enforce the cap only after the fact.
		assert.deepEqual([logged[0]?.fields?.capped, logged[0]?.fields?.brake], [true, true], "a capped meter must have its brake at the pin");

		const otherRuntime = await fx.runtime();
		const calls = [];
		await registerFakeProvider({ modelRuntime: fx.modelRuntime, compat: installed.module, api: API, calls });
		await registerFakeProvider({ modelRuntime: otherRuntime, compat: installed.module, api: API, calls });

		const rootSession = await openSession({ fx, modelRuntime: fx.modelRuntime, sessionManager: rootManager });
		const otherSession = await openSession({ fx, modelRuntime: otherRuntime, sessionManager: otherManager });
		sessions.push(rootSession, otherSession);

		await Promise.all([rootSession.prompt("root prompt"), otherSession.prompt("other prompt")]);
		await flush();

		assert.equal(meter.state.breached, true, "two sentinel calls must exceed a cap one token below their sum");
		assert.equal(meter.state.stopReason, "token_budget", "the token cap is the stop, by reason");
		assert.deepEqual(breaches, [["token_budget", 2 * SENTINEL_TOTAL]], "onStop fires exactly once, naming the token cap and carrying the running total");
		assert.equal(calls.length, 2);

		// The third request. captureTerminal's two event shapes are covered in compose.test.mjs; here the
		// terminal message is read the same way run-job.mjs reads it.
		let terminal;
		const unsubscribe = rootSession.subscribe((event) => {
			if (event.type === "turn_end") terminal = event.message ?? terminal;
			if (event.type === "agent_end") terminal = event.messages?.at(-1) ?? terminal;
		});
		await rootSession.prompt("this one must not be paid for");
		unsubscribe();

		assert.equal(calls.length, 2, "the capped call must NOT have reached the provider");
		assert.equal(terminal?.stopReason, "aborted", "the hard stop must surface as an abort, not an error");
		assert.equal(terminal?.errorMessage, "pi-dispatch: token cap exceeded", "the hard stop names the stop it answers for");
		// "aborted" rather than "error" is load-bearing: pi's isRetryableAssistantError returns false
		// unless stopReason === "error", so an "error" here would make the cap trigger PAID auto-retries.
		assert.equal(terminal?.usage?.totalTokens, 0, "nothing was spent, so nothing may be recorded as spent");
		assert.equal(terminal?.usage?.cost?.total, 0);

		// And the totals did not move: the refused call is not observed at all (the wrapper returns
		// before meter.observe), so it cannot inflate calls, cost, or the daily token counter.
		// The OTHER runtime is braked too: the cap is process-wide, not per instance.
		await otherSession.prompt("nor this one");
		assert.equal(calls.length, 2, "a capped call from the other runtime must not reach the provider either");
		const snapshot = meter.snapshot();
		assert.equal(snapshot.calls, 2, "a refused call must not be counted as a call");
		assert.equal(snapshot.total, 2 * SENTINEL_TOTAL, "the overshoot is reported as-is; the refusal adds nothing");
	} finally {
		for (const session of sessions) session.dispose();
		installed?.uninstall();
		fx.cleanup();
	}
});

test("compaction is metered: each summary call lands in otherTotal under a fresh session id, and getSessionStats agrees (issue #500)", { skip }, async () => {
	// REQ-TOKEN-ACCOUNTING-AND-CAPS says compaction is counted in otherTotal. This is the behavioural pin for that
	// sentence; pinned-api.test.mjs holds the source needles it rests on (the session's streamFunction is handed to
	// compact(), no session id is passed, and completeSummarization falls back to uuidv7()). A pin bump that moves
	// compaction back onto pi-ai's compat completeSimple, or hands it the root id, turns this red.
	const API = "pi-dispatch-fake-api-compaction";
	const fx = await fixture(API);
	const sessions = [];
	let installed;
	try {
		const rootManager = pi.SessionManager.inMemory(fx.root);
		const rootSessionId = rootManager.getSessionId();
		const meter = createUsageMeter({ maxTokens: null, rootSessionId });
		installed = await installProcessUsageMeter({ ModelRuntime: pi.ModelRuntime, runtime: fx.modelRuntime, meter, log: () => {} });
		assert.equal(installed.ok, true);
		const calls = [];
		await registerFakeProvider({ modelRuntime: fx.modelRuntime, compat: installed.module, api: API, calls });
		const session = await openSession({ fx, modelRuntime: fx.modelRuntime, sessionManager: rootManager, settings: { compaction: { keepRecentTokens: 1 } } });
		sessions.push(session);
		for (const text of ["one", "two", "three"]) await session.prompt(text);
		await flush();
		const before = meter.snapshot();
		assert.deepEqual([calls.length, before.calls, before.sessions, before.rootTotal, before.otherTotal], [3, 3, 1, 3 * SENTINEL_TOTAL, 0], "three root turns, nothing else yet");

		await session.compact();
		await flush();
		const summaries = calls.slice(3);
		const after = meter.snapshot();
		// Measured at the pin: two calls. keepRecentTokens 1 cuts inside the last turn, so pi summarises the history
		// before it and, separately, the split turn's prefix (compaction.js, compact()).
		assert.equal(summaries.length, 2, "compact() makes a history summary and a split-turn prefix summary");
		assert.equal(after.calls, before.calls + summaries.length, "every summary call is a metered call");
		for (const call of summaries) assert.ok(call.sessionId && call.sessionId !== rootSessionId, `a summary call ran under the root id or none: ${JSON.stringify(call)}`);
		assert.equal(new Set(summaries.map((call) => call.sessionId)).size, summaries.length, "each summary call has its own fresh id");
		assert.equal(after.sessions, before.sessions + summaries.length, "sessions rises by one per summary call");
		assert.equal(after.otherTotal, summaries.length * SENTINEL_TOTAL, "the rise lands in otherTotal");
		assert.equal(after.rootTotal, before.rootTotal, "the root session's own total does not move");
		assert.equal(after.looseTotal, 0, "every summary call carried an id");
		assert.equal(after.rootTotal + after.otherTotal + after.looseTotal, after.total);
		assert.equal(meter.usageSnapshot().models[0].calls, 3 + summaries.length, "the model row counts the summary calls");

		// pi's own control: at 0.99.1 getSessionStats() sums the compaction entry's usage too, so a mismatch means
		// one of the two lost a call.
		const stats = session.getSessionStats();
		assert.equal(stats.tokens.total, after.total, `getSessionStats() and the meter disagree: ${JSON.stringify(stats.tokens)}`);
		assert.ok(Math.abs(stats.cost - after.cost) < 1e-12, `cost: ${stats.cost} against ${after.cost}`);
	} finally {
		for (const session of sessions) session.dispose();
		installed?.uninstall();
		fx.cleanup();
	}
});

test("a branch summary is metered too: one call in otherTotal under a fresh session id (issue #500)", { skip }, async () => {
	// The other summary path. navigateTree({ summarize: true }) summarises the abandoned branch through the session's
	// streamFunction, with no session id of its own, so the call must land in otherTotal like compaction's.
	const API = "pi-dispatch-fake-api-branch-summary";
	const fx = await fixture(API);
	const sessions = [];
	let installed;
	try {
		const rootManager = pi.SessionManager.inMemory(fx.root);
		const rootSessionId = rootManager.getSessionId();
		const meter = createUsageMeter({ maxTokens: null, rootSessionId });
		installed = await installProcessUsageMeter({ ModelRuntime: pi.ModelRuntime, runtime: fx.modelRuntime, meter, log: () => {} });
		assert.equal(installed.ok, true);
		const calls = [];
		await registerFakeProvider({ modelRuntime: fx.modelRuntime, compat: installed.module, api: API, calls });
		const session = await openSession({ fx, modelRuntime: fx.modelRuntime, sessionManager: rootManager });
		sessions.push(session);
		await session.prompt("one");
		const firstReply = rootManager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant")[0];
		assert.ok(firstReply, "the first turn's reply must be in the session");
		await session.prompt("two");
		await flush();
		const before = meter.snapshot();
		assert.deepEqual([calls.length, before.rootTotal, before.otherTotal], [2, 2 * SENTINEL_TOTAL, 0]);

		// Back to the first reply: the second turn is the abandoned branch, and it is summarised.
		const result = await session.navigateTree(firstReply.id, { summarize: true });
		await flush();
		assert.equal(result.cancelled, false);
		assert.equal(rootManager.getEntries().filter((entry) => entry.type === "branch_summary").length, 1, "one branch summary was recorded");
		const summaries = calls.slice(2);
		assert.equal(summaries.length, 1, "a branch summary is one provider call");
		assert.ok(summaries[0].sessionId && summaries[0].sessionId !== rootSessionId, `the branch summary ran under the root id or none: ${JSON.stringify(summaries[0])}`);
		const after = meter.snapshot();
		assert.equal(after.calls, before.calls + 1, "the branch summary is a metered call");
		assert.equal(after.otherTotal, SENTINEL_TOTAL, "and it lands in otherTotal");
		assert.equal(after.rootTotal, before.rootTotal, "the root session's own total does not move");
		assert.equal(after.sessions, before.sessions + 1, "under one fresh id");
		assert.equal(after.looseTotal, 0);
	} finally {
		for (const session of sessions) session.dispose();
		installed?.uninstall();
		fx.cleanup();
	}
});

// ── Issue #501: the per-job cost cap, checked BEFORE each call, through the real dispatch chain ────────────
//
// The model is priced on `openai-completions`, one of the PRICED_APIS, so the guard bounds it from the catalog row
// models.json declares, exactly as it would a real provider's: input $1/M, output $100/M, maxTokens 10000. A
// session turn passes no maxTokens, so every call's bound is (request bytes + 8192) x 1 + 10000 x 100: just over
// one dollar (1,000,000 micro-dollars of output plus about 10,000 of input). Each call then SETTLES at a fixed $0.40.
// The margins below are hundreds of thousands of micro-dollars wide, so the request's exact byte count cannot
// move an outcome.
const PRICED_API = "openai-completions";
const PRICED_MODEL = { cost: { input: 1, output: 100, cacheRead: 0, cacheWrite: 0 }, maxTokens: 10000, compat: { maxTokensField: "max_tokens" } };
const FORTY_CENTS = { input: 1000, output: 100, cacheRead: 0, cacheWrite: 0, totalTokens: 1100, cost: { input: 0.001, output: 0.399, cacheRead: 0, cacheWrite: 0, total: 0.4 } };

/** One install with a cost cap, as run-job.mjs builds it: the meter carries the cap, the guard enforces it. */
async function installCapped({ fx, capMicros, rootSessionId }) {
	const stops = [];
	const logged = [];
	const meter = createUsageMeter({ maxTokens: null, maxCostMicros: capMicros, rootSessionId, onStop: (reason) => stops.push(reason) });
	const guard = createCostGuard({ capMicros, log: (event, fields) => logged.push({ event, fields }) });
	const installed = await installProcessUsageMeter({ ModelRuntime: pi.ModelRuntime, runtime: fx.modelRuntime, meter, guard, log: (event, fields) => logged.push({ event, fields }) });
	assert.equal(installed.ok, true, `logged ${JSON.stringify(logged)}`);
	assert.equal(installed.brake, true, "a cost cap needs its brake at the pin");
	assert.deepEqual([...installed.enforces], ["cost-cap"]);
	return { meter, guard, installed, stops, logged };
}

test("cost cap, sequential: the call whose bound would pass the cap is refused before dispatch, and the total stays under it", { skip }, async () => {
	const fx = await fixture(PRICED_API, PRICED_MODEL);
	const sessions = [];
	let installed;
	try {
		const rootManager = pi.SessionManager.inMemory(fx.root);
		// 0.40 settled per call, a bound of about 1.01: the first two calls fit (0 + 1.01, 0.40 + 1.01), the third
		// (0.80 + 1.01 = 1.81) does not.
		const capped = await installCapped({ fx, capMicros: 1_750_000, rootSessionId: rootManager.getSessionId() });
		installed = capped.installed;
		const calls = [];
		await registerFakeProvider({ modelRuntime: fx.modelRuntime, compat: installed.module, api: PRICED_API, calls, usage: FORTY_CENTS });
		const session = await openSession({ fx, modelRuntime: fx.modelRuntime, sessionManager: rootManager });
		sessions.push(session);
		let terminal;
		session.subscribe((event) => {
			if (event.type === "turn_end") terminal = event.message ?? terminal;
		});

		await session.prompt("one");
		await session.prompt("two");
		await flush();
		assert.equal(calls.length, 2);
		assert.equal(capped.guard.state.spent, 800_000, "two settled calls at their real cost");
		assert.equal(capped.meter.state.stopReason, null);

		await session.prompt("three");
		await flush();
		assert.equal(calls.length, 2, "the third call never reached the provider");
		assert.equal(capped.meter.state.stopReason, "cost-cap");
		assert.deepEqual(capped.stops, ["cost-cap"]);
		assert.equal(terminal?.errorMessage, "pi-dispatch: cost cap reached");
		assert.equal(terminal?.stopReason, "aborted", "aborted, so pi does not auto-retry it");
		assert.deepEqual(capped.guard.snapshot(), { costCapMicros: 1_750_000, costRefused: 1, boundExceeded: 0, longContext: 0, costUnjudged: 0, costUnanswered: 0 });
		assert.ok(capped.meter.state.cost * 1e6 <= 1_750_000, "the job's metered total never passed its cap");
		const refusal = capped.logged.find((entry) => entry.event === "cost_refused");
		assert.equal(refusal.fields.spent, 800_000);
		assert.ok(refusal.fields.bound > 1_000_000 && refusal.fields.bound < 1_100_000, `the bound is about a dollar: ${refusal.fields.bound}`);
	} finally {
		for (const session of sessions) session.dispose();
		installed?.uninstall();
		fx.cleanup();
	}
});

test("cost cap, two sessions in parallel: the second call is judged against the first one's bound while it is in flight", { skip }, async () => {
	const fx = await fixture(PRICED_API, PRICED_MODEL);
	const sessions = [];
	let installed;
	try {
		const rootManager = pi.SessionManager.inMemory(fx.root);
		const otherManager = pi.SessionManager.inMemory(fx.root);
		// One bound (about 1.01) fits under 1.75; two at once (about 2.02) do not, though either alone would.
		const capped = await installCapped({ fx, capMicros: 1_750_000, rootSessionId: rootManager.getSessionId() });
		installed = capped.installed;
		const otherRuntime = await fx.runtime();
		const calls = [];
		// Each call stays in flight for 300 ms, far longer than a session takes to reach its first call.
		await registerFakeProvider({ modelRuntime: fx.modelRuntime, compat: installed.module, api: PRICED_API, calls, usage: FORTY_CENTS, delayMs: 300 });
		await registerFakeProvider({ modelRuntime: otherRuntime, compat: installed.module, api: PRICED_API, calls, usage: FORTY_CENTS, delayMs: 300 });
		const rootSession = await openSession({ fx, modelRuntime: fx.modelRuntime, sessionManager: rootManager });
		const otherSession = await openSession({ fx, modelRuntime: otherRuntime, sessionManager: otherManager });
		sessions.push(rootSession, otherSession);

		await Promise.all([rootSession.prompt("root"), otherSession.prompt("other")]);
		await flush();
		assert.equal(calls.length, 1, "exactly one of the two overlapping calls was dispatched");
		assert.deepEqual([capped.guard.state.refused, capped.meter.state.stopReason], [1, "cost-cap"]);
		assert.deepEqual([capped.guard.state.spent, capped.guard.state.inflight], [400_000, 0], "the admitted one settled at its real cost");
		const refusal = capped.logged.find((entry) => entry.event === "cost_refused");
		assert.ok(refusal.fields.inflight > 1_000_000, `the refusal counted the other call in flight: ${JSON.stringify(refusal.fields)}`);
	} finally {
		for (const session of sessions) session.dispose();
		installed?.uninstall();
		fx.cleanup();
	}
});

test("cost cap: session.compact() is a provider call like any other, and is refused when its bound would pass the cap", { skip }, async () => {
	const fx = await fixture(PRICED_API, PRICED_MODEL);
	const sessions = [];
	let installed;
	try {
		const rootManager = pi.SessionManager.inMemory(fx.root);
		// One turn fits (about 1.01); the compaction call after it (0.40 + about 1.01) does not.
		const capped = await installCapped({ fx, capMicros: 1_300_000, rootSessionId: rootManager.getSessionId() });
		installed = capped.installed;
		const calls = [];
		await registerFakeProvider({ modelRuntime: fx.modelRuntime, compat: installed.module, api: PRICED_API, calls, usage: FORTY_CENTS });
		const session = await openSession({ fx, modelRuntime: fx.modelRuntime, sessionManager: rootManager, settings: { compaction: { keepRecentTokens: 1, reserveTokens: 20_000 } } });
		sessions.push(session);
		await session.prompt("one");
		await flush();
		assert.equal(calls.length, 1);
		assert.equal(capped.guard.state.spent, 400_000);
		// The compaction's summarization call goes through the session's streamFn, so it is the runtime half's
		// call to judge. With one exchange and keepRecentTokens 1 pi summarises the split turn's prefix, asking for
		// maxTokens = min(0.5 x reserveTokens, model.maxTokens) = 10000 here, so its bound is a turn's (about 1.01) and
		// 0.40 + 1.01 passes 1.30. (With pi's default reserve it asks for 8192, and its bound is smaller: the guard
		// bounds what each call asks for, not a fixed worst case.)
		await session.compact();
		await flush();
		// MEASURED at the pin, and pinned here as a residual rather than a guarantee: pi does not reject compact()
		// for an aborted summarization. It records the compaction with that call's (empty) text as the split turn's
		// summary. The job is stopped either way (cost-cap, exit 2), so nothing more is spent; what the residual
		// costs is a resumed conversation (run.resume) carrying a summary with nothing in it. The token cap's
		// brake has always done the same to a compaction it answers. If pi starts refusing the compaction instead,
		// this goes red: drop the residual from DES-DOLLAR-RESERVE-AND-SETTLE.
		const compactions = rootManager.getEntries().filter((entry) => entry.type === "compaction");
		assert.equal(compactions.length, 1);
		assert.match(compactions[0].summary, /\*\*Turn Context \(split turn\):\*\*\n\n$/, "the refused call's empty text is the prefix summary");
		assert.equal(calls.length, 1, "the compaction's call never reached the provider");
		assert.deepEqual([capped.guard.state.refused, capped.meter.state.stopReason], [1, "cost-cap"]);
		assert.equal(capped.guard.state.spent, 400_000);
	} finally {
		for (const session of sessions) session.dispose();
		installed?.uninstall();
		fx.cleanup();
	}
});

// ── PR #534's review: a failed call that never started is metered and counted; one that started pays its bound ──
//
// These run pi's REAL openai-completions module against a loopback server: the HTTP status, the SDK's error and
// the message pi settles with are all real. Loopback only, and a literal key, so nothing leaves the machine.

/** A local OpenAI-shaped server. `plan` answers each request in turn: "429", "ok", "nousage" ("ok" with no usage chunk, a server that ignores stream_options), "lost" (no answer), "inband" (200, then an error before content) or "cut" (200, content deltas, then the socket dies). */
async function loopbackOpenAI(plan) {
	const seen = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const step = plan[Math.min(seen.length, plan.length - 1)];
			seen.push(step);
			if (step === "lost") {
				// The request arrived whole; the connection dies before any answer.
				res.socket.destroy();
				return;
			}
			if (step === "429") {
				res.writeHead(429, { "content-type": "application/json", "retry-after": "0", "x-should-retry": "false" });
				res.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit" } }));
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
			const base = { id: "x", object: "chat.completion.chunk", created: 1, model: "priced" };
			if (step === "inband") {
				// A 200, then an error event in the stream before any content (the shape of Anthropic's overloaded_error).
				res.write(`data: ${JSON.stringify({ error: { message: "overloaded", type: "overloaded_error" } })}\n\n`);
				res.end();
				return;
			}
			if (step === "cut") {
				for (let i = 0; i < 50; i++) chunk({ ...base, choices: [{ index: 0, delta: { content: "word " } }] });
				setTimeout(() => res.socket.destroy(), 10);
				return;
			}
			chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] });
			chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
			if (step !== "nousage") chunk({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const root = tempDir("pi-dispatch-loopback-");
	const modelsPath = join(root, "models.json");
	// Under the BUILTIN openai provider, with a model-level baseUrl, so pi dispatches through the provider's own api
	// object. A provider pi does not know would be composed onto the compat registry's openai-completions entry
	// (trap #5), which earlier tests in this file left wrapped by installs whose meters are stopped.
	writeFileSync(modelsPath, JSON.stringify({ providers: { openai: { apiKey: "loopback-literal-key",
		models: [{ id: "loopback-priced", name: "priced", api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: false, input: ["text"], cost: { input: 1, output: 100, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 10000, compat: { maxTokensField: "max_tokens" } }] } } }));
	// The compat registry is process-wide and an install never unwraps it, so the cost-cap tests above left its
	// openai-completions entry wrapped by meters they stopped. pi's own reset puts the builtins back, as
	// AgentSession.reload() would, so this test's install arms a clean registry.
	(await import(resolvePiAiCompat()[0].url)).resetApiProviders();
	const modelRuntime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, agentDir: root, modelsPath });
	const model = modelRuntime.getModel("openai", "loopback-priced");
	assert.ok(model, "the loopback model must resolve under the builtin openai provider");
	return { seen, root, modelRuntime, model, close: () => new Promise((resolve) => server.close(resolve)) };
}

test("cost cap: a 429 is charged its metered cost and counted, so pi's retry after it is admitted and the job completes", { skip }, async () => {
	const lb = await loopbackOpenAI(["429", "ok"]);
	let installed;
	let session;
	try {
		const capped = await installCapped({ fx: { modelRuntime: lb.modelRuntime }, capMicros: 1_500_000, rootSessionId: undefined });
		installed = capped.installed;
		// pi's session retry is on: the 429 ends the first call, and the retry is a second call through the guard.
		const settingsManager = pi.SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 3, baseDelayMs: 1 } });
		const resourceLoader = new pi.DefaultResourceLoader({ cwd: lb.root, agentDir: pi.getAgentDir(), settingsManager, noContextFiles: true, noSkills: true, noExtensions: true });
		await resourceLoader.reload();
		({ session } = await pi.createAgentSession({ cwd: lb.root, agentDir: pi.getAgentDir(), modelRuntime: lb.modelRuntime, model: lb.model, settingsManager, sessionManager: pi.SessionManager.inMemory(lb.root), resourceLoader, noTools: "all" }));
		let terminal;
		session.subscribe((event) => {
			if (event.type === "turn_end") terminal = event.message ?? terminal;
		});
		await session.prompt("hello");
		await flush();
		// One bound (about 1.01) fits under 1.50 and two do not: had the 429 been charged its bound, the retry would
		// have been refused and the job stopped as cost-cap at $0 metered.
		assert.deepEqual(lb.seen, ["429", "ok"]);
		assert.equal(capped.meter.state.stopReason, null);
		assert.equal(capped.guard.state.refused, 0);
		assert.equal(terminal?.stopReason, "stop");
		assert.equal(capped.guard.state.spent, Math.ceil(capped.meter.state.cost * 1e6), "spent is the successful call's cost alone");
		assert.equal(capped.guard.snapshot().costUnanswered, 1, "the 429 is counted: a settlement reads the cost as a floor");
	} finally {
		session?.dispose();
		installed?.uninstall();
		await lb.close();
	}
});

test("cost cap: a 200 cut after content is charged its bound, so a retry loop of cut streams cannot run under the cap", { skip }, async () => {
	const lb = await loopbackOpenAI(["cut"]);
	let installed;
	try {
		const capped = await installCapped({ fx: { modelRuntime: lb.modelRuntime }, capMicros: 100_000_000, rootSessionId: undefined });
		installed = capped.installed;
		const context = { systemPrompt: "s", messages: [{ role: "user", content: "hello", timestamp: 1 }] };
		const options = { maxRetries: 0 };
		const message = await lb.modelRuntime.streamSimple(lb.model, context, options).result();
		await flush();
		assert.equal(message.stopReason, "error", `the cut stream ended in error: ${message.errorMessage}`);
		assert.equal(message.usage.cost.total, 0, "the premise: openai-completions reports usage only at the end");
		assert.ok(message.content.length > 0, "the premise: content came back before the cut");
		assert.equal(capped.guard.state.spent, callCostBound("streamSimple", lb.model, context, options), "it started, so it is charged its bound");
		assert.equal(capped.guard.snapshot().costUnanswered, 0);
		assert.equal(capped.meter.snapshot().costUnreported, 1, "its usage never came: the metered cost is short (issue #571)");
	} finally {
		installed?.uninstall();
		await lb.close();
	}
});

test("cost cap: an answer with no usage chunk is charged its bound and counted costUnreported, so the worker settles the job at the floor (issue #571)", { skip }, async () => {
	const lb = await loopbackOpenAI(["ok", "nousage"]);
	let installed;
	try {
		const cap = 100_000_000;
		const capped = await installCapped({ fx: { modelRuntime: lb.modelRuntime }, capMicros: cap, rootSessionId: undefined });
		installed = capped.installed;
		// As in a job: the children's fold (none here) puts the child keys on the line at zero.
		capped.meter.setChildren(foldChildLedgers({ dir: lb.root }));
		const context = { systemPrompt: "s", messages: [{ role: "user", content: "hello", timestamp: 1 }] };
		const options = { maxRetries: 0 };
		// The premise first: this server sends usage when asked, so the floor below is the missing chunk and nothing else.
		const reported = await lb.modelRuntime.streamSimple(lb.model, context, options).result();
		await flush();
		assert.deepEqual([reported.stopReason, reported.usage.input, reported.usage.output], ["stop", 100, 10], "the premise: usage when the server sends it");
		assert.equal(capped.meter.snapshot().costUnreported, 0, "a call that reported its usage is not counted");
		const line = () => ({ tokens: { ...capped.meter.snapshot(), ...capped.guard.snapshot() }, usage: capped.meter.usageSnapshot() });
		const before = line();
		assert.equal(dollarSettlement({ ...before, reservedMicros: cap, trusted: true }).basis, "metered", "one honest call settles metered");
		const spentBefore = capped.guard.state.spent;
		const message = await lb.modelRuntime.streamSimple(lb.model, context, options).result();
		await flush();
		assert.deepEqual(lb.seen, ["ok", "nousage"]);
		assert.equal(message.stopReason, "stop", `it succeeded: ${message.errorMessage}`);
		assert.deepEqual([message.usage.input, message.usage.output, message.usage.cost.total], [0, 0, 0], "the premise: pi fills a missing usage block with zeros");
		assert.equal(capped.guard.state.spent - spentBefore, callCostBound("streamSimple", lb.model, context, options), "charged its bound");
		assert.deepEqual([capped.meter.snapshot().costUnreported, capped.guard.snapshot().costUnanswered], [1, 0]);
		// The exit line as run-job writes it, through the worker's own parse and settlement.
		const after = line();
		const tokens = parseExitTokens(JSON.stringify({ event: "exit", tokens: after.tokens }));
		assert.equal(tokens.costUnreported, 1, "the worker keeps the key");
		assert.equal(tokens.cost, before.tokens.cost, "the meter priced the call at $0");
		assert.equal(dollarSettlement({ tokens, usage: after.usage, reservedMicros: cap, trusted: true }).basis, "floor", "so the run settles at the floor");
	} finally {
		installed?.uninstall();
		await lb.close();
	}
});

test("no cap: an answer with no usage chunk is counted costUnreported on the exit line all the same (issue #571)", { skip }, async () => {
	const lb = await loopbackOpenAI(["ok", "nousage"]);
	let installed;
	try {
		const logged = [];
		const meter = createUsageMeter({ maxTokens: null });
		installed = await installProcessUsageMeter({ ModelRuntime: pi.ModelRuntime, runtime: lb.modelRuntime, meter, log: (event, fields) => logged.push({ event, fields }) });
		assert.equal(installed.ok, true, JSON.stringify(logged));
		meter.setChildren(foldChildLedgers({ dir: lb.root }));
		const context = { systemPrompt: "s", messages: [{ role: "user", content: "hello", timestamp: 1 }] };
		await lb.modelRuntime.streamSimple(lb.model, context, { maxRetries: 0 }).result();
		await flush();
		assert.equal(meter.snapshot().costUnreported, 0, "the premise: usage when the server sends it");
		const message = await lb.modelRuntime.streamSimple(lb.model, context, { maxRetries: 0 }).result();
		await flush();
		assert.deepEqual([message.stopReason, message.usage.input, message.usage.cost.total], ["stop", 0, 0], "the premise: pi's zeros");
		const tokens = parseExitTokens(JSON.stringify({ event: "exit", tokens: meter.snapshot() }));
		assert.deepEqual([tokens.costUnreported, tokens.costCapMicros], [1, undefined], "no guard, and the line still says the cost is short");
	} finally {
		installed?.uninstall();
		await lb.close();
	}
});

for (const [step, label] of [["inband", "a 200 then an in-band error before any content"], ["lost", "a connection lost before any answer"]]) {
	test(`cost cap: ${label} never started, so it is charged its metered cost and counted as costUnanswered`, { skip }, async () => {
		const lb = await loopbackOpenAI([step]);
		let installed;
		try {
			const capped = await installCapped({ fx: { modelRuntime: lb.modelRuntime }, capMicros: 100_000_000, rootSessionId: undefined });
			installed = capped.installed;
			const context = { systemPrompt: "s", messages: [{ role: "user", content: "hello", timestamp: 1 }] };
			const message = await lb.modelRuntime.streamSimple(lb.model, context, { maxRetries: 0 }).result();
			await flush();
			assert.deepEqual(lb.seen, [step], "the request reached the server");
			assert.equal(message.stopReason, "error", `it failed: ${message.errorMessage}`);
			assert.equal(message.content.length, 0, "the premise: nothing came back");
			assert.deepEqual([capped.guard.state.spent, capped.guard.snapshot().costUnanswered], [0, 1]);
		} finally {
			installed?.uninstall();
			await lb.close();
		}
	});
}

test("cost cap: anthropic-messages' message_start (one output token) then an in-band overloaded_error never started: metered, costUnanswered 1", { skip }, async () => {
	// pi's REAL anthropic-messages module copies message_start's usage, output_tokens 1 included, before the error
	// event ends the stream. With no content block the call never started, whatever its output count says.
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			const start = { type: "message_start", message: { id: "msg_x", type: "message", role: "assistant", model: "loopback-priced", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 25, output_tokens: 1 } } };
			res.write(`event: message_start\ndata: ${JSON.stringify(start)}\n\n`);
			res.end(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })}\n\n`);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const root = tempDir("pi-dispatch-loopback-");
	const modelsPath = join(root, "models.json");
	writeFileSync(modelsPath, JSON.stringify({ providers: { anthropic: { apiKey: "loopback-literal-key",
		models: [{ id: "loopback-priced", name: "priced", api: "anthropic-messages", baseUrl: `http://127.0.0.1:${server.address().port}`, reasoning: false, input: ["text"], cost: { input: 1, output: 100, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 10000 }] } } }));
	(await import(resolvePiAiCompat()[0].url)).resetApiProviders();
	const modelRuntime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, agentDir: root, modelsPath });
	const model = modelRuntime.getModel("anthropic", "loopback-priced");
	let installed;
	try {
		assert.ok(model, "the loopback model must resolve under the builtin anthropic provider");
		const capped = await installCapped({ fx: { modelRuntime }, capMicros: 100_000_000, rootSessionId: undefined });
		installed = capped.installed;
		const message = await modelRuntime.streamSimple(model, { systemPrompt: "s", messages: [{ role: "user", content: "hello", timestamp: 1 }] }, { maxRetries: 0 }).result();
		await flush();
		assert.equal(message.stopReason, "error", `it failed: ${message.errorMessage}`);
		assert.deepEqual([message.content.length, message.usage.input, message.usage.output], [0, 25, 1], "the premise: no content, message_start's usage copied");
		assert.equal(capped.guard.state.spent, Math.ceil(message.usage.cost.total * 1e6), "charged its metered cost, not its bound");
		assert.equal(capped.guard.snapshot().costUnanswered, 1);
		assert.equal(capped.meter.state.stopReason, null);
	} finally {
		installed?.uninstall();
		await new Promise((resolve) => server.close(resolve));
	}
});

// ── Issue #502, part 4: the allowed-model list against the real SDK ────────────────────────────────────────
//
// Model A (the fixture's) is on the list, model B, on the same provider and api, is not. Each case reaches B by a
// different door pi offers, and each must end as exit 2 / model-not-allowed with B never called: no provider call
// on B and no ledger row for it. Per-test api ids, for the fixture's reason (the compat half never unwraps).

const MODEL_B = "fake-2";

/** One install with a model list, as run-job.mjs builds it, and the enforcement check run-job makes before the session. */
async function installListed({ fx, rootSessionId }) {
	const stops = [];
	const logged = [];
	const list = [{ provider: PROVIDER, model: MODEL_ID }];
	const log = (event, fields) => logged.push({ event, fields });
	const meter = createUsageMeter({ maxTokens: null, allowedModels: list, rootSessionId, onStop: (reason) => stops.push(reason) });
	const guard = createPolicyGuard({ allowedModels: list, log });
	const installed = await installProcessUsageMeter({ ModelRuntime: pi.ModelRuntime, runtime: fx.modelRuntime, meter, guard, log });
	assert.equal(installed.ok, true, `logged ${JSON.stringify(logged)}`);
	assert.deepEqual([installed.brake, [...installed.enforces]], [true, [MODEL_NOT_ALLOWED]]);
	assert.doesNotThrow(() => assertPoliciesEnforceable({ allowedModels: list, ...policyEnforcement(installed) }), "a list is enforceable with the model guard installed");
	return { meter, guard, installed, stops, logged };
}

/** Exit 2 / model-not-allowed, B never called, and B's ledger row absent (0 calls). */
function assertStoppedBeforeB({ listed, calls, label }) {
	const outcome = decideExit({ budgetAborted: false, budgetTurns: 1, meterStop: listed.meter.state.stopReason, tokenAborted: false, terminal: undefined });
	assert.deepEqual([outcome.code, outcome.reason], [EXIT_POLICY, MODEL_NOT_ALLOWED], label);
	assert.deepEqual(listed.stops, [MODEL_NOT_ALLOWED], label);
	assert.equal(calls.filter((entry) => entry.model === MODEL_B).length, 0, `${label}: B reached the provider`);
	const rowB = listed.meter.usageSnapshot()?.models.find((row) => row.model === MODEL_B);
	assert.equal(rowB?.calls ?? 0, 0, `${label}: B's ledger row`);
	assert.equal(listed.guard.snapshot().modelRefused, 1, label);
	assert.ok(listed.logged.some((entry) => entry.event === "model_refused"), label);
}

test("model list: session.setModel(B) mid-run is stopped at B's first call", { skip }, async () => {
	const api = "pi-dispatch-fake-api-list-setmodel";
	const fx = await fixture(api, {}, [MODEL_B]);
	const sessions = [];
	let installed;
	try {
		const rootManager = pi.SessionManager.inMemory(fx.root);
		const listed = await installListed({ fx, rootSessionId: rootManager.getSessionId() });
		installed = listed.installed;
		const calls = [];
		await registerFakeProvider({ modelRuntime: fx.modelRuntime, compat: installed.module, api, calls });
		const session = await openSession({ fx, modelRuntime: fx.modelRuntime, sessionManager: rootManager });
		sessions.push(session);
		let terminal;
		session.subscribe((event) => {
			if (event.type === "turn_end") terminal = event.message ?? terminal;
		});
		await session.prompt("on A");
		await flush();
		assert.deepEqual([calls.map((entry) => entry.model), listed.meter.state.stopReason], [[MODEL_ID], null], "A is listed and answers");
		const modelB = fx.modelRuntime.getModel(PROVIDER, MODEL_B);
		assert.ok(modelB);
		await session.setModel(modelB);
		await session.prompt("on B");
		await flush();
		assert.equal(terminal?.errorMessage, "pi-dispatch: model not allowed");
		assert.equal(terminal?.stopReason, "aborted", "aborted, so pi does not auto-retry it");
		assertStoppedBeforeB({ listed, calls, label: "setModel" });
	} finally {
		for (const session of sessions) session.dispose();
		installed?.uninstall();
		fx.cleanup();
	}
});

test("model list: a second in-process session on B is stopped at its first call", { skip }, async () => {
	const api = "pi-dispatch-fake-api-list-second";
	const fx = await fixture(api, {}, [MODEL_B]);
	const sessions = [];
	let installed;
	try {
		const rootManager = pi.SessionManager.inMemory(fx.root);
		const listed = await installListed({ fx, rootSessionId: rootManager.getSessionId() });
		installed = listed.installed;
		const calls = [];
		// The second session runs on its OWN runtime, as a subagent extension that builds one would.
		const otherRuntime = await fx.runtime();
		await registerFakeProvider({ modelRuntime: fx.modelRuntime, compat: installed.module, api, calls });
		await registerFakeProvider({ modelRuntime: otherRuntime, compat: installed.module, api, calls });
		const root = await openSession({ fx, modelRuntime: fx.modelRuntime, sessionManager: rootManager });
		const other = await openSession({ fx, modelRuntime: otherRuntime, sessionManager: pi.SessionManager.inMemory(fx.root), model: otherRuntime.getModel(PROVIDER, MODEL_B) });
		sessions.push(root, other);
		await root.prompt("on A");
		await other.prompt("on B");
		await flush();
		assert.deepEqual(calls.map((entry) => entry.model), [MODEL_ID]);
		assertStoppedBeforeB({ listed, calls, label: "second session" });
	} finally {
		for (const session of sessions) session.dispose();
		installed?.uninstall();
		fx.cleanup();
	}
});

test("model list: an extension's ctx.modelRegistry.streamSimple(B) is answered with the hard stop", { skip }, async () => {
	const api = "pi-dispatch-fake-api-list-registry";
	const fx = await fixture(api, {}, [MODEL_B]);
	const sessions = [];
	let installed;
	try {
		const rootManager = pi.SessionManager.inMemory(fx.root);
		const listed = await installListed({ fx, rootSessionId: rootManager.getSessionId() });
		installed = listed.installed;
		const calls = [];
		await registerFakeProvider({ modelRuntime: fx.modelRuntime, compat: installed.module, api, calls });
		let probed;
		// A command handler runs no model turn of its own, so the only provider call is the extension's.
		const probe = (extension) => {
			extension.registerCommand("probe", {
				description: "call model B directly",
				handler: async (_args, ctx) => {
					const modelB = ctx.modelRegistry.find(PROVIDER, MODEL_B);
					probed = await ctx.modelRegistry.streamSimple(modelB, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, {}).result();
				},
			});
		};
		const session = await openSession({ fx, modelRuntime: fx.modelRuntime, sessionManager: rootManager, extensionFactories: [probe] });
		sessions.push(session);
		await session.prompt("/probe");
		await flush();
		assert.equal(probed?.errorMessage, "pi-dispatch: model not allowed", `the extension's call: ${JSON.stringify(probed)}`);
		assert.deepEqual(calls, []);
		assertStoppedBeforeB({ listed, calls, label: "ctx.modelRegistry" });
	} finally {
		for (const session of sessions) session.dispose();
		installed?.uninstall();
		fx.cleanup();
	}
});

test("model list: a virtual router is judged on each request's pick, so its route to B is stopped", { skip }, async () => {
	const api = "pi-dispatch-fake-api-list-virtual";
	const fx = await fixture(api, {}, [MODEL_B]);
	const sessions = [];
	let installed;
	try {
		const rootManager = pi.SessionManager.inMemory(fx.root);
		const listed = await installListed({ fx, rootSessionId: rootManager.getSessionId() });
		installed = listed.installed;
		const calls = [];
		await registerFakeProvider({ modelRuntime: fx.modelRuntime, compat: installed.module, api, calls });
		// The router's pick is a variable, so one session shows both verdicts: A admitted, then B refused. The list
		// names neither the router nor its virtual entry.
		let pick = MODEL_ID;
		// registerVirtualModel starts a refresh it does not await (model-runtime.js, `void this.refresh(...)`), and that
		// refresh reads credentials, which writes auth.json into the fixture root. Unawaited, it lands after
		// fx.cleanup() and recreates the root (the leftover the suite's TMPDIR check names). So the one refresh it
		// starts is captured, through the instance's own `this.refresh`, and awaited here.
		const started = [];
		const refresh = fx.modelRuntime.refresh;
		fx.modelRuntime.refresh = function (...args) {
			const promise = refresh.apply(this, args);
			started.push(promise);
			return promise;
		};
		try {
			fx.modelRuntime.registerVirtualModel({
				provider: "pi-dispatch-router",
				id: "auto",
				name: "router",
				route: () => ({ model: fx.modelRuntime.getModel(PROVIDER, pick), thinkingLevel: "off" }),
			});
		} finally {
			delete fx.modelRuntime.refresh;
		}
		assert.equal(started.length, 1, "registerVirtualModel started exactly one refresh");
		await Promise.all(started);
		const virtual = fx.modelRuntime.getModel("pi-dispatch-router", "auto");
		assert.equal(virtual?.api, "pi-virtual");
		const session = await openSession({ fx, modelRuntime: fx.modelRuntime, sessionManager: rootManager, model: virtual });
		sessions.push(session);
		await session.prompt("routed to A");
		await flush();
		assert.deepEqual([calls.map((entry) => entry.model), listed.meter.state.stopReason], [[MODEL_ID], null], "the virtual entry passed; its route to A was judged and admitted");
		pick = MODEL_B;
		await session.prompt("routed to B");
		await flush();
		assertStoppedBeforeB({ listed, calls, label: "virtual router" });
	} finally {
		for (const session of sessions) session.dispose();
		installed?.uninstall();
		fx.cleanup();
	}
});

// ── PR #538's review: what else picks the model that answers, against a real provider ────────────────────────
//
// The builtin openai provider on a loopback server that records the `model` of every request it receives, so "the
// unlisted model was never asked" is read off the wire, not off a fake. Two models under it, one listed.

async function loopbackListed() {
	const sentModels = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			try {
				sentModels.push(JSON.parse(body).model);
			} catch {
				sentModels.push("<unparsed>");
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			const chunk = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
			const base = { id: "x", object: "chat.completion.chunk", created: 1, model: "loopback-listed" };
			chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] });
			chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
			chunk({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } });
			res.end("data: [DONE]\n\n");
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const root = tempDir("pi-dispatch-loopback-");
	const modelsPath = join(root, "models.json");
	const row = (id) => ({ id, name: id, api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 });
	writeFileSync(modelsPath, JSON.stringify({ providers: { openai: { apiKey: "loopback-literal-key", models: [row("loopback-listed"), row("loopback-unlisted")] } } }));
	// Earlier installs in this file left the compat registry wrapped by stopped meters; pi's own reset puts the builtins back.
	(await import(resolvePiAiCompat()[0].url)).resetApiProviders();
	const modelRuntime = await createJobModelRuntime({ ModelRuntime: pi.ModelRuntime, agentDir: root, modelsPath });
	const model = modelRuntime.getModel("openai", "loopback-listed");
	assert.ok(model, "the loopback model must resolve under the builtin openai provider");
	const list = [{ provider: "openai", model: "loopback-listed" }];
	const stops = [];
	const logged = [];
	const log = (event, fields) => logged.push({ event, fields });
	const meter = createUsageMeter({ maxTokens: null, allowedModels: list, onStop: (reason) => stops.push(reason) });
	const guard = createPolicyGuard({ allowedModels: list, log });
	const installed = await installProcessUsageMeter({ ModelRuntime: pi.ModelRuntime, runtime: modelRuntime, meter, guard, log });
	assert.equal(installed.ok, true);
	return { sentModels, root, modelRuntime, model, meter, guard, stops, logged, installed, close: () => new Promise((resolve) => server.close(resolve)) };
}

const HELLO = { systemPrompt: "s", messages: [{ role: "user", content: "hello", timestamp: 1 }] };

test("model list, on the wire: a listed call is sent as asked; samplingParams or an onPayload naming another model never leave", { skip }, async () => {
	const lb = await loopbackListed();
	try {
		const ok = await lb.modelRuntime.streamSimple(lb.model, HELLO, { maxRetries: 0 }).result();
		assert.equal(ok.stopReason, "stop", `the listed call: ${ok.errorMessage}`);
		assert.deepEqual(lb.sentModels, ["loopback-listed"]);
		const sampled = await lb.modelRuntime.streamSimple(lb.model, HELLO, { maxRetries: 0, samplingParams: { model: "loopback-unlisted" } }).result();
		assert.equal(sampled.errorMessage, "pi-dispatch: model not allowed");
		assert.deepEqual([lb.sentModels, lb.meter.state.stopReason, lb.guard.snapshot().modelRefused], [["loopback-listed"], "model-not-allowed", 1]);
		assert.deepEqual(lb.logged.filter((entry) => entry.event === "model_refused").map((entry) => entry.fields.why), ["sampling"]);
	} finally {
		lb.installed.uninstall();
		await lb.close();
	}
});

test("model list, on the wire: a call option onPayload that rewrites the model fails the call before it is sent", { skip }, async () => {
	const lb = await loopbackListed();
	try {
		const rewritten = await lb.modelRuntime.streamSimple(lb.model, HELLO, { maxRetries: 0, onPayload: (payload) => ({ ...payload, model: "loopback-unlisted" }) }).result();
		assert.equal(rewritten.stopReason, "error");
		assert.match(rewritten.errorMessage, /pi-dispatch: model not allowed/);
		assert.deepEqual([lb.sentModels, lb.meter.state.stopReason, lb.guard.snapshot().modelRefused], [[], "model-not-allowed", 1], "nothing reached the server");
		assert.deepEqual(lb.logged.filter((entry) => entry.event === "model_refused").map((entry) => entry.fields.why), ["payload"]);
	} finally {
		lb.installed.uninstall();
		await lb.close();
	}
});

test("model list, on the wire: a session's before_provider_request hook that rewrites the model fails the call before it is sent", { skip }, async () => {
	const lb = await loopbackListed();
	let session;
	try {
		// The shape of a serviced repo's .pi/extensions hook: it sees every payload the session sends.
		const hook = (extension) => {
			extension.on("before_provider_request", (event) => ({ ...event.payload, model: "loopback-unlisted" }));
		};
		const settingsManager = pi.SettingsManager.inMemory({});
		const resourceLoader = new pi.DefaultResourceLoader({ cwd: lb.root, agentDir: pi.getAgentDir(), settingsManager, noContextFiles: true, noSkills: true, noExtensions: true, extensionFactories: [hook] });
		await resourceLoader.reload();
		({ session } = await pi.createAgentSession({ cwd: lb.root, agentDir: pi.getAgentDir(), modelRuntime: lb.modelRuntime, model: lb.model, settingsManager, sessionManager: pi.SessionManager.inMemory(lb.root), resourceLoader, noTools: "all" }));
		let terminal;
		session.subscribe((event) => {
			if (event.type === "turn_end") terminal = event.message ?? terminal;
		});
		await session.prompt("hello");
		await flush();
		assert.match(terminal?.errorMessage ?? "", /pi-dispatch: model not allowed/);
		assert.deepEqual([lb.sentModels, lb.meter.state.stopReason], [[], "model-not-allowed"], "the hook's model never reached the server");
		const outcome = decideExit({ budgetAborted: false, budgetTurns: 1, meterStop: lb.meter.state.stopReason, tokenAborted: false, terminal });
		assert.deepEqual([outcome.code, outcome.reason], [EXIT_POLICY, MODEL_NOT_ALLOWED]);
	} finally {
		session?.dispose();
		lb.installed.uninstall();
		await lb.close();
	}
});

test("model list, on the wire: a session hook that hides the model behind toJSON fails the call before it is sent", { skip }, async () => {
	const lb = await loopbackListed();
	let session;
	try {
		const hook = (extension) => {
			extension.on("before_provider_request", (event) => ({ ...event.payload, toJSON() {
				return { ...event.payload, model: "loopback-unlisted" };
			} }));
		};
		const settingsManager = pi.SettingsManager.inMemory({});
		const resourceLoader = new pi.DefaultResourceLoader({ cwd: lb.root, agentDir: pi.getAgentDir(), settingsManager, noContextFiles: true, noSkills: true, noExtensions: true, extensionFactories: [hook] });
		await resourceLoader.reload();
		({ session } = await pi.createAgentSession({ cwd: lb.root, agentDir: pi.getAgentDir(), modelRuntime: lb.modelRuntime, model: lb.model, settingsManager, sessionManager: pi.SessionManager.inMemory(lb.root), resourceLoader, noTools: "all" }));
		await session.prompt("hello");
		await flush();
		assert.deepEqual([lb.sentModels, lb.meter.state.stopReason], [[], "model-not-allowed"], "the toJSON body never reached the server");
	} finally {
		session?.dispose();
		lb.installed.uninstall();
		await lb.close();
	}
});

// ── Issue #543: a model call an extension makes while it loads ──────────────────────────────────────────────
//
// An extension factory runs inside the resource loader's reload(). Its pi API has no ctx then (every action
// method throws "Extension runtime not initialized", and pi.registerProvider is only queued for the session), so a
// call it makes at load goes through a ModelRuntime of its own (ModelRuntime.prototype) or pi-ai's legacy global
// stream functions (the compat api registry). run-job.mjs installs the meter and the guards BEFORE it builds the
// loader, so both are already wrapped. These drive that order with the real loader: the runtime first, then the
// meter, the guard, the install and the policy check, then buildLoadedResourceLoader on a workspace whose
// .pi/extensions holds one extension that makes one call while it loads. pinned-api.test.mjs pins the pi facts.

/** Where the extension finds what the test hands it: one global, read at load, written back with the answer. */
const LOAD_PROBE = Symbol.for("pi-dispatch.test.load-time-call");
let loadTimeRuns = 0;

const LOAD_TIME_EXTENSION = `
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { getApiProvider, registerApiProvider, streamSimple } from "@earendil-works/pi-ai";
export default async function () {
	const probe = globalThis[Symbol.for("pi-dispatch.test.load-time-call")];
	const context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
	if (probe.path === "override") {
		// A legacy extension that only re-registers an api id the registry already held, passing through to it. No call.
		const prior = getApiProvider(probe.overrideApi);
		registerApiProvider({ api: probe.overrideApi, stream: prior.stream, streamSimple: prior.streamSimple }, "legacy-extension");
	} else if (probe.path !== "compat") {
		const runtime = await ModelRuntime.create(probe.runtimeOptions);
		runtime.registerProvider(probe.provider, { api: probe.api, streamSimple: probe.streamSimple });
		await runtime.refresh({ allowNetwork: false });
		// The two onPayload paths (issue #543's review): a legacy call made from the runtime call's onPayload, at once
		// while the call is in flight ("onpayload-inner") or from a timer scheduled there ("onpayload-late"). Both run
		// in the runtime call's async context, and neither is that call's own dispatch.
		let legacy;
		const onPayload = () => {
			const call = () => streamSimple(probe.legacyModel, context, { apiKey: probe.apiKey }).result();
			legacy = probe.path === "onpayload-inner" ? call() : new Promise((resolve) => setTimeout(() => resolve(call()), 1));
		};
		const options = probe.path === "runtime" ? {} : { onPayload };
		probe.result = await runtime.streamSimple(runtime.getModel(probe.provider, probe.modelId), context, options).result();
		if (legacy) probe.legacy = await legacy;
	} else {
		probe.result = await streamSimple(probe.compatModel, context, { apiKey: probe.apiKey }).result();
	}
}
`;

/**
 * One job's start, in run-job.mjs's order, with an extension that makes one model call while it loads: through its
 * own ModelRuntime (`path: "runtime"`) or pi-ai's legacy global streamSimple (`path: "compat"`, on an api id the
 * registry already holds when the meter installs, as every builtin does). Returns what reached the provider, the
 * extension's answer, the stop and the exit line's `tokens`, as run-job builds them.
 */
async function loadTimeCall({ api, modelOverrides = {}, path, maxCostMicros = null, allowedModels = null, legacyModelId = null }) {
	const { buildLoadedResourceLoader } = await import("../src/loader.mjs");
	const { jobModelRuntimeOptions } = await import("../src/model-runtime.mjs");
	const fx = await fixture(api, modelOverrides, [MODEL_B]);
	const calls = [];
	const logged = [];
	const log = (event, fields) => logged.push({ event, fields });
	let installed;
	try {
		const workspace = join(fx.root, "workspace");
		const jobPiDir = join(fx.root, "job", "pi");
		mkdirSync(join(workspace, ".pi", "extensions"), { recursive: true });
		mkdirSync(join(jobPiDir, "skills"), { recursive: true });
		writeFileSync(join(workspace, ".pi", "extensions", "load-call.js"), LOAD_TIME_EXTENSION);
		const guardrailsPath = join(fx.root, "HARD_RULES.md");
		writeFileSync(guardrailsPath, "rules\n");

		// The compat path's api id is in the registry before the meter installs, as every builtin is, so the install
		// wraps it. Under a cap the call is on the job's own priced api instead, so its bound is a finite number; it is
		// refused before any entry is reached. One id per run: the registry outlives an uninstall, and re-registering an
		// id an install already wrapped is a displacement.
		const compat = await import(resolvePiAiCompat()[0].url);
		loadTimeRuns += 1;
		const compatApi = `${api}-compat-${loadTimeRuns}`;
		// It hands the payload to the call's onPayload first, as a provider does just before it sends.
		const served = (model, _context, options) => {
			calls.push({ model: model.id, api: model.api });
			const stream = compat.createAssistantMessageEventStream();
			Promise.resolve(options?.onPayload?.({ model: model.id }, model)).then(() =>
				stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "ok" }], api: model.api, provider: model.provider, model: model.id, usage: SENTINEL_USAGE, stopReason: "stop", timestamp: Date.now() } }),
			);
			return stream;
		};
		compat.registerApiProvider({ api: compatApi, stream: served, streamSimple: served });
		const probe = {
			path,
			runtimeOptions: jobModelRuntimeOptions({ agentDir: fx.root, modelsPath: join(fx.root, "models.json") }),
			provider: PROVIDER,
			api,
			modelId: MODEL_ID,
			streamSimple: served,
			compatModel: maxCostMicros === null ? { ...fx.model, api: compatApi } : fx.model,
			// The onPayload paths' legacy call: on the job's own model (a priced api, so a finite bound) under a cap,
			// else on the served compat api under the given id.
			overrideApi: compatApi,
			legacyModel: maxCostMicros === null ? { ...fx.model, id: legacyModelId ?? fx.model.id, api: compatApi } : fx.model,
			apiKey: FAKE_KEY,
		};
		globalThis[LOAD_PROBE] = probe;

		// run-job.mjs's order from here: the root session id, the meter, the guard, the install, the policy check, then
		// the loader.
		const rootSessionId = pi.SessionManager.inMemory(fx.root).getSessionId();
		const stops = [];
		const meter = createUsageMeter({ maxTokens: null, maxCostMicros, allowedModels, rootSessionId, onStop: (reason) => stops.push(reason) });
		const guard = createPolicyGuard({ maxCostMicros, allowedModels, log });
		installed = await installProcessUsageMeter({ ModelRuntime: pi.ModelRuntime, runtime: fx.modelRuntime, meter, log, guard });
		assert.deepEqual([installed.ok, installed.module === compat], [true, true], `the install proved the job's runtime and the compat copy extensions get: ${JSON.stringify(logged)}`);
		assertPoliciesEnforceable({ maxCostMicros, allowedModels, ...policyEnforcement(installed) });

		const loader = await buildLoadedResourceLoader({ cwd: workspace, jobPiDir, guardrailsPath, settingsManager: pi.SettingsManager.inMemory({}), allowGlobalExtensions: false, log });
		await flush();
		const loaded = loader.getExtensions().extensions.map((extension) => extension.path);
		assert.deepEqual(loaded, [join(workspace, ".pi", "extensions", "load-call.js")], "exactly the one extension loaded, so the counts below are its call");
		// run-job's re-arm after createAgentSession: the registry was not touched, so nothing was displaced.
		installed.arm();
		return {
			calls,
			result: probe.result,
			legacy: probe.legacy,
			stops,
			rearms: installed.rearms,
			loggedEvents: logged.map((line) => line.event),
			stopReason: meter.state.stopReason,
			tokens: { ...meter.snapshot(), ...(guard ? guard.snapshot() : {}) },
			outcome: decideExit({ budgetAborted: false, meterStop: meter.state.stopReason, terminal: undefined }),
			// A copy: the uninstall below adds its teardown line, which is not the load's.
			logged: [...logged],
		};
	} finally {
		delete globalThis[LOAD_PROBE];
		installed?.uninstall();
		fx.cleanup();
	}
}

test("issue #543: under a cost cap, an extension's call while it loads is refused before the provider, in both halves", { skip }, async () => {
	// A priced api, so the call's bound is a finite number (about a dollar, as in the sequential test above), and it
	// exceeds this cap of 1,000 micro-dollars: the refusal is the bound's, not an unboundable call's.
	for (const path of ["runtime", "compat"]) {
		const run = await loadTimeCall({ api: PRICED_API, modelOverrides: PRICED_MODEL, path, maxCostMicros: 1000 });
		assert.deepEqual(run.calls, [], `${path}: nothing reached the provider`);
		assert.deepEqual([run.result?.stopReason, run.result?.errorMessage], ["aborted", "pi-dispatch: cost cap reached"], `${path}: the extension got the hard stop`);
		assert.deepEqual([run.stopReason, run.stops], ["cost-cap", ["cost-cap"]]);
		assert.deepEqual([run.tokens.calls, run.tokens.costRefused, run.tokens.costUnjudged, run.rearms], [0, 1, 0, 0]);
		assert.deepEqual([run.outcome.code, run.outcome.reason], [EXIT_POLICY, "cost-cap"]);
		const refusals = run.logged.filter((line) => line.event === "cost_refused");
		assert.equal(refusals.length, 1);
		assert.ok(Number.isFinite(refusals[0].fields.bound) && refusals[0].fields.bound > 1000, `the bound exceeds the cap: ${JSON.stringify(refusals[0].fields)}`);
	}
});

test("issue #543: under a model list naming another model, an extension's call while it loads is refused, in both halves", { skip }, async () => {
	for (const [index, path] of ["runtime", "compat"].entries()) {
		const run = await loadTimeCall({ api: `pi-dispatch-fake-api-543-list-${index}`, path, allowedModels: [{ provider: PROVIDER, model: MODEL_B }] });
		assert.deepEqual(run.calls, [], `${path}: nothing reached the provider`);
		assert.deepEqual([run.result?.stopReason, run.result?.errorMessage], ["aborted", "pi-dispatch: model not allowed"], `${path}: the extension got the hard stop`);
		assert.deepEqual([run.stopReason, run.stops], [MODEL_NOT_ALLOWED, [MODEL_NOT_ALLOWED]]);
		assert.deepEqual([run.tokens.calls, run.tokens.modelRefused, run.rearms], [0, 1, 0]);
		assert.deepEqual([run.outcome.code, run.outcome.reason], [EXIT_POLICY, MODEL_NOT_ALLOWED]);
	}
});

test("issue #543: a legacy call made from a load-time runtime call's onPayload is judged, not skipped as that call's dispatch", { skip }, async () => {
	// The review's s3 shape. The runtime call is admitted; the legacy call its onPayload makes runs in that call's
	// async context, and before the per-call token the compat half skipped any call there unjudged and uncounted.
	// Under a cap, at once, while the admitted call's bound is in flight: 1.01M + 1.01M passes a cap of 1.5M.
	const capped = await loadTimeCall({ api: PRICED_API, modelOverrides: PRICED_MODEL, path: "onpayload-inner", maxCostMicros: 1_500_000 });
	assert.equal(capped.result?.stopReason, "stop", "the runtime call itself was admitted");
	assert.deepEqual([capped.legacy?.stopReason, capped.legacy?.errorMessage], ["aborted", "pi-dispatch: cost cap reached"], "the onPayload's call was refused");
	assert.deepEqual([capped.calls.length, capped.stopReason, capped.tokens.costRefused], [1, "cost-cap", 1], "only the admitted call reached the provider");
	// Under a list, from a timer the onPayload scheduled: the call runs after the runtime call settled, still in its context.
	const listed = await loadTimeCall({ api: "pi-dispatch-fake-api-543-late", path: "onpayload-late", allowedModels: [{ provider: PROVIDER, model: MODEL_ID }], legacyModelId: MODEL_B });
	assert.equal(listed.result?.stopReason, "stop", "the listed runtime call was admitted");
	assert.deepEqual([listed.legacy?.stopReason, listed.legacy?.errorMessage], ["aborted", "pi-dispatch: model not allowed"], "the timer's call to an unlisted model was refused");
	assert.deepEqual([listed.calls.map((call) => call.model), listed.stopReason, listed.tokens.modelRefused], [[MODEL_ID], MODEL_NOT_ALLOWED, 1]);
	// With no policy, the same late call reaches its provider and is counted: two calls, not one.
	const counted = await loadTimeCall({ api: "pi-dispatch-fake-api-543-late-none", path: "onpayload-late", legacyModelId: MODEL_B });
	assert.deepEqual([counted.calls.map((call) => call.model), counted.tokens.calls, counted.stopReason], [[MODEL_ID, MODEL_B], 2, null]);
});

test("issue #543: with no policy, an extension's call while it loads is counted on the exit line, and nothing else changes", { skip }, async () => {
	for (const [index, path] of ["runtime", "compat"].entries()) {
		const run = await loadTimeCall({ api: `pi-dispatch-fake-api-543-none-${index}`, path });
		assert.equal(run.calls.length, 1, `${path}: the call reached the provider once`);
		assert.equal(run.result?.stopReason, "stop");
		assert.deepEqual([run.stopReason, run.stops, run.rearms], [null, [], 0]);
		// Counted, at the sentinel's numbers, and as no session's: a factory's call carries no sessionId, so it lands
		// in looseTotal, never in the root session's total.
		assert.deepEqual([run.tokens.calls, run.tokens.total, run.tokens.rootTotal, run.tokens.otherTotal, run.tokens.looseTotal], [1, SENTINEL_TOTAL, 0, 0, SENTINEL_TOTAL]);
		// No policy, so no guard: the exit line carries none of the cost or model fields.
		for (const key of ["costCapMicros", "costRefused", "modelRefused"]) assert.equal(key in run.tokens, false, key);
		assert.deepEqual(run.logged.filter((line) => line.event !== "usage_meter").map((line) => line.event), []);
	}
});

/** A session hook that makes one legacy pi-ai call while the session's request is being built: the review's s7 shape. */
function legacyCallHook(model, apiKey, into) {
	return (extension) => {
		let fired = false;
		extension.on("before_provider_request", async () => {
			if (fired) return undefined;
			fired = true;
			const compat = await import(resolvePiAiCompat()[0].url);
			into.result = await compat.streamSimple(model, { messages: [{ role: "user", content: "x", timestamp: 1 }] }, { apiKey }).result();
			return undefined;
		});
	};
}

async function sessionWithHook({ root, modelRuntime, model, hook }) {
	const settingsManager = pi.SettingsManager.inMemory({});
	const resourceLoader = new pi.DefaultResourceLoader({ cwd: root, agentDir: pi.getAgentDir(), settingsManager, noContextFiles: true, noSkills: true, noExtensions: true, extensionFactories: [hook] });
	await resourceLoader.reload();
	const { session } = await pi.createAgentSession({ cwd: root, agentDir: pi.getAgentDir(), modelRuntime, model, settingsManager, sessionManager: pi.SessionManager.inMemory(root), resourceLoader, noTools: "all" });
	return session;
}

test("issue #543, model list, on the wire: a legacy call a session's before_provider_request hook makes is judged, and never sent", { skip }, async () => {
	const lb = await loopbackListed();
	let session;
	try {
		const into = {};
		const unlisted = lb.modelRuntime.getModel("openai", "loopback-unlisted");
		session = await sessionWithHook({ root: lb.root, modelRuntime: lb.modelRuntime, model: lb.model, hook: legacyCallHook(unlisted, "loopback-literal-key", into) });
		await session.prompt("hello");
		await flush();
		assert.equal(into.result?.errorMessage, "pi-dispatch: model not allowed", `the hook's call: ${JSON.stringify(into.result)}`);
		assert.equal(lb.sentModels.includes("loopback-unlisted"), false, "the hook's unlisted model never reached the server");
		assert.deepEqual([lb.meter.state.stopReason, lb.guard.snapshot().modelRefused], [MODEL_NOT_ALLOWED, 1]);
	} finally {
		session?.dispose();
		lb.installed.uninstall();
		await lb.close();
	}
});

test("issue #543, cost cap, on the wire: a legacy call a session's before_provider_request hook makes is judged against the in-flight bound", { skip }, async () => {
	const lb = await loopbackOpenAI(["ok"]);
	let session;
	let installed;
	try {
		// The session's call (a bound of about 1.01M) is admitted and in flight when its hook calls the same model
		// again; 1.01M + 1.01M passes 1.5M, so the hook's call is refused before it is sent.
		const capped = await installCapped({ fx: lb, capMicros: 1_500_000, rootSessionId: "root" });
		installed = capped.installed;
		const into = {};
		session = await sessionWithHook({ root: lb.root, modelRuntime: lb.modelRuntime, model: lb.model, hook: legacyCallHook(lb.model, "loopback-literal-key", into) });
		await session.prompt("hello");
		await flush();
		assert.equal(into.result?.errorMessage, "pi-dispatch: cost cap reached", `the hook's call: ${JSON.stringify(into.result)}`);
		assert.ok(lb.seen.length <= 1, `the hook's call never reached the server: ${lb.seen.length} requests`);
		assert.deepEqual([capped.meter.state.stopReason, capped.guard.snapshot().costRefused], ["cost-cap", 1]);
	} finally {
		session?.dispose();
		installed?.uninstall();
		await lb.close();
	}
});

test("issue #543: a legacy extension that only re-registers an api id at load is a displaced entry: a stop under a policy, a rearm without", { skip }, async () => {
	// The install now runs before the loader, so an extension that replaces an api entry the install wrapped, while it
	// loads, is found displaced by the re-arm after the session exists, as the same replacement during the run is.
	const capped = await loadTimeCall({ api: "pi-dispatch-fake-api-543-override-cap", path: "override", maxCostMicros: 1_000_000 });
	assert.deepEqual([capped.stopReason, capped.tokens.costUnjudged, capped.tokens.costRefused, capped.rearms, capped.calls.length], ["cost-cap", 1, 0, 1, 0]);
	assert.ok(capped.loggedEvents.includes("cost_guard_displaced"));
	const listed = await loadTimeCall({ api: "pi-dispatch-fake-api-543-override-list", path: "override", allowedModels: [{ provider: PROVIDER, model: MODEL_ID }] });
	assert.deepEqual([listed.stopReason, listed.tokens.modelRefused, listed.rearms], [MODEL_NOT_ALLOWED, 0, 1]);
	assert.ok(listed.loggedEvents.includes("model_guard_displaced"));
	const none = await loadTimeCall({ api: "pi-dispatch-fake-api-543-override-none", path: "override" });
	assert.deepEqual([none.stopReason, none.rearms, none.tokens.calls], [null, 1, 0], "with no policy, only the rearm count");
	assert.deepEqual(none.loggedEvents.filter((event) => event !== "usage_meter"), []);
});

/**
 * A proxy provider on the job's runtime (the review's rb4 shape): its streamSimple forwards to pi-ai's legacy streamSimple
 * on ANOTHER model and api, with the options spread, and a served compat entry answers. One request, one answer.
 */
/** What a fallback provider spends answering itself: $2, priced by the provider, as a fetch-based custom api reports it. */
const OWN_TWO_DOLLARS = { input: 100000, output: 10000, cacheRead: 0, cacheWrite: 0, totalTokens: 110000, cost: { input: 1.5, output: 0.5, cacheRead: 0, cacheWrite: 0, total: 2 } };

async function proxyRun({ maxTokens = null, maxCostMicros = null, allowedModels = null, target: targetOverrides = {}, answer: proxyAnswer = "pass", entry = "ok", second = false, registerTarget = false }) {
	const fx = await fixture(`pi-dispatch-fake-api-543-proxy-${(loadTimeRuns += 1)}`);
	const compat = await import(resolvePiAiCompat()[0].url);
	const servedApi = `pi-dispatch-served-api-${loadTimeRuns}`;
	const served = [];
	// The served target: answers ("ok"), answers an in-band error with no content ("error"), or throws ("throw").
	const answer = (model) => {
		served.push(model.id);
		if (entry === "throw") throw new Error("target down");
		const stream = compat.createAssistantMessageEventStream();
		if (entry === "error") {
			stream.push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "error", errorMessage: "503", timestamp: Date.now() } });
		} else {
			stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "ok" }], api: model.api, provider: model.provider, model: model.id, usage: SENTINEL_USAGE, stopReason: "stop", timestamp: Date.now() } });
		}
		return stream;
	};
	compat.registerApiProvider({ api: servedApi, stream: answer, streamSimple: answer });
	let target = { ...fx.model, provider: "pi-dispatch-upstream", id: "upstream-1", api: servedApi, ...targetOverrides };
	const stops = [];
	const logged = [];
	const log = (event, fields) => logged.push({ event, fields });
	const meter = createUsageMeter({ maxTokens, maxCostMicros, allowedModels, rootSessionId: "root", onStop: (reason) => stops.push(reason) });
	const guard = createPolicyGuard({ maxCostMicros, allowedModels, log });
	const installed = await installProcessUsageMeter({ ModelRuntime: pi.ModelRuntime, runtime: fx.modelRuntime, meter, log, guard });
	try {
		fx.modelRuntime.registerProvider("pi-dispatch-proxy", {
			baseUrl: "http://127.0.0.1:1",
			apiKey: "pi-dispatch-proxy-literal-key",
			api: PRICED_API,
			// A cheap table on a priced api, so under a cap the proxy's own call has a small finite bound.
			models: [{ id: "proxy-1", name: "proxy-1", api: PRICED_API, reasoning: false, input: ["text"], cost: { input: 0.01, output: 0.01, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 4096, compat: { maxTokensField: "max_tokens" } }],
			// "pass" answers with the forward's own stream; "zero" with a stream of its own that reports no usage, a proxy
			// that drops it; "fallback" tries the forward and, whatever it gave (an answer, an error, a throw, a
			// refusal), answers ITSELF with $2 of its own (the review's f1 shape: a fallback or router provider).
			streamSimple: (model, context, options) => {
				if (proxyAnswer === "fallback") {
					const own = compat.createAssistantMessageEventStream();
					(async () => {
						try {
							await compat.streamSimple(target, context, { ...options }).result();
						} catch {
							// the forward threw; the provider answers itself all the same
						}
						own.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "ok" }], api: model.api, provider: model.provider, model: model.id, usage: OWN_TWO_DOLLARS, stopReason: "stop", timestamp: Date.now() } });
					})();
					return own;
				}
				if (proxyAnswer === "async-zero") {
					// A router that awaits before it forwards, then answers with zero usage of its own (issue #571).
					const own = compat.createAssistantMessageEventStream();
					(async () => {
						await new Promise((resolve) => setTimeout(resolve, 1));
						const message = await compat.streamSimple(target, context, { ...options }).result();
						own.push({ type: "done", reason: "stop", message: { ...message, api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
					})();
					return own;
				}
				const forwarded = compat.streamSimple(target, context, { ...options });
				if (proxyAnswer === "pass") return forwarded;
				const own = compat.createAssistantMessageEventStream();
				forwarded.result().then((message) => own.push({ type: "done", reason: "stop", message: { ...message, api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }));
				return own;
			},
		});
		// `registerTarget` (issue #587's gate): the target is a model of the job runtime's own registry, so under a cap it is
		// priced from there; an unregistered target is refused as unboundable before its bound is even taken.
		if (registerTarget) {
			const { provider: _provider, ...definition } = target;
			fx.modelRuntime.registerProvider("pi-dispatch-upstream", { baseUrl: target.baseUrl, apiKey: "pi-dispatch-upstream-literal-key", api: target.api, models: [{ ...definition, name: target.id, reasoning: false, input: ["text"], contextWindow: 100000 }] });
		}
		await fx.modelRuntime.refresh({ allowNetwork: false });
		if (registerTarget) target = fx.modelRuntime.getModel("pi-dispatch-upstream", "upstream-1");
		const proxy = fx.modelRuntime.getModel("pi-dispatch-proxy", "proxy-1");
		const result = await fx.modelRuntime.streamSimple(proxy, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, {}).result();
		await flush();
		// `second`: the job's next call, plain, on the proxy's model with no forward in it (a fresh runtime call).
		const next = second ? await fx.modelRuntime.streamSimple(fx.model, { messages: [{ role: "user", content: "again", timestamp: 2 }] }, {}).result() : null;
		await flush();
		return { result, next, served, stops, meter, guard, logged };
	} finally {
		installed.uninstall();
		fx.cleanup();
	}
}

test("PR #547's reviews: a proxy provider's forward to another model is a full call, and the provider's own call is counted too", { skip }, async () => {
	// The documented residual: a passthrough proxy is counted for BOTH calls (its own and the forward's), the safe side.
	const twice = await proxyRun({});
	assert.deepEqual([twice.result.stopReason, twice.served, twice.meter.state.calls, twice.meter.state.total, twice.stops], ["stop", ["upstream-1"], 2, 2 * SENTINEL_TOTAL, []]);
	assert.deepEqual(twice.meter.usageSnapshot().models.map((row) => `${row.provider}/${row.model}`).sort(), ["pi-dispatch-proxy/proxy-1", "pi-dispatch-upstream/upstream-1"]);
	// A list that names the proxy but not where it forwards: the forward is refused before it is sent.
	const listed = await proxyRun({ allowedModels: [{ provider: "pi-dispatch-proxy", model: "proxy-1" }] });
	assert.equal(listed.result.errorMessage, "pi-dispatch: model not allowed", JSON.stringify(listed.result));
	assert.deepEqual([listed.served, listed.stops, listed.guard.snapshot().modelRefused], [[], [MODEL_NOT_ALLOWED], 1]);
	// A cheap proxy forwarding to a dear target under a $1 cap: the target's own bound (about $2) is judged, and refused
	// before anything is sent, as the same target called directly would be.
	const dear = await proxyRun({ maxCostMicros: 1_000_000, registerTarget: true, target: { api: PRICED_API, cost: { input: 1, output: 200, cacheRead: 0, cacheWrite: 0 }, maxTokens: 10000, compat: { maxTokensField: "max_tokens" } } });
	assert.equal(dear.result.errorMessage, "pi-dispatch: cost cap reached", JSON.stringify(dear.result));
	const refusal = dear.logged.find((line) => line.event === "cost_refused");
	assert.ok(refusal?.fields.bound > 1_000_000, `the target's own bound was judged: ${JSON.stringify(refusal)}`);
	assert.deepEqual([dear.served, dear.stops, dear.guard.cost.state.inflight], [[], ["cost-cap"], 0], "nothing sent, nothing left in flight");
	// The same forward to a target no registry knows (issue #587's gate): refused before its bound, as unboundable.
	const unregistered = await proxyRun({ maxCostMicros: 1_000_000, target: { api: PRICED_API, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, maxTokens: 10000, compat: { maxTokensField: "max_tokens" } } });
	assert.equal(unregistered.logged.find((line) => line.event === "cost_refused")?.fields.why, "unboundable", JSON.stringify(unregistered.logged));
	assert.deepEqual([unregistered.served, unregistered.stops], [[], ["cost-cap"]], "a zero-rated target nobody registered is not run for free");
	// A proxy that answers with zero usage of its own: the target's usage is counted.
	const zero = await proxyRun({ answer: "zero" });
	assert.deepEqual([zero.served, zero.meter.state.calls, zero.meter.state.total], [["upstream-1"], 2, SENTINEL_TOTAL]);
	// Issue #571: its own zeros are a router's, not a lost count: it forwarded, so it is not counted costUnreported.
	assert.equal(zero.meter.snapshot().costUnreported, 0, "a forwarding proxy's own zero usage is not counted");
	// The same proxy forwarding asynchronously, after an await: still not counted, so a line with every guard counter at 0
	// settles metered at the upstream's cost. (No cap here: the served target's api is one the bound cannot price.)
	const later = await proxyRun({ answer: "async-zero" });
	assert.deepEqual([later.served, later.meter.snapshot().costUnreported, later.meter.state.cost], [["upstream-1"], 0, SENTINEL_COST]);
	const guardZeros = { costCapMicros: 5_000_000, costRefused: 0, boundExceeded: 0, longContext: 0, costUnjudged: 0, costUnanswered: 0 };
	const settled = dollarSettlement({ tokens: { ...later.meter.snapshot(), unmeteredChildren: 0, ...guardZeros }, usage: later.meter.usageSnapshot(), reservedMicros: 5_000_000, trusted: true });
	assert.deepEqual(settled, { settledMicros: Math.ceil(SENTINEL_COST * 1e6), basis: "metered" });
});

test("issue #571: a legacy registry entry that answers with a promise of a stream reaches its caller as a promise, and the meter counts the call", { skip }, async () => {
	const fx = await fixture(`pi-dispatch-fake-api-571-promise-${(loadTimeRuns += 1)}`);
	const compat = await import(resolvePiAiCompat()[0].url);
	const asyncApi = `pi-dispatch-async-api-${loadTimeRuns}`;
	// An extension's entry whose streamSimple is an async function: it answers Promise<stream>.
	const answer = async (model) => {
		const stream = compat.createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: { role: "assistant", content: [{ type: "text", text: "ok" }], api: model.api, provider: model.provider, model: model.id, usage: SENTINEL_USAGE, stopReason: "stop", timestamp: Date.now() } });
		return stream;
	};
	compat.registerApiProvider({ api: asyncApi, stream: answer, streamSimple: answer });
	const meter = createUsageMeter({ maxTokens: null, rootSessionId: "root" });
	const installed = await installProcessUsageMeter({ ModelRuntime: pi.ModelRuntime, runtime: fx.modelRuntime, meter, log: () => {} });
	try {
		const target = { ...fx.model, provider: "pi-dispatch-async", id: "async-1", api: asyncApi };
		const returned = compat.streamSimple(target, { messages: [{ role: "user", content: "hi", timestamp: 1 }] }, {});
		assert.equal(typeof returned.result, "undefined", "the premise: pi-ai's legacy call hands the promise on as it is");
		const message = await (await returned).result();
		await flush();
		assert.equal(message.usage.cost.total, SENTINEL_COST, "a caller that awaits it gets a working answer");
		assert.deepEqual([meter.state.calls, meter.state.unresolved, meter.state.total, meter.state.cost], [1, 0, SENTINEL_TOTAL, SENTINEL_COST], "so its spend is on the exit line");
	} finally {
		installed.uninstall();
		fx.cleanup();
	}
});

test("PR #547's final review: a fallback provider whose forward failed and that answers itself is counted, and a $1 cap still stops the job", { skip }, async () => {
	// No policy: the forward errs in-band, or throws, or answers; whatever it did, the provider's own $2 is counted.
	for (const entry of ["error", "throw", "ok"]) {
		const run = await proxyRun({ answer: "fallback", entry });
		assert.equal(run.result.stopReason, "stop", entry);
		assert.ok(run.meter.state.cost >= 2, `${entry}: the provider's own $2 is counted (${run.meter.state.cost})`);
		assert.ok(run.meter.usageSnapshot().models.some((row) => row.model === "proxy-1" && row.cost === 2), entry);
	}
	// Under a $1 cap, a forward that fails on the network (the target's priced api dials a closed port): the provider's
	// own $2 is charged, so the job's next call is refused cost-cap, as on main.
	const neterr = await proxyRun({ answer: "fallback", maxCostMicros: 1_000_000, target: { api: PRICED_API, compat: { maxTokensField: "max_tokens" } }, second: true });
	assert.ok(neterr.guard.cost.state.spent >= 2_000_000, `charged the provider's own $2: ${neterr.guard.cost.state.spent}`);
	assert.deepEqual([neterr.next?.errorMessage, neterr.meter.state.stopReason], ["pi-dispatch: cost cap reached", "cost-cap"]);
	// Under a $1 cap, a forward refused (unboundable target): the job stops, and the provider's own answer is still counted.
	const refused = await proxyRun({ answer: "fallback", maxCostMicros: 1_000_000 });
	assert.deepEqual([refused.served, refused.meter.state.stopReason], [[], "cost-cap"]);
	assert.ok(refused.meter.state.cost >= 2, `the provider's own $2 is counted after the refusal: ${refused.meter.state.cost}`);
});
