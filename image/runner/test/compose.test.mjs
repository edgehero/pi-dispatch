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
