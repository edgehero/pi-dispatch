import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { collectChecks, defaultPromptFn, githubProtectionPreflight, runDoctor } from "../src/doctor.mjs";

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
function overlay({ auth = false, models, extensions = false, packages, packagesNoManifest = false, skills } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-overlay-"));
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
	const path = join(mkdtempSync(join(tmpdir(), "pi-triggers-")), "triggers.json");
	const run = { kind: "local", folder: "/srv/repo", flow: "review", task: "nightly review", ...(packages === undefined ? {} : { packages }), ...(image === undefined ? {} : { image }), ...extra };
	writeFileSync(path, JSON.stringify({ triggers: [{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run }] }));
	return path;
}
const overlayEnv = (dir, extra = {}) => ({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_GLOBAL_PI_DIR: dir, ...extra });
// `agentDir` points at a path that does not exist, so the host-vs-overlay comparison (issue #102) finds
// nothing and, crucially, never reads the developer's real ~/.pi/agent or spawns their package manager.
// A test that wants the comparison passes its own agentDir.
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
	const path = join(mkdtempSync(join(tmpdir(), "pi-app-key-")), "github-app-test.pem");
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
	const dir = mkdtempSync(join(tmpdir(), "pi-env-setup-"));
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
function installUnit({ platform, home = mkdtempSync(join(tmpdir(), "pi-unit-home-")), deployDir, setup, which = "worker" }) {
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
	home: mkdtempSync(join(tmpdir(), "pi-empty-home-")),
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
	const deployDir = mkdtempSync(join(tmpdir(), "pi-deploy-"));
	const { home, path } = installUnit({ platform: "linux", deployDir, setup });
	const { out, text } = capture();
	const code = await runDoctor(seamEnv(), seamDeps(out, { cwd: deployDir, home, platform: "linux" }));
	assert.equal(code, 0);
	assert.match(text(), new RegExp(`✓ env-setup script present \\(${rx(setup)}, named by ${rx(path)}\\)`));
	assert.doesNotMatch(text(), new RegExp(SETUP_BODY.trim()), "the path is named; the contents are never read");
});

test("doctor: a launchd plist carries the same seam, read out of its EnvironmentVariables dict", async () => {
	const setup = setupScript();
	const deployDir = mkdtempSync(join(tmpdir(), "pi-deploy-"));
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
	const code = await runDoctor(seamEnv(), seamDeps(out, { cwd: mkdtempSync(join(tmpdir(), "pi-deploy-")), home }));
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
	const deployDir = mkdtempSync(join(tmpdir(), "pi-deploy-"));
	const { home } = installUnit({ platform: "linux", deployDir, setup: fromUnit });
	const { out, text } = capture();
	await runDoctor(seamEnv({ PI_ENV_SETUP: fromEnv }), seamDeps(out, { cwd: deployDir, home }));
	assert.match(text(), new RegExp(rx(fromUnit)));
	assert.doesNotMatch(text(), new RegExp(rx(fromEnv)), "the environment is only consulted when no unit named one");
});

test("doctor: worker and receiver naming the same script produce one set of lines, not two", async () => {
	const setup = setupScript();
	const deployDir = mkdtempSync(join(tmpdir(), "pi-deploy-"));
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
	const deployDir = mkdtempSync(join(tmpdir(), "pi-deploy-"));
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
		const deployDir = mkdtempSync(join(tmpdir(), "pi-deploy-"));
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
	const deployDir = mkdtempSync(join(tmpdir(), "pi-deploy-"));
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
		const deployDir = mkdtempSync(join(tmpdir(), "pi-deploy-"));
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
	const deployDir = mkdtempSync(join(tmpdir(), "pi-deploy-"));
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
		const deployDir = mkdtempSync(join(tmpdir(), "pi-deploy-"));
		const { home } = installUnit({ platform: "linux", deployDir, setup });
		const { out, text } = capture();
		const code = await runDoctor(seamEnv(), seamDeps(out, { cwd: deployDir, home, spawn: fakeSpawn({ ...green, "git ": outcome }) }));
		assert.equal(code, 0);
		assert.doesNotMatch(text(), /does not ignore it/, `${name}: only a definite "not ignored" may warn`);
	}
});

test("doctor: a unit rendered WITHOUT the flag reads as no seam, and an unparseable one does not guess", async () => {
	const deployDir = mkdtempSync(join(tmpdir(), "pi-deploy-"));
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

// -- run.command triggers (issue #189): one advisory line, and no flow-tier probe ---------------------

/** A triggers file with one cron command trigger, through the SHARED parseTriggers -- a stub the parser
 *  rejects would be swallowed by readTriggerFacts' never-throw guard and silently count 0, making the
 *  advisory assertion below pass for the wrong reason (the catch-zeroes-counts trap named at triggersFile). */
function commandTriggersFile() {
	const path = join(mkdtempSync(join(tmpdir(), "pi-triggers-cmd-")), "triggers.json");
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
	const dir = mkdtempSync(join(tmpdir(), "pi-scaffold-"));
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

test("doctor: no scaffolded file, no line -- the feature-off deployment is not told about a file it has not got", async () => {
	const { out, text } = capture();
	await runDoctor(imgEnv(), scaffoldDeps(out, mkdtempSync(join(tmpdir(), "pi-bare-"))));
	assert.doesNotMatch(text(), /pause-windows/, "nothing exists to be ignored");
});

test("doctor: an EMPTY PI_PAUSE_WINDOWS_FILE counts as unset, mirroring the worker's own load site", async () => {
	// start.mjs gates on `if (config.pauseWindowsFile)`, so an empty value leaves the feature off exactly as
	// an absent one does. A check that read only `undefined` would call that deployment wired.
	const cwd = scaffoldedCwd();
	const { out, text } = capture();
	await runDoctor(imgEnv({ PI_PAUSE_WINDOWS_FILE: "   " }), scaffoldDeps(out, cwd));
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
	const path = join(mkdtempSync(join(tmpdir(), "pi-triggers-forge-")), "triggers.json");
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
	const path = join(mkdtempSync(join(tmpdir(), "pi-triggers-resume-")), "triggers.json");
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
	const cwd = mkdtempSync(join(tmpdir(), "pi-fix-init-"));
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
	const cwd = mkdtempSync(join(tmpdir(), "pi-fix-auth-"));
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
	const cwd = mkdtempSync(join(tmpdir(), "pi-fix-restage-"));
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
	cwd: mkdtempSync(join(tmpdir(), "pi-fix-doctrine-")),
	out: () => {},
	spawn: fakeSpawn(plan),
	probeValkey: async () => false,
	fileExists: existsSync,
	nodeVersion: "20.10.0",
	...extra,
});

/** One validating triggers file that names every forge, a custom image, resume, and replicas. */
function fullyBrokenTriggersFile() {
	const path = join(mkdtempSync(join(tmpdir(), "pi-triggers-broken-")), "triggers.json");
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
	const env = {
		PI_PROVIDER: "anthropic",
		PI_AUTH_FROM_PI: "0",
		PI_TRIGGERS_FILE: fullyBrokenTriggersFile(),
		PI_GLOBAL_PI_DIR: dir,
		PI_GLOBAL_ALLOW_EXTENSIONS: "maybe",
		PI_SESSIONS_DIR: join(mkdtempSync(join(tmpdir(), "pi-sessions-parent-")), "absent"),
		RECEIVER_PORT: "http",
		AZURE_WEBHOOK_MODE: "hmac",
	};
	// A configured --env-setup seam, wrong in all three ways at once (issue #216). Without a unit that
	// names one, envSetupChecks returns [] and this pin would walk straight past the new checks -- the
	// same hollowing-out the triggers-parse guard below exists to prevent.
	const deployDir = mkdtempSync(join(tmpdir(), "pi-doctrine-deploy-"));
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
	const skillsDir = mkdtempSync(join(tmpdir(), "pi-skills-"));
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
