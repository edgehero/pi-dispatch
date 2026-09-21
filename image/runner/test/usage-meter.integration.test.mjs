import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
// Both of these are pure -- no static pi import anywhere in their module graph -- so they load
// unconditionally and the gate below applies only to pi itself.
import { attachTokenBudget } from "../src/token-budget.mjs";
import { createUsageMeter, installProcessUsageMeter } from "../src/usage-meter.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * THE PROOF for issue #58 (REQ-TOKEN-ACCOUNTING-AND-CAPS, CONST-BUDGET-BEFORE-TOKENS).
 *
 * usage-meter.test.mjs verifies the accumulator with everything pi-shaped injected. That is the right
 * shape for the arithmetic and the wrong shape for the CLAIM this commit rests on, which is about the
 * real SDK: that two AgentSessions alive in one process are invisible to each other's event bus, and
 * that metering at pi-ai's module-level api-provider registry sees both. A fake registry cannot
 * falsify either half -- only a real `createAgentSession` can.
 *
 * There is NO API credential here and none is needed. The fixture declares a CUSTOM provider whose
 * api id is served by a `streamSimple` we register ourselves, so the whole run is offline: nothing is
 * dialled, and the baseUrl points at a port that is not listening precisely so a regression that DOES
 * try to dial fails loudly instead of quietly reaching the internet.
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
 * `api` is parameterised because installProcessUsageMeter wraps EVERY api id registered at arm() time
 * and never unwraps (`uninstall()` only clears the re-arm interval, by design -- unregistering would
 * call refresh() -> resetApiProviders() and wipe every wrapper). Giving each test its own api id is
 * what keeps one test's meter out of the next test's dispatch chain.
 */
function fixture(api) {
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
						models: [
							{
								id: MODEL_ID,
								name: "pi-dispatch fake",
								api,
								reasoning: false,
								input: ["text"],
								cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
								contextWindow: 100000,
								maxTokens: 4096,
							},
						],
					},
				},
			},
			null,
			"\t",
		)}\n`,
	);

	const authStorage = pi.AuthStorage.create(join(root, "auth.json"));
	const modelRegistry = pi.ModelRegistry.create(authStorage, modelsPath);
	const model = modelRegistry.find(PROVIDER, MODEL_ID);
	assert.ok(model, "the fixture's custom model must resolve out of models.json");
	assert.ok(modelRegistry.hasConfiguredAuth(model), "the fixture's literal apiKey must count as configured auth");
	return { root, authStorage, modelRegistry, model, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Register the provider that serves the fixture's api id.
 *
 * Registered through `modelRegistry.registerProvider` (not compat's registerApiProvider) for the same
 * reason the meter does: refresh() re-applies stored provider configs, so this survives a reload the
 * way a real extension's provider would. `calls` records what actually reached the provider, which is
 * how the hard-stop test proves a capped call never got there.
 */
function registerFakeProvider({ modelRegistry, compat, api, calls }) {
	modelRegistry.registerProvider(PROVIDER, {
		api,
		streamSimple(model, _context, options) {
			calls.push({ sessionId: options?.sessionId, apiKey: options?.apiKey });
			const stream = compat.createAssistantMessageEventStream();
			// A terminal "done" resolves result() via EventStream's completion predicate -- the exact
			// channel meter.observe() reads, and the one the agent loop awaits.
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: SENTINEL_USAGE,
					stopReason: "stop",
					timestamp: Date.now(),
				},
			});
			return stream;
		},
	});
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
async function openSession({ fx, sessionManager }) {
	const settingsManager = pi.SettingsManager.inMemory({});
	const resourceLoader = new pi.DefaultResourceLoader({
		cwd: fx.root,
		agentDir: pi.getAgentDir(),
		settingsManager,
		noContextFiles: true,
		noSkills: true,
		noExtensions: true,
	});
	await resourceLoader.reload();
	const { session } = await pi.createAgentSession({
		cwd: fx.root,
		agentDir: pi.getAgentDir(),
		authStorage: fx.authStorage,
		modelRegistry: fx.modelRegistry,
		model: fx.model,
		settingsManager,
		sessionManager,
		resourceLoader,
		// "all", not `true`: CreateAgentSessionOptions.noTools is the union "all" | "builtin" at the
		// pin. No tools at all keeps every prompt to exactly one provider call, so `calls` counts what
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
	const fx = fixture(API);
	const sessions = [];
	let installed;
	try {
		// The root SessionManager FIRST: its id must exist before the meter is constructed.
		const rootManager = pi.SessionManager.inMemory(fx.root);
		const otherManager = pi.SessionManager.inMemory(fx.root);
		const rootSessionId = rootManager.getSessionId();
		assert.notEqual(rootSessionId, otherManager.getSessionId(), "the two sessions must have distinct ids");

		const meter = createUsageMeter({ maxTokens: null, rootSessionId });
		installed = await installProcessUsageMeter({ modelRegistry: fx.modelRegistry, meter, log: () => {} });
		assert.equal(installed.ok, true, "the meter must find the pi-ai copy pi actually mutates");

		const calls = [];
		registerFakeProvider({ modelRegistry: fx.modelRegistry, compat: installed.module, api: API, calls });
		// The re-arm run-job.mjs performs after createAgentSession: our api id did not exist when the
		// meter installed, so without this the fake provider is unwrapped and nothing is counted.
		installed.arm();

		const rootSession = await openSession({ fx, sessionManager: rootManager });
		const otherSession = await openSession({ fx, sessionManager: otherManager });
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
		// compat dispatched on, not off the settled message -- with the cache split intact that the flat
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
	const fx = fixture(API);
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
			onBreach: (total) => breaches.push(total),
		});
		installed = await installProcessUsageMeter({ modelRegistry: fx.modelRegistry, meter, log: () => {} });
		assert.equal(installed.ok, true);

		const calls = [];
		registerFakeProvider({ modelRegistry: fx.modelRegistry, compat: installed.module, api: API, calls });
		installed.arm();

		const rootSession = await openSession({ fx, sessionManager: rootManager });
		const otherSession = await openSession({ fx, sessionManager: otherManager });
		sessions.push(rootSession, otherSession);

		await Promise.all([rootSession.prompt("root prompt"), otherSession.prompt("other prompt")]);
		await flush();

		assert.equal(meter.state.breached, true, "two sentinel calls must exceed a cap one token below their sum");
		assert.deepEqual(breaches, [2 * SENTINEL_TOTAL], "onBreach fires exactly once, carrying the running total");
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
		// "aborted" rather than "error" is load-bearing: pi's isRetryableAssistantError returns false
		// unless stopReason === "error", so an "error" here would make the cap trigger PAID auto-retries.
		assert.equal(terminal?.usage?.totalTokens, 0, "nothing was spent, so nothing may be recorded as spent");
		assert.equal(terminal?.usage?.cost?.total, 0);

		// And the totals did not move: the refused call is not observed at all (the wrapper returns
		// before meter.observe), so it cannot inflate calls, cost, or the daily token counter.
		const snapshot = meter.snapshot();
		assert.equal(snapshot.calls, 2, "a refused call must not be counted as a call");
		assert.equal(snapshot.total, 2 * SENTINEL_TOTAL, "the overshoot is reported as-is; the refusal adds nothing");
	} finally {
		for (const session of sessions) session.dispose();
		installed?.uninstall();
		fx.cleanup();
	}
});
