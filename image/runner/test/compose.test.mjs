import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { captureTerminal, decideExit, EXIT_COMPLETED, EXIT_INFRA, EXIT_POLICY } from "../src/outcome.mjs";

// The wiring in run-job.mjs used to be untested -- the composition of budget + terminal capture +
// classification is exactly where this project's documented traps live. These test the two pure
// pieces that composition rests on.

test("captureTerminal reads agent_end.messages.at(-1) -- agent_end has no `message` field", () => {
	// Verified against agent-session.d.ts@0.99.1 (as @0.80.7): agent_end carries messages[] and willRetry, not message.
	const assistant = { role: "assistant", stopReason: "stop" };
	const terminal = captureTerminal(undefined, { type: "agent_end", messages: [{ role: "user" }, assistant] });
	assert.equal(terminal, assistant);
});

test("captureTerminal reads turn_end.message", () => {
	const msg = { role: "assistant", stopReason: "toolUse" };
	assert.equal(captureTerminal(undefined, { type: "turn_end", message: msg }), msg);
});

test("captureTerminal ignores unrelated events and preserves the prior value", () => {
	const prior = { role: "assistant", stopReason: "stop" };
	assert.equal(captureTerminal(prior, { type: "message_update", message: {} }), prior);
	assert.equal(captureTerminal(prior, { type: "auto_retry_start" }), prior);
});

test("decideExit: a blown budget wins over stopReason, always", () => {
	// Even if the terminal message says "stop" (success), an abort we triggered is exit 2. Checking
	// budget FIRST means a future change to how abort surfaces as a stopReason cannot turn a blown
	// budget into a silent success.
	const outcome = decideExit({ budgetAborted: true, budgetTurns: 41, terminal: { stopReason: "stop" } });
	assert.equal(outcome.code, EXIT_POLICY);
	assert.equal(outcome.reason, "turn_budget");
	assert.equal(outcome.turns, 41);
});

test("decideExit: without an abort, the stopReason decides", () => {
	assert.equal(decideExit({ budgetAborted: false, terminal: { stopReason: "stop" } }).code, EXIT_COMPLETED);
	assert.equal(decideExit({ budgetAborted: false, terminal: { stopReason: "error" } }).code, EXIT_INFRA);
});

test("decideExit: no terminal message and no abort is infra, not success", () => {
	// Absence of evidence that the agent ran is not success.
	assert.equal(decideExit({ budgetAborted: false, terminal: undefined }).code, EXIT_INFRA);
});

test("decideExit's non-abort branch carries NO turns of its own -- the premise the source-guard rests on", () => {
	// WHY the guard below exists: on the success path, `turns` reaches the exit log SOLELY from
	// run-job.mjs's `exitWriter.writeExit({ ...capExitMessage(outcome), turns: budget.state.turns, ... })`.
	// decideExit's non-abort branch returns classifyStopReason, which has no `turns` field (only the
	// budget-abort branch carries one -- see "a blown budget wins" above). So if that line ever dropped `turns`,
	// nothing in outcome.mjs would put it back, and the worker's parseExitTurns (which requires a
	// numeric `turns` on the exit line) would silently read null on every completed run.
	const outcome = decideExit({ budgetAborted: false, terminal: { stopReason: "stop" } });
	assert.equal(outcome.code, EXIT_COMPLETED);
	assert.equal(outcome.turns, undefined, "the non-abort branch of decideExit carries no turns of its own");
});

test("run-job.mjs staples `turns` onto the success-path exit line -- worker parseExitTurns depends on it", () => {
	// A stdout-capture test would EXECUTE the runner (main() self-runs on import and `log` is
	// unexported), so this guards the worker<->runner contract against the source instead -- the same
	// tactic worker/test/wiring.test.mjs uses for wiring it cannot exercise at runtime. The regex
	// matches an `exitWriter.writeExit({ ... turns: ... })` call (issue #545: every exit line goes through the one writer) whose object literal carries a `turns:` key
	// before its closing brace: specific enough that dropping `turns` from the success spread fails
	// it, tolerant of whitespace and property reordering.
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	assert.match(
		src,
		/exitWriter\.writeExit\(\s*\{[^}]*turns:/,
		"run-job.mjs exit line must carry turns -- worker parseExitTurns depends on it",
	);
	// The catch-path exit line (classifyThrow, a preflight throw) legitimately OMITS turns: no budget
	// exists when the agent loop never started. The regex above matches the success call and does not
	// require every exit line to carry turns, so that omission is allowed by design.
});

test("run-job.mjs staples `context` onto the success-path exit line -- worker parseExitContext depends on it", () => {
	// Same tactic and same reason as the two guards below. Like `usage`, the key is CONDITIONAL: a run pi
	// could give no context window for, and a compaction that left its own count unknown, both OMIT it
	// rather than emit null, because the host's bound reads absence as "no measurement" and a null that
	// arrived as a zero would be a denominator nobody computed.
	// The `[^}]*` the two guards below use cannot reach this key: it sits after `...(usage ? { usage } :
	// {})`, whose braces close the character class early. The call is one line, so the line is the bound.
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	assert.match(
		src,
		/exitWriter\.writeExit\([^\n]*\bcontext\b/,
		"run-job.mjs success exit line must carry the context reading -- worker parseExitContext depends on it",
	);
	// ...and it must come from pi's own accounting rather than a hand-rolled estimate. There is no
	// bytes-to-tokens calibration anywhere in this project, which is exactly why the host does not compute
	// this itself.
	assert.match(src, /getContextUsage\(\)/, "the reading must be pi's own ContextUsage, not an estimate");
	// The ORDER is the part a refactor breaks silently: getContextUsage() walks the session's branch, so a
	// disposed session has nothing to walk and the reading would come back undefined on every run, which
	// the host cannot tell apart from an old runner. Pin that the capture precedes dispose().
	// Anchored on the ASSIGNMENT rather than the call: `getContextUsage()` also appears in the comment
	// above it, and an indexOf on the bare call would keep finding that comment however far the real line
	// moved. The ordering is DEFENSIVE rather than load-bearing -- at the pin the reading survives
	// dispose(), measured in the image -- so this pins an order a refactor should not silently invert,
	// not a bug that exists today.
	assert.ok(
		src.indexOf("contextUsage = session.getContextUsage()") < src.indexOf("session.dispose()"),
		"the context reading must be captured before session.dispose(), so no pin bump that starts clearing session state there can turn this into a silent no-measurement",
	);
	// And the key must be spread CONDITIONALLY. Emitting it as an explicit null would parse to the same
	// "no measurement" host-side, so no behaviour test can tell the two apart -- but it would change every
	// exit line that has nothing to report, which is the property the `usage` key was given for the same
	// reason and which existing consumers are pinned against.
	assert.match(src, /\.\.\.\(context \?/, "the context key must be omitted when absent, not emitted as null");
});

test("run-job.mjs staples `usage` onto the success-path exit line -- worker parseExitUsage depends on it", () => {
	// Same tactic and same reason as the `turns` guard above: main() self-runs on import and `log` is
	// unexported, so the worker<->runner contract is guarded against the source. The ledger key is
	// CONDITIONAL by design -- a fallback-metered run and a metered run with zero provider calls both
	// OMIT it rather than emit null -- so the regex targets the guard expression inside the exit
	// object literal. \busage\b is what keeps `usageMeter` (the install handle, also in scope there)
	// from satisfying the match with the ledger long gone.
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	assert.match(
		src,
		/exitWriter\.writeExit\(\s*\{[^}]*\busage\b/,
		"run-job.mjs success exit line must carry the usage ledger -- worker parseExitUsage depends on it",
	);
	// ...and the value must come from the meter's ledger emitter, the only producer of the bounded,
	// sum-preserving shape the worker's validating parser accepts.
	assert.match(
		src,
		/usageSnapshot\(\)/,
		"the exit line's usage must be meter.usageSnapshot()'s ledger, not a hand-rolled object",
	);
	// The catch-path exit line legitimately omits `usage` for the same reason it omits turns: no meter
	// exists when a preflight throw kills the run before any session started.
});

test("run-job.mjs verifies the flow against the LOADED skill set, unconditionally and pre-spend", () => {
	// Same source-guard tactic as the turns/usage pins above (main() self-runs on import, log is
	// unexported). Three orderings pinned, each of which failed silently before issue #189:
	// (1) getSkills() sits OUTSIDE the packages guard -- inside it, the flow check would only run for
	//     jobs with staged packages, which is exactly the blindness being closed;
	// (2) the flow_not_loaded line exists and carries the flow -- a flow that resolves in no tier
	//     must leave a named, greppable trace, so "a silent exit 0 for this case" is a failing test;
	// (3) the check sits before createAgentSession -- before the prompt, so flipping report to
	//     refusal (DES-FLOW-RESOLUTION-TWO-ADVISORY-LAYERS) stays a one-line change at this site. (It read
	//     openSessionManager until issue #543 moved the session manager and the meter above the loader.)
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	assert.ok(
		src.indexOf("resourceLoader.getSkills()") < src.indexOf("if (cfg.packages.length"),
		"getSkills() must be read before (outside) the packages guard",
	);
	assert.match(src, /log\("flow_not_loaded",\s*\{[^}]*flow:/, "the miss must leave a named line carrying the flow");
	assert.ok(
		src.indexOf('log("flow_not_loaded"') < src.indexOf("await createAgentSession("),
		"the flow check must sit before the prompt",
	);
});

test("run-job.mjs wires the command path: env-authoritative prompt, pre-spend verification, observed throws", () => {
	// Same source-guard tactic as the pins above. Five facts, each of which fails silently if unwired:
	// (1) the prompt is rebuilt from PI_COMMAND, never read from prompt.md, for a command job -- one
	//     in-container authority, and pi's grammar demands the whole text start with "/";
	// (2) the command is verified against extensionRunner.getCommand BEFORE session.prompt -- an
	//     unregistered "/name" is not an error to pi, it falls through toward a paid model call;
	// (3) the verification failure is the tagged command-unregistered refusal (exit 2, pre-spend);
	// (4) a swallowed handler throw is observed via extensionRunner.onError before the prompt;
	// (5) decideExit receives the command outcome, null for every prompt job.
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	assert.match(src, /cfg\.command \? `\/\$\{cfg\.command\}` : readPrompt\(/, "the prompt must be env-authoritative for command jobs");
	assert.ok(
		src.indexOf("extensionRunner.getCommand") < src.indexOf("await session.prompt("),
		"getCommand verification must run before the prompt is sent",
	);
	assert.match(src, /"command-unregistered"/, "the refusal must carry its own greppable reason");
	assert.ok(
		src.indexOf("extensionRunner.onError") < src.indexOf("await session.prompt("),
		"the error-channel subscription must exist before the prompt, or a fast throw is missed",
	);
	assert.match(src, /command: cfg\.command \? \{ failed: commandFailed \} : null/, "decideExit must receive the command outcome");
	assert.match(src, /log\("command_dispatch", \{ command: name \}\)/, "the dispatch line carries the NAME only, never args");
});

test("run-job.mjs counts all four package resource kinds, and commands after the session exists", () => {
	// Same source-guard tactic as above. Two facts: (1) packages_loaded feeds prompt and theme paths
	// into countPackageResources -- the two DATA kinds loaded with no per-root visibility before
	// issue #189 (OQ-019 (b)); (2) commands_registered fires AFTER createAgentSession, because a
	// command exists only once the ExtensionRunner has executed the factories -- the loader knows
	// extension paths, never what they registered.
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	assert.match(src, /promptPaths: resourceLoader\.getPrompts\(\)/, "packages_loaded must count package prompts");
	assert.match(src, /themePaths: resourceLoader\.getThemes\(\)/, "packages_loaded must count package themes");
	assert.ok(
		src.indexOf("createAgentSession") < src.indexOf('log("commands_registered"'),
		"commands are countable only post-session",
	);
	assert.match(src, /getRegisteredCommands\(\)/, "the count must come from the runner's registry, not the manifest");
});

test("run-job wires run.excludeTools: membership pre-spend, a conditional spread, and the read-back log", () => {
	// Issue #291, the run.command block's tactic: run-job self-runs on import, so the wiring is pinned
	// against the source. Five facts, each a mutation this catches: the membership assert exists, sits
	// before any session machinery (pre-spend), the option rides a CONDITIONAL spread (an unflagged
	// job's options object stays byte-identical), and every flagged job logs what the session actually
	// holds, read back via getActiveToolNames.
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	assert.match(src, /assertExcludeToolsKnown\(cfg\.excludeTools\)/, "the membership assert is gone -- an unknown exclusion would be silently ignored in-container");
	assert.ok(
		src.indexOf("assertExcludeToolsKnown(") < src.indexOf("openSessionManager("),
		"the membership assert must run pre-spend, before any session machinery",
	);
	assert.ok(
		// The CALL, not the bare name: readPrompt is imported by name, and the import line would win indexOf.
		src.indexOf("assertExcludeToolsKnown(") < src.indexOf("readPrompt(PROMPT_PATH)"),
		"and before the job inputs are even read, beside the mount asserts",
	);
	assert.match(src, /\.\.\.\(cfg\.excludeTools\.length > 0 && \{ excludeTools: cfg\.excludeTools \}\)/, "the option must ride a conditional spread -- unconditional would hand pi an empty-but-present denylist");
	assert.match(src, /log\("tools_excluded", \{ excludeTools: cfg\.excludeTools, active: session\.getActiveToolNames\(\) \}\)/, "the read-back log line is gone -- the exclusion would be unobservable in the job log");
	assert.ok(
		src.indexOf("createAgentSession(") < src.indexOf('log("tools_excluded"'),
		"the read-back can only be logged post-session",
	);
});

test("run-job checks /job for every job and logs the mount advisories before any credential work (issue #341)", () => {
	// Source-guard tactic again, three facts: (1) the /job access check runs beside the mount asserts, BEFORE the
	// prompt ternary, so a command job (which never reads prompt.md) is covered; (2) the advisories are logged
	// before getAgentDir/AuthStorage, because pi swallows the auth-lock failure and the line is the only record;
	// (3) they are logged, never thrown, so nothing that runs today gains an exit.
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	assert.match(src, /assertJobInputsReadable\(\[JOB_DIR, GLOBAL_PI_DIR, WORKSPACE\]\);/, "the job inputs, the operator overlay and the workspace");
	assert.ok(src.indexOf("assertSessionMountReady(cfg.sessionFile)") < src.indexOf("assertJobInputsReadable([JOB_DIR"));
	assert.ok(
		src.indexOf("assertJobInputsReadable([JOB_DIR") < src.indexOf("const prompt = cfg.command"),
		"the check must precede the command/prompt split, or command jobs skip it",
	);
	assert.match(src, /for \(const \[event, fields\] of mountAdvisories\(\)\) log\(event, fields\);/);
	assert.ok(src.indexOf("mountAdvisories()") < src.indexOf("getAgentDir()"), "advisories must be logged before pi touches HOME");
	const between = src.slice(src.indexOf("mountAdvisories()"), src.indexOf("getAgentDir()"));
	assert.doesNotMatch(between, /\bthrow\b|configError\(|process\.exit/, "an advisory must never become an exit: nothing between the advisories and getAgentDir may throw or exit");
	assert.doesNotMatch(src, /function readPrompt/, "readPrompt lives in src/config.mjs, where its EACCES split is tested");
});

test("run-job installs the meter and the guards before any extension loads, and a stop before the prompt sends no prompt (issue #543)", () => {
	// Source-guard tactic again; usage-meter.integration.test.mjs drives this order with the real loader. An extension
	// factory runs inside buildLoadedResourceLoader, so a call it makes while it loads is metered and judged only when
	// the install comes first. The policy check stays after the install it reads and before anything loads.
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	const runtime = src.indexOf("await createJobModelRuntime({");
	const sessionManager = src.indexOf("openSessionManager({");
	const meter = src.indexOf("const meter = createUsageMeter({");
	const install = src.indexOf("await installProcessUsageMeter(");
	const check = src.indexOf("assertPoliciesEnforceable({");
	const loader = src.indexOf("await buildLoadedResourceLoader({");
	assert.ok(runtime > 0 && sessionManager > runtime && meter > sessionManager && install > meter && check > install && loader > check, "the runtime, the root session id, the meter, the install, the policy check, then the loader");
	assert.equal(src.split("buildLoadedResourceLoader(").length, 2, "one loader, built once");
	// A stop that came before the prompt had no session to abort, so the prompt is not sent.
	assert.match(src, /\n\t\tif \(meter\.state\.stopReason === null\) await session\.prompt\(prompt\);\n/, "a stop before the prompt must keep the prompt from being sent");
	// And nothing says the command dispatched when the prompt is not sent.
	assert.match(src, /\n\t\tif \(meter\.state\.stopReason === null\) log\("command_dispatch", \{ command: name \}\);\n/, "command_dispatch only when the command will run");
	// Every exit line after the install carries the meter's tokens and usage, the outer catch's too: a load-time call
	// that spent before a later refusal (command-unregistered) must reach the settlement.
	const armed = src.indexOf("\t\tmeteredExitFields = () => {");
	assert.ok(armed > install && armed < loader, "the exit fields are armed right after the install, before any extension loads");
	assert.match(src, /exitWriter\.writeExit\(\{ code: capped\.code, reason: capped\.reason, message: capped\.message, \.\.\.meteredExitFields\(\) \}\);/, "the outer catch's exit line carries the meter's fields");
	assert.match(src, /const tokens = usageMeter\.ok \? meteredExitFields\(\)\.tokens :/, "the success line reads the same fields");
	// `usage` rides only when a call was observed: a run with none keeps the key absent, never `usage: null`.
	assert.match(src, /\{ tokens: \{ \.\.\.meter\.snapshot\(\), \.\.\.\(policyGuard \? policyGuard\.snapshot\(\) : \{\}\) \}, \.\.\.\(usage \? \{ usage \} : \{\}\) \}/, "usage is omitted when no call was observed");
	// A throw after a stop (a refused load-time call, then command-unregistered) exits with the stop, as decideExit ranks it.
	assert.match(src, /meterStopAtExit = \(\) => \(meter\.state\.stopReason === null \? null : decideExit\(\{ budgetAborted: false, meterStop: meter\.state\.stopReason \}\)\);/, "the stop is decided by decideExit");
	assert.match(src, /const thrown = classifyThrow\(error\);\n\t\tconst stopped = meterStopAtExit\(\);/, "the throw is classified and the stop read");
	assert.match(src, /const outcome = stopped \?\? thrown;/, "the stop wins the catch path's exit reason");
	// The outranked throw keeps a trace: its classified reason and its class, never its message.
	assert.match(src, /if \(stopped !== null\) log\("throw_after_stop", \{ reason: thrown\.reason, error: typeof error\?\.name === "string" \? error\.name : null \}\);/, "the second cause is logged, names only");
	assert.ok(src.indexOf("\t\tmeterStopAtExit = () =>") > install && src.indexOf("\t\tmeterStopAtExit = () =>") < loader, "armed with the exit fields, before any extension loads");
});

test("run-job refuses an unenforceable cost cap or model list after the meter installs and before the session exists (issues #501, #502)", () => {
	// Source-guard tactic again. The order is the whole point: the check reads the install's verdict (meter ok,
	// brake, guard), so it must follow installProcessUsageMeter; and it must precede createAgentSession, because
	// a session can spend on its own (an extension factory's call, a cache warm) before the first prompt.
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	const install = src.indexOf("await installProcessUsageMeter(");
	const check = src.indexOf("assertPoliciesEnforceable({");
	const session = src.indexOf("await createAgentSession(");
	assert.ok(install > 0 && check > install && session > check, "install, then the policy check, then the session");
	// The verdict comes from policyEnforcement, whose ok:false and brake rules usage-meter.test.mjs drives.
	assert.match(src, /assertPoliciesEnforceable\(\{\s*maxCostMicros: cfg\.maxCostMicros,\s*allowedModels: cfg\.allowedModels,\s*\.\.\.policyEnforcement\(usageMeter\),\s*\}\);/, "the fallback bus meter (ok:false) can only see a call after it was paid for");
	// Issue #501, PR 3 (PR #533's review): the stop handler is the tested one, so a cost stop cannot log token_budget_exceeded.
	assert.match(src, /onStop: meterStopHandler\(\{ onTokenAbort, abort: \(\) => void session\?\.abort\(\) \}\),/, "the meter's stop goes through meterStopHandler");
	assert.doesNotMatch(src, /reason === TOKEN_BUDGET/, "no second, untested copy of the token-only rule");
	// The policy guard (issues #501, #502): built from both policies (null when neither is set, its order and its
	// snapshot driven in model-guard.test.mjs), handed to the install, and its fields spread only when it exists.
	assert.match(src, /const policyGuard = createPolicyGuard\(\{ maxCostMicros: cfg\.maxCostMicros, allowedModels: cfg\.allowedModels, log \}\);/);
	assert.ok(src.indexOf("const policyGuard =") < install, "the guard exists before the install that hands it to both halves");
	assert.match(src, /installProcessUsageMeter\(\{ ModelRuntime, runtime: modelRuntime, meter, log, guard: policyGuard \}\)/);
	assert.match(src, /\{ \.\.\.meter\.snapshot\(\), \.\.\.\(policyGuard \? policyGuard\.snapshot\(\) : \{\}\) \}/, "the policy fields ride the exit line only when a policy is set");
	assert.doesNotMatch(src, /createCostGuard|createModelGuard/, "no guard built beside the policy guard, which fixes their order");
	assert.match(src, /maxCostMicros: cfg\.maxCostMicros,\s*allowedModels: cfg\.allowedModels,\s*rootSessionId/, "the meter carries both policies, so the brake is armed for them");
	assert.match(src, /meterStop: usageMeter\.ok \? meter\.state\.stopReason : null,/, "the exit decision reads the meter's stop by reason");
	assert.match(src, /tokenAborted: usageMeter\.ok \? false : tokenBudget\.state\.aborted,/, "the flag is the fallback meter's alone");
});

test("run-job takes PI_EXIT_AUTH out of its environment right after reading the key, and opens the child ledger before the meter and before any extension (issue #500)", () => {
	// Source-guard tactic. PI_EXIT_AUTH: every descendant inherits the runner's environment, and a nested copy of the
	// runner (the stock subagent example spawns one) that saw it would drain a stdin that is not its own. The ledger:
	// a child can be spawned from the first extension factory on, and the three variables must be in place by then.
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	assert.match(src, /\nconst exitKey = readExitKey\(process\.env\);\n(?:\/\/[^\n]*\n)*delete process\.env\.PI_EXIT_AUTH;\n/, "the delete is the next statement after the key read");
	const ledger = src.indexOf("openChildLedger({ env: process.env, pid: process.pid, preloadPath: fileURLToPath(new URL(\"./src/child-preload.cjs\", import.meta.url)) })");
	assert.ok(ledger > 0, "the ledger is opened on the runner's own environment, with the preload beside it");
	assert.ok(ledger < src.indexOf("await installProcessUsageMeter("), "before the meter installs");
	assert.ok(ledger < src.indexOf("await buildLoadedResourceLoader("), "before any extension loads");
	assert.ok(ledger < src.indexOf("await createAgentSession("), "before the session exists");
	assert.match(src, /if \(childLedger\.error !== undefined\) log\("child_ledger_unavailable", \{ reason: childLedger\.error \}\);/, "a ledger that could not be opened is said, by code");
});
