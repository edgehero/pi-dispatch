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
	// ANTHROPIC_AUTH_TOKEN is controlled too since the pi 0.99.1 bump (issue #509), where it became the first
	// name in anthropic's list: a box exporting it would otherwise decide these assertions the same way.
	const restore = withoutEnv(["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]);
	try {
		assert.deepEqual(findEnvKeys("anthropic", HOST), ["ANTHROPIC_API_KEY"]);
		assert.deepEqual(findEnvKeys("openai", HOST), ["OPENAI_API_KEY"]);
		// OAuth outranks API key -- the array order is the precedence.
		assert.deepEqual(findEnvKeys("anthropic", { ...HOST, ANTHROPIC_OAUTH_TOKEN: "oauth" }), ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
		// And the bearer token outranks both (pi 0.99.1).
		assert.deepEqual(findEnvKeys("anthropic", { ...HOST, ANTHROPIC_OAUTH_TOKEN: "oauth", ANTHROPIC_AUTH_TOKEN: "bearer" }), ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
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
	// variable an operator should set. Order is pi's precedence: at the 0.99.1 pin the bearer token first,
	// then the OAuth token, then the API key (issue #509).
	assert.deepEqual(providerKeyCandidates("anthropic"), ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
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
	const saved = Object.fromEntries(["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"].map((n) => [n, Object.hasOwn(process.env, n) ? process.env[n] : undefined]));
	const restore = () => {
		for (const [n, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[n];
			else process.env[n] = v;
		}
	};
	try {
		delete process.env.ANTHROPIC_OAUTH_TOKEN;
		delete process.env.ANTHROPIC_AUTH_TOKEN;
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

test("pi's catalog covers every id findEnvKeys answers for at the 0.99.1 pin, and the question order stays anyway", { skip }, async () => {
	// The pin for the QUESTION ORDER in doctor's provider check: candidates first, catalog second.
	// At 0.80.7 `radius` was purely dynamic -- a real key variable and no catalog entry -- so asking the
	// catalog first would have reported a working configuration as an unknown provider. At the 0.99.1 pin
	// (issue #509) radius is a builtin provider (pi-ai/dist/providers/all.js) and its variable is
	// RADIUS_API_KEY (it was PI_GATEWAY_API_KEY), so the catalog IS now a superset. Pinned in that direction,
	// so the order is known to be defence in depth today rather than load-bearing, and so the day pi adds a
	// key variable for an id with no catalog entry this names it.
	assert.deepEqual(providerKeyCandidates("radius"), ["RADIUS_API_KEY"]);
	assert.equal(piProviders().includes("radius"), true);
	// The ids pi's key table answers for, read off the pinned artifact rather than a list here: the
	// envMap entries plus the two ids answered before it (anthropic, github-copilot).
	const { readFileSync } = await import("node:fs");
	const { dirname, join } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const src = readFileSync(join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai"))), "env-api-keys.js"), "utf8");
	const keyed = [...src.matchAll(/^\s+"?([a-z0-9-]+)"?: "[A-Z0-9_]+",$/gm)].map((m) => m[1]).concat(["anthropic", "github-copilot"]);
	assert.ok(keyed.length > 30, `read only ${keyed.length} ids off pi's key table, so the scan is reading the wrong thing`);
	for (const id of keyed) assert.ok(providerKeyCandidates(id).length > 0, `${id}: the scan found an id pi reads no key for`);
	const catalog = new Set(piProviders());
	assert.deepEqual(keyed.filter((id) => !catalog.has(id)), [], "an id with a key variable and no catalog entry: the candidates-first order is load-bearing again");
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

test("a host ANTHROPIC_AUTH_TOKEN is forwarded exactly like a host ANTHROPIC_OAUTH_TOKEN, and auth.json is not consulted (#509)", { skip }, () => {
	// The rule chosen at the pi 0.99.1 bump: the bearer token pi now reads first is treated the way the
	// OAuth token always was. It reaches the container under its own name beside the API key (pi then
	// picks it by its own precedence), doctor warns that it outranks ANTHROPIC_API_KEY, and the auth.json
	// fallback does not fire because the env already holds a credential.
	const readFile = () => {
		throw new Error("auth.json must not be read while the env holds a credential");
	};
	const env = buildContainerEnv({ ...authBase, hostEnv: { HOME: "/root", ANTHROPIC_AUTH_TOKEN: "gateway-token", ANTHROPIC_API_KEY: "sk-real" }, authFromPi: true, readFile });
	assert.equal(env.ANTHROPIC_AUTH_TOKEN, "gateway-token");
	assert.equal(env.ANTHROPIC_API_KEY, "sk-real");
	const oauth = buildContainerEnv({ ...authBase, hostEnv: { HOME: "/root", ANTHROPIC_OAUTH_TOKEN: "oauth", ANTHROPIC_API_KEY: "sk-real" }, authFromPi: true, readFile });
	assert.equal(oauth.ANTHROPIC_OAUTH_TOKEN, "oauth", "the same treatment the OAuth token gets");
	const alone = buildContainerEnv({ ...authBase, hostEnv: { HOME: "/root", ANTHROPIC_AUTH_TOKEN: "gateway-token" }, authFromPi: true, readFile });
	assert.equal(alone.ANTHROPIC_AUTH_TOKEN, "gateway-token");
	assert.equal(alone.ANTHROPIC_API_KEY, undefined, "nothing is invented beside it");
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

test("an auth.json api key is NEVER injected under the OAuth or bearer token variable, host env or not", { skip }, () => {
	// Two properties in one test, because they are the same line of code.
	// pi's precedence for anthropic is [ANTHROPIC_AUTH_TOKEN, ANTHROPIC_OAUTH_TOKEN, ANTHROPIC_API_KEY] at the
	// 0.99.1 pin, so taking pi's first candidate would write an api_key credential under the bearer name (pi
	// then sends it as `Authorization: Bearer`, issue #509), and skipping only that one would land it on the
	// subscription-login name -- the variables doctor refuses to name, for the same reason.
	// And the old resolver's synthetic environment was a plain object, while pi's getProviderEnvValue falls
	// back to the REAL process.env: with ANTHROPIC_OAUTH_TOKEN exported here, it resolved to that name. The
	// candidate list is now asked against a proxy where every name is present, so the host cannot reach in.
	const had = Object.hasOwn(process.env, "ANTHROPIC_OAUTH_TOKEN");
	const before = process.env.ANTHROPIC_OAUTH_TOKEN;
	const hadBearer = Object.hasOwn(process.env, "ANTHROPIC_AUTH_TOKEN");
	const beforeBearer = process.env.ANTHROPIC_AUTH_TOKEN;
	process.env.ANTHROPIC_OAUTH_TOKEN = "oauth-on-this-host";
	process.env.ANTHROPIC_AUTH_TOKEN = "bearer-on-this-host";
	try {
		const env = buildContainerEnv({
			...authBase,
			hostEnv: { HOME: "/root" },
			authFromPi: true,
			readFile: authReader({ anthropic: { type: "api_key", key: "sk-from-pi" } }),
		});
		assert.equal(env.ANTHROPIC_API_KEY, "sk-from-pi");
		assert.equal(env.ANTHROPIC_OAUTH_TOKEN, undefined, "the api key must not ride the OAuth variable");
		assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined, "the api key must not ride the bearer variable");
	} finally {
		if (had) process.env.ANTHROPIC_OAUTH_TOKEN = before;
		else delete process.env.ANTHROPIC_OAUTH_TOKEN;
		if (hadBearer) process.env.ANTHROPIC_AUTH_TOKEN = beforeBearer;
		else delete process.env.ANTHROPIC_AUTH_TOKEN;
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
		// Issue #503 reworded it to name both ways in: a key for one of pi's providers, or a keyless endpoint.
		(e) => e.piDispatchConfig === true && /^pi has no provider "gemini", so there is no key variable/.test(e.message) && /"keyless": true/.test(e.message) && /"apiKey": "\$PI_DISPATCH_KEYLESS"/.test(e.message),
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
	// Since issue #503 the refusal arrives from the unknown-provider branch, which the filtered (empty) candidate list
	// is what selects; without the filter the list is non-empty and the auth.json path builds that key again.
	assert.throws(
		() =>
			buildContainerEnv({
				...authBase,
				provider: "__proto__",
				hostEnv: {},
				authFromPi: true,
				readFile: authReader('{"__proto__":{"type":"api_key","key":"sk-x"}}'),
			}),
		(e) => e.piDispatchConfig === true && /^pi has no provider "__proto__"/.test(e.message),
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
		assert.ok(!/_AUTH_TOKEN$/.test(expected), `${id}: ${expected} is not a bearer token (issue #509)`);
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

test("PI_EXCLUDE_TOOLS is emitted only when the job carries exclusions, and never as an empty string", { skip }, () => {
	const args = { provider: "anthropic", model: "m", maxTurns: 10, jobId: "j", hostEnv: HOST };
	// Mirrors PI_COMMAND directly above: absent means the full pinned default set, and the variable is
	// omitted entirely rather than emitted empty -- an empty value is a third state the two sides of the
	// mount need not agree on.
	for (const excludeTools of [undefined, []]) {
		assert.equal(buildContainerEnv({ ...args, excludeTools }).PI_EXCLUDE_TOOLS, undefined, `excludeTools ${JSON.stringify(excludeTools)} must not become a value`);
	}
	// Comma-joined, and the join is safe by a LOAD-time guarantee this map deliberately does not
	// re-check (the second-validator rule): the loader admits only names from its pinned set, none of
	// which carries a comma.
	assert.equal(buildContainerEnv({ ...args, excludeTools: ["bash", "edit"] }).PI_EXCLUDE_TOOLS, "bash,edit");
});

test("PI_ALLOWED_MODELS is emitted only when the job has a list, comma-joined and verbatim, never empty (#502)", { skip }, () => {
	const args = { provider: "anthropic", model: "m", maxTurns: 10, jobId: "j", hostEnv: HOST };
	// Null is unrestricted, and the runner refuses an EMPTY value as a config error: an empty allow list read
	// as unset would fail open. So nothing at all is emitted for an unrestricted job.
	for (const allowedModels of [undefined, null, []]) {
		assert.equal(buildContainerEnv({ ...args, allowedModels }).PI_ALLOWED_MODELS, undefined, `allowedModels ${JSON.stringify(allowedModels)} must not become a value`);
	}
	// Verbatim: case and the model half's own slashes survive, for the runner's first-slash split.
	assert.equal(buildContainerEnv({ ...args, allowedModels: ["anthropic/m", "openrouter/~anthropic/Claude"] }).PI_ALLOWED_MODELS, "anthropic/m,openrouter/~anthropic/Claude");
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
	const env = mod.buildContainerEnv({ ...secretsBase, maxTokens: 100, packagePaths: ["/opt/pi-global/packages/x"], sessionFile: "/session/current.jsonl", flow: "fix", excludeTools: ["bash"], allowGlobalExtensions: false, home: "/home/pi" });
	assert.equal(env.HOME, "/home/pi", "the drift check must see HOME, or a reservation it needs would go unchecked");
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

test("the SDKs' custom-header variables reach pi's real request and REPLACE the credential it sends (0.99.1, #509)", { skip }, async () => {
	// New at the 0.99.1 pin, measured, and the reason both names joined provider-steering.mjs: the Anthropic
	// SDK (0.124.0) folds ANTHROPIC_CUSTOM_HEADERS, and openai (7.19.0) OPENAI_CUSTOM_HEADERS, into every
	// client's headers, and a line naming the credential header wins over the key pi was GIVEN. So a job
	// env carrying either one decides which credential the provider call spends, with no baseUrl involved.
	// If a pi or SDK release stops honouring them, this goes red and the reservation can be revisited.
	const { ANTHROPIC_MODELS } = await import("@earendil-works/pi-ai/providers/anthropic.models");
	const anthropicModel = ANTHROPIC_MODELS["claude-haiku-4-5"] ?? Object.values(ANTHROPIC_MODELS)[0];
	const anthropic = await withEnv({ ANTHROPIC_CUSTOM_HEADERS: "x-api-key: sk-ant-chosen-by-the-env" }, () => anthropicRequestFor(anthropicModel));
	assert.ok(anthropic, "the stub captured no Anthropic request, so this asserted nothing");
	assert.equal(anthropic.headers["x-api-key"], "sk-ant-chosen-by-the-env", "ANTHROPIC_CUSTOM_HEADERS replaces the key pi sends");

	const { OPENAI_MODELS } = await import("@earendil-works/pi-ai/providers/openai.models");
	const openaiModel = OPENAI_MODELS["gpt-5.4"] ?? Object.values(OPENAI_MODELS)[0];
	assert.equal(openaiModel?.api, "openai-responses", "the openai model this pin drives moved to another api; re-point it");
	const captured = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url, opts) => {
		captured.push({ url: String(url), headers: Object.fromEntries(new Headers(opts?.headers ?? {})) });
		throw new Error("pinned: the request was captured, not sent");
	};
	try {
		await withEnv({ OPENAI_CUSTOM_HEADERS: "Authorization: Bearer sk-chosen-by-the-env" }, async () => {
			const { stream } = await import("@earendil-works/pi-ai/api/openai-responses");
			try {
				await stream(openaiModel, { messages: [{ role: "user", content: "hi" }] }, { apiKey: "sk-not-a-real-key" }).result();
			} catch {}
		});
	} finally {
		globalThis.fetch = realFetch;
	}
	assert.ok(captured[0], "the stub captured no OpenAI request, so this asserted nothing");
	assert.equal(captured[0].headers.authorization, "Bearer sk-chosen-by-the-env", "OPENAI_CUSTOM_HEADERS replaces the key pi sends");
});

test("the control: an Anthropic client built WITHOUT pi's baseURL lets the environment win, which is why the names are reserved", { skip }, async () => {
	// Without this, the pin above would pass against a stub that never fired, or against a pi that had
	// stopped reading the environment for unrelated reasons.
	//
	// RE-DERIVED at the pi 0.99.1 bump (issue #509). At 0.80.7 the control drove pi's own `stream` with a
	// model whose baseUrl was undefined, and pi handed the SDK `baseURL: undefined`, so the SDK's
	// `readEnv('ANTHROPIC_BASE_URL')` default fired. At 0.99.1 that model never reaches fetch at all:
	// `getAnthropicCompat` reads `model.baseUrl.includes(...)` before any client is built and throws a
	// TypeError (anthropic-messages.js:136, measured). The first assertion below pins that, so the day a pi
	// release makes a baseUrl-less model reach the client again, this control says so.
	//
	// The control itself now builds the client pi builds, from the SAME SDK copy pi imports (resolved through
	// pi-ai, not from here), with every option pi's API-key branch passes EXCEPT `baseURL`. That isolates the
	// one fact the pin above depends on: the endpoint stays put only because pi passes baseURL explicitly.
	// The honest bound from the old version still holds: no reachable deployment builds a model without a
	// baseUrl (pi's model registry fills one or skips the model), so reserving ANTHROPIC_BASE_URL is defence
	// in depth against a pi that stops passing it, not a hole open today.
	const { ANTHROPIC_MODELS } = await import("@earendil-works/pi-ai/providers/anthropic.models");
	const model = ANTHROPIC_MODELS["claude-haiku-4-5"] ?? Object.values(ANTHROPIC_MODELS)[0];
	const { stream } = await import("@earendil-works/pi-ai/api/anthropic-messages");
	assert.throws(
		() => stream({ ...model, baseUrl: undefined }, { messages: [{ role: "user", content: "hi" }] }, { apiKey: "sk-ant-not-a-real-key" }),
		TypeError,
		"a model with no baseUrl now fails before any client is built; if that changed, the 0.80.7 control shape is live again and belongs back here",
	);

	const { createRequire } = await import("node:module");
	const { pathToFileURL, fileURLToPath } = await import("node:url");
	const piRequire = createRequire(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")));
	const sdk = await import(pathToFileURL(piRequire.resolve("@anthropic-ai/sdk")).href);
	const Anthropic = sdk.default?.default ?? sdk.default ?? sdk.Anthropic;
	const captured = [];
	const fetch = async (url, opts) => {
		captured.push({ url: String(url), headers: Object.fromEntries(new Headers(opts?.headers ?? {})) });
		throw new Error("pinned: the request was captured, not sent");
	};
	await withEnv({ ANTHROPIC_BASE_URL: "https://evil.example/v1" }, async () => {
		// pi's API-key branch (createClient in anthropic-messages.js) minus `baseURL: model.baseUrl`.
		const client = new Anthropic({ apiKey: "sk-ant-not-a-real-key", authToken: null, dangerouslyAllowBrowser: true, fetch, maxRetries: 0 });
		try {
			await client.messages.create({ model: model.id, max_tokens: 1, messages: [{ role: "user", content: "hi" }] });
		} catch {
			// Expected: the stub refuses every request.
		}
	});
	assert.ok(captured[0], "the stub captured no request, so the control proves nothing");
	assert.match(captured[0].url, /^https:\/\/evil\.example\//, "without pi's explicit baseURL, ANTHROPIC_BASE_URL chooses the host");
});

test("HOME is written only when a home is passed, and neither a forwarded nor a secret HOME can win (issue #341)", { skip }, () => {
	const without = mod.buildContainerEnv({ ...secretsBase, hostEnv: { ...HOST, HOME: "/root" }, forwardEnv: ["HOME"] });
	assert.equal(without.HOME, "/root", "no --user: HOME is not the harness's to set, so an explicit forward still applies");
	const withHome = mod.buildContainerEnv({ ...secretsBase, hostEnv: { ...HOST, HOME: "/root" }, forwardEnv: ["HOME"], secrets: { HOME: "/workspace" }, home: "/home/pi" });
	assert.equal(withHome.HOME, "/home/pi", "beside --user the harness's HOME is assigned after both loops");
	for (const empty of [null, undefined, ""]) assert.equal("HOME" in mod.buildContainerEnv({ ...secretsBase, home: empty }), false, String(empty));
	assert.ok(CONTAINER_ENV_NAMES.has("HOME"), "reserved, so a trigger's run.secrets cannot bind it");
});

// ── Issue #503, part 4: a custom provider served by keyless model endpoints passes the credential gate ─────────
//
// The snapshot is what index.mjs hands runJob at pickup: the parsed endpoints and the overlay models.json, read once.
// `readFile` throws on every call, so a pass proves no auth.json (and no second models.json) was read.
const KL_MAC = { id: "mac-ollama", host: "host.docker.internal", port: 11434, slots: 2, keyless: true };
const KL_LAN = { id: "lan-vllm", host: "gpu.lan", port: 8000, slots: 1, keyless: true };
const KL_KEYED = { id: "keyed-vllm", host: "vllm.lan", port: 8000, slots: 1, keyless: false };
const klModels = (provider = {}) => ({
	providers: {
		"local-ollama": {
			api: "openai-completions",
			baseUrl: "http://host.docker.internal:11434/v1",
			apiKey: "$PI_DISPATCH_KEYLESS",
			models: [{ id: "qwen2.5:0.5b" }, { id: "llama3", baseUrl: "http://gpu.lan:8000/v1" }],
			...provider,
		},
	},
});
const klSnapshot = (models = klModels(), endpoints = [KL_MAC, KL_LAN, KL_KEYED]) => ({ endpoints, models, set: [] });
const noRead = () => {
	throw new Error("no file may be read on the keyless branch");
};
const klBase = { provider: "local-ollama", model: "qwen2.5:0.5b", maxTurns: 5, jobId: "j", hostEnv: { HOME: "/root" }, authFromPi: true, readFile: noRead };
const isKeylessRefusal = (e) => e.piDispatchConfig === true && /^pi has no provider "local-ollama"/.test(e.message) && /"keyless": true/.test(e.message);

test("keyless: a custom provider whose EVERY model is on a keyless endpoint passes, with PI_DISPATCH_KEYLESS=keyless and no file read", { skip }, () => {
	assert.deepEqual(mod.resolveProviderCredential({ ...klBase, modelEndpoints: klSnapshot() }), { PI_DISPATCH_KEYLESS: "keyless" });
	const env = buildContainerEnv({ ...klBase, modelEndpoints: klSnapshot() });
	assert.equal(env.PI_DISPATCH_KEYLESS, "keyless");
	assert.equal(env.PI_PROVIDER, "local-ollama");
	// Model-level baseUrl beats the provider's: llama3 is on lan-vllm, not on the provider's mac-ollama.
	assert.deepEqual(mod.keylessEndpointsFor("local-ollama", klSnapshot()), ["lan-vllm", "mac-ollama"]);
});

test("keyless: ONE model off every declared endpoint refuses the whole provider (every, not some)", { skip }, () => {
	const models = klModels({ models: [{ id: "qwen2.5:0.5b" }, { id: "hosted", baseUrl: "https://api.example.com/v1" }] });
	assert.throws(() => buildContainerEnv({ ...klBase, modelEndpoints: klSnapshot(models) }), isKeylessRefusal);
	// The same host on another port is another server, so it does not count either.
	const offPort = klModels({ models: [{ id: "qwen2.5:0.5b" }, { id: "other", baseUrl: "http://host.docker.internal:11435/v1" }] });
	assert.throws(() => buildContainerEnv({ ...klBase, modelEndpoints: klSnapshot(offPort) }), isKeylessRefusal);
});

test("keyless: a model on an endpoint WITHOUT \"keyless\": true refuses (the flag is the operator's word)", { skip }, () => {
	const models = klModels({ models: [{ id: "qwen2.5:0.5b" }, { id: "big", baseUrl: "http://vllm.lan:8000/v1" }] });
	assert.throws(() => buildContainerEnv({ ...klBase, modelEndpoints: klSnapshot(models) }), isKeylessRefusal);
	// And every model on the one non-keyless endpoint.
	const allKeyed = klModels({ baseUrl: "http://vllm.lan:8000/v1", models: [{ id: "big" }] });
	assert.throws(() => buildContainerEnv({ ...klBase, modelEndpoints: klSnapshot(allKeyed) }), isKeylessRefusal);
});

test("keyless: the apiKey must be exactly \"$PI_DISPATCH_KEYLESS\"; a literal, another variable, a command or none refuses", { skip }, () => {
	for (const apiKey of ["ollama", "$OLLAMA_KEY", "${PI_DISPATCH_KEYLESS}", "!echo x", undefined]) {
		assert.throws(() => buildContainerEnv({ ...klBase, modelEndpoints: klSnapshot(klModels({ apiKey })) }), isKeylessRefusal, String(apiKey));
	}
});

test("keyless: no models, no overlay entry, no endpoint declared, or no snapshot at all refuses", { skip }, () => {
	assert.throws(() => buildContainerEnv({ ...klBase, modelEndpoints: klSnapshot(klModels({ models: [] })) }), isKeylessRefusal, "no models");
	assert.throws(() => buildContainerEnv({ ...klBase, modelEndpoints: klSnapshot({ providers: {} }) }), isKeylessRefusal, "not in the overlay");
	assert.throws(() => buildContainerEnv({ ...klBase, modelEndpoints: klSnapshot(klModels(), []) }), isKeylessRefusal, "nothing declared");
	assert.throws(() => buildContainerEnv({ ...klBase, modelEndpoints: { endpoints: [KL_MAC], models: null, set: [] } }), isKeylessRefusal, "overlay unreadable");
	assert.throws(() => buildContainerEnv({ ...klBase }), isKeylessRefusal, "no snapshot (an unwired caller)");
	// The env-only posture names the same way in.
	assert.throws(() => buildContainerEnv({ ...klBase, authFromPi: false }), isKeylessRefusal, "PI_AUTH_FROM_PI=0");
});

test("keyless: a provider pi KNOWS is unchanged, even pointed at a keyless endpoint with the keyless apiKey", { skip }, () => {
	// `openai` reads OPENAI_API_KEY: with it, the key is forwarded and no keyless variable appears; without it, the
	// refusal is the one it always was. A builtin baseUrl pointed at a local server is a named residual, never keyless.
	const asOpenai = (models) => ({ providers: { openai: models.providers["local-ollama"] } });
	const snap = klSnapshot(asOpenai(klModels()));
	const keyed = buildContainerEnv({ ...klBase, provider: "openai", hostEnv: { OPENAI_API_KEY: "sk-o" }, authFromPi: false, modelEndpoints: snap });
	assert.equal(keyed.OPENAI_API_KEY, "sk-o");
	assert.equal("PI_DISPATCH_KEYLESS" in keyed, false);
	assert.throws(
		() => buildContainerEnv({ ...klBase, provider: "openai", authFromPi: false, modelEndpoints: snap }),
		(e) => e.piDispatchConfig === true && /^provider openai has no configured credential in the worker environment\. Set its key there, or, for a custom provider served by a local model server, declare/.test(e.message),
	);
	// `amazon-bedrock` is in pi's catalog with NO key variable: it must keep its own refusal, not fall to keyless.
	const bedrock = { providers: { "amazon-bedrock": klModels().providers["local-ollama"] } };
	assert.throws(
		() => buildContainerEnv({ ...klBase, provider: "amazon-bedrock", authFromPi: false, modelEndpoints: klSnapshot(bedrock) }),
		(e) => e.piDispatchConfig === true && /no configured credential/.test(e.message),
	);
	assert.throws(
		() => buildContainerEnv({ ...klBase, provider: "amazon-bedrock", readFile: authReader({ "amazon-bedrock": { type: "api_key", key: "sk-x" } }), modelEndpoints: klSnapshot(bedrock) }),
		(e) => e.piDispatchConfig === true && /without an API-key environment variable/.test(e.message),
	);
});

test("keyless: PI_DISPATCH_KEYLESS is in the env ONLY on the keyless branch", { skip }, () => {
	// A hosted job beside a declared keyless provider: the snapshot is there, the variable is not.
	const hosted = buildContainerEnv({ provider: "anthropic", model: "m", maxTurns: 5, jobId: "j", hostEnv: HOST, modelEndpoints: klSnapshot() });
	assert.equal("PI_DISPATCH_KEYLESS" in hosted, false);
	const bare = buildContainerEnv({ provider: "anthropic", model: "m", maxTurns: 5, jobId: "j", hostEnv: HOST });
	assert.equal("PI_DISPATCH_KEYLESS" in bare, false);
	// Nothing the operator or a trigger names can put it there either: PI_FORWARD_ENV refuses it at load (config.test)
	// and run.secrets cannot bind a reserved name; this map is the only writer.
	assert.ok(CONTAINER_ENV_NAMES.has("PI_DISPATCH_KEYLESS"));
});

// ── PR #520 review round 1 ────────────────────────────────────────────────────────────────────────────────────────

test("keyless: any other credential refuses: headers anywhere, oauth, or a user or password in a baseUrl", { skip }, () => {
	const cases = {
		"provider headers": klModels({ headers: { "X-Trace": "1" } }),
		"model headers": klModels({ models: [{ id: "qwen2.5:0.5b", headers: { Authorization: "Bearer x" } }] }),
		"modelOverrides headers": klModels({ modelOverrides: { "qwen2.5:0.5b": { headers: { "X-Key": "!cat /x" } } } }),
		oauth: klModels({ oauth: "radius" }),
		"provider userinfo": klModels({ baseUrl: "http://u:p@host.docker.internal:11434/v1" }),
		"model userinfo": klModels({ models: [{ id: "qwen2.5:0.5b", baseUrl: "http://tok@host.docker.internal:11434/v1" }] }),
	};
	for (const [name, models] of Object.entries(cases)) {
		assert.throws(() => buildContainerEnv({ ...klBase, modelEndpoints: klSnapshot(models) }), isKeylessRefusal, name);
	}
	// The control: a modelOverrides entry without headers is not a credential.
	assert.equal(buildContainerEnv({ ...klBase, modelEndpoints: klSnapshot(klModels({ modelOverrides: { "qwen2.5:0.5b": { contextWindow: 8192 } } })) }).PI_DISPATCH_KEYLESS, "keyless");
});

test("keyless: a model entry pi's schema would refuse refuses the provider, rather than being skipped", { skip }, () => {
	for (const models of [[{ id: "qwen2.5:0.5b" }, { name: "no id" }], [{ id: "" }], [{ id: "qwen2.5:0.5b" }, null], [{ id: 7 }], "qwen"]) {
		assert.throws(() => buildContainerEnv({ ...klBase, modelEndpoints: klSnapshot(klModels({ models })) }), isKeylessRefusal, JSON.stringify(models));
	}
});

test("keyless: a TRANSIENT overlay read at pickup is no verdict (untagged, retryable); absence stays a refusal", { skip }, () => {
	const snapshot = { endpoints: [KL_MAC], models: null, set: [], modelsUnreadable: { code: "EIO" } };
	assert.throws(
		() => buildContainerEnv({ ...klBase, modelEndpoints: snapshot }),
		(e) => e.piDispatchConfig !== true && e.piDispatchTransient === true && e.code === "EIO" && !/keyless": true/.test(e.message),
	);
	// A provider pi knows is decided as before, the read does not matter to it.
	assert.equal(buildContainerEnv({ ...klBase, provider: "anthropic", hostEnv: HOST, modelEndpoints: snapshot }).ANTHROPIC_API_KEY, "sk-ant-real");
	// No marker (absent file, invalid JSON, a determinate errno): the determinate refusal.
	assert.throws(() => buildContainerEnv({ ...klBase, modelEndpoints: { endpoints: [KL_MAC], models: null, set: [] } }), isKeylessRefusal);
});

test("keyless: PI_DISPATCH_KEYLESS is settled after the forward and secrets loops, so neither can replace or add it", { skip }, () => {
	// Both lists refuse the name upstream (config.mjs, the reserved set); this pins the backstop at the seam.
	const keyless = buildContainerEnv({ ...klBase, hostEnv: { HOME: "/root", PI_DISPATCH_KEYLESS: "forwarded" }, forwardEnv: ["PI_DISPATCH_KEYLESS"], secrets: { PI_DISPATCH_KEYLESS: "secret" }, modelEndpoints: klSnapshot() });
	assert.equal(keyless.PI_DISPATCH_KEYLESS, "keyless");
	const keyed = buildContainerEnv({ provider: "anthropic", model: "m", maxTurns: 5, jobId: "j", hostEnv: { ...HOST, PI_DISPATCH_KEYLESS: "forwarded" }, forwardEnv: ["PI_DISPATCH_KEYLESS"], secrets: { PI_DISPATCH_KEYLESS: "secret" } });
	assert.equal("PI_DISPATCH_KEYLESS" in keyed, false);
});
