import assert from "node:assert/strict";
import { test } from "node:test";
// Static, unlike env-allowlist itself below: forges.mjs imports nothing, so it is available even on a
// box where pi-ai will not load and the rest of this file skips.
import { FORGES, FORGE_KINDS } from "../src/forges.mjs";

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
const { buildContainerEnv, providerKeyVars } = mod ?? {};

const HOST = {
	ANTHROPIC_API_KEY: "sk-ant-real",
	OPENAI_API_KEY: "sk-openai-real",
	// The stray host variable no-broad-env-into-container exists to defend against:
	AWS_SECRET_ACCESS_KEY: "must-not-leak",
	HOME: "/root",
	PATH: "/usr/bin",
};

test("derives the provider key var from the host env, in precedence order", { skip }, () => {
	assert.deepEqual(providerKeyVars("anthropic", HOST), ["ANTHROPIC_API_KEY"]);
	assert.deepEqual(providerKeyVars("openai", HOST), ["OPENAI_API_KEY"]);
	// OAuth outranks API key -- the array order is the precedence.
	assert.deepEqual(
		providerKeyVars("anthropic", { ...HOST, ANTHROPIC_OAUTH_TOKEN: "oauth" }),
		["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
	);
});

test("an unconfigured provider yields undefined (=> refuse before spend)", { skip }, () => {
	assert.equal(providerKeyVars("google", HOST), undefined);
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
	if (json === null) throw new Error("ENOENT");
	return typeof json === "string" ? json : JSON.stringify(json);
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

test("PI_AUTH_FROM_PI refuses when auth.json is missing/unreadable, with guidance", { skip }, () => {
	assert.throws(
		() => buildContainerEnv({ ...authBase, hostEnv: {}, authFromPi: true, readFile: authReader(null) }),
		(e) => e.piDispatchConfig === true && /pi login|environment/i.test(e.message),
	);
});

test("without PI_AUTH_FROM_PI, a missing env key still refuses and auth.json is never consulted", { skip }, () => {
	assert.throws(
		() => buildContainerEnv({ ...authBase, hostEnv: {}, authFromPi: false, readFile: () => assert.fail("must not read auth.json when PI_AUTH_FROM_PI is off") }),
		(e) => e.piDispatchConfig === true,
	);
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
