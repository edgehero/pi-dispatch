import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../src/doctor.mjs";

// A fake `spawn`: plan keys are command-line prefixes ("docker info", "docker image", "docker run",
// "gh auth status", "gh auth token") mapped to a canned exit code, a `{code, output}` pair (output is
// emitted on the fake stdout for doctor's capture helper), or "enoent" for a launch failure. Every spawn
// is recorded into `calls` (cmd, args, opts) so tests can assert argv and the spawn env.
function fakeSpawn(plan, calls = []) {
	return (cmd, args, opts) => {
		const line = [cmd, ...args].join(" ");
		const key = Object.keys(plan).find((k) => line.startsWith(k));
		const outcome = plan[key];
		calls.push({ cmd, args, opts });
		const stream = () => ({
			handlers: {},
			on(ev, cb) {
				this.handlers[ev] = cb;
				return this;
			},
		});
		const handlers = {};
		const child = {
			stdout: stream(),
			stderr: stream(),
			kill() {},
			on(ev, cb) {
				handlers[ev] = cb;
				return this;
			},
		};
		queueMicrotask(() => {
			if (outcome === "enoent") {
				handlers.error?.(new Error(`spawn ${cmd} ENOENT`));
				return;
			}
			const { code, output } = typeof outcome === "object" && outcome !== null ? outcome : { code: outcome, output: "" };
			if (output) child.stdout.handlers.data?.(output);
			handlers.close?.(code);
		});
		return child;
	};
}
function capture() {
	const buf = [];
	return { out: (s) => buf.push(s), text: () => buf.join("") };
}
const green = { "docker info": 0, "docker image": 0 };
// A classic-token `gh auth status` (newer gh quotes each scope; the parser also accepts unquoted).
const ghStatusOutput = [
	"github.com",
	"  ✓ Logged in to github.com account octocat (keyring)",
	"  - Active account: true",
	"  - Token scopes: 'gist', 'read:org', 'repo', 'workflow'",
	"",
].join("\n");

test("doctor: all prerequisites present passes and exits 0", async () => {
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" },
		{ out, spawn: fakeSpawn(green), probeValkey: async () => true, fileExists: () => true, nodeVersion: "22.19.0" },
	);
	assert.equal(code, 0);
	assert.match(text(), /Docker daemon reachable/);
	assert.doesNotMatch(text(), /✗/, "no hard failures are marked");
});

test("doctor: docker down, valkey down, no key exits 1 with fixes", async () => {
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic" }, // no credential
		{ out, spawn: fakeSpawn({ "docker info": 1 }), probeValkey: async () => false, fileExists: () => true, nodeVersion: "22.19.0" },
	);
	assert.equal(code, 1);
	assert.match(text(), /start Docker/, "a down daemon (exit != 0) is distinguished from a missing binary");
	assert.match(text(), /docker compose .* up -d/, "the Valkey fix is shown");
	assert.match(text(), /set ANTHROPIC_API_KEY in \.env/, "the provider-key fix names the right var");
});

test("doctor: a missing docker binary reads as 'install', not 'start'", async () => {
	const { out, text } = capture();
	await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" },
		{ out, spawn: fakeSpawn({ "docker info": "enoent" }), probeValkey: async () => true, fileExists: () => true, nodeVersion: "22.19.0" },
	);
	assert.match(text(), /install Docker/, "an unlaunchable docker is an install problem");
});

test("doctor: the provider key value is never printed", async () => {
	const { out, text } = capture();
	await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-secret-value" },
		{
			out,
			spawn: fakeSpawn({ ...green, "gh auth status": { code: 0, output: ghStatusOutput }, "gh auth token": { code: 0, output: "gho_secret_mint\n" }, "docker run": 0 }),
			probeValkey: async () => true,
			fileExists: () => true,
			nodeVersion: "22.19.0",
		},
	);
	assert.doesNotMatch(text(), /sk-secret-value/, "the credential must never reach output");
	assert.doesNotMatch(text(), /gho_secret_mint/, "the minted gh token must never reach output");
});

test("doctor: an outdated Node is flagged and fails", async () => {
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" },
		{ out, spawn: fakeSpawn(green), probeValkey: async () => true, fileExists: () => true, nodeVersion: "20.10.0" },
	);
	assert.equal(code, 1);
	assert.match(text(), /Node ≥ 22\.19 \(have 20\.10\.0\)/);
});

test("doctor: a missing .env is a warning, not a hard failure", async () => {
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" },
		{ out, spawn: fakeSpawn(green), probeValkey: async () => true, fileExists: () => false, nodeVersion: "22.19.0" },
	);
	assert.equal(code, 0, "an absent .env alone does not fail doctor — env can come from a service manager");
	assert.match(text(), /⚠ \.env present/);
});

// The overlay checks read real files (doctor uses real readFileSync for models.json), so use temp dirs and
// doctor's default fileExists; the docker/valkey checks stay faked green so ONLY the overlay drives the outcome.
// `packages` is the stage manifest's entry list; each entry's dir is created alongside it UNLESS the entry
// carries `stage: false` (the manifest-names-a-dir-that-is-gone case). `packagesNoManifest` creates the
// packages/ dir with no packages.json in it — staged bytes nothing knows the names of.
function overlay({ auth = false, models, extensions = false, packages, packagesNoManifest = false } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-overlay-"));
	if (auth) writeFileSync(join(dir, "auth.json"), "{}");
	if (models !== undefined) writeFileSync(join(dir, "models.json"), models);
	if (extensions) mkdirSync(join(dir, "extensions", "x"), { recursive: true });
	if (packages || packagesNoManifest) {
		const pkgDir = join(dir, "packages");
		mkdirSync(pkgDir, { recursive: true });
		for (const p of packages ?? []) if (p.stage !== false) mkdirSync(join(pkgDir, p.dir), { recursive: true });
		if (!packagesNoManifest) {
			const entries = (packages ?? []).map(({ name, version, dir: d }) => ({ name, version, dir: d }));
			writeFileSync(join(pkgDir, "packages.json"), JSON.stringify({ stagedAt: "2026-07-28T00:00:00.000Z", packages: entries }));
		}
	}
	return dir;
}

// Doctor counts armed triggers with the SHARED parseTriggers, so the fixture must write a file that really
// validates — a stub `{triggers:[{run:{packages:true}}]}` would be swallowed by the never-throw guard and
// silently count 0, making every ARMED assertion pass for the wrong reason.
function triggersFile(packages, image) {
	const path = join(mkdtempSync(join(tmpdir(), "pi-triggers-")), "triggers.json");
	const run = { kind: "local", folder: "/srv/repo", flow: "review", task: "nightly review", ...(packages === undefined ? {} : { packages }), ...(image === undefined ? {} : { image }) };
	writeFileSync(path, JSON.stringify({ triggers: [{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run }] }));
	return path;
}
const overlayEnv = (dir, extra = {}) => ({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_GLOBAL_PI_DIR: dir, ...extra });
const overlayDeps = (out) => ({ out, cwd: tmpdir(), spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0" });

// -- per-trigger job images (issue #41): presence is the only thing this project can check ------------

const imgEnv = (extra = {}) => ({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", ...extra });
const imgDeps = (out, plan, calls) => ({ out, cwd: tmpdir(), spawn: fakeSpawn(plan, calls), probeValkey: async () => true, fileExists: () => true, nodeVersion: "22.19.0" });
// The runner entrypoint probe reads --format={{json .Config.Entrypoint}}; this is a conformant answer.
const RUNNER_ENTRYPOINT = { code: 0, output: '["/entrypoint.sh"]\n' };

test("doctor: a deployment with no run.image anywhere prints no extra image line at all", async () => {
	// The non-adopter byte-identity guard: one image, one line, exactly as before the feature existed.
	const { out, text } = capture();
	await runDoctor(imgEnv({ PI_TRIGGERS_FILE: triggersFile() }), imgDeps(out, green));
	assert.doesNotMatch(text(), /Trigger job image/);
	assert.match(text(), /Job image present \(pi-job:latest\)/);
});

test("doctor: a trigger naming the deployment default adds no second line", async () => {
	const { out, text } = capture();
	await runDoctor(imgEnv({ PI_TRIGGERS_FILE: triggersFile(undefined, "pi-job:latest") }), imgDeps(out, green));
	assert.doesNotMatch(text(), /Trigger job image/, "the default is already checked once; twice is noise");
});

test("doctor: a trigger image that is absent FAILS, and the fix says the worker never fetches it", async () => {
	// With --pull=never nothing will pull it at job time, so this line is the only warning that arrives
	// before the trigger fires.
	const { out, text } = capture();
	const plan = { "docker info": 0, "docker image inspect pi-job:latest": 0, "docker image inspect my-python:1.2.0": 1, "docker image": 0 };
	const code = await runDoctor(imgEnv({ PI_TRIGGERS_FILE: triggersFile(undefined, "my-python:1.2.0") }), imgDeps(out, plan));
	assert.equal(code, 1, "a trigger that can never run is a hard failure, not a warning");
	assert.match(text(), /✗ Trigger job image present \(my-python:1\.2\.0\)/);
	assert.match(text(), /--pull=never/, "the fix names why waiting will not help");
});

test("doctor: a trigger image present but without the runner entrypoint WARNS, never fails", async () => {
	// An image without the runner can exit 0 without ever starting the agent, and the queue records that as
	// success. But an operator may legitimately wrap the entrypoint, so ✗ is not ours to claim.
	const { out, text } = capture();
	const plan = { "docker info": 0, "docker image inspect --format": { code: 0, output: '["/bin/sh"]\n' }, "docker image": 0 };
	const code = await runDoctor(imgEnv({ PI_TRIGGERS_FILE: triggersFile(undefined, "my-python:1.2.0") }), imgDeps(out, plan));
	assert.equal(code, 0, "warn, never fail");
	assert.match(text(), /⚠ my-python:1\.2\.0 does not appear to carry the pi-dispatch runner entrypoint/);
	assert.match(text(), /docs\/job-image\.md/);
});

test("doctor: a conformant trigger image passes both checks silently", async () => {
	const { out, text } = capture();
	const plan = { "docker info": 0, "docker image inspect --format": RUNNER_ENTRYPOINT, "docker image": 0 };
	const code = await runDoctor(imgEnv({ PI_TRIGGERS_FILE: triggersFile(undefined, "my-python:1.2.0") }), imgDeps(out, plan));
	assert.equal(code, 0);
	assert.match(text(), /✓ Trigger job image present \(my-python:1\.2\.0\)/);
	assert.doesNotMatch(text(), /does not appear to carry/);
});

test("doctor: no per-trigger image probes on top of a down daemon", async () => {
	const calls = [];
	const { out } = capture();
	await runDoctor(imgEnv({ PI_TRIGGERS_FILE: triggersFile(undefined, "my-python:1.2.0") }), imgDeps(out, { "docker info": 1 }, calls));
	assert.ok(!calls.some((c) => c.args.join(" ").includes("my-python:1.2.0")), "an image check is noise on top of a down daemon");
});

test("doctor: a set-but-missing overlay dir fails", async () => {
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv("/no/such/overlay"), overlayDeps(out));
	assert.equal(code, 1);
	assert.match(text(), /Global overlay dir exists/);
});

test("doctor: auth.json in the overlay is a hard failure (credential leak)", async () => {
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(overlay({ auth: true })), overlayDeps(out));
	assert.equal(code, 1);
	assert.match(text(), /credential-free \(no auth\.json\)/);
	assert.match(text(), /belongs in env/);
});

test("doctor: a literal key in the overlay models.json is a hard failure", async () => {
	const dir = overlay({ models: JSON.stringify({ providers: { c: { apiKey: "sk-literal" } } }) });
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(dir), overlayDeps(out));
	assert.equal(code, 1);
	assert.match(text(), /Overlay models\.json is credential-free/);
});

test("doctor: a clean overlay passes; staged extensions warn that they LOAD, with no flag set", async () => {
	const clean = overlay({ models: JSON.stringify({ providers: { anthropic: { name: "Anthropic" } } }) });
	const { out: o1, text: t1 } = capture();
	assert.equal(await runDoctor(overlayEnv(clean), overlayDeps(o1)), 0, "a clean overlay does not fail doctor");
	assert.doesNotMatch(t1(), /✗/);

	// The newly-dangerous state: extensions staged once and forgotten are running in every container NOW.
	const staged = overlay({ extensions: true });
	const { out: o2, text: t2 } = capture();
	const code = await runDoctor(overlayEnv(staged), overlayDeps(o2));
	assert.equal(code, 0, "loading extensions warn (⚠) but do not fail doctor -- it is the intended posture");
	assert.match(t2(), /⚠ Overlay extensions LOAD in every job \(PI_GLOBAL_ALLOW_EXTENSIONS is not 0\)/);
	assert.match(t2(), /set PI_GLOBAL_ALLOW_EXTENSIONS=0 in \.env to disable them/);
	assert.doesNotMatch(t2(), /dormant/, "nothing about a staged extensions dir is dormant any more");
});

test("doctor: PI_GLOBAL_ALLOW_EXTENSIONS=0 reports the extensions as disabled, and passes", async () => {
	const staged = overlay({ extensions: true });
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(staged, { PI_GLOBAL_ALLOW_EXTENSIONS: "0" }), overlayDeps(out));
	assert.equal(code, 0);
	assert.match(text(), /✓ Overlay extensions present but disabled \(PI_GLOBAL_ALLOW_EXTENSIONS=0\)/);
	assert.doesNotMatch(text(), /LOAD in every job/);
});

test("doctor: a malformed PI_GLOBAL_ALLOW_EXTENSIONS is a hard failure, overlay or not", async () => {
	// The worker refuses to boot on it, so doctor must not report a posture as if one had been chosen --
	// least of all the "false means off" an operator writing that value is counting on.
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(overlay({ extensions: true }), { PI_GLOBAL_ALLOW_EXTENSIONS: "false" }), overlayDeps(out));
	assert.equal(code, 1);
	assert.match(text(), /✗ PI_GLOBAL_ALLOW_EXTENSIONS is "false", which is neither on nor off/);
	assert.match(text(), /the worker refuses to boot on any other value/);
	assert.doesNotMatch(text(), /Overlay extensions (LOAD|present but disabled)/, "no second line guessing how it would have resolved");

	// And with no overlay configured at all: a knob that stops boot stops it either way.
	const { out: o2, text: t2 } = capture();
	const noOverlay = await runDoctor({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_GLOBAL_ALLOW_EXTENSIONS: "yes" }, overlayDeps(o2));
	assert.equal(noOverlay, 1);
	assert.match(t2(), /✗ PI_GLOBAL_ALLOW_EXTENSIONS is "yes"/);
});

// Staged packages (REQ-GLOBAL-PI-OVERLAY): what will actually load, plus every way the pair still goes
// wrong SILENTLY -- the flow runs without the tools it was written for and still exits 0.
const pkg = (over = {}) => ({ name: "pi-fmt", version: "1.2.3", dir: "pi-fmt", ...over });

test("doctor: staged packages LOAD by default -- with no trigger flag anywhere, they still warn", async () => {
	const dir = overlay({ packages: [pkg(), pkg({ name: "pi-lint", version: "0.4.0", dir: "pi-lint" })] });
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(dir, { PI_TRIGGERS_FILE: triggersFile() }), overlayDeps(out));
	assert.equal(code, 0, "loading third-party code an operator staged is the intended posture — warn, don't fail");
	assert.match(text(), /✓ Staged packages present \(pi-fmt@1\.2\.3, pi-lint@0\.4\.0\)/, "the pinned versions are named");
	assert.match(text(), /⚠ Staged packages LOAD in every job \(0 trigger\(s\) opt out with run\.packages: false\)/);
	assert.match(text(), /keep every version exactly pinned/);
	assert.doesNotMatch(text(), /dormant|ARMED/, "there is no dormant state left, and no switch to be armed");
});

test("doctor: the opt-out count is reported, and counted strictly (=== false)", async () => {
	const dir = overlay({ packages: [pkg()] });
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(dir, { PI_TRIGGERS_FILE: triggersFile(false) }), overlayDeps(out));
	assert.equal(code, 0);
	assert.match(text(), /⚠ Staged packages LOAD in every job \(1 trigger\(s\) opt out with run\.packages: false\)/);

	// An explicit `true` is not an opt-out, and no longer arms anything either -- it reads exactly like absent.
	const { out: o2, text: t2 } = capture();
	await runDoctor(overlayEnv(dir, { PI_TRIGGERS_FILE: triggersFile(true) }), overlayDeps(o2));
	assert.match(t2(), /⚠ Staged packages LOAD in every job \(0 trigger\(s\) opt out with run\.packages: false\)/);
});

test("doctor: a manifest entry whose staged dir is gone fails", async () => {
	const dir = overlay({ packages: [pkg(), pkg({ name: "pi-lint", version: "0.4.0", dir: "pi-lint", stage: false })] });
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(dir), overlayDeps(out));
	assert.equal(code, 1, "a name with no dir behind it loads nothing, and pi reports nothing");
	assert.match(text(), /✗ Staged packages present \(pi-fmt@1\.2\.3, pi-lint@0\.4\.0\)/);
	assert.match(text(), /staged dir missing for pi-lint/, "only the entry that is actually gone is named");
});

test("doctor: a packages/ dir with no manifest fails — nothing knows what is staged", async () => {
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(overlay({ packagesNoManifest: true })), overlayDeps(out));
	assert.equal(code, 1);
	assert.match(text(), /✗ Staged packages manifest readable \(packages\/packages\.json\)/);
	assert.match(text(), /import-pi --with-packages/);
});

test("doctor: an admin-like staged package is a hard failure (recursion vector)", async () => {
	const dir = overlay({ packages: [pkg({ name: "dispatch-admin", version: "0.1.0", dir: "dispatch-admin" })] });
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(dir), overlayDeps(out));
	assert.equal(code, 1);
	assert.match(text(), /✗ Staged package looks like the dispatch admin \(dispatch-admin\)/);
	assert.match(text(), /enqueue paid jobs from INSIDE a job container/);
});

test("doctor: run.packages: true with nothing staged is still the silently-package-less job", async () => {
	// The one check the flip does not touch. `true` no longer arms anything, but it is still an operator
	// asserting the flow needs those packages -- and nothing staged still ends in a clean exit 0 without them.
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(overlay({}), { PI_TRIGGERS_FILE: triggersFile(true) }), overlayDeps(out));
	assert.equal(code, 1, "the flow would run without its tools on a clean exit 0");
	assert.match(text(), /✗ 1 trigger\(s\) require staged packages \(run\.packages: true\) but nothing is staged in .*packages/);
	assert.match(text(), /declare them in pi-packages\.json/);
});

test("doctor: run.packages: true with PI_GLOBAL_PI_DIR unset fails", async () => {
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: triggersFile(true) }, // no overlay at all
		overlayDeps(out),
	);
	assert.equal(code, 1);
	assert.match(text(), /✗ 1 trigger\(s\) require staged packages \(run\.packages: true\) but PI_GLOBAL_PI_DIR is unset/);
	assert.match(text(), /staged packages live inside the overlay and are mounted with it/);
});

test("doctor: run.packages: false with nothing staged is a NO-OP, not a failure", async () => {
	// Under the old posture an unmatched flag meant a flow silently missing its tools. An opt-out from a
	// stage that does not exist takes nothing away, so it is no longer worth a line of the operator's time.
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(overlay({}), { PI_TRIGGERS_FILE: triggersFile(false) }), overlayDeps(out));
	assert.equal(code, 0);
	assert.doesNotMatch(text(), /package/i, "nothing staged and nothing wanted: nothing to say");
});

test("doctor: a deployment with no packages and no trigger flag prints no package line at all", async () => {
	const clean = overlay({ models: JSON.stringify({ providers: { anthropic: { name: "Anthropic" } } }) });
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(clean, { PI_TRIGGERS_FILE: triggersFile() }), overlayDeps(out));
	assert.equal(code, 0);
	assert.doesNotMatch(text(), /package/i, "a non-adopter's output is unchanged by this feature");
});

// PI_AUTH_FROM_PI: the provider key may live in pi's auth.json, not the env — doctor reads it (real fs).
function agentDirWith(cred) {
	const dir = mkdtempSync(join(tmpdir(), "pi-agent-"));
	writeFileSync(join(dir, "auth.json"), JSON.stringify({ anthropic: cred }));
	return dir;
}

test("doctor: an api_key in pi auth.json passes the provider-key check BY DEFAULT (no flag set)", async () => {
	const dir = agentDirWith({ type: "api_key", key: "sk-x" });
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", PI_CODING_AGENT_DIR: dir }, // no ANTHROPIC_API_KEY, no PI_AUTH_FROM_PI — default on
		{ out, cwd: tmpdir(), spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0" },
	);
	assert.equal(code, 0, "the key comes from pi by default, so doctor is green");
	assert.match(text(), /from pi auth\.json/);
});

test("doctor: PI_AUTH_FROM_PI=0 forces env-only — the pi login is ignored", async () => {
	const dir = agentDirWith({ type: "api_key", key: "sk-x" });
	const { out } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", PI_CODING_AGENT_DIR: dir, PI_AUTH_FROM_PI: "0" }, // opt out
		{ out, cwd: tmpdir(), spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0" },
	);
	assert.equal(code, 1, "with the fallback disabled, a missing env key fails the check");
});

test("doctor: an OAuth login in pi auth.json is flagged as not usable for a service", async () => {
	const dir = agentDirWith({ type: "oauth", access_token: "x" });
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", PI_CODING_AGENT_DIR: dir },
		{ out, cwd: tmpdir(), spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0" },
	);
	assert.equal(code, 1, "an OAuth/subscription login is not a usable service credential");
	assert.match(text(), /OAuth\/subscription/);
});

// GITHUB_AUTH_SOURCE=gh (the default) forwards the operator's full gh login into every token-carrying job
// container (CONST-TOKEN-SCOPED-PER-JOB) — doctor surfaces the trade-off as a warning, never a failure.
const ghDeps = (out, plan, calls) => ({ out, spawn: fakeSpawn(plan, calls), probeValkey: async () => true, fileExists: () => true, nodeVersion: "22.19.0" });
const ghEnv = (extra = {}) => ({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", ...extra });

test("doctor: default source gh warns with the login's scopes and names the broad ones", async () => {
	const { out, text } = capture();
	const code = await runDoctor(ghEnv(), ghDeps(out, { ...green, "gh auth status": { code: 0, output: ghStatusOutput } }));
	assert.equal(code, 0, "the scope warning never fails doctor");
	assert.match(text(), /⚠ GITHUB_AUTH_SOURCE=gh forwards your full gh login into every token-carrying job container \(scopes: gist, read:org, repo, workflow\)/);
	assert.match(text(), /this token carries broad scopes \(workflow\)/, "broad scopes are called out by name");
	assert.match(text(), /fine-grained PAT \(GITHUB_AUTH_SOURCE=pat\) or a GitHub App/);
});

test("doctor: a fine-grained token (no scopes line) is reported as such", async () => {
	const { out, text } = capture();
	await runDoctor(ghEnv(), ghDeps(out, { ...green, "gh auth status": { code: 0, output: "github.com\n  ✓ Logged in to github.com account octocat\n" } }));
	assert.match(text(), /scopes not reported \(fine-grained token\)/);
	assert.doesNotMatch(text(), /broad scopes/);
});

test("doctor: GITHUB_AUTH_SOURCE=pat emits no scope warning", async () => {
	const { out, text } = capture();
	await runDoctor(ghEnv({ GITHUB_AUTH_SOURCE: "pat" }), ghDeps(out, green));
	assert.doesNotMatch(text(), /forwards your full gh login/);
});

test("doctor: source gh with gh missing warns 'auth status failed', still exits 0", async () => {
	const { out, text } = capture();
	const code = await runDoctor(ghEnv(), ghDeps(out, { ...green, "gh auth": "enoent" }));
	assert.equal(code, 0, "a local-only deployment with the default source is valid — warn, don't fail");
	assert.match(text(), /⚠ GITHUB_AUTH_SOURCE is gh but `gh auth status` failed/);
	assert.match(text(), /run `gh auth login` \(or switch GITHUB_AUTH_SOURCE\)/);
});

test("doctor: the in-image probe passes the token via the spawn env, never argv", async () => {
	const calls = [];
	const { out, text } = capture();
	const plan = {
		...green,
		"gh auth status": { code: 0, output: ghStatusOutput },
		"gh auth token": { code: 0, output: "gho_fake_mint_123\n" },
		"docker run": 0,
	};
	const code = await runDoctor(ghEnv(), ghDeps(out, plan, calls));
	assert.equal(code, 0);
	const run = calls.find((c) => c.cmd === "docker" && c.args[0] === "run");
	assert.ok(run, "the in-image probe spawned docker run");
	assert.equal(run.args[run.args.indexOf("--entrypoint") + 1], "gh", "the image entrypoint is overridden to gh");
	// value-less -e flags: only the names appear in argv, the values ride the spawn env
	assert.deepEqual(run.args.filter((_, i) => run.args[i - 1] === "-e"), ["GH_TOKEN", "GITHUB_TOKEN"]);
	assert.ok(!run.args.some((a) => a.includes("gho_fake_mint_123")), "the token never enters argv");
	assert.equal(run.opts.env.GH_TOKEN, "gho_fake_mint_123");
	assert.equal(run.opts.env.GITHUB_TOKEN, "gho_fake_mint_123");
	assert.match(text(), /✓ gh authenticates inside the job image \(pi-job:latest\)/);
	assert.doesNotMatch(text(), /gho_fake_mint_123/, "the token never reaches output");
});

test("doctor: an in-image gh auth failure warns with the egress fix, exits 0", async () => {
	const { out, text } = capture();
	const plan = { ...green, "gh auth status": { code: 0, output: ghStatusOutput }, "gh auth token": { code: 0, output: "gho_x\n" }, "docker run": 1 };
	const code = await runDoctor(ghEnv(), ghDeps(out, plan));
	assert.equal(code, 0, "an in-container auth failure warns but never fails doctor");
	assert.match(text(), /⚠ gh cannot authenticate inside the job image \(pi-job:latest\)/);
	assert.match(text(), /check network egress from containers/);
});

test("doctor: no in-image probe when docker is not green (gating)", async () => {
	const calls = [];
	const { out } = capture();
	const plan = { "docker info": 1, "gh auth status": { code: 0, output: ghStatusOutput }, "gh auth token": { code: 0, output: "gho_x\n" } };
	await runDoctor(ghEnv(), ghDeps(out, plan, calls));
	assert.ok(!calls.some((c) => c.cmd === "docker" && c.args[0] === "run"), "no docker run on top of a down daemon");
});

test("doctor: GITHUB_AUTH_SOURCE=app skips the in-image probe (mints per-job)", async () => {
	const calls = [];
	const { out, text } = capture();
	const code = await runDoctor(ghEnv({ GITHUB_AUTH_SOURCE: "app" }), ghDeps(out, green, calls));
	assert.equal(code, 0);
	assert.match(text(), /✓ in-image gh auth: skipped \(GITHUB_AUTH_SOURCE=app mints per-job\)/);
	assert.ok(!calls.some((c) => c.cmd === "docker" && c.args[0] === "run"), "app mints per-job — nothing to preflight");
	assert.doesNotMatch(text(), /forwards your full gh login/, "no scope warning for source app");
});

// -- replica runs (REQ-REPLICA-RUNS): the multiplier is worth stating, not worth failing on ------------

/** A triggers file with one github label trigger, optionally carrying `run.replicas`. */
function replicaTriggersFile(replicas) {
	const path = join(mkdtempSync(join(tmpdir(), "pi-triggers-rep-")), "triggers.json");
	const run = { kind: "github", flow: "fix", ...(replicas === undefined ? {} : { replicas }) };
	writeFileSync(path, JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi:fix"] }, run }] }));
	return path;
}

test("doctor: a replicating trigger warns with the budget arithmetic, and never fails", async () => {
	// An opt-in an operator chose in a reviewed file, so the harness is doing exactly what was asked. What
	// is worth saying is that each replica reserves its OWN slot before its own tokens, so the daily cap
	// simply divides -- the caps stay the ceiling and that IS the feature.
	const { out, text } = capture();
	const code = await runDoctor(imgEnv({ PI_TRIGGERS_FILE: replicaTriggersFile(2) }), imgDeps(out, green));
	assert.match(text(), /1 trigger\(s\) set run\.replicas/);
	assert.match(text(), /budget slot PER replica/);
	// In the LABEL, not the fix: an `ok: true` check never prints its fix line, and "they queue instead of
	// racing" is the half an operator most often has wrong.
	assert.match(text(), /PI_CONCURRENCY bounds how many actually race/);
	assert.notEqual(code, 1, "a chosen opt-in is a warning, never a hard failure");
});

test("doctor: a deployment with no run.replicas anywhere prints no replica line at all", async () => {
	const { out, text } = capture();
	await runDoctor(imgEnv({ PI_TRIGGERS_FILE: replicaTriggersFile() }), imgDeps(out, green));
	assert.doesNotMatch(text(), /run\.replicas/, "a deployment that does not use the feature is not told about it");
});
