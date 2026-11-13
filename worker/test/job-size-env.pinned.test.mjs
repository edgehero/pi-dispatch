import assert from "node:assert/strict";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { jobSizeEnv } from "../src/job-size.mjs";

// Issue #865: the job's size reaches the agent's commands only because the pinned pi's bash tool spawns its shell with
// the runner's environment. At pi 1.5.2 `resolveSpawnContext` (dist/core/tools/bash.js) copies `getShellEnv()`, which
// spreads `process.env`, and deletes five PI_* names of its own (PI_SESSION_ID, PI_SESSION_FILE, PI_PROVIDER, PI_MODEL,
// PI_REASONING_LEVEL) before it sets them again from the session. Nothing else in this repository says that holds, so a
// pi release that filtered the environment harder would leave `jest --maxWorkers=$PI_JOB_SIZE_CPUS` expanding to
// nothing in every job, on a clean exit. This runs the pinned tool definition itself, as the runner gets it
// (image/runner/src/tools.mjs imports the same factory), with a session context shaped like the runner's.
let createBashToolDefinition;
try {
	({ createBashToolDefinition } = await import("@earendil-works/pi-coding-agent"));
} catch (error) {
	if (process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw error;
}
const skip = createBashToolDefinition ? false : "pinned pi artifact not installed; CI requires it";

/** Set env vars for the duration of `fn`, restoring exactly what was there (absent included). Async, so the finally waits. */
async function withEnv(vars, fn) {
	const saved = Object.fromEntries(Object.keys(vars).map((n) => [n, Object.hasOwn(process.env, n) ? process.env[n] : undefined]));
	Object.assign(process.env, vars);
	try {
		return await fn();
	} finally {
		for (const [n, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[n];
			else process.env[n] = v;
		}
	}
}

test("issue #865: the pinned pi's bash tool hands a command the job's size from the runner's environment", { skip }, async () => {
	const cwd = tempDir("pd-865-bash-");
	const size = jobSizeEnv({ memMiB: 1536, cpuCenti: 150, source: "project" });
	const ctx = { cwd, model: { provider: "p", id: "m" }, thinkingLevel: undefined, sessionManager: { getSessionId: () => "s", getSessionFile: () => undefined } };
	const definition = createBashToolDefinition(cwd);
	const command = 'printf "%s|%s|%s" "$PI_JOB_SIZE_CPUS" "$PI_JOB_SIZE_MEMORY_MIB" "${PI_SESSION_FILE-unset}"';
	// PI_SESSION_FILE is one of the names the tool deletes before it spawns, and this context names no session file, so
	// its absence in the command's output is the control: the test does run through the tool's own environment filter.
	const result = await withEnv({ ...size, PI_SESSION_FILE: "/session/current.jsonl" }, () => definition.execute("call-1", { command }, undefined, undefined, ctx));
	assert.equal(result.isError, undefined, JSON.stringify(result.content));
	assert.equal(result.content[0].text, `${size.PI_JOB_SIZE_CPUS}|${size.PI_JOB_SIZE_MEMORY_MIB}|unset`);
	assert.deepEqual([size.PI_JOB_SIZE_CPUS, size.PI_JOB_SIZE_MEMORY_MIB], ["2", "1536"]);
});
