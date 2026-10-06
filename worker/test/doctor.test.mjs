import { execFileSync, spawnSync } from "node:child_process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdtempSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { makeWaitChecker } from "../src/wait-check.mjs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { dollarChecks, overlayDollarProblem, scopedDollarRowChecks, startAdvice, CANARY_LINES, CANARY_PROBE_SLUGS, DOCTOR_SHELL_KEYS, EGRESS_CANARY_RUNNER_MODULE, EGRESS_CANARY_STALE_RUNNER, ENV_FILE_READABLE_KEYS, RECEIVER_SERVICE_KEYS, RUN_TIMEOUTS, SERVICE_ENV_KEYS, STEERING_SERVICE_KEYS, WORKER_SERVICE_KEYS, backendChecks, countRetained, defaultPromptFn, dockerRunVia, egressCanaryPlainScript, egressCanaryProbeArgs, forgeUrlEgressChecks, egressCanaryScript, envFileKeys, githubProtectionPreflight, jobUserChecks, liveChecks, liveRunVia, podmanLiveChecks, render, sandboxTombstoneChecks, serviceEnvKeys, serviceEnvLoader, sweepStaleCanaryNetworks, urlShown, resolveDoctorEnv, jobImageOf, CLI_SERVICE_KEYS, cliNotHandedLines, fileConfigures, triggersPath, valkeyPasswordUpgradeStep, undeclaredPortNear, ENDPOINT_PROBE_SLUGS, allowlistHostAliases, egressEndpointScript, lanIPv4Addresses, overlayLoopbackModels } from "../src/doctor.mjs";
import { collectChecks, runDoctor } from "./helpers/doctor.mjs";
import { valkeyPasswordFor } from "../src/valkey-endpoint.mjs";
import { serviceEnvFileOf } from "../src/service-env.mjs";
import { VALKEY_SHARED_KEY as VALKEY_SHARED_NAME } from "../src/podman-stack.mjs";
import { EMPTY_PAUSE_WINDOWS, EMPTY_SCOPED_LIMITS, runInit } from "../src/init.mjs";
import { ignoredOutputCapModels } from "../src/output-cap.mjs";
import { EMPTY_MODEL_ENDPOINTS, MODEL_ENDPOINT_ID_RE, loadModelEndpoints, parseModelEndpoints, renderEndpointsInclude, unreportedUsageModels } from "../src/model-endpoints.mjs";
import { EGRESS_CANARY_NET_PREFIX, egressCanaryProbe, egressEndpointProbe } from "../src/egress.mjs";
import { LIVE_PREFIX, egressVerdict } from "../src/live-probes.mjs";
import { JOB_USER_FIX, parseDaemonFacts } from "../src/job-user.mjs";
import { OBSERVATION_FIX } from "../src/backends.mjs";
import { PODMAN_JOB_USER_FIX } from "../src/backend-podman.mjs";
import { loadConfig, underOsTempDir } from "../src/config.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { usdFingerprint } from "../src/dollar-fingerprint.mjs";
import { projectsFingerprint } from "../src/projects.mjs";
import { appliedSplitChecks, envelopeChecks, fleetEnvelopeChecks, loadEnvelopeAsTheWorker } from "../src/doctor.mjs";
import { doctorJobSize, fleetSizeChecks, jobSizeChecks } from "../src/doctor.mjs";
import { envelopeDigest, parseEnvelope } from "../src/envelope.mjs";
import { parseScopedLimits } from "../src/scoped-limits.mjs";
import { quotedShown } from "../src/backend-local.mjs";

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
			// What the caller wrote to the child's stdin is RECORDED (issue #521): the in-image gh probe hands its token
			// there, and a test that cannot see the write cannot tell a token delivered from one dropped on the floor.
			stdin: {
				on() {
					return this;
				},
				end(data) {
					entry.stdin = (entry.stdin ?? "") + (data ?? "");
					entry.stdinEnded = true;
				},
			},
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
const proxyAnswer = (health, status, { image = PINNED_SQUID, cwd = process.cwd(), conf = join(cwd, "deploy/egress-proxy.conf"), allowlist = join(cwd, "egress-allowlist.conf"), include = null, entrypoint = ["entrypoint.sh"], cmd = ["-f", "/etc/squid/squid.conf", "-NYC"], stderr } = {}) => ({
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
			// Issue #503: the third mount, the model endpoints' include, on a proxy made since.
			...(include ? [{ Type: "bind", Source: include, Destination: "/etc/pi-dispatch/model-endpoints.conf" }] : []),
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
	// Issue #508: plain HTTP to a listed host off port 80 is refused by the proxy (exit 3).
	"docker run --rm --name pi-dispatch-egress-probe-plainhttp": 3,
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

test("doctor: an overlay entry pi will not compose is ✗ naming the provider; a dropped file's fix names the public endpoint (issue #539)", async () => {
	const uncomposable = overlay({ models: JSON.stringify({ providers: { openai: { baseUrl: "http://proxy.lan:8080/v1", models: [{ id: "my-ft", maxTokens: 0 }] }, ollama: { baseUrl: "http://gpu.lan:11434/v1", api: "openai-completions", models: [{ id: "q" }] } } }) });
	const a = capture();
	assert.equal(await runDoctor(overlayEnv(uncomposable), overlayDeps(a.out)), 1);
	assert.match(a.text(), /✗ Overlay models\.json entry "openai" is one pi will not compose \(maxTokens\), so pi drops all of it, its baseUrl and headers included\n {4}→ every job that runs or lists a model of "openai" is refused as model-unknown \(overlay-provider-invalid\)/);
	assert.doesNotMatch(a.text(), /entry "ollama"/, "an entry pi composes has no line");
	assert.match(a.text(), /✓ Overlay models\.json is credential-free/, "the file itself loads");
	for (const [text, fix] of [
		[JSON.stringify({ providers: { openai: { baseUrl: "http://proxy.lan:8080/v1" }, lan: { models: [{ id: "m", contextWindow: "big" }] } } }), /does not match pi's models\.json schema, so pi loads none of it: every job is refused as model-unknown \(overlay-unparseable\) until the file is fixed, since pi would run even a builtin model against its provider's public endpoint/],
		['{ "providers": { "openai": { "baseUrl": "http://proxy.lan:8080/v1" } }', /is not valid JSON, so pi loads none of it: every job is refused as model-unknown \(overlay-unparseable\) until the file is fixed/],
	]) {
		const b = capture();
		assert.equal(await runDoctor(overlayEnv(overlay({ models: text })), overlayDeps(b.out)), 1);
		assert.match(b.text(), fix, text);
		assert.doesNotMatch(b.text(), /will not compose/, "a file pi drops is the one line above, not a line per entry");
	}
});

test("doctor: an overlay models.json that is a directory is ✗: every job is refused until it is a file (issue #539)", async () => {
	const dir = overlay();
	mkdirSync(join(dir, "models.json"));
	const { out, text } = capture();
	assert.equal(await runDoctor(overlayEnv(dir), overlayDeps(out)), 1);
	assert.match(text(), /✗ Overlay models\.json is a directory, so pi loads none of it and every job is refused as model-unknown \(overlay-is-a-directory\)\n {4}→ replace .*models\.json with a models\.json file, or remove it; no job runs until then/);
	assert.doesNotMatch(text(), /could not be read \(EISDIR\)/);
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

test("doctor: PI_PROVIDER=azure-openai-responses names pi 1.0.3's rename to azure (issue #587)", { skip: skipNoPi }, async () => {
	const { out, text } = capture();
	const code = await runDoctor(provEnv({ PI_PROVIDER: "azure-openai-responses", AZURE_OPENAI_API_KEY: "k" }), provDeps(out));
	assert.equal(code, 1, "the worker refuses every job on the old id, so doctor must not be green");
	assert.match(text(), /PI_PROVIDER is "azure-openai-responses", which is not a provider pi has; pi renamed the provider "azure-openai-responses" to "azure" in pi 1\.0\.3: did you mean "azure"\?/);
	assert.match(text(), /set PI_PROVIDER=azure, and rename the provider in every trigger's model and allowed-models entries and in models\.json the same way/);
	const other = capture();
	await runDoctor(provEnv({ PI_PROVIDER: "gemini", GEMINI_API_KEY: "g" }), provDeps(other.out));
	assert.doesNotMatch(other.text(), /renamed/, "only an id pi renamed gets the hint");
});

test("doctor: an overlay that declares the old azure id as a provider of its own gets no rename hint, with no endpoint declared (issue #587)", { skip: skipNoPi }, async () => {
	// The hint read the overlay only through the keyless snapshot, which exists only when model-endpoints.json declares
	// an endpoint; a full custom provider under the old id then got "did you mean azure". It reads the overlay itself.
	const custom = overlay({ models: JSON.stringify({ providers: { "azure-openai-responses": { baseUrl: "https://x.openai.azure.com/openai/v1", api: "azure-openai-responses", apiKey: "$AZURE_OPENAI_API_KEY", models: [{ id: "my-deployment" }] } } }) });
	const declared = capture();
	await runDoctor(overlayEnv(custom, { PI_PROVIDER: "azure-openai-responses" }), overlayDeps(declared.out));
	assert.match(declared.text(), /PI_PROVIDER is "azure-openai-responses", which is not a provider pi has/);
	assert.doesNotMatch(declared.text(), /did you mean/, "the overlay declares it: no hint");
	const unrelated = capture();
	await runDoctor(overlayEnv(overlay({ models: JSON.stringify({ providers: { ollama: { baseUrl: "http://gpu.lan:11434/v1", api: "openai-completions", models: [{ id: "q" }] } } }) }), { PI_PROVIDER: "azure-openai-responses" }), overlayDeps(unrelated.out));
	assert.match(unrelated.text(), /did you mean "azure"\?/, "an overlay that does not declare it: the hint");
	const broken = capture();
	await runDoctor(overlayEnv(overlay({ models: "{ not json" }), { PI_PROVIDER: "azure-openai-responses" }), overlayDeps(broken.out));
	assert.doesNotMatch(broken.text(), /did you mean/, "an overlay that cannot be read: no guess");
});

test("doctor: an overlay entry under the old azure id that only moves the baseUrl is flagged, a full custom provider is not (issue #587)", async () => {
	for (const entry of [{ baseUrl: "https://x.openai.azure.com/openai/v1" }, { baseUrl: "https://x.openai.azure.com/openai/v1", api: "azure-openai-responses" }, { api: "azure-openai-responses", models: [{ id: "gpt-5.4", baseUrl: "https://x.openai.azure.com/openai/v1" }] }, { modelOverrides: { "gpt-5.4": { maxTokens: 1000 } } }]) {
		const a = capture();
		await runDoctor(overlayEnv(overlay({ models: JSON.stringify({ providers: { "azure-openai-responses": entry } }) })), overlayDeps(a.out));
		assert.match(a.text(), /⚠ Overlay models\.json entry "azure-openai-responses" no longer overrides anything: pi 1\.0\.3 renamed that provider to "azure", so this entry is now a provider of its own, holding only what it declares itself, and the azure models do not get its settings\n {4}→ rename the entry to "azure" in /, JSON.stringify(entry));
	}
	for (const providers of [{ "azure-openai-responses": { baseUrl: "https://x.openai.azure.com/openai/v1", api: "azure-openai-responses", models: [{ id: "my-deployment" }] } }, { azure: { baseUrl: "https://x.openai.azure.com/openai/v1" } }]) {
		const b = capture();
		await runDoctor(overlayEnv(overlay({ models: JSON.stringify({ providers }) })), overlayDeps(b.out));
		assert.doesNotMatch(b.text(), /no longer overrides anything/, JSON.stringify(providers));
	}
});

test("doctor: a keyless custom provider is ✓ exactly when the worker's gate passes it, on the same declaration (#503)", { skip: skipNoPi }, async () => {
	// The agreement bolt: doctor's line and the worker's buildContainerEnv are driven on the SAME endpoints and the SAME
	// overlay models.json, case by case. A disagreement is a green setup line over a refused job, or the reverse.
	const { buildContainerEnv } = await import("../src/env-allowlist.mjs");
	const MAC = { id: "mac-ollama", host: "host.docker.internal", port: 11434, slots: 1, keyless: true };
	const provider = (extra = {}) => ({ providers: { "local-ollama": { api: "openai-completions", baseUrl: "http://host.docker.internal:11434/v1", apiKey: "$PI_DISPATCH_KEYLESS", models: [{ id: "qwen" }], ...extra } } });
	const cases = [
		{ name: "keyless", endpoints: [MAC], models: provider(), keyless: true },
		{ name: "endpoint not keyless", endpoints: [{ ...MAC, keyless: false }], models: provider(), keyless: false, why: /the endpoint mac-ollama serving its model "qwen" is not "keyless": true/ },
		{ name: "one model off-endpoint", endpoints: [MAC], models: provider({ models: [{ id: "qwen" }, { id: "big", baseUrl: "https://api.example.com/v1" }] }), keyless: false, why: /its model "big" is not served by a declared model endpoint/ },
		{ name: "literal key", endpoints: [MAC], models: provider({ apiKey: "ollama" }), keyless: false, why: /its models\.json "apiKey" is not "\$PI_DISPATCH_KEYLESS"/ },
		{ name: "nothing declared", endpoints: [], models: provider(), keyless: false },
	];
	for (const c of cases) {
		const overlay = tempDir("pi-overlay-keyless-");
		writeFileSync(join(overlay, "models.json"), JSON.stringify(c.models));
		const { out, text } = capture();
		await runDoctor(provEnv({ PI_PROVIDER: "local-ollama", PI_GLOBAL_PI_DIR: overlay, PI_EGRESS: "0" }), { ...provDeps(out), declaredEndpoints: () => c.endpoints });
		let workerPasses = true;
		try {
			buildContainerEnv({ provider: "local-ollama", model: "qwen", maxTurns: 5, jobId: "j", hostEnv: {}, modelEndpoints: { endpoints: c.endpoints, models: c.models, set: [] } });
		} catch (error) {
			if (error?.piDispatchConfig !== true) throw error;
			workerPasses = false;
		}
		assert.equal(workerPasses, c.keyless, `${c.name}: the worker's verdict`);
		if (c.keyless) {
			assert.match(text(), /✓ Provider key: none needed \(local-ollama is keyless: served by declared endpoint mac-ollama\)/, c.name);
		} else {
			assert.match(text(), /✗ PI_PROVIDER is "local-ollama", which is not a provider pi has/, c.name);
			assert.match(text(), /declare that server in model-endpoints\.json with "keyless": true and set "apiKey": "\$PI_DISPATCH_KEYLESS"/, `${c.name}: the fix names the keyless way in`);
			if (c.why) assert.match(text(), c.why, `${c.name}: and why this one is not`);
		}
	}
});

test("doctor: the keyless line reads the folder's own files as the service would, queue port included (PR #520 round 1)", { skip: skipNoPi }, async () => {
	// No `declaredEndpoints` seam: the real read, from the deployment folder, with the absolute PI_GLOBAL_PI_DIR the
	// worker requires (PR #553's review), and the queue port the worker's boot refuses.
	for (const [port, keyless] of [[11434, true], [6379, false]]) {
		const cwd = tempDir("pi-keyless-folder-");
		mkdirSync(join(cwd, "overlay"));
		writeFileSync(join(cwd, "overlay", "models.json"), JSON.stringify({ providers: { "local-ollama": { baseUrl: `http://ollama.lan:${port}/v1`, apiKey: "$PI_DISPATCH_KEYLESS", models: [{ id: "qwen" }] } } }));
		writeFileSync(join(cwd, "model-endpoints.json"), JSON.stringify({ version: 1, endpoints: [{ id: "lan-ollama", host: "ollama.lan", port, slots: 1, keyless: true }] }));
		const { out, text } = capture();
		await runDoctor(provEnv({ PI_PROVIDER: "local-ollama", PI_GLOBAL_PI_DIR: join(cwd, "overlay"), PI_EGRESS: "0" }), { ...provDeps(out), cwd, fileExists: existsSync });
		if (keyless) assert.match(text(), /✓ Provider key: none needed \(local-ollama is keyless: served by declared endpoint lan-ollama\)/);
		else assert.doesNotMatch(text(), /keyless: served by/, "an endpoint on the queue's port refuses the worker's boot, so it is not keyless");
	}
});

test("doctor: an overlay models.json it cannot read names the errno and the refusal, never ✗ unknown or \"not valid JSON\" (PR #520 round 2, issue #552)", { skip: skipNoPi || (typeof process.getuid === "function" && process.getuid() === 0 ? "root reads a mode-000 file" : false) }, async () => {
	const cwd = tempDir("pi-keyless-000-");
	mkdirSync(join(cwd, "overlay"));
	const models = join(cwd, "overlay", "models.json");
	writeFileSync(models, JSON.stringify({ providers: { "local-ollama": { baseUrl: "http://ollama.lan:11434/v1", apiKey: "$PI_DISPATCH_KEYLESS", models: [{ id: "qwen" }] } } }));
	writeFileSync(join(cwd, "model-endpoints.json"), JSON.stringify({ version: 1, endpoints: [{ id: "lan-ollama", host: "ollama.lan", port: 11434, slots: 1, keyless: true }] }));
	chmodSync(models, 0o000);
	try {
		const { out, text } = capture();
		await runDoctor(provEnv({ PI_PROVIDER: "local-ollama", PI_GLOBAL_PI_DIR: join(cwd, "overlay"), PI_EGRESS: "0" }), { ...provDeps(out), cwd, fileExists: existsSync });
		assert.match(text(), /✗ Provider key: could not read models\.json \(EACCES\), so whether "local-ollama" is keyless is not known; the worker refuses every job until it can read it \(overlay-unreadable\)/);
		assert.match(text(), /✗ Overlay models\.json cannot be read by the worker \(EACCES\), so a job loads none of it and every job is refused as model-unknown \(overlay-unreadable\)/);
		assert.doesNotMatch(text(), /✗ PI_PROVIDER is "local-ollama"/);
		assert.match(text(), /could not read models\.json \(EACCES\)/);
		assert.doesNotMatch(text(), /overlay models\.json is not valid JSON/, "a read error is not a parse error");
	} finally {
		chmodSync(models, 0o600);
	}
});

test("doctor: the credential-free check reads through the one reader: a models.json under a mode-000 overlay is ✗, never a silent pass (PR #520, issue #552)", { skip: typeof process.getuid === "function" && process.getuid() === 0 ? "root reads a mode-000 directory" : false }, async () => {
	const overlay = join(tempDir("pi-overlay-dir000-"), "overlay");
	mkdirSync(overlay);
	writeFileSync(join(overlay, "models.json"), JSON.stringify({ providers: { p: { apiKey: "sk-literal-secret-value" } } }));
	chmodSync(overlay, 0o000);
	try {
		const { out, text } = capture();
		await runDoctor(provEnv({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_GLOBAL_PI_DIR: overlay }), { ...provDeps(out), fileExists: existsSync });
		assert.match(text(), /✗ Overlay models\.json cannot be read by the worker \(EACCES\), so a job loads none of it and every job is refused as model-unknown \(overlay-unreadable\)\n {4}→ make .*models\.json and its folder readable by the account the worker runs as; every job is refused until then/);
		assert.doesNotMatch(text(), /✓ Overlay models\.json is credential-free/, "an unread file is not a clean one");
	} finally {
		chmodSync(overlay, 0o700);
	}
	// Readable again: the same file's literal key is the ✗ it always was, and a non-object is ✗ too, never "unreadable".
	const { out, text } = capture();
	await runDoctor(provEnv({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_GLOBAL_PI_DIR: overlay }), { ...provDeps(out), fileExists: existsSync });
	assert.match(text(), /✗ Overlay models\.json is credential-free/);
	writeFileSync(join(overlay, "models.json"), "[]");
	const again = capture();
	await runDoctor(provEnv({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_GLOBAL_PI_DIR: overlay }), { ...provDeps(again.out), fileExists: existsSync });
	assert.match(again.text(), /✗ Overlay models\.json is credential-free\n {4}→ overlay models\.json does not match pi's models\.json schema/);
});

test("doctor: each overlay read errno is ✗ refused with a fix for its reason, unless it is one the worker retries, which is ⚠ (issue #552)", async () => {
	const overlay = join(tempDir("pi-overlay-errno-"), "overlay");
	mkdirSync(overlay);
	writeFileSync(join(overlay, "models.json"), "{}");
	const failing = (code) => (path, enc) => {
		if (path.endsWith("models.json")) throw Object.assign(new Error(`${code}: read failed`), { code });
		return readFileSync(path, enc);
	};
	const doctor = async (code) => {
		const { out, text } = capture();
		const exit = await runDoctor(provEnv({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_GLOBAL_PI_DIR: overlay }), { ...provDeps(out), fileExists: existsSync, readOverlayFile: failing(code) });
		return { exit, text: text() };
	};
	for (const [code, fix] of [["EACCES", /→ make .*models\.json and its folder readable by the account the worker runs as; every job is refused until then/], ["EPERM", /→ make .*models\.json and its folder readable/], ["EROFS", /→ check .*models\.json on the worker host \(the read failed with EROFS\); every job is refused until the worker can read it/], ["EWHATEVER", /→ check .*models\.json on the worker host \(the read failed with EWHATEVER\)/]]) {
		const { exit, text } = await doctor(code);
		assert.equal(exit, 1, code);
		assert.match(text, new RegExp(`✗ Overlay models\\.json cannot be read by the worker \\(${code}\\), so a job loads none of it and every job is refused as model-unknown \\(overlay-unreadable\\)`), code);
		assert.match(text, fix, code);
	}
	for (const code of ["EIO", "EAGAIN", "EMFILE", "ENFILE"]) {
		const { text } = await doctor(code);
		assert.match(text, new RegExp(`⚠ Overlay models\\.json could not be read just now \\(${code}\\), so whether it is credential-free is not known; the worker retries each job once, then fails it`), code);
		assert.doesNotMatch(text, /overlay-unreadable/, code);
	}
	// What the job reads as no file is no overlay here too (PR #553's review).
	for (const code of ["ELOOP", "ENOTDIR", "ENAMETOOLONG"]) {
		const { text } = await doctor(code);
		assert.doesNotMatch(text, /overlay-unreadable|could not be read/, code);
		assert.match(text, /✓ Overlay models\.json is credential-free/, code);
	}
});

test("doctor: a models.json that is a link is ✗: every job is refused until it is the file itself (PR #553's review)", async () => {
	const root = tempDir("pi-overlay-link-");
	const body = JSON.stringify({ providers: {} });
	writeFileSync(join(root, "outside.json"), body);
	const overlay = join(root, "overlay");
	mkdirSync(overlay);
	writeFileSync(join(overlay, "real.json"), body);
	const run = async (env) => {
		const { out, text } = capture();
		const exit = await runDoctor(provEnv({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", ...env }), { ...provDeps(out), fileExists: existsSync });
		return { exit, text: text() };
	};
	for (const target of [join(root, "outside.json"), "real.json", "../outside.json", "nowhere.json"]) {
		try {
			unlinkSync(join(overlay, "models.json"));
		} catch {}
		symlinkSync(target, join(overlay, "models.json"));
		const { exit, text } = await run({ PI_GLOBAL_PI_DIR: overlay });
		assert.equal(exit, 1, target);
		assert.match(text, /✗ Overlay models\.json is a link, so every job is refused as model-unknown \(overlay-link\)\n {4}→ models\.json in the overlay folder is a link; replace it with the file itself \(the job's read-only mount cannot follow links reliably\): .*models\.json; no job runs until then/, target);
		assert.doesNotMatch(text, /✓ Overlay models\.json is credential-free/, target);
	}
	// The overlay FOLDER may be a link: the runtime follows it at mount time, and both sides read the same file.
	unlinkSync(join(overlay, "models.json"));
	writeFileSync(join(overlay, "models.json"), body);
	symlinkSync(overlay, join(root, "overlay-link"));
	const folder = await run({ PI_GLOBAL_PI_DIR: join(root, "overlay-link") });
	assert.match(folder.text, /✓ Overlay models\.json is credential-free/);
	assert.doesNotMatch(folder.text, /model-unknown \(overlay-link\)/);
});

test("doctor: a models.json that is a named pipe, socket or device is ✗ and never opened (issue #556)", async () => {
	const overlay = join(tempDir("pi-overlay-notfile-"), "overlay");
	mkdirSync(overlay);
	writeFileSync(join(overlay, "models.json"), "{}");
	for (const name of ["fifo", "socket", "device"]) {
		const { out, text } = capture();
		let opened = false;
		const exit = await runDoctor(provEnv({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_GLOBAL_PI_DIR: overlay }), {
			...provDeps(out),
			fileExists: existsSync,
			lstatOverlayFile: () => ({ isSymbolicLink: () => false, isFile: () => false, isDirectory: () => false }),
			readOverlayFile: () => {
				opened = true;
				throw new Error("opened");
			},
		});
		assert.equal(exit, 1, name);
		assert.equal(opened, false, `${name}: doctor never opens it`);
		assert.match(text(), /✗ Overlay models\.json is not a regular file \(a named pipe, socket or device\), so every job is refused as model-unknown \(overlay-not-a-file\)\n {4}→ models\.json in the overlay folder is not a regular file .*; replace it with the file itself/, name);
		assert.doesNotMatch(text(), /✓ Overlay models\.json is credential-free/, name);
	}
});

test("doctor: a relative PI_GLOBAL_PI_DIR is ✗ naming the variable, and neither overlay read runs on it (PR #553's review)", async () => {
	const { out, text } = capture();
	assert.equal(await runDoctor(provEnv({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_GLOBAL_PI_DIR: "pi-global" }), { ...provDeps(out), fileExists: () => true }), 1);
	assert.match(text(), /✗ PI_GLOBAL_PI_DIR is "pi-global", which is not an absolute path, so the worker refuses to boot\n {4}→ set PI_GLOBAL_PI_DIR to the overlay folder's absolute path/);
	assert.doesNotMatch(text(), /Global overlay dir exists|Overlay models\.json/);
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

test("doctor: a bearer token in the ENV is reported, and the line says it outranks the API key (#509)", { skip: skipNoPi }, async () => {
	// pi 0.99.1 lists ANTHROPIC_AUTH_TOKEN FIRST and sends it as `Authorization: Bearer`, ahead of the
	// API key. Same treatment as the OAuth token above (forwarded, so a warn), with its own sentence.
	const { out, text } = capture();
	const code = await runDoctor(provEnv({ PI_PROVIDER: "anthropic", ANTHROPIC_AUTH_TOKEN: "gateway-token" }), provDeps(out));
	assert.equal(code, 0, "a warn does not fail the run");
	assert.match(text(), /⚠ Provider key set \(anthropic: ANTHROPIC_AUTH_TOKEN\) -- a bearer token, not an API key/);
	assert.match(text(), /set ANTHROPIC_API_KEY and unset ANTHROPIC_AUTH_TOKEN: pi reads ANTHROPIC_AUTH_TOKEN BEFORE ANTHROPIC_API_KEY/, "the fix names the API key and says the token outranks it");
	assert.doesNotMatch(text(), /✓ Provider key set/, "never blessed in silence");

	// Beside a real API key the key is the one ignored, and that is the sentence.
	const second = capture();
	await runDoctor(provEnv({ PI_PROVIDER: "anthropic", ANTHROPIC_AUTH_TOKEN: "gateway-token", ANTHROPIC_API_KEY: "sk-x" }), provDeps(second.out));
	assert.match(second.text(), /unset ANTHROPIC_AUTH_TOKEN: pi reads it BEFORE ANTHROPIC_API_KEY and sends it as an Authorization: Bearer header/);
	assert.doesNotMatch(second.text(), /✓ Provider key set/);
});

test("doctor: a host token beside an auth.json API key says the pi login is NOT used while the token is set (#509 review)", { skip: skipNoPi }, async () => {
	// The worker reads the environment first and auth.json only as a fallback, while pi on the host takes a
	// stored api_key first. So with both, the job spends the token and the host's pi spends the key; the
	// warning has to say which one is being ignored and what to do about it.
	const dir = agentDirWith({ type: "api_key", key: "sk-from-login" });
	const deps = (out) => ({ ...provDeps(out), agentDir: dir });
	for (const [token, kind] of [["ANTHROPIC_AUTH_TOKEN", "a bearer token"], ["ANTHROPIC_OAUTH_TOKEN", "an OAuth\\/subscription login"]]) {
		const { out, text } = capture();
		const code = await runDoctor({ PI_PROVIDER: "anthropic", [token]: "tok" }, deps(out));
		assert.equal(code, 0, `${token}: still a warning`);
		assert.match(text(), new RegExp(`⚠ Provider key set \\(anthropic: ${token}\\) -- ${kind}`));
		assert.match(text(), new RegExp(`the API key in pi auth\\.json is NOT used while ${token} is set`), `${token}: names the ignored login`);
		assert.match(text(), new RegExp(`unset ${token} to spend the pi login, or keep it only if this token is the credential you mean jobs to spend`));
		assert.doesNotMatch(text(), /sk-from-login/, "the stored key is never printed");
		// Without a pi login, or with the fallback off, there is nothing to name.
		const bare = capture();
		await runDoctor(provEnv({ PI_PROVIDER: "anthropic", [token]: "tok" }), provDeps(bare.out));
		assert.doesNotMatch(bare.text(), /pi auth\.json is NOT used/, `${token}: no login, no line`);
		const off = capture();
		await runDoctor({ PI_PROVIDER: "anthropic", PI_AUTH_FROM_PI: "0", [token]: "tok" }, deps(off.out));
		assert.doesNotMatch(off.text(), /pi auth\.json is NOT used/, `${token}: PI_AUTH_FROM_PI=0 never reads the login`);
		// With an env API key beside the token, THAT key is the ignored credential and the line names it; the
		// login is not in play at all, because the worker never reads auth.json while the env holds a key.
		const shadow = capture();
		await runDoctor({ PI_PROVIDER: "anthropic", [token]: "tok", ANTHROPIC_API_KEY: "sk-x" }, deps(shadow.out));
		assert.doesNotMatch(shadow.text(), /pi auth\.json is NOT used/, `${token}: an env key beside it is the one named`);
		assert.match(shadow.text(), new RegExp(`unset ${token}: pi reads it BEFORE ANTHROPIC_API_KEY`));
	}
});

test("doctor: an OAuth token in the API-key variable, or in pi auth.json, warns instead of passing (#509 review)", { skip: skipNoPi }, async () => {
	// pi judges by the VALUE (`isOAuthToken`: contains "sk-ant-oat"), so a subscription login under
	// ANTHROPIC_API_KEY is still sent as a Bearer subscription token.
	const { out, text } = capture();
	const code = await runDoctor(provEnv({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-oat01-not-a-real-token" }), provDeps(out));
	assert.equal(code, 0, "a warning, as for the OAuth variable");
	assert.match(text(), /⚠ Provider key set \(anthropic: ANTHROPIC_API_KEY\) -- but the value is an OAuth\/subscription token, not an API key/);
	assert.doesNotMatch(text(), /✓ Provider key set/);
	assert.doesNotMatch(text(), /sk-ant-oat01/, "the value is never printed");

	const dir = agentDirWith({ type: "api_key", key: "sk-ant-oat01-not-a-real-token" });
	const stored = capture();
	await runDoctor({ PI_PROVIDER: "anthropic" }, { ...provDeps(stored.out), agentDir: dir });
	assert.match(stored.text(), /⚠ Provider key set \(anthropic\) -- from pi auth\.json, but the stored key is an OAuth\/subscription token/);
	assert.doesNotMatch(stored.text(), /sk-ant-oat01/);

	// A real API key, and another provider's key that happens to contain the marker, stay green.
	const real = capture();
	await runDoctor(provEnv({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-api03-x" }), provDeps(real.out));
	assert.match(real.text(), /✓ Provider key set \(anthropic: ANTHROPIC_API_KEY\)/);
	const other = capture();
	await runDoctor(provEnv({ PI_PROVIDER: "openai", OPENAI_API_KEY: "sk-ant-oat-lookalike" }), provDeps(other.out));
	assert.match(other.text(), /✓ Provider key set \(openai: OPENAI_API_KEY\)/);
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
	await runDoctor(ghEnv({ GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_fixture" }), ghDeps(out, green));
	assert.doesNotMatch(text(), /forwards your full gh login/);
});

test("doctor: source gh with gh missing warns 'auth status failed', still exits 0", async () => {
	const { out, text } = capture();
	const code = await runDoctor(ghEnv(), ghDeps(out, { ...green, "gh auth": "enoent" }));
	assert.equal(code, 0, "a local-only deployment with the default source is valid — warn, don't fail");
	assert.match(text(), /⚠ GITHUB_AUTH_SOURCE is gh but `gh auth status` failed/);
	assert.match(text(), /run `gh auth login` \(or switch GITHUB_AUTH_SOURCE\)/);
});

test("doctor: the in-image probe passes the token on stdin, never in argv or any environment (#521)", async () => {
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
	assert.equal(run.args[run.args.indexOf("--entrypoint") + 1], "sh", "the image entrypoint is overridden to the reading shell");
	// Exact (issue #433 review round 1): the podman venue's pins ride only the podman probe; docker's CLI has no
	// containers.conf defaults to pin, and a podman-only flag here would make docker refuse the probe.
	const script = run.args[run.args.indexOf("-c") + 1];
	assert.deepEqual(run.args, ["run", "--rm", "-i", "--pull=never", "--entrypoint", "sh", "pi-job:latest", "-c", script, "sh", "gh", "auth", "status"]);
	// Issue #521: no `-e` and no `--env-file` at all. Either one puts the value in the container create request, which
	// Docker Desktop's backend log writes to disk in plain text (measured: two copies per doctor run with `-e`).
	assert.ok(!run.args.some((a) => a === "-e" || a === "--env" || a.startsWith("--env=") || a.startsWith("--env-file")), "no environment flag");
	assert.ok(!run.args.some((a) => a.includes("gho_fake_mint_123")), "the token never enters argv");
	// The token is the one line on stdin, and the docker CLI's own environment does not carry it either.
	assert.equal(run.opts.stdio[0], "pipe", "stdin is a pipe, or the write below goes nowhere");
	assert.equal(run.stdin, "gho_fake_mint_123\n");
	assert.equal(run.stdinEnded, true, "stdin is closed, so the probe's read returns");
	assert.ok(!Object.values(run.opts.env).includes("gho_fake_mint_123"), "the CLI's environment holds no copy");
	assert.equal(run.opts.env.GH_TOKEN, undefined);
	assert.equal(run.opts.env.GITHUB_TOKEN, undefined);
	assert.match(text(), /✓ gh authenticates inside the job image \(pi-job:latest\)/);
	assert.doesNotMatch(text(), /gho_fake_mint_123/, "the token never reaches output");
});

// The probe's script, run by a real `sh` (issue #521). Not docker: the question is what the script does with one line of
// stdin, and only a shell answers it. The probe's tail (`gh auth status`) is swapped for a command that prints what the
// exec'd program received, so a script that reads the line but does not EXPORT it, or splits or unescapes it, fails here.
test("doctor: the in-image probe's script hands the stdin line to gh as GH_TOKEN and GITHUB_TOKEN, and nothing else does (#521)", async () => {
	const calls = [];
	const { out } = capture();
	await runDoctor(ghEnv(), ghDeps(out, { ...green, "gh auth status": { code: 0, output: ghStatusOutput }, "gh auth token": { code: 0, output: "gho_x\n" }, "docker run": 0 }, calls));
	const run = calls.find((c) => c.cmd === "docker" && c.args[0] === "run" && c.args.includes("gh"));
	const at = run.args.indexOf("-c");
	assert.deepEqual(run.args.slice(at + 2), ["sh", "gh", "auth", "status"], "the script's $0, then the command it execs");
	const show = ["sh", "sh", "-c", 'printf "%s|%s|%s" "$GH_TOKEN" "$GITHUB_TOKEN" "$t"'];
	for (const token of ["ghp_i521fixture", "a b\\c d"]) {
		const r = spawnSync("sh", ["-c", run.args[at + 1], ...show], { input: `${token}\n`, env: { PATH: process.env.PATH }, encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		// Both names, the line verbatim (no word splitting, no backslash escapes), and `t` itself not exported.
		assert.equal(r.stdout, `${token}|${token}|`, `token ${JSON.stringify(token)}`);
	}
});

test("doctor: an in-image gh auth failure warns with the egress fix, exits 0", async () => {
	const { out, text } = capture();
	const plan = { ...green, "gh auth status": { code: 0, output: ghStatusOutput }, "gh auth token": { code: 0, output: "gho_x\n" }, "docker run": 1 };
	const code = await runDoctor(ghEnv(), ghDeps(out, plan));
	assert.equal(code, 0, "an in-container auth failure warns but never fails doctor");
	assert.match(text(), /⚠ gh cannot authenticate inside the job image \(pi-job:latest\)/);
	assert.match(text(), /check network egress from containers/);
});

test("doctor: an in-image probe that could not run (exit 126 or 127) names the missing sh or gh, not auth (#521)", async () => {
	for (const code of [126, 127]) {
		const { out, text } = capture();
		const plan = { ...green, "gh auth status": { code: 0, output: ghStatusOutput }, "gh auth token": { code: 0, output: "gho_x\n" }, "docker run": code };
		assert.equal(await runDoctor(ghEnv(), ghDeps(out, plan)), 0, "still a warning");
		assert.match(text(), new RegExp(`⚠ gh could not be run inside the job image \\(pi-job:latest\\): it has no sh or no gh \\(exit ${code}\\)\n {4}→ rebuild or pull the job image: every image built FROM this repo's image/Dockerfile has both`));
		assert.doesNotMatch(text(), /gh cannot authenticate|check network egress from containers/);
	}
	// Podman's label carries the venue, as the other two do.
	const { docker: _d, ...podmanOnly } = podmanPlan();
	const failed = capture();
	await runDoctor(podmanEnv({ GITHUB_AUTH_SOURCE: "gh" }), podmanDeps(failed.out, { ...podmanOnly, ...green, "gh auth status": { code: 0, output: ghStatusOutput }, "gh auth token": { code: 0, output: "gho_x\n" }, "podman run": 127 }, []));
	assert.match(failed.text(), /⚠ podman: gh could not be run inside the job image \(pi-job:latest\): it has no sh or no gh \(exit 127\)/);
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
	assert.match(text(), /✗ GITHUB_AUTH_SOURCE=app but GITHUB_APP_ID is unset or empty -- the worker will refuse to boot\n {4}→ run `pi-dispatch setup github`/);
	assert.match(text(), /✗ GITHUB_AUTH_SOURCE=app but GITHUB_APP_INSTALLATION_ID is unset or empty -- the worker will refuse to boot\n {4}→ run `pi-dispatch setup github`/);
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
	assert.match(bad.text(), /✗ GITHUB_AUTH_SOURCE=app but GITHUB_APP_INSTALLATION_ID is unset or empty -- the worker will refuse to boot\n/);
	// This shell wins where it sets a key, and then the file's value is not read for it.
	const own = capture();
	await runDoctor(imgEnv({ GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_fixture" }), { ...scaffoldDeps(own.out, cwd), readEnvFile });
	assert.doesNotMatch(own.text(), /GITHUB_APP_INSTALLATION_ID/, "the shell's pat wins over the file's app");
	assert.doesNotMatch(own.text(), /GitHub auth settings read from/, "an App key read under another source decides nothing, so nothing is said");
});

// Issue #481: the GitHub twin of the settings line, and the two GitHub auth refusals doctor had passed in silence. The
// line hides an empty value only where the loaders read it as unset (`EMPTY_READ_AS_UNSET`): a blank inline App key is
// hidden, an empty App id is not (the loader keeps it), and its own ✗ names it besides.
test("the GitHub auth settings line hides only a proven-unset empty key, and an empty or unknown GITHUB_AUTH_SOURCE is a ✗ in that block (#481)", async () => {
	const cwd = scaffoldedCwd();
	const readEnvFile = (path) => readFileSync(path, "utf8");
	const envPath = join(cwd, ".env");
	const keyPath = join(cwd, "app.pem");
	writeFileSync(keyPath, `-----BEGIN PRIVATE KEY-----${KEY_BODY}\n`, { mode: 0o600 });
	writeFileSync(envPath, `GITHUB_AUTH_SOURCE=app\nGITHUB_APP_ID=4242\nGITHUB_APP_INSTALLATION_ID=987654\nGITHUB_APP_PRIVATE_KEY_PATH=${keyPath}\nGITHUB_APP_PRIVATE_KEY=\n`);
	const good = capture();
	await runDoctor(imgEnv(), { ...scaffoldDeps(good.out, cwd), readEnvFile });
	assert.ok(good.text().includes(`✓ GitHub auth settings read from ${envPath}, as the service reads them (this shell does not set them): GITHUB_AUTH_SOURCE, GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY_PATH\n`), good.text());
	// An empty App id is not proven unset (the loader returns it as ""), so it is still named, beside the ✗ that decides.
	writeFileSync(envPath, "GITHUB_AUTH_SOURCE=app\nGITHUB_APP_ID=\nGITHUB_APP_INSTALLATION_ID=987654\nGITHUB_APP_PRIVATE_KEY_PATH=/nope\n");
	const idless = capture();
	assert.equal(await runDoctor(imgEnv(), { ...scaffoldDeps(idless.out, cwd), readEnvFile }), 1);
	assert.match(idless.text(), /: GITHUB_AUTH_SOURCE, GITHUB_APP_ID, GITHUB_APP_INSTALLATION_ID, GITHUB_APP_PRIVATE_KEY_PATH\n/);
	assert.match(idless.text(), /✗ GITHUB_AUTH_SOURCE=app but GITHUB_APP_ID is unset or empty -- the worker will refuse to boot\n/);
	const note = `GITHUB_AUTH_SOURCE read from ${envPath}, as the service reads it; this shell does not set it`;
	for (const [value, shown] of [["", '""'], ["bogus", '"bogus"'], [`ghp_${"x".repeat(36)}`, "an unrecognised value (40 characters, not shown)"]]) {
		writeFileSync(envPath, `GITHUB_AUTH_SOURCE=${value}\n`);
		const bad = capture();
		assert.equal(await runDoctor(imgEnv(), { ...scaffoldDeps(bad.out, cwd), readEnvFile }), 1, `${shown}: both processes exit 2 on it`);
		const want = `✗ GITHUB_AUTH_SOURCE is ${shown}, which is none of pat, gh or app: the worker and the receiver refuse to start on it (exit 2) -- ${note}`;
		const lines = bad.text().split("\n");
		const at = lines.indexOf(want);
		assert.ok(at > 0, bad.text());
		// In the GitHub auth block: straight after that block's own read line (an unknown source is not proven unset, so
		// the line names it), not merely somewhere in the output.
		assert.ok(lines[at - 1].startsWith(`✓ GitHub auth settings read from ${envPath}`) && lines[at - 1].endsWith(": GITHUB_AUTH_SOURCE"), lines[at - 1]);
		assert.ok(!bad.text().includes("x".repeat(36)), "a token pasted into the source line is never printed");
	}
	// This shell's own bad value is the same ✗, with no file note.
	writeFileSync(envPath, "");
	const shell = capture();
	assert.equal(await runDoctor(imgEnv({ GITHUB_AUTH_SOURCE: "token" }), scaffoldDeps(shell.out, cwd)), 1);
	assert.match(shell.text(), /✗ GITHUB_AUTH_SOURCE is "token", which is none of pat, gh or app: the worker and the receiver refuse to start on it \(exit 2\)\n/);
});

// Issue #481 (PR #485 review round 1): the PAT source's refusal, `requires a non-empty <var>`, which both processes make
// at start and doctor had reported only as a probe it did not run.
test("GITHUB_AUTH_SOURCE=pat with no PAT, an empty or blank one, or an empty GITHUB_PAT_VAR is a ✗; a PAT in the file is none (#481)", async () => {
	const cwd = scaffoldedCwd();
	const readEnvFile = (path) => readFileSync(path, "utf8");
	const envPath = join(cwd, ".env");
	const run = async (text) => {
		writeFileSync(envPath, text);
		const c = capture();
		const code = await runDoctor(imgEnv(), { ...scaffoldDeps(c.out, cwd), readEnvFile });
		return { code, text: c.text() };
	};
	const fromFile = (key) => ` -- ${key} read from ${envPath}, as the service reads it; this shell does not set it`;
	const refusal = "the worker and the receiver refuse to start (exit 2)";
	const unset = await run("GITHUB_AUTH_SOURCE=pat\n");
	assert.equal(unset.code, 1);
	assert.ok(unset.text.includes(`✗ GITHUB_AUTH_SOURCE=pat but GITHUB_PAT is unset: ${refusal}\n`), unset.text);
	const empty = await run("GITHUB_AUTH_SOURCE=pat\nGITHUB_PAT=\n");
	assert.equal(empty.code, 1);
	assert.ok(empty.text.includes(`✗ GITHUB_AUTH_SOURCE=pat but GITHUB_PAT is empty: ${refusal}${fromFile("GITHUB_PAT")}\n`), empty.text);
	// The probe does not claim a blank PAT "comes from" the file: the file supplies none.
	assert.doesNotMatch(empty.text, /because GITHUB_PAT comes from/);
	const blank = await run("GITHUB_AUTH_SOURCE=pat\nGITHUB_PAT='   '\n");
	assert.equal(blank.code, 1);
	assert.ok(blank.text.includes(`✗ GITHUB_AUTH_SOURCE=pat but GITHUB_PAT is whitespace only: ${refusal}${fromFile("GITHUB_PAT")}\n`), blank.text);
	const noVar = await run("GITHUB_AUTH_SOURCE=pat\nGITHUB_PAT_VAR=\nGITHUB_PAT=ghp_real\n");
	assert.equal(noVar.code, 1);
	assert.ok(noVar.text.includes(`✗ GITHUB_AUTH_SOURCE=pat but GITHUB_PAT_VAR is set to an empty value, so it names no variable to take the PAT from: ${refusal}${fromFile("GITHUB_PAT_VAR")}\n`), noVar.text);
	const named = await run("GITHUB_AUTH_SOURCE=pat\nGITHUB_PAT_VAR=MY_PAT\nMY_PAT=\n");
	assert.ok(named.text.includes(`✗ GITHUB_AUTH_SOURCE=pat but MY_PAT is empty: ${refusal}${fromFile("MY_PAT")}\n`), named.text);
	const good = await run("GITHUB_AUTH_SOURCE=pat\nGITHUB_PAT=ghp_real\n");
	assert.doesNotMatch(good.text, /GITHUB_AUTH_SOURCE=pat but/);
	assert.match(good.text, /in-image gh auth: not checked, because GITHUB_PAT comes from/);
});

// Issue #481 (PR #485 review round 1): a PI_TRIGGERS_FILE that is set and names no file, empty included. The worker takes
// any set value as the file to load and the receiver as the file to serve from, and both exit 2 without it.
test("a set PI_TRIGGERS_FILE that names no file, or is empty, is a ✗; unset keeps each process's own default (#481)", async () => {
	const cwd = scaffoldedCwd();
	const readEnvFile = (path) => readFileSync(path, "utf8");
	const envPath = join(cwd, ".env");
	const refusal = "the worker and the receiver refuse to start on it (exit 2)";
	const run = async (text, shell = {}) => {
		writeFileSync(envPath, text);
		const c = capture();
		const code = await runDoctor(imgEnv(shell), { ...scaffoldDeps(c.out, cwd), fileExists: existsSync, readEnvFile });
		return { code, text: c.text() };
	};
	const empty = await run("PI_TRIGGERS_FILE=\n");
	assert.equal(empty.code, 1);
	const note = ` -- PI_TRIGGERS_FILE read from ${envPath}, as the service reads it; this shell does not set it`;
	assert.ok(empty.text.includes(`✗ PI_TRIGGERS_FILE is set to an empty value, which neither process reads as unset: ${refusal}${note}\n`), empty.text);
	const missing = await run("", { PI_TRIGGERS_FILE: "/nonexistent/t.json" });
	assert.equal(missing.code, 1);
	assert.ok(missing.text.includes(`✗ PI_TRIGGERS_FILE names "/nonexistent/t.json", which does not exist: ${refusal}\n`), missing.text);
	const relative = await run("PI_TRIGGERS_FILE=gone.json\n");
	assert.ok(relative.text.includes(`✗ PI_TRIGGERS_FILE names "${join(cwd, "gone.json")}", which does not exist: ${refusal}${note}\n`), relative.text);
	// Unset with no ./triggers.json: the worker schedules no cron, so there is nothing of this to say.
	const unset = await run("");
	assert.doesNotMatch(unset.text, /PI_TRIGGERS_FILE (is set|names)/);
	writeFileSync(join(cwd, "t.json"), JSON.stringify({ triggers: [] }));
	const present = await run(`PI_TRIGGERS_FILE=${join(cwd, "t.json")}\n`);
	assert.doesNotMatch(present.text, /PI_TRIGGERS_FILE (is set|names)/);
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
	await runDoctor(ghEnv({ GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_fixture" }), ghDeps(out, green));
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

const seamEnv = (extra = {}) => ({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_fixture", ...extra });
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

// Issue #481 (PR #485 review round 2): a credential an --env-setup script exports is invisible to doctor by design
// (docs/secrets.md), so where doctor sees such a script that can run, a credential missing from this shell and the .env
// is a ⚠ naming the script, never a ✗ on a working deployment. Where it sees none it cannot tell: the ✗ stands and its
// fix line says who may ignore it. The PAT, the App keys and the provider key alike.
test("a credential missing from shell and .env is a ⚠ naming the env-setup script doctor sees, and a ✗ where it sees none (#481)", async () => {
	const setup = setupScript();
	const deployDir = tempDir("pi-deploy-");
	const { home, path: unit } = installUnit({ platform: "linux", deployDir, setup });
	const seen = `not visible to doctor in this shell or .env, and expected from the env-setup script ${setup} (named by ${unit}), which the service runs after .env`;
	const run = async (env, extra = {}) => {
		const c = capture();
		const code = await runDoctor(env, seamDeps(c.out, { cwd: deployDir, home, ...extra }));
		return { code, text: c.text() };
	};
	const { GITHUB_PAT: _p, ...noPat } = seamEnv();
	const pat = await run(noPat);
	assert.equal(pat.code, 0, pat.text);
	assert.ok(pat.text.includes(`⚠ GITHUB_AUTH_SOURCE=pat but GITHUB_PAT is unset: ${seen}\n    → if that script does not export GITHUB_PAT, the worker and the receiver refuse to start (exit 2): set GITHUB_PAT`), pat.text);
	const app = await run(seamEnv({ GITHUB_AUTH_SOURCE: "app" }));
	assert.equal(app.code, 0, app.text);
	for (const subject of ["GITHUB_APP_ID is unset or empty", "GITHUB_APP_INSTALLATION_ID is unset or empty", "neither GITHUB_APP_PRIVATE_KEY_PATH nor GITHUB_APP_PRIVATE_KEY is set"]) {
		assert.ok(app.text.includes(`⚠ GITHUB_AUTH_SOURCE=app but ${subject}: ${seen}\n`), `${subject}\n${app.text}`);
	}
	const { ANTHROPIC_API_KEY: _k, ...noKey } = seamEnv({ PI_AUTH_FROM_PI: "0" });
	const key = await run(noKey);
	assert.equal(key.code, 0, key.text);
	assert.match(key.text, new RegExp(`⚠ Provider key \\(anthropic: [A-Z_]+( or [A-Z_]+)*\\) not set: ${seen.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\n`));
	// A script that is not there supplies nothing (its own ⚠ says the unit restart-loops): the ✗ stands.
	const gone = tempDir("pi-deploy-gone-");
	const lost = installUnit({ platform: "linux", deployDir: gone, setup: join(gone, "nope.sh") });
	const c = capture();
	assert.equal(await runDoctor(noPat, seamDeps(c.out, { cwd: gone, home: lost.home })), 1);
	assert.match(c.text(), /✗ GITHUB_AUTH_SOURCE=pat but GITHUB_PAT is unset: the worker and the receiver refuse to start \(exit 2\)\n/);
	// No script at all: the ✗ stands, and its fix line says an env-setup deployment may ignore it.
	const none = capture();
	assert.equal(await runDoctor(noPat, seamDeps(none.out)), 1);
	assert.ok(none.text().includes("✗ GITHUB_AUTH_SOURCE=pat but GITHUB_PAT is unset: the worker and the receiver refuse to start (exit 2)\n    → set GITHUB_PAT to a fine-grained PAT in .env, or switch GITHUB_AUTH_SOURCE. A deployment whose service gets GITHUB_PAT from an --env-setup script (docs/secrets.md) can ignore this line; doctor found no service installed for this folder to read\n"), none.text());
	const noKeyNone = capture();
	assert.equal(await runDoctor(noKey, seamDeps(noKeyNone.out)), 1);
	assert.match(noKeyNone.text(), /✗ Provider key set \(anthropic: [^\n]*\n {4}→ [^\n]*\. A deployment whose service gets one of [A-Za-z_ ]+ from an --env-setup script \(docs\/secrets\.md\) can ignore this line; doctor found no service installed for this folder to read\n/);
	assert.ok(!pat.text.includes(SETUP_BODY.trim()) && !app.text.includes(SETUP_BODY.trim()), "the script is named, never read out");
});

// Issue #481 (PR #485's final review): the strict rule, case by case. A missing credential is softened only where EVERY
// installed service of this folder that reads it names a USABLE script (a regular file after symlinks, readable here),
// with the worker's service installed. This shell's PI_ENV_SETUP softens nothing, and a receiver's script is not the
// worker's. The reviewer's L, P, D and W cases, by shape.
test("a credential ✗ is softened only by a usable script every installed service reading it names; never by this shell's PI_ENV_SETUP (#481)", async () => {
	const { GITHUB_PAT: _p, ...noPat } = seamEnv();
	const { ANTHROPIC_API_KEY: _k, ...noKey } = seamEnv({ PI_AUTH_FROM_PI: "0" });
	const soft = /⚠ GITHUB_AUTH_SOURCE=pat but GITHUB_PAT is unset: not visible to doctor/;
	const hard = /✗ GITHUB_AUTH_SOURCE=pat but GITHUB_PAT is unset: the worker and the receiver refuse to start \(exit 2\)\n/;
	const run = async (env, { platform = "linux", units = [], spawn } = {}) => {
		const deployDir = tempDir("pi-deploy-");
		const home = tempDir("pi-unit-home-");
		for (const u of units) installUnit({ platform, home, deployDir: u.other ? tempDir("pi-other-") : deployDir, setup: u.setup, which: u.which ?? "worker" });
		const c = capture();
		const code = await runDoctor(env, seamDeps(c.out, { cwd: deployDir, home, platform, ...(spawn ? { spawn } : {}) }));
		return { code, text: c.text() };
	};
	const plain = setupScript();
	const dir = tempDir("pi-setup-kinds-");
	const link = join(dir, "link.sh");
	symlinkSync(plain, link);
	const dangling = join(dir, "dangling.sh");
	symlinkSync(join(dir, "nope.sh"), dangling);
	const folder = join(dir, "dir.sh");
	mkdirSync(folder);
	const unreadable = join(dir, "unreadable.sh");
	writeFileSync(unreadable, "#!/bin/sh\n", { mode: 0o000 });
	// L1, L6: the worker's unit names a regular file (directly or through a symlink): softened, exit 0.
	for (const setup of [plain, link]) {
		const r = await run(noPat, { units: [{ setup }] });
		assert.equal(r.code, 0, r.text);
		assert.match(r.text, soft);
	}
	// L7, L9, L10: a dangling symlink, a file this account cannot read, a directory: nothing the service can source.
	if (process.getuid?.() !== 0) {
		for (const setup of [dangling, unreadable, folder]) {
			const r = await run(noPat, { units: [{ setup }] });
			assert.equal(r.code, 1, `${setup}\n${r.text}`);
			assert.match(r.text, hard);
		}
	}
	// L2: a unit for ANOTHER folder names a script: not this deployment's; doctor found no service for this folder.
	const other = await run(noPat, { units: [{ setup: plain, other: true }] });
	assert.equal(other.code, 1);
	assert.match(other.text, /doctor found no service installed for this folder to read\n/);
	// L4, L5: this shell's PI_ENV_SETUP, with this folder's unit rendered without --env-setup, or with no unit at all.
	for (const units of [[{ setup: null }], []]) {
		const r = await run({ ...noPat, PI_ENV_SETUP: plain }, { units });
		assert.equal(r.code, 1, r.text);
		assert.match(r.text, hard);
		assert.ok(r.text.includes(`. PI_ENV_SETUP in this shell is not what the service runs: install with \`pi-dispatch service install --env-setup ${plain}\`\n`), r.text);
		assert.doesNotMatch(r.text, /doctor: ready/);
	}
	// L13: the worker's unit names no script, the receiver's does: the worker reads the PAT and the provider key.
	const recv = await run(noPat, { units: [{ setup: null }, { setup: plain, which: "receiver" }] });
	assert.equal(recv.code, 1);
	assert.match(recv.text, hard);
	// And a receiver's script with no worker service installed at all: the worker is the reader that must name one.
	const recvOnly = await run(noPat, { units: [{ setup: plain, which: "receiver" }] });
	assert.match(recvOnly.text, hard);
	// A shared credential needs every installed reader's script: the worker's alone does not cover a receiver without one.
	const half = await run(noPat, { units: [{ setup: plain }, { setup: null, which: "receiver" }] });
	assert.match(half.text, hard);
	const whole = await run(noPat, { units: [{ setup: plain }, { setup: plain, which: "receiver" }] });
	assert.match(whole.text, soft);
	// ...while a worker-only credential ignores the receiver: the provider key, with the receiver's unit naming none.
	const workerOnly = await run(noKey, { units: [{ setup: plain }, { setup: null, which: "receiver" }] });
	assert.match(workerOnly.text, /⚠ Provider key \(anthropic: [^\n]*\) not set: not visible to doctor/);
	// D1, D2: a launchd plist for this folder names the script; one for another folder does not count.
	const d1 = await run(noPat, { platform: "darwin", units: [{ setup: plain }] });
	assert.match(d1.text, soft);
	const d2 = await run(noPat, { platform: "darwin", units: [{ setup: plain, other: true }] });
	assert.match(d2.text, hard);
	// W1, W4: nssm's worker service names the script; nssm's worker names none while this shell's PI_ENV_SETUP does.
	const nssm = (worker) => fakeSpawn({ ...green, "nssm get pi-dispatch-worker": { code: 0, output: worker }, "nssm get pi-dispatch-receiver": { code: 1, output: "" } });
	const w1 = await run(noPat, { platform: "win32", spawn: nssm(`PI_ENV_SETUP=${plain}\r\n`) });
	assert.match(w1.text, soft);
	const w4 = await run({ ...noPat, PI_ENV_SETUP: plain }, { platform: "win32", spawn: nssm("\r\n") });
	assert.match(w4.text, hard);
	assert.match(w4.text, /PI_ENV_SETUP in this shell is not what the service runs/);
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
	assert.match(text(), /✓ 1 command trigger\(s\): a command is only verifiable in-container -- the runner refuses an unregistered one before the prompt is sent \(command-unregistered\)/);
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
	// The test helper, never the source module: a child doctor must not read a real Valkey's alloc:plan either.
	const doctorUrl = new URL("./helpers/doctor.mjs", import.meta.url).href;
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

// Issue #471 (gate round 2): the deployment .env is read through ONE descriptor; this counts the opens.
const countingEnvFs = (opened) => ({ realpathSync, lstatSync, fstatSync, readFileSync, closeSync, openSync: (p, f) => (opened.push(p), openSync(p, f)) });
function scaffoldedCwd() {
	const dir = tempDir("pi-scaffold-");
	writeFileSync(join(dir, "pause-windows.json"), EMPTY_PAUSE_WINDOWS);
	writeFileSync(join(dir, "subscriptions.json"), JSON.stringify({ version: 1, subscriptions: [] }));
	return dir;
}
const scaffoldDeps = (out, cwd) => ({ out, cwd, spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0" });

/** Doctor's output without the model endpoint rows (issue #503, part 6) and the fix line under each. */
function withoutEndpointRows(output) {
	const lines = output.split("\n");
	const kept = [];
	for (let i = 0; i < lines.length; i++) {
		if (/^. (?:podman: )?Model endpoints?\b/.test(lines[i])) {
			if (lines[i + 1]?.startsWith("    →")) i++;
			continue;
		}
		kept.push(lines[i]);
	}
	return kept.join("\n");
}

// Issue #503: the model endpoints file defaults to the deployment folder's copy, so unset is not off and the scaffold is
// what doctor loads, through the worker's own loader.
test("doctor: an unset PI_MODEL_ENDPOINTS_FILE loads model-endpoints.json from the deployment folder, silent when it loads or is absent (#503)", async () => {
	for (const content of [null, EMPTY_MODEL_ENDPOINTS, JSON.stringify({ version: 1, endpoints: [{ id: "mac", host: "host.docker.internal", port: 11434, slots: 2 }] })]) {
		const cwd = scaffoldedCwd();
		if (content !== null) writeFileSync(join(cwd, "model-endpoints.json"), content);
		const { out, text } = capture();
		const code = await runDoctor(imgEnv(), scaffoldDeps(out, cwd));
		// The boot-file line is what this pins. A declared endpoint also gets the egress section's own rows (#503, part 6),
		// which name it by design and are pinned on their own below, so they are set aside here.
		assert.doesNotMatch(withoutEndpointRows(text()), /PI_MODEL_ENDPOINTS_FILE|model-endpoints/, String(content));
		assert.doesNotMatch(text(), /exists but PI_MODEL_ENDPOINTS_FILE is unset/, "unset is not off for this key");
		assert.equal(code, 0);
	}
});

test("doctor: a default model-endpoints.json that does not load fails, with the loader's own reason (#503)", async () => {
	const cases = [
		["", /not valid JSON/], // a zero-byte file is not the empty declaration: it does not parse, and refuses the start
		[JSON.stringify({ version: 2, endpoints: [] }), /written by a newer pi-dispatch/],
		[JSON.stringify({ version: 1, endpoints: [{ id: "lo", host: "localhost", port: 11434, slots: 1 }] }), /loopback/],
		[JSON.stringify({ version: 1, endpoints: [{ id: "q", host: "valkey.lan", port: 6390, slots: 1 }] }), /job queue's \(VALKEY_URL\)/],
	];
	for (const [content, reason] of cases) {
		const cwd = scaffoldedCwd();
		writeFileSync(join(cwd, "model-endpoints.json"), content);
		const { out, text } = capture();
		const code = await runDoctor(imgEnv({ VALKEY_URL: "redis://127.0.0.1:6390" }), scaffoldDeps(out, cwd));
		// The worker loads this file at boot (start.mjs), so a bad one refuses the start, said in the other boot files' words.
		assert.match(text(), /✗ PI_MODEL_ENDPOINTS_FILE is unset, so the worker reads model-endpoints\.json in the deployment folder, and it does not load: the worker REFUSES TO START: /, content);
		assert.match(text(), reason, content);
		assert.equal(code, 1);
	}
});

test("doctor: with VALKEY_URL unset, an endpoint on 6379 fails as the worker's default queue port (#503 review)", async () => {
	// The worker's config defaults VALKEY_URL and refuses the endpoint; doctor must reach the same verdict, from the same
	// constant, rather than read an unset URL as "no queue port".
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, "model-endpoints.json"), JSON.stringify({ version: 1, endpoints: [{ id: "q", host: "valkey.lan", port: 6379, slots: 1 }] }));
	const { out, text } = capture();
	const env = imgEnv();
	assert.equal(env.VALKEY_URL, undefined);
	const code = await runDoctor(env, scaffoldDeps(out, cwd));
	assert.match(text(), /✗ PI_MODEL_ENDPOINTS_FILE is unset, .* port 6379 is the job queue's \(VALKEY_URL\)/);
	assert.equal(code, 1);
	assert.throws(() => loadModelEndpoints(loadConfig({}), { cwd }), /port 6379 is the job queue's/, "the worker's own config refuses it too");
});

test("doctor: a PI_MODEL_ENDPOINTS_FILE naming no file, or set empty, fails in this shell (#503)", async () => {
	const cwd = scaffoldedCwd();
	for (const [value, re] of [[join(cwd, "nope.json"), /✗ PI_MODEL_ENDPOINTS_FILE is set in this shell to a file the worker cannot load, so it REFUSES TO START: .*nope\.json does not exist/], ["", /✗ PI_MODEL_ENDPOINTS_FILE is set to an EMPTY value in this shell, which is not unset: the worker keeps it, tries to load "" and REFUSES TO START/]]) {
		const { out, text } = capture();
		const code = await runDoctor(imgEnv({ PI_MODEL_ENDPOINTS_FILE: value }), scaffoldDeps(out, cwd));
		assert.match(text(), re);
		assert.equal(code, 1);
	}
});

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

test("doctor: a BLANK PI_MODEL_ENDPOINTS_FILE in the .env is a refused boot, in the other boot files' words (#503)", async () => {
	// The worker loads the endpoints file at boot (start.mjs, since PR #518), so an empty value refuses the start like
	// the two keys above, and deleting the line falls back to the folder's copy rather than turning anything off.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "PI_MODEL_ENDPOINTS_FILE=\n");
	const { out, text } = capture();
	const code = await runDoctor(imgEnv(), scaffoldDeps(out, cwd));
	assert.match(text(), /✗ PI_MODEL_ENDPOINTS_FILE is assigned an EMPTY value in .*\.env, which is not unset: .* the worker tries to load "" and REFUSES TO START/);
	assert.match(text(), /Deleting it reads model-endpoints\.json in the deployment folder instead; an empty value turns the worker off/);
	assert.doesNotMatch(text(), /no endpoint usable|REFUSES THE FILE/);
	assert.equal(code, 1);
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

test("doctor: this shell's PI_ENV_SETUP softens no boot-file refusal; the installed unit's script does (#384, #481)", async () => {
	// The setup script runs AFTER the file on every platform, so it can supply or replace what the file says, and a ⚠
	// naming it is right where the SERVICE runs one. Issue #481 (PR #485's final review) CHANGED this: it used to soften
	// on PI_ENV_SETUP in doctor's own shell, which the service does not run, so a deployment whose unit names no script
	// passed doctor and then refused to boot. The unit-named case is the round-3 test below.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "PI_PAUSE_WINDOWS_FILE=\n");
	const setup = join(cwd, "env-setup.sh");
	writeFileSync(setup, "#!/bin/sh\n");
	const { out, text } = capture();
	const code = await runDoctor(imgEnv({ PI_ENV_SETUP: setup }), scaffoldDeps(out, cwd));
	assert.match(text(), /✗ PI_PAUSE_WINDOWS_FILE is assigned an EMPTY value/, "the finding stands, as a failure");
	assert.doesNotMatch(text(), /runs after that file and may replace it/, "no script the service runs was seen");
	assert.equal(code, 1);
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

// Issue #481 (PR #485 review round 3): the boot-file downgrade asks the one discovery the env-setup lines and the
// credential checks ask (`envSetupSources`): the installed unit's script for this folder, else PI_ENV_SETUP here. It read
// this shell's PI_ENV_SETUP alone, so a unit-named script went unseen, and a shell's could outrank the unit's.
test("the boot-file downgrade sees the env-setup script the installed unit names, and the unit's outranks this shell's (#481)", async () => {
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "PI_PAUSE_WINDOWS_FILE=\n");
	const setup = setupScript({ name: "unit-setup.sh" });
	const { home } = installUnit({ platform: "linux", deployDir: cwd, setup });
	const deps = (out) => ({ ...scaffoldDeps(out, cwd), platform: "linux", home });
	const unitOnly = capture();
	assert.equal(await runDoctor(imgEnv(), deps(unitOnly.out)), 0, unitOnly.text());
	assert.match(unitOnly.text(), /⚠ PI_PAUSE_WINDOWS_FILE is assigned an EMPTY value/);
	assert.ok(unitOnly.text().includes(`${setup} runs after that file and may replace it`), unitOnly.text());
	const other = join(cwd, "shell-setup.sh");
	writeFileSync(other, "#!/bin/sh\n");
	const both = capture();
	await runDoctor(imgEnv({ PI_ENV_SETUP: other }), deps(both.out));
	assert.ok(both.text().includes(`${setup} runs after that file and may replace it`), both.text());
	assert.ok(!both.text().includes(`${other} runs after that file`), "the file that boots is the answer, not this shell");
});

// Issue #481 (PR #485 review round 3): a credential doctor accepted as expected from an env-setup script reaches only the
// service, which runs that script, so the ready line never sends the operator to a hand-started worker.
test("the ready line points at the service when a credential is expected from an env-setup script (#481)", async () => {
	const setup = setupScript();
	const deployDir = tempDir("pi-deploy-");
	const { home, path: unit } = installUnit({ platform: "linux", deployDir, setup });
	const { GITHUB_PAT: _p, ...noPat } = seamEnv();
	const c = capture();
	assert.equal(await runDoctor(noPat, seamDeps(c.out, { cwd: deployDir, home })), 0, c.text());
	assert.ok(
		c.text().endsWith(`\ndoctor: ready. Start the worker as the service: \`pi-dispatch service restart\` (the service installed for this folder, ${unit}). The service runs the env-setup script ${setup} first, which doctor expects to export GITHUB_PAT; a worker started by hand (\`pi-dispatch worker\`) runs no env-setup script, so it starts without that unless this shell exports it.\n`),
		c.text(),
	);
	// The same script, nothing expected from it: the advice is unchanged.
	const plain = capture();
	await runDoctor(seamEnv(), seamDeps(plain.out, { cwd: deployDir, home }));
	assert.ok(plain.text().endsWith("\ndoctor: ready. Start the worker with `pi-dispatch worker`.\n"), plain.text());
});

test("startAdvice joins the .env reason and the env-setup reason, and names each expected credential (#481)", () => {
	const fromSetup = { script: "/etc/pi/setup.sh", names: ["GITHUB_PAT", "one of A or B"] };
	const both = startAdvice({ tookFromFile: true, envPath: "/d/.env", unit: null, platform: "linux", fromSetup });
	assert.match(both, /^Start the worker as the service, whose loader reads \/d\/\.env as doctor did: `pi-dispatch service install`\./);
	assert.ok(both.endsWith(" The service also runs the env-setup script /etc/pi/setup.sh first, which doctor expects to export GITHUB_PAT, one of A or B; a worker started by hand (`pi-dispatch worker`) runs no env-setup script, so it starts without those unless this shell exports them."), both);
	assert.equal(startAdvice({ tookFromFile: false, envPath: "/d/.env", unit: null, platform: "linux" }), "Start the worker with `pi-dispatch worker`.");
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
	await runDoctor(imgEnv(), { ...scaffoldDeps(out, cwd), envFs: countingEnvFs(asked), readEnvFile: (path) => assert.fail(`a second read of ${path}`) });
	assert.deepEqual(asked, [realpathSync(join(cwd, ".env"))], "one file, opened once, and read through that descriptor alone");
	// Issue #453 (gate round 2) widened the read by exactly the keys the service takes from this file and a doctor's
	// shell does not: the venue keys, VALKEY_URL, PI_PROVIDER and the provider's key (its presence); issue #471 by every
	// other service key doctor judges, PI_JOB_IMAGE among them, each said with its source. A key the service does not
	// take from the file (PI_ENV_SETUP, which the unit carries) still reaches nothing.
	assert.ok(!text().includes("/tmp/evil.sh"), "PI_ENV_SETUP came out of .env and must reach nothing");
	assert.ok(text().includes(`Job image present (never-read:from-env-file) -- PI_JOB_IMAGE read from ${join(cwd, ".env")}, as the service reads it`), text());
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
		envFs: {
			...countingEnvFs([]),
			openSync: () => {
				throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			},
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

// Issue #471: a forge URL is printed as scheme, host, port and path only, as a Valkey URL is: one read from .env now
// reaches these lines, and a URL may carry a token in its userinfo.
test("doctor: a forge URL in a configured line never prints its credentials (#471)", async () => {
	const cases = [
		["gitlab", { GITLAB_TOKEN: "glpat_x", GITLAB_URL: "https://user:glpat_in_url@gitlab.example/" }, /✓ gitlab triggers configured \(https:\/\/gitlab\.example\)/],
		["forgejo", { FORGEJO_URL: "https://bot:fj_in_url@code.example.org", FORGEJO_WEBHOOK_SECRET: "s", FORGEJO_TOKEN: "t" }, /✓ forgejo triggers configured \(https:\/\/code\.example\.org\)/],
		["azure", { AZURE_WEBHOOK_MODE: "basic", AZURE_WEBHOOK_SECRET: "s", AZURE_TOKEN: "t", AZURE_ORG_URL: "https://pat:az_in_url@dev.azure.com/acme" }, /✓ azure triggers configured \(https:\/\/dev\.azure\.com\/acme\)/],
	];
	for (const [kind, vars, line] of cases) {
		const { out, text } = capture();
		await runDoctor(imgEnv({ PI_TRIGGERS_FILE: forgeTriggersFile(kind), ...vars }), imgDeps(out, green));
		assert.match(text(), line, kind);
		assert.doesNotMatch(text(), /_in_url/, `${kind}: no credential from the URL`);
	}
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
	// Issue #468 with #471's rule: doctor starts no Valkey (its start needs the deployment's password in a child's
	// environment); the fix line names `pi-dispatch up`.
	assert.match(text(), /✗ Valkey reachable \(redis:\/\/127\.0\.0\.1:6379\)\n    → run `pi-dispatch up` in the deployment folder: it starts Valkey with the deployment's VALKEY_PASSWORD/);
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
	// Issue #468 with #471's rule: no Valkey offer any more, only the image's.
	assert.doesNotMatch(text(), /fix available: Valkey reachable/);
	assert.match(text(), /skipped: Job image present \(pi-job:latest\)/);
	assert.deepEqual(prompts, ["run this? [y/N] "]);
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
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_fixture" },
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

// Issue #468 with issue #471's rule (PR #474): doctor hands no program anything from `.env`, and a Valkey `up` or
// compose starts takes the deployment's VALKEY_PASSWORD from there, so `doctor --fix` starts no Valkey at all: the check
// carries no offer, and its fix line names `pi-dispatch up`, which starts it with the password, labels its container and
// volume with the folder, and asks before it uses a volume it cannot attribute.
test("doctor --fix starts no Valkey: the unreachable check names `pi-dispatch up` and offers nothing (#468 over #471)", async () => {
	const calls = [];
	const { out, text } = capture();
	const { fn: promptFn, calls: prompts } = promptRecorder(true);
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_fixture" },
		{ out, cwd: tmpdir(), spawn: fakeSpawn({ ...EGRESS_OK, "docker info": 0, "docker image": 0, "docker run": 0 }, calls), probeValkey: async () => false, fileExists: () => true, nodeVersion: "22.19.0", fix: true, promptFn },
	);
	assert.equal(code, 1);
	assert.ok(!calls.some((c) => c.cmd === "docker" && ["run", "volume", "start", "compose"].includes(c.args[0]) && c.args.join(" ").includes("valkey")), "nothing started for Valkey");
	assert.deepEqual(prompts, [], "no offer to accept");
	assert.match(text(), /✗ Valkey reachable \(redis:\/\/127\.0\.0\.1:6379\)\n    → run `pi-dispatch up` in the deployment folder: it starts Valkey with the deployment's VALKEY_PASSWORD \(or, in a folder \/dispatch setup handed to compose, compose's own: `docker compose -p <folder name> --env-file \.env -f deploy\/docker-compose\.yml -f deploy\/docker-compose\.valkey\.yml up -d valkey`\)\n/);
});

test("doctor prints which resume bounds are on, so an unset one is legible as a choice", async () => {
	const { out, text } = capture();
	await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_SESSIONS_DIR: "/srv/pi-sessions", PI_TRIGGERS_FILE: resumeTriggersFile(), GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_fixture" },
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
	const env = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_SESSIONS_DIR: "/srv/pi-sessions", PI_TRIGGERS_FILE: resumeTriggersFile(), GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_fixture" };
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
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_SESSIONS_DIR: "/srv/pi-sessions", PI_SESSION_MAX_CONTEXT_PCT: "80", GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_fixture" },
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
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_SESSIONS_DIR: sessionsDir, PI_TRIGGERS_FILE: resumeTriggersFile(), GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_fixture" },
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
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_fixture" },
		// The proxy's mounts are this folder's (issue #480): init now scaffolds the files it mounts, so doctor compares them.
		{ out, cwd, spawn: fakeSpawn({ ...green, [PROXY_KEY]: proxyAnswer("healthy", "running", { cwd, include: join(cwd, "model-endpoints.conf") }) }), probeValkey: async () => true, nodeVersion: "22.19.0", fix: true, promptFn },
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
	assert.match(text(), /\nNext \(the podman venue; run these as the worker's own account\. First set the account up as the Podman guide's "Setup"\n/);
	assert.match(text(), / {2}6\. pi-dispatch doctor --live {26}# read the bounds, egress and job user back off real containers\n/);
	assert.doesNotMatch(text(), /docker compose -f deploy\/docker-compose\.yml up -d {2}# the durable queue/);
});

test("doctor --fix: accepting the overlay auth.json offer deletes the file and converges credential-free", async () => {
	const dir = overlay({ auth: true });
	const cwd = tempDir("pi-fix-auth-");
	const { fn: promptFn, calls: prompts } = promptRecorder(true);
	const { out, text } = capture();
	const code = await runDoctor(overlayEnv(dir, { GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_fixture" }), {
		out,
		cwd,
		// This folder's mounts (issue #480): the --fix pass runs init here, which scaffolds the files the proxy mounts.
		spawn: fakeSpawn({ ...green, [PROXY_KEY]: proxyAnswer("healthy", "running", { cwd, include: join(cwd, "model-endpoints.conf") }) }),
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
	const env = overlayEnv(dir, { GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_fixture" });
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
	// Issue #471: a store the deployment's .env names, not this shell, is shown and asked for.
	[/^Session store (exists|does not exist) \([^)]*\) -- PI_SESSIONS_DIR read from /, "prompt"],
	[/^Session store (exists|does not exist) \(/, "silent"],
	[/^Job image present \(pi-job:latest\)$/, "prompt"],
	// Issue #433: the podman venue's own image line, the image check of a deployment without `local`.
	[/^podman: job image is not in this account's Podman store \(pi-job:latest\)$/, "prompt"],
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
	// PR #551's review: never the default, which opens a Valkey connection to scan for dollar counters.
	dollarKeysExist: async () => false,
	// Issue #504 part B: never the default, which reads alloc:plan off a Valkey.
	readAppliedSplit: async () => null,
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
	for (const expected of [/^\.env present$/, /^Job image present \(pi-job:latest\)$/, /^Overlay is credential-free/, /^Staged packages present/, /^Session store does not exist/]) {
		assert.ok(carried.some((l) => expected.test(l)), `fixture failed to produce a fixAction for ${expected}`);
	}
	assert.equal(carried.length, 5, "exactly the eligible checks carry one, no more");
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
	// `pi-dispatch up` only (PR #488's review): a compose line here would start a second Valkey in a setup folder.
	assert.match(text(), /→ `pi-dispatch up` from the deployment folder starts it {2}-- /);
	assert.doesNotMatch(text(), /--profile egress up -d/);
});

test("doctor: a directory where one of the proxy's two files belongs is a failure naming it (PR #488's review)", async () => {
	const { out, text } = capture();
	const code = await runDoctor(ghEnv({ PI_EGRESS: "1" }), { ...ghDeps(out, egressPlan({ [PROXY_KEY]: proxyAnswer("healthy", "running"), "gh auth status": { code: 0, output: ghStatusOutput } })), proxyFileIsDirectory: (p) => p.endsWith(join("deploy", "egress-proxy.conf")) });
	assert.equal(code, 1);
	assert.match(text(), /✗ deploy\/egress-proxy\.conf in this folder is a directory, not a file\n {4}→ the egress proxy mounts it where squid reads a file, so it cannot start from this folder: remove the directory, then `pi-dispatch init` writes the file \(create-only\)/);
	assert.doesNotMatch(text(), /egress-allowlist\.conf in this folder is a directory/);
	// PI_EGRESS_PROXY's own proxy mounts whatever its operator gave it: not judged.
	const custom = capture();
	await runDoctor(ghEnv({ PI_EGRESS: "1", PI_EGRESS_PROXY: "my-squid" }), { ...ghDeps(custom.out, egressPlan({ [PROXY_KEY]: proxyAnswer("healthy", "running"), "gh auth status": { code: 0, output: ghStatusOutput } })), proxyFileIsDirectory: () => true });
	assert.doesNotMatch(custom.text(), /in this folder is a directory/);
});

// Issue #503's governing rule: the folder's rules include model-endpoints.conf only together with a proxy that mounts
// it. So what a missing include file or a missing third mount costs is decided by whether the rules this proxy runs
// include the file; endpoints declared under rules that predate #503 are the rules refresh's, named in one line.
const PRE_503_RULES = "http_port 3128\n";
const INCLUDE_503_RULES = "http_port 3128\ninclude /etc/pi-dispatch/model-endpoints.conf\n";
function folder503(rules, { include = true, endpoints = null } = {}) {
	const cwd = tempDir("pi-doctor-503-");
	mkdirSync(join(cwd, "deploy"));
	writeFileSync(join(cwd, "deploy", "egress-proxy.conf"), rules);
	writeFileSync(join(cwd, "egress-allowlist.conf"), "api.anthropic.com\n");
	if (include) writeFileSync(join(cwd, "model-endpoints.conf"), "# generated\n");
	if (endpoints) writeFileSync(join(cwd, "model-endpoints.json"), JSON.stringify({ version: 1, endpoints }));
	return cwd;
}
async function doctor503(cwd, answer = proxyAnswer("healthy", "running", { cwd })) {
	const c = capture();
	const code = await runDoctor(ghEnv({ PI_EGRESS: "1" }), { ...ghDeps(c.out, egressPlan({ [PROXY_KEY]: answer, "gh auth status": { code: 0, output: ghStatusOutput } })), cwd });
	return { code, text: c.text() };
}

test("doctor: a missing model-endpoints.conf is ✗ under rules that include it, ⚠ under rules that predate #503; a directory there is ✗ (#503)", async () => {
	const strict = await doctor503(folder503(INCLUDE_503_RULES, { include: false }));
	assert.equal(strict.code, 1);
	assert.match(strict.text, /✗ model-endpoints\.conf is not in this folder\n {4}→ the egress proxy mounts it and its rules include it, and squid will not start without it: `pi-dispatch init` writes it \(create-only\)/);
	const old = await doctor503(folder503(PRE_503_RULES, { include: false }));
	assert.match(old.text, /⚠ model-endpoints\.conf is not in this folder\n {4}→ the proxy's rules here predate #503 and run without it/);
	assert.doesNotMatch(old.text, /✗ model-endpoints\.conf/);
	const cwd = folder503(PRE_503_RULES, { include: false });
	mkdirSync(join(cwd, "model-endpoints.conf"));
	const dir = await doctor503(cwd);
	assert.match(dir.text, /✗ model-endpoints\.conf in this folder is a directory, not a file/);
	assert.doesNotMatch(dir.text, /model-endpoints\.conf is not in this folder/);
});

test("doctor: a two-mount proxy is out of date only under rules that include the file; endpoints under older rules name the rules refresh, never a replace (#503)", async () => {
	const STALE = /✗ Egress proxy is this deployment's proxy but out of date \(pi-dispatch-egress-proxy\): nothing is mounted at \/etc\/pi-dispatch\/model-endpoints\.conf[^\n]*this folder's rules include it, and squid will not start again without it/;
	const current = await doctor503(folder503(PRE_503_RULES));
	assert.doesNotMatch(current.text, /out of date|not this deployment's/, "rules from before #503: a two-mount proxy is current");
	const ENDPOINT = [{ id: "m", host: "host.docker.internal", port: 11434, slots: 1 }];
	const declared = await doctor503(folder503(PRE_503_RULES, { endpoints: ENDPOINT }));
	assert.match(declared.text, /⚠ model endpoints are declared, but deploy\/egress-proxy\.conf predates #503 and does not include model-endpoints\.conf, so the endpoints stay unreachable until the rules are refreshed: `pi-dispatch up`, and accept the refresh/);
	assert.doesNotMatch(declared.text, /out of date|not this deployment's/, "not drift: a replace would cut tunnels and fix nothing");
	const includes = folder503(INCLUDE_503_RULES, { endpoints: ENDPOINT });
	const stale = await doctor503(includes);
	assert.match(stale.text, STALE);
	assert.doesNotMatch(stale.text, /predates #503/);
	assert.doesNotMatch((await doctor503(includes, proxyAnswer("healthy", "running", { cwd: includes, include: join(includes, "model-endpoints.conf") }))).text, /out of date|not this deployment's/);
	const elsewhere = tempDir("pi-doctor-503-other-");
	writeFileSync(join(elsewhere, "model-endpoints.conf"), "# other\n");
	assert.match((await doctor503(includes, proxyAnswer("healthy", "running", { cwd: includes, include: join(elsewhere, "model-endpoints.conf") }))).text, /not this deployment's[^\n]*its \/etc\/pi-dispatch\/model-endpoints\.conf is .*pi-doctor-503-other-.*model-endpoints\.conf, not /);
});

// Issue #503, part 6: each declared model endpoint proved through the proxy, the include read inside the proxy, the
// measured route per runtime, and the two static warnings. The canary's own three probes run first and read as before.
const MAC = { id: "mac-ollama", host: "host.docker.internal", port: 11434, slots: 1 };
const ENDPOINT_PROBE = "docker run --rm --name pi-dispatch-egress-probe-endpoint-";
const INCLUDE_CAT = "docker exec pi-dispatch-egress-proxy cat /etc/pi-dispatch/model-endpoints.conf";
const declaredInclude = (endpoints) => renderEndpointsInclude(parseModelEndpoints(JSON.stringify({ version: 1, endpoints }), "test"));
const ENDPOINT_OK = { models: { code: 0, output: "reached 200\n" }, nextport: { code: 3, output: "tunnel 403\n" }, plain: { code: 3, output: "blocked 403 ERR_ACCESS_DENIED 0\n" } };
const DESKTOP_FACTS = { ServerVersion: "27.4.0", OperatingSystem: "Docker Desktop", SecurityOptions: ["name=seccomp,profile=builtin"], PidsLimit: true, MemoryLimit: true };
const ENGINE_2913_FACTS = { ServerVersion: "29.1.3", OperatingSystem: "Ubuntu 24.04", SecurityOptions: ["name=seccomp,profile=builtin"], PidsLimit: true, MemoryLimit: true };
async function doctorEndpoints({ endpoints = [MAC], answers = {}, inside, insideAnswer, hostFile, includeSource, proxy = "pi-dispatch-egress-proxy", facts = DESKTOP_FACTS, rules = INCLUDE_503_RULES, cwd = folder503(rules, { endpoints: endpoints.length > 0 ? endpoints : null }), home = tempDir("pi-home-503-"), calls = [] } = {}) {
	writeFileSync(join(cwd, "model-endpoints.conf"), hostFile ?? declaredInclude(endpoints));
	const probes = Object.fromEntries(endpoints.flatMap((e) => ENDPOINT_PROBE_SLUGS.map((slug) => [`${ENDPOINT_PROBE}${slug}-${e.id}-`, answers[slug] ?? ENDPOINT_OK[slug]])));
	const plan = {
		...probes,
		[`docker exec ${proxy} cat /etc/pi-dispatch/model-endpoints.conf`]: insideAnswer ?? { code: 0, output: inside ?? declaredInclude(endpoints) },
		...egressPlan({ [PROXY_KEY]: proxyAnswer("healthy", "running", { cwd, include: includeSource === undefined ? join(cwd, "model-endpoints.conf") : includeSource }), "gh auth status": { code: 0, output: ghStatusOutput } }),
		"docker info": { code: 0, output: `${JSON.stringify(facts)}\n` },
	};
	const checks = await collectChecks(ghEnv({ PI_EGRESS: "1", ...(proxy === "pi-dispatch-egress-proxy" ? {} : { PI_EGRESS_PROXY: proxy }) }), { ...ghDeps(() => {}, plan, calls, { pid: 7, platform: "darwin", home, hostAddresses: () => undefined }), cwd });
	let text = "";
	const failed = render(checks, (s) => (text += s));
	return { checks, text, failed, calls, cwd };
}

test("doctor: each declared model endpoint is proved through the proxy by three probes named by its id, and the canary reads as before (#503)", async () => {
	const { checks, text, failed, calls } = await doctorEndpoints();
	assert.equal(failed, false, text);
	assert.match(text, /✓ Model endpoint mac-ollama \(host\.docker\.internal:11434\): host\.docker\.internal works from the proxy \(measured 2026-09-30, Docker Desktop 4\.37\.2 \(engine 27\.4\.0\), macOS\)\. Nothing to add\./);
	assert.match(text, /✓ Model endpoints: the include inside the running proxy matches model-endpoints\.json \(mac-ollama\)\n/);
	assert.match(text, /✓ Model endpoint mac-ollama answers through the proxy \(GET http:\/\/host\.docker\.internal:11434\/v1\/models through a CONNECT tunnel: 200\)\n/);
	assert.match(text, /✓ Model endpoint mac-ollama's rule is port-exact \(a CONNECT to host\.docker\.internal:11435, a port nobody declared, got the proxy's 403\)\n/);
	assert.match(text, /✓ Model endpoint mac-ollama admits no plain forward request \(GET http:\/\/host\.docker\.internal:11434\/v1\/models without a tunnel got the proxy's 403 ERR_ACCESS_DENIED\)\n/);
	assert.ok(calls.some((c) => c.args.join(" ") === "exec pi-dispatch-egress-proxy cat /etc/pi-dispatch/model-endpoints.conf"), "the include is read inside the proxy");
	const runs = calls.filter((c) => c.args[0] === "run").map((c) => c.args);
	assert.deepEqual(
		runs.map((a) => a[a.indexOf("--name") + 1]),
		[...CANARY_PROBE_SLUGS.map((s) => egressCanaryProbe(s, 7)), ...ENDPOINT_PROBE_SLUGS.map((s) => egressEndpointProbe(s, "mac-ollama", 7))],
		"the canary's three, then the endpoint's three, on one network",
	);
	assert.ok(runs.slice(3).every((a) => a.includes("--network=pi-dispatch-egress-doctor-7") && a.includes("HTTP_PROXY=http://pi-dispatch-egress-proxy:3128")), "a job's plain-HTTP proxy rides the endpoint probes");
	assert.ok(!runs.slice(0, 3).some((a) => a.includes("HTTP_PROXY=http://pi-dispatch-egress-proxy:3128")), "the canary's own argv is unchanged");
	assert.equal(runs[3].at(-1), egressEndpointScript("http://host.docker.internal:11434/v1/models"));
	assert.equal(runs[4].at(-1), egressEndpointScript("http://host.docker.internal:11435/v1/models"));
	assert.equal(runs[5].at(-1), egressCanaryPlainScript("http://host.docker.internal:11434/v1/models", { proxyUrl: "http://pi-dispatch-egress-proxy:3128" }));
	assert.deepEqual(checks.filter((c) => c.readBack).map((c) => c.readBack.probe), ["provider", "unlisted", "plainhttp"], "the egress verdict reads exactly the canary's three");
	assert.ok(calls.findIndex((c) => c.args.slice(0, 2).join(" ") === "network rm") > calls.findLastIndex((c) => c.args[0] === "run"), "the network goes after the last endpoint probe");
	// docs/egress.md's sample is these lines, in this order: generated here, so the page cannot drift from what doctor prints.
	const doc = readFileSync(new URL("../../docs/egress.md", import.meta.url), "utf8");
	const sample = checks.filter((c) => c.endpointProbe || /^Model endpoints: the include/.test(c.label)).map((c) => `✓ ${c.label}\n`).join("");
	assert.ok(doc.includes(sample), "docs/egress.md shows the include line and the three probe lines exactly");
});

test("doctor: an endpoint probe fails on a silent server, a rule that is not port-exact and a plain request let through, and shows the proxy's status (#503)", async () => {
	const line = async (answers, slug) => {
		const { checks } = await doctorEndpoints({ answers });
		const found = checks.filter((c) => c.endpointProbe?.probe === slug);
		assert.equal(found.length, 1);
		assert.equal(found[0].ok, false, found[0].label);
		assert.equal(found[0].warn, true, "the network has to answer, so a probe line is warn-tier, as the canary's are");
		return found[0];
	};
	const silent = await line({ models: { code: 3, output: "tunnel 503\n" } }, "models");
	assert.equal(silent.label, "Model endpoint mac-ollama does NOT answer: the proxy allowed the tunnel to host.docker.internal:11434 and answered 503, so nothing answered there");
	assert.match(silent.fix, /start the model server/);
	assert.match((await line({ models: { code: 3, output: "tunnel 403\n" } }, "models")).label, /refused the tunnel to host\.docker\.internal:11434 with 403/);
	assert.match((await line({ models: { code: 0, output: "reached 404\n" } }, "models")).label, /GET \/v1\/models answered 404, not 200$/);
	// Gate round 1, item 5: a server that took the connection and never answered is not told to start.
	const stuck = await line({ models: { code: 6, output: "blocked TimeoutError\n" } }, "models");
	assert.equal(stuck.label, "Model endpoint mac-ollama does NOT answer: it accepted the connection but did not answer /v1/models within 15 s");
	assert.doesNotMatch(stuck.fix, /start the model server/);
	assert.match((await line({ models: { code: 6, output: "blocked ECONNREFUSED\n" } }, "models")).label, /no answer came back through the proxy \(ECONNREFUSED\)/);
	// Gate round 1, item 6: the server's own 401 or 403 through the tunnel proves the route and the rule; it wants a key.
	for (const status of [401, 403]) {
		const keyed = await line({ models: { code: 0, output: `reached ${status}\n` } }, "models");
		assert.equal(keyed.label, `Model endpoint mac-ollama: the route through the proxy works (the tunnel to host.docker.internal:11434 opened), and the server wants a key (GET /v1/models answered ${status})`);
		assert.match(keyed.fix, /declare it without "keyless" and give its provider its key/);
	}
	assert.match(silent.fix, /on Docker Engine that is 172\.17\.0\.1 or 0\.0\.0\.0/, "docker's advice on docker");
	assert.match((await line({ models: 125 }, "models")).label, /^Model endpoint mac-ollama: the models probe did not run \(docker run exited 125\)$/);
	const open = await line({ nextport: { code: 3, output: "tunnel 503\n" } }, "nextport");
	assert.equal(open.label, "Model endpoint mac-ollama's rule is NOT shown to be port-exact: the proxy let a CONNECT to host.docker.internal:11435, a port nobody declared, through and answered 503 (nothing listens there)");
	// A 403 that the SERVER sent through an open tunnel is not the proxy's refusal.
	assert.match((await line({ nextport: { code: 0, output: "reached 403\n" } }, "nextport")).label, /was let through, and something there answered 403/);
	const plain = await line({ plain: { code: 0, output: "reached 200 \n" } }, "plain");
	assert.equal(plain.label, "Model endpoint mac-ollama admits a plain forward request: GET http://host.docker.internal:11434/v1/models without a tunnel got 200, not the proxy's 403 ERR_ACCESS_DENIED");
	// A bare 403, with no squid error header, may be the server's own answer to a request the proxy forwarded.
	assert.match((await line({ plain: { code: 0, output: "reached 403 \n" } }, "plain")).label, /got 403, not the proxy's 403 ERR_ACCESS_DENIED/);
});

test("doctor: the include is compared INSIDE the running proxy, so a stale copy there is ✗ even when this folder's file matches (#503)", async () => {
	// Not rendered since the declaration changed: the folder and the proxy agree with each other and not with the JSON.
	const old = declaredInclude([]);
	const stale = await doctorEndpoints({ inside: old, hostFile: old });
	assert.equal(stale.failed, true);
	assert.match(stale.text, /✗ Model endpoints: the include inside the running proxy \(\/etc\/pi-dispatch\/model-endpoints\.conf in pi-dispatch-egress-proxy\) does not match model-endpoints\.json \(mac-ollama\), so a reload would not load the declared rules\n {4}→ `pi-dispatch egress render` in the deployment folder, then `docker exec pi-dispatch-egress-proxy squid -k reconfigure`\. If the render says the file already matches and this line stays, the proxy holds an earlier copy of a file that was replaced rather than written in place, which a reload never sees: `docker rm -f -v pi-dispatch-egress-proxy`, then `pi-dispatch up`/);
	// Rendered, but the folder's file was REPLACED: the container keeps the old inode (measured), so it reads the old rules.
	const replaced = await doctorEndpoints({ inside: old });
	assert.equal(replaced.failed, true);
	assert.match(replaced.text, /✗ Model endpoints: the proxy is mounted on a replaced file: the file it mounts \(\S+model-endpoints\.conf\) differs from what pi-dispatch-egress-proxy reads at \/etc\/pi-dispatch\/model-endpoints\.conf, so it was replaced \(a rename, an editor's save\) rather than written in place, and no reload reaches the proxy\n {4}→ recreate the proxy so it mounts the file anew: `docker rm -f -v pi-dispatch-egress-proxy`, then `pi-dispatch up`/);
	// Gate round 1, item 9: a file replaced by hand with the JSON unchanged, so what the PROXY holds still matches the
	// declaration. The folder's file differing from the proxy's is the finding, whichever of the two matches the JSON.
	const handReplaced = await doctorEndpoints({ hostFile: `${declaredInclude([MAC])}# a hand edit\n` });
	assert.equal(handReplaced.failed, true);
	assert.match(handReplaced.text, /✗ Model endpoints: the proxy is mounted on a replaced file/);
	assert.doesNotMatch(handReplaced.text, /✓ Model endpoints: the include inside the running proxy matches/);
	// Gate round 2: the compare reads the file the proxy MOUNTS (its bind source), never the folder doctor runs in. A
	// proxy mounting another folder's current file is fine, whatever this folder holds.
	const mounted = join(tempDir("pi-doctor-503-mounted-"), "model-endpoints.conf");
	writeFileSync(mounted, declaredInclude([MAC]));
	// Doctor run from a second folder (not the deployment folder, so the proxy's mounts are not judged against it) that
	// holds an include of its own: the proxy mounts the deployment folder's, which is current.
	const second = tempDir("pi-doctor-503-second-");
	writeFileSync(join(second, "model-endpoints.json"), JSON.stringify({ version: 1, endpoints: [MAC] }));
	const elsewhere = await doctorEndpoints({ cwd: second, hostFile: "# this folder's own, not mounted\n", includeSource: mounted });
	assert.match(elsewhere.text, /✓ Model endpoints: the include inside the running proxy matches/);
	assert.doesNotMatch(elsewhere.text, /replaced file/);
	writeFileSync(mounted, "# replaced under the proxy\n");
	assert.match((await doctorEndpoints({ cwd: second, includeSource: mounted })).text, /✗ Model endpoints: the proxy is mounted on a replaced file/, "the mounted file is what is compared");
	// An operator's own proxy (PI_EGRESS_PROXY) is compared the same way, by its own mount.
	const custom = await doctorEndpoints({ proxy: "my-squid", includeSource: mounted });
	assert.match(custom.text, /✗ Model endpoints: the proxy is mounted on a replaced file: the file it mounts \(\S+pi-doctor-503-mounted-\S+model-endpoints\.conf\) differs from what my-squid reads/);
	// No bind at that path, or a source this host cannot read: the compare is skipped, never guessed.
	for (const includeSource of [null, join(tempDir("pi-doctor-503-gone-"), "absent.conf")]) {
		const skipped = await doctorEndpoints({ proxy: "my-squid", hostFile: "# differs\n", includeSource });
		assert.match(skipped.text, /✓ Model endpoints: the include inside the running proxy matches/, String(includeSource));
		assert.doesNotMatch(skipped.text, /replaced file/);
	}
	const unread = await doctorEndpoints({ insideAnswer: { code: 1, output: "" } });
	assert.match(unread.text, /⚠ Model endpoints: the include inside the running proxy could not be read \(`docker exec pi-dispatch-egress-proxy cat \/etc\/pi-dispatch\/model-endpoints\.conf` exited 1\)\n/);
	assert.doesNotMatch(unread.text, /does not match/, "an unread file is not called a mismatch");
});

test("doctor: a route the measurements refute on this runtime is ✗ naming the venue's alias; an unmeasured one is said, not warned (#503)", async () => {
	const HCI = { id: "hci", host: "host.containers.internal", port: 11434, slots: 1 };
	const refuted = await doctorEndpoints({ endpoints: [HCI], facts: ENGINE_2913_FACTS });
	assert.equal(refuted.failed, true);
	assert.match(refuted.text, /✗ Model endpoint hci \(host\.containers\.internal:11434\) has no route from the egress proxy on this runtime: host\.containers\.internal does not work from the proxy \(measured 2026-09-30, Docker Engine 29\.1\.3, Ubuntu 24\.04\)\. The name is not defined on Docker Engine\. Declare host\.docker\.internal\.\n {4}→ declare the host this runtime reaches \(docs\/backends\.md/);
	const unmeasured = await doctorEndpoints({ facts: { ...ENGINE_2913_FACTS, ServerVersion: "28.0.1" } });
	assert.equal(unmeasured.failed, false, unmeasured.text);
	assert.match(unmeasured.text, /✓ Model endpoint mac-ollama \(host\.docker\.internal:11434\): the route from the proxy is not measured here\. No route from the proxy to host\.docker\.internal was measured on docker 28\.0\.1 engine\. docs\/backends\.md lists the measured ones\. The endpoint probes below are the proof/);
});

test("doctor: no declared endpoint is no new line and no new container, and rules that predate the include say only the refresh (#503)", async () => {
	const cwd = folder503(INCLUDE_503_RULES);
	const home = tempDir("pi-home-503-");
	const before = await doctorEndpoints({ endpoints: [], cwd, home });
	writeFileSync(join(cwd, "model-endpoints.json"), EMPTY_MODEL_ENDPOINTS);
	const empty = await doctorEndpoints({ endpoints: [], cwd, home });
	assert.equal(empty.text, before.text, "an empty declaration prints what no file prints");
	for (const run of [before, empty]) {
		assert.doesNotMatch(run.text, /Model endpoint/);
		assert.ok(!run.calls.some((c) => c.args[0] === "exec" || c.args.some((a) => String(a).includes("egress-probe-endpoint-"))), "no exec and no endpoint probe");
	}
	const old = await doctorEndpoints({ rules: PRE_503_RULES });
	assert.match(old.text, /⚠ model endpoints are declared, but deploy\/egress-proxy\.conf predates #503/);
	assert.doesNotMatch(old.text, /Model endpoint/, "the refresh line is the whole story there");
	assert.ok(!old.calls.some((c) => c.args[0] === "exec" || c.args.some((a) => String(a).includes("egress-probe-endpoint-"))));
});

test("doctor: an overlay model on a loopback baseUrl is ⚠, named with its provider, whatever is declared (#503)", async () => {
	assert.deepEqual(
		overlayLoopbackModels({
			providers: {
				"local-ollama": { baseUrl: "http://localhost:11434/v1", models: [{ id: "qwen" }, { id: "remote", baseUrl: "http://host.docker.internal:11434/v1" }] },
				lms: { baseUrl: "http://127.0.0.1:1234/v1" },
				v6: { baseUrl: "http://[::1]:8000/v1", models: [{ id: "a" }] },
				gpu: { baseUrl: "http://gpu.lan:8000/v1", models: [{ id: "m", baseUrl: "http://0.0.0.0:8000" }, { id: "n" }] },
				anthropic: { baseUrl: "https://api.anthropic.com" },
				"bad\u202e": { baseUrl: "http://LOCALHOST./v1" },
			},
		}),
		['"local-ollama"/"qwen" (localhost:11434)', '"lms" (127.0.0.1:1234)', '"v6"/"a" ([::1]:8000)', '"gpu"/"m" (0.0.0.0:8000)', `${quotedShown("bad\u202e")} (localhost:80)`],
	);
	assert.deepEqual(overlayLoopbackModels(null), []);
	assert.deepEqual(overlayLoopbackModels({ providers: [] }), []);
	const overlay = tempDir("pi-overlay-503-");
	writeFileSync(join(overlay, "models.json"), JSON.stringify({ providers: { "local-ollama": { baseUrl: "http://localhost:11434/v1", apiKey: "$PI_DISPATCH_KEYLESS", models: [{ id: "qwen2.5:0.5b" }] } } }));
	const { out, text } = capture();
	await runDoctor(ghEnv({ PI_EGRESS: "0", PI_GLOBAL_PI_DIR: overlay }), { ...ghDeps(out, { ...green, "gh auth status": { code: 0, output: ghStatusOutput } }), fileExists: existsSync });
	assert.match(text(), /⚠ Overlay models\.json points "local-ollama"\/"qwen2\.5:0\.5b" \(localhost:11434\) at a loopback address, which inside a job is the job's own container, so no job reaches that server\n {4}→ serve the model on an address the egress proxy reaches, declare it in model-endpoints\.json/);
});

test("doctor: an overlay model that costs money and asks for no streaming usage is ⚠, named, since every capped call floors (issue #571)", async () => {
	const priced = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
	const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	assert.deepEqual(
		unreportedUsageModels({
			providers: {
				lan: {
					baseUrl: "http://gpu.lan:8000/v1",
					api: "openai-completions",
					compat: { supportsUsageInStreaming: false },
					models: [{ id: "priced", cost: priced }, { id: "free", cost: free }, { id: "nocost" }, { id: "on", cost: priced, compat: { supportsUsageInStreaming: true } }, { id: "tiered", cost: { ...free, tiers: [{ inputTokensAbove: 1, ...priced }] } }, { id: "overridden", cost: free }],
					modelOverrides: { overridden: { cost: { input: 3 } }, priced: {} },
				},
				own: { baseUrl: "http://gpu.lan:8001/v1", models: [{ id: "m", api: "openai-completions", cost: priced, compat: { supportsUsageInStreaming: false } }, { id: "anth", api: "anthropic-messages", cost: priced, compat: { supportsUsageInStreaming: false } }] },
				switched: { baseUrl: "http://gpu.lan:8002/v1", compat: { supportsUsageInStreaming: false }, models: [{ id: "back", cost: priced }], modelOverrides: { back: { compat: { supportsUsageInStreaming: true } } } },
				plain: { baseUrl: "http://gpu.lan:8003/v1", models: [{ id: "x", cost: priced }] },
			},
		}),
		[{ provider: "lan", modelId: "priced" }, { provider: "lan", modelId: "tiered" }, { provider: "lan", modelId: "overridden" }, { provider: "own", modelId: "m" }],
	);
	assert.deepEqual(unreportedUsageModels(null), []);
	assert.deepEqual(unreportedUsageModels({ providers: [] }), []);
	// Builtin models (PR #572's review): a provider-level compat or a modelOverrides entry turns usage off on the catalog's
	// chat models, priced from the catalog with the override's cost applied. The catalog's own flag is not the overlay's.
	const catalogModels = {
		groq: [
			{ id: "priced", api: "openai-completions", cost: priced },
			{ id: "free", api: "openai-completions", cost: free },
			{ id: "made-free", api: "openai-completions", cost: priced },
			{ id: "other-api", api: "anthropic-messages", cost: priced },
			{ id: "redefined", api: "openai-completions", cost: priced },
		],
		openrouter: [{ id: "a", api: "openai-completions", cost: priced }, { id: "b", api: "openai-completions", cost: priced, compat: { supportsUsageInStreaming: false } }],
		mistral: [{ id: "own-false", api: "openai-completions", cost: priced, compat: { supportsUsageInStreaming: false } }],
	};
	const catalog = { builtinChatModels: (p) => catalogModels[p] ?? [], builtinModel: (p, id) => (catalogModels[p] ?? []).find((m) => m.id === id) ?? null };
	assert.deepEqual(
		unreportedUsageModels(
			{
				providers: {
					groq: { models: [{ id: "redefined", cost: free, api: "openai-completions" }], modelOverrides: { priced: { compat: { supportsUsageInStreaming: false } }, free: { compat: { supportsUsageInStreaming: false } }, "made-free": { cost: { input: 0, output: 0 }, compat: { supportsUsageInStreaming: false } }, "other-api": { compat: { supportsUsageInStreaming: false } } }, compat: {} },
					openrouter: { compat: { supportsUsageInStreaming: false }, modelOverrides: { b: { compat: { supportsUsageInStreaming: true } } } },
					mistral: { baseUrl: "http://x" },
				},
			},
			catalog,
		),
		[{ provider: "groq", modelId: "priced" }, { provider: "openrouter", modelId: "a" }],
	);
	// Through doctor with a catalog seam: a modelOverrides entry on a builtin model is named.
	const builtinOverlay = tempDir("pi-overlay-571b-");
	writeFileSync(join(builtinOverlay, "models.json"), JSON.stringify({ providers: { groq: { modelOverrides: { priced: { compat: { supportsUsageInStreaming: false } } } } } }));
	const viaCatalog = capture();
	await runDoctor(ghEnv({ PI_EGRESS: "0", PI_GLOBAL_PI_DIR: builtinOverlay }), { ...ghDeps(viaCatalog.out, { ...green, "gh auth status": { code: 0, output: ghStatusOutput } }), fileExists: existsSync, modelCatalog: async () => ({ ...catalog, checkModelsKnown: () => [] }) });
	assert.match(viaCatalog.text(), /⚠ Overlay models\.json sets compat\.supportsUsageInStreaming to false on "groq"\/"priced" with a nonzero cost table/);
	const overlay = tempDir("pi-overlay-571-");
	writeFileSync(join(overlay, "models.json"), JSON.stringify({ providers: { lan: { baseUrl: "http://gpu.lan:8000/v1", api: "openai-completions", apiKey: "$LAN_KEY", models: [{ id: "qwen", cost: priced, compat: { supportsUsageInStreaming: false } }] } } }));
	const { out, text } = capture();
	await runDoctor(ghEnv({ PI_EGRESS: "0", PI_GLOBAL_PI_DIR: overlay }), { ...ghDeps(out, { ...green, "gh auth status": { code: 0, output: ghStatusOutput } }), fileExists: existsSync });
	assert.match(text(), /⚠ Overlay models\.json sets compat\.supportsUsageInStreaming to false on "lan"\/"qwen" with a nonzero cost table, so those calls report no usage: each counts as costUnreported, and every job that calls one settles at the floor\n {4}→ remove supportsUsageInStreaming: false/);
	writeFileSync(join(overlay, "models.json"), JSON.stringify({ providers: { lan: { baseUrl: "http://gpu.lan:8000/v1", api: "openai-completions", apiKey: "$LAN_KEY", models: [{ id: "qwen", compat: { supportsUsageInStreaming: false } }] } } }));
	const quiet = capture();
	await runDoctor(ghEnv({ PI_EGRESS: "0", PI_GLOBAL_PI_DIR: overlay }), { ...ghDeps(quiet.out, { ...green, "gh auth status": { code: 0, output: ghStatusOutput } }), fileExists: existsSync });
	assert.doesNotMatch(quiet.text(), /supportsUsageInStreaming/, "a zero-rated model reports nothing and costs nothing");
});

test("doctor: a priced model on a declared endpoint whose output cap travels as max_completion_tokens is ⚠, named, since a capped job is refused at its first call (issue #507)", async () => {
	const priced = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
	const free = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	const endpoints = [{ id: "gpu", host: "gpu.lan", port: 8000, slots: 1, keyless: true }];
	assert.deepEqual(
		ignoredOutputCapModels({
			models: {
				providers: {
					lan: {
						baseUrl: "http://gpu.lan:8000/v1",
						api: "openai-completions",
						models: [{ id: "priced", cost: priced }, { id: "free", cost: free }, { id: "fixed", cost: priced, compat: { maxTokensField: "max_tokens" } }, { id: "explicit", cost: priced, compat: { maxTokensField: "max_completion_tokens" } }, { id: "anth", api: "anthropic-messages", cost: priced }, { id: "elsewhere", cost: priced, baseUrl: "http://other.lan:8000/v1" }, { id: "by-override", cost: priced }],
						modelOverrides: { "by-override": { compat: { maxTokensField: "max_tokens" } } },
					},
					whole: { baseUrl: "http://gpu.lan:8000/v1", api: "openai-completions", compat: { maxTokensField: "max_tokens" }, models: [{ id: "a", cost: priced }, { id: "b", cost: priced, compat: { maxTokensField: "max_completion_tokens" } }] },
				},
			},
			endpoints,
		}),
		[{ provider: "lan", modelId: "priced" }, { provider: "lan", modelId: "explicit" }, { provider: "whole", modelId: "b" }],
	);
	assert.deepEqual(ignoredOutputCapModels({ models: { providers: { lan: { baseUrl: "http://gpu.lan:8000/v1", models: [{ id: "x", api: "openai-completions", cost: priced }] } } }, endpoints: [] }), [], "no declared endpoint: nothing to judge");
	assert.deepEqual(ignoredOutputCapModels({ models: null, endpoints }), []);
	// A builtin provider pointed at the endpoint: the catalog's chat models take its baseUrl, priced from the catalog.
	const catalogModels = { groq: [{ id: "g", api: "openai-completions", cost: priced }, { id: "own-field", api: "openai-completions", cost: priced, compat: { maxTokensField: "max_tokens" } }] };
	assert.deepEqual(
		ignoredOutputCapModels({ models: { providers: { groq: { baseUrl: "http://gpu.lan:8000/v1" } } }, endpoints, builtinChatModels: (p) => catalogModels[p] ?? [] }),
		[{ provider: "groq", modelId: "g" }],
	);
	const overlay = tempDir("pi-overlay-507-");
	const write = (model) => writeFileSync(join(overlay, "models.json"), JSON.stringify({ providers: { ollama: { baseUrl: "http://gpu.lan:8000/v1", api: "openai-completions", apiKey: "$PI_DISPATCH_KEYLESS", models: [model] } } }));
	const run = async () => {
		const { out, text } = capture();
		await runDoctor(ghEnv({ PI_EGRESS: "0", PI_GLOBAL_PI_DIR: overlay }), { ...ghDeps(out, { ...green, "gh auth status": { code: 0, output: ghStatusOutput } }), fileExists: existsSync, declaredEndpoints: () => endpoints });
		return text();
	};
	write({ id: "qwen2.5:3b", cost: priced, contextWindow: 32768, maxTokens: 256 });
	assert.match(await run(), /⚠ Overlay models\.json sends the output cap of "ollama"\/"qwen2\.5:3b" as max_completion_tokens to a declared model endpoint, which a local server may ignore \(Ollama does\), so under a dollar cap every call to it is refused as unboundable\n {4}→ set "compat": \{ "maxTokensField": "max_tokens" \} on the model or its provider in models\.json/);
	write({ id: "qwen2.5:3b", cost: priced, contextWindow: 32768, maxTokens: 256, compat: { maxTokensField: "max_tokens" } });
	assert.doesNotMatch(await run(), /maxTokensField|max_completion_tokens/, "the documented fix silences it");
	write({ id: "qwen2.5:3b", cost: free, contextWindow: 32768, maxTokens: 256 });
	assert.doesNotMatch(await run(), /max_completion_tokens/, "a zero-rated model is bounded at 0 and needs no output cap");
	// A capped job that may use it (review of #507): the cost-cap line names it, and the overlay line leaves it out, so
	// one model gets one line.
	write({ id: "qwen2.5:3b", cost: priced, contextWindow: 32768, maxTokens: 256 });
	const capped = capture();
	await runDoctor(ghEnv({ PI_EGRESS: "0", PI_GLOBAL_PI_DIR: overlay, PI_PROVIDER: "ollama", PI_MODEL: "qwen2.5:3b", PI_MAX_COST_USD: "2" }), { ...ghDeps(capped.out, { ...green, "gh auth status": { code: 0, output: ghStatusOutput } }), fileExists: existsSync, declaredEndpoints: () => endpoints });
	assert.match(capped.text(), /⚠ A job under a per-job cost cap may use a model whose output cap travels as max_completion_tokens to a server that may ignore it \(one outside pi's own hosted providers\), so the runner counts every call to it unboundable and refuses it under the cap: ollama\/qwen2\.5:3b \(the main model/);
	assert.doesNotMatch(capped.text(), /Overlay models\.json sends the output cap/, "not twice");
	// A model the overlay adds to a builtin provider with no api of its own (final review of #507): pi takes the api of
	// groq's first openai-completions model, and the provider's proxy baseUrl, so the cost-cap line names it.
	writeFileSync(join(overlay, "models.json"), JSON.stringify({ providers: { groq: { baseUrl: "http://proxy.lan:8080/openai/v1", models: [{ id: "new-groq", cost: priced }] } } }));
	const added = capture();
	await runDoctor(ghEnv({ PI_EGRESS: "0", PI_GLOBAL_PI_DIR: overlay, PI_PROVIDER: "groq", PI_MODEL: "new-groq", PI_MAX_COST_USD: "2" }), { ...ghDeps(added.out, { ...green, "gh auth status": { code: 0, output: ghStatusOutput } }), fileExists: existsSync, declaredEndpoints: () => endpoints });
	assert.match(added.text(), /refuses it under the cap: groq\/new-groq \(the main model/);
});

test("doctor: an allowlist naming a host alias is ⚠, pointing at model-endpoints.json (#503)", async () => {
	assert.deepEqual(allowlistHostAliases("api.anthropic.com\n.HOST.docker.internal # mine\n# host.containers.internal\nfoo.host.containers.internal\n"), [{ alias: "host.docker.internal", entry: ".HOST.docker.internal" }]);
	assert.deepEqual(allowlistHostAliases("host.containers.internal host.docker.internal\n"), [{ alias: "host.docker.internal", entry: "host.docker.internal" }, { alias: "host.containers.internal", entry: "host.containers.internal" }]);
	// Gate round 1, item 7: a dotted entry admits every name under it, so it covers an alias as surely as the alias.
	assert.deepEqual(allowlistHostAliases(".internal\n"), [{ alias: "host.docker.internal", entry: ".internal" }, { alias: "host.containers.internal", entry: ".internal" }]);
	assert.deepEqual(allowlistHostAliases(".docker.internal .containers.internal\n"), [{ alias: "host.docker.internal", entry: ".docker.internal" }, { alias: "host.containers.internal", entry: ".containers.internal" }]);
	assert.deepEqual(allowlistHostAliases("internal\ndocker.internal\n.ost.docker.internal\n"), [], "a bare name admits itself only, and a suffix must end at a dot");
	const cwd = folder503(INCLUDE_503_RULES);
	writeFileSync(join(cwd, "egress-allowlist.conf"), "api.anthropic.com\nhost.docker.internal\n");
	const { text } = await doctorEndpoints({ endpoints: [], cwd });
	const dotted = folder503(INCLUDE_503_RULES);
	writeFileSync(join(dotted, "egress-allowlist.conf"), "api.anthropic.com\n.internal\n");
	assert.match((await doctorEndpoints({ endpoints: [], cwd: dotted })).text, /⚠ egress-allowlist\.conf lists "\.internal", which admits host\.docker\.internal, which lets a job open a CONNECT/);
	assert.match(text, /⚠ egress-allowlist\.conf lists host\.docker\.internal, which lets a job open a CONNECT to that host's port 443 and send plain HTTP to its port 80, and reaches no model server's port\n {4}→ remove it, and declare the model server in model-endpoints\.json instead/);
	const { out, text: off } = capture();
	await runDoctor(ghEnv({ PI_EGRESS: "0" }), { ...ghDeps(out, { ...green, "gh auth status": { code: 0, output: ghStatusOutput } }), cwd });
	assert.doesNotMatch(off(), /egress-allowlist\.conf lists/, "with the policy off the file is no policy");
});

// Gate round 1, item 1: the port-exact probe must ask for a port nobody declared, or a neighbour's own rule answers it.
test("the port-exact probe asks for the nearest port no declaration for that host uses, never 80 or 443 (#503)", async () => {
	const at = (port, host = "srv.lan") => ({ id: `p${port}`, host, port, slots: 1 });
	assert.equal(undeclaredPortNear(at(18080), [at(18080), at(18081), at(18082), at(18083, "other.lan")]), 18083, "skips the same host's declared ports, not another host's");
	assert.equal(undeclaredPortNear(at(442), [at(442)]), 444, "never 443, which the allowlist opens for a listed host");
	assert.equal(undeclaredPortNear(at(79), [at(79)]), 81, "never 80, which the allowlist opens for plain HTTP");
	assert.equal(undeclaredPortNear(at(65535), [at(65535), at(65534)]), 65533, "wraps below the declared port at the top");
	const SRV = { id: "srv", host: "srv.lan", port: 18080, slots: 1 };
	const SRV2 = { id: "srv2", host: "srv.lan", port: 18081, slots: 1 };
	const { text, calls } = await doctorEndpoints({ endpoints: [SRV, SRV2], facts: ENGINE_2913_FACTS });
	const nextport = calls.filter((c) => c.args[0] === "run" && String(c.args[c.args.indexOf("--name") + 1]).includes("-nextport-")).map((c) => c.args.at(-1));
	assert.deepEqual(nextport, [egressEndpointScript("http://srv.lan:18082/v1/models"), egressEndpointScript("http://srv.lan:18082/v1/models")], "neither probes the other's declared port");
	assert.match(text, /✓ Model endpoint srv's rule is port-exact \(a CONNECT to srv\.lan:18082, a port nobody declared/);
	// Gate round 1, item 3: another machine is an ordinary route out, said plainly, not "not measured here" before a
	// sentence naming this very runtime as measured.
	assert.match(text, /✓ Model endpoint srv \(srv\.lan:18080\): srv\.lan is not a route to this host: an ordinary outbound route through the proxy\. Another machine on the LAN was measured reachable/);
	assert.doesNotMatch(text, /srv\.lan:18080\): the route from the proxy is not measured here/);
});

test("doctor on the podman venue judges the route by the helper Podman names, and says so plainly when it names none (#503)", async () => {
	const HCI = { id: "hci", host: "host.containers.internal", port: 11434, slots: 1 };
	const rules = (p) => {
		if (p === `${PODMAN_HOME}/.config/pi-dispatch/egress-proxy.conf`) return INCLUDE_503_RULES;
		throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
	};
	const run = async (info) => {
		const { out, text } = capture();
		await runDoctor(podmanEnv({ PI_EGRESS: "1" }), podmanDeps(out, { "podman exec pi-dispatch-egress-proxy cat": { code: 0, output: declaredInclude([HCI]) }, ...podmanPlan({ proxy: "running", info }) }, [], { platform: "linux", readProxyConf: rules, declaredEndpoints: () => [HCI], hostAddresses: () => undefined }));
		return text();
	};
	assert.match(await run(PODMAN_INFO({ rootlessNetworkCmd: "pasta" })), /✓ podman: Model endpoint hci \(host\.containers\.internal:11434\): host\.containers\.internal works from the proxy \(measured 2026-09-30, Podman 5\.8\.1 rootless, pasta, Fedora\)/);
	const unnamed = await run(PODMAN_INFO());
	assert.match(unnamed, /✓ podman: Model endpoint hci \(host\.containers\.internal:11434\): the rootless network helper was not reported by this Podman, so the route is not judged here\. `pi-dispatch doctor --live` probes it, which is the proof\.\n/);
	assert.doesNotMatch(unnamed, /missing or invalid/, "never worded as a fault");
});

test("a podman endpoint that does not answer gets the podman venue's advice, not docker's (#503)", async () => {
	const HCI = { id: "hci", host: "host.containers.internal", port: 11434, slots: 1 };
	const env = liveEnv({ PI_EGRESS: "1", PI_BACKENDS: "podman" });
	const probe = (slug, answer) => ({ [`podman run --name=pi-dispatch-egress-probe-endpoint-${slug}-hci-`]: answer });
	const held = await podmanLiveChecks(env, podmanEgressSeams({ ...probe("models", { code: 3, output: "tunnel 503\n" }), ...probe("nextport", { code: 3, output: "tunnel 403\n" }), ...probe("plain", { code: 3, output: "blocked 403 ERR_ACCESS_DENIED 0\n" }), [`${PODMAN_PROBE}provider`]: 0, [`${PODMAN_PROBE}unlisted`]: 3 }), podmanEgressFacts({ endpoints: [HCI] }));
	const down = held.find((c) => c.endpointProbe?.probe === "models");
	assert.equal(down.label, "podman: Model endpoint hci does NOT answer: the proxy allowed the tunnel to host.containers.internal:11434 and answered 503, so nothing answered there");
	assert.match(down.fix, /bound to this host's LAN address or 0\.0\.0\.0 \(never 127\.0\.0\.1 alone\), and declare a server on this host as host\.containers\.internal/);
	assert.doesNotMatch(down.fix, /Docker Engine|172\.17\.0\.1/);
});

test("doctor: the leftover sweep removes a dead run's endpoint probes by their exact shape, and only those (#503)", async () => {
	const calls = [];
	const members = ["pi-dispatch-egress-probe-endpoint-models-mac-ollama-4242", "pi-dispatch-egress-probe-endpoint-plain-a-1-4242", `pi-dispatch-egress-probe-endpoint-models-${"a".repeat(33)}-4242`, "pi-dispatch-egress-probe-endpoint-models-mac-ollama-42420", "pi-dispatch-egress-probe-endpoint-other-mac-4242", "pi-dispatch-egress-probe-endpoint-models-MAC-4242", "pi-dispatch-egress-probe-endpoint-nextport-x.y-4242"];
	const plan = {
		"docker network ls --filter name=pi-dispatch-egress-doctor-": { code: 0, output: "pi-dispatch-egress-doctor-4242\n" },
		"docker network inspect --format {{json .Containers}} pi-dispatch-egress-doctor-4242": { code: 0, output: JSON.stringify(Object.fromEntries(members.map((Name, i) => [`c${i}`, { Name }]))) },
		"docker rm -f": 0,
		...green,
		"gh auth status": { code: 0, output: ghStatusOutput },
	};
	const { out } = capture();
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), ghDeps(out, plan, calls, { isAlive: () => false, pid: 1 }));
	assert.deepEqual(calls.filter((c) => c.args[0] === "rm").map((c) => c.args.at(-1)), members.slice(0, 2), "a probe this file builds, for the dead pid, is removed");
	const detached = calls.filter((c) => c.args.slice(0, 2).join(" ") === "network disconnect" && c.args.includes("pi-dispatch-egress-doctor-4242")).map((c) => c.args.at(-1));
	// Gate round 1, item 8: the id class IS the parser's, so an id the parser refuses (33 characters) is never removed.
	assert.equal(MODEL_ENDPOINT_ID_RE.test("a".repeat(33)), false);
	assert.deepEqual(detached.sort(), members.slice(2).sort(), "another pid, an unknown probe, or an id the parser refuses is merely detached");
});

test("lanIPv4Addresses keeps this host's own LAN IPv4 addresses and leaves out loopback, link-local and container bridges (#503)", () => {
	assert.deepEqual(
		lanIPv4Addresses({
			lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }],
			eth0: [{ family: "IPv4", address: "192.168.5.15", internal: false }, { family: "IPv6", address: "fe80::1", internal: false }],
			en1: [{ family: 4, address: "10.0.0.7", internal: false }, { family: "IPv4", address: "169.254.3.4", internal: false }],
			docker0: [{ family: "IPv4", address: "172.17.0.1", internal: false }],
			"br-1a2b": [{ family: "IPv4", address: "172.18.0.1", internal: false }],
			podman1: [{ family: "IPv4", address: "10.89.0.1", internal: false }],
			wlan0: [{ family: "IPv4", address: "192.168.5.15", internal: false }],
		}),
		["192.168.5.15", "10.0.0.7"],
	);
	assert.equal(lanIPv4Addresses({ lo: [{ family: "IPv4", address: "127.0.0.1", internal: true }] }), undefined, "none is omitted, never an empty list");
	assert.equal(lanIPv4Addresses(undefined), undefined);
});

// The tunnelled endpoint script, run for real against a fake proxy in this process, with the repo's own runner module
// in place of the image's: undici's tunnel error text is what doctor's status comes from (measured M9), so it is pinned
// at the version the runner actually loads.
test("the endpoint probe script reports the proxy's status for a refused tunnel, and the server's for one let through (#503)", async () => {
	const { createServer } = await import("node:http");
	const { connect } = await import("node:net");
	const { spawn: spawnChild } = await import("node:child_process");
	const { fileURLToPath } = await import("node:url");
	const runner = join(dirname(fileURLToPath(import.meta.url)), "../../image/runner/src/env-proxy.mjs");
	const model = createServer((req, res) => res.writeHead(req.url === "/v1/models" ? 200 : 404).end("{}"));
	await new Promise((r) => model.listen(0, "127.0.0.1", r));
	const runAgainst = (onConnect) =>
		new Promise((resolve) => {
			const seen = [];
			const proxy = createServer((req, res) => {
				seen.push(`${req.method} ${req.url}`);
				res.writeHead(500).end();
			});
			proxy.on("connect", (req, socket) => {
				seen.push(`CONNECT ${req.url}`);
				onConnect(socket);
			});
			proxy.listen(0, "127.0.0.1", () => {
				const script = egressEndpointScript("http://model.test:11434/v1/models", { timeoutMs: 3000 }).replace(JSON.stringify(EGRESS_CANARY_RUNNER_MODULE), JSON.stringify(runner));
				const { HTTP_PROXY: _a, http_proxy: _b, HTTPS_PROXY: _c, https_proxy: _d, NO_PROXY: _e, no_proxy: _f, ...base } = process.env;
				const child = spawnChild(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"], env: { ...base, NODE_USE_ENV_PROXY: "1", HTTP_PROXY: `http://127.0.0.1:${proxy.address().port}` } });
				let stdout = "";
				let stderr = "";
				child.stdout.on("data", (d) => (stdout += d));
				child.stderr.on("data", (d) => (stderr += d));
				child.on("close", (status) => {
					proxy.closeAllConnections();
					proxy.close(() => resolve({ status, stdout, stderr, seen }));
				});
			});
		});
	try {
		for (const code of [403, 503]) {
			const refused = await runAgainst((socket) => socket.end(`HTTP/1.1 ${code} ${code === 403 ? "Forbidden" : "Service Unavailable"}\r\nContent-Length: 0\r\n\r\n`));
			assert.equal(refused.status, 3, refused.stdout + refused.stderr);
			assert.equal(refused.stdout, `tunnel ${code}\n`);
			assert.deepEqual(refused.seen, ["CONNECT model.test:11434"], "sent as a CONNECT, the way pi sends an http:// provider call");
		}
		const through = await runAgainst((socket) => {
			const upstream = connect(model.address().port, "127.0.0.1", () => {
				socket.write("HTTP/1.1 200 Connection established\r\n\r\n");
				upstream.pipe(socket);
				socket.pipe(upstream);
			});
			socket.on("error", () => upstream.destroy());
			upstream.on("error", () => socket.destroy());
		});
		assert.equal(through.status, 0, through.stdout + through.stderr);
		assert.equal(through.stdout, "reached 200\n");
	} finally {
		model.closeAllConnections();
		await new Promise((r) => model.close(r));
	}
});

test("doctor on the podman venue reads the include inside its proxy, and --live probes each endpoint beside the canary (#503)", async () => {
	const HCI = { id: "hci", host: "host.containers.internal", port: 11434, slots: 1 };
	const rules = (p) => {
		if (p === `${PODMAN_HOME}/.config/pi-dispatch/egress-proxy.conf`) return INCLUDE_503_RULES;
		throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
	};
	const run = async (inside, mounts) => {
		const { out, text } = capture();
		const calls = [];
		const code = await runDoctor(podmanEnv({ PI_EGRESS: "1" }), podmanDeps(out, { "podman exec pi-dispatch-egress-proxy cat": { code: 0, output: inside }, ...(mounts ? { "podman inspect --format {{json .Mounts}} pi-dispatch-egress-proxy": { code: 0, output: `${JSON.stringify(mounts)}\n` } } : {}), ...podmanPlan({ proxy: "running" }) }, calls, { platform: "linux", readProxyConf: rules, declaredEndpoints: () => [HCI], hostAddresses: () => undefined }));
		return { code, text: text(), calls };
	};
	const same = await run(declaredInclude([HCI]));
	assert.match(same.text, /✓ podman: Model endpoint hci \(host\.containers\.internal:11434\): .*`pi-dispatch doctor --live` probes it, which is the proof\.\n/);
	assert.match(same.text, /✓ podman: Model endpoints: the include inside the running proxy matches model-endpoints\.json \(hci\)\n/);
	assert.ok(same.calls.some((c) => c.cmd === "podman" && c.args.join(" ") === "exec pi-dispatch-egress-proxy cat /etc/pi-dispatch/model-endpoints.conf"));
	// Gate round 2: the replaced-file compare reads the bind source the proxy mounts, from `podman inspect`, wherever doctor
	// runs: the Quadlet unit mounts the deployment folder's file, which need not be this one.
	const deployed = join(tempDir("pi-doctor-503-quadlet-"), "model-endpoints.conf");
	writeFileSync(deployed, declaredInclude([HCI]));
	const bind = [{ Type: "bind", Source: deployed, Destination: "/etc/pi-dispatch/model-endpoints.conf" }];
	const current = await run(declaredInclude([HCI]), bind);
	assert.match(current.text, /✓ podman: Model endpoints: the include inside the running proxy matches/);
	assert.ok(current.calls.some((c) => c.args.join(" ") === "inspect --format {{json .Mounts}} pi-dispatch-egress-proxy"));
	writeFileSync(deployed, "# replaced under the proxy\n");
	assert.match((await run(declaredInclude([HCI]), bind)).text, /✗ podman: Model endpoints: the proxy is mounted on a replaced file: the file it mounts \(\S+pi-doctor-503-quadlet-\S+\)/);
	assert.doesNotMatch((await run(declaredInclude([HCI]), [{ Type: "volume", Source: deployed, Destination: "/etc/pi-dispatch/model-endpoints.conf" }])).text, /replaced file/, "no bind there, no compare");
	const stale = await run(declaredInclude([]));
	assert.match(stale.text, /✗ podman: Model endpoints: the include inside the running proxy \([^)]+\) does not match model-endpoints\.json \(hci\)[^\n]*\n {4}→ `pi-dispatch egress render` in the deployment folder, then `podman exec pi-dispatch-egress-proxy squid -k reconfigure`\..*`systemctl --user restart pi-dispatch-egress-proxy\.service`/);

	const env = liveEnv({ PI_EGRESS: "1", PI_BACKENDS: "podman" });
	const calls = [];
	const lines = [];
	const probe = (slug, answer) => ({ [`podman run --name=pi-dispatch-egress-probe-endpoint-${slug}-hci-`]: answer });
	const held = await podmanLiveChecks(
		env,
		{ ...podmanEgressSeams({ ...probe("models", { code: 0, output: "reached 200\n" }), ...probe("nextport", { code: 3, output: "tunnel 403\n" }), ...probe("plain", { code: 3, output: "blocked 403 ERR_ACCESS_DENIED 0\n" }), [`${PODMAN_PROBE}provider`]: 0, [`${PODMAN_PROBE}unlisted`]: 3 }, calls), out: (s) => lines.push(s) },
		podmanEgressFacts({ endpoints: [HCI] }),
	);
	const named = calls.filter((c) => c.args[0] === "run" && String(c.args[1]).startsWith("--name=pi-dispatch-egress-probe-")).map((c) => c.args[1]);
	assert.deepEqual(named, [...CANARY_PROBE_SLUGS.map((s) => `--name=${egressCanaryProbe(s, 1)}`), ...ENDPOINT_PROBE_SLUGS.map((s) => `--name=${egressEndpointProbe(s, "hci", 1)}`)]);
	const models = calls.find((c) => c.args[1] === `--name=${egressEndpointProbe("models", "hci", 1)}`).args;
	assert.deepEqual(models, [...podmanProbeArgv("models", "http://host.containers.internal:11434/v1/models").slice(0, -1).map((a) => a.replace("--name=pi-dispatch-egress-probe-models-1", `--name=${egressEndpointProbe("models", "hci", 1)}`)), egressEndpointScript("http://host.containers.internal:11434/v1/models")], "a podman job's argv, with its own name and the tunnelled GET");
	assert.ok(held.some((c) => c.ok && c.label === "podman: Model endpoint hci answers through the proxy (GET http://host.containers.internal:11434/v1/models through a CONNECT tunnel: 200)"));
	assert.ok(held.some((c) => c.ok && c.label.startsWith("podman: Model endpoint hci's rule is port-exact")));
	assert.ok(held.some((c) => c.ok && c.label.startsWith("podman: Model endpoint hci admits no plain forward request")));
	assert.deepEqual(held.filter((c) => c.readBack).map((c) => c.readBack.probe), ["provider", "unlisted", "plainhttp"]);
	assert.ok(held.some((c) => c.ok && c.label.startsWith("read back on podman: egress holds")), "the verdict reads the canary's three alone");
	assert.match(lines.join(""), /all three are removed when the canary ends; then three per declared model endpoint \(hci\), named pi-dispatch-egress-probe-endpoint-<probe>-<id>-1, removed the same way\n/);
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
	for (const [status, fix] of [["restarting", "its squid keeps exiting and its restart policy keeps bringing it back, so every job is retried once, then failed; `docker logs pi-dispatch-egress-proxy` says why"], ["created", "`pi-dispatch up` from the deployment folder starts it  -- "]]) {
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
		new RegExp(`✗ Egress proxy is running but is not this deployment's \\(pi-dispatch-egress-proxy\\): its /etc/pi-dispatch/allowlist\\.conf is ${esc(join(other, "egress-allowlist.conf"))}, not ${esc(join(folder, "egress-allowlist.conf"))}\\n {4}→ check its mounts \\(\`docker inspect --format '\\{\\{json \\.Mounts\\}\\}' pi-dispatch-egress-proxy\`\\), then \`docker rm -f -v pi-dispatch-egress-proxy\` and \`pi-dispatch up\` from the deployment folder replace it with the shipped one; \`up\` does not offer to on its own while one of its mounts cannot be compared here;`),
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
	// keeping: a name in PROVIDER_STEERING_VARS refuses at LOAD and never reaches this check at all.
	// An early draft of #314 had GEMINI_API_KEY in that set; the set as landed subtracts every key
	// variable, so it is not, and either name would do today. HF_TOKEN stays, and
	// provider-steering.test.mjs pins it outside the set. 37 of the 38 provider key variables (0.99.1 pin)
	// are NOT in that set (the one inside is the retained ANTHROPIC_AUTH_TOKEN), and 32 are not even read by
	// name in a scanned SDK source, so this check still has work to do, and a fixture that is
	// double-covered would have hidden that either way.
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
	// One past the newest version this build reads (3 since issue #596), so the loader's own words name it.
	writeFileSync(path, JSON.stringify({ version: 4, limits: [] }));
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

// ── PI_PROJECTS_FILE, the fourth boot file (issue #499) ─────────────────────────────────────────────────

test("doctor: a scaffolded projects.json with PI_PROJECTS_FILE unset warns; wired, no trap line (#499)", async () => {
	const cwd = tempDir("pi-projects-scaffold-");
	writeFileSync(join(cwd, "projects.json"), JSON.stringify({ version: 1, projects: [] }));
	const { out, text } = capture();
	const code = await runDoctor(imgEnv(), scaffoldDeps(out, cwd));
	assert.ok(text().includes(`⚠ ${join(cwd, "projects.json")} exists but PI_PROJECTS_FILE is unset -- the worker ignores it, so projects are OFF`), text());
	assert.ok(text().includes(`set PI_PROJECTS_FILE=${join(cwd, "projects.json")}`), "the fix names the variable AND the absolute path");
	assert.ok(text().includes(`set PI_PROJECTS_FILE=${join(cwd, "projects.json")} in .env and restart the worker -- unset means the worker groups no run into a project; delete the file if this deployment has no projects`), text());
	assert.doesNotMatch(text(), /reports each project it writes/, "no panel writes projects yet, so the fix line promises none");
	assert.equal(code, 0, "warn, never fail");
	const wired = capture();
	await runDoctor(imgEnv({ PI_PROJECTS_FILE: join(cwd, "projects.json") }), scaffoldDeps(wired.out, cwd));
	assert.doesNotMatch(wired.text(), /PI_PROJECTS_FILE/, "a wired deployment with a loadable file gets no line about it");
});

test("doctor: an EMPTY PI_PROJECTS_FILE and a file that will not load each FAIL as a refused boot (#499)", async () => {
	const dir = tempDir("pi-projects-bad-");
	const empty = capture();
	const code = await runDoctor(imgEnv({ PI_PROJECTS_FILE: "" }), scaffoldDeps(empty.out, dir));
	assert.match(empty.text(), /✗ PI_PROJECTS_FILE is set to an EMPTY value in this shell, which is not unset: the worker keeps it, tries to load "" and REFUSES TO START/);
	assert.notEqual(code, 0, "a refused boot fails doctor");
	const path = join(dir, "projects.json");
	writeFileSync(path, JSON.stringify({ version: 1, projects: [{ id: "a", name: "Private Name", members: ["github:acme/web"] }, { id: "b", members: ["github:acme/web"] }] }));
	const checks = await collectChecks(imgEnv({ PI_PROJECTS_FILE: path }), collectSeams(green, { cwd: dir, nodeVersion: "22.19.0", probeValkey: async () => true }));
	const c = checks.find((x) => /PI_PROJECTS_FILE is set in this shell to a file the worker cannot load/.test(x.label));
	assert.ok(c, "the check is present");
	assert.equal(c.ok, false);
	assert.notEqual(c.warn, true, "a boot blocker is a failure, not an advisory");
	assert.match(c.label, /REFUSES TO START/);
	assert.match(c.label, /claimed by both "a" and "b"/, "the loader's own words");
	assert.doesNotMatch(c.label, /Private Name/, "and never a project's name");
	const gone = await collectChecks(imgEnv({ PI_PROJECTS_FILE: join(dir, "absent.json") }), collectSeams(green, { cwd: dir, nodeVersion: "22.19.0", probeValkey: async () => true }));
	assert.ok(gone.find((x) => /PI_PROJECTS_FILE/.test(x.label) && /does not exist/.test(x.label)));
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
			"⚠ 3 scoped limit(s) name a folder no trigger runs in (./relative-nowhere, sitealone, C:\\srv\\site) -- no trigger runs there, so unless a CLI or local job does, the cap guards nothing; scopes match exactly (no globs, folders by resolved ABSOLUTE path), so check the spelling against triggers.json run.folder or delete the entry",
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

test("doctor: a project row whose id is not in projects.json is a FAILURE naming the row; a defined one is never a dead folder (issue #499 part B)", async () => {
	const dir = tempDir("pi-sl-project-");
	writeFileSync(join(dir, "triggers.json"), JSON.stringify({ triggers: [{ on: { type: "cron", id: "t1", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/shop-a", flow: "tidy", task: "t" } }] }));
	const limitsPath = join(dir, "scoped-limits.json");
	const projectsPath = join(dir, "projects.json");
	writeFileSync(limitsPath, JSON.stringify({ version: 2, limits: [{ scope: "/srv/shop-a", day: 3 }, { scope: "project:shop", day: 2 }] }));
	const seams = () => collectSeams(green, { cwd: dir, nodeVersion: "22.19.0", probeValkey: async () => true });
	const dangling = (checks) => checks.find((x) => /name a project that is not in the projects file/.test(x.label));
	// No projects file: the row dangles, and the worker would refuse to start.
	const unset = await collectChecks(imgEnv({ PI_TRIGGERS_FILE: join(dir, "triggers.json"), PI_SCOPED_LIMITS_FILE: limitsPath }), seams());
	const c = dangling(unset);
	assert.ok(c, "the failure is present");
	assert.equal(c.ok, false);
	assert.notEqual(c.warn, true, "a FAILURE, never a warning: the worker refuses to start");
	assert.match(c.label, /#1 \(project:shop\)/);
	assert.match(c.label, /the worker refuses to start/);
	assert.ok(!unset.some((x) => /name a folder no trigger runs in/.test(x.label) && x.label.includes("project:")), "a project row is never a dead folder");
	// A projects file that defines another id: still dangling, and no project name is quoted.
	writeFileSync(projectsPath, JSON.stringify({ version: 1, projects: [{ id: "other", name: "Private Name", members: ["/srv/x"] }] }));
	const other = await collectChecks(imgEnv({ PI_TRIGGERS_FILE: join(dir, "triggers.json"), PI_SCOPED_LIMITS_FILE: limitsPath, PI_PROJECTS_FILE: projectsPath }), seams());
	assert.ok(dangling(other));
	assert.ok(!JSON.stringify(other).includes("Private Name"));
	// Defined: silent.
	writeFileSync(projectsPath, JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["/srv/shop-a"] }] }));
	const ok = await collectChecks(imgEnv({ PI_TRIGGERS_FILE: join(dir, "triggers.json"), PI_SCOPED_LIMITS_FILE: limitsPath, PI_PROJECTS_FILE: projectsPath }), seams());
	assert.equal(dangling(ok), undefined);
	// A projects file that does not load is the BOOT_FILES line's, so this check says nothing more.
	writeFileSync(projectsPath, "{broken");
	const broken = await collectChecks(imgEnv({ PI_TRIGGERS_FILE: join(dir, "triggers.json"), PI_SCOPED_LIMITS_FILE: limitsPath, PI_PROJECTS_FILE: projectsPath }), seams());
	assert.equal(dangling(broken), undefined);
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

test("doctor: a bare repo row or bare pause window warns when triggers name two forge kinds, with the qualified spellings (issue #498)", async () => {
	const dir = tempDir("pi-sl-bare-forges-");
	const triggersPath = join(dir, "triggers.json");
	const twoForges = [
		{ on: { type: "label", any: ["pi:fix"] }, run: { kind: "github", flow: "fix" } },
		{ on: { type: "label", any: ["pi:fix"] }, run: { kind: "forgejo", flow: "fix" } },
	];
	writeFileSync(triggersPath, JSON.stringify({ triggers: twoForges }));
	const limitsPath = join(dir, "scoped-limits.json");
	// A bare row (flagged), a qualified row (never flagged, by this line or by the dead-folder one), and two relative
	// folder rows: the dead-folder line names those, and the bare-repo line must not also call them repos.
	writeFileSync(limitsPath, JSON.stringify({ version: 2, limits: [{ scope: "acme/web", day: 9 }, { scope: "github:acme/api", day: 2 }, { scope: "site", day: 1 }, { scope: "./site", day: 1 }] }));
	const pausePath = join(dir, "pause-windows.json");
	writeFileSync(pausePath, JSON.stringify({ windows: [{ scope: "acme/docs", from: "22:00", to: "06:00" }, { scope: "*", from: "01:00", to: "02:00" }, { scope: "forgejo:acme/web", from: "09:00", to: "10:00" }] }));
	const seams = () => collectSeams(green, { cwd: dir, nodeVersion: "22.19.0", probeValkey: async () => true });
	const env = imgEnv({ PI_TRIGGERS_FILE: triggersPath, PI_SCOPED_LIMITS_FILE: limitsPath, PI_PAUSE_WINDOWS_FILE: pausePath });
	const checks = await collectChecks(env, seams());
	const c = checks.find((x) => /name a bare repo/.test(x.label));
	assert.ok(c, "the ambiguity warning is present");
	assert.equal(c.ok, false);
	assert.equal(c.warn, true, "a warning, never a failure: a bare row may be meant");
	assert.equal(c.fixAction, undefined, "never-tier");
	assert.equal(c.label, "1 scoped limit(s) and 1 pause window(s) name a bare repo (acme/web, acme/docs) while triggers run on forgejo and github: a bare scope matches that repo on EVERY forge, so one cap, lease or pause covers all of them");
	assert.match(c.fix, /forgejo:acme\/web or github:acme\/web; forgejo:acme\/docs or github:acme\/docs/);
	assert.ok(!c.label.includes("acme/api") && !c.label.includes("*"), "qualified rows and \"*\" are not bare");
	assert.ok(!/github:site|forgejo:site/.test(c.fix), "a relative folder row is never offered a forge-qualified spelling");
	const dead = checks.find((x) => /name a folder no trigger runs in/.test(x.label));
	assert.match(dead.label, /\(site, \.\/site\)/, "the relative folder rows are the dead-folder line's, and only theirs");
	assert.ok(!dead.label.includes("github:acme/api"), "the dead-folder heuristic never flags a qualified row");
	// One forge kind: silent.
	writeFileSync(triggersPath, JSON.stringify({ triggers: [twoForges[0]] }));
	const one = await collectChecks(env, seams());
	assert.ok(!one.find((x) => /name a bare repo/.test(x.label)), "one forge: no line");
	// Two forges and only qualified scopes: silent.
	writeFileSync(triggersPath, JSON.stringify({ triggers: twoForges }));
	writeFileSync(limitsPath, JSON.stringify({ version: 2, limits: [{ scope: "github:acme/web", day: 9 }] }));
	writeFileSync(pausePath, JSON.stringify({ windows: [{ scope: "*", from: "01:00", to: "02:00" }] }));
	const qualified = await collectChecks(env, seams());
	assert.ok(!qualified.find((x) => /name a bare repo/.test(x.label)), "qualified only: no line");
});

test("doctor: every forge-qualified spelling the bare-repo warning suggests parses, an Azure name with spaces included (issue #498)", async () => {
	const dir = tempDir("pi-sl-azure-spaces-");
	const triggersPath = join(dir, "triggers.json");
	writeFileSync(triggersPath, JSON.stringify({ triggers: [
		{ on: { type: "label", any: ["pi:fix"] }, run: { kind: "github", flow: "fix" } },
		{ on: { type: "label", any: ["pi:fix"] }, run: { kind: "azure", flow: "fix", repository: "webapp" } },
	] }));
	const limitsPath = join(dir, "scoped-limits.json");
	writeFileSync(limitsPath, JSON.stringify({ version: 1, limits: [{ scope: "Fabrikam Fiber/Web App", day: 3 }] }));
	const checks = await collectChecks(imgEnv({ PI_TRIGGERS_FILE: triggersPath, PI_SCOPED_LIMITS_FILE: limitsPath }), collectSeams(green, { cwd: dir, nodeVersion: "22.19.0", probeValkey: async () => true }));
	const c = checks.find((x) => /name a bare repo/.test(x.label));
	assert.ok(c, "the warning is present");
	for (const spelling of ["azure:Fabrikam Fiber/Web App", "github:Fabrikam Fiber/Web App"]) {
		assert.ok(c.fix.includes(spelling), spelling);
		assert.equal(parseScopedLimits(JSON.stringify({ version: 2, limits: [{ scope: spelling, day: 3 }] }), "sl.json")[0].scope, spelling, "the worker accepts the spelling doctor recommends");
	}
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

function modelsTriggersFile(models = ["anthropic/claude-haiku-4-5"]) {
	const path = join(tempDir("pi-triggers-models-"), "triggers.json");
	writeFileSync(path, JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi:go"] }, run: { kind: "github", flow: "fix", models } }] }));
	return path;
}

test("doctor: run.models states its version floor once, naming trigger-skew, and only when a trigger lists (#502)", async () => {
	const listing = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: modelsTriggersFile() }, secretsSeams());
	const floor = listing.filter((c) => /name run\.models, which needs a worker and a receiver/.test(c.label));
	assert.equal(floor.length, 1);
	assert.equal(floor[0].ok, true, "a fact, not a defect: doctor cannot see the receiver's version");
	assert.match(floor[0].label, /trigger-skew/);
	const quiet = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: waitTriggersFile() }, secretsSeams());
	assert.equal(quiet.some((c) => /name run\.models/.test(c.label)), false);
});

function costCapTriggersFile(caps) {
	const path = join(tempDir("pi-triggers-cost-"), "triggers.json");
	writeFileSync(path, JSON.stringify({ triggers: caps.map((maxCostUsd, i) => ({ on: { type: "label", any: [`pi:go${i}`] }, run: { kind: "github", flow: "fix", maxCostUsd } })) }));
	return path;
}

test("doctor: run.maxCostUsd states its version floor once, naming trigger-skew, and only when a trigger sets one (#540)", async () => {
	const capping = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: costCapTriggersFile(["2.50", 1, null]) }, secretsSeams());
	const floor = capping.filter((c) => /set run\.maxCostUsd, which needs a worker and a receiver/.test(c.label));
	assert.equal(floor.length, 1, "once, not once per trigger");
	assert.equal(floor[0].ok, true, "a fact, not a defect: doctor cannot see the receiver's version");
	assert.match(floor[0].label, /^2 trigger\(s\) set run\.maxCostUsd/, "a null cap is absent and not counted");
	assert.match(floor[0].label, /issue #501/);
	assert.match(floor[0].label, /trigger-skew/);
	// Exactly one cap, beside a null one: still said, and counted as one.
	const one = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: costCapTriggersFile([null, "0.01"]) }, secretsSeams());
	const single = one.filter((c) => /set run\.maxCostUsd, which needs a worker and a receiver/.test(c.label));
	assert.equal(single.length, 1, "one trigger with a cap is enough");
	assert.match(single[0].label, /^1 trigger\(s\) set run\.maxCostUsd/);
	const quiet = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: modelsTriggersFile() }, secretsSeams());
	assert.equal(quiet.some((c) => /run\.maxCostUsd, which needs/.test(c.label)), false, "no trigger sets a cap: nothing to say");
});

test("doctor: PI_ALLOWED_MODELS is judged by the worker's own rule, a spaced value included (#502)", async () => {
	const base = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_TRIGGERS_FILE: waitTriggersFile() };
	const good = await collectChecks({ ...base, PI_ALLOWED_MODELS: "anthropic/claude-haiku-4-5,openai/gpt-x" }, secretsSeams());
	const fact = good.find((c) => /^PI_ALLOWED_MODELS limits/.test(c.label));
	assert.equal(fact.ok, true);
	assert.match(fact.label, /2 model\(s\): anthropic\/claude-haiku-4-5, openai\/gpt-x/);
	for (const bad of ["anthropic/claude-haiku-4-5, openai/gpt-x", "anthropic", "a/b,,c/d"]) {
		const checks = await collectChecks({ ...base, PI_ALLOWED_MODELS: bad }, secretsSeams());
		const hit = checks.find((c) => c.label === "PI_ALLOWED_MODELS is not a valid list");
		assert.ok(hit && hit.ok === false, JSON.stringify(bad));
		assert.match(hit.fix, /refuses to boot/);
	}
	assert.equal((await collectChecks(base, secretsSeams())).some((c) => /PI_ALLOWED_MODELS/.test(c.label)), false, "unset says nothing");
});

test("doctor: a spaced PI_ALLOWED_MODELS in a .env a shell sources is named, since that shell leaves it unset (#502)", async () => {
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "PI_ALLOWED_MODELS=anthropic/claude-haiku-4-5, openai/gpt-x\n");
	const { out, text } = capture();
	const { PI_BACKENDS: _b, ...shell } = podmanEnv();
	await runDoctor(shell, { ...podmanDeps(out, podmanPlan(), []), cwd, platform: "darwin", readEnvFile: (path) => readFileSync(path, "utf8") });
	assert.match(text(), /✗ [^\n]*line 1 [^\n]*PI_ALLOWED_MODELS/, "the service's own value is unknown, and the line says which key");
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

// ── issue #501 part 6: the fleet's dollar caps, and the round's doctor lines about models ───────────────

// A settings file that does not exist, so no test reads the developer's own overlay.
const noOverlay = () => join(tempDir("pi-fp-usd-"), "settings.json");

test("doctor names a peer whose dollar caps differ from this host's, and is silent when they agree", async () => {
	const env = { VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1", PI_MAX_COST_USD: "2", PI_DAILY_COST_USD: "20", PI_SETTINGS_FILE: noOverlay() };
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const same = usdFingerprint({ maxCostUsd: "2", dailyCostUsd: "20" }, []);
	const other = usdFingerprint({ maxCostUsd: "5", dailyCostUsd: "20" }, []);
	const differ = await collectChecks(env, fleetSeams([{ name: "mini2", tz, fpUsd: other }]));
	const c = differ.find((x) => /^Hosts disagree about the dollar caps/.test(x.label));
	assert.ok(c, "the disagreement is named");
	assert.equal(c.warn, true);
	assert.ok(c.label.includes("mini2"));
	const agree = await collectChecks(env, fleetSeams([{ name: "mini2", tz, fpUsd: same }]));
	assert.ok(!agree.some((x) => /dollar caps/.test(x.label)), "agreement is silent: doctor computes this host's fingerprint as the worker does");
	const old = await collectChecks(env, fleetSeams([{ name: "mini2", tz }]));
	assert.ok(old.some((x) => /^mini2 publishes no fingerprint of its dollar caps/.test(x.label)), "a peer from before fpUsd is named while dollars are in use");
	const quiet = await collectChecks({ VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1", PI_SETTINGS_FILE: noOverlay() }, fleetSeams([{ name: "mini2", tz }]));
	assert.ok(!quiet.some((x) => /dollar caps/.test(x.label)), "no dollar setting anywhere: nothing new on upgrade");
	const counters = await collectChecks({ VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1", PI_SETTINGS_FILE: noOverlay() }, fleetSeams([{ name: "mini2", tz }], { dollarKeysExist: async () => true }));
	assert.ok(counters.some((x) => /^mini2 publishes no fingerprint of its dollar caps.*dollar counters exist on this Valkey/.test(x.label)), "an old capped host beside an uncapped one: its counters show it");
});

test("issue #499 part C: doctor names a peer whose projects differ, from the service's own projects.json", async () => {
	const dir = tempDir("pi-fp-projects-");
	const file = join(dir, "projects.json");
	writeFileSync(file, JSON.stringify({ version: 1, projects: [{ id: "shop", name: "Hidden", members: ["github:acme/web"] }] }));
	const env = { VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1", PI_PROJECTS_FILE: file, PI_SETTINGS_FILE: noOverlay() };
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const same = projectsFingerprint([{ id: "shop", name: null, members: ["github:acme/web"] }]);
	const agree = await collectChecks(env, fleetSeams([{ name: "mini2", tz, fpProjects: same }]));
	assert.ok(!agree.some((x) => /about the projects|fingerprint of its projects/.test(x.label)), "the same file: one fingerprint, as the worker computes it");
	const differ = await collectChecks(env, fleetSeams([{ name: "mini2", tz, fpProjects: projectsFingerprint([]) }]));
	const c = differ.find((x) => /^Hosts disagree about the projects/.test(x.label));
	assert.ok(c && c.warn === true && c.label.includes("mini2"), "a peer without the project is named");
	assert.ok(!c.label.includes("Hidden") && !c.label.includes("acme/web"), "never a name or a member");
	const old = await collectChecks(env, fleetSeams([{ name: "mini2", tz }]));
	assert.ok(old.some((x) => /^mini2 publishes no fingerprint of its projects/.test(x.label)), "a peer from before fpProjects is named while projects are in use");
	const none = await collectChecks({ VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1", PI_SETTINGS_FILE: noOverlay() }, fleetSeams([{ name: "mini2", tz }]));
	assert.ok(!none.some((x) => /projects/.test(x.label) && /fingerprint|disagree/.test(x.label)), "no projects anywhere: nothing new on upgrade");
});

test("issue #596 (gate round 1): doctor names a peer that predates job sizes, from the service's own scoped-limits file", async () => {
	const dir = tempDir("pi-fleet-size-");
	const projects = join(dir, "projects.json");
	writeFileSync(projects, JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }] }));
	const sized = join(dir, "sized.json");
	writeFileSync(sized, JSON.stringify({ version: 3, limits: [{ scope: "project:shop", memory: "1g" }] }));
	const plain = join(dir, "plain.json");
	writeFileSync(plain, JSON.stringify({ version: 2, limits: [{ scope: "project:shop", day: 5 }] }));
	const env = (file) => ({ VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1", PI_PROJECTS_FILE: projects, PI_SCOPED_LIMITS_FILE: file, PI_SETTINGS_FILE: noOverlay() });
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const old = await collectChecks(env(sized), fleetSeams([{ name: "mini2", tz }, { name: "mini3", tz, limitsVersion: "3" }]));
	const line = old.find((c) => /predates job sizes/.test(c.label));
	assert.ok(line && line.warn === true && /^mini2 predates/.test(line.label), "the peer from before sizes is named, the current one is not");
	const current = await collectChecks(env(sized), fleetSeams([{ name: "mini2", tz, limitsVersion: "3" }]));
	assert.ok(!current.some((c) => /predate/.test(c.label)));
	const unsized = await collectChecks(env(plain), fleetSeams([{ name: "mini2", tz }]));
	assert.ok(!unsized.some((c) => /predate/.test(c.label)), "no size written: nothing at risk yet");
	// Gate round 2: an older worker refuses by the DECLARED version, so a hand-written version 3 with no size warns too.
	const declared = join(dir, "declared.json");
	writeFileSync(declared, JSON.stringify({ version: 3, limits: [{ scope: "project:shop", day: 5 }] }));
	const bare = await collectChecks(env(declared), fleetSeams([{ name: "mini2", tz }]));
	assert.ok(bare.some((c) => c.warn === true && /^mini2 predates job sizes/.test(c.label)), "a declared version 3 without a size is named");
});

test("PR #569's review: with THIS host's projects.json not loading, doctor fails on it and does not blame a healthy peer", async () => {
	const file = join(tempDir("pi-fp-projects-bad-"), "projects.json");
	writeFileSync(file, "{ not json");
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const peer = projectsFingerprint([{ id: "shop", name: null, members: ["/srv/a"] }]);
	const checks = await collectChecks({ VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1", PI_PROJECTS_FILE: file, PI_SETTINGS_FILE: noOverlay() }, fleetSeams([{ name: "mini2", tz, fpProjects: peer }]));
	assert.ok(checks.some((c) => c.ok === false && !c.warn && /PI_PROJECTS_FILE/.test(c.label)), "the load failure is named");
	assert.ok(!checks.some((c) => /about the projects|fingerprint of its projects/.test(c.label)), "no peer comparison against a file that does not load");
});

test("doctor's fingerprint covers the scoped-limits dollar rows and the overlay, as the worker resolves them", async () => {
	const dir = tempDir("pi-fp-usd-rows-");
	const limits = join(dir, "scoped-limits.json");
	writeFileSync(limits, JSON.stringify({ version: 2, limits: [{ scope: "acme/web", dayUsd: "5" }] }));
	const settings = join(dir, "settings.json");
	writeFileSync(settings, JSON.stringify({ weeklyCostUsd: "40" }));
	const env = { VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1", PI_MAX_COST_USD: "2", PI_SCOPED_LIMITS_FILE: limits, PI_SETTINGS_FILE: settings };
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const rows = parseScopedLimits(readFileSync(limits, "utf8"), limits);
	const worker = usdFingerprint({ maxCostUsd: "2", weeklyCostUsd: "40" }, rows);
	const agree = await collectChecks(env, fleetSeams([{ name: "mini2", tz, fpUsd: worker }]));
	assert.ok(!agree.some((x) => /dollar caps/.test(x.label)), "the same rows and overlay: one fingerprint");
	const noRows = await collectChecks(env, fleetSeams([{ name: "mini2", tz, fpUsd: usdFingerprint({ maxCostUsd: "2", weeklyCostUsd: "40" }, []) }]));
	assert.ok(noRows.some((x) => /^Hosts disagree about the dollar caps/.test(x.label)), "a peer without the row disagrees");
	// PR #551's review: the env list picks the model rows a job without its own list reserves in.
	const modelRows = join(dir, "model-limits.json");
	writeFileSync(modelRows, JSON.stringify({ version: 2, limits: [{ scope: "model:openai/gpt-4o", dayUsd: "5" }] }));
	const mRows = parseScopedLimits(readFileSync(modelRows, "utf8"), modelRows);
	const listed = { ...env, PI_SCOPED_LIMITS_FILE: modelRows, PI_ALLOWED_MODELS: "anthropic/claude-sonnet-4-5-20250929" };
	const sameList = await collectChecks(listed, fleetSeams([{ name: "mini2", tz, fpUsd: usdFingerprint({ maxCostUsd: "2", weeklyCostUsd: "40" }, mRows, ["anthropic/claude-sonnet-4-5-20250929"]) }]));
	assert.ok(!sameList.some((x) => /^Hosts disagree about the dollar caps/.test(x.label)), "the same env list agrees");
	const noList = await collectChecks(listed, fleetSeams([{ name: "mini2", tz, fpUsd: usdFingerprint({ maxCostUsd: "2", weeklyCostUsd: "40" }, mRows, null) }]));
	assert.ok(noList.some((x) => /^Hosts disagree about the dollar caps/.test(x.label)), "a peer with no list reserves in the model row, this host does not");
});

test("doctor names, end to end: a cron trigger's unknown model, a cap below the default model's first call, a listed provider with no key", async () => {
	const path = triggersFile(undefined, undefined, { provider: "openai", model: "gpt-9-turbo" });
	const listed = join(tempDir("pi-model-lines-"), "triggers.json");
	writeFileSync(
		listed,
		JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi:x"] }, run: { kind: "github", flow: "fix", provider: "anthropic", model: "claude-sonnet-4-5-20250929", models: ["anthropic/claude-sonnet-4-5-20250929", "openai/gpt-4o"] } }] }),
	);
	const env = { VALKEY_URL: "redis://x", PI_TRIGGERS_FILE: path, PI_MAX_COST_USD: "1", PI_SETTINGS_FILE: noOverlay() };
	const checks = await collectChecks(env, fleetSeams([]));
	assert.ok(checks.some((c) => c.warn === true && /^1 trigger\(s\) name a model this deployment does not know.*cron "nightly": openai\/gpt-9-turbo \(not-in-catalog\)/.test(c.label)), "cron is judged");
	assert.ok(checks.some((c) => c.warn === true && /^The per-job cost cap is below one full-output call.*anthropic\/claude-sonnet-4-5-20250929 \(the main model, so such a job makes no call at all\) needs at least \$1\.00608 a call under a \$1\.00 cap \(the deployment default\)/.test(c.label)));
	const second = await collectChecks({ ...env, PI_TRIGGERS_FILE: listed, PI_MAX_COST_USD: "50" }, fleetSeams([]));
	assert.ok(second.some((c) => c.warn === true && /no credential this deployment hands its jobs.*openai \(label trigger #0; looked for OPENAI_API_KEY\)/.test(c.label)));
	assert.ok(!second.some((c) => /per-job cost cap is below/.test(c.label)), "a $50 cap fits");
	const forwarded = await collectChecks({ ...env, PI_TRIGGERS_FILE: listed, PI_MAX_COST_USD: "50", PI_FORWARD_ENV: "OPENAI_API_KEY", OPENAI_API_KEY: "sk-o" }, fleetSeams([]));
	assert.ok(!forwarded.some((c) => /no credential this deployment hands its jobs/.test(c.label)), "forwarded and set");
});

test("an overlay the reader refuses before reading it (a link, an unreadable file, a pipe) is never compared, and never blamed on .env (PR #553)", async () => {
	const disagrees = async () => ({ version: "0.99.1", pinned: "0.99.1", read: async () => ({ loads: false, has: () => false }) });
	const doc = JSON.stringify({ providers: { ollama: { baseUrl: "http://gpu:11434/v1", api: "openai-completions", models: [{ id: "qwen" }] } } });
	const linked = tempDir("pi-parity-link-");
	writeFileSync(join(linked, "real.json"), doc);
	symlinkSync(join(linked, "real.json"), join(linked, "models.json"));
	const viaLink = await collectChecks({ VALKEY_URL: "redis://x", PI_GLOBAL_PI_DIR: linked, PI_SETTINGS_FILE: noOverlay() }, fleetSeams([], { piModelLoader: disagrees }));
	assert.ok(viaLink.some((c) => /overlay-link/.test(c.label)), "the reader's own line is there");
	assert.ok(!viaLink.some((c) => /own loader/.test(c.label)), "a link is not compared: the job never loads it");
	assert.ok(!viaLink.some((c) => /^The deployment's default model/.test(c.label)), "and the default model is not blamed");
	const plain = tempDir("pi-parity-eacces-");
	writeFileSync(join(plain, "models.json"), doc);
	const eacces = () => {
		throw Object.assign(new Error("denied"), { code: "EACCES" });
	};
	const unreadable = await collectChecks({ VALKEY_URL: "redis://x", PI_GLOBAL_PI_DIR: plain, PI_SETTINGS_FILE: noOverlay() }, fleetSeams([], { piModelLoader: disagrees, readOverlayFile: eacces }));
	assert.ok(unreadable.some((c) => /overlay-unreadable/.test(c.label)));
	assert.ok(!unreadable.some((c) => /own loader/.test(c.label)), "an unreadable file is not compared");
	assert.ok(!unreadable.some((c) => /^The deployment's default model/.test(c.label)));
	// PR #557: a named pipe is refused unopened (overlay-not-a-file), and is not compared either.
	const fifoDir = tempDir("pi-parity-fifo-");
	execFileSync("mkfifo", [join(fifoDir, "models.json")]);
	const viaFifo = await collectChecks({ VALKEY_URL: "redis://x", PI_GLOBAL_PI_DIR: fifoDir, PI_SETTINGS_FILE: noOverlay() }, fleetSeams([], { piModelLoader: disagrees }));
	assert.ok(viaFifo.some((c) => /overlay-not-a-file/.test(c.label)), "the reader's own line is there");
	assert.ok(!viaFifo.some((c) => /own loader/.test(c.label)), "a pipe is not compared, and never opened");
	assert.ok(!viaFifo.some((c) => /^The deployment's default model/.test(c.label)));
	writeFileSync(join(plain, "models.json"), "{ not json");
	const unparseable = await collectChecks({ VALKEY_URL: "redis://x", PI_GLOBAL_PI_DIR: plain, PI_SETTINGS_FILE: noOverlay() }, fleetSeams([], { piModelLoader: async () => ({ version: "0.99.1", pinned: "0.99.1", read: async () => ({ loads: false, has: () => false }) }) }));
	assert.ok(unparseable.some((c) => c.ok === true && /reads the same in pi 0\.99\.1's own loader/.test(c.label)), "a file refused for its text is still compared");
});

test("doctor compares the overlay models.json with pi's own loader through its seam, and says when it cannot", async () => {
	const dir = tempDir("pi-parity-wiring-");
	writeFileSync(join(dir, "models.json"), JSON.stringify({ providers: { ollama: { baseUrl: "http://gpu:11434/v1", api: "openai-completions", models: [{ id: "qwen" }] } } }));
	const env = { VALKEY_URL: "redis://x", PI_GLOBAL_PI_DIR: dir, PI_SETTINGS_FILE: noOverlay() };
	const lacking = await collectChecks(env, fleetSeams([], { piModelLoader: async () => ({ version: "0.99.1", pinned: "0.99.1", read: async () => ({ loads: true, has: () => false }) }) }));
	assert.ok(lacking.some((c) => c.warn === true && /^pi 0\.99\.1's own loader and the worker's model catalog disagree.*ollama\/qwen: pi lacks it, the worker calls it known/.test(c.label)));
	const absent = await collectChecks(env, fleetSeams([], { piModelLoader: async () => null }));
	assert.ok(absent.some((c) => c.ok === true && /not compared with pi's own loader/.test(c.label)));
	const noCatalog = await collectChecks(env, fleetSeams([], { modelCatalog: async () => null, piModelLoader: async () => null }));
	assert.ok(!noCatalog.some((c) => /pi's own loader/.test(c.label)), "without the worker's catalog there is nothing to compare against");
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
// Issue #596: a default-size job's swap, weight and ceiling too (no runtime CPU count in these fakes, so no ceiling).
const LIVE_STATUS = (uid = "1001") => `Name:\tdocker-init\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nCapBnd:\t0000000000000000\nNoNewPrivs:\t1\ncgroup:v2\npids.max:512\nmemory.max:4294967296\nmemory.swap.max:0\ncpu.weight:79\ncpu.max:max 100000\n`;

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
	// Issue #596, gate round 2: the probe's `--cpus`, applied as the runtime applies it (cpu.max is the quota over a
	// 100000 period). Absent (no runtime CPU count in the fake), cpu.max stays `max`, as LIVE_STATUS has it.
	let cpus = null;
	return {
		"docker run --name=pi-dispatch-live-probe-": (_cmd, args) => {
			volumes = args.flatMap((a, i) => (args[i - 1] === "-v" ? [a] : []));
			const flag = args.find((a) => a.startsWith("--cpus="));
			cpus = flag ? Number(flag.slice("--cpus=".length)) : null;
			return { code: 0, output: `${LIVE_ID}\n` };
		},
		"docker inspect --format={{json .Mounts}}": () => ({ code: 0, output: JSON.stringify(volumes.map((v) => ({ Type: "bind", Source: v.split(":")[0], Destination: v.split(":")[1], RW: v.split(":")[2] !== "ro" }))) }),
		// A readable rootful daemon, so the job user is decided and the probe runs (issue #341).
		...infoPlan(ROOTFUL_INFO),
		[`docker exec ${LIVE_ID} sh -c cat /proc/1/status`]: () => ({ code: 0, output: cpus === null ? LIVE_STATUS(uid) : LIVE_STATUS(uid).replace("cpu.max:max 100000", `cpu.max:${Math.round(cpus * 100000)} 100000`) }),
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

test("doctor --live builds its probes at the deployment's job size with the daemon's --cpus ceiling, and reads both back (#596)", async () => {
	const env = { ...liveEnv(), PI_JOB_MEMORY: "2g", PI_JOB_CPUS: "0.5" };
	const { out, text } = capture();
	const calls = [];
	const sized = "Name:\tdocker-init\nUid:\t1001\t1001\t1001\t1001\nCapBnd:\t0000000000000000\nNoNewPrivs:\t1\ncgroup:v2\npids.max:512\nmemory.max:2147483648\nmemory.swap.max:0\ncpu.weight:59\ncpu.max:1300000 100000\n";
	const facts = JSON.stringify({ ...JSON.parse(ROOTFUL_INFO), NCPU: 14, SwapLimit: true });
	const plan = { ...liveOk(), ...infoPlan(facts), [`docker exec ${LIVE_ID} sh -c cat /proc/1/status`]: { code: 0, output: sized }, ...green };
	const code = await runDoctor(env, { ...ghDeps(out, plan, calls), live: true, ...instantClock(), liveFs: liveFsAs(1001), jobUserIdentity: LINUX_1001, isAlive: () => false, pid: 7, nonce: "n" });
	assert.equal(code, 0, text());
	const probe = calls.find((c) => c.args[0] === "run" && String(c.args[1]).startsWith("--name=pi-dispatch-live-probe")).args;
	assert.deepEqual(probe.filter((a) => /^--(?:memory|memory-swap|cpus|cpu-shares|shm-size)=/.test(a)), ["--memory=2g", "--memory-swap=2g", "--cpus=13", "--cpu-shares=512", "--shm-size=1g"]);
	assert.match(text(), /✓ read back on local: isolation holds \(CapBnd 0, NoNewPrivs 1, pids\.max 512, memory\.max 2147483648, memory\.swap\.max 0, cpu\.max 1300000 100000, cpu\.weight 59 \(--cpu-shares=512\)\)/);
	assert.match(text(), /✓ Job size: 2g of memory .* weight of 0\.5 CPUs, per job \(PI_JOB_MEMORY and PI_JOB_CPUS;/);
	assert.match(text(), /✓ local: any one job may use at most 13 of this runtime's 14 CPUs/);
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
	// Issue #464: the default is per account, `<tmp>/pi-dispatch-<uid>/jobs`, and the live probe makes it 0700 as the worker does.
	const jobs = join(tmp, `pi-dispatch-${process.geteuid()}`, "jobs");
	assert.ok(text().includes(`with a fixture under ${jobs};`), text());
	assert.deepEqual(readdirSync(jobs), [], "and removes it");
	assert.equal(statSync(dirname(jobs)).mode & 0o777, 0o700, "the account root it created is 0700");
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
	assert.deepEqual(checks.filter((c) => c.readBack).map((c) => c.readBack.reached), [true, null, false]);
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
	assert.ok(!calls.some((c) => c.args.some((a) => /egress-probe-plainhttp/.test(a))), "nor the plain HTTP probe (#508): the canary stops at the first stale reading");
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

// Issue #508: the plain HTTP probe's script, against a fake proxy in this process. It must send a plain forward request
// (absolute URI, never a CONNECT), and only squid's own refusal (403 + X-Squid-Error ERR_ACCESS_DENIED) counts as denied.
test("the plain HTTP canary script sends a forward GET, and only squid's access denial is a block (#508)", async () => {
	const { createServer } = await import("node:http");
	const { spawn: spawnChild } = await import("node:child_process");
	const runAgainst = (answer) =>
		new Promise((resolve) => {
			const seen = [];
			const server = createServer((req, res) => {
				seen.push(`${req.method} ${req.url} HTTP/${req.httpVersion}`, req.headers.host);
				answer?.(res);
			});
			server.on("connect", (req, socket) => {
				seen.push(`CONNECT ${req.url}`);
				socket.destroy();
			});
			server.listen(0, "127.0.0.1", () => {
				const script = egressCanaryPlainScript("http://api.anthropic.com:443/", { proxyUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 300 });
				const child = spawnChild(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "pipe"] });
				let stdout = "";
				child.stdout.on("data", (d) => (stdout += d));
				child.on("close", (status) => {
					server.closeAllConnections();
					server.close(() => resolve({ status, stdout, seen }));
				});
			});
		});
	const denied = await runAgainst((res) => res.writeHead(403, { "X-Squid-Error": "ERR_ACCESS_DENIED 0" }).end("no"));
	assert.equal(denied.status, 3, denied.stdout);
	assert.deepEqual(denied.seen, ["GET http://api.anthropic.com:443/ HTTP/1.1", "api.anthropic.com:443"], "a plain forward request, absolute URI, never a CONNECT");
	assert.match(denied.stdout, /^blocked 403 ERR_ACCESS_DENIED/);
	for (const [why, answer] of [
		["a TLS port spoken to in clear", (res) => res.writeHead(400).end()],
		["squid let it out and the far end hung up", (res) => res.writeHead(502, { "X-Squid-Error": "ERR_ZERO_SIZE_OBJECT 0" }).end()],
		["a 403 that is not squid's", (res) => res.writeHead(403).end()],
	]) {
		const got = await runAgainst(answer);
		assert.equal(got.status, 0, `${why}: ${got.stdout}`);
		assert.match(got.stdout, /^reached /, why);
	}
	const silent = await runAgainst(null);
	assert.equal(silent.status, 5, "a proxy that never answers is no reading");
	// Nothing listening: take a port, then free it.
	const { createServer: net } = await import("node:net");
	const port = await new Promise((resolve) => {
		const s = net().listen(0, "127.0.0.1", () => {
			const p = s.address().port;
			s.close(() => resolve(p));
		});
	});
	const refused = spawnSync(process.execPath, ["-e", egressCanaryPlainScript("http://api.anthropic.com:443/", { proxyUrl: `http://127.0.0.1:${port}`, timeoutMs: 300 })], { encoding: "utf8", timeout: 30_000 });
	assert.equal(refused.status, 5, refused.stdout);
	assert.match(refused.stdout, /^error ECONNREFUSED/);
});

test("the plain HTTP probe's argv is the unlisted probe's apart from its name and its script (#508)", () => {
	const base = { pid: 42, network: "pi-dispatch-egress-doctor-42", proxy: "pi-dispatch-egress-proxy", image: "pi-job:latest" };
	const plain = egressCanaryPlainScript("http://api.anthropic.com:443/", { proxyUrl: "http://pi-dispatch-egress-proxy:3128" });
	for (const bin of ["docker", "podman"]) {
		const user = bin === "podman" ? "1234:1234" : null;
		const unlisted = egressCanaryProbeArgs({ bin, ...base, user, slug: "unlisted", url: "https://example.com/" });
		const plainhttp = egressCanaryProbeArgs({ bin, ...base, user, slug: "plainhttp", url: "http://api.anthropic.com:443/", script: plain });
		assert.equal(plainhttp.at(-1), plain, bin);
		assert.equal(unlisted.at(-1), egressCanaryScript("https://example.com/"), `${bin}: the default script is unchanged`);
		assert.deepEqual(
			plainhttp.slice(0, -1).map((a) => a.replace("plainhttp", "SLUG")),
			unlisted.slice(0, -1).map((a) => a.replace("unlisted", "SLUG")),
			bin,
		);
	}
});

test("a proxy that lets plain HTTP through fails its own line and reads back as reached; an unrun one is not a reading (#508)", async () => {
	const through = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" }, collectSeams({ ...green, "docker run --rm --name pi-dispatch-egress-probe-plainhttp": 0 }));
	const line = through.find((c) => c.readBack?.probe === "plainhttp");
	assert.equal(line.ok, false);
	assert.equal(line.warn, true);
	assert.equal(line.label, "Egress policy lets plain HTTP through to api.anthropic.com on port 443, so a client that does not tunnel reaches every port of a listed host");
	assert.match(line.fix, /issue #508/);
	assert.ok(line.fix.includes('"http_access deny !Safe_ports !CONNECT" right before "http_access allow allowed"'));
	assert.ok(line.fix.includes("for a proxy you started by hand, update the egress-proxy.conf it mounts, then `docker restart pi-dispatch-egress-proxy`"), line.fix);
	assert.deepEqual(line.readBack, { property: "egress", want: false, reached: true, probe: "plainhttp" });
	const held = (await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" }, collectSeams(green))).find((c) => c.readBack?.probe === "plainhttp");
	assert.equal(held.ok, true);
	assert.equal(held.label, "Egress policy refuses plain HTTP to a listed host off port 80 (api.anthropic.com:443 without a tunnel; only a CONNECT reaches 443)");
	const unrun = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" }, collectSeams({ ...green, "docker run --rm --name pi-dispatch-egress-probe-plainhttp": 125 }));
	assert.ok(unrun.some((c) => c.label === "Egress policy probe for plain HTTP to a listed host off port 80 did not run (docker run exited 125)"));
	assert.deepEqual(unrun.find((c) => c.readBack?.probe === "plainhttp").readBack, { property: "egress", want: false, reached: null, probe: "plainhttp" });
});

// Issue #508, gate round 1: docs/egress.md's sample doctor output is the code's own wording. The page's generated rows
// (CANARY_LINES) are the leftover sweep's lines only, so the probe lines were free to drift; they are pinned here, read
// off a real canary run and the real verdict rather than retyped.
test("docs/egress.md's sample egress lines are what doctor prints, on docker and on podman (#508)", async () => {
	const doc = readFileSync(new URL("../../docs/egress.md", import.meta.url), "utf8");
	const probes = (await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x" }, collectSeams(green))).filter((c) => c.readBack);
	assert.deepEqual(probes.map((c) => c.readBack.probe), ["provider", "unlisted", "plainhttp"]);
	const docker = probes.map((c) => `✓ ${c.label}\n`).join("");
	const podman = probes.map((c) => `✓ podman: ${c.label}\n`).join("");
	assert.ok(doc.includes(`✓ Egress proxy health: healthy\n${docker}\`\`\``), "the docker sample, all three lines in order");
	const held = egressVerdict({ armed: true, results: probes.map((c) => c.readBack) });
	assert.equal(held.ok, true);
	assert.ok(doc.includes(`${podman}✓ read back on podman: egress holds (${held.detail})\n`), "the podman sample, with the read-back's own wording");
});

// Issue #508, gate rounds 1 and 2: with the egress policy on a job reaches a forge only over https on 443. git ignores the
// job's uppercase HTTP_PROXY for an http:// remote (measured in the job image), and the proxy refuses a CONNECT off 443.
test("doctor warns when egress is on and a forge URL is anything but https:// on port 443 (#508)", () => {
	const on = { PI_EGRESS: "1" };
	const [gitlab] = forgeUrlEgressChecks({ ...on, GITLAB_URL: "http://gitlab.example:8929" }, ["gitlab"]);
	assert.deepEqual([gitlab.ok, gitlab.warn], [false, true]);
	assert.equal(gitlab.label, "GITLAB_URL (http://gitlab.example:8929) is http://, so with the egress policy on a job's git push and fetch fail (git never sends http:// through the proxy), and on port 8929, not 80, its API calls fail too (issue #508)");
	// On port 80 the API calls pass (glab and tea use HTTP_PROXY, and the proxy allows port 80): only git is named.
	assert.equal(forgeUrlEgressChecks({ GITLAB_URL: "http://gitlab.example" }, ["gitlab"])[0].label, "GITLAB_URL (http://gitlab.example) is http://, so with the egress policy on a job's git push and fetch fail (git never sends http:// through the proxy) (issue #508)");
	// Any other scheme, a bare host:port among them (parsed with the host as its scheme), is not called http://.
	for (const value of ["ftp://gl.example", "gitlab.internal:8443"]) {
		const [other] = forgeUrlEgressChecks({ GITLAB_URL: value }, ["gitlab"]);
		assert.match(other.label, /^GITLAB_URL \(.*\) is not an https:\/\/ URL, so with the egress policy on a job cannot reach it \(issue #508\)$/, value);
		assert.match(other.fix, /^serve the forge over https:\/\/ on port 443/, value);
	}
	assert.equal(gitlab.fix, "serve the forge over https:// on port 443 and point GITLAB_URL there, or set PI_EGRESS=0 if you accept jobs without the policy (docs/egress.md)");
	const [tls] = forgeUrlEgressChecks({ GITLAB_URL: "https://gitlab.example:8443" }, ["gitlab"]);
	assert.equal(tls.label, "GITLAB_URL (https://gitlab.example:8443) is https:// on port 8443, and the egress proxy refuses a CONNECT to any port but 443, so with the egress policy on every job's push, fetch and API call to it fails (issue #508)");
	for (const [why, env, forges] of [
		["http on 80", { GITLAB_URL: "http://gitlab.example" }, ["gitlab"]],
		["http on 80 written out", { GITLAB_URL: "http://gitlab.example:80" }, ["gitlab"]],
		["forgejo on 3000, armed by default", { FORGEJO_URL: "http://forgejo.example:3000/" }, ["forgejo"]],
	]) {
		assert.equal(forgeUrlEgressChecks(env, forges).length, 1, why);
	}
	// The credential in a URL is never printed.
	assert.doesNotMatch(forgeUrlEgressChecks({ GITLAB_URL: "http://u:secret@gitlab.example:8929" }, ["gitlab"])[0].label, /secret/);
	for (const [why, env, forges] of [
		["https by default", { GITLAB_URL: "https://gitlab.example" }, ["gitlab"]],
		["https on 443 written out", { FORGEJO_URL: "https://forgejo.example:443/" }, ["forgejo"]],
		["policy off", { PI_EGRESS: "0", GITLAB_URL: "http://gitlab.example:8929" }, ["gitlab"]],
		["policy unreadable", { PI_EGRESS: "maybe", GITLAB_URL: "http://gitlab.example:8929" }, ["gitlab"]],
		["forge not in triggers", { GITLAB_URL: "http://gitlab.example:8929" }, ["forgejo"]],
		["not a URL", { GITLAB_URL: "gitlab" }, ["gitlab"]],
	]) {
		assert.deepEqual(forgeUrlEgressChecks(env, forges), [], why);
	}
});

test("the forge warning reaches doctor's output for a gitlab and a forgejo trigger (#508)", async () => {
	for (const [kind, vars] of [
		["gitlab", { GITLAB_TOKEN: "glpat_x", GITLAB_URL: "http://gitlab.example:8929" }],
		["forgejo", { FORGEJO_URL: "http://code.example.org:3000", FORGEJO_WEBHOOK_SECRET: "s", FORGEJO_TOKEN: "t" }],
	]) {
		const { out, text } = capture();
		await runDoctor(imgEnv({ PI_TRIGGERS_FILE: forgeTriggersFile(kind), ...vars }), imgDeps(out, green));
		assert.match(text(), new RegExp(`⚠ ${kind.toUpperCase()}_URL \\([^)]*\\) is http://, so with the egress policy on a job's git push and fetch fail`), `${kind}: ${text()}`);
	}
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
	assert.deepEqual(readBacks, [
		{ property: "egress", want: true, reached: true, probe: "provider" },
		{ property: "egress", want: false, reached: false, probe: "unlisted" },
		{ property: "egress", want: false, reached: false, probe: "plainhttp" },
	]);
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
	assert.match(src, /const \{ timeoutMs = 30000, stdoutOnly = false, input \} = opts;/, "runCmdCapture's probe bound");
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
	const section = doc.slice(doc.indexOf("### Lines about leftovers"), doc.indexOf("The provider and unlisted-host lines each run"));
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
	assert.deepEqual(ran, ["pi-dispatch-egress-probe-provider-777", "pi-dispatch-egress-probe-unlisted-777", "pi-dispatch-egress-probe-plainhttp-777"], "the injected pid names the probes");
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
	// Issue #508 appends `plainhttp` LAST, so the two names that were already read off `ps` keep their places.
	assert.deepEqual([...CANARY_PROBE_SLUGS], ["provider", "unlisted", "plainhttp"]);
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
	assert.match(text(), new RegExp(`reads only the ${["zero", "one", "two", "three", "four", "five"][ENV_FILE_READABLE_KEYS.length] ?? String(ENV_FILE_READABLE_KEYS.length)} it names`), "the count in the limit sentence matches the frozen set");
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
		assert.ok(lines[0].startsWith(`⚠ whether PI_PAUSE_WINDOWS_FILE or PI_SCOPED_LIMITS_FILE or PI_PROJECTS_FILE or PI_MODEL_ENDPOINTS_FILE or PI_ENVELOPE_FILE reaches the service cannot be read off ${join(cwd, ".env")}: line ${line} `), lines[0]);
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
		assert.match(text(), new RegExp(`✗ whether PI_PAUSE_WINDOWS_FILE or PI_SCOPED_LIMITS_FILE or PI_PROJECTS_FILE or PI_MODEL_ENDPOINTS_FILE or PI_ENVELOPE_FILE reaches the service cannot be read off .*: ${what.source}`));
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
	// The test helper, never the source module: a child doctor must not read a real Valkey's alloc:plan either.
	const doctorUrl = new URL("./helpers/doctor.mjs", import.meta.url).href;
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
	// Issue #448 added one, ahead of them in the file: the local section's `systemctl show podman.service`, read only where a
	// local job runs on rootful Podman's Docker API on this host.
	assert.deepEqual(named, ['"systemctl"', '"podman"', '"podman"', '"podman"'], "only the podman venue's reads and the rootful unit read name a bin");
	// Issue #433: and the spawns that name `podman` directly, by their first two arguments: the trigger-named image and its
	// entrypoint, `--fix`'s pull and tag of the default image, and the egress proxy's state. One more site picks its
	// runtime from a variable, the in-image gh probe, which is docker's with `local` and podman's without it. A new podman
	// spawn, or a docker one turned into a variable, lands here as a diff rather than going unseen.
	const direct = [...doctorSource.matchAll(/runCmd(?:Capture)?\(\w*[sS]pawn, "podman", \[("[^"]*", "[^"]*")/g)].map((m) => m[1]);
	// Issue #503 added one (PR #519 gate round 2): the proxy's mounts, read for the include's bind source. Its `exec ... cat`
	// of the include names the proxy by a variable, so the matcher above cannot see it.
	assert.deepEqual(direct, ['"image", "inspect"', '"image", "inspect"', '"pull", "ghcr.io/edgehero/pi-job:latest"', '"tag", "ghcr.io/edgehero/pi-job:latest"', '"inspect", "--format={{.State.Status}}"', '"inspect", "--format"', '"network", "inspect"']);
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
const podmanEnv = (extra = {}) => ({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_fixture", PI_BACKENDS: "podman", PI_EGRESS: "0", ...extra });
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
	// Issue #596, gate round 2: the Podman 5.8.1 this pin models answers with its CPU count (`host.cpus`), as every one
	// does, so the pin prints the ceiling a healthy host prints rather than a cpu_ceiling_unknown none does. The local
	// count stays unknown on purpose: docker is absent ("absent") or answers with no body (below).
	// Issue #596, phase 2: and with its memory (`host.memTotal`, an illustrative 7937.5 MiB), so the host budget line is a
	// healthy host's too.
	const info = PODMAN_INFO({ cpus: 4, memTotal: 8_323_072_000 });
	const { docker: _absent, ...podmanOnly } = podmanPlan({ info, image: scenario !== "podmanMissing" });
	const plan =
		scenario === "absent"
			? podmanPlan({ info })
			: {
					...EGRESS_OK,
					...podmanOnly,
					"gh auth status": { code: 0, output: ghStatusOutput },
					"gh auth token": { code: 0, output: "gho_x\n" },
					// The facts read answers with no body, as it did when this pin was captured (issue #452 keeps it so). So its CPU
					// count is genuinely unknown, as its job user and observations are (`unparseable` on each line), and the
					// local cpu_ceiling_unknown warning below is the honest output for this daemon (issue #596, gate round 2).
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
			"⚠ local: nonRoot is ASSERTED by the job image's USER directive (this repo's builds `USER pi`; an operator-built image may not), or, on a daemon that enforces bind-mount ownership with a worker uid other than 1001, the worker's own non-zero uid passed as `--user`, not enforced by it",
			"    → not verifiable from here, so treat it as a claim rather than a control: the agent runs as a non-root user",
			"✓ PI_BACKEND_FLOOR is not set, so no minimum is required of any backend",
			"✓ Job size: 4g of memory with no swap beyond it, and the CPU weight of 2 CPUs, per job (the built-in default; a project row's memory and cpus override it, docs/scoped-limits.md)",
			// Issue #596 (gate round 1): the CPU ceiling unknown is a warning per venue, since such a job runs with no --cpus.
			"⚠ local: `docker info` gave no answer that says its CPU count (unparseable), so the CPU ceiling is unknown and a job that runs gets no --cpus: it may use every core of the host (cpu_ceiling_unknown)",
			"    → make `docker info` answer for the worker's account with its CPU count, then re-run doctor; the worker reads it with every job's user",
			"✓ podman: any one job may use at most 3 of this runtime's 4 CPUs (--cpus); under contention a larger size gets more CPU than a smaller one (--cpu-shares)",
			"✓ Host budget: memory 6913m (auto: 7937m here, 1g kept for the host), CPUs 3 (auto: 4 here, 1 kept for the host); a job starts only when its size fits beside what already runs on this host",
			"✓ The host budget binds first: it holds 1 job of the default size (4g, 2 CPUs) at once, fewer than PI_CONCURRENCY (3); bigger sizes fit fewer",
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
			"    → run `pi-dispatch doctor --live`: its egress canary runs three containers built like a podman job's (the job user, --userns=keep-id, the venue's pinned flags) on a job-shaped --internal network under this account's Podman, one that must reach the provider through the proxy, one that must not reach an unlisted host, and one that must not get plain HTTP through to a listed host off port 80",
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
			"⚠ PI_PROJECTS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for projects cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"⚠ PI_ENVELOPE_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for the allocation envelope cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"✓ Jobs dir <jobs> is this account's and writable",
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
			"⚠ local: nonRoot is ASSERTED by the job image's USER directive (this repo's builds `USER pi`; an operator-built image may not), or, on a daemon that enforces bind-mount ownership with a worker uid other than 1001, the worker's own non-zero uid passed as `--user`, not enforced by it",
			"    → not verifiable from here, so treat it as a claim rather than a control: the agent runs as a non-root user",
			"⚠ local: credentialTransit is ASSERTED by the operator, not enforced: this shell's docker CLI did not say which endpoint it resolves (spawn-failed)",
			"    → nothing shows where job containers (and the credentials they carry) would go; fix what stops the docker CLI answering, then re-run doctor. The worker logs its own answer at boot (worker_started.dockerEndpointLocal)",
			"⚠ podman: egress CAN be enforced here, but PI_EGRESS is off, so this deployment is not getting it",
			"    → arm PI_EGRESS to get it (the job reaches only what the allowlist proxy permits (CONST-EGRESS-POLICY-IN-THE-ARGV))",
			"⚠ podman: jobToJobIsolation CAN be enforced here, but PI_EGRESS is off, so this deployment is not getting it",
			"    → arm PI_EGRESS to get it (two jobs cannot reach each other, structurally rather than by policy)",
			"✓ PI_BACKEND_FLOOR is not set, so no minimum is required of any backend",
			"✓ Job size: 4g of memory with no swap beyond it, and the CPU weight of 2 CPUs, per job (the built-in default; a project row's memory and cpus override it, docs/scoped-limits.md)",
			// Issue #596 (gate round 1): the CPU ceiling unknown is a warning per venue, since such a job runs with no --cpus.
			"⚠ local: `docker info` gave no answer that says its CPU count (docker-not-found), so the CPU ceiling is unknown and a job that runs gets no --cpus: it may use every core of the host (cpu_ceiling_unknown)",
			"    → make `docker info` answer for the worker's account with its CPU count, then re-run doctor; the worker reads it with every job's user",
			"✓ podman: any one job may use at most 3 of this runtime's 4 CPUs (--cpus); under contention a larger size gets more CPU than a smaller one (--cpu-shares)",
			"✓ Host budget: memory 6913m (auto: 7937m here, 1g kept for the host), CPUs 3 (auto: 4 here, 1 kept for the host); a job starts only when its size fits beside what already runs on this host",
			"✓ The host budget binds first: it holds 1 job of the default size (4g, 2 CPUs) at once, fewer than PI_CONCURRENCY (3); bigger sizes fit fewer",
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
			"⚠ PI_PROJECTS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for projects cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"⚠ PI_ENVELOPE_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for the allocation envelope cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"✓ Jobs dir <jobs> is this account's and writable",
			"✓ 0 retained workspace(s) in <jobs>/sandboxes, swept after 24h, re-open one with `pi-dispatch sandbox <jobId>`",
			"✓ Durable state: run history /home/op/.pi-dispatch/logs, settings /home/op/.pi-dispatch/settings.json \u2014 both survive a reboot (docs/backup.md)",
			"",
			"fix available: Job image present (pi-job:latest)",
			"    $ docker pull ghcr.io/edgehero/pi-job:latest && docker tag ghcr.io/edgehero/pi-job:latest pi-job:latest",
			"skipped: Job image present (pi-job:latest)",
			"",
			"doctor: some checks failed: fix the above, then re-run.",
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
			"⚠ local: nonRoot is ASSERTED by the job image's USER directive (this repo's builds `USER pi`; an operator-built image may not), or, on a daemon that enforces bind-mount ownership with a worker uid other than 1001, the worker's own non-zero uid passed as `--user`, not enforced by it",
			"    → not verifiable from here, so treat it as a claim rather than a control: the agent runs as a non-root user",
			"⚠ podman: egress CAN be enforced here, but PI_EGRESS is off, so this deployment is not getting it",
			"    → arm PI_EGRESS to get it (the job reaches only what the allowlist proxy permits (CONST-EGRESS-POLICY-IN-THE-ARGV))",
			"⚠ podman: jobToJobIsolation CAN be enforced here, but PI_EGRESS is off, so this deployment is not getting it",
			"    → arm PI_EGRESS to get it (two jobs cannot reach each other, structurally rather than by policy)",
			"✓ PI_BACKEND_FLOOR is not set, so no minimum is required of any backend",
			"✓ Job size: 4g of memory with no swap beyond it, and the CPU weight of 2 CPUs, per job (the built-in default; a project row's memory and cpus override it, docs/scoped-limits.md)",
			// Issue #596 (gate round 1): the CPU ceiling unknown is a warning per venue, since such a job runs with no --cpus.
			"⚠ local: `docker info` gave no answer that says its CPU count (unparseable), so the CPU ceiling is unknown and a job that runs gets no --cpus: it may use every core of the host (cpu_ceiling_unknown)",
			"    → make `docker info` answer for the worker's account with its CPU count, then re-run doctor; the worker reads it with every job's user",
			"✓ podman: any one job may use at most 3 of this runtime's 4 CPUs (--cpus); under contention a larger size gets more CPU than a smaller one (--cpu-shares)",
			"✓ Host budget: memory 6913m (auto: 7937m here, 1g kept for the host), CPUs 3 (auto: 4 here, 1 kept for the host); a job starts only when its size fits beside what already runs on this host",
			"✓ The host budget binds first: it holds 1 job of the default size (4g, 2 CPUs) at once, fewer than PI_CONCURRENCY (3); bigger sizes fit fewer",
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
			"⚠ PI_PROJECTS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for projects cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"⚠ PI_ENVELOPE_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for the allocation envelope cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"✓ Jobs dir <jobs> is this account's and writable",
			"✓ 0 retained workspace(s) in <jobs>/sandboxes, swept after 24h, re-open one with `pi-dispatch sandbox <jobId>`",
			"✓ Durable state: run history /home/op/.pi-dispatch/logs, settings /home/op/.pi-dispatch/settings.json \u2014 both survive a reboot (docs/backup.md)",
			"",
			"doctor: some checks failed: fix the above, then re-run.",
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
			"⚠ local: nonRoot is ASSERTED by the job image's USER directive (this repo's builds `USER pi`; an operator-built image may not), or, on a daemon that enforces bind-mount ownership with a worker uid other than 1001, the worker's own non-zero uid passed as `--user`, not enforced by it",
			"    → not verifiable from here, so treat it as a claim rather than a control: the agent runs as a non-root user",
			"⚠ podman: egress CAN be enforced here, but PI_EGRESS is off, so this deployment is not getting it",
			"    → arm PI_EGRESS to get it (the job reaches only what the allowlist proxy permits (CONST-EGRESS-POLICY-IN-THE-ARGV))",
			"⚠ podman: jobToJobIsolation CAN be enforced here, but PI_EGRESS is off, so this deployment is not getting it",
			"    → arm PI_EGRESS to get it (two jobs cannot reach each other, structurally rather than by policy)",
			"✓ PI_BACKEND_FLOOR is not set, so no minimum is required of any backend",
			"✓ Job size: 4g of memory with no swap beyond it, and the CPU weight of 2 CPUs, per job (the built-in default; a project row's memory and cpus override it, docs/scoped-limits.md)",
			// Issue #596 (gate round 1): the CPU ceiling unknown is a warning per venue, since such a job runs with no --cpus.
			"⚠ local: `docker info` gave no answer that says its CPU count (unparseable), so the CPU ceiling is unknown and a job that runs gets no --cpus: it may use every core of the host (cpu_ceiling_unknown)",
			"    → make `docker info` answer for the worker's account with its CPU count, then re-run doctor; the worker reads it with every job's user",
			"✓ podman: any one job may use at most 3 of this runtime's 4 CPUs (--cpus); under contention a larger size gets more CPU than a smaller one (--cpu-shares)",
			"✓ Host budget: memory 6913m (auto: 7937m here, 1g kept for the host), CPUs 3 (auto: 4 here, 1 kept for the host); a job starts only when its size fits beside what already runs on this host",
			"✓ The host budget binds first: it holds 1 job of the default size (4g, 2 CPUs) at once, fewer than PI_CONCURRENCY (3); bigger sizes fit fewer",
			"⚠ local: which uid a job runs as could not be read from the daemon's answer (runtime-unreadable) -- every local job is refused",
			"    → the docker CLI answered `docker info` with something no rule can read, so which uid a job may run as is unknown; point the real docker CLI at a Docker or Podman daemon",
			"✓ podman: `podman info` answered as this account (Podman 5.8.1, rootless, this host's own)",
			"✓ podman: cgroup v2 controllers are delegated to this account (cpuset, cpu, io, memory, pids), so a job's pid, memory and cpu bounds are applied",
			"✓ podman: SELinux does not confine containers here, so nothing a job mounts is relabelled",
			"✗ podman: job image is not in this account's Podman store (pi-job:latest)",
			"    → pull or load it AS THE WORKER'S ACCOUNT, since rootless Podman keeps one image store per account: podman pull ghcr.io/edgehero/pi-job:latest && podman tag ghcr.io/edgehero/pi-job:latest pi-job:latest -- jobs run with --pull=never, so the worker never fetches it",
			"✓ podman: jobs run as uid:gid 1234:1234 (passed as --user, with --userns=keep-id) with HOME=/home/pi, once the job image is in this account's store and declares anyUid",
			// Issue #481: the fixture now carries the PAT its source needs (the ✗ for a missing one is new), so the in-image
			// probe runs here as it does on the green path. Nothing about the #433 output this pins moved.
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
			"⚠ PI_PROJECTS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for projects cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"⚠ PI_ENVELOPE_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for the allocation envelope cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"✓ Jobs dir <jobs> is this account's and writable",
			"✓ 0 retained workspace(s) in <jobs>/sandboxes, swept after 24h, re-open one with `pi-dispatch sandbox <jobId>`",
			"✓ Durable state: run history /home/op/.pi-dispatch/logs, settings /home/op/.pi-dispatch/settings.json \u2014 both survive a reboot (docs/backup.md)",
			"",
			"doctor: some checks failed: fix the above, then re-run.",
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
			// Gate round 1 of PR #473: a per-container key needs no network reset; a network-helper key does.
			assert.match(said(), new RegExp(`${boot ? "a worker running as this account refuses to boot" : "every podman job is refused"}\n {4}→ ${key === "annotations" ? "remove that key from that file; the next podman job runs once it is gone" : "remove that key from that file, then stop every running container of this account that is on a bridge network, all of them at once"}`));
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

test("doctor's missing-job-image fix follows up's rule: the default pull and tag, a qualified name's own pull, a short name never pulled (#523)", async () => {
	// docker: the fix line for the image PI_JOB_IMAGE names, never ghcr's latest for an overriding name.
	for (const [image, fix] of [
		["pi-job:latest", "docker pull ghcr.io/edgehero/pi-job:latest && docker tag ghcr.io/edgehero/pi-job:latest pi-job:latest  (or build image/Dockerfile)"],
		["ghcr.io/edgehero/pi-job:2.1.0", "docker pull ghcr.io/edgehero/pi-job:2.1.0"],
		["pi-job:2.1.0", "pi-job:2.1.0 names no registry host, so a pull would fetch whatever a public registry holds under that name: build it on this host, `docker tag` an image you have as pi-job:2.1.0, or set PI_JOB_IMAGE to a registry-qualified name (such as ghcr.io/edgehero/pi-job:<version>)"],
	]) {
		const { out, text } = capture();
		await runDoctor({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_JOB_IMAGE: image }, { out, cwd: tmpdir(), spawn: fakeSpawn({ ...EGRESS_OK, "docker info": 0, "docker image": 1 }), probeValkey: async () => false, fileExists: () => true, nodeVersion: "22.19.0" });
		assert.ok(text().includes(`✗ Job image present (${image})\n    → ${fix}\n`), `${image}: ${text()}`);
	}
	// podman: the same helper inside the account-store sentence.
	// Round 2: the lead-in never suggests a pull for a name no pull is offered for (short, or localhost/).
	for (const [image, lead, fix] of [
		["ghcr.io/edgehero/pi-job:2.1.0", "pull or load", "podman pull ghcr.io/edgehero/pi-job:2.1.0"],
		["pi-job:2.1.0", "build or load", "pi-job:2.1.0 names no registry host, so a pull would fetch whatever a public registry holds under that name: build it on this host, `podman tag` an image you have as pi-job:2.1.0"],
		["localhost/my-job:dev", "build or load", "localhost/my-job:dev is a locally built name (localhost/ is no registry to pull from): build it on this host, or `podman tag` an image you have as localhost/my-job:dev"],
	]) {
		const { out, text } = capture();
		await runDoctor(podmanEnv({ PI_JOB_IMAGE: image }), podmanDeps(out, podmanPlan({ image: false })));
		assert.ok(text().includes(`→ ${lead} it AS THE WORKER'S ACCOUNT, since rootless Podman keeps one image store per account: ${fix}`), `${image}: ${text()}`);
		assert.doesNotMatch(text(), image.startsWith("ghcr") ? /podman pull ghcr\.io\/edgehero\/pi-job:latest/ : new RegExp(`podman pull ${image.replace(/[./]/g, "\\$&")}`), image);
	}
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
	assert.deepEqual(probes[0].args, ["run", "--rm", "-i", "--pull=never", "--pid=private", "--ipc=private", "--uts=private", "--cgroupns=private", "--env-host=false", "--http-proxy=false", "--entrypoint", "sh", "pi-job:latest", "-c", probes[0].args[probes[0].args.indexOf("-c") + 1], "sh", "gh", "auth", "status"]);
	// Issue #521: on stdin here too, and in no environment (the pins keep doctor's own out; the token is not in it).
	assert.equal(probes[0].stdin, "gho_x\n");
	assert.equal(probes[0].opts?.env?.GH_TOKEN, undefined);
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

// Issue #464 (gate round 1, coordinator follow-up): PI_WORKER_NAME is resolved ONCE, this shell's value else the .env's
// by the service's reader, and the fleet wording and which cron triggers are scheduled here both use it. Read from the
// shell alone, a deployment whose .env names its worker was judged as a single host.
test("a worker name in .env makes this host a fleet member for the unblessed-venue line and the cron placement, as the shell's did (#464)", async () => {
	const env = { PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_EGRESS: "0" };
	const cwd = tempDir("pi-464-name-cwd-");
	writeFileSync(join(cwd, ".env"), "PI_WORKER_NAME=mini1\n");
	const deps = (out, extra = {}) => ({ ...ghDeps(out, { ...green }, []), agentDir: NO_AGENT_DIR, readHosts: async () => ({ hosts: [] }), cwd, readEnvFile: (path) => readFileSync(path, "utf8"), ...extra });
	// Another machine's folder: not scheduled here, so not judged (was: judged in the single host's words).
	const elsewhere = capture();
	const code = await runDoctor({ ...env, PI_TRIGGERS_FILE: triggersFile(undefined, undefined, { backend: "podman", folder: "/srv/only-on-mini2" }) }, deps(elsewhere.out, { fileExists: (p) => p !== "/srv/only-on-mini2" }));
	assert.doesNotMatch(elsewhere.text(), /backend-unblessed/, elsewhere.text());
	assert.equal(code, 0, elsewhere.text());
	// Its folder here: judged, in the fleet's words.
	const here = capture();
	await runDoctor({ ...env, PI_TRIGGERS_FILE: triggersFile(undefined, undefined, { backend: "podman" }) }, deps(here.out));
	assert.ok(here.text().includes('✗ run.backend "podman" is not in this host\'s PI_BACKENDS (local), so a job of cron "nightly" that this host picks up is refused (backend-unblessed)'), here.text());
	// A shell that sets the name empty overrides the file, as for every service key: a single host again.
	const blank = capture();
	await runDoctor({ ...env, PI_WORKER_NAME: "", PI_TRIGGERS_FILE: triggersFile(undefined, undefined, { backend: "podman", folder: "/srv/only-on-mini2" }) }, deps(blank.out, { fileExists: (p) => p !== "/srv/only-on-mini2" }));
	assert.ok(blank.text().includes('✗ run.backend "podman" is not in PI_BACKENDS (local), so every job of cron "nightly" is refused (backend-unblessed)'), blank.text());
});

// Issue #471, generalising #464's PI_WORKER_NAME bolt from one key to the rule: doctor reads no service key from its
// environment outside the resolver. Three halves, each failing on a different way back to the shell: (1) the shell's
// environment is reachable under ONE name, read only where the resolution is made and where a child process is handed
// it, and never read by key; (2) every key doctor.mjs reads as `env.NAME` is a service key (so resolved) or a key
// declared shell-only with its reason; (3) every helper doctor imports and hands `env` to reads only such keys.
test("doctor.mjs reads no service key from this shell outside the resolver: every read is resolved, or declared shell-only (#471)", async () => {
	const code = readFileSync(new URL("../src/doctor.mjs", import.meta.url), "utf8").replace(/^\s*(\/\/|\*).*$/gm, "");
	// (1) The places the shell's own environment is touched, and no others.
	// Gate round 1: every line naming the shell's environment OR a name it is carried under (`venueEnv`, `spawnEnv`), so a
	// destructuring (`const { X } = spawnEnv`) or an alias (`const sv = spawnEnv`) is a new line here and fails.
	const sites = code.split("\n").filter((l) => /\b(?:shellVars|venueEnv|spawnEnv)\b/.test(l)).map((l) => l.trim());
	const allowed = [
		/^export async function runDoctor\(shellVars = process\.env, deps = \{\}\) \{$/,
		/^agentDir = agentDirFrom\(shellVars\),$/,
		/^const venue = deploymentVenueEnv\(\{ env: shellVars, /,
		/^let venueEnv = shellVars;$/,
		/^venueEnv = venue\.env;$/,
		/^seams\.spawnEnv = shellVars;$/,
		/^seams\.serviceEnv = resolveDoctorEnv\(venueEnv, seams\.serviceEnvFile\);$/,
		/^let checks = await collectChecks\(venueEnv, seams\);$/,
		/^checks = await collectChecks\(venueEnv, seams\);$/,
		/^export function resolveDoctorEnv\(venueEnv, file\) \{$/,
		/^const record = resolveServiceEnv\(\{ env: venueEnv, file, keys \}\);$/,
		/^record\.shellOnly\.unshift\(\.\.\.resolveServiceEnv\(\{ env: venueEnv, file, keys: STACK_KEYS \}\)\.shellOnly\);$/,
		/^const more = resolveServiceEnv\(\{ env: venueEnv, file, keys: names \}\);$/,
		/^export async function collectChecks\(shellVars, seams\) \{$/,
		/^const service = seams\.serviceEnv \?\? resolveDoctorEnv\(shellVars, serviceEnvFile\);$/,
		/^const spawnEnv = seams\.spawnEnv \?\? shellVars;$/,
		/^const shellValue = \(name\) => \(Object\.hasOwn\(spawnEnv, name\) \? spawnEnv\[name\] : undefined\);$/,
		/^const \{ cwd, spawn, probeValkey, readHosts = defaultReadHosts, fileExists, nodeVersion, platform, agentDir = agentDirFrom\(spawnEnv\), readHostPiFn = readHostPi, /,
		/^const probe = await runCmdCapture\(spawn, ghProbeBin, ghProbeArgs\(jobImage, ghProbeBin\), \{ env: spawnEnv, input: `\$\{token\}\\n` \}\);$/,
		/^const res = await runCmdCapture\(spawn, process\.execPath, \[cli, "import-pi", "--with-packages", "--no-host-packages", "--to", overlay\], \{ env: spawnEnv, cwd, timeoutMs: 600000 \}\);$/,
		/^const res = await runCmdCapture\(spawn, file, args, \{ env: spawnEnv, cwd, timeoutMs: 15000 \}\);$/,
	];
	assert.equal(sites.length, allowed.length, `the shell's environment is touched at exactly the pinned sites:\n${sites.join("\n")}`);
	sites.forEach((line, n) => assert.match(line, allowed[n]));
	assert.equal([...code.matchAll(/\bprocess\.env\b/g)].length, 1, "process.env only as runDoctor's default");
	// Handed on whole, never read by key: a `venueEnv.NAME` would be a service key read from the shell.
	// One by-name read, pinned above: `shellValue`, the probe PAT's value from this shell alone (round-cap re-review, D1).
	assert.deepEqual([...code.matchAll(/\b(?:shellVars|venueEnv|spawnEnv)\s*(?:\?\.|\.|\[)\s*\[?["']?[A-Za-z_]/g)].map((m) => m[0]), ["spawnEnv[n"]);
	// The one resolution runDoctor hands collectChecks, and `--live` the same one.
	assert.match(code, /seams\.serviceEnv = resolveDoctorEnv\(venueEnv, seams\.serviceEnvFile\);\n\tconst env = seams\.serviceEnv\.env;/);

	// (2) Every `env.NAME` doctor reads is resolved or declared.
	const named = new Set([...code.matchAll(/\benv(?:\??\.([A-Z][A-Z0-9_]{2,})\b|\??\.?\[\s*["']([A-Z][A-Z0-9_]{2,})["']\s*\])/g)].map((m) => m[1] ?? m[2]));
	assert.ok(named.size > 40, "the scan still sees doctor's reads");
	const undeclared = [...named].filter((k) => !SERVICE_ENV_KEYS.includes(k) && !Object.hasOwn(DOCTOR_SHELL_KEYS, k));
	assert.deepEqual(undeclared, [], "a key doctor reads is a service key (resolved) or declared shell-only with its reason");
	assert.deepEqual(SERVICE_ENV_KEYS.filter((k) => Object.hasOwn(DOCTOR_SHELL_KEYS, k)), [VALKEY_SHARED_NAME], "only the .env-only opt-in is both, and there by its own rule");

	// (3) Every function doctor.mjs IMPORTS and hands `env` to, probed for the keys it reads. A new helper handed `env`
	// fails here until it is probed, so a helper cannot read a service key doctor never resolved.
	const imported = new Set([...code.matchAll(/^import \{([^}]*)\} from/gm)].flatMap((m) => m[1].split(",").map((n) => n.trim().split(/\s+as\s+/).pop())).filter(Boolean));
	const handedEnv = new Set();
	for (const m of code.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/g)) {
		if (!imported.has(m[1])) continue;
		// The call's OWN arguments: strings blanked (".env" is not a read) and nested calls folded, since each is its own match.
		let args = m[2].replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
		for (let prev = null; prev !== args; ) [prev, args] = [args, args.replace(/\([^()]*\)/g, "()")];
		if (/\benv\b(?!\s*(?:\?\.|\.|\[|:))/.test(args)) handedEnv.add(m[1]);
	}
	const { agentDirFrom } = await import("../src/host-pi.mjs");
	const cfg = await import("../src/config.mjs");
	const egress = await import("../src/egress.mjs");
	const backends = await import("../src/backends.mjs");
	const podman = await import("../src/backend-podman.mjs");
	const enoent = () => {
		throw Object.assign(new Error("absent"), { code: "ENOENT" });
	};
	const noFs = { statSync: enoent, readFileSync: enoent, readdirSync: enoent, lstatSync: enoent };
	const runtimeObs = await import("../src/runtime-observations.mjs");
	const rootfulEndpoint = { local: true, endpoint: "unix:///run/podman/podman.sock" };
	const rootfulDaemon = { answered: true, facts: { shape: "podman", podman: true, rootless: false, remoteSocketPath: "unix:///run/podman/podman.sock" } };
	const probes = {
		agentDirFrom: (e) => agentDirFrom(e),
		logsDirPath: (e) => (cfg.logsDirPath(e, "/h"), cfg.logsDirPath(e, null)),
		settingsFilePath: (e) => (cfg.settingsFilePath(e, "/h"), cfg.settingsFilePath(e, null)),
		globalExtensionsEnabled: (e) => cfg.globalExtensionsEnabled(e),
		allowedModelsFrom: (e) => cfg.allowedModelsFrom(e),
		defaultLogsDir: (e) => cfg.defaultLogsDir(e, null),
		defaultSettingsFile: (e) => cfg.defaultSettingsFile(e, null),
		jobsDirPath: (e) => cfg.jobsDirPath(e),
		accountTempRoot: (e) => cfg.accountTempRoot(e),
		defaultSandboxDir: (e) => cfg.defaultSandboxDir(e),
		legacyTempStateDir: (e) => cfg.legacyTempStateDir(e),
		egressArmed: (e) => egress.egressArmed(e),
		egressProxyName: (e) => egress.egressProxyName(e),
		venuesOf: (e) => backends.venuesOf(e),
		// Its only reads of `env` are containers.conf's own variables, through the lister `podmanConfWidening` reaches.
		observePodman: (e) => podman.podmanConfWidening({ fs: noFs, home: "/h", env: e, euid: 1 }),
		podmanConfWidening: (e) => podman.podmanConfWidening({ fs: noFs, home: "/h", env: e, euid: 1 }),
		// Reached as `spec.resolve(env)` through BOOT_FILES, a member call the scan does not attribute, so probed by name.
		// #448 (PR #473): both read the environment only through `rootfulConfChain`, on a rootful Podman on this host.
		observeHost: (e) => runtimeObs.observeHost({ endpoint: rootfulEndpoint, daemon: rootfulDaemon, fs: noFs, unit: null, env: e }),
		observeRootfulConf: (e) => runtimeObs.observeRootfulConf({ endpoint: rootfulEndpoint, daemon: rootfulDaemon, fs: noFs, readService: async () => ({ code: 1, stdout: "" }), env: e, unit: { read: false, reason: "probe" } }),
		pauseWindowsFilePath: (e) => cfg.pauseWindowsFilePath(e),
		// Issue #596: the default job size, as the worker's config reads it.
		jobSizeDefaults: async (e) => (await import("../src/job-size.mjs")).jobSizeDefaults(e),
		// Issue #596, phase 2: the host budget's settings and a project's size, as the worker reads them.
		hostBudgetSettings: async (e) => (await import("../src/host-budget.mjs")).hostBudgetSettings(e),
		resolveJobSize: async (e) => (await import("../src/job-size.mjs")).resolveJobSize({ env: e }),
		scopedLimitsFilePath: (e) => cfg.scopedLimitsFilePath(e),
		modelEndpointsFilePath: (e) => cfg.modelEndpointsFilePath(e),
		// Issue #503: whether endpoints are declared, read as the service reads PI_MODEL_ENDPOINTS_FILE.
		endpointsDeclaredIn: async (e) => (await import("../src/egress-cli.mjs")).endpointsDeclaredIn({ env: e, cwd: "/nonexistent-503", fs: { readFileSync: enoent, existsSync: () => false }, platform: "linux" }),
	};
	assert.deepEqual([...handedEnv].filter((n) => !Object.hasOwn(probes, n)).sort(), [], "every imported helper doctor hands env to is probed here");
	const probedReads = {};
	for (const [name, call] of Object.entries(probes)) {
		const read = new Set();
		const probe = new Proxy({}, { get: (_, k) => (typeof k === "string" && read.add(k), undefined), has: (_, k) => (read.add(String(k)), false) });
		try {
			await call(probe);
		} catch {}
		probedReads[name] = [...read];
		for (const k of read) assert.ok(SERVICE_ENV_KEYS.includes(k) || Object.hasOwn(DOCTOR_SHELL_KEYS, k), `${name} reads ${k}, which doctor neither resolves nor declares shell-only`);
	}
	// The probes of #448's two readers must reach the chain, or they prove nothing: they read the service's conf variables.
	for (const name of ["observeHost", "observeRootfulConf"]) assert.deepEqual([...probedReads[name]].sort(), ["CONTAINERS_CONF", "CONTAINERS_CONF_OVERRIDE", "HOME", "XDG_CONFIG_HOME"], name);
	// And doctor hands them the RESOLVED environment (`env`, never this shell's), so they judge the service's chain.
	assert.match(code, /const observed = observeHost\(\{ endpoint, daemon, fs, unit, env \}\);/);
	assert.match(code, /const rootful = await observeRootfulConf\(\{ endpoint, daemon, fs: observationFs, readService: readPodmanService, env, unit \}\);/);
	// underOsTempDir reaches doctor as the `underTemp` seam rather than by name, and reads TMPDIR and TEMP.
	const read = new Set();
	cfg.underOsTempDir("/x", new Proxy({}, { get: (_, k) => (typeof k === "string" && read.add(k), undefined) }), { platform: "win32" });
	for (const k of read) assert.ok(SERVICE_ENV_KEYS.includes(k), k);
});

// Issue #471: the resolution covers every key the allowlist names that the venue read and the .env-only opt-in do not,
// and each of them the same way: taken from a plain line where this shell sets none, this shell's where it does, and a
// disagreement returned for every one, whatever the key.
test("resolveDoctorEnv takes every non-venue service key from .env where this shell sets none, and returns every disagreement (#471)", () => {
	const keys = SERVICE_ENV_KEYS.filter((k) => !["PI_BACKENDS", "PI_EGRESS", "PI_EGRESS_PROXY", VALKEY_SHARED_NAME].includes(k));
	const text = `${keys.map((k) => `${k}=file-${k.toLowerCase()}`).join("\n")}\n`;
	const file = serviceEnvFileOf(Buffer.from(text), "/d/.env", "systemd");
	const alone = resolveDoctorEnv({}, file);
	for (const k of keys) assert.equal(alone.env[k], `file-${k.toLowerCase()}`, k);
	assert.deepEqual(Object.keys(alone.fromFile).sort(), [...keys].sort());
	assert.deepEqual(alone.disagreements, []);
	const shell = Object.fromEntries(keys.map((k) => [k, `shell-${k}`]));
	const both = resolveDoctorEnv(shell, file);
	for (const k of keys) assert.equal(both.env[k], `shell-${k}`, `${k}: this shell's value is judged`);
	assert.deepEqual(both.disagreements.map((d) => d.key).sort(), [...keys].sort(), "and every key is a disagreement, said");
	assert.deepEqual(both.fromFile, {});
	// The venue keys and the opt-in are not this resolution's: the venue read and the owner check own them.
	const venue = resolveDoctorEnv({}, serviceEnvFileOf(Buffer.from("PI_BACKENDS=podman\nPI_VALKEY_SHARED=1\n"), "/d/.env", "systemd"));
	assert.deepEqual(venue.fromFile, {});
});

// Issue #471: the rule end to end, through runDoctor and a real `.env`. A deployment folder, this shell, and the lines doctor
// prints for them.
const envDoctor = async (envText, shell, extra = {}) => {
	const cwd = scaffoldedCwd();
	if (envText !== null) writeFileSync(join(cwd, ".env"), envText);
	const calls = [];
	const { out, text } = capture();
	const code = await runDoctor(ghEnv(shell), { ...ghDeps(out, extra.plan ?? green, calls), cwd, agentDir: NO_AGENT_DIR, readEnvFile: (path) => readFileSync(path), ...(extra.deps ?? {}) });
	return { code, text: text(), calls, envPath: join(cwd, ".env"), cwd };
};

test("a key only the deployment's .env sets is judged as the service reads it, and its source is said (#471)", async () => {
	// Before #471 doctor read PI_GLOBAL_ALLOW_EXTENSIONS from its shell alone, so a .env value the worker refuses to boot on
	// got no line at all.
	const bad = await envDoctor("PI_GLOBAL_ALLOW_EXTENSIONS=false\nPI_SESSIONS_TTL_DAYS=30\n", {});
	assert.match(bad.text, /✗ PI_GLOBAL_ALLOW_EXTENSIONS is "false", which is neither on nor off/);
	assert.ok(bad.text.includes(`✓ service settings read from ${bad.envPath}, as the service reads them (this shell does not set them): PI_SESSIONS_TTL_DAYS, PI_GLOBAL_ALLOW_EXTENSIONS\n`), bad.text);
	assert.equal(bad.code, 1);
	// The same deployment with nothing in the file: no line about either.
	const none = await envDoctor(null, {});
	assert.doesNotMatch(none.text, /PI_GLOBAL_ALLOW_EXTENSIONS|service settings read from/);
});

// Issue #481: a present but EMPTY line is left off the settings line only where every reader of the key takes empty as
// unset (`EMPTY_READ_AS_UNSET`, proven in doctor-empty-keys.test.mjs). `KEY=` is what init scaffolds for every optional
// key, and the line listed twelve of them on a fresh deployment; a key whose empty value is a value is still named.
test("the service settings line hides an empty key only where it is proven unset (#481)", async () => {
	const mixed = await envDoctor("PI_SESSIONS_TTL_DAYS=30\nWEBHOOK_SECRET=\nFORGEJO_URL=\nAZURE_WEBHOOK_HEADER=\nGITLAB_URL=\n", {});
	// GITLAB_URL= is not unset: both processes default it with `??`, so the empty string becomes the API base.
	assert.ok(mixed.text.includes(`✓ service settings read from ${mixed.envPath}, as the service reads them (this shell does not set them): PI_SESSIONS_TTL_DAYS, GITLAB_URL\n`), mixed.text);
	// Nothing but proven-unset empty lines: no line at all, as with no file.
	const blank = await envDoctor("WEBHOOK_SECRET=\nGITLAB_TOKEN=\n", {});
	assert.doesNotMatch(blank.text, /service settings read from/);
	assert.equal(blank.code, 0, blank.text);
});

test("fileConfigures decides per key and per value shape: blank is unset only where the reader trims (#481)", () => {
	assert.equal(fileConfigures("WEBHOOK_SECRET", "  "), false, "the receiver trims it");
	assert.equal(fileConfigures("PI_SESSIONS_TTL_DAYS", "  "), true, "the loader does not read a blank count as unset");
	assert.equal(fileConfigures("PI_SESSIONS_TTL_DAYS", ""), false);
	assert.equal(fileConfigures("DOCKER_HOST", " "), true, "docker compares with \"\", not a trim");
	assert.equal(fileConfigures("GITLAB_URL", ""), true, "unproven keys always configure");
	assert.equal(fileConfigures("HOME", ""), true);
});

test("a .env straight from init: the settings line names no key init left empty (#481)", async () => {
	const cwd = tempDir("pi-init-env-");
	runInit(cwd, { out: () => {}, platform: "linux", newPassword: () => "a".repeat(64) });
	const text = readFileSync(join(cwd, ".env"), "utf8");
	const empty = [...text.matchAll(/^([A-Z][A-Z0-9_]*)=$/gm)].map((m) => m[1]);
	assert.ok(empty.includes("WEBHOOK_SECRET") && empty.includes("GITLAB_TOKEN"), "init still scaffolds empty keys, so this test tests something");
	const { out, text: printed } = capture();
	await runDoctor(ghEnv({}), { ...ghDeps(out, green, []), cwd, agentDir: NO_AGENT_DIR, readEnvFile: (path) => readFileSync(path) });
	const line = printed().split("\n").find((l) => l.startsWith("✓ service settings read from "));
	assert.ok(line, printed());
	const named = line.slice(line.lastIndexOf(": ") + 2).split(", ");
	assert.deepEqual(named.filter((k) => empty.includes(k)), [], line);
	assert.ok(named.includes("PI_JOB_IMAGE") && named.includes("RECEIVER_PORT"), "and the keys init did set are still named");
	const gh = printed().split("\n").find((l) => l.startsWith("✓ GitHub auth settings read from "));
	assert.ok(gh?.endsWith(": GITHUB_AUTH_SOURCE"), printed());
});

// Issue #481: the venue line, the CLI-variable warnings and the closing line judge an empty value by the same allowlist.
test("an empty venue key is not named as read from .env: the worker reads it as unset (#481)", async () => {
	const cwd = scaffoldedCwd();
	const envPath = join(cwd, ".env");
	const { PI_BACKENDS: _b, PI_EGRESS: _e, ...shell } = podmanEnv();
	writeFileSync(envPath, "PI_BACKENDS=podman\nPI_EGRESS=\nPI_EGRESS_PROXY=\n");
	const mixed = capture();
	await runDoctor(shell, { ...podmanDeps(mixed.out, podmanPlan(), []), cwd, platform: "linux", readEnvFile: (path) => readFileSync(path, "utf8") });
	assert.ok(mixed.text().includes(`✓ venue keys read from ${envPath} (PI_BACKENDS="podman"), as the service reads them: this shell does not set them\n`), mixed.text());
	writeFileSync(envPath, "PI_EGRESS=\n");
	const blank = capture();
	await runDoctor({ ...shell, PI_BACKENDS: "podman" }, { ...podmanDeps(blank.out, podmanPlan(), []), cwd, platform: "linux", readEnvFile: (path) => readFileSync(path, "utf8") });
	assert.doesNotMatch(blank.text(), /venue keys read from/);
	assert.match(blank.text(), /✓ Jobs run on: podman/);
});

test("a CLI variable left empty in .env is warned about unless its tool reads empty as unset (#481)", () => {
	const fromFile = { DOCKER_HOST: "", GH_TOKEN: "", CONTAINERS_CONF: "", CONTAINER_HOST: "", CONTAINER_CONNECTION: "", CONTAINERS_STORAGE_CONF: "", XDG_CONFIG_HOME: "", HOME: "" };
	const lines = cliNotHandedLines({ fromFile }, "/d/.env");
	// podman takes CONTAINER_HOST and CONTAINER_CONNECTION by os.LookupEnv (an empty one switches it to remote), and the
	// storage conf, XDG_CONFIG_HOME and HOME are read as values by at least one of their readers.
	assert.deepEqual(lines.map((l) => l.label.split(" ")[0]).sort(), ["CONTAINERS_STORAGE_CONF", "CONTAINER_CONNECTION", "CONTAINER_HOST", "HOME", "XDG_CONFIG_HOME"]);
	assert.ok(lines.some((l) => /^HOME is set in \/d\/\.env \(""\), and doctor hands nothing/.test(l.label)));
	assert.equal(cliNotHandedLines({ fromFile: { DOCKER_HOST: "tcp://x:2375" } }, "/d/.env").length, 1, "a value is still warned about");
});

test("doctor's ready line counts an empty .env key as the file deciding something only where it is not proven unset (#481)", async () => {
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "PI_JOB_IMAGE=\nWEBHOOK_SECRET=\nPI_EGRESS_PROXY=\nDOCKER_HOST=\n");
	const quiet = capture();
	assert.equal(await runDoctor(podmanEnv(), podmanDeps(quiet.out, podmanPlan(), [], { cwd, platform: "linux" })), 0, quiet.text());
	assert.ok(quiet.text().endsWith("\ndoctor: ready. Start the worker with `pi-dispatch worker`.\n"), quiet.text());
	// GITLAB_URL= is a value to both processes (the API base becomes ""), so the file decided something.
	writeFileSync(join(cwd, ".env"), "GITLAB_URL=\n");
	const said = capture();
	assert.equal(await runDoctor(podmanEnv(), podmanDeps(said.out, podmanPlan(), [], { cwd, platform: "linux" })), 0, said.text());
	assert.match(said.text(), /doctor: ready\. Start the worker as the service/);
});

test("a shell/.env disagreement is a ✗ naming both values, a secret by name only, and doctor judges this shell's (#471)", async () => {
	const envText = "PI_GLOBAL_ALLOW_EXTENSIONS=false\nWEBHOOK_SECRET=file-secret-value\nGITLAB_URL=https://tok:en@gitlab.file.example\n";
	const r = await envDoctor(envText, { PI_GLOBAL_ALLOW_EXTENSIONS: "0", WEBHOOK_SECRET: "shell-secret-value", GITLAB_URL: "https://gitlab.shell.example" });
	const p = r.envPath;
	assert.ok(
		r.text.includes(`✗ this shell and ${p} disagree: PI_GLOBAL_ALLOW_EXTENSIONS is "0" in this shell and "false" in ${p}; WEBHOOK_SECRET is set differently in this shell and in ${p} (neither value is shown); GITLAB_URL is "https://gitlab.shell.example" in this shell and "https://gitlab.file.example" in ${p}. doctor judged this shell's values below, which a worker started by hand from this shell runs, while the service runs the file's\n    → make them agree: change ${p} (what the service reads), or unset the key in this shell, then re-run doctor\n`),
		r.text,
	);
	assert.doesNotMatch(r.text, /secret-value|tok:en/, "no secret and no URL credential reaches output");
	// This shell's value is what the rest judges: "0" parses, so no ✗ for the knob.
	assert.doesNotMatch(r.text, /PI_GLOBAL_ALLOW_EXTENSIONS is "false", which is neither/);
	assert.equal(r.code, 1, "a disagreement fails the run: doctor cannot say which of the two runs");
	// Two URLs that differ only in what is not shown are still a disagreement, said without either value.
	const hidden = await envDoctor("GITLAB_URL=https://a:b@gitlab.example\n", { GITLAB_URL: "https://c:d@gitlab.example" });
	assert.ok(hidden.text.includes(`GITLAB_URL is set differently in this shell and in ${hidden.envPath} (neither value is shown)`), hidden.text);
	assert.doesNotMatch(hidden.text, /a:b|c:d/);
	// Agreeing values are no disagreement.
	const same = await envDoctor("PI_SESSIONS_TTL_DAYS=30\n", { PI_SESSIONS_TTL_DAYS: "30" });
	assert.doesNotMatch(same.text, /disagree/);
});

test("a .env line doctor cannot read the way the service will is named and its value never used (#471)", async () => {
	// A `$`: systemd hands the worker "/srv/$USER/logs" as written, a sourcing wrapper expands it. Neither is doctor's to pick.
	const r = await envDoctor("PI_LOGS_DIR=/srv/$USER/logs\n", {});
	assert.ok(r.text.includes(`✗ ${r.envPath} assigns PI_LOGS_DIR (line 1) in a form the service's loader may read differently from doctor's reader (quotes, a $, a space), so doctor used none of those values and judged this shell's values or the defaults instead: the service's own are unknown`), r.text);
	assert.doesNotMatch(r.text, /\/srv\/(\$USER|[a-z]+)\/logs/, "the value is not used anywhere");
});

test("PI_JOB_IMAGE from .env is the image doctor inspects and runs, said; one the worker's validator refuses is never handed to docker (#471)", async () => {
	const plan = { ...green, "gh auth status": { code: 0, output: ghStatusOutput }, "gh auth token": { code: 0, output: "gho_x\n" }, "docker run": 0 };
	const r = await envDoctor("PI_JOB_IMAGE=team/img:1\n", {}, { plan });
	assert.ok(r.calls.some((c) => c.cmd === "docker" && c.args.join(" ") === "image inspect team/img:1"), "the service's image is the one inspected");
	assert.ok(r.text.includes(`✓ Job image present (team/img:1) -- PI_JOB_IMAGE read from ${r.envPath}, as the service reads it; this shell does not set it`), r.text);
	assert.ok(r.calls.some((c) => c.cmd === "docker" && c.args[0] === "run" && c.args.includes("team/img:1") && c.args.includes("gh")), "and the probe runs in it");
	// A leading dash is a flag to docker: named, and nothing is spawned with it.
	const dash = await envDoctor("PI_JOB_IMAGE=--privileged\n", {}, { plan });
	assert.ok(!dash.calls.some((c) => c.args.includes("--privileged")), "the refused value reaches no argv");
	assert.ok(dash.text.includes(`✗ PI_JOB_IMAGE is "--privileged" -- PI_JOB_IMAGE read from ${dash.envPath}, as the service reads it; this shell does not set it, and it must not start with "-", which the runtime reads as a flag where the image belongs: the worker refuses to boot on it (exit 2), so doctor ran and inspected nothing with it and judged the default pi-job:latest in its place`), dash.text);
	assert.ok(dash.calls.some((c) => c.args.join(" ") === "image inspect pi-job:latest"));
	// The worker's `||`: an empty value is the default, where doctor's `??` inspected an image named "".
	const empty = await envDoctor(null, { PI_JOB_IMAGE: "" }, { plan });
	assert.ok(empty.calls.some((c) => c.args.join(" ") === "image inspect pi-job:latest"), "an empty PI_JOB_IMAGE is the default, as the worker reads it");
	assert.ok(!empty.calls.some((c) => c.args[0] === "image" && c.args.at(-1) === ""));
	assert.deepEqual(["", " x", "x ", "-x", "a\u001bb", "pi:1"].map((v) => jobImageOf({ PI_JOB_IMAGE: v }).refused === null), [true, false, false, false, false, true]);
});

test("a .env-only secret never rides into a process doctor starts, and a PAT only the file holds means the in-image probe is not run, said (#471)", async () => {
	const plan = { ...green, "docker run": 0 };
	const r = await envDoctor("GITHUB_AUTH_SOURCE=pat\nGITHUB_PAT=ghp_from_file_123\nWEBHOOK_SECRET=wh_file_only\n", {}, { plan });
	assert.ok(!r.calls.some((c) => c.cmd === "docker" && c.args[0] === "run" && c.args.includes("gh")), "no probe: its token would come from .env");
	assert.ok(r.text.includes(`⚠ in-image gh auth: not checked, because GITHUB_PAT comes from ${r.envPath} and doctor hands nothing from that file to a program it starts`), r.text);
	assert.doesNotMatch(r.text, /ghp_from_file_123|wh_file_only/);
	// A GITHUB_PAT_VAR from the file names which variable is the token: the same, even when this shell holds that variable.
	const named = await envDoctor("GITHUB_AUTH_SOURCE=pat\nGITHUB_PAT_VAR=MY_PAT\n", { MY_PAT: "ghp_shell_456" }, { plan });
	assert.ok(!named.calls.some((c) => c.args[0] === "run" && c.args.includes("gh")));
	assert.match(named.text, /in-image gh auth: not checked, because GITHUB_PAT_VAR comes from/);
	// This shell's own PAT: the probe runs with it, as before #471.
	const shell = await envDoctor("GITHUB_AUTH_SOURCE=pat\n", { GITHUB_PAT: "ghp_shell_789" }, { plan });
	assert.equal(shell.calls.find((c) => c.args[0] === "run" && c.args.includes("gh"))?.stdin, "ghp_shell_789\n");
	// A PAT set differently in both places is a disagreement on a credential: named, never shown.
	const both = await envDoctor("GITHUB_AUTH_SOURCE=pat\nGITHUB_PAT=ghp_file_789\n", { GITHUB_PAT: "ghp_shell_000" }, { plan });
	assert.ok(both.text.includes(`GITHUB_PAT is set differently in this shell and in ${both.envPath} (neither value is shown)`), both.text);
	assert.doesNotMatch(both.text, /ghp_file_789|ghp_shell_000/);
});


test("the provider key's auth.json is read from the agent dir the service's .env names (#471)", { skip: skipNoPi }, async () => {
	const agent = tempDir("pi-471-agent-");
	writeFileSync(join(agent, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "sk-from-auth-json" } }));
	const r = await envDoctor(`PI_CODING_AGENT_DIR=${agent}\n`, { ANTHROPIC_API_KEY: undefined });
	assert.ok(r.text.includes(`✓ Provider key set (anthropic) -- from pi auth.json -- PI_CODING_AGENT_DIR read from ${r.envPath}, as the service reads it; this shell does not set it`), r.text);
	assert.doesNotMatch(r.text, /sk-from-auth-json/);
});

test("doctor --fix: a session store named only in .env is offered at the prompt tier, shown first (#471)", async () => {
	const sessionsDir = join(tempDir("pi-471-sessions-"), "store");
	const made = [];
	const { fn: promptFn, calls: prompts } = promptRecorder(false);
	const r = await envDoctor(`PI_SESSIONS_DIR=${sessionsDir}\n`, { PI_TRIGGERS_FILE: resumeTriggersFile(), GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_fixture" }, { deps: { fix: true, promptFn, mkdir: (p) => made.push(p), fileExists: (p) => p !== sessionsDir } });
	assert.deepEqual(prompts, ["run this? [y/N] "], "asked, not run silently");
	assert.ok(r.text.includes(`fix available: Session store does not exist (${sessionsDir}) -- PI_SESSIONS_DIR read from ${r.envPath}, as the service reads it; this shell does not set it\n    $ mkdir -p ${sessionsDir} && chmod 700 ${sessionsDir}\n`), r.text);
	assert.deepEqual(made, [], "declined, so nothing was created");
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
	// The worker's predicate, imported from the worker's module (issue #504 part B imports envelopeJobPaths beside it).
	assert.match(doctorSource, /^import \{ cronPlacement(, envelopeJobPaths)? \} from "\.\/schedules\.mjs";$/m);
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
	// With local blessed, the docker route is named (issue #468 over #471: `pi-dispatch up`, never an offer doctor runs).
	const mixed = capture();
	await runDoctor(podmanEnv({ PI_BACKENDS: "local,podman" }), { ...podmanDeps(mixed.out, { ...green, ...podmanPlan() }, [], { probeValkey: async () => false }), fix: true, promptFn: async () => false });
	assert.match(mixed.text(), /✗ Valkey reachable \(redis:\/\/127\.0\.0\.1:6379\)\n {4}→ run `pi-dispatch up` in the deployment folder/);
	assert.doesNotMatch(mixed.text(), /fix available: Valkey reachable/);
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
	// The plain HTTP probe (issue #508) refused by default, as a current proxy does; a test that reads it names it.
	spawn: fakeSpawn({ [`${PODMAN_PROBE}plainhttp`]: 3, ...canary, ...toPodman(liveOk({ uid: "1234" })), ...toPodman(livePeersOk(plan)), ...podmanPlan(), "podman network": 0, ...canary }, calls),
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
const podmanProbeArgv = (slug, url, script = egressCanaryScript(url)) => [
	"run",
	`--name=pi-dispatch-egress-probe-${slug}-1`,
	"--pull=never",
	"--rm",
	"--init",
	"--cap-drop=ALL",
	"--security-opt",
	"no-new-privileges",
	"--pids-limit=512",
	"--memory=4g",
	"--memory-swap=4g",
	"--cpu-shares=2048",
	"--shm-size=1g",
	"--label=pi.dispatch.mem=4096",
	"--label=pi.dispatch.cpu=200",
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
	script,
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
		"run --name=pi-dispatch-egress-probe-plainhttp-1 --pull=never",
		"network disconnect -f",
		"network rm pi-dispatch-egress-doctor-1",
	]);
	// The probes' argv, exactly: the venue's pins and the job user, never a weaker hand-rolled one.
	const probes = calls.filter((c) => String(c.args[1]).startsWith("--name=pi-dispatch-egress-probe-"));
	assert.deepEqual(probes[0].args, podmanProbeArgv("provider", "https://api.anthropic.com/v1/messages"));
	assert.deepEqual(probes[1].args, podmanProbeArgv("unlisted", "https://example.com/"));
	// Issue #508: the plain HTTP probe is a job's argv too, running the raw forward request at the job's own proxy.
	assert.deepEqual(probes[2].args, podmanProbeArgv("plainhttp", "http://api.anthropic.com:443/", egressCanaryPlainScript("http://api.anthropic.com:443/", { proxyUrl: "http://pi-dispatch-egress-proxy:3128" })));
	// want and reached per probe, carried where the verdict reads them, and the lines say podman.
	assert.deepEqual(held.filter((c) => c.readBack).map((c) => c.readBack), [
		{ property: "egress", want: true, reached: true, probe: "provider" },
		{ property: "egress", want: false, reached: false, probe: "unlisted" },
		{ property: "egress", want: false, reached: false, probe: "plainhttp" },
	]);
	assert.ok(labels.includes("podman: Egress policy reaches the provider (api.anthropic.com answered, so the whole path works and no key was spent)"), labels.join("\n"));
	assert.ok(labels.includes("podman: Egress policy denies an unlisted host (the deny direction is the half an allowlist can silently lose)"));
	assert.ok(labels.includes("podman: Egress policy refuses plain HTTP to a listed host off port 80 (api.anthropic.com:443 without a tunnel; only a CONNECT reaches 443)"));
	assert.ok(held.some((c) => c.ok && c.label === "read back on podman: egress holds (the provider was reached, an unlisted host was not, and plain HTTP off port 80 was refused)"), labels.join("\n"));
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
	assert.match(stale.find((c) => c.label.startsWith("read back on podman: egress")).label, /egress not read back: the egress canary did not run all three probes \(see the egress lines above\)/);
	const refused = await run({ [`${PODMAN_PROBE}provider`]: 125, [`${PODMAN_PROBE}unlisted`]: 3 });
	assert.ok(refused.some((c) => c.label === "podman: Egress policy probe for the provider did not run (podman run exited 125)"));
	assert.match(refused.find((c) => c.label.startsWith("read back on podman: egress")).label, /egress not read back: an egress probe did not run to an answer/);
	// Issue #508: a proxy on rules from before it lets plain HTTP through, and podman's verdict says which probe.
	const plain = await run({ [`${PODMAN_PROBE}provider`]: 0, [`${PODMAN_PROBE}unlisted`]: 3, [`${PODMAN_PROBE}plainhttp`]: 0 });
	assert.ok(plain.some((c) => c.warn && !c.ok && c.label === "podman: Egress policy lets plain HTTP through to api.anthropic.com on port 443, so a client that does not tunnel reaches every port of a listed host"));
	assert.equal(plain.find((c) => c.label.startsWith("read back on podman: egress")).label, "read back on podman: egress does NOT hold -- declared enforced, observed: plain HTTP to a listed host off port 80 was let through");
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
	const plan = { [`${PODMAN_PROBE}provider`]: 0, [`${PODMAN_PROBE}unlisted`]: 3, [`${PODMAN_PROBE}plainhttp`]: 3, ...toPodman(liveOk({ uid: "1234" })), ...toPodman(livePeersOk({})), "podman network": 0, ...podmanPlan() };
	const code = await runDoctor(env, { ...podmanDeps(out, plan, calls), live: true, liveFs: liveFsAs(1234), isAlive: () => false, pid: 7, nonce: "n", ...instantClock() });
	assert.equal(code, 0, text());
	assert.deepEqual(calls.filter((c) => c.cmd === "docker"), []);
	assert.doesNotMatch(text(), /allowlist is read back by `pi-dispatch doctor --live`/, "a --live run does not point at itself");
	assert.match(text(), /\nread back on podman: starting pi-dispatch-egress-probe-provider-7, pi-dispatch-egress-probe-unlisted-7 and pi-dispatch-egress-probe-plainhttp-7 from pi-job:latest \(as the job user 1234:1234\) on the --internal network pi-dispatch-egress-doctor-7, with pi-dispatch-egress-proxy attached, to read the egress allowlist back; all three are removed when the canary ends\n/);
	assert.match(text(), /✓ podman: Egress policy reaches the provider[^\n]*\n✓ podman: Egress policy denies an unlisted host[^\n]*\n✓ podman: Egress policy refuses plain HTTP to a listed host off port 80[^\n]*\n/);
	assert.ok(text().indexOf("✓ podman: Egress policy refuses plain HTTP to a listed host off port 80") < text().indexOf("✓ read back on podman: egress holds"));
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
		const plan = { ...(stale ? staleKeys : {}), [`${PODMAN_PROBE}provider`]: 0, [`${PODMAN_PROBE}unlisted`]: 3, [`${PODMAN_PROBE}plainhttp`]: 3, ...toPodman(liveOk({ uid: "1234" })), ...toPodman(livePeersOk({})), "podman network": 0, ...podmanPlan({ info, keeper }) };
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
	assert.equal(probes.length, 3);
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
	assert.match(text(), /✗ Egress proxy is stopped \(pi-dispatch-egress-proxy\)\n {4}→ it is not this deployment's either \(its \/etc\/pi-dispatch\/allowlist\.conf is [^)]*\): `pi-dispatch up` from the deployment folder offers to replace it with the shipped one \(docker rm -f -v pi-dispatch-egress-proxy, then the shipped run\) -- /);
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
	// PR #466 gate round 2 added the GitHub auth source and App keys; issue #464 the jobs and sandbox dirs, and in its gate
	// round 1 the Valkey opt-in, the TMPDIR the default jobs root lives under, and the worker's name.
	// Issue #471: and every other key the service reads that doctor judges, the worker's and the receiver's.
	assert.deepEqual([...SERVICE_ENV_KEYS], ["PI_BACKENDS", "PI_EGRESS", "PI_EGRESS_PROXY", "VALKEY_URL", "PI_VALKEY_SHARED", "VALKEY_PASSWORD", "PI_VALKEY_PORT", "PI_PROVIDER", "PI_MODEL", "GITHUB_AUTH_SOURCE", "GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_APP_PRIVATE_KEY_PATH", "GITHUB_APP_PRIVATE_KEY", "PI_JOBS_DIR", "PI_SANDBOX_DIR", "TMPDIR", "PI_WORKER_NAME", ...WORKER_SERVICE_KEYS, ...RECEIVER_SERVICE_KEYS, ...new Set(Object.values(CLI_SERVICE_KEYS).flat())]);
	for (const key of ["PI_JOB_IMAGE", "PI_TRIGGERS_FILE", "PI_LOGS_DIR", "PI_SETTINGS_FILE", "PI_SESSIONS_DIR", "PI_SESSIONS_TTL_DAYS", "PI_SESSION_MAX_AGE_DAYS", "PI_SESSION_MAX_CONTEXT_PCT", "PI_SESSION_MAX_RESUME_CHAIN", "PI_GLOBAL_PI_DIR", "PI_GLOBAL_ALLOW_EXTENSIONS", "PI_FORWARD_ENV", "PI_AUTH_FROM_PI", "PI_BACKEND_FLOOR", "PI_SECRET_PROFILES", "PI_SECRET_RESOLVER_ROOTS", "PI_WAIT_PROFILES", "PI_WAIT_AFTER_MAX_MS", "PI_SANDBOX_RETENTION_HOURS", "PI_ALLOWED_MODELS", "GITLAB_TOKEN", "GITLAB_URL", "GITLAB_WEBHOOK_MODE", "GITLAB_WEBHOOK_SECRET", "FORGEJO_URL", "AZURE_ORG_URL", "AZURE_WEBHOOK_MODE", "WEBHOOK_SECRET", "RECEIVER_PORT", "GITHUB_PAT_VAR"]) {
		assert.ok(SERVICE_ENV_KEYS.includes(key), `${key}, which issue #471 lists, is a service key`);
	}
	// Every key whose value steers a spawn, a connection or a write says how it is judged, and is a service key.
	for (const key of Object.keys(STEERING_SERVICE_KEYS)) assert.ok(SERVICE_ENV_KEYS.includes(key), key);
	// The three the issue keeps shell-only on purpose stay out of the allowlist.
	for (const key of ["PI_ENV_SETUP", "XDG_DATA_HOME", "DOCKER_CONTENT_TRUST"]) assert.ok(!SERVICE_ENV_KEYS.includes(key) && Object.hasOwn(DOCTOR_SHELL_KEYS, key), key);
	assert.deepEqual(serviceEnvKeys(["PI_JOB_IMAGE", "PI_ENV_SETUP", "VALKEY_URL", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"], ["ANTHROPIC_API_KEY"]), ["PI_JOB_IMAGE", "VALKEY_URL", "ANTHROPIC_API_KEY"]);
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
	await runDoctor(shell, { ...podmanDeps(out, podmanPlan(), []), cwd, platform: "linux", envFs: countingEnvFs(asked), readEnvFile: (path) => assert.fail(`a second read of ${path}`) });
	assert.match(text(), new RegExp(`✓ venue keys read from ${join(cwd, ".env").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} \\(PI_BACKENDS="podman", PI_EGRESS="0"\\), as the service reads them: this shell does not set them\\n`));
	assert.match(text(), /✓ Jobs run on: podman/);
	assert.doesNotMatch(text(), /Docker daemon reachable/);
	assert.deepEqual(asked, [realpathSync(join(cwd, ".env"))], "one file, opened once");
	// This shell set differently: ✗, and doctor judges the shell's values.
	const conflict = capture();
	assert.equal(await runDoctor({ ...shell, PI_BACKENDS: "local" }, { ...ghDeps(conflict.out, green), cwd, platform: "linux", readEnvFile: (path) => readFileSync(path, "utf8") }), 1);
	assert.match(conflict.text(), new RegExp(`✗ which venue this deployment runs is unknown: PI_BACKENDS is "local" in this shell and "podman" in ${join(cwd, ".env").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\. doctor would judge the shell's venue while the service runs the file's\\.`));
	// A .env that is there and cannot be read is said, as up says it (gate round 2); an absent one is not.
	const dirEnv = tempDir("pi-venue-dir-env-");
	mkdirSync(join(dirEnv, ".env"));
	const unread = capture();
	await runDoctor(shell, { ...podmanDeps(unread.out, podmanPlan(), []), cwd: dirEnv, fileExists: existsSync, platform: "linux" });
	assert.match(unread.text(), new RegExp(`⚠ ${join(dirEnv, ".env").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} could not be read \\(not a regular file\\), so PI_BACKENDS, PI_EGRESS and PI_EGRESS_PROXY come from this shell alone, as does every other service setting doctor judges \\(issue #471\\)\n`));
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
// leftover swept, every probe answering, the teardown clean, the read-back with its peers), a job image whose runner
// predates #427, and a provider probe the bound cut short. Captured from main at 26cef96, BEFORE the canary was
// parameterised on a venue runner: the text and every spawn (runtime and argv), with the only per-run values (the
// jobs directory and the fixture names under it) replaced. A docker canary that moved by one byte or one spawn lands here.
// Issue #508 added, by hand and nothing else: the third probe's spawn after the unlisted one (its argv the unlisted one's
// but for name and script), its ✓ line, one more spawn in each total but the stale runner's (which stops at the first
// probe), and the read-back's wording for three probes.
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
	// Issue #596, gate round 2: the Docker 27.5.1 this pin models answers with its CPU count, as every Docker does, so the
	// pin prints the ceiling a healthy host prints rather than a cpu_ceiling_unknown none does. Assigned, keeping its place.
	// Issue #596, phase 2: and with its memory (`MemTotal`), so the host budget line is a healthy host's too.
	plan["docker info --format={{json .}}"] = { code: 0, output: `${JSON.stringify({ ...JSON.parse(ROOTFUL_INFO), NCPU: 4, MemTotal: 8_323_072_000 })}\n` };
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
	const script = (s) =>
		s
			.replace(egressCanaryScript("https://api.anthropic.com/v1/messages"), "<egressCanaryScript(provider)>")
			.replace(egressCanaryScript("https://example.com/"), "<egressCanaryScript(unlisted)>")
			.replace(egressCanaryPlainScript("http://api.anthropic.com:443/", { proxyUrl: "http://pi-dispatch-egress-proxy:3128" }), "<egressCanaryPlainScript(plainhttp)>");
	const spawns = calls.map((c) => script(norm([c.cmd, ...c.args].join(" "))));
	// The collection's spawns, which is where the canary lives, exactly; the read-back's (runLiveProbes, which this
	// change does not touch) by count.
	const readBack = spawns.indexOf("docker ps -a --filter name=pi-dispatch-live- --format {{.ID}} {{.Names}}");
	return { code, text: norm(text()), collection: spawns.slice(0, readBack), total: spawns.length, killsBeforeBound, kills: probe()?.kills ?? null };
};
const DOCKER_CANARY_PIN = {
	green: {
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
			"docker run --rm --name pi-dispatch-egress-probe-plainhttp-7 --pull=never --network=pi-dispatch-egress-doctor-7 -e HTTPS_PROXY=http://pi-dispatch-egress-proxy:3128 -e NODE_USE_ENV_PROXY=1 --entrypoint node pi-job:latest -e <egressCanaryPlainScript(plainhttp)>",
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
			"✓ Egress policy refuses plain HTTP to a listed host off port 80 (api.anthropic.com:443 without a tunnel; only a CONNECT reaches 443)",
			"✓ Jobs run on: local",
			"⚠ local: nonRoot is ASSERTED by the job image's USER directive (this repo's builds `USER pi`; an operator-built image may not), or, on a daemon that enforces bind-mount ownership with a worker uid other than 1001, the worker's own non-zero uid passed as `--user`, not enforced by it",
			"    → not verifiable from here, so treat it as a claim rather than a control: the agent runs as a non-root user",
			"✓ PI_BACKEND_FLOOR is not set, so no minimum is required of any backend",
			"✓ Job size: 4g of memory with no swap beyond it, and the CPU weight of 2 CPUs, per job (the built-in default; a project row's memory and cpus override it, docs/scoped-limits.md)",
			// Issue #596 (gate round 1): the CPU ceiling unknown is a warning per venue, since such a job runs with no --cpus.
			"✓ local: any one job may use at most 3 of this runtime's 4 CPUs (--cpus); under contention a larger size gets more CPU than a smaller one (--cpu-shares)",
			"✓ Host budget: memory 6913m (auto: 7937m here, 1g kept for the host), CPUs 3 (auto: 4 here, 1 kept for the host); a job starts only when its size fits beside what already runs on this host",
			"✓ The host budget binds first: it holds 1 job of the default size (4g, 2 CPUs) at once, fewer than PI_CONCURRENCY (3); bigger sizes fit fewer",
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
			"⚠ PI_PROJECTS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for projects cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"⚠ PI_ENVELOPE_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for the allocation envelope cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"✓ Jobs dir <jobs> is this account's and writable",
			"✓ 0 retained workspace(s) in <jobs>/sandboxes, swept after 24h, re-open one with `pi-dispatch sandbox <jobId>`",
			"✓ Durable state: run history /home/op/.pi-dispatch/logs, settings /home/op/.pi-dispatch/settings.json \u2014 both survive a reboot (docs/backup.md)",
			"",
			"read back on local: starting pi-dispatch-live-probe-7-n, pi-dispatch-live-pin-7-n and pi-dispatch-live-ephemeral-7-n (twice) from pi-job:latest (no environment, as the image's own user), and pi-dispatch-live-peer1-7-n and pi-dispatch-live-peer2-7-n on their own --internal networks pi-dispatch-live-peer1-7-n-net and pi-dispatch-live-peer2-7-n-net, with pi-dispatch-egress-proxy attached to both, with a fixture under <jobs>; all of them are removed when the read-back ends, as is anything an interrupted earlier run left",
			"✓ read back on local: the probe ran as the job image's own user (uid 1001)",
			"✓ read back on local: isolation holds (CapBnd 0, NoNewPrivs 1, pids.max 512, memory.max 4294967296, memory.swap.max 0, cpu.max 300000 100000, cpu.weight 79 (--cpu-shares=2048))",
			"✓ read back on local: ephemeral holds (two runs under one name each removed themselves (in 0 ms and 0 ms), and the second found nothing of the first)",
			"✓ read back on local: mountSet holds (/job:ro, /workspace, /outbox, /session, /opt/pi-global:ro and nothing else, in docker inspect and in /proc/self/mountinfo)",
			"✓ read back on local: egress holds (the provider was reached, an unlisted host was not, and plain HTTP off port 80 was refused)",
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
			"⚠ local: nonRoot is ASSERTED by the job image's USER directive (this repo's builds `USER pi`; an operator-built image may not), or, on a daemon that enforces bind-mount ownership with a worker uid other than 1001, the worker's own non-zero uid passed as `--user`, not enforced by it",
			"    → not verifiable from here, so treat it as a claim rather than a control: the agent runs as a non-root user",
			"✓ PI_BACKEND_FLOOR is not set, so no minimum is required of any backend",
			"✓ Job size: 4g of memory with no swap beyond it, and the CPU weight of 2 CPUs, per job (the built-in default; a project row's memory and cpus override it, docs/scoped-limits.md)",
			// Issue #596 (gate round 1): the CPU ceiling unknown is a warning per venue, since such a job runs with no --cpus.
			"✓ local: any one job may use at most 3 of this runtime's 4 CPUs (--cpus); under contention a larger size gets more CPU than a smaller one (--cpu-shares)",
			"✓ Host budget: memory 6913m (auto: 7937m here, 1g kept for the host), CPUs 3 (auto: 4 here, 1 kept for the host); a job starts only when its size fits beside what already runs on this host",
			"✓ The host budget binds first: it holds 1 job of the default size (4g, 2 CPUs) at once, fewer than PI_CONCURRENCY (3); bigger sizes fit fewer",
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
			"⚠ PI_PROJECTS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for projects cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"⚠ PI_ENVELOPE_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for the allocation envelope cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"✓ Jobs dir <jobs> is this account's and writable",
			"✓ 0 retained workspace(s) in <jobs>/sandboxes, swept after 24h, re-open one with `pi-dispatch sandbox <jobId>`",
			"✓ Durable state: run history /home/op/.pi-dispatch/logs, settings /home/op/.pi-dispatch/settings.json \u2014 both survive a reboot (docs/backup.md)",
			"",
			"read back on local: starting pi-dispatch-live-probe-7-n, pi-dispatch-live-pin-7-n and pi-dispatch-live-ephemeral-7-n (twice) from pi-job:latest (no environment, as the image's own user), and pi-dispatch-live-peer1-7-n and pi-dispatch-live-peer2-7-n on their own --internal networks pi-dispatch-live-peer1-7-n-net and pi-dispatch-live-peer2-7-n-net, with pi-dispatch-egress-proxy attached to both, with a fixture under <jobs>; all of them are removed when the read-back ends, as is anything an interrupted earlier run left",
			"✓ read back on local: the probe ran as the job image's own user (uid 1001)",
			"✓ read back on local: isolation holds (CapBnd 0, NoNewPrivs 1, pids.max 512, memory.max 4294967296, memory.swap.max 0, cpu.max 300000 100000, cpu.weight 79 (--cpu-shares=2048))",
			"✓ read back on local: ephemeral holds (two runs under one name each removed themselves (in 0 ms and 0 ms), and the second found nothing of the first)",
			"✓ read back on local: mountSet holds (/job:ro, /workspace, /outbox, /session, /opt/pi-global:ro and nothing else, in docker inspect and in /proc/self/mountinfo)",
			"⚠ read back on local: egress not read back: the egress canary did not run all three probes (see the egress lines above)",
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
		total: 52,
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
			"docker run --rm --name pi-dispatch-egress-probe-plainhttp-7 --pull=never --network=pi-dispatch-egress-doctor-7 -e HTTPS_PROXY=http://pi-dispatch-egress-proxy:3128 -e NODE_USE_ENV_PROXY=1 --entrypoint node pi-job:latest -e <egressCanaryPlainScript(plainhttp)>",
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
			"✓ Egress policy refuses plain HTTP to a listed host off port 80 (api.anthropic.com:443 without a tunnel; only a CONNECT reaches 443)",
			"✓ Jobs run on: local",
			"⚠ local: nonRoot is ASSERTED by the job image's USER directive (this repo's builds `USER pi`; an operator-built image may not), or, on a daemon that enforces bind-mount ownership with a worker uid other than 1001, the worker's own non-zero uid passed as `--user`, not enforced by it",
			"    → not verifiable from here, so treat it as a claim rather than a control: the agent runs as a non-root user",
			"✓ PI_BACKEND_FLOOR is not set, so no minimum is required of any backend",
			"✓ Job size: 4g of memory with no swap beyond it, and the CPU weight of 2 CPUs, per job (the built-in default; a project row's memory and cpus override it, docs/scoped-limits.md)",
			// Issue #596 (gate round 1): the CPU ceiling unknown is a warning per venue, since such a job runs with no --cpus.
			"✓ local: any one job may use at most 3 of this runtime's 4 CPUs (--cpus); under contention a larger size gets more CPU than a smaller one (--cpu-shares)",
			"✓ Host budget: memory 6913m (auto: 7937m here, 1g kept for the host), CPUs 3 (auto: 4 here, 1 kept for the host); a job starts only when its size fits beside what already runs on this host",
			"✓ The host budget binds first: it holds 1 job of the default size (4g, 2 CPUs) at once, fewer than PI_CONCURRENCY (3); bigger sizes fit fewer",
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
			"⚠ PI_PROJECTS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for projects cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"⚠ PI_ENVELOPE_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for the allocation envelope cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"✓ Jobs dir <jobs> is this account's and writable",
			"✓ 0 retained workspace(s) in <jobs>/sandboxes, swept after 24h, re-open one with `pi-dispatch sandbox <jobId>`",
			"✓ Durable state: run history /home/op/.pi-dispatch/logs, settings /home/op/.pi-dispatch/settings.json \u2014 both survive a reboot (docs/backup.md)",
			"",
			"read back on local: starting pi-dispatch-live-probe-7-n, pi-dispatch-live-pin-7-n and pi-dispatch-live-ephemeral-7-n (twice) from pi-job:latest (no environment, as the image's own user), and pi-dispatch-live-peer1-7-n and pi-dispatch-live-peer2-7-n on their own --internal networks pi-dispatch-live-peer1-7-n-net and pi-dispatch-live-peer2-7-n-net, with pi-dispatch-egress-proxy attached to both, with a fixture under <jobs>; all of them are removed when the read-back ends, as is anything an interrupted earlier run left",
			"✓ read back on local: the probe ran as the job image's own user (uid 1001)",
			"✓ read back on local: isolation holds (CapBnd 0, NoNewPrivs 1, pids.max 512, memory.max 4294967296, memory.swap.max 0, cpu.max 300000 100000, cpu.weight 79 (--cpu-shares=2048))",
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
		total: 52,
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
			"docker run --rm --name pi-dispatch-egress-probe-plainhttp-7 --pull=never --network=pi-dispatch-egress-doctor-7 -e HTTPS_PROXY=http://pi-dispatch-egress-proxy:3128 -e NODE_USE_ENV_PROXY=1 --entrypoint node pi-job:latest -e <egressCanaryPlainScript(plainhttp)>",
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
			"✓ Egress policy refuses plain HTTP to a listed host off port 80 (api.anthropic.com:443 without a tunnel; only a CONNECT reaches 443)",
			"✓ Jobs run on: local",
			"⚠ local: nonRoot is ASSERTED by the job image's USER directive (this repo's builds `USER pi`; an operator-built image may not), or, on a daemon that enforces bind-mount ownership with a worker uid other than 1001, the worker's own non-zero uid passed as `--user`, not enforced by it",
			"    → not verifiable from here, so treat it as a claim rather than a control: the agent runs as a non-root user",
			"✓ PI_BACKEND_FLOOR is not set, so no minimum is required of any backend",
			"✓ Job size: 4g of memory with no swap beyond it, and the CPU weight of 2 CPUs, per job (the built-in default; a project row's memory and cpus override it, docs/scoped-limits.md)",
			// Issue #596 (gate round 1): the CPU ceiling unknown is a warning per venue, since such a job runs with no --cpus.
			"✓ local: any one job may use at most 3 of this runtime's 4 CPUs (--cpus); under contention a larger size gets more CPU than a smaller one (--cpu-shares)",
			"✓ Host budget: memory 6913m (auto: 7937m here, 1g kept for the host), CPUs 3 (auto: 4 here, 1 kept for the host); a job starts only when its size fits beside what already runs on this host",
			"✓ The host budget binds first: it holds 1 job of the default size (4g, 2 CPUs) at once, fewer than PI_CONCURRENCY (3); bigger sizes fit fewer",
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
			"⚠ PI_PROJECTS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for projects cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"⚠ PI_ENVELOPE_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for the allocation envelope cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"✓ Jobs dir <jobs> is this account's and writable",
			"✓ 0 retained workspace(s) in <jobs>/sandboxes, swept after 24h, re-open one with `pi-dispatch sandbox <jobId>`",
			"✓ Durable state: run history /home/op/.pi-dispatch/logs, settings /home/op/.pi-dispatch/settings.json \u2014 both survive a reboot (docs/backup.md)",
			"",
			"read back on local: starting pi-dispatch-live-probe-7-n, pi-dispatch-live-pin-7-n and pi-dispatch-live-ephemeral-7-n (twice) from pi-job:latest (no environment, as the image's own user), and pi-dispatch-live-peer1-7-n and pi-dispatch-live-peer2-7-n on their own --internal networks pi-dispatch-live-peer1-7-n-net and pi-dispatch-live-peer2-7-n-net, with pi-dispatch-egress-proxy attached to both, with a fixture under <jobs>; all of them are removed when the read-back ends, as is anything an interrupted earlier run left",
			"✓ read back on local: the probe ran as the job image's own user (uid 1001)",
			"✓ read back on local: isolation holds (CapBnd 0, NoNewPrivs 1, pids.max 512, memory.max 4294967296, memory.swap.max 0, cpu.max 300000 100000, cpu.weight 79 (--cpu-shares=2048))",
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
		total: 52,
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
			"docker run --rm --name pi-dispatch-egress-probe-plainhttp-7 --pull=never --network=pi-dispatch-egress-doctor-7 -e HTTPS_PROXY=http://pi-dispatch-egress-proxy:3128 -e NODE_USE_ENV_PROXY=1 --entrypoint node pi-job:latest -e <egressCanaryPlainScript(plainhttp)>",
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
			"✓ Egress policy refuses plain HTTP to a listed host off port 80 (api.anthropic.com:443 without a tunnel; only a CONNECT reaches 443)",
			"✓ Jobs run on: local",
			"⚠ local: nonRoot is ASSERTED by the job image's USER directive (this repo's builds `USER pi`; an operator-built image may not), or, on a daemon that enforces bind-mount ownership with a worker uid other than 1001, the worker's own non-zero uid passed as `--user`, not enforced by it",
			"    → not verifiable from here, so treat it as a claim rather than a control: the agent runs as a non-root user",
			"✓ PI_BACKEND_FLOOR is not set, so no minimum is required of any backend",
			"✓ Job size: 4g of memory with no swap beyond it, and the CPU weight of 2 CPUs, per job (the built-in default; a project row's memory and cpus override it, docs/scoped-limits.md)",
			// Issue #596 (gate round 1): the CPU ceiling unknown is a warning per venue, since such a job runs with no --cpus.
			"✓ local: any one job may use at most 3 of this runtime's 4 CPUs (--cpus); under contention a larger size gets more CPU than a smaller one (--cpu-shares)",
			"✓ Host budget: memory 6913m (auto: 7937m here, 1g kept for the host), CPUs 3 (auto: 4 here, 1 kept for the host); a job starts only when its size fits beside what already runs on this host",
			"✓ The host budget binds first: it holds 1 job of the default size (4g, 2 CPUs) at once, fewer than PI_CONCURRENCY (3); bigger sizes fit fewer",
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
			"⚠ PI_PROJECTS_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for projects cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"⚠ PI_ENVELOPE_FILE is unset in this shell, and <cwd>/.env could not be read, so whether the service is configured for the allocation envelope cannot be answered here",
			"    → make <cwd>/.env a readable regular file, or run doctor from the deployment folder",
			"✓ Jobs dir <jobs> is this account's and writable",
			"✓ 0 retained workspace(s) in <jobs>/sandboxes, swept after 24h, re-open one with `pi-dispatch sandbox <jobId>`",
			"✓ Durable state: run history /home/op/.pi-dispatch/logs, settings /home/op/.pi-dispatch/settings.json \u2014 both survive a reboot (docs/backup.md)",
			"",
			"read back on local: starting pi-dispatch-live-probe-7-n, pi-dispatch-live-pin-7-n and pi-dispatch-live-ephemeral-7-n (twice) from pi-job:latest (no environment, as the image's own user), and pi-dispatch-live-peer1-7-n and pi-dispatch-live-peer2-7-n on their own --internal networks pi-dispatch-live-peer1-7-n-net and pi-dispatch-live-peer2-7-n-net, with pi-dispatch-egress-proxy attached to both, with a fixture under <jobs>; all of them are removed when the read-back ends, as is anything an interrupted earlier run left",
			"✓ read back on local: the probe ran as the job image's own user (uid 1001)",
			"✓ read back on local: isolation holds (CapBnd 0, NoNewPrivs 1, pids.max 512, memory.max 4294967296, memory.swap.max 0, cpu.max 300000 100000, cpu.weight 79 (--cpu-shares=2048))",
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
	const env = imgEnv({ PI_SESSIONS_DIR: "/srv/pi-sessions", PI_TRIGGERS_FILE: resumeTriggersFile(), GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_fixture", PI_SESSION_MAX_CONTEXT_PCT: "80" });
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

// Issue #464: the jobs dir is this account's. A fake fs whose files are `{ path: { uid, dir, link, writable } }`; any
// other path is absent. Real paths are never read.
const jobsFs = (entries) => {
	const missing = (p) => {
		throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
	};
	const at = (p) => entries[p] ?? missing(p);
	const st = (e) => ({ uid: e.uid, isDirectory: () => e.dir !== false, isSymbolicLink: () => e.link === true });
	return {
		statSync: (p) => st(at(p)),
		lstatSync: (p) => st(at(p)),
		accessSync: (p) => {
			if (at(p).writable === false) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
		},
		readdirSync: (p) => {
			at(p);
			return Object.keys(entries).filter((k) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes("/")).map((k) => k.slice(p.length + 1));
		},
	};
};
const JOBS_ENV = { TMPDIR: "/t" };
const passwdNames = (uid) => ({ 1270: "op", 501: "rob" })[uid] ?? null;

test("jobsDirChecks: the default per-account jobs dir, present or still to be made, is ✓; an account root another account owns is ✗ naming it and the fix (#464)", async () => {
	const { jobsDirChecks } = await import("../src/doctor.mjs");
	const made = jobsDirChecks(JOBS_ENV, { uid: 501, fs: jobsFs({ "/t": { uid: 0 }, "/t/pi-dispatch-501": { uid: 501 }, "/t/pi-dispatch-501/jobs": { uid: 501 } }) });
	assert.deepEqual(made, [{ ok: true, label: "Jobs dir /t/pi-dispatch-501/jobs is this account's and writable" }]);
	const fresh = jobsDirChecks(JOBS_ENV, { uid: 501, fs: jobsFs({ "/t": { uid: 0 } }) });
	assert.deepEqual(fresh, [{ ok: true, label: "Jobs dir /t/pi-dispatch-501/jobs does not exist yet; the worker creates it (mode 0700) at boot" }]);
	const squatted = jobsDirChecks(JOBS_ENV, { uid: 501, fs: jobsFs({ "/t": { uid: 0 }, "/t/pi-dispatch-501": { uid: 1270 } }), ownerName: passwdNames });
	assert.deepEqual(squatted, [
		{
			ok: false,
			label: "/t/pi-dispatch-501, where this account's jobs dir lives, is owned by op (uid 1270), not by this account (uid 501); the worker refuses it at boot -- every job fails before it starts",
			fix: "another account created /t/pi-dispatch-501 before this one; remove it as its owner or as root (sudo rm -rf /t/pi-dispatch-501), or set PI_JOBS_DIR in .env to a directory this account owns",
		},
	]);
	const linked = jobsDirChecks(JOBS_ENV, { uid: 501, fs: jobsFs({ "/t": { uid: 0 }, "/t/pi-dispatch-501": { uid: 501, link: true } }) });
	assert.match(linked[0].label, /^\/t\/pi-dispatch-501, where this account's jobs dir lives, is not a directory \(a symlink or a file there is refused/);
	assert.equal(linked[0].ok, false);
	const unwritableTmp = jobsDirChecks(JOBS_ENV, { uid: 501, fs: jobsFs({ "/t": { uid: 0, writable: false } }) });
	assert.equal(unwritableTmp[0].label, "the jobs dir /t/pi-dispatch-501/jobs does not exist, and this account cannot create it (/t is not writable by it) -- every job fails before it starts");
	assert.deepEqual(jobsDirChecks(JOBS_ENV, { uid: null, fs: jobsFs({}) }), [], "no uid (Windows): nothing to say");
});

test("jobsDirChecks: an explicit PI_JOBS_DIR another account owns, one this account cannot write, one that is a file, and an empty one are ✗ (#464)", async () => {
	const { jobsDirChecks } = await import("../src/doctor.mjs");
	const env = { PI_JOBS_DIR: "/srv/jobs" };
	const other = jobsDirChecks(env, { uid: 501, fs: jobsFs({ "/srv/jobs": { uid: 1270 } }), ownerName: passwdNames, note: " -- PI_JOBS_DIR read from /d/.env" });
	assert.deepEqual(other, [
		{
			ok: false,
			label: "the jobs dir /srv/jobs is owned by op (uid 1270), not by this account (uid 501), which could replace a job's inputs; the worker refuses it at boot -- every job fails before it starts -- PI_JOBS_DIR read from /d/.env",
			fix: "point PI_JOBS_DIR at a directory this account owns, or chown /srv/jobs to this account",
		},
	]);
	assert.equal(jobsDirChecks(env, { uid: 501, fs: jobsFs({ "/srv/jobs": { uid: 501, writable: false } }) })[0].fix, "chmod u+rwx /srv/jobs");
	assert.match(jobsDirChecks(env, { uid: 501, fs: jobsFs({ "/srv/jobs": { uid: 501, dir: false } }) })[0].label, /^the jobs dir \/srv\/jobs is not a directory/);
	assert.match(jobsDirChecks({ PI_JOBS_DIR: "" }, { uid: 501, fs: jobsFs({}) })[0].label, /^PI_JOBS_DIR is set to an empty value/);
	assert.deepEqual(jobsDirChecks(env, { uid: 501, fs: jobsFs({ "/srv/jobs": { uid: 501 } }) }), [{ ok: true, label: "Jobs dir /srv/jobs is this account's and writable" }], "the account root is not judged for a dir outside it");
});

test("jobsDirChecks: this account's retained workspaces left under the OLD shared default are a ⚠ naming them and the move; another account's are not counted (#464)", async () => {
	const { jobsDirChecks } = await import("../src/doctor.mjs");
	const files = { "/t": { uid: 0 }, "/t/pi-dispatch/jobs/sandboxes": { uid: 1270 }, "/t/pi-dispatch/jobs/sandboxes/gh-1": { uid: 501 }, "/t/pi-dispatch/jobs/sandboxes/gh-2": { uid: 501 }, "/t/pi-dispatch/jobs/sandboxes/gh-3": { uid: 1270 } };
	const checks = jobsDirChecks(JOBS_ENV, { uid: 501, fs: jobsFs(files) });
	assert.deepEqual(checks[1], {
		ok: false,
		warn: true,
		label: "2 retained workspace(s) of this account are in /t/pi-dispatch/jobs/sandboxes, the shared default before issue #464: this version keeps them in /t/pi-dispatch-501/jobs/sandboxes, so `pi-dispatch sandbox` cannot re-open them and the retention sweep no longer removes them",
		// Gate round 1: the root named in the mkdir, since `mkdir -m` sets only the directories it names (measured: the plain
		// `mkdir -p` this said before left the root 755 or 775 until the worker's next boot).
		fix: "move the ones worth keeping (the same filesystem, so a rename): mkdir -m 700 -p /t/pi-dispatch-501 /t/pi-dispatch-501/jobs/sandboxes && mv /t/pi-dispatch/jobs/sandboxes/<name> /t/pi-dispatch-501/jobs/sandboxes/, and delete the rest: rm -rf /t/pi-dispatch/jobs/sandboxes/<name>. Naming /t/pi-dispatch-501 makes it 0700 too (`mkdir -m` sets only the directories named, and a plain `mkdir -p` leaves /t/pi-dispatch-501 755); the worker also tightens it to 0700 at its next boot",
	});
	assert.equal(jobsDirChecks(JOBS_ENV, { uid: 1234, fs: jobsFs(files) }).length, 1, "none of them is this account's");
	assert.equal(jobsDirChecks({ ...JOBS_ENV, PI_SANDBOX_DIR: "/s" }, { uid: 501, fs: jobsFs(files) }).length, 1, "an explicit PI_SANDBOX_DIR did not move");
	const explicit = jobsDirChecks({ ...JOBS_ENV, PI_JOBS_DIR: "/t/pi-dispatch/jobs" }, { uid: 501, fs: jobsFs({ ...files, "/t/pi-dispatch/jobs": { uid: 501 } }) });
	assert.ok(!explicit.some((c) => c.warn), "an explicit PI_JOBS_DIR did not move either");
	// Its sandboxes/ is another account's here, which the worker refuses at boot (gate round 1): said as that, a ✗.
	assert.match(explicit[1].label, /^the sandbox dir \/t\/pi-dispatch\/jobs\/sandboxes is owned by uid 1270, not by this account \(uid 501\)/);
});

test("doctor reads PI_JOBS_DIR as the service does, from the deployment .env, and a jobs dir another account owns fails doctor (#464)", async () => {
	const cwd = tempDir("pi-jobs-464-cwd-");
	writeFileSync(join(cwd, ".env"), "PI_JOBS_DIR=/srv/pd-jobs\n");
	const { out, text } = capture();
	const code = await runDoctor(ghEnv(), ghDeps(out, green, [], { cwd, jobsDirUid: 501, jobsDirFs: jobsFs({ "/srv/pd-jobs": { uid: 1270 } }), passwd: () => "op:x:1270:1270::/home/op:/bin/bash\n" }));
	assert.equal(code, 1, text());
	assert.ok(text().includes(`✗ the jobs dir /srv/pd-jobs is owned by op (uid 1270), not by this account (uid 501), which could replace a job's inputs; the worker refuses it at boot -- every job fails before it starts -- PI_JOBS_DIR read from ${join(cwd, ".env")}, as the service reads it; this shell does not set it\n    → point PI_JOBS_DIR at a directory this account owns, or chown /srv/pd-jobs to this account\n`), text());
});

// Gate round 1: an explicit PI_SANDBOX_DIR another account owns (seen: a 0777 directory of another account's) is the
// directory that account can swap a retained workspace in; the worker refuses it at boot and doctor says so.
test("jobsDirChecks: a sandbox dir another account owns is ✗ naming the owner and the fix; this account's, or one not made yet, says nothing (#464)", async () => {
	const { jobsDirChecks } = await import("../src/doctor.mjs");
	const env = { ...JOBS_ENV, PI_SANDBOX_DIR: "/tmp/shared-sb" };
	const base = { "/t": { uid: 0 }, "/t/pi-dispatch-501": { uid: 501 }, "/t/pi-dispatch-501/jobs": { uid: 501 } };
	const other = jobsDirChecks(env, { uid: 501, fs: jobsFs({ ...base, "/tmp/shared-sb": { uid: 1270 } }), ownerName: passwdNames, note: " -- PI_SANDBOX_DIR read from /d/.env" });
	assert.deepEqual(other, [
		{ ok: true, label: "Jobs dir /t/pi-dispatch-501/jobs is this account's and writable -- PI_SANDBOX_DIR read from /d/.env" },
		{
			ok: false,
			label: "the sandbox dir /tmp/shared-sb is owned by op (uid 1270), not by this account (uid 501), which could swap a retained workspace for one of its own; the worker refuses it at boot -- every job fails before it starts -- PI_SANDBOX_DIR read from /d/.env",
			fix: "point PI_SANDBOX_DIR at a directory this account owns (or remove the line for the default), or chown /tmp/shared-sb to this account",
		},
	]);
	assert.equal(jobsDirChecks(env, { uid: 501, fs: jobsFs({ ...base, "/tmp/shared-sb": { uid: 501, dir: false } }) })[1].label.startsWith("the sandbox dir /tmp/shared-sb is not a directory"), true);
	assert.equal(jobsDirChecks(env, { uid: 501, fs: jobsFs({ ...base, "/tmp/shared-sb": { uid: 501 } }) }).length, 1, "this account's: nothing more");
	assert.equal(jobsDirChecks(env, { uid: 501, fs: jobsFs(base) }).length, 1, "not made yet: the retention step makes it 0700");
});

test("doctor judges the sandbox dir and the jobs root the SERVICE uses (PI_SANDBOX_DIR and TMPDIR from .env), and prints no retained ✓ after a ✗ on them (#464)", async () => {
	// The retained count reads the .env's PI_SANDBOX_DIR (gate round 1: it counted the default instead).
	const cwd = tempDir("pi-464-sbenv-cwd-");
	const sandboxDir = tempDir("pi-464-sbenv-");
	mkdirSync(join(sandboxDir, "gh-1"));
	writeFileSync(join(cwd, ".env"), `PI_SANDBOX_DIR=${sandboxDir}\n`);
	const kept = capture();
	await runDoctor(ghEnv(), ghDeps(kept.out, green, [], { cwd }));
	assert.match(kept.text(), new RegExp(`✓ 1 retained workspace\\(s\\) in ${sandboxDir.replaceAll(".", "\\.")}, swept after 24h`));
	// TMPDIR in .env (the documented way out of a squatted default root) moves the root doctor judges, as it moves the
	// service's; a squat there is ✗, and then no ✓ counts what sits in the squatted directory.
	const uid = process.geteuid();
	const squatCwd = tempDir("pi-464-tmpenv-cwd-");
	writeFileSync(join(squatCwd, ".env"), "TMPDIR=/t\n");
	const squat = capture();
	const { TMPDIR: _shellTmp, ...shell } = ghEnv();
	const code = await runDoctor(shell, ghDeps(squat.out, green, [], { cwd: squatCwd, jobsDirUid: uid, jobsDirFs: jobsFs({ "/t": { uid: 0 }, [`/t/pi-dispatch-${uid}`]: { uid: 1270 } }), passwd: () => "op:x:1270:1270::/home/op:/bin/bash\n" }));
	assert.equal(code, 1, squat.text());
	assert.ok(squat.text().includes(`✗ /t/pi-dispatch-${uid}, where this account's jobs dir lives, is owned by op (uid 1270), not by this account (uid ${uid}); the worker refuses it at boot -- every job fails before it starts -- TMPDIR read from ${join(squatCwd, ".env")}, as the service reads it; this shell does not set it\n`), squat.text());
	assert.doesNotMatch(squat.text(), /retained workspace\(s\) in/, "no ✓ over a directory another account made");
});

// Gate round 1 (D7): doctor said ✓ Valkey reachable on another account's Valkey, and the worker drained its queue. The
// owner is judged by the SAME function `service install` and `up` use.
test("doctor on podman: a VALKEY_URL whose listener is not this account's is ✗ by the worker's own rule, with no PING and no fleet read; this account's is ✓ and talked to at the pinned address; docker's is not judged (#464)", async () => {
	const { judgeValkeyListeners } = await import("../src/podman-stack.mjs");
	const TCP_HEAD = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
	const hostAt = (uid) => ({
		"/proc/net/tcp": `${TCP_HEAD}   3: 0100007F:18EB 00000000:0000 0A 00000000:00000000 00:00000000 00000000  ${uid}        0 1 1 0 100 0 0 10 0\n`,
		"/proc/net/tcp6": TCP_HEAD,
		"/etc/subuid": "op:1234000000:65536\n",
	});
	const asked = [];
	const owner = (uid) => async (url, opts) => {
		asked.push({ url, ...opts });
		return judgeValkeyListeners({ url, probeTcp: async () => true, lookup: async () => [], fs: { readFileSync: (p) => hostAt(uid)[p] }, euid: 1234, ownerName: (u) => ({ 1235: "op2" })[u] ?? null, ...opts });
	};
	// Gate round 2: after a refusal doctor does not PING that Valkey or read its fleet.
	const talked = [];
	const talk = { probeValkey: async (url) => (talked.push(["ping", url]), true), readHosts: async (url) => (talked.push(["hosts", url]), { hosts: [{ name: "their-worker" }] }) };
	const other = capture();
	const code = await runDoctor(podmanEnv(), podmanDeps(other.out, podmanPlan(), [], { userName: () => "op", valkeyOwner: owner(1235), ...talk }));
	assert.equal(code, 1, other.text());
	assert.ok(other.text().includes("✗ Valkey (redis://127.0.0.1:6379) is not this account's: 127.0.0.1:6379 is held by op2 (uid 1235), not by this account (uid 1234) or its containers (subordinate uids read from /etc/subuid). The worker refuses to start on it (exit 2); doctor did not talk to it\n    → Give this account a Valkey of its own on another port, VALKEY_URL=redis://127.0.0.1:<port> in "), other.text());
	assert.deepEqual(talked, [], "no PING, no fleet read of another account's Valkey");
	assert.doesNotMatch(other.text(), /Valkey reachable|Fleet:|their-worker/);
	assert.deepEqual([asked[0].shared, asked[0].user], [false, "op"]);
	// This account's: ✓, and the PING and the fleet read go to the address the worker pins.
	const mine = capture();
	talked.length = 0;
	await runDoctor(podmanEnv({ VALKEY_URL: "redis://localhost:6379" }), podmanDeps(mine.out, podmanPlan(), [], { userName: () => "op", valkeyOwner: async (url, opts) => judgeValkeyListeners({ url, probeTcp: async () => true, lookup: async () => [{ address: "127.0.0.1", family: 4 }], fs: { readFileSync: (p) => hostAt(1234000998)[p] }, euid: 1234, ...opts }), ...talk }));
	assert.match(mine.text(), /✓ Valkey \(redis:\/\/localhost:6379\) answers from a listener of this account's containers \(a subordinate uid of it, from \/etc\/subuid\); the worker connects to 127\.0\.0\.1 only\n/);
	assert.deepEqual(talked, [["ping", "redis://127.0.0.1:6379"], ["hosts", "redis://127.0.0.1:6379"]], "the literal the worker pins, not the name");
	// The opt-in, from the deployment .env only.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "PI_VALKEY_SHARED=1\n");
	const shared = capture();
	asked.length = 0;
	await runDoctor(podmanEnv(), { ...podmanDeps(shared.out, podmanPlan(), [], { userName: () => "op", valkeyOwner: owner(1235) }), cwd, readEnvFile: (path) => readFileSync(path, "utf8") });
	assert.equal(asked[0].shared, true);
	assert.match(shared.text(), /✓ Valkey \(redis:\/\/127\.0\.0\.1:6379\) answers from a listener of op2 \(uid 1235\), shared on purpose as PI_VALKEY_SHARED=1 in [^\n]*\.env says/);
	// Gate round 2: a shell opt-in is ignored and named, even over a PI_VALKEY_SHARED=0 in .env, and the refusal stands.
	for (const file of ["PI_VALKEY_SHARED=0\n", ""]) {
		const shellCwd = scaffoldedCwd();
		writeFileSync(join(shellCwd, ".env"), file);
		const shell = capture();
		asked.length = 0;
		const shellCode = await runDoctor(podmanEnv({ PI_VALKEY_SHARED: "1" }), { ...podmanDeps(shell.out, podmanPlan(), [], { userName: () => "op", valkeyOwner: owner(1235) }), cwd: shellCwd, readEnvFile: (path) => readFileSync(path, "utf8") });
		assert.equal(asked[0].shared, false, JSON.stringify(file));
		assert.equal(shellCode, 1);
		assert.match(shell.text(), /⚠ PI_VALKEY_SHARED is "1" in this shell: ignored, since only [^\n]*\.env may say a Valkey is shared on purpose/);
		assert.doesNotMatch(shell.text(), /shared on purpose as PI_VALKEY_SHARED=1/);
	}
	// Gate round 3's simpler rule: judged on every venue. Where `local` is blessed, root's listener (docker-proxy) is
	// docker's Valkey and taken; another account's is refused there too (item 7).
	asked.length = 0;
	const docker = capture();
	await runDoctor(podmanEnv({ PI_BACKENDS: "local,podman" }), podmanDeps(docker.out, { ...green, ...podmanPlan() }, [], { userName: () => "op", valkeyOwner: owner(0) }));
	assert.equal(asked[0].rootOk, true, "root is not refused where local is blessed");
	assert.match(docker.text(), /✓ Valkey \(redis:\/\/127\.0\.0\.1:6379\) answers from a listener of root/);
	assert.doesNotMatch(docker.text(), /is not this account's/);
	const podmanRoot = capture();
	asked.length = 0;
	assert.equal(await runDoctor(podmanEnv(), podmanDeps(podmanRoot.out, podmanPlan(), [], { userName: () => "op", valkeyOwner: owner(0) })), 1);
	assert.equal(asked[0].rootOk, false, "root refused on the podman venue alone");
	assert.match(podmanRoot.text(), /✗ Valkey \(redis:\/\/127\.0\.0\.1:6379\) is not this account's: 127\.0\.0\.1:6379 is held by root/);
	const dockerForeign = capture();
	talked.length = 0;
	assert.equal(await runDoctor(podmanEnv({ PI_BACKENDS: "local,podman" }), podmanDeps(dockerForeign.out, { ...green, ...podmanPlan() }, [], { userName: () => "op", valkeyOwner: owner(1235), ...talk })), 1);
	assert.match(dockerForeign.text(), /✗ Valkey \(redis:\/\/127\.0\.0\.1:6379\) is not this account's: 127\.0\.0\.1:6379 is held by op2 \(uid 1235\)/);
	assert.deepEqual(talked, []);
	// Gate round 3, item 4: a name that does not resolve is ✗ and not talked to, never "another host".
	const gone = capture();
	talked.length = 0;
	const goneOwner = async (url, opts) => judgeValkeyListeners({ url, probeTcp: async () => true, lookup: async () => { throw Object.assign(new Error("getaddrinfo EAI_AGAIN gone.lan"), { code: "EAI_AGAIN" }); }, fs: { readFileSync: (p) => hostAt(1235)[p] }, euid: 1234, ...opts });
	assert.equal(await runDoctor(podmanEnv({ VALKEY_URL: "redis://gone.lan:6379" }), podmanDeps(gone.out, podmanPlan(), [], { userName: () => "op", valkeyOwner: goneOwner, ...talk })), 1);
	assert.match(gone.text(), /✗ [^\n]*gone\.lan did not resolve here \(EAI_AGAIN\)/);
	assert.deepEqual(talked, []);
});

// Gate round 3, item 5: doctor read the service .env's PI_WORKER_NAME, TMPDIR, PI_JOBS_DIR and PI_SANDBOX_DIR past a byte
// systemd refuses or reads differently. It now names the hazard and reads none of them from the file.
test("doctor names a hazard in the service .env and reads none of the service's keys from it (#464, gate round 3)", async () => {
	for (const [bytes, re] of [[Buffer.from("PI_WORKER_NAME=a\rPI_JOBS_DIR=/x\n"), /carriage return/], [Buffer.from("PI_WORKER_NAME=a\nX=\u0000\n"), /NUL/]]) {
		const cwd = scaffoldedCwd();
		writeFileSync(join(cwd, ".env"), bytes);
		const { out, text } = capture();
		await runDoctor(podmanEnv(), { ...podmanDeps(out, podmanPlan(), [], { userName: () => "op", platform: "linux" }), cwd, readEnvFile: (path) => readFileSync(path) });
		assert.match(text(), new RegExp(`✗ [^\\n]*\\.env line \\d+ [^\\n]*${re.source}[^\\n]*, so doctor read none of [^\\n]* from it and judged this shell's values \\(or the defaults\\) instead: the service's own are unknown`), text());
	}
});

// Gate round 2: another account publishing ::1 beside this account's 127.0.0.1 (the localhost squat after install) is a
// ⚠, since the worker pins 127.0.0.1 and never dials ::1; refusing would let any account stop another's worker.
test("doctor names another account's listener on another address of the name as a ⚠, while ✓ on the address the worker pins (#464)", async () => {
	const { judgeValkeyListeners } = await import("../src/podman-stack.mjs");
	const TCP_HEAD = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
	const files = {
		"/proc/net/tcp": `${TCP_HEAD}   3: 0100007F:4063 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1234        0 1 1 0 100 0 0 10 0\n`,
		"/proc/net/tcp6": `${TCP_HEAD}   1: 00000000000000000000000001000000:4063 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1235        0 1 1 0 100 0 0 10 0\n`,
	};
	const { out, text } = capture();
	const code = await runDoctor(podmanEnv({ VALKEY_URL: "redis://localhost:16483" }), podmanDeps(out, podmanPlan(), [], { userName: () => "op", valkeyOwner: async (url, opts) => judgeValkeyListeners({ url, probeTcp: async () => true, lookup: async () => [{ address: "::1", family: 6 }, { address: "127.0.0.1", family: 4 }], fs: { readFileSync: (p) => files[p] ?? "" }, euid: 1234, ownerName: (u) => ({ 1235: "op2" })[u] ?? null, ...opts }) }));
	assert.match(text(), /✓ Valkey \(redis:\/\/localhost:16483\) answers from a listener of this account; the worker connects to 127\.0\.0\.1 only\n/);
	assert.match(text(), /⚠ another account also listens on an address VALKEY_URL's host resolves to: \[::1\]:16483 \(held by op2 \(uid 1235\)\)\. The worker connects only to the address judged this account's/);
	assert.equal(code, 0, text());
});

// Gate round 1 (coordinator follow-up): an unquoted [::1] VALKEY_URL line is one doctor takes no value from, while systemd
// hands it to the worker as written. Doctor used to fall back to 127.0.0.1:6379 and PING it, which on a shared host is
// another account's Valkey (measured on pd-ubuntu), then read that Valkey's fleet and judge its owner. Now it contacts no
// Valkey at all, on either venue, and names the line.
test("doctor contacts no Valkey when the service's VALKEY_URL line cannot be read, and names the line (#464)", async () => {
	for (const [label, env, deps] of [
		["podman", podmanEnv(), (out, extra) => podmanDeps(out, podmanPlan(), [], { userName: () => "op", ...extra })],
		["docker", ghEnv(), (out, extra) => ghDeps(out, green, [], extra)],
	]) {
		const cwd = scaffoldedCwd();
		writeFileSync(join(cwd, ".env"), "VALKEY_URL=redis://[::1]:16510\n");
		const contacted = [];
		const { out, text } = capture();
		const code = await runDoctor(env, {
			...deps(out, {
				probeValkey: async (url) => (contacted.push(["probe", url]), true),
				readHosts: async (url) => (contacted.push(["hosts", url]), { hosts: [{ name: "someone-else" }] }),
				valkeyOwner: async (url) => (contacted.push(["owner", url]), null),
			}),
			cwd,
			readEnvFile: (path) => readFileSync(path, "utf8"),
		});
		assert.equal(code, 1, `${label}: ${text()}`);
		assert.deepEqual(contacted, [], `${label}: no probe, no fleet read, no owner verdict`);
		assert.match(text(), /✗ [^\n]*\.env line 1 assigns VALKEY_URL in a form this command cannot read the way the service's loader will \(an unquoted \[ or \]: [^\n]*: doctor contacted no Valkey, since the default it would fall back to \(redis:\/\/127\.0\.0\.1:6379\) is not what the service's worker is given, and on a shared host may be another account's\n/, label);
		assert.doesNotMatch(text(), /Valkey reachable|Fleet:/, label);
		// Issue #471: said ONCE, by its own reader's words, not a second time by the general unread-line ✗.
		assert.doesNotMatch(text(), /assigns VALKEY_URL \(line 1\) in a form/, label);
	}
	// Only the VALKEY_URL line decides it: a readable VALKEY_URL beside an unreadable PI_VALKEY_SHARED is still probed.
	const plainCwd = scaffoldedCwd();
	writeFileSync(join(plainCwd, ".env"), "VALKEY_URL=redis://127.0.0.1:16482\nPI_VALKEY_SHARED=$X\n");
	const plain = capture();
	await runDoctor(ghEnv(), { ...ghDeps(plain.out, green, []), cwd: plainCwd, readEnvFile: (path) => readFileSync(path, "utf8") });
	assert.match(plain.text(), /✓ Valkey reachable \(redis:\/\/127\.0\.0\.1:16482\)/);
	assert.doesNotMatch(plain.text(), /doctor contacted no Valkey/);
	// This shell's own VALKEY_URL wins as for every service key: then the file's line is not what doctor judges.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "VALKEY_URL=redis://[::1]:16510\n");
	const { out, text } = capture();
	await runDoctor(ghEnv({ VALKEY_URL: "redis://127.0.0.1:16482" }), { ...ghDeps(out, green, []), cwd, readEnvFile: (path) => readFileSync(path, "utf8") });
	assert.match(text(), /✓ Valkey reachable \(redis:\/\/127\.0\.0\.1:16482\)/);
	// Issue #471: and the file's line, which the service runs and doctor cannot read, is still named.
	assert.match(text(), /✗ [^\n]*\.env assigns VALKEY_URL \(line 1\) in a form the service's loader may read differently from doctor's reader[^\n]*judged this shell's instead/);
});

// Gate round 1 (coordinator follow-up): the routing warning read PI_WORKER_NAME from this shell alone, so a deployment
// whose .env names its worker was told host routing is off (measured on both lab VMs).
test("doctor reads PI_WORKER_NAME from .env as the service does: no routing warning when the file names the worker, and the fleet line carries it (#464)", async () => {
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "PI_WORKER_NAME=mini1\n");
	const named = capture();
	await runDoctor(ghEnv(), { ...ghDeps(named.out, green, [], { readHosts: async () => ({ hosts: [{ name: "mini1" }, { name: "mini2" }] }) }), cwd, readEnvFile: (path) => readFileSync(path, "utf8") });
	assert.doesNotMatch(named.text(), /no PI_WORKER_NAME/);
	assert.match(named.text(), /✓ Fleet: 2 workers \(mini1, mini2\)/, "its own row is itself, not a peer");
	const unnamed = capture();
	await runDoctor(ghEnv(), { ...ghDeps(unnamed.out, green, [], { readHosts: async () => ({ hosts: [{ name: "mini2" }] }) }), cwd: scaffoldedCwd() });
	assert.match(unnamed.text(), /⚠ This worker has peers but no PI_WORKER_NAME, so host routing is OFF here/);
	// This shell's value still wins where it sets one.
	const shell = capture();
	await runDoctor(ghEnv({ PI_WORKER_NAME: "mini3" }), { ...ghDeps(shell.out, green, [], { readHosts: async () => ({ hosts: [{ name: "mini2" }] }) }), cwd, readEnvFile: (path) => readFileSync(path, "utf8") });
	assert.match(shell.text(), /✓ Fleet: 2 workers \(mini2, mini3\)/);
});

// Issue #464: Podman after linger was switched off, measured on Fedora 44 (5.8.1) and Ubuntu 24.04 (4.9.3).
test("podmanRunDirGone: an exit-status read with /run/user/<uid> absent and Podman's database recording a run root there, and nothing else (#464)", async () => {
	const { podmanRunDirGone } = await import("../src/doctor.mjs");
	const enoent = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
	// Podman's database as bytes around the measured string (a Lima account's db.sql held `/run/user/501/containers`).
	const db = (uid) => Buffer.concat([Buffer.from([0x53, 0x51, 0x4c, 0, 0xff]), Buffer.from(`/run/user/${uid}/containers`), Buffer.from([0, 1])]);
	const withDb = (files) => ({ statSync: enoent, readFileSync: (p) => files[p] ?? enoent() });
	const gone = withDb({ "/home/op/.local/share/containers/storage/db.sql": db(1240) });
	const there = { ...gone, statSync: () => ({}) };
	const denied = { ...gone, statSync: () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } };
	const read = (reason) => ({ answered: false, reason, transient: true });
	const home = "/home/op";
	assert.equal(podmanRunDirGone({ read: read("exit-125"), euid: 1240, fs: gone, home }), "/run/user/1240");
	assert.equal(podmanRunDirGone({ read: read("exit-1"), euid: 1240, fs: gone, home }), "/run/user/1240", "5.8.1 with XDG_RUNTIME_DIR set exits 1");
	assert.equal(podmanRunDirGone({ read: read("exit-125"), euid: 1240, fs: withDb({ "/home/op/.local/share/containers/storage/libpod/bolt_state.db": db(1240) }), home }), "/run/user/1240", "an older BoltDB store");
	assert.equal(podmanRunDirGone({ read: read("exit-125"), euid: 1240, fs: withDb({ "/x/containers/storage/db.sql": db(1240) }), home, env: { XDG_DATA_HOME: "/x" } }), "/run/user/1240", "XDG_DATA_HOME moves it");
	// Gate round 1: no evidence that Podman ever ran under /run/user (an account that never had a session), so nothing
	// is claimed about linger; the generic line says what failed.
	assert.equal(podmanRunDirGone({ read: read("exit-125"), euid: 1240, fs: withDb({}), home }), null, "no database");
	assert.equal(podmanRunDirGone({ read: read("exit-125"), euid: 1240, fs: withDb({ "/home/op/.local/share/containers/storage/db.sql": Buffer.from("/tmp/podman-run-1240/containers") }), home }), null, "a database whose run root is elsewhere");
	assert.equal(podmanRunDirGone({ read: read("exit-125"), euid: 1240, fs: withDb({ "/home/op/.local/share/containers/storage/db.sql": db(12400) }), home }), null, "another uid's /run/user is not this one's");
	assert.equal(podmanRunDirGone({ read: read("exit-125"), euid: 1240, fs: gone, home: null }), null, "no home, no storage root to look in");
	assert.equal(podmanRunDirGone({ read: read("exit-125"), euid: 1240, fs: there, home }), null);
	assert.equal(podmanRunDirGone({ read: read("exit-125"), euid: 1240, fs: denied, home }), null, "only ENOENT counts");
	for (const reason of ["timeout", "signal-sigkill", "spawn-failed", "podman-not-found"]) assert.equal(podmanRunDirGone({ read: read(reason), euid: 1240, fs: gone, home }), null, reason);
	assert.equal(podmanRunDirGone({ read: { answered: true, info: {} }, euid: 1240, fs: gone, home }), null);
	assert.equal(podmanRunDirGone({ read: read("exit-125"), euid: 0, fs: gone, home }), null, "root has no /run/user run root here");
});

test("readLingerOrFlag: loginctl's answer, else logind's flag file, as Ubuntu 24.04's loginctl fails for a non-lingering account (#464)", async () => {
	const { readLingerOrFlag } = await import("../src/doctor.mjs");
	const flags = (present) => ({ statSync: (p) => { if (present.includes(p)) return {}; throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } });
	const failing = fakeSpawn({ "loginctl show-user": { code: 1, output: "" } }, []);
	assert.equal(await readLingerOrFlag("op", { spawn: fakeSpawn({ "loginctl show-user": { code: 0, output: "Linger=no\n" } }, []), fs: flags([]) }), false);
	assert.equal(await readLingerOrFlag("op", { spawn: failing, fs: flags(["/var/lib/systemd/linger"]) }), false);
	assert.equal(await readLingerOrFlag("op", { spawn: failing, fs: flags(["/var/lib/systemd/linger", "/var/lib/systemd/linger/op"]) }), true);
	assert.equal(await readLingerOrFlag("op", { spawn: failing, fs: flags([]) }), null, "no logind flag directory: unknown");
});

test("doctor names Podman's missing run directory after linger went off, with the measured fix, in place of the undecided line (#464)", async () => {
	const DB = `${PODMAN_HOME}/.local/share/containers/storage/db.sql`;
	const runDirGone = { ...podmanFs, statSync: (p) => (p === "/run/user/1234" ? (() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); })() : podmanFs.statSync(p)), readFileSync: (p) => (p === DB ? Buffer.from("\0/run/user/1234/containers\0") : podmanFs.readFileSync(p)) };
	for (const [linger, said] of [["no", ", because linger is off for op"], [null, " (linger could not be read)"]]) {
		const { out, text } = capture();
		const plan = { ...podmanPlan(), "podman info": { code: 125, output: "" }, ...(linger ? { "loginctl show-user op -p Linger": { code: 0, output: `Linger=${linger}\n` } } : { "loginctl show-user": { code: 1, output: "" } }) };
		const code = await runDoctor(podmanEnv(), podmanDeps(out, plan, [], { userName: () => "op", observationFs: runDirGone }));
		assert.equal(code, 1, text());
		assert.ok(text().includes(`✗ podman: every podman command fails as this account (exit-125): its run directory /run/user/1234 does not exist${said}. Podman keeps the run root it first used, under that directory, and cannot start a container or answer \`podman info\` without it -- no podman job can run\n    → sudo loginctl enable-linger op -- it starts the account's user manager, which recreates /run/user/1234, and keeps it with no one logged in (measured, Podman 5.8.1 and 4.9.3). \`podman system migrate\` does not get past this (measured: it fails the same way), and a login session of the account (ssh, \`machinectl shell op@\`) recreates the directory only while that session lasts. Then re-run doctor\n`), text());
		assert.doesNotMatch(text(), /which uid a job runs as could not be decided/);
	}
	// With the directory there, an exit status is still the undecided line it always was.
	const { out, text } = capture();
	await runDoctor(podmanEnv(), podmanDeps(out, { ...podmanPlan(), "podman info": { code: 125, output: "" } }, [], { userName: () => "op", observationFs: { ...podmanFs, statSync: (p) => (p === "/run/user/1234" ? {} : podmanFs.statSync(p)) } }));
	assert.match(text(), /⚠ podman: which uid a job runs as could not be decided \(exit-125\)/);
	assert.doesNotMatch(text(), /its run directory/);
	// Gate round 1: the directory gone but no database of Podman's recording it (an account that never had a session):
	// the undecided line, never "linger is off".
	const fresh = capture();
	await runDoctor(podmanEnv(), podmanDeps(fresh.out, { ...podmanPlan(), "podman info": { code: 125, output: "" } }, [], { userName: () => "op", observationFs: { ...runDirGone, readFileSync: podmanFs.readFileSync } }));
	assert.match(fresh.text(), /⚠ podman: which uid a job runs as could not be decided \(exit-125\)/);
	assert.doesNotMatch(fresh.text(), /its run directory|linger/);
});

test("doctor with no home: the durable stores' per-account root owned by another account is ✗, said once beside the jobs dir line (#464)", async () => {
	const uid = process.geteuid();
	const root = `/t/pi-dispatch-${uid}`;
	const run = async (env) => {
		const checks = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", TMPDIR: "/t", ...env }, { ...collectSeams(green), home: "", jobsDirUid: uid, jobsDirFs: jobsFs({ "/t": { uid: 0 }, [root]: { uid: 1270 } }), passwd: () => "op:x:1270:1270::/home/op:/bin/bash\n" });
		return checks.filter((c) => c.ok === false && !c.warn);
	};
	const alone = await run({ PI_JOBS_DIR: "/srv/jobs-elsewhere" });
	assert.deepEqual(alone.filter((c) => c.label.startsWith(root)), [{
		ok: false,
		label: `${root}, where this account's run history and settings overlay (no home directory, so the default is here) lives, is owned by op (uid 1270), not by this account (uid ${uid}); the worker refuses it at boot`,
		fix: `another account created ${root} before this one; remove it as its owner or as root (sudo rm -rf ${root}), or set PI_JOBS_DIR in .env to a directory this account owns; or set PI_LOGS_DIR and PI_SETTINGS_FILE to a path this account owns`,
	}]);
	const both = await run({});
	assert.equal(both.filter((c) => c.label.startsWith(`${root}, `)).length, 1, "the jobs dir line already names that root; not twice");
	const mine = await collectChecks({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", TMPDIR: "/t", PI_JOBS_DIR: "/srv/x" }, { ...collectSeams(green), home: "", jobsDirUid: uid, jobsDirFs: jobsFs({ "/t": { uid: 0 }, [root]: { uid } }) });
	assert.ok(!mine.some((c) => c.label.startsWith(`${root}, `)), "this account's root says nothing new");
});

// --- issue #448: rootful Podman's containers.conf keys that reach a `local` job ---------------------------------------

/** A host holding `files` (text, or `{ error }`) and nothing else; every stat is an mtime of 0 unless `mtimes` says. */
const rootfulHostFs = (files = {}, ctimes = {}) => {
	const fail = (code, p) => {
		throw Object.assign(new Error(`${code}: ${p}`), { code });
	};
	const at = (p) => (files[p] === undefined ? fail("ENOENT", p) : typeof files[p] === "object" ? fail(files[p].error, p) : files[p]);
	return { readFileSync: at, readdirSync: (p) => (typeof files[p] === "object" ? fail(files[p].error, p) : fail("ENOENT", p)), statSync: (p) => (ctimes[p] !== undefined ? { size: 0, ctimeMs: ctimes[p] } : (at(p), { size: 0, ctimeMs: 0 })) };
};
// The doctor fakes' docker endpoint (EGRESS_OK), which podman.socket must be listening on for podman.service to be trusted.
const DOCTOR_SOCK = "/Users/x/.docker/run/docker.sock";
const UNIT_OF = (over) => ({ read: true, loaded: true, running: false, startedAtMs: null, environment: {}, environmentFiles: [], unitPaths: [], modules: [], manager: { read: true, environment: {}, modules: [] }, listen: [DOCTOR_SOCK], ...over });
const IDLE_UNIT = async () => UNIT_OF({});
const rootfulDoctor = async (env, { fs, readPodmanService = IDLE_UNIT, body = PODMAN_COMPAT_INFO, live = false } = {}) => {
	const { out, text } = capture();
	await runDoctor(ghEnv(env), { ...ghDeps(out, { ...infoPlan(body), ...green }), jobUserIdentity: LINUX_ID(1234), stat: socketStat, observationFs: fs, readPodmanService, ...(live ? { live: true } : {}) });
	return text();
};

test("doctor: a rootful Podman containers.conf key that reaches a local job is ✗ where it stops a boot, ⚠ where it refuses each job (#448)", async () => {
	for (const key of ["annotations", "env", "helper_binaries_dir"]) {
		const fs = rootfulHostFs({ "/etc/containers/containers.conf": `${key} = []\n` });
		const boot = await rootfulDoctor({}, { fs });
		assert.match(boot, new RegExp(`✗ local: no job can run on this venue \\(podman-conf-widens-job\\): /etc/containers/containers\\.conf sets ${key}, which [^\\n]* -- a worker running as this account refuses to boot\\n {4}→ remove that key from that file, then sudo systemctl restart podman\\.service`), key);
		assert.doesNotMatch(boot, /✓ local: no containers\.conf rootful Podman's service reads here/);
	}
	const perJob = await rootfulDoctor({ PI_BACKENDS: "podman,local" }, { fs: rootfulHostFs({ "/etc/containers/containers.conf": "env = []\n" }) });
	assert.match(perJob, /⚠ local: no job can run on this venue \(podman-conf-widens-job\): \/etc\/containers\/containers\.conf sets env, which [^\n]* -- every local job is refused/);
	// Measured inert on this route: no line refuses them, and the clean line is said.
	for (const key of ["pasta_options", "network_cmd_options", "network_cmd_path"]) {
		const clean = await rootfulDoctor({}, { fs: rootfulHostFs({ "/etc/containers/containers.conf": `${key} = []\n` }) });
		assert.match(clean, /✓ local: no containers\.conf rootful Podman's service reads here sets any of the 24 keys the local venue refuses \(docs\/podman\.md\), and none of them changed since podman\.service started \(a file deleted while it runs is not seen here: only a running worker remembers what it saw\)/, key);
		assert.doesNotMatch(clean, /podman-conf-widens-job/, key);
	}
});

test("doctor: a running podman.service older than its containers.conf is ⚠, the worker's retry, with the restart; so is a moment's failure (#448)", async () => {
	const running = async () => UNIT_OF({ running: true, startedAtMs: 5_000 });
	const stale = await rootfulDoctor({}, { fs: rootfulHostFs({ "/etc/containers/containers.conf": "[containers]\n" }, { "/etc/containers/containers.conf": 6_000 }), readPodmanService: running });
	// Gate round 1 of PR #473: it heals by itself, so the worker retries (boot exit 1): ⚠, never ✗.
	assert.match(stale, /⚠ local: every local job is held, not refused, until rootful Podman's service restarts: \/etc\/containers\/containers\.conf changed after the running podman\.service started[^\n]*\n {4}→ sudo systemctl restart podman\.service while no local job runs/);
	assert.doesNotMatch(stale, /✗ local: no job can run/);
	const fresh = await rootfulDoctor({}, { fs: rootfulHostFs({ "/etc/containers/containers.conf": "[containers]\n" }, { "/etc/containers/containers.conf": 4_000 }), readPodmanService: running });
	assert.match(fresh, /✓ local: no containers\.conf rootful Podman's service reads here/);
	const busy = await rootfulDoctor({}, { fs: rootfulHostFs({ "/etc/containers/containers.conf": { error: "EMFILE" } }) });
	assert.match(busy, /⚠ local: whether rootful Podman's containers\.conf widens a job could not be read just now: \/etc\/containers\/containers\.conf could not be read \(EMFILE\)/);
});

test("doctor: what this shell cannot read of rootful Podman's chain is its own ⚠, naming each path, never a refusal (#448)", async () => {
	const text = await rootfulDoctor({}, { fs: rootfulHostFs({ "/root/.config/containers/containers.conf": { error: "EACCES" }, "/root/.config/containers/containers.conf.d": { error: "EACCES" } }) });
	assert.match(text, /⚠ local: part of rootful Podman's configuration is not judged here: \/root\/\.config\/containers\/containers\.conf \(EACCES\), \/root\/\.config\/containers\/containers\.conf\.d \(EACCES\)\n {4}→ rootful Podman's service may also read /);
	assert.match(text, /✓ local: no containers\.conf rootful Podman's service reads here sets any of the 24 keys the local venue refuses \(docs\/podman\.md\), among those this account can read, and none of them changed since podman\.service started \(a file deleted while it runs is not seen here: only a running worker remembers what it saw\)\n/, "the readable chain is still judged, and clean, and the line says only that");
	assert.doesNotMatch(text, /podman-conf-widens-job/);
	const noSystemd = await rootfulDoctor({}, { fs: rootfulHostFs(), readPodmanService: async () => ({ read: false, reason: "systemctl-not-found" }) });
	assert.match(noSystemd, /⚠ local: part of rootful Podman's configuration is not judged here: podman\.service \(systemctl-not-found\)/);
	assert.match(noSystemd, /✓ local: no containers\.conf rootful Podman's service reads here sets any of the 24 keys the local venue refuses \(docs\/podman\.md\)\n/, "nothing said of a service that was not read");
});

test("doctor: Docker reads no rootful file and never asks systemctl, and says nothing new (#448)", async () => {
	let asked = 0;
	const text = await rootfulDoctor({}, { fs: rootfulHostFs({ "/etc/containers/containers.conf": "env = []\n" }), body: ROOTFUL_INFO, readPodmanService: async () => (asked++, IDLE_UNIT()) });
	assert.equal(asked, 0);
	assert.doesNotMatch(text, /rootful Podman|podman-conf-widens-job/);
});

test("doctor --live runs no local probe where a local job is refused on rootful Podman's containers.conf (#448)", async () => {
	const { out, text } = capture();
	const facts = {};
	await collectChecks(ghEnv(), { ...collectSeams({ ...infoPlan(PODMAN_COMPAT_INFO), ...green }, { home: "/nowhere", platform: "linux", jobUserIdentity: LINUX_ID(1234), stat: socketStat, observationFs: rootfulHostFs({ "/etc/containers/containers.conf": "env = []\n" }), readPodmanService: IDLE_UNIT, facts }), out });
	assert.deepEqual(facts.jobUser, { run: false, reason: "a local job is refused here (podman-conf-widens-job), so a probe would read back a container no job gets" });
	void text;
});

test("doctor: the backend section's mountSet judges the same podman.service answer, so a stale service withholds it (#448)", async () => {
	let asked = 0;
	const running = async () => (asked++, UNIT_OF({ running: true, startedAtMs: 5_000 }));
	const text = await rootfulDoctor({}, { fs: rootfulHostFs({ "/etc/containers/mounts.conf": "", "/etc/containers/containers.conf": "[containers]\n" }, { "/etc/containers/containers.conf": 6_000 }), readPodmanService: running });
	assert.equal(asked, 1, "one read, for both lines");
	assert.match(text, /local: mountSet is ASSERTED[^\n]*\/etc\/containers\/containers\.conf changed after the running podman\.service started, and a running Podman service keeps the containers\.conf it started with, so what it mounts/);
	const fresh = await rootfulDoctor({}, { fs: rootfulHostFs({ "/etc/containers/mounts.conf": "", "/etc/containers/containers.conf": "[containers]\n" }), readPodmanService: running });
	assert.doesNotMatch(fresh, /local: mountSet is ASSERTED/);
});

test("doctor: an unreadable drop-in in /etc is ✗, not a residual; another rootful service's socket is named, not trusted (#448)", async () => {
	// Gate round 1 of PR #473 (raw 70): a 0600 root drop-in the service applied while doctor said ✓.
	const hidden = { ...rootfulHostFs({ "/etc/containers/containers.conf.d/zz.conf": { error: "EACCES" } }), readdirSync: (p) => (p === "/etc/containers/containers.conf.d" ? ["zz.conf"] : (() => { throw Object.assign(new Error(p), { code: "ENOENT" }); })()) };
	const text = await rootfulDoctor({}, { fs: hidden });
	assert.match(text, /✗ local: no job can run on this venue \(podman-conf-widens-job\): \/etc\/containers\/containers\.conf\.d\/zz\.conf could not be read \(EACCES\)[^\n]*\n {4}→ make that file readable by the worker's account/);
	assert.doesNotMatch(text, /✓ local: no containers\.conf rootful Podman's service reads here/);
	// A socket podman.socket does not listen on (raw 72): podman.service's environment is not that service's.
	const other = await rootfulDoctor({}, { fs: rootfulHostFs(), readPodmanService: async () => UNIT_OF({ listen: ["/run/podman/podman.sock"] }) });
	assert.match(other, /⚠ local: part of rootful Podman's configuration is not judged here: podman\.service \(the worker's socket \/Users\/x\/\.docker\/run\/docker\.sock is not the one podman\.socket listens on \(\/run\/podman\/podman\.sock\)/);
});

// ---- issue #471, follow-up: the five items the first pass named ----

test("a relative PI_TRIGGERS_FILE is the deployment folder's, as the worker's own read resolves it (#471)", async () => {
	assert.equal(triggersPath({ PI_TRIGGERS_FILE: "conf/t.json" }, "/srv/deploy"), "/srv/deploy/conf/t.json");
	assert.equal(triggersPath({ PI_TRIGGERS_FILE: "/abs/t.json" }, "/srv/deploy"), "/abs/t.json");
	assert.equal(triggersPath({}, "/srv/deploy"), "/srv/deploy/triggers.json");
	assert.equal(triggersPath({ PI_TRIGGERS_FILE: "" }, "/srv/deploy"), "", "empty stays empty: the worker refuses to boot on it");
	// End to end: a deployment folder that is not this process's working directory, and a relative path into it.
	const cwd = scaffoldedCwd();
	mkdirSync(join(cwd, "conf"));
	writeFileSync(join(cwd, "conf", "t.json"), readFileSync(forgeTriggersFile("gitlab")));
	const { out, text } = capture();
	await runDoctor(imgEnv({ PI_TRIGGERS_FILE: "conf/t.json" }), { ...imgDeps(out, green), cwd, fileExists: existsSync });
	assert.match(text(), /triggers\.json has gitlab triggers but GITLAB_TOKEN is unset/, "the file under the deployment folder was read");
});

test("the session store's path reaches the terminal escaped, in its label, its fix and its --fix command (#471)", async () => {
	const sessionsDir = "/srv/sess\u001b[2Jions";
	const { fn: promptFn } = promptRecorder(false);
	const { out, text } = capture();
	await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", PI_SESSIONS_DIR: sessionsDir, PI_SESSION_MAX_AGE_DAYS: "3\u001b]0;x", PI_TRIGGERS_FILE: resumeTriggersFile(), GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_fixture" },
		{ out, spawn: fakeSpawn(green), probeValkey: async () => true, nodeVersion: "22.19.0", fix: true, promptFn, fileExists: (p) => p !== sessionsDir, mkdir: () => {}, chmod: () => {} },
	);
	assert.doesNotMatch(text(), /\u001b/, "no raw ESC reaches the terminal");
	assert.ok(text().includes('Session store does not exist ("/srv/sess\\u001b[2Jions")'), text());
	assert.ok(text().includes('PI_SESSION_MAX_AGE_DAYS="3\\u001b]0;x"'), text());
});

test("the overlay comparison reads THIS shell's pi setup, the one import-pi stages from, never the .env's (#471)", async () => {
	const dir = overlay({ packages: [pkg()] });
	const seen = [];
	await collectChecks(overlayEnv(dir), {
		...overlayDeps(() => {}),
		agentDir: undefined,
		readHosts: async () => ({ hosts: [] }),
		fileExists: existsSync,
		serviceEnvFile: serviceEnvFileOf(Buffer.from("PI_CODING_AGENT_DIR=/from/env/agent\n"), "/d/.env", "systemd"),
		readHostPiFn: async ({ agentDir }) => (seen.push(agentDir), { agentDir, packages: [], extensions: [], settingsState: "absent" }),
	});
	const { agentDirFrom } = await import("../src/host-pi.mjs");
	assert.deepEqual(seen, [agentDirFrom(overlayEnv(dir))], "this shell's (here the default), not /from/env/agent");
});


test("a .env CONTAINERS_CONF is judged in-process by the conf-chain check and never handed to doctor's podman (#471)", async () => {
	// Gate round 1 (c6): a CONTAINERS_CONF naming a containers.conf with conmon_path made doctor's own `podman info` run it.
	// Since PR #474's round cap no `.env` value reaches a spawn at all; the chain check reads it, in-process, as the worker.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "CONTAINERS_CONF=/srv/deploy/containers.conf\n");
	const calls = [];
	const { out, text } = capture();
	await runDoctor(podmanEnv(), podmanDeps(out, podmanPlan(), calls, { cwd, readEnvFile: (path) => readFileSync(path) }));
	assert.ok(calls.some((c) => c.cmd === "podman"));
	assert.ok(!calls.some((c) => c.opts?.env?.CONTAINERS_CONF), "no spawn is handed the refused chain");
	assert.match(text(), /CONTAINERS_CONF is set, so which containers\.conf Podman reads is not the list this check reads/, "the conf-chain check judges the service's chain");
	assert.ok(text().includes(`⚠ CONTAINERS_CONF is set in ${join(cwd, ".env")} (/srv/deploy/containers.conf), and doctor hands nothing from that file to a program it starts, so its podman probes ran without it and describe this shell's view, not the service's; the containers.conf check below read it as the worker does`), text());
	assert.match(text(), /✗ podman: no job can run on this venue \(podman-conf-widens-job\): CONTAINERS_CONF is set/, "the refused chain, judged in-process from .env, is still a ✗");
	// Set differently in this shell: a disagreement like any other key.
	const two = capture();
	await runDoctor(podmanEnv({ CONTAINERS_CONF: "/home/me/c.conf" }), podmanDeps(two.out, podmanPlan(), [], { cwd, readEnvFile: (path) => readFileSync(path) }));
	assert.ok(two.text().includes(`CONTAINERS_CONF is "/home/me/c.conf" in this shell and "/srv/deploy/containers.conf" in ${join(cwd, ".env")}`), two.text());
});



test("from a .env another account can write, or its group can, doctor takes no value at all and says so (#471)", async () => {
	const plan = { ...green, "gh auth status": { code: 0, output: ghStatusOutput }, "gh auth token": { code: 0, output: "gho_x\n" }, "docker run": 0 };
	const envText = "PI_JOB_IMAGE=team/img:1\nPI_BACKENDS=local\nDOCKER_HOST=unix:///srv/other.sock\nPI_GLOBAL_ALLOW_EXTENSIONS=false\n";
	// Group-writable, this account's.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), envText);
	chmodSync(join(cwd, ".env"), 0o664);
	const calls = [];
	const { out, text } = capture();
	await runDoctor(ghEnv(), { ...ghDeps(out, plan, calls), cwd, agentDir: NO_AGENT_DIR, readEnvFile: (path) => readFileSync(path) });
	assert.match(text(), new RegExp(`✗ ${join(cwd, ".env").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} is owned by [^\\n]* with mode 0664, writable by the members of its group [^\\n]*, so doctor took no value from it`));
	assert.ok(!calls.some((c) => c.args.includes("team/img:1") || c.opts?.env?.DOCKER_HOST), "no image and no daemon from it");
	assert.doesNotMatch(text(), /service settings read from|venue keys read from|neither on nor off/);
	// Owned by another account (the seam stands for this process's uid).
	chmodSync(join(cwd, ".env"), 0o600);
	const other = capture();
	const calls2 = [];
	await runDoctor(ghEnv(), { ...ghDeps(other.out, plan, calls2), cwd, agentDir: NO_AGENT_DIR, readEnvFile: (path) => readFileSync(path), trustUid: 4242, passwd: () => "" });
	assert.match(other.text(), /\.env is owned by uid \d+ with mode 0600, not by this account or root, so doctor took no value from it/);
	assert.ok(!calls2.some((c) => c.args.includes("team/img:1")));
	// Its own and closed: read as before.
	const own = capture();
	await runDoctor(ghEnv(), { ...ghDeps(own.out, plan, []), cwd, agentDir: NO_AGENT_DIR, readEnvFile: (path) => readFileSync(path) });
	assert.match(own.text(), /Job image present \(team\/img:1\) -- PI_JOB_IMAGE read from/);
});

test("with a worker unit installed for this folder, a service key only this shell sets is named, never its value (#471)", async () => {
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "PI_LOGS_DIR=/srv/logs\n");
	const deployDir = cwd;
	const { home } = installUnit({ platform: "linux", deployDir });
	const shell = { PI_JOB_IMAGE: "busybox:secret-tag", GITLAB_TOKEN: "glpat-shell-only", TMPDIR: "/tmp/x" };
	const { out, text } = capture();
	await runDoctor(ghEnv(shell), { ...ghDeps(out, green, []), cwd, home, platform: "linux", agentDir: NO_AGENT_DIR, readEnvFile: (path) => readFileSync(path) });
	assert.match(text(), /⚠ [^\n]*PI_JOB_IMAGE, GITLAB_TOKEN[^\n]* are set in this shell only: the service installed for this folder \([^)]*\) loads [^\n]*\.env, not this shell, so it runs without those values unless its --env-setup script sets them/);
	assert.doesNotMatch(text(), /TMPDIR[^\n]*set in this shell only/, "what a service manager gives every service is not named");
	// XDG_CONFIG_HOME at its default is what the service falls back to: not named. Anywhere else, named.
	const dflt = capture();
	await runDoctor(ghEnv({ ...shell, XDG_CONFIG_HOME: join(home, ".config") }), { ...ghDeps(dflt.out, green, []), cwd, home, platform: "linux", agentDir: NO_AGENT_DIR, readEnvFile: (path) => readFileSync(path) });
	assert.doesNotMatch(dflt.text(), /XDG_CONFIG_HOME[^\n]*set in this shell only/);
	const moved = capture();
	await runDoctor(ghEnv({ ...shell, XDG_CONFIG_HOME: "/srv/elsewhere" }), { ...ghDeps(moved.out, green, []), cwd, home, platform: "linux", agentDir: NO_AGENT_DIR, readEnvFile: (path) => readFileSync(path) });
	assert.match(moved.text(), /XDG_CONFIG_HOME[^\n]*set in this shell only/);
	assert.doesNotMatch(text(), /glpat-shell-only/);
	// No unit for this folder: nothing to say.
	const none = capture();
	await runDoctor(ghEnv(shell), { ...ghDeps(none.out, green, []), cwd, home: tempDir("pi-471-nohome-"), platform: "linux", agentDir: NO_AGENT_DIR, readEnvFile: (path) => readFileSync(path) });
	assert.doesNotMatch(none.text(), /set in this shell only/);
});

test("a refused PI_JOB_IMAGE's default carries no 'read from .env' note (#471)", async () => {
	const r = await envDoctor("PI_JOB_IMAGE=--privileged\n", {});
	assert.match(r.text, /✓ Job image present \(pi-job:latest\)\n/, r.text);
});


// ---- issue #471, PR #474 gate round 2: resolved paths, one-descriptor .env, and endpoints ----


test("trustedChain: this account's or root's all the way down; a root sticky directory is the one writable exception (#471 gate 2)", async () => {
	const { trustedChain } = await import("../src/service-env.mjs");
	const node = (uid, mode, dir = true, link = false) => ({ uid, gid: uid, mode: (dir ? 0o040000 : 0o100000) | mode, isDirectory: () => dir, isSymbolicLink: () => link });
	const tree = { "/": node(0, 0o755), "/tmp": node(0, 0o1777), "/tmp/me": node(501, 0o700), "/tmp/me/f": node(501, 0o600, false), "/srv": node(0, 0o1777), "/srv/x": node(501, 0o700) };
	const fs = { lstatSync: (p) => tree[p] ?? (() => { throw Object.assign(new Error("x"), { code: "ENOENT" }); })() };
	const names = { ownerName: (id) => (id === 501 ? "me" : `uid ${id}`), groupName: (id) => (id === 501 ? "me" : `gid ${id}`) };
	assert.equal(trustedChain("/tmp/me/f", { fs, uid: 501, names }), null, "/tmp's sticky bit protects an entry its owner made");
	tree["/srv"] = node(501, 0o1777);
	assert.equal(trustedChain("/srv/x", { fs, uid: 501, names }), "/srv is owned by me with mode 1777, writable by every account", "sticky counts only on root's");
	tree["/srv"] = node(501, 0o775);
	assert.equal(trustedChain("/srv/x", { fs, uid: 501, names }), "/srv is owned by me with mode 0775, writable by the members of its group me (me's own group, which may have no other member; doctor trusts only a file no group can write)", "a user-private group is said as one (gate round 3)");
	tree["/tmp/me"] = node(4242, 0o700);
	assert.equal(trustedChain("/tmp/me/f", { fs, uid: 501, names }), "/tmp/me is owned by uid 4242 with mode 0700, not by this account or root");
	tree["/tmp/me"] = node(501, 0o700, true, true);
	assert.match(trustedChain("/tmp/me/f", { fs, uid: 501, names }), /became a symbolic link/);
	assert.equal(trustedChain("/anything", { fs, uid: undefined }), null, "no uids on this platform");
});


test("a .env in a folder another account can change gives no value, whatever the file's own owner and mode (#471 gate 2)", async () => {
	const parent = tempDir("pi-471-r2-envdir-");
	const cwd = join(parent, "deploy");
	mkdirSync(cwd);
	writeFileSync(join(cwd, ".env"), "PI_JOB_IMAGE=team/img:1\n");
	chmodSync(join(cwd, ".env"), 0o600);
	chmodSync(cwd, 0o777);
	const calls = [];
	const r = capture();
	await runDoctor(ghEnv(), { ...ghDeps(r.out, green, calls), cwd, agentDir: NO_AGENT_DIR });
	assert.ok(r.text().includes(`${join(cwd, ".env")} is in a folder another account can change: ${realpathSync(cwd)} is owned by`) && r.text().includes("with mode 0777, writable by every account"), r.text());
	assert.ok(!calls.some((c) => c.args.includes("team/img:1")));
	// A .env that is a link into such a folder: the same, judged at the file's real folder.
	chmodSync(cwd, 0o700);
	const elsewhere = tempDir("pi-471-r2-envlink-");
	writeFileSync(join(elsewhere, "real.env"), "PI_JOB_IMAGE=team/img:2\n");
	chmodSync(join(elsewhere, "real.env"), 0o600);
	chmodSync(elsewhere, 0o777);
	rmSync(join(cwd, ".env"));
	symlinkSync(join(elsewhere, "real.env"), join(cwd, ".env"));
	const calls2 = [];
	const r2 = capture();
	await runDoctor(ghEnv(), { ...ghDeps(r2.out, green, calls2), cwd, agentDir: NO_AGENT_DIR });
	assert.ok(r2.text().includes(`is in a folder another account can change: ${realpathSync(elsewhere)} is owned by`), r2.text());
	assert.ok(!calls2.some((c) => c.args.includes("team/img:2")));
});


// ---- issue #471, PR #474's round cap: nothing from .env reaches a program doctor starts ----

// THE BOLT, both ways. Statically: every environment doctor.mjs hands a child is built from `spawnEnv`, which runDoctor
// sets to the shell's own environment and to nothing else. Dynamically: a run over a .env that sets every CLI variable, a
// PAT, a token and every other kind of service key, with distinctive values, hands no child any of them.
test("no program doctor starts receives an environment derived from .env values (#471 round cap)", async () => {
	const code = readFileSync(new URL("../src/doctor.mjs", import.meta.url), "utf8").replace(/^\s*(\/\/|\*).*$/gm, "");
	assert.match(code, /\n\tseams\.spawnEnv = shellVars;\n/, "runDoctor hands children this shell's environment");
	assert.doesNotMatch(code, /seams\.spawnEnv = (?!shellVars;)/, "and nothing else");
	// The environment option of every runCmdCapture / spawn call in doctor.mjs (the options bag after the argv).
	const envOptions = [...code.matchAll(/\b(?:runCmdCapture|spawn)\([^\n]*?\{ (?:[^\n]*?, )?env: (\{ \.\.\.[^}]*\}|[A-Za-z_$][\w$.]*)/g)].map((m) => m[1].trim());
	assert.ok(envOptions.length >= 3, "the scan sees doctor's own spawn environments");
	// `opts.env` is runCmdCapture forwarding its caller's, which is one of the others.
	// Issue #521: the probe's extended environment is gone (its token rides stdin), so the shell's own is the only form.
	for (const e of envOptions) assert.match(e, /^(?:spawnEnv|opts\.env)$/, `a spawn environment built from something other than this shell's: ${e}`);
	// The one stdin a child is handed: the probe's token, which comes from this shell (pinned just below).
	assert.deepEqual([...code.matchAll(/\binput: ([^\n]*?) \}\);/g)].map((m) => m[1]), ["`${token}\\n`"]);
	assert.equal(envOptions.filter((e) => e === "opts.env").length, 1, "one forwarder");
	assert.doesNotMatch(code, /\bcliSpawn\b|\bspawnWith\b/, "no spawn wrapper that could add to it");
	// The token that one stdin carries never comes from .env (the probe is skipped instead).
	assert.match(code, /token = patFromFile \? "" : \(shellPat \?\? ""\)\.trim\(\);/);
	assert.match(code, /const shellPat = shellValue\(patVar\);/);

	const marker = (k) => `from-env-${k.toLowerCase()}-${k.length}`;
	const cliKeys = [...new Set(Object.values(CLI_SERVICE_KEYS).flat())];
	const envText = [...cliKeys.map((k) => `${k}=/${marker(k)}`), "GITHUB_AUTH_SOURCE=pat", `GITHUB_PAT=${marker("PAT")}`, `WEBHOOK_SECRET=${marker("WH")}`, `PI_JOB_IMAGE=${marker("IMG")}:1`, "PI_BACKENDS=local,podman", `VALKEY_PASSWORD=${marker("VALKEYPW")}`].join("\n") + "\n";
	for (const [shell, deps] of [
		[ghEnv(), (out, calls, cwd) => ({ ...ghDeps(out, { ...green, "docker run": 0, "gh auth status": { code: 0, output: ghStatusOutput }, "gh auth token": { code: 0, output: "gho_shell\n" } }, calls), cwd, agentDir: NO_AGENT_DIR })],
		[podmanEnv({ PI_BACKENDS: "local,podman" }), (out, calls, cwd) => podmanDeps(out, { ...podmanPlan(), ...green }, calls, { cwd })],
	]) {
		const cwd = scaffoldedCwd();
		writeFileSync(join(cwd, ".env"), envText);
		const calls = [];
		const r = capture();
		await runDoctor(shell, deps(r.out, calls, cwd));
		assert.ok(calls.length > 0, `the run spawned its probes: ${calls.length}`);
		assert.ok(calls.some((c) => c.cmd === "docker" || c.cmd === "podman"), "a container runtime among them");
		for (const c of calls) {
			for (const [k, v] of Object.entries(c.opts?.env ?? {})) assert.doesNotMatch(String(v), /from-env-/, `${c.cmd} ${c.args.join(" ")} was handed ${k} from .env`);
			assert.doesNotMatch(c.stdin ?? "", /from-env-/, `${c.cmd} ${c.args.join(" ")} was handed a .env value on stdin`);
			if (c.opts?.env) for (const k of cliKeys) assert.equal(c.opts.env[k], shell[k], `${c.cmd} got ${k} only as this shell has it`);
		}
		// Each CLI variable is named once, as not handed on; its value shown only for a path.
		for (const k of cliKeys) assert.equal(r.text().split("\n").filter((l) => l.startsWith(`⚠ ${k} is set in `)).length, 1, `${k}: ${r.text()}`);
		assert.doesNotMatch(r.text(), /from-env-gh_token|from-env-github_token|from-env-container_host|from-env-docker_host|from-env-docker_context|from-env-container_connection|from-env-gh_host|from-env-pat|from-env-wh|from-env-valkeypw/, "no endpoint, name or token value is printed");
		// Issue #468: the Valkey password is a service key, secret, named only: read as a service setting, never printed,
		// and never handed to a child (the loop above), since doctor starts no Valkey.
		assert.match(r.text(), /service settings read from [^\n]*VALKEY_PASSWORD/);
		assert.match(r.text(), /⚠ XDG_CONFIG_HOME is set in [^\n]* \(\/from-env-xdg_config_home-15\)/, "a path's value is shown");
		assert.doesNotMatch(r.text(), /service settings read from[^\n]*(CONTAINERS_CONF|DOCKER_HOST|GH_TOKEN)/, "a CLI variable is never listed as read");
	}
});

test("a shell GITHUB_PAT_VAR naming a venue key only .env sets hands the probe nothing from the file (#471 round-cap re-review, D1)", async () => {
	const plan = { ...green, "docker run": 0 };
	for (const [key, value] of [["PI_BACKENDS", "local"], ["PI_EGRESS", "on"], ["PI_EGRESS_PROXY", "from-dotenv-proxy"]]) {
		const r = await envDoctor(`GITHUB_AUTH_SOURCE=pat\n${key}=${value}\n`, { GITHUB_PAT_VAR: key, ...(key === "PI_BACKENDS" ? {} : { PI_BACKENDS: "local" }) }, { plan });
		for (const c of r.calls) {
			assert.notEqual(c.opts?.env?.GH_TOKEN, value, `${key}: the file's value reached ${c.cmd} as GH_TOKEN`);
			assert.ok(!(c.stdin ?? "").includes(value), `${key}: the file's value reached ${c.cmd} on stdin`);
		}
		assert.ok(!r.calls.some((c) => c.args[0] === "run" && c.args.includes("gh")), `${key}: the probe is skipped`);
		assert.ok(r.text.includes(`⚠ in-image gh auth: not checked, because ${key} comes from ${r.envPath} and doctor hands nothing from that file to a program it starts`), `${key}: ${r.text}`);
	}
	// This shell's own value of the same key: its own, handed on as before.
	const own = await envDoctor("GITHUB_AUTH_SOURCE=pat\n", { GITHUB_PAT_VAR: "PI_EGRESS_PROXY", PI_EGRESS_PROXY: "shell-token", PI_BACKENDS: "local" }, { plan });
	assert.equal(own.calls.find((c) => c.args[0] === "run" && c.args.includes("gh"))?.stdin, "shell-token\n");
});

test("cliNotHandedLines: one ⚠ per CLI variable the file sets, the value only for a path, and the chain check named for its three (#471 round cap)", () => {
	const service = { fromFile: { CONTAINER_HOST: "ssh://u:p@h/s", DOCKER_CONFIG: "/srv/d\u001b[2J", GH_TOKEN: "ghp_x", PI_LOGS_DIR: "/srv/logs" } };
	const lines = cliNotHandedLines(service, "/d/.env");
	assert.deepEqual(lines.map((l) => l.label.split(" ")[0]), ["CONTAINER_HOST", "DOCKER_CONFIG", "GH_TOKEN"], "the CLI variables alone");
	assert.ok(lines.every((l) => l.ok === false && l.warn === true), "warnings, never a failure: the service's own settings are not a fault");
	assert.equal(lines[0].label, "CONTAINER_HOST is set in /d/.env, and doctor hands nothing from that file to a program it starts, so its podman probes ran without it and describe this shell's view, not the service's");
	assert.ok(lines[1].label.startsWith('DOCKER_CONFIG is set in /d/.env ("/srv/d\\u001b[2J"), and'), "a path shown, escaped");
	assert.doesNotMatch(lines.map((l) => l.label).join("\n"), /u:p|ghp_x/);
	const chain = cliNotHandedLines({ fromFile: { XDG_CONFIG_HOME: "/x" } }, "/d/.env")[0].label;
	assert.match(chain, /its podman and gh probes ran without it[^\n]*; the containers.conf check below read it as the worker does$/);
	assert.match(lines[0].fix, /^the service's own podman uses it: check what CONTAINER_HOST names and who can change it, then/, "never plain advice to export a value nobody checked");
	const home = cliNotHandedLines({ fromFile: { HOME: "/h" } }, "/d/.env")[0];
	assert.match(home.label, /so its podman, docker and gh probes ran without it/);
	assert.match(home.fix, /^the service's own podman, docker and gh use it: /, "the verb agrees with the count (D2)");
});

test("this account's own unix socket in .env is no failure: named as not handed on, nothing more (#471 round cap)", async () => {
	const cwd = scaffoldedCwd();
	const run = tempDir("pi-471-r3-sock-");
	writeFileSync(join(run, "podman.sock"), "");
	chmodSync(join(run, "podman.sock"), 0o660);
	writeFileSync(join(cwd, ".env"), `CONTAINER_HOST=unix://${run}/podman.sock\nDOCKER_HOST=unix:///var/run/docker.sock\n`);
	const calls = [];
	const r = capture();
	await runDoctor(podmanEnv({ PI_BACKENDS: "local,podman" }), podmanDeps(r.out, { ...podmanPlan(), ...green }, calls, { cwd }));
	assert.doesNotMatch(r.text(), /^✗ (CONTAINER_HOST|DOCKER_HOST)/m);
	assert.match(r.text(), /^⚠ CONTAINER_HOST is set in /m);
	assert.match(r.text(), /^⚠ DOCKER_HOST is set in /m);
	assert.ok(!calls.some((c) => c.opts?.env?.CONTAINER_HOST || c.opts?.env?.DOCKER_HOST));
});

// PR #475's review, round 3: PI_VALKEY_PORT is where compose publishes its Valkey; one that disagrees with VALKEY_URL's
// port (in .env, or this shell, which wins over --env-file) moves the queue off the worker's port on the next compose run.
test("doctor flags a PI_VALKEY_PORT that disagrees with VALKEY_URL's port, in .env or this shell (#475 round 3)", async () => {
	const dir = tempDir("doctor-valkey-port-");
	writeFileSync(join(dir, ".env"), "VALKEY_URL=redis://127.0.0.1:16495\nPI_VALKEY_PORT=16000\n");
	const run = async (env) => {
		const { out, text } = capture();
		await runDoctor({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_fixture", ...env }, { out, cwd: dir, spawn: fakeSpawn(green), probeValkey: async () => true, fileExists: () => true, nodeVersion: "22.19.0" });
		return text();
	};
	const t1 = await run({});
	assert.ok(t1.includes(`⚠ PI_VALKEY_PORT is 16000 in ${join(dir, ".env")}, and VALKEY_URL's port is 16495: compose publishes its Valkey on 16000, where the worker does not dial.`), t1);
	const t2 = await run({ PI_VALKEY_PORT: "17000" });
	assert.match(t2, /⚠ PI_VALKEY_PORT is 17000 in this shell, and VALKEY_URL's port is 16495/);
	writeFileSync(join(dir, ".env"), "VALKEY_URL=redis://127.0.0.1:16495\nPI_VALKEY_PORT=16495\n");
	assert.doesNotMatch(await run({}), /PI_VALKEY_PORT is/, "agreeing: nothing said");
	writeFileSync(join(dir, ".env"), "VALKEY_URL=redis://valkey.internal:16495\nPI_VALKEY_PORT=16000\n");
	assert.doesNotMatch(await run({}), /PI_VALKEY_PORT is/, "another host's port is not compose's");
});

const PW468 = "7a11ed0c".repeat(8);
async function doctorAuth({ auth, open, passwordSet = false, env = {}, envFile = null, mode = 0o600 }) {
	const cwd = scaffoldedCwd();
	if (envFile !== null) writeFileSync(join(cwd, ".env"), envFile);
	const asked = [];
	const probed = [];
	const { out, text } = capture();
	const code = await runDoctor(
		{ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_fixture", ...env },
		{
			out,
			cwd,
			spawn: fakeSpawn(green),
			probeValkey: async (url) => (probed.push(url), true),
			valkeyAuth: async (url, opts = {}) => (asked.push([url, opts.withoutPassword === true]), opts.withoutPassword ? { state: open, passwordSet: false } : { state: auth, passwordSet, from: passwordSet ? join(cwd, ".env") : null }),
			nodeVersion: "22.19.0",
			readEnvFile: (path) => readFileSync(path, "utf8"),
			stat: (p) => (p.endsWith(".env") ? { mode: 0o100000 | mode } : statSync(p)),
		},
	);
	return { code, text: text(), asked, probed };
}

test("doctor (#468): a Valkey that requires a password this deployment does not send, or refuses the one it sends, is a ✗ naming the key, never the value", async () => {
	const none = await doctorAuth({ auth: "noauth" });
	assert.equal(none.code, 1);
	assert.match(none.text, /✗ Valkey \(redis:\/\/127\.0\.0\.1:6379\) answers, and requires a password this deployment does not send: the worker refuses to start on it \(exit 2\)\n\s+→ put VALKEY_PASSWORD=<that Valkey's password> in [^\n]*\.env \(for a Valkey shared with PI_VALKEY_SHARED=1, the password of the account that runs it\)/);
	assert.doesNotMatch(none.text, /Valkey reachable/, "not \"unreachable\", and no offer to start a second one");
	assert.deepEqual(none.probed, []);
	const wrong = await doctorAuth({ auth: "wrongpass", passwordSet: true, envFile: `VALKEY_PASSWORD=${PW468}\n` });
	assert.equal(wrong.code, 1);
	assert.match(wrong.text, /✗ Valkey \(redis:\/\/127\.0\.0\.1:6379\) answers, and refuses the VALKEY_PASSWORD this deployment sends/);
	assert.ok(!wrong.text.includes(PW468), "the value is never printed");
});

test("doctor (#468): a loopback Valkey that answers a client sending NO password is a warning with the upgrade step; one that requires it is a ✓", async () => {
	const open = await doctorAuth({ auth: "ok", open: "ok" });
	assert.match(open.text, /⚠ Valkey \(redis:\/\/127\.0\.0\.1:6379\) has no password: any local account can read, enqueue or delete this deployment's jobs \(VALKEY_PASSWORD is not set\)\n\s+→ run `pi-dispatch up`: it writes a VALKEY_PASSWORD into \.env and restarts pi-dispatch-valkey with it/);
	assert.deepEqual(open.asked.map((a) => a[1]), [false, true], "asked as this deployment, then as a client with none");
	const stale = await doctorAuth({ auth: "ok", open: "ok", passwordSet: true, envFile: `VALKEY_PASSWORD=${PW468}\n` });
	assert.match(stale.text, /⚠ Valkey \(redis:\/\/127\.0\.0\.1:6379\) answers a client that sends no password, although VALKEY_PASSWORD is set: it was started before the password existed/);
	const guarded = await doctorAuth({ auth: "ok", open: "noauth", passwordSet: true, envFile: `VALKEY_PASSWORD=${PW468}\n` });
	assert.match(guarded.text, /✓ Valkey \(redis:\/\/127\.0\.0\.1:6379\) requires a password, and the one this deployment sends \(VALKEY_PASSWORD from [^\n]*\/\.env\) is accepted \(the value is not shown\)/, "names where the password came from");
	for (const r of [open, stale, guarded]) assert.ok(!r.text.includes(PW468));
	// Another machine's Valkey is the operator's own to secure: not judged.
	const remote = await doctorAuth({ auth: "ok", open: "ok", env: { VALKEY_URL: "redis://queue.lan:6379" } });
	assert.doesNotMatch(remote.text, /has no password|answers a client that sends no password/);
	assert.equal(remote.asked.length, 1, "no second probe for a remote Valkey");
	// The upgrade step names the command that restarts THIS venue's Valkey.
	assert.match(valkeyPasswordUpgradeStep({ localUsed: false, podmanUsed: true }), /^run `pi-dispatch service install --force` as this account: it writes a VALKEY_PASSWORD into \.env, restarts the Quadlet Valkey with it \(the queue in its volume is kept\) and then the worker and the receiver$/);
	assert.match(valkeyPasswordUpgradeStep({ localUsed: true, podmanUsed: false }), /docker compose --env-file \.env -f deploy\/docker-compose\.yml up -d/);
});

test("doctor (#468): a .env holding VALKEY_PASSWORD that others can read is a warning, and a value Valkey could not take is a ✗", async () => {
	const wide = await doctorAuth({ auth: "ok", open: "noauth", passwordSet: true, envFile: `VALKEY_PASSWORD=${PW468}\n`, mode: 0o644 });
	assert.match(wide.text, /⚠ [^\n]*\.env holds VALKEY_PASSWORD and is readable by every account on this host \(mode 644\)\n\s+→ chmod 600 [^\n]*\.env/);
	const group = await doctorAuth({ auth: "ok", open: "noauth", passwordSet: true, envFile: `VALKEY_PASSWORD=${PW468}\n`, mode: 0o640 });
	assert.match(group.text, /readable by its group \(mode 640\)/);
	const tight = await doctorAuth({ auth: "ok", open: "noauth", passwordSet: true, envFile: `VALKEY_PASSWORD=${PW468}\n` });
	assert.doesNotMatch(tight.text, /holds VALKEY_PASSWORD and is readable/);
	const bad = await doctorAuth({ auth: "ok", open: "noauth", passwordSet: true, envFile: "VALKEY_PASSWORD=tooshort\n" });
	assert.match(bad.text, /✗ [^\n]*\.env cannot be handed to Valkey: it is 8 characters long/);
	assert.doesNotMatch(bad.text, /tooshort/);
});

// Issue #468 over issue #471's rule: doctor's own in-process client sends the RESOLVED password (this shell's, else the
// file's, the file's to a loopback Valkey only), and no program doctor starts is handed it.
test("doctor (#468 over #471): the AUTH check's context carries the resolved password, a disagreement never prints it, and no child is handed it", async () => {
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), `VALKEY_PASSWORD=${PW468}\n`);
	const contexts = [];
	const calls = [];
	const run = async (env, url = "redis://127.0.0.1:6379") => {
		const { out, text } = capture();
		contexts.length = 0;
		await runDoctor({ PI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-x", GITHUB_AUTH_SOURCE: "pat", GITHUB_PAT: "ghp_fixture", VALKEY_URL: url, ...env }, { out, cwd, spawn: fakeSpawn(green, calls), probeValkey: async () => true, valkeyAuth: async (_u, opts = {}) => (contexts.push(opts.context), { state: opts.withoutPassword ? "noauth" : "ok", passwordSet: true, from: "x" }), nodeVersion: "22.19.0" });
		return text();
	};
	await run({});
	assert.equal(valkeyPasswordFor("redis://127.0.0.1:6379", contexts[0]).password, PW468, "the file's, to a loopback Valkey");
	assert.equal(valkeyPasswordFor("redis://queue.lan:6379", contexts[0]).password, null, "never the file's to another host");
	const both = await run({ VALKEY_PASSWORD: "shellside0123456789" });
	assert.equal(valkeyPasswordFor("redis://127.0.0.1:6379", contexts[0]).password, "shellside0123456789", "this shell's where it sets one");
	assert.match(both, /VALKEY_PASSWORD is set differently in this shell and in [^\n]*\.env \(neither value is shown\)/);
	assert.ok(!both.includes(PW468) && !both.includes("shellside0123456789"), "neither value printed");
	for (const c of calls) for (const v of Object.values(c.opts?.env ?? {})) assert.notEqual(String(v), PW468, `${c.cmd} ${c.args.join(" ")} was handed the file's password`);
});

test("doctor reads the documented unquoted PI_BACKEND_FLOOR from .env and judges it (#477)", async () => {
	// Round-446 final verification (pd-fedora, raw/52): `PI_BACKEND_FLOOR=isolation=enforced` in .env, the form
	// docs/podman.md shows, drew a false ✗ ("in a form the service's loader may read differently") and then "✓
	// PI_BACKEND_FLOOR is not set", so the floor the service refuses to boot on was never judged.
	const cwd = scaffoldedCwd();
	writeFileSync(join(cwd, ".env"), "PI_BACKEND_FLOOR=isolation=enforced\n");
	const { out, text } = capture();
	const code = await runDoctor(podmanEnv(), podmanDeps(out, podmanPlan(), [], { cwd, platform: "linux", observationFs: podmanFsWith(null) }));
	assert.equal(code, 1, text());
	assert.doesNotMatch(text(), /assigns PI_BACKEND_FLOOR/);
	assert.doesNotMatch(text(), /PI_BACKEND_FLOOR is not set/);
	assert.match(text(), /✓ service settings read from [^\n]*\.env, as the service reads them \(this shell does not set them\): [^\n]*PI_BACKEND_FLOOR/);
	assert.match(text(), /✗ PI_BACKEND_FLOOR asks for isolation=enforced \(podman provides it only while/);
	// Quoted, the same value reads the same.
	writeFileSync(join(cwd, ".env"), "PI_BACKEND_FLOOR='isolation=enforced'\n");
	const quoted = capture();
	assert.equal(await runDoctor(podmanEnv(), podmanDeps(quoted.out, podmanPlan(), [], { cwd, platform: "linux", observationFs: podmanFsWith(null) })), 1);
	assert.match(quoted.text(), /✗ PI_BACKEND_FLOOR asks for isolation=enforced \(podman provides it only while/);
});

test("doctor's ready line names a worker that reads the .env it judged, and keeps `pi-dispatch worker` where it judged none (#477)", async () => {
	// Round-446 final verification (pd-fedora, raw/51): doctor judged .env's Valkey and ended with "Start the worker with
	// `pi-dispatch worker`", and that worker, started by hand, read its shell alone and dialled 127.0.0.1:6379.
	const cwd = scaffoldedCwd();
	const envPath = join(cwd, ".env");
	writeFileSync(envPath, "PI_JOB_IMAGE=pi-job:latest\n");
	const { out, text } = capture();
	assert.equal(await runDoctor(podmanEnv(), podmanDeps(out, podmanPlan(), [], { cwd, platform: "linux" })), 0, text());
	assert.match(text(), /✓ service settings read from [^\n]*\.env[^\n]*: PI_JOB_IMAGE\n/);
	assert.ok(text().endsWith(`\ndoctor: ready. Start the worker as the service, whose loader reads ${envPath} as doctor did: \`pi-dispatch service install\`. A worker started by hand (\`pi-dispatch worker\`) reads this shell's environment and not that file, so it runs without the settings doctor read from the file above unless this shell exports them.\n`), text());
	assert.doesNotMatch(text(), /Start the worker with `pi-dispatch worker`/);
	// A service installed for this folder: restart it, by the command that drives its scope (PR #478's gate: a system
	// unit was told `pi-dispatch service restart`, which only drives `systemctl --user` and refuses `--system`).
	const esc = (x) => x.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
	const withUnit = async (unitPath) => {
		const c = capture();
		await runDoctor(podmanEnv(), podmanDeps(c.out, podmanPlan(), [], { cwd, platform: "linux", fileExists: (p) => p === unitPath || existsSync(p), readUnit: (p) => (p === unitPath ? `[Service]\nWorkingDirectory=${cwd}\nEnvironmentFile=${envPath}\n` : (() => { throw new Error("ENOENT"); })()) }));
		return c.text();
	};
	for (const [unitPath, command] of [
		["/etc/systemd/system/pi-dispatch-worker.service", "sudo systemctl restart pi-dispatch-worker.service"],
		["/etc/systemd/system/worker.service", "sudo systemctl restart worker.service"],
		[join(PODMAN_HOME, ".config", "systemd", "user", "pi-dispatch-worker.service"), "pi-dispatch service restart"],
	]) {
		const text = await withUnit(unitPath);
		assert.match(text, new RegExp(`\\ndoctor: ready\\. Start the worker as the service, whose loader reads [^\\n]* as doctor did: \`${esc(command)}\` \\(the service installed for this folder, ${esc(unitPath)}\\)\\. A worker started by hand`), unitPath);
	}
	// The same rule on the other two platforms, where doctor cannot be run green here: a LaunchDaemon is kickstarted
	// in the system domain, a LaunchAgent restarts through the CLI, and on Windows the nssm service has no file to read.
	const advice = (platform, unit) => startAdvice({ tookFromFile: true, envPath: "/d/.env", platform, unit });
	assert.match(advice("darwin", { path: "/Library/LaunchDaemons/com.pi-dispatch.worker.plist", scope: "system" }), /: `sudo launchctl kickstart -k system\/com\.pi-dispatch\.worker` \(the service installed for this folder, \/Library\/LaunchDaemons\/com\.pi-dispatch\.worker\.plist\)\./);
	assert.match(advice("darwin", { path: "/Users/o/Library/LaunchAgents/com.pi-dispatch.worker.plist", scope: "user" }), /: `pi-dispatch service restart` \(the service installed for this folder, /);
	assert.match(advice("darwin", null), /: `pi-dispatch service install`\. A worker/);
	assert.match(advice("win32", null), /: `pi-dispatch service install`, or `pi-dispatch service restart` when its nssm service is already installed\. A worker/);
	assert.equal(startAdvice({ tookFromFile: false, envPath: "/d/.env", platform: "win32", unit: null }), "Start the worker with `pi-dispatch worker`.");
	// Taken from the file only through a provider key (`extra`), the line still names the service.
	const { ANTHROPIC_API_KEY: _k, ...noKey } = podmanEnv();
	writeFileSync(envPath, "ANTHROPIC_API_KEY=sk-file\n");
	const keyed = capture();
	assert.equal(await runDoctor(noKey, podmanDeps(keyed.out, podmanPlan(), [], { cwd, platform: "linux" })), 0, keyed.text());
	assert.doesNotMatch(keyed.text(), /service settings read from/);
	assert.match(keyed.text(), /\ndoctor: ready\. Start the worker as the service/);
	// This shell sets what the file does (it wins, so doctor judged the shell's): the worker started from it runs that.
	writeFileSync(envPath, "PI_JOB_IMAGE=pi-job:latest\n");
	const shellWins = capture();
	assert.equal(await runDoctor(podmanEnv({ PI_JOB_IMAGE: "pi-job:latest" }), podmanDeps(shellWins.out, podmanPlan(), [], { cwd, platform: "linux" })), 0, shellWins.text());
	assert.ok(shellWins.text().endsWith("\ndoctor: ready. Start the worker with `pi-dispatch worker`.\n"), shellWins.text());
	// And with no .env at all.
	const bare = capture();
	assert.equal(await runDoctor(podmanEnv(), podmanDeps(bare.out, podmanPlan(), [], { cwd: scaffoldedCwd(), platform: "linux" })), 0, bare.text());
	assert.ok(bare.text().endsWith("\ndoctor: ready. Start the worker with `pi-dispatch worker`.\n"), bare.text());
	// The venue keys, which `deploymentVenueEnv` decides apart from the rest, count too.
	writeFileSync(envPath, "PI_BACKENDS=podman\nPI_EGRESS=0\n");
	const { PI_BACKENDS: _b, PI_EGRESS: _e, ...noVenue } = podmanEnv();
	const venue = capture();
	assert.equal(await runDoctor(noVenue, podmanDeps(venue.out, podmanPlan(), [], { cwd, platform: "linux" })), 0, venue.text());
	assert.match(venue.text(), /✓ venue keys read from/);
	assert.match(venue.text(), /\ndoctor: ready\. Start the worker as the service/);
});

test("doctor says a VALKEY_URL path that names no database as a ✗ and contacts no Valkey, never an unhandled rejection (#477 follow-up)", async () => {
	// PR #478's gate, pd-fedora: `redis://127.0.0.1:16478/abc` and `/0,x=y=z` ended doctor with "error: an unhandled
	// rejection: ERR value is not an integer or out of range".
	for (const url of ["redis://127.0.0.1:6379/abc", "redis://127.0.0.1:6379/0,x=y=z"]) {
		const { out, text } = capture();
		const asked = [];
		const code = await runDoctor(ghEnv({ VALKEY_URL: url }), { ...ghDeps(out, green), probeValkey: async (u) => (asked.push(`probe ${u}`), true), valkeyAuth: async (u) => (asked.push(`auth ${u}`), { state: "ok" }), readHosts: async (u) => (asked.push(`hosts ${u}`), { hosts: [] }) });
		assert.equal(code, 1, text());
		assert.ok(text().includes(`✗ VALKEY_URL ${url} names no database: its path must be a whole number (redis://host:port/0 is database 0, and no path means the same), not ${JSON.stringify(new URL(url).pathname)}: the worker refuses to start on it (exit 2), and doctor contacted no Valkey\n    → write VALKEY_URL as redis://host:port, or redis://host:port/<database number>, then re-run doctor\n`), text());
		assert.deepEqual(asked, [], "no probe, no AUTH, no fleet read");
		assert.doesNotMatch(text(), /Valkey reachable/);
	}
	// A database number is judged as before.
	const { out, text } = capture();
	await runDoctor(ghEnv({ VALKEY_URL: "redis://127.0.0.1:6379/3" }), { ...ghDeps(out, green), probeValkey: async () => true });
	assert.match(text(), /✓ Valkey reachable \(redis:\/\/127\.0\.0\.1:6379\/3\)/);
});

test("doctor says a VALKEY_URL database that Valkey does not have as a ✗, and reads nothing more from it (gate round 2 of PR #478)", async () => {
	// Measured: `/16` on a default Valkey. Every client refuses it rather than going on on database 0, and doctor's AUTH
	// probe is the client that finds it (`valkeyAuthState`'s "dbrange").
	const sentence = "VALKEY_URL redis://127.0.0.1:6379/16 names database 16, which that Valkey does not have: it has 16 (databases 0 to 15, its `databases` setting). No client uses another database in its place; name one it has, or raise `databases` in that Valkey's configuration";
	const { out, text } = capture();
	const asked = [];
	const code = await runDoctor(ghEnv({ VALKEY_URL: "redis://127.0.0.1:6379/16" }), { ...ghDeps(out, green), probeValkey: async (u) => (asked.push(`probe ${u}`), true), valkeyAuth: async (u, o) => (asked.push(`auth ${u}${o?.withoutPassword ? " (no password)" : ""}`), { state: "dbrange", error: sentence }), readHosts: async (u) => (asked.push(`hosts ${u}`), { hosts: [] }) });
	assert.equal(code, 1, text());
	assert.ok(text().includes(`✗ ${sentence}: the worker refuses to start on it (exit 2)\n    → write VALKEY_URL with a database that Valkey has (no path is database 0), or raise \`databases\` in its configuration, then re-run doctor\n`), text());
	assert.deepEqual(asked, ["auth redis://127.0.0.1:6379/16"], "the one probe that found it, and no reachability, password or fleet read after it");
	assert.doesNotMatch(text(), /Valkey reachable/);
});

test("doctor takes a valkey:// VALKEY_URL as redis:// (gate round 3 of PR #478)", async () => {
	const { out, text } = capture();
	const asked = [];
	await runDoctor(ghEnv({ VALKEY_URL: "valkey://127.0.0.1:6379/2" }), { ...ghDeps(out, green), probeValkey: async (u) => (asked.push(u), true) });
	assert.match(text(), /✓ Valkey reachable \(valkey:\/\/127\.0\.0\.1:6379\/2\)/);
	assert.doesNotMatch(text(), /does not connect with|names no database/);
	assert.deepEqual(asked, ["valkey://127.0.0.1:6379/2"]);
});

// Issue #484: a copy of the proxy's rules that differs from the installed package's is said, as a ⚠ naming the file and
// the refresh; an identical or an absent one is not, and neither is a copy no shipped proxy mounts.
test("doctor warns when this folder's deploy/egress-proxy.conf differs from the package's copy, and is silent when it matches (#484)", async () => {
	const folder = tempDir("pi-doctor-484-");
	mkdirSync(join(folder, "deploy"));
	writeFileSync(join(folder, "egress-allowlist.conf"), "api.anthropic.com\n");
	writeFileSync(join(folder, "deploy/egress-proxy.conf"), "http_port 3128\n");
	const run = async (packaged, env = {}, plan = {}) => {
		const { out, text } = capture();
		const code = await runDoctor(ghEnv({ PI_EGRESS: "1", ...env }), { ...ghDeps(out, egressPlan({ [PROXY_KEY]: proxyAnswer("healthy", "running", { cwd: folder }), "gh auth status": { code: 0, output: ghStatusOutput }, ...plan })), cwd: folder, readPackagedProxyConf: () => packaged });
		return { code, text: text() };
	};
	const stale = await run("http_port 3128\nacl allowed dstdomain -n \"/etc/pi-dispatch/allowlist.conf\"\n");
	assert.match(stale.text, /⚠ deploy\/egress-proxy\.conf in this folder differs from the package's copy \([^)]+\) \(0 lines of it not in the package's copy, 1 line of the package's not in it\), so the egress proxy runs rules this version did not ship\n/);
	assert.match(stale.text, /→ an upgrade does not rewrite it, so this is either an older version's rules or your own edit: `diff \S+\/deploy\/egress-proxy\.conf \S+egress-proxy\.conf` shows which\. To take this version's, `pi-dispatch up` from this folder offers to replace it with the package's copy, keeping this one as a backup, and then to restart the proxy, since squid reads its rules only at start; a proxy made before #503, which lacks the model-endpoints\.conf mount the new rules need, is REPLACED in the same step instead, asked once\. Leave it if the difference is yours/);
	assert.doesNotMatch(stale.text, /✗ deploy\/egress-proxy\.conf/, "a warning, never a failure: a differing copy still enforces the allowlist");
	const same = await run("http_port 3128\n");
	assert.doesNotMatch(same.text, /egress-proxy\.conf in this folder (differs|could not)/);
	assert.equal(same.code, stale.code, "the warning moves no exit code");
	// Said before the daemon is asked: a file compare holds whatever docker answers.
	const down = await run("other\n", {}, { "docker version": 1 });
	assert.match(down.text, /⚠ deploy\/egress-proxy\.conf in this folder differs from the package's copy/);
	// A proxy PI_EGRESS_PROXY names mounts no copy of this folder's, and an unarmed policy has no proxy to speak of.
	for (const env of [{ PI_EGRESS_PROXY: "my-squid" }, { PI_EGRESS: "0" }]) {
		const other = await run("other\n", env);
		assert.doesNotMatch(other.text, /egress-proxy\.conf in this folder differs/, JSON.stringify(env));
	}
	// Absent: the missing-file lines elsewhere are the story; nothing here.
	const empty = tempDir("pi-doctor-484-empty-");
	const { out, text } = capture();
	await runDoctor(ghEnv({ PI_EGRESS: "1" }), { ...ghDeps(out, egressPlan({ [PROXY_KEY]: proxyAnswer("healthy", "running"), "gh auth status": { code: 0, output: ghStatusOutput } })), cwd: empty, readPackagedProxyConf: () => "other\n" });
	assert.doesNotMatch(text(), /egress-proxy\.conf in this folder (differs|could not)/);
});

test("doctor on the podman venue warns when the account's rules copy differs from the package's, naming service install --force (#484)", async () => {
	const COPY = `${PODMAN_HOME}/.config/pi-dispatch/egress-proxy.conf`;
	const run = async ({ copy, packaged = "new rules\n", env = {} }) => {
		const { out, text } = capture();
		const readProxyConf = (p) => {
			if (p === COPY && copy !== null) return copy;
			throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
		};
		const code = await runDoctor(podmanEnv({ PI_EGRESS: "1", ...env }), podmanDeps(out, podmanPlan({ proxy: "running" }), [], { readProxyConf, readPackagedProxyConf: () => packaged }));
		return { code, text: text() };
	};
	const stale = await run({ copy: "old rules\n" });
	assert.match(stale.text, /⚠ podman: the egress proxy's rules copy \/home\/op\/\.config\/pi-dispatch\/egress-proxy\.conf differs from the package's copy \([^)]+\) \(1 line of it not in the package's copy, 1 line of the package's not in it\), so the egress proxy runs rules this version did not ship\n/);
	assert.match(stale.text, /To take this version's, `pi-dispatch service install` lists it among what differs and `pi-dispatch service install --force` replaces it and restarts the proxy \(squid reads its rules only at start\)/);
	const same = await run({ copy: "new rules\n" });
	assert.doesNotMatch(same.text, /rules copy .* (differs|could not)/);
	assert.equal(same.code, stale.code, "a warning moves no exit code");
	const absent = await run({ copy: null });
	assert.doesNotMatch(absent.text, /rules copy/);
	const custom = await run({ copy: "old rules\n", env: { PI_EGRESS_PROXY: "my-squid" } });
	assert.doesNotMatch(custom.text, /rules copy/, "a proxy PI_EGRESS_PROXY names mounts no copy of ours");
});

// ---- the dollar settings (issue #501) ----

test("doctor: dollarChecks is silent with nothing set, and names each env refusal the worker's boot makes", () => {
	assert.deepEqual(dollarChecks({}, [], true), [], "nothing set: no line at all");
	assert.deepEqual(dollarChecks({ PI_MAX_COST_USD: "2.50" }, [], true), [], "a valid cap alone: nothing to say");
	const bad = dollarChecks({ PI_MAX_COST_USD: "1.1234567" }, [], true);
	assert.equal(bad.length, 1);
	assert.equal(bad[0].ok, false);
	assert.match(bad[0].label, /^PI_MAX_COST_USD must be a dollar amount.* the worker refuses to start$/);
	assert.doesNotMatch(bad[0].label, /1\.1234567/, "never the value");
	const noCap = dollarChecks({ PI_WEEKLY_COST_USD: "50" }, [], true);
	assert.ok(noCap.some((c) => c.ok === false && /^PI_WEEKLY_COST_USD is set without PI_MAX_COST_USD/.test(c.label)), "the invariant");
	assert.equal(noCap.length, 1, "the invariant is the one refusal: the windows are enforced (issue #501)");
	assert.deepEqual(dollarChecks({ PI_MAX_COST_USD: "2", PI_DAILY_COST_USD: "25", PI_WEEKLY_COST_USD: "100", PI_MONTHLY_COST_USD: "300" }, [], true), [], "windows with the per-job cap: nothing to say");
});

test("doctor: a trigger cap above PI_MAX_COST_USD FAILS when the worker loads the file and warns when it does not", () => {
	const caps = [{ label: 'cron "nightly"', maxCostUsd: "5" }, { label: "label trigger #1", maxCostUsd: 9 }, { label: "comment trigger #2", maxCostUsd: "5.000001" }];
	const loaded = dollarChecks({ PI_MAX_COST_USD: "5" }, caps, true);
	assert.deepEqual(loaded.map((c) => c.label.split(":")[0]), ["label trigger #1", "comment trigger #2"], "equal is fine; above is named");
	for (const c of loaded) {
		assert.equal(c.ok, false);
		assert.equal(c.warn, undefined, "a failure: the worker refuses to start on it");
		assert.match(c.label, /refuses to start/);
	}
	const unloaded = dollarChecks({ PI_MAX_COST_USD: "5" }, caps, false);
	assert.ok(unloaded.every((c) => c.ok === false && c.warn === true && /run under PI_MAX_COST_USD anyway/.test(c.label)));
	assert.deepEqual(dollarChecks({}, caps, true), [], "no deployment cap: a trigger's cap applies alone");
});

test("doctor: the trigger-cap line comes from the real triggers file it reads", async () => {
	const { out, text } = capture();
	await runDoctor(imgEnv({ PI_TRIGGERS_FILE: triggersFile(undefined, undefined, { maxCostUsd: "7" }), PI_MAX_COST_USD: "5" }), imgDeps(out, green));
	assert.match(text(), /cron "nightly": run\.maxCostUsd is above PI_MAX_COST_USD -- the worker refuses to start/);
});

test("doctor: the dollar settings are read from the deployment's .env, as the worker reads them (#501)", async () => {
	// The worker reads PI_*_COST_USD from its .env; a doctor reading only this shell would stay silent while the worker
	// refuses to start.
	const r = await envDoctor("PI_WEEKLY_COST_USD=50\n", {});
	assert.match(r.text, /PI_WEEKLY_COST_USD is set without PI_MAX_COST_USD -- the worker refuses to start/);
	assert.doesNotMatch(r.text, /not supported yet/, "the windows are enforced (issue #501): the invariant is the only refusal");
	for (const name of ["PI_MAX_COST_USD", "PI_DAILY_COST_USD", "PI_WEEKLY_COST_USD", "PI_MONTHLY_COST_USD"]) assert.ok(WORKER_SERVICE_KEYS.includes(name), name);
});

test("doctor: a VALID overlay whose merge with .env leaves a window with no maxCostUsd FAILS, naming the window (#501, PR #542)", async () => {
	const dir = tempDir("pi-542-overlay-");
	const file = join(dir, "settings.json");
	writeFileSync(file, '{"dailyCostUsd":"10"}');
	const bad = await envDoctor(`PI_SETTINGS_FILE=${file}\n`, {});
	assert.ok(bad.text.includes(`settings overlay ${file}: dailyCostUsd needs maxCostUsd`), bad.text);
	assert.match(bad.text, /the worker refuses every job as settings-overlay-invalid/);
	assert.equal(bad.code, 1);
	assert.doesNotMatch((await envDoctor(`PI_SETTINGS_FILE=${file}\nPI_MAX_COST_USD=2\n`, {})).text, /dailyCostUsd needs maxCostUsd/, "the cap in .env");
	writeFileSync(file, '{"maxCostUsd":"2"}');
	assert.doesNotMatch((await envDoctor(`PI_SETTINGS_FILE=${file}\nPI_WEEKLY_COST_USD=50\n`, {})).text, /needs maxCostUsd/, "the window in .env, the cap in the overlay");
	assert.equal(overlayDollarProblem({}, { PI_WEEKLY_COST_USD: "50" }), null, "env alone broken is dollarChecks' line, not repeated");
	assert.match(overlayDollarProblem({ dailyCostUsd: "10" }, { PI_MAX_COST_USD: "" }), /^dailyCostUsd needs maxCostUsd/, "an EMPTY PI_MAX_COST_USD is unset, the worker's own reading");
	assert.equal(overlayDollarProblem({ dailyCostUsd: "10" }, { PI_MAX_COST_USD: "2" }), null);
	assert.equal(overlayDollarProblem({ monthlyCostUsd: 5 }, {}), "monthlyCostUsd needs maxCostUsd: a dollar window reserves each job's per-job cost cap before it starts, so it cannot be set without one");
});

test("doctor: an invalid settings overlay FAILS with the reader's reason, keys only, and a missing one says nothing (#501)", async () => {
	const dir = tempDir("pi-501-overlay-");
	const file = join(dir, "settings.json");
	writeFileSync(file, '{"maxCostUsd":"1","maxCostUsd":"999"}');
	const bad = await envDoctor(`PI_SETTINGS_FILE=${file}\n`, {});
	assert.ok(bad.text.includes(`settings overlay ${file} is invalid (settings file has a duplicate key "maxCostUsd"`), bad.text);
	assert.match(bad.text, /a duplicate key is refused since issue #501; it used to take the last value/);
	assert.equal(bad.text.includes("\"999\""), false, "never a value");
	assert.equal(bad.code, 1);
	// A second kind: the fix follows the reason, and only a duplicate key carries the upgrade note.
	writeFileSync(file, '{"maxCostUsd":"0.1234567"}');
	const kind2 = await envDoctor(`PI_SETTINGS_FILE=${file}\n`, {});
	assert.ok(kind2.text.includes(`settings overlay ${file} is invalid (maxCostUsd must be a dollar amount`), kind2.text);
	assert.match(kind2.text, /fix what the reason names in that file, or delete the file/);
	assert.doesNotMatch(kind2.text, /duplicate key/);
	assert.equal(kind2.text.includes("0.1234567"), false, "never a value");
	writeFileSync(file, "{ not json");
	assert.match((await envDoctor(`PI_SETTINGS_FILE=${file}\n`, {})).text, /is invalid \(settings file is not valid JSON\)/);
	writeFileSync(file, '{"maxCostUsd":"1"}');
	assert.doesNotMatch((await envDoctor(`PI_SETTINGS_FILE=${file}\n`, {})).text, /settings overlay .* is invalid/);
	assert.doesNotMatch((await envDoctor(`PI_SETTINGS_FILE=${join(dir, "absent.json")}\n`, {})).text, /settings overlay .* is invalid/);
});

test("doctor: scoped-limits dollar rows WARN with no per-job cap, and a row window below the per-job cap (PR #549's review)", async () => {
	const rows = [
		{ scope: "/srv/secret", day: 3, week: null, month: null, concurrent: null, dayUsd: null, weekUsd: null, monthUsd: null },
		{ scope: "acme/web", day: null, week: null, month: null, concurrent: null, dayUsd: "1.00", weekUsd: "10.00", monthUsd: null },
		{ scope: "model:openai/gpt-x", day: null, week: null, month: null, concurrent: null, dayUsd: "3.00", weekUsd: null, monthUsd: null },
	];
	const none = scopedDollarRowChecks(rows, undefined, "sl.json");
	assert.equal(none.length, 1);
	assert.equal(none[0].warn, true);
	assert.match(none[0].label, /#1 \(a repo or folder row\), #2 \(a model row\) in sl\.json set a dollar window, but the deployment has no per-job cost cap/);
	const below = scopedDollarRowChecks(rows, "2", "sl.json");
	assert.equal(below.length, 1);
	assert.match(below[0].label, /#1 \(a repo or folder row\) day in sl\.json are below the per-job cost cap/);
	assert.ok(!below[0].label.includes("week"), "a window at or above the cap is fine");
	assert.deepEqual(scopedDollarRowChecks(rows, "1", "sl.json"), []);
	assert.ok(!JSON.stringify(none).includes("/srv/secret"), "never a scope string");
	// Wired: the overlay's maxCostUsd counts, merged over env.
	const dir = tempDir("pi-sl-usd-");
	const path = join(dir, "scoped-limits.json");
	writeFileSync(path, JSON.stringify({ version: 2, limits: [{ scope: "acme/web", dayUsd: "5" }] }));
	const settings = join(dir, "settings.json");
	const seams = collectSeams(green, { cwd: dir, nodeVersion: "22.19.0", probeValkey: async () => true });
	const bare = await collectChecks(imgEnv({ PI_SCOPED_LIMITS_FILE: path, PI_SETTINGS_FILE: settings }), seams);
	assert.ok(bare.some((c) => c.warn === true && /set a dollar window, but the deployment has no per-job cost cap/.test(c.label)));
	writeFileSync(settings, JSON.stringify({ maxCostUsd: "2" }));
	const capped = await collectChecks(imgEnv({ PI_SCOPED_LIMITS_FILE: path, PI_SETTINGS_FILE: settings }), seams);
	assert.ok(!capped.some((c) => /no per-job cost cap \(maxCostUsd\) --/.test(c.label)), "the overlay's cap is seen");
});

// ── PI_ENVELOPE_FILE, the fifth boot file (issue #504 part B) ─────────────────────────────────────────────

/** A canonical deployment folder (realpath: a macOS temp dir is a /var symlink) with projects.json and an envelope. */
function envelopeDeployment({ floors = { shop: "10" }, cap = "2", extra = {} } = {}) {
	const dir = realpathSync.native(tempDir("pi-envelope-doc-"));
	const projects = join(dir, "projects.json");
	writeFileSync(projects, JSON.stringify({ version: 1, projects: [{ id: "shop", members: ["github:acme/web"] }, { id: "tools", members: ["github:acme/tools"] }] }));
	const envelope = join(dir, "envelope.json");
	writeFileSync(envelope, JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: floors }));
	return { dir, envelope, env: imgEnv({ PI_PROJECTS_FILE: projects, PI_ENVELOPE_FILE: envelope, PI_MAX_COST_USD: cap, PI_SETTINGS_FILE: noOverlay(), ...extra }) };
}

test("doctor: an EMPTY PI_ENVELOPE_FILE fails as a refused boot, and a good one loads as the worker loads it (#504)", async () => {
	const dir = tempDir("pi-envelope-empty-");
	const empty = capture();
	const code = await runDoctor(imgEnv({ PI_ENVELOPE_FILE: "" }), scaffoldDeps(empty.out, dir));
	assert.match(empty.text(), /✗ PI_ENVELOPE_FILE is set to an EMPTY value in this shell, which is not unset: the worker keeps it, tries to load "" and REFUSES TO START/);
	assert.notEqual(code, 0);
	const ok = envelopeDeployment();
	const checks = await collectChecks(ok.env, collectSeams(green, { cwd: ok.dir, nodeVersion: "22.19.0", probeValkey: async () => true }));
	assert.ok(!checks.some((c) => c.ok === false && !c.warn && /PI_ENVELOPE_FILE/.test(c.label)), "a loadable envelope fails nothing");
	const facts = checks.find((c) => /^Allocation envelope [0-9a-f]{16}: 100\.00 a week/.test(c.label));
	assert.ok(facts, "one line of facts, with the digest an operator copies into alloc:envelope:expected");
	assert.ok(facts.label.includes(envelopeDigest(loadEnvelopeAsTheWorker(ok.envelope, {}, ok.env))));
});

test("doctor: an envelope the worker would refuse fails: no per-job cap, a floor naming no project, a path inside a job path (#504)", async () => {
	const seams = (dir) => collectSeams(green, { cwd: dir, nodeVersion: "22.19.0", probeValkey: async () => true });
	const failing = (checks) => checks.find((c) => c.ok === false && !c.warn && /PI_ENVELOPE_FILE is set in this shell to a file the worker cannot load/.test(c.label));
	const noCap = envelopeDeployment({ cap: undefined });
	delete noCap.env.PI_MAX_COST_USD;
	assert.match(failing(await collectChecks(noCap.env, seams(noCap.dir))).label, /needs a per-job cost cap: set PI_MAX_COST_USD/);
	const unknown = envelopeDeployment({ floors: { nope: "1" } });
	assert.match(failing(await collectChecks(unknown.env, seams(unknown.dir))).label, /floorsUsd\.nope names a project that is not in the projects file/);
	// The envelope inside a run root: the worker's boot refusal, through the worker's own function.
	const inside = envelopeDeployment({ extra: {} });
	inside.env.PI_DISPATCH_RUN_ROOTS = inside.dir;
	const c = failing(await collectChecks(inside.env, seams(inside.dir)));
	assert.match(c.label, /lies inside a job path \(run-root /);
	assert.match(c.label, /REFUSES TO START/);
});

test("envelopeChecks: a floor below the per-job cap admits no job, and a project outside the envelope joins _other; both WARN (#504)", () => {
	const projects = [{ id: "shop", members: ["github:acme/web"] }, { id: "tools", members: ["github:acme/tools"] }];
	const envelope = parseEnvelope(JSON.stringify({ version: 1, window: "week", totalUsd: "100", floorsUsd: { shop: "1", _other: "0" } }), "/e", { projects, maxCostMicros: 2_000_000 });
	const checks = envelopeChecks(envelope, projects, 2_000_000);
	const low = checks.find((c) => /below the per-job cost cap/.test(c.label));
	assert.ok(low && low.warn === true);
	assert.match(low.label, /shop \(1\.00\)/);
	assert.doesNotMatch(low.label, /_other/, "a floor of 0 is no guaranteed share, never a warning");
	const absent = checks.find((c) => /not in the envelope/.test(c.label));
	assert.ok(absent && absent.warn === true);
	assert.match(absent.label, /project\(s\) tools are in projects\.json and not in the envelope, so their jobs count in _other's share/);
	assert.equal(envelopeChecks(envelope, [projects[0]], 500_000).filter((c) => c.ok === false).length, 0, "a floor at or above the cap, every project named: facts only");
});

test("fleetEnvelopeChecks names the hosts whose envelope differs, and an old worker only while an envelope is in use (#504)", () => {
	const mine = "0123456789abcdef";
	assert.deepEqual(fleetEnvelopeChecks(mine, [{ name: "mini2", fpEnvelope: mine }]), [], "one envelope: nothing");
	const differ = fleetEnvelopeChecks(mine, [{ name: "mini2", fpEnvelope: "fedcba9876543210" }, { name: "mini3", fpEnvelope: "none" }, { name: "mini4", fpEnvelope: mine }]);
	assert.equal(differ.length, 1);
	assert.equal(differ[0].warn, true);
	assert.match(differ[0].label, /^Hosts disagree about the allocation envelope: mini2, mini3 have/);
	assert.match(differ[0].label, /envelope-mismatch/);
	assert.ok(!differ[0].label.includes("mini4"));
	const old = fleetEnvelopeChecks(mine, [{ name: "mini2" }]);
	assert.match(old[0].label, /^mini2 publishes no envelope digest/);
	assert.deepEqual(fleetEnvelopeChecks("none", [{ name: "mini2" }, { name: "mini3", fpEnvelope: "none" }]), [], "no envelope anywhere: nothing new on upgrade");
	assert.match(fleetEnvelopeChecks("none", [{ name: "mini2", fpEnvelope: mine }])[0].label, /and this host has none/);
	assert.match(differ[0].fix, /SET alloc:envelope:expected/, "the fix names the key, not a panel that does not exist yet");
});

test("issue #504 part B: doctor compares this host's envelope digest with its peers', from the service's own file", async () => {
	const ok = envelopeDeployment();
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const env = { ...ok.env, VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1" };
	const digest = envelopeDigest(loadEnvelopeAsTheWorker(ok.envelope, {}, ok.env));
	const agree = await collectChecks(env, fleetSeams([{ name: "mini2", tz, fpEnvelope: digest }]));
	assert.ok(!agree.some((c) => /allocation envelope:|no envelope digest/.test(c.label)));
	const differ = await collectChecks(env, fleetSeams([{ name: "mini2", tz, fpEnvelope: "none" }]));
	assert.ok(differ.some((c) => c.warn === true && /^Hosts disagree about the allocation envelope: mini2/.test(c.label)));
});

test("appliedSplitChecks: the applied split's digest and the hosts matching it; every host that differs FAILS, a host with no envelope too (#504)", () => {
	const d = "0123456789abcdef";
	const ok = appliedSplitChecks({ digest: d }, d, "mini1", [{ name: "mini2", fpEnvelope: d }]);
	assert.deepEqual(ok.map((c) => c.ok), [true]);
	assert.match(ok[0].label, /made for envelope 0123456789abcdef: mini1, mini2 match it/);
	const bad = appliedSplitChecks({ digest: d }, "fedcba9876543210", "mini1", [{ name: "mini2", fpEnvelope: d }, { name: "mini3", fpEnvelope: "none" }, { name: "old" }]);
	assert.match(bad[0].label, /mini2 matches it/);
	assert.equal(bad[1].ok, false);
	assert.equal(bad[1].label, "this host (mini1) carries envelope fedcba9876543210, not the one the applied budget split was made for (0123456789abcdef), so it refuses every governed job as envelope-mismatch", "the host is named, as a peer is (#507)");
	assert.notEqual(bad[1].warn, true, "a failure: this host refuses its governed jobs");
	assert.match(bad[1].fix, /SET alloc:envelope:expected fedcba9876543210/);
	assert.match(bad[2].label, /^mini3 carries no envelope, not the one the applied budget split was made for/);
	const none = appliedSplitChecks({ digest: d }, "none", "mini1", []);
	assert.match(none[1].label, /^this host \(mini1\) has no envelope while the fleet has an applied budget split/);
	assert.match(appliedSplitChecks({ digest: d }, "none", "", [])[1].label, /^this host has no envelope/, "no name to give: the bare words");
	assert.match(none[1].fix, /DEL alloc:plan/);
});

test("doctor reads the applied split when this host has an envelope, and fails a host whose envelope is not it (#504)", async () => {
	const ok = envelopeDeployment();
	const digest = envelopeDigest(loadEnvelopeAsTheWorker(ok.envelope, {}, ok.env));
	const asked = [];
	const read = async (url) => (asked.push(url), { digest: "fedcba9876543210" });
	const checks = await collectChecks(ok.env, collectSeams(green, { cwd: ok.dir, nodeVersion: "22.19.0", probeValkey: async () => true, readAppliedSplit: read }));
	assert.equal(asked.length, 1);
	const fail = checks.find((c) => /^this host \([^)]+\) carries envelope [0-9a-f]{16}, not the one the applied budget split was made for/.test(c.label));
	assert.ok(fail && fail.ok === false && fail.warn !== true);
	assert.ok(fail.label.includes(digest));
});

test("doctor reads the applied split on a single host with NO envelope too, and fails it; a key that does not decode is governed; no match is not green (#504)", async () => {
	const dir = tempDir("pi-no-envelope-");
	const seams = (read) => collectSeams(green, { cwd: dir, nodeVersion: "22.19.0", probeValkey: async () => true, readAppliedSplit: read });
	const bare = imgEnv({ PI_SETTINGS_FILE: noOverlay() });
	const governed = await collectChecks(bare, seams(async () => ({ digest: "0123456789abcdef" })));
	const fail = governed.find((c) => /this host \([^)]+\) has no envelope while the fleet has an applied budget split/.test(c.label));
	assert.ok(fail && fail.ok === false && fail.warn !== true, "a host that refuses every job is a failure");
	assert.match(fail.fix, /DEL alloc:plan alloc:envelope:expected/);
	const summary = governed.find((c) => /^Applied budget split/.test(c.label));
	assert.equal(summary.ok, false, "no host matches the split, so the summary is no green tick");
	assert.equal(summary.warn, true);
	const garbled = await collectChecks(bare, seams(async () => ({ undecodable: true })));
	assert.ok(garbled.some((c) => /alloc:plan exists but is not a budget split/.test(c.label) && c.warn === true));
	assert.ok(garbled.some((c) => /this host \([^)]+\) has no envelope/.test(c.label)), "the worker's EXISTS counts it as governed");
	const never = await collectChecks(bare, seams(async () => null));
	assert.ok(!never.some((c) => /alloc:plan|budget split/.test(c.label)), "a deployment that never delegated hears nothing");
});

test("no doctor test reaches a real Valkey for the applied split: every runDoctor and collectChecks comes from the test helper (#504)", () => {
	// The rule, not the site: the helper defaults `readAppliedSplit` to no split. A test file importing either entry point
	// from the source module would read the developer's real `alloc:plan` on 127.0.0.1:6379 again.
	const dir = new URL("./", import.meta.url);
	const offenders = readdirSync(dir)
		.filter((f) => f.endsWith(".test.mjs"))
		.filter((f) => {
			const src = readFileSync(new URL(f, dir), "utf8");
			return [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\.\/src\/doctor\.mjs"/g)].some((m) => /\b(runDoctor|collectChecks)\b/.test(m[1]));
		});
	assert.deepEqual(offenders, []);
});

// --- issue #596: job sizes ---------------------------------------------------------------------------------------------


test("doctor names the default job size, the --cpus ceiling this runtime gives every job, and warns where SwapLimit is false (#596)", () => {
	const facts = (over) => ({ answered: true, facts: { shape: "docker", podman: false, hostCpus: 14, swapLimit: true, ...over } });
	const plain = jobSizeChecks({}, { daemon: facts() });
	assert.deepEqual(plain.map((c) => [c.ok, c.warn === true]), [[true, false], [true, false]]);
	assert.match(plain[0].label, /^Job size: 4g of memory with no swap beyond it, and the CPU weight of 2 CPUs, per job \(the built-in default;/);
	assert.match(plain[1].label, /^local: any one job may use at most 13 of this runtime's 14 CPUs \(--cpus\);/);
	assert.doesNotMatch(plain[1].label, /kept for the host/, "the ceiling is per job and keeps no core free across jobs (measured)");
	assert.match(jobSizeChecks({ PI_JOB_MEMORY: "1536m", PI_JOB_CPUS: "0.5" })[0].label, /^Job size: 1536m of memory .* weight of 0\.5 CPUs, per job \(PI_JOB_MEMORY and PI_JOB_CPUS;/);
	assert.match(jobSizeChecks({}, { daemon: facts({ hostCpus: 2 }) })[1].label, /at most 2 of this runtime's 2 CPUs/, "a host under four CPUs keeps none back");
	assert.equal(jobSizeChecks({}, {}).length, 1, "no venue named, no ceiling line");
	// The ceiling UNKNOWN is a warning, per venue (P1G1-C1): a job then runs with no --cpus at all.
	for (const [label, opts, want] of [
		["docker not read", { daemon: null }, /^local: `docker info` gave no answer that says its CPU count \(not read\), so the CPU ceiling is unknown and a job that runs gets no --cpus/],
		["docker unreadable", { daemon: { answered: false, reason: "unparseable", transient: false } }, /^local: `docker info` gave no answer that says its CPU count \(unparseable\)/],
		["docker gave no count", { daemon: facts({ hostCpus: null }) }, /^local: `docker info` gave no CPU count, so the CPU ceiling is unknown/],
		["podman gave no count", { podman: { answered: true, info: { hostCpus: null } } }, /^podman: `podman info` gave no CPU count, so the CPU ceiling is unknown .*cpu_ceiling_unknown/],
		["podman did not answer", { podman: { answered: false, reason: "timeout" } }, /^podman: `podman info` gave no answer that says its CPU count \(timeout\)/],
	]) {
		const lines = jobSizeChecks({}, opts);
		assert.deepEqual([lines.length, lines[1].ok, lines[1].warn], [2, false, true], label);
		assert.match(lines[1].label, want, label);
	}
	// A podman-only deployment's ceiling comes from `podman info`; both venues say their own.
	const both = jobSizeChecks({}, { daemon: facts({ hostCpus: 14 }), podman: { answered: true, info: { hostCpus: 4 } } });
	assert.deepEqual(both.slice(1).map((c) => c.label.match(/^(\w+): any one job may use at most (\d+) of this runtime's (\d+)/).slice(1)), [["local", "13", "14"], ["podman", "3", "4"]]);
	const shares = jobSizeChecks({}, { daemon: facts({ cpuShares: false }) }).at(-1);
	assert.deepEqual([shares.ok, shares.warn], [false, true]);
	assert.match(shares.label, /CPUShares false, so it drops --cpu-shares .*size_bound_unenforced/);
	assert.equal(jobSizeChecks({}, { daemon: facts({ cpuShares: null }) }).some((c) => /CPUShares/.test(c.label)), false);
	const swap = jobSizeChecks({}, { daemon: facts({ swapLimit: false }) }).at(-1);
	assert.equal(swap.ok, false);
	assert.equal(swap.warn, true);
	assert.match(swap.label, /SwapLimit false, so it drops --memory-swap and a job may swap beyond its memory \(size_bound_unenforced\)/);
	assert.equal(jobSizeChecks({}, { daemon: facts({ swapLimit: null }) }).some((c) => /SwapLimit/.test(c.label)), false, "Podman's compat answer is not read, so nothing is said");
	// A setting the worker refuses at boot is a FAILURE, never a warning.
	const bad = jobSizeChecks({ PI_JOB_MEMORY: "4GB" });
	assert.deepEqual([bad.length, bad[0].ok, bad[0].warn === true], [1, false, false]);
	assert.match(bad[0].label, /^job size does not parse: PI_JOB_MEMORY: a memory size is a whole number .* REFUSES TO START$/);
});

test("doctor's read-backs and the podman canary are built at the deployment's default size (#596)", () => {
	assert.deepEqual(doctorJobSize({}), { memMiB: 4096, cpuCenti: 200, source: "default" });
	assert.deepEqual(doctorJobSize({ PI_JOB_MEMORY: "2g" }), { memMiB: 2048, cpuCenti: 200, source: "env" });
	assert.deepEqual(doctorJobSize({ PI_JOB_MEMORY: "nope" }), { memMiB: 4096, cpuCenti: 200, source: "default" }, "a refused value is reported by jobSizeChecks; the probes take the default");
	const args = egressCanaryProbeArgs({ bin: "podman", slug: "provider", pid: 1, network: "n", proxy: "p", image: "pi-job:latest", url: "https://x", user: "1234:1234", size: { memMiB: 1024, cpuCenti: 50 }, hostCpus: 4 });
	assert.deepEqual(args.filter((a) => /^--(?:memory|memory-swap|cpus|cpu-shares|shm-size)=/.test(a)), ["--memory=1g", "--memory-swap=1g", "--cpus=3", "--cpu-shares=512", "--shm-size=512m"]);
	// docker's canary is a plain `docker run` with no bounds at all, pinned byte for byte, and stays so.
	assert.equal(egressCanaryProbeArgs({ slug: "provider", pid: 1, network: "n", proxy: "p", image: "pi-job:latest", url: "https://x", size: { memMiB: 1024, cpuCenti: 50 } }).some((a) => a.startsWith("--memory")), false);
});

test("doctor names each peer that predates job sizes once this host's file is version 3, and nothing otherwise (#596)", () => {
	const peers = [{ name: "a", limitsVersion: "3" }, { name: "b" }, { name: "c", limitsVersion: "2" }, { name: "d", limitsVersion: "4" }];
	const [line, ...rest] = fleetSizeChecks(3, peers);
	assert.deepEqual([rest.length, line.ok, line.warn], [0, false, true]);
	assert.equal(line.label, "b, c predate job sizes (scoped-limits version 3), while this host's file is version 3: a running worker from before keeps its last good file, so neither the size nor any later edit to the file (job counts, concurrent, dollar caps) applies on it until it is upgraded and restarted, and it refuses the file at its next start");
	assert.match(line.fix, /upgrade and restart every worker/);
	assert.match(fleetSizeChecks(3, [{ name: "b" }])[0].label, /^b predates job sizes/);
	assert.deepEqual(fleetSizeChecks(2, peers), [], "no size in the file: nothing at risk yet");
	assert.deepEqual(fleetSizeChecks(3, [{ name: "a", limitsVersion: "3" }]), [], "every peer reads version 3");
});

test("issue #596, phase 2: with this host's registry row carrying its ledger, doctor lists the job containers' size labels and holds the two against each other", async () => {
	const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const plan = { ...EGRESS_OK, "docker info": 0, "docker image": 0, "docker ps --filter name=pi-job- --format": { code: 0, output: "pi-job-1\t4096\t200\n" } };
	const seams = (row) => collectSeams(plan, { nodeVersion: "22.19.0", readHosts: async () => ({ hosts: [{ name: "mini1", tz, ...row }] }) });
	const match = await collectChecks({ VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1" }, seams({ usedMemMiB: "4096", usedCpuCenti: "200" }));
	assert.ok(match.some((c) => c.ok && /^Host budget ledger matches the running job containers \(1 running, 4g and 2 CPUs\)/.test(c.label)));
	const differ = await collectChecks({ VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1" }, seams({ usedMemMiB: "0", usedCpuCenti: "0" }));
	assert.ok(differ.some((c) => c.warn && /^Host budget ledger holds 0 and 0 CPUs, while the running job containers are labelled 4g and 2 CPUs/.test(c.label)));
	const none = await collectChecks({ VALKEY_URL: "redis://x", PI_WORKER_NAME: "mini1" }, seams({}));
	assert.ok(!none.some((c) => /Host budget ledger/.test(c.label)), "a row without the ledger: no listing, no line");
});
