import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { makeWaitChecker } from "../src/wait-check.mjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { CANARY_LINES, CANARY_PROBE_SLUGS, EGRESS_CANARY_RUNNER_MODULE, EGRESS_CANARY_STALE_RUNNER, ENV_FILE_READABLE_KEYS, RUN_TIMEOUTS, SERVICE_ENV_KEYS, backendChecks, collectChecks, countRetained, defaultPromptFn, dockerRunVia, egressCanaryProbeArgs, egressCanaryScript, envFileKeys, githubProtectionPreflight, jobUserChecks, liveChecks, liveRunVia, podmanLiveChecks, render, runDoctor, sandboxTombstoneChecks, serviceEnvKeys, serviceEnvLoader, sweepStaleCanaryNetworks, urlShown } from "../src/doctor.mjs";
import { EMPTY_PAUSE_WINDOWS, EMPTY_SCOPED_LIMITS } from "../src/init.mjs";
import { EGRESS_CANARY_NET_PREFIX, egressCanaryProbe } from "../src/egress.mjs";
import { LIVE_PREFIX } from "../src/live-probes.mjs";
import { JOB_USER_FIX, parseDaemonFacts } from "../src/job-user.mjs";
import { OBSERVATION_FIX } from "../src/backends.mjs";
import { PODMAN_JOB_USER_FIX } from "../src/backend-podman.mjs";
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
const ENGINE_FACTS = JSON.stringify({ ServerVersion: "27.5.1", OperatingSystem: "Ubuntu 24.04", SecurityOptions: ["name=seccomp,profile=builtin"], PidsLimit: true, MemoryLimit: true });
function fakeSpawn(plan, calls = []) {
	return (cmd, args, opts) => {
		const line = [cmd, ...args].join(" ");
		const key = Object.keys(plan).find((k) => line.startsWith(k));
		const outcome = plan[key];
		// `kill` is RECORDED, not ignored: the bound's contract is that it kills the child with SIGKILL, and
		// a fake that swallows the call cannot tell a bound that fires from one that merely gives up waiting.
		const entry = { cmd, args, opts, kills: [] };
		calls.push(entry);
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
			kill(sig) {
				entry.kills.push(sig);
			},
			on(ev, cb) {
				handlers[ev] = cb;
				return this;
			},
		};
		queueMicrotask(() => {
			// "hang": a child that NEVER answers, which is what a wedged daemon's `docker info` does (issue
			// #397). No handler is called at all, so only the caller's own bound can end it.
			if (outcome === "hang") return;
			if (outcome === "enoent") {
				handlers.error?.(new Error(`spawn ${cmd} ENOENT`));
				return;
			}
			// A FUNCTION outcome answers from the argv (issue #278's --live sequence, where a later step reads what an
			// earlier one was given); it may also act, as the in-container write does on the host fixture.
			let resolved = typeof outcome === "function" ? outcome(cmd, args) : outcome;
			// Issue #452 (gate round 3): every armed doctor run's canary asks the detach gate which runtime answered, from the
			// run's one `docker info --format={{json .}}`. A plan whose bare `"docker info": 0` answers that read with no body has
			// not said which daemon it is, and is read as Docker Engine, as a real Docker host answers, so the gate lets the
			// canary through with no keeper read. A plan that gives the read a body of its own, or a key of its own, keeps it.
			if (cmd === "docker" && args[0] === "info" && args[1] === "--format={{json .}}" && key === "docker info" && resolved === 0) resolved = { code: 0, output: `${ENGINE_FACTS}\n` };
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
// Issue #453: the proxy's state is one inspect, health first, then `egress-proxy-state.mjs`'s status, image and mounts.
// A container `up` or compose made in the folder doctor runs from carries the pinned squid and that folder's two files.
const PROXY_KEY = 'docker inspect --format={"status":';
const PINNED_SQUID = "ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029";
const proxyAnswer = (health, status, { image = PINNED_SQUID, cwd = process.cwd(), conf = join(cwd, "deploy/egress-proxy.conf"), allowlist = join(cwd, "egress-allowlist.conf"), entrypoint = ["entrypoint.sh"], cmd = ["-f", "/etc/squid/squid.conf", "-NYC"], stderr } = {}) => ({
	code: 0,
	output: `${JSON.stringify({
		status,
		health,
		image,
		entrypoint,
		cmd,
		mounts: [
			{ Type: "bind", Source: conf, Destination: "/etc/squid/squid.conf" },
			{ Type: "bind", Source: allowlist, Destination: "/etc/pi-dispatch/allowlist.conf" },
			{ Type: "volume", Source: "/var/lib/docker/volumes/a1/_data", Destination: "/var/log/squid" },
			{ Type: "volume", Source: "/var/lib/docker/volumes/b2/_data", Destination: "/var/spool/squid" },
		],
		networks: { "pi-dispatch-egress-out": {} },
	})}\n`,
	...(stderr ? { stderr } : {}),
});
const EGRESS_OK = {
	// Issue #278: the docker CLI's endpoint, answered as a local socket. Here rather than only in `green`,
	// because plans that build on EGRESS_OK without `green` would otherwise read an unresolved endpoint.
	"docker context inspect": { code: 0, output: '"desktop-linux"|"unix:///Users/x/.docker/run/docker.sock"\n' },
	[PROXY_KEY]: proxyAnswer("healthy", "running"),
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
// `readHosts` is injected, never the default: the default opens a real Valkey connection to VALKEY_URL (127.0.0.1:6379
// when unset), so a test's output depended on whether something answered there. A host running its own Redis read an
// empty registry and printed nothing; CI's release job, with nothing there, printed "Fleet: could not read the host
// registry", and the exact-output pins that were captured on the first failed on the second.
const ghDeps = (out, plan, calls, extra = {}) => ({ out, spawn: fakeSpawn(plan, calls), probeValkey: async () => true, readHosts: async () => ({ hosts: [] }), fileExists: () => true, nodeVersion: "22.19.0", ...extra });
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
	// Exact (issue #433 review round 1): the podman venue's pins ride only the podman probe; docker's CLI has no
	// containers.conf defaults to pin, and a podman-only flag here would make docker refuse the probe.
	assert.deepEqual(run.args, ["run", "--rm", "--pull=never", "-e", "GH_TOKEN", "-e", "GITHUB_TOKEN", "--entrypoint", "gh", "pi-job:latest", "auth", "status"]);
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
	// The ids and a key set, since without them doctor fails on their own lines (PR #466 gate round 1): this test is the
	// probe's.
	const code = await runDoctor(ghEnv({ GITHUB_AUTH_SOURCE: "app", GITHUB_APP_ID: "4242", GITHUB_APP_INSTALLATION_ID: "987654", GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY-----" }), ghDeps(out, green, calls));
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

test("doctor: app source with the whole triple unset FAILS on the two ids, points at setup github, exits 1", async () => {
	const { out, text } = capture();
	const code = await runDoctor(appEnv(), appDeps(out));
	// PR #466 gate round 1: unset ids refuse the worker's boot (`loadGitHubAuth`), so they are ✗, not the ⚠ they were.
	assert.equal(code, 1, "a chosen app source without its ids is a deployment that cannot start");
	assert.match(text(), /✗ GITHUB_AUTH_SOURCE=app but GITHUB_APP_ID is unset -- the worker will refuse to boot\n {4}→ run `pi-dispatch setup github`/);
	assert.match(text(), /✗ GITHUB_AUTH_SOURCE=app but GITHUB_APP_INSTALLATION_ID is unset -- the worker will refuse to boot\n {4}→ run `pi-dispatch setup github`/);
	assert.match(text(), /✗ GITHUB_AUTH_SOURCE=app but neither GITHUB_APP_PRIVATE_KEY_PATH nor GITHUB_APP_PRIVATE_KEY is set -- the worker will refuse to boot\n {4}→ run `pi-dispatch setup github`/);
	assert.match(text(), /run `pi-dispatch setup github`/, "the fix is the wizard that mints all three");
});

test("doctor: a non-numeric GITHUB_APP_ID is named as such (an id is not a secret, so it IS echoed)", async () => {
	const { out, text } = capture();
	const code = await runDoctor(appEnv({ GITHUB_APP_ID: "Iv1.oops", GITHUB_APP_INSTALLATION_ID: "987654", GITHUB_APP_PRIVATE_KEY_PATH: appKeyFile() }), appDeps(out));
	assert.equal(code, 1, "every github job would fail to mint its token (PR #466 gate round 1)");
	assert.match(text(), /✗ GITHUB_AUTH_SOURCE=app but GITHUB_APP_ID is not numeric \("Iv1\.oops"\) -- github jobs cannot mint tokens\n/);
	assert.match(text(), /✓ GITHUB_APP_INSTALLATION_ID set \(987654\)/, "the other two are judged independently");
});

test("doctor: a key path that points at nothing FAILS with the path, since the worker refuses to boot on it", async () => {
	const { out, text } = capture();
	const missing = join(tmpdir(), "no-such-github-app.pem");
	const code = await runDoctor(appEnv({ GITHUB_APP_ID: "4242", GITHUB_APP_INSTALLATION_ID: "987654", GITHUB_APP_PRIVATE_KEY_PATH: missing }), appDeps(out));
	assert.equal(code, 1, "`loadGitHubAuth` refuses the boot on it (PR #466 gate round 1)");
	assert.match(text(), new RegExp(`✗ GITHUB_APP_PRIVATE_KEY_PATH does not exist \\(${missing.replace(/[.\\/]/g, "\\$&")}\\) -- the worker will refuse to boot\\n {4}→ run \`pi-dispatch setup github\``));
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

test("doctor: both key sources set FAILS, since the worker will refuse to boot", async () => {
	const { out, text } = capture();
	const env = appEnv({ GITHUB_APP_ID: "4242", GITHUB_APP_INSTALLATION_ID: "987654", GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----x-----END PRIVATE KEY-----", GITHUB_APP_PRIVATE_KEY_PATH: appKeyFile() });
	const code = await runDoctor(env, appDeps(out));
	assert.equal(code, 1, "`loadGitHubAuth` refuses the boot on it, so doctor says ✗ (PR #466 gate round 1)");
	assert.match(text(), /✗ GITHUB_APP_PRIVATE_KEY and GITHUB_APP_PRIVATE_KEY_PATH are both set -- the worker will refuse to boot\n {4}→ unset one of them/);
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

test("doctor judges app auth on the service's .env where this shell sets none, never printing the key (PR #466 gate round 2)", async () => {
	// The ✗ lines would otherwise judge a shell that lacks the keys the worker loads from its .env, and fail a deployment
	// that boots, or pass one that does not.
	const cwd = scaffoldedCwd();
	const readEnvFile = (path) => readFileSync(path, "utf8");
	const envPath = join(cwd, ".env").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
	writeFileSync(join(cwd, ".env"), `GITHUB_AUTH_SOURCE=app\nGITHUB_APP_ID=4242\nGITHUB_APP_INSTALLATION_ID=987654\nGITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----${KEY_BODY}"\n`);
	const good = capture();
	const code = await runDoctor(imgEnv(), { ...scaffoldDeps(good.out, cwd), readEnvFile });
	assert.equal(code, 0, good.text());
	assert.match(good.text(), new RegExp(`✓ GitHub auth settings read from ${envPath}, as the service reads them \\(this shell does not set them\\): GITHUB_AUTH_SOURCE, GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY\\n`));
	assert.match(good.text(), /✓ GITHUB_APP_ID set \(4242\)\n/);
	assert.match(good.text(), /✓ GitHub App private key supplied inline \(GITHUB_APP_PRIVATE_KEY\)\n/);
	assert.ok(!good.text().includes(KEY_BODY), "the key's contents never reach output");
	// Chosen in the file, incomplete there: ✗, as the worker would refuse to boot on that file.
	writeFileSync(join(cwd, ".env"), "GITHUB_AUTH_SOURCE=app\nGITHUB_APP_ID=4242\n");
	const bad = capture();
	assert.equal(await runDoctor(imgEnv(), { ...scaffoldDeps(bad.out, cwd), readEnvFile }), 1);
	assert.match(bad.text(), /✗ GITHUB_AUTH_SOURCE=app but GITHUB_APP_INSTALLATION_ID is unset -- the worker will refuse to boot\n/);
	// This shell wins where it sets a key, and then the file's value is not read for it.
	const own = capture();
	await runDoctor(imgEnv({ GITHUB_AUTH_SOURCE: "pat" }), { ...scaffoldDeps(own.out, cwd), readEnvFile });
	assert.doesNotMatch(own.text(), /GITHUB_APP_INSTALLATION_ID/, "the shell's pat wins over the file's app");
	assert.doesNotMatch(own.text(), /GitHub auth settings read from/, "an App key read under another source decides nothing, so nothing is said");
});

test("doctor trims GITHUB_APP_PRIVATE_KEY_PATH as loadGitHubAuth does: blank beside an inline key is not 'both set' (PR #466 gate round 2)", async () => {
	const inline = `-----BEGIN PRIVATE KEY-----${KEY_BODY}`;
	const beside = capture();
	assert.equal(await runDoctor(appEnv({ GITHUB_APP_ID: "4242", GITHUB_APP_INSTALLATION_ID: "987654", GITHUB_APP_PRIVATE_KEY: inline, GITHUB_APP_PRIVATE_KEY_PATH: "   " }), appDeps(beside.out)), 0);
	assert.doesNotMatch(beside.text(), /are both set/);
	assert.match(beside.text(), /✓ GitHub App private key supplied inline/);
	const alone = capture();
	assert.equal(await runDoctor(appEnv({ GITHUB_APP_ID: "4242", GITHUB_APP_INSTALLATION_ID: "987654", GITHUB_APP_PRIVATE_KEY_PATH: "   " }), appDeps(alone.out)), 1);
	assert.match(alone.text(), /✗ GITHUB_AUTH_SOURCE=app but neither GITHUB_APP_PRIVATE_KEY_PATH nor GITHUB_APP_PRIVATE_KEY is set -- the worker will refuse to boot\n/);
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

test("doctor: a replicating trigger states the budget arithmetic, and never fails", async () => {
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
	assert.notEqual(code, 1, "a chosen opt-in is a fact line, never a hard failure");
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
/**
 * `runDoctor` in a BOUNDED CHILD, for the reads that can block (issue #396).
 *
 * `readFileSync` on a FIFO never returns, and it is synchronous, so a guard removed from one of doctor's
 * regular-file checks does not redden the test that covers it -- it HANGS the whole file, `--test-timeout`
 * cannot reach a blocked event loop, and CI reports a job timeout instead of a failure. The three tests that
 * plant a named pipe therefore ran the subject where no bound could reach it.
 *
 * A child with `timeout` plus `killSignal: "SIGKILL"` turns that into an assertion. SIGKILL because
 * `spawnSync` waits for the child to exit, so a catchable signal lets a process blocked in a synchronous
 * read outlive the bound -- the same reasoning, and the same shape, as `receiver/test/start.test.mjs`'s
 * bounded spawn.
 */
function doctorInChild(env, cwd, { timeoutMs = 20000 } = {}) {
	const doctorUrl = new URL("../src/doctor.mjs", import.meta.url).href;
	const script = `
		const { runDoctor } = await import(${JSON.stringify(doctorUrl)});
		let out = "";
		const code = await runDoctor(${JSON.stringify(env)}, {
			cwd: ${JSON.stringify(cwd)},
			out: (s) => { out += s; },
			spawn: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
			probeValkey: async () => true,
			nodeVersion: "22.19.0",
		});
		process.stdout.write(JSON.stringify({ code, out }));
	`;
	const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf8" });
	// The ERROR, and only the error: a killed child has `status: null`, which would read as an ordinary
	// non-zero exit, so the bound is detected here and the exit code is left to the caller.
	assert.equal(r.error?.code, undefined, `doctor did not return within ${timeoutMs}ms -- a regular-file guard is missing, which is the failure this shape exists to name. stderr: ${r.stderr}`);
	return JSON.parse(String(r.stdout));
}

/** `doctorInChild`'s sibling for a module-level call: same bound, same reason, arbitrary script body. */
function inChild(body, { timeoutMs = 20000 } = {}) {
	const url = JSON.stringify(new URL("../src/doctor.mjs", import.meta.url).href);
	const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const URL = ${url};\n${body}`], { timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf8" });
	assert.equal(r.error?.code, undefined, `the call did not return within ${timeoutMs}ms -- a regular-file guard is missing. stderr: ${r.stderr}`);
	return JSON.parse(String(r.stdout));
}

function scaffoldedCwd() {
	const dir = tempDir("pi-scaffold-");
	writeFileSync(join(dir, "pause-windows.json"), EMPTY_PAUSE_WINDOWS);
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
	//
	// It is a PASS rather than a softened warning since issue #384, and the reason is that doctor now asks
	// the worker's own loader: the file is named, it exists, and it parses, so there is nothing left to warn
	// about. What used to make this a warning was that doctor could not tell whether the named file would
	// load; now it can.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), `PI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json")}\n`);
	const { out, text } = capture();
	await runDoctor(imgEnv(), scaffoldDeps(out, cwd));
	assert.ok(text().includes(`✓ PI_PAUSE_WINDOWS_FILE is set in ${join(cwd, ".env")} (${join(cwd, "pause-windows.json")}) and loads`), "it names the file, and says it loads");
	assert.doesNotMatch(text(), /scoped pauses are OFF/, "and drops the claim that the feature is off, because for the service it is not");
});

test("doctor: a .env line carrying an inline comment is NAMED, never quoted back (#384)", async () => {
	// The shape issue #392 found in the shipped scaffold, from doctor's side. systemd keeps the comment as
	// part of the value and a sourcing shell strips it, so this file cannot say what the service reads --
	// and the previous reader answered anyway, by stripping the comment and printing the path. It now names
	// the LINE and prints no value at all, which is the only honest thing available.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), `PI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json")}   # written by up\n`);
	const { out, text } = capture();
	await runDoctor(imgEnv(), scaffoldDeps(out, cwd));
	assert.match(text(), /⚠ PI_PAUSE_WINDOWS_FILE on line 1 of .* is not in the form every loader reads the same way/, "the line is named");
	assert.doesNotMatch(text(), /written by up/, "and the value is never quoted back, because this file cannot vouch for it");
	assert.match(text(), /rewrite it as PI_PAUSE_WINDOWS_FILE=/, "the fix is the form `up` writes");
});

test("doctor: a file carrying BOTH forms, disagreeing, names the disagreement (#365, #384)", async () => {
	// A key with a bare line AND an `export` one is not export-only, and the two readings disagree about the
	// VALUE, which means two deployments of the same file load different files. `EnvironmentFile=` takes the
	// bare line (systemd does not strip the prefix, measured on 252) and `set -a; . ./.env` in the wrappers
	// takes the LAST assignment. Since issue #384 the label leads with the loader THIS platform's service
	// actually uses, rather than naming systemd's reading on every platform.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), `PI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json")}\nexport PI_PAUSE_WINDOWS_FILE=/wrapper-wins.json\n`);
	const { out, text } = capture();
	await runDoctor(imgEnv(), scaffoldDeps(out, cwd));
	assert.match(text(), /⚠ PI_PAUSE_WINDOWS_FILE is assigned TWICE in .* with different values/, "the disagreement is the finding, not either value");
	assert.match(text(), /wrapper-wins\.json/, "the second assignment is named");
	assert.match(text(), /keep one assignment/, "and the fix is to stop having two");
});

test("doctor: a BLANK line in the .env is a refused boot, and it FAILS (#365, #384)", async () => {
	// The verdict this issue is named for. A blank value is not unset: the loader keeps it, the worker tries
	// to load "" and refuses to start, so this is a ✗ and doctor exits 1. It warned before, three rows from
	// a sibling check that failed the identical deployment.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "PI_PAUSE_WINDOWS_FILE=\n");
	const { out, text } = capture();
	const code = await runDoctor(imgEnv(), scaffoldDeps(out, cwd));
	assert.match(text(), /✗ PI_PAUSE_WINDOWS_FILE is assigned an EMPTY value in .*\.env, which is not unset/, "the file's blank line is named as the refused boot it is");
	assert.match(text(), /REFUSES TO START/);
	assert.match(text(), /delete the PI_PAUSE_WINDOWS_FILE line from that \.env, or give it a path/, "and the fix is about a blank value, not about an unset one");
	assert.equal(code, 1, "a deployment whose worker cannot boot must not exit 0");
});

test("doctor: a blank value with NO scaffolded file still fails (#384)", async () => {
	// The silence this issue found: the old checks only spoke when `./pause-windows.json` existed, so the
	// commonest shape of all -- a blank key and no scaffold -- printed nothing and exited 0 on a worker that
	// cannot start. The scaffold now decides only the "a file sits here that nothing reads" line.
	const cwd = tempDir("pi-noscaffold-");
	writeFileSync(join(cwd, "subscriptions.json"), JSON.stringify({ version: 1, subscriptions: [] }));
	const { out, text } = capture();
	const code = await runDoctor(imgEnv({ PI_SCOPED_LIMITS_FILE: "" }), scaffoldDeps(out, cwd));
	assert.match(text(), /✗ PI_SCOPED_LIMITS_FILE is set to an EMPTY value in this shell/, "the shell's blank value is judged whether or not a file was scaffolded");
	assert.equal(code, 1);
});

test("doctor: an `export` line that CLEARS the key is the same disagreement (#365)", async () => {
	// The sharpest shape: the `export` line is the one that empties the key, so the two loaders disagree
	// about whether the feature is configured at all. It was silent before issue #365 and is a single
	// finding now, never a finding plus an "unset" line about the same key.
	// THE PLATFORM IS PASSED, because since issue #384 this shape is a different sentence on each one and
	// taking it from the host would make this test say one thing on a developer's mac and another in CI.
	// systemd ignores the export line, so the service keeps the path and only a sourcing shell is emptied.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), `PI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json")}\nexport PI_PAUSE_WINDOWS_FILE=\n`);
	const { out, text } = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform: "linux" });
	assert.match(text(), /assigned TWICE in .* with different values/, "the clearing line is a disagreement, not an absence");
	assert.match(text(), /an EMPTY value, which refuses the boot/, "and the empty side says what it costs");
	assert.doesNotMatch(text(), /exists but PI_PAUSE_WINDOWS_FILE is unset/, "one key, one finding: the scaffold line must not fire beside it");

	// The same file on darwin, where the only loader IS the sourcing wrapper: it takes the LAST assignment,
	// so the service reads nothing and the deployment is down rather than untidy. One file, two platforms,
	// two true sentences -- which is the whole reason the loader is chosen per platform.
	const { out: out2, text: text2 } = capture();
	const code2 = await runDoctor(imgEnv(), { ...scaffoldDeps(out2, cwd), platform: "darwin" });
	assert.match(text2(), /✗ PI_PAUSE_WINDOWS_FILE is assigned an EMPTY value/, "on darwin the wrapper takes the empty export line");
	assert.match(text2(), /while systemd's EnvironmentFile= would take .*pause-windows\.json/, "and the disagreement is still named");
	assert.equal(code2, 1, "a service that cannot start is a failure, not a warning");
});

test("doctor: the SCOPED_LIMITS twin says the same thing about the same shapes (#365, #384)", async () => {
	// One rule for both files since issue #384, so this is the twin of the test above rather than a second
	// hand-written copy of it. The mutex parenthetical is the one thing that differs, and it is load-bearing:
	// local folders are NOT ungated when the file is off.
	const cwd = scopedScaffoldCwd();
	writeFileSync(join(cwd, ".env"), `PI_SCOPED_LIMITS_FILE=${join(cwd, "scoped-limits.json")}\nexport PI_SCOPED_LIMITS_FILE=/wrapper-wins.json\n`);
	const { out, text } = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform: "linux" });
	assert.match(text(), /⚠ PI_SCOPED_LIMITS_FILE is assigned TWICE in .* with different values/);
	assert.match(text(), /wrapper-wins\.json/);
});

test("doctor: two assignments that AGREE are not a finding (#365)", async () => {
	// Both forms carrying the same value is a tidiness question rather than a fact about the deployment, and
	// a warning about it would be the crying wolf this file refuses elsewhere.
	const cwd = scaffoldedCwd();
	const path = join(cwd, "pause-windows.json");
	writeFileSync(join(cwd, ".env"), `PI_PAUSE_WINDOWS_FILE=${path}\nexport PI_PAUSE_WINDOWS_FILE=${path}\n`);
	const { out, text } = capture();
	await runDoctor(imgEnv(), scaffoldDeps(out, cwd));
	assert.doesNotMatch(text(), /assigned TWICE/, "same value twice is not a disagreement");
	assert.match(text(), /✓ PI_PAUSE_WINDOWS_FILE is set in .* and loads/, "it is simply configured");
});

test("doctor: a file the SERVICE names but cannot load is a failure, not a warning (#384)", async () => {
	// The half that had no check at all: doctor parsed a configured scoped-limits file and said nothing
	// about a configured pause-windows one. Both are boot-load fail-loud, so both are ✗ now, and the reason
	// comes from the worker's own loader rather than from a second parser written here.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, "broken.json"), "not json at all");
	writeFileSync(join(cwd, ".env"), `PI_PAUSE_WINDOWS_FILE=${join(cwd, "broken.json")}\n`);
	const { out, text } = capture();
	const code = await runDoctor(imgEnv(), scaffoldDeps(out, cwd));
	assert.match(text(), /✗ PI_PAUSE_WINDOWS_FILE is set in .*\.env .* to a file the worker cannot load, so a service started from it REFUSES TO START/);
	assert.match(text(), /not valid JSON/, "the loader's own words, not doctor's paraphrase");
	assert.equal(code, 1);
});

test("doctor: a PI_ENV_SETUP deployment gets a warning where another would fail (#384)", async () => {
	// The setup script runs AFTER the file on every platform, so it can supply or replace what the file
	// says. Doctor cannot run it, and failing a working `--env-setup` deployment would be the crying wolf
	// this file refuses elsewhere -- so the same finding is a ⚠ that names the script.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "PI_PAUSE_WINDOWS_FILE=\n");
	const setup = join(cwd, "env-setup.sh");
	writeFileSync(setup, "#!/bin/sh\n");
	const { out, text } = capture();
	const code = await runDoctor(imgEnv({ PI_ENV_SETUP: setup }), scaffoldDeps(out, cwd));
	assert.match(text(), /⚠ PI_PAUSE_WINDOWS_FILE is assigned an EMPTY value/, "the finding stands");
	assert.match(text(), /runs after that file and may replace it/, "and it names what doctor cannot see");
	assert.notEqual(code, 1, "a deployment doctor cannot judge must not be failed on a guess");
});

test("doctor: a PI_ENV_SETUP script that is NOT THERE downgrades nothing (#384)", async () => {
	// The downgrade exists because a script doctor cannot run may replace the value. A script that does not
	// EXIST replaces nothing, and doctor already says so two lines up -- so downgrading on it printed two
	// contradicting sentences in one run: the unit restart-loops until the script is back, and the blank key
	// is only a warning because that same script may fix it.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "PI_PAUSE_WINDOWS_FILE=\n");
	const { out, text } = capture();
	const code = await runDoctor(imgEnv({ PI_ENV_SETUP: join(cwd, "gone.sh") }), scaffoldDeps(out, cwd));
	assert.match(text(), /✗ PI_PAUSE_WINDOWS_FILE is assigned an EMPTY value/, "the finding is not softened by a script that is not there");
	assert.doesNotMatch(text(), /gone\.sh runs after that file and may replace it/, "and nothing claims it may be replaced");
	assert.equal(code, 1);
});

test("doctor: a PI_ENV_SETUP of only whitespace is CONFIGURED, because the wrapper says so (#384)", async () => {
	// `worker-env-wrapper.sh` tests `[ -n "$env_setup" ]` and then `[ ! -f "$env_setup" ]`, so three spaces
	// is a configured script that does not exist, and the wrapper refuses to start on it. Reading it as
	// unset here -- `.trim() !== ""` -- left that deployment with no line anywhere in the report.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "PI_PAUSE_WINDOWS_FILE=\n");
	const { out, text } = capture();
	const code = await runDoctor(imgEnv({ PI_ENV_SETUP: "   " }), scaffoldDeps(out, cwd));
	assert.match(text(), /✗ PI_PAUSE_WINDOWS_FILE is assigned an EMPTY value/, "a setup script that cannot exist downgrades nothing");
	assert.match(text(), /the env-setup script at .* does not exist/, "and the configured-but-missing script gets a line of its own, which trimming it away removed");
	assert.equal(code, 1);
});

test("doctor: a .env that is a FIFO does not hang the boot-file checks (#384)", async () => {
	// The loader reads with `readFileSync`, which on a FIFO never returns. `envFileKeys` already guards the
	// `.env` itself; this is the same hazard one file along, and it arrives because these checks read a path
	// an OPERATOR wrote rather than one doctor chose.
	const cwd = scaffoldedCwd();
	const fifo = join(cwd, "fifo.json");
	const { spawnSync } = await import("node:child_process");
	spawnSync("mkfifo", [fifo]);
	// THROUGH A BOUNDED CHILD (issue #396): in-process, a missing guard blocks this file forever instead of
	// failing it. See `doctorInChild`.
	const { code, out } = doctorInChild({ PI_JOB_IMAGE: "pi-job:latest", PI_PAUSE_WINDOWS_FILE: fifo }, cwd);
	assert.match(out, /is not a regular file/, "the guard names what it refused");
	// A CONTROL, because the exit code alone is not discriminating here: the child's spawn stub refuses every
	// docker call, so doctor exits 1 whatever this key points at. What separates the two runs is the LINE.
	const control = doctorInChild({ PI_JOB_IMAGE: "pi-job:latest", PI_PAUSE_WINDOWS_FILE: join(cwd, "pause-windows.json") }, cwd);
	assert.doesNotMatch(control.out, /is not a regular file/, "and a real file is not refused, so the line above is about the FIFO and not about the harness");
	assert.equal(code, 1);
});

test("doctor: an `export`ed key is honoured by the loader this platform's service uses (#357, #384)", async () => {
	// Three states, not two, and WHICH of them an `export` line is depends on the platform: systemd's
	// `EnvironmentFile=` does not read it (measured on 252, the journal says so), while the darwin and
	// win32 wrappers source or split the file and do. Doctor names the loader its own platform renders.
	// ALL THREE PLATFORMS, driven explicitly. This test used to branch on `process.platform` and assert one
	// of two shapes, which meant it checked darwin's answer on a mac and linux's in CI and NEVER checked
	// win32 at all -- and win32 is where the label was wrong: the cmd wrapper splits on the first `=`, so
	// `export PI_X` is a variable NAME there and that loader does not read the key either.
	const cwd = scaffoldedCwd();
	const path = join(cwd, "pause-windows.json");
	writeFileSync(join(cwd, ".env"), `export PI_PAUSE_WINDOWS_FILE=${path}\n`);
	for (const [platform, expected, why] of [
		["linux", /only a shell that SOURCES this file reads, and systemd's EnvironmentFile= does not/, "systemd's grammar is bare NAME=VALUE (measured on 252: the journal says `Ignoring invalid environment assignment`)"],
		["darwin", /and loads: the service reads that file/, "the launchd wrapper SOURCES the file, so the export line is an ordinary assignment to it"],
		["win32", /only a shell that SOURCES this file reads, and the \.cmd wrapper does not/, "`for /f ... delims==` makes `export PI_PAUSE_WINDOWS_FILE` the variable NAME"],
	]) {
		const { out, text } = capture();
		await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform });
		const line = text().split("\n").find((l) => l.includes("PI_PAUSE_WINDOWS_FILE"));
		assert.ok(line, `${platform}: the key is spoken about either way`);
		assert.match(line, expected, `${platform}: ${why}`);
	}
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
	// Issue #453 (gate round 2) widened the read by exactly the keys the service takes from this file and a doctor's
	// shell does not: the venue keys, VALKEY_URL, PI_PROVIDER and the provider's key (its presence). Each is said with
	// its source; everything else in the file still reaches nothing.
	for (const leaked of ["never-read:from-env-file", "/tmp/evil.sh"]) {
		assert.ok(!text().includes(leaked), `${leaked} came out of .env and must reach nothing`);
	}
	assert.match(text(), new RegExp(`Valkey reachable \\(redis://from-env-file:6379\\) -- VALKEY_URL read from ${join(cwd, ".env").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}, as the service reads it; this shell does not set it`));
	assert.match(text(), /PI_PAUSE_WINDOWS_FILE is set in/, "only the two keys the checks name are read back");
});

test("doctor: a .env that is a FIFO does not hang the command, through the DEFAULT seam (#357)", async () => {
	// The guard that matters is the one `collectChecks` actually gets: every other assertion here injects
	// its own `statFile`, so the production default was unpinned and a named pipe would have hung
	// `pi-dispatch doctor` forever, with no output and no check to point at.
	// IN A BOUNDED CHILD, for the reason `doctorInChild` gives: this reads through the PRODUCTION default
	// `statFile`, so with that guard deleted `readFileSync` blocks on the FIFO and this whole FILE hangs
	// rather than failing. A review pass measured exactly that against the first version of this change,
	// which converted the two `runDoctor` FIFO tests and left this one in-process.
	const cwd = tempDir("pi-fifo-");
	const fifo = join(cwd, ".env");
	execFileSync("mkfifo", [fifo]);
	const got = inChild(
		`const { envFileKeys } = await import(URL);
		const { existsSync, readFileSync } = await import("node:fs");
		const read = (p) => readFileSync(p, "utf8");
		process.stdout.write(JSON.stringify({
			fifo: envFileKeys(${JSON.stringify(fifo)}, ["PI_PAUSE_WINDOWS_FILE"], { fileExists: existsSync, readEnvFile: read }),
			dir: envFileKeys(${JSON.stringify(cwd)}, ["PI_PAUSE_WINDOWS_FILE"], { fileExists: existsSync, readEnvFile: read }),
		}));`,
	);
	assert.deepEqual(got.fifo, { unreadable: true }, "not a regular file, so not read at all -- and SOMETHING is there, which is not the same as the key being unset");
	// A directory is the other shape, and it throws rather than blocking; both must be silent.
	assert.deepEqual(got.dir, { unreadable: true }, "a .env that is a DIRECTORY is unreadable too: statFile answers happily and isFile() is false, so this never threw and the key came back merely absent");
});

test("doctor: a FIFO named by PI_TRIGGERS_FILE does not hang the command either (#396)", async () => {
	// THE THIRD GUARD, which issue #396 names and which nothing drove: deleting `readTriggerFacts`' own
	// `isFile()` left the entire suite green in 2.2 seconds, because no fixture in the repo ever planted a
	// named pipe at the triggers path. Measured with it deleted: doctor blocks until the child's bound
	// kills it. The guard is as load-bearing as its two siblings and was the only one untested.
	const cwd = scaffoldedCwd();
	const fifo = join(cwd, "triggers.json");
	if (spawnSync("mkfifo", [fifo]).status !== 0) return;
	const { code, out } = doctorInChild({ PI_JOB_IMAGE: "pi-job:latest", PI_TRIGGERS_FILE: fifo }, cwd);
	assert.match(out, /triggers file is not a regular file/, "the read is refused rather than attempted");
	assert.equal(code, 1, "and a triggers path the worker cannot read fails the command");
});

test("doctor: a good path in THIS SHELL does not excuse a blank line in the .env (#384)", async () => {
	// THE SHAPE THE WHOLE CHANGE IS FOR, and it had no test: the shell sets a valid path, the `.env` assigns
	// nothing, and doctor exited 0 with no line at all. The service never reads this shell -- `worker.service`
	// is `EnvironmentFile=` plus `ExecStart`, the launchd plist carries only PATH and PI_ENV_SETUP, and the
	// wrappers source the file inside the child -- so the unit refuses to start while the command whose job
	// is to answer "will this start" says yes.
	//
	// Both subjects are asserted in one run, because the defect was a PRECEDENCE: judging the shell first
	// and stopping is what produced the clean exit, so a test that only checks the service line would still
	// pass with the shell branch skipped.
	const cwd = scaffoldedCwd();
	const good = join(cwd, "pause-windows.json");
	writeFileSync(join(cwd, ".env"), "PI_PAUSE_WINDOWS_FILE=\n");
	const { out, text } = capture();
	const code = await runDoctor(imgEnv({ PI_PAUSE_WINDOWS_FILE: good }), { ...scaffoldDeps(out, cwd), platform: "linux" });
	assert.match(text(), /✗ PI_PAUSE_WINDOWS_FILE is assigned an EMPTY value/, "the service is judged on the file, whatever this shell says");
	assert.equal(code, 1, "and a service that cannot start fails the command");
	assert.doesNotMatch(text(), /PI_PAUSE_WINDOWS_FILE is set to an EMPTY value in this shell/, "this shell is fine and is not accused of anything");
});

test("doctor: a .env value that will not load is a failure even when this shell is configured (#384)", async () => {
	// The same precedence, one step along: the shell names a file that loads and the FILE names one that
	// does not. Before, the shell reading won and the service's broken path was never opened.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), `PI_PAUSE_WINDOWS_FILE=${join(cwd, "gone.json")}\n`);
	const { out, text } = capture();
	const code = await runDoctor(imgEnv({ PI_PAUSE_WINDOWS_FILE: join(cwd, "pause-windows.json") }), { ...scaffoldDeps(out, cwd), platform: "linux" });
	assert.match(text(), /✗ PI_PAUSE_WINDOWS_FILE is set in .*\.env .* to a file the worker cannot load/, "the service's own path is opened");
	assert.equal(code, 1);
});

test("doctor: a RELATIVE .env value resolves against the deployment folder, not the process cwd (#384)", async () => {
	// `.env` values are written by hand as often as by `up`, and a bare `pause-windows.json` beside the file
	// is the obvious spelling. Resolving it against `process.cwd()` -- wherever the operator happened to be
	// standing -- turns a working deployment into a ✗ that names a file they can see is there.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "PI_PAUSE_WINDOWS_FILE=pause-windows.json\n");
	const { out, text } = capture();
	const code = await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform: "linux" });
	assert.match(text(), /✓ PI_PAUSE_WINDOWS_FILE is set in .*\.env \(pause-windows\.json\) and loads/, "resolved beside the .env that names it");
	assert.notEqual(code, 1);
});

test("doctor: a line that reaches past itself names THAT line, not the key's (#384)", async () => {
	// The key's own line is in the form every loader reads the same way; another line is the problem. The
	// first version named this key's line and said "rewrite it", which asked the operator to retype a
	// correct line and changed nothing while the warning stayed.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), `PI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json")}\nunset FOO\n`);
	const { out, text } = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform: "darwin" });
	assert.match(text(), /cannot be read off .*\.env: line 2 is not one this command can read/, "the line an operator has to open");
	assert.doesNotMatch(text(), /PI_PAUSE_WINDOWS_FILE on line 1 of/, "and not the line that is already correct");
});

test("doctor: a file this reader cannot finish is never reported as a key that is unset (#384)", async () => {
	// ABSENCE OF A READING IS NOT ABSENCE OF AN ASSIGNMENT. A BOM'd line leaves no record for the key, and
	// the scaffold line then said "the worker ignores it" -- about a file whose loaders may well set it, and
	// which systemd 252 drops while the shells run as a command.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), `OTHER=1\n\ufeffPI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json")}\n`);
	const { out, text } = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform: "darwin" });
	assert.doesNotMatch(text(), /exists but PI_PAUSE_WINDOWS_FILE is unset/, "no positive claim about a file this reader could not finish");
	assert.match(text(), /cannot be read off .*\.env: line 2 is not one this command can read/, "and the line that stopped it is named");
});

test("doctor: a control byte in a value from THIS SHELL never reaches the terminal (#384)", async () => {
	// The file half is guarded by the grammar, which withholds a value it cannot show. The SHELL half has no
	// grammar at all: an environment variable can hold anything, and doctor printed it verbatim.
	const cwd = scaffoldedCwd();
	const { out, text } = capture();
	await runDoctor(imgEnv({ PI_PAUSE_WINDOWS_FILE: "/srv/a\u001b[31mb.json" }), { ...scaffoldDeps(out, cwd), platform: "linux" });
	assert.equal(text().includes("\u001b[31m"), false, "no escape sequence survives into the output");
	assert.match(text(), /PI_PAUSE_WINDOWS_FILE is set in this shell to a file the worker cannot load/, "the finding still lands");
});

test("doctor: the WINDOWS loader is judged by its own rules, not by the POSIX ones (#384)", async () => {
	// Three findings in one platform, all of them doctor telling a Windows operator something false:
	//
	//   KEY=                      `set "K="` UNSETS in cmd, so this is a key that is off, not a refused boot
	//   export KEY=<path>         cmd makes `export KEY` a variable NAME, so THAT loader does not read it
	//   KEY=C:\pi\pause.json      one assignment, and comparing it against a POSIX loader that will not
	//                             vouch for a backslash reported it as "assigned TWICE with different values"
	//
	// The third is the line `renderEnvValue` itself writes on win32, so doctor was contradicting the command
	// that wrote the file, on the commonest path shape the platform has.
	const cwd = scaffoldedCwd();
	const win = (out) => ({ ...scaffoldDeps(out, cwd), platform: "win32" });

	writeFileSync(join(cwd, ".env"), "PI_PAUSE_WINDOWS_FILE=\n");
	const a = capture();
	const codeA = await runDoctor(imgEnv(), win(a.out));
	assert.doesNotMatch(a.text(), /assigned an EMPTY value/, "an empty value is an UNSET key under the cmd wrapper");
	assert.notEqual(codeA, 1, "so a deployment that starts is not failed");

	writeFileSync(join(cwd, ".env"), `export PI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json")}\n`);
	const b = capture();
	await runDoctor(imgEnv(), win(b.out));
	assert.match(b.text(), /which only a shell that SOURCES this file reads, and the \.cmd wrapper does not/, "the loader that reads an export line is a sourcing shell, and it is not this platform's");

	writeFileSync(join(cwd, ".env"), "PI_PAUSE_WINDOWS_FILE=C:\\pi\\pause-windows.json\n");
	const c = capture();
	await runDoctor(imgEnv(), win(c.out));
	assert.doesNotMatch(c.text(), /assigned TWICE/, "one assignment is not two, whatever a loader this platform does not use would make of it");
});

test("doctor: a CRLF .env is judged on Windows, where CRLF is what writes it (#384)", async () => {
	// Holding a trailing CR against every loader disabled the whole verdict on the one platform whose files
	// natively carry it -- never the ✓, never the blank ✗ -- while `setEnvKeyIfEmpty` preserves CRLF by
	// contract, so `up` wrote lines the same module then refused to vouch for.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), `PI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json")}\r\n`);
	const { out, text } = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform: "win32" });
	assert.match(text(), /✓ PI_PAUSE_WINDOWS_FILE is set in .*\.env .* and loads/, "the cmd wrapper's `for /f` strips the CR");
	// AND ON LINUX TOO, because systemd 252 strips the CR (measured on the rig) exactly as `for /f` does.
	// Only a SOURCING shell keeps it in the value, so only darwin sees an ambiguity here -- and holding the
	// CR against all three made a CRLF deployment unjudgeable on the two platforms that read it cleanly,
	// on files `setEnvKeyIfEmpty` writes that way by contract.
	const { out: out2, text: text2 } = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(out2, cwd), platform: "linux" });
	assert.match(text2(), /✓ PI_PAUSE_WINDOWS_FILE is set in .*\.env .* and loads/, "systemd strips the CR, so the line is ordinary there");
	const { out: out3, text: text3 } = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(out3, cwd), platform: "darwin" });
	// On macOS the wrapper sources the file and keeps every CR, so the whole file is named, with its fix (round-cap
	// review of #447), rather than one line's form.
	assert.match(text3(), /line 1 has a carriage return \(CR\) at its end, a CRLF line ending, which the wrapper that sources this file on macOS keeps/, "and the disagreement is reported where it is real: a sourcing shell keeps the CR");
	assert.match(text3(), /on line 1 of that file, convert the file to LF line endings, then run doctor again/);
});

test("doctor: a FIFO named by PI_SCOPED_LIMITS_FILE does not hang the command (#384)", async () => {
	// The OTHER unbounded read, and the one the first round of this change missed while claiming the hazard
	// was closed. `readScopedLimitFacts` runs long before the guarded boot-file check, so a named pipe here
	// hung `pi-dispatch doctor` forever: no output, no check to point at, and nothing to kill but the
	// terminal. `readTriggerFacts` had the same shape and is guarded with it.
	//
	// THE STATED LIMIT IS GONE, and this is what replaced it (issue #396). It used to read: remove either
	// guard and this test does not go red, it HANGS, because `readFileSync` is synchronous and no
	// `--test-timeout` can interrupt it, so CI reports a job timeout rather than a failure -- which is
	// honest, and is not a pin. Through `doctorInChild` the bound is outside the blocked process, so a
	// missing guard is now an assertion that names itself.
	const cwd = tempDir("pi-fifo-scoped-");
	const fifo = join(cwd, "limits.json");
	execFileSync("mkfifo", [fifo]);
	const { code, out } = doctorInChild({ PI_JOB_IMAGE: "pi-job:latest", PI_SCOPED_LIMITS_FILE: fifo }, cwd);
	assert.match(out, /is not a regular file/, "the read is refused rather than attempted");
	// The code is 1 either way under the child's spawn stub (see the control in the `.env` FIFO test above),
	// so it is asserted as a floor and the LINE carries the claim.
	assert.equal(code, 1, "and the command fails");
});

test("doctor: a deployment folder with an apostrophe in its name still gets a report (#384)", async () => {
	// THE WORST FAILURE THIS ROUND PRODUCED, and it was a repair's own doing. `renderEnvValue` is a WRITER:
	// it refuses a value it cannot render, because a single quote has no spelling both systemd and the
	// shells read back. Doctor started calling it on labels, so in a folder named `rob's deploy` the command
	// threw `cannot write this value into a .env safely` and printed NOTHING AT ALL -- not one check, on a
	// deployment `init` alone can produce, where `main` printed a full report.
	const cwd = tempDir("pi-apos-");
	const dir = join(cwd, "rob's deploy");
	mkdirSync(dir);
	writeFileSync(join(dir, "pause-windows.json"), "[]\n");
	writeFileSync(join(dir, "scoped-limits.json"), '{"version":1,"limits":[]}\n');
	const { out, text } = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(out, dir), platform: "linux" });
	assert.match(text(), /Node .* 22\.19/, "the report happens at all");
	assert.match(text(), /PI_PAUSE_WINDOWS_FILE/, "and it still speaks about the key");
	assert.doesNotMatch(text(), /cannot write this value into a \.env safely/, "the writer's refusal is advice here, never an exception");
	// The advice says why there is no line to copy, rather than inventing a spelling no loader reads back.
	assert.match(text(), /cannot be written into a \.env/, "and it says so where the fix line would have been");
});

test("doctor: a .env that is a DIRECTORY is not a key that is unset (#384)", async () => {
	// `fileExists` says something is there and `isFile()` says it cannot be read, which is the same sentence
	// as a mode this account cannot open -- and it returned the SAME `{}` as "no .env at all", so doctor
	// printed "the worker ignores it" about a file it never opened. The round-1 repair fixed the throwing
	// case and left this one, because the guard returns before the read that would have thrown.
	const cwd = scaffoldedCwd();
	mkdirSync(join(cwd, ".env"));
	const { out, text } = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform: "linux" });
	assert.match(text(), /could not be read/, "it says what it actually knows");
	assert.doesNotMatch(text(), /exists but PI_PAUSE_WINDOWS_FILE is unset/, "and makes no claim about a key in a file nobody opened");
});

test("doctor: on win32 a bare KEY= is not an `export` line that the file does not contain (#384)", async () => {
	// The round-1 repair nulled the cmd reading of an empty value so Windows would stop being failed for a
	// key that is simply unset there -- and that dropped the key into the export-only branch, so doctor
	// quoted `export PI_PAUSE_WINDOWS_FILE=` at an operator whose file has no such line and told them to
	// drop a prefix that is not there. The export signal asks the FILE, not the per-platform view.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "PI_PAUSE_WINDOWS_FILE=\n");
	const { out, text } = capture();
	const code = await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform: "win32" });
	assert.doesNotMatch(text(), /as `export PI_PAUSE_WINDOWS_FILE=/, "no line is quoted that the file does not contain");
	assert.notEqual(code, 1, "and an empty value still just unsets the key there");
});

test("doctor: a line swallowed by the one above it points at the line above (#384)", async () => {
	// An unclosed quote makes the NEXT line part of its own value in every shell, so the key's line is
	// often perfect and "rewrite it as ..." repeated it back byte for byte. Two branches now, chosen by
	// where the trouble is rather than by which one noticed it.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), `OTHER="unclosed\nPI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json")}\n`);
	const { out, text } = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform: "darwin" });
	assert.match(text(), /cannot be read off .*\.env: line 1 is not one this command can read/, "the line that reaches is the line to fix");
	assert.doesNotMatch(text(), /PI_PAUSE_WINDOWS_FILE on line 2 of/, "and the swallowed line is not accused of being malformed");
});

test("doctor: a quote that CLOSES stops swallowing, and the key below it is still checked (#384)", async () => {
	// The first version latched on the first swallowing line and voided the rest of the file, so a key three
	// lines down was reported as malformed AND its file was never opened -- exit 0 on a deployment that
	// cannot boot. A multi-line value is still a disagreement (systemd 252 does not continue a quote), so
	// the file gets a warning; the key itself is read, and the load check runs.
	// A QUOTE THAT CLOSES IS NOT A QUOTE THAT SWALLOWS THE REST OF THE FILE. Lines 1 and 2 are one value to
	// a sourcing shell and two ordinary lines to systemd 252, so they disagree about OTHER -- and they agree
	// EXACTLY about line 3, which every one of them reads as the path (measured in sh, bash, dash, zsh and
	// on the rig). A version of this branch called the whole file unreadable and returned exit 0 on this
	// deployment, which cannot start.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), `OTHER='x\ny'\nPI_PAUSE_WINDOWS_FILE=${join(cwd, "gone.json")}\n`);
	for (const platform of ["linux", "darwin"]) {
		const { out, text } = capture();
		const code = await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform });
		assert.match(text(), /to a file the worker cannot load/, `${platform}: the value is read and the file opened`);
		assert.equal(code, 1, `${platform}: so a deployment that cannot boot fails`);
	}
});

test("doctor: a value it will not vouch for is never printed as what another loader takes (#384)", async () => {
	// `alsoExported` prints a value, so it needs the VOUCH and not merely a plain line. With a hazard in the
	// file, doctor said "a shell that sources the file would take /w.json" about a file where every shell
	// leaves the key UNSET -- the exact trap the three flags exist to prevent, inside the caller that
	// introduced them.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "PI_PAUSE_WINDOWS_FILE=\nexport PI_PAUSE_WINDOWS_FILE=/w.json\nunset PI_PAUSE_WINDOWS_FILE\n");
	const { out, text } = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform: "darwin" });
	assert.doesNotMatch(text(), /would take \/w\.json/, "no value is quoted out of a file this reader cannot vouch for");
	assert.match(text(), /cannot be read off .*\.env: line 3/, "the line that stopped it is named instead");
});

test("doctor: the win32 comparison guard is exercised by the paths `up` actually writes there (#384)", async () => {
	// The guard that stops a single assignment being reported as "assigned TWICE" on Windows was unpinned:
	// the only win32 fixture used a BACKSLASH path, which no POSIX loader vouches for, so the comparison
	// never ran and deleting the guard left the suite green. `up` writes FORWARD slashes on win32
	// (`renderEnvValue` quotes nothing there), and those ARE vouched for by both readers.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "PI_PAUSE_WINDOWS_FILE=C:/pi/pause-windows.json\nexport PI_PAUSE_WINDOWS_FILE=C:/pi/other.json\n");
	const { out, text } = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform: "win32" });
	assert.doesNotMatch(text(), /assigned TWICE/, "no POSIX shell reads a .env on Windows, so there is nothing to disagree with");
	// AND THE PATH IS RESOLVED AS WINDOWS WOULD. `C:/pi/...` is not absolute to a POSIX `isAbsolute`, so the
	// host's own rule joined it under doctor's cwd and every win32 verdict was computed against a path shape
	// Windows never produces -- including the ones these tests assert.
	assert.match(text(), /C:\/pi\/pause-windows\.json/, "the path is reported as the operator wrote it");
	assert.doesNotMatch(text(), /pi-scaffold-[^/]*\/C:/, "and never joined under this cwd as though it were relative");
});

test("doctor: an export-only key in a file with a hazard is not quoted back (#384)", async () => {
	// The export branch is the one place the vouch is load-bearing rather than incidental: a key with NO
	// reading of its own never reaches the "another line reaches past itself" sentence, so without the vouch
	// doctor quotes a value out of a file it has just decided it cannot read.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "export PI_PAUSE_WINDOWS_FILE=/w.json\nunset PI_PAUSE_WINDOWS_FILE\n");
	const { out, text } = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform: "darwin" });
	assert.doesNotMatch(text(), /as `export PI_PAUSE_WINDOWS_FILE=\/w\.json`/, "no value is quoted out of a file with a hazard in it");
	assert.match(text(), /cannot be read off .*\.env: line 2/, "the line that reaches is named instead");
});

test("doctor: concatenated empty quotes are an empty value, and they FAIL (#384)", async () => {
	// `PI_PAUSE_WINDOWS_FILE=""''` is empty to systemd 252 and to all four shells (measured), so the worker
	// refuses to start on it -- and it sits outside the grammar doctor will repeat back, which is a
	// different question. Gating the refusal on that grammar let this deployment exit 0.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), `PI_PAUSE_WINDOWS_FILE=""''\n`);
	const { out, text } = capture();
	const code = await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform: "linux" });
	assert.match(text(), /✗ PI_PAUSE_WINDOWS_FILE is assigned an EMPTY value/, "empty is empty however it is spelled");
	assert.equal(code, 1);
});

test("doctor: a second reading it will not vouch for is not a disagreement (#384)", async () => {
	// The file is readable, so both lines mean what they say -- but the export line's VALUE is outside the
	// grammar, so there is no second value to compare. Coercing that missing value to `""` reported the
	// file as "assigned TWICE ... an EMPTY value, which refuses the boot" about a deployment that is
	// configured and boots.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), `PI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json")}\nexport PI_PAUSE_WINDOWS_FILE=a b\n`);
	const { out, text } = capture();
	const code = await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform: "linux" });
	assert.doesNotMatch(text(), /assigned TWICE/, "a reading this file will not vouch for is not a value to disagree with");
	assert.doesNotMatch(text(), /an EMPTY value, which refuses the boot/, "and certainly not an empty one");
	assert.notEqual(code, 1, "the service's own line is fine and loads");
});

test("doctor: the .env reader answers for ONE loader, and only for the keys it was asked (#357, #384)", () => {
	// The boundary itself, pinned directly. Widening the doctor call's key LIST alone is an equivalent
	// mutant today, because nothing consumes a key these two checks do not name, and that is the safety
	// property rather than an accident: the read is a message decision. What must never drift is the
	// helper's contract, so it is asserted here rather than inferred from the absence of output.
	//
	// PLATFORM IS PASSED EXPLICITLY, never taken from the host (issue #384): `service.mjs` renders exactly
	// one loader per platform, and this helper now answers for that one. A test that read `process.platform`
	// would assert linux's verdict on linux and darwin's on darwin, which is how a per-platform rule goes
	// unchecked on every platform but the author's.
	const seams = (readEnvFile, platform) => ({ fileExists: () => true, readEnvFile, statFile: () => ({ isFile: () => true }), platform });
	const text = ["PI_PAUSE_WINDOWS_FILE=/w.json", "PI_JOB_IMAGE=never:read", "PI_ENV_SETUP=/tmp/evil.sh", "export PI_SCOPED_LIMITS_FILE=/l.json", "PI_PAUSE_WINDOWS_FILE=/a-later.json"].join("\n");

	// NOT the keys it was not asked for, whatever else the file holds. `PI_JOB_IMAGE` and `PI_ENV_SETUP` are
	// both in this fixture and neither may come back: the licence for reading a `.env` at all is that it
	// decides what two named checks say.
	const linux = envFileKeys("/d/.env", ["PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE"], seams(() => text, "linux"));
	assert.equal(linux.PI_JOB_IMAGE, undefined);
	assert.equal(linux.PI_ENV_SETUP, undefined);
	// The later duplicate wins, because every loader takes the last assignment and this reports what the
	// SERVICE sees.
	assert.equal(linux.PI_PAUSE_WINDOWS_FILE, "/a-later.json");
	// systemd does not read an `export` line, so on linux that key is export-only: neither set nor unset,
	// and a sentence of its own. Collapsing it either way makes doctor wrong -- called set, it claims the
	// service reads what systemd does not; called unset, it tells the operator to write a line already there.
	assert.deepEqual(linux.exported, { PI_SCOPED_LIMITS_FILE: "/l.json" });

	// The SAME file on darwin, where the rendered loader is the wrapper and sourcing it honours `export`.
	const darwin = envFileKeys("/d/.env", ["PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE"], seams(() => text, "darwin"));
	assert.equal(darwin.PI_SCOPED_LIMITS_FILE, "/l.json", "the wrapper reads it, so it is simply set");
	assert.deepEqual(darwin.exported, {}, "and nothing is export-only where the loader reads exports");

	// A value outside the grammar every loader reads the same way is reported as a LINE, never as a value.
	const fuzzy = envFileKeys("/d/.env", ["PI_PAUSE_WINDOWS_FILE"], seams(() => "PI_PAUSE_WINDOWS_FILE=/w.json   # written by up", "linux"));
	assert.equal(fuzzy.PI_PAUSE_WINDOWS_FILE, undefined, "no value is claimed");
	assert.deepEqual(fuzzy.notPlain, { PI_PAUSE_WINDOWS_FILE: 1 }, "the line number is what an operator is given instead");

	// A blank assignment is an assignment, and the shape the worker refuses to boot on.
	const blank = envFileKeys("/d/.env", ["PI_PAUSE_WINDOWS_FILE"], seams(() => "PI_PAUSE_WINDOWS_FILE=", "linux"));
	assert.deepEqual(blank.blankInFile, { PI_PAUSE_WINDOWS_FILE: true });

	// Unreadable, missing or not a regular file is `{}`, which restores the unsoftened warning: the worse
	// failure is a deployment told it is fine when nobody could check.
	assert.deepEqual(envFileKeys("/d/.env", ["PI_PAUSE_WINDOWS_FILE"], { fileExists: () => false, readEnvFile: () => text, statFile: () => ({ isFile: () => true }) }), {});
	assert.deepEqual(envFileKeys("/d/.env", ["PI_PAUSE_WINDOWS_FILE"], { fileExists: () => true, readEnvFile: () => text, statFile: () => ({ isFile: () => false }) }), { unreadable: true });
	assert.deepEqual(envFileKeys("/d/.env", ["PI_JOB_IMAGE"], seams(() => text, "linux")), {}, "and a key outside the frozen list is not readable at all");
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
	// NOT "the key is unset", which is what this said and which is a positive claim about a file nobody
	// could open. The intent of the test is unchanged and is what matters: doctor does not go quiet, and it
	// does not soften on evidence it never had.
	assert.match(text(), /⚠ PI_PAUSE_WINDOWS_FILE is unset in this shell, and .*\.env could not be read/, "told-it-is-fine when nobody could check is the worse failure");
	assert.doesNotMatch(text(), /exists but PI_PAUSE_WINDOWS_FILE is unset/, "and it does not answer a question it could not ask");
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
		assert.match(text(), /✗ PI_PAUSE_WINDOWS_FILE is set to an EMPTY value in this shell, which is not unset: the worker keeps it, tries to load "" and REFUSES TO START/, "the verdict is the boot refusal, and it FAILS rather than warns (issue #384)");
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
	// PR #466 gate round 1: counted in render's tiers, so a ⚠ is a warning here as it is everywhere, and a converged run
	// that says "ready" reports no failing check.
	const recheck = /re-check after fixes: (\d+) pass, (\d+) warning\(s\), 0 failing\n/.exec(text());
	assert.ok(recheck, text());
	const tail = text().split("re-check after fixes")[1];
	assert.equal((tail.match(/^⚠ /gm) ?? []).length, Number(recheck[2]), "the warning count is the ⚠ lines listed under it");
	assert.ok(Number(recheck[2]) > 0, "the fixture carries warnings, so the count is not vacuous");
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

test("doctor says the context bound is inert until the job image reports a measurement", async () => {
	// The one bound that can be set and still do nothing. Its measurement comes from the image's runner,
	// and there is deliberately no capability label to check against, so this line is the entire
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

test("doctor --fix: init's next steps follow doctor's venue: PI_BACKENDS=podman gets the podman ladder (#453 gate)", async () => {
	const cwd = tempDir("pi-fix-init-podman-");
	const { out, text } = capture();
	await runDoctor(podmanEnv(), { ...podmanDeps(out, podmanPlan(), []), cwd, fileExists: existsSync, platform: "linux", fix: true, promptFn: async () => false });
	assert.ok(existsSync(join(cwd, ".env")), "init created the .env");
	assert.match(text(), /\nNext \(the podman venue; run these as the worker's own account\. First set the account up as docs\/podman\.md "Setup"\n/);
	assert.match(text(), / {2}6\. pi-dispatch doctor --live {26}# read the bounds, egress and job user back off real containers\n/);
	assert.doesNotMatch(text(), /docker compose -f deploy\/docker-compose\.yml up -d {2}# the durable queue/);
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
	const counts = /re-check after fixes: \d+ pass, \d+ warning\(s\), (\d+) failing\n/.exec(text());
	assert.equal(Number(counts?.[1]), (text().split("re-check after fixes")[1].match(/^✗ /gm) ?? []).length, "the failing count is the ✗ lines listed (PR #466 gate round 1)");
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
	// Issue #433: the podman venue's own image line, the image check of a deployment without `local`.
	[/^podman: job image is not in this account's Podman store \(pi-job:latest\)$/, "prompt"],
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
	// And it takes the RUNNER's path to the network, not a plain fetch that never loads pi (issue #427).
	assert.equal(run.args.at(-1), egressCanaryScript("https://api.anthropic.com/v1/messages"));
	assert.ok(run.args.at(-1).includes(`import(${JSON.stringify(EGRESS_CANARY_RUNNER_MODULE)}).then(m=>m.loadPiThenRestore()`));
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
		ghDeps(out, egressPlan({ [PROXY_KEY]: 1, "gh auth status": { code: 0, output: ghStatusOutput } })),
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
		ghDeps(out, egressPlan({ [PROXY_KEY]: proxyAnswer("none", "exited"), "gh auth status": { code: 0, output: ghStatusOutput } })),
	);
	assert.match(text(), /✗ Egress proxy is stopped \(pi-dispatch-egress-proxy\)/);
});

test("doctor: a paused or crash-looping proxy is not running, and one named by PI_EGRESS_PROXY is started by hand, never by compose (#453 gate)", async () => {
	// The worker's simple rule (gate round 3): paused refuses every job, so ✗; restarting and every other non-running
	// state is retried by the worker, so ⚠ with a fix that says so.
	// `restarting` is a crash loop that fails every job (one retry, then failed), and `created` never starts: both ✗.
	for (const [status, fix] of [["restarting", "its squid keeps exiting and its restart policy keeps bringing it back, so every job is retried once, then failed; `docker logs pi-dispatch-egress-proxy` says why"], ["created", "docker compose -f deploy/docker-compose.yml --profile egress up -d  -- "]]) {
		const failed = capture();
		assert.equal(await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(failed.out, egressPlan({ [PROXY_KEY]: proxyAnswer("none", status), "gh auth status": { code: 0, output: ghStatusOutput } }))), 1, status);
		assert.ok(failed.text().includes(`✗ Egress proxy is ${status} (pi-dispatch-egress-proxy)\n    → ${fix}`), `${status}:\n${failed.text()}`);
	}
	const paused = capture();
	assert.equal(await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(paused.out, egressPlan({ [PROXY_KEY]: proxyAnswer("none", "paused"), "gh auth status": { code: 0, output: ghStatusOutput } }))), 1);
	assert.match(paused.text(), /✗ Egress proxy is paused \(pi-dispatch-egress-proxy\)/);
	for (const status of ["stopping", "removing"]) {
		const retried = capture();
		assert.equal(await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(retried.out, egressPlan({ [PROXY_KEY]: proxyAnswer("none", status), "gh auth status": { code: 0, output: ghStatusOutput } }))), 0, status);
		assert.match(retried.text(), new RegExp(`⚠ Egress proxy is ${status} \\(pi-dispatch-egress-proxy\\)\\n {4}→ a job meanwhile is retried once, then failed \\(the worker does not refuse it outright on this state\\); if it stays ${status}, \`docker logs pi-dispatch-egress-proxy\` says why\\n`), status);
	}
	const { out, text } = capture();
	await runDoctor(ghEnv({ PI_EGRESS: "1", PI_EGRESS_PROXY: "my-squid" }), ghDeps(out, egressPlan({ [PROXY_KEY]: proxyAnswer("none", "exited"), "gh auth status": { code: 0, output: ghStatusOutput } })));
	assert.match(text(), /✗ Egress proxy is stopped \(my-squid\)\n {4}→ PI_EGRESS_PROXY names your own proxy, which neither compose nor `pi-dispatch up` starts: `docker start my-squid` -- /);
	assert.doesNotMatch(text(), /✗ Egress proxy is stopped \(my-squid\)\n {4}→ docker compose/);
});

test("doctor: a RUNNING shipped proxy from another squid, command or folder is ✗; mounts are compared only in a deployment folder whose sources resolve here (#453 gate)", async () => {
	// Real folders, since the mount comparison resolves every bind source on this host (gate round 2).
	const folder = tempDir("pi-proxy-folder-");
	mkdirSync(join(folder, "deploy"));
	writeFileSync(join(folder, "deploy/egress-proxy.conf"), "http_port 3128\n");
	writeFileSync(join(folder, "egress-allowlist.conf"), "api.anthropic.com\n");
	const other = tempDir("pi-proxy-other-");
	writeFileSync(join(other, "egress-allowlist.conf"), "evil.example\n");
	const run = async (answer, { inFolder = true, env = {} } = {}) => {
		const { out, text } = capture();
		const code = await runDoctor(ghEnv({ PI_EGRESS: "1", ...env }), { ...ghDeps(out, egressPlan({ [PROXY_KEY]: answer, "gh auth status": { code: 0, output: ghStatusOutput } })), cwd: folder, proxyFilesExist: () => inFolder });
		return { code, text: text() };
	};
	const esc = (t) => t.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
	const stale = await run(proxyAnswer("healthy", "running", { cwd: folder, image: `ubuntu/squid@sha256:${"0".repeat(64)}` }), { inFolder: false });
	assert.equal(stale.code, 1);
	assert.match(stale.text, /✗ Egress proxy is running but is not this deployment's \(pi-dispatch-egress-proxy\): it was created from ubuntu\/squid@sha256:0{64}, not the pinned ubuntu\/squid@sha256:6a097f68[0-9a-f]{56}\n {4}→ `pi-dispatch up` from the deployment folder offers to replace it with the shipped one/);
	// The entrypoint and command are judged wherever doctor runs (adversary Y7).
	const command = await run(proxyAnswer("healthy", "running", { cwd: folder, entrypoint: ["squid"], cmd: ["-N", "-f", "/tmp/open.conf"] }), { inFolder: false });
	assert.match(command.text, /its entrypoint is \["squid"\], not the image's \["entrypoint\.sh"\]; its command is \["-N","-f","\/tmp\/open\.conf"\]/);
	const elsewhere = await run(proxyAnswer("healthy", "running", { cwd: folder, allowlist: join(other, "egress-allowlist.conf") }));
	assert.equal(elsewhere.code, 1);
	assert.match(elsewhere.text, new RegExp(`its /etc/pi-dispatch/allowlist\\.conf is ${esc(join(other, "egress-allowlist.conf"))}, not ${esc(join(folder, "egress-allowlist.conf"))}`));
	// Run from a folder without the two files, doctor cannot know which folder the service uses: the mounts are not judged.
	assert.equal((await run(proxyAnswer("healthy", "running", { cwd: folder, allowlist: join(other, "egress-allowlist.conf") }), { inFolder: false })).code, 0);
	// Sources that do not resolve on this host: ⚠ unknown, never ✗ (Docker Desktop's shape, not measured here).
	const desktop = await run(proxyAnswer("healthy", "running", { conf: "/host_mnt/Users/op/deploy/deploy/egress-proxy.conf", allowlist: "/host_mnt/Users/op/deploy/egress-allowlist.conf" }));
	assert.equal(desktop.code, 0, "an unknown never fails doctor");
	assert.match(desktop.text, /⚠ Egress proxy's mounts could not be compared on this host \(pi-dispatch-egress-proxy\): \/host_mnt\/Users\/op\/deploy\/deploy\/egress-proxy\.conf, \/host_mnt\/Users\/op\/deploy\/egress-allowlist\.conf are paths this host cannot resolve/);
	assert.doesNotMatch(desktop.text, /is not this deployment's/);
	// Stale by its image with its mounts unknown: `up` offers the replace (PR #456's final check), and the fix says so.
	const desktopOld = await run(proxyAnswer("healthy", "running", { image: "squid:old", conf: "/host_mnt/Users/op/deploy/deploy/egress-proxy.conf", allowlist: "/host_mnt/Users/op/deploy/egress-allowlist.conf" }));
	assert.match(desktopOld.text, /✗ Egress proxy is running but is not this deployment's \(pi-dispatch-egress-proxy\): it was created from squid:old, not the pinned [^\n]*\n {4}→ `pi-dispatch up` from the deployment folder offers to replace it with the shipped one/);
	// Stale on a mount alone while its other mount is unknown: `up` does not offer, so the fix names the commands instead.
	const desktopMount = await run(proxyAnswer("healthy", "running", { conf: "/host_mnt/Users/op/deploy/deploy/egress-proxy.conf", allowlist: join(other, "egress-allowlist.conf") }));
	assert.equal(desktopMount.code, 1);
	assert.match(
		desktopMount.text,
		new RegExp(`✗ Egress proxy is running but is not this deployment's \\(pi-dispatch-egress-proxy\\): its /etc/pi-dispatch/allowlist\\.conf is ${esc(join(other, "egress-allowlist.conf"))}, not ${esc(join(folder, "egress-allowlist.conf"))}\\n {4}→ check its mounts \\(\`docker inspect --format '\\{\\{json \\.Mounts\\}\\}' pi-dispatch-egress-proxy\`\\), then \`docker rm -f pi-dispatch-egress-proxy\` and \`pi-dispatch up\` from the deployment folder replace it with the shipped one; \`up\` does not offer to on its own while one of its mounts cannot be compared here;`),
	);
	// The operator's own proxy is never judged against the shipped one.
	assert.doesNotMatch((await run(proxyAnswer("healthy", "running", { image: "my/squid:1" }), { env: { PI_EGRESS_PROXY: "my-squid" } })).text, /is not this deployment's|could not be compared/);
	// Current: silent.
	assert.doesNotMatch((await run(proxyAnswer("healthy", "running", { cwd: folder }))).text, /is not this deployment's|could not be compared/);
});


test("doctor: a wedged proxy WARNS rather than fails -- health can flap, and the money gate ignores it", async () => {
	const { out, text } = capture();
	const code = await runDoctor(
		ghEnv({ PI_EGRESS: "1" }),
		ghDeps(out, egressPlan({ [PROXY_KEY]: proxyAnswer("unhealthy", "running"), "gh auth status": { code: 0, output: ghStatusOutput } })),
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
	// Issue #462: a FACT LINE, since the operator opened it on purpose and only closing it clears it, so the advice is in
	// the label, which is all an `ok: true` check prints.
	assert.equal(
		rendered([wide]),
		"✓ PI_SECRET_RESOLVER_ROOTS admits panel-declared resolvers under: /opt/pi -- keep those directories writable by nobody but the account the worker runs as: whoever can write a resolver there can run code as the worker\n",
	);
	assert.equal(render([wide], () => {}), false, "a disclosure never fails doctor");
});

test("doctor: a LOCAL trigger binding secrets warns that /workspace is the operator's real folder", async () => {
	// The hazard extending this to cron created: a local job edits the folder in place with no clone, so a
	// credential the agent persists lands in a real repository and survives in a retained sandbox.
	const env = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: secretsTriggersFile({ kind: "local", folder: "/srv/site", profile: "prod" }), PI_SECRET_PROFILES: "prod:/opt/pi/resolve.sh" };
	const checks = await collectChecks(env, secretsSeams());
	const hit = checks.find((c) => /run IN the operator's own folder/.test(c.label));
	assert.ok(hit, "the line must exist");
	// Issue #462: a FACT LINE, not a failure and not a warning: a nightly deploy binding a secret is the use case and
	// nothing clears it but unbinding, so what the operator must know is in the label, which is all a ✓ prints.
	assert.equal(
		rendered([hit]),
		"✓ 1 local trigger(s) bind secrets and run IN the operator's own folder: /srv/site -- a credential the agent writes to .env, .netrc or .git-credentials there lands in your real repository (and in a retained sandbox). Nothing scans for that: keep those folders out of anything you push\n",
	);
	assert.equal(render([hit], () => {}), false);
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
	// Issue #462: unset PI_TRIGGERS_FILE is the split-file hazard, so the line is a WARNING: a ⚠ WITH its fix line (the
	// old `ok: true` printed a ✓ and dropped it), and never a failure, since doctor never touches triggers.
	assert.equal(
		rendered([armedUnset]),
		[
			"⚠ 1 one-shot trigger(s) armed (on.once) -- the worker disarms the entry in ./triggers.json resolved against the worker service's working directory after the run record exists",
			"    → set PI_TRIGGERS_FILE to an absolute path in both services' environments, so worker and receiver name the same file from anywhere",
			"",
		].join("\n"),
	);
	assert.equal(render([armedUnset], () => {}), false, "advisory, never a failure: doctor never touches triggers");

	// Set: the same file by explicit path, and the warning goes away -- worker and receiver now name
	// the same file from anywhere, so the label names the variable instead of the hazard.
	const set = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: join(dir, "triggers.json") }, onceSeams());
	const armedSet = set.find((c) => /one-shot trigger\(s\) armed/.test(c.label));
	assert.ok(armedSet, "the armed advisory still appears -- only its warn flag changes");
	assert.equal(armedSet.warn, false, "with the variable set there is no split-file hazard to warn about");
	assert.equal(rendered([armedSet]), "✓ 1 one-shot trigger(s) armed (on.once) -- the worker disarms the entry in PI_TRIGGERS_FILE after the run record exists\n");
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
	assert.match(empty.text(), /✗ PI_SCOPED_LIMITS_FILE is set to an EMPTY value in this shell, which is not unset: the worker keeps it, tries to load "" and REFUSES TO START/, "the verdict is the boot refusal, and it FAILS rather than warns (issue #384)");
	assert.doesNotMatch(empty.text(), /PI_SCOPED_LIMITS_FILE is unset -- the worker ignores it/);
});

test("doctor: a configured scoped-limits file that will not load is a FAILURE naming the boot refusal, never-tier", async () => {
	const dir = tempDir("pi-sl-bad-");
	const path = join(dir, "scoped-limits.json");
	writeFileSync(path, JSON.stringify({ version: 2, limits: [] }));
	const checks = await collectChecks(imgEnv({ PI_SCOPED_LIMITS_FILE: path }), collectSeams(green, { cwd: dir, nodeVersion: "22.19.0", probeValkey: async () => true }));
	const c = checks.find((x) => /PI_SCOPED_LIMITS_FILE is set in this shell to a file the worker cannot load/.test(x.label));
	assert.ok(c, "the check is present");
	assert.equal(c.ok, false);
	assert.notEqual(c.warn, true, "a boot blocker is a failure, not an advisory");
	assert.match(c.label, /REFUSES TO START/);
	assert.match(c.label, /newer pi-dispatch/, "and the reason is the loader's own words, not a paraphrase written here");
	assert.equal(c.fixAction, undefined, "never-tier: doctor never rewrites limits content");
	// A configured-but-MISSING file is the same class: the worker's loader refuses boot on it.
	const gone = await collectChecks(imgEnv({ PI_SCOPED_LIMITS_FILE: join(dir, "absent.json") }), collectSeams(green, { cwd: dir, nodeVersion: "22.19.0", probeValkey: async () => true }));
	assert.ok(gone.find((x) => /cannot load/.test(x.label) && /does not exist/.test(x.label)));
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
	// Issue #462: a WARNING, a ⚠ with its fix line and never a red X; the old `ok: true` printed a ✓ with no fix.
	assert.equal(c.ok, false);
	assert.equal(c.warn, true);
	assert.equal(render([c], () => {}), false, "a warning never fails doctor");
	assert.equal(
		rendered([c]),
		[
			"⚠ 3 scoped limit(s) name a folder no trigger runs in (./relative-nowhere, sitealone, C:\\srv\\site) -- the cap guards nothing; scopes match exactly (no globs, folders by resolved ABSOLUTE path), so check the spelling against triggers.json run.folder or delete the entry",
			`    → edit ${limitsPath} by hand or via dispatch_limit_edit/_delete -- repo-shaped scopes are never flagged here, because a webhook job's repo comes from the delivery, which triggers.json cannot enumerate`,
			"",
		].join("\n"),
	);
	assert.equal(c.fixAction, undefined, "never-tier");
	assert.ok(!c.label.includes(folder), "the folder row matched across spellings -- not flagged");
	assert.match(c.label, /\.\/relative-nowhere/, "a dead relative row is folder-only and unmatched -- flagged");
	assert.match(c.label, /sitealone/, "a slashless scope can never be a repo -- flagged");
	assert.match(c.label, /C:\\srv/, "a foreign-platform row is inert here -- flagged");
	assert.ok(!c.label.includes("acme/web"), "a repo shape is never flagged -- doctor cannot enumerate webhook repos");
	assert.match(c.label, /resolved ABSOLUTE path/, "the actionable content is in the label as well as the fix");
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
	// Issue #462: a WARNING, a ⚠ with its fix that does not fail the command; the old `ok: true` drew a ✓ and no fix.
	assert.equal(retired.ok, false);
	assert.equal(retired.warn, true, "but it is not silent either");
	assert.equal(render([retired], () => {}), false, "it does not fail the command");
	assert.equal(
		rendered([retired]),
		[
			`⚠ Wait profile retired -> ${join(dir, "gone.sh")} (ENOENT), and no trigger names it`,
			"    → no job looks this up, so nothing refuses today -- fix the path or drop the entry before a trigger starts naming it",
			"",
		].join("\n"),
	);
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
	const code = await runDoctor(env, { ...ghDeps(out, { ...liveOk(), ...green }, calls), live: true, ...instantClock(), liveFs: liveFsAs(1001), jobUserIdentity: LINUX_1001, isAlive: () => false, pid: 7, nonce: "n" });
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
	const code = await runDoctor(liveEnv(), { ...ghDeps(out, { ...liveOk({ uid: "0" }), ...green }), live: true, ...instantClock(), liveFs: liveFsAs(1001), jobUserIdentity: LINUX_1001, isAlive: () => false, pid: 7, nonce: "n" });
	assert.equal(code, 1);
	assert.match(text(), /✗ read back on local: nonRoot does NOT hold -- declared asserted, observed: Uid 0 0 0 0/);
	assert.match(text(), /→ PI_JOB_IMAGE runs as root/);
});

test("doctor --live on a docker CLI not observed local runs no container and says why, once", async () => {
	const { out, text } = capture();
	const calls = [];
	const plan = { ...liveOk(), ...green, "docker context inspect": { code: 0, output: '"remote"|"tcp://10.1.2.3:2375"\n' } };
	await runDoctor(liveEnv(), { ...ghDeps(out, plan, calls), live: true, ...instantClock(), liveFs: liveFsAs(1001), jobUserIdentity: LINUX_1001, isAlive: () => false });
	assert.ok(!calls.some((c) => c.args.some((a) => String(a).includes("pi-dispatch-live"))));
	assert.equal(text().match(/read back on local/g).length, 1);
	assert.match(text(), /⚠ read back on local: not run -- this shell's docker CLI is not observed to point at this host/);
});

test("doctor --live checks carry no fixAction: a failed read-back is never something doctor fixes", async () => {
	const env = liveEnv();
	const facts = { endpoint: { local: true }, dockerCode: 0, imageCode: 0, jobImage: "pi-job:latest", triggerImages: ["a:1", "b:2"], egress: { armed: false, results: [] } };
	const checks = await liveChecks(env, { ...instantClock(), spawn: fakeSpawn({ ...liveOk({ uid: "0" }), ...green }), home: "/home/u", liveFs, isAlive: () => false, pid: 1, nonce: "n" }, facts);
	assert.ok(checks.length >= 7);
	assert.ok(checks.every((c) => c.fixAction === undefined));
	assert.match(checks.at(-1).label, /not the 2 image\(s\) your triggers name/);
	// The not-run path too: a notes-only result must not grow an offer either.
	const notRun = await liveChecks(env, { ...instantClock(), spawn: fakeSpawn(green), liveFs, isAlive: () => false, pid: 1, nonce: "n" }, { ...facts, imageCode: 1 });
	assert.equal(notRun.length, 1);
	assert.match(notRun[0].label, /not run -- the job image pi-job:latest is not present/);
	assert.equal(notRun[0].fixAction, undefined);
});

test("doctor --live gives each localFolders failure its own fix, and names what it swept from an interrupted run", async () => {
	const env = liveEnv();
	mkdirSync(join(env.PI_JOBS_DIR, "pi-dispatch-live-99999-aB3xYz"));
	const facts = { endpoint: { local: true }, dockerCode: 0, imageCode: 0, jobImage: "pi-job:latest", triggerImages: [], egress: { armed: false, results: [] } };
	const invisible = { ...liveOk(), [`docker exec ${LIVE_ID} sh -c [ -r /job ]`]: { code: 0, output: "wrote\n" } };
	const checks = await liveChecks(env, { ...instantClock(), spawn: fakeSpawn({ ...invisible, ...green }), liveFs, isAlive: () => false, pid: 1, nonce: "n" }, facts);
	assert.match(checks[0].label, /✓?read back on local: removed fixture pi-dispatch-live-99999-aB3xYz, left by an interrupted --live run/);
	const folders = checks.find((c) => /localFolders does NOT hold/.test(c.label));
	assert.match(folders.fix, /file sharing/, "a write the host cannot see is not the uid problem");
	assert.doesNotMatch(folders.fix, /uid 1001/);
});

test("doctor --fix --live reads back ONCE, after the fix pass, from the re-collected facts", async () => {
	const cwd = tempDir("pi-live-fix-"); // no .env, so the silent `init` fix runs and forces a re-collect
	const { out, text } = capture();
	const calls = [];
	await runDoctor(liveEnv(), { ...ghDeps(out, { ...liveOk(), ...green }, calls), fileExists: existsSync, cwd, fix: true, promptFn: async () => false, live: true, ...instantClock(), liveFs: liveFsAs(1001), jobUserIdentity: LINUX_1001, isAlive: () => false, pid: 7, nonce: "n" });
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
	await runDoctor(env, { ...ghDeps(out, { ...liveOk(), ...green }), live: true, ...instantClock(), liveFs: liveFsAs(1001), jobUserIdentity: LINUX_1001, isAlive: () => false, pid: 7, nonce: "n" });
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
	const checks = await liveChecks(env, { ...instantClock(), spawn: fakeSpawn({ ...failing, ...green }), liveFs, isAlive: () => false, pid: 1, nonce: "n" }, facts);
	assert.match(checks[0].label, /removed fixture pi-dispatch-live-99998-aB3xYz/);
	assert.ok(checks.some((c) => /not run -- the probe container did not start/.test(c.label)));
	assert.ok(checks.some((c) => c.warn && new RegExp(`could not be removed: docker rm -f ${LIVE_ID}`).test(c.label)), "a failed removal by ID is said on this path too");
});

test("doctor --live's probe that did not start carries the runtime's own words, one clean line (#453 gate)", async () => {
	const env = liveEnv();
	const facts = { endpoint: { local: true }, dockerCode: 0, imageCode: 0, jobImage: "pi-job:latest", triggerImages: [], egress: { armed: false, results: [] } };
	const failing = { ...liveOk(), "docker run --name=pi-dispatch-live-probe-": { code: 126, output: "", stderr: `\nError: OCI runtime error: crun: controller \`cpu\` is not available${String.fromCharCode(27)}[2J\nsecond line\n` } };
	const checks = await liveChecks(env, { ...instantClock(), spawn: fakeSpawn({ ...failing, ...green }), liveFs, isAlive: () => false, pid: 1, nonce: "n" }, facts);
	assert.ok(checks.some((c) => c.label.includes("not run -- the probe container did not start (docker said: Error: OCI runtime error: crun: controller `cpu` is not available [2J), so nothing was read back")), checks.map((c) => c.label).join("\n"));
});

test("doctor --live's not-writable localFolders failure keeps its own ownership fix", async () => {
	const env = liveEnv();
	const facts = { endpoint: { local: true }, dockerCode: 0, imageCode: 0, jobImage: "pi-job:latest", triggerImages: [], egress: { armed: false, results: [] } };
	const notWritable = { ...liveOk(), [`docker exec ${LIVE_ID} sh -c [ -r /job ]`]: { code: 0, output: "not-writable /workspace\n" } };
	const checks = await liveChecks(env, { ...instantClock(), spawn: fakeSpawn({ ...notWritable, ...green }), liveFs, isAlive: () => false, pid: 1, nonce: "n" }, facts);
	assert.match(checks.find((c) => /localFolders does NOT hold/.test(c.label)).fix, /the account the worker runs as/, "issue #341: the fix names the worker's uid, no longer the image's 1001");
});

test("an egress probe that did not RUN is reported as not run, and never passes for a deny", async () => {
	const checks = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" }, collectSeams({ ...green, "docker run --rm --name pi-dispatch-egress-probe-unlisted": 125 }));
	assert.ok(checks.some((c) => /Egress policy probe for an unlisted host did not run \(docker run exited 125\)/.test(c.label) && c.warn === true));
	assert.ok(!checks.some((c) => /denies an unlisted host/.test(c.label)));
	assert.deepEqual(checks.filter((c) => c.readBack).map((c) => c.readBack.reached), [true, null]);
});

test("a job image whose runner predates issue #427 is named once, and neither direction is read as the policy", async () => {
	const calls = [];
	const plan = { ...green, "docker run --rm --name pi-dispatch-egress-probe-provider": EGRESS_CANARY_STALE_RUNNER };
	const checks = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" }, collectSeams(plan, { spawn: fakeSpawn(plan, calls) }));
	const stale = checks.filter((c) => /runner predates issue #427/.test(c.label) && c.label.includes(EGRESS_CANARY_RUNNER_MODULE));
	assert.equal(stale.length, 1);
	assert.equal(stale[0].warn, true);
	assert.match(stale[0].fix, /built after issue #427/);
	assert.ok(calls.some((c) => c.args.some((a) => /egress-probe-provider/.test(a))), "the provider probe ran");
	assert.ok(!calls.some((c) => c.args.some((a) => /egress-probe-unlisted/.test(a))), "the deny probe is not run: its block would be the network's, not the policy's");
	assert.ok(!checks.some((c) => /reaches the provider|denies an unlisted host|did not run/.test(c.label)));
	assert.deepEqual(checks.filter((c) => c.readBack).map((c) => c.readBack.reached), [null]);
	assert.ok(calls.some((c) => c.args.slice(0, 2).join(" ") === "network rm"), "and the canary network is still removed");
});

test("the canary script's exits are real: 4 only for a missing module, 3 for a blocked request, 5 for any load that fails", () => {
	const dir = tempDir("pi-canary-script-");
	const run = (modulePath) => spawnSync(process.execPath, ["-e", egressCanaryScript("http://pi-dispatch-427.invalid/").replace(JSON.stringify(EGRESS_CANARY_RUNNER_MODULE), JSON.stringify(modulePath))], { encoding: "utf8", timeout: 30_000 });
	assert.equal(run(join(dir, "absent.mjs")).status, EGRESS_CANARY_STALE_RUNNER);
	writeFileSync(join(dir, "ok.mjs"), "export async function loadPiThenRestore() { return true; }\n");
	const blocked = run(join(dir, "ok.mjs"));
	assert.equal(blocked.status, 3, blocked.stdout + blocked.stderr);
	assert.match(blocked.stdout, /^blocked /);
	writeFileSync(join(dir, "throws.mjs"), "export async function loadPiThenRestore() { throw new Error(\"no pi\"); }\n");
	const broken = run(join(dir, "throws.mjs"));
	assert.equal(broken.status, 5, "a runner that cannot load pi is no reading, never a block");
	assert.match(broken.stdout, /^error no pi/);
	// A module that IS there but fails to load is a broken image, not an old one: 5, never 4.
	writeFileSync(join(dir, "throwsOnImport.mjs"), "throw new Error(\"broken\");\n");
	assert.equal(run(join(dir, "throwsOnImport.mjs")).status, 5);
	writeFileSync(join(dir, "syntax.mjs"), "export const = ;\n");
	assert.equal(run(join(dir, "syntax.mjs")).status, 5);
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
	const code = await runDoctor(liveEnv(), { ...ghDeps(out, plan, calls), live: true, ...instantClock(), liveFs: liveFsAs(1234), jobUserIdentity: LINUX_ID(1234), stat: socketStat, isAlive: () => false, pid: 7, nonce: "n" });
	assert.equal(code, 0, text());
	assert.ok(calls.filter((c) => c.args[0] === "run" && String(c.args[1]).startsWith("--name=pi-dispatch-live-")).every((c) => c.args.includes("--user=1234:1234")), "the reading and the pinning probe");
	assert.match(text(), /✓ read back on local: the probe ran as uid 1234, the job user this host decides \(1234:1234\)/);
	assert.match(text(), /it ran as the job user 1234:1234, decided for this shell \(uid 1234\)/);

	const wrong = capture();
	assert.equal(await runDoctor(liveEnv(), { ...ghDeps(wrong.out, { ...liveOk({ uid: "1001" }), ...infoPlan(ROOTFUL_INFO), ...imageLabels("anyUid"), ...green }), live: true, ...instantClock(), liveFs: liveFsAs(1234), jobUserIdentity: LINUX_ID(1234), stat: socketStat, isAlive: () => false, pid: 7, nonce: "n" }), 1);
	assert.match(wrong.text(), /✗ read back on local: the probe ran as uid 1001, not the decided job user 1234:1234/);

	const refused = capture();
	const refusedCalls = [];
	await runDoctor(liveEnv(), { ...ghDeps(refused.out, { ...liveOk(), ...infoPlan(ROOTFUL_INFO), ...imageLabels("replicas"), ...green }, refusedCalls), live: true, ...instantClock(), liveFs: liveFsAs(1234), jobUserIdentity: LINUX_ID(1234), stat: socketStat, isAlive: () => false, pid: 7, nonce: "n" });
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
		await runDoctor(liveEnv(), { ...ghDeps(out, { ...liveOk(), ...plan, ...green }, calls), live: true, ...instantClock(), liveFs: liveFsAs(1234), jobUserIdentity: ids, stat: () => ({ uid: 0, gid: 2375 }), isAlive: () => false, pid: 7, nonce: "n" });
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
		const checks = await liveChecks(env, { ...instantClock(), spawn: fakeSpawn({ ...liveOk({ uid: "1234" }), ...over, ...green }), liveFs: liveFsAs(fsUid), isAlive: () => false, pid: 1, nonce: "n", jobUserIdentity: LINUX_ID(1234) }, facts);
		const folders = checks.find((c) => /localFolders does NOT hold/.test(c.label));
		assert.ok(folders, `${label}: ${checks.map((c) => c.label).join("\n")}`);
		assert.match(folders.fix, pattern, label);
		fixes.push(folders.fix);
	}
	assert.equal(new Set(fixes).size, 3, "three causes, three fixes: none falls back to the generic one");
	// A sudo'd doctor is not the worker, and root can remove anything: no owner comparison, so no false not-yours.
	const root = await liveChecks(env, { ...instantClock(), spawn: fakeSpawn({ ...liveOk({ uid: "1234" }), ...green }), liveFs: liveFsAs(999), isAlive: () => false, pid: 1, nonce: "n", jobUserIdentity: { platform: "darwin", euid: 0, egid: 0 } }, facts);
	assert.ok(!root.some((c) => /not-yours|owned by another uid/.test(`${c.label} ${c.fix ?? ""}`)));
	assert.match(root.at(-1).label, /the host owner of what the probe wrote was not compared, because doctor ran as root/, "and the limits line says so");
	const shell = await liveChecks(env, { ...instantClock(), spawn: fakeSpawn({ ...liveOk({ uid: "1234" }), ...green }), liveFs: liveFsAs(1234), isAlive: () => false, pid: 1, nonce: "n", jobUserIdentity: LINUX_ID(1234) }, facts);
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
	await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" }, { ...collectSeams({ ...green, [PROXY_KEY]: proxyAnswer("none", "exited") }), facts: stopped });
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

	const noAddress = await liveChecks(env, { ...instantClock(), ...seams({}), spawn: fakeSpawn({ ...liveOk(), ...livePeersOk({}), "docker inspect --format={{json .NetworkSettings.Networks}}": { code: 1, output: "" }, ...green }) }, facts);
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
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, egressPlan({ [PROXY_KEY]: proxyAnswer("healthy", "running", { stderr: banner }), "gh auth status": { code: 0, output: ghStatusOutput } })));
	assert.match(text(), /✓ Egress proxy running \(pi-dispatch-egress-proxy\)/);
	assert.doesNotMatch(text(), /Egress proxy is stopped/);

	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const plan = { ...EGRESS_OK, "docker info": 0, "docker image inspect --format={{.Id}}": { code: 0, output: "sha256:same\n", stderr: banner }, "docker image": 0 };
	const same = await collectChecks({ VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1" }, collectSeams(plan, { nodeVersion: "22.19.0", readHosts: async () => ({ hosts: [{ name: "mini2", tz, imageDigest: "sha256:same" }] }) }));
	assert.ok(!same.some((c) => /digest differs/.test(c.label)), "the banner is not read as part of the id");
});

test("doctor compares this host's image id in the fleet's form: a bare id Podman prints matches a peer's sha256: one (#354)", async () => {
	// Podman's {{.Id}} has no `sha256:` prefix (measured on 5.8.1); the image preflight a peer publishes from adds it.
	const hex = "a".repeat(64);
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const plan = { ...EGRESS_OK, "docker info": 0, "docker image inspect --format={{.Id}}": { code: 0, output: `${hex}\n` }, "docker image": 0 };
	const same = await collectChecks({ VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1" }, collectSeams(plan, { nodeVersion: "22.19.0", readHosts: async () => ({ hosts: [{ name: "mini2", tz, imageDigest: `sha256:${hex}` }] }) }));
	assert.ok(!same.some((c) => /digest differs/.test(c.label)), same.map((c) => c.label).join("\n"));
	const other = await collectChecks({ VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1" }, collectSeams(plan, { nodeVersion: "22.19.0", readHosts: async () => ({ hosts: [{ name: "mini2", tz, imageDigest: `sha256:${"b".repeat(64)}` }] }) }));
	assert.ok(other.some((c) => /digest differs/.test(c.label)), "a different id still differs");
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

// The scenarios that reach every canary shape, each one the same fixture the shape's own test uses. They
// are listed here rather than derived, and that is the limit this test states: a shape no plan reaches is a
// shape the union check will catch, but a second SITE for a shape some other plan already reaches would be
// invisible. Both `notRemoved` sites are therefore driven on purpose.
const canaryFixture = (extra) => {
	const base = { ...green, "gh auth status": { code: 0, output: ghStatusOutput } };
	for (const key of Object.keys(extra)) delete base[key];
	return { ...extra, ...base };
};
const canaryPlan = (extra, seams = {}) => [
	ghEnv({ PI_EGRESS: "1" }),
	// THE SAME DEPS THE SHAPE'S OWN TEST USES, so this drives the real sweep rather than a near neighbour of
	// it: `collectSeams` does not arm the egress path, and with it every plan below produced no canary line
	// at all -- a union check that passes over an empty set is the kind of green this test exists to refuse.
	// THE SPECIFIC KEYS FIRST, AND WINNING ON DUPLICATES. Both halves are needed and neither is obvious:
	// `fakeSpawn` takes the FIRST key that prefixes the command line, and `green` carries a bare
	// `"docker network"`, so spreading green ahead answered every `network ls` with an empty success and no
	// canary line was produced at all. Spreading green AFTER fixes the order and then overwrites any key a
	// scenario names exactly, which silently restored the local endpoint for the one scenario that needs a
	// remote one. So green's defaults are stripped of whatever the scenario names.
	ghDeps(() => {}, canaryFixture(extra), [], { cwd: tempDir("pi-canary-plan-"), isAlive: () => false, pid: 1, ...seams }),
];
const NET = "pi-dispatch-egress-doctor-4242";
const LS = "docker network ls --filter name=pi-dispatch-egress-doctor-";
// The measured answer of the real docker CLI on a rootless Podman 4.9.3 API socket (round 446): Docker's shape, Podman's
// licence, `name=rootless`.
const PODMAN49_COMPAT_INFO = JSON.stringify({ ServerVersion: "4.9.3", ProductLicense: "Apache-2.0", OperatingSystem: "ubuntu", SecurityOptions: ["name=apparmor", "name=seccomp,profile=default", "name=rootless"] });
const CANARY_PLANS = [
	// held (issue #452, gate round 3): `local` on a rootless Podman 4.9 through its Docker API, no keeper, and a dead
	// doctor's network with the RUNNING proxy on it: the detach gate refuses, so nothing is detached and it is said.
	() => canaryPlan({
		"docker info --format={{json .}}": { code: 0, output: `${PODMAN49_COMPAT_INFO}\n` },
		[LS]: { code: 0, output: `${NET}\n` },
		[`docker network inspect --format {{json .Containers}} ${NET}`]: { code: 0, output: JSON.stringify({ b: { Name: "pi-dispatch-egress-proxy" } }) },
		"docker inspect --format={{.State.Status}}|{{.HostConfig.NetworkMode}}": { code: 1, output: "Error: No such object: pi-dispatch-netns-keeper" },
	}),
	// unlisted: the listing itself fails.
	() => canaryPlan({ [LS]: { code: 1, output: "" } }),
	// unreadable: the network is there and its membership will not parse.
	() => canaryPlan({ [LS]: { code: 0, output: `${NET}\n` }, [`docker network inspect --format {{json .Containers}} ${NET}`]: { code: 0, output: "not json" } }),
	// kept: a probe that will not go, so the network is deliberately left standing.
	() => canaryPlan({
		[LS]: { code: 0, output: `${NET}\n` },
		[`docker network inspect --format {{json .Containers}} ${NET}`]: { code: 0, output: JSON.stringify({ a: { Name: "pi-dispatch-egress-probe-unlisted-4242" } }) },
		"docker rm -f pi-dispatch-egress-probe-unlisted-4242": { code: 1, output: "" },
	}),
	// removed: the ordinary sweep. The probe removal must SUCCEED here, or this is the `kept` path instead.
	() => canaryPlan({
		[LS]: { code: 0, output: `${NET}\n` },
		[`docker network inspect --format {{json .Containers}} ${NET}`]: { code: 0, output: JSON.stringify({ a: { Name: "pi-dispatch-egress-probe-unlisted-4242" }, b: { Name: "pi-dispatch-egress-proxy" } }) },
		"docker rm -f": 0,
	}),
	// gone: the network vanished between this pass's own commands, but the pass DID something.
	() => canaryPlan({
		[LS]: { code: 0, output: `${NET}\n` },
		[`docker network inspect --format {{json .Containers}} ${NET}`]: { code: 0, output: JSON.stringify({ a: { Name: "pi-dispatch-egress-probe-unlisted-4242" } }) },
		// The `rm` fails and the FOLLOW-UP INSPECT gets the daemon's not-found words, which is the shape that
		// reaches the `absent` branch -- the words are read from the inspect, not from the `rm`.
		[`docker network rm ${NET}`]: { code: 1, output: "" },
		[`docker network inspect ${NET}`]: { code: 1, output: `Error response from daemon: network ${NET} not found` },
		"docker rm -f": 0,
	}),
	// notRemoved, from the SWEEP: everything was dealt with and the `rm` still failed for another reason.
	() => canaryPlan({
		[LS]: { code: 0, output: `${NET}\n` },
		[`docker network inspect --format {{json .Containers}} ${NET}`]: { code: 0, output: "{}" },
		[`docker network rm ${NET}`]: { code: 1, output: "Error response from daemon: something else entirely" },
		"docker rm -f": 0,
	}),
	// notRemoved, from doctor's OWN TEARDOWN at the end of a run -- a second site for the same shape. The
	// SWEEP's site is the one nothing drove before (its only assertion was a `doesNotMatch` on pid 4242);
	// this one was already reached by the #350 test that uses `process.pid`. Both are driven here so the
	// shape's two sites cannot drift apart.
	() => canaryPlan({ [`docker network rm pi-dispatch-egress-doctor-1`]: { code: 1, output: "Error response from daemon: has active endpoints" } }, { pid: 1, isAlive: () => true }),
	// foreign: a leftover on a daemon this shell cannot show is on this host. The endpoint comes from the
	// plan, because that is where doctor reads it from -- a seam would be a different code path.
	() => canaryPlan({ [LS]: { code: 0, output: `${NET}\n` }, "docker context inspect": { code: 0, output: '"remote"|"tcp://build.example.invalid:2376"\n' } }),
];

// THE PAGE IS GENERATED FROM THE TABLE, and the sweep is driven to prove the table is what it prints.
//
// What this replaces counted occurrences of ``label: `Egress canary: `` in doctor's SOURCE and required
// `docs/egress.md` to carry a matching number. Its own comment recorded what it could not see -- a constant
// holding the prefix, a plain double-quoted string, `label:` on its own line, an interpolation inside the
// phrase, a label built in another module -- and that it could go false red on a comment quoting the
// prefix. Two cleverer versions were tried and both failed worse: a raw-source count introduced the false
// red at scale, and stripping comments to fix that introduced a false GREEN at thirty times the scale,
// because the block-comment regex treated the `/*` inside `mv ${legacy}/logs/*` as an opener and deleted 88
// lines of live code before counting.
//
// A doc test that PARSES a page or a source file is an arms race the page wins (CLAUDE.md's own rule). So
// the page's first column is GENERATED from `CANARY_LINES`, and the sweep is driven over the real scenarios
// to check that every line it prints came from that table. Neither half reads source text.
test("every canary line doctor prints comes from the table it is generated from (#379)", async () => {
	const seen = new Map();
	for (const plan of CANARY_PLANS) {
		const checks = await collectChecks(...plan());
		for (const check of checks.filter((c) => /^Egress canary: /.test(c.label))) {
			assert.ok(check.canary, `a canary line with no table entry behind it: ${check.label}`);
			const spec = CANARY_LINES[check.canary.shape];
			assert.ok(spec, `unknown shape ${check.canary.shape}`);
			assert.equal(check.label, `Egress canary: ${spec.label(check.canary.params)}`, "the line is exactly what the table builds");
			assert.equal(check.ok, spec.tier === "ok", "and its tier is the table's");
			seen.set(check.canary.shape, (seen.get(check.canary.shape) ?? 0) + 1);
		}
	}
	// EVERY SHAPE, from a scenario that actually reaches it. The union is the check that matters: a shape
	// nothing drives is a shape the page can describe wrongly forever.
	assert.deepEqual([...seen.keys()].sort(), Object.keys(CANARY_LINES).sort(), "every shape in the table is produced by a real scenario");
	// STATED LIMIT, and it is wider than it first looks: this pins every line on a path one of the scenarios
	// below DRIVES. A line built by hand on a path none of them reaches -- an early return, a branch behind
	// a daemon answer nothing here models -- carries no `canary` field and is never seen, so it would not
	// fail this test and the page would not describe it. The union check catches a missing SHAPE, not a
	// missing SITE: `notRemoved` has two, and both are driven deliberately for that reason.
	assert.ok(seen.get("notRemoved") >= 2, "both notRemoved sites are driven, not just the one the union needs");
});

test("a teardown that KEEPS the network does not then remove it (#379)", async () => {
	// The teardown reuses the sweep's `kept` sentence -- "the network is the only way left to find it" -- and
	// then fell straight into removing it, so both halves of the sentence were false in the same run and the
	// probe the page says would be orphaned permanently was orphaned permanently.
	const calls = [];
	const { out, text } = capture();
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, canaryFixture({ "docker run --rm --name pi-dispatch-egress-probe-provider": { code: null, output: "" }, "docker rm -f": 1 }), calls));
	assert.match(text(), /Egress canary: .* is kept, because the probe/, "the line still says the network is kept");
	assert.equal(
		calls.some((c) => c.args.slice(0, 2).join(" ") === "network rm"),
		false,
		"and nothing removes it, which is what the line promises",
	);
});

test("docs/egress.md's canary rows ARE the table, generated (#379)", () => {
	const doc = readFileSync(new URL("../../docs/egress.md", import.meta.url), "utf8");
	const region = /<!-- CANARY-LINES -->\n([\s\S]*?)<!-- \/CANARY-LINES -->/.exec(doc);
	assert.ok(region, "the generated region is still there");
	// EVERY TABLE ROW IN THE REGION, not only the ones that look right: filtering to lines starting "| `"
	// let a fabricated row whose first cell is not backticked sit inside the generated region and be
	// silently dropped.
	const all = region[1].split("\n").filter((l) => l.startsWith("|") && !/^\|\s*(Line|-)/.test(l));
	assert.ok(
		all.every((l) => l.startsWith("| `")),
		"every row in the generated region has a backticked first cell, or it is not a generated row",
	);
	const rows = all.map((l) => l.slice(3, l.indexOf("` |")));
	// The page's placeholders, which are the only hand-written part: the table builds the sentence, this
	// decides what stands in for a network name. The `notRemoved` command is DERIVED rather than typed,
	// because it is the one placeholder that is itself a command the code composes.
	const placeholders = {
		unlisted: { prefix: EGRESS_CANARY_NET_PREFIX },
		foreign: { name: "<net>", cliSays: "<what it resolved>" },
		unreadable: { name: "<net>" },
		kept: { name: "<net>", stuck: ["<probe>"] },
		removed: { name: "<net>", after: "after removing <probes> and detaching <endpoints>" },
		gone: { name: "<net>", did: "removed <probes> and detached <endpoints>" },
		notRemoved: { name: "<net>", command: null },
		held: { name: "<net>", because: "<why>" },
	};
	assert.deepEqual(Object.keys(placeholders), Object.keys(CANARY_LINES), "a shape with no placeholder row is a shape the page cannot describe");
	const expected = Object.entries(CANARY_LINES).map(([shape, spec]) => {
		const params = shape === "notRemoved" ? { ...placeholders[shape], command: `docker network rm ${placeholders[shape].name}` } : placeholders[shape];
		return `${spec.tier === "ok" ? "✓" : "⚠"} Egress canary: ${spec.label(params)}`;
	});
	assert.deepEqual(rows, expected, "the page's first column is the table, in the table's order, or it is stale");
	// THE RETIRED PHRASES, carried over from the test this replaced. It guarded them with the note that a
	// correction had landed everywhere except the page four times on that branch, and dropping the guard let
	// all three back into the columns this test does not otherwise read.
	const section = doc.slice(doc.indexOf("### Lines about leftovers"), doc.indexOf("The two policy lines each run"));
	for (const retired of ["left by a doctor run that did not finish", "from an interrupted doctor", "the network itself was already gone"]) {
		assert.equal(section.includes(retired), false, `the page must not quote a sentence no site can emit: ${retired}`);
	}
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

test("a canary create the BOUND killed is treated as created, and a launch failure is not (#379)", async () => {
	// `liveRunVia` answers `code: null` for two opposite things, and the teardown decision turns on which:
	// a CLI that never launched did nothing, while one killed by the 10s bound may have landed after the
	// daemon already made the network. `ended` is what tells them apart -- without it, reading both as "not
	// created" leaks a network this run will not clean, and reading both as created prints a removal
	// instruction on every host with no docker installed.
	const { out, text } = capture();
	await runDoctor(
		ghEnv({ PI_EGRESS: "1" }),
		ghDeps(out, canaryFixture({ "docker network create": { code: null, output: "" }, "docker network rm": 1, "docker network inspect": { code: 1, output: "", stderr: "Cannot connect to the Docker daemon" } }), []),
	);
	assert.match(text(), /the create did not finish, so it may exist/, "the operator is told the network may be there");
	assert.match(text(), /Egress canary: the network .* could not be removed/, "and the teardown runs, because it may have landed");
});

test("the canary teardown NAMES a probe it could not remove, in the same run (#379)", async () => {
	// The `finally`'s `rm -f` dropped its result, so a probe that would not go was never reported -- while
	// `REQ-EGRESS-ALLOWLIST` says every canary object is removed in this run's `finally` or reported in the
	// same run. It is the same fact the sweep's `kept` line reports one run later, so it uses those words.
	// Through `canaryFixture`, which strips whatever this scenario names out of `green` first: spreading
	// green after would OVERWRITE the wedged probe with green's successful one, and the test would pass over
	// a run where nothing was ever stuck.
	const { out, text } = capture();
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, canaryFixture({ "docker run --rm --name pi-dispatch-egress-probe-provider": { code: null, output: "" }, "docker rm -f": 1 }), []));
	assert.match(text(), /Egress canary: .* is kept, because the probe pi-dispatch-egress-probe-provider-\d+ could not be removed/, "the probe that would not go is named now, not next run");
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

// --- issue #397: every `runCmd` is bounded, and a bound that fires is not the same fact as a missing binary

/** Milliseconds, so the timeout path is a test and not a coffee break. The product default is 30s. */
const FAST_TIMEOUTS = Object.freeze({ cmd: 25, pull: 60 });

test("doctor: a daemon that never answers ends the run instead of holding it forever (#397)", async () => {
	// THE DEFECT ITSELF. `runCmd` had no timeout at all, so `docker info` against a daemon that accepts the
	// connection and never answers held `pi-dispatch doctor` open at the FIRST docker call, with nothing
	// printed and no check to point at. Measured on docker 27.4.0; the CLI's own `--tls*` timeouts do not
	// apply to a socket that is open but silent.
	//
	// The assertion that matters is that this test RETURNS. Without the bound it never does, which is the
	// one failure a suite reports as a job timeout rather than as a red test.
	const cwd = scaffoldedCwd();
	const calls = [];
	const { out, text } = capture();
	// RACED AGAINST A REAL TIMER, and that is the load-bearing part of this test rather than belt. Without
	// the bound nothing in the process is pending: the promise never settles, the event loop EMPTIES, node
	// exits, and the runner reports the file without this test at all -- green. So the failure has to be an
	// assertion rather than an absence, and the sentinel's own timer is what keeps the loop alive to make it
	// one. Measured: with the bound removed this returns NEVER-RETURNED.
	const NEVER = "NEVER-RETURNED";
	let ticker;
	const code = await Promise.race([
		runDoctor(imgEnv(), {
			out,
			cwd,
			spawn: fakeSpawn({ ...green, "docker info": "hang" }, calls),
			probeValkey: async () => true,
			nodeVersion: "22.19.0",
			runTimeouts: FAST_TIMEOUTS,
		}),
		new Promise((resolve) => {
			ticker = setTimeout(() => resolve(NEVER), 2000);
		}),
	]);
	clearTimeout(ticker);
	assert.notEqual(code, NEVER, "doctor RETURNED: an unbounded runCmd would still be waiting on a daemon that never answers");
	assert.equal(code, 1, "a daemon that does not answer is a failure, not a warning");
	assert.match(text(), /Docker daemon reachable \(no answer in 0s\)/, "the label says the daemon did not answer");
	assert.match(text(), /accepted the connection and did not answer/, "and the fix says what that means");
	assert.doesNotMatch(text(), /install Docker/, "NEVER the missing-binary advice: the daemon is running, it is wedged");
	const info = calls.find((c) => [c.cmd, ...c.args].join(" ") === "docker info");
	assert.deepEqual(info.kills, ["SIGKILL"], "the child is killed, and with SIGKILL -- a catchable signal lets a wedged child outlive the bound");
});

test("doctor: a docker that is not installed still says so, which is the OTHER null (#397)", async () => {
	// The two nulls are opposite facts and this is the pin that keeps them apart: `ended` distinguishes a
	// CLI that never launched from one killed by the bound. Before `ended` existed there was one null and
	// the label had to guess.
	const cwd = scaffoldedCwd();
	const { out, text } = capture();
	const code = await runDoctor(imgEnv(), {
		out,
		cwd,
		spawn: fakeSpawn({ ...green, "docker info": "enoent" }),
		probeValkey: async () => true,
		nodeVersion: "22.19.0",
		runTimeouts: FAST_TIMEOUTS,
	});
	assert.equal(code, 1);
	assert.match(text(), /install Docker/, "a binary that is not on PATH gets the install advice");
	assert.doesNotMatch(text(), /no answer in/, "and never the wedged-daemon wording");
});

test("doctor: a gh that does not answer says it COULD NOT CHECK, not that the branch is unprotected (#397)", async () => {
	// The one site where reading a timeout as a non-zero exit would have been a WRONG VERDICT rather than a
	// missing one: this is a network call, and "gh did not finish" is not "the branch is open". Telling an
	// operator to go and protect an already-protected branch is the kind of advice that teaches people to
	// scroll past doctor.
	// The two gh calls per repo are ordered and both start `gh api repos/o/r`, so the plan keys are the FULL
	// argv line: the branch read must answer for the protection read to be reached at all.
	const checks = await githubProtectionPreflight(
		fakeSpawn({
			"gh auth status": { code: 0, output: "Token scopes: 'repo'" },
			"gh api repos/o/r --jq .default_branch": { code: 0, output: "main\n" },
			"gh api repos/o/r/branches/main/protection": "hang",
		}),
		["o/r"],
		FAST_TIMEOUTS,
	);
	const line = checks.map((c) => c.label).join("\n");
	assert.match(line, /could not check branch protection for o\/r/, "it says it could not tell");
	assert.doesNotMatch(line, /is not protected/, "and never claims the branch is open");
});

test("doctor: the `--fix` pull runs under the LONG bound, not the default one (#397)", async () => {
	// One bound for every call is either too short for a cold `docker pull` -- minutes of legitimate work --
	// or too long to be a bound at all, which is why this file has two and why the pull names its own.
	//
	// Pinned by the CLOCK, because the timeout is not visible in the argv: with a pull that never answers,
	// a fix wired to the default bound gives up at `cmd` and one wired to the pull bound at `pull`. The
	// assertion is a floor, so a slow machine can only make it pass harder.
	const cwd = scaffoldedCwd();
	const { out } = capture();
	const checks = await collectChecks(imgEnv(), {
		cwd,
		spawn: fakeSpawn({ ...green, "docker image inspect pi-job:latest": 1 }),
		probeValkey: async () => true,
		fileExists: existsSync,
		nodeVersion: "22.19.0",
		platform: "linux",
		home: tempDir("pi-397-home-"),
		out,
		runTimeouts: FAST_TIMEOUTS,
	});
	const image = checks.find((c) => String(c.label).startsWith("Job image present"));
	assert.ok(image?.fixAction, "the job-image check offers the pull");

	const began = Date.now();
	const res = await image.fixAction.run({ spawn: fakeSpawn({ "docker pull": "hang", docker: 0 }), cwd, env: imgEnv() });
	const took = Date.now() - began;
	assert.equal(res.ok, false);
	assert.match(res.note, /docker pull did not finish within/, "the note says the bound fired, not that the pull failed");
	assert.ok(took >= FAST_TIMEOUTS.pull - 5, `waited ${took}ms, which is the PULL bound (${FAST_TIMEOUTS.pull}) and not the default (${FAST_TIMEOUTS.cmd})`);
});

test("doctor: the two bounds are what ship, and the pull one is the larger (#397)", async () => {
	// The values themselves, because every test above injects its own. `cmd` matches `runCmdCapture`'s, so
	// the two runners in that file do not disagree about what "too long" means, and `pull` matches the 600s
	// the same file already gives `import-pi`.
	assert.equal(RUN_TIMEOUTS.cmd, 30_000);
	assert.equal(RUN_TIMEOUTS.pull, 600_000);
	assert.ok(RUN_TIMEOUTS.pull > RUN_TIMEOUTS.cmd, "the override exists to be LONGER; equal values would mean one bound and no reason for two");
	assert.ok(Object.isFrozen(RUN_TIMEOUTS));
});

test("doctor: a wedged daemon is TRANSIENT to the backend floor, not a missing CLI (#397)", async () => {
	// THE CONFLATION THIS ISSUE IS ABOUT, one call site further on than the one that was fixed first. The
	// floor's daemon read used `dockerCode === null`, which after the bound means BOTH causes, so a wedged
	// host got `reason: "docker-not-found"` -- and `runtime-observations` treats that as DETERMINATE
	// (`value: false`, "answered, so a floor refuses"). The two hosts produced a byte-identical refusal
	// telling an operator whose CLI is fine that no docker CLI was found.
	//
	// The transient class has its own sentence already written; this pins that a timeout reaches it.
	const cwd = scaffoldedCwd();
	const seams = (info) => ({
		cwd,
		spawn: fakeSpawn({ ...green, "docker info": info }),
		probeValkey: async () => true,
		fileExists: existsSync,
		nodeVersion: "22.19.0",
		platform: "linux",
		home: tempDir("pi-397-floor-"),
		out: () => {},
		runTimeouts: FAST_TIMEOUTS,
	});
	const env = { ...imgEnv(), PI_BACKEND_FLOOR: "isolation=enforced" };
	const wedged = (await collectChecks(env, seams("hang"))).filter((c) => /PI_BACKEND_FLOOR/.test(String(c.label)));
	const missing = (await collectChecks(env, seams("enoent"))).filter((c) => /PI_BACKEND_FLOOR/.test(String(c.label)));
	assert.ok(wedged.length > 0 && missing.length > 0, "both hosts produce a floor line");
	assert.notDeepEqual(
		wedged.map((c) => [c.label, c.fix]),
		missing.map((c) => [c.label, c.fix]),
		"the two hosts must not read identically: one is answered-and-refused, the other unanswered-and-retried",
	);
	// The two classes have their own sentences, and this is the difference that matters to an operator: one
	// is told to fix what stops the daemon answering and that the worker will retry, the other is told the
	// floor cannot be met on this runtime at all.
	assert.match(JSON.stringify(wedged), /fix what stops the daemon answering/, "the wedged host gets the TRANSIENT sentence");
	assert.match(JSON.stringify(wedged), /supervisor retries/, "which says the worker will keep trying");
	assert.match(JSON.stringify(missing), /Run jobs on a rootful Docker Engine/, "the host with no CLI gets the DETERMINATE refusal");
	assert.doesNotMatch(JSON.stringify(missing), /fix what stops the daemon answering/, "and never the transient one");
	// The reason travels as far as the evidence string, which is where the conflation was visible.
	const isolation = (await collectChecks(env, seams("hang"))).find((c) => /isolation is ASSERTED/.test(String(c.label)));
	assert.match(String(isolation.label), /docker-no-answer/, "the evidence names the timeout");
	assert.doesNotMatch(String(isolation.label), /docker-not-found/, "and never the missing-CLI reason");
});

test("doctor: a daemon that did not answer is not offered a pull to fix it (#397)", async () => {
	// Changing only the LABEL left `--fix` offering an operator a `docker pull` against the daemon doctor had
	// just reported as unresponsive: it would hang for the pull bound, ten minutes, and then report a failed
	// fix. A verdict that says "I could not tell" must not carry an action that assumes the answer.
	const cwd = scaffoldedCwd();
	const seams = (info) => ({
		cwd,
		// The specific key FIRST: the fake resolves by the first key that PREFIXES the line, so a broader key
		// from `green` would shadow this one. And `docker info` must ANSWER, because the image check is only
		// asked when it did -- the hang has to be the image read itself.
		spawn: fakeSpawn({ "docker image inspect pi-job:latest": info, ...green }),
		probeValkey: async () => true,
		fileExists: existsSync,
		nodeVersion: "22.19.0",
		platform: "linux",
		home: tempDir("pi-397-pull-"),
		out: () => {},
		runTimeouts: FAST_TIMEOUTS,
	});
	const wedged = (await collectChecks(imgEnv(), seams("hang"))).find((c) => String(c.label).startsWith("Job image present"));
	assert.ok(wedged, "the job-image check ran, which needs `docker info` to have answered");
	assert.match(wedged.label, /the daemon did not answer/, "the label says which");
	assert.match(wedged.fix, /restart Docker first/, "and so does the fix, instead of naming a pull");
	assert.equal(wedged.fixAction, undefined, "no prompt-tier action on a check that could not be answered");

	// The SAME check on a daemon that answered and really has no image keeps the pull, which is the point:
	// the action is withheld for the unanswered case only.
	const absent = (await collectChecks(imgEnv(), seams(1))).find((c) => String(c.label).startsWith("Job image present"));
	assert.equal(absent.ok, false);
	assert.match(absent.fix, /docker pull/, "an ANSWERED absence still gets the pull");
	assert.equal(absent.fixAction?.tier, "prompt");
});

test("doctor: a trigger image whose daemon did not answer says so too (#397)", async () => {
	// The per-trigger loop is a second site for the same sentence, and the sweep that drives the first does
	// not reach it: deleting this label leaves every other test green.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, "triggers.json"), JSON.stringify({ triggers: [{ on: { type: "cron", id: "n", pattern: "0 3 * * *" }, run: { kind: "local", folder: cwd, flow: "f", task: "t", image: "my-python:1.2.0" } }] }));
	const checks = await collectChecks(
		{ ...imgEnv(), PI_TRIGGERS_FILE: join(cwd, "triggers.json") },
		{
			cwd,
			spawn: fakeSpawn({ "docker image inspect my-python:1.2.0": "hang", ...green }),
			probeValkey: async () => true,
			fileExists: existsSync,
			nodeVersion: "22.19.0",
			platform: "linux",
			home: tempDir("pi-397-trig-"),
			out: () => {},
			runTimeouts: FAST_TIMEOUTS,
		},
	);
	const line = checks.find((c) => String(c.label).startsWith("Trigger job image present"));
	assert.ok(line, "the trigger's image is checked");
	assert.match(line.label, /my-python:1\.2\.0.*the daemon did not answer/, "and an unanswered read says so rather than reading as absent");
});

test("doctor: the valkey --fix `docker run` gets the PULL bound, because it may fetch an image (#397)", async () => {
	// `docker run valkey/valkey:8` on a host that does not have that image PULLS it first, so this is the
	// second fetching action and it needs the same bound as the job-image pull. Pinned by the clock, as a
	// floor: on the default bound this would give up at `cmd`.
	const cwd = scaffoldedCwd();
	const checks = await collectChecks(
		{ ...imgEnv(), VALKEY_URL: "redis://127.0.0.1:6379" },
		{
			cwd,
			spawn: fakeSpawn(green),
			probeValkey: async () => false,
			fileExists: existsSync,
			nodeVersion: "22.19.0",
			platform: "linux",
			home: tempDir("pi-397-valkey-"),
			out: () => {},
			runTimeouts: FAST_TIMEOUTS,
		},
	);
	const valkey = checks.find((c) => c.fixAction?.describe?.startsWith("docker run"));
	assert.ok(valkey, "the unreachable-valkey check offers the start");
	const began = Date.now();
	const res = await valkey.fixAction.run({ spawn: fakeSpawn({ docker: "hang" }), cwd, env: imgEnv() });
	const took = Date.now() - began;
	assert.equal(res.ok, false);
	assert.ok(took >= FAST_TIMEOUTS.pull - 5, `waited ${took}ms, which is the PULL bound (${FAST_TIMEOUTS.pull}) and not the default (${FAST_TIMEOUTS.cmd})`);
});

test("doctor: a line the reader cannot model is said ONCE for the file, naming both keys (#396)", async () => {
	// It was said once per KEY, inside the per-key loop, so one unreadable line produced two near-identical
	// warnings differing only in which key they named. The fact is about the FILE, and nothing pinned the
	// count -- hoisting it out left the whole suite green.
	// PLATFORM DRIVEN EXPLICITLY, and the reason is a fact worth writing down rather than a test detail: THIS
	// hazard is a line a SOURCING loader cannot get past, and systemd has none of these -- it ignores what it
	// cannot parse rather than aborting, measured in #384 for `unset K`, a command substitution, an unclosed
	// quote and a bare word alike. So this warning can only arise for this file where the service SOURCES it,
	// which is darwin and the sh wrapper. (systemd has hazards of its own since #447 -- a lone CR, a reopened
	// quote, a quoted value under a non-identifier key, a continuation the line scan misses, a quote the
	// region model gets wrong, a file it will not load -- and this file has none of them, which the Linux
	// half below still pins.) Left on the default platform, this passed on macOS and reported zero lines on
	// CI's Linux, which is the platform-dependent-fixture defect this round has hit before.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), `unset PI_PAUSE_WINDOWS_FILE\nPI_SCOPED_LIMITS_FILE=${join(cwd, "scoped-limits.json")}\n`);
	const { out, text } = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform: "darwin" });
	const lines = text().split("\n").filter((l) => /cannot be read off/.test(l));
	assert.equal(lines.length, 1, `exactly one line about the file, got:\n${lines.join("\n")}`);
	// DERIVED, not spelled: replacing the `BOOT_FILES.map(...).join(" or ")` with the literal string left this
	// green, so a third boot key would silently keep the line naming two while its own "reads only the two it
	// names" became false. `ENV_FILE_READABLE_KEYS` is the frozen set the reader is allowed to look at, and
	// it is what the line has to agree with.
	for (const key of ENV_FILE_READABLE_KEYS) assert.ok(lines[0].includes(key), `the line names ${key}, which the reader reads`);
	// AND ON LINUX THERE IS NO SUCH LINE AT ALL, which is the other half of the same fact: systemd reads the
	// file without aborting, so nothing about it is unreadable to this command.
	const onLinux = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(onLinux.out, cwd), platform: "linux" });
	assert.doesNotMatch(onLinux.text(), /cannot be read off/, "systemd ignores the line rather than stopping at it, so there is nothing to warn about");
	assert.ok(lines[0].includes(` or `), "and joins them, rather than naming one");
	// The limit sentence rides the FIX line, not the label, so it is matched against the whole report.
	assert.match(text(), new RegExp(`reads only the ${ENV_FILE_READABLE_KEYS.length === 2 ? "two" : String(ENV_FILE_READABLE_KEYS.length)} it names`), "the count in the limit sentence matches the frozen set");
	// AND BY SHAPE, because with exactly two keys a frozen literal produces the same string and every
	// assertion above passes on it -- measured. The risk the derivation exists for is a THIRD boot file, at
	// which point the literal would keep naming two while the sentence beside it kept saying "the two it
	// names". This reads the source, so its limit is the usual one: it sees the expression, not the output.
	const src = readFileSync(new URL("../src/doctor.mjs", import.meta.url), "utf8");
	assert.match(src, /BOOT_FILES\.map\(\(spec\) => spec\.key\)\.join\(/, "the names in that line are derived from BOOT_FILES, not spelled out");
	// The limit is IN the line, because the same hazard may stop a sourcing shell reaching a key this
	// command does not read at all -- WEBHOOK_SECRET, which the receiver refuses to start without.
});

test("doctor: a line systemd reads differently is named with its shape, once, and no reading is printed (#447)", async () => {
	// The same once-per-file line as #396's, from systemd's side: the file is one systemd splits into lines
	// differently from this command, so neither boot key's reading can be vouched for. Each issue shape, on Linux.
	const shapes = [
		["X=1\rY=2\n", 2, /has a carriage return \(CR\) that is not part of a CRLF line ending/, /remove the CR, or save the file with LF \(or CRLF\) line endings/],
		['NOTE="a" "b\nOTHER=1\n"\n', 2, /has a second quote right after a value's closing quote/, /remove the second quote, or close it on the same line/],
		['FOO-BAR="x\nOTHER=1\n"\n', 2, /has a quoted value under a key that is not a variable name/, /rename the key to a valid variable name/],
		['NOTE="a\nb"\\\nOTHER=1\n', 3, /has a trailing backslash that systemd reads as joining the next line/, /remove the trailing backslash, or move the value onto one line/],
	];
	for (const [hazard, line, what, fix] of shapes) {
		const cwd = scaffoldedCwd();
		writeFileSync(join(cwd, ".env"), `PI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json")}\n${hazard}`);
		const { out, text } = capture();
		const code = await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform: "linux" });
		const lines = text().split("\n").filter((l) => /cannot be read off/.test(l));
		assert.equal(lines.length, 1, `one line for the file: ${JSON.stringify(hazard)}\n${text()}`);
		assert.ok(lines[0].startsWith(`⚠ whether PI_PAUSE_WINDOWS_FILE or PI_SCOPED_LIMITS_FILE reaches the service cannot be read off ${join(cwd, ".env")}: line ${line} `), lines[0]);
		assert.match(lines[0], what);
		assert.match(text(), new RegExp(`on line ${line} of that file, ${fix.source}`), "the fix names the line and what to change");
		assert.doesNotMatch(text(), /PI_PAUSE_WINDOWS_FILE is set in .* and loads/, "and no reading of a file systemd splits differently");
		assert.equal(code, 0, "a warning, as #396's line is");
	}
	// The harmless neighbours read as before: after a closing quote any other character puts systemd in VALUE.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), `NOTE="a" # "b\nOTHER='x'y'\nPI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json")}\n`);
	const { out, text } = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform: "linux" });
	assert.doesNotMatch(text(), /cannot be read off/);
	assert.ok(text().includes(`✓ PI_PAUSE_WINDOWS_FILE is set in ${join(cwd, ".env")} (${join(cwd, "pause-windows.json")}) and loads`));
});

test("doctor: a .env systemd will not LOAD fails on Linux, naming the line and the byte (#447 gate round 1)", async () => {
	// Measured on systemd 259: a NUL anywhere (a comment included) or invalid UTF-8 in a value fails the unit at start.
	for (const [tail, what, fix] of [
		[Buffer.concat([Buffer.from("# a"), Buffer.from([0]), Buffer.from("b\n")]), /line 2 has a NUL byte, and systemd refuses to load a file with one anywhere in it, so the service does not start/, /on line 2 of that file, remove the NUL byte, then run doctor again/],
		[Buffer.concat([Buffer.from("K=caf"), Buffer.from([0xe9]), Buffer.from("\n")]), /line 2 has bytes in a key or value that are not valid UTF-8, or a Unicode noncharacter \(U\+FFFE, U\+FFFF, U\+FDD0 to U\+FDEF and the like\), and systemd refuses to load such a file/, /re-save the file as UTF-8, or remove those bytes/],
		// Gate round 3: too large to exec (measured 203/EXEC on systemd 259), which also stops the service starting.
		[Buffer.from(`X=${"h".repeat(200000)}\n`), /line 2 has more environment than the service can safely be started with: .*\(X=\.\.\. is 200002 bytes\)/, /shorten that value, or move the large content into a file/],
	]) {
		const cwd = scaffoldedCwd();
		writeFileSync(join(cwd, ".env"), Buffer.concat([Buffer.from(`PI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json")}\n`), tail]));
		const { out, text } = capture();
		const code = await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform: "linux" });
		assert.match(text(), new RegExp(`✗ whether PI_PAUSE_WINDOWS_FILE or PI_SCOPED_LIMITS_FILE reaches the service cannot be read off .*: ${what.source}`));
		assert.match(text(), fix);
		assert.doesNotMatch(text(), /PI_PAUSE_WINDOWS_FILE is set in .* and loads/);
		assert.equal(code, 1, "a service that cannot start fails doctor");
	}
	// A stray byte in a COMMENT is never pushed and systemd loads the file (measured): no line about it.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), Buffer.concat([Buffer.from("# caf"), Buffer.from([0xe9]), Buffer.from(`\nPI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json")}\n`)]));
	const ok = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(ok.out, cwd), platform: "linux" });
	assert.doesNotMatch(ok.text(), /cannot be read off/);
	assert.ok(ok.text().includes(`✓ PI_PAUSE_WINDOWS_FILE is set in ${join(cwd, ".env")} (${join(cwd, "pause-windows.json")}) and loads`));
});

test("doctor: a lone CR is systemd's line break and not the wrapper's, so darwin says nothing about it (#447)", async () => {
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), `PI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json")}\nX=1\rY=2\n`);
	const { out, text } = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform: "darwin" });
	assert.doesNotMatch(text(), /cannot be read off/, "a sourcing shell reads LF lines, and the CR is part of X's value there");
	assert.ok(text().includes(`✓ PI_PAUSE_WINDOWS_FILE is set in ${join(cwd, ".env")} (${join(cwd, "pause-windows.json")}) and loads`));
});

test("doctor: a boot key line inside a multi-line quoted value is not read as the key on Linux (#447)", async () => {
	// The residual #430 left: systemd continues a value that OPENS with a quote to its close (env_file_6), and
	// doctor's systemd reading did not know, so it said this key "is set ... and loads" while the service never
	// saw it. It is now named as inside that value, and the fix is about the quote, not the line.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), `NOTE="see\nPI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json")}\n"\n`);
	const { out, text } = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), platform: "linux" });
	assert.doesNotMatch(text(), /PI_PAUSE_WINDOWS_FILE is set in .* and loads/, "not read as the key");
	assert.match(text(), /⚠ PI_PAUSE_WINDOWS_FILE on line 2 of .*\.env lies inside the quoted value that opens on line 1, so the service reads it as part of that value and not as PI_PAUSE_WINDOWS_FILE/);
	assert.match(text(), /close the quote that opens on line 1 before line 2, or write that value's newlines as \\n escapes/);
	// A value that closes ABOVE the key leaves it an ordinary line, as the documented PEM does.
	writeFileSync(join(cwd, ".env"), `GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----"\nPI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json")}\n`);
	const pem = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(pem.out, cwd), platform: "linux" });
	assert.ok(pem.text().includes(`✓ PI_PAUSE_WINDOWS_FILE is set in ${join(cwd, ".env")} (${join(cwd, "pause-windows.json")}) and loads`));
});

test("doctor: removing a regular-file guard REDDENS this file instead of hanging it (#396)", async () => {
	// THE ORACLE FOR THE THREE FIFO TESTS ABOVE, and the reason it has to be a child process. Those three
	// drive `runDoctor` in-process, so with a guard deleted `readFileSync` blocks forever on the FIFO: the
	// read cannot be interrupted, `--test-timeout` cannot reach a blocked event loop, and CI reports a job
	// timeout rather than a failure. The tests say so in a comment, which is honest but is not a pin.
	//
	// A BOUNDED CHILD turns that into an assertion, using the `spawnSync` + `killSignal: "SIGKILL"` shape
	// `receiver/test/start.test.mjs` already uses: SIGKILL because `spawnSync` waits for the child to exit,
	// so a catchable signal lets a process blocked in a synchronous read outlive the bound.
	const { spawnSync } = await import("node:child_process");
	const cwd = scaffoldedCwd();
	const fifo = join(cwd, "fifo.json");
	if (spawnSync("mkfifo", [fifo]).status !== 0) return; // no mkfifo on this host: nothing to say
	const doctorUrl = new URL("../src/doctor.mjs", import.meta.url).href;
	const script = `
		const { runDoctor } = await import(${JSON.stringify(doctorUrl)});
		const code = await runDoctor({ PI_JOB_IMAGE: "pi-job:latest", PI_PAUSE_WINDOWS_FILE: ${JSON.stringify(fifo)} }, {
			cwd: ${JSON.stringify(cwd)},
			out: () => {},
			spawn: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); },
			probeValkey: async () => true,
			nodeVersion: "22.19.0",
		});
		process.stdout.write("EXITED:" + code);
	`;
	const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { timeout: 20000, killSignal: "SIGKILL", encoding: "utf8" });
	// The ERROR is checked before the status, because a killed child has `status: null` and would otherwise
	// read as an ordinary non-zero exit.
	assert.equal(r.error?.code, undefined, `doctor RETURNED rather than blocking on the FIFO; if this is ETIMEDOUT a regular-file guard is missing. stderr: ${r.stderr}`);
	assert.match(String(r.stdout), /EXITED:\d/, `the child ran doctor to completion; stderr: ${r.stderr}`);
});

// --- issue #355: SELinux labels on the directories the worker never relabels ------------------------------------

// Measured through rootful Podman 5.8.1's compat API on an enforcing Fedora 44 host (SecurityOptions verbatim).
const PODMAN_SELINUX_INFO = JSON.stringify({ ServerVersion: "5.8.1", OperatingSystem: "fedora", SecurityOptions: ["name=seccomp,profile=default", "name=selinux"], PidsLimit: true, MemoryLimit: true, CpuCfsQuota: false, ProductLicense: "Apache-2.0" });
const statPlan = (answers) => Object.fromEntries(Object.entries(answers).map(([dir, answer]) => [`stat -L --format=%C -- ${dir}`, answer]));

test("the SELinux label check: user_home_t warns with the semanage fix, container_file_t passes, an unanswered stat is quiet (#355)", async () => {
	const { selinuxLabelChecks } = await import("../src/doctor.mjs");
	const calls = [];
	const spawn = fakeSpawn(
		statPlan({
			"/home/op/repo": { code: 0, output: "unconfined_u:object_r:user_home_t:s0\n" },
			"/srv/labelled": { code: 0, output: "system_u:object_r:container_file_t:s0\n" },
			"/srv/readonly": { code: 0, output: "system_u:object_r:container_ro_file_t:s0\n" },
			"/srv/private": { code: 0, output: "system_u:object_r:container_file_t:s0:c12,c345\n" },
			"/srv/unreadable": { code: 1, output: "stat: cannot statx '/srv/unreadable': Permission denied\n" },
			"/srv/nolabel": { code: 0, output: "?\n" },
			"/srv/failed": { code: 1, output: "system_u:object_r:container_file_t:s0\n" },
			"/srv/pi's overlay": { code: 0, output: "unconfined_u:object_r:var_t:s0\n" },
		}),
		calls,
	);
	const checks = await selinuxLabelChecks({ folders: ["/home/op/repo", "/srv/labelled", "/srv/readonly", "/srv/private", "/srv/unreadable", "/srv/nolabel", "/srv/failed"], overlay: "/srv/pi's overlay", spawn, realpath: (dir) => dir, readFile: noSelinuxFiles });
	const byDir = (dir) => checks.find((c) => c.label.includes(` ${dir} `));
	assert.deepEqual([checks[0].ok, checks[0].label], [true, "SELinux: jobs' own directories are relabelled for SELinux (:Z); a local folder and the global overlay never are"]);
	const home = byDir("/home/op/repo");
	assert.deepEqual([home.ok, home.warn], [false, true], "a per-job refusal, never a boot one");
	assert.match(home.label, /the local folder \/home\/op\/repo is labelled user_home_t, not a container type, so a job container may be denied it \(measured: user_home_t, user_tmp_t, var_lib_t and var_t are\) -- a job in it that is denied is refused before it spends/);
	assert.ok(home.fix.includes("semanage fcontext -a -t container_file_t '/home/op/repo(/.*)?' && restorecon -R /home/op/repo"), home.fix);
	assert.deepEqual([byDir("/srv/labelled").ok, byDir("/srv/labelled").warn], [true, undefined]);
	assert.match(byDir("/srv/labelled").label, /is labelled container_file_t, which a container can read/);
	assert.deepEqual([byDir("/srv/readonly").ok, byDir("/srv/readonly").warn], [true, undefined], "container_ro_file_t is readable too");
	const priv = byDir("/srv/private");
	assert.deepEqual([priv.ok, priv.warn], [false, true], "another container's :Z locks every other one out");
	assert.match(priv.label, /with a private category pair/);
	for (const dir of ["/srv/unreadable", "/srv/nolabel", "/srv/failed"]) {
		const quiet = byDir(dir);
		assert.deepEqual([quiet.ok, quiet.warn, quiet.fix], [true, undefined, undefined], dir);
		assert.match(quiet.label, /was not checked \(stat did not answer with one\)/, dir);
	}
	const overlay = checks.find((c) => c.label.includes("global overlay /srv/pi's overlay"));
	assert.deepEqual([overlay.ok, overlay.warn], [false, true]);
	assert.match(overlay.label, /labelled var_t, not a container type, so a job container may be denied it \(measured: user_home_t, user_tmp_t, var_lib_t and var_t are\) -- a job that is denied it is refused before it spends/);
	// A space in the rule is a hex escape (semanage refuses one written plainly or backslashed, measured); restorecon takes
	// the path as it is.
	assert.ok(overlay.fix.includes(`semanage fcontext -a -t container_file_t '/srv/pi'\\''s\\x20overlay(/.*)?' && restorecon -R '/srv/pi'\\''s overlay'`), overlay.fix);
	assert.deepEqual(calls.map((c) => [c.cmd, ...c.args]).at(0), ["stat", "-L", "--format=%C", "--", "/home/op/repo"], "one stat per directory, through a link, the path after --");
	assert.equal(calls.length, 8);
});

// No policy files: no equivalences, and nothing read from this machine's /etc.
const noSelinuxFiles = () => {
	throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
};

test("the SELinux label check names the directory restorecon meets: through every link, then back through the policy's equivalences (#355)", async () => {
	const { selinuxLabelChecks } = await import("../src/doctor.mjs");
	const folders = ["/home/op/linked", "/home/op/chain", "/home/op/plink/repo", "/home/op/plain", "/home/op/aliased", "/home/op/sp ace"];
	const answers = Object.fromEntries(folders.map((dir) => [dir, { code: 0, output: "unconfined_u:object_r:var_t:s0\n" }]));
	const calls = [];
	const spawn = fakeSpawn(statPlan(answers), calls);
	// Measured shapes, each of which left a rule matching nothing when only the folder's own link was followed: a link, a
	// chain of two, a folder under a linked parent; and a link into /var/opt, which semanage refuses for its equivalence
	// rule '/var/opt /opt' and wants on /opt.
	const resolved = {
		"/home/op/linked": "/srv/my.proj+1 (x)[y]",
		"/home/op/chain": "/srv/chained",
		"/home/op/plink/repo": "/srv/plink/repo",
		"/home/op/aliased": "/var/opt/tool",
	};
	const files = {
		"/etc/selinux/config": "SELINUX=enforcing\nSELINUXTYPE=targeted\n",
		"/etc/selinux/targeted/contexts/files/file_contexts.subs_dist": "# comment\n/var/home /home\n/var/opt /opt\n/var/opt/deep /elsewhere\n",
		"/etc/selinux/targeted/contexts/files/file_contexts.subs": "/srv/plink /srv/pl\n",
	};
	const readFile = (path) => {
		if (path in files) return files[path];
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	};
	const checks = await selinuxLabelChecks({ folders, spawn, realpath: (dir) => resolved[dir] ?? dir, readFile });
	const of = (dir) => checks.find((c) => c.warn && c.label.includes(`local folder ${dir} `));
	assert.match(of("/home/op/linked").label, /\(resolved to \/srv\/my\.proj\+1 \(x\)\[y\]\) is labelled var_t/);
	assert.ok(of("/home/op/linked").fix.includes("semanage fcontext -a -t container_file_t '/srv/my\\.proj\\+1\\x20\\(x\\)\\[y\\](/.*)?' && restorecon -R '/srv/my.proj+1 (x)[y]'"), of("/home/op/linked").fix);
	assert.ok(of("/home/op/chain").fix.includes("'/srv/chained(/.*)?'") || of("/home/op/chain").fix.includes(" /srv/chained(/.*)?"), "a chain names its last target, not the middle link");
	// The local .subs is read too: /srv/plink is an alias of /srv/pl there.
	assert.ok(of("/home/op/plink/repo").fix.includes("/srv/pl/repo(/.*)?"), of("/home/op/plink/repo").fix);
	assert.match(of("/home/op/plink/repo").label, /resolved to \/srv\/pl\/repo/);
	// The longest alias wins, on a separator boundary.
	assert.ok(of("/home/op/aliased").fix.includes("/opt/tool(/.*)?"), of("/home/op/aliased").fix);
	// ...but restorecon is handed the directory that exists: /opt/tool does not, and restorecon failed on it (measured).
	assert.ok(of("/home/op/aliased").fix.includes("&& restorecon -R /var/opt/tool`"), of("/home/op/aliased").fix);
	const plain = of("/home/op/plain");
	assert.ok(!plain.label.includes("resolved to"), "a folder that resolves to itself says nothing more");
	assert.ok(of("/home/op/sp ace").fix.includes("'/home/op/sp\\x20ace(/.*)?' && restorecon -R '/home/op/sp ace'"), of("/home/op/sp ace").fix);
	assert.deepEqual(calls[0].args, ["-L", "--format=%C", "--", "/home/op/linked"]);
	// A relative folder is named as configured and its rule made absolute.
	const rel = await selinuxLabelChecks({ folders: ["repo"], spawn: fakeSpawn(statPlan({ repo: { code: 0, output: "unconfined_u:object_r:user_home_t:s0\n" } }), []), realpath: (dir) => dir, readFile: noSelinuxFiles });
	const relWarn = rel.find((c) => c.warn);
	assert.ok(!relWarn.label.includes("resolved to"), "made absolute is not resolved elsewhere: nothing more to say");
	assert.match(relWarn.fix, /semanage fcontext -a -t container_file_t '?\/[^ ']*\/repo\(\/\.\*\)\?'?/);
	assert.match(relWarn.fix, /virt_use_nfs/, "names the mounts restorecon cannot relabel");
	// The default resolver is the real one: a real symlink on this machine is followed without any seam.
	const target = tempDir("pi-selinux-target-");
	const link = join(tempDir("pi-selinux-link-"), "folder");
	symlinkSync(target, link);
	const real = await selinuxLabelChecks({ folders: [link], spawn: fakeSpawn(statPlan({ [link]: { code: 0, output: "unconfined_u:object_r:var_t:s0\n" } }), []), readFile: noSelinuxFiles });
	assert.ok(real.find((c) => c.warn).label.includes(`resolved to ${realpathSync(target)}`), real.find((c) => c.warn).label);
});

test("doctor runs the label check only where relabelling applies: local Podman with SELinux on Linux, nothing at all elsewhere (#355)", async () => {
	// Resolved, because on macOS the temp root is itself a link (/var -> /private/var) and the check names a link.
	const overlay = realpathSync(tempDir("pi-selinux-overlay-"));
	for (const [label, body, ids, applies] of [
		["podman with selinux", PODMAN_SELINUX_INFO, LINUX_ID(1001), true],
		["docker with selinux, out of scope", JSON.stringify({ ...JSON.parse(ROOTFUL_INFO), SecurityOptions: ["name=seccomp,profile=builtin", "name=selinux"] }), LINUX_ID(1001), false],
		["podman without selinux", PODMAN_COMPAT_INFO, LINUX_ID(1001), false],
		["a Podman machine on macOS", PODMAN_SELINUX_INFO, { platform: "darwin", release: "24.6.0", euid: 501, egid: 20 }, false],
	]) {
		const { out, text } = capture();
		const calls = [];
		const plan = statPlan({ [overlay]: { code: 0, output: "unconfined_u:object_r:user_tmp_t:s0\n" }, "/srv/repo": { code: 0, output: "unconfined_u:object_r:var_t:s0\n" } });
		await runDoctor(ghEnv({ PI_GLOBAL_PI_DIR: overlay, PI_TRIGGERS_FILE: triggersFile() }), { ...ghDeps(out, { ...plan, ...infoPlan(body), ...green }, calls), jobUserIdentity: ids, stat: socketStat, observationFs: noHostFiles });
		const stats = calls.filter((c) => c.cmd === "stat");
		if (applies) {
			assert.match(text(), /✓ SELinux: jobs' own directories are relabelled for SELinux \(:Z\)/, label);
			assert.match(text(), new RegExp(`⚠ SELinux: the global overlay ${overlay.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} is labelled user_tmp_t`), label);
			assert.match(text(), /⚠ SELinux: the local folder \/srv\/repo is labelled var_t, not a container type/, `${label}: every local trigger's folder`);
			assert.match(text(), /semanage fcontext -a -t container_file_t '\/srv\/repo\(\/\.\*\)\?' && restorecon -R \/srv\/repo/, label);
			assert.equal(stats.length, 2, label);
		} else {
			assert.doesNotMatch(text(), /SELinux:/, label);
			assert.equal(stats.length, 0, `${label}: no stat is ever spawned`);
		}
	}
});

test("doctor --live relabels its probes' own mounts from the same daemon answer, and never the global fixture (#355)", async () => {
	const env = liveEnv();
	const base = { endpoint: { local: true }, dockerCode: 0, imageCode: 0, jobImage: "pi-job:latest", triggerImages: [], egress: { armed: false, results: [] }, jobUser: { run: true, user: null } };
	const podman = { answered: true, facts: parseDaemonFacts(PODMAN_SELINUX_INFO).facts };
	let lastChecks = [];
	const runsOf = async (facts, ids = LINUX_1001) => {
		const calls = [];
		lastChecks = await liveChecks(env, { spawn: fakeSpawn({ ...liveOk(), ...green }, calls), liveFs, isAlive: () => false, pid: 1, nonce: "n", jobUserIdentity: ids, ...instantClock() }, facts);
		return calls.filter((c) => c.cmd === "docker" && c.args[0] === "run").map((c) => c.args.filter((_a, i) => c.args[i - 1] === "-v"));
	};
	const limits = () => lastChecks.find((c) => /limits of this read-back/.test(c.label)).label;
	const relabelled = await runsOf({ ...base, daemon: podman });
	// The fixture's workspace is relabelled like a forge clone's, which an operator's folder never is: the limits line
	// says so, or a held localFolders would read as covering folders it never touched.
	assert.match(limits(), /on this SELinux host the fixture's workspace was relabelled \(:Z\), which a local folder of yours never is/);
	assert.ok(relabelled.length >= 3, "the probe, the pin and the ephemeral runs");
	for (const v of relabelled) {
		assert.deepEqual(v.map((m) => m.slice(m.indexOf(":") + 1)), ["/job:ro,Z", "/workspace:Z", "/outbox:Z", "/session:Z", "/opt/pi-global:ro"]);
	}
	for (const [label, facts, ids] of [
		["no daemon answer kept", base, LINUX_1001],
		["docker with selinux", { ...base, daemon: { answered: true, facts: { ...podman.facts, podman: false } } }, LINUX_1001],
		["a Podman machine on macOS", { ...base, daemon: podman }, { ...LINUX_1001, platform: "darwin" }],
	]) {
		const runs = await runsOf(facts, ids);
		assert.ok(runs.length >= 3, `${label}: the probes ran`);
		for (const v of runs) assert.ok(!v.some((m) => /Z$/.test(m)), label);
		assert.doesNotMatch(limits(), /SELinux/, `${label}: no relabel, no such sentence`);
	}
});

test("doctor --live reads relabel from the collection's own daemon answer, end to end (#355)", async () => {
	for (const [label, body, want] of [["podman with selinux", PODMAN_SELINUX_INFO, true], ["docker", ROOTFUL_INFO, false]]) {
		const { out } = capture();
		const calls = [];
		await runDoctor(liveEnv(), { ...ghDeps(out, { ...liveOk(), ...infoPlan(body), ...green }, calls), live: true, ...instantClock(), liveFs, jobUserIdentity: LINUX_1001, stat: socketStat, observationFs: noHostFiles, isAlive: () => false, pid: 7, nonce: "n" });
		const probe = calls.find((c) => c.cmd === "docker" && c.args[0] === "run" && c.args.includes("sleep"));
		assert.ok(probe, `${label}: the probe ran`);
		assert.equal(probe.args.some((a) => a.endsWith(":/job:ro,Z")), want, label);
		assert.equal(probe.args.some((a) => a.endsWith(":/job:ro")), !want, label);
	}
});

test("doctor's two docker runners spawn the bin they are given, and docker when none is (#354)", async () => {
	const { EventEmitter } = await import("node:events");
	const spawned = [];
	// A child that prints its binary and exits 0, so what each runner resolves shows the spawn it made.
	const spawn = (cmd, args) => {
		spawned.push([cmd, ...args]);
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = () => {};
		setImmediate(() => {
			child.stdout.end(`${cmd}\n`);
			child.stderr.end();
			setImmediate(() => child.emit("close", 0, null));
		});
		return child;
	};
	assert.equal((await dockerRunVia(spawn)(["version"])).stdout, "docker\n");
	assert.equal((await dockerRunVia(spawn, 1000)(["version"])).stdout, "docker\n");
	assert.equal((await dockerRunVia(spawn, 1000, { bin: "podman" })(["version"])).stdout, "podman\n");
	assert.equal((await liveRunVia(spawn)(["ps"], { timeoutMs: 1000 })).stdout, "docker\n");
	const live = await liveRunVia(spawn, { bin: "podman" })(["ps"], { timeoutMs: 1000 });
	assert.deepEqual([live.code, live.stdout, live.ended], [0, "podman\n", "close"]);
	assert.deepEqual(spawned, [["docker", "version"], ["docker", "version"], ["podman", "version"], ["docker", "ps"], ["podman", "ps"]]);
	// Issue #354 part 2: the call sites that name a bin are the podman venue's three (its info read in the section and
	// again before --live, and --live's runner), and each names podman; every other spawn doctor makes through them is
	// docker's, as before. Issue #431 added no site: the podman egress canary and its sweep run on --live's runner, the
	// third, so the list is exactly what it was and a canary given a runner of its own would land here.
	const doctorSource = readFileSync(new URL("../src/doctor.mjs", import.meta.url), "utf8");
	const named = [...doctorSource.matchAll(/(?<!function )(?:docker|live)RunVia\(spawn[^)\n]*\{ bin: ([^ }]+)/g)].map((m) => m[1]);
	assert.deepEqual(named, ['"podman"', '"podman"', '"podman"'], "only the podman venue's reads name a bin, and they name podman");
	// Issue #433: and the spawns that name `podman` directly, by their first two arguments: the trigger-named image and its
	// entrypoint, `--fix`'s pull and tag of the default image, and the egress proxy's state. One more site picks its
	// runtime from a variable, the in-image gh probe, which is docker's with `local` and podman's without it. A new podman
	// spawn, or a docker one turned into a variable, lands here as a diff rather than going unseen.
	const direct = [...doctorSource.matchAll(/runCmd(?:Capture)?\(\w*[sS]pawn, "podman", \[("[^"]*", "[^"]*")/g)].map((m) => m[1]);
	assert.deepEqual(direct, ['"image", "inspect"', '"image", "inspect"', '"pull", "ghcr.io/edgehero/pi-job:latest"', '"tag", "ghcr.io/edgehero/pi-job:latest"', '"inspect", "--format={{.State.Status}}"', '"network", "inspect"']);
	// Issue #458 added the last (PR #463 round 3): the keeper network's options. And the rootless network keeper's read, whose format is the shared constant (podman-stack.mjs), so the
	// literal matcher above cannot see it; it is pinned by its own shape, exactly once.
	assert.equal([...doctorSource.matchAll(/runCmd(?:Capture)?\(\w*[sS]pawn, "podman", \["inspect", NETNS_KEEPER_FORMAT, NETNS_KEEPER\]/g)].length, 1);
	const chosen = [...doctorSource.matchAll(/runCmd(?:Capture)?\(\w*[sS]pawn, ([a-z]\w*Bin)\b/g)].map((m) => m[1]);
	assert.deepEqual(chosen, ["ghProbeBin"]);
});

// --- issue #354 part 2: the podman venue ------------------------------------------------------------------------------

// `podman info --format json` as rootless Podman 5.8.1 on Fedora 44 answers it (measured), reduced to the keys read.
const PODMAN_INFO = (over = {}, security = {}) =>
	JSON.stringify({ host: { security: { rootless: true, selinuxEnabled: false, ...security }, serviceIsRemote: false, cgroupVersion: "v2", cgroupManager: "systemd", cgroupControllers: ["cpuset", "cpu", "io", "memory", "pids"], ...over }, version: { Version: "5.8.1" }, store: { runRoot: "/run/user/1234/containers" } });
// The worker account's own mounts.conf, empty: the documented override that earns podmanAddsNoMounts.
const PODMAN_HOME = "/home/op";
// And the account's user manager running with the controllers delegated (issue #453): user@1234.service's cgroup.
const PODMAN_USER_MANAGER = "/sys/fs/cgroup/user.slice/user-1234.slice/user@1234.service/cgroup.controllers";
const podmanFs = {
	...noHostFiles,
	statSync: (p) => (p === `${PODMAN_HOME}/.config/containers/mounts.conf` ? { size: 0 } : noHostFiles.statSync(p)),
	readFileSync: (p) => (p === PODMAN_USER_MANAGER ? "cpuset cpu io memory pids\n" : noHostFiles.readFileSync(p)),
};
// The same host with the user manager's controllers given (null: no user manager running for the account).
// `self` is this process's /proc/self/cgroup (null: unread), which decides the bounds only when Podman does not use the
// systemd cgroup manager (issue #453, gate round 1).
const podmanFsWith = (controllers, self = null) => ({
	...podmanFs,
	readFileSync: (p) => (p === PODMAN_USER_MANAGER && controllers !== null ? controllers : p === "/proc/self/cgroup" && self !== null ? self : noHostFiles.readFileSync(p)),
});
// A podman host that answers everything, docker absent altogether. "docker" LAST, so it catches every docker call.
// Issue #458 (PR #463 round 2): when the keeper and the proxy started, epoch ms. The keeper long before the proxy, both
// long before any clock a test runs on, so the age and order rules hold unless a test moves them (with its own `now`).
const KEEPER_STARTED = 1_000_000;
const PROXY_STARTED = 2_000_000;
const podmanPlan = ({ info = PODMAN_INFO(), capabilities = "anyUid", image = true, proxy = "running", keeper = "running", proxyStarted = PROXY_STARTED, keeperNet = "true false" } = {}) => ({
	"podman info": { code: 0, output: `${info}\n` },
	"podman image inspect --format={{.Id}}": image ? { code: 0, output: `abc|0.80.7||${capabilities}\n` } : { code: 125, output: "" },
	// Issue #458: the rootless network keeper's state, network mode, networks and start, read beside the proxy's whenever
	// egress is armed. BEFORE the proxy's key: its format begins with the proxy's `--format={{.State.Status}}`, and the fake
	// takes the first matching prefix. A bare state word is the shipped shape; a full `state|mode|nets,|started` is as given.
	"podman inspect --format={{.State.Status}}|{{.HostConfig.NetworkMode}}": keeper === null ? { code: 125, output: "" } : { code: 0, output: `${keeper.includes("|") ? keeper : `${keeper}|bridge|pi-dispatch-netns-keeper,|${KEEPER_STARTED}`}\n` },
	"podman inspect --format={{.State.StartedAt.UnixMilli}}": proxyStarted === null ? { code: 125, output: "" } : { code: 0, output: `${proxyStarted}\n` },
	"podman inspect --format={{.State.Status}}": proxy === null ? { code: 125, output: "" } : { code: 0, output: `${proxy}\n` },
	// PR #463 round 3: the keeper network's options, as shipped unless a test says otherwise.
	"podman network inspect --format {{.Internal}} {{.DNSEnabled}}": keeperNet === null ? { code: 125, output: "" } : { code: 0, output: `${keeperNet}\n` },
	docker: "enoent",
});
const podmanEnv = (extra = {}) => ({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", GITHUB_AUTH_SOURCE: "pat", PI_BACKENDS: "podman", PI_EGRESS: "0", ...extra });
const podmanDeps = (out, plan, calls, extra = {}) => ({ ...ghDeps(out, plan, calls), home: PODMAN_HOME, observationFs: podmanFs, jobUserIdentity: LINUX_ID(1234), ...extra });

// Issue #433: a deployment that blesses BOTH venues keeps doctor's output byte for byte. Captured from main at 98f2857,
// before the podman-only change, in four shapes: every docker read green (with a trigger-named image, the gh probe, the
// egress canary and a peer to compare digests with), docker absent under --fix with every offer declined, a docker
// daemon that answered with the job image missing, and (review round 1) the podman store without the job image under
// --fix with every offer ACCEPTED, where main offers and runs nothing. The temp paths a run makes are the only thing replaced.
const mixedPinRun = async (scenario) => {
	const triggers = triggersFile(undefined, "my-python:1.2.0");
	const cwd = tempDir("pi-mixed-pin-cwd-");
	const jobs = tempDir("pi-mixed-pin-jobs-");
	const env = podmanEnv({ PI_BACKENDS: "local,podman", PI_WORKER_NAME: "mini1", PI_TRIGGERS_FILE: triggers, PI_JOBS_DIR: jobs, ...(scenario === "green" ? { PI_EGRESS: "1", GITHUB_AUTH_SOURCE: "gh" } : {}) });
	const { docker: _absent, ...podmanOnly } = podmanPlan({ image: scenario !== "podmanMissing" });
	const plan =
		scenario === "absent"
			? podmanPlan()
			: {
					...EGRESS_OK,
					...podmanOnly,
					"gh auth status": { code: 0, output: ghStatusOutput },
					"gh auth token": { code: 0, output: "gho_x\n" },
					// The facts read answers with no body, as it did when this pin was captured (issue #452 keeps it so).
					"docker info --format={{json .}}": { code: 0, output: "" },
					"docker info": 0,
					"docker image inspect --format={{json": RUNNER_ENTRYPOINT,
					"docker image inspect --format={{.Id}}": { code: 0, output: "sha256:aaaa\n" },
					"docker image inspect pi-job:latest": scenario === "missing" ? 1 : 0,
					"docker image": 0,
					"docker run": 0,
				};
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const { out, text } = capture();
	const calls = [];
	const code = await runDoctor(env, podmanDeps(out, plan, calls, { cwd, agentDir: NO_AGENT_DIR, readHosts: async () => ({ hosts: [{ name: "mini2", tz, imageDigest: "sha256:bbbb" }] }), ...(scenario === "absent" ? { fix: true, promptFn: async () => false } : {}), ...(scenario === "podmanMissing" ? { fix: true, promptFn: async () => true } : {}) }));
	return { code, calls, text: text().replaceAll(triggers, "<triggers>").replaceAll(cwd, "<cwd>").replaceAll(jobs, "<jobs>").replaceAll(tz, "<tz>") };
};
// The em dashes some of these lines carry are the output's own (labels older than this change), written as escapes.
const MIXED_PIN = {
	green: {
		code: 0,
		text: [
			"✓ Node ≥ 22.19 (have 22.19.0)",
			"✓ .env present",
			"✓ Docker daemon reachable",
			"✓ Job image present (pi-job:latest)",
			"⚠ Trigger flow \"review\" resolves in NO tier visible here (cron \"nightly\")",
			"    → checked: staged packages; not checkable here: repo (/srv/repo is not readable as a git repo here) -- commit .pi/skills/review/SKILL.md, add the skill to run.skillsDir or the overlay skills/, or stage a package shipping it; a job of this trigger runs without the flow it names (the runner logs flow_not_loaded) and still exits 0",
			"✓ Trigger job image present (my-python:1.2.0)",
			"✓ Egress proxy running (pi-dispatch-egress-proxy)",
			"✓ Egress proxy health: healthy",
			// Issue #452 (gate round 3): this plan's `docker info` answers with no body, so the detach gate cannot say which
			// runtime it is and no keeper holds: the canary, whose teardown detaches the running proxy, is not run.
			"⚠ Egress policy: not proved, and no egress canary was run, because this shell's docker CLI could not say which container runtime it reaches and the rootless network keeper pi-dispatch-netns-keeper does not hold, and on a rootless Podman 4.x detaching the running egress proxy from a network cuts its route out (issue #458)",
			"    → fix what stops `docker info` answering (which runtime it is decides whether a keeper is needed at all), or start it as the worker's account where its Quadlet unit is installed: systemctl --user reset-failed pi-dispatch-netns-keeper-network.service pi-dispatch-netns-keeper.service; systemctl --user restart pi-dispatch-netns-keeper-network.service pi-dispatch-netns-keeper.service (else `pi-dispatch service install` or `pi-dispatch up` installs it, or start it by hand, docs/podman.md step 6; a container of its name that is not the shipped keeper must be removed first), then re-run doctor",
			"✓ Jobs run on: local, podman (a trigger that names none runs on local; run.backend selects)",
			"⚠ local: isolation is ASSERTED by the daemon, not enforced: the daemon answered in a shape nothing here reads (unparseable)",
			"    → the pid and memory bounds in the job argv are the daemon's to apply, and it is not observed applying them: `pi-dispatch doctor --live` reads pids.max and memory.max off a real container on this daemon. The worker logs its own answer at boot (worker_started.daemonAppliesBounds)",
			"⚠ local: mountSet is ASSERTED by the container runtime's configuration, not enforced: the daemon answered in a shape nothing here reads (unparseable)",
			"    → Podman mounts what its mounts.conf and containers.conf list into every job container, invisible to docker inspect: create an empty /etc/containers/mounts.conf and remove any volumes or mounts key. The worker logs its own answer at boot (worker_started.runtimeAddsNoMounts)",
			"⚠ local: nonRoot is ASSERTED by the job image's USER directive (this repo's builds `USER pi`; an operator-built image may not), or on a daemon that enforces bind-mount ownership and a worker uid other than 1001 the worker's own non-zero uid passed as `--user`, not enforced by it",
			"    → not verifiable from here, so treat it as a claim rather than a control: the agent runs as a non-root user",
			"✓ PI_BACKEND_FLOOR is not set, so no minimum is required of any backend",
			"⚠ local: which uid a job runs as could not be read from the daemon's answer (runtime-unreadable) -- every local job is refused",
			"    → the docker CLI answered `docker info` with something no rule can read, so which uid a job may run as is unknown; point the real docker CLI at a Docker or Podman daemon",
			"✓ podman: `podman info` answered as this account (Podman 5.8.1, rootless, this host's own)",
			"✓ podman: cgroup v2 controllers are delegated to this account (cpuset, cpu, io, memory, pids), so a job's pid, memory and cpu bounds are applied",
			"✓ podman: SELinux does not confine containers here, so nothing a job mounts is relabelled",
			"✓ podman: job image present in this account's Podman store (pi-job:latest)",
			"✓ podman: jobs run as uid:gid 1234:1234 (passed as --user, with --userns=keep-id) with HOME=/home/pi",
			"✓ podman: egress proxy running under this account's Podman (pi-dispatch-egress-proxy)",
			// Issue #431: the one line that moved, and on purpose: the podman venue's allowlist is now read back by --live.
			"⚠ podman: the egress allowlist is read back by `pi-dispatch doctor --live` on this venue, not by this run",
			"    → run `pi-dispatch doctor --live`: its egress canary runs two containers built like a podman job's (the job user, --userns=keep-id, the venue's pinned flags) on a job-shaped --internal network under this account's Podman, one that must reach the provider through the proxy and one that must not reach an unlisted host",
			// Issue #458: the one line added, with egress armed on this venue.
			"✓ podman: rootless network keeper running under this account's Podman on its own bridge network (pi-dispatch-netns-keeper), so a job's network teardown cannot cut the proxy's route out",
			// PR #463 round 3: the keeper network's options, read as they are.
			"✓ podman: the keeper's network pi-dispatch-netns-keeper is internal with DNS off, so the keeper reaches nothing",
			"⚠ GITHUB_AUTH_SOURCE=gh forwards your full gh login into every token-carrying job container (scopes: gist, read:org, repo, workflow)",
			"    → this token carries broad scopes (workflow) -- use a fine-grained PAT (GITHUB_AUTH_SOURCE=pat) or a GitHub App for per-job scoping -- see SECURITY.md",
			"✓ gh authenticates inside the job image (pi-job:latest)",
			"✓ Valkey reachable (redis://127.0.0.1:6379)",
			"✓ Fleet: 2 workers (mini1, mini2)",
			"⚠ Job image digest differs from the other host",
			"    → rebuild or re-pull so every host runs the same image; digests are identical only when both hosts pulled one tag from one registry, so two local builds differ legitimately",
			"✓ Provider key set (anthropic: ANTHROPIC_API_KEY)",
			"⚠ PI_PAUSE_WINDOWS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for scoped pauses cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"⚠ PI_SCOPED_LIMITS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for scoped limits cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"✓ 0 retained workspace(s) in <jobs>/sandboxes, swept after 24h, re-open one with `pi-dispatch sandbox <jobId>`",
			"✓ Durable state: run history /home/op/.pi-dispatch/logs, settings /home/op/.pi-dispatch/settings.json \u2014 both survive a reboot (docs/backup.md)",
			"",
			"doctor: ready. Start the worker with `pi-dispatch worker`.",
			"",
		].join("\n"),
	},
	absent: {
		code: 1,
		text: [
			"✓ Node ≥ 22.19 (have 22.19.0)",
			"✓ .env present",
			"✗ Docker daemon reachable",
			"    → install Docker \u2014 `docker` was not found on PATH",
			"✗ Job image present (pi-job:latest)",
			"    → docker pull ghcr.io/edgehero/pi-job:latest && docker tag ghcr.io/edgehero/pi-job:latest pi-job:latest  (or build image/Dockerfile)",
			"⚠ Trigger flow \"review\" resolves in NO tier visible here (cron \"nightly\")",
			"    → checked: staged packages; not checkable here: repo (/srv/repo is not readable as a git repo here) -- commit .pi/skills/review/SKILL.md, add the skill to run.skillsDir or the overlay skills/, or stage a package shipping it; a job of this trigger runs without the flow it names (the runner logs flow_not_loaded) and still exits 0",
			"✓ Jobs run on: local, podman (a trigger that names none runs on local; run.backend selects)",
			"⚠ local: egress CAN be enforced here, but PI_EGRESS is off, so this deployment is not getting it",
			"    → arm PI_EGRESS to get it (the job reaches only what the allowlist proxy permits (CONST-EGRESS-POLICY-IN-THE-ARGV))",
			"⚠ local: jobToJobIsolation CAN be enforced here, but PI_EGRESS is off, so this deployment is not getting it",
			"    → arm PI_EGRESS to get it (two jobs cannot reach each other, structurally rather than by policy)",
			"⚠ local: nonRoot is ASSERTED by the job image's USER directive (this repo's builds `USER pi`; an operator-built image may not), or on a daemon that enforces bind-mount ownership and a worker uid other than 1001 the worker's own non-zero uid passed as `--user`, not enforced by it",
			"    → not verifiable from here, so treat it as a claim rather than a control: the agent runs as a non-root user",
			"⚠ local: credentialTransit is ASSERTED by the operator, not enforced: this shell's docker CLI did not say which endpoint it resolves (spawn-failed)",
			"    → nothing shows where job containers (and the credentials they carry) would go; fix what stops the docker CLI answering, then re-run doctor. The worker logs its own answer at boot (worker_started.dockerEndpointLocal)",
			"⚠ podman: egress CAN be enforced here, but PI_EGRESS is off, so this deployment is not getting it",
			"    → arm PI_EGRESS to get it (the job reaches only what the allowlist proxy permits (CONST-EGRESS-POLICY-IN-THE-ARGV))",
			"⚠ podman: jobToJobIsolation CAN be enforced here, but PI_EGRESS is off, so this deployment is not getting it",
			"    → arm PI_EGRESS to get it (two jobs cannot reach each other, structurally rather than by policy)",
			"✓ PI_BACKEND_FLOOR is not set, so no minimum is required of any backend",
			"✓ podman: `podman info` answered as this account (Podman 5.8.1, rootless, this host's own)",
			"✓ podman: cgroup v2 controllers are delegated to this account (cpuset, cpu, io, memory, pids), so a job's pid, memory and cpu bounds are applied",
			"✓ podman: SELinux does not confine containers here, so nothing a job mounts is relabelled",
			"✓ podman: job image present in this account's Podman store (pi-job:latest)",
			"✓ podman: jobs run as uid:gid 1234:1234 (passed as --user, with --userns=keep-id) with HOME=/home/pi",
			"✓ Valkey reachable (redis://127.0.0.1:6379)",
			"✓ Fleet: 2 workers (mini1, mini2)",
			"✓ Provider key set (anthropic: ANTHROPIC_API_KEY)",
			"⚠ PI_PAUSE_WINDOWS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for scoped pauses cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"⚠ PI_SCOPED_LIMITS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for scoped limits cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"✓ 0 retained workspace(s) in <jobs>/sandboxes, swept after 24h, re-open one with `pi-dispatch sandbox <jobId>`",
			"✓ Durable state: run history /home/op/.pi-dispatch/logs, settings /home/op/.pi-dispatch/settings.json \u2014 both survive a reboot (docs/backup.md)",
			"",
			"fix available: Job image present (pi-job:latest)",
			"    $ docker pull ghcr.io/edgehero/pi-job:latest && docker tag ghcr.io/edgehero/pi-job:latest pi-job:latest",
			"skipped: Job image present (pi-job:latest)",
			"",
			"doctor: some checks failed \u2014 fix the above, then re-run.",
			"",
		].join("\n"),
	},
	missing: {
		code: 1,
		text: [
			"✓ Node ≥ 22.19 (have 22.19.0)",
			"✓ .env present",
			"✓ Docker daemon reachable",
			"✗ Job image present (pi-job:latest)",
			"    → docker pull ghcr.io/edgehero/pi-job:latest && docker tag ghcr.io/edgehero/pi-job:latest pi-job:latest  (or build image/Dockerfile)",
			"⚠ Trigger flow \"review\" resolves in NO tier visible here (cron \"nightly\")",
			"    → checked: staged packages; not checkable here: repo (/srv/repo is not readable as a git repo here) -- commit .pi/skills/review/SKILL.md, add the skill to run.skillsDir or the overlay skills/, or stage a package shipping it; a job of this trigger runs without the flow it names (the runner logs flow_not_loaded) and still exits 0",
			"✓ Trigger job image present (my-python:1.2.0)",
			"✓ Jobs run on: local, podman (a trigger that names none runs on local; run.backend selects)",
			"⚠ local: isolation is ASSERTED by the daemon, not enforced: the daemon answered in a shape nothing here reads (unparseable)",
			"    → the pid and memory bounds in the job argv are the daemon's to apply, and it is not observed applying them: `pi-dispatch doctor --live` reads pids.max and memory.max off a real container on this daemon. The worker logs its own answer at boot (worker_started.daemonAppliesBounds)",
			"⚠ local: mountSet is ASSERTED by the container runtime's configuration, not enforced: the daemon answered in a shape nothing here reads (unparseable)",
			"    → Podman mounts what its mounts.conf and containers.conf list into every job container, invisible to docker inspect: create an empty /etc/containers/mounts.conf and remove any volumes or mounts key. The worker logs its own answer at boot (worker_started.runtimeAddsNoMounts)",
			"⚠ local: egress CAN be enforced here, but PI_EGRESS is off, so this deployment is not getting it",
			"    → arm PI_EGRESS to get it (the job reaches only what the allowlist proxy permits (CONST-EGRESS-POLICY-IN-THE-ARGV))",
			"⚠ local: jobToJobIsolation CAN be enforced here, but PI_EGRESS is off, so this deployment is not getting it",
			"    → arm PI_EGRESS to get it (two jobs cannot reach each other, structurally rather than by policy)",
			"⚠ local: nonRoot is ASSERTED by the job image's USER directive (this repo's builds `USER pi`; an operator-built image may not), or on a daemon that enforces bind-mount ownership and a worker uid other than 1001 the worker's own non-zero uid passed as `--user`, not enforced by it",
			"    → not verifiable from here, so treat it as a claim rather than a control: the agent runs as a non-root user",
			"⚠ podman: egress CAN be enforced here, but PI_EGRESS is off, so this deployment is not getting it",
			"    → arm PI_EGRESS to get it (the job reaches only what the allowlist proxy permits (CONST-EGRESS-POLICY-IN-THE-ARGV))",
			"⚠ podman: jobToJobIsolation CAN be enforced here, but PI_EGRESS is off, so this deployment is not getting it",
			"    → arm PI_EGRESS to get it (two jobs cannot reach each other, structurally rather than by policy)",
			"✓ PI_BACKEND_FLOOR is not set, so no minimum is required of any backend",
			"⚠ local: which uid a job runs as could not be read from the daemon's answer (runtime-unreadable) -- every local job is refused",
			"    → the docker CLI answered `docker info` with something no rule can read, so which uid a job may run as is unknown; point the real docker CLI at a Docker or Podman daemon",
			"✓ podman: `podman info` answered as this account (Podman 5.8.1, rootless, this host's own)",
			"✓ podman: cgroup v2 controllers are delegated to this account (cpuset, cpu, io, memory, pids), so a job's pid, memory and cpu bounds are applied",
			"✓ podman: SELinux does not confine containers here, so nothing a job mounts is relabelled",
			"✓ podman: job image present in this account's Podman store (pi-job:latest)",
			"✓ podman: jobs run as uid:gid 1234:1234 (passed as --user, with --userns=keep-id) with HOME=/home/pi",
			"✓ Valkey reachable (redis://127.0.0.1:6379)",
			"✓ Fleet: 2 workers (mini1, mini2)",
			"✓ Provider key set (anthropic: ANTHROPIC_API_KEY)",
			"⚠ PI_PAUSE_WINDOWS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for scoped pauses cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"⚠ PI_SCOPED_LIMITS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for scoped limits cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"✓ 0 retained workspace(s) in <jobs>/sandboxes, swept after 24h, re-open one with `pi-dispatch sandbox <jobId>`",
			"✓ Durable state: run history /home/op/.pi-dispatch/logs, settings /home/op/.pi-dispatch/settings.json \u2014 both survive a reboot (docs/backup.md)",
			"",
			"doctor: some checks failed \u2014 fix the above, then re-run.",
			"",
		].join("\n"),
	},
	podmanMissing: {
		code: 1,
		text: [
			"✓ Node ≥ 22.19 (have 22.19.0)",
			"✓ .env present",
			"✓ Docker daemon reachable",
			"✓ Job image present (pi-job:latest)",
			"⚠ Trigger flow \"review\" resolves in NO tier visible here (cron \"nightly\")",
			"    → checked: staged packages; not checkable here: repo (/srv/repo is not readable as a git repo here) -- commit .pi/skills/review/SKILL.md, add the skill to run.skillsDir or the overlay skills/, or stage a package shipping it; a job of this trigger runs without the flow it names (the runner logs flow_not_loaded) and still exits 0",
			"✓ Trigger job image present (my-python:1.2.0)",
			"✓ Jobs run on: local, podman (a trigger that names none runs on local; run.backend selects)",
			"⚠ local: isolation is ASSERTED by the daemon, not enforced: the daemon answered in a shape nothing here reads (unparseable)",
			"    → the pid and memory bounds in the job argv are the daemon's to apply, and it is not observed applying them: `pi-dispatch doctor --live` reads pids.max and memory.max off a real container on this daemon. The worker logs its own answer at boot (worker_started.daemonAppliesBounds)",
			"⚠ local: mountSet is ASSERTED by the container runtime's configuration, not enforced: the daemon answered in a shape nothing here reads (unparseable)",
			"    → Podman mounts what its mounts.conf and containers.conf list into every job container, invisible to docker inspect: create an empty /etc/containers/mounts.conf and remove any volumes or mounts key. The worker logs its own answer at boot (worker_started.runtimeAddsNoMounts)",
			"⚠ local: egress CAN be enforced here, but PI_EGRESS is off, so this deployment is not getting it",
			"    → arm PI_EGRESS to get it (the job reaches only what the allowlist proxy permits (CONST-EGRESS-POLICY-IN-THE-ARGV))",
			"⚠ local: jobToJobIsolation CAN be enforced here, but PI_EGRESS is off, so this deployment is not getting it",
			"    → arm PI_EGRESS to get it (two jobs cannot reach each other, structurally rather than by policy)",
			"⚠ local: nonRoot is ASSERTED by the job image's USER directive (this repo's builds `USER pi`; an operator-built image may not), or on a daemon that enforces bind-mount ownership and a worker uid other than 1001 the worker's own non-zero uid passed as `--user`, not enforced by it",
			"    → not verifiable from here, so treat it as a claim rather than a control: the agent runs as a non-root user",
			"⚠ podman: egress CAN be enforced here, but PI_EGRESS is off, so this deployment is not getting it",
			"    → arm PI_EGRESS to get it (the job reaches only what the allowlist proxy permits (CONST-EGRESS-POLICY-IN-THE-ARGV))",
			"⚠ podman: jobToJobIsolation CAN be enforced here, but PI_EGRESS is off, so this deployment is not getting it",
			"    → arm PI_EGRESS to get it (two jobs cannot reach each other, structurally rather than by policy)",
			"✓ PI_BACKEND_FLOOR is not set, so no minimum is required of any backend",
			"⚠ local: which uid a job runs as could not be read from the daemon's answer (runtime-unreadable) -- every local job is refused",
			"    → the docker CLI answered `docker info` with something no rule can read, so which uid a job may run as is unknown; point the real docker CLI at a Docker or Podman daemon",
			"✓ podman: `podman info` answered as this account (Podman 5.8.1, rootless, this host's own)",
			"✓ podman: cgroup v2 controllers are delegated to this account (cpuset, cpu, io, memory, pids), so a job's pid, memory and cpu bounds are applied",
			"✓ podman: SELinux does not confine containers here, so nothing a job mounts is relabelled",
			"✗ podman: job image is not in this account's Podman store (pi-job:latest)",
			"    → pull or load it AS THE WORKER'S ACCOUNT, since rootless Podman keeps one image store per account: podman pull ghcr.io/edgehero/pi-job:latest && podman tag ghcr.io/edgehero/pi-job:latest pi-job:latest -- jobs run with --pull=never, so the worker never fetches it",
			"✓ podman: jobs run as uid:gid 1234:1234 (passed as --user, with --userns=keep-id) with HOME=/home/pi, once the job image is in this account's store and declares anyUid",
			"✓ Valkey reachable (redis://127.0.0.1:6379)",
			"✓ Fleet: 2 workers (mini1, mini2)",
			"⚠ Job image digest differs from the other host",
			"    → rebuild or re-pull so every host runs the same image; digests are identical only when both hosts pulled one tag from one registry, so two local builds differ legitimately",
			"✓ Provider key set (anthropic: ANTHROPIC_API_KEY)",
			"⚠ PI_PAUSE_WINDOWS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for scoped pauses cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"⚠ PI_SCOPED_LIMITS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for scoped limits cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"✓ 0 retained workspace(s) in <jobs>/sandboxes, swept after 24h, re-open one with `pi-dispatch sandbox <jobId>`",
			"✓ Durable state: run history /home/op/.pi-dispatch/logs, settings /home/op/.pi-dispatch/settings.json \u2014 both survive a reboot (docs/backup.md)",
			"",
			"doctor: some checks failed \u2014 fix the above, then re-run.",
			"",
		].join("\n"),
	},
};
test("a deployment that blesses local and podman prints exactly what it printed before issue #433 (#433)", async () => {
	for (const [scenario, want] of Object.entries(MIXED_PIN)) {
		const got = await mixedPinRun(scenario);
		assert.equal(got.text, want.text, `${scenario}: the mixed deployment's output moved`);
		assert.equal(got.code, want.code, `${scenario}: exit code`);
		// Round 1 (D1): with local listed, a podman store without the image gets no `--fix` pull, even when every offer
		// would be accepted; the output above already shows no offer, and nothing was run either.
		assert.deepEqual(got.calls.filter((c) => c.args[0] === "pull"), [], `${scenario}: no pull ran`);
	}
});

test("PI_BACKENDS=podman: docker is never spawned, one neutral line says so, and the podman section reads this account's Podman (#354, #433)", async () => {
	const { out, text } = capture();
	const calls = [];
	const code = await runDoctor(podmanEnv(), podmanDeps(out, podmanPlan(), calls));
	assert.equal(code, 0, text());
	// Issue #433: not asked at all, so the plan's `docker: "enoent"` is never consulted, and nothing about docker is judged.
	assert.deepEqual(calls.filter((c) => c.cmd === "docker"), [], "a podman-only deployment makes no docker spawn");
	assert.ok(text().includes("✓ Docker: not checked -- PI_BACKENDS lists no docker venue (local), so no job here runs on Docker\n"), text());
	assert.doesNotMatch(text(), /Docker daemon reachable|Job image present \(|not used by any job|install Docker/, "no docker verdict from a command that never ran");
	assert.match(text(), /✓ podman: `podman info` answered as this account \(Podman 5\.8\.1, rootless, this host's own\)/);
	assert.match(text(), /✓ podman: cgroup v2 controllers are delegated to this account \(cpuset, cpu, io, memory, pids\)/);
	assert.match(text(), /✓ podman: SELinux does not confine containers here, so nothing a job mounts is relabelled/);
	assert.match(text(), /✓ podman: job image present in this account's Podman store \(pi-job:latest\)/);
	assert.match(text(), /✓ podman: jobs run as uid:gid 1234:1234 \(passed as --user, with --userns=keep-id\) with HOME=\/home\/pi/);
	assert.doesNotMatch(text(), /podman: \w+ is ASSERTED/, "every observation holds, so the backend section says nothing of them");
	assert.doesNotMatch(text(), /^. local: /m, "no local line of any kind on a deployment that runs no local job");
	assert.equal(calls.filter((c) => c.cmd === "podman" && c.args[0] === "info").length, 1, "one podman info, shared by the decision, the observations and the line");
	// --fix with the image present offers nothing, and never a pull into docker's store.
	const asked = [];
	const fixing = capture();
	const fixCalls = [];
	await runDoctor(podmanEnv(), { ...podmanDeps(fixing.out, podmanPlan(), fixCalls), fix: true, promptFn: async (question) => (asked.push(question), false) });
	assert.doesNotMatch(fixing.text(), /fix available|docker pull/, "no pull offered");
	assert.deepEqual(asked, []);
	assert.deepEqual(fixCalls.filter((c) => c.cmd === "docker"), []);
});

test("a deployment that does not bless podman spawns no podman and prints no podman line (#354)", async () => {
	for (const PI_BACKENDS of [undefined, "local", "nonsense"]) {
		const { out, text } = capture();
		const calls = [];
		await runDoctor({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", ...(PI_BACKENDS ? { PI_BACKENDS } : {}) }, { ...ghDeps(out, { ...podmanPlan(), ...green }, calls) });
		assert.ok(!calls.some((c) => c.cmd === "podman"), `${PI_BACKENDS}: no podman spawn`);
		assert.doesNotMatch(text(), /podman:|not used by any job/, `${PI_BACKENDS}: the docker lines are what they were`);
	}
});

test("a podman venue refusal is ✗ where podman is the default venue and ⚠ where it is not, with its own fix (#354)", async () => {
	for (const [label, plan, ids, cause] of [
		["rootful", podmanPlan({ info: PODMAN_INFO({}, { rootless: false }) }), LINUX_ID(1234), "podman-rootful"],
		["remote", podmanPlan({ info: PODMAN_INFO({ serviceIsRemote: true }) }), LINUX_ID(1234), "podman-remote"],
		["root worker", podmanPlan(), LINUX_ID(0), "worker-is-root"],
		["no podman", "no podman", LINUX_ID(1234), "podman-not-found"],
		["macOS", podmanPlan(), { platform: "darwin", euid: 501, egid: 20 }, "podman-platform"],
	]) {
		for (const PI_BACKENDS of ["podman", "local,podman"]) {
			const { out, text } = capture();
			const calls = [];
			const deps = podmanDeps(out, plan === "no podman" ? { docker: "enoent" } : plan, calls, { jobUserIdentity: ids });
			// No podman on PATH is what node's spawn says: an error with code ENOENT, which the fake's "enoent" does not carry.
			if (plan === "no podman") {
				const base = deps.spawn;
				deps.spawn = (cmd, ...rest) => {
					if (cmd === "podman") throw Object.assign(new Error("spawn podman ENOENT"), { code: "ENOENT" });
					return base(cmd, ...rest);
				};
			}
			const code = await runDoctor(podmanEnv({ PI_BACKENDS }), deps);
			const boot = PI_BACKENDS === "podman";
			const mark = boot ? "✗" : "⚠";
			const tail = boot ? "a worker running as this account refuses to boot" : "every podman job is refused";
			assert.ok(text().includes(`${mark} podman: no job can run on this venue (${cause}) -- ${tail}\n    → ${PODMAN_JOB_USER_FIX[cause]}\n`), `${label} ${PI_BACKENDS}:\n${text()}`);
			if (boot) assert.equal(code, 1, `${label}: a boot refusal fails doctor`);
			assert.doesNotMatch(text(), /podman: jobs run as|podman: job image/, `${label}: nothing past the refusal is read`);
			if (label === "macOS") assert.ok(!calls.some((c) => c.cmd === "podman"), "off Linux podman is not even asked");
		}
	}
});

test("a widening containers.conf is a podman venue refusal: ✗ where podman is the default, ⚠ where not, naming the file and key, with no extra spawn (#428)", async () => {
	const confPath = `${PODMAN_HOME}/.config/containers/containers.conf`;
	const withConf = (text) => ({ ...podmanFs, readFileSync: (p) => (p === confPath ? text : podmanFs.readFileSync(p)) });
	for (const [key, text] of [
		["pasta_options", '[network]\npasta_options = ["--map-gw"]\n'],
		["network_cmd_options", '[engine]\nnetwork_cmd_options = ["allow_host_loopback=true"]\n'],
		["annotations", '[containers]\nannotations = ["run.oci.keep_original_groups=1"]\n'],
	]) {
		for (const PI_BACKENDS of ["podman", "local,podman"]) {
			const { out, text: said } = capture();
			const calls = [];
			const code = await runDoctor(podmanEnv({ PI_BACKENDS }), podmanDeps(out, podmanPlan(), calls, { observationFs: withConf(text) }));
			const boot = PI_BACKENDS === "podman";
			const line = `${boot ? "✗" : "⚠"} podman: no job can run on this venue (podman-conf-widens-job): ${confPath} sets ${key}, which `;
			assert.ok(said().includes(line), `${key} ${PI_BACKENDS}:\n${said()}`);
			assert.match(said(), new RegExp(`${boot ? "a worker running as this account refuses to boot" : "every podman job is refused"}\n {4}→ remove that key from that file, then stop every running container of this account that is on a bridge network, all of them at once`));
			if (boot) assert.equal(code, 1, `${key}: a boot refusal fails doctor`);
			assert.doesNotMatch(said(), /podman: jobs run as|podman: job image/, `${key}: nothing past the refusal is read`);
			assert.deepEqual(calls.filter((c) => c.cmd === "podman").map((c) => c.args[0]), ["info"], "the files are read, podman is asked nothing more");
		}
	}
	// The ⚠ is not a failure: with podman merely blessed and local's own lines green, doctor exits 0 (review round 2
	// saw exit 1 in the loop above; that came from the fixture's absent docker, local's two ✗ lines, not from this one).
	const blessed = capture();
	const blessedCode = await runDoctor(podmanEnv({ PI_BACKENDS: "local,podman" }), podmanDeps(blessed.out, { ...green, ...podmanPlan() }, [], { observationFs: withConf("pasta_options = []\n") }));
	assert.ok(blessed.text().includes("⚠ podman: no job can run on this venue (podman-conf-widens-job)"), blessed.text());
	assert.deepEqual(blessed.text().split("\n").filter((l) => l.startsWith("✗")), [], blessed.text());
	assert.equal(blessedCode, 0, "a ⚠ line does not fail doctor");
	// A clean conf says nothing of it.
	const { out, text: said } = capture();
	await runDoctor(podmanEnv(), podmanDeps(out, podmanPlan(), [], { observationFs: withConf("[network]\n# pasta_options = []\n") }));
	assert.doesNotMatch(said(), /podman-conf-widens-job/);
	// With a podman info that has not answered, the conf is still judged and said: the worker refuses on the files
	// alone, so doctor must not wait on the job-user decision to say so.
	const slow = capture();
	await runDoctor(podmanEnv(), podmanDeps(slow.out, { ...podmanPlan(), "podman info": { code: 125, output: "Error: cannot connect\n" } }, [], { observationFs: withConf("pasta_options = []\n") }));
	assert.ok(slow.text().includes(`✗ podman: no job can run on this venue (podman-conf-widens-job): ${confPath} sets pasta_options, which `), slow.text());
	assert.doesNotMatch(slow.text(), /which uid a job runs as could not be decided/, "the conf line, not the undecided one");
	// A conf read that failed for a moment is ⚠ and says it is retried, never the ✗ refusal.
	const busy = capture();
	const busyCode = await runDoctor(podmanEnv(), podmanDeps(busy.out, podmanPlan(), [], { observationFs: { ...podmanFs, readFileSync: (p) => (p === confPath ? (() => { throw Object.assign(new Error("EMFILE"), { code: "EMFILE" }); })() : podmanFs.readFileSync(p)) } }));
	assert.match(busy.text(), /⚠ podman: whether this account's containers.conf or running rootless network widens a job could not be read just now: [^\n]*could not be read \(EMFILE\)\n {4}→ the read failed for a moment/);
	assert.equal(busyCode, 0);
	// `--live` names the conf line as the one to fix, not the job-user line (the reviewer's R3).
	const live = capture();
	await runDoctor(liveEnv({ PI_BACKENDS: "podman" }), { ...podmanDeps(live.out, { ...podmanLiveOk(), ...podmanPlan() }, [], { observationFs: withConf("annotations = []\n") }), live: true, ...instantClock(), liveFs: liveFsAs(1234), isAlive: () => false, pid: 7, nonce: "n" });
	assert.match(live.text(), /⚠ read back on podman: not run -- a podman job is refused here \(podman-conf-widens-job\)[^\n]*\n {4}→ fix the podman containers\.conf line above first/);
});

// Issue #450: this account's rootless network still running with an option a removed key gave it (Podman 5.8.1's pasta,
// measured with --map-host-loopback after the key was removed), read from /proc by the worker's own function.
test("a rootless network still carrying a removed key's option is the same podman venue refusal, with the reset to run (#450)", async () => {
	const argv = ["/usr/sbin/pasta", "--config-net", "--map-host-loopback", "169.254.1.2", "--pid", "/run/user/1234/containers/networks/rootless-netns/rootless-netns-conn.pid", "--dns-forward", "169.254.1.1", "-t", "none", "-u", "none", "-T", "none", "-U", "none", "--no-map-gw", "--quiet", "--netns", "/run/user/1234/containers/networks/rootless-netns/rootless-netns", "--map-guest-addr", "169.254.1.2"];
	const withLive = (args) => {
		// 5.8.1's pasta: PID 1 of a pid namespace of its own, found through the pid file Podman keeps under runRoot.
		// It started 10 s after boot (stat field 22, in ticks), and wrote the pid file a minute after boot.
		const conn = "/run/user/1234/containers/networks/rootless-netns/rootless-netns-conn.pid";
		const proc = { "/proc/4887/status": "Name:\tpasta\nUid:\t1234\t1234\t1234\t1234\nNSpid:\t4887\t1\n", "/proc/4887/cmdline": `${args.join("\0")}\0`, "/proc/4887/stat": "4887 (pasta) S 1 4887 4887 0 -1 4194560 1 0 0 0 0 0 0 0 20 0 1 0 1000 1 1\n", "/proc/stat": "btime 1790000000\n", [conn]: "4887\n" };
		return { ...podmanFs, readFileSync: (p) => (Object.hasOwn(proc, p) ? proc[p] : podmanFs.readFileSync(p)), readdirSync: (p) => (p === "/proc" ? ["self", "4887"] : podmanFs.readdirSync(p)), statSync: (p) => (p === conn ? { size: 5, mtimeMs: 1_790_000_060_000 } : podmanFs.statSync(p)) };
	};
	for (const PI_BACKENDS of ["podman", "local,podman"]) {
		const { out, text: said } = capture();
		const calls = [];
		const code = await runDoctor(podmanEnv({ PI_BACKENDS }), podmanDeps(out, podmanPlan(), calls, { observationFs: withLive(argv) }));
		const boot = PI_BACKENDS === "podman";
		const line = `${boot ? "✗" : "⚠"} podman: no job can run on this venue (podman-conf-widens-job): this account's running rootless network (pasta, pid 4887), which every container on a bridge network shares, the egress proxy's among them, still carries --map-host-loopback`;
		assert.ok(said().includes(line), `${PI_BACKENDS}:\n${said()}`);
		assert.match(said(), /\n {4}→ stop every running container of this account that is on a bridge network, all of them at once, [^\n]*systemctl --user stop pi-dispatch-worker\.service pi-dispatch-egress-proxy\.service pi-dispatch-netns-keeper\.service pi-dispatch-valkey\.service[^\n]*admits the next once it no longer carries the option\n/);
		assert.doesNotMatch(said(), /remove that key/);
		if (boot) assert.equal(code, 1, "a boot refusal fails doctor");
		assert.deepEqual(calls.filter((c) => c.cmd === "podman").map((c) => c.args[0]), ["info"], "/proc is read, podman is asked nothing more");
	}
	// The same helper narrow says nothing of it.
	const { out, text: said } = capture();
	await runDoctor(podmanEnv(), podmanDeps(out, podmanPlan(), [], { observationFs: withLive(argv.filter((t, i) => i !== 2 && i !== 3)) }));
	assert.doesNotMatch(said(), /podman-conf-widens-job/);
	// `--live` points at the network's reset, never at a containers.conf line there is none of.
	const live = capture();
	await runDoctor(liveEnv({ PI_BACKENDS: "podman" }), { ...podmanDeps(live.out, { ...podmanLiveOk(), ...podmanPlan() }, [], { observationFs: withLive(argv) }), live: true, ...instantClock(), liveFs: liveFsAs(1234), isAlive: () => false, pid: 7, nonce: "n" });
	assert.match(live.text(), /⚠ read back on podman: not run -- a podman job is refused here \(podman-conf-widens-job\)[^\n]*\n {4}→ reset this account's rootless network as the podman line above says first, then re-run `pi-dispatch doctor --live`/);
	assert.doesNotMatch(live.text(), /containers\.conf line above/);
	// And a helper whose argv could not be read points at that line, not at a reset.
	const denied = { ...withLive(argv), readFileSync: (p) => (p === "/proc/4887/cmdline" ? (() => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); })() : withLive(argv).readFileSync(p)) };
	const unread = capture();
	await runDoctor(liveEnv({ PI_BACKENDS: "podman" }), { ...podmanDeps(unread.out, { ...podmanLiveOk(), ...podmanPlan() }, [], { observationFs: denied }), live: true, ...instantClock(), liveFs: liveFsAs(1234), isAlive: () => false, pid: 7, nonce: "n" });
	assert.match(unread.text(), /\/proc\/4887\/cmdline could not be read \(EACCES\)/);
	assert.match(unread.text(), /\n {4}→ fix the podman rootless network line above first, then re-run `pi-dispatch doctor --live`/);
});

test("doctor names a host file read that failed for a moment as that, not as a runtime that did not answer, on both venues (#428)", async () => {
	// podman: the account's own mounts.conf stat fails with EMFILE; podman info answered.
	const mountsPath = `${PODMAN_HOME}/.config/containers/mounts.conf`;
	const emfile = (p) => {
		throw Object.assign(new Error(`EMFILE: ${p}`), { code: "EMFILE" });
	};
	const { out, text } = capture();
	await runDoctor(podmanEnv(), podmanDeps(out, podmanPlan(), [], { observationFs: { ...podmanFs, statSync: (p) => (p === mountsPath ? emfile(p) : podmanFs.statSync(p)) } }));
	assert.match(text(), new RegExp(`⚠ podman: mountSet is ASSERTED by this account's Podman setup, not enforced: ${mountsPath.replaceAll(".", "\\.")} could not be read \\(EMFILE\\)\\n {4}→ nothing shows whether [^\\n]*because the file named above could not be read just now \\(the runtime itself answered\\); a job the floor needs it for is retried`));
	assert.doesNotMatch(text(), /fix what stops `podman info` answering/);
	// local, on a rootful Podman's Docker API: the hooks directory read fails with EMFILE; the daemon answered.
	const endpoint = { local: true, context: "podman", endpoint: "unix:///run/podman/podman.sock" };
	const daemon = { answered: true, facts: parseDaemonFacts(PODMAN_COMPAT_INFO).facts };
	const fs = { ...withOverride, readdirSync: (p) => (p === "/etc/containers/oci/hooks.d" ? emfile(p) : withOverride.readdirSync(p)) };
	const line = backendChecks({}, { endpoint, daemon, fs }).find((c) => c.label.startsWith("local: mountSet is ASSERTED"));
	assert.match(line.label, /not enforced: \/etc\/containers\/oci\/hooks\.d could not be read \(EMFILE\)/);
	assert.match(line.fix, /because the file named above could not be read just now \(the runtime itself answered\); a job the floor needs it for is retried/);
	assert.doesNotMatch(line.fix, /fix what stops the daemon answering/);
});

test("the podman job image is read from THIS account's store, and its anyUid rule is the podman venue's (#354)", async () => {
	const run = async (plan, ids = LINUX_ID(1234)) => {
		const { out, text } = capture();
		const code = await runDoctor(podmanEnv(), podmanDeps(out, plan, [], { jobUserIdentity: ids }));
		return { code, text: text() };
	};
	const absent = await run(podmanPlan({ image: false }));
	assert.equal(absent.code, 1);
	assert.match(absent.text, /✗ podman: job image is not in this account's Podman store \(pi-job:latest\)\n {4}→ pull or load it AS THE WORKER'S ACCOUNT, since rootless Podman keeps one image store per account: podman pull ghcr\.io\/edgehero\/pi-job:latest && podman tag/);
	assert.match(absent.text, /✓ podman: jobs run as uid:gid 1234:1234 \(passed as --user, with --userns=keep-id\) with HOME=\/home\/pi, once the job image is in this account's store and declares anyUid/);
	const noAnyUid = await run(podmanPlan({ capabilities: "replicas" }));
	assert.match(noAnyUid.text, /⚠ podman: every job on pi-job:latest is refused as this uid \(job-image-any-uid-unsupported\)\n {4}→ the job image does not declare `anyUid`[^\n]*which the podman venue always uses/);
	assert.equal(noAnyUid.code, 0, "a per-job refusal warns, as the worker boots and refuses each job");
	const imageUid = await run(podmanPlan({ capabilities: "replicas" }), LINUX_ID(1001));
	assert.match(imageUid.text, /✓ podman: jobs run as uid:gid 1001:1001 \(passed as --user, with --userns=keep-id\)/, "uid 1001 is the image's own, anyUid or not");
});

test("with egress armed the podman proxy is read under podman, and the docker egress checks do not run for a podman-only deployment (#354)", async () => {
	const run = async (proxy) => {
		const { out, text } = capture();
		const calls = [];
		const code = await runDoctor(podmanEnv({ PI_EGRESS: "1" }), podmanDeps(out, podmanPlan({ proxy }), calls));
		return { code, text: text(), calls };
	};
	const up = await run("running");
	assert.match(up.text, /✓ podman: egress proxy running under this account's Podman \(pi-dispatch-egress-proxy\)/);
	// Issue #431: a plain run points at --live, where this venue's canary runs; it starts no canary container itself.
	assert.match(up.text, /⚠ podman: the egress allowlist is read back by `pi-dispatch doctor --live` on this venue, not by this run/);
	assert.ok(!up.calls.some((c) => c.args.some((a) => /pi-dispatch-egress-(doctor|probe)-/.test(String(a)))), "no canary object is touched by a plain run");
	assert.doesNotMatch(up.text, /Egress (policy|proxy)/, "docker's egress lines are about a proxy no job here is wired to");
	assert.deepEqual(up.calls.find((c) => c.cmd === "podman" && c.args[0] === "inspect")?.args, ["inspect", "--format={{.State.Status}}", "pi-dispatch-egress-proxy"]);
	const down = await run(null);
	assert.equal(down.code, 1);
	assert.match(down.text, /✗ podman: egress proxy is not under this account's Podman \(pi-dispatch-egress-proxy\)\n {4}→ start it as the worker's account, under the same rootless Podman, on a named bridge network/);
	const stopped = await run("exited");
	// The raw word (gate round 1), so an exited proxy and a crash-looping `stopped` one read apart.
	assert.match(stopped.text, /✗ podman: egress proxy is exited under this account's Podman \(pi-dispatch-egress-proxy\)\n {4}→ start it as the worker's account/);
	assert.doesNotMatch(stopped.text, /allowlist is read back by/, "only said beside a running proxy");
	// PR #456's final check: Podman reads a proxy crash-looping under a restart policy as `stopped` between restarts, and
	// every job fails (one retry, then failed), so it is ✗ like docker's `restarting`, never the ⚠ that says jobs wait.
	for (const status of ["stopped", "restarting"]) {
		const looping = await run(status);
		assert.equal(looping.code, 1, status);
		assert.match(
			looping.text,
			new RegExp(`✗ podman: egress proxy is ${status} under this account's Podman \\(pi-dispatch-egress-proxy\\)\\n {4}→ if a restart policy keeps bringing it back, its squid keeps exiting \\(Podman reads such a crash loop as ${status}\\) and every podman job is retried once, then failed; \`podman logs pi-dispatch-egress-proxy\` says why\\n`),
		);
	}
	// A transient word stays the ⚠ that says a job waits, and never fails doctor.
	const transient = await run("stopping");
	assert.match(transient.text, /⚠ podman: egress proxy is stopping under this account's Podman \(pi-dispatch-egress-proxy\)\n {4}→ a podman job meanwhile is retried once, then failed \(the worker does not refuse it outright on this state\); if it stays stopping, `podman logs pi-dispatch-egress-proxy` says why\n/);
	assert.doesNotMatch(transient.text, /✗ podman: egress proxy/);
});

// Issue #458: on Podman 4.x a job's network teardown cuts the proxy's route out unless another bridge container runs,
// and the proxy line above stays ✓ while every later egress job gets 503. So the keeper is read beside the proxy, and
// its absence is ✗ exactly where it breaks egress: 4.x, or a version podman info did not give.
test("with egress armed the rootless network keeper is read, and a missing one is ✗ on Podman 4.x only (#458)", async () => {
	const run = async ({ version = "4.9.3", keeper = "running", env = { PI_EGRESS: "1" } } = {}) => {
		const { out, text } = capture();
		const calls = [];
		const info = JSON.stringify({ ...JSON.parse(PODMAN_INFO()), version: { Version: version } });
		const code = await runDoctor(podmanEnv(env), podmanDeps(out, podmanPlan({ info, keeper }), calls));
		return { code, text: text(), calls };
	};
	const held = await run();
	assert.equal(held.code, 0);
	assert.match(held.text, /✓ podman: rootless network keeper running under this account's Podman on its own bridge network \(pi-dispatch-netns-keeper\), so a job's network teardown cannot cut the proxy's route out\n/);
	assert.deepEqual(held.calls.filter((c) => c.cmd === "podman" && c.args[0] === "inspect").map((c) => c.args), [
		["inspect", "--format={{.State.Status}}", "pi-dispatch-egress-proxy"],
		["inspect", "--format={{.State.Status}}|{{.HostConfig.NetworkMode}}|{{range $k, $v := .NetworkSettings.Networks}}{{$k}},{{end}}|{{.State.StartedAt.UnixMilli}}", "pi-dispatch-netns-keeper"],
		["inspect", "--format={{.State.StartedAt.UnixMilli}}", "pi-dispatch-egress-proxy"],
	]);
	const absent = await run({ keeper: null });
	assert.equal(absent.code, 1, "a missing keeper on 4.x fails doctor");
	assert.match(absent.text, /✗ podman: rootless network keeper pi-dispatch-netns-keeper is not under this account's Podman: on Podman 4\.9\.3, the first egress job's network teardown then cuts the proxy's route out, and every egress job after it gets 503 from the proxy\n {4}→ start it as the worker's account where its Quadlet unit is installed: systemctl --user reset-failed pi-dispatch-netns-keeper-network\.service pi-dispatch-netns-keeper\.service; systemctl --user restart pi-dispatch-netns-keeper-network\.service pi-dispatch-netns-keeper\.service \(else `pi-dispatch service install` or `pi-dispatch up` installs it/);
	const exited = await run({ keeper: "exited" });
	assert.equal(exited.code, 1);
	assert.match(exited.text, /✗ podman: rootless network keeper pi-dispatch-netns-keeper is exited under this account's Podman: on Podman 4\.9\.3/);
	// Issue #463's gate: RUNNING is not holding. What 4.9.3 printed for a keeper of this name on each other network mode
	// (measured), and one on another bridge only: each runs, protects nothing here, and is ✗ saying which.
	for (const [shape, words] of [
		["running|none|none,", /is running on the none network mode, not on its pi-dispatch-netns-keeper bridge network, so it holds nothing open/],
		["running|slirp4netns|", /is running on the slirp4netns network mode/],
		["running|pasta|", /is running on the pasta network mode/],
		["running|host|host,", /is running on the host network mode/],
		["running|bridge|pdn-other,", /is running but not attached to its pi-dispatch-netns-keeper bridge network \(it is on pdn-other\)/],
		["paused|bridge|pi-dispatch-netns-keeper,", /is paused under this account's Podman/],
	]) {
		const off = await run({ keeper: shape });
		assert.equal(off.code, 1, shape);
		assert.match(off.text, new RegExp(`✗ podman: rootless network keeper pi-dispatch-netns-keeper ${words.source}`), shape);
	}
	const twoNets = await run({ keeper: `running|bridge|pdn-other,pi-dispatch-netns-keeper,|${KEEPER_STARTED}` });
	assert.equal(twoNets.code, 0, "on its own network, whatever else it is on, it is a bridge member and holds");
	// PR #463 round 2, on an injected clock: a keeper up for under 3 s is not yet counted (a crash loop reads as running
	// for moments), and one that started more than 15 s after the proxy asks for a PROXY restart, since a teardown
	// while it was down may already have cut the proxy's route out and nothing outside shows it.
	const at = async (keeper, now, proxyStarted = PROXY_STARTED) => {
		const { out, text } = capture();
		const info = JSON.stringify({ ...JSON.parse(PODMAN_INFO()), version: { Version: "4.9.3" } });
		const code = await runDoctor(podmanEnv({ PI_EGRESS: "1" }), podmanDeps(out, podmanPlan({ info, keeper, proxyStarted }), [], { wallClock: () => now }));
		return { code, text: text() };
	};
	const young = await at(`running|bridge|pi-dispatch-netns-keeper,|${PROXY_STARTED + 15_000}`, PROXY_STARTED + 17_500);
	assert.equal(young.code, 1);
	assert.match(young.text, /✗ podman: rootless network keeper pi-dispatch-netns-keeper has been running for only 2\.5 s, and a keeper that keeps dying reads as running for a moment at a time; it counts once it has run for 3 s: on Podman 4\.9\.3/);
	const settled = await at(`running|bridge|pi-dispatch-netns-keeper,|${PROXY_STARTED + 15_000}`, PROXY_STARTED + 18_000);
	assert.equal(settled.code, 0, "3 s up, and within 15 s of the proxy: holds");
	const late = await at(`running|bridge|pi-dispatch-netns-keeper,|${PROXY_STARTED + 15_001}`, PROXY_STARTED + 600_000);
	assert.equal(late.code, 1);
	assert.match(late.text, /✗ podman: rootless network keeper pi-dispatch-netns-keeper started 15 s after the egress proxy did, so it was down while the proxy ran, and a job teardown in that gap would have cut the proxy's route out for good, which nothing can see from outside: on Podman 4\.9\.3, so every egress job may get 503 from the proxy until the proxy restarts, and the worker retries each one rather than start it\n {4}→ restart the egress proxy once no job is running: systemctl --user restart pi-dispatch-egress-proxy\.service/);
	// PR #463 round 3: a STOPPED keeper under a proxy up longer than the grace needs two steps, and the fix says both.
	const stoppedLate = await at(`exited|bridge|pi-dispatch-netns-keeper,|${KEEPER_STARTED}`, PROXY_STARTED + 600_000);
	assert.match(stoppedLate.text, /✗ podman: rootless network keeper pi-dispatch-netns-keeper is exited under this account's Podman[^\n]*\n {4}→ start it as the worker's account where its Quadlet unit is installed: systemctl --user reset-failed [^\n]*, then restart the egress proxy once no job is running: systemctl --user restart pi-dispatch-egress-proxy\.service \(podman restart pi-dispatch-egress-proxy for one started by hand\), since the proxy has been up since before it\./);
	const stoppedFresh = await at(`exited|bridge|pi-dispatch-netns-keeper,|${KEEPER_STARTED}`, PROXY_STARTED + 10_000);
	assert.doesNotMatch(stoppedFresh.text, /then restart the egress proxy/, "a proxy up under the grace: the keeper's start is enough");
	// PR #463 round 3: the keeper's network is read as it IS; a widened one (its units' --ignore keeps it) is ✗.
	const netAt = async (keeperNet) => {
		const { out, text } = capture();
		const calls = [];
		const code = await runDoctor(podmanEnv({ PI_EGRESS: "1" }), podmanDeps(out, podmanPlan({ keeperNet }), calls));
		return { code, text: text(), calls };
	};
	const shipped = await netAt("true false");
	assert.equal(shipped.code, 0);
	assert.match(shipped.text, /✓ podman: the keeper's network pi-dispatch-netns-keeper is internal with DNS off, so the keeper reaches nothing\n/);
	assert.ok(shipped.calls.some((c) => c.cmd === "podman" && c.args.join(" ") === "network inspect --format {{.Internal}} {{.DNSEnabled}} pi-dispatch-netns-keeper"));
	for (const [answer, words] of [["false false", "not internal \\(it has a route out\\)"], ["true true", "DNS on"], ["false true", "not internal \\(it has a route out\\) and DNS on"]]) {
		const widened = await netAt(answer);
		assert.equal(widened.code, 1, answer);
		assert.match(widened.text, new RegExp(`✗ podman: the keeper's network pi-dispatch-netns-keeper is ${words}, which is not the network this project ships[^\\n]*\\n {4}→ remove the network and restart the keeper units, which recreate it as shipped: systemctl --user stop pi-dispatch-netns-keeper\\.service; podman network rm pi-dispatch-netns-keeper; systemctl --user reset-failed`), answer);
	}
	const odd = await netAt("<no value>");
	assert.match(odd.text, /⚠ podman: whether the keeper's network pi-dispatch-netns-keeper is internal with DNS off could not be read/);
	const absentNet = await netAt(null);
	assert.doesNotMatch(absentNet.text, /keeper's network/, "no network: the keeper line already says what is missing");
	// Pinned as a READ that exited 125, not a read never made (PR #463 final review): the inspect ran, and said nothing.
	assert.ok(absentNet.calls.some((c) => c.cmd === "podman" && c.args.join(" ") === "network inspect --format {{.Internal}} {{.DNSEnabled}} pi-dispatch-netns-keeper"));
	assert.equal(absentNet.code, 0, "and nothing failed for it");
	const unreadStart = await at("running|bridge|pi-dispatch-netns-keeper,|", PROXY_STARTED);
	assert.match(unreadStart.text, /✗ podman: rootless network keeper pi-dispatch-netns-keeper is running, but when it started could not be read/);
	// The proxy's start not readable: the order cannot be judged, and is not held against the keeper.
	const noProxyStart = await at(`running|bridge|pi-dispatch-netns-keeper,|${PROXY_STARTED + 600_000}`, PROXY_STARTED + 700_000, null);
	assert.equal(noProxyStart.code, 0);
	// On 5.x neither rule is asked, and the proxy's start is not even read.
	const { out: o5, text: t5 } = capture();
	const calls5 = [];
	const info5 = JSON.stringify({ ...JSON.parse(PODMAN_INFO()), version: { Version: "5.8.1" } });
	assert.equal(await runDoctor(podmanEnv({ PI_EGRESS: "1" }), podmanDeps(o5, podmanPlan({ info: info5, keeper: `running|bridge|pi-dispatch-netns-keeper,|${PROXY_STARTED + 600_000}` }), calls5, { wallClock: () => PROXY_STARTED + 600_500 })), 0, t5());
	assert.ok(!calls5.some((c) => c.args.includes("--format={{.State.StartedAt.UnixMilli}}")));
	const unread = await run({ version: "", keeper: "exited" });
	assert.equal(unread.code, 1, "an unreported version is no evidence of 5.x");
	assert.match(unread.text, /✗ podman: rootless network keeper pi-dispatch-netns-keeper is exited [^\n]*: on Podman of an unreported version, the first egress job's/);
	for (const version of ["5.0.0", "5.8.1"]) {
		const five = await run({ version, keeper: null });
		assert.equal(five.code, 0, `Podman ${version} does not need it`);
		assert.match(five.text, new RegExp(`✓ podman: rootless network keeper pi-dispatch-netns-keeper is not under this account's Podman, which Podman ${version.replaceAll(".", "\\.")} does not need`));
	}
	// Egress off: no proxy is ever disconnected, so neither is read.
	const off = await run({ keeper: null, env: { PI_EGRESS: "0" } });
	assert.equal(off.code, 0);
	assert.doesNotMatch(off.text, /network keeper/);
	assert.ok(!off.calls.some((c) => c.cmd === "podman" && c.args[0] === "inspect"), "no inspect with egress off");
	// Whatever the proxy's name: the worker disconnects an operator's own proxy just the same.
	const own = await run({ keeper: null, env: { PI_EGRESS: "1", PI_EGRESS_PROXY: "my-squid" } });
	assert.match(own.text, /✗ podman: rootless network keeper pi-dispatch-netns-keeper is not under this account's Podman/);
});

test("the backend section judges the podman venue's words on its own observations, never the docker daemon's (#354)", () => {
	const observed = (observations, read = { answered: true }) => ({
		observations: { podmanBoundsDelegated: true, podmanAddsNoMounts: true, podmanServiceLocal: true, ...observations },
		evidence: { podmanBoundsDelegated: "the pids cgroup controller is not delegated", podmanAddsNoMounts: "mounts evidence", podmanServiceLocal: "podman info reports serviceIsRemote true" },
		read,
	});
	const env = { PI_BACKENDS: "podman" };
	const find = (checks, property) => checks.find((c) => c.label.startsWith(`podman: ${property} is ASSERTED`));
	// A docker daemon that reads as Podman-compat is given too: its answer must not speak for the podman venue.
	const daemon = { answered: true, facts: parseDaemonFacts(PODMAN_COMPAT_INFO).facts };
	const bounds = backendChecks(env, { daemon, fs: noHostFiles, podman: observed({ podmanBoundsDelegated: false }) });
	assert.deepEqual([find(bounds, "isolation").ok, find(bounds, "isolation").warn], [false, true]);
	assert.equal(find(bounds, "isolation").label, "podman: isolation is ASSERTED by this account's Podman setup, not enforced: the pids cgroup controller is not delegated");
	assert.equal(find(bounds, "isolation").fix, OBSERVATION_FIX.podmanBoundsDelegated);
	assert.equal(find(bounds, "mountSet"), undefined, "mounts observed, so quiet, whatever the docker daemon's files say");
	const remote = backendChecks(env, { fs: noHostFiles, podman: observed({ podmanServiceLocal: false }) });
	assert.match(find(remote, "credentialTransit").label, /credentialTransit is ASSERTED by the operator, not enforced: podman info reports serviceIsRemote true/);
	const unread = backendChecks(env, { fs: noHostFiles, podman: observed({ podmanBoundsDelegated: null }, { answered: false, reason: "timeout", transient: true }) });
	assert.match(find(unread, "isolation").fix, /fix what stops `podman info` answering for the worker's account/);
	for (const read of [{ answered: false, reason: "podman-not-found", transient: false }, null]) {
		const quiet = backendChecks(env, { daemon, fs: noHostFiles, podman: observed({ podmanBoundsDelegated: false, podmanAddsNoMounts: false, podmanServiceLocal: false }, read) });
		assert.equal(quiet.find((c) => /is ASSERTED/.test(c.label)), undefined, `${read?.reason ?? "never read"}: the podman section's refusal line is the whole story`);
	}
	// The floor judges the same observations, and names the podman remedy only.
	const floor = backendChecks({ ...env, PI_BACKEND_FLOOR: "isolation=enforced" }, { fs: noHostFiles, podman: observed({ podmanBoundsDelegated: false }) }).find((c) => /PI_BACKEND_FLOOR/.test(c.label));
	assert.deepEqual([floor.ok, floor.warn], [false, undefined]);
	assert.match(floor.label, /isolation=enforced \(podman provides it only while this worker's rootless Podman runs on cgroup v2/);
	assert.ok(floor.fix.startsWith(OBSERVATION_FIX.podmanBoundsDelegated), floor.fix);
	const held = backendChecks({ ...env, PI_BACKEND_FLOOR: "isolation=enforced,credentialTransit=enforced" }, { fs: noHostFiles, podman: observed({}) });
	assert.ok(held.some((c) => c.ok && /PI_BACKEND_FLOOR holds/.test(c.label)));
});

// The --live answers for the podman venue: local's, spoken by `podman`, with the probe running as the worker's uid.
const podmanLiveOk = () => Object.fromEntries(Object.entries(liveOk({ uid: "1234" })).map(([k, v]) => [k.replace(/^docker /, "podman "), v]));

test("doctor --live on podman reads the eight back through podman, as the worker's uid, with keep-id (#354)", async () => {
	const env = liveEnv({ PI_BACKENDS: "podman" });
	const { out, text } = capture();
	const calls = [];
	const code = await runDoctor(env, { ...podmanDeps(out, { ...podmanLiveOk(), ...podmanPlan() }, calls), live: true, liveFs: liveFsAs(1234), isAlive: () => false, pid: 7, nonce: "n", ...instantClock() });
	assert.equal(code, 0, text());
	const probe = calls.find((c) => c.args[0] === "run" && c.args.includes("sleep"));
	assert.equal(probe.cmd, "podman", "the probe runs under podman");
	assert.ok(probe.args.includes("--user=1234:1234") && probe.args.includes("--userns=keep-id"), `the podman builder's argv: ${probe.args.join(" ")}`);
	assert.ok(!calls.some((c) => c.cmd === "docker" && c.args.some((a) => String(a).includes("pi-dispatch-live"))), "nothing of the read-back touches docker");
	assert.equal(calls.filter((c) => c.cmd === "podman" && c.args[0] === "info").length, 2, "podman info is read by the collection AND again right before the probe");
	for (const property of ["isolation", "ephemeral", "mountSet", "imagePinning", "nonRoot", "localFolders"]) {
		assert.match(text(), new RegExp(`✓ read back on podman: ${property} holds`));
	}
	assert.match(text(), /✓ read back on podman: mountSet holds \([^)]*in podman inspect and in \/proc\/self\/mountinfo\)/);
	assert.match(text(), /✓ read back on podman: the probe ran as uid 1234, the job user this host decides \(1234:1234\)/);
	assert.match(text(), /⚠ read back on podman: jobToJobIsolation not read back: PI_EGRESS is off, so jobs share podman's default network by design/);
	assert.match(text(), /✓ read back on podman: limits of this read-back -- /);
	assert.doesNotMatch(text(), /read back on local|DOCKER_CONTENT_TRUST/);
	assert.deepEqual(readdirSync(env.PI_JOBS_DIR), [], "the fixture is removed");
});

test("doctor --live on podman runs nothing when podman is re-read as remote, or a podman job would be refused (#354)", async () => {
	let reads = 0;
	const flips = { ...podmanLiveOk(), ...podmanPlan(), "podman info": () => ({ code: 0, output: `${PODMAN_INFO(++reads > 1 ? { serviceIsRemote: true } : {})}\n` }) };
	const { out, text } = capture();
	const calls = [];
	await runDoctor(liveEnv({ PI_BACKENDS: "podman" }), { ...podmanDeps(out, flips, calls), live: true, ...instantClock(), liveFs: liveFsAs(1234), isAlive: () => false, pid: 7, nonce: "n" });
	assert.ok(!calls.some((c) => c.args.some((a) => String(a).includes("pi-dispatch-live"))), "no probe after the re-read");
	assert.match(text(), /⚠ read back on podman: not run -- this shell's podman CLI is not observed to point at this host/);
	const refused = capture();
	const refusedCalls = [];
	await runDoctor(liveEnv({ PI_BACKENDS: "podman" }), { ...podmanDeps(refused.out, { ...podmanLiveOk(), ...podmanPlan({ capabilities: "" }) }, refusedCalls), live: true, ...instantClock(), liveFs: liveFsAs(1234), isAlive: () => false, pid: 7, nonce: "n" });
	assert.match(refused.text(), /⚠ read back on podman: not run -- a podman job is refused as this uid \(any-uid-unsupported\), so a probe would read back a container no job gets\n {4}→ fix the podman job-user line above first/);
	assert.ok(!refusedCalls.some((c) => c.args.some((a) => String(a).includes("pi-dispatch-live"))));
});

test("doctor --live with both venues blessed reads back each on its own runtime, local's lines unchanged (#354)", async () => {
	const env = liveEnv({ PI_BACKENDS: "local,podman" });
	const { out, text } = capture();
	const calls = [];
	// uid 1001: the image's own, so both venues' probes run as it and one fake container answers both.
	const liveBoth = { ...liveOk(), ...Object.fromEntries(Object.entries(liveOk()).map(([k, v]) => [k.replace(/^docker /, "podman "), v])) };
	const { docker: _everyDocker, ...podmanOnly } = podmanPlan();
	const code = await runDoctor(env, { ...podmanDeps(out, { ...liveBoth, ...podmanOnly, ...infoPlan(ROOTFUL_INFO), ...green }, calls), live: true, liveFs: liveFsAs(1001), jobUserIdentity: LINUX_1001, isAlive: () => false, pid: 7, nonce: "n", ...instantClock() });
	assert.equal(code, 0, text());
	assert.match(text(), /✓ read back on local: mountSet holds \([^)]*in docker inspect and in \/proc\/self\/mountinfo\)/);
	assert.match(text(), /✓ read back on podman: mountSet holds \([^)]*in podman inspect and in \/proc\/self\/mountinfo\)/);
	assert.match(text(), /⚠ read back on local: jobToJobIsolation not read back: PI_EGRESS is off, so jobs share docker's default bridge by design/);
	assert.ok(text().indexOf("read back on local: limits") < text().indexOf("read back on podman: starting"), "local's read-back first, then podman's");
	assert.ok(calls.some((c) => c.cmd === "docker" && c.args[0] === "run" && c.args.includes("sleep")) && calls.some((c) => c.cmd === "podman" && c.args[0] === "run" && c.args.includes("sleep")));
});

test("a failed read-back on podman names podman's commands and the podman venue's declared word (#354)", async () => {
	const { out, text } = capture();
	// The pinning probe STARTED (a pull or a wrapper), and PID 1 ran as the image's uid rather than the worker's.
	const plan = { ...podmanLiveOk(), "podman run --name=pi-dispatch-live-pin-": { code: 0, output: `${"e".repeat(64)}\n` }, [`podman exec ${LIVE_ID} sh -c cat /proc/1/status`]: { code: 0, output: LIVE_STATUS("1001") }, ...podmanPlan() };
	const code = await runDoctor(liveEnv({ PI_BACKENDS: "podman" }), { ...podmanDeps(out, plan, []), live: true, liveFs: liveFsAs(1234), isAlive: () => false, pid: 7, nonce: "n", ...instantClock() });
	assert.equal(code, 1);
	assert.match(text(), /✗ read back on podman: imagePinning does NOT hold -- declared enforced, observed: a container started from an image this host does not have\n {4}→ the daemon ran or pulled an image this host does not have -- check for a podman CLI plugin or wrapper that rewrites `podman run`\n/);
	assert.match(text(), /✗ read back on podman: the probe ran as uid 1001, not the decided job user 1234:1234\n {4}→ podman did not apply --user with --userns=keep-id as the worker passes it/);
});

test("the podman SELinux line follows the relabel rule, and an unreported SELinux warns (#354)", async () => {
	const run = async (security) => {
		const { out, text } = capture();
		const calls = [];
		await runDoctor(podmanEnv(), podmanDeps(out, podmanPlan({ info: PODMAN_INFO({}, security) }), calls));
		return { text: text(), calls };
	};
	const on = await run({ selinuxEnabled: true });
	assert.match(on.text, /✓ podman: SELinux confines containers here, so a job's own directories are relabelled \(:Z\) and your local folders are not: the SELinux label lines below read those/);
	assert.match(on.text, /✓ SELinux: jobs' own directories are relabelled for SELinux \(:Z\)/, "and the label lines it names are there");
	const unreported = await run({ selinuxEnabled: "yes" });
	assert.doesNotMatch(unreported.text, /✓ SELinux: jobs' own directories/, "no relabel, so no label lines");
	assert.match(unreported.text, /⚠ podman: whether SELinux confines containers here was not reported, so nothing a job mounts is relabelled\n {4}→ on an SELinux host an unlabelled job directory is unreadable/);
});

test("a podman-only deployment on a host that also has docker: docker is not asked, and the in-image gh probe runs on podman (#354, #433)", async () => {
	const { out, text } = capture();
	const calls = [];
	const { docker: _everyDocker, ...podmanOnly } = podmanPlan();
	const plan = { ...podmanOnly, ...green, "gh auth status": { code: 0, output: ghStatusOutput }, "gh auth token": { code: 0, output: "gho_x\n" }, "podman run": 0 };
	const code = await runDoctor(podmanEnv({ PI_EGRESS: "1", GITHUB_AUTH_SOURCE: "gh" }), podmanDeps(out, plan, calls));
	assert.equal(code, 0, text());
	assert.deepEqual(calls.filter((c) => c.cmd === "docker"), [], "a docker that would answer is still not asked");
	assert.doesNotMatch(text(), /Docker daemon reachable|Job image present \(|Egress (policy|proxy)|^. local: /m);
	// The probe runs where this deployment's jobs start, with docker's argv, the token only in the spawn env.
	const probes = calls.filter((c) => c.cmd === "podman" && c.args[0] === "run");
	assert.equal(probes.length, 1, "one probe");
	// Review round 1: with the podman venue's pins, written out rather than imported, so a probe that drops one fails here.
	// Without `--env-host=false` an account's `env_host = true` would copy doctor's whole environment into the container.
	assert.deepEqual(probes[0].args, ["run", "--rm", "--pull=never", "--pid=private", "--ipc=private", "--uts=private", "--cgroupns=private", "--env-host=false", "--http-proxy=false", "-e", "GH_TOKEN", "-e", "GITHUB_TOKEN", "--entrypoint", "gh", "pi-job:latest", "auth", "status"]);
	assert.equal(probes[0].opts?.env?.GH_TOKEN, "gho_x");
	assert.ok(!probes[0].args.some((a) => a.includes("gho_x")), "never in argv");
	assert.match(text(), /⚠ GITHUB_AUTH_SOURCE=gh forwards[^\n]*\n[^\n]*\n✓ podman: gh authenticates inside the job image \(pi-job:latest\)\n/);
	// A failing probe says so, with podman named.
	const failed = capture();
	await runDoctor(podmanEnv({ GITHUB_AUTH_SOURCE: "gh" }), podmanDeps(failed.out, { ...plan, "podman run": 1 }, []));
	assert.match(failed.text(), /⚠ podman: gh cannot authenticate inside the job image \(pi-job:latest\)\n {4}→ check network egress from containers/);
	// Not run where the podman section did not read the image in this account's store, nor where it refused every podman
	// job (a remote service among them, which is where the token would otherwise ride to another machine).
	for (const [label, over] of [
		["image absent", podmanPlan({ image: false })],
		["remote service", podmanPlan({ info: PODMAN_INFO({ serviceIsRemote: true }) })],
		["rootful", podmanPlan({ info: PODMAN_INFO({}, { rootless: false }) })],
	]) {
		const { docker: _d, ...only } = over;
		const seen = [];
		const said = capture();
		await runDoctor(podmanEnv({ GITHUB_AUTH_SOURCE: "gh" }), podmanDeps(said.out, { ...only, ...green, "gh auth status": { code: 0, output: ghStatusOutput }, "gh auth token": { code: 0, output: "gho_x\n" }, "podman run": 0 }, seen));
		assert.ok(!seen.some((c) => c.args[0] === "run"), `${label}: no probe`);
		assert.doesNotMatch(said.text(), /gh (authenticates|cannot authenticate) inside/, label);
		assert.deepEqual(seen.filter((c) => c.cmd === "docker"), [], `${label}: no docker`);
	}
	// App mode says it was skipped, as it does on docker.
	const app = capture();
	await runDoctor(podmanEnv({ GITHUB_AUTH_SOURCE: "app" }), podmanDeps(app.out, plan, []));
	assert.match(app.text(), /✓ in-image gh auth: skipped \(GITHUB_AUTH_SOURCE=app mints per-job\)/);
});

test("podman-only: the podman image line is THE image check, and --fix pulls into this account's store through podman (#433)", async () => {
	const pullPlan = (pull = 0) => ({ ...podmanPlan({ image: false }), "podman pull": pull, "podman tag": 0 });
	const { out, text } = capture();
	const calls = [];
	const code = await runDoctor(podmanEnv(), { ...podmanDeps(out, pullPlan(), calls), fix: true, promptFn: async () => true });
	assert.equal(code, 1, "the image is still absent on the re-check, since the fake store never changes");
	assert.match(text(), /✗ podman: job image is not in this account's Podman store \(pi-job:latest\)\n {4}→ pull or load it AS THE WORKER'S ACCOUNT/);
	assert.ok(text().includes("fix available: podman: job image is not in this account's Podman store (pi-job:latest)\n    $ podman pull ghcr.io/edgehero/pi-job:latest && podman tag ghcr.io/edgehero/pi-job:latest pi-job:latest\n"), text());
	const fixes = calls.filter((c) => c.args[0] === "pull" || c.args[0] === "tag").map((c) => [c.cmd, ...c.args]);
	assert.deepEqual(fixes, [
		["podman", "pull", "ghcr.io/edgehero/pi-job:latest"],
		["podman", "tag", "ghcr.io/edgehero/pi-job:latest", "pi-job:latest"],
	]);
	assert.deepEqual(calls.filter((c) => c.cmd === "docker"), [], "no docker pull, no docker anything");
	// A failed pull is reported as podman's.
	const failing = capture();
	await runDoctor(podmanEnv(), { ...podmanDeps(failing.out, pullPlan(1), []), fix: true, promptFn: async () => true });
	assert.match(failing.text(), /podman pull failed/);
	// An overridden PI_JOB_IMAGE is the operator's trust choice: named in the fix line, never pulled for them.
	const custom = capture();
	const customAsked = [];
	await runDoctor(podmanEnv({ PI_JOB_IMAGE: "registry.example/mine:1" }), { ...podmanDeps(custom.out, pullPlan(), []), fix: true, promptFn: async (q) => (customAsked.push(q), true) });
	assert.match(custom.text(), /✗ podman: job image is not in this account's Podman store \(registry\.example\/mine:1\)\n {4}→ [^\n]*podman pull registry\.example\/mine:1/);
	assert.deepEqual(customAsked, [], "no offer for an image the operator chose");
	// A store that did not answer is not a miss, and gets no offer either: the second `podman info` of the image
	// preflight's disambiguation fails, while the first (the section's own read) answered.
	let infos = 0;
	const unanswered = capture();
	const unansweredAsked = [];
	await runDoctor(podmanEnv(), {
		...podmanDeps(unanswered.out, { ...pullPlan(), "podman info": () => (++infos === 1 ? { code: 0, output: `${PODMAN_INFO()}\n` } : { code: 125, output: "" }) }, []),
		fix: true,
		promptFn: async (q) => (unansweredAsked.push(q), true),
	});
	assert.match(unanswered.text(), /⚠ podman: whether the job image is in this account's Podman store could not be read \(pi-job:latest\)/);
	assert.deepEqual(unansweredAsked, []);
});

test("podman-only: a trigger-named image is asked of this account's Podman store, never docker's (#433)", async () => {
	const run = async (plan, env = {}, image = "my-python:1.2.0", extra = {}) => {
		const { out, text } = capture();
		const calls = [];
		const code = await runDoctor(podmanEnv({ PI_TRIGGERS_FILE: triggersFile(undefined, image, extra), ...env }), podmanDeps(out, plan, calls));
		return { code, text: text(), calls };
	};
	const absent = await run({ "podman image inspect my-python:1.2.0": 1, ...podmanPlan() });
	assert.equal(absent.code, 1, "a trigger that can never run fails, as on docker");
	assert.match(absent.text, /✗ podman: trigger job image present in this account's Podman store \(my-python:1\.2\.0\)\n {4}→ pull, load or build it AS THE WORKER'S ACCOUNT[^\n]*podman pull my-python:1\.2\.0[^\n]*--pull=never/);
	// The whole fix line (issue #453): `docker save ... | podman load` was offered as an alternative, and a podman-only
	// host has no docker to save from.
	assert.ok(absent.text.includes("\n    → pull, load or build it AS THE WORKER'S ACCOUNT, since rootless Podman keeps one image store per account: podman pull my-python:1.2.0 -- a trigger names it in run.image, and jobs run with --pull=never, so the worker never fetches it at job time\n"), absent.text);
	assert.deepEqual(absent.calls.filter((c) => c.cmd === "docker"), [], "no docker image inspect");
	assert.deepEqual(absent.calls.filter((c) => c.args.includes("my-python:1.2.0")).map((c) => [c.cmd, ...c.args]), [["podman", "image", "inspect", "my-python:1.2.0"]]);
	const wrapped = await run({ "podman image inspect --format={{json": { code: 0, output: '["/bin/sh"]\n' }, "podman image inspect my-python:1.2.0": 0, ...podmanPlan() });
	assert.match(wrapped.text, /✓ podman: trigger job image present in this account's Podman store \(my-python:1\.2\.0\)\n⚠ podman: my-python:1\.2\.0 does not appear to carry the pi-dispatch runner entrypoint\n {4}→ build your job image FROM this repo's image\/Dockerfile/);
	assert.equal(wrapped.code, 0, "warn, never fail");
	const conformant = await run({ "podman image inspect --format={{json": RUNNER_ENTRYPOINT, "podman image inspect my-python:1.2.0": 0, ...podmanPlan() });
	assert.doesNotMatch(conformant.text, /does not appear to carry/);
	// Not asked on top of a store the section could not read: off Linux podman is not asked at all.
	const { out, text } = capture();
	const offLinux = [];
	await runDoctor(podmanEnv({ PI_TRIGGERS_FILE: triggersFile(undefined, "my-python:1.2.0") }), podmanDeps(out, podmanPlan(), offLinux, { jobUserIdentity: { platform: "darwin", euid: 501, egid: 20 } }));
	assert.ok(!offLinux.some((c) => c.args.includes("my-python:1.2.0")), text());
	// With both venues, each image is asked of the runtime its trigger's jobs start on: run.backend, else the default.
	const both = { "podman image inspect my-python:1.2.0": 0, "podman image inspect --format={{json": RUNNER_ENTRYPOINT, ...green, "docker image inspect --format={{json": RUNNER_ENTRYPOINT, ...podmanPlan() };
	for (const [PI_BACKENDS, backend, cli] of [
		["local,podman", "podman", "podman"],
		["local,podman", undefined, "docker"],
		["podman,local", undefined, "podman"],
		["podman,local", "local", "docker"],
	]) {
		const r = await run(both, { PI_BACKENDS }, "my-python:1.2.0", backend === undefined ? {} : { backend });
		const asked = [...new Set(r.calls.filter((c) => c.args.includes("my-python:1.2.0")).map((c) => c.cmd))];
		assert.deepEqual(asked, [cli], `${PI_BACKENDS} run.backend=${backend}: ${r.text}`);
		assert.match(r.text, cli === "podman" ? /✓ podman: trigger job image present in this account's Podman store \(my-python:1\.2\.0\)/ : /✓ Trigger job image present \(my-python:1\.2\.0\)/);
	}
});

test("podman-only: trigger images are not asked of a Podman store that did not answer for the default image (#433)", async () => {
	// The section's own `podman info` answers; the image preflight's disambiguating second one does not, so the store's
	// answer about the default image is "unavailable", and asking it about a trigger's image would be noise on top.
	let infos = 0;
	const calls = [];
	const { out, text } = capture();
	await runDoctor(
		podmanEnv({ PI_TRIGGERS_FILE: triggersFile(undefined, "my-python:1.2.0") }),
		podmanDeps(out, { "podman image inspect my-python:1.2.0": 0, ...podmanPlan({ image: false }), "podman info": () => (++infos === 1 ? { code: 0, output: `${PODMAN_INFO()}\n` } : { code: 125, output: "" }) }, calls),
	);
	assert.match(text(), /⚠ podman: whether the job image is in this account's Podman store could not be read \(pi-job:latest\)/);
	assert.ok(!calls.some((c) => c.args.includes("my-python:1.2.0")), "no trigger image asked of a store that did not answer");
	assert.doesNotMatch(text(), /trigger job image/);
});

test("podman-only: the `--fix` podman pull runs under the LONG bound, not the default one (#433)", async () => {
	// docker's pull pin, for the podman pull: by the clock, since the bound is not in the argv.
	const checks = await collectChecks(podmanEnv(), { ...podmanDeps(() => {}, podmanPlan({ image: false }), []), cwd: tempDir("pi-433-bound-"), readHosts: async () => ({ hosts: [] }), agentDir: NO_AGENT_DIR, runTimeouts: FAST_TIMEOUTS });
	const image = checks.find((c) => c.label === "podman: job image is not in this account's Podman store (pi-job:latest)");
	assert.ok(image?.fixAction, "the podman image line offers the pull");
	const began = Date.now();
	const res = await image.fixAction.run({ spawn: fakeSpawn({ "podman pull": "hang", podman: 0 }) });
	const took = Date.now() - began;
	assert.equal(res.ok, false);
	assert.match(res.note, /podman pull did not finish within/);
	assert.ok(took >= FAST_TIMEOUTS.pull - 5, `waited ${took}ms, which is the PULL bound (${FAST_TIMEOUTS.pull}) and not the default (${FAST_TIMEOUTS.cmd})`);
});

test("a trigger whose run.backend names a venue PI_BACKENDS does not list fails doctor, in both directions (#433)", async () => {
	const run = async (env, plan, backend) => {
		const { out, text } = capture();
		const code = await runDoctor({ ...env, PI_TRIGGERS_FILE: triggersFile(undefined, undefined, { backend }) }, podmanDeps(out, plan, []));
		return { code, text: text() };
	};
	const onPodman = await run(podmanEnv(), podmanPlan(), "local");
	assert.equal(onPodman.code, 1);
	assert.ok(onPodman.text.includes('✗ run.backend "local" is not in PI_BACKENDS (podman), so every job of cron "nightly" is refused (backend-unblessed)\n    → add local to PI_BACKENDS, or change run.backend on that trigger to a venue PI_BACKENDS lists -- the worker refuses each such job before it spends\n'), onPodman.text);
	const onLocal = await run({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_EGRESS: "0" }, { ...green }, "podman");
	assert.ok(onLocal.text.includes('✗ run.backend "podman" is not in PI_BACKENDS (local), so every job of cron "nightly" is refused (backend-unblessed)'), onLocal.text);
	// A blessed venue says nothing, on either kind of deployment.
	for (const [env, plan, backend] of [
		[podmanEnv(), podmanPlan(), "podman"],
		[podmanEnv({ PI_BACKENDS: "local,podman" }), { ...green, ...podmanPlan() }, "local"],
		[podmanEnv({ PI_BACKENDS: "local,podman" }), { ...green, ...podmanPlan() }, "podman"],
	]) {
		assert.doesNotMatch((await run(env, plan, backend)).text, /backend-unblessed/, `${env.PI_BACKENDS} ${backend}`);
	}
	// An unparseable PI_BACKENDS is the backend section's failure, not a verdict on every trigger: doctor otherwise reads
	// it as the unset default (local alone), against which "podman" would be judged unblessed by a guessed list.
	const unparsed = await run(podmanEnv({ PI_BACKENDS: "local,nonsense" }), { ...green, ...podmanPlan() }, "podman");
	assert.match(unparsed.text, /✗ backend configuration does not parse/);
	assert.doesNotMatch(unparsed.text, /backend-unblessed/);
});

test("on a fleet the unblessed-venue line judges only triggers this host serves, and says what this host does (#433)", async () => {
	const env = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_EGRESS: "0", PI_WORKER_NAME: "mini1" };
	const deps = (out, calls, extra = {}) => ({ ...ghDeps(out, { ...green }, calls), agentDir: NO_AGENT_DIR, readHosts: async () => ({ hosts: [] }), ...extra });
	// A cron trigger whose folder is another machine's: not scheduled here (the worker's own `folder-absent`), so this
	// host's PI_BACKENDS says nothing about it, and doctor says nothing either.
	const elsewhere = capture();
	const code = await runDoctor({ ...env, PI_TRIGGERS_FILE: triggersFile(undefined, undefined, { backend: "podman", folder: "/srv/only-on-mini2" }) }, deps(elsewhere.out, [], { fileExists: (p) => p !== "/srv/only-on-mini2" }));
	assert.doesNotMatch(elsewhere.text(), /backend-unblessed/, elsewhere.text());
	assert.equal(code, 0, elsewhere.text());
	// The same trigger with its folder HERE is served, and still fails, in the fleet's words.
	const here = capture();
	const hereCode = await runDoctor({ ...env, PI_TRIGGERS_FILE: triggersFile(undefined, undefined, { backend: "podman" }) }, deps(here.out, []));
	assert.equal(hereCode, 1);
	assert.ok(here.text().includes('✗ run.backend "podman" is not in this host\'s PI_BACKENDS (local), so a job of cron "nightly" that this host picks up is refused (backend-unblessed)\n    → add podman to this host\'s PI_BACKENDS, or change run.backend on that trigger to a venue PI_BACKENDS lists -- this host\'s worker refuses each such job it picks up before it spends\n'), here.text());
	// Without a declared name there is no fleet: an absent folder is the worker's boot refusal, not placement, so the
	// trigger is still judged, in the single host's words.
	const single = capture();
	const { PI_WORKER_NAME: _n, ...singleEnv } = env;
	await runDoctor({ ...singleEnv, PI_TRIGGERS_FILE: triggersFile(undefined, undefined, { backend: "podman", folder: "/srv/only-on-mini2" }) }, deps(single.out, [], { fileExists: (p) => p !== "/srv/only-on-mini2" }));
	assert.ok(single.text().includes('✗ run.backend "podman" is not in PI_BACKENDS (local), so every job of cron "nightly" is refused (backend-unblessed)'), single.text());
});

test("a webhook trigger is named by its position in the file, in the unblessed-venue line and the flow line alike (#433)", async () => {
	const path = join(tempDir("pi-433-label-"), "triggers.json");
	writeFileSync(
		path,
		JSON.stringify({
			triggers: [
				{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/repo", flow: "review", task: "t" } },
				{ on: { type: "label", any: ["pi:fix"] }, run: { kind: "gitlab", flow: "fix", backend: "podman" } },
			],
		}),
	);
	const { out, text } = capture();
	await runDoctor({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_EGRESS: "0", PI_TRIGGERS_FILE: path }, { ...ghDeps(out, { ...green }, []), agentDir: NO_AGENT_DIR, readHosts: async () => ({ hosts: [] }) });
	assert.ok(text().includes('✗ run.backend "podman" is not in PI_BACKENDS (local), so every job of label trigger #1 is refused (backend-unblessed)'), text());
	assert.match(text(), /⚠ Trigger flow "fix" resolves in NO tier visible here \(label trigger #1\)/);
});

test("the unblessed-venue line judges only cron triggers this host's worker schedules: a sibling's bad skillsDir changes nothing (#433)", async () => {
	// Review round 3, D1: on a fleet, one SERVED trigger with a skillsDir that is not there must not make doctor judge
	// another machine's trigger. The skills-dir failure is still reported, by its own line.
	const path = join(tempDir("pi-433-r3-"), "triggers.json");
	writeFileSync(
		path,
		JSON.stringify({
			triggers: [
				{ on: { type: "cron", id: "mine", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/here", flow: "review", task: "t", skillsDir: "/srv/skills-missing" } },
				{ on: { type: "cron", id: "theirs", pattern: "0 4 * * *" }, run: { kind: "local", folder: "/srv/only-on-mini2", flow: "review", task: "t", backend: "podman" } },
			],
		}),
	);
	const { out, text } = capture();
	const fileExists = (p) => !["/srv/only-on-mini2", "/srv/skills-missing"].includes(p);
	await runDoctor({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_EGRESS: "0", PI_WORKER_NAME: "mini1", PI_TRIGGERS_FILE: path }, { ...ghDeps(out, { ...green }, [], { fileExists }), agentDir: NO_AGENT_DIR, readHosts: async () => ({ hosts: [] }) });
	assert.doesNotMatch(text(), /backend-unblessed/, text());
	assert.match(text(), /✗ Trigger skills dir present \(\/srv\/skills-missing\)/);
});

test("without PI_TRIGGERS_FILE the worker schedules no cron, so no cron trigger is judged for its venue; a forge trigger still is (#433)", async () => {
	// Review round 3, D2: doctor reads ./triggers.json by default (the receiver's default), but the worker schedules
	// cron only from a PI_TRIGGERS_FILE it was given.
	const cwd = tempDir("pi-433-r3-cwd-");
	const triggers = [{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/repo", flow: "review", task: "t", backend: "podman" } }];
	writeFileSync(join(cwd, "triggers.json"), JSON.stringify({ triggers }));
	const env = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_EGRESS: "0" };
	const deps = (out) => ({ ...ghDeps(out, { ...green }, []), cwd, agentDir: NO_AGENT_DIR, readHosts: async () => ({ hosts: [] }) });
	const unset = capture();
	await runDoctor(env, deps(unset.out));
	assert.match(unset.text(), /Trigger flow "review"/, "the file was read");
	assert.doesNotMatch(unset.text(), /backend-unblessed/, unset.text());
	// The same file named in PI_TRIGGERS_FILE is scheduled, so the same trigger is judged.
	const named = capture();
	await runDoctor({ ...env, PI_TRIGGERS_FILE: join(cwd, "triggers.json") }, deps(named.out));
	assert.ok(named.text().includes('✗ run.backend "podman" is not in PI_BACKENDS (local), so every job of cron "nightly" is refused (backend-unblessed)'), named.text());
	// A forge trigger in the default file keeps its judgement: the receiver reads that file and enqueues its jobs.
	writeFileSync(join(cwd, "triggers.json"), JSON.stringify({ triggers: [...triggers, { on: { type: "label", any: ["pi:fix"] }, run: { kind: "gitlab", flow: "fix", backend: "podman" } }] }));
	const forge = capture();
	await runDoctor(env, deps(forge.out));
	assert.ok(forge.text().includes('✗ run.backend "podman" is not in PI_BACKENDS (local), so every job of label trigger #1 is refused (backend-unblessed)'), forge.text());
});

test("doctor places a cron trigger by the worker's own predicate, not a copy (#433)", () => {
	const doctorSource = readFileSync(new URL("../src/doctor.mjs", import.meta.url), "utf8");
	const schedulesSource = readFileSync(new URL("../src/schedules.mjs", import.meta.url), "utf8");
	assert.match(doctorSource, /^import \{ cronPlacement \} from "\.\/schedules\.mjs";$/m);
	assert.match(schedulesSource, /const placement = cronPlacement\(run, \{ existsSync, fleet \}\);/, "the worker's loader places by the same function");
	assert.doesNotMatch(doctorSource, /existsSync\(run\.folder\)|fileExists\(t\.run\.folder\)/, "and doctor keeps no folder rule of its own");
});

test("podman-only: Valkey's fix points at the podman route, and --fix never runs docker for it (#433)", async () => {
	const { out, text } = capture();
	const calls = [];
	const asked = [];
	await runDoctor(podmanEnv(), { ...podmanDeps(out, podmanPlan(), calls, { probeValkey: async () => false }), fix: true, promptFn: async (q) => (asked.push(q), true) });
	assert.match(text(), /✗ Valkey reachable \(redis:\/\/127\.0\.0\.1:6379\)\n {4}→ run `pi-dispatch up` \(or `pi-dispatch service install`\) as this account: on the podman venue both start Valkey as a Quadlet unit under its Podman \(docs\/podman\.md, setup step 6\); a Valkey you run yourself, a distribution package say, works too\n/);
	assert.doesNotMatch(text(), /docker compose|docker run|fix available: Valkey/);
	assert.deepEqual(asked, []);
	assert.deepEqual(calls.filter((c) => c.cmd === "docker"), []);
	// With local blessed, the docker route is offered exactly as before.
	const mixed = capture();
	await runDoctor(podmanEnv({ PI_BACKENDS: "local,podman" }), { ...podmanDeps(mixed.out, { ...green, ...podmanPlan() }, [], { probeValkey: async () => false }), fix: true, promptFn: async () => false });
	assert.match(mixed.text(), /✗ Valkey reachable \(redis:\/\/127\.0\.0\.1:6379\)\n {4}→ docker compose -f deploy\/docker-compose\.yml up -d\n/);
	assert.match(mixed.text(), /fix available: Valkey reachable/);
});

test("podman-only: the fleet digest is the podman store's own id, read with no docker spawn (#433)", async () => {
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	for (const [peerDigest, differs] of [
		["abc", false],
		["sha256:other", true],
	]) {
		const { out, text } = capture();
		const calls = [];
		await runDoctor(podmanEnv({ PI_WORKER_NAME: "mini1" }), podmanDeps(out, podmanPlan(), calls, { readHosts: async () => ({ hosts: [{ name: "mini2", tz, imageDigest: peerDigest }] }) }));
		assert.match(text(), /✓ Fleet: 2 workers \(mini1, mini2\)/);
		assert.equal(/Job image digest differs/.test(text()), differs, text());
		assert.deepEqual(calls.filter((c) => c.cmd === "docker"), []);
		assert.equal(calls.filter((c) => c.cmd === "podman" && c.args[0] === "image").length, 1, "the section's own image read, not a second one");
	}
});

test("doctor --fix doctrine on a podman-only deployment: only the default image's podman pull is offered (#433)", async () => {
	const checks = await collectChecks(podmanEnv({ PI_TRIGGERS_FILE: triggersFile(undefined, "custom-img:1") }), {
		...podmanDeps(() => {}, { "podman image inspect custom-img:1": 1, ...podmanPlan({ image: false }) }, []),
		cwd: tempDir("pi-podman-doctrine-"),
		probeValkey: async () => false,
		readHosts: async () => ({ hosts: [] }),
		agentDir: NO_AGENT_DIR,
	});
	const carried = assertFixActionDoctrine(checks);
	assert.ok(carried.includes("podman: job image is not in this account's Podman store (pi-job:latest)"), carried.join("\n"));
	const trigger = checks.find((c) => c.label === "podman: trigger job image present in this account's Podman store (custom-img:1)");
	assert.ok(trigger && !trigger.ok, "the fixture reaches the podman trigger-image check");
	assert.equal(trigger.fixAction, undefined, "a trigger-named image is a per-flow trust posture, never pulled for the operator");
	const valkey = checks.find((c) => c.label.startsWith("Valkey reachable"));
	assert.ok(!valkey.ok);
	assert.equal(valkey.fixAction, undefined, "no docker run for Valkey without local");
});

// Issue #431: the podman venue's --live with egress armed, driven straight through `podmanLiveChecks` on the facts the
// podman section hands it. Every podman answer by prefix; `docker` LAST and "enoent", and every docker spawn is asserted
// absent besides, so a podman path that reached for docker cannot pass on a lucky answer.
const toPodman = (plan) => Object.fromEntries(Object.entries(plan).map(([k, v]) => [k.replace(/^docker /, "podman "), v]));
const podmanEgressFacts = (egress = {}, over = {}) => ({
	jobImage: "pi-job:latest",
	triggerImages: [],
	podman: { run: true, user: "1234:1234", relabel: false, info: { rootless: true, serviceIsRemote: false, selinux: false }, imagePresent: true, egress: { armed: true, proxy: "pi-dispatch-egress-proxy", proxyRunning: true, ...egress }, ...over },
});
const podmanEgressSeams = (canary = {}, calls = [], plan = {}) => ({
	// `canary` FIRST, for its keys' place in the prefix match, and LAST, for their values: a spread keeps the first place a
	// key had and the last value it was given, so spreading it once would lose an override of a key the rest also carry.
	spawn: fakeSpawn({ ...canary, ...toPodman(liveOk({ uid: "1234" })), ...toPodman(livePeersOk(plan)), ...podmanPlan(), "podman network": 0, ...canary }, calls),
	liveFs: liveFsAs(1234),
	isAlive: () => false,
	pid: 1,
	nonce: "n",
	jobUserIdentity: LINUX_ID(1234),
	...instantClock(),
});
const PODMAN_PROBE = "podman run --name=pi-dispatch-egress-probe-";
// The podman canary's probe argv, WRITTEN OUT rather than built by the builder under test: a job's own argv (the
// builder's isolation flags and bounds, the job user, keep-id and the venue's pinned flags, a job's HOME and its four
// egress variables), on the canary network, with no mount, running the runner's route to the network.
const podmanProbeArgv = (slug, url) => [
	"run",
	`--name=pi-dispatch-egress-probe-${slug}-1`,
	"--pull=never",
	"--rm",
	"--init",
	"--cap-drop=ALL",
	"--security-opt",
	"no-new-privileges",
	"--pids-limit=512",
	"--shm-size=1g",
	"--memory=4g",
	"--cpus=2",
	"--network=pi-dispatch-egress-doctor-1",
	"--user=1234:1234",
	"--userns=keep-id",
	"--pid=private",
	"--ipc=private",
	"--uts=private",
	"--cgroupns=private",
	"--env-host=false",
	"--http-proxy=false",
	"--entrypoint",
	"node",
	"-e",
	"HOME=/home/pi",
	"-e",
	"HTTPS_PROXY=http://pi-dispatch-egress-proxy:3128",
	"-e",
	"HTTP_PROXY=http://pi-dispatch-egress-proxy:3128",
	"-e",
	"NO_PROXY=localhost,127.0.0.1",
	"-e",
	"NODE_USE_ENV_PROXY=1",
	"pi-job:latest",
	"-e",
	egressCanaryScript(url),
];

test("doctor --live on podman reads egress back through a canary under podman, built as a podman job is (#431)", async () => {
	const env = liveEnv({ PI_EGRESS: "1", PI_BACKENDS: "podman" });
	const calls = [];
	const held = await podmanLiveChecks(env, podmanEgressSeams({ [`${PODMAN_PROBE}provider`]: 0, [`${PODMAN_PROBE}unlisted`]: 3 }, calls), podmanEgressFacts());
	const labels = held.map((c) => c.label);
	assert.deepEqual(calls.filter((c) => c.cmd !== "podman"), [], "the podman path never spawns docker, or anything else");
	// The canary's own steps, in order, all under podman: the sweep's listing, the network, the two probes, the teardown.
	const canarySteps = calls.filter((c) => c.args.some((a) => /pi-dispatch-egress-(doctor|probe)-/.test(String(a)))).map((c) => c.args.slice(0, 3).join(" "));
	assert.deepEqual(canarySteps, [
		"network ls --filter",
		"network create --internal",
		"network connect pi-dispatch-egress-doctor-1",
		"run --name=pi-dispatch-egress-probe-provider-1 --pull=never",
		"run --name=pi-dispatch-egress-probe-unlisted-1 --pull=never",
		"network disconnect -f",
		"network rm pi-dispatch-egress-doctor-1",
	]);
	// The probes' argv, exactly: the venue's pins and the job user, never a weaker hand-rolled one.
	const probes = calls.filter((c) => String(c.args[1]).startsWith("--name=pi-dispatch-egress-probe-"));
	assert.deepEqual(probes[0].args, podmanProbeArgv("provider", "https://api.anthropic.com/v1/messages"));
	assert.deepEqual(probes[1].args, podmanProbeArgv("unlisted", "https://example.com/"));
	// want and reached per probe, carried where the verdict reads them, and the lines say podman.
	assert.deepEqual(held.filter((c) => c.readBack).map((c) => c.readBack), [{ property: "egress", want: true, reached: true }, { property: "egress", want: false, reached: false }]);
	assert.ok(labels.includes("podman: Egress policy reaches the provider (api.anthropic.com answered, so the whole path works and no key was spent)"), labels.join("\n"));
	assert.ok(labels.includes("podman: Egress policy denies an unlisted host (the deny direction is the half an allowlist can silently lose)"));
	assert.ok(held.some((c) => c.ok && c.label === "read back on podman: egress holds (the provider was reached and an unlisted host was not)"), labels.join("\n"));
	assert.ok(labels.indexOf("podman: Egress policy reaches the provider (api.anthropic.com answered, so the whole path works and no key was spent)") < labels.findIndex((l) => l.startsWith("read back on podman: egress")), "the canary's lines come first, so the verdict's 'above' is true");
	assert.equal(calls.filter((c) => c.args[0] === "info").length, 2, "podman info asked again before the canary, and again before the probes");
	assert.ok(held.some((c) => c.ok && /^read back on podman: jobToJobIsolation holds \(peer1 reached the proxy/.test(c.label)), labels.join("\n"));
	assert.match(held.at(-1).label, /jobToJobIsolation tried one pair of peers on this account's Podman job networks/);
	const noAddress = await podmanLiveChecks(env, { ...podmanEgressSeams({ [`${PODMAN_PROBE}provider`]: 0, [`${PODMAN_PROBE}unlisted`]: 3, "podman inspect --format={{json .NetworkSettings.Networks}}": { code: 1, output: "" } }) }, podmanEgressFacts());
	assert.ok(noAddress.some((c) => c.warn && /jobToJobIsolation not read back: podman inspect gave peer2 no address/.test(c.label)), noAddress.map((c) => c.label).join("\n"));
});

test("a podman canary that reaches an unlisted host, or not the provider, fails egress on podman, and an unrun probe is not a reading (#431)", async () => {
	const env = liveEnv({ PI_EGRESS: "1", PI_BACKENDS: "podman" });
	const run = (canary) => podmanLiveChecks(env, podmanEgressSeams(canary), podmanEgressFacts());
	const open = await run({ [`${PODMAN_PROBE}provider`]: 0, [`${PODMAN_PROBE}unlisted`]: 0 });
	assert.ok(open.some((c) => c.warn && !c.ok && c.label === "podman: Egress policy ALLOWS an unlisted host that is not on your allowlist"));
	const verdict = open.find((c) => c.label.startsWith("read back on podman: egress"));
	assert.deepEqual([verdict.ok, verdict.warn, verdict.label], [false, undefined, "read back on podman: egress does NOT hold -- declared enforced, observed: an unlisted host was reached"]);
	const shut = await run({ [`${PODMAN_PROBE}provider`]: 3, [`${PODMAN_PROBE}unlisted`]: 3 });
	assert.ok(shut.some((c) => c.label === "podman: Egress policy does NOT reach the provider (api.anthropic.com)"));
	assert.match(shut.find((c) => c.label.startsWith("read back on podman: egress")).label, /egress does NOT hold -- declared enforced, observed: the provider was not reached$/);
	const stale = await run({ [`${PODMAN_PROBE}provider`]: EGRESS_CANARY_STALE_RUNNER });
	assert.ok(stale.some((c) => c.warn && c.label.startsWith(`podman: Egress policy: not proved, because the job image could not find ${EGRESS_CANARY_RUNNER_MODULE}`)));
	assert.match(stale.find((c) => c.label.startsWith("read back on podman: egress")).label, /egress not read back: the egress canary did not run both probes \(see the egress lines above\)/);
	const refused = await run({ [`${PODMAN_PROBE}provider`]: 125, [`${PODMAN_PROBE}unlisted`]: 3 });
	assert.ok(refused.some((c) => c.label === "podman: Egress policy probe for the provider did not run (podman run exited 125)"));
	assert.match(refused.find((c) => c.label.startsWith("read back on podman: egress")).label, /egress not read back: an egress probe did not run to an answer/);
});

test("the podman canary is stopped by the venue's refusals, a service no longer this host's own, the policy off, and a proxy that is down (#431)", async () => {
	const env = liveEnv({ PI_EGRESS: "1", PI_BACKENDS: "podman" });
	const canaryObjects = (calls) => calls.filter((c) => c.args.some((a) => /pi-dispatch-egress-(doctor|probe)-/.test(String(a))));
	// A refusal (the conf refusal of #428, a job-user refusal): nothing at all is spawned, the canary included.
	for (const reason of ["a podman job is refused here (podman-conf-widens-job), so a probe would read back a container no job gets", "a podman job is refused as this uid (any-uid-unsupported), so a probe would read back a container no job gets"]) {
		const calls = [];
		const checks = await podmanLiveChecks(env, podmanEgressSeams({}, calls), podmanEgressFacts({}, { run: false, reason }));
		assert.deepEqual(calls, [], reason);
		assert.equal(checks.length, 1);
	}
	// A service re-read as remote: no canary object, one line saying why, and the verdict unread.
	const remoteCalls = [];
	const remote = await podmanLiveChecks(env, podmanEgressSeams({ "podman info": { code: 0, output: `${PODMAN_INFO({ serviceIsRemote: true })}\n` } }, remoteCalls), podmanEgressFacts());
	assert.deepEqual(canaryObjects(remoteCalls), []);
	assert.ok(remote.some((c) => c.warn && c.label === "podman: Egress policy: not proved, because this shell's podman CLI is not observed to point at this host, so no canary container was started"));
	// The policy off: no sweep, no canary, and not even the re-ask.
	const offCalls = [];
	const off = await podmanLiveChecks(liveEnv({ PI_BACKENDS: "podman" }), podmanEgressSeams({}, offCalls), podmanEgressFacts({ armed: false, proxyRunning: null }));
	assert.deepEqual(canaryObjects(offCalls), []);
	assert.equal(offCalls.filter((c) => c.args[0] === "info").length, 1, "only runLiveProbes' own re-ask");
	assert.ok(off.some((c) => c.label === "read back on podman: egress not read back: PI_EGRESS is off, so there is no policy to read back"));
	// A proxy seen stopped, or an image not in the store: the SWEEP still runs, the canary does not.
	for (const facts of [podmanEgressFacts({ proxyRunning: false }), podmanEgressFacts({}, { imagePresent: false })]) {
		const calls = [];
		await podmanLiveChecks(env, podmanEgressSeams({}, calls), facts);
		assert.deepEqual(canaryObjects(calls).map((c) => c.args.slice(0, 2).join(" ")), ["network ls"], "swept, and nothing created");
	}
});

test("the stale canary sweep works on podman: a dead run's leftover in this account's Podman is removed through podman, in podman's words (#431)", async () => {
	const env = liveEnv({ PI_EGRESS: "1", PI_BACKENDS: "podman" });
	const leftover = "pi-dispatch-egress-doctor-4242";
	const sweep = {
		[`podman network ls --filter name=${EGRESS_CANARY_NET_PREFIX} --format {{.Name}}`]: { code: 0, output: `${leftover}\npi-dispatch-egress-doctor-4242-extra\n` },
		// Podman's member read (issue #452): every member with its state, as 4.9.3 and 5.8.1 both render it.
		[`podman ps -a --filter network=${leftover} --format {{.Names}}\t{{.State}}`]: { code: 0, output: "pi-dispatch-egress-probe-unlisted-4242\trunning\npi-dispatch-egress-proxy\trunning\n" },
		[`podman network exists ${leftover}`]: { code: 0, output: "" },
		[`${PODMAN_PROBE}provider`]: 0,
		[`${PODMAN_PROBE}unlisted`]: 3,
	};
	const calls = [];
	const checks = await podmanLiveChecks(env, podmanEgressSeams(sweep, calls), podmanEgressFacts({ proxyRunning: false }));
	const touched = calls.filter((c) => c.args.some((a) => String(a).includes("4242"))).map((c) => [c.cmd, ...c.args].join(" "));
	assert.deepEqual(touched, [
		`podman ps -a --filter network=${leftover} --format {{.Names}}\t{{.State}}`,
		`podman network exists ${leftover}`,
		// `--time=0` (review F1): podman's `rm -f` otherwise waits the probe's 10 s stop timeout, the step bound itself.
		"podman rm -f --time=0 pi-dispatch-egress-probe-unlisted-4242",
		`podman network disconnect -f ${leftover} pi-dispatch-egress-proxy`,
		`podman network rm ${leftover}`,
	], "the name filter is unchanged and anchored, and the proxy is detached, never removed");
	const line = checks.find((c) => c.canary);
	assert.equal(line.label, `podman: Egress canary: removed ${leftover} (after removing pi-dispatch-egress-probe-unlisted-4242 and detaching pi-dispatch-egress-proxy), left by an EARLIER doctor run`);
	assert.equal(line.label, `podman: Egress canary: ${CANARY_LINES[line.canary.shape].label(line.canary.params)}`, "built from the table, with podman's CLI in its params");
	// The table's command-carrying lines name podman on this venue, and their fixes too.
	const unlisted = await podmanLiveChecks(env, podmanEgressSeams({ [`podman network ls --filter name=${EGRESS_CANARY_NET_PREFIX}`]: { code: 125, output: "" } }), podmanEgressFacts({ proxyRunning: false }));
	assert.ok(unlisted.some((c) => c.warn && c.label === `podman: Egress canary: leftovers from an EARLIER doctor run could not be listed: podman network ls --filter name=${EGRESS_CANARY_NET_PREFIX}`), unlisted.map((c) => c.label).join("\n"));
	const kept = await podmanLiveChecks(env, podmanEgressSeams({ ...sweep, "podman rm -f --time=0 pi-dispatch-egress-probe-unlisted-4242": 1 }), podmanEgressFacts({ proxyRunning: false }));
	const keptLine = kept.find((c) => c.canary?.shape === "kept");
	assert.equal(keptLine.label, `podman: Egress canary: ${leftover} is kept, because the probe pi-dispatch-egress-probe-unlisted-4242 could not be removed and the network is the only way left to find it: podman rm -f pi-dispatch-egress-probe-unlisted-4242`);
	const unproved = await podmanLiveChecks(env, podmanEgressSeams({ "podman network create": 1 }), podmanEgressFacts());
	assert.match(unproved.find((c) => /could not be created/.test(c.label)).fix, /`podman network ls --filter name=pi-dispatch-egress-doctor-`/);
	assert.doesNotMatch(unproved.find((c) => /could not be created/.test(c.label)).fix, /\bdocker\b/);
});

// --- issue #452: the canary sweep on Podman 4.9, which renders no `.Containers` --------------------------------------

/** A Podman answering the canary sweep: `network ls`, the member `ps -a` rows per network, `network exists`, removals. */
function podmanCanaryDaemon({ nets = {}, exists = () => 0, rm = () => 0, version = "5.8.1", keeper = { code: 125, stdout: "", stderr: "no such container" } } = {}) {
	const calls = [];
	const run = async (args) => {
		calls.push(args.join(" "));
		if (args[0] === "network" && args[1] === "ls") return { code: 0, stdout: Object.keys(nets).join("\n"), stderr: "" };
		if (args[0] === "ps") {
			const net = args[args.indexOf("--filter") + 1].slice("network=".length);
			return { code: 0, stdout: (nets[net] ?? []).map(([n, st]) => `${n}\t${st}`).join("\n"), stderr: "" };
		}
		if (args[0] === "network" && args[1] === "exists") return { code: exists(args.at(-1)), stdout: "", stderr: "" };
		if (args[0] === "rm") return { code: rm(args.at(-1)), stdout: "", stderr: "" };
		if (args[0] === "network" && (args[1] === "disconnect" || args[1] === "rm")) return { code: 0, stdout: "", stderr: "" };
		// The detach gate's one runtime read (issue #452, gate round 3): Podman 5.8.1 unless a test says otherwise.
		if (args[0] === "info") return { code: 0, stdout: JSON.stringify({ host: { security: { rootless: true } }, version: { Version: version } }), stderr: "" };
		if (args[0] === "inspect") return keeper;
		return { code: 99, stdout: "", stderr: "unmodelled" };
	};
	return { run, calls };
}

test("on podman the canary sweep removes a dead run's probes in EVERY state and detaches the rest, stopped ones included (#452)", async () => {
	// The measured leftover (a `kill -9` mid-canary on Podman 4.9.3): the proxy running on the network, a running probe,
	// and here a stopped one as well. Podman's `network rm` refuses while any of them remains (4.9.3 and 5.8.1), so a
	// stopped probe the sweep could not see would keep the network and print `notRemoved` on every run.
	const net = "pi-dispatch-egress-doctor-4242";
	const d = podmanCanaryDaemon({ nets: { [net]: [["pi-dispatch-egress-proxy", "running"], ["pi-dispatch-egress-probe-provider-4242", "running"], ["pi-dispatch-egress-probe-unlisted-4242", "exited"], ["someone-else", "created"]] } });
	const checks = await sweepStaleCanaryNetworks({ run: d.run, pid: 1, isAlive: () => false, endpoint: { local: true }, bin: "podman" });
	assert.deepEqual(d.calls, [
		"network ls --filter name=pi-dispatch-egress-doctor- --format {{.Name}}",
		`ps -a --filter network=${net} --format {{.Names}}\t{{.State}}`,
		`network exists ${net}`,
		"rm -f --time=0 pi-dispatch-egress-probe-provider-4242",
		"rm -f --time=0 pi-dispatch-egress-probe-unlisted-4242",
		// The detach gate's one runtime read (issue #452, gate round 3): 5.8.1, so no keeper read.
		"info --format json",
		`network disconnect -f ${net} pi-dispatch-egress-proxy`,
		`network disconnect -f ${net} someone-else`,
		`network rm ${net}`,
	], "the probes are removed by name, the proxy and the stranger only detached, and the network removed without -f");
	// On 4.9.3 with no keeper holding, the probes still go (removing one is not the trigger) but nothing is DETACHED, and
	// the network is kept with a `held` line, the table's own words (issue #452, gate round 3).
	const old = podmanCanaryDaemon({ version: "4.9.3", nets: { [net]: [["pi-dispatch-egress-proxy", "running"], ["pi-dispatch-egress-probe-provider-4242", "running"]] } });
	const held = await sweepStaleCanaryNetworks({ run: old.run, pid: 1, isAlive: () => false, endpoint: { local: true }, bin: "podman" });
	assert.ok(!old.calls.some((c) => c.startsWith("network disconnect") || c.startsWith("network rm")), old.calls.join(" | "));
	assert.deepEqual(held.map((c) => c.canary?.shape), ["held"]);
	assert.equal(held[0].label, `podman: Egress canary: ${CANARY_LINES.held.label(held[0].canary.params)}`);
	assert.match(held[0].label, /is kept with what is running on it, because the rootless network keeper pi-dispatch-netns-keeper does not hold under the rootless Podman 4\.x this shell's podman CLI reaches/);
	assert.deepEqual(checks.map((c) => c.label), [`podman: Egress canary: removed ${net} (after removing pi-dispatch-egress-probe-provider-4242, pi-dispatch-egress-probe-unlisted-4242 and detaching pi-dispatch-egress-proxy, someone-else), left by an EARLIER doctor run`]);
	assert.equal(checks[0].label, `podman: Egress canary: ${CANARY_LINES[checks[0].canary.shape].label(checks[0].canary.params)}`);
	// `venue` still wins where doctor passes it, and `bin` alone gives the same words.
	const again = podmanCanaryDaemon({ nets: { [net]: [] } });
	const viaBin = await sweepStaleCanaryNetworks({ run: again.run, pid: 1, isAlive: () => false, endpoint: { local: true }, bin: "podman" });
	assert.deepEqual(viaBin.map((c) => c.label), [`podman: Egress canary: removed ${net}, left by an EARLIER doctor run`], "an EMPTY leftover is removed too");
});

test("on podman the canary sweep says `unreadable` only when Podman cannot answer, and is silent on a network already gone (#452)", async () => {
	const net = "pi-dispatch-egress-doctor-4242";
	// Gone between the listing and the read: `network exists` exit 1, the one silence.
	const gone = podmanCanaryDaemon({ nets: { [net]: [] }, exists: () => 1 });
	assert.deepEqual(await sweepStaleCanaryNetworks({ run: gone.run, pid: 1, isAlive: () => false, endpoint: { local: true }, bin: "podman" }), []);
	// 125 from `network exists`, or a `ps` row this parser was not measured against: unreadable, and nothing touched.
	for (const d of [podmanCanaryDaemon({ nets: { [net]: [] }, exists: () => 125 }), podmanCanaryDaemon({ nets: { [net]: [["pi-dispatch-egress-proxy", ""]] } })]) {
		const checks = await sweepStaleCanaryNetworks({ run: d.run, pid: 1, isAlive: () => false, endpoint: { local: true }, bin: "podman" });
		// The read that failed, which on Podman is the member `ps`, not an inspect that renders no members on 4.9.
		assert.deepEqual(checks.map((c) => c.label), [`podman: Egress canary: the network ${net} could not be read: podman ps -a --filter network=${net}`]);
		assert.equal(checks[0].label, `podman: Egress canary: ${CANARY_LINES.unreadable.label(checks[0].canary.params)}`);
		assert.ok(!d.calls.some((c) => c.startsWith("rm ") || c.startsWith("network disconnect") || c.startsWith("network rm")), d.calls.join(" | "));
	}
	// A stopped probe that will not go keeps the network, named, exactly as a running one does.
	const stuck = podmanCanaryDaemon({ nets: { [net]: [["pi-dispatch-egress-probe-unlisted-4242", "created"]] }, rm: () => 125 });
	const kept = await sweepStaleCanaryNetworks({ run: stuck.run, pid: 1, isAlive: () => false, endpoint: { local: true }, bin: "podman" });
	assert.deepEqual(kept.map((c) => c.canary.shape), ["kept"]);
	assert.ok(!stuck.calls.some((c) => c.startsWith("network rm")));
});

test("doctor --live on a podman-only deployment with egress armed: the canary's lines, then the read-back, and no docker (#431)", async () => {
	const env = liveEnv({ PI_EGRESS: "1", PI_BACKENDS: "podman" });
	const { out, text } = capture();
	const calls = [];
	const plan = { [`${PODMAN_PROBE}provider`]: 0, [`${PODMAN_PROBE}unlisted`]: 3, ...toPodman(liveOk({ uid: "1234" })), ...toPodman(livePeersOk({})), "podman network": 0, ...podmanPlan() };
	const code = await runDoctor(env, { ...podmanDeps(out, plan, calls), live: true, liveFs: liveFsAs(1234), isAlive: () => false, pid: 7, nonce: "n", ...instantClock() });
	assert.equal(code, 0, text());
	assert.deepEqual(calls.filter((c) => c.cmd === "docker"), []);
	assert.doesNotMatch(text(), /allowlist is read back by `pi-dispatch doctor --live`/, "a --live run does not point at itself");
	assert.match(text(), /\nread back on podman: starting pi-dispatch-egress-probe-provider-7 and pi-dispatch-egress-probe-unlisted-7 from pi-job:latest \(as the job user 1234:1234\) on the --internal network pi-dispatch-egress-doctor-7, with pi-dispatch-egress-proxy attached/);
	assert.match(text(), /✓ podman: Egress policy reaches the provider[^\n]*\n✓ podman: Egress policy denies an unlisted host[^\n]*\n/);
	assert.ok(text().indexOf("✓ podman: Egress policy denies an unlisted host") < text().indexOf("✓ read back on podman: egress holds"));
	assert.equal(calls.filter((c) => c.cmd === "podman" && c.args[0] === "info").length, 3, "the section's read, the canary's re-ask, and the read-back's");
});

// Issue #458: on Podman 4.x (or an unreported version) with the keeper not running, every network teardown under the
// proxy is the trigger, and `--live` makes three kinds of them: the canary's network, the stale sweeps' detaches, and
// the jobToJobIsolation peers' networks. None may run there; each property says why it was not read back. With the
// keeper running, or on 5.x, the same run reads everything back as before.
test("doctor --live on Podman 4.x without the keeper runs no canary and no peer networks, and says why (#458)", async () => {
	const env = liveEnv({ PI_EGRESS: "1", PI_BACKENDS: "podman" });
	// `stale`: a peer network a dead run (pid 99) left with the proxy still on it, for the live sweep to meet.
	const STALE = "pi-dispatch-live-peer1-99-abc-net";
	const staleKeys = {
		[`podman network ls --filter name=${LIVE_PREFIX}`]: { code: 0, output: `${STALE}\n` },
		// Podman's member read since #452 (4.9 renders no `.Containers`): the proxy as a running member, and the network there.
		[`podman ps -a --filter network=${STALE} --format {{.Names}}\t{{.State}}`]: { code: 0, output: "pi-dispatch-egress-proxy\trunning\n" },
		[`podman network exists ${STALE}`]: { code: 0, output: "" },
	};
	const run = async ({ version, keeper, stale = false }) => {
		const { out, text } = capture();
		const calls = [];
		const info = JSON.stringify({ ...JSON.parse(PODMAN_INFO()), version: { Version: version } });
		const plan = { ...(stale ? staleKeys : {}), [`${PODMAN_PROBE}provider`]: 0, [`${PODMAN_PROBE}unlisted`]: 3, ...toPodman(liveOk({ uid: "1234" })), ...toPodman(livePeersOk({})), "podman network": 0, ...podmanPlan({ info, keeper }) };
		const code = await runDoctor(env, { ...podmanDeps(out, plan, calls), live: true, liveFs: liveFsAs(1234), isAlive: () => false, pid: 7, nonce: "n", ...instantClock() });
		const lines = calls.map((c) => [c.cmd, ...c.args].join(" "));
		return { code, text: text(), lines };
	};
	const touchesProxyNetworks = (lines) => lines.filter((l) => /pi-dispatch-egress-(doctor|probe)-|pi-dispatch-live-peer|network (connect|disconnect)/.test(l));
	for (const version of ["4.9.3", ""]) {
		const blocked = await run({ version, keeper: null });
		assert.equal(blocked.code, 1, `${version || "unreported"}: fails`);
		assert.deepEqual(touchesProxyNetworks(blocked.lines), [], `${version || "unreported"}: no canary, no sweep listing of canary networks, no peer network, no connect or disconnect`);
		assert.match(blocked.text, /✗ podman: Egress policy: not proved, and no egress canary was run \(nor a stale canary network swept\), because the rootless network keeper pi-dispatch-netns-keeper is not under this account's Podman on Podman [^\n]*, where tearing down a network the proxy is on would cut the proxy's route out \(issue #458\)\n {4}→ start it as the worker's account where its Quadlet unit is installed: systemctl --user reset-failed /);
		assert.match(blocked.text, /⚠ read back on podman: egress not read back: the egress canary was not run, because the rootless network keeper pi-dispatch-netns-keeper is not under this account's Podman/);
		assert.match(blocked.text, /⚠ read back on podman: jobToJobIsolation not read back: no peer networks were built, because the rootless network keeper pi-dispatch-netns-keeper is not under this account's Podman/);
		assert.doesNotMatch(blocked.text, /read back on podman: starting [^\n]*peer1/, "the announcement names no peers");
		assert.match(blocked.text, /✓ read back on podman: isolation holds/, "what does not touch the proxy is still read back");
	}
	for (const [version, keeper] of [["4.9.3", "running"], ["5.8.1", null], ["5.8.1", "exited"]]) {
		const held = await run({ version, keeper });
		assert.equal(held.code, 0, `${version} keeper ${keeper}: ${held.text}`);
		const touched = touchesProxyNetworks(held.lines);
		assert.ok(touched.some((l) => l.startsWith("podman network create --internal pi-dispatch-egress-doctor-7")), `${version} keeper ${keeper}: the canary ran`);
		assert.ok(touched.some((l) => l.startsWith("podman network disconnect -f pi-dispatch-live-peer1-7-n-net")), `${version} keeper ${keeper}: the peers ran`);
		assert.match(held.text, /✓ read back on podman: egress holds/);
		assert.match(held.text, /✓ read back on podman: jobToJobIsolation holds/);
	}
	// Issue #463's gate: a keeper RUNNING off its bridge network blocks exactly like a missing one.
	const offBridge = await run({ version: "4.9.3", keeper: "running|none|none," });
	assert.equal(offBridge.code, 1);
	assert.deepEqual(touchesProxyNetworks(offBridge.lines), [], "a keeper on --network none holds nothing: no canary, no peers");
	assert.match(offBridge.text, /no egress canary was run [^\n]*because the rootless network keeper pi-dispatch-netns-keeper is running on the none network mode/);
	// The live sweep's side, end to end: a dead run's peer network with the proxy on it is LEFT, and said, while blocked
	// (its detach is the trigger); swept, proxy detached, once the keeper holds.
	const staleBlocked = await run({ version: "4.9.3", keeper: null, stale: true });
	assert.deepEqual(staleBlocked.lines.filter((l) => / network (connect|disconnect|rm|create) /.test(` ${l.replace(/^podman /, "")} `) || /^podman network (connect|disconnect|rm|create)/.test(l)), [], "nothing connected, detached, removed or created");
	assert.match(staleBlocked.text, new RegExp(`the stale network ${STALE} was left with pi-dispatch-egress-proxy attached, because the rootless network keeper pi-dispatch-netns-keeper is not under this account's Podman`));
	const staleHeld = await run({ version: "4.9.3", keeper: "running", stale: true });
	assert.ok(staleHeld.lines.includes(`podman network disconnect -f ${STALE} pi-dispatch-egress-proxy`), staleHeld.lines.join("\n"));
	assert.ok(staleHeld.lines.includes(`podman network rm ${STALE}`));
	assert.doesNotMatch(staleHeld.text, /was left with/);
});

test("a podman canary probe gets the first-start bound, and one the bound cut short is removed without podman's stop wait (#431)", async (t) => {
	// The probe's bound is PODMAN_FIRST_START_TIMEOUT_MS, pinned as a NUMBER: a cold keep-id first start measured 27 to
	// 32 s (29.4 s on the review VM), so docker's 30 s would read a healthy first run as a probe that did not run.
	t.mock.timers.enable({ apis: ["setTimeout"] });
	const env = liveEnv({ PI_EGRESS: "1", PI_BACKENDS: "podman" });
	const calls = [];
	const pending = podmanLiveChecks(env, podmanEgressSeams({ [`${PODMAN_PROBE}provider`]: "hang", [`${PODMAN_PROBE}unlisted`]: 3 }, calls), podmanEgressFacts());
	const probe = () => calls.find((c) => c.args[1] === "--name=pi-dispatch-egress-probe-provider-1");
	for (let i = 0; i < 200 && !probe(); i++) await new Promise((r) => setImmediate(r));
	assert.ok(probe(), "the provider probe started");
	t.mock.timers.tick(119_999);
	assert.deepEqual(probe().kills, [], "no kill short of 120 s");
	t.mock.timers.tick(1);
	assert.deepEqual(probe().kills, ["SIGKILL"], "at 120 s exactly, by the step runner's SIGKILL");
	const checks = await pending;
	assert.ok(checks.some((c) => c.label === "podman: Egress policy probe for the provider did not run (podman run did not finish)"), checks.map((c) => c.label).join("\n"));
	// The teardown removes the probe the bound left behind, with podman's stop wait turned off (review F1), then the network.
	const teardown = calls.filter((c) => (c.args[0] === "rm" && c.args.includes("pi-dispatch-egress-probe-provider-1")) || (c.args[0] === "network" && c.args[1] === "rm" && c.args[2] === "pi-dispatch-egress-doctor-1"));
	assert.deepEqual(teardown.map((c) => [c.cmd, ...c.args].join(" ")), ["podman rm -f --time=0 pi-dispatch-egress-probe-provider-1", "podman network rm pi-dispatch-egress-doctor-1"]);
});

test("the podman canary runs PI_JOB_IMAGE, whatever it names (#431)", async () => {
	const env = liveEnv({ PI_EGRESS: "1", PI_BACKENDS: "podman", PI_JOB_IMAGE: "registry.example.invalid/team/pi-job:7" });
	const calls = [];
	await podmanLiveChecks(env, podmanEgressSeams({ [`${PODMAN_PROBE}provider`]: 0, [`${PODMAN_PROBE}unlisted`]: 3 }, calls), { ...podmanEgressFacts(), jobImage: "registry.example.invalid/team/pi-job:7" });
	const probes = calls.filter((c) => String(c.args[1]).startsWith("--name=pi-dispatch-egress-probe-"));
	assert.equal(probes.length, 2);
	for (const p of probes) {
		assert.equal(p.args.at(-3), "registry.example.invalid/team/pi-job:7", p.args.join(" "));
		assert.equal(p.args.includes("pi-job:latest"), false);
	}
});

test("the podman canary's argv cannot be built weaker than a job's: no job user, no argv (#431)", () => {
	assert.throws(() => egressCanaryProbeArgs({ bin: "podman", slug: "provider", pid: 1, network: "n", proxy: "p", image: "i", url: "https://example.com/", user: null }), /refusing a keep-id spec with no job user/);
	const args = egressCanaryProbeArgs({ bin: "podman", slug: "provider", pid: 1, network: "n", proxy: "p", image: "i", url: "https://example.com/", user: "1:1" });
	assert.equal(args.includes("-v"), false, "the canary mounts nothing: a mount only adds reach");
	assert.equal(args.some((a) => a.includes("pi-dispatch-egress-canary-mounts-nothing")), false);
});

test("the podman bounds line is said only when the controllers are delegated (#354)", async () => {
	const { out, text } = capture();
	await runDoctor(podmanEnv(), podmanDeps(out, podmanPlan(), [], { observationFs: podmanFsWith("cpu memory\n") }));
	assert.doesNotMatch(text(), /podman: cgroup v2 controllers are delegated/);
	assert.match(text(), /⚠ podman: isolation is ASSERTED by this account's Podman setup, not enforced: the pids cgroup controller is not delegated to this account's systemd user manager \(user@1234\.service\)/);
});

test("an account with no systemd user manager running, or one Podman cannot reach: doctor names the cause once, as --live's isolation failure does (#453)", async () => {
	// Measured (round-446 M0-e E1, gate 456 L1-L3): linger off and a `sudo -iu` shell, or a manager Podman reaches no bus
	// to, podman info still listing every controller.
	const noManager = { observationFs: podmanFsWith(null) };
	const EVIDENCE = "no systemd user manager is running for this account (/sys/fs/cgroup/user.slice/user-1234.slice/user@1234.service/cgroup.controllers does not exist), so Podman leaves a job's pids, memory and cpu bounds unapplied, whichever cgroup manager it uses: with linger off the manager runs only while the account has a login session, and a `sudo -iu` shell starts none (measured). On a host without systemd managing cgroups under user.slice this path never exists, and the venue gives no credit there";
	const FIX = "    → turn on linger for the worker's account: `sudo loginctl enable-linger <account>` starts its systemd user manager and keeps it running with no one logged in, and `pi-dispatch service install` runs the worker as a systemd user service inside it. A hand-written system unit with `User=` also needs `Wants=user@<uid>.service` and `After=user@<uid>.service` (docs/podman.md); `pi-dispatch doctor --live` reads pids.max and memory.max back off a real container\n";
	const ISOLATION = `⚠ podman: isolation is ASSERTED by this account's Podman setup, not enforced: ${EVIDENCE}\n${FIX}`;
	// No floor: jobs still run, so one ⚠, the backend section's, carrying the cause and its fix; podman info's controller
	// list no longer earns the ✓ line, and the podman section does not repeat the ⚠.
	const plain = capture();
	assert.equal(await runDoctor(podmanEnv(), podmanDeps(plain.out, podmanPlan(), [], noManager)), 0);
	assert.ok(plain.text().includes(ISOLATION), plain.text());
	assert.equal(plain.text().match(/no systemd user manager is running/g).length, 1, "said once");
	assert.doesNotMatch(plain.text(), /podman: cgroup v2 controllers are delegated/);
	// A floor that needs the bounds: the same one line, and the floor line is the ✗ that fails doctor, saying the worker
	// refuses to boot on this answer.
	const floored = capture();
	assert.equal(await runDoctor(podmanEnv({ PI_BACKEND_FLOOR: "isolation=enforced" }), podmanDeps(floored.out, podmanPlan(), [], noManager)), 1);
	assert.ok(floored.text().includes(ISOLATION), floored.text());
	assert.equal(floored.text().match(/no systemd user manager is running/g).length, 1, "said once");
	assert.match(floored.text(), /✗ PI_BACKEND_FLOOR asks for isolation=enforced \(podman provides it only while this worker's rootless Podman runs on cgroup v2 with a systemd user manager running for its account, the pids, memory and cpu controllers delegated to that manager, and Podman putting containers under it, and no containers\.conf it reads sets `cgroups`, and that is not observed\)\n {4}→ Turn on linger for the worker account[^\n]* The worker refuses to boot, and refuses each job, on the same answer\.\n/);
	// A manager Podman cannot reach (gate L1: no user bus, so podman info reports cgroupfs) from a shell outside it: its
	// own cause, and its own fix, which leads with running inside the manager.
	const unreachable = capture();
	await runDoctor(podmanEnv(), podmanDeps(unreachable.out, podmanPlan({ info: PODMAN_INFO({ cgroupManager: "cgroupfs" }) }), [], { observationFs: podmanFsWith("cpuset cpu io memory pids\n", "0::/user.slice/user-501.slice/session-5.scope\n") }));
	assert.ok(unreachable.text().includes("⚠ podman: isolation is ASSERTED by this account's Podman setup, not enforced: Podman is using the cgroupfs cgroup manager, not systemd, and this worker is not running inside the account's user manager (user@1234.service), so whether a job's pids, memory and cpu bounds are applied is not observed from here. Measured: where a configured systemd manager fell back to cgroupfs because Podman could not reach the user manager over D-Bus (no user bus socket, a DBUS_SESSION_BUS_ADDRESS pointing nowhere), the container landed in the worker's own cgroup unbounded; an explicit cgroupfs with the bus reachable had its bounds applied, and nothing read here tells the two apart\n    → run the worker inside the account's user manager, as a systemd user service (`pi-dispatch service install`, with linger on), where a job's container lands under the manager whichever cgroup manager Podman uses; or let Podman reach the manager over the account's user bus, /run/user/<uid>/bus (on Debian and Ubuntu the dbus-user-session package provides it), with no DBUS_SESSION_BUS_ADDRESS pointing elsewhere and no `cgroup_manager = \"cgroupfs\"` in its containers.conf; `pi-dispatch doctor --live` reads pids.max and memory.max back off a real container\n"), unreachable.text());
	// The same cgroupfs from inside the manager (measured E3a, E3b) is credited.
	const inside = capture();
	await runDoctor(podmanEnv(), podmanDeps(inside.out, podmanPlan({ info: PODMAN_INFO({ cgroupManager: "cgroupfs" }) }), [], { observationFs: podmanFsWith("cpuset cpu io memory pids\n", "0::/user.slice/user-1234.slice/user@1234.service/app.slice/pi-dispatch-worker.service\n") }));
	assert.match(inside.text(), /✓ podman: cgroup v2 controllers are delegated to this account/);
	// Another cause keeps OBSERVATION_FIX: the cause fixes are tied to their causes, not to the observation.
	const undelegated = capture();
	await runDoctor(podmanEnv(), podmanDeps(undelegated.out, podmanPlan(), [], { observationFs: podmanFsWith("cpu memory\n") }));
	assert.match(undelegated.text(), /⚠ podman: isolation is ASSERTED by this account's Podman setup, not enforced: the pids cgroup controller is not delegated to this account's systemd user manager \(user@1234\.service\), so a job cannot have that bound: measured for cpu, Podman 5\.8\.1 refuses to start a container carrying --cpus \(exit 126, "controller `cpu` is not available"\)\n {4}→ Turn on linger for the worker account/);
	// A running manager with the controllers: the ✓ line, listing the MANAGER's controllers, whatever podman info's
	// caller-cgroup list says (measured E2a: `memory pids` inside a user unit, cpu applied anyway).
	const session = capture();
	await runDoctor(podmanEnv(), podmanDeps(session.out, podmanPlan({ info: PODMAN_INFO({ cgroupControllers: ["memory", "pids"] }) }), []));
	assert.doesNotMatch(session.text(), /user manager/);
	assert.match(session.text(), /✓ podman: cgroup v2 controllers are delegated to this account \(cpuset, cpu, io, memory, pids\), so a job's pid, memory and cpu bounds are applied\n/);
	// --live: pids.max and memory.max read back `max` (measured E1), and the failure's fix names the cause, not docker's
	// delegation, opening its own sentence with a capital.
	const live = capture();
	const unbounded = LIVE_STATUS("1234").replace("pids.max:512", "pids.max:max").replace("memory.max:4294967296", "memory.max:max");
	const plan = { ...podmanLiveOk(), [`podman exec ${LIVE_ID} sh -c cat /proc/1/status`]: { code: 0, output: unbounded }, ...podmanPlan() };
	assert.equal(await runDoctor(liveEnv({ PI_BACKENDS: "podman" }), { ...podmanDeps(live.out, plan, [], noManager), live: true, liveFs: liveFsAs(1234), isAlive: () => false, pid: 7, nonce: "n", ...instantClock() }), 1);
	assert.match(live.text(), /✗ read back on podman: isolation does NOT hold -- declared enforced, observed: [^\n]*\n {4}→ the runtime did not apply a bound the worker passes: on rootless Podman that is the account's systemd user manager not running, Podman not reaching it, or a controller not delegated to it \(the "isolation is ASSERTED" line above names which, when the static read sees it\) -- jobs on this host do not have the boundary the table declares\. Turn on linger for the worker's account: `sudo loginctl enable-linger <account>`/);
	assert.doesNotMatch(live.text(), /on rootless podman, cgroup delegation/, "not docker's words with the name swapped");
});

test("with linger off, doctor's ✓ for the bounds says it lasts only as long as a login session does (#453 gate)", async () => {
	// Measured (gate 456, extra-login-session-sudo-doctor.txt): linger off, another login session of the account open, a
	// `sudo -iu` doctor saw the manager running and gave ✓; the manager stops with the last session.
	const run = async (linger) => {
		const { out, text } = capture();
		const calls = [];
		const plan = { ...podmanPlan(), ...(linger === null ? {} : { "loginctl show-user op -p Linger": { code: 0, output: `Linger=${linger}\n` } }) };
		await runDoctor(podmanEnv(), podmanDeps(out, plan, calls, { userName: () => "op" }));
		return { text: text(), calls };
	};
	const off = await run("no");
	assert.match(off.text, /✓ podman: cgroup v2 controllers are delegated to this account \(cpuset, cpu, io, memory, pids\), so a job's pid, memory and cpu bounds are applied\n⚠ podman: linger is off for op, so the user manager above runs only while a login session of the account is open: when the last one ends, a worker run as a user service stops with it, and one run as a system unit with User= runs on with no bounds \(refused per job under an isolation floor\)\n {4}→ sudo loginctl enable-linger op -- it keeps the manager running with no one logged in, which is what a service needs\n/);
	assert.ok(off.calls.some((c) => c.cmd === "loginctl" && c.args.join(" ") === "show-user op -p Linger"), "asked as up asks it");
	assert.doesNotMatch((await run("yes")).text, /linger is off/);
	assert.doesNotMatch((await run(null)).text, /linger is off/, "an unanswered loginctl says nothing");
});

test("the ladder's doctor step judges the service's .env: the provider key's presence (never its value) and VALKEY_URL, with the source said (#453 gate 2)", async () => {
	// The exec's ladder-4.txt: step 2 put the key and the Valkey URL in .env, and doctor's shell has neither.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "PI_BACKENDS=podman\nPI_EGRESS=0\nANTHROPIC_API_KEY=sk-ant-never-printed\nVALKEY_URL=redis://worker:hunter2@127.0.0.1:16456/1\n");
	const probed = [];
	const { out, text } = capture();
	const { PI_BACKENDS: _b, PI_EGRESS: _e, ANTHROPIC_API_KEY: _k, ...shell } = podmanEnv();
	await runDoctor(shell, { ...podmanDeps(out, podmanPlan(), []), cwd, platform: "linux", probeValkey: async (url) => (probed.push(url), true), readEnvFile: (path) => readFileSync(path, "utf8") });
	const envPath = join(cwd, ".env").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
	assert.match(text(), new RegExp(`✓ Provider key set \\(anthropic: ANTHROPIC_API_KEY\\) -- ANTHROPIC_API_KEY read from ${envPath}, as the service reads it; this shell does not set it\\n`));
	assert.match(text(), new RegExp(`✓ Valkey reachable \\(redis://127\\.0\\.0\\.1:16456/1\\) -- VALKEY_URL read from ${envPath}, as the service reads it; this shell does not set it\\n`));
	assert.deepEqual(probed, ["redis://worker:hunter2@127.0.0.1:16456/1"], "the service's URL is the one probed");
	for (const secret of ["sk-ant-never-printed", "hunter2"]) assert.ok(!text().includes(secret), `${secret} must never be printed`);
	// This shell's own values win, and then nothing is said about the file.
	const own = capture();
	await runDoctor({ ...shell, ANTHROPIC_API_KEY: "sk-shell", VALKEY_URL: "redis://127.0.0.1:6379" }, { ...podmanDeps(own.out, podmanPlan(), []), cwd, platform: "linux", probeValkey: async () => true, readEnvFile: (path) => readFileSync(path, "utf8") });
	assert.match(own.text(), /✓ Provider key set \(anthropic: ANTHROPIC_API_KEY\)\n/);
	assert.match(own.text(), /✓ Valkey reachable \(redis:\/\/127\.0\.0\.1:6379\)\n/);
});

test("doctor: a PAUSED shipped proxy's fix is docker unpause, as up offers; a RUNNING stale one gets no ✓ line, and the canary through it blames the proxy, not the allowlist (#453 exec round 3)", async () => {
	const paused = capture();
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(paused.out, egressPlan({ [PROXY_KEY]: proxyAnswer("none", "paused"), "gh auth status": { code: 0, output: ghStatusOutput } })));
	assert.match(paused.text(), /✗ Egress proxy is paused \(pi-dispatch-egress-proxy\)\n {4}→ docker unpause pi-dispatch-egress-proxy {2}-- as `pi-dispatch up` offers;/);
	// A running proxy made from another image, the canary's provider probe failing through it (case6-docker-stale-imagerun.txt).
	const stale = capture();
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(stale.out, egressPlan({ [PROXY_KEY]: proxyAnswer("none", "running", { image: "docker.io/library/alpine:3.20", entrypoint: [], cmd: ["sleep", "100000"] }), "docker run --rm --name pi-dispatch-egress-probe-provider": 3, "gh auth status": { code: 0, output: ghStatusOutput } })));
	assert.doesNotMatch(stale.text(), /✓ Egress proxy running/, "never healthy right before the ✗");
	assert.match(stale.text(), /✗ Egress proxy is running but is not this deployment's \(pi-dispatch-egress-proxy\): it was created from docker\.io\/library\/alpine:3\.20/);
	assert.match(stale.text(), /⚠ Egress policy does NOT reach the provider \(api\.anthropic\.com\)\n {4}→ the canary ran through pi-dispatch-egress-proxy, which is not this deployment's proxy \(above\), so this says nothing about egress-allowlist\.conf: `pi-dispatch up` from the deployment folder offers to replace it/);
	assert.doesNotMatch(stale.text(), /add api\.anthropic\.com to egress-allowlist\.conf/);
	// A current proxy keeps its ✓ and the allowlist fix.
	const current = capture();
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(current.out, egressPlan({ [PROXY_KEY]: proxyAnswer("none", "running"), "docker run --rm --name pi-dispatch-egress-probe-provider": 3, "gh auth status": { code: 0, output: ghStatusOutput } })));
	assert.match(current.text(), /✓ Egress proxy running \(pi-dispatch-egress-proxy\)/);
	assert.match(current.text(), /add api\.anthropic\.com to egress-allowlist\.conf/);
});

test("doctor: a STOPPED shipped proxy that is not this deployment's gets up's replace offer as its fix, never compose (#453 gate 2)", async () => {
	const folder = tempDir("pi-proxy-stopped-");
	mkdirSync(join(folder, "deploy"));
	writeFileSync(join(folder, "deploy/egress-proxy.conf"), "http_port 3128\n");
	writeFileSync(join(folder, "egress-allowlist.conf"), "api.anthropic.com\n");
	const other = tempDir("pi-proxy-stopped-other-");
	writeFileSync(join(other, "egress-allowlist.conf"), "evil.example\n");
	const { out, text } = capture();
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), { ...ghDeps(out, egressPlan({ [PROXY_KEY]: proxyAnswer("none", "exited", { cwd: folder, allowlist: join(other, "egress-allowlist.conf") }), "gh auth status": { code: 0, output: ghStatusOutput } })), cwd: folder, proxyFilesExist: () => true });
	assert.match(text(), /✗ Egress proxy is stopped \(pi-dispatch-egress-proxy\)\n {4}→ it is not this deployment's either \(its \/etc\/pi-dispatch\/allowlist\.conf is [^)]*\): `pi-dispatch up` from the deployment folder offers to replace it with the shipped one \(docker rm -f pi-dispatch-egress-proxy, then the shipped run\) -- /);
	assert.doesNotMatch(text(), /✗ Egress proxy is stopped \(pi-dispatch-egress-proxy\)\n {4}→ docker compose/);
});

test("a URL doctor prints has its password blanked and its query dropped, or is not printed at all (#453 gate 3)", () => {
	assert.equal(urlShown("redis://:p@ss@host"), "redis://host", "the userinfo is never printed, whatever @ it holds");
	assert.equal(urlShown("redis://127.0.0.1:6379?password=secret"), "redis://127.0.0.1:6379");
	assert.equal(urlShown("redis://:p@ss@host:6380/2?password=secret&token=t"), "redis://host:6380/2");
	assert.equal(urlShown("redis://worker:hunter2@127.0.0.1:16456/1"), "redis://127.0.0.1:16456/1", "a username can be a token too");
	assert.equal(urlShown("redis:///2"), "<no host>");
	assert.equal(urlShown("redis://127.0.0.1:6379"), "redis://127.0.0.1:6379", "nothing to hide, printed as written");
	assert.equal(urlShown("not a url with pass:word@"), "<unparseable URL>");
});

test("doctor's .env reads pass ONE allowlist and ONE loader mapping (#453 gate 3)", async () => {
	// PR #466 gate round 2 added the GitHub auth source and App keys, and nothing else.
	assert.deepEqual([...SERVICE_ENV_KEYS], ["PI_BACKENDS", "PI_EGRESS", "PI_EGRESS_PROXY", "VALKEY_URL", "PI_PROVIDER", "GITHUB_AUTH_SOURCE", "GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY_PATH", "GITHUB_APP_PRIVATE_KEY"]);
	assert.deepEqual(serviceEnvKeys(["PI_JOB_IMAGE", "PI_ENV_SETUP", "VALKEY_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"], ["ANTHROPIC_API_KEY"]), ["VALKEY_URL", "ANTHROPIC_API_KEY"]);
	assert.deepEqual(["linux", "win32", "darwin", "freebsd"].map(serviceEnvLoader), ["systemd", "cmd", "shell", "shell"]);
	// The venue read uses that mapping too: on freebsd a sourcing shell reads `export PI_BACKENDS=podman` as an assignment.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "export PI_BACKENDS=podman\n");
	const { out, text } = capture();
	const { PI_BACKENDS: _b, ...shell } = podmanEnv();
	await runDoctor(shell, { ...podmanDeps(out, podmanPlan(), []), cwd, platform: "freebsd", readEnvFile: (path) => readFileSync(path, "utf8") });
	assert.match(text(), /✓ venue keys read from [^\n]* \(PI_BACKENDS="podman"\)/);
});

test("fleet host names and zones doctor prints from Valkey have their control bytes blanked (#453 gate 3)", async () => {
	const ESC = String.fromCharCode(27);
	const { out, text } = capture();
	await runDoctor(ghEnv({ PI_WORKER_NAME: "mini1" }), { ...ghDeps(out, green), readHosts: async () => ({ hosts: [{ name: "mini1" }, { name: `evil${ESC}[2Jhost`, tz: `Zone${ESC}]0;x` }] }) });
	assert.ok(!text().includes(ESC), "no escape byte reaches the terminal");
	assert.match(text(), /Fleet: 2 workers \(evil \[2Jhost, mini1\)/);
	// C1 controls too (U+0080 to U+009F: U+009B is a one-byte CSI to some terminals).
	const c1 = capture();
	await runDoctor(ghEnv({ PI_WORKER_NAME: "mini1" }), { ...ghDeps(c1.out, green), readHosts: async () => ({ hosts: [{ name: "mini1" }, { name: `evil${String.fromCharCode(0x9b)}2Jhost` }] }) });
	assert.ok(!c1.text().includes(String.fromCharCode(0x9b)));
	assert.match(c1.text(), /Fleet: 2 workers \(evil 2Jhost, mini1\)/);
});

test("doctor reads the venue keys from the deployment's .env as up does, says so, reads the file once, and refuses a disagreement (#453 gate)", async () => {
	// The exec's ladder step 4 (gate 456, case6-step4-doctor.txt): PI_BACKENDS=podman in .env, nothing in the shell, and
	// doctor judged docker.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "PI_BACKENDS=podman\nPI_EGRESS=0\n");
	const asked = [];
	const { out, text } = capture();
	const { PI_BACKENDS: _b, PI_EGRESS: _e, ...shell } = podmanEnv();
	await runDoctor(shell, { ...podmanDeps(out, podmanPlan(), []), cwd, platform: "linux", readEnvFile: (path) => (asked.push(path), readFileSync(path, "utf8")) });
	assert.match(text(), new RegExp(`✓ venue keys read from ${join(cwd, ".env").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} \\(PI_BACKENDS="podman", PI_EGRESS="0"\\), as the service reads them: this shell does not set them\\n`));
	assert.match(text(), /✓ Jobs run on: podman/);
	assert.doesNotMatch(text(), /Docker daemon reachable/);
	assert.deepEqual(asked, [join(cwd, ".env")], "one file, read once");
	// This shell set differently: ✗, and doctor judges the shell's values.
	const conflict = capture();
	assert.equal(await runDoctor({ ...shell, PI_BACKENDS: "local" }, { ...ghDeps(conflict.out, green), cwd, platform: "linux", readEnvFile: (path) => readFileSync(path, "utf8") }), 1);
	assert.match(conflict.text(), new RegExp(`✗ which venue this deployment runs is unknown: PI_BACKENDS is "local" in this shell and "podman" in ${join(cwd, ".env").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\. doctor would judge the shell's venue while the service runs the file's\\.`));
	// A .env that is there and cannot be read is said, as up says it (gate round 2); an absent one is not.
	const dirEnv = tempDir("pi-venue-dir-env-");
	mkdirSync(join(dirEnv, ".env"));
	const unread = capture();
	await runDoctor(shell, { ...podmanDeps(unread.out, podmanPlan(), []), cwd: dirEnv, fileExists: existsSync, platform: "linux" });
	assert.match(unread.text(), new RegExp(`⚠ ${join(dirEnv, ".env").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} could not be read \\(not a regular file\\), so PI_BACKENDS, PI_EGRESS and PI_EGRESS_PROXY come from this shell alone\n`));
	const absent = capture();
	await runDoctor(shell, { ...podmanDeps(absent.out, podmanPlan(), []), cwd: tempDir("pi-venue-no-env-"), fileExists: existsSync, platform: "linux" });
	assert.doesNotMatch(absent.text(), /come from this shell alone/);
	// A shell that agrees in meaning is no disagreement, and no source line is needed for keys the shell set.
	const agree = capture();
	await runDoctor({ ...shell, PI_BACKENDS: " podman", PI_EGRESS: "0" }, { ...podmanDeps(agree.out, podmanPlan(), []), cwd, platform: "linux", readEnvFile: (path) => readFileSync(path, "utf8") });
	assert.doesNotMatch(agree.text(), /which venue this deployment runs is unknown|venue keys read from/);
});



test("the pinning and ephemeral read-backs on podman name podman in what they could not read (#354)", async () => {
	const { out, text } = capture();
	const plan = { ...podmanLiveOk(), "podman run --name=pi-dispatch-live-pin-": { code: 125, output: "Error: something new\n" }, "podman ps -a --no-trunc --filter id=": { code: 125, output: "" }, ...podmanPlan() };
	await runDoctor(liveEnv({ PI_BACKENDS: "podman" }), { ...podmanDeps(out, plan, []), live: true, liveFs: liveFsAs(1234), isAlive: () => false, pid: 7, nonce: "n", ...instantClock() });
	assert.match(text(), /⚠ read back on podman: imagePinning not read back: podman refused the run with a message this check does not recognise/);
	assert.match(text(), /⚠ read back on podman: ephemeral not read back: podman ps did not answer while the first run was being waited on/);
});

// --- issue #431: docker's egress canary, pinned before it was parameterised on the venue -------------------------------

// A docker deployment with egress armed, run as `doctor --live`, in three shapes: the ordinary one (a DEAD doctor's
// leftover swept, both probes answering, the teardown clean, the read-back with its peers), a job image whose runner
// predates #427, and a provider probe the bound cut short. Captured from main at 26cef96, BEFORE the canary was
// parameterised on a venue runner: the text and every spawn (runtime and argv), with the only per-run values (the
// jobs directory and the fixture names under it) replaced. A docker canary that moved by one byte or one spawn lands here.
const dockerCanaryPinRun = async (scenario, t = null) => {
	const env = liveEnv({ PI_EGRESS: "1" });
	const cwd = tempDir("pi-canary-pin-cwd-");
	const leftover = "pi-dispatch-egress-doctor-4242";
	const plan = {
		[`docker network ls --filter name=${EGRESS_CANARY_NET_PREFIX}`]: { code: 0, output: `${leftover}\n` },
		[`docker network inspect --format {{json .Containers}} ${leftover}`]: { code: 0, output: JSON.stringify({ a: { Name: "pi-dispatch-egress-probe-unlisted-4242" }, b: { Name: "pi-dispatch-egress-proxy" } }) },
		...liveOk(),
		...livePeersOk({}),
		...green,
		"gh auth status": { code: 0, output: ghStatusOutput },
	};
	// Assigned, not spread: `green` already carries this key, and a spread keeps the FIRST key's place with the last value.
	if (scenario === "stale") plan["docker run --rm --name pi-dispatch-egress-probe-provider"] = EGRESS_CANARY_STALE_RUNNER;
	if (scenario === "unfinished") plan["docker run --rm --name pi-dispatch-egress-probe-provider"] = { code: null, output: "" };
	// Issue #431, review: the two shapes `runCmdCapture` answers differently from the step runner, added to the pin
	// (captured from main at a65d6d5 like the rest). A probe that never answers is ended by its 30 s bound, with the
	// signal that runner sends; a probe whose CLI cannot launch still leaves its name for the teardown's `rm -f`.
	if (scenario === "enoent") plan["docker run --rm --name pi-dispatch-egress-probe-provider"] = "enoent";
	if (scenario === "hung") {
		plan["docker run --rm --name pi-dispatch-egress-probe-provider"] = "hang";
		t.mock.timers.enable({ apis: ["setTimeout"] });
	}
	const { out, text } = capture();
	const calls = [];
	const pending = runDoctor(env, { ...ghDeps(out, plan, calls), cwd, home: "/home/op", agentDir: NO_AGENT_DIR, live: true, liveFs: liveFsAs(1001), jobUserIdentity: LINUX_1001, isAlive: () => false, pid: 7, nonce: "n", ...instantClock() });
	const probe = () => calls.find((c) => c.args[3] === "pi-dispatch-egress-probe-provider-7");
	let killsBeforeBound = null;
	if (scenario === "hung") {
		for (let i = 0; i < 200 && !probe(); i++) await new Promise((r) => setImmediate(r));
		t.mock.timers.tick(29_999);
		killsBeforeBound = [...probe().kills];
		t.mock.timers.tick(1);
	}
	const code = await pending;
	const jobs = realpathSync(env.PI_JOBS_DIR);
	const norm = (s) => String(s).replaceAll(jobs, "<jobs>").replaceAll(env.PI_JOBS_DIR, "<jobs>").replaceAll(cwd, "<cwd>").replace(/pi-dispatch-live-7-[A-Za-z0-9]{6}/g, "<fixture>");
	// The in-container script is `egressCanaryScript`'s, which its own tests pin; here it is named, so the argv around it
	// is what this reads, and a script that is not exactly that function's output for that URL still differs.
	const script = (s) => s.replace(egressCanaryScript("https://api.anthropic.com/v1/messages"), "<egressCanaryScript(provider)>").replace(egressCanaryScript("https://example.com/"), "<egressCanaryScript(unlisted)>");
	const spawns = calls.map((c) => script(norm([c.cmd, ...c.args].join(" "))));
	// The collection's spawns, which is where the canary lives, exactly; the read-back's (runLiveProbes, which this
	// change does not touch) by count.
	const readBack = spawns.indexOf("docker ps -a --filter name=pi-dispatch-live- --format {{.ID}} {{.Names}}");
	return { code, text: norm(text()), collection: spawns.slice(0, readBack), total: spawns.length, killsBeforeBound, kills: probe()?.kills ?? null };
};
const DOCKER_CANARY_PIN = {
	green: {
		code: 0,
		total: 50,
		collection: [
			"docker info",
			"docker context inspect --format={{json .Name}}|{{json .Endpoints.docker.Host}}",
			"docker image inspect pi-job:latest",
			"docker network ls --filter name=pi-dispatch-egress-doctor- --format {{.Name}}",
			"docker network inspect --format {{json .Containers}} pi-dispatch-egress-doctor-4242",
			"docker rm -f pi-dispatch-egress-probe-unlisted-4242",
			"docker info --format={{json .}}",
			"docker network disconnect -f pi-dispatch-egress-doctor-4242 pi-dispatch-egress-proxy",
			"docker network rm pi-dispatch-egress-doctor-4242",
			'docker inspect --format={"status":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}},"image":{{json .Config.Image}},"entrypoint":{{json .Config.Entrypoint}},"cmd":{{json .Config.Cmd}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}}} pi-dispatch-egress-proxy',
			"docker network create --internal pi-dispatch-egress-doctor-7",
			"docker network connect pi-dispatch-egress-doctor-7 pi-dispatch-egress-proxy",
			"docker run --rm --name pi-dispatch-egress-probe-provider-7 --pull=never --network=pi-dispatch-egress-doctor-7 -e HTTPS_PROXY=http://pi-dispatch-egress-proxy:3128 -e NODE_USE_ENV_PROXY=1 --entrypoint node pi-job:latest -e <egressCanaryScript(provider)>",
			"docker run --rm --name pi-dispatch-egress-probe-unlisted-7 --pull=never --network=pi-dispatch-egress-doctor-7 -e HTTPS_PROXY=http://pi-dispatch-egress-proxy:3128 -e NODE_USE_ENV_PROXY=1 --entrypoint node pi-job:latest -e <egressCanaryScript(unlisted)>",
			"docker network disconnect -f pi-dispatch-egress-doctor-7 pi-dispatch-egress-proxy",
			"docker network rm pi-dispatch-egress-doctor-7",
			"gh auth status",
			"gh auth token",
			"docker context inspect --format={{json .Name}}|{{json .Endpoints.docker.Host}}",
		],
		text: [
			"✓ Node ≥ 22.19 (have 22.19.0)",
			"✓ .env present",
			"✓ Docker daemon reachable",
			"✓ Job image present (pi-job:latest)",
			"✓ Egress canary: removed pi-dispatch-egress-doctor-4242 (after removing pi-dispatch-egress-probe-unlisted-4242 and detaching pi-dispatch-egress-proxy), left by an EARLIER doctor run",
			"✓ Egress proxy running (pi-dispatch-egress-proxy)",
			"✓ Egress proxy health: healthy",
			"✓ Egress policy reaches the provider (api.anthropic.com answered, so the whole path works and no key was spent)",
			"✓ Egress policy denies an unlisted host (the deny direction is the half an allowlist can silently lose)",
			"✓ Jobs run on: local",
			"⚠ local: nonRoot is ASSERTED by the job image's USER directive (this repo's builds `USER pi`; an operator-built image may not), or on a daemon that enforces bind-mount ownership and a worker uid other than 1001 the worker's own non-zero uid passed as `--user`, not enforced by it",
			"    → not verifiable from here, so treat it as a claim rather than a control: the agent runs as a non-root user",
			"✓ PI_BACKEND_FLOOR is not set, so no minimum is required of any backend",
			"✓ local: the daemon is Docker Engine 27.5.1",
			"✓ local: jobs run as the job image's own user (this shell is uid 1001, the image's own uid)",
			"⚠ GITHUB_AUTH_SOURCE=gh forwards your full gh login into every token-carrying job container (scopes: gist, read:org, repo, workflow)",
			"    → this token carries broad scopes (workflow) -- use a fine-grained PAT (GITHUB_AUTH_SOURCE=pat) or a GitHub App for per-job scoping -- see SECURITY.md",
			"✓ Valkey reachable (redis://127.0.0.1:6379)",
			"✓ Provider key set (anthropic: ANTHROPIC_API_KEY)",
			"⚠ PI_PAUSE_WINDOWS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for scoped pauses cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"⚠ PI_SCOPED_LIMITS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for scoped limits cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"✓ 0 retained workspace(s) in <jobs>/sandboxes, swept after 24h, re-open one with `pi-dispatch sandbox <jobId>`",
			"✓ Durable state: run history /home/op/.pi-dispatch/logs, settings /home/op/.pi-dispatch/settings.json \u2014 both survive a reboot (docs/backup.md)",
			"",
			"read back on local: starting pi-dispatch-live-probe-7-n, pi-dispatch-live-pin-7-n and pi-dispatch-live-ephemeral-7-n (twice) from pi-job:latest (no environment, as the image's own user), and pi-dispatch-live-peer1-7-n and pi-dispatch-live-peer2-7-n on their own --internal networks pi-dispatch-live-peer1-7-n-net and pi-dispatch-live-peer2-7-n-net, with pi-dispatch-egress-proxy attached to both, with a fixture under <jobs>; all of them are removed when the read-back ends, as is anything an interrupted earlier run left",
			"✓ read back on local: the probe ran as the job image's own user (uid 1001)",
			"✓ read back on local: isolation holds (CapBnd 0, NoNewPrivs 1, pids.max 512, memory.max 4294967296)",
			"✓ read back on local: ephemeral holds (two runs under one name each removed themselves (in 0 ms and 0 ms), and the second found nothing of the first)",
			"✓ read back on local: mountSet holds (/job:ro, /workspace, /outbox, /session, /opt/pi-global:ro and nothing else, in docker inspect and in /proc/self/mountinfo)",
			"✓ read back on local: egress holds (the provider was reached and an unlisted host was not)",
			"✓ read back on local: jobToJobIsolation holds (peer1 reached the proxy and none of peer2's 3 name(s) and address(es) (pi-dispatch-live-peer2-7-n:47431 enetunreach, pi-dispatch-live-peer2-1-n:47431 enetunreach, 10.99.0.3:47431 enetunreach); peer2 answered itself before and after)",
			"✓ read back on local: imagePinning holds (an absent image was refused without a pull)",
			"✓ read back on local: nonRoot holds (Uid 1001 1001 1001 1001)",
			"✓ read back on local: localFolders holds (every mount a job uses was used as the job user, and the files written inside /workspace, /outbox and /session were read back on the host, owned by this shell's uid 1001)",
			"✓ read back on local: limits of this read-back -- every probe container runs a constant program (`sleep`, `sh` or `node`) in place of the job image's entrypoint; it ran as the image's own user, decided for this shell (uid 1001), and the worker service may run as another account; it wrote to a fixture folder, not to any folder of yours; it read back PI_JOB_IMAGE only; ephemeral ran two short-lived containers under one name, not two real jobs; jobToJobIsolation tried one pair of peers on this daemon's job networks, from the first to the second only, not every pair of jobs; secretsCustody and credentialTransit are not container properties",
			"",
			"doctor: ready. Start the worker with `pi-dispatch worker`.",
			"",
		].join("\n"),
	},
	stale: {
		code: 0,
		total: 49,
		collection: [
			"docker info",
			"docker context inspect --format={{json .Name}}|{{json .Endpoints.docker.Host}}",
			"docker image inspect pi-job:latest",
			"docker network ls --filter name=pi-dispatch-egress-doctor- --format {{.Name}}",
			"docker network inspect --format {{json .Containers}} pi-dispatch-egress-doctor-4242",
			"docker rm -f pi-dispatch-egress-probe-unlisted-4242",
			"docker info --format={{json .}}",
			"docker network disconnect -f pi-dispatch-egress-doctor-4242 pi-dispatch-egress-proxy",
			"docker network rm pi-dispatch-egress-doctor-4242",
			'docker inspect --format={"status":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}},"image":{{json .Config.Image}},"entrypoint":{{json .Config.Entrypoint}},"cmd":{{json .Config.Cmd}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}}} pi-dispatch-egress-proxy',
			"docker network create --internal pi-dispatch-egress-doctor-7",
			"docker network connect pi-dispatch-egress-doctor-7 pi-dispatch-egress-proxy",
			"docker run --rm --name pi-dispatch-egress-probe-provider-7 --pull=never --network=pi-dispatch-egress-doctor-7 -e HTTPS_PROXY=http://pi-dispatch-egress-proxy:3128 -e NODE_USE_ENV_PROXY=1 --entrypoint node pi-job:latest -e <egressCanaryScript(provider)>",
			"docker network disconnect -f pi-dispatch-egress-doctor-7 pi-dispatch-egress-proxy",
			"docker network rm pi-dispatch-egress-doctor-7",
			"gh auth status",
			"gh auth token",
			"docker context inspect --format={{json .Name}}|{{json .Endpoints.docker.Host}}",
		],
		text: [
			"✓ Node ≥ 22.19 (have 22.19.0)",
			"✓ .env present",
			"✓ Docker daemon reachable",
			"✓ Job image present (pi-job:latest)",
			"✓ Egress canary: removed pi-dispatch-egress-doctor-4242 (after removing pi-dispatch-egress-probe-unlisted-4242 and detaching pi-dispatch-egress-proxy), left by an EARLIER doctor run",
			"✓ Egress proxy running (pi-dispatch-egress-proxy)",
			"✓ Egress proxy health: healthy",
			"⚠ Egress policy: not proved, because the job image could not find /app/image/runner/src/env-proxy.mjs (or an import of it): its runner predates issue #427, whose provider call goes around the proxy so that with egress armed every job fails at its first turn, or the image is not built from this project's",
			"    → use a job image built after issue #427 (ghcr.io/edgehero/pi-job:latest, or rebuild yours FROM it), or set PI_EGRESS=0 until you can",
			"✓ Jobs run on: local",
			"⚠ local: nonRoot is ASSERTED by the job image's USER directive (this repo's builds `USER pi`; an operator-built image may not), or on a daemon that enforces bind-mount ownership and a worker uid other than 1001 the worker's own non-zero uid passed as `--user`, not enforced by it",
			"    → not verifiable from here, so treat it as a claim rather than a control: the agent runs as a non-root user",
			"✓ PI_BACKEND_FLOOR is not set, so no minimum is required of any backend",
			"✓ local: the daemon is Docker Engine 27.5.1",
			"✓ local: jobs run as the job image's own user (this shell is uid 1001, the image's own uid)",
			"⚠ GITHUB_AUTH_SOURCE=gh forwards your full gh login into every token-carrying job container (scopes: gist, read:org, repo, workflow)",
			"    → this token carries broad scopes (workflow) -- use a fine-grained PAT (GITHUB_AUTH_SOURCE=pat) or a GitHub App for per-job scoping -- see SECURITY.md",
			"✓ Valkey reachable (redis://127.0.0.1:6379)",
			"✓ Provider key set (anthropic: ANTHROPIC_API_KEY)",
			"⚠ PI_PAUSE_WINDOWS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for scoped pauses cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"⚠ PI_SCOPED_LIMITS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for scoped limits cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"✓ 0 retained workspace(s) in <jobs>/sandboxes, swept after 24h, re-open one with `pi-dispatch sandbox <jobId>`",
			"✓ Durable state: run history /home/op/.pi-dispatch/logs, settings /home/op/.pi-dispatch/settings.json \u2014 both survive a reboot (docs/backup.md)",
			"",
			"read back on local: starting pi-dispatch-live-probe-7-n, pi-dispatch-live-pin-7-n and pi-dispatch-live-ephemeral-7-n (twice) from pi-job:latest (no environment, as the image's own user), and pi-dispatch-live-peer1-7-n and pi-dispatch-live-peer2-7-n on their own --internal networks pi-dispatch-live-peer1-7-n-net and pi-dispatch-live-peer2-7-n-net, with pi-dispatch-egress-proxy attached to both, with a fixture under <jobs>; all of them are removed when the read-back ends, as is anything an interrupted earlier run left",
			"✓ read back on local: the probe ran as the job image's own user (uid 1001)",
			"✓ read back on local: isolation holds (CapBnd 0, NoNewPrivs 1, pids.max 512, memory.max 4294967296)",
			"✓ read back on local: ephemeral holds (two runs under one name each removed themselves (in 0 ms and 0 ms), and the second found nothing of the first)",
			"✓ read back on local: mountSet holds (/job:ro, /workspace, /outbox, /session, /opt/pi-global:ro and nothing else, in docker inspect and in /proc/self/mountinfo)",
			"⚠ read back on local: egress not read back: the egress canary did not run both probes (see the egress lines above)",
			"    → this property was not read back, which is not the same as holding: see the reason, fix it if you can, and re-run `pi-dispatch doctor --live`",
			"✓ read back on local: jobToJobIsolation holds (peer1 reached the proxy and none of peer2's 3 name(s) and address(es) (pi-dispatch-live-peer2-7-n:47431 enetunreach, pi-dispatch-live-peer2-1-n:47431 enetunreach, 10.99.0.3:47431 enetunreach); peer2 answered itself before and after)",
			"✓ read back on local: imagePinning holds (an absent image was refused without a pull)",
			"✓ read back on local: nonRoot holds (Uid 1001 1001 1001 1001)",
			"✓ read back on local: localFolders holds (every mount a job uses was used as the job user, and the files written inside /workspace, /outbox and /session were read back on the host, owned by this shell's uid 1001)",
			"✓ read back on local: limits of this read-back -- every probe container runs a constant program (`sleep`, `sh` or `node`) in place of the job image's entrypoint; it ran as the image's own user, decided for this shell (uid 1001), and the worker service may run as another account; it wrote to a fixture folder, not to any folder of yours; it read back PI_JOB_IMAGE only; ephemeral ran two short-lived containers under one name, not two real jobs; jobToJobIsolation tried one pair of peers on this daemon's job networks, from the first to the second only, not every pair of jobs; secretsCustody and credentialTransit are not container properties",
			"",
			"doctor: ready. Start the worker with `pi-dispatch worker`.",
			"",
		].join("\n"),
	},
	unfinished: {
		code: 0,
		total: 51,
		collection: [
			"docker info",
			"docker context inspect --format={{json .Name}}|{{json .Endpoints.docker.Host}}",
			"docker image inspect pi-job:latest",
			"docker network ls --filter name=pi-dispatch-egress-doctor- --format {{.Name}}",
			"docker network inspect --format {{json .Containers}} pi-dispatch-egress-doctor-4242",
			"docker rm -f pi-dispatch-egress-probe-unlisted-4242",
			"docker info --format={{json .}}",
			"docker network disconnect -f pi-dispatch-egress-doctor-4242 pi-dispatch-egress-proxy",
			"docker network rm pi-dispatch-egress-doctor-4242",
			'docker inspect --format={"status":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}},"image":{{json .Config.Image}},"entrypoint":{{json .Config.Entrypoint}},"cmd":{{json .Config.Cmd}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}}} pi-dispatch-egress-proxy',
			"docker network create --internal pi-dispatch-egress-doctor-7",
			"docker network connect pi-dispatch-egress-doctor-7 pi-dispatch-egress-proxy",
			"docker run --rm --name pi-dispatch-egress-probe-provider-7 --pull=never --network=pi-dispatch-egress-doctor-7 -e HTTPS_PROXY=http://pi-dispatch-egress-proxy:3128 -e NODE_USE_ENV_PROXY=1 --entrypoint node pi-job:latest -e <egressCanaryScript(provider)>",
			"docker run --rm --name pi-dispatch-egress-probe-unlisted-7 --pull=never --network=pi-dispatch-egress-doctor-7 -e HTTPS_PROXY=http://pi-dispatch-egress-proxy:3128 -e NODE_USE_ENV_PROXY=1 --entrypoint node pi-job:latest -e <egressCanaryScript(unlisted)>",
			"docker rm -f pi-dispatch-egress-probe-provider-7",
			"docker network disconnect -f pi-dispatch-egress-doctor-7 pi-dispatch-egress-proxy",
			"docker network rm pi-dispatch-egress-doctor-7",
			"gh auth status",
			"gh auth token",
			"docker context inspect --format={{json .Name}}|{{json .Endpoints.docker.Host}}",
		],
		text: [
			"✓ Node ≥ 22.19 (have 22.19.0)",
			"✓ .env present",
			"✓ Docker daemon reachable",
			"✓ Job image present (pi-job:latest)",
			"✓ Egress canary: removed pi-dispatch-egress-doctor-4242 (after removing pi-dispatch-egress-probe-unlisted-4242 and detaching pi-dispatch-egress-proxy), left by an EARLIER doctor run",
			"✓ Egress proxy running (pi-dispatch-egress-proxy)",
			"✓ Egress proxy health: healthy",
			"⚠ Egress policy probe for the provider did not run (docker run did not finish)",
			"    → re-run doctor; if it persists, run the job image by hand to see why a container on this network will not start",
			"✓ Egress policy denies an unlisted host (the deny direction is the half an allowlist can silently lose)",
			"✓ Jobs run on: local",
			"⚠ local: nonRoot is ASSERTED by the job image's USER directive (this repo's builds `USER pi`; an operator-built image may not), or on a daemon that enforces bind-mount ownership and a worker uid other than 1001 the worker's own non-zero uid passed as `--user`, not enforced by it",
			"    → not verifiable from here, so treat it as a claim rather than a control: the agent runs as a non-root user",
			"✓ PI_BACKEND_FLOOR is not set, so no minimum is required of any backend",
			"✓ local: the daemon is Docker Engine 27.5.1",
			"✓ local: jobs run as the job image's own user (this shell is uid 1001, the image's own uid)",
			"⚠ GITHUB_AUTH_SOURCE=gh forwards your full gh login into every token-carrying job container (scopes: gist, read:org, repo, workflow)",
			"    → this token carries broad scopes (workflow) -- use a fine-grained PAT (GITHUB_AUTH_SOURCE=pat) or a GitHub App for per-job scoping -- see SECURITY.md",
			"✓ Valkey reachable (redis://127.0.0.1:6379)",
			"✓ Provider key set (anthropic: ANTHROPIC_API_KEY)",
			"⚠ PI_PAUSE_WINDOWS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for scoped pauses cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"⚠ PI_SCOPED_LIMITS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for scoped limits cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"✓ 0 retained workspace(s) in <jobs>/sandboxes, swept after 24h, re-open one with `pi-dispatch sandbox <jobId>`",
			"✓ Durable state: run history /home/op/.pi-dispatch/logs, settings /home/op/.pi-dispatch/settings.json \u2014 both survive a reboot (docs/backup.md)",
			"",
			"read back on local: starting pi-dispatch-live-probe-7-n, pi-dispatch-live-pin-7-n and pi-dispatch-live-ephemeral-7-n (twice) from pi-job:latest (no environment, as the image's own user), and pi-dispatch-live-peer1-7-n and pi-dispatch-live-peer2-7-n on their own --internal networks pi-dispatch-live-peer1-7-n-net and pi-dispatch-live-peer2-7-n-net, with pi-dispatch-egress-proxy attached to both, with a fixture under <jobs>; all of them are removed when the read-back ends, as is anything an interrupted earlier run left",
			"✓ read back on local: the probe ran as the job image's own user (uid 1001)",
			"✓ read back on local: isolation holds (CapBnd 0, NoNewPrivs 1, pids.max 512, memory.max 4294967296)",
			"✓ read back on local: ephemeral holds (two runs under one name each removed themselves (in 0 ms and 0 ms), and the second found nothing of the first)",
			"✓ read back on local: mountSet holds (/job:ro, /workspace, /outbox, /session, /opt/pi-global:ro and nothing else, in docker inspect and in /proc/self/mountinfo)",
			"⚠ read back on local: egress not read back: an egress probe did not run to an answer (see the egress lines above)",
			"    → this property was not read back, which is not the same as holding: see the reason, fix it if you can, and re-run `pi-dispatch doctor --live`",
			"✓ read back on local: jobToJobIsolation holds (peer1 reached the proxy and none of peer2's 3 name(s) and address(es) (pi-dispatch-live-peer2-7-n:47431 enetunreach, pi-dispatch-live-peer2-1-n:47431 enetunreach, 10.99.0.3:47431 enetunreach); peer2 answered itself before and after)",
			"✓ read back on local: imagePinning holds (an absent image was refused without a pull)",
			"✓ read back on local: nonRoot holds (Uid 1001 1001 1001 1001)",
			"✓ read back on local: localFolders holds (every mount a job uses was used as the job user, and the files written inside /workspace, /outbox and /session were read back on the host, owned by this shell's uid 1001)",
			"✓ read back on local: limits of this read-back -- every probe container runs a constant program (`sleep`, `sh` or `node`) in place of the job image's entrypoint; it ran as the image's own user, decided for this shell (uid 1001), and the worker service may run as another account; it wrote to a fixture folder, not to any folder of yours; it read back PI_JOB_IMAGE only; ephemeral ran two short-lived containers under one name, not two real jobs; jobToJobIsolation tried one pair of peers on this daemon's job networks, from the first to the second only, not every pair of jobs; secretsCustody and credentialTransit are not container properties",
			"",
			"doctor: ready. Start the worker with `pi-dispatch worker`.",
			"",
		].join("\n"),
	},
	hung: {
		code: 0,
		total: 51,
		// The kills the provider probe got: none before its 30 s bound, then ONE, with no signal named (so the
		// default SIGTERM), which is `runCmdCapture`'s. The step runner would send SIGKILL.
		killsBeforeBound: [],
		kills: [null],
		collection: [
			"docker info",
			"docker context inspect --format={{json .Name}}|{{json .Endpoints.docker.Host}}",
			"docker image inspect pi-job:latest",
			"docker network ls --filter name=pi-dispatch-egress-doctor- --format {{.Name}}",
			"docker network inspect --format {{json .Containers}} pi-dispatch-egress-doctor-4242",
			"docker rm -f pi-dispatch-egress-probe-unlisted-4242",
			"docker info --format={{json .}}",
			"docker network disconnect -f pi-dispatch-egress-doctor-4242 pi-dispatch-egress-proxy",
			"docker network rm pi-dispatch-egress-doctor-4242",
			'docker inspect --format={"status":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}},"image":{{json .Config.Image}},"entrypoint":{{json .Config.Entrypoint}},"cmd":{{json .Config.Cmd}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}}} pi-dispatch-egress-proxy',
			"docker network create --internal pi-dispatch-egress-doctor-7",
			"docker network connect pi-dispatch-egress-doctor-7 pi-dispatch-egress-proxy",
			"docker run --rm --name pi-dispatch-egress-probe-provider-7 --pull=never --network=pi-dispatch-egress-doctor-7 -e HTTPS_PROXY=http://pi-dispatch-egress-proxy:3128 -e NODE_USE_ENV_PROXY=1 --entrypoint node pi-job:latest -e <egressCanaryScript(provider)>",
			"docker run --rm --name pi-dispatch-egress-probe-unlisted-7 --pull=never --network=pi-dispatch-egress-doctor-7 -e HTTPS_PROXY=http://pi-dispatch-egress-proxy:3128 -e NODE_USE_ENV_PROXY=1 --entrypoint node pi-job:latest -e <egressCanaryScript(unlisted)>",
			"docker rm -f pi-dispatch-egress-probe-provider-7",
			"docker network disconnect -f pi-dispatch-egress-doctor-7 pi-dispatch-egress-proxy",
			"docker network rm pi-dispatch-egress-doctor-7",
			"gh auth status",
			"gh auth token",
			"docker context inspect --format={{json .Name}}|{{json .Endpoints.docker.Host}}",
		],
		text: [
			"✓ Node ≥ 22.19 (have 22.19.0)",
			"✓ .env present",
			"✓ Docker daemon reachable",
			"✓ Job image present (pi-job:latest)",
			"✓ Egress canary: removed pi-dispatch-egress-doctor-4242 (after removing pi-dispatch-egress-probe-unlisted-4242 and detaching pi-dispatch-egress-proxy), left by an EARLIER doctor run",
			"✓ Egress proxy running (pi-dispatch-egress-proxy)",
			"✓ Egress proxy health: healthy",
			"⚠ Egress policy probe for the provider did not run (docker run did not finish)",
			"    → re-run doctor; if it persists, run the job image by hand to see why a container on this network will not start",
			"✓ Egress policy denies an unlisted host (the deny direction is the half an allowlist can silently lose)",
			"✓ Jobs run on: local",
			"⚠ local: nonRoot is ASSERTED by the job image's USER directive (this repo's builds `USER pi`; an operator-built image may not), or on a daemon that enforces bind-mount ownership and a worker uid other than 1001 the worker's own non-zero uid passed as `--user`, not enforced by it",
			"    → not verifiable from here, so treat it as a claim rather than a control: the agent runs as a non-root user",
			"✓ PI_BACKEND_FLOOR is not set, so no minimum is required of any backend",
			"✓ local: the daemon is Docker Engine 27.5.1",
			"✓ local: jobs run as the job image's own user (this shell is uid 1001, the image's own uid)",
			"⚠ GITHUB_AUTH_SOURCE=gh forwards your full gh login into every token-carrying job container (scopes: gist, read:org, repo, workflow)",
			"    → this token carries broad scopes (workflow) -- use a fine-grained PAT (GITHUB_AUTH_SOURCE=pat) or a GitHub App for per-job scoping -- see SECURITY.md",
			"✓ Valkey reachable (redis://127.0.0.1:6379)",
			"✓ Provider key set (anthropic: ANTHROPIC_API_KEY)",
			"⚠ PI_PAUSE_WINDOWS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for scoped pauses cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"⚠ PI_SCOPED_LIMITS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for scoped limits cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"✓ 0 retained workspace(s) in <jobs>/sandboxes, swept after 24h, re-open one with `pi-dispatch sandbox <jobId>`",
			"✓ Durable state: run history /home/op/.pi-dispatch/logs, settings /home/op/.pi-dispatch/settings.json \u2014 both survive a reboot (docs/backup.md)",
			"",
			"read back on local: starting pi-dispatch-live-probe-7-n, pi-dispatch-live-pin-7-n and pi-dispatch-live-ephemeral-7-n (twice) from pi-job:latest (no environment, as the image's own user), and pi-dispatch-live-peer1-7-n and pi-dispatch-live-peer2-7-n on their own --internal networks pi-dispatch-live-peer1-7-n-net and pi-dispatch-live-peer2-7-n-net, with pi-dispatch-egress-proxy attached to both, with a fixture under <jobs>; all of them are removed when the read-back ends, as is anything an interrupted earlier run left",
			"✓ read back on local: the probe ran as the job image's own user (uid 1001)",
			"✓ read back on local: isolation holds (CapBnd 0, NoNewPrivs 1, pids.max 512, memory.max 4294967296)",
			"✓ read back on local: ephemeral holds (two runs under one name each removed themselves (in 0 ms and 0 ms), and the second found nothing of the first)",
			"✓ read back on local: mountSet holds (/job:ro, /workspace, /outbox, /session, /opt/pi-global:ro and nothing else, in docker inspect and in /proc/self/mountinfo)",
			"⚠ read back on local: egress not read back: an egress probe did not run to an answer (see the egress lines above)",
			"    → this property was not read back, which is not the same as holding: see the reason, fix it if you can, and re-run `pi-dispatch doctor --live`",
			"✓ read back on local: jobToJobIsolation holds (peer1 reached the proxy and none of peer2's 3 name(s) and address(es) (pi-dispatch-live-peer2-7-n:47431 enetunreach, pi-dispatch-live-peer2-1-n:47431 enetunreach, 10.99.0.3:47431 enetunreach); peer2 answered itself before and after)",
			"✓ read back on local: imagePinning holds (an absent image was refused without a pull)",
			"✓ read back on local: nonRoot holds (Uid 1001 1001 1001 1001)",
			"✓ read back on local: localFolders holds (every mount a job uses was used as the job user, and the files written inside /workspace, /outbox and /session were read back on the host, owned by this shell's uid 1001)",
			"✓ read back on local: limits of this read-back -- every probe container runs a constant program (`sleep`, `sh` or `node`) in place of the job image's entrypoint; it ran as the image's own user, decided for this shell (uid 1001), and the worker service may run as another account; it wrote to a fixture folder, not to any folder of yours; it read back PI_JOB_IMAGE only; ephemeral ran two short-lived containers under one name, not two real jobs; jobToJobIsolation tried one pair of peers on this daemon's job networks, from the first to the second only, not every pair of jobs; secretsCustody and credentialTransit are not container properties",
			"",
			"doctor: ready. Start the worker with `pi-dispatch worker`.",
			"",
		].join("\n"),
	},
	enoent: {
		code: 0,
		total: 51,
		// The kills the provider probe got: none before its 30 s bound, then ONE, with no signal named (so the
		// A probe that never launched is never killed.
		killsBeforeBound: null,
		kills: [],
		collection: [
			"docker info",
			"docker context inspect --format={{json .Name}}|{{json .Endpoints.docker.Host}}",
			"docker image inspect pi-job:latest",
			"docker network ls --filter name=pi-dispatch-egress-doctor- --format {{.Name}}",
			"docker network inspect --format {{json .Containers}} pi-dispatch-egress-doctor-4242",
			"docker rm -f pi-dispatch-egress-probe-unlisted-4242",
			"docker info --format={{json .}}",
			"docker network disconnect -f pi-dispatch-egress-doctor-4242 pi-dispatch-egress-proxy",
			"docker network rm pi-dispatch-egress-doctor-4242",
			'docker inspect --format={"status":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}},"image":{{json .Config.Image}},"entrypoint":{{json .Config.Entrypoint}},"cmd":{{json .Config.Cmd}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}}} pi-dispatch-egress-proxy',
			"docker network create --internal pi-dispatch-egress-doctor-7",
			"docker network connect pi-dispatch-egress-doctor-7 pi-dispatch-egress-proxy",
			"docker run --rm --name pi-dispatch-egress-probe-provider-7 --pull=never --network=pi-dispatch-egress-doctor-7 -e HTTPS_PROXY=http://pi-dispatch-egress-proxy:3128 -e NODE_USE_ENV_PROXY=1 --entrypoint node pi-job:latest -e <egressCanaryScript(provider)>",
			"docker run --rm --name pi-dispatch-egress-probe-unlisted-7 --pull=never --network=pi-dispatch-egress-doctor-7 -e HTTPS_PROXY=http://pi-dispatch-egress-proxy:3128 -e NODE_USE_ENV_PROXY=1 --entrypoint node pi-job:latest -e <egressCanaryScript(unlisted)>",
			"docker rm -f pi-dispatch-egress-probe-provider-7",
			"docker network disconnect -f pi-dispatch-egress-doctor-7 pi-dispatch-egress-proxy",
			"docker network rm pi-dispatch-egress-doctor-7",
			"gh auth status",
			"gh auth token",
			"docker context inspect --format={{json .Name}}|{{json .Endpoints.docker.Host}}",
		],
		text: [
			"✓ Node ≥ 22.19 (have 22.19.0)",
			"✓ .env present",
			"✓ Docker daemon reachable",
			"✓ Job image present (pi-job:latest)",
			"✓ Egress canary: removed pi-dispatch-egress-doctor-4242 (after removing pi-dispatch-egress-probe-unlisted-4242 and detaching pi-dispatch-egress-proxy), left by an EARLIER doctor run",
			"✓ Egress proxy running (pi-dispatch-egress-proxy)",
			"✓ Egress proxy health: healthy",
			"⚠ Egress policy probe for the provider did not run (docker run did not finish)",
			"    → re-run doctor; if it persists, run the job image by hand to see why a container on this network will not start",
			"✓ Egress policy denies an unlisted host (the deny direction is the half an allowlist can silently lose)",
			"✓ Jobs run on: local",
			"⚠ local: nonRoot is ASSERTED by the job image's USER directive (this repo's builds `USER pi`; an operator-built image may not), or on a daemon that enforces bind-mount ownership and a worker uid other than 1001 the worker's own non-zero uid passed as `--user`, not enforced by it",
			"    → not verifiable from here, so treat it as a claim rather than a control: the agent runs as a non-root user",
			"✓ PI_BACKEND_FLOOR is not set, so no minimum is required of any backend",
			"✓ local: the daemon is Docker Engine 27.5.1",
			"✓ local: jobs run as the job image's own user (this shell is uid 1001, the image's own uid)",
			"⚠ GITHUB_AUTH_SOURCE=gh forwards your full gh login into every token-carrying job container (scopes: gist, read:org, repo, workflow)",
			"    → this token carries broad scopes (workflow) -- use a fine-grained PAT (GITHUB_AUTH_SOURCE=pat) or a GitHub App for per-job scoping -- see SECURITY.md",
			"✓ Valkey reachable (redis://127.0.0.1:6379)",
			"✓ Provider key set (anthropic: ANTHROPIC_API_KEY)",
			"⚠ PI_PAUSE_WINDOWS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for scoped pauses cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"⚠ PI_SCOPED_LIMITS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for scoped limits cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"✓ 0 retained workspace(s) in <jobs>/sandboxes, swept after 24h, re-open one with `pi-dispatch sandbox <jobId>`",
			"✓ Durable state: run history /home/op/.pi-dispatch/logs, settings /home/op/.pi-dispatch/settings.json \u2014 both survive a reboot (docs/backup.md)",
			"",
			"read back on local: starting pi-dispatch-live-probe-7-n, pi-dispatch-live-pin-7-n and pi-dispatch-live-ephemeral-7-n (twice) from pi-job:latest (no environment, as the image's own user), and pi-dispatch-live-peer1-7-n and pi-dispatch-live-peer2-7-n on their own --internal networks pi-dispatch-live-peer1-7-n-net and pi-dispatch-live-peer2-7-n-net, with pi-dispatch-egress-proxy attached to both, with a fixture under <jobs>; all of them are removed when the read-back ends, as is anything an interrupted earlier run left",
			"✓ read back on local: the probe ran as the job image's own user (uid 1001)",
			"✓ read back on local: isolation holds (CapBnd 0, NoNewPrivs 1, pids.max 512, memory.max 4294967296)",
			"✓ read back on local: ephemeral holds (two runs under one name each removed themselves (in 0 ms and 0 ms), and the second found nothing of the first)",
			"✓ read back on local: mountSet holds (/job:ro, /workspace, /outbox, /session, /opt/pi-global:ro and nothing else, in docker inspect and in /proc/self/mountinfo)",
			"⚠ read back on local: egress not read back: an egress probe did not run to an answer (see the egress lines above)",
			"    → this property was not read back, which is not the same as holding: see the reason, fix it if you can, and re-run `pi-dispatch doctor --live`",
			"✓ read back on local: jobToJobIsolation holds (peer1 reached the proxy and none of peer2's 3 name(s) and address(es) (pi-dispatch-live-peer2-7-n:47431 enetunreach, pi-dispatch-live-peer2-1-n:47431 enetunreach, 10.99.0.3:47431 enetunreach); peer2 answered itself before and after)",
			"✓ read back on local: imagePinning holds (an absent image was refused without a pull)",
			"✓ read back on local: nonRoot holds (Uid 1001 1001 1001 1001)",
			"✓ read back on local: localFolders holds (every mount a job uses was used as the job user, and the files written inside /workspace, /outbox and /session were read back on the host, owned by this shell's uid 1001)",
			"✓ read back on local: limits of this read-back -- every probe container runs a constant program (`sleep`, `sh` or `node`) in place of the job image's entrypoint; it ran as the image's own user, decided for this shell (uid 1001), and the worker service may run as another account; it wrote to a fixture folder, not to any folder of yours; it read back PI_JOB_IMAGE only; ephemeral ran two short-lived containers under one name, not two real jobs; jobToJobIsolation tried one pair of peers on this daemon's job networks, from the first to the second only, not every pair of jobs; secretsCustody and credentialTransit are not container properties",
			"",
			"doctor: ready. Start the worker with `pi-dispatch worker`.",
			"",
		].join("\n"),
	},
};
test("docker's egress canary prints and spawns exactly what it did before it was parameterised on the venue (#431)", async (t) => {
	for (const [scenario, want] of Object.entries(DOCKER_CANARY_PIN)) {
		const got = await dockerCanaryPinRun(scenario, t);
		assert.deepEqual(got.collection, want.collection, `${scenario}: the collection's spawns moved`);
		assert.equal(got.text, want.text, `${scenario}: the output moved`);
		assert.deepEqual([got.code, got.total], [want.code, want.total], `${scenario}: exit code and spawn count`);
		// JSON has no `undefined`, so the capture wrote a signal-less kill as null.
		if ("kills" in want) assert.deepEqual([got.killsBeforeBound, got.kills?.map((k) => k ?? null) ?? null], [want.killsBeforeBound, want.kills], `${scenario}: the probe's bound and its kill`);
	}
});


// --- issue #446: the sweep's tombstones -------------------------------------------------------------------------

/** What an operator SEES for `checks`: `render`'s own lines (gate round 2 pinned the output, not the check objects). */
const rendered = (checks) => {
	const lines = [];
	render(checks, (s) => lines.push(s));
	return lines.join("");
};

test("doctor counts tombstones apart from retained workspaces, and tells a PINNED one from every other, never by pid (#446)", () => {
	const at = 10_000_000;
	const names = ["gh-1", "gh-2", ".reap-1-1000-0", `.reap-1-${at - 60_000}-1`, ".reap-by-hand", ".reap-7-2000-0", `.reap-1-${at + 60_000}-2`, ".reap-1-3000-0"];
	// `.reap-1-3000-0` holds a pin that has not run out; `.reap-1-1000-0` held one that has.
	const readFile = (p) => {
		if (p === "/sbx/.reap-1-3000-0/manifest.json") return JSON.stringify({ jobId: "p", keepUntil: new Date(at + 3600000).toISOString() });
		if (p === "/sbx/.reap-1-1000-0/manifest.json") return JSON.stringify({ jobId: "q", keepUntil: new Date(at - 1).toISOString() });
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	};
	const kept = countRetained("/sbx", () => true, { readdir: () => names, now: () => at, readFile });
	// A delete in progress (a minute old) is neither. Gate round 3: the pid in a name decides NOTHING here (after a
	// restart every stuck tombstone's pid is dead, and a pid means nothing across namespaces), so `.reap-7-...` is an
	// ordinary one with its removal, not a "crash leftover" without one.
	assert.deepEqual(kept, { count: 2, tombstones: 6, stuck: [".reap-1-1000-0", ".reap-by-hand", ".reap-7-2000-0", `.reap-1-${at + 60_000}-2`], pinned: [".reap-1-3000-0"] });
	const lines = sandboxTombstoneChecks("/sbx", kept);
	assert.deepEqual(lines.map((c) => [c.ok, c.warn]), [[false, true], [false, true]], "the WARNING shape: a ⚠ that never fails doctor");
	assert.deepEqual(sandboxTombstoneChecks("/sbx", { count: 1, tombstones: 1, stuck: [], pinned: [] }), [], "none old, no line");
	assert.deepEqual(countRetained("/nope", () => false), { count: 0, tombstones: 0, stuck: [], pinned: [] });
	// RENDERED: a ⚠ with its fix line, each unpinned one by its exact path, and never a claim that nothing failed.
	assert.equal(
		rendered(lines),
		[
			"⚠ 1 pinned workspace(s) in /sbx are held aside by the retention sweep (.reap-1-3000-0) because their run's name was taken when they were put back",
			"    → do NOT remove them: each holds a pinned run, and the sweep puts it back under its run's name as soon as that name is free (move away whatever now holds the name, if it is not a run you want)",
			`⚠ 4 deleted workspace(s) in /sbx are still on disk (.reap-1-1000-0, .reap-by-hand, .reap-7-2000-0, ...) -- the sweep could not remove them; if the worker is running it retries each pass`,
			`    → the usual cause is files the worker's account cannot delete (root-owned files a job left in its clone); remove each as their owner: \`sudo rm -rf /sbx/.reap-1-1000-0\`, \`sudo rm -rf /sbx/.reap-by-hand\`, \`sudo rm -rf /sbx/.reap-7-2000-0\`, \`sudo rm -rf /sbx/.reap-1-${at + 60_000}-2\`. They are no longer re-openable either way`,
			"",
		].join("\n"),
	);
});

test("a stuck tombstone reaches doctor's RENDERED output as a warning with its fix, retention on or off (#446)", async () => {
	const sandboxDir = tempDir("pi-doctor-tomb-");
	mkdirSync(join(sandboxDir, "gh-1"));
	// pid 1 is always alive, so this is a delete that keeps failing rather than a crash leftover.
	mkdirSync(join(sandboxDir, ".reap-1-1000-0"));
	for (const env of [{}, { PI_SANDBOX_RETENTION_HOURS: "0" }]) {
		const out = rendered(await collectChecks({ PI_PROVIDER: "google", PI_SANDBOX_DIR: sandboxDir, ...env }, collectSeams(green, { providerOracle: async () => null })));
		assert.match(out, new RegExp(`⚠ 1 deleted workspace\\(s\\) in ${sandboxDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} are still on disk \\(\\.reap-1-1000-0\\)[^\\n]*\\n    → the usual cause`), JSON.stringify(env));
		if (env.PI_SANDBOX_RETENTION_HOURS === "0") assert.match(out, /Workspace retention off/);
		else assert.match(out, new RegExp(`1 retained workspace\\(s\\) in`), "the tombstone is not a workspace");
	}
});

// -- issue #462: every advisory renders as what it means ---------------------------------------------------------
// `render` reads `ok` first, so a check returned as `ok: true, warn: true` printed a green ✓ and dropped its fix. Each
// such check is now either a WARNING (`ok: false, warn: true`: a ⚠ with its fix, never failing doctor) or a FACT LINE
// (`ok: true`, its advice in the label). Pinned RENDERED, since the shape is only a means to what an operator reads.

/** The one check whose label matches, rendered alone, and whether rendering it would fail doctor. */
function renderedOne(checks, re) {
	const hits = checks.filter((c) => re.test(c.label ?? ""));
	assert.equal(hits.length, 1, `exactly one check matches ${re}`);
	return { text: rendered(hits), failed: render(hits, () => {}) };
}
const adviceSeams = (extra = {}) => collectSeams(green, { nodeVersion: "22.19.0", probeValkey: async () => true, ...extra });

test("an injected skills dir's skipped symlinks and its unread ai-trigger opt-in are WARNINGS with their fixes (#462)", async () => {
	const skillsDir = tempDir("pi-skills-462-");
	mkdirSync(join(skillsDir, "review"));
	writeFileSync(join(skillsDir, "review", "SKILL.md"), "---\ndescription: injected\nai-trigger: allow\n---\n");
	symlinkSync(join(skillsDir, "review", "SKILL.md"), join(skillsDir, "review", "linked.md"));
	const checks = await collectChecks(imgEnv({ PI_TRIGGERS_FILE: triggersFile(undefined, undefined, { skillsDir }) }), adviceSeams());
	const links = renderedOne(checks, /are symlinks and are SKIPPED/);
	assert.equal(
		links.text,
		[
			`⚠ 1 entry(ies) under ${skillsDir} are symlinks and are SKIPPED`,
			"    → the copier never follows a link (a link out of the tree would put a host file in a job container); replace them with real files if the jobs need them",
			"",
		].join("\n"),
	);
	assert.equal(links.failed, false, "a warning never fails doctor");
	const optIn = renderedOne(checks, /set ai-trigger: allow, which is NEVER read/);
	assert.equal(
		optIn.text,
		[
			`⚠ 1 injected skill(s) under ${skillsDir} set ai-trigger: allow, which is NEVER read`,
			"    → injected skills are trigger-reachable but not AI-reachable: the gate reads the target repo's committed .pi/skills at the pinned sha, so chain and dispatch_run requests for these flows are refused. Commit the flow to the repo if a model must be able to start it",
			"",
		].join("\n"),
	);
	assert.equal(optIn.failed, false);
});

test("the GitLab token scope is a FACT LINE whose advice is in the label, since no change clears it (#462)", async () => {
	const checks = await collectChecks(imgEnv({ PI_TRIGGERS_FILE: forgeTriggersFile("gitlab"), GITLAB_TOKEN: "glpat_secret_val" }), adviceSeams());
	const scope = renderedOne(checks, /needs the `api` scope to post notes/);
	assert.equal(
		scope.text,
		"✓ a GitLab project access token needs the `api` scope to post notes, which grants full project API read/write: scope it to ONE project and rotate it on a schedule (GitLab has no contents-vs-issues split and no short-expiry token)\n",
	);
	assert.equal(scope.failed, false);
});

test("persisted transcripts and a context bound that may be inert are FACT LINES whose advice is in the label (#462)", async () => {
	const env = imgEnv({ PI_SESSIONS_DIR: "/srv/pi-sessions", PI_TRIGGERS_FILE: resumeTriggersFile(), GITHUB_AUTH_SOURCE: "pat", PI_SESSION_MAX_CONTEXT_PCT: "80" });
	const checks = await collectChecks(env, adviceSeams({ fileExists: () => true }));
	const transcripts = renderedOne(checks, /persist agent transcripts/);
	assert.equal(
		transcripts.text,
		"✓ 1 trigger(s) persist agent transcripts to /srv/pi-sessions -- PII-bearing, host-only, never committed: keep it outside every git repo, on a disk you would put issue text on (docs/sessions.md)\n",
	);
	assert.equal(transcripts.failed, false);
	// Gate round 1: a fact line, not a warning, because doctor has no image capability to check, so a ⚠ here could never
	// clear on an image that does report the reading. The older-image caveat rides in the label.
	const bound = renderedOne(checks, /needs a job image whose runner reports context usage/);
	assert.equal(
		bound.text,
		"✓ PI_SESSION_MAX_CONTEXT_PCT=80 needs a job image whose runner reports context usage: an older image reports none, and a bound with no measurement passes, so there it does nothing. Each run's record (the logs directory/<jobId>.json) carries session.reason, which names the gate that refused\n",
	);
	assert.equal(bound.failed, false, "a bound that may be inert is never a refusal");
});

test("replicas are a FACT LINE carrying the budget and concurrency arithmetic in the label (#462)", async () => {
	const checks = await collectChecks(imgEnv({ PI_TRIGGERS_FILE: replicaTriggersFile(2) }), adviceSeams());
	const replicas = renderedOne(checks, /set run\.replicas/);
	assert.equal(
		replicas.text,
		"✓ 1 trigger(s) set run.replicas -- one delivery reserves one budget slot PER replica, so the daily/weekly/monthly caps divide by it; PI_CONCURRENCY bounds how many actually race, so keep it at least the largest run.replicas\n",
	);
	assert.equal(replicas.failed, false);
});

test("retained workspaces are a FACT LINE that says what each holds only when there is one (#462)", async () => {
	const sandboxDir = tempDir("pi-doctor-kept-462-");
	const zero = renderedOne(await collectChecks({ PI_PROVIDER: "google", PI_SANDBOX_DIR: sandboxDir }, collectSeams(green, { providerOracle: async () => null })), /retained workspace\(s\)/);
	assert.equal(zero.text, `✓ 0 retained workspace(s) in ${sandboxDir}, swept after 24h, re-open one with \`pi-dispatch sandbox <jobId>\`\n`);
	mkdirSync(join(sandboxDir, "gh-1"));
	const one = renderedOne(await collectChecks({ PI_PROVIDER: "google", PI_SANDBOX_DIR: sandboxDir }, collectSeams(green, { providerOracle: async () => null })), /retained workspace\(s\)/);
	assert.equal(
		one.text,
		`✓ 1 retained workspace(s) in ${sandboxDir}, swept after 24h, re-open one with \`pi-dispatch sandbox <jobId>\`; each holds the run's clone plus its prompt.md/event.json (issue text), and PI_SANDBOX_RETENTION_HOURS=0 turns retention off\n`,
	);
	assert.equal(one.failed, false);
});

test("a plain doctor on `local` reaching a rootless Podman 4.9 runs no canary while the keeper does not hold, through the API or podman-docker (#452 gate round 3, L205)", async () => {
	// MEASURED (gate round 3, c9-doctor-*): the canary's teardown detached the running proxy and cut its route out, through
	// both routes. Now the ONE detach gate is asked before anything exists, from the run's one `docker info`.
	const SHIM49 = JSON.stringify({ host: { os: "linux", security: { rootless: true, selinuxEnabled: false }, serviceIsRemote: false }, version: { Version: "4.9.3" } });
	for (const [route, body] of [["api", PODMAN49_COMPAT_INFO], ["podman-docker", SHIM49]]) {
		const calls = [];
		const { out, text } = capture();
		await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, canaryFixture({ "docker info --format={{json .}}": { code: 0, output: `${body}\n` }, "docker inspect --format={{.State.Status}}|{{.HostConfig.NetworkMode}}": { code: 1, output: "Error: no such container" } }), calls));
		const lines = calls.map((c) => [c.cmd, ...c.args].join(" "));
		assert.ok(!lines.some((l) => /network (create|connect|disconnect)/.test(l)), `${route}: no canary object, no detach: ${lines.join(" | ")}`);
		assert.match(text(), /✗ Egress policy: not proved, and no egress canary was run, because the rootless network keeper pi-dispatch-netns-keeper does not hold under the rootless Podman 4\.x this shell's docker CLI reaches/, route);
		assert.equal(lines.filter((l) => l.startsWith("docker info --format={{json .}}")).length, 1, `${route}: one runtime read for the run`);
		// With the keeper holding, the canary runs as ever.
		const heldCalls = [];
		const held = capture();
		await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(held.out, canaryFixture({ "docker info --format={{json .}}": { code: 0, output: `${body}\n` }, "docker inspect --format={{.State.Status}}|{{.HostConfig.NetworkMode}}": { code: 0, output: "running|bridge|pi-dispatch-netns-keeper,\n" } }), heldCalls));
		assert.ok(heldCalls.some((c) => c.args.slice(0, 2).join(" ") === "network create"), `${route}: the canary ran with the keeper holding`);
		assert.doesNotMatch(held.text(), /no egress canary was run/);
	}
});

test("doctor --live on `local` reaching a rootless Podman 4.9 builds no peer networks while the keeper does not hold (#452 gate round 3, L205)", async () => {
	const env = liveEnv({ PI_EGRESS: "1" });
	const daemon = { answered: true, facts: { podman: true, rootless: true, serverVersion: "4.9.3" } };
	const facts = { endpoint: { local: true }, dockerCode: 0, imageCode: 0, jobImage: "pi-job:latest", triggerImages: [], daemon, egress: { armed: true, results: [], proxy: "pi-dispatch-egress-proxy", proxyRunning: true } };
	const calls = [];
	const seams = { spawn: fakeSpawn({ ...liveOk(), ...livePeersOk({}), "docker inspect --format={{.State.Status}}|{{.HostConfig.NetworkMode}}": { code: 1, output: "" }, ...green }, calls), liveFs: liveFsAs(1001), isAlive: () => false, pid: 1, nonce: "n", jobUserIdentity: LINUX_1001, ...instantClock() };
	const checks = await liveChecks(env, seams, facts);
	assert.ok(!calls.some((c) => c.args.slice(0, 2).join(" ") === "network create"), "no peer network");
	assert.ok(checks.some((c) => /jobToJobIsolation not read back: no peer networks were built, because the rootless network keeper pi-dispatch-netns-keeper does not hold/.test(c.label)), checks.map((c) => c.label).join("\n"));
	assert.ok(!calls.some((c) => c.args[0] === "info"), "the collection's answer is used, not a second read");
});

test("doctor: a .env line assigning a wrapper's own variable is named beside the readings, never its value (#470)", async () => {
	// The wrappers assign their own variables again after the load, so such a line has no effect; doctor says so for the
	// platforms that run a wrapper, keeps its readings of the two boot keys, and prints the NAME only.
	for (const [platform, line, name] of [["darwin", "PI_ENV_SETUP=/tmp/evil.sh", "PI_ENV_SETUP"], ["darwin", "env_setup=/tmp/evil.sh", "env_setup"], ["win32", "Env_Setup=/tmp/evil.sh", "Env_Setup"]]) {
		const cwd = scaffoldedCwd();
		writeFileSync(join(cwd, ".env"), [`PI_PAUSE_WINDOWS_FILE=${join(cwd, "pause-windows.json").replace(/\\/g, "/")}`, line].join("\n"));
		const { out, text } = capture();
		const checks = await collectChecks(imgEnv(), { out, cwd, home: cwd, platform, spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0", fileExists: existsSync, readEnvFile: (p) => readFileSync(p, "utf8") });
		const warned = checks.find((c) => c.label.includes(`line 2 assigns ${name}, a variable the service wrapper keeps for itself`));
		assert.ok(warned, `${platform}: the line is named`);
		assert.equal(warned.warn, true, "a warning: the line has no effect");
		assert.match(warned.fix, /remove the line \(a setup script is named with pi-dispatch service install --env-setup <path>, never in \.env\), then run doctor again/);
		assert.ok(!(JSON.stringify(checks) + text()).includes("/tmp/evil.sh"), "the value never leaves .env");
		assert.ok(checks.some((c) => /PI_PAUSE_WINDOWS_FILE is set in/.test(c.label)), "and the boot key's reading stands");
	}
	// Linux runs no wrapper: nothing to say.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "env_setup=/tmp/evil.sh\n");
	const { out } = capture();
	const checks = await collectChecks(imgEnv(), { out, cwd, home: cwd, platform: "linux", spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0", fileExists: existsSync, readEnvFile: (p) => readFileSync(p, "utf8") });
	assert.ok(!checks.some((c) => c.label.includes("keeps for itself")));
});
