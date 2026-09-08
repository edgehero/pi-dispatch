import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTAINER_ENV_NAMES } from "../src/reserved-env.mjs";
// Static, unlike env-allowlist itself below: forges.mjs imports nothing, so it is available even on a
// box where pi-ai will not load and the rest of this file skips.
import { FORGES, FORGE_KINDS } from "../src/forges.mjs";
import { apiKeyVariable } from "../src/provider-key.mjs";

// env-allowlist imports @earendil-works/pi-ai (for findEnvKeys). That needs node >=22.19.0 and
// installed deps, so it skips on a below-floor dev box and runs in CI, where
// PI_DISPATCH_REQUIRE_WORKER_TESTS=1 turns a skip into a hard failure. A skipped security test is
// an unverified one -- the same discipline as the runner's loader tests.
let mod;
let importError;
try {
	mod = await import("../src/env-allowlist.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`env-allowlist tests are REQUIRED here but pi-ai could not import.\n${importError}`);
}
const skip = mod ? false : `pi-ai not installed (node ${process.version} < 22.19.0); CI runs these`;
const { buildContainerEnv, piProviders, providerKeyCandidates } = mod ?? {};
// pi itself, for the upstream pins below. Dynamic and guarded like the module above, for its reason: a
// static import would ERROR the whole file on a below-floor box instead of skipping it.
const findEnvKeys = mod ? (await import("@earendil-works/pi-ai/compat")).findEnvKeys : undefined;

// Save, clear and restore a set of variables around a test, so a pin about presence cannot be decided by
// the developer's shell. pi's getProviderEnvValue reads the real process.env for any name the given env
// lacks, so this is the only way an absence assertion means anything here.
function withoutEnv(names) {
	const saved = Object.fromEntries(names.map((n) => [n, Object.hasOwn(process.env, n) ? process.env[n] : undefined]));
	for (const n of names) delete process.env[n];
	return () => {
		for (const [n, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[n];
			else process.env[n] = v;
		}
	};
}

const HOST = {
	ANTHROPIC_API_KEY: "sk-ant-real",
	OPENAI_API_KEY: "sk-openai-real",
	// The stray host variable no-broad-env-into-container exists to defend against:
	AWS_SECRET_ACCESS_KEY: "must-not-leak",
	HOME: "/root",
	PATH: "/usr/bin",
};

// pi's own `findEnvKeys`, pinned DIRECTLY rather than through a wrapper of ours. It used to be reached
// through an exported `providerKeyVars`, which issue #309 deleted: every caller it ever had was asking it
// the wrong question, and an exported helper that answers a subtly wrong question does not stay uncalled.
// The upstream facts it encoded are still worth pinning at the pin, so they moved here, and they are now
// hermetic, which they were not: `HOST` carries no google key but this machine may export one, so the
// google case read the developer's shell.
test("pi's findEnvKeys filters its list by presence, in precedence order", { skip }, () => {
	// `withoutEnv` around the FIRST assertion too, not only the google case below. HOST deliberately carries
	// no ANTHROPIC_OAUTH_TOKEN, and pi answers absence from the real process.env, so on a developer or CI box
	// that exports one -- the very variable this cluster of issues is about, and one `.env.example` offers by
	// name -- the expectation reads ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"] and the test that pins
	// pi's presence filter becomes the one test in the file decided by the shell.
	const restore = withoutEnv(["ANTHROPIC_OAUTH_TOKEN"]);
	try {
		assert.deepEqual(findEnvKeys("anthropic", HOST), ["ANTHROPIC_API_KEY"]);
		assert.deepEqual(findEnvKeys("openai", HOST), ["OPENAI_API_KEY"]);
		// OAuth outranks API key -- the array order is the precedence.
		assert.deepEqual(findEnvKeys("anthropic", { ...HOST, ANTHROPIC_OAUTH_TOKEN: "oauth" }), ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
	} finally {
		restore();
	}
});

test("pi's findEnvKeys returns ONE undefined for two different facts, which is why we do not use it", { skip }, () => {
	// "no such provider" and "known provider, nothing set" arrive identically. providerKeyCandidates plus
	// piProviders is what tells them apart, and the conflation is the shared root of issues #286 and #309.
	const saved = withoutEnv(["GEMINI_API_KEY"]);
	try {
		assert.equal(findEnvKeys("google", HOST), undefined, "known provider, key not set here");
		assert.equal(findEnvKeys("not-a-provider-pi-has", HOST), undefined, "no such provider");
	} finally {
		saved();
	}
});

// ── providerKeyCandidates / piProviders: pi's own table, recovered (issue #286) ──────────────────

test("providerKeyCandidates recovers pi's OWN list, present or not", { skip }, () => {
	// The list `findEnvKeys` filters, before it filters -- which is what doctor needs to NAME the
	// variable an operator should set. Order is pi's precedence, OAuth first.
	assert.deepEqual(providerKeyCandidates("anthropic"), ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
	assert.deepEqual(providerKeyCandidates("openai"), ["OPENAI_API_KEY"]);
	// The drift issue #286 reports: GOOGLE_API_KEY is not a name pi reads for google, or for anything.
	assert.deepEqual(providerKeyCandidates("google"), ["GEMINI_API_KEY"]);
});

test("providerKeyCandidates is hermetic: the real process.env cannot reach it", { skip }, () => {
	// pi's getProviderEnvValue falls back to process.env for any name the injected env lacks, so the
	// difference between these two functions is a TESTED fact and not a comment. If this ever stops
	// holding, every doctor test that injects a fake env is silently reading the developer's shell.
	const before = providerKeyCandidates("anthropic");
	// BOTH anthropic variables are controlled, not just the one being set. A box that exports
	// ANTHROPIC_OAUTH_TOKEN -- any operator with a pi subscription login -- would otherwise make the
	// leak assertion below read ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"], so the test written to
	// prove hermeticity would be the one non-hermetic test in the file.
	const saved = Object.fromEntries(["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"].map((n) => [n, Object.hasOwn(process.env, n) ? process.env[n] : undefined]));
	const restore = () => {
		for (const [n, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[n];
			else process.env[n] = v;
		}
	};
	try {
		delete process.env.ANTHROPIC_OAUTH_TOKEN;
		process.env.ANTHROPIC_API_KEY = "leaked-from-the-shell";
		assert.deepEqual(providerKeyCandidates("anthropic"), before, "the candidate list ignores the host");
		// The other direction, asserted positively: pi's own findEnvKeys DOES see it, through an env that
		// carries nothing. That is why no presence test in this project may be pi's.
		assert.deepEqual(findEnvKeys("anthropic", {}), ["ANTHROPIC_API_KEY"]);
	} finally {
		restore();
	}
});

test("a provider id that is a prototype key yields no candidate, not a coerced one", { skip }, () => {
	// pi looks providers up in a plain object literal, so these resolve up the prototype chain to a
	// non-string. Doctor prints candidates in its fix line, so an unfiltered one becomes the advice
	// "set [object Object] in .env".
	for (const id of ["__proto__", "constructor", "toString"]) assert.deepEqual(providerKeyCandidates(id), [], id);
});

test("pi's catalog is NOT a superset of the ids findEnvKeys answers for", { skip }, () => {
	// The pin for the QUESTION ORDER in doctor's provider check: candidates first, catalog second.
	// `radius` is purely dynamic -- a real key variable and no catalog entry -- so asking the catalog
	// first would report a working configuration as an unknown provider.
	assert.deepEqual(providerKeyCandidates("radius"), ["PI_GATEWAY_API_KEY"]);
	assert.equal(piProviders().includes("radius"), false);
});

test("an empty candidate list means two different things, and piProviders tells them apart", { skip }, () => {
	// Known to pi, authenticates without a key variable (AWS credentials, an OAuth login): the closed
	// container env has no door for either.
	for (const id of ["amazon-bedrock", "openai-codex"]) {
		assert.deepEqual(providerKeyCandidates(id), [], id);
		assert.equal(piProviders().includes(id), true, id);
	}
	// Not a provider at all -- the second configuration issue #286 reports doctor passing.
	assert.deepEqual(providerKeyCandidates("gemini"), []);
	assert.equal(piProviders().includes("gemini"), false);
});

test("the container env is a CLOSED set: only the provider key, never the whole host", { skip }, () => {
	const env = buildContainerEnv({
		provider: "anthropic",
		model: "claude-x",
		maxTurns: 20,
		jobId: "abc",
		githubToken: "ghs_scoped",
		forgeKind: "github",
		hostEnv: HOST,
	});
	assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-real");
	assert.equal(env.GITHUB_TOKEN, "ghs_scoped");
	assert.equal(env.PI_PROVIDER, "anthropic");
	// The stray host secrets are NOT forwarded.
	assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
	assert.equal(env.HOME, undefined);
	assert.equal(env.OPENAI_API_KEY, undefined); // wrong provider's key not forwarded either
	// The closed set itself, pinned. A new name here is a change to INT-CONTAINER-RUNTIME-CONTRACT and
	// must be deliberate. Undefined-valued keys are filtered: docker-run skips them, so they reach no
	// container. PI_MAX_TOKENS and PI_PACKAGES are unset because this job has neither; PI_GLOBAL_ALLOW_EXTENSIONS
	// is absent because absent MEANS load -- the variable now exists only to carry the "0" opt-out.
	assert.deepEqual(
		Object.keys(env)
			.filter((k) => env[k] !== undefined)
			.sort(),
		[
			"ANTHROPIC_API_KEY",
			"GH_TOKEN",
			"GITHUB_TOKEN",
			"PI_JOB_ID",
			"PI_MAX_TURNS",
			"PI_MODEL",
			"PI_OFFLINE",
			"PI_PROVIDER",
			"PLAYWRIGHT_BROWSERS_PATH",
			"PLAYWRIGHT_MCP_BROWSER",
			"PLAYWRIGHT_MCP_SANDBOX",
		],
	);
});

test("a local-folder job (no token) gets NO GITHUB_TOKEN or GH_TOKEN var at all -- not an empty one", { skip }, () => {
	const env = buildContainerEnv({
		provider: "anthropic",
		model: "m",
		maxTurns: 5,
		jobId: "j",
		githubToken: undefined,
		hostEnv: HOST,
	});
	assert.ok(!("GITHUB_TOKEN" in env), "absent token must mean absent variable");
	assert.ok(!("GH_TOKEN" in env), "the mirror var is absent too, never an empty one");
});

test("the minted token is mirrored into BOTH GITHUB_TOKEN and GH_TOKEN (gh prefers GH_TOKEN)", { skip }, () => {
	const env = buildContainerEnv({
		provider: "anthropic",
		model: "m",
		maxTurns: 5,
		jobId: "j",
		githubToken: "ghs_scoped",
		forgeKind: "github",
		hostEnv: HOST,
	});
	assert.equal(env.GITHUB_TOKEN, "ghs_scoped");
	assert.equal(env.GH_TOKEN, "ghs_scoped", "gh reads GH_TOKEN first -- both must carry the same mint");
});

test("a forwarded GH_TOKEN can never override the mint -- the token assignment sits after the forward loop", { skip }, () => {
	const env = buildContainerEnv({
		provider: "anthropic",
		model: "m",
		maxTurns: 5,
		jobId: "j",
		githubToken: "minted-token",
		forgeKind: "github",
		hostEnv: { ...HOST, GH_TOKEN: "operator-token" },
		forwardEnv: ["GH_TOKEN"],
	});
	assert.equal(env.GH_TOKEN, "minted-token", "the operator token must not beat the per-job mint");
	assert.equal(env.GITHUB_TOKEN, "minted-token");
});

test("PI_MAX_TOKENS is forwarded only when the per-job budget is set", { skip }, () => {
	const withCap = buildContainerEnv({ provider: "anthropic", model: "m", maxTurns: 5, maxTokens: 500000, jobId: "j", hostEnv: HOST });
	assert.equal(withCap.PI_MAX_TOKENS, "500000", "a set cap is forwarded as a string, like PI_MAX_TURNS");

	// null/absent => undefined, which docker-run.mjs skips -> the runner attaches a pure meter, no cap.
	const noCap = buildContainerEnv({ provider: "anthropic", model: "m", maxTurns: 5, maxTokens: null, jobId: "j", hostEnv: HOST });
	assert.equal(noCap.PI_MAX_TOKENS, undefined, "an unset cap is omitted, never an empty string");
});

test("an unconfigured provider throws a config-tagged error (=> pre-spend refusal)", { skip }, () => {
	assert.throws(
		() => buildContainerEnv({ provider: "google", model: "m", maxTurns: 5, jobId: "j", hostEnv: HOST }),
		(e) => e.piDispatchConfig === true,
	);
});

test("PI_GLOBAL_ALLOW_EXTENSIONS is emitted ONLY to carry the explicit opt-out", { skip }, () => {
	const base = { provider: "anthropic", model: "m", maxTurns: 5, jobId: "j", hostEnv: HOST };
	// Absent means LOAD on both sides of the mount, so the loading case emits nothing at all.
	assert.equal(buildContainerEnv(base).PI_GLOBAL_ALLOW_EXTENSIONS, undefined, "the default is ON, and ON is the absence of the variable");
	assert.equal(buildContainerEnv({ ...base, allowGlobalExtensions: true }).PI_GLOBAL_ALLOW_EXTENSIONS, undefined, "an explicit true is the same absence");
	// The opt-out is the one thing a container must never have to infer.
	assert.equal(buildContainerEnv({ ...base, allowGlobalExtensions: false }).PI_GLOBAL_ALLOW_EXTENSIONS, "0", "PI_GLOBAL_ALLOW_EXTENSIONS=0 travels verbatim");
});

test("PI_PACKAGES is the \":\"-joined staged set, and absent when this job loads none", { skip }, () => {
	const base = { provider: "anthropic", model: "m", maxTurns: 5, jobId: "j", hostEnv: HOST };
	const staged = buildContainerEnv({ ...base, packagePaths: ["/opt/pi-global/packages/pi-playwright", "/opt/pi-global/packages/pi-lint"] });
	assert.equal(
		staged.PI_PACKAGES,
		"/opt/pi-global/packages/pi-playwright:/opt/pi-global/packages/pi-lint",
		"CONTAINER (POSIX) paths joined with \":\" -- never the host's path.delimiter, which is \";\" on Windows",
	);

	// The caller has already applied the per-trigger opt-out, so an empty list here means "this job loads
	// none" -- nothing staged, or a trigger that said run.packages: false. Either way: undefined, which
	// docker-run skips, so no -e PI_PACKAGES at all -- never an empty string.
	assert.equal(buildContainerEnv({ ...base, packagePaths: [] }).PI_PACKAGES, undefined, "an empty staged set omits the variable, never PI_PACKAGES=");
	assert.equal(buildContainerEnv(base).PI_PACKAGES, undefined, "and so does the default");
});

test("PI_OFFLINE=1 on EVERY job -- flagged and unflagged alike (a narrowing, never a capability)", { skip }, () => {
	const base = { provider: "anthropic", model: "m", maxTurns: 5, jobId: "j", hostEnv: HOST };
	assert.equal(buildContainerEnv({ ...base, packagePaths: ["/opt/pi-global/packages/pi-lint"] }).PI_OFFLINE, "1", "a packages job must not be able to reach npm install");
	assert.equal(
		buildContainerEnv(base).PI_OFFLINE,
		"1",
		"the ONE deliberate deviation from byte-identity for an unflagged job: disarming job-time installs takes nothing away that a job may have",
	);
});

test("PI_FORWARD_ENV forwards ONLY the named vars that are present, never a pass-through", { skip }, () => {
	const host = { ...HOST, MY_PROVIDER_KEY: "sk-custom", UNLISTED: "nope" };
	const env = buildContainerEnv({ provider: "anthropic", model: "m", maxTurns: 5, jobId: "j", hostEnv: host, forwardEnv: ["MY_PROVIDER_KEY", "ABSENT_VAR"] });
	assert.equal(env.MY_PROVIDER_KEY, "sk-custom", "a listed, present var is forwarded (a custom provider's key)");
	assert.equal(env.ABSENT_VAR, undefined, "a listed but unset var is skipped, never forwarded as empty");
	assert.equal(env.UNLISTED, undefined, "an unlisted host var is never forwarded");
	assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, "the stray host secret still does not ride along");
});

// --- PI_AUTH_FROM_PI: source the provider key from pi's auth.json when the env has none ---
const authBase = { provider: "anthropic", model: "m", maxTurns: 5, jobId: "j", agentDir: "/home/u/.pi/agent" };
const authReader = (json) => (p) => {
	assert.match(p, /auth\.json$/, "reads auth.json under the agent dir");
	// A real ENOENT, with the CODE set and not just the word in the message. The resolver distinguishes
	// absent (determinate) from a transient read fault (not), so a fixture that only looks absent would
	// exercise the wrong branch (issue #310).
	if (json === null) {
		const error = new Error("ENOENT: no such file or directory");
		error.code = "ENOENT";
		throw error;
	}
	return typeof json === "string" ? json : JSON.stringify(json);
};

/** A readFile that fails the way a busy or broken filesystem does, rather than the way an absent file does. */
const faultyReader = (code) => () => {
	const error = new Error(`${code}: simulated`);
	error.code = code;
	throw error;
};

test("PI_AUTH_FROM_PI injects the api key from auth.json under pi's expected var name", { skip }, () => {
	const env = buildContainerEnv({
		...authBase,
		hostEnv: { HOME: "/root" }, // no ANTHROPIC_API_KEY on the host
		authFromPi: true,
		readFile: authReader({ anthropic: { type: "api_key", key: "sk-from-pi" } }),
	});
	assert.equal(env.ANTHROPIC_API_KEY, "sk-from-pi", "pi's own findEnvKeys resolves the var name -- no hand table");
});

test("PI_AUTH_FROM_PI: the env wins when the key is present (fallback only, auth.json never read)", { skip }, () => {
	const env = buildContainerEnv({
		...authBase,
		hostEnv: { ANTHROPIC_API_KEY: "sk-env" },
		authFromPi: true,
		readFile: () => assert.fail("auth.json must not be read when the env already has the key"),
	});
	assert.equal(env.ANTHROPIC_API_KEY, "sk-env");
});

test("PI_AUTH_FROM_PI refuses an OAuth/subscription login (pre-spend)", { skip }, () => {
	assert.throws(
		() => buildContainerEnv({ ...authBase, hostEnv: {}, authFromPi: true, readFile: authReader({ anthropic: { type: "oauth", access_token: "x" } }) }),
		(e) => e.piDispatchConfig === true && /OAuth|subscription/i.test(e.message),
	);
});

test("PI_AUTH_FROM_PI refuses when auth.json is ABSENT, with guidance", { skip }, () => {
	assert.throws(
		() => buildContainerEnv({ ...authBase, hostEnv: {}, authFromPi: true, readFile: authReader(null) }),
		(e) => e.piDispatchConfig === true && /pi login|environment/i.test(e.message),
	);
});

test("an unparseable auth.json is determinate too, and says which of the two it is", { skip }, () => {
	// The file is there and wrong, so an operator has to fix it: determinate, and the message must not say
	// "no pi login", which sends them to run a login they have already run.
	assert.throws(
		() => buildContainerEnv({ ...authBase, hostEnv: {}, authFromPi: true, readFile: authReader("{not json") }),
		(e) => e.piDispatchConfig === true && /not valid JSON/.test(e.message),
	);
});

test("a TRANSIENT read fault is NOT a config refusal -- it propagates as itself", { skip }, () => {
	// Issue #310 made this expensive. A config-tagged error is now never retried, refunds the reserve, and
	// tells the issue author publicly that the deployment is misconfigured. Under the old bare `catch {}`
	// every one of these produced that verdict on a deployment that was correctly configured a microsecond
	// earlier and later: fd exhaustion, a network-filesystem blip, a permission fault, a directory in the
	// file's place, or a torn read while `pi login` rewrites the file.
	for (const code of ["EMFILE", "EIO", "EACCES", "EAGAIN", "EISDIR", "ETIMEDOUT"]) {
		assert.throws(
			() => buildContainerEnv({ ...authBase, hostEnv: {}, authFromPi: true, readFile: faultyReader(code) }),
			(e) => e.piDispatchConfig === undefined && e.code === code,
			`${code} must propagate as itself, not as a determinate refusal`,
		);
	}
});

test("without PI_AUTH_FROM_PI, a missing env key still refuses and auth.json is never consulted", { skip }, () => {
	assert.throws(
		() => buildContainerEnv({ ...authBase, hostEnv: {}, authFromPi: false, readFile: () => assert.fail("must not read auth.json when PI_AUTH_FROM_PI is off") }),
		(e) => e.piDispatchConfig === true,
	);
});

// --- Issue #311: the variable an auth.json login is injected under is pi's, for every provider ---

test("a key variable pi reports present but this env does not carry falls through to auth.json", { skip }, () => {
	// pi's `findEnvKeys` presence test falls back to the real process.env, deliberately on pi's side (the
	// test above asserts it). Reading the VALUE from the same place is
	// what would be wrong: the old code took the env path on such a name and returned { NAME: undefined },
	// so a host that merely exported a variable defeated a working `pi login` and the job reached the
	// provider with no credential.
	const had = Object.hasOwn(process.env, "GEMINI_API_KEY");
	const before = process.env.GEMINI_API_KEY;
	process.env.GEMINI_API_KEY = "gemini-on-this-host";
	try {
		const env = buildContainerEnv({
			...authBase,
			provider: "google",
			hostEnv: { HOME: "/root" }, // the env this deployment was actually handed
			authFromPi: true,
			readFile: authReader({ google: { type: "api_key", key: "sk-from-pi" } }),
		});
		assert.equal(env.GEMINI_API_KEY, "sk-from-pi", "the auth.json login is used, not the ambient name");
	} finally {
		if (had) process.env.GEMINI_API_KEY = before;
		else delete process.env.GEMINI_API_KEY;
	}
});

test("PI_AUTH_FROM_PI resolves a provider whose variable does not follow the convention", { skip }, () => {
	// The whole defect in one case: `google` reads GEMINI_API_KEY, so the old hand-built candidates
	// (GOOGLE_API_KEY, GOOGLE_KEY) matched nothing pi recognizes and a valid `pi login` threw
	// "could not determine the environment variable pi expects".
	const env = buildContainerEnv({
		...authBase,
		provider: "google",
		hostEnv: { HOME: "/root" },
		authFromPi: true,
		readFile: authReader({ google: { type: "api_key", key: "sk-google" } }),
	});
	assert.equal(env.GEMINI_API_KEY, "sk-google");
	assert.equal(env.GOOGLE_API_KEY, undefined, "the conventional name is not one pi reads for google");
});

test("PI_AUTH_FROM_PI resolves huggingface, whose variable shares no stem with its provider id", { skip }, () => {
	const env = buildContainerEnv({
		...authBase,
		provider: "huggingface",
		hostEnv: { HOME: "/root" },
		authFromPi: true,
		readFile: authReader({ huggingface: { type: "api_key", key: "hf-token" } }),
	});
	assert.equal(env.HF_TOKEN, "hf-token");
});

test("an auth.json api key is NEVER injected under the OAuth token variable, host env or not", { skip }, () => {
	// Two properties in one test, because they are the same line of code.
	// pi's precedence for anthropic is [ANTHROPIC_OAUTH_TOKEN, ANTHROPIC_API_KEY], so taking pi's first
	// candidate would write an api_key credential under the subscription-login name -- the variable doctor
	// refuses to name, for the same reason.
	// And the old resolver's synthetic environment was a plain object, while pi's getProviderEnvValue falls
	// back to the REAL process.env: with ANTHROPIC_OAUTH_TOKEN exported here, it resolved to that name. The
	// candidate list is now asked against a proxy where every name is present, so the host cannot reach in.
	const had = Object.hasOwn(process.env, "ANTHROPIC_OAUTH_TOKEN");
	const before = process.env.ANTHROPIC_OAUTH_TOKEN;
	process.env.ANTHROPIC_OAUTH_TOKEN = "oauth-on-this-host";
	try {
		const env = buildContainerEnv({
			...authBase,
			hostEnv: { HOME: "/root" },
			authFromPi: true,
			readFile: authReader({ anthropic: { type: "api_key", key: "sk-from-pi" } }),
		});
		assert.equal(env.ANTHROPIC_API_KEY, "sk-from-pi");
		assert.equal(env.ANTHROPIC_OAUTH_TOKEN, undefined, "the api key must not ride the OAuth variable");
	} finally {
		if (had) process.env.ANTHROPIC_OAUTH_TOKEN = before;
		else delete process.env.ANTHROPIC_OAUTH_TOKEN;
	}
});

test("a pi login stored as a command or a variable reference is refused, not forwarded", { skip }, () => {
	// pi reads auth.json through `resolveConfigValue`: a leading "!" runs the rest as a shell command and
	// takes stdout, "$VAR" interpolates. An ENV variable is read raw, through no such grammar, so forwarding
	// the source text hands the container a string that is not a key. doctor saw a non-empty string and went
	// green, so this was a container spent per job with nothing to show. Refusing costs nothing.
	for (const key of ["!op read op://vault/pi/anthropic --no-newline", "$ANTHROPIC_API_KEY", "${SOME_VAR}", "sk-$$-literal"]) {
		assert.throws(
			() => buildContainerEnv({ ...authBase, hostEnv: { HOME: "/root" }, authFromPi: true, readFile: authReader({ anthropic: { type: "api_key", key } }) }),
			(e) => e.piDispatchConfig === true && /command or a variable reference/.test(e.message),
			`refused: ${key}`,
		);
	}
	// The other direction: a literal key with neither character still resolves.
	const env = buildContainerEnv({ ...authBase, hostEnv: { HOME: "/root" }, authFromPi: true, readFile: authReader({ anthropic: { type: "api_key", key: "sk-ant-plain" } }) });
	assert.equal(env.ANTHROPIC_API_KEY, "sk-ant-plain");
});

test("a non-string key in auth.json is refused instead of coerced into the container env", { skip }, () => {
	// pi validates no schema on auth.json, so a hand edit can leave a number, an array or an object here.
	// The old guard was `!cred.key`, which all three pass: an object reached a paid container as
	// `-e ANTHROPIC_API_KEY=[object Object]`.
	for (const key of [{ a: 1 }, ["sk-x"], 12345, true]) {
		assert.throws(
			() => buildContainerEnv({ ...authBase, hostEnv: { HOME: "/root" }, authFromPi: true, readFile: authReader({ anthropic: { type: "api_key", key } }) }),
			(e) => e.piDispatchConfig === true && /does not hold a string API key/.test(e.message),
			`refused: ${JSON.stringify(key)}`,
		);
	}
});

test("a credential whose companion settings cannot reach the container is refused, unless they are forwarded", { skip }, () => {
	// `cred.env` is provider CONFIG, not a variable-name hint. pi's cloudflare auth returns NO auth at all
	// without CLOUDFLARE_ACCOUNT_ID, and the container env is a closed set, so the key alone is a container
	// spent to fail. pi does fall back to the ambient environment for these, which makes PI_FORWARD_ENV a
	// real fix rather than a shrug, so the refusal is scoped to the names that will not arrive.
	const login = { "cloudflare-workers-ai": { type: "api_key", key: "cf-key", env: { CLOUDFLARE_ACCOUNT_ID: "acct-1" } } };
	assert.throws(
		() => buildContainerEnv({ ...authBase, provider: "cloudflare-workers-ai", hostEnv: { HOME: "/root" }, authFromPi: true, readFile: authReader(login) }),
		(e) => e.piDispatchConfig === true && /CLOUDFLARE_ACCOUNT_ID/.test(e.message) && /PI_FORWARD_ENV/.test(e.message),
	);
	// Forwarded and present on the host: the deployment already works, so nothing is refused.
	const env = buildContainerEnv({
		...authBase,
		provider: "cloudflare-workers-ai",
		hostEnv: { HOME: "/root", CLOUDFLARE_ACCOUNT_ID: "acct-1" },
		forwardEnv: ["CLOUDFLARE_ACCOUNT_ID"],
		authFromPi: true,
		readFile: authReader(login),
	});
	assert.equal(env.CLOUDFLARE_API_KEY, "cf-key");
	assert.equal(env.CLOUDFLARE_ACCOUNT_ID, "acct-1");
	// Listed but absent on the host is still a refusal: PI_FORWARD_ENV only forwards what the host holds.
	assert.throws(
		() => buildContainerEnv({ ...authBase, provider: "cloudflare-workers-ai", hostEnv: { HOME: "/root" }, forwardEnv: ["CLOUDFLARE_ACCOUNT_ID"], authFromPi: true, readFile: authReader(login) }),
		(e) => e.piDispatchConfig === true && /CLOUDFLARE_ACCOUNT_ID/.test(e.message),
	);
});

test("a provider pi authenticates without a key variable is told so, not told to set one", { skip }, () => {
	// Two facts behind one old message. doctor already splits them and says an AWS profile or an OAuth
	// login "has no way in"; the worker said "set it in the worker environment manually" for both, which
	// for this half is advice to do the thing doctor calls impossible. Candidates first, catalog second.
	assert.throws(
		() => buildContainerEnv({ ...authBase, provider: "amazon-bedrock", hostEnv: {}, authFromPi: true, readFile: authReader({ "amazon-bedrock": { type: "api_key", key: "sk-x" } }) }),
		(e) => e.piDispatchConfig === true && /without an API-key environment variable/.test(e.message) && !/set it in the worker environment/.test(e.message),
	);
});

test("a provider pi reads no key variable for still refuses, rather than guessing a name", { skip }, () => {
	// The refusal this change must NOT remove. `gemini` is not a provider pi has (that is #286's other
	// half), so there is no variable to name and a guess would inject a key nothing reads.
	assert.throws(
		() =>
			buildContainerEnv({
				...authBase,
				provider: "gemini",
				hostEnv: {},
				authFromPi: true,
				readFile: authReader({ gemini: { type: "api_key", key: "sk-x" } }),
			}),
		(e) => e.piDispatchConfig === true && /could not determine the environment variable/.test(e.message),
	);
});

test("a prototype-key provider id refuses instead of coercing a name out of pi's lookup", { skip }, () => {
	// pi looks its provider up in a plain object literal, so `__proto__` resolves up the prototype chain
	// and hands back a non-string. providerKeyCandidates filters those out, which leaves an empty list,
	// which is a refusal. Without that filter this would build an env key named "[object Object]".
	//
	// The fixture is a RAW STRING, and that is the whole test. Written as the object literal
	// `{ __proto__: { ... } }` it sets the prototype instead of an own property, so `JSON.stringify` emits
	// "{}", `auth.__proto__` resolves to `Object.prototype`, and the refusal arrives from the
	// `cred.type !== "api_key"` guard three lines earlier without ever reaching the name resolution. That
	// version passed while the string filter was deleted. `JSON.parse` of the same text DOES create an own
	// data property, so this reaches the code the comment is about, and the assertion names the message.
	assert.throws(
		() =>
			buildContainerEnv({
				...authBase,
				provider: "__proto__",
				hostEnv: {},
				authFromPi: true,
				readFile: authReader('{"__proto__":{"type":"api_key","key":"sk-x"}}'),
			}),
		(e) => e.piDispatchConfig === true && /could not determine the environment variable/.test(e.message),
	);
});

test("the write path goes through the shared selection, and never lands on an OAuth variable", { skip }, () => {
	// What this pins, stated honestly: that `resolveEnvName` routes through `apiKeyVariable`, and that the
	// variable the credential lands under is one pi actually reads and is never a subscription login.
	// It does NOT pin agreement with doctor: it computes the expectation with the same function the code
	// uses, so a doctor that stopped calling `apiKeyVariable` leaves this green. `doctor.test.mjs` carries
	// that bolt, where doctor's real output is available to compare against. CLAUDE.md's rule is to say so
	// rather than manufacture the relation.
	//
	// The loop's real content is `anthropic`, the only id in pi's table with more than one candidate; for
	// the other 33 `apiKeyVariable(c) === c[0]` trivially and the assertion degrades to "an injection
	// happened". That is still worth running: it is the sweep that would catch a new multi-candidate
	// provider appearing in a pi bump.
	let multiCandidate = 0;
	for (const id of [...piProviders(), "radius"]) {
		const candidates = providerKeyCandidates(id);
		if (candidates.length === 0) continue; // no key variable at all: the worker refuses, tested above
		if (candidates.length > 1) multiCandidate += 1;
		const expected = apiKeyVariable(candidates);
		const env = buildContainerEnv({
			...authBase,
			provider: id,
			hostEnv: { HOME: "/root" },
			authFromPi: true,
			readFile: authReader({ [id]: { type: "api_key", key: `sk-${id}` } }),
		});
		assert.equal(env[expected], `sk-${id}`, `${id}: injected under ${expected}`);
		assert.ok(candidates.includes(expected), `${id}: ${expected} is a name pi reads`);
		assert.ok(!/_OAUTH_TOKEN$/.test(expected), `${id}: ${expected} is not a subscription login`);
		assert.equal(Object.keys(env).filter((k) => env[k] === `sk-${id}`).length, 1, `${id}: the key lands in exactly one variable`);
	}
	assert.equal(multiCandidate, 1, "anthropic is still the only provider whose choice is a real choice");
});

test("PI_FORWARD_ENV cannot blank the provider credential with an empty host value", { skip }, () => {
	// The forward loop runs AFTER the credential assign, and its guard was `!== undefined`, so a name listed
	// in PI_FORWARD_ENV and set to "" on the host overwrote a working auth.json credential with an empty
	// string. docker-run skips `undefined` but not `""`, so the container started with `-e NAME=` and every
	// job of that deployment spent a container to fail auth. The loop's own comment already promised this.
	const env = buildContainerEnv({
		...authBase,
		provider: "google",
		hostEnv: { HOME: "/root", GEMINI_API_KEY: "" },
		forwardEnv: ["GEMINI_API_KEY"],
		authFromPi: true,
		readFile: authReader({ google: { type: "api_key", key: "sk-from-pi" } }),
	});
	assert.equal(env.GEMINI_API_KEY, "sk-from-pi");
});

test("a gitlab job's token lands in GITLAB_TOKEN/GL_TOKEN and NEVER in the github names", () => {
	// A GitLab credential exported as GITHUB_TOKEN would be sent by `gh` to github.com on the agent's
	// first invocation: a working credential handed to the wrong host, which is how a scoped token stops
	// being scoped.
	const env = buildContainerEnv({
		provider: "anthropic",
		model: "m",
		maxTurns: 5,
		jobId: "j1",
		githubToken: "glpat-secret",
		forgeKind: "gitlab",
		forgeHosts: { gitlab: "https://gl.internal" },
		hostEnv: { ANTHROPIC_API_KEY: "k" },
	});
	assert.equal(env.GITLAB_TOKEN, "glpat-secret");
	assert.equal(env.GL_TOKEN, "glpat-secret", "glab prefers GL_TOKEN; mirroring forecloses a precedence surprise");
	assert.equal(env.GITLAB_HOST, "https://gl.internal", "so glab talks to the operator's instance, not gitlab.com");
	assert.equal("GITHUB_TOKEN" in env, false);
	assert.equal("GH_TOKEN" in env, false);
});

test("a github job is unchanged: the github names only, and no gitlab ones", () => {
	const env = buildContainerEnv({
		provider: "anthropic",
		model: "m",
		maxTurns: 5,
		jobId: "j1",
		githubToken: "ghs_x",
		forgeKind: "github",
		hostEnv: { ANTHROPIC_API_KEY: "k" },
	});
	assert.equal(env.GITHUB_TOKEN, "ghs_x");
	assert.equal(env.GH_TOKEN, "ghs_x");
	for (const name of ["GITLAB_TOKEN", "GL_TOKEN", "GITLAB_HOST"]) assert.equal(name in env, false);
});

test("a local run.github job still gets the github names -- the opt-in names github explicitly", () => {
	const env = buildContainerEnv({
		provider: "anthropic",
		model: "m",
		maxTurns: 5,
		jobId: "j1",
		githubToken: "ghs_x",
		forgeKind: "local",
		hostEnv: { ANTHROPIC_API_KEY: "k" },
	});
	assert.equal(env.GH_TOKEN, "ghs_x");
	assert.equal("GITLAB_TOKEN" in env, false);
});

test("PI_SESSION_FILE is emitted only when the job has a transcript, and never as an empty string", { skip }, async () => {
	const args = { provider: "anthropic", model: "m", maxTurns: 10, jobId: "j", hostEnv: HOST };

	// Absent means pi's ephemeral in-memory session -- every job before this feature, and every job whose
	// trigger did not arm run.resume. The variable is omitted entirely rather than emitted empty, for
	// PI_PACKAGES' reason: an empty value is a third state the two sides of the mount need not agree on,
	// and the one reading a container must not have to infer which was meant.
	// `undefined`, not "" -- buildDockerRunArgs skips undefined/null and would pass an empty string
	// through as `-e PI_SESSION_FILE=`. Same shape as PI_MAX_TOKENS and PI_PACKAGES.
	for (const sessionFile of [undefined, null, ""]) {
		assert.equal(buildContainerEnv({ ...args, sessionFile }).PI_SESSION_FILE, undefined, `sessionFile ${JSON.stringify(sessionFile)} must not become a value`);
	}
	const { buildDockerRunArgs } = await import("../src/docker-run.mjs");
	assert.equal(
		buildDockerRunArgs({ image: "i", name: "n", workspace: "/w", env: buildContainerEnv({ ...args, sessionFile: null }) }).includes("PI_SESSION_FILE="),
		false,
		"and no -e reaches the argv at all",
	);
	assert.equal(buildContainerEnv({ ...args, sessionFile: "/session/current.jsonl" }).PI_SESSION_FILE, "/session/current.jsonl");
});

test("PI_FLOW is emitted only when the job carries a flow, and never as an empty string", { skip }, async () => {
	const args = { provider: "anthropic", model: "m", maxTurns: 10, jobId: "j", hostEnv: HOST };
	// Absent means "no flow to verify" (a bare run.task cron job) and the variable is omitted
	// entirely rather than emitted empty, for PI_PACKAGES' reason: an empty value is a third state
	// the two sides of the mount need not agree on. Same shape as PI_SESSION_FILE above.
	for (const flow of [undefined, null, ""]) {
		assert.equal(buildContainerEnv({ ...args, flow }).PI_FLOW, undefined, `flow ${JSON.stringify(flow)} must not become a value`);
	}
	// Verbatim, no charset opinion on this side either: parseTriggers already validated the reviewed
	// file, and the runner's comparison is what gives the value meaning.
	assert.equal(buildContainerEnv({ ...args, flow: "review" }).PI_FLOW, "review");
});

test("PI_COMMAND is emitted only when the job carries a command, and never as an empty string", { skip }, () => {
	const args = { provider: "anthropic", model: "m", maxTurns: 10, jobId: "j", hostEnv: HOST };
	// Mirrors PI_FLOW directly above, and for the same reasons: absent means "not a command job", and
	// the variable is omitted entirely rather than emitted empty -- an empty value is a third state the
	// two sides of the mount need not agree on.
	for (const command of [undefined, null, ""]) {
		assert.equal(buildContainerEnv({ ...args, command }).PI_COMMAND, undefined, `command ${JSON.stringify(command)} must not become a value`);
	}
	// Verbatim, args and all: parseTriggers already validated the reviewed file (trimmed, no leading
	// slash, no control chars), and the runner's registry lookup is what gives the value meaning.
	assert.equal(buildContainerEnv({ ...args, command: "wf run nightly" }).PI_COMMAND, "wf run nightly");
});

test("a job kind with no table entry refuses, rather than inheriting the github token names", { skip }, () => {
	// This was an `if gitlab / else github`, and the `else` was the hazard: any kind the table did not name
	// -- a forge wired up everywhere but here, a typo that survived validation -- got its credential
	// exported as GITHUB_TOKEN and GH_TOKEN. That is a working credential handed to the wrong host, which
	// is how a scoped token stops being scoped. Refusing costs a pre-spend config error; the alternative
	// costs the token.
	// Deliberately NOT the name of a forge that might later be added -- these are the kinds that genuinely
	// never carry a forge credential (a chained /outbox child, a CLI run) plus outright junk.
	for (const forgeKind of ["chained", "", undefined, null, 42]) {
		assert.throws(
			() =>
				buildContainerEnv({
					provider: "anthropic",
					model: "m",
					maxTurns: 5,
					jobId: "j",
					githubToken: "some-forge-token",
					forgeKind,
					hostEnv: HOST,
				}),
			(e) => e.piDispatchConfig === true,
			`kind ${JSON.stringify(forgeKind)} must refuse rather than be handed GitHub's variable names`,
		);
	}
});

test("every forge in the table mints into its OWN names and no other forge's", { skip }, () => {
	// A loop over the table rather than one case per forge, so a forge added to FORGES without a mint
	// entry fails here instead of exporting its credential under whatever name the fallback picked.
	const others = (kind) => FORGE_KINDS.filter((k) => k !== kind).flatMap((k) => FORGES[k].tokenVars);
	for (const kind of FORGE_KINDS) {
		const env = buildContainerEnv({
			provider: "anthropic",
			model: "m",
			maxTurns: 5,
			jobId: "j",
			githubToken: "minted",
			forgeKind: kind,
			hostEnv: HOST,
		});
		for (const name of FORGES[kind].tokenVars) {
			assert.equal(env[name], "minted", `${kind}: its CLI reads ${name}`);
		}
		for (const name of others(kind)) {
			assert.equal(env[name], undefined, `${kind}: must not also export ${name} -- that is another forge's host`);
		}
	}
});

// --- REQ-EGRESS-ALLOWLIST: the proxy variables ride the CLOSED map, never PI_FORWARD_ENV -------------

const egressBase = {
	provider: "anthropic",
	model: "m",
	maxTurns: 5,
	jobId: "job-1",
	forgeKind: "local",
	hostEnv: { ANTHROPIC_API_KEY: "sk-test" },
};

test("no egress policy emits NO proxy variables, so the container env is byte-identical to a pre-feature one", { skip }, () => {
	const env = mod.buildContainerEnv({ ...egressBase });
	for (const name of ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_USE_ENV_PROXY"]) {
		assert.equal(env[name], undefined, `${name} must be absent without a policy`);
	}
});

test("an armed policy emits all four, including the NODE_USE_ENV_PROXY the hand-written recipe omits", { skip }, () => {
	const env = mod.buildContainerEnv({ ...egressBase, egress: true });
	assert.equal(env.HTTPS_PROXY, "http://pi-dispatch-egress-proxy:3128");
	assert.equal(env.HTTP_PROXY, "http://pi-dispatch-egress-proxy:3128");
	assert.equal(env.NO_PROXY, "localhost,127.0.0.1");
	// The provider call follows the process's global dispatcher, and nothing installs a proxy-aware one
	// without this flag. Behind an --internal network its absence is an outage, not a leak: every job dies
	// at its first turn, exit 1 is retryable, and each one spends two budget slots to prove it.
	assert.equal(env.NODE_USE_ENV_PROXY, "1");
});

test("a PI_FORWARD_ENV entry can NEVER override the policy's own proxy variables", { skip }, () => {
	// loadConfig refuses these names outright while the policy is armed, so this is the second line rather
	// than the first. It exists because the ordering inside buildContainerEnv is what actually enforces it,
	// and an edit that moved the assignment above the forward loop would silently hand every job an
	// operator's own proxy -- which would read exactly like the control working.
	const env = mod.buildContainerEnv({
		...egressBase,
		egress: true,
		forwardEnv: ["HTTPS_PROXY", "NODE_USE_ENV_PROXY"],
		hostEnv: { ANTHROPIC_API_KEY: "sk-test", HTTPS_PROXY: "http://attacker.example:8080", NODE_USE_ENV_PROXY: "0" },
	});
	assert.equal(env.HTTPS_PROXY, "http://pi-dispatch-egress-proxy:3128", "the policy's value wins");
	assert.equal(env.NODE_USE_ENV_PROXY, "1");
});

test("the proxy is named, not hardcoded, so a deployment can run its own component", { skip }, () => {
	const env = mod.buildContainerEnv({ ...egressBase, egress: true, egressProxy: "my-egress" });
	assert.equal(env.HTTPS_PROXY, "http://my-egress:3128");
});

// --- run.secrets: resolved values enter the closed map, and lose every collision (issue #225) ---

const secretsBase = { provider: "anthropic", model: "m", maxTurns: 5, jobId: "job-1", forgeKind: "github", hostEnv: HOST };

test("resolved secrets reach the container under the operator's own names", { skip }, () => {
	const env = mod.buildContainerEnv({ ...secretsBase, secrets: { STRIPE_KEY: "sk-live-x", DB_URL: "postgres://y" } });
	assert.equal(env.STRIPE_KEY, "sk-live-x");
	assert.equal(env.DB_URL, "postgres://y");
	// And the closed set is otherwise untouched: this widens the map by exactly what the operator wrote.
	assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined, "the stray host variable still does not ride along");
});

test("omitting `secrets` leaves the env map byte-identical -- which is why the whole-map pin above still holds", { skip }, () => {
	const withKey = mod.buildContainerEnv({ ...secretsBase, secrets: {} });
	const without = mod.buildContainerEnv({ ...secretsBase });
	assert.deepEqual(Object.keys(withKey).sort(), Object.keys(without).sort());
});

test("a secret can NEVER override the minted per-job token", { skip }, () => {
	// The whole of CONST-TOKEN-SCOPED-PER-JOB defeated by a config line: a vault-supplied GITHUB_TOKEN
	// winning here hands every container a long-lived operator credential. parseTriggers refuses this name
	// at load; the ordering is the second line, and this test is what keeps the two from drifting apart.
	const env = mod.buildContainerEnv({ ...secretsBase, githubToken: "ghs_scoped", secrets: { GITHUB_TOKEN: "vault-supplied", GH_TOKEN: "vault-supplied" } });
	assert.equal(env.GITHUB_TOKEN, "ghs_scoped");
	assert.equal(env.GH_TOKEN, "ghs_scoped");
});

test("a secret can NEVER override the egress policy's proxy variables", { skip }, () => {
	// A secret named HTTPS_PROXY that won would point the job away from the proxy its --internal network
	// was built around, while reading exactly like the control working. That is an OUTAGE dressed as a
	// policy, and it is the reason the assignment sits after the egress block rather than before it.
	const env = mod.buildContainerEnv({ ...egressBase, egress: true, secrets: { HTTPS_PROXY: "http://attacker:3128", NODE_USE_ENV_PROXY: "0" } });
	assert.equal(env.HTTPS_PROXY, "http://pi-dispatch-egress-proxy:3128");
	assert.equal(env.NODE_USE_ENV_PROXY, "1");
});

test("a secret DOES outrank a same-named PI_FORWARD_ENV entry", { skip }, () => {
	// The one collision that resolves in the secret's favour, and deliberately: PI_FORWARD_ENV is the
	// operator's blanket host list, while run.secrets is the specific binding this trigger asked for.
	// Deployment-wide loses to per-trigger; both lose to the closed map.
	const env = mod.buildContainerEnv({ ...secretsBase, hostEnv: { ...HOST, SHARED: "from-host" }, forwardEnv: ["SHARED"], secrets: { SHARED: "from-vault" } });
	assert.equal(env.SHARED, "from-vault");
});

test("an empty or non-string value emits NO variable at all, never `NAME=`", { skip }, () => {
	// docker-run skips undefined but not "", so an empty string would reach the container as a set-but-blank
	// variable -- a third state neither side reads the same way, which PI_PACKAGES and PI_FLOW already refuse.
	const env = mod.buildContainerEnv({ ...secretsBase, secrets: { EMPTY: "", NUMBER: 5, NOTHING: null, GOOD: "x" } });
	assert.equal("EMPTY" in env, false);
	assert.equal("NUMBER" in env, false);
	assert.equal("NOTHING" in env, false);
	assert.equal(env.GOOD, "x");
});

test("the reserved-name list triggers.mjs refuses covers every STATIC name this map writes", { skip }, () => {
	// The drift guard. reserved-env.mjs is a hand-written list in a module with no imports (so the shared
	// validator and the admin bundle can have it for free), and a variable added to the closed map without
	// being added there would open a hole a trigger could drive through. This is the test that closes it.
	const env = mod.buildContainerEnv({ ...secretsBase, maxTokens: 100, packagePaths: ["/opt/pi-global/packages/x"], sessionFile: "/session/current.jsonl", flow: "fix", allowGlobalExtensions: false });
	const dynamic = new Set(["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GH_TOKEN"]); // provider + mint: deployment state, refused pre-spend instead
	for (const name of Object.keys(env)) {
		if (dynamic.has(name)) continue;
		assert.ok(CONTAINER_ENV_NAMES.has(name), `${name} is written by buildContainerEnv but is missing from reserved-env.mjs`);
	}
	// And a command job, whose PI_COMMAND replaces PI_FLOW.
	const cmd = mod.buildContainerEnv({ ...secretsBase, command: "wf run" });
	for (const name of Object.keys(cmd)) {
		if (dynamic.has(name)) continue;
		assert.ok(CONTAINER_ENV_NAMES.has(name), `${name} is missing from reserved-env.mjs`);
	}
});

// ── Issue #314: the endpoint pi's Anthropic client resolves, pinned against the artifact ─────────
//
// The other half of the fix. `provider-steering.mjs` reserves the names a trigger may not BIND; this pins
// what happens if one ever reaches the runner anyway. It is the same shape as the `findEnvKeys` round trip
// above and exists for the same reason: `CONST-PI-VERSION-PINNED` is what makes an upstream fact worth
// pinning at the pin rather than trusting.

/**
 * Set env vars for the duration of `fn`, restoring exactly what was there (absent included).
 *
 * ASYNC, and it has to be: a synchronous version returns the promise and runs its `finally` immediately,
 * so the environment is restored BEFORE the request it was set for is made. Written that way first, and
 * the control below is what caught it -- the pin passed, because "the endpoint did not move" is also what
 * you get when the variable was never set.
 */
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

/** Drive pi's real Anthropic path with a stubbed fetch and report the request it would have made. */
async function anthropicRequestFor(model) {
	const captured = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, opts) => {
		captured.push({ url: String(url), headers: Object.fromEntries(new Headers(opts?.headers ?? {})) });
		// Nothing leaves this machine, and nothing is spent: the request is inspected and then refused.
		throw new Error("pinned: the request was captured, not sent");
	};
	try {
		const { stream } = await import("@earendil-works/pi-ai/api/anthropic-messages");
		await stream(model, { messages: [{ role: "user", content: "hi" }] }, { apiKey: "sk-ant-not-a-real-key" }).result();
	} catch {
		// Expected: the stub refuses every request.
	} finally {
		globalThis.fetch = realFetch;
	}
	return captured[0];
}

test("pi pins the Anthropic endpoint and auth token, so the environment cannot move them", { skip }, async () => {
	// The issue's option 1. pi passes `baseURL: model.baseUrl` and an explicit `authToken` on all three
	// client branches, which shadows the SDK's own `readEnv` defaults -- and a default parameter fires only
	// on `undefined`, so an explicit `null` beats it for good. If a pi release ever stopped passing them,
	// a trigger that got one of these names past the reserved set would choose the host this deployment's
	// own credential is sent to. This is the build going red instead.
	const { ANTHROPIC_MODELS } = await import("@earendil-works/pi-ai/providers/anthropic.models");
	const model = ANTHROPIC_MODELS["claude-haiku-4-5"] ?? Object.values(ANTHROPIC_MODELS)[0];
	assert.equal(typeof model?.baseUrl, "string", "the pinned pi no longer ships anthropic models carrying a baseUrl -- find where the endpoint is resolved now and re-point this pin BEFORE bumping");
	assert.notEqual(model.baseUrl, "", "an empty baseUrl would make the environment the primary source, which is the azure shape this pin exists to distinguish from");

	const request = await withEnv(
		{ ANTHROPIC_BASE_URL: "https://evil.example/v1", ANTHROPIC_AUTH_TOKEN: "sk-ant-oat-not-a-real-token" },
		() => anthropicRequestFor(model),
	);
	assert.ok(request, "the stub captured no request at all, so this test asserted nothing");
	assert.match(request.url, /^https:\/\/api\.anthropic\.com\//, "ANTHROPIC_BASE_URL must not move the endpoint");
	assert.equal(request.headers.authorization, undefined, "ANTHROPIC_AUTH_TOKEN must not become an Authorization header");
	assert.equal(request.headers["x-api-key"], "sk-ant-not-a-real-key", "the key pi was GIVEN is the one it sends");
});

test("the control: with no model baseUrl the environment DOES win, which is why the names are reserved", { skip }, async () => {
	// Without this, the pin above would pass against a stub that never fired, or against a pi that had
	// stopped reading the environment for unrelated reasons. `model.baseUrl` is what makes the anthropic
	// path inert, and this shows what happens without one.
	//
	// AND THE HONEST BOUND ON WHAT THAT PROVES, because the first draft of this comment asserted a
	// deployment that does not exist: a custom model in the operator's global overlay CANNOT reach `stream`
	// without a baseUrl. `pi-coding-agent`'s ModelRegistry fills it from the provider config and then the
	// built-in default (`model-registry.js:492`) and SKIPS the model entirely if all three are absent, and
	// the schema forbids an empty string. So this is a property of `stream`, not a reachable path, and
	// reserving `ANTHROPIC_BASE_URL` is defence in depth against a pi that stops passing `baseURL` rather
	// than a hole that is open today. The azure and google cases are the ones that are open today.
	const { ANTHROPIC_MODELS } = await import("@earendil-works/pi-ai/providers/anthropic.models");
	const custom = { ...(ANTHROPIC_MODELS["claude-haiku-4-5"] ?? Object.values(ANTHROPIC_MODELS)[0]), baseUrl: undefined };

	const request = await withEnv({ ANTHROPIC_BASE_URL: "https://evil.example/v1" }, () => anthropicRequestFor(custom));
	assert.ok(request, "the stub captured no request, so the control proves nothing");
	assert.match(request.url, /^https:\/\/evil\.example\//, "a model with no baseUrl lets ANTHROPIC_BASE_URL choose the host");
});
