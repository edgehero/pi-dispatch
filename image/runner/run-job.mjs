import { existsSync } from "node:fs";
import {
	createAgentSession,
	getAgentDir,
	ModelRuntime,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	assertJobInputsReadable,
	assertPackagePathsExist,
	assertSessionMountReady,
	commandName,
	enforceOfflineMode,
	enforceTelemetryOff,
	jobSettings,
	mountAdvisories,
	parseRunnerEnv,
	readPrompt,
} from "./src/config.mjs";
import { buildLoadedResourceLoader, GLOBAL_PI_DIR, JOB_PI_DIR, TRIGGER_SKILLS_DIR, WORKSPACE } from "./src/loader.mjs";
import {
	capExitMessage,
	captureTerminal,
	classifyPromptRejection,
	classifyThrow,
	configError,
	costRefusalField,
	decideExit,
	EXIT_INFRA,
	loadRetryPredicate,
} from "./src/outcome.mjs";
import { restoreEnvProxyDispatcher } from "./src/env-proxy.mjs";
import { createExitWriter, readExitKey, writeAllSync } from "./src/exit-line.mjs";
import { createJobModelRuntime, loadPiAuthStorage } from "./src/model-runtime.mjs";
import { countPackageResources, findShadowedSkills, isFlowLoaded, owningRoot } from "./src/packages.mjs";
import { isNestedRunner, runAsPiCli } from "./src/child-route.mjs";
import { createChildWatch } from "./src/child-watch.mjs";
import { precheckAtExit } from "./src/plan-check.mjs";
import { openSessionManager } from "./src/session.mjs";
import { attachTokenBudget } from "./src/token-budget.mjs";
import { assertExcludeToolsKnown } from "./src/tools.mjs";
import { attachTurnBudget } from "./src/turn-budget.mjs";
// NOTE: usage-meter.mjs meters at ModelRuntime.prototype, with the class handed over from the import above,
// and reaches pi-ai (its compat half, the brake's stream factory) only through a copy it proves at runtime,
// never a static import. Never add a pi-ai package specifier to this file's imports: two copies of that
// package are installed and a plain specifier binds the HOISTED one, which pi does not use.
// pinned-api.test.mjs guards this file against exactly that string.
import {
	assertPoliciesEnforceable,
	createPolicyGuard,
	createUsageMeter,
	installProcessUsageMeter,
	meterStopHandler,
	openChildLedger,
	policyEnforcement,
	publishPriceTable,
	resolvePiAiCompat,
} from "./src/usage-meter.mjs";

// FIRST, before anything else this file does (issue #500): is this the job's runner, or a NESTED copy of it that a
// tool started as a pi CLI? pi's stock subagent example spawns `process.execPath process.argv[1] <pi args>`, which in a
// job is this file, and before this check such a child ran the whole job prompt again (OQ-011 M1). A nested runner runs
// as the pi CLI instead, metered through the job runner's ledger directory (child-route.mjs runAsPiCli): it reads no
// exit key, writes no exit line, installs no SIGTERM handler, never reaches main() (the block at the end of this file
// is the job runner's alone), never reads /job and opens no ledger directory of its own.
const nestedRunner = isNestedRunner(process.env, process.pid);
if (nestedRunner) await runAsPiCli();

const JOB_DIR = "/job";
const PROMPT_PATH = `${JOB_DIR}/prompt.md`;

/** Log a stable identifier, never task content. Issue bodies are user-authored personal data.
 *  Newline-DELIMITED, not merely newline-terminated: the leading \n closes whatever un-newlined
 *  write a subprocess sharing this stdout left dangling, which otherwise glues onto this line and
 *  costs the host every exit-line field at once (issue #224, OQ-003). The host also repairs glued
 *  lines on its side (`parseTailLine`), because this fix only reaches deployments that pull a new
 *  image; both halves are deliberate. */
function log(event, fields = {}) {
	// env-internal PI_JOB_ID: set by the worker on the container, so a log line can name its job.
	process.stdout.write(`\n${JSON.stringify({ event, jobId: process.env.PI_JOB_ID, ...fields })}\n`);
}

/** The four fields the exit line's `tokens` object always carries, whichever meter produced them. */
function pickTotals({ input, output, total, cost }) {
	return { input, output, total, cost };
}

/**
 * What the process-wide meter has counted, as the exit line carries it: `tokens` and, when it observed a call, `usage`.
 * Empty until the meter installs; then set, so EVERY exit line after that carries them, the outer catch's included
 * (issue #543): a call an extension made while it loaded may have spent before a later check refused the job
 * (command-unregistered, say), and an exit line without tokens would hide that spend from the settlement.
 */
let meteredExitFields = () => ({});
/**
 * The meter's stop, if it stopped, as the outcome decideExit ranks it, else null. Set with meteredExitFields. A throw
 * after a stop (a load-time call refused, then command-unregistered) exits with the STOP's reason, the same ranking
 * decideExit gives a stop over a rejected prompt, so the record says why the job really ended (PR #547's review).
 */
let meterStopAtExit = () => null;
/**
 * The cost guard's first refusal rule (issue #507, outcome.mjs COST_REFUSALS), or null. Set once the guard exists. Both
 * exit-line paths spread costRefusalField(outcome, costRefusalWhy()), so a `cost-cap` line names which rule refused.
 */
let costRefusalWhy = () => null;
/**
 * The turn count and the session as they stand, for an exit line written by the SIGTERM handler (issue #545). Empty
 * until the turn budget is attached; then set, so a line written on a stop carries what the decided line would have.
 */
let liveExitFields = () => ({});
/**
 * The meter's teardown (issue #500 part E's review): the children hook's final fold, its STOP and its teardown rule, and
 * the teardown line. Empty until the meter installs; idempotent. The prompt's finally runs it, and so do the SIGTERM
 * handler and the outer catch before they write their exit line, so every line a metered run writes carries the final
 * fold and every unmetered child the detector would count. Bounded: the fold reads at most CHILD_LEDGER_MAX_FILES open
 * files and the /proc scan stops at its time budget, well inside the stop's grace period.
 */
let finishMeter = () => {};

/** The exit line's key (issue #545) and its one writer, both set in the job runner's block at the end of this file before main runs. */
let exitKey;
let exitWriter;

async function main() {
	// A worker that asked for a signed exit line and did not deliver a usable key: the run goes on with an unsigned
	// line, which that worker reads as no line at all (the floor, tokens unknown). Said here, by kind only.
	if (exitKey.problem !== null) log("exit_key_unread", { problem: exitKey.problem });
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
	// Same moment, same exit code, and for EVERY job, command jobs included (issue #341): a job user that cannot
	// traverse /job loses its trigger skills without a word and would otherwise spend anyway.
	// /workspace joins the list for READ only (issue #355). On an SELinux-enforcing host, an operator's local folder
	// that is not labelled container_file_t is unreadable in the container whatever its mode bits say (measured on
	// Fedora 44), and before this the job ran and spent with an agent that could not read its own repository.
	// UNWRITABLE stays advisory (mountAdvisories below): "a read-only review of a folder the job user cannot write
	// is a legitimate job", so only a workspace the job cannot even read is refused here.
	assertJobInputsReadable([JOB_DIR, GLOBAL_PI_DIR, WORKSPACE]);
	// Offline is a property of the RUNNER, not of whoever started it. Set before the loader is built,
	// because the loader is what resolves package sources: with offline off, an unresolved source is a
	// live `npm install` at agent runtime, from inside the job, against a network the job's own input
	// can influence. Idempotent and only ever tightening. INT-SDK-SESSION-OPTIONS.
	enforceOfflineMode(process.env);
	// Same moment, same reason (issue #509): pi reads PI_TELEMETRY at each call and it OVERRIDES the setting
	// jobSettings pins, so the override is closed here, before the runtime or any request exists.
	enforceTelemetryOff(process.env);
	// And before anything can reach the network: loading pi (the static import above) replaced the env-proxy dispatcher
	// NODE_USE_ENV_PROXY installed, so with egress armed the provider call went direct and died on the job's
	// `--internal` network (issue #427). Free, and a no-op unless NODE_USE_ENV_PROXY=1 reached the container.
	restoreEnvProxyDispatcher();
	// Same moment as the mount asserts above, same exit code, and the same silent-skip hazard behind it
	// (issue #291): pi consults excludeTools only through a Set filter, so an unknown name is a no-op
	// with no diagnostic -- the job would run WITH the tool the trigger says to remove. Free, pre-spend,
	// and before the prompt is even read; the entry is reported verbatim so a padded name reads as itself.
	if (cfg.excludeTools.length > 0) assertExcludeToolsKnown(cfg.excludeTools);

	// A command job's prompt is rebuilt from PI_COMMAND rather than read from disk: one in-container
	// authority, so a worker bug that wrote a prompt.md disagreeing with the env var cannot make the
	// classification below (command-completed on a promptless return) misread a flow job. pi's
	// dispatch grammar demands it anyway -- a command dispatches only when the ENTIRE prompt starts
	// with "/", and everything after the first space becomes the handler's args, so there is no such
	// thing as a command line "at the top of" a larger prompt. prompt.md still carries the same bytes
	// as the human record of what ran (INT-CONTAINER-JOB-INPUTS).
	const prompt = cfg.command ? `/${cfg.command}` : readPrompt(PROMPT_PATH);

	// Advisory only (issue #341): the reason a later write fails, logged before pi or any tool tries one.
	for (const [event, fields] of mountAdvisories()) log(event, fields);

	const agentDir = getAgentDir();

	// ModelRuntime, the 0.99.1 model and credential layer (issue #509, OQ-005's migration, which shipped between
	// 0.80.7 and this pin: AuthStorage is no longer exported and ModelRegistry is a facade over a runtime).
	// Built AFTER enforceOfflineMode, deliberately: create() reads PI_OFFLINE at construction to decide whether the
	// runtime may ever reach the network (model-runtime.js:92). The options, and why each is set, live in
	// src/model-runtime.mjs. Prefer the operator's global overlay models.json (REQ-GLOBAL-PI-OVERLAY) when the :ro
	// overlay is mounted -- this is how a CUSTOM provider/model becomes resolvable.
	const GLOBAL_MODELS = "/opt/pi-global/models.json";
	const modelsPath = existsSync(GLOBAL_MODELS) ? GLOBAL_MODELS : `${agentDir}/models.json`;
	// The credentials are auth.json as it is NOW, held in memory (issue #587's gate, src/model-runtime.mjs has the why).
	const modelRuntime = await createJobModelRuntime({ ModelRuntime, AuthStorage: await loadPiAuthStorage(), agentDir, modelsPath });

	// Pin the model explicitly. With `model` omitted, pi picks from settings and provider defaults
	// -- nondeterministic across images, and it silently changes cost per job. hasConfiguredAuth takes the
	// PROVIDER id at 0.99.1 (it took the model at 0.80.7) and answers from the availability snapshot create()
	// awaited, so both refusals stay pre-spend config errors (exit 2) exactly as before.
	const model = modelRuntime.getModel(cfg.provider, cfg.model);
	if (!model) throw configError(`unknown model: ${cfg.provider}/${cfg.model}`);
	if (!modelRuntime.hasConfiguredAuth(model.provider)) throw configError(`no configured auth for ${cfg.provider}`);

	// Retry pinned, cache warming off, telemetry off: every key and why, in src/config.mjs jobSettings.
	const settingsManager = SettingsManager.inMemory(jobSettings(cfg.retry));

	// HOISTED so the root session id exists BEFORE the meter does. createAgentSession would otherwise
	// build its own SessionManager and the id would only be readable afterwards -- too late, because
	// createUsageMeter must know which session is the root to split rootTotal from otherTotal, and an
	// undefined root would file every call as unattributed and hide the fanout the meter exists to see.
	// Persisted when the trigger armed run.resume and the host resolved a key, in-memory otherwise --
	// and openSessionManager is TOTAL, so the hoist below holds on every path including a degraded one.
	const { sessionManager, resumed: sessionResumed, reason: sessionReason } = openSessionManager({ sessionFile: cfg.sessionFile, cwd: WORKSPACE, log });
	const rootSessionId = sessionManager.getSessionId();

	// Declared before the meter so onStop can close over it; assigned the moment the session exists.
	let session;
	// Read off the session before it is disposed, reported on the exit line, and persisted host-side
	// beside the transcript so the NEXT job on this key can bound what it resumes into.
	let contextUsage;

	/** One log shape for both meters -- an operator must not have to learn which one fired. */
	const onTokenAbort = (tokens) => log("token_budget_exceeded", { tokens, maxTokens: cfg.maxTokens });

	// REQ-TOKEN-ACCOUNTING-AND-CAPS / CONST-BUDGET-BEFORE-TOKENS, issue #58.
	//
	// The per-session event bus cannot see a subagent session an extension spawns: the bus is per
	// AgentSession instance and no event carries a sessionId, so a 16-wide fanout registers on our bus
	// as roughly ONE turn. Metering at ModelRuntime.prototype -- the one choke point every in-process
	// session's model calls go through at 0.99.1 -- counts calls instead of turns and gets per-session
	// attribution for free from options.sessionId. Installed AFTER the runtime exists (the install checks
	// that THIS instance dispatches through the wrappers) and BEFORE the resource loader is built (issue #543):
	// an extension factory runs inside the loader's reload(), and a model call it makes there, through a
	// ModelRuntime of its own or pi-ai's legacy global stream functions, is already metered and judged. The
	// session's first call is metered for the same reason.
	// The child ledger (issue #500), opened BEFORE the meter installs and before any extension loads, because a child
	// can be spawned from the first extension factory on. Every descendant inherits the directory, this runner's pid and
	// a NODE_OPTIONS --import of the child preload, which meters a pi child in the child and reports through a file in
	// the directory (openChildLedger). The meter's children hook (child-watch.mjs) folds the files on every tick and at
	// teardown, and removes the directory after its final fold. With no directory the children are not pointed anywhere
	// and a pi child runs unmetered, which the hook's detector counts; said here, by code only (a path never ships in a log).
	const childLedger = openChildLedger({ env: process.env, pid: process.pid, preloadUrl: new URL("./src/child-preload.mjs", import.meta.url).href });
	if (childLedger.error !== undefined) log("child_ledger_unavailable", { reason: childLedger.error });
	// Declared before the meter so its onStop can write STOP at once (the hook rewrites it on every tick anyway).
	let childWatch = null;
	const stopHandler = meterStopHandler({ onTokenAbort, abort: () => void session?.abort() });

	const meter = createUsageMeter({
		maxTokens: cfg.maxTokens,
		maxCostMicros: cfg.maxCostMicros,
		allowedModels: cfg.allowedModels,
		rootSessionId,
		// The meter's ONE stop (issues #501, #502): the token cap, the cost cap and the model list. Fires once,
		// for the first stop only, whichever policy it was; only a token stop logs token_budget_exceeded
		// (meterStopHandler). Same synchronous-abort discipline as attachTokenBudget's
		// onAbort: abort() flips the AbortController before its first await, so the signal is set the instant we
		// call it. Awaiting here would let the next turn start under a cap we already know is blown.
		onStop: (reason, detail) => {
			stopHandler(reason, detail);
			childWatch?.stopped(reason);
		},
	});
	// The allowed-model list (issue #502) and the per-job cost cap (issue #501): judged BEFORE every provider call by
	// the one guard both meter halves consult, the list first. Each part is built only when its policy is set, and
	// with neither there is no guard, so such a job runs exactly as before.
	// The parent's children hook (issue #500 part E, child-watch.mjs): folds the child ledgers into this meter, writes
	// SPENT and STOP, judges the stops on the job's whole spend, and detects pi processes that report through no ledger.
	// Built before the guard, whose `external` is every child's spend and in-flight bound as of the last fold. From here
	// on the exit line carries childTotal, childProcesses and unmeteredChildren, zeros with no children.
	childWatch = createChildWatch({ dir: childLedger.dir ?? null, meter, guard: () => policyGuard, log });
	const policyGuard = createPolicyGuard({ maxCostMicros: cfg.maxCostMicros, allowedModels: cfg.allowedModels, log, external: () => childWatch.external() });
	costRefusalWhy = () => policyGuard?.refusedWhy() ?? null;
	const usageMeter = await installProcessUsageMeter({ ModelRuntime, runtime: modelRuntime, meter, log, guard: policyGuard, children: childWatch });
	// The price table the meter pinned from this runtime, before any extension loads, handed to pi children (issue #587's
	// review): a child prices every capped call from it. A table that cannot be written leaves a child with none, which
	// refuses its capped calls.
	if (childLedger.dir && usageMeter.prices instanceof Map) {
		try {
			publishPriceTable({ dir: childLedger.dir, table: usageMeter.prices, env: process.env });
		} catch (error) {
			log("price_table_unavailable", { reason: error?.code ?? "write-failed" });
		}
	}
	if (usageMeter.ok) {
		meteredExitFields = () => {
			const usage = meter.usageSnapshot();
			// The guard's counters with the children's added (childWatch.guardFields): a child's partial count floors the job.
			return { tokens: { ...meter.snapshot(), ...(policyGuard ? childWatch.guardFields(policyGuard.snapshot()) : {}) }, ...(usage ? { usage } : {}) };
		};
		finishMeter = () => usageMeter.uninstall();
		meterStopAtExit = () => (meter.state.stopReason === null ? null : decideExit({ budgetAborted: false, meterStop: meter.state.stopReason }));
	}
	// A cost cap or a model list must be enforced BEFORE each call, so a runner that cannot do that refuses
	// here, after the install it depends on and before any extension loads, while nothing has been spent
	// (INT-RUNNER-EXIT-CODE-PROTOCOL): exit 2, `model-policy-unenforceable` or `cost-cap-unenforceable`. The
	// fallback bus meter below is the `ok: false` case, and it can only see a call after it was paid for. The cost
	// guard enforces the cap and the model guard the list; a job carrying neither policy passes untouched.
	assertPoliciesEnforceable({
		maxCostMicros: cfg.maxCostMicros,
		allowedModels: cfg.allowedModels,
		...policyEnforcement(usageMeter),
	});

	// Built only now, after the meter and the guards are installed (issue #543). Extension factories run in here,
	// and one that makes a model call while it loads is metered, and judged against the cost cap and the model
	// list, like any other call. A stop it causes ends the job before its prompt (below).
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
	// before the prompt anyway (after the extensions load, so a load-time call may already have spent), so flipping
	// report to refusal is a one-line change here plus a
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
				// The two DATA kinds a manifest contributes (issue #189, OQ-019 (b)): loaded with no
				// per-root visibility until now, and a package prompt template changes what a /name
				// dispatches even when it shadows nothing.
				promptPaths: resourceLoader.getPrompts().prompts.map((prompt) => prompt.filePath),
				themePaths: resourceLoader.getThemes().themes.map((theme) => theme.filePath),
			}),
		});
	}

	// pi-ai's own transient-error predicate, from the compat copy the meter accepted (issue #437): a 401/403
	// shape pi calls retryable (a gateway's "Provider returned error", an HTML "please retry" page) is not
	// a refusal of the credential. Without it every provider error stays retryable, so say so on the log.
	const isRetryable = await loadRetryPredicate({ module: usageMeter.ok ? usageMeter.module : null, candidates: resolvePiAiCompat() });
	if (!isRetryable) log("retry_predicate_unavailable", {});

	({ session } = await createAgentSession({
		cwd: WORKSPACE,
		agentDir,
		modelRuntime,
		model,
		settingsManager,
		sessionManager,
		resourceLoader,
		// The trigger's tool denylist (issue #291), enforced by pi structurally: the excluded names are
		// filtered out of the tool REGISTRY, not merely the active list, so neither an extension's
		// setActiveTools nor a later refresh can re-enable one. Spread conditionally so an unflagged
		// job's options object is byte-identical to today's -- at the pin `excludeTools: []` happens to
		// behave the same, but it stores an empty Set on the session, and a future pi may distinguish.
		...(cfg.excludeTools.length > 0 && { excludeTools: cfg.excludeTools }),
	}));

	// The in-container read-back (issue #291): what was asked for and what the session actually holds,
	// on every flagged job's log. Names only, from a set the loader validated -- no payload text, no
	// values -- so the line is PII-free by construction.
	if (cfg.excludeTools.length > 0) {
		log("tools_excluded", { excludeTools: cfg.excludeTools, active: session.getActiveToolNames() });
	}

	// Deterministic re-arm of the meter's COMPAT half. An extension that registered an api id in pi-ai's legacy
	// registry while it loaded or during createAgentSession left it unwrapped until now; the unref'd interval
	// inside the meter would eventually catch it, and this closes the window before the first prompt. (The
	// runtime half needs no re-arm: a provider an extension registers with pi.registerProvider is served by
	// the ModelRuntime, whose prototype is already wrapped.)
	usageMeter.arm();

	// The one packages count that cannot ride packages_loaded: a COMMAND exists only once the
	// ExtensionRunner has executed the factories, which is here, after createAgentSession -- the
	// loader knows extension paths, never what they registered. Names and roots only (operator-staged
	// config, the packages_loaded discipline); a staged package whose factory registered nothing still
	// reports [], which is how an operator learns their run.command has nothing to bind to before the
	// first job of it refuses command-unregistered.
	if (cfg.packages.length > 0) {
		const registered = session.extensionRunner.getRegisteredCommands();
		log("commands_registered", {
			packages: cfg.packages.map((root) => ({
				root,
				commands: registered
					.filter((command) => owningRoot(command.sourceInfo?.path, cfg.packages) === root)
					.map((command) => command.name)
					.sort(),
			})),
		});
	}

	// A command job dispatches before its prompt spends anything (a call an extension made while it loaded is already
	// metered and judged), so verify the command is actually registered first
	// (issue #189). pi's fallthrough is the hazard being closed: an unregistered "/name" is not an
	// error to session.prompt() -- it falls through to prompt-template expansion and then to the
	// MODEL as literal text, a full paid turn for a config typo, or (with a same-named template
	// staged) whatever that template does. Extensions have registered by createAgentSession time, so
	// getCommand() is authoritative here. commandName() is pi's own first-space parse, imported so
	// the verification reads the string exactly as dispatch will.
	if (cfg.command) {
		const name = commandName(cfg.command);
		if (!session.extensionRunner.getCommand(name)) {
			throw configError(
				`run.command names "${name}" but no loaded extension registers it -- stage the package that ships it, or fix the trigger`,
				"command-unregistered",
			);
		}
		// Only when the command will run: after a stop at load the prompt is not sent (below), so nothing dispatches.
		if (meter.state.stopReason === null) log("command_dispatch", { command: name });
	}

	// A throwing command handler is SWALLOWED by pi -- emitError, handled=true, prompt() resolves
	// cleanly -- and the extension runner's error channel is the only place it surfaces at the pin
	// (never the session event bus). Subscribe before prompt so decideExit can tell a failed command
	// from a completed one; scoped to command jobs because that is the only path whose success would
	// otherwise be decided by an event that cannot arrive.
	let commandFailed = false;
	const unsubscribeCommandErrors = cfg.command
		? session.extensionRunner.onError((extensionError) => {
				if (extensionError?.event === "command") commandFailed = true;
			})
		: null;

	// prompt() returns Promise<void>, so this subscription is the ONLY channel through which the
	// outcome arrives. captureTerminal handles both event shapes (agent_end carries messages[],
	// turn_end carries message).
	let terminal;
	// Whether one of pi's own auto-retries is under way: set by auto_retry_start, cleared by auto_retry_end.
	// classifyPromptRejection reads it, because a prompt() that rejects mid-retry is pi failing to resume
	// work already paid for, not a preflight fault (issue #509).
	let retryInFlight = false;
	const unsubscribeTerminal = session.subscribe((event) => {
		terminal = captureTerminal(terminal, event);
		if (event.type === "auto_retry_start") {
			retryInFlight = true;
			// pi retries internally. Surface it: our daily cap counts jobs, not provider calls.
			log("pi_auto_retry", { attempt: event.attempt, maxAttempts: event.maxAttempts });
		}
		if (event.type === "auto_retry_end") retryInFlight = false;
	});

	const budget = attachTurnBudget(session, cfg.maxTurns, {
		onAbort: (turns) => log("turn_budget_exceeded", { turns, maxTurns: cfg.maxTurns }),
	});
	liveExitFields = () => ({ turns: budget.state.turns, retryTurns: budget.state.retryTurns, session: { resumed: sessionResumed, reason: sessionReason } });

	// FALLBACK ONLY. The process-wide meter is the single source of truth whenever it installed, so
	// the per-session accumulator is attached only when it did NOT -- the two are never both counting
	// and a double count is impossible by construction rather than by arithmetic. Still an always-on
	// meter that aborts only when cfg.maxTokens is set (lagging backstop, OQ-010).
	const tokenBudget = usageMeter.ok ? null : attachTokenBudget(session, cfg.maxTokens, { onAbort: onTokenAbort });

	// A prompt() rejection is classified HERE only when it is pi's unresumable retry (classifyPromptRejection
	// says which, and why that must not be retried by the queue); every other rejection is rethrown untouched to
	// the catch at the bottom, the preflight path it has always taken. The finally runs either way.
	let rejected = null;
	try {
		// A stop that came before the prompt (a call an extension made while it loaded, or while the session was
		// built) found no session to abort, so it ends the job here instead: the prompt is never sent, and the exit
		// line names the stop (issue #543).
		if (meter.state.stopReason === null) await session.prompt(prompt);
	} catch (error) {
		rejected = classifyPromptRejection(error, { retryInFlight });
		if (!rejected) throw error;
	} finally {
		budget.unsubscribe();
		tokenBudget?.unsubscribe();
		// Stops the meter's re-arm interval. It is unref'd, so this is hygiene rather than a hang fix
		// -- but REQ-JOB-TIMEOUT-30M is a backstop, not a teardown plan, and a timer left running past
		// the session it was metering is exactly the kind of thing that becomes one.
		usageMeter.uninstall();
		unsubscribeTerminal();
		unsubscribeCommandErrors?.();
		// Captured ABOVE dispose() rather than read at the exit line, and the reason is smaller than it
		// first looks. At the 0.99.1 pin dispose() aborts the agent (and any retry, compaction, branch
		// summary or bash run), invalidates the extension ctx, drops the listeners and cancels the cache
		// warmer; it leaves the model and the session manager alone, so the reading DOES survive it (read
		// in agent-session.js at the pin; the 0.80.7 behaviour was measured inside the built image). What
		// remains is that reading state off an object which has been told it is finished is not a supported
		// thing anywhere upstream, and the ordering costs nothing. Defensive, then, not load-bearing, and the test pins the order
		// so a refactor cannot quietly invert it and find out when a pin bump does start clearing here.
		//
		// Three shapes come back and all three are honest answers. `undefined` when pi has no model or no
		// context window for it; an object whose `tokens` is null right after a compaction, before the
		// next assistant message re-establishes a count; or real numbers. Only the third is reported --
		// the host's bound is written to act on a measurement and invent nothing when there is none.
		contextUsage = session.getContextUsage();
		// Runs the cleanup callbacks providers register via registerSessionResourceCleanup. Every
		// official SDK example disposes; skipping it can leak a provider transport and hang the
		// container until the 30-minute timeout -- a completed job turned into a timeout failure.
		session.dispose();
	}

	const outcome = decideExit({
		budgetAborted: budget.state.aborted,
		budgetTurns: budget.state.turns,
		// Whichever meter was actually counting, and never both: the process-wide meter reports its first
		// stop by reason (token_budget, cost-cap, model-not-allowed), the fallback bus meter its token abort
		// by flag. A token stop maps to the same reason:"token_budget" / exit 2 from either.
		meterStop: usageMeter.ok ? meter.state.stopReason : null,
		tokenAborted: usageMeter.ok ? false : tokenBudget.state.aborted,
		terminal,
		// Null for every prompt job, so their decision tree is byte-identical to before run.command.
		command: cfg.command ? { failed: commandFailed } : null,
		isRetryable,
		rejected,
	});
	// `metered: true` on the process-wide snapshot is what tells the daily token counter that this
	// total includes every in-process session, not just the root's turns.
	// The cost fields (issue #501) ride only when a cap is set and `modelRefused` (issue #502) only when a list is,
	// so every other exit line stays byte-identical.
	const tokens = usageMeter.ok ? meteredExitFields().tokens : { ...pickTotals(tokenBudget.state), metered: false };
	// The per-(provider,model) ledger (issue #53, INT-RUN-HISTORY-FILE-CONTRACT) -- a SIBLING of
	// `tokens`, never a widening of it: `tokens` rides through the worker verbatim because it holds
	// nothing but numbers, while the ledger carries id STRINGS the host re-validates through its own
	// parser. Only the process-wide meter keeps a ledger (the per-session fallback cannot attribute a
	// call to a model), and a metered run with zero provider calls has no rows to report -- both come
	// back null, and the key is then OMITTED rather than emitted as null, so those exit lines stay
	// byte-identical to what every pre-ledger consumer already parses.
	const usage = usageMeter.ok ? (meteredExitFields().usage ?? null) : null;
	// `session` reports what pi ACTUALLY did, not what the host intended. The host records its own
	// intent separately, and the pair is what makes a degrade visible: a host that resolved a key while
	// the container reports resumed:false is a real event, and without both numbers it is indist-
	// inguishable from an ordinary cold start. A feature that fails open must still say that it did.
	// How full the context was when this run ended, which is what the NEXT run on this key would resume
	// into. A SIBLING of `tokens` rather than a widening of it, for the reason the ledger is one: `tokens`
	// is a per-run BILLING snapshot with two possible producers, and occupancy is neither billing nor
	// per-run. Omitted entirely rather than emitted as null when there is no measurement, exactly as
	// `usage` is, so an exit line with nothing to say stays byte-identical to what every existing consumer
	// already parses -- and the host gate reads that absence as "no measurement" rather than as zero.
	const context = Number.isFinite(contextUsage?.tokens) && Number.isFinite(contextUsage?.contextWindow) && contextUsage.contextWindow > 0 ? { tokens: contextUsage.tokens, window: contextUsage.contextWindow } : null;
	// Issue #505: a read-only look at /outbox/priorities.json, logged as enum tokens so the job's log says what the host
	// is likely to make of the plan. Its result is DISCARDED and it never throws: the host decides after exit, and nothing
	// a plan file holds may change this exit code or this exit line.
	try {
		precheckAtExit({ log });
	} catch {}
	// capExitMessage: a provider's error body is unbounded, and the worker reads this line from a bounded
	// tail, so an uncapped message can push `code` and `reason` out of what the host ever sees.
	exitWriter.writeExit({ ...capExitMessage(outcome), ...costRefusalField(outcome, costRefusalWhy()), turns: budget.state.turns, retryTurns: budget.state.retryTurns, tokens, ...(usage ? { usage } : {}), ...(context ? { context } : {}), session: { resumed: sessionResumed, reason: sessionReason } });
	return outcome.code;
}

// The job runner's block: everything this file does at module level, apart from the nested check at the top, and none
// of it for a nested runner.
if (!nestedRunner) {
	// The exit line's key (issue #545), read FIRST, before main and so before any extension loads or any tool can run:
	// the worker wrote it to stdin and closed it, and draining the pipe here is what leaves nothing in it for a tool to
	// read later. Read whatever happens next, so the catch path's line is signed too. No PI_EXIT_AUTH, no read.
	exitKey = readExitKey(process.env);
	// And at once out of this process's environment (issue #500): every descendant inherits it, and any child that reads
	// it as this runner does would drain a stdin that is not its own, or wait on one no one writes.
	// env-internal PI_EXIT_AUTH: written by the worker into the job's closed env map, removed here once read.
	delete process.env.PI_EXIT_AUTH;
	exitWriter = createExitWriter({
		key: exitKey.key,
		// env-internal PI_JOB_ID: set by the worker on the container, so the exit line can name its job.
		jobId: process.env.PI_JOB_ID,
		// Synchronously, every byte, to fd 1 (writeAllSync): the SIGTERM path exits the moment the line is written.
		write: (line) => writeAllSync(1, line),
		exit: (code) => process.exit(code),
	});
	// SIGTERM is the worker's stop (the job timeout, an operator's cancel, a shutdown): `docker stop` delivers it to the
	// init process, which forwards it here. Without a handler node died at once and no genuine exit line followed, so a
	// line a tool wrote earlier was the last one in the log. Now the real line is written, with what the meter counted,
	// and the runner exits 143 well inside the stop's grace period. A line already written is not written again.
	process.on("SIGTERM", () => {
		try {
			finishMeter();
		} catch {
			// The line is written whatever the teardown did.
		}
		exitWriter.terminate({ ...liveExitFields(), ...meteredExitFields() });
	});

	// Preflight throws; the agent loop swallows. Both paths are real and cover disjoint failure sets
	// -- see INT-RUNNER-EXIT-CODE-PROTOCOL. Without this catch, a missing API key is an unhandled
	// rejection exiting Node's default 1, which the protocol defines as RETRYABLE, so the queue would
	// pay to retry a job that can never succeed.
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			// The meter's fields ride here too once it installed (issue #543); before that there is nothing to report.
			const thrown = classifyThrow(error);
			// The final fold first, so a stop it makes ranks this exit and its counts are on the line.
			try {
				finishMeter();
			} catch {
				// The line is written whatever the teardown did.
			}
			const stopped = meterStopAtExit();
			// The stop wins the exit reason, and the throw it outranked is named on its own line so the second cause is not
			// lost: its classified reason and the error's class, never its message (names only).
			if (stopped !== null) log("throw_after_stop", { reason: thrown.reason, error: typeof error?.name === "string" ? error.name : null });
			const outcome = stopped ?? thrown;
			const capped = capExitMessage(outcome);
			exitWriter.writeExit({ code: capped.code, reason: capped.reason, ...costRefusalField(outcome, costRefusalWhy()), message: capped.message, ...meteredExitFields() });
			process.exitCode = outcome.code ?? EXIT_INFRA;
		});
}
