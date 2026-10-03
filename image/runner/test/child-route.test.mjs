import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CHILD_LEDGER_ENV, CHILD_METER_HANDOFF, RUNNER_PID_ENV } from "../src/usage-meter.mjs";
import * as usageMeter from "../src/usage-meter.mjs";
import { CHILD_METER_PATH, hasChildMeter, injectChildMeter, isNestedRunner, ledgerDirProblem, nestedRunnerKind, RUN_JOB_PATH, runAsPiCli } from "../src/child-route.mjs";
// Importing the preload runs its top level, which does nothing without PI_DISPATCH_CHILD_LEDGER in this environment.
import { preload } from "../src/child-preload.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #500 part D, the nested runner's pure halves (DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY). The real processes
 * run in child-meter.integration.test.mjs.
 */

test("isNestedRunner: nested only when PI_DISPATCH_RUNNER_PID is set and is another process's pid", () => {
	// The job's runner starts without it: the worker never passes it in.
	assert.equal(isNestedRunner({}, 7), false);
	// The job's runner after openChildLedger set it to its own pid: still the job's runner.
	assert.equal(isNestedRunner({ [RUNNER_PID_ENV]: "7" }, 7), false);
	// A copy of the runner started below it.
	assert.equal(isNestedRunner({ [RUNNER_PID_ENV]: "7" }, 30), true);
	// Any value that is not exactly this pid is nested: the doubt goes to the side that never re-runs the job.
	assert.equal(isNestedRunner({ [RUNNER_PID_ENV]: "" }, 7), true);
	assert.equal(isNestedRunner({ [RUNNER_PID_ENV]: " 7" }, 7), true);
	assert.equal(isNestedRunner({ [RUNNER_PID_ENV]: "x" }, 7), true);
});

test("RUN_JOB_PATH and CHILD_METER_PATH name this image's files", () => {
	assert.equal(RUN_JOB_PATH, fileURLToPath(new URL("../run-job.mjs", import.meta.url)));
	assert.equal(CHILD_METER_PATH, fileURLToPath(new URL("../src/child-meter.ts", import.meta.url)));
});

test("nestedRunnerKind: \"cli\" for this image's run-job.mjs (by realpath) in a nested runner, else null", () => {
	const realpath = (path) => {
		if (path === "/gone") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
		return path === "/link/run-job.mjs" ? RUN_JOB_PATH : path;
	};
	const nested = { env: { [RUNNER_PID_ENV]: "7" }, pid: 30, realpath };
	assert.equal(nestedRunnerKind(RUN_JOB_PATH, nested), "cli");
	assert.equal(nestedRunnerKind("/link/run-job.mjs", nested), "cli");
	assert.equal(nestedRunnerKind("/workspace/run-job.mjs", nested), null, "a file merely named run-job.mjs");
	assert.equal(nestedRunnerKind("/gone", nested), null);
	assert.equal(nestedRunnerKind(undefined, nested), null);
	assert.equal(nestedRunnerKind(RUN_JOB_PATH, { ...nested, pid: 7 }), null, "the job's runner itself");
	assert.equal(nestedRunnerKind(RUN_JOB_PATH, { ...nested, env: {} }), null);
});

test("hasChildMeter and injectChildMeter: the injection is recognised in front, and made once", () => {
	const argv = ["node", RUN_JOB_PATH, "-p", "hi"];
	assert.equal(hasChildMeter(argv), false);
	injectChildMeter(argv, "cli");
	assert.equal(hasChildMeter(argv), true);
	assert.deepEqual(argv.slice(2), ["-e", CHILD_METER_PATH, "-p", "hi"]);
	assert.equal(hasChildMeter(["node", RUN_JOB_PATH, "-e", "/other.ts"]), false);
});

test("ledgerDirProblem: a writable directory is fine; unset, relative, missing, a file, a link or no write access is named by a code", () => {
	const root = tempDir("pi-dispatch-route-");
	const dir = join(root, "ledger");
	mkdirSync(dir, { mode: 0o700 });
	assert.equal(ledgerDirProblem(dir), null);
	assert.equal(ledgerDirProblem(undefined), "unset");
	assert.equal(ledgerDirProblem(""), "unset");
	assert.equal(ledgerDirProblem("ledger"), "relative");
	assert.equal(ledgerDirProblem(join(root, "gone")), "ENOENT");
	writeFileSync(join(root, "file"), "");
	assert.equal(ledgerDirProblem(join(root, "file")), "not-a-directory");
	symlinkSync(dir, join(root, "link"));
	assert.equal(ledgerDirProblem(join(root, "link")), "not-a-directory", "a link to a directory is not the directory");
	const denied = () => {
		throw Object.assign(new Error("EACCES"), { code: "EACCES" });
	};
	assert.equal(ledgerDirProblem(dir, { access: denied }), "EACCES");
	assert.equal(ledgerDirProblem(dir, { access: () => { throw new Error("odd"); } }), "unusable");
});

test("runAsPiCli: a usable directory injects -e first (once) and loads pi's unbundled dist/cli.js", async () => {
	const dir = tempDir("pi-dispatch-route-cli-");
	const loaded = [];
	const codes = [];
	const argv = ["node", RUN_JOB_PATH, "--mode", "json", "-p", "hi"];
	const options = { env: { [CHILD_LEDGER_ENV]: dir }, argv, warn: () => assert.fail("no warning"), setExitCode: (code) => codes.push(code), load: async (url) => loaded.push(url) };
	assert.equal(await runAsPiCli(options), "cli");
	assert.deepEqual(argv.slice(2), ["-e", CHILD_METER_PATH, "--mode", "json", "-p", "hi"]);
	assert.equal(loaded.length, 1);
	assert.equal(loaded[0], new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
	assert.ok(loaded[0].endsWith("/@earendil-works/pi-coding-agent/dist/cli.js"), "the unbundled CLI, not the bundle");
	assert.deepEqual(codes, []);
	// The preload made the injection already: not a second -e.
	assert.equal(await runAsPiCli(options), "cli");
	assert.deepEqual(argv.slice(2), ["-e", CHILD_METER_PATH, "--mode", "json", "-p", "hi"]);
	// A subcommand is passed through as pi gets it.
	const sub = ["node", RUN_JOB_PATH, "list"];
	await runAsPiCli({ ...options, argv: sub });
	assert.deepEqual(sub.slice(2), ["list"]);
});

test("runAsPiCli: an unusable directory is one line on stderr and exit code 2, and pi is never loaded", async () => {
	for (const env of [{}, { [CHILD_LEDGER_ENV]: "/nonexistent/pi-dispatch-meter-x" }]) {
		const lines = [];
		const codes = [];
		const argv = ["node", RUN_JOB_PATH, "-p", "hi"];
		const result = await runAsPiCli({ env, argv, warn: (line) => lines.push(line), setExitCode: (code) => codes.push(code), load: () => assert.fail("pi must not load") });
		assert.equal(result, "refused");
		assert.deepEqual(codes, [2]);
		assert.equal(lines.length, 1);
		assert.match(lines[0], /^pi-dispatch: a nested runner cannot be metered, [^\n]*\((unset|ENOENT)\); exit 2\n$/);
		assert.doesNotMatch(lines[0], /nonexistent/, "a code, never the path");
		assert.deepEqual(argv.slice(2), ["-p", "hi"], "nothing injected");
	}
});

test("preload: a nested runner takes the pi CLI's route (stub, -e first) and registers NO library hook", async () => {
	const dir = tempDir("pi-dispatch-route-preload-");
	const argv = ["node", RUN_JOB_PATH, "--mode", "json", "-p", "hi"];
	const global = {};
	const env = { [CHILD_LEDGER_ENV]: dir, [RUNNER_PID_ENV]: "7" };
	const result = await preload({ env, argv, pid: 30, global, realpath: (path) => path, registerHooks: () => assert.fail("one meter per process: no library hook in a nested runner"), loadMeter: () => usageMeter, onExit: () => {} });
	assert.equal(result, "entry");
	assert.deepEqual(argv.slice(2), ["-e", CHILD_METER_PATH, "--mode", "json", "-p", "hi"]);
	const [stub] = readdirSync(dir);
	assert.match(stub, /^30\.[0-9a-f]{16}\.json$/);
	assert.equal(JSON.parse(readFileSync(join(dir, stub), "utf8")).state, "starting");
	assert.equal(global[CHILD_METER_HANDOFF].name, stub);
	// The job's runner itself (its own pid) is not one: the library route, as before.
	const hooks = [];
	assert.equal(await preload({ env, argv: ["node", RUN_JOB_PATH], pid: 7, global: {}, realpath: (path) => path, registerHooks: (hook) => hooks.push(hook) }), "library");
	assert.equal(hooks.length, 1);
});
