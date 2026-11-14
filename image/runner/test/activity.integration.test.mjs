import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { JOB_MODEL, jobTree, runRealJob } from "./helpers/real-job.mjs";

/**
 * Issue #888, end to end: the real run-job.mjs with the real pi (helpers/real-job.mjs) and a scripted model that asks
 * for bash calls, under limits of seconds. A pure test says what the watch decides on a fake clock; only this says that
 * pi's real events reach it, that a stop really ends a job whose tool is still running, and what the line says.
 *
 * CPU and network are hidden here (PI_DISPATCH_TEST_HIDE_PROBES, fixtures/remap-roots.mjs): outside a container the cgroup
 * is the whole test session's, so a CPU case would be measuring the test machine, and CI runs many test files at once.
 * Output (`tool_execution_update`) is the activity these cases use; verify-image.sh proves the rest in the image. Gated like loader.test.mjs: a skip is NOT a pass, and CI sets PI_DISPATCH_REQUIRE_LOADER_TESTS=1.
 */
let pi;
let importError;
try {
	pi = await import("@earendil-works/pi-coding-agent");
} catch (error) {
	importError = error;
}
if (!pi && process.env.PI_DISPATCH_REQUIRE_LOADER_TESTS === "1") throw new Error(`the activity watch is REQUIRED here but pi could not be imported.\n${importError}`);
const skip = pi ? false : `pi not installed (node ${process.version}); CI runs these`;

/** An OpenAI-compatible endpoint that answers each call with the next bash command of `commands`, then with text. */
async function scriptedServer(commands) {
	let calls = 0;
	const chunk = (res, payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
	const base = { id: "r", object: "chat.completion.chunk", created: 0, model: JOB_MODEL };
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			const command = commands[calls];
			calls += 1;
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (command === undefined) {
				chunk(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] });
				chunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
			} else {
				const call = { index: 0, id: `call_${calls}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } };
				chunk(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [call] }, finish_reason: null }] });
				chunk(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
			}
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		base: `http://127.0.0.1:${server.address().port}/v1`,
		calls: () => calls,
		close: () =>
			new Promise((resolve) => {
				server.close(resolve);
				server.closeAllConnections();
			}),
	};
}

/** Run the scripted job with a session file mounted, under the given limits; resolve the run and the elapsed time. */
async function runScripted(commands, limits) {
	const server = await scriptedServer(commands);
	try {
		const root = jobTree({ base: server.base });
		// The worker stages the session file before the container starts; an absent one is a mount that did not land.
		writeFileSync(join(root, "session", "current.jsonl"), "");
		const started = Date.now();
		const run = await runRealJob(root, { PI_SESSION_FILE: "/session/current.jsonl", PI_MAX_TURNS: "20", PI_DISPATCH_TEST_HIDE_PROBES: "1", ...limits });
		const counters = (() => {
			try {
				return JSON.parse(readFileSync(join(root, "session", "activity.json"), "utf8"));
			} catch {
				return null;
			}
		})();
		return { ...run, elapsedMs: Date.now() - started, counters };
	} finally {
		await server.close();
	}
}

test("a tool that sleeps in silence is stopped as idle, and the job ends though the tool never returned", { skip, timeout: 60_000 }, async () => {
	const { exit, lines, elapsedMs, counters, stderr } = await runScripted(["sleep 120"], { PI_JOB_IDLE_MS: "3000" });
	assert.equal(exit?.code, 2, `${JSON.stringify(exit)}\n${stderr}`);
	assert.equal(exit.reason, "idle");
	assert.equal(typeof exit.activity?.sinceActivityS, "number");
	assert.ok(elapsedMs < 40_000, `stopped in ${elapsedMs} ms, not after the 120 s sleep`);
	assert.ok(lines.some((line) => line.event === "activity_stop" && line.reason === "idle"));
	assert.ok(counters?.v === 1 && counters.steps >= 1 && counters.active >= counters.steps, JSON.stringify(counters));
});

test("a tool that keeps printing is not idle, but with no step it stalls at the stall limit", { skip, timeout: 60_000 }, async () => {
	const { exit, elapsedMs, stderr } = await runScripted(["for i in $(seq 1 200); do echo tick $i; sleep 0.5; done"], { PI_JOB_IDLE_MS: "3000", PI_JOB_STALL_MS: "9000" });
	assert.equal(exit?.code, 2, `${JSON.stringify(exit)}\n${stderr}`);
	assert.equal(exit.reason, "stalled", "printing kept it from idle; the missing steps ended it");
	assert.ok(elapsedMs >= 9_000, `ran ${elapsedMs} ms: output kept it past the 3 s idle limit`);
});

test("a job that keeps taking steps runs well past both limits and completes", { skip, timeout: 60_000 }, async () => {
	const { exit, elapsedMs, stderr } = await runScripted(["sleep 1.5", "sleep 1.5", "sleep 1.5", "sleep 1.5", "sleep 1.5", "sleep 1.5", "sleep 1.5", "sleep 1.5"], { PI_JOB_IDLE_MS: "4000", PI_JOB_STALL_MS: "5000" });
	assert.equal(exit?.code, 0, `${JSON.stringify(exit)}\n${stderr}`);
	assert.ok(elapsedMs >= 10_000, `ran ${elapsedMs} ms, twice the stall limit`);
	assert.equal(typeof exit.activity?.sinceStepS, "number");
});

test("without the worker's variables there is no watch: the line carries no activity field", { skip, timeout: 60_000 }, async () => {
	const { exit, lines, stderr } = await runScripted([], {});
	assert.equal(exit?.code, 0, `${JSON.stringify(exit)}\n${stderr}`);
	assert.equal("activity" in exit, false);
	assert.equal(lines.some((line) => line.event === "activity_watch"), false);
});
