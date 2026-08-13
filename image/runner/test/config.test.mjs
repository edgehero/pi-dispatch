import assert from "node:assert/strict";
import { test } from "node:test";
import { assertPackagePathsExist, commandName, enforceOfflineMode, parseRunnerEnv } from "../src/config.mjs";
import { EXIT_POLICY } from "../src/outcome.mjs";

const base = { PI_PROVIDER: "anthropic", PI_MODEL: "claude-x", PI_MAX_TURNS: "20" };

test("parses a valid environment", () => {
	const cfg = parseRunnerEnv(base);
	assert.equal(cfg.provider, "anthropic");
	assert.equal(cfg.model, "claude-x");
	assert.equal(cfg.maxTurns, 20);
	assert.equal(cfg.maxTokens, null); // optional, unset -> cap disabled
	assert.equal(cfg.retry.maxRetries, 2); // default
	assert.equal(cfg.retry.baseDelayMs, 2000); // default
});

test("PI_MAX_TOKENS is optional: unset is null, a valid value parses", () => {
	assert.equal(parseRunnerEnv({ ...base }).maxTokens, null);
	assert.equal(parseRunnerEnv({ ...base, PI_MAX_TOKENS: "" }).maxTokens, null);
	assert.equal(parseRunnerEnv({ ...base, PI_MAX_TOKENS: "500000" }).maxTokens, 500000);
});

test("a malformed PI_MAX_TOKENS is a config error, not a silently-ignored cap", () => {
	for (const bad of ["0", "-1", "1.5", "abc", "12x", " "]) {
		try {
			parseRunnerEnv({ ...base, PI_MAX_TOKENS: bad });
			assert.fail(`expected throw for PI_MAX_TOKENS=${JSON.stringify(bad)}`);
		} catch (error) {
			assert.equal(error.piDispatchExit, EXIT_POLICY, `PI_MAX_TOKENS=${JSON.stringify(bad)}`);
		}
	}
});

// Every deterministic misconfiguration must be a TAGGED config error (exit 2), so the queue
// does not retry a worker-template typo forever. These threw plain Errors before -- routed
// through a regex tuned for pi's vocabulary that did not match them -- landing on exit 1.
test("missing required vars are config errors (exit 2)", () => {
	for (const missing of ["PI_PROVIDER", "PI_MODEL", "PI_MAX_TURNS"]) {
		const env = { ...base };
		delete env[missing];
		try {
			parseRunnerEnv(env);
			assert.fail(`expected throw for missing ${missing}`);
		} catch (error) {
			assert.equal(error.piDispatchExit, EXIT_POLICY, `${missing} must be exit 2`);
		}
	}
});

test("a malformed PI_MAX_TURNS is a config error, not a retryable NaN", () => {
	for (const bad of ["0", "-1", "1.5", "abc", "", "12x", " "]) {
		try {
			parseRunnerEnv({ ...base, PI_MAX_TURNS: bad });
			assert.fail(`expected throw for PI_MAX_TURNS=${JSON.stringify(bad)}`);
		} catch (error) {
			assert.equal(error.piDispatchExit, EXIT_POLICY, `PI_MAX_TURNS=${JSON.stringify(bad)}`);
		}
	}
});

test("optional retry knobs override their defaults and are validated too", () => {
	const cfg = parseRunnerEnv({ ...base, PI_RETRY_MAX: "5", PI_RETRY_BASE_MS: "500" });
	assert.equal(cfg.retry.maxRetries, 5);
	assert.equal(cfg.retry.baseDelayMs, 500);
	assert.throws(() => parseRunnerEnv({ ...base, PI_RETRY_MAX: "0" }), (e) => e.piDispatchExit === EXIT_POLICY);
});

// --- REQ-GLOBAL-PI-OVERLAY: the overlay-extensions opt-OUT (PI_GLOBAL_ALLOW_EXTENSIONS) ---

test("PI_GLOBAL_ALLOW_EXTENSIONS unset means LOAD -- the operator staged that dir themselves", () => {
	// The worker emits nothing for the loading case, so "absent" is the shape almost every job arrives with.
	assert.equal(parseRunnerEnv({ ...base }).allowGlobalExtensions, true);
	assert.equal(parseRunnerEnv({ ...base, PI_GLOBAL_ALLOW_EXTENSIONS: "" }).allowGlobalExtensions, true);
	assert.equal(parseRunnerEnv({ ...base, PI_GLOBAL_ALLOW_EXTENSIONS: "1" }).allowGlobalExtensions, true, "the legacy arming value still reads as ON");
});

test('PI_GLOBAL_ALLOW_EXTENSIONS="0" is the opt-out, and the only one', () => {
	assert.equal(parseRunnerEnv({ ...base, PI_GLOBAL_ALLOW_EXTENSIONS: "0" }).allowGlobalExtensions, false);
});

test("a malformed PI_GLOBAL_ALLOW_EXTENSIONS is a config error (exit 2), never a guessed default", () => {
	// The worker only ever emits "0" or nothing, so a third value means a hand-run container or a template
	// regression. Guessing "load" runs extensions someone disabled; guessing "off" strips a flow's setup and
	// still exits 0. Refusing is the only outcome that cannot lie about which happened. Mirrors the worker.
	for (const bad of ["false", "true", "yes", "no", "2", " 0", "off"]) {
		try {
			parseRunnerEnv({ ...base, PI_GLOBAL_ALLOW_EXTENSIONS: bad });
			assert.fail(`expected throw for PI_GLOBAL_ALLOW_EXTENSIONS=${JSON.stringify(bad)}`);
		} catch (error) {
			assert.equal(error.piDispatchExit, EXIT_POLICY, `PI_GLOBAL_ALLOW_EXTENSIONS=${JSON.stringify(bad)}`);
		}
	}
});

// --- INT-CONTAINER-JOB-INPUTS: staged pi packages (PI_PACKAGES) ---

test("PI_PACKAGES unset or empty is no packages, not an error", () => {
	// A trigger that opted into no packages is the normal state. Every job would fail otherwise.
	assert.deepEqual(parseRunnerEnv({ ...base }).packages, []);
	assert.deepEqual(parseRunnerEnv({ ...base, PI_PACKAGES: "" }).packages, []);
});

test("PI_PACKAGES parses one and many absolute entries, in order", () => {
	assert.deepEqual(parseRunnerEnv({ ...base, PI_PACKAGES: "/opt/pi-global/packages/tools" }).packages, [
		"/opt/pi-global/packages/tools",
	]);
	assert.deepEqual(
		parseRunnerEnv({ ...base, PI_PACKAGES: "/opt/pi-global/packages/tools:/opt/pi-global/packages/review" }).packages,
		["/opt/pi-global/packages/tools", "/opt/pi-global/packages/review"],
	);
});

test("empty PI_PACKAGES segments are dropped, not turned into a cwd-relative path", () => {
	// "a::b" and a trailing ":" are what a shell template leaves behind. An empty string reaching pi
	// would resolve to the cwd itself -- /workspace, the adversarial clone.
	assert.deepEqual(parseRunnerEnv({ ...base, PI_PACKAGES: "/a::/b:" }).packages, ["/a", "/b"]);
	assert.deepEqual(parseRunnerEnv({ ...base, PI_PACKAGES: ":::" }).packages, []);
});

test("a RELATIVE PI_PACKAGES entry is a config error, not a path resolved against /workspace", () => {
	// pi resolves a relative local source against the process cwd, which is the checked-out repo.
	// `packages/tools` would therefore load an extension out of a fork's branch. Exit 2, not retried.
	for (const bad of ["packages/tools", "./packages/tools", "tools", "/ok:relative/tools"]) {
		try {
			parseRunnerEnv({ ...base, PI_PACKAGES: bad });
			assert.fail(`expected throw for PI_PACKAGES=${JSON.stringify(bad)}`);
		} catch (error) {
			assert.equal(error.piDispatchExit, EXIT_POLICY, `PI_PACKAGES=${JSON.stringify(bad)}`);
		}
	}
});

test("a PI_PACKAGES entry containing a `..` segment is a config error", () => {
	// An absolute path may still climb out of the read-only staging mount.
	for (const bad of ["/opt/pi-global/packages/../../../workspace", "/opt/pi-global/packages/..", "/../etc"]) {
		try {
			parseRunnerEnv({ ...base, PI_PACKAGES: bad });
			assert.fail(`expected throw for PI_PACKAGES=${JSON.stringify(bad)}`);
		} catch (error) {
			assert.equal(error.piDispatchExit, EXIT_POLICY, `PI_PACKAGES=${JSON.stringify(bad)}`);
		}
	}

	// The NEGATIVE half: `..` only counts as a whole segment, so a legitimate name containing dots
	// still parses. Rejecting these would make a valid staging layout unusable.
	assert.deepEqual(parseRunnerEnv({ ...base, PI_PACKAGES: "/opt/pi-global/packages/a..b" }).packages, [
		"/opt/pi-global/packages/a..b",
	]);
});

test("a staged package path that never mounted is a config error naming the path", () => {
	// pi skips an absent local source with no error and no diagnostic, so without this the job runs
	// to a clean exit 0 without the tools its flow was written for. fileExists is injected: the
	// classification is asserted without a container.
	const present = ["/opt/pi-global/packages/tools", "/opt/pi-global/packages/review"];
	const fileExists = (path) => path !== "/opt/pi-global/packages/review";
	try {
		assertPackagePathsExist(present, { fileExists });
		assert.fail("expected a throw for the unmounted package path");
	} catch (error) {
		assert.equal(error.piDispatchExit, EXIT_POLICY);
		assert.ok(
			error.message.includes("/opt/pi-global/packages/review"),
			`the error must name the missing path; got ${JSON.stringify(error.message)}`,
		);
	}

	// The POSITIVE half: all present is silent, and no packages at all is silent too.
	assert.doesNotThrow(() => assertPackagePathsExist(present, { fileExists: () => true }));
	assert.doesNotThrow(() => assertPackagePathsExist([], { fileExists: () => false }));
});

test("enforceOfflineMode sets PI_OFFLINE=1 and is idempotent", () => {
	// Offline is a property of the runner, not of its caller: a hand-run container or a worker
	// regression must not be able to re-arm pi's job-time-install path.
	const unset = {};
	enforceOfflineMode(unset);
	assert.equal(unset.PI_OFFLINE, "1");
	enforceOfflineMode(unset);
	assert.equal(unset.PI_OFFLINE, "1", "a second call must not change it");

	// It only ever tightens: anything that is not exactly "1" is overwritten.
	for (const weak of ["0", "", "true", "yes", "no"]) {
		const env = { PI_OFFLINE: weak };
		enforceOfflineMode(env);
		assert.equal(env.PI_OFFLINE, "1", `PI_OFFLINE=${JSON.stringify(weak)} must be overwritten`);
	}
});

test("PI_SESSION_FILE is optional: unset is null, so an unarmed job is byte-identical to today", () => {
	assert.equal(parseRunnerEnv({ ...base }).sessionFile, null);
	assert.equal(parseRunnerEnv({ ...base, PI_SESSION_FILE: "" }).sessionFile, null);
	assert.equal(parseRunnerEnv({ ...base, PI_SESSION_FILE: "/session/current.jsonl" }).sessionFile, "/session/current.jsonl");
});

test("PI_SESSION_FILE refuses a relative path, a .. segment, and anything under /workspace", () => {
	// Relative and `..` for parsePackagePaths' reason: the cwd is /workspace, the adversarial clone.
	// The /workspace exclusion is this variable's own, and it is a narrowing rather than a live guard:
	// the worker never points there, and a template bug that did would put the transcript inside the
	// worktree the agent commits from -- one `git add -A` from a public pull request.
	for (const bad of ["session/current.jsonl", "../session/current.jsonl", "/session/../workspace/s.jsonl", "/workspace", "/workspace/s.jsonl", "/workspace/.pi/s.jsonl"]) {
		assert.throws(
			() => parseRunnerEnv({ ...base, PI_SESSION_FILE: bad }),
			(e) => e.piDispatchExit === EXIT_POLICY,
			`PI_SESSION_FILE=${JSON.stringify(bad)} must refuse pre-spend, not be silently accepted`,
		);
	}
	// A path merely NAMED like the workspace is fine -- the check is on the path boundary, not a prefix.
	assert.equal(parseRunnerEnv({ ...base, PI_SESSION_FILE: "/workspace-sessions/s.jsonl" }).sessionFile, "/workspace-sessions/s.jsonl");
});

test("PI_FLOW is optional: unset or empty is null, so a flowless job is byte-identical to today", () => {
	assert.equal(parseRunnerEnv(base).flow, null);
	assert.equal(parseRunnerEnv({ ...base, PI_FLOW: "" }).flow, null);
});

test("PI_FLOW parses to the exact string, with no charset opinion", () => {
	assert.equal(parseRunnerEnv({ ...base, PI_FLOW: "review" }).flow, "review");
	// Deliberately accepted: the value is only compared against loaded skill names and logged, never
	// interpolated into a path or a shell word, and refusing a shape the worker's own validator
	// accepted (parseTriggers pins non-empty string, nothing narrower) would start failing
	// yesterday's jobs on an image upgrade. The comparison simply misses, and the miss is the report.
	assert.equal(parseRunnerEnv({ ...base, PI_FLOW: "Not A Skill Name" }).flow, "Not A Skill Name");
});

test("PI_COMMAND is optional: unset or empty is null, so a prompt job is byte-identical to today", () => {
	assert.equal(parseRunnerEnv(base).command, null);
	assert.equal(parseRunnerEnv({ ...base, PI_COMMAND: "" }).command, null);
});

test("PI_COMMAND parses a bare name and a name with args, verbatim", () => {
	assert.equal(parseRunnerEnv({ ...base, PI_COMMAND: "wf" }).command, "wf");
	assert.equal(parseRunnerEnv({ ...base, PI_COMMAND: "wf run nightly" }).command, "wf run nightly");
});

test("PI_COMMAND refuses a leading slash, surrounding whitespace, and control characters -- exit 2", () => {
	// Dispatch grammar at the pin: the runner prepends "/", the name runs to the first space, and
	// EVERYTHING after -- a newline included -- becomes handler args. Each refusal below is a value
	// that would silently change what dispatches rather than fail.
	for (const bad of ["/wf", " wf", "wf ", "wf run\nnightly", "wf\trun", "wf \u001b[1m"]) {
		assert.throws(
			() => parseRunnerEnv({ ...base, PI_COMMAND: bad }),
			(e) => e.piDispatchExit === EXIT_POLICY,
			`PI_COMMAND=${JSON.stringify(bad)} must refuse pre-spend, not silently reshape the dispatch`,
		);
	}
});

test("commandName reads the string exactly as pi's dispatch will: text to the first space", () => {
	assert.equal(commandName("wf"), "wf");
	assert.equal(commandName("wf run nightly"), "wf");
});
