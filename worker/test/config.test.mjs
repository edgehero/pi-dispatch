import assert from "node:assert/strict";
import { delimiter } from "node:path";
import { test } from "node:test";
import { CHAIN_DEPTH_MAX_DEFAULT, CHAIN_MAX_PER_JOB_DEFAULT, configError, defaultGraphDir, globalExtensionsEnabled, loadConfig, loadGitLabAuth, normalizeAppPrivateKey } from "../src/config.mjs";
import { FORGES, FORGE_KINDS } from "../src/forges.mjs";

test("loads conservative defaults with an empty-ish env", () => {
	const c = loadConfig({});
	assert.equal(c.concurrency, 3);
	assert.equal(c.dailyCap, 25);
	assert.equal(c.weeklyCap, null, "the weekly ceiling defaults to disabled");
	assert.equal(c.monthlyCap, null, "the monthly ceiling defaults to disabled");
	assert.equal(c.softHoldPct, null, "the soft-hold band defaults to disabled");
	assert.equal(c.maxTokens, null, "the per-job token budget defaults to disabled");
	assert.equal(c.dailyTokenCap, null, "the daily token cap defaults to disabled");
	assert.equal(c.provider, "anthropic");
	assert.equal(c.model, "claude-sonnet-4-5-20250929"); // dated, deterministic
	assert.equal(c.maxTurns, 30);
	assert.equal(c.valkeyUrl, "redis://127.0.0.1:6379");
	assert.equal(c.jobImage, "pi-job:latest");
	assert.ok(c.jobsDir.length > 0);
	assert.equal(c.triggersFile, null);
	assert.equal(c.schedulerStallMax, 2);
	assert.ok(c.logsDir.endsWith("/pi-dispatch/logs"), c.logsDir);
	assert.equal(c.captureJobLogs, false);
	assert.equal(c.logRetentionDays, 30);
});

test("AI-trigger / chaining knobs default conservatively", () => {
	const c = loadConfig({});
	assert.equal(c.chainDepthMax, 1);
	assert.equal(c.chainMaxPerJob, 2);
	assert.equal(c.dispatchRunPerHour, 3);
	assert.deepEqual(c.dispatchRunRoots, []);
});

test("defaultGraphDir is the worker-owned temp path, beside logs/ and jobs/, never inside logsDir", () => {
	// NOT logsDir on purpose: INT-RUN-HISTORY-FILE-CONTRACT names that directory's filename shape,
	// and a stray .html beside the sidecars would widen a contract for a file that is not a record.
	assert.equal(defaultGraphDir({ TMPDIR: "/t" }), "/t/pi-dispatch/graph");
	assert.equal(defaultGraphDir({ TEMP: "C:\\Temp" }), "C:/Temp/pi-dispatch/graph", "backslashes normalise like the sibling defaults");
	assert.equal(defaultGraphDir({}), "/tmp/pi-dispatch/graph");
	assert.ok(!defaultGraphDir({}).includes("/logs"), "never inside the run-history directory");
});

test("the exported chain-cap defaults are the literals loadConfig uses (issue #54)", () => {
	// The admin's resolvePaths imports these so the graph never states a cap the worker does not
	// enforce. The literal assertions beside the loadConfig ones make widening either a reviewed edit:
	// change a number here on purpose and say why in the commit body.
	assert.equal(CHAIN_DEPTH_MAX_DEFAULT, 1);
	assert.equal(CHAIN_MAX_PER_JOB_DEFAULT, 2);
	const c = loadConfig({});
	assert.equal(c.chainDepthMax, CHAIN_DEPTH_MAX_DEFAULT);
	assert.equal(c.chainMaxPerJob, CHAIN_MAX_PER_JOB_DEFAULT);
});

test("chaining / dispatch knobs take explicit values", () => {
	const c = loadConfig({ PI_CHAIN_DEPTH_MAX: "3", PI_CHAIN_MAX_PER_JOB: "5", PI_DISPATCH_RUN_PER_HOUR: "10" });
	assert.equal(c.chainDepthMax, 3);
	assert.equal(c.chainMaxPerJob, 5);
	assert.equal(c.dispatchRunPerHour, 10);
});

test("chaining / dispatch knobs accept 0 as a kill-switch (nonNegativeInt)", () => {
	const c = loadConfig({ PI_CHAIN_DEPTH_MAX: "0", PI_CHAIN_MAX_PER_JOB: "0", PI_DISPATCH_RUN_PER_HOUR: "0" });
	assert.equal(c.chainDepthMax, 0);
	assert.equal(c.chainMaxPerJob, 0);
	assert.equal(c.dispatchRunPerHour, 0);
});

test("chaining / dispatch knobs reject negatives and non-integers as config errors", () => {
	for (const name of ["PI_CHAIN_DEPTH_MAX", "PI_CHAIN_MAX_PER_JOB", "PI_DISPATCH_RUN_PER_HOUR"]) {
		for (const bad of ["-1", "abc", "1.5"]) {
			assert.throws(() => loadConfig({ [name]: bad }), (e) => e.piDispatchConfig === true, `${name}=${bad}`);
		}
	}
});

test("dispatchRunRoots splits on path.delimiter, trims, drops empties", () => {
	assert.deepEqual(loadConfig({ PI_DISPATCH_RUN_ROOTS: ["/srv/a", "/srv/b"].join(delimiter) }).dispatchRunRoots, ["/srv/a", "/srv/b"]);
	assert.deepEqual(
		loadConfig({ PI_DISPATCH_RUN_ROOTS: `  /srv/a ${delimiter}${delimiter} /srv/b  ` }).dispatchRunRoots,
		["/srv/a", "/srv/b"],
	);
});

test("dispatchRunRoots defaults to [] and empty/whitespace yields [] (fail-closed)", () => {
	assert.deepEqual(loadConfig({}).dispatchRunRoots, []);
	assert.deepEqual(loadConfig({ PI_DISPATCH_RUN_ROOTS: "" }).dispatchRunRoots, []);
	assert.deepEqual(loadConfig({ PI_DISPATCH_RUN_ROOTS: `   ${delimiter}  ` }).dispatchRunRoots, []);
});

test("globalPiDir: unset is null; set-but-missing fails loud; set-and-existing returns the path", () => {
	assert.equal(loadConfig({}).globalPiDir, null);
	assert.throws(
		() => loadConfig({ PI_GLOBAL_PI_DIR: "/no/such/dir" }, { fileExists: () => false }),
		(e) => e.piDispatchConfig === true,
		"a PI_GLOBAL_PI_DIR that does not exist must refuse boot, not silently drop the operator's setup",
	);
	assert.equal(loadConfig({ PI_GLOBAL_PI_DIR: "/opt/pi-global" }, { fileExists: () => true }).globalPiDir, "/opt/pi-global");
});

test("allowGlobalExtensions is ON by default -- the operator staged those extensions, so they load", () => {
	assert.equal(loadConfig({}).allowGlobalExtensions, true, "unset means LOAD: staging is the vetting step");
	assert.equal(loadConfig({ PI_GLOBAL_ALLOW_EXTENSIONS: "" }).allowGlobalExtensions, true, "empty is unset");
	assert.equal(loadConfig({ PI_GLOBAL_ALLOW_EXTENSIONS: "1" }).allowGlobalExtensions, true, "the legacy arming value still reads as ON");
});

test('allowGlobalExtensions: the exact string "0" is the opt-out', () => {
	assert.equal(loadConfig({ PI_GLOBAL_ALLOW_EXTENSIONS: "0" }).allowGlobalExtensions, false);
	assert.equal(globalExtensionsEnabled({ PI_GLOBAL_ALLOW_EXTENSIONS: "0" }), false, "the exported reading doctor uses agrees");
	assert.equal(globalExtensionsEnabled({}), true);
});

test("a malformed PI_GLOBAL_ALLOW_EXTENSIONS refuses boot -- it must never silently keep extensions loading", () => {
	// The strict parse is unchanged; what it protects has flipped. `false` is the value an operator writes
	// when they mean OFF, and a lenient read would leave their extensions running in every container while
	// they believed otherwise. Loud beats either default here.
	for (const bad of ["false", "true", "yes", "no", "2", " 0", "0 ", "off"]) {
		assert.throws(
			() => loadConfig({ PI_GLOBAL_ALLOW_EXTENSIONS: bad }),
			(e) => e.piDispatchConfig === true && /PI_GLOBAL_ALLOW_EXTENSIONS/.test(e.message),
			`PI_GLOBAL_ALLOW_EXTENSIONS=${JSON.stringify(bad)}`,
		);
	}
});

test("forwardEnv is a comma list of names -- trimmed, empties dropped, default []", () => {
	assert.deepEqual(loadConfig({}).forwardEnv, []);
	assert.deepEqual(loadConfig({ PI_FORWARD_ENV: "MY_KEY, OTHER ,,THIRD" }).forwardEnv, ["MY_KEY", "OTHER", "THIRD"]);
});

test("forwardEnv refuses GITHUB_TOKEN and GH_TOKEN at boot -- a forwarded operator token would override the mint", () => {
	for (const bad of ["GH_TOKEN", "GITHUB_TOKEN", "FOO,GH_TOKEN"]) {
		assert.throws(
			() => loadConfig({ PI_FORWARD_ENV: bad }),
			(e) => e.piDispatchConfig === true && /CONST-TOKEN-SCOPED-PER-JOB/.test(e.message),
			`PI_FORWARD_ENV=${bad}`,
		);
	}
});

test("forwardEnv refuses the App signing key -- worse in a container than the token it would mint", () => {
	for (const bad of ["GITHUB_APP_PRIVATE_KEY", "FOO,GITHUB_APP_PRIVATE_KEY,BAR"]) {
		assert.throws(
			() => loadConfig({ PI_FORWARD_ENV: bad }),
			(e) => e.piDispatchConfig === true && /every repository the App is installed on/.test(e.message),
			`PI_FORWARD_ENV=${bad}`,
		);
	}
	// The PATH is deliberately still forwardable: a path string with no mount behind it is inert in a
	// container, and a refusal that fires on harmless things stops being read.
	assert.deepEqual(loadConfig({ PI_FORWARD_ENV: "GITHUB_APP_PRIVATE_KEY_PATH" }).forwardEnv, ["GITHUB_APP_PRIVATE_KEY_PATH"]);
});

test("authFromPi defaults ON; only PI_AUTH_FROM_PI=0 forces env-only", () => {
	assert.equal(loadConfig({}).authFromPi, true, "reusing the pi login is the default — no flag needed");
	assert.equal(loadConfig({ PI_AUTH_FROM_PI: "1" }).authFromPi, true);
	assert.equal(loadConfig({ PI_AUTH_FROM_PI: "0" }).authFromPi, false, "explicit 0 forces env-only (fail-loud on a missing env key)");
	assert.equal(loadConfig({ PI_AUTH_FROM_PI: "yes" }).authFromPi, true, "any non-0 value keeps the default on");
});

test("run-history env overrides logsDir, captureJobLogs, and logRetentionDays", () => {
	const c = loadConfig({ PI_LOGS_DIR: "/x", PI_CAPTURE_JOB_LOGS: "1", PI_LOG_RETENTION_DAYS: "7" });
	assert.equal(c.logsDir, "/x");
	assert.equal(c.captureJobLogs, true);
	assert.equal(c.logRetentionDays, 7);
});

test("logsDir uses || so an empty PI_LOGS_DIR falls back to the default", () => {
	const c = loadConfig({ PI_LOGS_DIR: "" });
	assert.ok(c.logsDir.endsWith("/pi-dispatch/logs"), c.logsDir);
});

test("captureJobLogs is strict: only \"1\" enables it, everything else stays off", () => {
	for (const off of ["0", "true", "yes", "", undefined]) {
		const c = loadConfig(off === undefined ? {} : { PI_CAPTURE_JOB_LOGS: off });
		assert.equal(c.captureJobLogs, false, `PI_CAPTURE_JOB_LOGS=${JSON.stringify(off)}`);
	}
});

test("logRetentionDays accepts 0 (keep forever)", () => {
	const c = loadConfig({ PI_LOG_RETENTION_DAYS: "0" });
	assert.equal(c.logRetentionDays, 0);
});

test("logRetentionDays rejects negative and non-integer values as config errors", () => {
	for (const bad of ["-1", "abc", "1.5"]) {
		assert.throws(
			() => loadConfig({ PI_LOG_RETENTION_DAYS: bad }),
			(e) => e.piDispatchConfig === true,
			`PI_LOG_RETENTION_DAYS=${bad}`,
		);
	}
});

test("positiveInt is unchanged: a spend var of 0 still throws", () => {
	assert.throws(() => loadConfig({ PI_DAILY_CAP: "0" }), (e) => e.piDispatchConfig === true);
});

test("weekly/monthly ceilings take explicit positive values, and absence is disabled (null)", () => {
	const c = loadConfig({ PI_WEEKLY_CAP: "100", PI_MONTHLY_CAP: "400" });
	assert.equal(c.weeklyCap, 100);
	assert.equal(c.monthlyCap, 400);
	// empty string is also "disabled", not a parse error
	assert.equal(loadConfig({ PI_WEEKLY_CAP: "" }).weeklyCap, null);
});

test("weekly/monthly ceilings reject 0, negatives, and non-integers as config errors", () => {
	for (const name of ["PI_WEEKLY_CAP", "PI_MONTHLY_CAP"]) {
		for (const bad of ["0", "-1", "abc", "1.5"]) {
			assert.throws(() => loadConfig({ [name]: bad }), (e) => e.piDispatchConfig === true, `${name}=${bad}`);
		}
	}
});

test("soft-hold pct takes 1-99, defaults to disabled, and rejects out-of-range or non-integer", () => {
	assert.equal(loadConfig({ PI_SOFT_HOLD_PCT: "80" }).softHoldPct, 80);
	assert.equal(loadConfig({ PI_SOFT_HOLD_PCT: "1" }).softHoldPct, 1);
	assert.equal(loadConfig({ PI_SOFT_HOLD_PCT: "99" }).softHoldPct, 99);
	assert.equal(loadConfig({}).softHoldPct, null);
	assert.equal(loadConfig({ PI_SOFT_HOLD_PCT: "" }).softHoldPct, null);
	for (const bad of ["0", "100", "-5", "abc", "50.5"]) {
		assert.throws(() => loadConfig({ PI_SOFT_HOLD_PCT: bad }), (e) => e.piDispatchConfig === true, `PI_SOFT_HOLD_PCT=${bad}`);
	}
});

test("token controls take explicit positive values, default to disabled, and reject bad values", () => {
	const c = loadConfig({ PI_MAX_TOKENS: "500000", PI_DAILY_TOKEN_CAP: "20000000" });
	assert.equal(c.maxTokens, 500000, "per-job token budget from env");
	assert.equal(c.dailyTokenCap, 20000000, "daily token cap from env");
	assert.equal(loadConfig({}).maxTokens, null, "absence disables the per-job token budget");
	assert.equal(loadConfig({ PI_DAILY_TOKEN_CAP: "" }).dailyTokenCap, null, "empty string is disabled, not an error");
	for (const name of ["PI_MAX_TOKENS", "PI_DAILY_TOKEN_CAP"]) {
		for (const bad of ["0", "-1", "abc", "1.5"]) {
			assert.throws(() => loadConfig({ [name]: bad }), (e) => e.piDispatchConfig === true, `${name}=${bad}`);
		}
	}
});

test("env overrides every field", () => {
	const c = loadConfig({
		VALKEY_URL: "redis://valkey:6379",
		PI_CONCURRENCY: "6",
		PI_DAILY_CAP: "100",
		PI_PROVIDER: "openai",
		PI_MODEL: "gpt-x",
		PI_MAX_TURNS: "50",
		PI_JOB_IMAGE: "pi-job:0.1.0",
		PI_JOBS_DIR: "/srv/jobs",
	});
	assert.equal(c.concurrency, 6);
	assert.equal(c.dailyCap, 100);
	assert.equal(c.provider, "openai");
	assert.equal(c.model, "gpt-x");
	assert.equal(c.jobsDir, "/srv/jobs");
});

test("a malformed integer is a config error, not a silent NaN", () => {
	for (const bad of ["0", "-1", "3.5", "abc", "3x"]) {
		assert.throws(() => loadConfig({ PI_CONCURRENCY: bad }), (e) => e.piDispatchConfig === true, `PI_CONCURRENCY=${bad}`);
	}
});

test("cap 0 is rejected -- it would fail closed, and is more likely a typo than intent", () => {
	assert.throws(() => loadConfig({ PI_DAILY_CAP: "0" }), (e) => e.piDispatchConfig === true);
});

test("scheduler stall max 0 is rejected -- a 0 threshold would fail closed", () => {
	assert.throws(() => loadConfig({ PI_SCHEDULER_STALL_MAX: "0" }), (e) => e.piDispatchConfig === true);
});

test("scheduler stall max non-integer is a config error, not a silent NaN", () => {
	assert.throws(() => loadConfig({ PI_SCHEDULER_STALL_MAX: "abc" }), (e) => e.piDispatchConfig === true);
});

test("triggers file is honored verbatim -- no default path, null means cron disabled", () => {
	const c = loadConfig({ PI_TRIGGERS_FILE: "/abs/x.json" });
	assert.equal(c.triggersFile, "/abs/x.json");
});

test("configError is tagged for clean CLI reporting", () => {
	assert.equal(configError("x").piDispatchConfig, true);
});

test("github auth defaults to gh source with no extra required vars", () => {
	const c = loadConfig({});
	assert.equal(c.github.source, "gh");
	assert.equal(c.github.patVar, "GITHUB_PAT");
});

test("source=pat with empty or absent PAT is a config error", () => {
	assert.throws(
		() => loadConfig({ GITHUB_AUTH_SOURCE: "pat" }),
		(e) => e.piDispatchConfig === true,
	);
	assert.throws(
		() => loadConfig({ GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "   " }),
		(e) => e.piDispatchConfig === true,
	);
});

test("source=pat with a non-empty PAT parses and echoes patVar", () => {
	const c = loadConfig({ GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_x" });
	assert.equal(c.github.source, "pat");
	assert.equal(c.github.patVar, "GITHUB_PAT");
});

test("unknown GITHUB_AUTH_SOURCE is a config error", () => {
	assert.throws(
		() => loadConfig({ GITHUB_AUTH_SOURCE: "oauth" }),
		(e) => e.piDispatchConfig === true,
	);
});

test("source=app missing installationId or privateKeyPath is a config error", () => {
	assert.throws(
		() => loadConfig({ GITHUB_AUTH_SOURCE: "app", GITHUB_APP_ID: "1", GITHUB_APP_PRIVATE_KEY_PATH: "/k.pem" }),
		(e) => e.piDispatchConfig === true,
	);
	assert.throws(
		() => loadConfig({ GITHUB_AUTH_SOURCE: "app", GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "2" }),
		(e) => e.piDispatchConfig === true,
	);
});

test("source=app with all vars present but a missing key file is a config error", () => {
	assert.throws(
		() =>
			loadConfig(
				{
					GITHUB_AUTH_SOURCE: "app",
					GITHUB_APP_ID: "1",
					GITHUB_APP_INSTALLATION_ID: "2",
					GITHUB_APP_PRIVATE_KEY_PATH: "/nope.pem",
				},
				{ fileExists: () => false },
			),
		(e) => e.piDispatchConfig === true,
	);
});

// -- the App key as a VALUE (issue #208) ---------------------------------------------------------------
//
// A deployment fed by a secrets manager can supply every other secret as an environment value; the App
// key was the one that had to be a file (docs/secrets.md). These pin the contract: exactly one source,
// one normalisation rule, a shape check at load, and never the key in a message.

const PEM = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAsecret\n-----END RSA PRIVATE KEY-----";
const appEnvBase = { GITHUB_AUTH_SOURCE: "app", GITHUB_APP_ID: "1", GITHUB_APP_INSTALLATION_ID: "2" };

test("source=app takes the key inline, with no key file anywhere", () => {
	const c = loadConfig({ ...appEnvBase, GITHUB_APP_PRIVATE_KEY: PEM }, { fileExists: () => false });
	assert.equal(c.github.privateKey, PEM, "carried verbatim -- real newlines need no normalising");
	assert.equal(c.github.privateKeyPath, undefined, "and no path is invented for it");
});

test("a flattened key (literal backslash-n, no real newline) is unescaped -- one unambiguous rule", () => {
	const flat = PEM.replace(/\n/g, "\\n");
	assert.ok(!flat.includes("\n"), "the fixture really is single-line");
	const c = loadConfig({ ...appEnvBase, GITHUB_APP_PRIVATE_KEY: flat }, { fileExists: () => false });
	assert.equal(c.github.privateKey, PEM, "a .env line and a manager UI both produce this shape");
});

test("both key sources set is a refusal, not a precedence rule", () => {
	assert.throws(
		() => loadConfig({ ...appEnvBase, GITHUB_APP_PRIVATE_KEY: PEM, GITHUB_APP_PRIVATE_KEY_PATH: "/k.pem" }, { fileExists: () => true }),
		(e) => e.piDispatchConfig === true && /both set/.test(e.message),
		"two places holding one signing key disagree eventually, and the winner should not be folklore",
	);
});

test("source=app with neither key source names both ways to supply it", () => {
	assert.throws(
		() => loadConfig({ ...appEnvBase }, { fileExists: () => true }),
		(e) => e.piDispatchConfig === true && /GITHUB_APP_PRIVATE_KEY_PATH \(or GITHUB_APP_PRIVATE_KEY\)/.test(e.message),
	);
});

test("an inline key that is not a PEM refuses at load, and the refusal never quotes it", () => {
	const junk = "not-a-pem-but-still-a-secret-9f3a";
	assert.throws(
		() => loadConfig({ ...appEnvBase, GITHUB_APP_PRIVATE_KEY: junk }, { fileExists: () => false }),
		(e) => e.piDispatchConfig === true && /not a PEM private key/.test(e.message) && !e.message.includes(junk),
		"a truncated paste must fail here, not at the first mint with a crypto error naming nothing",
	);
});

test("a blank inline key reads as unset, so a scaffolded .env line never shadows the path", () => {
	const c = loadConfig({ ...appEnvBase, GITHUB_APP_PRIVATE_KEY: "   ", GITHUB_APP_PRIVATE_KEY_PATH: "/k.pem" }, { fileExists: () => true });
	assert.equal(c.github.privateKey, null);
	assert.equal(c.github.privateKeyPath, "/k.pem", "the empty line is not 'both set', and does not win");
});

test("normalizeAppPrivateKey: blank is null, a real PEM is untouched, a mixed value is left alone", () => {
	assert.equal(normalizeAppPrivateKey(undefined), null);
	assert.equal(normalizeAppPrivateKey("  "), null);
	assert.equal(normalizeAppPrivateKey(PEM), PEM, "verbatim once trimmed");
	// A value that already has real newlines is NOT unescaped, even if it also contains a backslash-n:
	// the rule fires only on the unambiguous case, so nothing can mangle a key that was already correct.
	const withBoth = "-----BEGIN PRIVATE KEY-----\nline\\nstill\n-----END PRIVATE KEY-----";
	assert.equal(normalizeAppPrivateKey(withBoth), withBoth);
});

test("source=app with all vars present and key file present parses the exact block shape", () => {
	const c = loadConfig(
		{
			GITHUB_AUTH_SOURCE: "app",
			GITHUB_APP_ID: "1",
			GITHUB_APP_INSTALLATION_ID: "2",
			GITHUB_APP_PRIVATE_KEY_PATH: "/k.pem",
		},
		{ fileExists: () => true },
	);
	assert.deepEqual(c.github, {
		source: "app",
		patVar: "GITHUB_PAT",
		appId: "1",
		installationId: "2",
		privateKeyPath: "/k.pem",
		// Null because this deployment supplies the key as a FILE. Present in the shape either way, so an
		// inline deployment and a path deployment are the same object with one field swapped, and neither
		// consumer has to ask which kind it is holding.
		privateKey: null,
		// The gh-source resume escape hatch (PI_SESSIONS_ALLOW_GH_SOURCE), carried on the block so
		// makeGitHubAuth reads it without a second env lookup. False here: unset means the refusal is armed.
		allowGhResume: false,
	});
});

test("custom GITHUB_PAT_VAR reads the named env var for the PAT", () => {
	const c = loadConfig({ GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT_VAR: "MY_PAT", MY_PAT: "ghp_y" });
	assert.equal(c.github.patVar, "MY_PAT");
	assert.throws(
		() => loadConfig({ GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT_VAR: "MY_PAT" }),
		(e) => e.piDispatchConfig === true,
	);
});

test("PI_FORWARD_ENV refuses every name any forge's mint can write -- read off the table, not a copy of it", () => {
	// Forwarding one would override the per-job mint with a broader, longer-lived operator credential --
	// silently, and in the direction that matters (CONST-TOKEN-SCOPED-PER-JOB).
	//
	// The names come FROM the forge table rather than being listed here, so this test cannot pass while
	// the refusal set has fallen behind the mint. A hand-written list would keep passing on exactly the
	// four names it knew about and say nothing about a fifth.
	for (const name of FORGE_KINDS.flatMap((kind) => FORGES[kind].tokenVars)) {
		assert.throws(
			() => loadConfig({ PI_FORWARD_ENV: `SOME_KEY,${name}` }),
			(e) => e.piDispatchConfig === true && e.message.includes(name),
			`${name} must be refused at load`,
		);
	}
});

test("loadGitLabAuth is null without a token, and refuses any source other than pat", () => {
	assert.equal(loadGitLabAuth({}), null, "no token means no gitlab forge at all");
	assert.deepEqual(loadGitLabAuth({ GITLAB_TOKEN: "glpat-x" }), { source: "pat", apiUrl: "https://gitlab.com", tokenVar: "GITLAB_TOKEN" });
	assert.equal(loadGitLabAuth({ GITLAB_TOKEN: "glpat-x", GITLAB_URL: "https://gl.internal" }).apiUrl, "https://gl.internal");
	// There is no stronger source to fall back to, so naming one is a mistake worth refusing rather than
	// silently ignoring.
	assert.throws(() => loadGitLabAuth({ GITLAB_TOKEN: "glpat-x", GITLAB_AUTH_SOURCE: "app" }), (e) => e.piDispatchConfig === true);
});

// --- REQ-EGRESS-ALLOWLIST -----------------------------------------------------------------------------

test("PI_EGRESS is an opt-OUT: the bounded posture is the default, and a typo never weakens it", () => {
	// The polarity, and it is the decision rather than a detail. A control that ships off is a control
	// nobody enabled, which is the state OQ-004 spent a year in: a disclosure with a dead end at the end of
	// it. Unset, "" and "1" all mean ON -- exactly PI_GLOBAL_ALLOW_EXTENSIONS' shape, one knob over.
	assert.equal(loadConfig({}).egress, true, "unset is ON");
	assert.equal(loadConfig({ PI_EGRESS: "" }).egress, true, "empty is ON");
	assert.equal(loadConfig({ PI_EGRESS: "1" }).egress, true);
	assert.equal(loadConfig({ PI_EGRESS: "0" }).egress, false, "only an explicit 0 turns it off");
	// A typo must never silently produce the OPEN posture while an operator believes they are bounded:
	// they would then be in a worse position than one who knows they have no policy, because the belief
	// displaces the credential bound that is actually holding.
	for (const bad of ["true", "yes", "on", "2"]) {
		assert.throws(() => loadConfig({ PI_EGRESS: bad }), /PI_EGRESS must be exactly/, `${bad} must not be guessed`);
	}
});

test("the egress proxy name is overridable, and an empty value falls back rather than throwing later", () => {
	assert.equal(loadConfig({}).egressProxy, "pi-dispatch-egress-proxy");
	assert.equal(loadConfig({ PI_EGRESS_PROXY: "my-egress" }).egressProxy, "my-egress");
	assert.equal(loadConfig({ PI_EGRESS_PROXY: "" }).egressProxy, "pi-dispatch-egress-proxy", "|| not ??, like jobImage");
});

test("PI_FORWARD_ENV refuses the policy's own variables WHILE ARMED, and permits them otherwise", () => {
	// Conditional deliberately: with no policy these are an ordinary escape hatch, and docs/egress.md still
	// documents the manual form that uses them. With a policy, a forwarded value would point every job at
	// an operator's own proxy instead of the one attached to this job's network -- and would read exactly
	// like the control working, which is the failure class this file already refuses for the minted token.
	for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY"]) {
		assert.throws(
			() => loadConfig({ PI_FORWARD_ENV: name }), // armed by default now
			/must not forward .* while the egress policy is armed/,
			`${name} must be refused while the policy is armed`,
		);
		assert.deepEqual(loadConfig({ PI_EGRESS: "0", PI_FORWARD_ENV: name }).forwardEnv, [name], `${name} is fine with no policy`);
	}
});


test("the session-store bounds default to their shipped values, pinned as literals", () => {
	// LITERAL numbers, not expressions derived from the constants they pin: a test that says
	// `c.sessionMaxBytes === 8 * 1024 * 1024` is correct at every value and therefore blind to a change in
	// THAT value, which is the one thing it exists to catch.
	const c = loadConfig({});
	assert.equal(c.sessionsTtlDays, 14);
	assert.equal(c.sessionMaxBytes, 8388608);
	assert.equal(c.sessionMaxAgeDays, 0, "the conversation-age bound is OFF unless an operator chooses an age");
	assert.equal(c.sessionMaxResumeChain, 0, "and so is the chain bound");
	assert.equal(c.sessionsDir, null, "no default: unset means the feature is unavailable, not defaulted into a temp dir");
});

test("the session-store bounds take explicit values and accept their 0 sentinels", () => {
	const set = loadConfig({ PI_SESSIONS_TTL_DAYS: "7", PI_SESSION_MAX_BYTES: "1024", PI_SESSION_MAX_AGE_DAYS: "30", PI_SESSION_MAX_RESUME_CHAIN: "3" });
	assert.equal(set.sessionsTtlDays, 7);
	assert.equal(set.sessionMaxBytes, 1024);
	assert.equal(set.sessionMaxAgeDays, 30);
	assert.equal(set.sessionMaxResumeChain, 3);

	const off = loadConfig({ PI_SESSIONS_TTL_DAYS: "0", PI_SESSION_MAX_BYTES: "0", PI_SESSION_MAX_AGE_DAYS: "0", PI_SESSION_MAX_RESUME_CHAIN: "0" });
	assert.equal(off.sessionsTtlDays, 0, "0 = keep forever");
	assert.equal(off.sessionMaxBytes, 0, "0 = no cap");
	assert.equal(off.sessionMaxAgeDays, 0, "0 = no age bound");
	assert.equal(off.sessionMaxResumeChain, 0, "0 = no chain bound");
});

test("the session-store bounds reject negatives and non-integers as config errors", () => {
	for (const name of ["PI_SESSIONS_TTL_DAYS", "PI_SESSION_MAX_BYTES", "PI_SESSION_MAX_AGE_DAYS", "PI_SESSION_MAX_RESUME_CHAIN"]) {
		for (const bad of ["-1", "abc", "1.5"]) {
			assert.throws(() => loadConfig({ [name]: bad }), (e) => e.piDispatchConfig === true, `${name}=${bad}`);
		}
	}
});
