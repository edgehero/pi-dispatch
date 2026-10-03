/**
 * How a process of this image reaches the child meter (issue #500; DES-USAGE-METER-VIA-API-PROVIDER-REGISTRY): the
 * argument injection a pi CLI child gets, and the nested runner. No pi import and nothing done at load, because the
 * child preload loads this file in every Node process a job starts.
 *
 * THE NESTED RUNNER. pi's stock subagent example starts its children as `process.execPath process.argv[1] <pi args>`,
 * and in a job argv[1] is run-job.mjs: the child is a second copy of this runner (measured, OQ-011 M1). Before this
 * file it ran the whole job prompt again, with its own meter, its own exit line and its own ledger directory. Now it
 * runs as the pi CLI it was spawned to be (runAsPiCli), metered like any pi CLI child through the parent's ledger.
 */
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The extension the child preload puts first on a pi child's command line. */
export const CHILD_METER_PATH = join(HERE, "child-meter.ts");
/** The runner itself, which a nested copy runs as its argv[1]. */
export const RUN_JOB_PATH = join(HERE, "..", "run-job.mjs");

/** The pi subcommands, dispatched on args[0] before any option is parsed (pinned in pinned-api.test.mjs). */
export const PI_SUBCOMMANDS = Object.freeze(["auth", "config", "install", "list", "mcp", "remove", "uninstall", "update"]);

/**
 * Whether this process is a NESTED runner: PI_DISPATCH_RUNNER_PID is set and is not this process's pid. The job's
 * runner sets that variable to its own pid for every descendant (openChildLedger), and the worker never passes it in,
 * so the job's runner starts without it and any other process that carries it was started below the runner. Any value
 * that is not exactly this pid counts as nested: a nested runner that wrongly thinks it is the job's runner re-runs the
 * job, and one that wrongly thinks it is nested runs a pi CLI or stops with exit 2, so the doubt goes to nested.
 */
export function isNestedRunner(env, pid) {
	// Read by name, not through usage-meter.mjs RUNNER_PID_ENV: this file loads nothing heavy. child-route.test.mjs drives it with that constant.
	// env-internal PI_DISPATCH_RUNNER_PID: set by the runner in its own environment and inherited, never by the worker.
	const runner = env.PI_DISPATCH_RUNNER_PID;
	return runner !== undefined && runner !== String(pid);
}

/**
 * Insert `-e <meterPath>` first in a pi entry's arguments (argv[2] on), in place. False, and argv untouched, for a CLI
 * whose first argument is a subcommand. First, not last and not before the first `--`: everything after `--` is a
 * message, and in front of the spawner's own `-e`s is what loads the meter before them (measured in both CLIs).
 */
export function injectChildMeter(argv, kind, meterPath = CHILD_METER_PATH) {
	if (kind === "cli" && PI_SUBCOMMANDS.includes(argv[2])) return false;
	argv.splice(2, 0, "-e", meterPath);
	return true;
}

/** Whether `argv` already carries the injection in front (the preload made it). */
export function hasChildMeter(argv, meterPath = CHILD_METER_PATH) {
	return argv[2] === "-e" && argv[3] === meterPath;
}

/**
 * "cli" when `argv1` is this image's run-job.mjs (by realpath) and the process is a nested runner, else null. The
 * preload's route for such a process is then the pi CLI's: the `starting` stub, `-e` first, no library hook. So a nested
 * runner is metered by exactly the route a pi CLI child is, with one meter, the extension's.
 */
export function nestedRunnerKind(argv1, { env, pid, realpath = realpathSync, runJob = RUN_JOB_PATH }) {
	if (!isNestedRunner(env, pid) || typeof argv1 !== "string" || argv1 === "") return null;
	try {
		return realpath(argv1) === realpath(runJob) ? "cli" : null;
	} catch {
		return null;
	}
}

/**
 * Why `dir` cannot hold this process's ledger, or null when it can: set, absolute, a directory itself (not a link to
 * one), and writable and searchable by this process. A code, never the path.
 */
export function ledgerDirProblem(dir, { lstat = lstatSync, access = accessSync } = {}) {
	if (typeof dir !== "string" || dir === "") return "unset";
	if (!isAbsolute(dir)) return "relative";
	try {
		if (!lstat(dir).isDirectory()) return "not-a-directory";
		access(dir, constants.W_OK | constants.X_OK);
	} catch (error) {
		return typeof error?.code === "string" ? error.code : "unusable";
	}
	return null;
}

/** pi's unbundled CLI, from the copy of pi this runner imports (dist/index.js's sibling). */
function defaultCliUrl() {
	return new URL("./cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href;
}

/**
 * The nested runner's whole life (run-job.mjs calls this and nothing else when isNestedRunner). It reads no exit key,
 * writes no exit line, installs no SIGTERM handler, reads nothing under /job and opens no ledger directory of its own.
 *
 *   - The parent's ledger directory must be usable. If it is not, one line on stderr and exit code 2 (a config error,
 *     never retried), set as the exit code so the line is flushed: a child that cannot be metered does not run.
 *   - `-e child-meter.ts` first, unless the preload already put it there (it does, through nestedRunnerKind): with the
 *     preload missing (a spawner that replaced NODE_OPTIONS) the extension still loads and meters this process.
 *   - Then pi's UNBUNDLED dist/cli.js, which runs `setupCli()` and `main(process.argv.slice(2))`. Unbundled, because the
 *     runner's own imports already loaded that copy of pi: the CLI runs on the same module graph, one copy of pi in the
 *     process, and the extension's bare imports reach the same class the sessions dispatch through. The bundle would be
 *     a second, separate copy of pi beside the one already loaded.
 *
 * Returns "refused" or "cli". Resolves once pi's CLI module has run; pi's main then runs on its own, as in a pi process.
 */
export async function runAsPiCli({
	env = process.env,
	argv = process.argv,
	warn = (line) => process.stderr.write(line),
	setExitCode = (code) => {
		process.exitCode = code;
	},
	check = ledgerDirProblem,
	cliUrl = defaultCliUrl,
	load = (url) => import(url),
} = {}) {
	// env-internal PI_DISPATCH_CHILD_LEDGER: set by the runner in its own environment and inherited, never by the worker.
	const problem = check(env.PI_DISPATCH_CHILD_LEDGER);
	if (problem !== null) {
		warn(`pi-dispatch: a nested runner cannot be metered, its parent's child ledger directory is unusable (${problem}); exit 2\n`);
		setExitCode(2);
		return "refused";
	}
	if (!hasChildMeter(argv)) injectChildMeter(argv, "cli");
	await load(cliUrl());
	return "cli";
}
