import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { costRefusalOf, parseExitCostRefusal, parseExitTokens, TOKEN_KEYS } from "../../../worker/src/run-history.mjs";
import { LIMIT_WARNINGS, TIME_LIMIT, TURN_LIMIT } from "../src/cost-warning.mjs";
import { chatServer, jobTree, put, runRealJob } from "./helpers/real-job.mjs";

/**
 * Issue #985, end to end: the real run-job.mjs with the real pi (helpers/real-job.mjs) under a cost cap, on a priced
 * model served locally. The first answer runs a tool and reports a usage that spends past 70% of the cap; what follows is
 * the warning in the next request, and the exit line's charge keys, which the worker's own parsers read back. A second
 * run's next call does not fit, and its exit line carries the refusal's numbers.
 *
 * Gated like loader.test.mjs: a skip is NOT a pass, and CI sets PI_DISPATCH_REQUIRE_LOADER_TESTS=1.
 */
let pi;
let importError;
try {
	pi = await import("@earendil-works/pi-coding-agent");
} catch (error) {
	importError = error;
}
if (!pi && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw new Error(`the cost warning end to end is REQUIRED here but pi could not be imported.\n${importError}`);
const skip = pi ? false : `pi not installed (node ${process.version}); CI runs these`;

// The model costs $1 a million tokens either way, so a token is a micro-dollar: 290,000 prompt tokens and 3 completion
// tokens cost 290,003 micro-dollars, and a call's bound is its request's bytes plus 8192, plus its 1000 output tokens.
const SPEND = 290_000;
const replies = [{ toolCall: { name: "ls", arguments: { path: "." } }, promptTokens: SPEND }, { content: "done" }];
const userTexts = (body) => (body?.messages ?? []).filter((message) => message.role === "user").map((message) => (typeof message.content === "string" ? message.content : message.content.map((part) => part.text ?? "").join("")));

test("a capped job past 70% of its cap after a tool turn reads the warning in its next request, once, and its exit line says what the cap charged", { skip }, async () => {
	const server = await chatServer({ replies });
	try {
		const root = jobTree({ base: server.base, cost: 1 });
		const cap = 400_000;
		const { code, exit, lines, stderr } = await runRealJob(root, { PI_MAX_COST_MICROS: String(cap) });
		assert.equal(code, 0, `${JSON.stringify(exit)}\n${stderr}`);
		assert.equal(server.calls(), 2, "the warning rides the next call, which pi makes anyway after a tool turn: no call of its own");
		const [first, second] = server.bodies();
		assert.equal(userTexts(first).some((text) => text === LIMIT_WARNINGS["cost-cap"]), false, "not before the spend");
		assert.deepEqual(userTexts(second).filter((text) => text === LIMIT_WARNINGS["cost-cap"]).length, 1, "after the tool turn that crossed 70%, as user text");
		assert.equal(second.messages.at(-1).role, "user", "after the tool's result, before the model answers");
		assert.deepEqual(lines.filter((line) => line.event === "cost_warning").map(({ event, jobId, ...fields }) => fields), [{ limit: "cost-cap", settled: SPEND + 3, threshold: 280_000, cap }]);
		// What the cap charged: both calls at pi's price (13 micro-dollars for the second), nothing lifted, nobody waited.
		const t = exit.tokens;
		assert.deepEqual([t.costChargedMicros, t.costLiftedMicros, t.costWaited, t.costWarned], [SPEND + 3 + 13, 0, 0, 1]);
		assert.equal(Math.ceil(t.cost * 1e6), t.costChargedMicros - t.costLiftedMicros, "the charge less the lift is what pi priced");
		// After the cap's own keys, in the worker's order, and read back byte for byte by the worker's parser.
		// Then issue #1055's `turnsWarned` (every run watches its turn limit; this one's 3 turns warn at 3, and it ran 2).
		assert.deepEqual(Object.keys(t).slice(-5), ["costChargedMicros", "costLiftedMicros", "costWaited", "costWarned", "turnsWarned"]);
		assert.equal(t.turnsWarned, 0);
		assert.deepEqual(TOKEN_KEYS.slice(-6, -1), Object.keys(t).slice(-5));
		const line = `${JSON.stringify(exit)}\n`;
		assert.equal(JSON.stringify(parseExitTokens(line)), JSON.stringify(t));
		assert.equal(Object.hasOwn(exit, "costRefusal"), false, "no refusal, no numbers");
		assert.equal(Object.hasOwn(exit, "why"), false);
	} finally {
		await server.close();
	}
});

test("a capped job whose next call cannot fit stops cost-cap with the refusal's numbers beside its why, which the worker reads back", { skip }, async () => {
	const server = await chatServer({ replies });
	try {
		const root = jobTree({ base: server.base, cost: 1 });
		const cap = 300_000;
		const { code, exit, lines, stderr } = await runRealJob(root, { PI_MAX_COST_MICROS: String(cap) });
		assert.equal(code, 2, `${JSON.stringify(exit)}\n${stderr}`);
		assert.deepEqual([exit.reason, exit.why], ["cost-cap", "over-cap"]);
		assert.equal(server.calls(), 1, "the refused call was never sent");
		const refused = lines.find((line) => line.event === "cost_refused");
		// The numbers the log line judged, now on the exit line: spent + in flight + outside + bound past the cap.
		assert.deepEqual(exit.costRefusal, { spentMicros: SPEND + 3, inflightMicros: 0, externalMicros: 0, boundMicros: refused.bound });
		assert.ok(SPEND + 3 + refused.bound > cap, "over the cap");
		const keys = Object.keys(exit);
		assert.equal(keys[keys.indexOf("why") + 1], "costRefusal", "right beside `why`");
		assert.deepEqual(parseExitCostRefusal(`${JSON.stringify(exit)}\n`), costRefusalOf(exit.costRefusal));
		assert.deepEqual([exit.tokens.costChargedMicros, exit.tokens.costLiftedMicros, exit.tokens.costWaited, exit.tokens.costWarned], [SPEND + 3, 0, 0, 1], "warned after the tool turn, before the refused call");
		assert.equal(lines.some((line) => line.event === "cost_warning"), true);
	} finally {
		await server.close();
	}
});

/**
 * An OpenAI-compatible endpoint whose answer to each request `answer(body, rootCalls)` decides: `{ toolCall }` or
 * `{ content }`, the `promptTokens` it reports, and an optional `delayMs` before it answers. A request carrying SIDECALL
 * is an extension's own call, not the root's.
 */
async function scriptedServer(answer) {
	const bodies = [];
	let rootCalls = 0;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			const parsed = JSON.parse(body);
			bodies.push(parsed);
			const side = body.includes("SIDECALL");
			if (!side) rootCalls += 1;
			const spec = answer(parsed, side ? null : rootCalls);
			const chunk = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
			const delta = spec.toolCall ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${bodies.length}`, type: "function", function: { name: spec.toolCall, arguments: "{}" } }] } : { role: "assistant", content: spec.content ?? "done" };
			const send = () => {
				res.writeHead(200, { "content-type": "text/event-stream" });
				chunk({ id: "r", object: "chat.completion.chunk", created: 0, model: "m1", choices: [{ index: 0, delta, finish_reason: null }] });
				chunk({ id: "r", object: "chat.completion.chunk", created: 0, model: "m1", choices: [{ index: 0, delta: {}, finish_reason: spec.toolCall ? "tool_calls" : "stop" }], usage: { prompt_tokens: spec.promptTokens ?? 10, completion_tokens: 3, total_tokens: (spec.promptTokens ?? 10) + 3 } });
				res.write("data: [DONE]\n\n");
				res.end();
			};
			if (spec.delayMs) setTimeout(send, spec.delayMs);
			else send();
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		base: `http://127.0.0.1:${server.address().port}/v1`,
		rootBodies: () => bodies.filter((body) => !JSON.stringify(body).includes("SIDECALL")),
		close: () => new Promise((resolve) => {
			server.close(resolve);
			server.closeAllConnections();
		}),
	};
}

/** An overlay extension registering one tool, `name`, whose `execute` body is `body` (with `ctx` in scope). */
const toolExtension = (name, body) => `export default function (pi) {
	pi.registerTool({ name: "${name}", label: "${name}", description: "a test tool", parameters: { type: "object", properties: {} },
		execute: async (_id, _params, _signal, _update, ctx) => { ${body} } });
}
`;

test("the warning's measure leaves out what calls hold in flight: settled at 50%, a hold that would take it past 70% sends nothing", { skip }, async () => {
	// The tool starts a model call it does not await (about 110,000 of bound, a 100 KB request) and returns, so the root's
	// turn ends with that hold in flight while 200,003 of the 400,000 cap has settled.
	const server = await scriptedServer((_body, root) => (root === null ? { content: "side", delayMs: 1500 } : root === 1 ? { toolCall: "kick", promptTokens: 200_000 } : { content: "done" }));
	try {
		const root = jobTree({ base: server.base, cost: 1 });
		put(root, "/opt/pi-global/extensions/kick.js", toolExtension("kick", `const stream = ctx.modelRegistry.streamSimple(ctx.model, { messages: [{ role: "user", content: "SIDECALL " + "x".repeat(100000), timestamp: 1 }] }, { maxTokens: 1000 });
			Promise.resolve(stream).then((s) => s.result()).catch(() => {});
			return { content: [{ type: "text", text: "started" }] };`));
		const { code, exit, stderr } = await runRealJob(root, { PI_MAX_COST_MICROS: "400000" });
		assert.equal(code, 0, `${JSON.stringify(exit)}\n${stderr.slice(-2000)}`);
		const after = server.rootBodies().at(-1);
		assert.equal(userTexts(after).includes(LIMIT_WARNINGS["cost-cap"]), false, "no warning: only settled plus the hold passes 70%");
		assert.equal(exit.tokens.costWarned, 0);
	} finally {
		await server.close();
	}
});

test("the warning's measure counts what the job's pi child processes settled: 37% of its own and 37% in a child's ledger warn", { skip }, async () => {
	// The tool writes a child's ledger as a pi child does (whole, by rename, in the runner's ledger directory: 150,000 spent)
	// and waits past the parent's next fold, so the root's turn ends with 150,003 of its own and 150,000 of a child's settled.
	const ledger = JSON.stringify({ v: 4, state: "running", metered: true, totals: { input: 0, output: 0, total: 0, cost: 0, calls: 0, unresolved: 0, unpriced: 0, sessions: 0 }, rows: [], spentMicros: 150_000, inflightMicros: 0, costRefused: 0, modelRefused: 0, boundExceeded: 0, costUnanswered: 0, costUnreported: 0, longContext: 0, costUnjudged: 0, waiting: 0 });
	const server = await scriptedServer((_body, root) => (root === 1 ? { toolCall: "spend", promptTokens: 150_000 } : { content: "done" }));
	try {
		const root = jobTree({ base: server.base, cost: 1 });
		put(root, "/opt/pi-global/extensions/spend.js", toolExtension("spend", `const fs = await import("node:fs");
			const dir = process.env.PI_DISPATCH_CHILD_LEDGER;
			fs.writeFileSync(dir + "/99999.0123456789abcdef.tmp", ${JSON.stringify(ledger)});
			fs.renameSync(dir + "/99999.0123456789abcdef.tmp", dir + "/99999.0123456789abcdef.json");
			await new Promise((resolve) => setTimeout(resolve, 2500));
			return { content: [{ type: "text", text: "spent" }] };`));
		const { code, exit, stderr } = await runRealJob(root, { PI_MAX_COST_MICROS: "400000" });
		assert.equal(code, 0, `${JSON.stringify(exit)}\n${stderr.slice(-2000)}`);
		const after = server.rootBodies().at(-1);
		assert.equal(userTexts(after).filter((text) => text === LIMIT_WARNINGS["cost-cap"]).length, 1, "300,003 settled of 400,000: warned");
		assert.deepEqual([exit.tokens.costWarned, exit.tokens.costChargedMicros], [1, 150_003 + 13 + 150_000]);
	} finally {
		await server.close();
	}
});

test("a pi child's cost refusal that stops the job is the job's: the exit line's why and costRefusal are the child's, off its ledger", { skip }, async () => {
	// The tool writes a child's ledger that says its cost guard refused one call (as a role task's child writes it) and waits
	// past the parent's next fold, which stops the job on it. The parent's own guard refused nothing.
	const numbers = { spentMicros: 20_000, inflightMicros: 0, externalMicros: 380_000, boundMicros: 50_000 };
	const ledger = JSON.stringify({ v: 4, state: "running", metered: true, totals: { input: 0, output: 0, total: 0, cost: 0, calls: 0, unresolved: 0, unpriced: 0, sessions: 0 }, rows: [], spentMicros: 20_000, inflightMicros: 0, costRefused: 1, modelRefused: 0, boundExceeded: 0, costUnanswered: 0, costUnreported: 0, longContext: 0, costUnjudged: 0, waiting: 0, refusedWhy: "over-cap", costRefusal: numbers });
	const server = await scriptedServer((_body, root) => (root === 1 ? { toolCall: "refuse" } : { content: "done" }));
	try {
		const root = jobTree({ base: server.base, cost: 1 });
		put(root, "/opt/pi-global/extensions/refuse.js", toolExtension("refuse", `const fs = await import("node:fs");
			const dir = process.env.PI_DISPATCH_CHILD_LEDGER;
			fs.writeFileSync(dir + "/99998.0123456789abcdef.tmp", ${JSON.stringify(ledger)});
			fs.renameSync(dir + "/99998.0123456789abcdef.tmp", dir + "/99998.0123456789abcdef.json");
			await new Promise((resolve) => setTimeout(resolve, 2500));
			return { content: [{ type: "text", text: "refused" }] };`));
		const { code, exit, stderr } = await runRealJob(root, { PI_MAX_COST_MICROS: "400000" });
		assert.equal(code, 2, `${JSON.stringify(exit)}\n${stderr.slice(-2000)}`);
		assert.deepEqual([exit.reason, exit.why, exit.costRefusal], ["cost-cap", "over-cap", numbers]);
		assert.deepEqual(parseExitCostRefusal(`${JSON.stringify(exit)}\n`), numbers, "and the worker reads them back");
		assert.equal(exit.tokens.costRefused, 1, "the child's refusal, counted on the parent's line");
	} finally {
		await server.close();
	}
});

test("issue #1055: a job at 70% of its turn limit after a tool turn reads the turn warning in its next request, once, and its exit line says so", { skip }, async () => {
	// Four turns: 70% of 4 is 3, so the warning follows turn 3 and rides call 4, which the budget still allows.
	const server = await chatServer({ replies: [{ toolCall: { name: "ls", arguments: { path: "." } } }, { toolCall: { name: "ls", arguments: { path: "." } } }, { toolCall: { name: "ls", arguments: { path: "." } } }, { content: "done" }] });
	try {
		const root = jobTree({ base: server.base });
		const { code, exit, lines, stderr } = await runRealJob(root, { PI_MAX_TURNS: "4" });
		assert.equal(code, 0, `${JSON.stringify(exit)}\n${stderr.slice(-2000)}`);
		assert.equal(server.calls(), 4, "no call of its own");
		const turnWarnings = server.bodies().map((body) => userTexts(body).filter((text) => text === LIMIT_WARNINGS[TURN_LIMIT]).length);
		assert.deepEqual(turnWarnings, [0, 0, 0, 1], "after turn 3, before call 4");
		assert.deepEqual(lines.filter((line) => line.event === "cost_warning").map(({ event, jobId, ...fields }) => fields), [{ limit: TURN_LIMIT, settled: 3, threshold: 3, cap: 4 }]);
		assert.deepEqual([exit.turns, exit.tokens.turnsWarned, Object.hasOwn(exit.tokens, "timeWarned")], [4, 1, false], "no time limit was handed, so no timeWarned");
		assert.equal(JSON.stringify(parseExitTokens(`${JSON.stringify(exit)}\n`)), JSON.stringify(exit.tokens), "the worker reads both back as written");
	} finally {
		await server.close();
	}
});

test("issue #1055: a job the worker said was past 70% of its time limit reads the time warning after its first tool turn, and its exit line says so", { skip }, async () => {
	const server = await chatServer({ replies: [{ toolCall: { name: "ls", arguments: { path: "." } } }, { content: "done" }] });
	try {
		const root = jobTree({ base: server.base });
		// A ten-minute limit with 100 seconds left when the environment was built: 500 seconds had passed, past 70% (420).
		const { code, exit, lines, stderr } = await runRealJob(root, { PI_JOB_MAX_MS: "600000", PI_JOB_LEFT_MS: "100000" });
		assert.equal(code, 0, `${JSON.stringify(exit)}\n${stderr.slice(-2000)}`);
		const [first, second] = server.bodies();
		assert.equal(userTexts(first).includes(LIMIT_WARNINGS[TIME_LIMIT]), false);
		assert.equal(userTexts(second).filter((text) => text === LIMIT_WARNINGS[TIME_LIMIT]).length, 1);
		const warned = lines.filter((line) => line.event === "cost_warning");
		assert.deepEqual(warned.map((line) => [line.limit, line.threshold, line.cap]), [[TIME_LIMIT, 420_000, 600_000]]);
		assert.ok(warned[0].settled >= 500_000 && warned[0].settled < 600_000, "what had passed, plus this process's own clock");
		assert.deepEqual([exit.tokens.turnsWarned, exit.tokens.timeWarned], [0, 1]);
		assert.deepEqual(Object.keys(exit.tokens).slice(-2), ["turnsWarned", "timeWarned"], "the worker's TOKEN_KEYS order");
		assert.equal(JSON.stringify(parseExitTokens(`${JSON.stringify(exit)}\n`)), JSON.stringify(exit.tokens));
		// With most of the hour left the same job is not warned, and says so.
		const calm = await runRealJob(jobTree({ base: server.base }), { PI_JOB_MAX_MS: "3600000", PI_JOB_LEFT_MS: "3590000" });
		assert.equal(calm.code, 0, calm.stderr.slice(-2000));
		assert.equal(calm.exit.tokens.timeWarned, 0);
	} finally {
		await server.close();
	}
});

test("issue #1055: a broken time limit stops the job before anything spends, as a config error", { skip }, async () => {
	const server = await chatServer({ replies: [{ content: "done" }] });
	try {
		const { code, exit } = await runRealJob(jobTree({ base: server.base }), { PI_JOB_MAX_MS: "600000", PI_JOB_LEFT_MS: "600001" });
		assert.equal(code, 2);
		assert.equal(exit.reason, "config");
		assert.equal(server.calls(), 0, "refused before the first call");
	} finally {
		await server.close();
	}
});
