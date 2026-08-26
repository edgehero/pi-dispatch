import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { captureTerminal, decideExit, EXIT_COMPLETED, EXIT_INFRA, EXIT_POLICY } from "../src/outcome.mjs";

// The wiring in run-job.mjs used to be untested -- the composition of budget + terminal capture +
// classification is exactly where this project's documented traps live. These test the two pure
// pieces that composition rests on.

test("captureTerminal reads agent_end.messages.at(-1) -- agent_end has no `message` field", () => {
	// Verified against agent-session.d.ts@0.80.7: agent_end carries messages[], not message.
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
	// run-job.mjs's `log("exit", { ...outcome, turns: budget.state.turns })` spread. decideExit's
	// non-abort branch returns classifyStopReason, which has no `turns` field (only the budget-abort
	// branch carries one -- see "a blown budget wins" above). So if that spread ever dropped `turns`,
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
	// matches a `log("exit", { ... turns: ... })` call whose object literal carries a `turns:` key
	// before its closing brace: specific enough that dropping `turns` from the success spread fails
	// it, tolerant of whitespace and property reordering.
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	assert.match(
		src,
		/log\("exit",\s*\{[^}]*turns:/,
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
		/log\("exit",[^\n]*\bcontext\b/,
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
		/log\("exit",\s*\{[^}]*\busage\b/,
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
	// (3) the check sits before openSessionManager -- the pre-spend moment, so flipping report to
	//     refusal (DES-FLOW-RESOLUTION-TWO-ADVISORY-LAYERS) stays a one-line change at this site.
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	assert.ok(
		src.indexOf("resourceLoader.getSkills()") < src.indexOf("if (cfg.packages.length"),
		"getSkills() must be read before (outside) the packages guard",
	);
	assert.match(src, /log\("flow_not_loaded",\s*\{[^}]*flow:/, "the miss must leave a named line carrying the flow");
	assert.ok(
		src.indexOf('log("flow_not_loaded"') < src.indexOf("openSessionManager("),
		"the flow check must sit at the pre-spend moment",
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
