import { execFileSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { makeWaitChecker } from "../src/wait-check.mjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { CANARY_PROBE_SLUGS, ENV_FILE_READABLE_KEYS, backendChecks, collectChecks, defaultPromptFn, envFileKeys, githubProtectionPreflight, jobUserChecks, liveChecks, runDoctor } from "../src/doctor.mjs";
import { egressCanaryProbe } from "../src/egress.mjs";
import { JOB_USER_FIX, parseDaemonFacts } from "../src/job-user.mjs";
import { underOsTempDir } from "../src/config.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// env-allowlist imports @earendil-works/pi-ai, which needs node >=22.19.0 and installed deps. doctor.mjs
// itself reaches it through `await import` for exactly that reason, and a STATIC import here would undo
// that: on a below-floor or dependency-less box the whole file would throw at load and every doctor test
// would ERROR instead of skipping, with PI_DISPATCH_REQUIRE_WORKER_TESTS -- the mechanism built to tell
// those two cases apart -- never getting to speak. Same guard as env-allowlist.test.mjs, same reason.
let piMod;
let piImportError;
try {
	piMod = await import("../src/env-allowlist.mjs");
} catch (error) {
	piImportError = error;
}
if (!piMod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`the doctor provider-key tests are REQUIRED here but pi-ai could not import.\n${piImportError}`);
}
const skipNoPi = piMod ? false : `pi-ai not installed (node ${process.version} < 22.19.0); CI runs these`;

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
			// A FUNCTION outcome answers from the argv (issue #278's --live sequence, where a later step reads what an
			// earlier one was given); it may also act, as the in-container write does on the host fixture.
			const resolved = typeof outcome === "function" ? outcome(cmd, args) : outcome;
			const { code, output, stderr } = typeof resolved === "object" && resolved !== null ? resolved : { code: resolved, output: "" };
			// stderr FIRST, as podman-docker's banner arrives before the answer (issue #345).
			if (stderr) child.stderr.handlers.data?.(stderr);
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
/**
 * Drop the issue #189 flow-resolution lines (label + the → fix line under it). They name "staged
 * packages" as a TIER, so the package-feature no-op pins below keep their deliberately broad
 * /package/i needle by asserting on everything else.
 */
function stripFlowLines(output) {
	const lines = output.split("\n");
	const kept = [];
	for (let i = 0; i < lines.length; i++) {
		if (/Trigger flow /.test(lines[i])) {
			if (lines[i + 1]?.startsWith("    →")) i++;
			continue;
		}
		kept.push(lines[i]);
	}
	return kept.join("\n");
}
// A host where everything is in place -- INCLUDING the egress policy, which is armed by default now
// (REQ-EGRESS-ALLOWLIST). The egress keys come FIRST so they win the prefix match over a later, broader
// "docker run" a test may plan for the in-image gh probe. A correct policy reaches the provider (exit 0)
// and is blocked from an unlisted host (exit 3).
// A HEALTHY egress policy, as docker would answer (REQ-EGRESS-ALLOWLIST). Spread into every plan that
// wants a working host, because the policy is armed by DEFAULT now: a plan that omits these describes a
// deployment whose proxy is down, and doctor is right to fail it. Listed FIRST wherever it is spread, so
// these specific keys win the prefix match over a later, broader "docker run" a test plans for the
// in-image gh probe. A correct policy reaches the provider (exit 0) and is blocked from an unlisted host
// (exit 3), which is what makes both directions of the allowlist assertable.
const EGRESS_OK = {
	// Issue #278: the docker CLI's endpoint, answered as a local socket. Here rather than only in `green`,
	// because plans that build on EGRESS_OK without `green` would otherwise read an unresolved endpoint.
	"docker context inspect": { code: 0, output: '"desktop-linux"|"unix:///Users/x/.docker/run/docker.sock"\n' },
	"docker inspect --format={{.State.Running}}": { code: 0, output: "true|healthy\n" },
	"docker network": 0,
	"docker run --rm --name pi-dispatch-egress-probe-provider": 0,
	"docker run --rm --name pi-dispatch-egress-probe-unlisted": 3,
};
const green = { ...EGRESS_OK, "docker info": 0, "docker image": 0 };
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
		{ out, spawn: fakeSpawn({ "docker info": 1 }), probeValkey: async () => false, fileExists: () => true, nodeVersion: "22.19.0", agentDir: NO_AGENT_DIR },
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
function overlay({ auth = false, models, extensions = false, packages, packagesNoManifest = false, skills } = {}) {
	const dir = tempDir("pi-overlay-");
	if (auth) writeFileSync(join(dir, "auth.json"), "{}");
	if (models !== undefined) writeFileSync(join(dir, "models.json"), models);
	if (extensions) mkdirSync(join(dir, "extensions", "x"), { recursive: true });
	// The overlay's own skills/ tier (issue #189): `<overlay>/skills/<name>/SKILL.md`.
	for (const s of skills ?? []) {
		mkdirSync(join(dir, "skills", s), { recursive: true });
		writeFileSync(join(dir, "skills", s, "SKILL.md"), `---\ndescription: overlay ${s}\n---\n`);
	}
	if (packages || packagesNoManifest) {
		const pkgDir = join(dir, "packages");
		mkdirSync(pkgDir, { recursive: true });
		for (const p of packages ?? []) {
			if (p.stage === false) continue;
			mkdirSync(join(pkgDir, p.dir), { recursive: true });
			// package.json only when the entry declares skills or a pi manifest, so every pre-#189
			// fixture stays byte-identical (readStagedSkills skips a package it cannot read, as pi would).
			if (p.skills !== undefined || p.pi !== undefined) {
				writeFileSync(join(pkgDir, p.dir, "package.json"), JSON.stringify({ name: p.name, version: p.version, ...(p.pi !== undefined ? { pi: p.pi } : {}) }));
			}
			for (const s of p.skills ?? []) {
				mkdirSync(join(pkgDir, p.dir, "skills", s), { recursive: true });
				writeFileSync(join(pkgDir, p.dir, "skills", s, "SKILL.md"), `---\ndescription: pkg ${s}\n---\n`);
			}
		}
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
function triggersFile(packages, image, extra = {}) {
	const path = join(tempDir("pi-triggers-"), "triggers.json");
	const run = { kind: "local", folder: "/srv/repo", flow: "review", task: "nightly review", ...(packages === undefined ? {} : { packages }), ...(image === undefined ? {} : { image }), ...extra };
	writeFileSync(path, JSON.stringify({ triggers: [{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run }] }));
	return path;
}
const overlayEnv = (dir, extra = {}) => ({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_GLOBAL_PI_DIR: dir, ...extra });
// `agentDir` points at a path that does not exist, so the host-vs-overlay comparison (issue #102) finds
// nothing and, crucially, never reads the developer's real ~/.pi/agent or spawns their package manager.
// A test that wants the comparison passes its own agentDir.
// An agent dir that cannot hold an auth.json, for every test that means "this deployment has NO
// credential". Without it the provider-key check reads the DEVELOPER's real ~/.pi/agent/auth.json, so a
// box where someone has run `pi login` disagrees with CI about whether a key exists (issue #286).
const NO_AGENT_DIR = join(tmpdir(), "pi-dispatch-no-such-agent-dir");
const overlayDeps = (out, extra = {}) => ({ out, cwd: tmpdir(), spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0", agentDir: NO_AGENT_DIR, ...extra });

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
	const plan = { ...EGRESS_OK, "docker info": 0, "docker image inspect pi-job:latest": 0, "docker image inspect my-python:1.2.0": 1, "docker image": 0 };
	const code = await runDoctor(imgEnv({ PI_TRIGGERS_FILE: triggersFile(undefined, "my-python:1.2.0") }), imgDeps(out, plan));
	assert.equal(code, 1, "a trigger that can never run is a hard failure, not a warning");
	assert.match(text(), /✗ Trigger job image present \(my-python:1\.2\.0\)/);
	assert.match(text(), /--pull=never/, "the fix names why waiting will not help");
});

test("doctor: a trigger image present but without the runner entrypoint WARNS, never fails", async () => {
	// An image without the runner can exit 0 without ever starting the agent, and the queue records that as
	// success. But an operator may legitimately wrap the entrypoint, so ✗ is not ours to claim.
	const { out, text } = capture();
	const plan = { ...EGRESS_OK, "docker info": 0, "docker image inspect --format": { code: 0, output: '["/bin/sh"]\n' }, "docker image": 0 };
	const code = await runDoctor(imgEnv({ PI_TRIGGERS_FILE: triggersFile(undefined, "my-python:1.2.0") }), imgDeps(out, plan));
	assert.equal(code, 0, "warn, never fail");
	assert.match(text(), /⚠ my-python:1\.2\.0 does not appear to carry the pi-dispatch runner entrypoint/);
	assert.match(text(), /docs\/job-image\.md/);
});

test("doctor: a conformant trigger image passes both checks silently", async () => {
	const { out, text } = capture();
	const plan = { ...EGRESS_OK, "docker info": 0, "docker image inspect --format": RUNNER_ENTRYPOINT, "docker image": 0 };
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
	assert.doesNotMatch(stripFlowLines(text()), /package/i, "nothing staged and nothing wanted: nothing to say");
});

test("doctor: a deployment with no packages and no trigger flag prints no package line at all", async () => {
	const clean = overlay({ models: JSON.stringify({ providers: { anthropic: { name: "Anthropic" } } }) });
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(clean, { PI_TRIGGERS_FILE: triggersFile() }), overlayDeps(out));
	assert.equal(code, 0);
	assert.doesNotMatch(stripFlowLines(text()), /package/i, "a non-adopter's output is unchanged by this feature");
});

// PI_AUTH_FROM_PI: the provider key may live in pi's auth.json, not the env — doctor reads it (real fs).
function agentDirWith(cred) {
	const dir = tempDir("pi-agent-");
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

test("doctor: a non-string key in pi auth.json is reported, and does not take doctor down with it", async () => {
	// The read sits OUTSIDE the try that wraps the JSON.parse, so `cred.key?.trim()` on a number or an
	// object threw a TypeError and killed the whole run: every later check went unreported, and the
	// operator saw a crash instead of the one line that names the problem. pi validates no schema on that
	// file, so a hand edit is all it takes. The worker refuses such a credential (issue #311); doctor has
	// to survive long enough to say so.
	for (const key of [12345, { a: 1 }, ["sk-x"], true]) {
		const dir = agentDirWith({ type: "api_key", key });
		const { out, text } = capture();
		const code = await runDoctor(
			{ PI_PROVIDER: "anthropic", PI_CODING_AGENT_DIR: dir },
			{ out, cwd: tmpdir(), spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0" },
		);
		assert.equal(code, 1, `${JSON.stringify(key)}: not a credential any job could spend`);
		assert.match(text(), /not a string/);
		// The run reached the end rather than dying at that line: a later check still reported.
		assert.match(text(), /Valkey/);
	}
});

test("doctor: a pi login stored as a command or a variable reference is not reported green", async () => {
	// pi resolves "!cmd" and "$VAR" itself when IT reads auth.json. This service forwards the value into a
	// container, where an environment variable is read raw, so the job gets the source text and fails auth.
	// A non-empty string used to be enough for a green line, which is the false green issue #286 is about.
	for (const key of ["!op read op://vault/pi/anthropic", "$ANTHROPIC_API_KEY"]) {
		const dir = agentDirWith({ type: "api_key", key });
		const { out, text } = capture();
		const code = await runDoctor(
			{ PI_PROVIDER: "anthropic", PI_CODING_AGENT_DIR: dir },
			{ out, cwd: tmpdir(), spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0" },
		);
		assert.equal(code, 1, `${key}: the worker refuses this, so doctor must not be green`);
		assert.match(text(), /command or variable reference/);
	}
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

// ── The provider key is PI's fact, asked of pi (issue #286) ──────────────────────────────────────
// doctor used to carry a hand-written provider->variable table. It had drifted three ways, and each way
// let a deployment pass doctor that the worker then refused pre-spend on every job. These pin the
// acceptance of #286 against pi itself; none of them asserts a copied table.
const provEnv = (extra) => ({ PI_AUTH_FROM_PI: "0", ...extra });
const provDeps = (out) => ({ out, cwd: tmpdir(), spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0", agentDir: NO_AGENT_DIR });

test("doctor NAMES the variable the worker WRITES, for every provider pi has (issue #311)", { skip: skipNoPi }, async () => {
	// The anti-drift bolt, and it has to live HERE, because this is the file where doctor's real output is
	// available. env-allowlist.test.mjs cannot carry it: over there both sides of the comparison would be
	// `apiKeyVariable(providerKeyCandidates(id))`, so a doctor that stopped calling the shared selection
	// would leave it green. This drives the REAL runDoctor and reads the variable out of its fix line, then
	// drives the REAL buildContainerEnv and reads the variable the credential landed in. A mismatch is the
	// #286 defect: a green setup line pointing at a name no job uses.
	const { buildContainerEnv, piProviders, providerKeyCandidates } = await import("../src/env-allowlist.mjs");
	const mismatches = [];
	for (const id of [...piProviders(), "radius"]) {
		if (providerKeyCandidates(id).length === 0) continue; // no key variable: doctor names none, worker refuses
		const { out, text } = capture();
		// No key set anywhere, so doctor takes the arm that has to NAME a variable rather than report one.
		await runDoctor(provEnv({ PI_PROVIDER: id }), provDeps(out));
		const named = text().match(/set ([A-Z0-9_]+) in \.env/)?.[1];
		const env = buildContainerEnv({
			provider: id,
			model: "m",
			maxTurns: 5,
			jobId: "j",
			agentDir: "/home/u/.pi/agent",
			hostEnv: { HOME: "/root" },
			authFromPi: true,
			readFile: () => JSON.stringify({ [id]: { type: "api_key", key: "sk-x" } }),
		});
		const written = Object.keys(env).find((k) => env[k] === "sk-x");
		if (named !== written) mismatches.push(`${id}: doctor says ${named}, worker writes ${written}`);
	}
	assert.deepEqual(mismatches, [], "doctor and the container path must name the same variable");
});

test("doctor: PI_PROVIDER=google with only GOOGLE_API_KEY fails, and the failure names GEMINI_API_KEY", { skip: skipNoPi }, async () => {
	const { out, text } = capture();
	const code = await runDoctor(provEnv({ PI_PROVIDER: "google", GOOGLE_API_KEY: "g" }), provDeps(out));
	assert.equal(code, 1, "the worker would refuse every job here, so doctor must not be green");
	assert.match(text(), /Provider key set \(google: GEMINI_API_KEY\)/, "it names the variable pi actually reads");
	assert.match(text(), /set GEMINI_API_KEY in \.env/, "and the fix line names it too");
	// The whole defect in one assertion: GOOGLE_API_KEY is not a name pi reads, for google or anything
	// else, so doctor must never print it again -- not as a candidate, not as a fix.
	assert.doesNotMatch(text(), /GOOGLE_API_KEY/, "the invented variable is gone from doctor's vocabulary");
});

test("doctor: PI_PROVIDER=gemini says pi has no such provider, and derives the one they meant", { skip: skipNoPi }, async () => {
	const { out, text } = capture();
	const code = await runDoctor(provEnv({ PI_PROVIDER: "gemini", GEMINI_API_KEY: "g" }), provDeps(out));
	assert.equal(code, 1, "pi has no `gemini` provider, so no key could ever satisfy it");
	assert.match(text(), /is not a provider pi has/);
	// Derived, not guessed: pi is asked which provider reads GEMINI_API_KEY. Edit distance would never
	// find this -- `gemini` and `google` differ by five characters.
	assert.match(text(), /set PI_PROVIDER=google/, "the suggestion comes from pi's own table");
});

test("doctor: a provider pi DOES know, with its key set, still passes", { skip: skipNoPi }, async () => {
	for (const [provider, variable] of [["anthropic", "ANTHROPIC_API_KEY"], ["openai", "OPENAI_API_KEY"], ["google", "GEMINI_API_KEY"], ["xai", "XAI_API_KEY"]]) {
		const { out, text } = capture();
		const code = await runDoctor(provEnv({ PI_PROVIDER: provider, [variable]: "sk-x" }), provDeps(out));
		assert.equal(code, 0, `${provider} with ${variable} set is a working deployment`);
		assert.match(text(), new RegExp(`✓ Provider key set \\(${provider}: ${variable}\\)`));
		assert.doesNotMatch(text(), /✗/, `${provider}: no hard failures`);
	}
});

test("doctor: an OAuth token in the ENV is reported, never silently blessed", { skip: skipNoPi }, async () => {
	// It used to pass in silence: the old table listed ANTHROPIC_OAUTH_TOKEN as a credential that works.
	// A warn, not a failure -- the worker forwards it and the job DOES run, so a ✗ would put doctor back
	// in disagreement with the worker, which is the disease rather than the cure.
	const { out, text } = capture();
	const code = await runDoctor(provEnv({ PI_PROVIDER: "anthropic", ANTHROPIC_OAUTH_TOKEN: "oauth" }), provDeps(out));
	assert.equal(code, 0, "a warn does not fail the run");
	assert.match(text(), /⚠ Provider key set \(anthropic: ANTHROPIC_OAUTH_TOKEN\) -- an OAuth\/subscription login/);
	assert.match(text(), /set ANTHROPIC_API_KEY instead/, "the fix names an API key, never the OAuth token");

	// Both set: pi reads the OAuth token FIRST, so the API key the operator thinks they configured is
	// the one being ignored. That is the sentence they need, and the old check printed neither.
	const second = capture();
	await runDoctor(provEnv({ PI_PROVIDER: "anthropic", ANTHROPIC_OAUTH_TOKEN: "oauth", ANTHROPIC_API_KEY: "sk-x" }), provDeps(second.out));
	assert.match(second.text(), /unset ANTHROPIC_OAUTH_TOKEN: pi reads it BEFORE ANTHROPIC_API_KEY/);
});

test("doctor: a whitespace value is refused against the variable pi will actually read", async () => {
	// The trap this replaced a `.trim()` presence filter to close. A blank OAuth token beside a real API
	// key USED to read as "the API key is set, all good" -- while pi, whose truthiness is plain, reads the
	// token, wins precedence with it, and fails auth on every job. doctor must name the variable pi reads.
	const { out, text } = capture();
	const code = await runDoctor(provEnv({ PI_PROVIDER: "anthropic", ANTHROPIC_OAUTH_TOKEN: "   ", ANTHROPIC_API_KEY: "sk-real" }), provDeps(out));
	assert.equal(code, 1, "the deployment cannot run a job, so doctor is not green");
	assert.match(text(), /Provider key set \(anthropic: ANTHROPIC_OAUTH_TOKEN\) -- but the value is whitespace/);
	assert.doesNotMatch(text(), /✓ Provider key set/, "the real API key beside it does not rescue the line");
});

test("doctor: a whitespace key in pi auth.json is refused too, on the same argument", async () => {
	// doctor and the worker AGREE on this one -- they agree on a credential that cannot buy anything,
	// which is the failure REQ-DEPLOYMENT-BOOTSTRAP's new clause names.
	const dir = agentDirWith({ type: "api_key", key: "   " });
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", PI_CODING_AGENT_DIR: dir },
		{ out, cwd: tmpdir(), spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0" },
	);
	assert.equal(code, 1);
	assert.match(text(), /the key in pi auth\.json is whitespace/);
});

test("doctor: a tree where pi cannot load FAILS -- it never reports ready on an unusable deployment", async () => {
	// The regression this guards is the worst one available here: doctor's own import graph has no
	// external specifiers, so it runs on a tree with no node_modules -- where the Node floor is green,
	// the worker cannot boot at all, and a warn would let doctor print "ready" and exit 0.
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" },
		{ out, spawn: fakeSpawn(green), probeValkey: async () => true, fileExists: () => true, nodeVersion: "22.19.0", providerOracle: async () => ({ loadError: Object.assign(new Error("no pi here"), { code: "ERR_MODULE_NOT_FOUND" }) }) },
	);
	assert.equal(code, 1, "green floor plus absent dependency is a hard failure, not an advisory");
	assert.match(text(), /✗ Provider key: not checked \(pi did not load/);

	// Below the floor the SAME state warns instead, because the Node check beside it already failed hard
	// and one root cause printing two ✗ reads as two problems.
	const below = capture();
	const belowCode = await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" },
		{ out: below.out, spawn: fakeSpawn(green), probeValkey: async () => true, fileExists: () => true, nodeVersion: "20.10.0", providerOracle: async () => null },
	);
	assert.equal(belowCode, 1, "the Node floor is what fails it");
	assert.match(below.text(), /⚠ Provider key: not checked/);
});

test("doctor: a broken provider table is named as such, never blamed on a missing dependency", async () => {
	// A bare `catch {}` reported a SyntaxError in our OWN module as "pi did not load", and doctor went on
	// to say ready. The error is carried and printed instead.
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" },
		{ out, spawn: fakeSpawn(green), probeValkey: async () => true, fileExists: () => true, nodeVersion: "22.19.0", providerOracle: async () => ({ loadError: new SyntaxError("unexpected token") }) },
	);
	assert.equal(code, 1);
	assert.match(text(), /loading the provider table failed: unexpected token/);
});

test("doctor: a host where pi will not load warns instead of guessing a variable name", async () => {
	// Below-floor Node, or a tree with no dependencies. The Node-floor check above already failed HARD
	// for the cause, so this warns rather than printing a second ✗ for one root cause -- and it names no
	// variable at all, because guessing one is the defect #286 is about.
	const checks = await collectChecks({ PI_PROVIDER: "google" }, collectSeams(green, { providerOracle: async () => null }));
	const c = checks.find((x) => /^Provider key/.test(x.label));
	assert.ok(c, "the check still appears");
	assert.equal(c.ok, false);
	assert.equal(c.warn, true, "one root cause, one hard failure");
	assert.equal(c.fixAction, undefined, "never tier");
	assert.doesNotMatch(`${c.label} ${c.fix}`, /_API_KEY/, "it does not invent a variable it could not ask for");
	assert.doesNotMatch(`${c.label} ${c.fix}`, /package/i, "and does not trip the staged-packages no-op pins");
});

// GITHUB_AUTH_SOURCE=gh (the default) forwards the operator's full gh login into every token-carrying job
// container (CONST-TOKEN-SCOPED-PER-JOB) — doctor surfaces the trade-off as a warning, never a failure.
const ghDeps = (out, plan, calls, extra = {}) => ({ out, spawn: fakeSpawn(plan, calls), probeValkey: async () => true, fileExists: () => true, nodeVersion: "22.19.0", ...extra });
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
	// The gh probe specifically: the egress checks run their own containers, so "the first docker run" is
	// no longer the same thing as "the one this test is about".
	const run = calls.find((c) => c.cmd === "docker" && c.args[0] === "run" && c.args.includes("gh"));
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
	assert.ok(
		!calls.some((c) => c.cmd === "docker" && c.args[0] === "run" && c.args.includes("gh")),
		"app mints per-job — nothing to preflight (the egress probes are a different check and still run)",
	);
	assert.doesNotMatch(text(), /forwards your full gh login/, "no scope warning for source app");
});

// -- GITHUB_AUTH_SOURCE=app completeness (issue #81): the credential triple, preflighted -----------------
//
// Real temp files for the key, like the overlay tests above: the mode check stats a real mode and the
// PEM sniff reads real leading bytes. cwd points at tmpdir and fileExists stays the default, so only
// the app-auth env drives these outcomes; everything else warns at most (and warns never fail).

const KEY_BODY = "sk-app-key-body-distinctive"; // planted so no-contents-in-output is a grep, not a hope
function appKeyFile({ content = `-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n-----END PRIVATE KEY-----\n`, mode = 0o600 } = {}) {
	const path = join(tempDir("pi-app-key-"), "github-app-test.pem");
	writeFileSync(path, content);
	chmodSync(path, mode);
	return path;
}
const appEnv = (extra = {}) => ({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", GITHUB_AUTH_SOURCE: "app", ...extra });
const appDeps = (out) => ({ out, cwd: tmpdir(), spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0" });

test("doctor: a complete app-auth triple with a locked-down PEM is all green, contents never in output", async () => {
	const keyPath = appKeyFile();
	const { out, text } = capture();
	const code = await runDoctor(appEnv({ GITHUB_APP_ID: "4242", GITHUB_APP_INSTALLATION_ID: "987654", GITHUB_APP_PRIVATE_KEY_PATH: keyPath }), appDeps(out));
	assert.equal(code, 0);
	assert.match(text(), /✓ GITHUB_APP_ID set \(4242\)/);
	assert.match(text(), /✓ GITHUB_APP_INSTALLATION_ID set \(987654\)/);
	assert.match(text(), new RegExp(`✓ GitHub App private key present \\(${keyPath.replace(/[.\\/]/g, "\\$&")}\\)`));
	assert.doesNotMatch(text(), /group\/world-readable/);
	assert.doesNotMatch(text(), /does not look like a PEM/);
	assert.doesNotMatch(text(), new RegExp(KEY_BODY), "the key's contents must never reach output");
});

test("doctor: app source with the whole triple unset warns per variable, points at setup github, exits 0", async () => {
	const { out, text } = capture();
	const code = await runDoctor(appEnv(), appDeps(out));
	assert.equal(code, 0, "app-auth completeness warns, never fails — a deployment can be mid-setup");
	assert.match(text(), /⚠ GITHUB_AUTH_SOURCE=app but GITHUB_APP_ID is unset/);
	assert.match(text(), /⚠ GITHUB_AUTH_SOURCE=app but GITHUB_APP_INSTALLATION_ID is unset/);
	assert.match(text(), /⚠ GITHUB_AUTH_SOURCE=app but neither GITHUB_APP_PRIVATE_KEY_PATH nor GITHUB_APP_PRIVATE_KEY is set/);
	assert.match(text(), /run `pi-dispatch setup github`/, "the fix is the wizard that mints all three");
});

test("doctor: a non-numeric GITHUB_APP_ID is named as such (an id is not a secret, so it IS echoed)", async () => {
	const { out, text } = capture();
	const code = await runDoctor(appEnv({ GITHUB_APP_ID: "Iv1.oops", GITHUB_APP_INSTALLATION_ID: "987654", GITHUB_APP_PRIVATE_KEY_PATH: appKeyFile() }), appDeps(out));
	assert.equal(code, 0);
	assert.match(text(), /⚠ GITHUB_AUTH_SOURCE=app but GITHUB_APP_ID is not numeric \("Iv1\.oops"\)/);
	assert.match(text(), /✓ GITHUB_APP_INSTALLATION_ID set \(987654\)/, "the other two are judged independently");
});

test("doctor: a key path that points at nothing warns with the path", async () => {
	const { out, text } = capture();
	const missing = join(tmpdir(), "no-such-github-app.pem");
	const code = await runDoctor(appEnv({ GITHUB_APP_ID: "4242", GITHUB_APP_INSTALLATION_ID: "987654", GITHUB_APP_PRIVATE_KEY_PATH: missing }), appDeps(out));
	assert.equal(code, 0);
	assert.match(text(), new RegExp(`⚠ GITHUB_APP_PRIVATE_KEY_PATH does not exist \\(${missing.replace(/[.\\/]/g, "\\$&")}\\)`));
});

test("doctor: a group/world-readable PEM warns with the chmod fix", { skip: process.platform === "win32" ? "POSIX modes are synthetic on win32 (the check skips itself there)" : false }, async () => {
	const keyPath = appKeyFile({ mode: 0o644 });
	const { out, text } = capture();
	const code = await runDoctor(appEnv({ GITHUB_APP_ID: "4242", GITHUB_APP_INSTALLATION_ID: "987654", GITHUB_APP_PRIVATE_KEY_PATH: keyPath }), appDeps(out));
	assert.equal(code, 0, "a loose mode is a warning, not a failure");
	assert.match(text(), /⚠ the App private key at .* is group\/world-readable/);
	assert.match(text(), new RegExp(`chmod 600 ${keyPath.replace(/[.\\/]/g, "\\$&")}`));
	assert.doesNotMatch(text(), new RegExp(KEY_BODY));
});

test("doctor: a file that does not start with -----BEGIN warns, and its contents are never echoed", async () => {
	const keyPath = appKeyFile({ content: `definitely not a pem ${KEY_BODY}\n` });
	const { out, text } = capture();
	const code = await runDoctor(appEnv({ GITHUB_APP_ID: "4242", GITHUB_APP_INSTALLATION_ID: "987654", GITHUB_APP_PRIVATE_KEY_PATH: keyPath }), appDeps(out));
	assert.equal(code, 0);
	assert.match(text(), /⚠ the file at GITHUB_APP_PRIVATE_KEY_PATH does not look like a PEM \(first line is not "-----BEGIN \.\.\."\)/);
	assert.doesNotMatch(text(), new RegExp(KEY_BODY), "not even a malformed key's contents may reach output");
});

// The key can also be supplied as a VALUE (issue #208), for a deployment whose environment comes from a
// secrets manager. Then there is no file to stat, no mode to judge and nothing for the ignore check to
// ask about -- what survives is the shape sniff and the rule that nothing from the key reaches output.

test("doctor: an inline App key is reported as such, with no file anywhere and no contents echoed", async () => {
	const { out, text } = capture();
	const inline = `-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n-----END PRIVATE KEY-----`;
	const code = await runDoctor(appEnv({ GITHUB_APP_ID: "4242", GITHUB_APP_INSTALLATION_ID: "987654", GITHUB_APP_PRIVATE_KEY: inline }), appDeps(out));
	assert.equal(code, 0);
	assert.match(text(), /✓ GitHub App private key supplied inline \(GITHUB_APP_PRIVATE_KEY\)/);
	assert.doesNotMatch(text(), /GITHUB_APP_PRIVATE_KEY_PATH/, "no path was configured, so none is demanded");
	assert.doesNotMatch(text(), /group\/world-readable|does not ignore it/, "there is no file to have a mode or a repo");
	assert.doesNotMatch(text(), new RegExp(KEY_BODY));
});

test("doctor: both key sources set warns that the worker will refuse to boot", async () => {
	const { out, text } = capture();
	const env = appEnv({ GITHUB_APP_ID: "4242", GITHUB_APP_INSTALLATION_ID: "987654", GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY-----", GITHUB_APP_PRIVATE_KEY_PATH: appKeyFile() });
	const code = await runDoctor(env, appDeps(out));
	assert.equal(code, 0, "doctor still only warns -- the boot refusal is config's job");
	assert.match(text(), /⚠ GITHUB_APP_PRIVATE_KEY and GITHUB_APP_PRIVATE_KEY_PATH are both set/);
	assert.match(text(), /unset one of them/);
});

test("doctor: an inline value that is not a PEM warns, and its contents are never echoed", async () => {
	const { out, text } = capture();
	const code = await runDoctor(appEnv({ GITHUB_APP_ID: "4242", GITHUB_APP_INSTALLATION_ID: "987654", GITHUB_APP_PRIVATE_KEY: `junk ${KEY_BODY}` }), appDeps(out));
	assert.equal(code, 0);
	assert.match(text(), /⚠ GITHUB_APP_PRIVATE_KEY does not look like a PEM/);
	assert.doesNotMatch(text(), new RegExp(KEY_BODY), "not even a malformed key's bytes may reach output");
});

// The key file's mode protects it from other users on this host and does nothing at all once the file is
// in a commit (issue #211). `setup github` writes it into the DEPLOYMENT folder, which is very often a
// checkout, so doctor asks git. `fakeSpawn` matches by prefix and nothing else in these fixtures shells
// out to git, so keying the plan on "git " is unambiguous here.

test("doctor: a key inside a git work tree that does not ignore it warns, with the path and no contents", async () => {
	const keyPath = appKeyFile();
	const { out, text } = capture();
	const deps = { ...appDeps(out), spawn: fakeSpawn({ ...green, "git ": 1 }) };
	const code = await runDoctor(appEnv({ GITHUB_APP_ID: "4242", GITHUB_APP_INSTALLATION_ID: "987654", GITHUB_APP_PRIVATE_KEY_PATH: keyPath }), deps);
	assert.equal(code, 0, "a committable key is a warning, not a failure -- doctor never fails on hygiene");
	assert.match(text(), new RegExp(`⚠ the App private key at ${keyPath.replace(/[.\\/]/g, "\\$&")} is inside a git work tree that does not ignore it`));
	assert.match(text(), /git add -A/, "the fix says what would actually happen");
	assert.doesNotMatch(text(), new RegExp(KEY_BODY));
});

test("doctor: check-ignore asks about the key path, from the key's own directory", async () => {
	const keyPath = appKeyFile();
	const calls = [];
	const { out } = capture();
	const deps = { ...appDeps(out), spawn: fakeSpawn({ ...green, "git ": 1 }, calls) };
	await runDoctor(appEnv({ GITHUB_APP_ID: "4242", GITHUB_APP_INSTALLATION_ID: "987654", GITHUB_APP_PRIVATE_KEY_PATH: keyPath }), deps);
	const git = calls.find((c) => c.cmd === "git");
	assert.ok(git, "doctor asked git");
	assert.equal(git.args.at(-1), keyPath, "the question is about the key file itself");
	assert.equal(git.args.at(-2), "-q");
	assert.equal(git.args.at(-3), "check-ignore");
	assert.equal(git.args.at(-4), dirname(keyPath), "asked from the key's own directory, not doctor's cwd");
});

test("doctor: an ignored key, a non-repo, and a git that will not launch are all silent", async () => {
	const keyPath = appKeyFile();
	for (const [name, outcome] of [
		["ignored (exit 0)", 0],
		["not a work tree (exit 128)", 128],
		["git missing", "enoent"],
	]) {
		const { out, text } = capture();
		const deps = { ...appDeps(out), spawn: fakeSpawn({ ...green, "git ": outcome }) };
		const code = await runDoctor(appEnv({ GITHUB_APP_ID: "4242", GITHUB_APP_INSTALLATION_ID: "987654", GITHUB_APP_PRIVATE_KEY_PATH: keyPath }), deps);
		assert.equal(code, 0);
		assert.doesNotMatch(text(), /does not ignore it/, `${name}: only a definite "not ignored" may warn`);
	}
});

test("doctor: the app-auth block only fires for source app", async () => {
	const { out, text } = capture();
	await runDoctor(ghEnv({ GITHUB_AUTH_SOURCE: "pat" }), ghDeps(out, green));
	assert.doesNotMatch(text(), /GITHUB_APP_ID/, "pat deployments hear nothing about App credentials");
});

// -- the --env-setup script (issue #216): doctor reads the installed unit, then checks the file -------

// Real files throughout, like the App key fixtures above: the unit is read with the real readFileSync
// and the script's mode is stat'ed. `platform` and `home` are injected because the point is to exercise
// all three unit formats, and only one of them exists on whichever host runs this suite.
//
// The unit bodies below are written by hand rather than rendered. That the hand-written shape and the
// RENDERED shape agree is not this file's job: worker/test/service.test.mjs round-trips every real
// render through readUnitSeam, so the renderer and the reader cannot drift apart unnoticed.
const SETUP_BODY = "export INFISICAL_TOKEN=st.setup-body-distinctive\n"; // planted: must never be echoed

function setupScript({ mode = 0o755, dirMode = 0o755, name = "setup-env.sh" } = {}) {
	const dir = tempDir("pi-env-setup-");
	const path = join(dir, name);
	writeFileSync(path, SETUP_BODY);
	chmodSync(path, mode);
	chmodSync(dir, dirMode);
	return path;
}

const linuxUnit = (deployDir, setup) =>
	`[Service]\nWorkingDirectory=${deployDir}\nEnvironmentFile=${deployDir}/.env\n` +
	(setup
		? `ExecStart=/bin/sh -c 'set -a; . "${setup}" || exit 1; set +a; exec "/usr/bin/node" "/opt/x/cli.mjs" "worker"'\n`
		: `ExecStart=/usr/bin/node /opt/x/cli.mjs worker\n`);

const darwinUnit = (deployDir, setup) =>
	`<dict>\n\t<key>WorkingDirectory</key>\n\t<string>${deployDir}</string>\n\n\t<key>EnvironmentVariables</key>\n\t<dict>\n` +
	`\t\t<key>PATH</key>\n\t\t<string>/usr/bin:/bin</string>\n` +
	(setup ? `\t\t<key>PI_ENV_SETUP</key>\n\t\t<string>${setup}</string>\n` : "") +
	`\t</dict>\n</dict>\n`;

/** Plant a unit in a temp home, in the location `pi-dispatch service install` writes it to. */
function installUnit({ platform, home = tempDir("pi-unit-home-"), deployDir, setup, which = "worker" }) {
	const rel =
		platform === "darwin"
			? join("Library", "LaunchAgents", `com.pi-dispatch.${which}.plist`)
			: join(".config", "systemd", "user", `pi-dispatch-${which}.service`);
	const path = join(home, rel);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, platform === "darwin" ? darwinUnit(deployDir, setup) : linuxUnit(deployDir, setup));
	return { home, path };
}

const seamEnv = (extra = {}) => ({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", GITHUB_AUTH_SOURCE: "pat", ...extra });
const seamDeps = (out, extra = {}) => ({
	out,
	cwd: tmpdir(),
	home: tempDir("pi-empty-home-"),
	platform: "linux",
	spawn: fakeSpawn(green),
	probeValkey: async () => true,
	nodeVersion: "22.19.0",
	...extra,
});
const rx = (p) => p.replace(/[.\\/]/g, "\\$&");

test("doctor: with no unit and no PI_ENV_SETUP, the seam adds not one line", async () => {
	const { out, text } = capture();
	const code = await runDoctor(seamEnv(), seamDeps(out));
	assert.equal(code, 0);
	assert.doesNotMatch(text(), /env-setup/, "a deployment that does not use the seam gets byte-identical output");
});

test("doctor: a systemd unit for THIS deployment names its env-setup script, and doctor says which unit", async () => {
	const setup = setupScript();
	const deployDir = tempDir("pi-deploy-");
	const { home, path } = installUnit({ platform: "linux", deployDir, setup });
	const { out, text } = capture();
	const code = await runDoctor(seamEnv(), seamDeps(out, { cwd: deployDir, home, platform: "linux" }));
	assert.equal(code, 0);
	assert.match(text(), new RegExp(`✓ env-setup script present \\(${rx(setup)}, named by ${rx(path)}\\)`));
	assert.doesNotMatch(text(), new RegExp(SETUP_BODY.trim()), "the path is named; the contents are never read");
});

test("doctor: a launchd plist carries the same seam, read out of its EnvironmentVariables dict", async () => {
	const setup = setupScript();
	const deployDir = tempDir("pi-deploy-");
	const { home, path } = installUnit({ platform: "darwin", deployDir, setup });
	const { out, text } = capture();
	const code = await runDoctor(seamEnv(), seamDeps(out, { cwd: deployDir, home, platform: "darwin" }));
	assert.equal(code, 0);
	assert.match(text(), new RegExp(`✓ env-setup script present \\(${rx(setup)}, named by ${rx(path)}\\)`));
});

test("doctor: on win32 the seam comes back from `nssm get`, NULs and all", async () => {
	const setup = setupScript();
	// nssm writes wide characters on some builds; readUnitSeam strips them rather than pretending the
	// output is always UTF-8. A CRLF rides along too, because it always does.
	const utf16ish = [..."PI_ENV_SETUP=" + setup + "\r\nOTHER=1"].map((c) => c + "\0").join("");
	const calls = [];
	const { out, text } = capture();
	const code = await runDoctor(
		seamEnv(),
		seamDeps(out, {
			platform: "win32",
			// BOTH services answer with the same script, which is the ordinary Windows deployment: one
			// setup file serving both daemons. The dedupe is what keeps that one set of lines.
			spawn: fakeSpawn({ ...green, "nssm get": { code: 0, output: utf16ish } }, calls),
		}),
	);
	assert.equal(code, 0);
	assert.match(text(), new RegExp(`✓ env-setup script present \\(${rx(setup)}, named by pi-dispatch-worker's AppEnvironmentExtra\\)`));
	assert.deepEqual(
		calls.filter((c) => c.cmd === "nssm").map((c) => c.args),
		[
			["get", "pi-dispatch-worker", "AppEnvironmentExtra"],
			["get", "pi-dispatch-receiver", "AppEnvironmentExtra"],
		],
		"both daemons are asked, and nothing else is",
	);
	assert.equal(text().match(/env-setup script present/g).length, 1, "one script serving both daemons is one finding");
	assert.doesNotMatch(text(), /group\/world-writable/, "win32 stat modes are synthetic -- the mode findings cannot exist there");
});

test("doctor: a unit belonging to ANOTHER deployment on this host is not doctor's business", async () => {
	const setup = setupScript();
	const { home } = installUnit({ platform: "linux", deployDir: "/srv/some-other-deployment", setup });
	const { out, text } = capture();
	const code = await runDoctor(seamEnv(), seamDeps(out, { cwd: tempDir("pi-deploy-"), home }));
	assert.equal(code, 0);
	assert.doesNotMatch(text(), /env-setup/, "a host running two deployments must not hear about the neighbour's unit forever");
});

test("doctor: with no unit, PI_ENV_SETUP in doctor's own environment answers -- and the line says so", async () => {
	const setup = setupScript();
	const { out, text } = capture();
	const code = await runDoctor(seamEnv({ PI_ENV_SETUP: setup }), seamDeps(out));
	assert.equal(code, 0);
	assert.match(text(), new RegExp(`✓ env-setup script present \\(${rx(setup)}, named by PI_ENV_SETUP in this environment\\)`));
});

test("doctor: the unit outranks PI_ENV_SETUP -- the file that boots is the answer", async () => {
	const fromUnit = setupScript({ name: "unit-setup.sh" });
	const fromEnv = setupScript({ name: "env-setup.sh" });
	const deployDir = tempDir("pi-deploy-");
	const { home } = installUnit({ platform: "linux", deployDir, setup: fromUnit });
	const { out, text } = capture();
	await runDoctor(seamEnv({ PI_ENV_SETUP: fromEnv }), seamDeps(out, { cwd: deployDir, home }));
	assert.match(text(), new RegExp(rx(fromUnit)));
	assert.doesNotMatch(text(), new RegExp(rx(fromEnv)), "the environment is only consulted when no unit named one");
});

test("doctor: worker and receiver naming the same script produce one set of lines, not two", async () => {
	const setup = setupScript();
	const deployDir = tempDir("pi-deploy-");
	// The receiver unit is written FIRST, so "the worker names it" below is about the scan order and
	// not about which file happened to land first.
	const { path: receiver } = installUnit({ platform: "linux", deployDir, setup, which: "receiver" });
	const { home } = installUnit({ platform: "linux", home: dirname(dirname(dirname(dirname(receiver)))), deployDir, setup });
	const { out, text } = capture();
	await runDoctor(seamEnv(), seamDeps(out, { cwd: deployDir, home }));
	assert.equal(text().match(/env-setup script present/g).length, 1, "the finding is about the script, so it is deduped by path");
	assert.match(text(), /named by .*pi-dispatch-worker\.service/, "the first unit to name it is the one reported, and the worker is scanned first");
	assert.doesNotMatch(text(), new RegExp(rx(receiver)), "the second unit naming the same script adds nothing");
});

test("doctor: a unit naming a script that is gone warns, names it, and still exits 0", async () => {
	const setup = setupScript();
	rmSync(dirname(setup), { recursive: true, force: true });
	const deployDir = tempDir("pi-deploy-");
	const { home, path } = installUnit({ platform: "linux", deployDir, setup });
	const { out, text } = capture();
	const code = await runDoctor(seamEnv(), seamDeps(out, { cwd: deployDir, home }));
	assert.equal(code, 0, "a broken boot path is a warning: `pi-dispatch worker` by hand still runs, and `up` inherits this code");
	assert.match(text(), new RegExp(`⚠ the env-setup script at ${rx(setup)} does not exist \\(named by ${rx(path)}\\)`));
	assert.match(text(), /restart loop/, "the fix says what actually happens at the next boot");
	assert.doesNotMatch(text(), /is group\/world-writable/, "nothing to stat once it is gone -- the missing line stands alone");
});

test("doctor: a group- or world-writable env-setup script warns -- it is EXECUTED, so writability is the risk", async () => {
	for (const mode of [0o775, 0o757]) {
		const setup = setupScript({ mode });
		const deployDir = tempDir("pi-deploy-");
		const { home } = installUnit({ platform: "linux", deployDir, setup });
		const { out, text } = capture();
		const code = await runDoctor(seamEnv(), seamDeps(out, { cwd: deployDir, home }));
		assert.equal(code, 0);
		assert.match(text(), new RegExp(`⚠ the env-setup script at ${rx(setup)} is group/world-writable`));
		assert.match(text(), new RegExp(`chmod go-w ${rx(setup)}`));
		assert.match(text(), /owns the worker/, "the fix says what the escalation actually buys");
	}
});

test("doctor: a world-READABLE script is fine -- it holds no secret, only the commands that fetch them", async () => {
	const setup = setupScript({ mode: 0o644 });
	const deployDir = tempDir("pi-deploy-");
	const { home } = installUnit({ platform: "linux", deployDir, setup });
	const { out, text } = capture();
	await runDoctor(seamEnv(), seamDeps(out, { cwd: deployDir, home }));
	assert.doesNotMatch(text(), /is group\/world-writable/, "0o022 and not the App key's 0o077: this file is sourced, not secret");
});

test("doctor: a world-writable directory warns, and a STICKY one does not", async () => {
	for (const [dirMode, expected] of [
		[0o777, true],
		[0o1777, false],
	]) {
		const setup = setupScript({ dirMode });
		const deployDir = tempDir("pi-deploy-");
		const { home } = installUnit({ platform: "linux", deployDir, setup });
		const { out, text } = capture();
		const code = await runDoctor(seamEnv(), seamDeps(out, { cwd: deployDir, home }));
		assert.equal(code, 0);
		const line = new RegExp(`⚠ the directory holding the env-setup script \\(${rx(dirname(setup))}\\) is group/world-writable`);
		if (expected) assert.match(text(), line);
		else assert.doesNotMatch(text(), line, "sticky: a non-owner cannot replace someone else's file there, so the claim would be false");
	}
});

test("doctor: an env-setup script in a work tree that does not ignore it warns, with the path and no contents", async () => {
	const setup = setupScript();
	const deployDir = tempDir("pi-deploy-");
	const { home } = installUnit({ platform: "linux", deployDir, setup });
	const calls = [];
	const { out, text } = capture();
	const code = await runDoctor(seamEnv(), seamDeps(out, { cwd: deployDir, home, spawn: fakeSpawn({ ...green, "git ": 1 }, calls) }));
	assert.equal(code, 0);
	assert.match(text(), new RegExp(`⚠ the env-setup script at ${rx(setup)} is inside a git work tree that does not ignore it`));
	assert.match(text(), /commands that FETCH them/, "the fix says why a file with no secret in it still matters");
	assert.doesNotMatch(text(), new RegExp(SETUP_BODY.trim()));
	const git = calls.find((c) => c.cmd === "git");
	assert.equal(git.args.at(-1), setup, "the question is about the script itself");
	assert.equal(git.args.at(-4), dirname(setup), "asked from the script's own directory, not doctor's cwd");
});

test("doctor: an ignored script, a non-repo, and a git that will not launch are all silent about the seam", async () => {
	for (const [name, outcome] of [
		["ignored (exit 0)", 0],
		["not a work tree (exit 128)", 128],
		["git missing", "enoent"],
	]) {
		const setup = setupScript();
		const deployDir = tempDir("pi-deploy-");
		const { home } = installUnit({ platform: "linux", deployDir, setup });
		const { out, text } = capture();
		const code = await runDoctor(seamEnv(), seamDeps(out, { cwd: deployDir, home, spawn: fakeSpawn({ ...green, "git ": outcome }) }));
		assert.equal(code, 0);
		assert.doesNotMatch(text(), /does not ignore it/, `${name}: only a definite "not ignored" may warn`);
	}
});

test("doctor: a unit rendered WITHOUT the flag reads as no seam, and an unparseable one does not guess", async () => {
	const deployDir = tempDir("pi-deploy-");
	const { home, path } = installUnit({ platform: "linux", deployDir, setup: null });
	const { out, text } = capture();
	await runDoctor(seamEnv(), seamDeps(out, { cwd: deployDir, home }));
	assert.doesNotMatch(text(), /env-setup/, "every unit that predates issue #209 lands here");
	writeFileSync(path, "[Service]\nWorkingDirectory=" + deployDir + "\nExecStart=/usr/bin/env something-hand-written\n");
	const second = capture();
	await runDoctor(seamEnv(), seamDeps(second.out, { cwd: deployDir, home }));
	assert.doesNotMatch(second.text(), /env-setup/, "a hand-rewritten ExecStart reads as no seam rather than as a guess");
});

// -- replica runs (REQ-REPLICA-RUNS): the multiplier is worth stating, not worth failing on ------------

/** A triggers file with one github label trigger, optionally carrying `run.replicas`. */
function replicaTriggersFile(replicas) {
	const path = join(tempDir("pi-triggers-rep-"), "triggers.json");
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

// -- run.command triggers (issue #189): one advisory line, and no flow-tier probe ---------------------

/** A triggers file with one cron command trigger, through the SHARED parseTriggers -- a stub the parser
 *  rejects would be swallowed by readTriggerFacts' never-throw guard and silently count 0, making the
 *  advisory assertion below pass for the wrong reason (the catch-zeroes-counts trap named at triggersFile). */
function commandTriggersFile() {
	const path = join(tempDir("pi-triggers-cmd-"), "triggers.json");
	writeFileSync(path, JSON.stringify({ triggers: [{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/repo", command: "wf run" } }] }));
	return path;
}

test("doctor: a command trigger prints ONE advisory line, and the flow-tier block prints nothing for it", async () => {
	const { out, text } = capture();
	const code = await runDoctor(imgEnv({ PI_TRIGGERS_FILE: commandTriggersFile() }), imgDeps(out, green));
	assert.equal(code, 0, "advisory only -- a command is not host-verifiable, so nothing may fail on it");
	assert.match(text(), /✓ 1 command trigger\(s\): a command is only verifiable in-container -- the runner refuses an unregistered one pre-spend \(command-unregistered\)/);
	// A command trigger carries no run.flow, so the flow-resolution probes must drop it naturally rather
	// than warn about a "flow" that was never named.
	assert.doesNotMatch(text(), /Trigger flow/, "the flow-tier block prints NO line for a command trigger");
});

test("doctor: a deployment with no command triggers prints no command line at all", async () => {
	const { out, text } = capture();
	await runDoctor(imgEnv({ PI_TRIGGERS_FILE: triggersFile() }), imgDeps(out, green));
	assert.doesNotMatch(text(), /command trigger/, "a deployment that does not use the feature is not told about it");
});

// -- the scaffolded pause-windows file the worker never reads (issue #99, REQ-SCOPED-PAUSE-WINDOWS) ----

/**
 * A deployment folder exactly as `pi-dispatch init` leaves it: both operator-authored config files
 * scaffolded, and neither env var set. Real files with doctor's default `fileExists`, so the check is
 * exercised against the filesystem it will actually read. Contents are irrelevant -- doctor never parses
 * either file, and must not start.
 */
function scaffoldedCwd() {
	const dir = tempDir("pi-scaffold-");
	writeFileSync(join(dir, "pause-windows.json"), "[]\n");
	writeFileSync(join(dir, "subscriptions.json"), JSON.stringify({ version: 1, subscriptions: [] }));
	return dir;
}
const scaffoldDeps = (out, cwd) => ({ out, cwd, spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0" });

test("doctor: a scaffolded pause-windows.json with PI_PAUSE_WINDOWS_FILE unset warns, names the var, and never fails", async () => {
	// The one failure mode where the UI asserts the opposite of the truth: the panel defaults to this same
	// file, writes the window, and says it is live -- while the worker, having no cwd default, loaded none.
	const cwd = scaffoldedCwd();
	const { out, text } = capture();
	const code = await runDoctor(imgEnv(), scaffoldDeps(out, cwd));
	assert.ok(text().includes(`⚠ ${join(cwd, "pause-windows.json")} exists but PI_PAUSE_WINDOWS_FILE is unset`), "the warn names the file it found");
	assert.ok(text().includes(`set PI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json")}`), "the fix names the variable AND the absolute path");
	assert.match(text(), /reports each window it writes as applied live/, "the consequence is stated, not just the mismatch");
	assert.equal(code, 0, "warn, never fail -- a deployment can legitimately be mid-setup");
	// The finding this check is deliberately NOT generalised to: subscriptions.json is scaffolded the same
	// way and its env var is unset here too, but the admin extension is its only reader and defaults to this
	// same path, so nothing is trapped and doctor says nothing.
	assert.doesNotMatch(text(), /PI_SUBSCRIPTIONS_FILE|subscriptions\.json/, "no warn where there is no second reader to disagree");
});

test("doctor: with PI_PAUSE_WINDOWS_FILE set, the scaffolded file is not mentioned at all", async () => {
	const cwd = scaffoldedCwd();
	const { out, text } = capture();
	await runDoctor(imgEnv({ PI_PAUSE_WINDOWS_FILE: join(cwd, "pause-windows.json") }), scaffoldDeps(out, cwd));
	assert.doesNotMatch(text(), /PI_PAUSE_WINDOWS_FILE/, "a wired deployment gets no line -- the worker and the panel agree");
});

test("doctor: a .env that NAMES the key softens the warning instead of crying wolf (#357)", async () => {
	// `pi-dispatch up` writes these keys into `<cwd>/.env`, which configures the SERVICE through
	// EnvironmentFile= and the wrappers and configures nothing about the shell doctor runs in. Unqualified,
	// the warning would fire on every correctly converged deployment, and this module's own rule is that a
	// check nobody can silence must never cry wolf.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), `PI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json")}   # written by up\n`);
	const { out, text } = capture();
	await runDoctor(imgEnv(), scaffoldDeps(out, cwd));
	assert.ok(text().includes(`PI_PAUSE_WINDOWS_FILE is set in ${join(cwd, ".env")} (${join(cwd, "pause-windows.json")}) but not in this shell`), "it says which process would honour the file, and quotes the VALUE");
	assert.doesNotMatch(text(), /written by up/, "the inline comment .env.example documents each key with is not part of the value");
	assert.doesNotMatch(text(), /scoped pauses are OFF/, "and drops the claim that the feature is off, because for the service it is not");
	assert.match(text(), /set -a; \. \.\/\.env; set \+a/, "the fix is how to look with the service's own environment");
	// Still a warning rather than a pass: in THIS shell the feature really is unconfigured, and a softened
	// line that pretended otherwise would be the same lie in the other direction.
	assert.match(text(), /⚠ PI_PAUSE_WINDOWS_FILE is set in/);
});

test("doctor: a file carrying BOTH forms names both, and which start wins (#365)", async () => {
	// The gap the three-state reading left: a key with a bare line AND an `export` one is not export-only,
	// so the label said nothing about it -- while the two readings disagree about the VALUE, which means the
	// two deployment shapes load different files. `EnvironmentFile=` takes the bare line (systemd does not
	// strip the prefix, measured on 257.13) and `set -a; . ./.env` in the wrappers takes the LAST
	// assignment. Doctor reported the bare value and called it the service's, which is right for systemd
	// and wrong for launchd and nssm.
	const cwd = scaffoldedCwd();
	const bare = join(cwd, "pause-windows.json");
	writeFileSync(join(cwd, ".env"), `PI_PAUSE_WINDOWS_FILE=${bare}\nexport PI_PAUSE_WINDOWS_FILE=/wrapper-wins.json\n`);
	const { out, text } = capture();
	await runDoctor(imgEnv(), scaffoldDeps(out, cwd));
	assert.match(text(), /and again as `export PI_PAUSE_WINDOWS_FILE=\/wrapper-wins\.json`/, "the second assignment is named");
	assert.match(text(), /Those two disagree, and which one is in force depends on how the worker starts/);
	assert.match(text(), /systemd's EnvironmentFile= reads BARE lines only, so it takes .*pause-windows\.json; deploy\/worker-env-wrapper\.sh SOURCES the file and takes the LAST assignment, so it takes \/wrapper-wins\.json/);
	// THREE loaders, not two, and the third was named wrongly. `worker-env-wrapper.cmd` splits on the first
	// `=` with `for /f ... delims==`, so an `export K=v` line sets a variable literally called `export K`:
	// nssm reads the BARE line, like systemd, and the export value can never be in force there. The first
	// version of this text said the nssm wrapper sources the file and takes the last assignment, which is
	// what the POSIX wrapper does and what `requirements.md` warns this loader must never be assumed to do.
	assert.match(text(), /deploy\/worker-env-wrapper\.cmd splits on the first `=` and would set a variable literally named `export PI_PAUSE_WINDOWS_FILE`, so the bare line is what it reads/);
	assert.doesNotMatch(text(), /and the nssm wrapper source the file/, "the cmd loader neither sources nor takes the last assignment");
	assert.doesNotMatch(text(), /which a wrapper script reads and systemd's EnvironmentFile= does not/, "not the export-ONLY line: there is a bare assignment here");
});

test("doctor: a BLANK line in the .env is the same refused boot as a blank shell value (#365)", async () => {
	// The shell-only test missed this entirely: `readEnvKeys` deletes a key whose value is empty, so `inFile`
	// was falsy and doctor fell through to "is unset -- the worker ignores it" for a file that makes the
	// worker refuse to start. Measured in sh, bash and zsh: `set -a; . ./.env` on `KEY=` SETS and EXPORTS
	// `KEY=""`, and `deploy/worker-env-wrapper.sh` does exactly that, so the worker gets the empty string.
	for (const [key, scaff, word] of [
		["PI_PAUSE_WINDOWS_FILE", "pause-windows", "pause-windows"],
		["PI_SCOPED_LIMITS_FILE", "scoped-limits", "scoped-limits"],
	]) {
		for (const blankLine of [`${key}=`, `${key}=""`, `${key}=   `, `export ${key}=`]) {
			const cwd = scaffoldedCwd();
			writeFileSync(join(cwd, `${scaff}.json`), scaff === "scoped-limits" ? "{}\n" : "[]\n");
			writeFileSync(join(cwd, ".env"), `${blankLine}\n`);
			const { out, text } = capture();
			await runDoctor(imgEnv(), scaffoldDeps(out, cwd));
			assert.match(text(), new RegExp(`${key} is set to an EMPTY value in this shell, which is not the same as unset: the worker keeps it, tries to load a ${word} file at that empty path, and REFUSES TO START`), `${key} ${JSON.stringify(blankLine)}`);
			assert.doesNotMatch(text(), new RegExp(`${key} is unset -- the worker ignores it`), `${key} ${JSON.stringify(blankLine)}`);
		}
	}
});

test("doctor: an `export` line that CLEARS the key is the same disagreement, and was silent (#365)", async () => {
	// The sharpest shape and the one the first version of this signal could not see. `readEnvKeys` deletes a
	// key whose last assignment is empty, so the second reading had no entry and the `key in withExport`
	// guard blocked it -- while the readings disagree exactly as much as when the values differ: systemd
	// loads the file and every wrapper deployment reads it unset, which is the feature silently off on half
	// the deployment shapes. Measured in sh, bash and zsh: `set -a; . ./.env` leaves the key set to empty.
	for (const cleared of ["", '""', "   "]) {
		const cwd = scaffoldedCwd();
		const bare = join(cwd, "pause-windows.json");
		writeFileSync(join(cwd, ".env"), `PI_PAUSE_WINDOWS_FILE=${bare}\nexport PI_PAUSE_WINDOWS_FILE=${cleared}\n`);
		const { out, text } = capture();
		await runDoctor(imgEnv(), scaffoldDeps(out, cwd));
		assert.match(text(), /and CLEARED again by a later `export PI_PAUSE_WINDOWS_FILE=`/, JSON.stringify(cleared));
		assert.match(text(), /Those two disagree, and which one is in force depends on how the worker starts/, JSON.stringify(cleared));
		// NOT "takes nothing": measured in sh, bash and zsh, `set -a; . ./.env` on an empty assignment SETS
		// and EXPORTS `KEY=""`. The worker keeps it and refuses to boot, which is the opposite of a feature
		// left off, and was the last surviving copy of the claim this round has been correcting.
		assert.match(text(), /so it takes an EMPTY value, which the worker keeps and REFUSES TO BOOT on/, JSON.stringify(cleared));
		assert.doesNotMatch(text(), /takes nothing, leaving the feature off/, "the false half is gone");
		assert.doesNotMatch(text(), /nothing to fix if the worker runs as a service/, "the old fix asserted the false half out loud");
	}
});

test("doctor: the SCOPED_LIMITS twin of the both-forms signal says the same thing (#365)", async () => {
	// The two consumers of this signal are written out separately, so the second was entirely unpinned:
	// deleting its `alsoExported` and deleting its label suffix were both green on the full suite. A pane
	// pinned in one of two copies is the shape this round has now had to fix three times.
	const cwd = scaffoldedCwd();
	const bare = join(cwd, "scoped-limits.json");
	// `scaffoldedCwd` writes only the pause-windows file, and this warning fires only when its OWN scaffold
	// exists -- which is why the twin was reachable by nothing.
	writeFileSync(bare, "{}\n");
	writeFileSync(join(cwd, ".env"), `PI_SCOPED_LIMITS_FILE=${bare}\nexport PI_SCOPED_LIMITS_FILE=/wrapper-wins.json\n`);
	const { out, text } = capture();
	await runDoctor(imgEnv(), scaffoldDeps(out, cwd));
	assert.match(text(), /and again as `export PI_SCOPED_LIMITS_FILE=\/wrapper-wins\.json`/);
	assert.match(text(), /Those two disagree, and which one is in force depends on how the worker starts/);
	assert.match(text(), /would set a variable literally named `export PI_SCOPED_LIMITS_FILE`/);
});

test("doctor: two assignments that AGREE are not a finding (#365)", async () => {
	// Tidiness is not a fact about the deployment, and a warning about it would be the crying wolf this file
	// refuses elsewhere. Both consumers read the same path, so there is nothing an operator has to decide.
	const cwd = scaffoldedCwd();
	const same = join(cwd, "pause-windows.json");
	writeFileSync(join(cwd, ".env"), `PI_PAUSE_WINDOWS_FILE=${same}\nexport PI_PAUSE_WINDOWS_FILE=${same}\n`);
	const { out, text } = capture();
	await runDoctor(imgEnv(), scaffoldDeps(out, cwd));
	assert.doesNotMatch(text(), /and again as `export/, "agreeing duplicates say nothing");
	assert.doesNotMatch(text(), /Those two disagree/);
});

test("doctor: an `export`ed key is neither set nor unset, and says which reader honours it (#357)", async () => {
	// Measured on systemd 257.13: `EnvironmentFile=` parses bare `VAR=VALUE` and does not strip an
	// `export ` prefix, while `deploy/worker-env-wrapper.sh` sources the file and does. So the same line is
	// live on launchd and nssm and inert under systemd, and `up` -- which must never clobber it -- reports
	// that key as already set. Without this third sentence, doctor tells the operator, three lines later in
	// the same `up` output, to write a line that is already there.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), `export PI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json")}\n`);
	const { out, text } = capture();
	await runDoctor(imgEnv(), scaffoldDeps(out, cwd));
	assert.match(text(), /as `export PI_PAUSE_WINDOWS_FILE=.*`, which a wrapper script reads and systemd's EnvironmentFile= does not/);
	assert.doesNotMatch(text(), /is unset -- the worker ignores it/, "not the unset warning: the line is there and one of the two readers honours it");
	assert.doesNotMatch(text(), /but not in this shell/, "and not the set one either, because systemd would read nothing");
	assert.match(text(), /drop the `export ` prefix if this deployment runs under systemd/);
});

test("doctor: a .env that does NOT name the key gets the full warning, unchanged (#357)", async () => {
	// The narrowing has to run both ways, or the read becomes "a .env exists, so stop warning", which is
	// exactly the wrong lesson and would silence the deployment this check was written for.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "WEBHOOK_SECRET=abc\n# PI_PAUSE_WINDOWS_FILE=   # still commented out\n");
	const { out, text } = capture();
	await runDoctor(imgEnv(), scaffoldDeps(out, cwd));
	assert.ok(text().includes(`⚠ ${join(cwd, "pause-windows.json")} exists but PI_PAUSE_WINDOWS_FILE is unset`), "a commented line is not a value");
	assert.match(text(), /scoped pauses are OFF/);
});

test("doctor: the .env read is narrowed to the two keys these checks name, and never configures (#357)", async () => {
	// The new precedent, pinned as a boundary rather than described in a comment. `service.test.mjs` pins
	// that a PI_ENV_SETUP line in ./.env is deliberately NOT honoured, and that has to stay true: this read
	// decides what doctor SAYS about two named keys, and nothing else in the file may reach anything.
	const cwd = scaffoldedCwd();
	const asked = [];
	writeFileSync(join(cwd, ".env"), ["PI_PAUSE_WINDOWS_FILE=/from/env-file/windows.json", "PI_SCOPED_LIMITS_FILE=/from/env-file/limits.json", "PI_JOB_IMAGE=never-read:from-env-file", "PI_PROVIDER=openai", "PI_ENV_SETUP=/tmp/evil.sh", "VALKEY_URL=redis://from-env-file:6379"].join("\n"));
	const { out, text } = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), readEnvFile: (path) => (asked.push(path), readFileSync(path, "utf8")) });
	assert.deepEqual(asked, [join(cwd, ".env")], "one file, read once");
	for (const leaked of ["never-read:from-env-file", "openai", "/tmp/evil.sh", "redis://from-env-file:6379"]) {
		assert.ok(!text().includes(leaked), `${leaked} came out of .env and must reach nothing`);
	}
	assert.match(text(), /PI_PAUSE_WINDOWS_FILE is set in/, "only the two keys the checks name are read back");
});

test("doctor: a .env that is a FIFO does not hang the command, through the DEFAULT seam (#357)", async () => {
	// The guard that matters is the one `collectChecks` actually gets: every other assertion here injects
	// its own `statFile`, so the production default was unpinned and a named pipe would have hung
	// `pi-dispatch doctor` forever, with no output and no check to point at.
	const cwd = tempDir("pi-fifo-");
	const fifo = join(cwd, ".env");
	execFileSync("mkfifo", [fifo]);
	assert.deepEqual(envFileKeys(fifo, ["PI_PAUSE_WINDOWS_FILE"], { fileExists: existsSync, readEnvFile: (p) => readFileSync(p, "utf8") }), {}, "not a regular file, so not read at all");
	// A directory is the other shape, and it throws rather than blocking; both must be silent.
	assert.deepEqual(envFileKeys(cwd, ["PI_PAUSE_WINDOWS_FILE"], { fileExists: existsSync, readEnvFile: (p) => readFileSync(p, "utf8") }), {});
});

test("doctor: the .env reader hands back only the keys it was asked for (#357)", async () => {
	// The boundary itself, pinned directly. Widening the doctor call's key LIST alone is an equivalent
	// mutant today, because nothing consumes a key these two checks do not name, and that is the safety
	// property rather than an accident: the read is a message decision. What must never drift is the
	// helper's contract, so it is asserted here rather than inferred from the absence of output.
	const text = ["PI_PAUSE_WINDOWS_FILE=/w.json", "PI_JOB_IMAGE=never:read", "PI_ENV_SETUP=/tmp/evil.sh", "export PI_SCOPED_LIMITS_FILE=/l.json", "# PI_SCOPED_LIMITS_FILE=/commented.json", "PI_PAUSE_WINDOWS_FILE=/a-later-duplicate.json"].join("\n");
	const seams = (readEnvFile) => ({ fileExists: () => true, readEnvFile, statFile: () => ({ isFile: () => true }) });
	// The later duplicate wins, because the shell and `EnvironmentFile=` both take the last assignment and
	// this has to report what the SERVICE sees.
	assert.deepEqual(envFileKeys("/d/.env", ["PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE"], seams(() => text)), { PI_PAUSE_WINDOWS_FILE: "/a-later-duplicate.json", exported: { PI_SCOPED_LIMITS_FILE: "/l.json" }, alsoExported: {}, blankInFile: {} });
	// THREE states, not two. A key assigned only with an `export ` prefix is read by the wrapper scripts
	// and not by systemd's `EnvironmentFile=` (measured on systemd 257.13), so it is neither "set" nor
	// "unset" and gets a sentence of its own. Collapsing it either way makes doctor wrong: called set, it
	// claims the service reads what systemd does not; called unset, it tells the operator to write a line
	// that is already there, moments after `up` reported that key as already set.
	assert.deepEqual(envFileKeys("/d/.env", ["PI_PAUSE_WINDOWS_FILE"], seams(() => "export PI_PAUSE_WINDOWS_FILE=/w.json")), { exported: { PI_PAUSE_WINDOWS_FILE: "/w.json" }, alsoExported: {}, blankInFile: {} });
	// A bare assignment ANYWHERE means the key is not export-only, however many export lines follow it.
	// systemd's `EnvironmentFile=` reads `/plain.json` and nothing else, so calling this export-only would
	// print a value systemd never sees and advise dropping a prefix, which would change which file the
	// worker loads on a wrapper deployment.
	assert.deepEqual(envFileKeys("/d/.env", ["PI_PAUSE_WINDOWS_FILE"], seams(() => "PI_PAUSE_WINDOWS_FILE=/plain.json\nexport PI_PAUSE_WINDOWS_FILE=/later.json")), { PI_PAUSE_WINDOWS_FILE: "/plain.json", exported: {}, alsoExported: { PI_PAUSE_WINDOWS_FILE: "/later.json" }, blankInFile: {} });
	// A THIRD SIGNAL for that same file (issue #365, item 2). It is not export-only and never was, so the
	// label said nothing about it -- while the two readings DISAGREE about the value, which means the two
	// deployment shapes disagree about which file the worker loads. Only when they differ: both forms
	// carrying the same value is tidiness, not a fact about the deployment, and warning on it would be the
	// crying wolf this file refuses elsewhere.
	assert.deepEqual(envFileKeys("/d/.env", ["PI_PAUSE_WINDOWS_FILE"], seams(() => "PI_PAUSE_WINDOWS_FILE=/same.json\nexport PI_PAUSE_WINDOWS_FILE=/same.json")), { PI_PAUSE_WINDOWS_FILE: "/same.json", exported: {}, alsoExported: {}, blankInFile: {} }, "agreeing duplicates are not a finding");
	// ORDER MATTERS, and the first version of this assertion got it backwards. With the export line FIRST
	// and the bare one last, the wrappers take the last assignment and so read `/plain.json` too, which is
	// what `EnvironmentFile=` reads: the two agree, so there is nothing to report. The signal is about the
	// readings DISAGREEING, not about both forms being present.
	assert.deepEqual(envFileKeys("/d/.env", ["PI_PAUSE_WINDOWS_FILE"], seams(() => "export PI_PAUSE_WINDOWS_FILE=/later.json\nPI_PAUSE_WINDOWS_FILE=/plain.json")), { PI_PAUSE_WINDOWS_FILE: "/plain.json", exported: {}, alsoExported: {}, blankInFile: {} }, "an export line BEFORE the bare one is overridden for both consumers");
	// And a caller's list can only NARROW: the allowlist is the module's, frozen, so a future check that
	// wants the same softening cannot reach a secret by adding a key to its own array. That is the whole
	// licence for reading a `.env`, and a convention would not have held it.
	assert.deepEqual(envFileKeys("/d/.env", ["PI_JOB_IMAGE", "WEBHOOK_SECRET", "PI_ENV_SETUP"], seams(() => text)), {}, "a key outside the frozen set is not readable, however it is asked for");
	assert.deepEqual([...ENV_FILE_READABLE_KEYS], ["PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE"], "adding to this list IS the review");
	// `export KEY=` is a shell-ism a loader would honour and this deliberately does not, which is the line
	// between reading a file and loading one.
	assert.deepEqual(envFileKeys("/d/.env", ["PI_JOB_IMAGE"], seams(() => "export PI_JOB_IMAGE=shell-ism")), {}, "and a key outside the frozen set is not reported as exported either");
	assert.deepEqual(envFileKeys("/d/.env", ["PI_PAUSE_WINDOWS_FILE"], { fileExists: () => false, readEnvFile: () => text }), {}, "no file, no evidence");
	// A named pipe is the one shape that would not fail: a synchronous read of it never returns, and doctor
	// would hang with no output and no check to point at. A directory throws and lands in the catch below.
	assert.deepEqual(envFileKeys("/d/.env", ["PI_PAUSE_WINDOWS_FILE"], { fileExists: () => true, readEnvFile: () => text, statFile: () => ({ isFile: () => false }) }), {}, "a .env that is not a regular file is not read at all");
	assert.deepEqual(envFileKeys("/d/.env", ["PI_PAUSE_WINDOWS_FILE"], { fileExists: () => true, readEnvFile: () => text, statFile: null }), {}, "and a seam that cannot answer is not evidence either");
	assert.deepEqual(envFileKeys("/d/.env", ["PI_PAUSE_WINDOWS_FILE"], { fileExists: () => true, readEnvFile: null }), {}, "no seam, no evidence");
});

test("doctor: nothing but the two named keys is ever read out of .env, secrets least of all (#357)", async () => {
	// The narrowing the whole precedent rests on, and until this test it was a sentence in a docblock:
	// widening the key list at the call site changed no output, so nothing would have noticed. The bytes
	// asserted here are the point -- a `.env` holds WEBHOOK_SECRET and provider keys, and `up.mjs`'s own
	// rule is that a webhook secret in a scrollback is a webhook secret in a pastebin.
	const cwd = scaffoldedCwd();
	const secret = "cafef00d".repeat(8);
	writeFileSync(join(cwd, ".env"), [`WEBHOOK_SECRET=${secret}`, "ANTHROPIC_API_KEY=sk-ant-not-a-real-key", "PI_ENV_SETUP=/tmp/evil.sh", `PI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json")}`].join("\n"));
	const { out, text } = capture();
	const checks = await collectChecks(imgEnv(), { out, cwd, spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0", fileExists: existsSync, readEnvFile: (p) => readFileSync(p, "utf8") });
	const rendered = JSON.stringify(checks) + text();
	for (const leaked of [secret, "sk-ant-not-a-real-key", "/tmp/evil.sh"]) {
		assert.ok(!rendered.includes(leaked), `${leaked.slice(0, 12)}... must never leave .env`);
	}
	assert.ok(
		checks.some((c) => /PI_PAUSE_WINDOWS_FILE is set in/.test(c.label)),
		"while the key the message names is read back",
	);
});

test("doctor: an unreadable .env restores the full warning rather than softening on no evidence (#357)", async () => {
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "PI_PAUSE_WINDOWS_FILE=/whatever\n");
	const { out, text } = capture();
	await runDoctor(imgEnv(), {
		...scaffoldDeps(out, cwd),
		readEnvFile: () => {
			throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		},
	});
	assert.ok(text().includes(`⚠ ${join(cwd, "pause-windows.json")} exists but PI_PAUSE_WINDOWS_FILE is unset`), "told-it-is-fine when nobody could check is the worse failure");
});

test("doctor: no scaffolded file, no line -- the feature-off deployment is not told about a file it has not got", async () => {
	const { out, text } = capture();
	await runDoctor(imgEnv(), scaffoldDeps(out, tempDir("pi-bare-")));
	assert.doesNotMatch(text(), /pause-windows/, "nothing exists to be ignored");
});

test("doctor: an EMPTY PI_PAUSE_WINDOWS_FILE is a REFUSED BOOT, not an unset one (#365)", async () => {
	// THE CITATION THIS TEST WAS BUILT ON WAS WRONG, and the claim with it. It said start.mjs "gates on
	// `if (config.pauseWindowsFile)`, so an empty value leaves the feature off exactly as an absent one
	// does" -- but that gate is the LIVE-RELOAD WATCHER at start.mjs:1436, and it is unreachable here,
	// because `loadPauseWindows(config)` at start.mjs:371 runs unconditionally first and THROWS. Measured:
	// `config.mjs` reads this key with `??`, so `""` and `"   "` survive into the config, and the loader
	// answers `pause-windows file does not exist: `. So the worker does not leave the feature off; it
	// refuses to start, and doctor was telling the operator the opposite.
	const cwd = scaffoldedCwd();
	for (const blank of ["", "   "]) {
		const { out, text } = capture();
		await runDoctor(imgEnv({ PI_PAUSE_WINDOWS_FILE: blank }), scaffoldDeps(out, cwd));
		assert.match(text(), /PI_PAUSE_WINDOWS_FILE is set to an EMPTY value in this shell, which is not the same as unset: the worker keeps it, tries to load a pause-windows file at that empty path, and REFUSES TO START/, JSON.stringify(blank));
		assert.doesNotMatch(text(), /PI_PAUSE_WINDOWS_FILE is unset -- the worker ignores it/, "the false sentence is gone");
	}
	// And a genuinely ABSENT key still gets the unset warning, which is the sentence that was always true.
	const { out, text } = capture();
	await runDoctor(imgEnv(), scaffoldDeps(out, cwd));
	assert.ok(text().includes(`⚠ ${join(cwd, "pause-windows.json")} exists but PI_PAUSE_WINDOWS_FILE is unset`));
});

test("doctor: the pause-windows mismatch is NEVER tier -- doctor cannot guess which path was meant", async () => {
	// This cwd is doctor's, not necessarily the worker's, and writing an env line would be guessing a
	// semantic value. The doctrine pin below enforces the allowed set generally; this asserts it at the
	// check that would be most tempting to automate.
	const cwd = scaffoldedCwd();
	const checks = await collectChecks(imgEnv(), collectSeams(green, { cwd, nodeVersion: "22.19.0", probeValkey: async () => true }));
	const c = checks.find((x) => /PI_PAUSE_WINDOWS_FILE is unset/.test(x.label));
	assert.ok(c, "the check is present");
	assert.equal(c.ok, false);
	assert.equal(c.warn, true);
	assert.equal(c.fixAction, undefined, "no offer: only the operator knows which file the worker will actually see");
});

// -- receiver preflight (issue #80): what receiver boot will refuse, said at doctor time --------------

/** A triggers file with one forge label trigger of `kind`. Azure carries the `run.repository` its label
 *  triggers require. Validates through the shared parseTriggers for triggersFile's reason above. */
function forgeTriggersFile(kind) {
	const path = join(tempDir("pi-triggers-forge-"), "triggers.json");
	const run = { kind, flow: "fix", ...(kind === "azure" ? { repository: "webapp" } : {}) };
	writeFileSync(path, JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi:fix"] }, run }] }));
	return path;
}

test("doctor: forge triggers without WEBHOOK_SECRET warn that the receiver will refuse to start", async () => {
	const { out, text } = capture();
	const code = await runDoctor(imgEnv({ PI_TRIGGERS_FILE: forgeTriggersFile("github") }), imgDeps(out, green));
	assert.equal(code, 0, "mid-setup is legitimate -- warn, never fail");
	assert.match(text(), /⚠ triggers\.json has github triggers but WEBHOOK_SECRET is unset -- the receiver will refuse to start/);
	assert.match(text(), /openssl rand -hex 32/, "the fix shows how to mint one");
	assert.match(text(), /pi-dispatch-receiver/, "the fix names the bin that starts the receiver");
});

test("doctor: WEBHOOK_SECRET presence is reported, its value never echoed", async () => {
	const { out, text } = capture();
	await runDoctor(imgEnv({ PI_TRIGGERS_FILE: forgeTriggersFile("github"), WEBHOOK_SECRET: "wh_secret_val_9" }), imgDeps(out, green));
	assert.match(text(), /✓ WEBHOOK_SECRET set/);
	assert.doesNotMatch(text(), /wh_secret_val_9/, "presence only -- the secret never reaches output");
});

test("doctor: a deployment with no forge triggers prints no receiver line at all", async () => {
	const { out, text } = capture();
	await runDoctor(imgEnv({ PI_TRIGGERS_FILE: triggersFile() }), imgDeps(out, green));
	assert.doesNotMatch(text(), /WEBHOOK_SECRET|RECEIVER_PORT/, "no receiver noise for a cron/local-only deployment");
});

test("doctor: a malformed RECEIVER_PORT is echoed by value and warned about; a sane one prints nothing", async () => {
	// The port is not a secret, so echoing the malformed shape is what makes the warn actionable.
	const { out, text } = capture();
	await runDoctor(imgEnv({ PI_TRIGGERS_FILE: forgeTriggersFile("github"), RECEIVER_PORT: "http" }), imgDeps(out, green));
	assert.match(text(), /⚠ RECEIVER_PORT is "http", which is not a positive integer -- the receiver will refuse to start/);

	const { out: o2, text: t2 } = capture();
	await runDoctor(imgEnv({ PI_TRIGGERS_FILE: forgeTriggersFile("github"), RECEIVER_PORT: "0" }), imgDeps(o2, green));
	assert.match(t2(), /⚠ RECEIVER_PORT is "0"/, "zero is not a bindable choice either");

	const { out: o3, text: t3 } = capture();
	await runDoctor(imgEnv({ PI_TRIGGERS_FILE: forgeTriggersFile("github"), RECEIVER_PORT: "3000" }), imgDeps(o3, green));
	assert.doesNotMatch(t3(), /RECEIVER_PORT/, "a valid port needs no line");
});

test("doctor: forgejo triggers with nothing set warn with the exact vars receiver boot requires", async () => {
	const { out, text } = capture();
	const code = await runDoctor(imgEnv({ PI_TRIGGERS_FILE: forgeTriggersFile("forgejo") }), imgDeps(out, green));
	assert.equal(code, 0, "warn, never fail");
	assert.match(text(), /⚠ triggers\.json has forgejo triggers but FORGEJO_URL, FORGEJO_WEBHOOK_SECRET, FORGEJO_TOKEN are unset/);
	assert.match(text(), /docs\/forgejo\.md/, "the fix says where the setup is documented");
	assert.match(text(), /FORGEJO_BOT_ID/, "the repository-scoped-token caveat is named");
});

test("doctor: a half-set forgejo block names only the vars actually missing", async () => {
	const { out, text } = capture();
	await runDoctor(
		imgEnv({ PI_TRIGGERS_FILE: forgeTriggersFile("forgejo"), FORGEJO_URL: "https://code.example.org", FORGEJO_TOKEN: "fj_token_val" }),
		imgDeps(out, green),
	);
	assert.match(text(), /⚠ triggers\.json has forgejo triggers but FORGEJO_WEBHOOK_SECRET is unset/);
	assert.doesNotMatch(text(), /FORGEJO_URL,|FORGEJO_TOKEN,/, "set vars are not reported missing");
	assert.doesNotMatch(text(), /fj_token_val/, "the token value never reaches output");
});

test("doctor: a fully-configured forgejo block reports ✓ with the instance URL, secrets unechoed", async () => {
	const { out, text } = capture();
	await runDoctor(
		imgEnv({ PI_TRIGGERS_FILE: forgeTriggersFile("forgejo"), FORGEJO_URL: "https://code.example.org", FORGEJO_WEBHOOK_SECRET: "fj_hook_secret", FORGEJO_TOKEN: "fj_token_val" }),
		imgDeps(out, green),
	);
	assert.match(text(), /✓ forgejo triggers configured \(https:\/\/code\.example\.org\)/);
	assert.doesNotMatch(text(), /fj_hook_secret|fj_token_val/, "presence only");
});

test("doctor: azure triggers with nothing set warn for the undefaulted mode AND the required vars", async () => {
	const { out, text } = capture();
	const code = await runDoctor(imgEnv({ PI_TRIGGERS_FILE: forgeTriggersFile("azure") }), imgDeps(out, green));
	assert.equal(code, 0, "warn, never fail");
	assert.match(text(), /⚠ triggers\.json has azure triggers but AZURE_WEBHOOK_MODE is unset -- the receiver will refuse to start/);
	assert.match(text(), /"basic" \(HTTP Basic on the service hook\) or "header"/, "the fix names both legal modes");
	assert.match(text(), /⚠ triggers\.json has azure triggers but AZURE_WEBHOOK_SECRET, AZURE_TOKEN, AZURE_ORG_URL are unset/);
	assert.match(text(), /docs\/azure-devops\.md/);
});

test("doctor: AZURE_WEBHOOK_MODE=header pulls AZURE_WEBHOOK_HEADER into the required set", async () => {
	const { out, text } = capture();
	await runDoctor(
		imgEnv({ PI_TRIGGERS_FILE: forgeTriggersFile("azure"), AZURE_WEBHOOK_MODE: "header", AZURE_WEBHOOK_SECRET: "az_hook_secret", AZURE_TOKEN: "az_token_val", AZURE_ORG_URL: "https://dev.azure.com/acme" }),
		imgDeps(out, green),
	);
	assert.match(text(), /⚠ triggers\.json has azure triggers but AZURE_WEBHOOK_HEADER is unset/);
	assert.doesNotMatch(text(), /az_hook_secret|az_token_val/, "presence only");
});

test("doctor: a fully-configured azure block reports ✓ with the org URL; a bogus mode is echoed", async () => {
	const base = { PI_TRIGGERS_FILE: forgeTriggersFile("azure"), AZURE_WEBHOOK_SECRET: "az_hook_secret", AZURE_TOKEN: "az_token_val", AZURE_ORG_URL: "https://dev.azure.com/acme" };
	const { out, text } = capture();
	await runDoctor(imgEnv({ ...base, AZURE_WEBHOOK_MODE: "basic" }), imgDeps(out, green));
	assert.match(text(), /✓ azure triggers configured \(https:\/\/dev\.azure\.com\/acme\)/);
	assert.doesNotMatch(text(), /az_hook_secret|az_token_val/, "presence only");

	// A value boot refuses is echoed by name -- a mode is a choice, not a secret.
	const { out: o2, text: t2 } = capture();
	await runDoctor(imgEnv({ ...base, AZURE_WEBHOOK_MODE: "hmac" }), imgDeps(o2, green));
	assert.match(t2(), /⚠ triggers\.json has azure triggers but AZURE_WEBHOOK_MODE is "hmac"/);
	assert.doesNotMatch(t2(), /✓ azure triggers configured/, "an unbootable mode is not reported configured");
});

test("doctor: gitlab triggers also preflight the receiver-boot vars (undefaulted mode, secret presence)", async () => {
	const { out, text } = capture();
	await runDoctor(imgEnv({ PI_TRIGGERS_FILE: forgeTriggersFile("gitlab"), GITLAB_TOKEN: "glpat_secret_val" }), imgDeps(out, green));
	assert.match(text(), /✓ gitlab triggers configured \(https:\/\/gitlab\.com\)/, "the worker-side token line is unchanged");
	assert.match(text(), /⚠ triggers\.json has gitlab triggers but GITLAB_WEBHOOK_MODE is unset/);
	assert.match(text(), /⚠ triggers\.json has gitlab triggers but GITLAB_WEBHOOK_SECRET is unset/);
	assert.doesNotMatch(text(), /glpat_secret_val/, "the token value never reaches output");

	const { out: o2, text: t2 } = capture();
	await runDoctor(
		imgEnv({ PI_TRIGGERS_FILE: forgeTriggersFile("gitlab"), GITLAB_TOKEN: "glpat_secret_val", GITLAB_WEBHOOK_MODE: "signature", GITLAB_WEBHOOK_SECRET: "gl_hook_secret" }),
		imgDeps(o2, green),
	);
	assert.doesNotMatch(t2(), /GITLAB_WEBHOOK_MODE is/, "a chosen mode prints no line");
	assert.doesNotMatch(t2(), /GITLAB_WEBHOOK_SECRET is unset/);
	assert.doesNotMatch(t2(), /gl_hook_secret/, "presence only");
});

test("doctor: each forge block appears only when the triggers file names that forge", async () => {
	const { out, text } = capture();
	await runDoctor(imgEnv({ PI_TRIGGERS_FILE: forgeTriggersFile("github") }), imgDeps(out, green));
	assert.doesNotMatch(text(), /FORGEJO|AZURE|gitlab triggers/, "github triggers summon no other forge's block");
});

// -- branch-protection preflight (issue #80, REQ-BRANCH-PROTECTION-PRECONDITION) ----------------------

test("doctor: github triggers get ONE informational protection line, and no gh api calls", async () => {
	// No valid github trigger can name a run.repository today (the shared schema admits the field on azure
	// only), so runDoctor's live path is the single "enforced per job" line -- and NO network is touched.
	const calls = [];
	const { out, text } = capture();
	await runDoctor(imgEnv({ PI_TRIGGERS_FILE: forgeTriggersFile("github") }), imgDeps(out, green, calls));
	assert.match(text(), /✓ github triggers take their repository from each delivery/);
	assert.match(text(), /REQ-BRANCH-PROTECTION-PRECONDITION/);
	assert.ok(!calls.some((c) => c.cmd === "gh" && c.args[0] === "api"), "nothing named a repo, so nothing is asked of GitHub");
});

// The per-repo loop, exercised directly: no valid triggers file reaches it through runDoctor yet (see
// doctor.mjs), so these pin the wiring for the day the schema grows run.repository for github.
const protectionPlan = (protectionCode) => ({
	"gh auth status": { code: 0, output: ghStatusOutput },
	"gh api repos/octo/webapp --jq": { code: 0, output: "main\n" },
	"gh api repos/octo/webapp/branches/main/protection": protectionCode,
});

test("githubProtectionPreflight: a protected default branch is one ✓ check", async () => {
	const checks = await githubProtectionPreflight(fakeSpawn(protectionPlan(0)), ["octo/webapp"]);
	assert.equal(checks.length, 1);
	assert.equal(checks[0].ok, true);
	assert.match(checks[0].label, /default branch of octo\/webapp is protected \(main\)/);
});

test("githubProtectionPreflight: an unprotected branch warns with the REQ id; the fix is shown, never run", async () => {
	const checks = await githubProtectionPreflight(fakeSpawn(protectionPlan(1)), ["octo/webapp"]);
	assert.equal(checks.length, 1);
	assert.equal(checks[0].ok, false);
	assert.equal(checks[0].warn, true, "warn, never fail -- the worker's own gate is the enforcement");
	assert.match(checks[0].label, /default branch of octo\/webapp is not protected/);
	assert.match(checks[0].label, /REQ-BRANCH-PROTECTION-PRECONDITION/);
	assert.match(checks[0].fix, /https:\/\/github\.com\/octo\/webapp\/settings\/branches/, "the settings URL is shown");
});

test("githubProtectionPreflight: gh missing is ONE warn and no api calls", async () => {
	const calls = [];
	const checks = await githubProtectionPreflight(fakeSpawn({ "gh auth status": "enoent" }, calls), ["octo/webapp", "octo/api"]);
	assert.equal(checks.length, 1, "one warn covers every repo");
	assert.equal(checks[0].ok, false);
	assert.equal(checks[0].warn, true);
	assert.match(checks[0].label, /branch-protection preflight skipped/);
	assert.ok(!calls.some((c) => c.args?.[0] === "api"), "the loop is skipped, not failed per-repo");
});

test("githubProtectionPreflight: an unresolvable repo warns per repo, and the loop caps at 5", async () => {
	const calls = [];
	const repos = ["octo/r1", "octo/r2", "octo/r3", "octo/r4", "octo/r5", "octo/r6"];
	const plan = { "gh auth status": { code: 0, output: ghStatusOutput }, "gh api": 1 }; // every api call fails
	const checks = await githubProtectionPreflight(fakeSpawn(plan, calls), repos);
	assert.equal(checks[0].ok, true, "the cap is information, not a fault");
	assert.match(checks[0].label, /capped at 5 of 6 repos/);
	assert.equal(checks.length, 6, "the cap line plus one warn per checked repo");
	assert.ok(checks.slice(1).every((c) => !c.ok && c.warn && /could not resolve the default branch/.test(c.label)));
	assert.ok(!calls.some((c) => c.args?.join(" ").includes("octo/r6")), "the sixth repo is never queried");
});

// -- doctor --fix (issue #80, REQ-DEPLOYMENT-BOOTSTRAP): offers, tiers, and the never-tier pin --------

/** A y/N prompt recorder. `answer` is the canned reply (or a fn of the call count). */
function promptRecorder(answer = false) {
	const calls = [];
	const fn = async (q) => {
		calls.push(q);
		return typeof answer === "function" ? answer(calls.length) : answer;
	};
	return { fn, calls };
}

/**
 * A validating triggers file whose one trigger sets run.resume (REQ-RESUMABLE-SESSION).
 *
 * A FORGE trigger, not a cron one: `run.resume: true` is refused on a local/cron entry (triggers.mjs --
 * resolveSession is handed to the forge preparers only, so an armed cron job would stage nothing and still
 * exit 0). The fixture has to be a file the SHARED parseTriggers really accepts, or readTriggerFacts
 * swallows the refusal to zeroes and every resume assertion here passes for the wrong reason.
 */
function resumeTriggersFile() {
	const path = join(tempDir("pi-triggers-resume-"), "triggers.json");
	const run = { kind: "github", flow: "review", resume: true };
	writeFileSync(path, JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi:review"] }, run }] }));
	return path;
}

test("doctor: without --fix, a fixAction-bearing failure prints exactly the old fix line and asks nothing", async () => {
	// The non-adopter byte-identity guard for --fix: same lines, same fixes, and the injected prompt is
	// never consulted -- offering is strictly opt-in behavior.
	const { fn: promptFn, calls: prompts } = promptRecorder(true);
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" },
		{ out, cwd: tmpdir(), spawn: fakeSpawn({ ...EGRESS_OK, "docker info": 0, "docker image": 1 }), probeValkey: async () => false, fileExists: () => true, nodeVersion: "22.19.0", promptFn },
	);
	assert.equal(code, 1);
	assert.match(
		text(),
		/✗ Job image present \(pi-job:latest\)\n    → docker pull ghcr\.io\/edgehero\/pi-job:latest && docker tag ghcr\.io\/edgehero\/pi-job:latest pi-job:latest {2}\(or build image\/Dockerfile\)\n/,
	);
	assert.match(text(), /✗ Valkey reachable \(redis:\/\/127\.0\.0\.1:6379\)\n    → docker compose -f deploy\/docker-compose\.yml up -d\n/);
	assert.equal(prompts.length, 0, "no --fix, no prompt -- even with a promptFn injected");
	assert.doesNotMatch(text(), /fix available|run this\?|skipped:|fixed:|re-check after fixes/);
});

test("doctor --fix: declining every offer runs nothing and leaves the exit code alone", async () => {
	const calls = [];
	const { fn: promptFn, calls: prompts } = promptRecorder(false);
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" },
		{ out, cwd: tmpdir(), spawn: fakeSpawn({ ...EGRESS_OK, "docker info": 0, "docker image": 1 }, calls), probeValkey: async () => false, fileExists: () => true, nodeVersion: "22.19.0", fix: true, promptFn },
	);
	assert.equal(code, 1, "warn-not-fail doctrine: offering fixes changes nothing about severity");
	// The EXACT command is shown before each prompt -- consent is to a command, not to a vibe.
	assert.match(text(), /fix available: Job image present \(pi-job:latest\)\n {4}\$ docker pull ghcr\.io\/edgehero\/pi-job:latest && docker tag ghcr\.io\/edgehero\/pi-job:latest pi-job:latest\n/);
	assert.match(
		text(),
		/fix available: Valkey reachable \(redis:\/\/127\.0\.0\.1:6379\)\n {4}\$ docker run -d --name pi-dispatch-valkey --restart unless-stopped -p 127\.0\.0\.1:6379:6379 -v pi-dispatch-valkey-data:\/data valkey\/valkey:8 valkey-server --appendonly yes\n/,
	);
	assert.match(text(), /skipped: Job image present \(pi-job:latest\)/);
	assert.match(text(), /skipped: Valkey reachable/);
	assert.deepEqual(prompts, ["run this? [y/N] ", "run this? [y/N] "]);
	assert.ok(!calls.some((c) => ["pull", "tag", "run"].includes(c.args[0])), "no spawn beyond the probes: a declined offer executes nothing");
	assert.doesNotMatch(text(), /re-check after fixes/, "nothing ran, so nothing is re-checked");
});

test("doctor --fix: accepting the image offer runs exactly docker pull then docker tag", async () => {
	const calls = [];
	const { out, text } = capture();
	await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" },
		{
			out,
			cwd: tmpdir(),
			spawn: fakeSpawn({ ...EGRESS_OK, "docker info": 0, "docker image": 1, "docker pull": 0, "docker tag": 0 }, calls),
			probeValkey: async () => true,
			fileExists: () => true,
			nodeVersion: "22.19.0",
			fix: true,
			promptFn: async () => true,
		},
	);
	const acts = calls.filter((c) => ["pull", "tag"].includes(c.args[0]));
	assert.deepEqual(
		acts.map((c) => [c.cmd, ...c.args]),
		[
			["docker", "pull", "ghcr.io/edgehero/pi-job:latest"],
			["docker", "tag", "ghcr.io/edgehero/pi-job:latest", "pi-job:latest"],
		],
		"exactly the printed command, as two argv arrays, in order",
	);
	assert.match(text(), /fixed: Job image present \(pi-job:latest\)/);
});

test("doctor --fix: the converge re-check reruns the probes once and reports green", async () => {
	const calls = [];
	const plan = { ...EGRESS_OK, "docker info": 0, "docker image": 1, "docker pull": 0, "docker tag": 0 };
	const inner = fakeSpawn(plan, calls);
	// Once the tag lands, the next inspect finds the image -- the probes are idempotent, so the single
	// re-collect is what honestly turns the report green.
	const spawn = (cmd, args, opts) => {
		const child = inner(cmd, args, opts);
		if (cmd === "docker" && args[0] === "tag") plan["docker image"] = 0;
		return child;
	};
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", GITHUB_AUTH_SOURCE: "pat" },
		{ out, cwd: tmpdir(), spawn, probeValkey: async () => true, fileExists: () => true, nodeVersion: "22.19.0", fix: true, promptFn: async () => true },
	);
	assert.match(text(), /✗ Job image present \(pi-job:latest\)/, "the first pass reported the failure as always");
	assert.match(text(), /re-check after fixes: \d+ of \d+ checks pass/);
	assert.match(text(), /\ndoctor: ready\. Start the worker with `pi-dispatch worker`\.\n/);
	assert.equal(code, 0, "converge-to-green: the exit code judges the re-checked list by the same failed/ok logic");
});

test("doctor --fix: accepting the valkey offer runs the exact loopback docker run argv, and converges", async () => {
	const calls = [];
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", GITHUB_AUTH_SOURCE: "pat" },
		{
			out,
			cwd: tmpdir(),
			spawn: fakeSpawn({ ...EGRESS_OK, "docker info": 0, "docker image": 0, "docker run": 0 }, calls),
			// Reachable exactly once the container has been started: the converge pass flips to ✓ only
			// because the fix actually ran, not because fixing earns credit.
			probeValkey: async () => calls.some((c) => c.cmd === "docker" && c.args[0] === "run" && c.args.includes("pi-dispatch-valkey")),
			fileExists: () => true,
			nodeVersion: "22.19.0",
			fix: true,
			promptFn: async () => true,
		},
	);
	// The VALKEY run, named explicitly: the egress checks run their own probe containers, so "the first
	// docker run" stopped being a unique way to name this one.
	const run = calls.find((c) => c.cmd === "docker" && c.args[0] === "run" && c.args.includes("pi-dispatch-valkey"));
	assert.deepEqual(run.args, [
		"run",
		"-d",
		"--name",
		"pi-dispatch-valkey",
		"--restart",
		"unless-stopped",
		"-p",
		"127.0.0.1:6379:6379",
		"-v",
		"pi-dispatch-valkey-data:/data",
		"valkey/valkey:8",
		"valkey-server",
		"--appendonly",
		"yes",
	]);
	assert.match(text(), /fixed: Valkey reachable \(redis:\/\/127\.0\.0\.1:6379\)/);
	assert.match(text(), /re-check after fixes/);
	assert.equal(code, 0);
});

test("doctor prints which resume bounds are on, so an unset one is legible as a choice", async () => {
	const { out, text } = capture();
	await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_SESSIONS_DIR: "/srv/pi-sessions", PI_TRIGGERS_FILE: resumeTriggersFile(), GITHUB_AUTH_SOURCE: "pat" },
		{ out, spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0", fileExists: () => true },
	);
	// Defaults: the TTL ships at 14 and the three eligibility bounds ship off. All four are printed, because
	// a knob that is silent when unset gives an operator no way to tell a deliberate "no bound" from a
	// forgotten one.
	assert.match(text(), /Resume bounds: PI_SESSIONS_TTL_DAYS=14, PI_SESSION_MAX_AGE_DAYS=off, PI_SESSION_MAX_RESUME_CHAIN=off, PI_SESSION_MAX_CONTEXT_PCT=off/);
});

test("doctor warns that the context bound is inert until the job image reports a measurement", async () => {
	// The one bound that can be set and still do nothing. Its measurement comes from the image's runner,
	// and there is deliberately no capability label to check against, so this warning is the entire
	// detection surface for "you set it and nothing is happening".
	const env = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_SESSIONS_DIR: "/srv/pi-sessions", PI_TRIGGERS_FILE: resumeTriggersFile(), GITHUB_AUTH_SOURCE: "pat" };
	const opts = { spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0", fileExists: () => true };

	const on = capture();
	await runDoctor({ ...env, PI_SESSION_MAX_CONTEXT_PCT: "80" }, { ...opts, out: on.out });
	assert.match(on.text(), /PI_SESSION_MAX_CONTEXT_PCT=80 needs a job image whose runner reports context usage/);

	const off = capture();
	await runDoctor(env, { ...opts, out: off.out });
	assert.doesNotMatch(off.text(), /needs a job image whose runner reports context usage/, "unset means unset: no warning about a bound nobody asked for");
});

test("the resume-bound lines appear only for a deployment that actually resumes", async () => {
	// Same restraint the store checks keep: a deployment with no armed trigger is told nothing about a
	// feature it does not use.
	const { out, text } = capture();
	await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_SESSIONS_DIR: "/srv/pi-sessions", PI_SESSION_MAX_CONTEXT_PCT: "80", GITHUB_AUTH_SOURCE: "pat" },
		{ out, spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0", fileExists: () => true },
	);
	assert.doesNotMatch(text(), /Resume bounds:/);
	assert.doesNotMatch(text(), /needs a job image whose runner reports context usage/);
});

test("doctor --fix: the declared-but-absent session store is created silently -- mkdir -p, chmod 700, no prompt", async () => {
	const sessionsDir = "/srv/pi-sessions";
	const made = [];
	const modes = [];
	const { fn: promptFn, calls: prompts } = promptRecorder(true);
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_SESSIONS_DIR: sessionsDir, PI_TRIGGERS_FILE: resumeTriggersFile(), GITHUB_AUTH_SOURCE: "pat" },
		{
			out,
			spawn: fakeSpawn(green),
			probeValkey: async () => true,
			nodeVersion: "22.19.0",
			fix: true,
			promptFn,
			// The store exists once mkdir ran -- everything else exists throughout.
			fileExists: (p) => (p === sessionsDir ? made.length > 0 : true),
			mkdir: (p, o) => made.push([p, o]),
			chmod: (p, m) => modes.push([p, m]),
		},
	);
	assert.equal(prompts.length, 0, "silent tier: setting PI_SESSIONS_DIR was the decision -- no prompt for the mechanical mkdir");
	assert.deepEqual(made, [[sessionsDir, { recursive: true }]]);
	assert.deepEqual(modes, [[sessionsDir, 0o700]], "0700 exactly -- transcripts are PII-bearing");
	assert.match(text(), /fixed: Session store does not exist \(\/srv\/pi-sessions\) — mode 0700/);
	assert.match(text(), /re-check after fixes/);
	assert.equal(code, 0, "the converge pass re-probes the now-existing store");
});

test("doctor --fix: a missing .env is delegated to init's create-only scaffolds, silently", async () => {
	const cwd = tempDir("pi-fix-init-");
	const { fn: promptFn, calls: prompts } = promptRecorder(true);
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", GITHUB_AUTH_SOURCE: "pat" },
		{ out, cwd, spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0", fix: true, promptFn },
	);
	assert.equal(prompts.length, 0, "scaffold delegation is silent -- init is create-only by contract and can overwrite nothing");
	assert.ok(existsSync(join(cwd, ".env")), "init created the .env");
	assert.match(text(), /created \.env {2,}from \.env\.example/, "init's own report is forwarded");
	assert.match(text(), /fixed: \.env present — scaffolded by `pi-dispatch init` \(create-only: existing files were kept\)/);
	assert.doesNotMatch(text().split("re-check after fixes")[1], /\.env present/, "the converge pass no longer lists it");
	assert.equal(code, 0);
});

test("doctor --fix: accepting the overlay auth.json offer deletes the file and converges credential-free", async () => {
	const dir = overlay({ auth: true });
	const cwd = tempDir("pi-fix-auth-");
	const { fn: promptFn, calls: prompts } = promptRecorder(true);
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(dir, { GITHUB_AUTH_SOURCE: "pat" }), {
		out,
		cwd,
		spawn: fakeSpawn(green),
		probeValkey: async () => true,
		nodeVersion: "22.19.0",
		fix: true,
		promptFn,
	});
	assert.deepEqual(prompts, ["run this? [y/N] "], "prompt tier: deleting an operator's file always gets a look first");
	assert.ok(text().includes(`    $ rm ${join(dir, "auth.json")}\n`), "the exact rm is shown before consent");
	assert.ok(!existsSync(join(dir, "auth.json")), "the credential file is gone");
	assert.match(text(), /fixed: Overlay is credential-free \(no auth\.json\)/);
	assert.doesNotMatch(text().split("re-check after fixes")[1], /credential-free/, "the converge pass finds the overlay clean");
	assert.equal(code, 0);
});

test("doctor --fix: accepting the restage offer re-runs import-pi as a child through the injected spawn", async () => {
	const dir = overlay({ packages: [pkg(), pkg({ name: "pi-lint", version: "0.4.0", dir: "pi-lint", stage: false })] });
	const cwd = tempDir("pi-fix-restage-");
	const calls = [];
	const env = overlayEnv(dir, { GITHUB_AUTH_SOURCE: "pat" });
	const { fn: promptFn, calls: prompts } = promptRecorder(true);
	const { out, text } = capture();
	await runDoctor(env, {
		out,
		cwd,
		spawn: fakeSpawn({ ...green, [process.execPath]: { code: 0, output: "restage-run-output\n" } }, calls),
		probeValkey: async () => true,
		nodeVersion: "22.19.0",
		fix: true,
		promptFn,
	});
	assert.deepEqual(prompts, ["run this? [y/N] "]);
	assert.ok(text().includes(`    $ pi-dispatch import-pi --with-packages --no-host-packages --to ${dir}\n`), "the offer names the exact command");
	const child = calls.find((c) => c.cmd === process.execPath);
	assert.ok(child, "import-pi runs as a child process, so its own gates and printed-names vetting run unmodified");
	assert.ok(child.args[0].endsWith("cli.mjs"), "spawned through the real CLI entry");
	// --no-host-packages keeps the ONE automated staging path a repair: accepting a doctor prompt restores
	// what the overlay declared, it never performs a first-time import of the host's pi setup (issue #102).
	assert.deepEqual(child.args.slice(1), ["import-pi", "--with-packages", "--no-host-packages", "--to", dir]);
	assert.equal(child.opts.env, env, "the child inherits doctor's env (PI_PACKAGES_FILE, PI_CODING_AGENT_DIR)");
	assert.equal(child.opts.cwd, cwd, "and doctor's cwd seam, where pi-packages.json lives");
	assert.match(text(), /restage-run-output/, "import-pi's own output is forwarded");
	assert.match(text(), /fixed: Staged packages present \(pi-fmt@1\.2\.3, pi-lint@0\.4\.0\)/);
	// The converge pass re-probes the real dirs; the fake spawn staged nothing, so the check honestly
	// stays failing -- running a fix is reported, convergence is measured.
	assert.match(text().split("re-check after fixes")[1], /✗ Staged packages present/);
});

test("doctor --fix: the default prompt answers No on non-TTY stdin and on plain enter", async () => {
	// Non-TTY is refused without reading at all -- a piped/CI --fix run must execute nothing prompt-tier.
	assert.equal(await defaultPromptFn("run this? [y/N] ", { input: new PassThrough(), output: new PassThrough() }), false);

	// Plain enter on a TTY-shaped stream is No: consent is only ever an explicit y.
	const emptyIn = new PassThrough();
	emptyIn.isTTY = true;
	const emptyAnswer = defaultPromptFn("run this? [y/N] ", { input: emptyIn, output: new PassThrough() });
	emptyIn.write("\n");
	assert.equal(await emptyAnswer, false);

	const yesIn = new PassThrough();
	yesIn.isTTY = true;
	const yesAnswer = defaultPromptFn("run this? [y/N] ", { input: yesIn, output: new PassThrough() });
	yesIn.write("y\n");
	assert.equal(await yesAnswer, true);
});

test("doctor --fix: piped stdin executes nothing from the prompt tier, end to end", async () => {
	const calls = [];
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" },
		{
			out,
			cwd: tmpdir(),
			spawn: fakeSpawn({ ...EGRESS_OK, "docker info": 0, "docker image": 1 }, calls),
			probeValkey: async () => true,
			fileExists: () => true,
			nodeVersion: "22.19.0",
			fix: true,
			promptFn: (q) => defaultPromptFn(q, { input: new PassThrough(), output: new PassThrough() }),
		},
	);
	assert.equal(code, 1);
	assert.match(text(), /skipped: Job image present/);
	assert.ok(!calls.some((c) => c.args[0] === "pull"), "default-No: nothing was pulled");
});

test("doctor --fix: secret values still never reach output", async () => {
	const { out, text } = capture();
	await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-secret-value", WEBHOOK_SECRET: "wh_secret_val_9", PI_TRIGGERS_FILE: forgeTriggersFile("github") },
		{
			out,
			cwd: tmpdir(),
			spawn: fakeSpawn({ ...green, "gh auth status": { code: 0, output: ghStatusOutput }, "gh auth token": { code: 0, output: "gho_secret_mint\n" }, "docker run": 0 }),
			probeValkey: async () => false,
			fileExists: () => true,
			nodeVersion: "22.19.0",
			fix: true,
			promptFn: async () => true,
		},
	);
	assert.doesNotMatch(text(), /sk-secret-value|gho_secret_mint|wh_secret_val_9/, "--fix changes nothing about secrets-and-pii");
});

// -- the never-tier doctrine pin: which checks may carry a fixAction, exactly, and no more ------------

// The allowed set, by label and tier. THIS list is the doctrine (REQ-DEPLOYMENT-BOOTSTRAP): a future
// check that grows a fixAction fails assertFixActionDoctrine by default, until someone deliberately adds
// it here and answers for the trust ladder it sits on.
const ALLOWED_FIXACTIONS = [
	[/^\.env present$/, "silent"],
	[/^Session store (exists|does not exist) \(/, "silent"],
	[/^Job image present \(pi-job:latest\)$/, "prompt"],
	[/^Valkey reachable \(redis:\/\/(127\.0\.0\.1|localhost)(:6379)?\/?\)$/, "prompt"],
	[/^Overlay is credential-free \(no auth\.json\)$/, "prompt"],
	[/^Staged packages manifest readable \(/, "prompt"],
	[/^Staged packages present \(/, "prompt"],
];

/** Walk a check list; fail on any fixAction outside the allowed set. Returns the carrying labels. */
function assertFixActionDoctrine(checks) {
	const carried = [];
	for (const c of checks) {
		if (!c.fixAction) continue;
		carried.push(c.label);
		const allowed = ALLOWED_FIXACTIONS.find(([re]) => re.test(c.label));
		assert.ok(allowed, `check "${c.label}" carries a fixAction outside the allowed set -- the never tier is doctrine`);
		assert.equal(c.fixAction.tier, allowed[1], `check "${c.label}" carries the wrong tier`);
		assert.equal(typeof c.fixAction.describe, "string", "every offer must show an exact command");
		assert.equal(typeof c.fixAction.run, "function");
	}
	return carried;
}

const collectSeams = (plan, extra = {}) => ({
	cwd: tempDir("pi-fix-doctrine-"),
	out: () => {},
	spawn: fakeSpawn(plan),
	probeValkey: async () => false,
	// Issue #57: no fleet unless a test says so, which is what keeps every existing doctor assertion --
	// and a single-host deployment's real output -- byte-identical.
	readHosts: async () => ({ hosts: [] }),
	fileExists: existsSync,
	nodeVersion: "20.10.0",
	...extra,
});

/** One validating triggers file that names every forge, a custom image, resume, and replicas. */
function fullyBrokenTriggersFile() {
	const path = join(tempDir("pi-triggers-broken-"), "triggers.json");
	const triggers = [
		{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/repo", flow: "review", task: "t", image: "custom-img:1" } },
		{ on: { type: "label", any: ["pi:fix"] }, run: { kind: "github", flow: "fix", replicas: 2 } },
		// `resume` rides a FORGE trigger, and not the replicating one: triggers.mjs refuses run.resume on a
		// local entry AND refuses it beside run.replicas, so this is the only entry that can carry it. A
		// fixture parseTriggers rejects would zero every count this pin depends on.
		{ on: { type: "label", any: ["pi:fix"] }, run: { kind: "gitlab", flow: "fix", resume: true } },
		{ on: { type: "label", any: ["pi:fix"] }, run: { kind: "forgejo", flow: "fix" } },
		{ on: { type: "label", any: ["pi:fix"] }, run: { kind: "azure", flow: "fix", repository: "webapp" } },
	];
	writeFileSync(path, JSON.stringify({ triggers }));
	return path;
}

test("doctor --fix doctrine: from a fully-broken env, no check outside the allowed set carries a fixAction", async () => {
	// Everything that can fail does: old node, no .env, absent images (default AND trigger-named), gh
	// missing, valkey down, no provider key, a poisoned overlay (auth.json, malformed models.json, a
	// missing staged dir, an admin-alike package), a malformed extensions knob, all four forges
	// misconfigured, and a declared-but-absent session store.
	const dir = overlay({
		auth: true,
		models: "{not json",
		extensions: true,
		packages: [pkg(), pkg({ name: "pi-lint", version: "0.4.0", dir: "pi-lint", stage: false }), pkg({ name: "dispatch-admin", version: "0.1.0", dir: "dispatch-admin" })],
	});
	// A scoped-limits file wrong in the boot-blocking way (issue #242), plus a dead-folder row route:
	// without one, none of the three new scoped checks enters this walk and the never-tier pin hollows.
	const scopedLimitsDir = tempDir("pi-doctrine-sl-");
	writeFileSync(join(scopedLimitsDir, "scoped-limits.json"), JSON.stringify({ version: 1, limits: [{ scope: "/srv/never-runs", day: 1 }] }));
	const env = {
		PI_PROVIDER: "anthropic",
		PI_AUTH_FROM_PI: "0",
		PI_TRIGGERS_FILE: fullyBrokenTriggersFile(),
		PI_SCOPED_LIMITS_FILE: join(scopedLimitsDir, "scoped-limits.json"),
		PI_GLOBAL_PI_DIR: dir,
		PI_GLOBAL_ALLOW_EXTENSIONS: "maybe",
		PI_SESSIONS_DIR: join(tempDir("pi-sessions-parent-"), "absent"),
		RECEIVER_PORT: "http",
		AZURE_WEBHOOK_MODE: "hmac",
	};
	// A configured --env-setup seam, wrong in all three ways at once (issue #216). Without a unit that
	// names one, envSetupChecks returns [] and this pin would walk straight past the new checks -- the
	// same hollowing-out the triggers-parse guard below exists to prevent.
	const deployDir = tempDir("pi-doctrine-deploy-");
	const loose = setupScript({ mode: 0o777, dirMode: 0o777 });
	const { home } = installUnit({ platform: "linux", deployDir, setup: loose });
	const checks = await collectChecks(
		env,
		collectSeams({ ...EGRESS_OK, "docker info": 0, "docker image": 1, "gh auth": "enoent", "git ": 1 }, { cwd: deployDir, home, platform: "linux" }),
	);
	const carried = assertFixActionDoctrine(checks);
	// The fixture must actually reach every eligible check -- a triggers-parse regression swallowed to
	// zeroes would otherwise hollow this pin out silently.
	for (const expected of [/^\.env present$/, /^Job image present \(pi-job:latest\)$/, /^Valkey reachable/, /^Overlay is credential-free/, /^Staged packages present/, /^Session store does not exist/]) {
		assert.ok(carried.some((l) => expected.test(l)), `fixture failed to produce a fixAction for ${expected}`);
	}
	assert.equal(carried.length, 6, "exactly the eligible checks carry one, no more");
	// The nevers, by name: each of these IS failing here and still gets no offer.
	const never = (re, why) => {
		const c = checks.find((x) => re.test(x.label));
		assert.ok(c, `fixture lost the check ${re}`);
		assert.ok(!c.ok, `the pinned check ${re} is expected to be failing here`);
		assert.equal(c.fixAction, undefined, why);
	};
	never(/^Trigger job image present \(custom-img:1\)$/, "a trigger-named image is a per-flow trust posture -- never pulled for the operator");
	never(/^PI_GLOBAL_ALLOW_EXTENSIONS is/, "a semantic env value is never guessed");
	never(/^Overlay models\.json is credential-free$/, "malformed JSON is never rewritten");
	never(/^Staged package looks like the dispatch admin/, "removing staged code is the operator's call");
	never(/^Node ≥/, "doctor does not upgrade the host runtime");
	never(/^Provider key/, "doctor cannot know which provider an operator meant, and never mints a credential");
	// noKeyVariableCheck's two labels start differently and the fixture above cannot reach them, so they
	// are collected separately rather than left pinned only by the count.
	const unknownProvider = await collectChecks({ ...env, PI_PROVIDER: "gemini" }, collectSeams({ ...EGRESS_OK, "docker info": 0 }));
	const unknown = unknownProvider.find((c) => /^PI_PROVIDER is/.test(c.label));
	assert.ok(unknown, "the unknown-provider check is reachable");
	assert.ok(!unknown.ok, "and is failing here");
	assert.equal(unknown.fixAction, undefined, "doctor never rewrites PI_PROVIDER for the operator");
	never(/but WEBHOOK_SECRET is unset/, "secrets are never minted or set");
	never(/AZURE_WEBHOOK_MODE is/, "an undefaulted mode must stay a chosen thing");
	never(/GITHUB_AUTH_SOURCE is gh but/, "auth posture is never changed behind the operator");
	never(/^the env-setup script at .* is group\/world-writable$/, "doctor does not chmod an operator's file");
	never(/^the directory holding the env-setup script/, "nor the directory it sits in");
	never(/^the env-setup script at .* is inside a git work tree/, "and never moves a file out of a repository");
});

test("doctor --fix doctrine: a missing manifest offers restage; overridden image and remote valkey never gain offers", async () => {
	const dir = overlay({ packagesNoManifest: true });
	const env = {
		PI_PROVIDER: "anthropic",
		ANTHROPIC_API_KEY: "sk-x",
		PI_GLOBAL_PI_DIR: dir,
		PI_JOB_IMAGE: "acme/pi-job:2",
		VALKEY_URL: "redis://queue.internal:6379",
	};
	const checks = await collectChecks(env, collectSeams({ ...EGRESS_OK, "docker info": 0, "docker image": 1, "gh auth": "enoent" }, { nodeVersion: "22.19.0" }));
	assertFixActionDoctrine(checks);
	const manifest = checks.find((c) => /^Staged packages manifest readable/.test(c.label));
	assert.ok(manifest && !manifest.ok);
	assert.equal(manifest.fixAction.tier, "prompt");
	assert.equal(manifest.fixAction.describe, `pi-dispatch import-pi --with-packages --no-host-packages --to ${dir}`);
	const img = checks.find((c) => c.label === "Job image present (acme/pi-job:2)");
	assert.ok(img && !img.ok);
	assert.equal(img.fixAction, undefined, "an overridden PI_JOB_IMAGE is the operator's trust choice -- pulling the default could not honor it");
	const valkey = checks.find((c) => c.label === "Valkey reachable (redis://queue.internal:6379)");
	assert.ok(valkey && !valkey.ok);
	assert.equal(valkey.fixAction, undefined, "a remote VALKEY_URL cannot be fixed by starting a local container");

	// A trigger demanding packages nobody staged is a declaration problem, never auto-restaged: with an
	// empty pi-packages.json a restage would 'succeed' into the same silent package-less job.
	const c2 = await collectChecks(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_GLOBAL_PI_DIR: overlay({}), PI_TRIGGERS_FILE: triggersFile(true) },
		collectSeams(green, { nodeVersion: "22.19.0" }),
	);
	const req = c2.find((c) => /require staged packages/.test(c.label));
	assert.ok(req && !req.ok);
	assert.equal(req.fixAction, undefined, "which packages a flow needs is a semantic decision, never guessed");
});

// -- per-trigger flow resolution (issue #189): one line per flow, naming the resolving tier ----------

const gitKey = (folder, sub) => `git -c core.hooksPath=/dev/null -c core.fsmonitor=false --no-pager -C ${folder} ${sub}`;

test("doctor: a deployment with no triggers file adds no flow line at all", async () => {
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(overlay({})), overlayDeps(out));
	assert.equal(code, 0);
	assert.doesNotMatch(text(), /Trigger flow/, "no triggers means byte-identical output");
});

test("doctor: a cron flow found at HEAD of its folder is a ✓ naming the repo tier", async () => {
	const sha = "a".repeat(40);
	const plan = {
		...green,
		[gitKey("/srv/repo", "rev-parse")]: { code: 0, output: `${sha}\n` },
		[gitKey("/srv/repo", "ls-tree")]: { code: 0, output: `100644 blob ${"b".repeat(40)}\t.pi/skills/review/SKILL.md\u0000` },
	};
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(overlay({}), { PI_TRIGGERS_FILE: triggersFile() }), overlayDeps(out, { spawn: fakeSpawn(plan) }));
	assert.equal(code, 0);
	assert.match(text(), /✓ Trigger flow "review" resolves \(cron "nightly": repo \.pi\/skills at HEAD of \/srv\/repo\)/);
});

test("doctor: a symlink SKILL.md at HEAD is absent, not present -- the gate and the materialiser both refuse it", async () => {
	const sha = "a".repeat(40);
	const plan = {
		...green,
		[gitKey("/srv/repo", "rev-parse")]: { code: 0, output: `${sha}\n` },
		[gitKey("/srv/repo", "ls-tree")]: { code: 0, output: `120000 blob ${"b".repeat(40)}\t.pi/skills/review/SKILL.md\u0000` },
	};
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(overlay({}), { PI_TRIGGERS_FILE: triggersFile() }), overlayDeps(out, { spawn: fakeSpawn(plan) }));
	assert.equal(code, 0, "warn, never fail");
	assert.match(text(), /⚠ Trigger flow "review" resolves in NO tier visible here/);
	assert.match(text(), /checked: repo \.pi\/skills at HEAD/);
});

test("doctor: a flow resolving in NO visible tier is a ⚠ naming checked vs not-checkable, never a ✗", async () => {
	// The green plan has no git keys, so the repo probe degrades to unknown -- the existing fixture's
	// /srv/repo does not exist, and a probe that crashed or guessed here would be the bug.
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(overlay({}), { PI_TRIGGERS_FILE: triggersFile() }), overlayDeps(out));
	assert.equal(code, 0, "warn, never fail");
	assert.match(text(), /⚠ Trigger flow "review" resolves in NO tier visible here \(cron "nightly"\)/);
	assert.match(text(), /not checkable here: repo \(\/srv\/repo is not readable as a git repo here\)/);
	assert.match(text(), /the runner logs flow_not_loaded/, "the fix line names the in-container half");
});

test("doctor: a flow resolving only in run.skillsDir is a ✓ naming the injected tier", async () => {
	const skillsDir = tempDir("pi-skills-");
	mkdirSync(join(skillsDir, "review"), { recursive: true });
	writeFileSync(join(skillsDir, "review", "SKILL.md"), "---\ndescription: injected\n---\n");
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(overlay({}), { PI_TRIGGERS_FILE: triggersFile(undefined, undefined, { skillsDir }) }), overlayDeps(out));
	assert.equal(code, 0);
	assert.match(text(), /✓ Trigger flow "review" resolves \(cron "nightly": injected run\.skillsDir /);
});

test("doctor: a flow resolving only in the overlay skills/ is a ✓ naming the overlay tier", async () => {
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(overlay({ skills: ["review"] }), { PI_TRIGGERS_FILE: triggersFile() }), overlayDeps(out));
	assert.equal(code, 0);
	assert.match(text(), /✓ Trigger flow "review" resolves \(cron "nightly": the overlay skills\/\)/);
});

test("doctor: a flow resolving only in a staged package is a plain ✓ naming the package, not a ⚠", async () => {
	// Issue #189's acceptance names this case: staged-package-only resolution is legal steady state.
	const dir = overlay({ packages: [{ name: "wf-tools", version: "1.0.0", dir: "wf-tools", skills: ["review"] }] });
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(dir, { PI_TRIGGERS_FILE: triggersFile() }), overlayDeps(out));
	assert.equal(code, 0);
	assert.match(text(), /✓ Trigger flow "review" resolves \(cron "nightly": staged package wf-tools\)/);
});

test("doctor: run.packages: false withholds the staged tier, and the fix line says so", async () => {
	// The same package ships the skill; the trigger opted out, so the ⚠ is correct and must name the
	// withholding rather than pretend the tier was searched and found empty.
	const dir = overlay({ packages: [{ name: "wf-tools", version: "1.0.0", dir: "wf-tools", skills: ["review"] }] });
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(dir, { PI_TRIGGERS_FILE: triggersFile(false) }), overlayDeps(out));
	assert.equal(code, 0);
	assert.match(text(), /⚠ Trigger flow "review" resolves in NO tier visible here/);
	assert.match(text(), /staged packages \(withheld: run\.packages false\)/);
});

test("doctor: a manifest with glob patterns makes the package not-enumerable, reported rather than guessed", async () => {
	// Patterns can also DISABLE files, so enumerating around them risks a wrong ✓ -- the one direction
	// an advisory line must never err in.
	const dir = overlay({ packages: [{ name: "globby", version: "1.0.0", dir: "globby", pi: { skills: ["skills/*"] } }] });
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(dir, { PI_TRIGGERS_FILE: triggersFile() }), overlayDeps(out));
	assert.equal(code, 0);
	assert.match(text(), /⚠ Trigger flow "review" resolves in NO tier visible here/);
	assert.match(text(), /staged package\(s\) globby \(manifest patterns, not enumerable here\)/);
});

test("doctor: a flow that fails the skill charset is its own ⚠ -- no tier could ever hold it", async () => {
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(overlay({}), { PI_TRIGGERS_FILE: triggersFile(undefined, undefined, { flow: "Not A Skill" }) }), overlayDeps(out));
	assert.equal(code, 0, "warn, never fail");
	assert.match(text(), /⚠ Trigger flow "Not A Skill" fails the skill name charset \(cron "nightly"\)/);
	assert.doesNotMatch(text(), /resolves in NO tier/, "the charset finding replaces the tier probe, not stacks on it");
});

// --- REQ-EGRESS-ALLOWLIST (issue #202) ----------------------------------------------------------------

const egressPlan = (extra = {}) => ({ ...green, ...extra });

test("doctor: a deployment that turned the policy OFF says nothing about one", async () => {
	const { out, text } = capture();
	// PI_EGRESS=0 is now the opt-out rather than the default, and the byte-identical-output convention
	// still holds for it: a deployment that declined the policy gets no lines about it at all.
	const code = await runDoctor(ghEnv({ PI_EGRESS: "0" }), ghDeps(out, { ...green, "gh auth status": { code: 0, output: ghStatusOutput } }));
	assert.equal(code, 0);
	// Byte-identical output for a deployment that never armed the feature, the same convention the
	// env-setup checks follow one feature over.
	assert.doesNotMatch(text(), /[Ee]gress (policy|proxy|network)/);
});

test("doctor: an armed policy with a running proxy reports it, and proves the path without spending", async () => {
	const calls = [];
	const { out, text } = capture();
	const code = await runDoctor(
		ghEnv({ PI_EGRESS: "1" }),
		ghDeps(out, egressPlan({ "gh auth status": { code: 0, output: ghStatusOutput } }), calls),
	);
	assert.equal(code, 0);
	assert.match(text(), /✓ Egress proxy running \(pi-dispatch-egress-proxy\)/);
	// A correct policy: the provider reachable, an unlisted host refused. BOTH directions, because an
	// allowlist that has quietly become a pass-through reads exactly like one that works.
	assert.match(text(), /✓ Egress policy reaches the provider \(api\.anthropic\.com answered/);
	assert.match(text(), /✓ Egress policy denies an unlisted host/);
	// The probe uses the JOB IMAGE's own node, which is the point: it proves the operator's own image
	// honours NODE_USE_ENV_PROXY, the property a stale image would silently lack.
	const run = calls.find((c) => c.args[0] === "run");
	assert.ok(run, "the end-to-end probe runs a container");
	assert.equal(run.args[run.args.indexOf("--entrypoint") + 1], "node");
	assert.ok(run.args.includes("NODE_USE_ENV_PROXY=1"), "the probe sets the flag the runner depends on");
	assert.ok(run.args.includes("--pull=never"), "doctor never fetches an image to run a probe");
	// Credential-free by construction: nothing is passed, because a 401 from an unauthenticated request
	// proves the whole path.
	assert.ok(!run.args.some((a) => /sk-|ANTHROPIC_API_KEY=/.test(a)), "no credential in the probe argv");
	// And the throwaway network is cleaned up.
	assert.ok(calls.some((c) => c.args.slice(0, 2).join(" ") === "network rm"), "the doctor network is removed");
});

test("doctor: a proxy that is not on the host FAILS, because every job is refused pre-spend without it", async () => {
	const { out, text } = capture();
	const code = await runDoctor(
		ghEnv({ PI_EGRESS: "1" }),
		ghDeps(out, egressPlan({ "docker inspect --format={{.State.Running}}": 1, "gh auth status": { code: 0, output: ghStatusOutput } })),
	);
	// A ✓ would be a lie and a ⚠ would under-report a deployment that cannot run anything at all.
	assert.equal(code, 1, "an armed policy with no proxy is a hard failure");
	assert.match(text(), /✗ Egress proxy is not on this host \(pi-dispatch-egress-proxy\)/);
	assert.match(text(), /--profile egress up -d/);
});

test("doctor: a proxy that exists but is STOPPED says so, because the fix is a different one", async () => {
	const { out, text } = capture();
	await runDoctor(
		ghEnv({ PI_EGRESS: "1" }),
		ghDeps(out, egressPlan({ "docker inspect --format={{.State.Running}}": { code: 0, output: "false|none\n" }, "gh auth status": { code: 0, output: ghStatusOutput } })),
	);
	assert.match(text(), /✗ Egress proxy is stopped \(pi-dispatch-egress-proxy\)/);
});

test("doctor: a wedged proxy WARNS rather than fails -- health can flap, and the money gate ignores it", async () => {
	const { out, text } = capture();
	const code = await runDoctor(
		ghEnv({ PI_EGRESS: "1" }),
		ghDeps(out, egressPlan({ "docker inspect --format={{.State.Running}}": { code: 0, output: "true|unhealthy\n" }, "gh auth status": { code: 0, output: ghStatusOutput } })),
	);
	assert.equal(code, 0, "a flapping healthcheck must not make doctor red");
	assert.match(text(), /⚠ Egress proxy health: unhealthy/);
});

test("doctor: a policy that cannot reach the provider warns, and names the budget cost of leaving it", async () => {
	const { out, text } = capture();
	// The provider probe is blocked -- that is the outage. The unlisted one is blocked too, which is right.
	const code = await runDoctor(
		ghEnv({ PI_EGRESS: "1" }),
		ghDeps(out, egressPlan({ "gh auth status": { code: 0, output: ghStatusOutput }, "docker run --rm --name pi-dispatch-egress-probe-provider": 3 })),
	);
	assert.equal(code, 0, "warn tier: a custom base URL or a provider blip must not make this a certainty");
	assert.match(text(), /⚠ Egress policy does NOT reach the provider/);
	assert.match(text(), /spends two budget slots proving it/);
	assert.match(text(), /✓ Egress policy denies an unlisted host/);
});

test("doctor: an allowlist WIDER than the operator meant is reported -- the deny direction is checked too", async () => {
	const { out, text } = capture();
	// Both probes REACH. The provider one reaching is correct; the unlisted one reaching is the finding --
	// an allowlist that is wider than it reads (a bare domain where a subdomain was meant) permits hosts
	// nobody listed, and the deny direction is the half an allowlist can silently lose.
	const code = await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, egressPlan({ "gh auth status": { code: 0, output: ghStatusOutput }, "docker run --rm --name pi-dispatch-egress-probe-unlisted": 0 })));
	assert.equal(code, 0, "warn tier: doctor cannot know which hosts an operator's flows legitimately need");
	assert.match(text(), /✓ Egress policy reaches the provider/);
	assert.match(text(), /⚠ Egress policy ALLOWS an unlisted host that is not on your allowlist/);
	assert.match(text(), /a bare domain where you wanted a subdomain/);
});

test("doctor: no egress probing at all on top of a down daemon", async () => {
	const calls = [];
	const { out, text } = capture();
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, { "docker info": 1 }, calls));
	assert.match(text(), /⚠ Egress policy: not checked \(the Docker daemon did not answer\)/);
	assert.ok(!calls.some((c) => c.args[0] === "network"), "no network is created against a daemon that is not answering");
});

test("doctor: a triggers file the loader refuses FAILS, names the reason, and says the receiver will not start", async () => {
	// This used to be swallowed to zeroes, justified by "a malformed triggers file already fails LOUD at
	// worker boot". False for the deployment that needs doctor most: the worker reads the file only when
	// PI_TRIGGERS_FILE is set, so a receiver-only host got no loud failure anywhere -- while the zeroes
	// disarmed the WEBHOOK_SECRET, per-forge credential, per-image and flow-tier checks. doctor came back
	// GREENER than a healthy deployment, which is the one direction a preflight must never fail in.
	const path = join(tempDir("pi-triggers-bad-"), "triggers.json");
	writeFileSync(path, JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi:fix"] }, run: { kind: "gitlab", flow: "fix", replicas: 99 } }] }));
	const { out, text } = capture();
	const code = await runDoctor(imgEnv({ PI_TRIGGERS_FILE: path }), imgDeps(out, green));

	assert.equal(code, 1, "a file neither service can load is a failure, not a warning");
	assert.match(text(), /triggers file is refused at load/);
	assert.match(text(), /the receiver will refuse to start/, "the consequence, not just the symptom");
	assert.match(text(), /run\.replicas must be an integer between 2 and 3/, "the loader's own message travels");
	assert.ok(text().includes(path), "and the path to fix");
});

test("doctor: a duplicate key is reported through the SAME check, with no new one added", async () => {
	// Issue #313. `readTriggerFacts` forwards any piDispatchConfig throw from the loader as `parseError`,
	// and the fail-tier check prints it, so a new refusal in parseTriggers reaches doctor for nothing. The
	// point of asserting it is that "for nothing" is a claim about a seam, and a seam that stopped working
	// would leave the operator finding out from the first delivery instead.
	const path = join(tempDir("pi-triggers-dup-"), "triggers.json");
	writeFileSync(path, '{"triggers":[{"on":{"type":"label","any":["pi:fix"]},"run":{"kind":"github","flow":"safe","flow":"evil"}}]}');
	const { out, text } = capture();
	const code = await runDoctor(imgEnv({ PI_TRIGGERS_FILE: path }), imgDeps(out, green));

	assert.equal(code, 1);
	assert.match(text(), /triggers file is refused at load/, "the existing check, not a new one");
	assert.match(text(), /duplicate key "flow"/, "the loader's own message travels");
	assert.match(text(), /triggers\.0\.run\.flow/, "including where in the file to look");
});

test("doctor: a VALID triggers file says nothing about parsing -- the check is silent when it passes", async () => {
	const { out, text } = capture();
	await runDoctor(imgEnv({ PI_TRIGGERS_FILE: replicaTriggersFile(2) }), imgDeps(out, green));
	assert.doesNotMatch(text(), /refused at load/);
});

// --- run.secrets (REQ-TRIGGER-SECRETS, issue #225) ---

/**
 * A validating triggers file that binds secrets. It must be a file the SHARED parseTriggers really accepts,
 * or readTriggerFacts swallows the refusal to zeroes and every assertion below passes for the wrong reason
 * -- the trap the resume fixture above documents.
 */
function secretsTriggersFile({ profile, kind = "github", folder, names = ["STRIPE_KEY"] } = {}) {
	const path = join(tempDir("pi-triggers-secrets-"), "triggers.json");
	const secrets = Object.fromEntries(names.map((n) => [n, `op://ci/${n.toLowerCase()}/value`]));
	const run = { kind, flow: "deploy", secrets, ...(profile ? { secretsProfile: profile } : {}) };
	const on = kind === "local" ? { type: "cron", id: "nightly", pattern: "0 3 * * *" } : { type: "label", any: ["pi:deploy"] };
	if (kind === "local") Object.assign(run, { folder: folder ?? "/srv/site", task: "ship it" });
	writeFileSync(path, JSON.stringify({ triggers: [{ on, run }] }));
	return path;
}

const secretsSeams = () => collectSeams({ ...EGRESS_OK, "docker info": 0, "docker image": 0 }, { nodeVersion: "22.19.0", probeValkey: async () => true });

test("doctor: a trigger binding secrets with NO profile declared FAILS, and says the jobs refuse until fixed", async () => {
	// A hard fail rather than a warning, worded like the run.resume/PI_SESSIONS_DIR check: these jobs
	// refuse pre-spend on purpose, rather than running without their secrets and looking like they worked.
	const env = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: secretsTriggersFile() };
	const checks = await collectChecks(env, secretsSeams());
	const hit = checks.find((c) => /bind secrets/.test(c.label));
	assert.ok(hit, "the finding must exist at all");
	assert.equal(hit.ok, false);
	assert.match(hit.label, /not declared: default/, "it names the profile the worker will actually look up");
	assert.match(hit.fix, /refuse pre-spend/);
});

test("doctor: with the profile declared, the check passes and the table is printed", async () => {
	// The table exists so an operator sees what is wired without reading .env.
	const env = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: secretsTriggersFile({ profile: "prod" }), PI_SECRET_PROFILES: "prod:/opt/pi/resolve.sh" };
	const checks = await collectChecks(env, secretsSeams());
	const hit = checks.find((c) => /bind secrets/.test(c.label));
	assert.equal(hit.ok, true);
	assert.ok(checks.some((c) => /Secret resolver profiles declared: prod -> \/opt\/pi\/resolve\.sh/.test(c.label)));
});

test("doctor: a trigger binding a variable pi reads for the provider FAILS at setup, not on a live job", { skip: skipNoPi }, async () => {
	// Issue #309. The worker refuses such a trigger pre-spend, and before this the operator's first
	// notice was that public refusal on a real delivery. The question is answerable here only BECAUSE the
	// gate stopped depending on host state: the presence-filtered version's answer changed with whichever
	// machine doctor happened to run on.
	//
	// The fixture uses HF_TOKEN rather than GEMINI_API_KEY since issue #314, and the reason is worth
	// keeping: GEMINI_API_KEY is now in PROVIDER_STEERING_VARS, so a file binding it refuses at LOAD and
	// never reaches this check at all. 27 of the 31 provider key variables are NOT in that set -- it is
	// derived from what pi and its SDKs READ, while the key table is data -- so this check still has work
	// to do, and a fixture that is double-covered would have hidden that either way.
	const env = {
		PI_PROVIDER: "huggingface",
		HF_TOKEN: "hf-x",
		PI_TRIGGERS_FILE: secretsTriggersFile({ profile: "prod", names: ["HF_TOKEN"] }),
		PI_SECRET_PROFILES: "prod:/opt/pi/resolve.sh",
	};
	const checks = await collectChecks(env, secretsSeams());
	const hit = checks.find((c) => /variable pi reads for/.test(c.label));
	assert.ok(hit, "the finding must exist at all");
	assert.equal(hit.ok, false);
	assert.match(hit.label, /HF_TOKEN/, "it names the variable the operator has to rename");
	assert.match(hit.fix, /secret-name-reserved/, "and the refusal they would otherwise have met");
});

test("doctor: the provider clash check follows the PROVIDER, so another provider's variable passes", { skip: skipNoPi }, async () => {
	// The same bound the gate keeps: an anthropic deployment may bind another provider's key for a flow
	// that talks to that provider itself. A check that refused it would be doctor inventing a namespace the
	// project does not own, and would fail a deployment the worker runs happily.
	//
	// MOONSHOT_API_KEY rather than GEMINI_API_KEY since issue #314: the latter is now reserved at load for
	// every deployment, so it could no longer demonstrate a binding that PASSES.
	const env = {
		PI_PROVIDER: "anthropic",
		ANTHROPIC_API_KEY: "sk-x",
		PI_TRIGGERS_FILE: secretsTriggersFile({ profile: "prod", names: ["MOONSHOT_API_KEY"] }),
		PI_SECRET_PROFILES: "prod:/opt/pi/resolve.sh",
	};
	const checks = await collectChecks(env, secretsSeams());
	const hit = checks.find((c) => /variable pi reads for/.test(c.label));
	assert.equal(hit.ok, true);
	assert.match(hit.label, /No trigger binds/);
});

test("doctor: the OAuth variable clashes too, which is the half no host env would have revealed", { skip: skipNoPi }, async () => {
	// ANTHROPIC_OAUTH_TOKEN is set on few hosts and the worker never writes it, so a host-state check could
	// not have found this one at all. pi reads it BEFORE the API key, so a trigger binding it wins.
	const env = {
		PI_PROVIDER: "anthropic",
		ANTHROPIC_API_KEY: "sk-x",
		PI_TRIGGERS_FILE: secretsTriggersFile({ profile: "prod", names: ["ANTHROPIC_OAUTH_TOKEN"] }),
		PI_SECRET_PROFILES: "prod:/opt/pi/resolve.sh",
	};
	const checks = await collectChecks(env, secretsSeams());
	const hit = checks.find((c) => /variable pi reads for/.test(c.label));
	assert.equal(hit.ok, false);
	assert.match(hit.label, /ANTHROPIC_OAUTH_TOKEN/);
});

test("doctor: a garbled PI_SECRET_PROFILES is REPORTED, never thrown", async () => {
	// The operator running doctor is very likely running it because the worker refused to boot on that
	// exact line. A stack trace instead of a check is the least useful possible answer.
	const env = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: secretsTriggersFile(), PI_SECRET_PROFILES: "prod" };
	const checks = await collectChecks(env, secretsSeams());
	const hit = checks.find((c) => /PI_SECRET_PROFILES does not parse/.test(c.label));
	assert.ok(hit && hit.ok === false);
});

test("doctor: the panel-authoring bound reads as SAFE when closed and as a disclosure when open", async () => {
	const base = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: secretsTriggersFile({ profile: "prod" }), PI_SECRET_PROFILES: "prod:/opt/pi/resolve.sh" };
	const closed = await collectChecks(base, secretsSeams());
	const shut = closed.find((c) => /PI_SECRET_RESOLVER_ROOTS is unset/.test(c.label));
	assert.ok(shut && shut.ok === true && !shut.warn, "the fail-closed default is a fact, not a defect");

	const open = await collectChecks({ ...base, PI_SECRET_RESOLVER_ROOTS: "/opt/pi" }, secretsSeams());
	const wide = open.find((c) => /admits panel-declared resolvers/.test(c.label));
	assert.ok(wide && wide.warn === true, "opening it is a disclosure the operator should see");
	assert.match(wide.fix, /run code as the worker/);
});

test("doctor: a LOCAL trigger binding secrets warns that /workspace is the operator's real folder", async () => {
	// The hazard extending this to cron created: a local job edits the folder in place with no clone, so a
	// credential the agent persists lands in a real repository and survives in a retained sandbox.
	const env = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: secretsTriggersFile({ kind: "local", folder: "/srv/site", profile: "prod" }), PI_SECRET_PROFILES: "prod:/opt/pi/resolve.sh" };
	const checks = await collectChecks(env, secretsSeams());
	const hit = checks.find((c) => /run IN the operator's own folder/.test(c.label));
	assert.ok(hit, "the warning must exist");
	assert.equal(hit.warn, true, "a warning, not a failure: a nightly deploy binding a secret is the use case");
	assert.match(hit.label, /\/srv\/site/);
	assert.match(hit.fix, /Nothing scans for that/);
});

test("doctor: a deployment that binds no secrets is told nothing about them at all", async () => {
	// The run.resume block's rule, inherited: a deployment that does not use the feature should not be told
	// about a variable it has no reason to set.
	const checks = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" }, secretsSeams());
	assert.equal(checks.some((c) => /secret/i.test(c.label ?? "")), false);
});

// --- one-shot close triggers (issue #231, DES-ONE-SHOT-DISARM-IN-THE-FILE) ---

/**
 * A validating file holding one ARMED one-shot, one SPENT one, and a label neighbour. It must really
 * parse (the resume/secrets fixtures' trap): readTriggerFacts swallows a refusing file to zeroes, and
 * every count below would then pass for the wrong reason. Written into `dir` when given, so the
 * PI_TRIGGERS_FILE-unset case can plant it at the injected cwd's ./triggers.json.
 */
function onceTriggersFile(dir = tempDir("pi-triggers-once-"), { armed = true, spent = true } = {}) {
	const triggers = [];
	if (armed) triggers.push({ on: { type: "issue", action: ["closed"], number: 40, once: true }, run: { kind: "github", flow: "deploy" } });
	if (spent) triggers.push({ on: { type: "issue", action: ["closed"], number: 41, once: true, disarmed: { at: "2026-08-01T00:00:00.000Z", jobId: "gh-old" } }, run: { kind: "github", flow: "deploy" } });
	triggers.push({ on: { type: "label", any: ["pi:fix"] }, run: { kind: "github", flow: "fix" } });
	const path = join(dir, "triggers.json");
	writeFileSync(path, JSON.stringify({ triggers }));
	return path;
}
const onceSeams = (extra = {}) => collectSeams({ ...EGRESS_OK, "docker info": 0, "docker image": 0 }, { nodeVersion: "22.19.0", probeValkey: async () => true, ...extra });

test("doctor: the armed one-shot line counts from the raw file and WARNS only when PI_TRIGGERS_FILE is unset", async () => {
	// Unset PI_TRIGGERS_FILE: doctor resolves ./triggers.json against the injected cwd, and the armed
	// line warns about the split-file hazard -- a worker service whose WorkingDirectory differs from
	// the receiver's disarms a file nobody matches against, and no mechanism can detect that.
	const dir = tempDir("pi-once-doctor-");
	onceTriggersFile(dir);
	const unset = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" }, onceSeams({ cwd: dir }));
	const armedUnset = unset.find((c) => /one-shot trigger\(s\) armed/.test(c.label));
	assert.ok(armedUnset, "the armed advisory must exist");
	assert.match(armedUnset.label, /^1 one-shot/, "counted 1 from the RAW entries: the spent sibling does not inflate the armed count");
	assert.equal(armedUnset.ok, true, "advisory, never a failure: doctor never touches triggers");
	assert.equal(armedUnset.warn, true, "unset PI_TRIGGERS_FILE is the split-file hazard, so the line warns");
	assert.match(armedUnset.label, /resolved against the worker service's working directory/);
	assert.match(armedUnset.fix, /absolute path in both services/);

	// Set: the same file by explicit path, and the warning goes away -- worker and receiver now name
	// the same file from anywhere, so the label names the variable instead of the hazard.
	const set = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: join(dir, "triggers.json") }, onceSeams());
	const armedSet = set.find((c) => /one-shot trigger\(s\) armed/.test(c.label));
	assert.ok(armedSet, "the armed advisory still appears -- only its warn flag changes");
	assert.equal(armedSet.warn, false, "with the variable set there is no split-file hazard to warn about");
	assert.match(armedSet.label, /in PI_TRIGGERS_FILE after the run record exists/);
});

test("doctor: the spent one-shot line counts 1, says 'spent', and states the deliberate degradation", async () => {
	// The spent count exists only because readTriggerFacts reads the RAW file: the shared parser
	// collapses a disarmed entry to a sentinel that matches nothing, which also erases it from every
	// parsed count -- and doctor is the surface that must still SEE it to answer "why did nothing fire".
	const checks = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: onceTriggersFile() }, onceSeams());
	const spentLine = checks.find((c) => /one-shot trigger\(s\) already spent/.test(c.label));
	assert.ok(spentLine, "the spent advisory must exist");
	assert.match(spentLine.label, /^1 one-shot/, "counted 1 from the raw file -- the armed sibling does not inflate the spent count");
	assert.equal(spentLine.ok, true, "a spent one-shot is history, not a defect");
	assert.equal(spentLine.warn, false, "and it does not warn -- the entry did exactly what it was armed to do");
	assert.match(spentLine.label, /spent \(on\.disarmed\)/, "the 'spent' wording, with the key an operator can grep for");
	assert.match(spentLine.label, /match nothing and count toward no credential or flow check/, "the degradation is stated, not implied");
	assert.match(spentLine.label, /delete on\.disarmed to re-arm/, "and the re-arm path is named");
});

test("doctor: zero once triggers means NEITHER one-shot line -- non-adopters hear nothing", async () => {
	const path = onceTriggersFile(undefined, { armed: false, spent: false });
	const checks = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: path }, onceSeams());
	assert.equal(checks.some((c) => /one-shot/.test(c.label ?? "")), false, "no armed line and no spent line: output stays byte-identical for a file that never armed one");
});

// ── scoped limits (issue #242): the trap check, the boot-blocker line, the membership advisory ──────────

function scopedScaffoldCwd(limits) {
	const dir = tempDir("pi-sl-scaffold-");
	writeFileSync(join(dir, "scoped-limits.json"), JSON.stringify({ version: 1, limits: limits ?? [] }));
	return dir;
}

test("doctor: a scaffolded scoped-limits.json with PI_SCOPED_LIMITS_FILE unset warns and names the mutex parenthetical", async () => {
	const cwd = scopedScaffoldCwd();
	const { out, text } = capture();
	const code = await runDoctor(imgEnv(), scaffoldDeps(out, cwd));
	assert.ok(text().includes(`⚠ ${join(cwd, "scoped-limits.json")} exists but PI_SCOPED_LIMITS_FILE is unset`), "the warn names the file it found");
	assert.ok(text().includes(`set PI_SCOPED_LIMITS_FILE=${join(cwd, "scoped-limits.json")}`), "the fix names the variable AND the absolute path");
	assert.match(text(), /the built-in one-job-per-folder mutex stays on/, "the check must not imply local folders run ungated");
	assert.equal(code, 0, "warn, never fail");
	const checks = await collectChecks(imgEnv(), collectSeams(green, { cwd, nodeVersion: "22.19.0", probeValkey: async () => true }));
	const trap = checks.find((x) => /PI_SCOPED_LIMITS_FILE is unset/.test(x.label));
	assert.equal(trap.fixAction, undefined, "never-tier: doctor cannot guess which path was meant");
});

test("doctor: with PI_SCOPED_LIMITS_FILE set to the file, no trap line; an EMPTY value is a REFUSED BOOT (#365)", async () => {
	const cwd = scopedScaffoldCwd();
	const wired = capture();
	await runDoctor(imgEnv({ PI_SCOPED_LIMITS_FILE: join(cwd, "scoped-limits.json") }), scaffoldDeps(wired.out, cwd));
	assert.doesNotMatch(wired.text(), /PI_SCOPED_LIMITS_FILE is unset/, "a wired deployment gets no trap line");
	// "Blank mirrors the worker's own load gate" was the claim and it is false, for the same reason its
	// pause-windows twin was: `loadScopedLimits(config)` runs unconditionally at boot and throws on an empty
	// path, so blank is a refused boot rather than a feature left off.
	const empty = capture();
	await runDoctor(imgEnv({ PI_SCOPED_LIMITS_FILE: "   " }), scaffoldDeps(empty.out, cwd));
	assert.match(empty.text(), /PI_SCOPED_LIMITS_FILE is set to an EMPTY value in this shell, which is not the same as unset: the worker keeps it, tries to load a scoped-limits file at that empty path, and REFUSES TO START/);
	assert.doesNotMatch(empty.text(), /PI_SCOPED_LIMITS_FILE is unset -- the worker ignores it/);
});

test("doctor: a configured scoped-limits file that will not load is a FAILURE naming the boot refusal, never-tier", async () => {
	const dir = tempDir("pi-sl-bad-");
	const path = join(dir, "scoped-limits.json");
	writeFileSync(path, JSON.stringify({ version: 2, limits: [] }));
	const checks = await collectChecks(imgEnv({ PI_SCOPED_LIMITS_FILE: path }), collectSeams(green, { cwd: dir, nodeVersion: "22.19.0", probeValkey: async () => true }));
	const c = checks.find((x) => /scoped-limits file does not load/.test(x.label));
	assert.ok(c, "the check is present");
	assert.equal(c.ok, false);
	assert.notEqual(c.warn, true, "a boot blocker is a failure, not an advisory");
	assert.match(c.label, /worker will refuse to start/);
	assert.match(c.label, /newer pi-dispatch/);
	assert.equal(c.fixAction, undefined, "never-tier: doctor never rewrites limits content");
	// A configured-but-MISSING file is the same class: the worker's loader refuses boot on it.
	const gone = await collectChecks(imgEnv({ PI_SCOPED_LIMITS_FILE: join(dir, "absent.json") }), collectSeams(green, { cwd: dir, nodeVersion: "22.19.0", probeValkey: async () => true }));
	assert.ok(gone.find((x) => /scoped-limits file does not load/.test(x.label) && /does not exist/.test(x.label)));
});

test("doctor: the dead-scope advisory flags folder-only shapes not in the canonicalized facts; repo shapes stay silent", async () => {
	const dir = tempDir("pi-sl-adv-");
	const folder = join(dir, "site");
	writeFileSync(
		join(dir, "triggers.json"),
		JSON.stringify({ triggers: [
			{ on: { type: "cron", id: "t1", pattern: "0 3 * * *" }, run: { kind: "local", folder: `${folder}/`, flow: "tidy", task: "t" } },
		] }),
	);
	const limitsPath = join(dir, "scoped-limits.json");
	// Row 1 matches the trigger's folder ACROSS spellings; rows 2-4 are folder-only shapes that match
	// nothing (dead relative, slashless, windows-shaped on POSIX); row 5 is a repo shape -- SILENT, not
	// caveated: a webhook job's repo comes from the delivery, which triggers.json cannot enumerate, so a
	// line on every legitimate repo cap would be standing noise.
	writeFileSync(limitsPath, JSON.stringify({ version: 1, limits: [
		{ scope: folder, day: 3 },
		{ scope: "./relative-nowhere", day: 1 },
		{ scope: "sitealone", day: 1 },
		{ scope: "C:\\srv\\site", day: 1 },
		{ scope: "acme/web", day: 9 },
	] }));
	const env = imgEnv({ PI_TRIGGERS_FILE: join(dir, "triggers.json"), PI_SCOPED_LIMITS_FILE: limitsPath });
	const checks = await collectChecks(env, collectSeams(green, { cwd: dir, nodeVersion: "22.19.0", probeValkey: async () => true }));
	const c = checks.find((x) => /scoped limit\(s\) name a folder no trigger runs in/.test(x.label));
	assert.ok(c, "the advisory is present");
	assert.equal(c.ok, true, "an advisory, never a red X (the replica advisory's tier)");
	assert.equal(c.warn, true);
	assert.equal(c.fixAction, undefined, "never-tier");
	assert.ok(!c.label.includes(folder), "the folder row matched across spellings -- not flagged");
	assert.match(c.label, /\.\/relative-nowhere/, "a dead relative row is folder-only and unmatched -- flagged");
	assert.match(c.label, /sitealone/, "a slashless scope can never be a repo -- flagged");
	assert.match(c.label, /C:\\srv/, "a foreign-platform row is inert here -- flagged");
	assert.ok(!c.label.includes("acme/web"), "a repo shape is never flagged -- doctor cannot enumerate webhook repos");
	assert.match(c.label, /resolved ABSOLUTE path/, "the actionable content lives in the LABEL -- ok:true never prints fix");
	// All judgeable scopes referenced: silent (the repo row alone must not keep the line alive).
	writeFileSync(limitsPath, JSON.stringify({ version: 1, limits: [{ scope: folder, day: 3 }, { scope: "acme/web", day: 9 }] }));
	const quiet = await collectChecks(env, collectSeams(green, { cwd: dir, nodeVersion: "22.19.0", probeValkey: async () => true }));
	assert.ok(!quiet.find((x) => /name a folder no trigger runs in/.test(x.label)), "nothing dead: no line");
});

test("doctor: the dead-scope advisory stays SILENT when the triggers facts are unreadable -- zeroed counts make no claims", async () => {
	const dir = tempDir("pi-sl-noclaim-");
	const limitsPath = join(dir, "scoped-limits.json");
	writeFileSync(limitsPath, JSON.stringify({ version: 1, limits: [{ scope: "/srv/never", day: 1 }] }));
	// Unparseable triggers file: doctor already says the file does not parse; asserting "no trigger
	// references this scope" on top would be a positive claim over counts it just said it cannot read.
	writeFileSync(join(dir, "triggers.json"), "{broken");
	const broken = await collectChecks(imgEnv({ PI_TRIGGERS_FILE: join(dir, "triggers.json"), PI_SCOPED_LIMITS_FILE: limitsPath }), collectSeams(green, { cwd: dir, nodeVersion: "22.19.0", probeValkey: async () => true }));
	assert.ok(!broken.find((x) => /name a folder no trigger runs in/.test(x.label)), "unparseable triggers: no advisory");
	// Absent triggers file entirely: same rule.
	const bare = tempDir("pi-sl-bare-");
	const limits2 = join(bare, "scoped-limits.json");
	writeFileSync(limits2, JSON.stringify({ version: 1, limits: [{ scope: "/srv/never", day: 1 }] }));
	const absent = await collectChecks(imgEnv({ PI_SCOPED_LIMITS_FILE: limits2 }), collectSeams(green, { cwd: bare, nodeVersion: "22.19.0", probeValkey: async () => true }));
	assert.ok(!absent.find((x) => /name a folder no trigger runs in/.test(x.label)), "no triggers file: no advisory");
});

// --- run.waitFor (issue #230) --------------------------------------------------------------------------

function waitTriggersFile({ profiles = ["jira"], after } = {}) {
	const path = join(tempDir("pi-triggers-wait-"), "triggers.json");
	const waitFor = [...(after ? [{ after }] : []), ...profiles.map((profile) => ({ profile }))];
	writeFileSync(path, JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi:deploy"] }, run: { kind: "github", flow: "deploy", waitFor } }] }));
	return path;
}

test("doctor: a waiting trigger whose profile is NOT declared FAILS, naming the profile", async () => {
	// A hard fail, `secretProfiles`' twin and for its reason: these jobs refuse pre-spend until it is set,
	// deliberately, rather than starting without ever asking the question they were written to ask.
	const env = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: waitTriggersFile() };
	const checks = await collectChecks(env, secretsSeams());
	const hit = checks.find((c) => /hold their jobs/.test(c.label));
	assert.ok(hit, "the finding must exist at all");
	assert.equal(hit.ok, false);
	assert.match(hit.label, /not declared: jira/);
	assert.match(hit.fix, /refuse pre-spend/);
	assert.match(hit.fix, /0 go, 3 not yet, 2 never, 1 could not tell/, "and it states the protocol, where an operator writing their first check reads");
});

test("doctor: a declared profile is STAT'd -- a path that cannot run is a check that can never answer", async () => {
	const dir = tempDir("pi-wait-checks-");
	const good = join(dir, "wait.sh");
	writeFileSync(good, "#!/bin/sh\nexit 0\n");
	chmodSync(good, 0o755);
	const notExec = join(dir, "plain.sh");
	writeFileSync(notExec, "x");
	chmodSync(notExec, 0o644);

	const env = {
		PI_PROVIDER: "anthropic",
		ANTHROPIC_API_KEY: "sk-x",
		PI_TRIGGERS_FILE: waitTriggersFile({ profiles: ["ok", "dull", "gone", "dir"] }),
		PI_WAIT_PROFILES: `ok:${good},dull:${notExec},gone:${join(dir, "missing.sh")},dir:${dir}`,
	};
	const checks = await collectChecks(env, secretsSeams());
	const byName = (n) => checks.find((c) => c.label.startsWith(`Wait profile ${n} `));
	assert.equal(byName("ok").ok, true);
	assert.equal(byName("dull").ok, false);
	assert.match(byName("dull").label, /not executable/);
	assert.equal(byName("gone").ok, false);
	assert.match(byName("gone").label, /ENOENT/);
	assert.equal(byName("dir").ok, false);
	assert.match(byName("dir").label, /not a regular file/);
	assert.match(byName("gone").fix, /wait-profile-unknown/, "and it names the reason the job will actually record");
});

test("doctor: a garbled PI_WAIT_PROFILES is REPORTED, never thrown", async () => {
	// The operator running doctor is very likely running it because the worker refused to boot on that line.
	const env = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: waitTriggersFile(), PI_WAIT_PROFILES: "jira" };
	const checks = await collectChecks(env, secretsSeams());
	const hit = checks.find((c) => /PI_WAIT_PROFILES does not parse/.test(c.label));
	assert.ok(hit && hit.ok === false);
});

test("doctor: the version floor is stated ONCE as a fact, and only when something waits", async () => {
	// doctor runs on the worker host and cannot see the receiver's installed version, so an unconditional
	// warning would be the always-on amber the panel's own design rejects -- and the worker's skew check
	// already refuses a job that arrives without conditions it should have had.
	const waiting = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: waitTriggersFile() }, secretsSeams());
	const floor = waiting.filter((c) => /receiver >= 1\.4\.0/.test(c.label));
	assert.equal(floor.length, 1, "once, not once per profile");
	assert.equal(floor[0].ok, true, "a fact, not a defect");
	assert.match(floor[0].label, /wait-skew/, "and it names what the worker does instead of running unheld");

	const quiet = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: secretsTriggersFile({ profile: "prod" }), PI_SECRET_PROFILES: "prod:/opt/pi/r.sh" }, secretsSeams());
	assert.equal(quiet.some((c) => /receiver >= 1\.4\.0/.test(c.label)), false, "a deployment that holds no jobs hears nothing about it");
	assert.equal(quiet.some((c) => /hold their jobs/.test(c.label)), false);
});

test("doctor: an `after`-only wait needs no profile table at all", async () => {
	// The free tier declares nothing, so a deployment using only instants must not be told to declare a
	// profile it has no use for.
	const env = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: waitTriggersFile({ profiles: [], after: "2026-09-01T09:00:00Z" }) };
	const checks = await collectChecks(env, secretsSeams());
	const hit = checks.find((c) => /hold their jobs/.test(c.label));
	assert.equal(hit.ok, true, "nothing named, nothing missing");
});

test("doctor: a profile literally NAMED `error` does not forge a parse failure", async () => {
	// `error` passes the profile charset, so a flat `{ ...profiles, error }` return let one declared profile's
	// PATH read as an error message: doctor reported the variable as unparseable, quoted the path as the
	// reason, and skipped every check below it on a deployment that was entirely fine. Both wrappers return an
	// envelope now, and both are pinned, because the second one was the first one's copy.
	const wait = await collectChecks(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: waitTriggersFile({ profiles: ["error"] }), PI_WAIT_PROFILES: "error:/opt/pi/wait.sh" },
		secretsSeams(),
	);
	assert.equal(wait.some((c) => /PI_WAIT_PROFILES does not parse/.test(c.label)), false);
	assert.equal(wait.find((c) => /hold their jobs/.test(c.label)).ok, true, "the profile IS declared");
	assert.ok(wait.some((c) => /^Wait profile error -> \/opt\/pi\/wait\.sh/.test(c.label)), "and it is stat'd like any other");

	const secret = await collectChecks(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: secretsTriggersFile({ profile: "error" }), PI_SECRET_PROFILES: "error:/opt/pi/resolve.sh" },
		secretsSeams(),
	);
	assert.equal(secret.some((c) => /PI_SECRET_PROFILES does not parse/.test(c.label)), false);
	assert.equal(secret.find((c) => /bind secrets/.test(c.label)).ok, true);
	assert.ok(secret.some((c) => /Secret resolver profiles declared: error -> \/opt\/pi\/resolve\.sh/.test(c.label)));
});

test("doctor: a garbled PI_WAIT_PROFILES is reported even when NOTHING waits", async () => {
	// `loadConfig` parses this variable on every boot, waiting triggers or not, so a garbled value is a worker
	// that will not START. Gating the parse behind `waiting > 0` hid it from exactly the operator the check
	// exists for, and the ordinary sequence produces that state: declare the variable, restart, THEN write the
	// trigger. Doctor is run in the middle.
	const env = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: secretsTriggersFile({ profile: "prod" }), PI_SECRET_PROFILES: "prod:/opt/pi/r.sh", PI_WAIT_PROFILES: "totally-garbled" };
	const checks = await collectChecks(env, secretsSeams());
	const hit = checks.find((c) => /PI_WAIT_PROFILES does not parse/.test(c.label));
	assert.ok(hit && hit.ok === false, "the finding must exist on a deployment that holds nothing");
	assert.match(hit.fix, /refuses to BOOT/, "and it says which failure this is: a boot refusal, not a delivery that refuses");
	// The trigger-driven half stays silent, because there is still no trigger.
	assert.equal(checks.some((c) => /hold their jobs/.test(c.label)), false);
	assert.equal(checks.some((c) => /receiver >= 1\.4\.0/.test(c.label)), false);
});

test("doctor: an `after` beyond PI_WAIT_AFTER_MAX_MS FAILS -- every delivery refuses at first pickup", async () => {
	const far = new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString();
	const near = new Date(Date.now() + 2 * 24 * 3600 * 1000).toISOString();
	const beyond = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: waitTriggersFile({ profiles: [], after: far }) }, secretsSeams());
	const hit = beyond.find((c) => /beyond PI_WAIT_AFTER_MAX_MS/.test(c.label));
	assert.ok(hit && hit.ok === false);
	assert.match(hit.label, new RegExp(far.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "it names the instant to go and edit");
	assert.match(hit.fix, /wait-after-beyond-max/, "and the reason the record will actually carry");

	// Inside the ceiling: silent. And the ceiling is the env var, not the 24h maximum wait -- a 2-day `after`
	// is the field's most obvious use and must not be reported as a defect.
	const ok = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: waitTriggersFile({ profiles: [], after: near }) }, secretsSeams());
	assert.equal(ok.some((c) => /beyond PI_WAIT_AFTER_MAX_MS/.test(c.label)), false);
	// And it reads the operator's own ceiling, not just the default.
	const lowered = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: waitTriggersFile({ profiles: [], after: near }), PI_WAIT_AFTER_MAX_MS: String(3600 * 1000) }, secretsSeams());
	assert.equal(lowered.find((c) => /beyond PI_WAIT_AFTER_MAX_MS/.test(c.label))?.ok, false);
});

test("doctor: a broken profile NO trigger names only warns -- nothing refuses today", async () => {
	// The missing-profile check is trigger-driven; the stat loop is declaration-driven. Failing the whole
	// command on a retired entry no job looks up is the same over-reporting the `waiting > 0` gate prevents.
	const dir = tempDir("pi-wait-unused-");
	const good = join(dir, "wait.sh");
	writeFileSync(good, "#!/bin/sh\nexit 0\n");
	chmodSync(good, 0o755);
	const env = {
		PI_PROVIDER: "anthropic",
		ANTHROPIC_API_KEY: "sk-x",
		PI_TRIGGERS_FILE: waitTriggersFile({ profiles: ["jira"] }),
		PI_WAIT_PROFILES: `jira:${good},retired:${join(dir, "gone.sh")}`,
	};
	const checks = await collectChecks(env, secretsSeams());
	const retired = checks.find((c) => c.label.startsWith("Wait profile retired "));
	assert.equal(retired.ok, true, "it does not fail the command");
	assert.equal(retired.warn, true, "but it is not silent either");
	assert.match(retired.label, /no trigger names it/);
	assert.equal(checks.find((c) => c.label.startsWith("Wait profile jira ")).ok, true);
	assert.ok(checks.find((c) => c.label.startsWith("Wait profile jira ")).label.includes("named by no trigger") === false);
});

test("doctor's stat probe follows SYMLINKS, exactly as the gate's does", async () => {
	// The one property this block rests on is that `statPath` asks the question `makeWaitChecker` will ask at
	// spawn. `realpathSync` is the half with no other pin: drop it and every test above stays green while a
	// release-directory layout (`current -> releases/<date>/wait.sh`), which the gate runs happily, reads here
	// as a check that can never answer. Asserted against the REAL checker, not against a restatement of it.
	const dir = tempDir("pi-wait-symlink-");
	const real = join(dir, "wait-2026-08-30.sh");
	writeFileSync(real, "#!/bin/sh\nexit 0\n");
	chmodSync(real, 0o755);
	const link = join(dir, "current.sh");
	symlinkSync(real, link);

	const checks = await collectChecks(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: waitTriggersFile({ profiles: ["jira"] }), PI_WAIT_PROFILES: `jira:${link}` },
		secretsSeams(),
	);
	assert.equal(checks.find((c) => c.label.startsWith("Wait profile jira ")).ok, true, "doctor follows the link");

	// And the gate agrees: it spawns rather than answering profileUnknown.
	let spawned = 0;
	const check = makeWaitChecker({
		profiles: { jira: link },
		spawnFn: () => {
			spawned += 1;
			const handlers = new Map();
			const child = { stdout: { on: (e, f) => handlers.set(`o${e}`, f) }, stderr: { on: (e, f) => handlers.set(`e${e}`, f) }, on: (e, f) => handlers.set(e, f), kill: () => {} };
			queueMicrotask(() => handlers.get("exit")?.(0, null));
			return child;
		},
		log: () => {},
	});
	assert.deepEqual(await check("jira", "acme/web#7"), { verdict: "go", fault: false });
	assert.equal(spawned, 1, "the gate resolved the same link doctor resolved");
});

// --- the fleet (issue #57) ------------------------------------------------------------------------------

const fleetSeams = (hosts, extra = {}) =>
	collectSeams({ ...EGRESS_OK, "docker info": 0, "docker image": 0 }, { nodeVersion: "22.19.0", readHosts: async () => ({ hosts }), ...extra });

test("with no peers, doctor says nothing about a fleet at all", async () => {
	const checks = await collectChecks({ VALKEY_URL: "redis://x" }, fleetSeams([]));
	assert.equal(checks.filter((c) => /Fleet|host routing|timezone|digest differs/i.test(c.label)).length, 0, "a single-host deployment's output is byte-identical");
});

test("with peers, doctor names the fleet and warns that routing is OFF without a declared name", async () => {
	// The one thing that is silently WRONG rather than merely undeclared: without a name this host
	// enqueues its own folder work to the SHARED queue, where a peer with no such folder can pop it.
	const checks = await collectChecks({ VALKEY_URL: "redis://x" }, fleetSeams([{ name: "mini2", tz: Intl.DateTimeFormat().resolvedOptions().timeZone }]));
	assert.ok(checks.some((c) => /^Fleet: 2 workers/.test(c.label)));
	const off = checks.find((c) => /host routing is OFF/.test(c.label));
	assert.ok(off, "the warning is present");
	assert.equal(off.warn, true, "a WARN: this command runs on one machine and must not refuse a deployment");
	assert.ok(off.fix.includes("PI_WORKER_NAME"));
});

test("a declared name silences the routing warning but keeps the fleet line", async () => {
	const checks = await collectChecks({ VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1" }, fleetSeams([{ name: "mini2", tz: Intl.DateTimeFormat().resolvedOptions().timeZone }]));
	assert.ok(!checks.some((c) => /host routing is OFF/.test(c.label)));
	assert.ok(checks.some((c) => /^Fleet: 2 workers \(mini1, mini2\)/.test(c.label)), "and it names both hosts, sorted");
});

test("a timezone disagreement is explained, because a cron pattern carries none", async () => {
	const here = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const other = here === "UTC" ? "America/New_York" : "UTC";
	const checks = await collectChecks({ VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1" }, fleetSeams([{ name: "mini2", tz: other }]));
	const c = checks.find((c) => /disagree about the timezone/.test(c.label));
	assert.ok(c, "the check is present");
	assert.equal(c.warn, true);
	assert.ok(c.label.includes(other) && c.label.includes(here), "and names both zones, so the refusal an operator already met is explained");
});

test("a stale peer row is reported, because it is either a dead worker or a skewed clock", async () => {
	const checks = await collectChecks(
		{ VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1" },
		fleetSeams([{ name: "mini2", tz: Intl.DateTimeFormat().resolvedOptions().timeZone, staleMs: 10 * 60_000 }]),
	);
	const c = checks.find((c) => /stale by more than five minutes/.test(c.label));
	assert.ok(c);
	assert.equal(c.warn, true);
	assert.ok(c.label.includes("mini2"));
});

test("an unreadable registry is SAID, never silently absent", async () => {
	// "No peers" and "could not ask" are different facts, and a command that shows the second as the first
	// tells an operator their fleet is fine when Valkey merely blinked.
	const checks = await collectChecks(
		{ VALKEY_URL: "redis://x" },
		collectSeams({ ...EGRESS_OK, "docker info": 0, "docker image": 0 }, { nodeVersion: "22.19.0", readHosts: async () => ({ unreachable: "ECONNREFUSED" }) }),
	);
	const c = checks.find((c) => /could not read the host registry/.test(c.label));
	assert.ok(c);
	assert.equal(c.ok, true, "not knowing is not a fault of this host");
});

// ── issue #290: the durable-state block ──────────────────────────────────────────────────────────────

/**
 * The durable-state block's seams. `underTemp` is scoped to the env's OWN temp dir: every fake home here
 * is an `mkdtemp` under the real one, so the production predicate would (correctly) call the new default
 * swept and suppress the very hints these tests exist to exercise.
 */
const stateSeams = (extra = {}) =>
	collectSeams({ ...EGRESS_OK, "docker info": 0, "docker image": 0 }, {
		nodeVersion: "22.19.0",
		probeValkey: async () => true,
		underTemp: (p, e) => typeof e.TMPDIR === "string" && e.TMPDIR !== "" && p.startsWith(e.TMPDIR),
		...extra,
	});
const durable = (checks) => checks.filter((c) => /^Durable state:/.test(c.label));
const tempWarn = (checks) => checks.filter((c) => /points? into the OS temp dir/.test(c.label));

test("a default deployment reports its durable state on ONE green line", async () => {
	// A home OUTSIDE the OS temp dir, and stated rather than mkdtemp'd: a home under <tmp> really is a
	// swept location, so a temp-rooted fixture would exercise the warn branch while claiming to test the
	// green one. No disk is needed -- the check reads paths and one fileExists.
	const home = "/home/u";
	const checks = await collectChecks({}, stateSeams({ home, fileExists: () => true }));
	const lines = durable(checks);
	assert.equal(lines.length, 1, "one line, not one per variable");
	assert.equal(lines[0].ok, true);
	assert.ok(!lines[0].warn, "a durable default is not a warning");
	assert.equal(tempWarn(checks).length, 0);
	assert.equal(durable(checks)[0].fixAction, undefined, "the never tier: doctor does not move records");
});

test("a run history under the OS temp dir warns, prints a fix, and does NOT fail doctor", async () => {
	const swept = join(tmpdir(), "pi-swept-logs");
	const checks = await collectChecks({ PI_LOGS_DIR: swept }, stateSeams({ underTemp: underOsTempDir }));
	const warns = tempWarn(checks);
	assert.equal(warns.length, 1);
	assert.equal(warns[0].ok, false, "ok:false is what renders the ⚠ AND its fix line");
	assert.equal(warns[0].warn, true, "warn:true is what keeps it out of doctor's failure set");
	assert.match(warns[0].label, /PI_LOGS_DIR/);
	assert.ok(!warns[0].label.includes("PI_SETTINGS_FILE"), "only the variable that actually hit is named");
	assert.equal(typeof warns[0].fix, "string");
	assert.ok(warns[0].fix.length > 0, "an ok:false check DOES print its fix, so it must have one");
	assert.equal(warns[0].fixAction, undefined);
});

test("the temp warning is a WARNING: doctor still exits 0 (the tier pinned by consequence)", async () => {
	// Field inspection cannot make this claim -- render()'s failed rule is what turns (ok,warn) into an
	// exit code, and that is the thing an operator actually experiences. Drive the whole command.
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_LOGS_DIR: join(tmpdir(), "pi-swept-exit"), PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-fake" },
		{ ...stateSeams({ underTemp: underOsTempDir }), out },
	);
	assert.match(text(), /points into the OS temp dir/);
	assert.equal(code, 0, "a swept state dir is worth a warning, never a refusal to run");
});

test("both variables under temp produce ONE line naming both, pluralised", async () => {
	const checks = await collectChecks(
		{ PI_LOGS_DIR: join(tmpdir(), "pi-a"), PI_SETTINGS_FILE: join(tmpdir(), "pi-b.json") },
		stateSeams({ underTemp: underOsTempDir }),
	);
	const warns = tempWarn(checks);
	assert.equal(warns.length, 1, "one line, not two");
	assert.match(warns[0].label, /PI_LOGS_DIR/);
	assert.match(warns[0].label, /PI_SETTINGS_FILE/);
	assert.match(warns[0].label, / point into /, "two variables read as plural");
});

test("no home directory on disk warns about the SILENT record loss the move introduces", async () => {
	// makeRecordWriter swallows its mkdir failure into a logs_dir_error line and keeps running, so
	// without this check the worker drains jobs perfectly and records nothing.
	const checks = await collectChecks({}, stateSeams({ home: "/nonexistent", fileExists: (p) => p !== "/nonexistent" }));
	const homeless = checks.filter((c) => /no home directory on disk/.test(c.label));
	assert.equal(homeless.length, 1);
	assert.equal(homeless[0].ok, false);
	assert.equal(homeless[0].warn, true);
	assert.match(homeless[0].fix, /logs_dir_error/, "name the log line an operator would otherwise have to guess");
	assert.match(homeless[0].label, /settings.json/, "the overlay is the quieter half of the same fault, and is named");
	assert.equal(checks.filter((c) => /^Durable state:/.test(c.label)).length, 0, "doctor must not promise a reboot survives a directory it just said cannot be created");

	// An explicit PI_LOGS_DIR rescues the RECORDS and nothing else: the overlay still defaults into the
	// unwritable home, and a settings file that cannot be written reads back as an empty overlay, which
	// widens every cap to the .env default. So the clause still fires, and now names only the store that
	// is actually still at risk.
	const half = await collectChecks({ PI_LOGS_DIR: "/srv/logs" }, stateSeams({ home: "/nonexistent", fileExists: (p) => p !== "/nonexistent" }));
	const halfLine = half.filter((c) => /no home directory on disk/.test(c.label));
	assert.equal(halfLine.length, 1, "setting one variable does not settle the other");
	assert.match(halfLine[0].label, /settings\.json/);
	assert.ok(!halfLine[0].label.includes("/srv/logs"), "the store the operator already placed is not re-litigated");

	// BOTH set: nothing defaults into the missing home, so there is nothing left to say.
	const both = await collectChecks({ PI_LOGS_DIR: "/srv/logs", PI_SETTINGS_FILE: "/srv/settings.json" }, stateSeams({ home: "/nonexistent", fileExists: (p) => p !== "/nonexistent" }));
	assert.equal(both.filter((c) => /no home directory on disk/.test(c.label)).length, 0);
});

test("the migration hint fires ONLY while the old path holds records and the new one does not", async () => {
	const tmp = tempDir("pi-migrate-");
	const home = tempDir("pi-migrate-home-");
	const env = { TMPDIR: tmp };
	mkdirSync(join(tmp, "pi-dispatch", "logs"), { recursive: true });
	writeFileSync(join(tmp, "pi-dispatch", "logs", "gh-1.json"), "{}");
	const hint = (checks) => checks.filter((c) => /holds \d+ run record/.test(c.label));

	// (a) old populated, new absent -> the hint, on the advisory tier.
	const a = await collectChecks(env, stateSeams({ home }));
	assert.equal(hint(a).length, 1);
	assert.equal(hint(a)[0].ok, false, "render() draws ok:true as a green tick whatever warn says, and stranded history is not good news");
	assert.equal(hint(a)[0].warn, true, "but it must not FAIL doctor");

	// (b) the new store has anything at all -> the hint retires itself forever.
	mkdirSync(join(home, ".pi-dispatch", "logs"), { recursive: true });
	writeFileSync(join(home, ".pi-dispatch", "logs", "gh-2.json"), "{}");
	assert.equal(hint(await collectChecks(env, stateSeams({ home }))).length, 0, "a populated new store retires the hint");

	// (c) an explicit PI_LOGS_DIR -> nothing to migrate, so nothing is claimed.
	rmSync(join(home, ".pi-dispatch", "logs", "gh-2.json"));
	assert.equal(hint(await collectChecks({ ...env, PI_LOGS_DIR: join(home, "elsewhere") }, stateSeams({ home }))).length, 0);

	// (d) a RECORD is a .json or a .log, the log reaper's own rule. Anything else in the new store is
	// not a record and must not retire the hint, or a stray file silently strands the operator's history
	// at the old path with nothing left to tell them.
	writeFileSync(join(home, ".pi-dispatch", "logs", "notes.txt"), "x");
	assert.equal(hint(await collectChecks(env, stateSeams({ home }))).length, 1, "a non-record does not count as a record");
});

test("a world-writable legacy dir gets no one-line adopt command, because that file may not be yours", { skip: process.platform === "win32" }, async () => {
	// The legacy state root is <OS temp>/pi-dispatch, and POSIX temp is mode 1777, so on a shared host any
	// local account can create files there. An overlay OUTRANKS .env for every spend cap, so a copy-paste
	// `mv` would let a stranger install their dailyCap on this deployment. The records half is softened the
	// same way, because adopting them corrupts the history the panel and dispatch_costs fold over.
	const tmp = tempDir("pi-shared-legacy-");
	const home = tempDir("pi-shared-home-");
	mkdirSync(join(tmp, "pi-dispatch", "logs"), { recursive: true });
	writeFileSync(join(tmp, "pi-dispatch", "logs", "gh-1.json"), "{}");
	writeFileSync(join(tmp, "pi-dispatch", "settings.json"), JSON.stringify({ dailyCap: 100000 }));
	chmodSync(join(tmp, "pi-dispatch"), 0o777);
	chmodSync(join(tmp, "pi-dispatch", "logs"), 0o777);

	const checks = await collectChecks({ TMPDIR: tmp }, stateSeams({ home }));
	const settings = checks.find((c) => /a settings overlay is still at/.test(c.label));
	assert.ok(settings, "the operator is still told the file exists");
	assert.ok(!/\bmv /.test(settings.fix), "but is NOT handed a command that adopts it unread");
	assert.match(settings.fix, /writable by every local account/);
	assert.match(settings.fix, /read it before adopting it/);

	const logs = checks.find((c) => /holds \d+ run record/.test(c.label));
	assert.ok(logs);
	assert.match(logs.fix, /confirm those files are yours/, "the records half carries the same caveat");
	assert.match(logs.fix, /PI_LOG_RETENTION_DAYS/, "and the reaper caveat survives on this branch too, not only the trusted one");
});

test("a legacy directory holding only non-records has nothing to migrate", async () => {
	const tmp = tempDir("pi-migrate-junk-");
	const home = tempDir("pi-migrate-junk-home-");
	mkdirSync(join(tmp, "pi-dispatch", "logs"), { recursive: true });
	writeFileSync(join(tmp, "pi-dispatch", "logs", "README.txt"), "x");
	const checks = await collectChecks({ TMPDIR: tmp }, stateSeams({ home }));
	assert.equal(checks.filter((c) => /holds \d+ run record/.test(c.label)).length, 0);
});

test("the migration hint's remedy is in the FIX, which renders because the check is ok:false", async () => {
	const tmp = tempDir("pi-migrate-label-");
	const home = tempDir("pi-migrate-label-home-");
	mkdirSync(join(tmp, "pi-dispatch", "logs"), { recursive: true });
	writeFileSync(join(tmp, "pi-dispatch", "logs", "gh-1.log"), "x"); // the reaper's OTHER extension
	const checks = await collectChecks({ TMPDIR: tmp }, stateSeams({ home }));
	const hint = checks.find((c) => /holds \d+ run record/.test(c.label));
	assert.ok(hint, "a .log counts as a record, exactly as the log reaper counts it");
	assert.equal(hint.ok, false, "ok:false is what makes render() print the fix line at all");
	assert.match(hint.fix, /mkdir -p /, "the target dir is usually absent -- that is the very condition the hint fires on");
	assert.match(hint.fix, /mv /);
	assert.match(hint.fix, /PI_LOG_RETENTION_DAYS/, "mv keeps mtimes, so the reaper eats anything already past the window; say so");
});

test("the settings hint names the CONSEQUENCE, not just the path", async () => {
	const tmp = tempDir("pi-migrate-settings-");
	const home = tempDir("pi-migrate-settings-home-");
	mkdirSync(join(tmp, "pi-dispatch"), { recursive: true });
	writeFileSync(join(tmp, "pi-dispatch", "settings.json"), "{}");
	const checks = await collectChecks({ TMPDIR: tmp }, stateSeams({ home }));
	const hint = checks.find((c) => /a settings overlay is still at/.test(c.label));
	assert.ok(hint);
	assert.equal(hint.ok, false);
	assert.equal(hint.warn, true);
	assert.match(hint.label, /may be wider/, "an operator who RAISED a cap gets a narrower fallback, so the claim is hedged rather than wrong");
	assert.match(hint.label, /the model and any secret profiles/, "the overlay is not only caps");
	assert.match(hint.fix, /mv /);
});

test("a home UNDER the OS temp dir is swept, and the line does NOT claim two unset variables point there", async () => {
	// Not a contrived case: a service account homed under /tmp gets a durable-looking ~/.pi-dispatch the
	// OS still sweeps. The predicate reads the resolved path, not the variable, which is why it catches
	// this -- and the message must then describe the DEFAULT, because naming PI_LOGS_DIR here would assert
	// something false about an operator who never set it, and "unset falls back to..." would advise the
	// very state being warned about.
	const home = tempDir("pi-home-in-temp-");
	const checks = await collectChecks({}, stateSeams({ home, underTemp: underOsTempDir }));
	assert.equal(checks.filter((c) => /^Durable state:/.test(c.label)).length, 0);
	const warns = checks.filter((c) => /OS temp dir/.test(c.label));
	assert.equal(warns.length, 1);
	assert.match(warns[0].label, /defaults under the OS temp dir/);
	assert.ok(!/PI_LOGS_DIR \(/.test(warns[0].label), "an unset variable is not said to point anywhere");
	assert.match(warns[0].fix, /^set PI_LOGS_DIR and PI_SETTINGS_FILE/, "the remedy is to SET them, never to unset them");
	assert.ok(!/unset/.test(warns[0].fix), "advising `unset` here would point back at the warned path");
});

test("an explicitly-set swept path names the variable, because that one really was set", async () => {
	const checks = await collectChecks({ PI_LOGS_DIR: join(tmpdir(), "pi-explicit-swept") }, stateSeams({ home: "/home/u", fileExists: () => true, underTemp: underOsTempDir }));
	const warns = checks.filter((c) => /OS temp dir/.test(c.label));
	assert.equal(warns.length, 1);
	assert.match(warns[0].label, /PI_LOGS_DIR \(/);
	assert.ok(!warns[0].label.includes("PI_SETTINGS_FILE"), "the durable one is not dragged in");
	assert.match(warns[0].fix, /unsetting it falls back to/, "and here `unset` IS the remedy, because it leads somewhere durable");
});

test("doctor: the in-image gh probe does NOT run on a docker CLI that points off this host (#278)", async () => {
	// The probe hands the operator's own gh token to `docker run -e`; on a redirected CLI that token rides to
	// another machine. A check must not do what the credentialTransit line warns about.
	const { out, text } = capture();
	const calls = [];
	const plan = { ...green, "docker context inspect": { code: 0, output: '"remote"|"tcp://10.1.2.3:2375"\n' }, "gh auth status": { code: 0, output: ghStatusOutput }, "gh auth token": { code: 0, output: "gho_x\n" }, "docker run": 0 };
	await runDoctor(ghEnv(), ghDeps(out, plan, calls));
	assert.ok(!calls.some((c) => c.cmd === "docker" && c.args.includes("GH_TOKEN")), "no container was handed the token");
	assert.match(text(), /⚠ in-image gh auth: not checked, because this shell's docker CLI resolves tcp:\/\/10\.1\.2\.3:2375, which is not shown to be on this host/);
});

test("doctor: the in-image gh probe does NOT run when the docker CLI could not say where it points (#278)", async () => {
	// Not only a redirect: an endpoint doctor could not read is not observed local either, and gets no credit.
	const { out, text } = capture();
	const calls = [];
	const plan = { ...green, "docker context inspect": { code: 1, output: "" }, "gh auth status": { code: 0, output: ghStatusOutput }, "gh auth token": { code: 0, output: "gho_x\n" }, "docker run": 0 };
	await runDoctor(ghEnv(), ghDeps(out, plan, calls));
	assert.ok(!calls.some((c) => c.cmd === "docker" && c.args.includes("GH_TOKEN")), "no container was handed the token");
	assert.match(text(), /⚠ in-image gh auth: not checked, because this shell's docker CLI did not say which daemon it uses \(exit-1\)/);
});

test("doctor: under GITHUB_AUTH_SOURCE=app a redirected CLI does not claim a probe would send a token (#278)", async () => {
	// App mode mints per job and never runs the probe, so the redirect warning would be about nothing.
	const { out, text } = capture();
	const plan = { ...green, "docker context inspect": { code: 0, output: '"remote"|"tcp://10.1.2.3:2375"\n' } };
	await runDoctor(ghEnv({ GITHUB_AUTH_SOURCE: "app" }), ghDeps(out, plan));
	assert.match(text(), /✓ in-image gh auth: skipped \(GITHUB_AUTH_SOURCE=app mints per-job\)/);
	assert.doesNotMatch(text(), /would send your gh token/);
});

// -- doctor --live (issue #278, INT-LIVE-PROBE-CONTRACT) ----------------------------------------------------------

const LIVE_ID = "d".repeat(64);
const LIVE_STATUS = (uid = "1001") => `Name:\tdocker-init\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nCapBnd:\t0000000000000000\nNoNewPrivs:\t1\ncgroup:v2\npids.max:512\nmemory.max:4294967296\n`;

// Issue #341: a rootful daemon's `docker info` body and the identities the job-user tests use.
const ROOTFUL_INFO = JSON.stringify({ ServerVersion: "27.5.1", OperatingSystem: "Ubuntu 24.04", SecurityOptions: ["name=seccomp,profile=builtin"], PidsLimit: true, MemoryLimit: true });
const ROOTLESS_INFO = JSON.stringify({ ServerVersion: "27.5.1", OperatingSystem: "Ubuntu 24.04", SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless"], PidsLimit: false, MemoryLimit: false });
const LINUX_ID = (euid, egid = euid) => ({ platform: "linux", release: "6.8.0-test", euid, egid });
const imageLabels = (capabilities) => ({ "docker image inspect --format={{.Id}}": { code: 0, output: `sha256:abc|0.80.7||${capabilities}\n` } });
const socketStat = () => ({ uid: 0, gid: 2375 });
const infoPlan = (body) => ({ "docker info --format={{json .}}": { code: 0, output: `${body}\n` } });

/**
 * The docker answers a --live pass needs, as function outcomes that read the probe's own argv. Listed FIRST wherever
 * spread, because `green`'s broad "docker image" key would otherwise answer the pinning probe's absent-image inspect.
 */
function liveOk({ uid = "1001" } = {}) {
	let volumes = [];
	return {
		"docker run --name=pi-dispatch-live-probe-": (_cmd, args) => {
			volumes = args.flatMap((a, i) => (args[i - 1] === "-v" ? [a] : []));
			return { code: 0, output: `${LIVE_ID}\n` };
		},
		"docker inspect --format={{json .Mounts}}": () => ({ code: 0, output: JSON.stringify(volumes.map((v) => ({ Type: "bind", Source: v.split(":")[0], Destination: v.split(":")[1], RW: v.split(":")[2] !== "ro" }))) }),
		// A readable rootful daemon, so the job user is decided and the probe runs (issue #341).
		...infoPlan(ROOTFUL_INFO),
		[`docker exec ${LIVE_ID} sh -c cat /proc/1/status`]: { code: 0, output: LIVE_STATUS(uid) },
		// Issue #345: the mount table inside the reading container, as rootful Docker shows it for the builder's argv.
		[`docker exec ${LIVE_ID} cat /proc/self/mountinfo`]: () => ({ code: 0, output: `${["/", "/proc", "/dev", "/sys", "/usr/sbin/docker-init", "/etc/hosts", ...volumes.map((v) => v.split(":")[1])].map((p, i) => `${100 + i} 99 0:${i} / ${p} rw - overlay overlay rw`).join("\n")}\n` }),
		[`docker exec ${LIVE_ID} sh -c [ -r /job ]`]: (_cmd, args) => {
			for (const dest of ["/workspace", "/outbox", "/session"]) {
				const src = volumes.find((v) => v.split(":")[1] === dest).split(":")[0];
				writeFileSync(join(src, ".pi-dispatch-live-probe"), args.at(-1));
			}
			return { code: 0, output: "wrote\n" };
		},
		"docker run --name=pi-dispatch-live-pin-": { code: 125, output: "docker: Error response from daemon: No such image: pi-dispatch-live-probe.invalid/absent:x.\n" },
		// Issue #344: the ephemeral pair. Each run leaves its nonce under its number in the fixture workspace, and is gone
		// by the first `ps` (it ran with --rm).
		"docker run --name=pi-dispatch-live-ephemeral-": (_cmd, args) => {
			const ws = args.flatMap((a, i) => (args[i - 1] === "-v" ? [a] : [])).find((v) => v.split(":")[1] === "/workspace").split(":")[0];
			writeFileSync(join(ws, `.pi-dispatch-live-ephemeral-${args.at(-1)}`), args.at(-2));
			return { code: 0, output: `${args.at(-1).repeat(64)}\n` };
		},
		"docker ps -a --no-trunc --filter id=": { code: 0, output: "" },
		"docker image inspect pi-dispatch-live-probe.invalid": 1,
		"docker rm -f": 0,
	};
}
const liveFs = { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync };
// Issue #341: never this machine's ids in a --live test. uid 1001 is the image's own, so the probe runs as the image's
// user whatever host runs the suite; the job-user tests below choose other ids on purpose.
const LINUX_1001 = { platform: "linux", release: "6.8.0-test", euid: 1001, egid: 1001 };
// The host owner the probe's write reads as, for that identity: the fake container writes as THIS test process.
const liveFsAs = (uid) => ({ ...liveFs, statSync: (p) => Object.assign(statSync(p), { uid }) });
const liveEnv = (extra = {}) => ({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_EGRESS: "0", PI_JOBS_DIR: tempDir("pi-live-doctor-"), ...extra });

test("doctor without --live is byte-identical and spawns no probe; a truthy non-boolean `live` runs nothing either", async () => {
	const env = liveEnv();
	const texts = [];
	for (const live of [undefined, false, "true", 1]) {
		const { out, text } = capture();
		const calls = [];
		await runDoctor(env, { ...ghDeps(out, { ...liveOk(), ...green }, calls), ...(live === undefined ? {} : { live, liveFs }) });
		assert.ok(!calls.some((c) => c.args.some((a) => String(a).includes("pi-dispatch-live"))), `no probe spawn for live=${JSON.stringify(live)}`);
		texts.push(text());
	}
	assert.ok(texts.every((t) => t === texts[0]), "the output is the same whatever a non-true `live` is");
	assert.doesNotMatch(texts[0], /read back on local/);
});

test("doctor --live reads the eight back, reports the limits, leaves no fixture, and exits 0 when they hold", async () => {
	const env = liveEnv();
	const { out, text } = capture();
	const calls = [];
	const code = await runDoctor(env, { ...ghDeps(out, { ...liveOk(), ...green }, calls), live: true, liveFs: liveFsAs(1001), jobUserIdentity: LINUX_1001, isAlive: () => false, pid: 7, nonce: "n" });
	assert.equal(code, 0, text());
	assert.equal(calls.filter((c) => c.args[0] === "context").length, 2, "the endpoint is read by the collection AND again right before the probe");
	for (const property of ["isolation", "ephemeral", "mountSet", "imagePinning", "nonRoot", "localFolders"]) {
		assert.match(text(), new RegExp(`✓ read back on local: ${property} holds`));
	}
	assert.match(text(), /⚠ read back on local: egress not read back: PI_EGRESS is off/);
	assert.match(text(), /⚠ read back on local: jobToJobIsolation not read back: PI_EGRESS is off, so jobs share docker's default bridge by design/);
	assert.match(text(), /jobToJobIsolation needs PI_EGRESS armed/, "the limits line says why the peers did not run");
	assert.doesNotMatch(text(), /are not probed/);
	assert.match(text(), /✓ read back on local: limits of this read-back -- every probe container runs a constant program \(`sleep`, `sh` or `node`\)/);
	assert.match(text(), /ephemeral ran two short-lived containers under one name/);
	assert.doesNotMatch(text(), /tried one pair of peers/, "no sentence claims the peers ran when they did not");
	assert.match(text(), /✓ read back on local: the probe ran as the job image's own user \(uid 1001\)/, "issue #341: the uid-1001 shell's probe is the image's user, read back");
	assert.match(text(), /it ran as the image's own user, decided for this shell \(uid 1001\)/);
	assert.ok(text().indexOf("read back on local: starting pi-dispatch-live-probe-7-n from pi-job:latest") < text().indexOf("✓ read back on local: isolation"), "shown before its results");
	assert.ok(text().includes(`with a fixture under ${env.PI_JOBS_DIR};`), "the fixture lives under the worker's own jobs dir (jobsDirPath), not a path doctor derived for itself");
	assert.deepEqual(calls.filter((c) => c.args[0] === "rm").map((c) => c.args), [["rm", "-f", LIVE_ID], ["rm", "-f", "pi-dispatch-live-pin-7-n"]]);
	assert.deepEqual(readdirSync(env.PI_JOBS_DIR), [], "the fixture is removed");
	assert.ok(calls.findIndex((c) => c.args[0] === "run" && String(c.args[1]).startsWith("--name=pi-dispatch-live-probe")) > calls.findIndex((c) => c.args[0] === "info"), "the probes run after the ordinary checks");
});

test("doctor --live renders a failed read-back as a hard failure with the declared word beside the observed", async () => {
	const { out, text } = capture();
	const code = await runDoctor(liveEnv(), { ...ghDeps(out, { ...liveOk({ uid: "0" }), ...green }), live: true, liveFs: liveFsAs(1001), jobUserIdentity: LINUX_1001, isAlive: () => false, pid: 7, nonce: "n" });
	assert.equal(code, 1);
	assert.match(text(), /✗ read back on local: nonRoot does NOT hold -- declared asserted, observed: Uid 0 0 0 0/);
	assert.match(text(), /→ PI_JOB_IMAGE runs as root/);
});

test("doctor --live on a docker CLI not observed local runs no container and says why, once", async () => {
	const { out, text } = capture();
	const calls = [];
	const plan = { ...liveOk(), ...green, "docker context inspect": { code: 0, output: '"remote"|"tcp://10.1.2.3:2375"\n' } };
	await runDoctor(liveEnv(), { ...ghDeps(out, plan, calls), live: true, liveFs: liveFsAs(1001), jobUserIdentity: LINUX_1001, isAlive: () => false });
	assert.ok(!calls.some((c) => c.args.some((a) => String(a).includes("pi-dispatch-live"))));
	assert.equal(text().match(/read back on local/g).length, 1);
	assert.match(text(), /⚠ read back on local: not run -- this shell's docker CLI is not observed to point at this host/);
});

test("doctor --live checks carry no fixAction: a failed read-back is never something doctor fixes", async () => {
	const env = liveEnv();
	const facts = { endpoint: { local: true }, dockerCode: 0, imageCode: 0, jobImage: "pi-job:latest", triggerImages: ["a:1", "b:2"], egress: { armed: false, results: [] } };
	const checks = await liveChecks(env, { spawn: fakeSpawn({ ...liveOk({ uid: "0" }), ...green }), home: "/home/u", liveFs, isAlive: () => false, pid: 1, nonce: "n" }, facts);
	assert.ok(checks.length >= 7);
	assert.ok(checks.every((c) => c.fixAction === undefined));
	assert.match(checks.at(-1).label, /not the 2 image\(s\) your triggers name/);
	// The not-run path too: a notes-only result must not grow an offer either.
	const notRun = await liveChecks(env, { spawn: fakeSpawn(green), liveFs, isAlive: () => false, pid: 1, nonce: "n" }, { ...facts, imageCode: 1 });
	assert.equal(notRun.length, 1);
	assert.match(notRun[0].label, /not run -- the job image pi-job:latest is not present/);
	assert.equal(notRun[0].fixAction, undefined);
});

test("doctor --live gives each localFolders failure its own fix, and names what it swept from an interrupted run", async () => {
	const env = liveEnv();
	mkdirSync(join(env.PI_JOBS_DIR, "pi-dispatch-live-99999-aB3xYz"));
	const facts = { endpoint: { local: true }, dockerCode: 0, imageCode: 0, jobImage: "pi-job:latest", triggerImages: [], egress: { armed: false, results: [] } };
	const invisible = { ...liveOk(), [`docker exec ${LIVE_ID} sh -c [ -r /job ]`]: { code: 0, output: "wrote\n" } };
	const checks = await liveChecks(env, { spawn: fakeSpawn({ ...invisible, ...green }), liveFs, isAlive: () => false, pid: 1, nonce: "n" }, facts);
	assert.match(checks[0].label, /✓?read back on local: removed fixture pi-dispatch-live-99999-aB3xYz, left by an interrupted --live run/);
	const folders = checks.find((c) => /localFolders does NOT hold/.test(c.label));
	assert.match(folders.fix, /file sharing/, "a write the host cannot see is not the uid problem");
	assert.doesNotMatch(folders.fix, /uid 1001/);
});

test("doctor --fix --live reads back ONCE, after the fix pass, from the re-collected facts", async () => {
	const cwd = tempDir("pi-live-fix-"); // no .env, so the silent `init` fix runs and forces a re-collect
	const { out, text } = capture();
	const calls = [];
	await runDoctor(liveEnv(), { ...ghDeps(out, { ...liveOk(), ...green }, calls), fileExists: existsSync, cwd, fix: true, promptFn: async () => false, live: true, liveFs: liveFsAs(1001), jobUserIdentity: LINUX_1001, isAlive: () => false, pid: 7, nonce: "n" });
	assert.match(text(), /re-check after fixes/, "the fixture must actually drive a re-collection");
	// `docker info` bare: the job-user read (`info --format=...`, issue #341) is a different question.
	const infos = calls.map((c, i) => [c, i]).filter(([c]) => c.args[0] === "info" && c.args.length === 1).map(([, i]) => i);
	const probes = calls.map((c, i) => [c, i]).filter(([c]) => c.args[0] === "run" && String(c.args[1]).startsWith("--name=pi-dispatch-live-probe")).map(([, i]) => i);
	assert.equal(infos.length, 2, "collected twice");
	assert.equal(probes.length, 1, "probed once");
	assert.ok(probes[0] > infos[1], "and after the second collection");
});

test("doctor --live with PI_JOBS_DIR unset builds its fixture under the injected TMPDIR, as loadConfig would", async () => {
	const tmp = tempDir("pi-live-tmpdir-");
	const { out, text } = capture();
	const env = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_EGRESS: "0", TMPDIR: tmp };
	await runDoctor(env, { ...ghDeps(out, { ...liveOk(), ...green }), live: true, liveFs: liveFsAs(1001), jobUserIdentity: LINUX_1001, isAlive: () => false, pid: 7, nonce: "n" });
	assert.ok(text().includes(`with a fixture under ${tmp}/pi-dispatch/jobs;`), text());
	assert.deepEqual(readdirSync(join(tmp, "pi-dispatch", "jobs")), [], "and removes it");
});

test("an egress probe that timed out or exited 1 is not run either, and doctor says which", async () => {
	for (const [outcome, said] of [[null, /did not run \(docker run did not finish\)/], [1, /did not run \(docker run exited 1\)/]]) {
		const checks = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" }, collectSeams({ ...green, "docker run --rm --name pi-dispatch-egress-probe-unlisted": { code: outcome, output: "" } }));
		assert.ok(checks.some((c) => said.test(c.label)), String(outcome));
		assert.ok(!checks.some((c) => /denies an unlisted host/.test(c.label)), String(outcome));
	}
});

test("doctor --live's not-run path still names what it swept", async () => {
	const env = liveEnv();
	mkdirSync(join(env.PI_JOBS_DIR, "pi-dispatch-live-99998-aB3xYz"));
	const facts = { endpoint: { local: true }, dockerCode: 0, imageCode: 0, jobImage: "pi-job:latest", triggerImages: [], egress: { armed: false, results: [] } };
	const failing = { ...liveOk(), "docker run --name=pi-dispatch-live-probe-": { code: 127, output: `${LIVE_ID}\n` }, "docker rm -f": 1 };
	const checks = await liveChecks(env, { spawn: fakeSpawn({ ...failing, ...green }), liveFs, isAlive: () => false, pid: 1, nonce: "n" }, facts);
	assert.match(checks[0].label, /removed fixture pi-dispatch-live-99998-aB3xYz/);
	assert.ok(checks.some((c) => /not run -- the probe container did not start/.test(c.label)));
	assert.ok(checks.some((c) => c.warn && new RegExp(`could not be removed: docker rm -f ${LIVE_ID}`).test(c.label)), "a failed removal by ID is said on this path too");
});

test("doctor --live's not-writable localFolders failure keeps its own ownership fix", async () => {
	const env = liveEnv();
	const facts = { endpoint: { local: true }, dockerCode: 0, imageCode: 0, jobImage: "pi-job:latest", triggerImages: [], egress: { armed: false, results: [] } };
	const notWritable = { ...liveOk(), [`docker exec ${LIVE_ID} sh -c [ -r /job ]`]: { code: 0, output: "not-writable /workspace\n" } };
	const checks = await liveChecks(env, { spawn: fakeSpawn({ ...notWritable, ...green }), liveFs, isAlive: () => false, pid: 1, nonce: "n" }, facts);
	assert.match(checks.find((c) => /localFolders does NOT hold/.test(c.label)).fix, /the account the worker runs as/, "issue #341: the fix names the worker's uid, no longer the image's 1001");
});

test("an egress probe that did not RUN is reported as not run, and never passes for a deny", async () => {
	const checks = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" }, collectSeams({ ...green, "docker run --rm --name pi-dispatch-egress-probe-unlisted": 125 }));
	assert.ok(checks.some((c) => /Egress policy probe for an unlisted host did not run \(docker run exited 125\)/.test(c.label) && c.warn === true));
	assert.ok(!checks.some((c) => /denies an unlisted host/.test(c.label)));
	assert.deepEqual(checks.filter((c) => c.readBack).map((c) => c.readBack.reached), [true, null]);
});

test("the egress canary's deny probe asks for a host that RESOLVES, under a per-process name", async () => {
	const calls = [];
	await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" }, collectSeams(green, { spawn: fakeSpawn(green, calls) }));
	const unlisted = calls.find((c) => c.args.includes(`pi-dispatch-egress-probe-unlisted-${process.pid}`));
	assert.ok(unlisted, "named with this process's pid, so two doctors cannot clash into a false deny");
	assert.ok(unlisted.args.some((a) => a.includes('"https://example.com/"')), "an allow-all proxy reaches example.com; a reserved .example name it could never resolve");
});

test("the egress canary carries a non-rendered readBack, so --live folds it in without a second canary", async () => {
	const checks = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" }, collectSeams(green));
	const readBacks = checks.filter((c) => c.readBack).map((c) => c.readBack);
	assert.deepEqual(readBacks, [{ property: "egress", want: true, reached: true }, { property: "egress", want: false, reached: false }]);
});

// --- issue #341: the job-user line, and the probe run as the job user ------------------------------------------

test("doctor names who a local job runs as, from the worker's own resolver, and never starts a container for it (#341)", async () => {
	for (const [label, ids, plan, pattern] of [
		["worker mode", LINUX_ID(1234), { ...infoPlan(ROOTFUL_INFO), ...imageLabels("replicas,anyUid") }, /✓ local: jobs run as uid:gid 1234:1234 \(passed as --user\) with HOME=\/home\/pi/],
		["uid 1001", LINUX_ID(1001), infoPlan(ROOTFUL_INFO), /✓ local: jobs run as the job image's own user \(this shell is uid 1001/],
		["macOS", { platform: "darwin", release: "24.6.0", euid: 501, egid: 20 }, {}, /✓ local: jobs run as the job image's own user \(a VM-backed daemon/],
	]) {
		const { out, text } = capture();
		const calls = [];
		const code = await runDoctor(ghEnv(), { ...ghDeps(out, { ...plan, ...green }, calls), jobUserIdentity: ids, stat: socketStat });
		assert.match(text(), pattern, label);
		assert.equal(code, 0, `${label}: ${text()}`);
		assert.ok(!calls.some((c) => c.args[0] === "run" && c.args.some((a) => /^--user/.test(String(a)))), `${label}: no container is started to decide it`);
		// Issue #345: macOS asks the daemon ONCE, for the runtime observations; the job user is still the image's whatever it says.
		if (ids.platform === "darwin") assert.equal(calls.filter((c) => c.args.includes("--format={{json .}}")).length, 1, "macOS asks the daemon once, and decides nothing from it");
	}
});

test("doctor marks ✗ only what stops the worker booting; a per-job refusal or an undecidable daemon is ⚠ (#341)", async () => {
	const rootless = capture();
	assert.equal(await runDoctor(ghEnv(), { ...ghDeps(rootless.out, { ...infoPlan(ROOTLESS_INFO), ...green }), jobUserIdentity: LINUX_ID(1234), stat: () => ({ uid: 1234, gid: 1234 }) }), 1);
	assert.match(rootless.text(), /✗ local: no job can run as a non-root user that owns its files on this daemon \(rootless\) -- a worker running as this account refuses to boot/);
	assert.match(rootless.text(), /run jobs on a rootful Docker or Podman daemon/, "the fix is the worker's own text");

	for (const [label, ids, plan, pattern] of [
		["no anyUid", LINUX_ID(1234), { ...infoPlan(ROOTFUL_INFO), ...imageLabels("replicas") }, /⚠ local: every job on pi-job:latest is refused as this uid \(job-image-any-uid-unsupported\)/],
		["docker group", LINUX_ID(1235, 2375), { ...infoPlan(ROOTFUL_INFO), ...imageLabels("anyUid") }, /⚠ local: every local job is refused as this uid \(docker-group\)/],
		["undecidable", LINUX_ID(1234), { "docker info --format={{json .}}": { code: 1, output: "" } }, /⚠ local: which uid a job runs as could not be decided \(exit-1\)/],
		["unreadable", LINUX_ID(1234), { "docker info --format={{json .}}": { code: 0, output: "not json\n" } }, /⚠ local: which uid a job runs as could not be read from the daemon's answer \(runtime-unreadable\) -- every local job is refused/],
	]) {
		const { out, text } = capture();
		const code = await runDoctor(ghEnv(), { ...ghDeps(out, { ...plan, ...green }), jobUserIdentity: ids, stat: socketStat });
		assert.match(text(), pattern, label);
		assert.equal(code, 0, `${label}: a warning, because the worker boots and refuses per job: ${text()}`);
	}
});

test("doctor warns when PI_FORWARD_ENV names HOME for a --user job, and when a system unit runs the worker as another account (#341)", async () => {
	const forwarded = capture();
	await runDoctor(ghEnv({ PI_FORWARD_ENV: "FOO,HOME" }), { ...ghDeps(forwarded.out, { ...infoPlan(ROOTFUL_INFO), ...imageLabels("anyUid"), ...green }), jobUserIdentity: LINUX_ID(1234), stat: socketStat });
	assert.match(forwarded.text(), /⚠ PI_FORWARD_ENV names HOME, which a job run as --user never receives/);

	const deployDir = tempDir("pi-unit-user-");
	const home = tempDir("pi-unit-home-");
	const unitPath = "/etc/systemd/system/pi-dispatch-worker.service";
	const unit = `[Service]\nUser=pi\nWorkingDirectory=${deployDir}\n`;
	const PASSWD = () => "root:x:0:0::/root:/bin/sh\npi:x:998:998::/home/pi:/usr/sbin/nologin\nop:x:1234:1234::/home/op:/bin/sh\n";
	const run = async (body, { passwd = PASSWD, path = unitPath, cwd = deployDir, info = ROOTFUL_INFO, plan = {}, stat = socketStat } = {}) => {
		const { out, text } = capture();
		await runDoctor(ghEnv(), {
			...ghDeps(out, { ...infoPlan(info), ...imageLabels("anyUid"), ...green, ...plan }),
			cwd,
			home,
			platform: "linux",
			fileExists: (p) => p === path || existsSync(p),
			jobUserIdentity: LINUX_ID(1234),
			stat,
			passwd,
			readUnit: (p) => (p === path ? body : (() => { throw new Error("ENOENT"); })()),
		});
		return text();
	};
	const warned = /this shell is uid 1234, but/;
	assert.match(await run(unit), /this shell is uid 1234, but .* runs the worker as pi \(uid 998\)/, "by name");
	assert.match(await run(unit.replace("User=pi", "User=4242")), /runs the worker as 4242 \(uid 4242\)/, "numeric");
	assert.match(await run(unit.replace("User=pi", "User = pi\n  User=4242")), /runs the worker as 4242 \(uid 4242\)/, "systemd's last assignment wins, whitespace allowed");
	// Only an explicit User= is compared: no guess from its absence (root, or a DynamicUser= uid), because a
	// guess here was wrong for every case it missed. What covers the gap is conditional, and this comment
	// used to say it was not: a root worker refuses to BOOT only while `local` is the default venue;
	// otherwise it boots and refuses each local job (#348).
	for (const body of [unit.replace("User=pi\n", ""), unit.replace("User=pi\n", "DynamicUser=Yes\n")]) {
		assert.doesNotMatch(await run(body), warned, JSON.stringify(body));
	}
	assert.match(await run(unit.replace("User=pi", "DynamicUser=yes\nUser=pi")), /runs the worker as pi \(uid 998\)/, "an explicit User= is compared whatever else the unit says");
	// UID 0, by name and by number, left untested under #347's round cap (issue #348 item 1). The code
	// warns because 0 is not this shell's uid, but a change that skipped uid 0 -- on the reasoning that
	// root can read anything, which is true of FILES and beside the point here -- passed every test. What
	// the line is about is that the worker runs as an account whose JOB USER decision differs from this
	// shell's, and for root it differs the most: `worker-is-root` refuses every local job.
	for (const spelling of ["User=root", "User=0"]) {
		// The unit's OWN spelling is echoed back, so the expectation is derived from it rather than written as
		// an alternation: `/(root|0)/` matched both spellings for either input, which let a build that printed
		// `0` for `User=root` -- no longer the line the operator can find in their unit file -- stay green.
		const name = spelling.slice("User=".length);
		const text = await run(unit.replace("User=pi", spelling));
		assert.ok(text.includes(`runs the worker as ${name} (uid 0)`), `${spelling}: ${text}`);
		assert.match(text, warned, spelling);
		// And uid 0 gets the ANSWER rather than the instruction (item 3). Asserted on the line UNDER the label
		// rather than anywhere in the output: `worker-is-root`'s text is also what the `local:` check prints
		// when the shell itself is root, so a whole-output search would pass for the wrong reason the day this
		// fixture's uid changes, while proving nothing about this check.
		const lines = text.split("\n");
		const at = lines.findIndex((line) => /runs the worker as/.test(line));
		assert.ok(lines[at + 1].includes(JOB_USER_FIX["worker-is-root"]), `${spelling}: ${lines[at + 1]}`);
		assert.doesNotMatch(text, /sudo -u (root|0) pi-dispatch doctor/, `${spelling}: not the roundabout version`);
	}
	// The OTHER half of that rule, which is where two review rounds found the defect: doctor names the refusal
	// only where this shell's own decision is `worker`, meaning the daemon maps uids fine and rootness is the
	// only thing left to differ. Every other decision is about the HOST, the `local:` line above has already
	// said it for every account, and inventing a per-account refusal there contradicts that line. Both shapes
	// below are that case, and both used to print `worker-is-root`.
	for (const [what, opts] of [
		// A rootless daemon refuses every account. Telling the operator to run the worker unprivileged is
		// advice against what the line above just proved, and it is worse than it looks: `decideJobUser` can
		// infer rootless from the SOCKET's owner, a row guarded `euid !== 0`, so any attempt to re-decide this
		// line as uid 0 loses it and lands back on `worker-is-root`.
		["a rootless daemon", { info: ROOTLESS_INFO }],
		// The same host with a daemon that does NOT say so: rootlessness is inferred from the socket's owner
		// (a rootful-looking Podman older than 4.9.3). This is the shape that kills re-deciding as uid 0,
		// because the row that sees it is guarded `euid !== 0` and a forced 0 walks straight past it.
		["a socket this shell's uid owns", { stat: () => ({ uid: 1234, gid: 1234 }) }],
		// An endpoint that is not on this host is not a refusal at all.
		["a remote endpoint", { plan: { "docker context inspect": { code: 0, output: '"remote"|"tcp://10.1.2.3:2375"\n' } } }],
	]) {
		const text = await run(unit.replace("User=pi", "User=root"), opts);
		const at = text.split("\n").findIndex((line) => line.includes("runs the worker as root (uid 0)"));
		assert.notEqual(at, -1, `${what}: the unit warning still fires`);
		assert.match(text.split("\n")[at + 1], /sudo -u root pi-dispatch doctor/, `${what}: the instruction stays`);
		assert.ok(!text.includes(JOB_USER_FIX["worker-is-root"]), `${what}: no refusal is invented`);
	}
	// A numeric account is addressed the way sudo reads one: `#4242`, quoted, never a bare number, which sudo
	// takes for a user NAME. No daemon fixture is needed for a non-zero uid, which never takes the refusal
	// branch whatever the decision is; uid 0 does need one, and `'#0'` only became reachable when that branch
	// stopped answering for every root unit, so it is covered here rather than left to be discovered.
	assert.match(await run(unit.replace("User=pi", "User=4242")), /sudo -u '#4242' pi-dispatch doctor/, "a uid needs sudo's # prefix, and the # needs quoting");
	assert.match(await run(unit.replace("User=pi", "User=0"), { info: ROOTLESS_INFO }), /sudo -u '#0' pi-dispatch doctor/, "and uid 0 spelled numerically is a uid like any other");
	// THE NAME BRANCH IS QUOTED ON THE SAME RULE (issue #370, item 3). #368 closed the numeric half and left
	// this one bare, so an `/etc/passwd` entry whose name carries a space or a metacharacter rendered a line
	// that does not do what it looks like when pasted. An ordinary name gains nothing, which is the other
	// half of the rule and is asserted above by every case that came before this one.
	// The account has to EXIST in passwd for the comparison to happen at all, so these rows bring their own.
	const oddPasswd = () => `${PASSWD()}odd name:x:777:777::/home/odd:/bin/sh\na;rm -rf /:x:778:778::/home/x:/bin/sh\no'brien:x:779:779::/home/o:/bin/sh\nop2:x:780:780::/home/op2:/bin/sh\n`;
	assert.match(await run(unit.replace("User=pi", "User=odd name"), { passwd: oddPasswd }), /sudo -u 'odd name' pi-dispatch doctor/, "a name needing quotes gets them");
	assert.match(await run(unit.replace("User=pi", "User=a;rm -rf /"), { passwd: oddPasswd }), /sudo -u 'a;rm -rf \/' pi-dispatch doctor/, "and a metacharacter is inside the quotes, not beside them");
	assert.match(await run(unit.replace("User=pi", "User=o'brien"), { passwd: oddPasswd }), /sudo -u 'o'\\''brien' pi-dispatch doctor/, "an embedded quote is closed, escaped and reopened, the one form sh, bash and zsh all read back");
	assert.match(await run(unit.replace("User=pi", "User=op2"), { passwd: oddPasswd }), /sudo -u op2 pi-dispatch doctor/, "an ordinary name is not quoted");
	// THE LABEL SAYS "MAY NOT BE" (issue #370, item 2). Under a host-level refusal -- a userns-remapped
	// daemon, Docker Desktop on Linux, an unreadable answer, a rootless daemon -- every account on the host
	// gets the identical verdict, so the line above IS the service's answer too and re-running as that
	// account changes nothing. "is not" was true in some modes and false in others; "may not be" is true in
	// all of them.
	const labelText = await run(unit.replace("User=pi", "User=4242"));
	assert.match(labelText, /so the job-user line above is this shell's answer and may not be the service's/);
	assert.doesNotMatch(labelText, /this shell's answer, not the service's/, "the flat claim is gone");
	assert.doesNotMatch(await run(unit.replace("User=pi", "User=op")), warned, "the same uid says nothing");
	assert.doesNotMatch(await run(unit, { passwd: () => { throw new Error("EACCES"); } }), warned, "an unreadable passwd is no answer, never a guess");
	assert.doesNotMatch(await run(unit, { cwd: tempDir("pi-other-deploy-") }), warned, "a unit serving another deployment is not this one's");
	assert.doesNotMatch(await run(unit, { path: "/etc/systemd/system/pi-dispatch-receiver.service" }), warned, "the receiver runs no job, so its account is not compared");
});

test("doctor --live runs its probes as the decided job user and reads the uid back (#341)", async () => {
	const { out, text } = capture();
	const calls = [];
	const plan = { ...liveOk({ uid: "1234" }), ...infoPlan(ROOTFUL_INFO), ...imageLabels("anyUid"), ...green };
	const code = await runDoctor(liveEnv(), { ...ghDeps(out, plan, calls), live: true, liveFs: liveFsAs(1234), jobUserIdentity: LINUX_ID(1234), stat: socketStat, isAlive: () => false, pid: 7, nonce: "n" });
	assert.equal(code, 0, text());
	assert.ok(calls.filter((c) => c.args[0] === "run" && String(c.args[1]).startsWith("--name=pi-dispatch-live-")).every((c) => c.args.includes("--user=1234:1234")), "the reading and the pinning probe");
	assert.match(text(), /✓ read back on local: the probe ran as uid 1234, the job user this host decides \(1234:1234\)/);
	assert.match(text(), /it ran as the job user 1234:1234, decided for this shell \(uid 1234\)/);

	const wrong = capture();
	assert.equal(await runDoctor(liveEnv(), { ...ghDeps(wrong.out, { ...liveOk({ uid: "1001" }), ...infoPlan(ROOTFUL_INFO), ...imageLabels("anyUid"), ...green }), live: true, liveFs: liveFsAs(1234), jobUserIdentity: LINUX_ID(1234), stat: socketStat, isAlive: () => false, pid: 7, nonce: "n" }), 1);
	assert.match(wrong.text(), /✗ read back on local: the probe ran as uid 1001, not the decided job user 1234:1234/);

	const refused = capture();
	const refusedCalls = [];
	await runDoctor(liveEnv(), { ...ghDeps(refused.out, { ...liveOk(), ...infoPlan(ROOTFUL_INFO), ...imageLabels("replicas"), ...green }, refusedCalls), live: true, liveFs: liveFsAs(1234), jobUserIdentity: LINUX_ID(1234), stat: socketStat, isAlive: () => false, pid: 7, nonce: "n" });
	assert.match(refused.text(), /⚠ read back on local: not run -- a local job is refused as this uid \(any-uid-unsupported\)/);
	assert.ok(!refusedCalls.some((c) => c.args.some((a) => String(a).includes("pi-dispatch-live"))), "no probe for a container no job gets");
});

test("doctor --live runs nothing where no job would run as a decided uid: a rootless daemon, an undecidable one, an unreadable answer (#341)", async () => {
	for (const [label, ids, plan, reason] of [
		["rootless", LINUX_ID(1234), { ...infoPlan(ROOTLESS_INFO) }, /a local job is refused on this daemon \(rootless\)/],
		["undecidable", LINUX_ID(1234), { "docker info --format={{json .}}": { code: 1, output: "" } }, /the job user could not be decided \(exit-1\)/],
		["unreadable", LINUX_ID(1234), { "docker info --format={{json .}}": { code: 0, output: "not json\n" } }, /a local job is refused on this daemon \(runtime-unreadable\)/],
	]) {
		const { out, text } = capture();
		const calls = [];
		await runDoctor(liveEnv(), { ...ghDeps(out, { ...liveOk(), ...plan, ...green }, calls), live: true, liveFs: liveFsAs(1234), jobUserIdentity: ids, stat: () => ({ uid: 0, gid: 2375 }), isAlive: () => false, pid: 7, nonce: "n" });
		assert.ok(!calls.some((c) => c.args.some((a) => String(a).includes("pi-dispatch-live"))), `${label}: no probe`);
		assert.match(text(), new RegExp(`⚠ read back on local: not run -- ${reason.source}`), label);
	}
});

test("doctor --live gives job-unreadable, mount-not-writable and not-yours each its own fix, and compares the owner with this shell (#341)", async () => {
	const env = liveEnv();
	const facts = { endpoint: { local: true }, dockerCode: 0, imageCode: 0, jobImage: "pi-job:latest", triggerImages: [], egress: { armed: false, results: [] }, jobUser: { run: true, user: "1234:1234" } };
	const fixes = [];
	for (const [label, over, fsUid, pattern] of [
		["job-unreadable", { [`docker exec ${LIVE_ID} sh -c [ -r /job ]`]: { code: 0, output: "job-unreadable\n" } }, 1234, /cannot list a 0700 job directory/],
		["mount-not-writable", { [`docker exec ${LIVE_ID} sh -c [ -r /job ]`]: { code: 0, output: "not-writable /outbox\n" } }, 1234, /outbox or session mount/],
		["not-yours", {}, 999, /owned by another uid, so the worker cannot remove/],
	]) {
		const checks = await liveChecks(env, { spawn: fakeSpawn({ ...liveOk({ uid: "1234" }), ...over, ...green }), liveFs: liveFsAs(fsUid), isAlive: () => false, pid: 1, nonce: "n", jobUserIdentity: LINUX_ID(1234) }, facts);
		const folders = checks.find((c) => /localFolders does NOT hold/.test(c.label));
		assert.ok(folders, `${label}: ${checks.map((c) => c.label).join("\n")}`);
		assert.match(folders.fix, pattern, label);
		fixes.push(folders.fix);
	}
	assert.equal(new Set(fixes).size, 3, "three causes, three fixes: none falls back to the generic one");
	// A sudo'd doctor is not the worker, and root can remove anything: no owner comparison, so no false not-yours.
	const root = await liveChecks(env, { spawn: fakeSpawn({ ...liveOk({ uid: "1234" }), ...green }), liveFs: liveFsAs(999), isAlive: () => false, pid: 1, nonce: "n", jobUserIdentity: { platform: "darwin", euid: 0, egid: 0 } }, facts);
	assert.ok(!root.some((c) => /not-yours|owned by another uid/.test(`${c.label} ${c.fix ?? ""}`)));
	assert.match(root.at(-1).label, /the host owner of what the probe wrote was not compared, because doctor ran as root/, "and the limits line says so");
	const shell = await liveChecks(env, { spawn: fakeSpawn({ ...liveOk({ uid: "1234" }), ...green }), liveFs: liveFsAs(1234), isAlive: () => false, pid: 1, nonce: "n", jobUserIdentity: LINUX_ID(1234) }, facts);
	assert.doesNotMatch(shell.at(-1).label, /was not compared/, "only a root run says it");
});

test("doctor and the worker read ONE set of boot-refusing causes, and doctor waits as long as the worker for docker info (#341)", async () => {
	const { BOOT_REFUSING_JOB_USER_CAUSES, DAEMON_FACTS_TIMEOUT_MS } = await import("../src/job-user.mjs");
	assert.deepEqual([...BOOT_REFUSING_JOB_USER_CAUSES].sort(), ["desktop-linux-userns", "rootless", "userns-remap", "worker-is-root"]);
	for (const file of ["doctor.mjs", "start.mjs"]) {
		const source = readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");
		assert.doesNotMatch(source, /const BOOT_REFUSING_JOB_USER_CAUSES\s*=/, `${file} keeps no copy of its own`);
		assert.match(source, /import \{[^}]*BOOT_REFUSING_JOB_USER_CAUSES[^}]*\} from "\.\/job-user\.mjs"/, `${file} imports the one set`);
	}
	assert.equal(DAEMON_FACTS_TIMEOUT_MS, 15_000);
	const doctorSource = readFileSync(new URL("../src/doctor.mjs", import.meta.url), "utf8");
	assert.match(doctorSource, /makeDaemonFactsReader\(\{ run: dockerRunVia\(spawn, DAEMON_FACTS_TIMEOUT_MS\) \}\)/, "a shorter doctor bound calls undecidable a host the worker decides");
});

test("every boot-refusing cause is a ✗ and exit 1 in doctor, through doctor's own severity, never a text match (#341)", async () => {
	const { BOOT_REFUSING_JOB_USER_CAUSES } = await import("../src/job-user.mjs");
	const USERNS_INFO = JSON.stringify({ ServerVersion: "27.5.1", OperatingSystem: "Ubuntu 24.04", SecurityOptions: ["name=seccomp,profile=builtin", "name=userns"] });
	const DESKTOP_INFO = JSON.stringify({ ServerVersion: "27.4.0", OperatingSystem: "Docker Desktop", SecurityOptions: ["name=seccomp,profile=unconfined"] });
	const fixtures = {
		rootless: [ROOTLESS_INFO, LINUX_ID(1234)],
		"userns-remap": [USERNS_INFO, LINUX_ID(1234)],
		"worker-is-root": [ROOTFUL_INFO, LINUX_ID(0)],
		"desktop-linux-userns": [DESKTOP_INFO, LINUX_ID(1234)],
	};
	assert.deepEqual(Object.keys(fixtures).sort(), [...BOOT_REFUSING_JOB_USER_CAUSES].sort(), "one fixture per cause the worker refuses to boot on");
	for (const [cause, [body, ids]] of Object.entries(fixtures)) {
		const { out, text } = capture();
		const code = await runDoctor(ghEnv(), { ...ghDeps(out, { ...infoPlan(body), ...green }), jobUserIdentity: ids, stat: () => ({ uid: 0, gid: 2375 }) });
		assert.equal(code, 1, `${cause}: ${text()}`);
		assert.match(text(), new RegExp(`✗ local: no job can run as a non-root user that owns its files on this daemon \\(${cause}\\)`), cause);
	}
});

test("doctor waits for docker info as long as the worker does: no kill at 5 s, a kill at 15 s (#341)", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let killed = false;
	let asked = false;
	const hanging = (cmd, args) => {
		const child = { stdout: { on() {} }, stderr: { on() {} }, on() { return child; }, kill: () => (killed = true) };
		if (args[0] === "info") asked = true;
		return child;
	};
	const pending = jobUserChecks({}, { spawn: hanging, cwd: "/nowhere", home: "/nowhere", fileExists: () => false, platform: "linux", jobUserIdentity: LINUX_ID(1234) }, { endpoint: { local: true, endpoint: "unix:///run/pd-test.sock" }, dockerCode: 0, imageCode: 0, jobImage: "pi-job:latest" });
	for (let i = 0; i < 5 && !asked; i++) await new Promise((r) => setImmediate(r));
	assert.ok(asked, "the facts read started");
	t.mock.timers.tick(5_001);
	assert.equal(killed, false, "the endpoint read's 5 s is not this read's bound");
	t.mock.timers.tick(9_998);
	assert.equal(killed, false, "nor anything short of 15 s");
	t.mock.timers.tick(1);
	assert.equal(killed, true, "15 s exactly, the worker's DAEMON_FACTS_TIMEOUT_MS");
	const result = await pending;
	assert.match(result.checks[0].label, /could not be decided \(timeout\)/);
});

// --- issue #344: the ephemeral pair and the peers, through doctor ---------------------------------------------------

const PEER1_ID = "b".repeat(64);
const PEER2_ID = "c".repeat(64);
const instantClock = () => {
	let t = 0;
	return { now: () => t, delay: async (ms) => (t += ms) };
};
/** The peer phase's docker answers: two job networks, two peers, and connection results `reach` decides. */
function livePeersOk({ reach = () => "enetunreach" } = {}) {
	let net2 = null;
	return {
		"docker run --name=pi-dispatch-live-peer1-": { code: 0, output: `${PEER1_ID}\n` },
		"docker run --name=pi-dispatch-live-peer2-": (_cmd, args) => {
			net2 = args.find((a) => a.startsWith("--network=")).slice("--network=".length);
			return { code: 0, output: `${PEER2_ID}\n` };
		},
		"docker inspect --format={{json .NetworkSettings.Networks}}": () => ({ code: 0, output: JSON.stringify({ [net2]: { IPAddress: "10.99.0.3", DNSNames: ["pi-dispatch-live-peer2-1-n"] } }) }),
		[`docker exec ${PEER1_ID} node --eval`]: (_cmd, args) => ({ code: 0, output: args.slice(6).map((t) => `${t} ${t.includes(":3128") ? "connected" : reach(t)}`).join("\n") }),
		[`docker exec ${PEER2_ID} node --eval`]: (_cmd, args) => ({ code: 0, output: args.slice(6).map((t) => `${t} reached`).join("\n") }),
		"docker rm -f": 0,
	};
}

test("doctor's facts carry the proxy's name and whether it is up, so --live's peers know without asking again (#344)", async () => {
	const facts = {};
	await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" }, { ...collectSeams(green), facts });
	assert.equal(facts.egress.armed, true);
	assert.deepEqual([facts.egress.proxy, facts.egress.proxyRunning], ["pi-dispatch-egress-proxy", true]);
	const stopped = {};
	await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" }, { ...collectSeams({ ...green, "docker inspect --format={{.State.Running}}": { code: 0, output: "false|none\n" } }), facts: stopped });
	assert.equal(stopped.egress.proxyRunning, false);
	const off = {};
	await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_EGRESS: "0" }, { ...collectSeams(green), facts: off });
	assert.deepEqual([off.egress.armed, off.egress.proxyRunning], [false, null], "not read is null, never a guessed false");
});

test("doctor --live with the policy armed reads jobToJobIsolation back through two peers, and a reach is a hard failure with its own fix (#344)", async () => {
	const env = liveEnv({ PI_EGRESS: "1" });
	const facts = { endpoint: { local: true }, dockerCode: 0, imageCode: 0, jobImage: "pi-job:latest", triggerImages: [], egress: { armed: true, results: [{ property: "egress", want: true, reached: true }, { property: "egress", want: false, reached: false }], proxy: "pi-dispatch-egress-proxy", proxyRunning: true } };
	const seams = (plan) => ({ spawn: fakeSpawn({ ...liveOk(), ...livePeersOk(plan), ...green }), liveFs: liveFsAs(1001), isAlive: () => false, pid: 1, nonce: "n", jobUserIdentity: LINUX_1001, ...instantClock() });
	const held = await liveChecks(env, seams({}), facts);
	assert.ok(held.some((c) => c.ok && /jobToJobIsolation holds \(peer1 reached the proxy and none of peer2's/.test(c.label)), held.map((c) => c.label).join("\n"));
	assert.match(held.at(-1).label, /jobToJobIsolation tried one pair of peers/);

	const reached = await liveChecks(env, seams({ reach: (t) => (t.startsWith("10.") ? "reached" : "eai_again") }), facts);
	const failed = reached.find((c) => /jobToJobIsolation does NOT hold/.test(c.label));
	assert.ok(failed && !failed.warn, reached.map((c) => c.label).join("\n"));
	assert.match(failed.fix, /reached another's across their own --internal networks/);
	assert.match(reached.at(-1).label, /jobToJobIsolation tried one pair of peers/, "a reach needed both peers started, so the limit still applies to it");

	const noAddress = await liveChecks(env, { ...seams({}), spawn: fakeSpawn({ ...liveOk(), ...livePeersOk({}), "docker inspect --format={{json .NetworkSettings.Networks}}": { code: 1, output: "" }, ...green }) }, facts);
	assert.ok(noAddress.some((c) => c.warn && /jobToJobIsolation not read back/.test(c.label)));
	assert.doesNotMatch(noAddress.at(-1).label, /tried one pair of peers/, "peers that were not read back are not claimed as tried");
	const proxyDown = await liveChecks(env, seams({}), { ...facts, egress: { ...facts.egress, proxyRunning: false } });
	assert.match(proxyDown.at(-1).label, /jobToJobIsolation needs the egress proxy running/);
	const unreadable = await liveChecks(env, seams({}), { ...facts, egress: { ...facts.egress, armed: null } });
	assert.ok(unreadable.some((c) => c.warn && /jobToJobIsolation not read back: PI_EGRESS could not be read/.test(c.label)), unreadable.map((c) => c.label).join("\n"));
	assert.doesNotMatch(unreadable.at(-1).label, /needs PI_EGRESS armed|tried one pair of peers/, "a malformed PI_EGRESS is not said to be off, and no peers are claimed");
});

test("doctor --live gives each ephemeral failure its own fix: a survivor, a held name, a reused container, residue (#344)", async () => {
	const env = liveEnv();
	const facts = { endpoint: { local: true }, dockerCode: 0, imageCode: 0, jobImage: "pi-job:latest", triggerImages: [], egress: { armed: false, results: [] } };
	const writeMarker = (args, body) => {
		const ws = args.flatMap((a, i) => (args[i - 1] === "-v" ? [a] : [])).find((v) => v.split(":")[1] === "/workspace").split(":")[0];
		writeFileSync(join(ws, `.pi-dispatch-live-ephemeral-${args.at(-1)}`), body ?? args.at(-2));
	};
	let second = 0;
	const cases = {
		survived: { "docker ps -a --no-trunc --filter id=": (_c, args) => ({ code: 0, output: `${args.at(-3).slice(3)} exited\n` }) },
		"name-held": {
			"docker run --name=pi-dispatch-live-ephemeral-": (_c, args) => (args.at(-1) === "1" ? (writeMarker(args), { code: 0, output: `${"1".repeat(64)}\n` }) : { code: 125, output: 'docker: Error response from daemon: Conflict. The container name "/x" is already in use by container "0123".' }),
		},
		reused: { "docker run --name=pi-dispatch-live-ephemeral-": (_c, args) => (writeMarker(args), { code: 0, output: `${"9".repeat(64)}\n` }) },
		residue: { "docker run --name=pi-dispatch-live-ephemeral-": (_c, args) => (writeMarker(args, args.at(-1) === "2" ? "residue" : undefined), second++, { code: 0, output: `${args.at(-1).repeat(64)}\n` }) },
	};
	const fixes = new Set();
	for (const [cause, over] of Object.entries(cases)) {
		const checks = await liveChecks(env, { spawn: fakeSpawn({ ...liveOk(), ...over, ...green }), liveFs: liveFsAs(1001), isAlive: () => false, pid: 1, nonce: "n", jobUserIdentity: LINUX_1001, ...instantClock() }, facts);
		const failed = checks.find((c) => /ephemeral does NOT hold/.test(c.label));
		assert.ok(failed, `${cause}: ${checks.map((c) => c.label).join("\n")}`);
		assert.ok(!failed.warn, cause);
		assert.ok(typeof failed.fix === "string" && failed.fix.length > 0, `${cause}: a fix of its own, never undefined`);
		assert.doesNotMatch(checks.at(-1).label, /ephemeral ran two short-lived containers/, `${cause}: the limits line does not claim two runs held`);
		fixes.add(failed.fix);
		if (cause === "name-held") {
			assert.match(failed.fix, /removed whatever held the name/, "the fix does not send the operator to inspect a container the read-back already removed");
			// The Podman half, unpinned until issue #352: `podman ps -a --external` is the only listing that
			// shows a storage container another tool made, and a name reservation left by one is exactly what
			// this cause means on that runtime. Checked on Podman 5.8.2. Without it the line sends an
			// operator to `ps -a`, which shows nothing, and the reservation looks like a daemon bug.
			assert.match(failed.fix, /podman ps -a --external/, "the Podman listing that actually shows the holder");
		}
	}
	assert.equal(fixes.size, 4, "four causes, four fixes, none falling back to a generic one");
});

// --- issue #345: the runtime observations -------------------------------------------------------------------------

const PODMAN_COMPAT_INFO = JSON.stringify({ ServerVersion: "5.8.2", OperatingSystem: "fedora", SecurityOptions: ["name=seccomp,profile=default"], PidsLimit: true, MemoryLimit: true, CpuCfsQuota: false, ProductLicense: "Apache-2.0" });
const DESKTOP_INFO = JSON.stringify({ ServerVersion: "27.4.0", OperatingSystem: "Docker Desktop", SecurityOptions: ["name=seccomp,profile=unconfined"], PidsLimit: true, MemoryLimit: true });
const SHIM_INFO = JSON.stringify({ host: { os: "linux", security: { rootless: false }, serviceIsRemote: true, remoteSocket: { path: "unix:///run/podman/podman.sock", exists: true } }, version: { Version: "5.8.2" } });
const noHostFiles = (() => {
	const missing = (p) => {
		throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
	};
	return { statSync: missing, readFileSync: missing, readdirSync: missing };
})();
const withOverride = { ...noHostFiles, statSync: (p) => (p === "/etc/containers/mounts.conf" ? { size: 0 } : noHostFiles.statSync(p)) };

test("doctor says isolation and mountSet are ASSERTED where the runtime is not observed providing them, with what was seen (#345)", () => {
	const endpoint = { local: true, context: "podman", endpoint: "unix:///run/podman/podman.sock" };
	const read = (body) => ({ answered: true, facts: parseDaemonFacts(body).facts });
	const find = (checks, property) => checks.find((c) => c.label.startsWith(`local: ${property} is ASSERTED`));
	const podman = backendChecks({}, { endpoint, daemon: read(PODMAN_COMPAT_INFO), fs: noHostFiles });
	const bounds = find(podman, "isolation");
	assert.deepEqual([bounds.ok, bounds.warn], [false, true]);
	assert.match(bounds.label, /isolation is ASSERTED by the daemon, not enforced: the daemon is Podman, whose Docker API reports PidsLimit and MemoryLimit/);
	assert.match(bounds.fix, /doctor --live` reads pids\.max and memory\.max/);
	assert.match(bounds.fix, /worker_started\.daemonAppliesBounds/);
	const mounts = find(podman, "mountSet");
	assert.match(mounts.label, /mountSet is ASSERTED by the container runtime's configuration, not enforced: \/etc\/containers\/mounts\.conf does not exist/);
	assert.match(mounts.fix, /create an empty \/etc\/containers\/mounts\.conf/);
	assert.equal(find(backendChecks({}, { endpoint, daemon: read(PODMAN_COMPAT_INFO), fs: withOverride }), "mountSet"), undefined, "the documented override earns mountSet");
	const docker = backendChecks({}, { endpoint: { local: true, endpoint: "unix:///var/run/docker.sock" }, daemon: read(ROOTFUL_INFO), fs: noHostFiles });
	assert.equal(find(docker, "isolation") ?? find(docker, "mountSet"), undefined, "a rootful Docker Engine reporting both bounds stays quiet");
	const unread = backendChecks({}, { endpoint, daemon: { answered: false, reason: "timeout", transient: true }, fs: noHostFiles });
	assert.match(find(unread, "isolation").label, /the daemon's info was not read \(timeout\)/);
	assert.match(find(unread, "isolation").fix, /fix what stops the daemon answering/);
	const down = backendChecks({}, { endpoint, daemon: null, fs: noHostFiles });
	assert.equal(find(down, "isolation") ?? find(down, "mountSet"), undefined, "no daemon read at all: the daemon line already failed, and these would only repeat it");
});

test("doctor names each floor miss with the observation it needed and that observation's remedy only (#345)", () => {
	const endpoint = { local: true, context: "podman", endpoint: "unix:///run/podman/podman.sock" };
	const daemon = { answered: true, facts: parseDaemonFacts(PODMAN_COMPAT_INFO).facts };
	const checks = backendChecks({ PI_BACKEND_FLOOR: "isolation=enforced,mountSet=enforced" }, { endpoint, daemon, fs: noHostFiles });
	const floor = checks.find((c) => /PI_BACKEND_FLOOR asks for/.test(c.label));
	assert.deepEqual([floor.ok, floor.warn], [false, undefined], "a floor miss is a ✗, as the worker refuses to boot on it");
	assert.match(floor.label, /isolation=enforced \(local provides it only while the daemon reports that it applies/);
	assert.match(floor.label, /mountSet=enforced \(local provides it only while the container runtime adds no mounts/);
	assert.match(floor.fix, /doctor --live` reads pids\.max/);
	assert.match(floor.fix, /create an empty \/etc\/containers\/mounts\.conf/);
	assert.doesNotMatch(floor.fix, /Point the docker CLI back/);
	const held = backendChecks({ PI_BACKEND_FLOOR: "mountSet=enforced" }, { endpoint, daemon, fs: withOverride });
	assert.ok(held.some((c) => c.ok && /PI_BACKEND_FLOOR holds \(mountSet=enforced\)/.test(c.label)));
	// True on the failure path: nothing answered means the worker retries, and the remedy is an answer, not a new host.
	const unread = backendChecks({ PI_BACKEND_FLOOR: "isolation=enforced" }, { endpoint, daemon: { answered: false, reason: "timeout", transient: true }, fs: noHostFiles });
	const retried = unread.find((c) => /PI_BACKEND_FLOOR asks for/.test(c.label));
	assert.match(retried.fix, /exits 1 at boot so the supervisor retries/);
	assert.doesNotMatch(retried.fix, /refuses to boot|rootful Docker Engine/);
	// One ANSWERED miss beside an unanswered one: the worker refuses on the answer, so doctor says so.
	const mixed = backendChecks({ PI_BACKEND_FLOOR: "isolation=enforced,credentialTransit=enforced" }, { endpoint: { local: false, context: "remote", endpoint: "tcp://10.0.0.1:2375" }, daemon: { answered: false, reason: "timeout", transient: true }, fs: noHostFiles });
	assert.match(mixed.find((c) => /PI_BACKEND_FLOOR asks for/.test(c.label)).fix, /refuses to boot/);
	// No docker binary is an answer too, as it is for the worker, and it adds no isolation or mountSet line of its own.
	const noDocker = backendChecks({ PI_BACKEND_FLOOR: "isolation=enforced" }, { endpoint, daemon: { answered: false, reason: "docker-not-found", transient: true }, fs: noHostFiles });
	assert.match(noDocker.find((c) => /PI_BACKEND_FLOOR asks for/.test(c.label)).fix, /refuses to boot/);
	assert.equal(noDocker.find((c) => /local: (isolation|mountSet) is ASSERTED/.test(c.label)), undefined);
});

test("doctor names the runtime that answered, and warns on podman-docker, where the docker CLI resolves no context (#345)", async () => {
	for (const [label, body, ids, pattern, warn] of [
		["Docker Engine", ROOTFUL_INFO, LINUX_ID(1001), /✓ local: the daemon is Docker Engine 27\.5\.1\n/, false],
		["Docker Desktop", DESKTOP_INFO, { platform: "darwin", release: "24.6.0", euid: 501, egid: 20 }, /✓ local: the daemon is Docker Desktop \(engine 27\.4\.0\)/, false],
		["Podman's Docker API", PODMAN_COMPAT_INFO, LINUX_ID(1001), /✓ local: the daemon is Podman 5\.8\.2, through its Docker API/, false],
		["podman-docker", SHIM_INFO, LINUX_ID(1001), /⚠ local: the daemon is Podman 5\.8\.2, reached through podman-docker/, true],
	]) {
		const { out, text } = capture();
		await runDoctor(ghEnv(), { ...ghDeps(out, { ...infoPlan(body), ...green }), jobUserIdentity: ids, stat: socketStat, observationFs: noHostFiles });
		assert.match(text(), pattern, label);
		if (warn) assert.match(text(), /docker context create podman --docker host=unix:\/\/\/run\/podman\/podman\.sock/, label);
	}
});

test("doctor parses the proxy's state and this host's image id from stdout only, so podman-docker's stderr banner cannot flip them (#345)", async () => {
	const banner = "Emulate Docker CLI using podman. Create /etc/containers/nodocker to quiet msg.\n";
	const { out, text } = capture();
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, egressPlan({ "docker inspect --format={{.State.Running}}": { code: 0, output: "true|healthy\n", stderr: banner }, "gh auth status": { code: 0, output: ghStatusOutput } })));
	assert.match(text(), /✓ Egress proxy running \(pi-dispatch-egress-proxy\)/);
	assert.doesNotMatch(text(), /Egress proxy is stopped/);

	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const plan = { ...EGRESS_OK, "docker info": 0, "docker image inspect --format={{.Id}}": { code: 0, output: "sha256:same\n", stderr: banner }, "docker image": 0 };
	const same = await collectChecks({ VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1" }, collectSeams(plan, { nodeVersion: "22.19.0", readHosts: async () => ({ hosts: [{ name: "mini2", tz, imageDigest: "sha256:same" }] }) }));
	assert.ok(!same.some((c) => /digest differs/.test(c.label)), "the banner is not read as part of the id");
});

test("doctor with no docker binary passes that answer to the floor check, so it says the worker refuses rather than retries (#345)", async () => {
	const { out, text } = capture();
	await runDoctor(ghEnv({ PI_BACKEND_FLOOR: "isolation=enforced" }), { ...ghDeps(out, { docker: "enoent" }), observationFs: noHostFiles });
	assert.match(text(), /install Docker/);
	assert.match(text(), /✗ PI_BACKEND_FLOOR asks for isolation=enforced/);
	assert.doesNotMatch(text(), /exits 1 at boot so the supervisor retries/);
});

// --- the egress canary's own leftovers (issue #350) --------------------------------------------------
//
// The defect: `runCmdCapture`'s 30 s bound kills the docker CLI, which is not the container it started, so a
// wedged proxy leaves a probe running on the canary network; the `finally`'s `network rm` then fails because
// a member is still attached, and nothing inspected either result. The network survived every later run.

/** A canary plan whose `unlisted` probe never finishes, which is the wedged-proxy shape #350 measured. */
const wedgedProbe = { ...green, "docker run --rm --name pi-dispatch-egress-probe-unlisted": { code: null, output: "" } };

test("doctor: a canary probe whose CLI never finished is removed BY NAME, and only that one (#350)", async () => {
	const calls = [];
	const { out } = capture();
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, { ...wedgedProbe, "gh auth status": { code: 0, output: ghStatusOutput } }, calls));
	const rms = calls.filter((c) => c.args[0] === "rm").map((c) => c.args.join(" "));
	assert.deepEqual(rms, [`rm -f pi-dispatch-egress-probe-unlisted-${process.pid}`], "only the probe whose CLI did not finish");
});

test("doctor: a probe name TAKEN by another doctor (125) is never removed -- it is not ours to kill (#350)", async () => {
	// 125 is a name clash, so the container under that name belongs to a doctor that is still running.
	const calls = [];
	const { out } = capture();
	await runDoctor(
		ghEnv({ PI_EGRESS: "1" }),
		ghDeps(out, { ...green, "docker run --rm --name pi-dispatch-egress-probe-unlisted": 125, "gh auth status": { code: 0, output: ghStatusOutput } }, calls),
	);
	assert.deepEqual(calls.filter((c) => c.args[0] === "rm"), [], "a clash means someone else owns that name");
});

test("doctor: a canary network that will not go is a WARNING carrying the command (#350)", async () => {
	const { out, text } = capture();
	const code = await runDoctor(
		ghEnv({ PI_EGRESS: "1" }),
		ghDeps(out, { "docker network rm": 1, "docker network inspect": { code: 1, output: "", stderr: "Cannot connect to the Docker daemon" }, ...green, "gh auth status": { code: 0, output: ghStatusOutput } }),
	);
	assert.equal(code, 0, "a leftover warns, it does not fail doctor");
	assert.match(text(), new RegExp(`⚠ Egress canary: the network pi-dispatch-egress-doctor-${process.pid} could not be removed: docker network rm pi-dispatch-egress-doctor-${process.pid}`));
	assert.match(text(), /remove whatever is still on it first \(a probe container under `pi-dispatch-egress-probe-`\), then the network/);
});

test("doctor: a canary network the daemon says is gone is not a line at all (#350)", async () => {
	const { out, text } = capture();
	await runDoctor(
		ghEnv({ PI_EGRESS: "1" }),
		ghDeps(out, { "docker network rm": 1, "docker network inspect": (cmd, args) => ({ code: 1, output: "", stderr: `Error response from daemon: network ${args.at(-1)} not found` }), ...green, "gh auth status": { code: 0, output: ghStatusOutput } }),
	);
	assert.doesNotMatch(text(), /could not be removed/, "the one silence this allows, in the daemon's own words");
});

test("doctor: a DEAD doctor's canary network is swept, its probe removed and the network taken without -f (#350)", async () => {
	const calls = [];
	const { out, text } = capture();
	const plan = {
		"docker network ls --filter name=pi-dispatch-egress-doctor-": { code: 0, output: "pi-dispatch-egress-doctor-4242\npi-dispatch-egress-doctor-4242-extra\n" },
		"docker network inspect --format {{json .Containers}} pi-dispatch-egress-doctor-4242": { code: 0, output: '{"a":{"Name":"pi-dispatch-egress-probe-unlisted-4242"},"b":{"Name":"pi-dispatch-egress-proxy"}}' },
		// Explicit: an unplanned command answers `undefined`, and `removed` now records only what exited 0.
		"docker rm -f": 0,
		...green,
		"gh auth status": { code: 0, output: ghStatusOutput },
	};
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, plan, calls, { isAlive: () => false, pid: 1 }));
	assert.match(text(), /✓ Egress canary: removed pi-dispatch-egress-doctor-4242 \(after removing pi-dispatch-egress-probe-unlisted-4242 and detaching pi-dispatch-egress-proxy\), left by an EARLIER doctor run/);
	const touched = calls.map((c) => c.args.join(" "));
	assert.ok(touched.includes("rm -f pi-dispatch-egress-probe-unlisted-4242"), "the dead run's own probe IS the leak, so it is removed");
	assert.ok(touched.includes("network disconnect -f pi-dispatch-egress-doctor-4242 pi-dispatch-egress-proxy"), "the shared proxy is detached");
	assert.ok(!touched.some((t) => t.startsWith("rm -f pi-dispatch-egress-proxy")), "and NEVER removed: it is long-lived and shared");
	assert.ok(!touched.some((t) => t.startsWith("network rm -f")), "never `network rm -f`");
	assert.ok(!touched.some((t) => t.includes("4242-extra")), "the name shape is ANCHORED: a longer name is not this namespace");
});

test("doctor: a canary network whose pid is still ALIVE is left entirely alone (#350)", async () => {
	const calls = [];
	const { out, text } = capture();
	const plan = { "docker network ls --filter name=pi-dispatch-egress-doctor-": { code: 0, output: "pi-dispatch-egress-doctor-4242\n" }, ...green, "gh auth status": { code: 0, output: ghStatusOutput } };
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, plan, calls, { isAlive: () => true, pid: 1 }));
	assert.doesNotMatch(text(), /left by an EARLIER doctor run/);
	assert.ok(!calls.some((c) => c.args.join(" ").includes("4242")), "a live doctor's network is its own business");
});

test("doctor: the canary's bounds are pinned as NUMBERS, not derived (#350)", async () => {
	// A constant-derived assertion is correct at any value and therefore blind to a change IN that value: an
	// adversarial pass set this bound to 1ms and the whole doctor suite stayed green, which in production makes
	// every canary network read "could not be read" and none is ever removed. Pinned as a literal, the way
	// PROTECTED_SKILL_ROOTS is, so moving it is a deliberate edit to this line.
	const src = readFileSync(new URL("../src/doctor.mjs", import.meta.url), "utf8");
	assert.match(src, /const CANARY_STEP_TIMEOUT_MS = 10_000;/, "10s: long enough for a network call, short enough that a wedged daemon does not own the doctor run");
	// And it must stay BELOW the probes' own bound, or the teardown becomes the slow part of a doctor run.
	assert.match(src, /const \{ timeoutMs = 30000, stdoutOnly = false \} = opts;/, "runCmdCapture's probe bound");
});

// A COUNT, deliberately, and not a match over the page's prose. `docs/egress.md` described three canary line
// shapes while doctor produced six, and the page went a whole round without anyone noticing (issue #360,
// item 2). The obvious repair is a test that reads each label out of the source and requires the page to
// carry it; that is the arms race `podman-doc.test.mjs:14-32` lost four rounds running, and these labels are
// worse subjects for it than that page's were -- several begin with `${name}`, and one nests a template
// inside itself, so there is no honest static text to require. So this pins the ONE thing that is both
// derivable and sufficient: how many places in doctor produce a line under this prefix. What each line SAYS
// is the page's own job and is not pinned here, and saying so is the point: a green regex over a false
// sentence is worse than no test.
//
// A COUNT, deliberately, and not a match over the page's prose. `docs/egress.md` described three canary line
// shapes while doctor produced six, and the page went a whole round without anyone noticing (issue #360,
// item 2). The obvious repair is a test that reads each label out of the source and requires the page to
// carry it: that is the arms race `podman-doc.test.mjs:14-32` lost four rounds running, and these labels are
// worse subjects for it than that page's were, since several begin with `${name}` and one nests a template
// inside itself. What each line SAYS stays the page's own job, unpinned on purpose, because a green regex
// over a false sentence is worse than no test.
//
// ONE NEEDLE, AND ITS LIMIT STATED RATHER THAN FOUGHT. This counts sites written the way all eight existing
// ones are written, and nothing else. Two cleverer versions were tried and both failed in their own
// direction, which is why the simple one is here: adding a raw-source count caught four more spellings and
// introduced a FALSE RED, because this file's house style is to quote its own output in comments, so one
// comment naming the prefix told its author to rewrite their prose as a label; and stripping comments first
// to fix that introduced a FALSE GREEN at thirty times the scale, because `/\*[\s\S]*?\*\/` treats the `/*`
// inside `mv ${legacy}/logs/*` and inside a quoted `*.service.d/*.conf` as comment openers and deleted 88
// lines of live code before counting. A test that silently stops looking at part of the file is worse than
// one with a limit written on it.
//
// SO: a site spelled any other way is invisible here -- a constant holding the prefix, a plain double-quoted
// string, `label:` wrapped onto its own line or given two spaces, an interpolation or a `\u` escape inside
// the phrase, or a label built in another module. The eight that exist are uniform, and the next one is
// expected to match them; if it does not, this test says nothing and the page goes stale again. That is the
// accepted cost of not shipping a stripper that eats code. The FALSE RED is narrowed and not gone either:
// the count reads raw source, so a comment or a string elsewhere in doctor.mjs that spells the needle
// exactly still trips it. That direction is SAFE -- it fails loudly and a reader can see why -- which is the
// only reason it is tolerated where the false green was not.
test("every `Egress canary:` line in doctor is accounted for on docs/egress.md (#360)", () => {
	const src = readFileSync(new URL("../src/doctor.mjs", import.meta.url), "utf8");
	const doc = readFileSync(new URL("../../docs/egress.md", import.meta.url), "utf8");
	const sites = src.split("label: `Egress canary: ").length - 1;
	const claimed = Number(/<!-- CANARY-LINE-SITES: (\d+) -->/.exec(doc)?.[1]);
	assert.equal(sites, claimed, `doctor produces ${sites} canary lines; docs/egress.md is written for ${claimed}. Update the page, then the marker.`);
	// The page must not quote a sentence no site can emit. It did: three code sites were reworded away from
	// "left by a doctor run that did not finish" and both of the page's own ✓ rows kept it, in a commit that
	// had one of those rows open for a different edit. One retired phrase, named, because this is the fourth
	// time on this branch that a correction landed everywhere except the page.
	for (const retired of ["left by a doctor run that did not finish", "the network itself was already gone", "from an interrupted doctor"]) {
		assert.ok(!doc.includes(retired), `docs/egress.md still quotes a line doctor cannot print: ${retired}`);
	}
	// Two of those sites share one shape (`could not be removed`, from the sweep and from the teardown), which
	// is why the page describes seven shapes and this counts eight sites. Stated here rather than derived:
	// telling two identical template literals apart needs a parser, and a parser over source is the same arms
	// race this test exists to refuse.
	assert.equal(sites, 8, "a deliberate edit, not a derived number: change it with the page");
});

test("doctor: a canary network that could not be READ names the command that failed (#350, #360)", async () => {
	// This file's convention is that a label carries the command that FAILED. This line carried
	// `docker network rm`, which never ran -- and which is advice about a network whose membership is by
	// definition unknown, so following it could strand a probe nothing else can find. The advice stays in the
	// fix line, which is where advice lives (issue #360, item 3).
	const calls = [];
	const { out, text } = capture();
	const plan = {
		"docker network ls --filter name=pi-dispatch-egress-doctor-": { code: 0, output: "pi-dispatch-egress-doctor-4242\n" },
		"docker network inspect --format {{json .Containers}} pi-dispatch-egress-doctor-4242": { code: 0, output: "not json" },
		...green,
		"gh auth status": { code: 0, output: ghStatusOutput },
	};
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, plan, calls, { isAlive: () => false, pid: 1 }));
	assert.match(text(), /⚠ Egress canary: the network pi-dispatch-egress-doctor-4242 could not be read: docker network inspect pi-dispatch-egress-doctor-4242/);
	assert.doesNotMatch(text(), /could not be read: docker network rm/, "the label never carries a command that did not run");
	assert.ok(!calls.some((c) => c.args.slice(0, 2).join(" ") === "network rm" && c.args.at(-1) === "pi-dispatch-egress-doctor-4242"), "and nothing removes it either");
});

test("doctor: probes removed off a network that then vanished are still accounted for (#360)", async () => {
	// The silence a vanished network earns covers the NETWORK, not the containers this pass already removed.
	// `removeNetworkOrSay` answers `{ removed: true, absent: true }` when its `rm` failed and the daemon then
	// said the network is not there, and neither of the two branches fired on it: the probes were gone and
	// nothing said so. `${name}` is deliberately not the subject of the line -- it is the one object here that
	// is not news.
	const { out, text } = capture();
	const plan = {
		"docker network ls --filter name=pi-dispatch-egress-doctor-": { code: 0, output: "pi-dispatch-egress-doctor-4242\n" },
		"docker network inspect --format {{json .Containers}} pi-dispatch-egress-doctor-4242": { code: 0, output: '{"a":{"Name":"pi-dispatch-egress-probe-unlisted-4242"}}' },
		"docker rm -f": 0,
		// The `rm` fails and the follow-up inspect gets the daemon's own not-found words, which is the shape
		// that reaches the `absent` branch.
		"docker network rm pi-dispatch-egress-doctor-4242": { code: 1, output: "" },
		"docker network inspect pi-dispatch-egress-doctor-4242": { code: 1, output: "Error response from daemon: network pi-dispatch-egress-doctor-4242 not found" },
		...green,
		"gh auth status": { code: 0, output: ghStatusOutput },
	};
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, plan, [], { isAlive: () => false, pid: 1 }));
	assert.match(text(), /✓ Egress canary: removed pi-dispatch-egress-probe-unlisted-4242 on pi-dispatch-egress-doctor-4242, left by an EARLIER doctor run; the network itself is gone/);
	assert.doesNotMatch(text(), /⚠ Egress canary: the network pi-dispatch-egress-doctor-4242 could not be removed/, "a network the daemon says is gone is not a failure");
});

test("a stranger DETACHED off a network that then vanished is named, with no probe of ours in the pass (#360)", async () => {
	// The half the first version of this branch missed, and the one the contract promises loudest: a container
	// this project did not make is force-detached and NAMED, never removed. With no probe of ours to remove,
	// `removed` is empty, so a line gated on removals alone printed nothing at all while a live stranger had
	// just lost its only network. That is a worse silence than the one the branch was written to close.
	const calls = [];
	const { out, text } = capture();
	const plan = {
		"docker network ls --filter name=pi-dispatch-egress-doctor-": { code: 0, output: "pi-dispatch-egress-doctor-4242\n" },
		"docker network inspect --format {{json .Containers}} pi-dispatch-egress-doctor-4242": { code: 0, output: '{"a":{"Name":"their-worker"}}' },
		"docker network rm pi-dispatch-egress-doctor-4242": { code: 1, output: "" },
		"docker network inspect pi-dispatch-egress-doctor-4242": { code: 1, output: "Error response from daemon: network pi-dispatch-egress-doctor-4242 not found" },
		...green,
		"gh auth status": { code: 0, output: ghStatusOutput },
	};
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, plan, calls, { isAlive: () => false, pid: 1 }));
	assert.ok(calls.some((c) => c.args.slice(0, 2).join(" ") === "network disconnect" && c.args.at(-1) === "their-worker"), "it really was detached");
	assert.match(text(), /✓ Egress canary: detached their-worker on pi-dispatch-egress-doctor-4242, left by an EARLIER doctor run; the network itself is gone/);
});

test("both halves of the vanished-network line are joined so the two lists do not run together (#360)", async () => {
	// The only state the join is visible in, and nothing drove it: one test drives `removed` alone and another
	// drives `detached` alone, so reverting `" and "` to `", "` survived the whole suite. With both lists
	// populated a comma gives `removed a, b, detached c, d`, which marks no boundary between them.
	const { out, text } = capture();
	const plan = {
		"docker network ls --filter name=pi-dispatch-egress-doctor-": { code: 0, output: "pi-dispatch-egress-doctor-4242\n" },
		"docker network inspect --format {{json .Containers}} pi-dispatch-egress-doctor-4242": {
			code: 0,
			output: '{"a":{"Name":"pi-dispatch-egress-probe-provider-4242"},"b":{"Name":"pi-dispatch-egress-probe-unlisted-4242"},"c":{"Name":"their-worker"},"d":{"Name":"their-db"}}',
		},
		"docker rm -f": 0,
		"docker network rm pi-dispatch-egress-doctor-4242": { code: 1, output: "" },
		"docker network inspect pi-dispatch-egress-doctor-4242": { code: 1, output: "Error response from daemon: network pi-dispatch-egress-doctor-4242 not found" },
		...green,
		"gh auth status": { code: 0, output: ghStatusOutput },
	};
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, plan, [], { isAlive: () => false, pid: 1 }));
	assert.match(text(), /✓ Egress canary: removed pi-dispatch-egress-probe-provider-4242, pi-dispatch-egress-probe-unlisted-4242 and detached their-worker, their-db on pi-dispatch-egress-doctor-4242, left by an EARLIER doctor run; the network itself is gone/);
	assert.doesNotMatch(text(), /pi-dispatch-egress-probe-unlisted-4242, detached/, "a comma between the lists would hide where one ends");
});

test("a vanished network with NOTHING done to it is still not a line (#360)", async () => {
	// The other half of the same branch, and the one that keeps it honest. The silence a vanished network
	// earns is real: this sweep and the boot reaper both refuse to speak about a network the daemon says is
	// not there. Without this pin the `did` guard can be deleted with a green suite, and doctor then prints a
	// ✓ with no subject at all.
	const { out, text } = capture();
	const plan = {
		"docker network ls --filter name=pi-dispatch-egress-doctor-": { code: 0, output: "pi-dispatch-egress-doctor-4242\n" },
		"docker network inspect --format {{json .Containers}} pi-dispatch-egress-doctor-4242": { code: 0, output: "{}" },
		"docker network rm pi-dispatch-egress-doctor-4242": { code: 1, output: "" },
		"docker network inspect pi-dispatch-egress-doctor-4242": { code: 1, output: "Error response from daemon: network pi-dispatch-egress-doctor-4242 not found" },
		...green,
		"gh auth status": { code: 0, output: ghStatusOutput },
	};
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, plan, [], { isAlive: () => false, pid: 1 }));
	assert.doesNotMatch(text(), /Egress canary:/, "an empty network that was already gone is the one silence this sweep allows");
});

test("an endpoint that resolves to NOTHING is said as a phrase, not as a gap (#360)", async () => {
	// `docker context create X --docker host=` is accepted by docker 27.4.0 and `context inspect` renders the
	// Host as "". Every site that interpolates an endpoint into "resolves ..., which is not shown to be on
	// this host" then printed "resolves , which is not shown". One helper, four call sites.
	const { out, text } = capture();
	const plan = {
		"docker network ls --filter name=pi-dispatch-egress-doctor-": { code: 0, output: "pi-dispatch-egress-doctor-4242\n" },
		...green,
		"docker context inspect": { code: 0, output: '"X"|""\n' },
		"gh auth status": { code: 0, output: ghStatusOutput },
	};
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, plan, [], { isAlive: () => false, pid: 1 }));
	assert.match(text(), /may be left over from an EARLIER doctor run, and is not swept because this shell's docker CLI resolves an empty endpoint, which is not shown to be on this host/);
	// The sibling site four lines down, which had the identical gap and is fixed by the same helper.
	assert.match(text(), /credentialTransit is ASSERTED by the operator, not enforced: this shell's docker CLI resolves context "X" to an empty endpoint, which is not shown to be on this host/);
	assert.doesNotMatch(text(), /resolves\s*, which is not shown/, "neither site rendered here renders the gap");
	assert.doesNotMatch(text(), /to\s*, which is not shown/, "including the one that names the context");
	// The other two sites the helper covers are driven separately below, because this plan mints no gh token
	// and never reaches the in-image probe, and `start.mjs` is a different module entirely. An earlier version
	// of this test said "no site renders the gap" while measuring half of them.
});

test("the in-image gh probe names an empty endpoint too, not a gap (#360)", async () => {
	// The third of the four sites, and it was UNPINNED: reverting it to `endpoint.endpoint` survived the whole
	// suite, because no other test in this file mints a token and this branch runs only once there is one.
	const { out, text } = capture();
	const plan = {
		...green,
		"docker context inspect": { code: 0, output: '"X"|""\n' },
		"gh auth status": { code: 0, output: ghStatusOutput },
		"gh auth token": { code: 0, output: "gho_dummy\n" },
	};
	await runDoctor(ghEnv({ PI_EGRESS: "0" }), ghDeps(out, plan, [], {}));
	assert.match(text(), /⚠ in-image gh auth: not checked, because this shell's docker CLI resolves an empty endpoint, which is not shown to be on this host, and the probe would send your gh token there/);
	assert.doesNotMatch(text(), /resolves\s*, which is not shown/);
});

test("doctor: the canary sweep removes only a probe whose SLUG it knows (#350)", async () => {
	// `\S+` for the slug would `rm -f` any container under this prefix that happened to end in the dead pid.
	// The slug is a closed set of two, so the matcher says so.
	const calls = [];
	const { out } = capture();
	const plan = {
		"docker network ls --filter name=pi-dispatch-egress-doctor-": { code: 0, output: "pi-dispatch-egress-doctor-4242\n" },
		"docker network inspect --format {{json .Containers}} pi-dispatch-egress-doctor-4242": { code: 0, output: '{"a":{"Name":"pi-dispatch-egress-probe-unlisted-4242"},"b":{"Name":"someone-elses-thing-4242"},"c":{"Name":"pi-dispatch-egress-probe-anything-you-like-4242"}}' },
		"docker rm -f": 0,
		...green,
		"gh auth status": { code: 0, output: ghStatusOutput },
	};
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, plan, calls, { isAlive: () => false, pid: 1 }));
	const removed = calls.filter((c) => c.args[0] === "rm").map((c) => c.args.at(-1));
	assert.deepEqual(removed, ["pi-dispatch-egress-probe-unlisted-4242"], "only a real probe name is removed");
	// Scoped to the SWEPT network: this doctor run also tears down its own canary, which detaches the proxy.
	const detached = calls.filter((c) => c.args.slice(0, 2).join(" ") === "network disconnect" && c.args.includes("pi-dispatch-egress-doctor-4242")).map((c) => c.args.at(-1));
	assert.deepEqual(detached.sort(), ["pi-dispatch-egress-probe-anything-you-like-4242", "someone-elses-thing-4242"], "anything else is merely detached, never deleted");
});

test("doctor: the dead-pid sweep runs ONLY on a daemon this host owns (#350)", async () => {
	// `isAlive` reads THIS process table while the network name came from the DAEMON. On a redirected
	// DOCKER_HOST another doctor's live pid reads as dead here, and its probe and network would be taken out
	// from under it. The in-image gh probe already refuses on exactly this test.
	const calls = [];
	const { out, text } = capture();
	const plan = {
		"docker network ls --filter name=pi-dispatch-egress-doctor-": { code: 0, output: "pi-dispatch-egress-doctor-4242\n" },
		...green,
		// A daemon this shell cannot show is on this host.
		"docker context inspect": { code: 0, output: '"remote"|"tcp://build.example.invalid:2376"\n' },
		"gh auth status": { code: 0, output: ghStatusOutput },
	};
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, plan, calls, { isAlive: () => false, pid: 1 }));
	// The needle is the string the code can ACTUALLY emit. It was `left by a doctor run that did not finish`
	// until three code sites were reworded, at which point both of these assertions passed against any output
	// at all -- the exact vacuity the comment below warns about, in the file that warns about it.
	assert.doesNotMatch(text(), /left by an EARLIER doctor run/, "a leftover there belongs to the doctor that owns that daemon");
	assert.ok(!calls.some((c) => c.args.join(" ").includes("4242")), "and nothing of it is touched");
});

test("doctor: a canary network that was never CREATED gets no teardown line (#350)", async () => {
	// `created` used to be set to true as the first statement in the try, so the flag could never be false and
	// the teardown ran even for a create that cleanly refused. With an unreachable daemon that emits a
	// `could not be removed` instruction for a network that never existed.
	const { out, text } = capture();
	const plan = { "docker network create": 1, "docker network rm": 1, "docker network inspect": { code: 1, output: "", stderr: "Cannot connect to the Docker daemon" }, ...green, "gh auth status": { code: 0, output: ghStatusOutput } };
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, plan, []));
	assert.doesNotMatch(text(), /could not be removed/, "nothing was created, so there is nothing to say about removing it");
});

test("doctor: the probe's name comes from the SEAM, so the producer and the reaper cannot disagree (#350)", async () => {
	// The name is built by `egressCanaryProbe(slug, pid)` at both ends. Built inline from `process.pid` at the
	// producing end, an injected pid would make the cleanup look for a name that was never created -- which is
	// exactly the failure `egress.mjs` owns these names to prevent.
	const calls = [];
	const { out } = capture();
	const wedged = { ...green, "docker run --rm --name pi-dispatch-egress-probe-unlisted": { code: null, output: "" }, "gh auth status": { code: 0, output: ghStatusOutput } };
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, wedged, calls, { pid: 777, isAlive: () => true }));
	const ran = calls.filter((c) => c.args[0] === "run").map((c) => c.args[c.args.indexOf("--name") + 1]);
	assert.deepEqual(ran, ["pi-dispatch-egress-probe-provider-777", "pi-dispatch-egress-probe-unlisted-777"], "the injected pid names the probes");
	assert.deepEqual(calls.filter((c) => c.args[0] === "rm").map((c) => c.args.at(-1)), ["pi-dispatch-egress-probe-unlisted-777"], "and the cleanup looks for that same name");
});

test("doctor: an UNKNOWN daemon does not sweep, and says so rather than going quiet (#350)", async () => {
	// Measured in this repo's own docs: through the podman-docker shim `docker context inspect` prints nothing
	// at all, so `local` is null. Treating unknown as remote made the sweep silently never run on a supported
	// runtime, with no line saying why. The in-image gh probe is the precedent: it refuses AND says.
	const calls = [];
	const { out, text } = capture();
	const plan = {
		"docker network ls --filter name=pi-dispatch-egress-doctor-": { code: 0, output: "pi-dispatch-egress-doctor-4242\n" },
		...green,
		"docker context inspect": { code: 0, output: "" },
		"gh auth status": { code: 0, output: ghStatusOutput },
	};
	const code = await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, plan, calls, { isAlive: () => false, pid: 1 }));
	assert.equal(code, 0, "an unswept leftover warns, it never fails doctor");
	assert.match(text(), /⚠ Egress canary: pi-dispatch-egress-doctor-4242 may be left over from an EARLIER doctor run, and is not swept because this shell's docker CLI did not say which daemon it uses \(unparseable\), so a pid that is dead here may be alive there/);
	// MAY be left over. The same sentence says four words later that the pid may be alive there, so asserting
	// it IS a leftover and then walking that back was the line contradicting itself (issue #360, item 3).
	assert.doesNotMatch(text(), /pi-dispatch-egress-doctor-4242 is left over/, "doctor does not assert what it just said it cannot know");
	// The REASON WORD is the one `credentialTransit` prints below for the same endpoint. The sentences around
	// it still differ ("which daemon it uses" against "which endpoint it resolves", and that one names the
	// context), and the limit is worth stating: issue #360 item 3 asked the canary line to gain a second
	// branch the way those two already had one, which is what happened. The wording copied verbatim is the
	// in-image gh probe's, four hundred lines up, not this one's.
	assert.match(text(), /credentialTransit is ASSERTED by the operator, not enforced: this shell's docker CLI did not say which endpoint it resolves \(unparseable\)/);
	assert.ok(calls.some((c) => c.args.slice(0, 2).join(" ") === "network ls"), "it LOOKS on any daemon: reading a list says nothing about a process table");
	assert.ok(!calls.some((c) => c.args.join(" ").includes("rm") && c.args.join(" ").includes("4242")), "but removes nothing there");
});

test("doctor: a REMOTE daemon is named and left, and the line says WHICH daemon (#350, #360)", async () => {
	// Remote and unknown take the same BRANCH, deliberately: in both cases this shell cannot show the daemon
	// is on this host, which is the only question `isAlive` needs answered. They no longer emit the same
	// LINE, and that is issue #360 item 3: the operator fixing it needs to know whether their CLI is pointed
	// somewhere else or merely mute, and those are two different fixes. The wording is
	// `credentialTransit`'s and the in-image gh probe's, which had the two branches already.
	const { out, text } = capture();
	const plan = {
		"docker network ls --filter name=pi-dispatch-egress-doctor-": { code: 0, output: "pi-dispatch-egress-doctor-4242\n" },
		...green,
		"docker context inspect": { code: 0, output: '"remote"|"tcp://build.example.invalid:2376"\n' },
		"gh auth status": { code: 0, output: ghStatusOutput },
	};
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, plan, [], { isAlive: () => false, pid: 1 }));
	// The needle must be a string the code can actually emit: `are not swept` appears in no doctor output,
	// so this assertion passed against anything at all until it was proven vacuous.
	assert.match(text(), /⚠ Egress canary: pi-dispatch-egress-doctor-4242 may be left over from an EARLIER doctor run, and is not swept because this shell's docker CLI resolves tcp:\/\/build\.example\.invalid:2376, which is not shown to be on this host, so a pid that is dead here may be alive there/, "a leftover there is named, not silently skipped");
	assert.doesNotMatch(text(), /left by an EARLIER doctor run/);
	assert.doesNotMatch(text(), /Egress canary:[^\n]*did not say which daemon it uses/, "a RESOLVED remote endpoint never takes the mute branch");
});

test("doctor: a password in DOCKER_HOST never reaches the canary's leftover line (#360)", async () => {
	// The line names what the CLI resolved, which is only safe because `makeDockerEndpointResolver` stores
	// `classifyDockerEndpoint`'s `display` and never the raw host (issue #340). A future resolver that stored
	// the raw one would leak a credential into a doctor line operators paste into support threads, and
	// nothing else in this file would notice. `ssh://` is also NOT local, so this drives the same branch the
	// test above does.
	const { out, text } = capture();
	const plan = {
		"docker network ls --filter name=pi-dispatch-egress-doctor-": { code: 0, output: "pi-dispatch-egress-doctor-4242\n" },
		...green,
		"docker context inspect": { code: 0, output: '"remote"|"ssh://bob:hunter2@remote.example.invalid:22"\n' },
		"gh auth status": { code: 0, output: ghStatusOutput },
	};
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, plan, [], { isAlive: () => false, pid: 1 }));
	const printed = text();
	assert.match(printed, /⚠ Egress canary: pi-dispatch-egress-doctor-4242 may be left over/, "the line still fires");
	assert.match(printed, /resolves ssh:\/\/remote\.example\.invalid:22/, "the host survives, which is what an operator needs");
	for (const needle of ["bob", "hunter2"]) assert.ok(!printed.includes(needle), `the credential must not: ${needle}`);
});

test("doctor: a probe the sweep could NOT remove is never reported as removed (#350)", async () => {
	// The rule `removeNetworkOrSay` applies to `detached`, applied to `removed` too: a check claiming a probe
	// was removed while it is still running is worse than no line at all.
	const calls = [];
	const { out, text } = capture();
	const plan = {
		"docker network ls --filter name=pi-dispatch-egress-doctor-": { code: 0, output: "pi-dispatch-egress-doctor-4242\n" },
		"docker network inspect --format {{json .Containers}} pi-dispatch-egress-doctor-4242": { code: 0, output: '{"a":{"Name":"pi-dispatch-egress-probe-unlisted-4242"}}' },
		"docker rm -f": 1,
		...green,
		"gh auth status": { code: 0, output: ghStatusOutput },
	};
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, plan, calls, { isAlive: () => false, pid: 1 }));
	assert.doesNotMatch(text(), /after removing pi-dispatch-egress-probe-unlisted-4242/, "it did not go, so it is not claimed");
	assert.match(text(), /⚠ Egress canary: pi-dispatch-egress-doctor-4242 is kept, because the probe pi-dispatch-egress-probe-unlisted-4242 could not be removed and the network is the only way left to find it: docker rm -f pi-dispatch-egress-probe-unlisted-4242/);
	// The network is the ONLY handle: nothing in this project enumerates probe containers, so removing it
	// would orphan a running container permanently, and detaching it first is no better.
	assert.ok(!calls.some((c) => c.args.slice(0, 2).join(" ") === "network rm" && c.args.at(-1) === "pi-dispatch-egress-doctor-4242"), "the network is not removed");
	assert.ok(!calls.some((c) => c.args.slice(0, 2).join(" ") === "network disconnect" && c.args.at(-1) === "pi-dispatch-egress-probe-unlisted-4242"), "nor is the probe cut loose from it");
});

test("doctor: a canary create that could not be LAUNCHED leaves no teardown line either (#350)", async () => {
	// `runCmd` has no timeout, so its null means the CLI never started -- not that it started and did not
	// finish. Reading null as "it may have landed anyway" printed a removal instruction for a network that
	// was never created. The numeric-refusal case is covered above; this is the launch-failure one.
	const { out, text } = capture();
	// The teardown must be made to FAIL, or `created` true and false look the same: a successful `network rm`
	// of a network that never existed prints nothing either way. Specific keys lead, since fakeSpawn takes
	// the first key the command line starts with.
	const plan = {
		"docker network create": "enoent",
		"docker network rm": 1,
		"docker network inspect": { code: 1, output: "", stderr: "Cannot connect to the Docker daemon" },
		...green,
		"gh auth status": { code: 0, output: ghStatusOutput },
	};
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, plan, []));
	assert.doesNotMatch(text(), /could not be removed/, "nothing launched, so nothing was created, so nothing to remove");
});

test("doctor: the probe names ARE the slug list, so a new direction cannot reach only one side (#350)", async () => {
	// A DRIFT pin rather than a value pin: re-typing today's two literals is an equivalent change, but adding
	// a third direction to one place and not the other is the failure `egress.mjs` owns these names to
	// prevent, and this is what goes red when that happens.
	const calls = [];
	const { out } = capture();
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, { ...green, "gh auth status": { code: 0, output: ghStatusOutput } }, calls, { pid: 4242 }));
	const named = calls.filter((c) => c.args[0] === "run").map((c) => c.args[c.args.indexOf("--name") + 1]);
	const expected = CANARY_PROBE_SLUGS.map((slug) => egressCanaryProbe(slug, 4242));
	assert.deepEqual(named, expected, "every slug in the list gets a probe, and no probe is named outside it");
});

test("doctor: a leftover carrying OUR OWN pid is swept, because it cannot be ours (#350)", async () => {
	// Measured before the fix: the sweep skipped `owner === pid` believing it protected a concurrent run, so a
	// network left by an EARLIER process the OS had since reused the number for stayed, blocked our own
	// `network create`, and took the whole egress read-back down with no line saying why. One host cannot have
	// two live processes under one pid, and this sweep runs before the canary creates anything, so our own pid
	// is the one value here that is certainly stale.
	const calls = [];
	const { out, text } = capture();
	const plan = {
		"docker network ls --filter name=pi-dispatch-egress-doctor-": { code: 0, output: "pi-dispatch-egress-doctor-4242\n" },
		"docker network inspect --format {{json .Containers}} pi-dispatch-egress-doctor-4242": { code: 0, output: "{}" },
		...green,
		"gh auth status": { code: 0, output: ghStatusOutput },
	};
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, plan, calls, { pid: 4242, isAlive: (p) => p === 4242 }));
	assert.match(text(), /✓ Egress canary: removed pi-dispatch-egress-doctor-4242/, "our own stale pid is reclaimed, not skipped");
	assert.ok(calls.some((c) => c.args.slice(0, 2).join(" ") === "network rm" && c.args.at(-1) === "pi-dispatch-egress-doctor-4242"));
});

test("doctor: a canary that cannot START says so instead of leaving no egress reading at all (#350)", async () => {
	// A reader cannot tell "the policy was proved" from "nothing was tried". Both early returns used to be
	// silent, so a blocked canary looked identical to a healthy one that simply printed less.
	for (const [what, plan] of [
		["create", { "docker network create": 1, ...green, "gh auth status": { code: 0, output: ghStatusOutput } }],
		["connect", { "docker network connect": 1, ...green, "gh auth status": { code: 0, output: ghStatusOutput } }],
	]) {
		const { out, text } = capture();
		const code = await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, plan, []));
		assert.equal(code, 0, `${what}: an unproved policy warns, it never fails doctor`);
		assert.match(text(), /⚠ Egress policy: not proved, because/, what);
		assert.match(text(), /the policy itself may be fine, but nothing here has shown that it is/, `${what}: and says what is missing`);
		assert.doesNotMatch(text(), /Egress policy reaches the provider/, `${what}: nothing may read as proved`);
	}
});

test("doctor: a host with no leftovers says nothing at all, on any daemon (#350)", async () => {
	// The first draft warned about leftovers on an unknown daemon WITHOUT ever listing them, so a spotless
	// podman-docker host got an unsilenceable line about a category of object that was not there. This file's
	// own doctrine: a check nobody can silence must never cry wolf, and "could not ask" is not "misconfigured".
	for (const [what, ctx] of [
		["unknown daemon", { code: 0, output: "" }],
		["remote daemon", { code: 0, output: '"remote"|"tcp://build.example.invalid:2376"\n' }],
		["local daemon", { code: 0, output: '"default"|"unix:///var/run/docker.sock"\n' }],
	]) {
		const { out, text } = capture();
		const plan = {
			"docker network ls --filter name=pi-dispatch-egress-doctor-": { code: 0, output: "" },
			...green,
			"docker context inspect": ctx,
			"gh auth status": { code: 0, output: ghStatusOutput },
		};
		await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, plan, [], { isAlive: () => false, pid: 1 }));
		assert.doesNotMatch(text(), /Egress canary:/, `${what}: nothing to say about leftovers that are not there`);
	}
});

test("doctor: the slug list is pinned as LITERALS, because order is part of the name (#350)", async () => {
	// The drift pin beside this is arity-only by construction: it derives `expected` from the same list, so a
	// REVERSAL moves both sides together. Order matters here -- reversing it names the provider probe
	// `-unlisted-<pid>` while it fetches api.anthropic.com, defeating the whole point of a name someone reads
	// off `ps` to find out what a wedged probe was doing.
	assert.deepEqual([...CANARY_PROBE_SLUGS], ["provider", "unlisted"]);
});

test("doctor: a listing that FAILS is said, never taken as 'no leftovers' (#350)", async () => {
	// The whole point of looking first is that silence then means "there are none". A `network ls` that could
	// not run must not borrow that meaning.
	const { out, text } = capture();
	const plan = {
		"docker network ls --filter name=pi-dispatch-egress-doctor-": { code: 1, output: "", stderr: "Cannot connect to the Docker daemon" },
		...green,
		"gh auth status": { code: 0, output: ghStatusOutput },
	};
	const code = await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, plan, [], { isAlive: () => false, pid: 1 }));
	assert.equal(code, 0, "it warns, it never fails doctor");
	assert.match(text(), /⚠ Egress canary: leftovers from an EARLIER doctor run could not be listed: docker network ls --filter name=pi-dispatch-egress-doctor-/);
});

test("doctor: `endpoint` defaults to unknown, so a caller that omits it sweeps nothing (#350)", async () => {
	// A source pin, like the canary bound above: the parameter has one call site today, so no behavioural test
	// can reach the default, and the safe answer and the SPOKEN answer are the same one. A future caller that
	// forgets it must not silently inherit the owned-daemon behaviour.
	const src = readFileSync(new URL("../src/doctor.mjs", import.meta.url), "utf8");
	assert.match(src, /endpoint = \{ local: null, reason: "not resolved" \}/, "unknown, which this sweep says out loud rather than acting on");
});
