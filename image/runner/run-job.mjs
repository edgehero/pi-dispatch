import { existsSync, readFileSync } from "node:fs";
import {
	AuthStorage,
	createAgentSession,
	getAgentDir,
	ModelRegistry,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { assertPackagePathsExist, assertSessionMountReady, enforceOfflineMode, parseRunnerEnv } from "./src/config.mjs";
import { buildLoadedResourceLoader, GLOBAL_PI_DIR, JOB_PI_DIR, TRIGGER_SKILLS_DIR, WORKSPACE } from "./src/loader.mjs";
import {
	captureTerminal,
	classifyThrow,
	configError,
	decideExit,
	EXIT_INFRA,
} from "./src/outcome.mjs";
import { countPackageResources, findShadowedSkills, isFlowLoaded, owningRoot } from "./src/packages.mjs";
import { openSessionManager } from "./src/session.mjs";
import { attachTokenBudget } from "./src/token-budget.mjs";
import { attachTurnBudget } from "./src/turn-budget.mjs";
// NOTE: usage-meter.mjs reaches pi-ai's module-level api-provider registry through a RUNTIME-probed
// dynamic import, never a static one. Never add a pi-ai package specifier to this file's imports: two
// copies of that package are installed and a plain specifier binds the HOISTED one, which pi does not
// use -- the meter would register, report success, and count nothing. pinned-api.test.mjs guards this
// file against exactly that string.
import { createUsageMeter, installProcessUsageMeter } from "./src/usage-meter.mjs";

const PROMPT_PATH = "/job/prompt.md";

/** Log a stable identifier, never task content. Issue bodies are user-authored personal data. */
function log(event, fields = {}) {
	process.stdout.write(`${JSON.stringify({ event, jobId: process.env.PI_JOB_ID, ...fields })}\n`);
}

/** The four fields the exit line's `tokens` object always carries, whichever meter produced them. */
function pickTotals({ input, output, total, cost }) {
	return { input, output, total, cost };
}

function readPrompt(path) {
	// A missing prompt file is a worker bug (it failed to write /job inputs), not infra -- the
	// same job would fail identically on retry. Classify it as config, exit 2.
	if (!existsSync(path)) throw configError(`missing job input: ${path}`);
	return readFileSync(path, "utf8");
}

async function main() {
	const cfg = parseRunnerEnv(process.env);

	// FIRST, before the prompt is read and before any auth or model lookup: a staged package root
	// that did not mount is a pre-spend config failure (exit 2, not retried) and this is the only
	// place it is still free. pi SKIPS a local package source that does not resolve -- no error, no
	// diagnostic -- so an unmounted package would otherwise run the job to a clean exit 0 without the
	// tools the flow was written for, and report success for work it could not have done.
	// INT-CONTAINER-JOB-INPUTS.
	assertPackagePathsExist(cfg.packages);
	// Same reason, same moment, same exit code: the host ALWAYS stages the session file when a trigger
	// armed run.resume -- as a 0-byte file even on a cold start -- so an absent one means the /session
	// bind mount did not land, not that there is nothing to resume. INT-SESSION-STORE-CONTRACT.
	assertSessionMountReady(cfg.sessionFile);
	// Offline is a property of the RUNNER, not of whoever started it. Set before the loader is built,
	// because the loader is what resolves package sources: with offline off, an unresolved source is a
	// live `npm install` at agent runtime, from inside the job, against a network the job's own input
	// can influence. Idempotent and only ever tightening. INT-SDK-SESSION-OPTIONS.
	enforceOfflineMode(process.env);

	const prompt = readPrompt(PROMPT_PATH);

	const agentDir = getAgentDir();

	// AuthStorage + ModelRegistry, NOT ModelRuntime.
	//
	// pi's [Unreleased] changelog says these two are replaced by an async `modelRuntime`. That is
	// true of its main branch and NOT of 0.80.7, which is what we pin -- the source at HEAD and the
	// artifact on npm are different things, and conflating them cost a build. When the migration
	// ships, REQ-UPSTREAM-CONTRACT-TESTS fires on the pin bump and this is the code that changes.
	// See OQ-005.
	const authStorage = AuthStorage.create(`${agentDir}/auth.json`);
	// Prefer the operator's global overlay models.json (REQ-GLOBAL-PI-OVERLAY) when the :ro overlay is
	// mounted -- this is how a CUSTOM provider/model becomes resolvable. The credential still comes from
	// env -> auth.json; the overlay models.json is definitions only (import-pi refuses a literal key).
	const GLOBAL_MODELS = "/opt/pi-global/models.json";
	const modelsPath = existsSync(GLOBAL_MODELS) ? GLOBAL_MODELS : `${agentDir}/models.json`;
	const modelRegistry = ModelRegistry.create(authStorage, modelsPath);

	// Pin the model explicitly. With `model` omitted, pi picks from settings and provider defaults
	// -- nondeterministic across images, and it silently changes cost per job.
	const model = modelRegistry.find(cfg.provider, cfg.model);
	if (!model) throw configError(`unknown model: ${cfg.provider}/${cfg.model}`);
	if (!modelRegistry.hasConfiguredAuth(model)) throw configError(`no configured auth for ${cfg.provider}`);

	// Pin pi's own retry settings rather than inherit `maxRetries ?? 3`. An upstream default change
	// would silently move our spend (CONST-PI-VERSION-PINNED's reasoning, applied to a default). And
	// inMemory() writes to the GLOBAL scope of a storage with no project file, so a serviced
	// project's .pi/settings.json cannot override our spend controls.
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, ...cfg.retry } });

	// `log` is handed over so the loader's own findings arrive on THIS writer, with this job's id: the
	// recursion guard drops an extension during reload() (see dropAdminExtensions), and a drop that
	// landed on a second, id-less writer would be an operator's only clue to a missing tool while being
	// unattributable to a run.
	const resourceLoader = await buildLoadedResourceLoader({
		settingsManager,
		allowGlobalExtensions: cfg.allowGlobalExtensions,
		packagePaths: cfg.packages,
		log,
	});

	// Read ONCE, unconditionally: the flow check below needs the loaded set whether or not packages
	// are staged, and the packages diagnostics block reuses the same bindings.
	const { skills, diagnostics } = resourceLoader.getSkills();

	// REPORT a flow that resolved in NO tier (issue #189). The trigger's run.flow reaches the model
	// as prompt prose, and pi never matches prose against loaded skill names, so without this line a
	// flow that materialised nowhere -- repo, injected, overlay or staged package -- runs to a clean
	// exit 0 without the procedure it was written for and reports success for work it could not have
	// done. That is the exact outcome assertPackagePathsExist refuses for an unmounted package root,
	// and the deliberate difference is that this one only REPORTS: run.flow is by long doctrine a
	// prompt hint (prepare.mjs), deployments legitimately run flows as loose hints over repos with no
	// .pi/skills, and the runner cannot tell that steady state from breakage. Refusing would break
	// them on an image upgrade for a value their reviewed file has carried all along. The line sits
	// at the pre-spend moment anyway, so flipping report to refusal is a one-line change here plus a
	// spec row (DES-FLOW-RESOLUTION-TWO-ADVISORY-LAYERS records the choice). Doctor's host-side tier
	// lines are the other advisory layer; this one is exact because it reads what actually loaded.
	// Flow name, never task content: run.flow is operator config out of the reviewed triggers file.
	if (!isFlowLoaded(cfg.flow, skills)) {
		log("flow_not_loaded", { flow: cfg.flow, skills: skills.length });
	}

	if (cfg.packages.length > 0) {
		// REPORT a staged package skill that TRIED to shadow a repo or operator-overlay skill.
		//
		// pi builds skillPaths as mergePaths(cliEnabledSkills, additionalSkillPaths) -- package paths
		// FIRST -- and loadSkills is first-path-wins, so on the raw load a package's `deploy` beats the
		// repo's. That ordering is pi's, but the outcome is not: loader.mjs re-imposes precedence
		// through the loader's declared `skillsOverride` option, so by the time we get here the repo's
		// skill is the one in force and REQ-GLOBAL-PI-OVERLAY's "repo wins on conflict" holds.
		//
		// This is therefore NOT a refusal. It is the one place the operator can learn that a staged
		// package shipped a name the repo had already published -- the package's own flow was written
		// against a procedure that is not the one now running, so it may do less than it claims. Refusing
		// the job would be refusing a conflict we have already resolved the documented way; saying
		// nothing would leave the operator to discover it from behaviour.
		//
		// The protected roots are derived from the loader's own constants rather than written out
		// again, so a change to where the worker materialises .pi/ cannot leave this check guarding
		// paths that no longer exist.
		const protectedRoots = [`${JOB_PI_DIR}/skills`, TRIGGER_SKILLS_DIR, `${GLOBAL_PI_DIR}/skills`];
		const shadowed = findShadowedSkills(diagnostics, { packageRoots: cfg.packages, protectedRoots });
		if (shadowed.length > 0) {
			// The winner is read off the LOADED skill, not off pi's pre-override diagnostic: the
			// diagnostic records what the raw load produced, and reporting that as the outcome would
			// state the opposite of what is running. Roots, never file paths.
			const loadedByName = new Map(skills.map((skill) => [skill.name, skill]));
			log("package_skill_shadowed", {
				skills: [...new Set(shadowed.map((collision) => collision.name))].sort().map((name) => ({
					name,
					root: owningRoot(loadedByName.get(name)?.filePath, [...protectedRoots, ...cfg.packages]),
				})),
			});
		}

		// Counts and root basenames only, NEVER task content. A root that contributed nothing still
		// reports 0 -- a package that mounted but resolved to no resources is otherwise
		// indistinguishable from one that worked, and the job runs without the tools its flow expects.
		log("packages_loaded", {
			packages: countPackageResources({
				packageRoots: cfg.packages,
				extensionPaths: resourceLoader.getExtensions().extensions.map((extension) => extension.path),
				skillPaths: skills.map((skill) => skill.filePath),
			}),
		});
	}

	// HOISTED so the root session id exists BEFORE the meter does. createAgentSession would otherwise
	// build its own SessionManager and the id would only be readable afterwards -- too late, because
	// createUsageMeter must know which session is the root to split rootTotal from otherTotal, and an
	// undefined root would file every call as unattributed and hide the fanout the meter exists to see.
	// Persisted when the trigger armed run.resume and the host resolved a key, in-memory otherwise --
	// and openSessionManager is TOTAL, so the hoist below holds on every path including a degraded one.
	const { sessionManager, resumed: sessionResumed, reason: sessionReason } = openSessionManager({ sessionFile: cfg.sessionFile, cwd: WORKSPACE, log });
	const rootSessionId = sessionManager.getSessionId();

	// Declared before the meter so onBreach can close over it; assigned the moment the session exists.
	let session;

	/** One log shape for both meters -- an operator must not have to learn which one fired. */
	const onTokenAbort = (tokens) => log("token_budget_exceeded", { tokens, maxTokens: cfg.maxTokens });

	// REQ-TOKEN-ACCOUNTING-AND-CAPS / CONST-BUDGET-BEFORE-TOKENS, issue #58.
	//
	// The per-session event bus cannot see a subagent session an extension spawns: the bus is per
	// AgentSession instance and no event carries a sessionId, so a 16-wide fanout registers on our bus
	// as roughly ONE turn. Metering at pi-ai's module-level api-provider registry -- the one choke
	// point every in-process session funnels through -- counts calls instead of turns and gets
	// per-session attribution for free from options.sessionId. Installed AFTER ModelRegistry.create
	// (it registers through the registry so refresh() re-applies it) and BEFORE createAgentSession.
	const meter = createUsageMeter({
		maxTokens: cfg.maxTokens,
		rootSessionId,
		onBreach: (tokens) => {
			onTokenAbort(tokens);
			// Same synchronous-abort discipline as attachTokenBudget's onAbort: abort() flips the
			// AbortController before its first await, so the signal is set the instant we call it.
			// Awaiting here would let the next turn start under a cap we already know is blown.
			void session?.abort();
		},
	});
	const usageMeter = await installProcessUsageMeter({ modelRegistry, meter, log });

	({ session } = await createAgentSession({
		cwd: WORKSPACE,
		agentDir,
		authStorage,
		modelRegistry,
		model,
		settingsManager,
		sessionManager,
		resourceLoader,
	}));

	// Deterministic re-arm. Extensions register their providers during createAgentSession, so any api
	// id that did not exist at install time is unwrapped until now. The unref'd interval inside the
	// meter would eventually catch it; this closes the window before the first prompt instead of
	// leaving the first call of an extension-provided model unmetered.
	usageMeter.arm();

	// prompt() returns Promise<void>, so this subscription is the ONLY channel through which the
	// outcome arrives. captureTerminal handles both event shapes (agent_end carries messages[],
	// turn_end carries message).
	let terminal;
	const unsubscribeTerminal = session.subscribe((event) => {
		terminal = captureTerminal(terminal, event);
		if (event.type === "auto_retry_start") {
			// pi retries internally. Surface it: our daily cap counts jobs, not provider calls.
			log("pi_auto_retry", { attempt: event.attempt, maxAttempts: event.maxAttempts });
		}
	});

	const budget = attachTurnBudget(session, cfg.maxTurns, {
		onAbort: (turns) => log("turn_budget_exceeded", { turns, maxTurns: cfg.maxTurns }),
	});

	// FALLBACK ONLY. The process-wide meter is the single source of truth whenever it installed, so
	// the per-session accumulator is attached only when it did NOT -- the two are never both counting
	// and a double count is impossible by construction rather than by arithmetic. Still an always-on
	// meter that aborts only when cfg.maxTokens is set (lagging backstop, OQ-010).
	const tokenBudget = usageMeter.ok ? null : attachTokenBudget(session, cfg.maxTokens, { onAbort: onTokenAbort });

	try {
		await session.prompt(prompt);
	} finally {
		budget.unsubscribe();
		tokenBudget?.unsubscribe();
		// Stops the meter's re-arm interval. It is unref'd, so this is hygiene rather than a hang fix
		// -- but REQ-JOB-TIMEOUT-30M is a backstop, not a teardown plan, and a timer left running past
		// the session it was metering is exactly the kind of thing that becomes one.
		usageMeter.uninstall();
		unsubscribeTerminal();
		// Runs the cleanup callbacks providers register via registerSessionResourceCleanup. Every
		// official SDK example disposes; skipping it can leak a provider transport and hang the
		// container until the 30-minute timeout -- a completed job turned into a timeout failure.
		session.dispose();
	}

	const outcome = decideExit({
		budgetAborted: budget.state.aborted,
		budgetTurns: budget.state.turns,
		// Whichever meter was actually counting. outcome.mjs needs no change: either flag maps to the
		// same reason:"token_budget" / exit 2.
		tokenAborted: usageMeter.ok ? meter.state.breached : tokenBudget.state.aborted,
		terminal,
	});
	// `metered: true` on the process-wide snapshot is what tells the daily token counter that this
	// total includes every in-process session, not just the root's turns.
	const tokens = usageMeter.ok ? meter.snapshot() : { ...pickTotals(tokenBudget.state), metered: false };
	// The per-(provider,model) ledger (issue #53, INT-RUN-HISTORY-FILE-CONTRACT) -- a SIBLING of
	// `tokens`, never a widening of it: `tokens` rides through the worker verbatim because it holds
	// nothing but numbers, while the ledger carries id STRINGS the host re-validates through its own
	// parser. Only the process-wide meter keeps a ledger (the per-session fallback cannot attribute a
	// call to a model), and a metered run with zero provider calls has no rows to report -- both come
	// back null, and the key is then OMITTED rather than emitted as null, so those exit lines stay
	// byte-identical to what every pre-ledger consumer already parses.
	const usage = usageMeter.ok ? meter.usageSnapshot() : null;
	// `session` reports what pi ACTUALLY did, not what the host intended. The host records its own
	// intent separately, and the pair is what makes a degrade visible: a host that resolved a key while
	// the container reports resumed:false is a real event, and without both numbers it is indist-
	// inguishable from an ordinary cold start. A feature that fails open must still say that it did.
	log("exit", { ...outcome, turns: budget.state.turns, tokens, ...(usage ? { usage } : {}), session: { resumed: sessionResumed, reason: sessionReason } });
	return outcome.code;
}

// Preflight throws; the agent loop swallows. Both paths are real and cover disjoint failure sets
// -- see INT-RUNNER-EXIT-CODE-PROTOCOL. Without this catch, a missing API key is an unhandled
// rejection exiting Node's default 1, which the protocol defines as RETRYABLE, so the queue would
// pay to retry a job that can never succeed.
main()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		const outcome = classifyThrow(error);
		log("exit", { code: outcome.code, reason: outcome.reason, message: outcome.message });
		process.exitCode = outcome.code ?? EXIT_INFRA;
	});
