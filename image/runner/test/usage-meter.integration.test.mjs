import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer } from "node:http";
import { test } from "node:test";
// Both of these are pure -- no static pi import anywhere in their module graph -- so they load
// unconditionally and the gate below applies only to pi itself.
import { attachTokenBudget } from "../src/token-budget.mjs";
import { createJobModelRuntime } from "../src/model-runtime.mjs";
import { assertPoliciesEnforceable, callCostBound, createCostGuard, createPolicyGuard, createUsageMeter, installProcessUsageMeter, policyEnforcement, resolvePiAiCompat } from "../src/usage-meter.mjs";
import { decideExit, EXIT_POLICY, MODEL_NOT_ALLOWED } from "../src/outcome.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

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
		assert.equal(installed.tag, "nested", `the compat half must accept pi's own copy; logged ${JSON.stringify(logged)}`);
		assert.equal(logged[0]?.fields?.compat, "nested");

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

// ── Issue #501: the per-job cost cap, checked BEFORE each call, through the real dispatch chain ────────────
//
// The model is priced on `openai-completions`, one of the PRICED_APIS, so the guard bounds it from the catalog row
// models.json declares, exactly as it would a real provider's: input $1/M, output $100/M, maxTokens 10000. A
// session turn passes no maxTokens, so every call's bound is (request bytes + 8192) x 1 + 10000 x 100: just over
// one dollar (1,000,000 micro-dollars of output plus about 10,000 of input). Each call then SETTLES at a fixed $0.40.
// The margins below are hundreds of thousands of micro-dollars wide, so the request's exact byte count cannot
// move an outcome.
const PRICED_API = "openai-completions";
const PRICED_MODEL = { cost: { input: 1, output: 100, cacheRead: 0, cacheWrite: 0 }, maxTokens: 10000 };
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

/** A local OpenAI-shaped server. `plan` answers each request in turn: "429", "ok", "lost" (no answer), "inband" (200, then an error before content) or "cut" (200, content deltas, then the socket dies). */
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
			chunk({ ...base, choices: [], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } });
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
		models: [{ id: "loopback-priced", name: "priced", api: "openai-completions", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, reasoning: false, input: ["text"], cost: { input: 1, output: 100, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 10000 }] } } }));
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
