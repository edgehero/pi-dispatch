#!/usr/bin/env node
/**
 * Issue #341, end to end on a real Linux kernel: every job mount works for a worker that is NOT uid 1001.
 *
 * The unit suite proves each decision against fakes; this proves the decisions against a real daemon that enforces
 * bind-mount ownership, which is the one thing the GitHub runner's own user (uid 1001, the image's) can never show.
 * Run it as a uid other than 0 and 1001, in the docker group, with PI_JOBS_DIR set:
 *
 *   node .github/scripts/job-user-e2e.mjs <image>
 *
 * It drives the REAL modules only (the facts reader, the resolver, the preparers, the session store, the builder,
 * the cleanup, doctor's decision and read-back) and the REAL runner. Nothing spends: `--network=none`, no provider
 * key, no secret. The runner and read-back negative controls are counted, and the script refuses to pass unless every
 * one of them ran and failed the way it must, so deleting a control's call turns this red rather than vacuously green.
 * What it does NOT exercise: a RESUMED session (the store stages a cold, empty transcript here; a resumed one is the
 * canonical file copied into the same `0700` directory, owned by the same uid).
 */

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, release as osRelease, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const load = (path) => import(pathToFileURL(join(root, path)).href);

const image = process.argv[2];
if (!image) {
	console.error("usage: job-user-e2e.mjs <image>");
	process.exit(64);
}
const jobsDir = process.env.PI_JOBS_DIR;
if (!jobsDir) {
	console.error("PI_JOBS_DIR must be set (a directory this user owns)");
	process.exit(64);
}

const { makeDockerEndpointResolver } = await load("worker/src/backend-local.mjs");
const { buildDockerRunArgs } = await load("worker/src/docker-run.mjs");
const { CONTAINER_HOME } = await load("worker/src/container-spec.mjs");
const { makeImagePreflight } = await load("worker/src/image-preflight.mjs");
const { makeDaemonFactsReader, makeJobUserResolver, resolveImageUser } = await load("worker/src/job-user.mjs");
const { makeCleanup, makeForgePreparers, makePrepareWorkspace } = await load("worker/src/prepare.mjs");
const { prepareGithubWorkspace } = await load("worker/src/prepare-github.mjs");
const { makeSessionStore } = await load("worker/src/session-store.mjs");
const { jobUserChecks, liveChecks } = await load("worker/src/doctor.mjs");

const say = (line) => console.log(`OK: ${line}`);
const controls = { expected: 3, ran: 0 };
const euid = process.geteuid();
const egid = process.getegid();

// --- 1. the preconditions, so a green run cannot be a run of the wrong thing ---------------------------------------
const want = readFileSync(join(root, ".nvmrc"), "utf8").trim().split(".").map(Number);
const have = process.versions.node.split(".").map(Number);
assert.ok(have[0] > want[0] || (have[0] === want[0] && (have[1] > want[1] || (have[1] === want[1] && have[2] >= want[2]))), `node ${process.versions.node} is older than .nvmrc ${want.join(".")}`);
assert.ok(euid !== 0 && euid !== 1001, `run this as a uid other than 0 and 1001 (the image's own); got ${euid}`);
const labels = execFileSync("docker", ["image", "inspect", "--format", '{{index .Config.Labels "dev.pi-dispatch.capabilities"}}', image], { encoding: "utf8" }).trim();
assert.ok(labels.split(",").includes("anyUid"), `${image} does not declare anyUid (${labels})`);
say(`node ${process.versions.node}, uid ${euid}:${egid}, ${image} declares anyUid`);

// --- 2. the decision, from the real facts -------------------------------------------------------------------------
const endpoint = await makeDockerEndpointResolver()();
assert.equal(endpoint.local, true, `the docker endpoint must be local (${endpoint.reason})`);
const { decision, socket } = await makeJobUserResolver({ readFacts: makeDaemonFactsReader() })({ endpoint, key: "e2e" });
assert.equal(decision.mode, "worker", JSON.stringify(decision));
assert.equal(decision.user, `${euid}:${egid}`);
const img = await makeImagePreflight({ image })({});
assert.equal(img.ok, true, JSON.stringify(img));
const jobUser = resolveImageUser(decision, { capabilities: img.capabilities, euid, egid, socket });
assert.deepEqual(jobUser, { user: `${euid}:${egid}`, home: CONTAINER_HOME });
// doctor's own decision, from its own reads (its bound, its image preflight), must be the worker's.
const identity = { platform: process.platform, release: osRelease(), euid, egid };
const doctored = await jobUserChecks({}, { spawn, cwd: process.cwd(), home: homedir(), fileExists: existsSync, platform: process.platform, jobUserIdentity: identity }, { endpoint, dockerCode: 0, imageCode: 0, jobImage: image });
assert.deepEqual(doctored.forLive, { run: true, user: jobUser.user }, JSON.stringify(doctored));
assert.ok(doctored.checks.some((c) => c.ok && c.label.includes(`uid:gid ${jobUser.user}`)), doctored.checks.map((c) => c.label).join("\n"));
say(`decided --user=${jobUser.user} with HOME=${jobUser.home} (socket gid ${socket?.gid ?? "unread"}), and doctor decides the same`);

// --- 3. real workspaces: a forge clone with a staged (cold) session, and a local folder ----------------------------
const scratch = mkdtempSync(join(tmpdir(), "pd-e2e-"));
// A failed assertion exits without reaching the removal at the end; the scratch repos go either way.
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const git = (cwd, ...args) => execFileSync("git", ["-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", ...args], { cwd, encoding: "utf8" }).trim();
const seed = join(scratch, "seed");
mkdirSync(seed);
git(seed, "init", "-q", "-b", "main");
writeFileSync(join(seed, "README.md"), "e2e\n");
git(seed, "add", "README.md");
git(seed, "commit", "-q", "-m", "seed");
const bare = join(scratch, "origin.git");
git(scratch, "clone", "-q", "--bare", seed, bare);
git(bare, "config", "uploadpack.allowAnySHA1InWant", "true");
const sha = git(seed, "rev-parse", "HEAD");

const store = makeSessionStore({ sessionsDir: join(scratch, "sessions"), ttlDays: 14, maxBytes: 10 * 1024 * 1024, defaultBackend: "local" });
const prepareWorkspace = makePrepareWorkspace({
	jobsDir,
	defaultBackend: "local",
	jobImage: image,
	forgeFor: () => ({ host: { resolveDefaultBranchSha: async () => ({ sha }) } }),
	resolveSession: store.resolveSession,
	preparers: makeForgePreparers({ prepareForge: (job, token, opts) => prepareGithubWorkspace(job, token, { ...opts, remoteUrlFor: () => `file://${bare}` }) }),
});
const forgeJob = { kind: "github", repo: "owner/name", resume: true, target: { type: "issue", number: 7, title: "e2e", body: "e2e" }, provider: "anthropic" };
const forge = await prepareWorkspace(forgeJob, "unused-token", { queueJobId: "gh-e2e", jobUser });
assert.ok(forge.jobDir && forge.session?.hostDir, `the forge job prepared a session: ${JSON.stringify(Object.keys(forge))}`);
assert.equal(statSync(forge.jobDir).mode & 0o777, 0o700, "a job dir is a 0700 mkdtemp");
assert.deepEqual(forge.sandbox.jobUser, jobUser, "the retention stamp carries the job user");

const folder = join(scratch, "folder");
mkdirSync(folder);
git(folder, "init", "-q", "-b", "main");
writeFileSync(join(folder, "notes.md"), "local\n");
git(folder, "add", "notes.md");
git(folder, "commit", "-q", "-m", "local");
const local = await prepareWorkspace({ kind: "local", folder, task: "e2e" }, null, { queueJobId: "local-e2e", jobUser });
assert.ok(local.outboxDir, "the local job has an outbox");
say(`prepared a forge clone (session ${forge.session.resume ? "resumed" : "cold"}) and a local folder, both under a 0700 job dir`);

// --- 4. every mount, used as the job user, and /job still read-only to its owner ----------------------------------
// ONE COMMAND PER LINE, deliberately: under `set -e` a failing command that is not the last of an `&&` list does not
// exit the shell, so `cat x && touch y` on an unreadable x would print mounts-ok (measured, dash).
const MOUNT_SCRIPT = [
	"set -e",
	"cd /job",
	"ls /job >/dev/null",
	"cat /job/prompt.md >/dev/null",
	"touch /workspace/.pd-e2e",
	"git -C /workspace status --porcelain >/dev/null",
	"if [ -d /outbox ]; then touch /outbox/.pd-e2e; fi",
	"if [ -d /session ]; then cat /session/current.jsonl >/dev/null; fi",
	"if [ -d /session ]; then touch /session/.pd-e2e; fi",
	'touch "$HOME/.pd-e2e"',
	"if touch /job/x 2>/dev/null; then echo job-writable; exit 3; fi",
	"if chmod 777 /job 2>/dev/null; then echo job-chmod; exit 4; fi",
	"echo mounts-ok",
].join("\n");
const docker = (args) => spawnSync("docker", args, { encoding: "utf8" });
const mountArgs = (prepared, name, user) => [
	...buildDockerRunArgs({ image, name, workspace: prepared.workspace, jobDir: prepared.jobDir, outboxDir: prepared.outboxDir, sessionDir: prepared.session?.hostDir, network: "none", user, env: user ? { HOME: CONTAINER_HOME } : {}, extraFlags: ["--entrypoint", "sh"] }),
	"-c",
	MOUNT_SCRIPT,
];
for (const [label, prepared] of [["forge", forge], ["local", local]]) {
	const r = docker(mountArgs(prepared, `pd-e2e-mounts-${label}-${process.pid}`, jobUser.user));
	assert.equal(r.status, 0, `${label}: ${r.stdout}${r.stderr}`);
	assert.match(r.stdout, /mounts-ok/);
	assert.equal(statSync(join(prepared.workspace, ".pd-e2e")).uid, euid, `${label}: a file the job wrote is owned by the worker on the host`);
	// Checked on the HOST too, not only by the script's own exit: the outbox and the session land as the worker's.
	for (const dir of [prepared.outboxDir, prepared.session?.hostDir].filter(Boolean)) {
		assert.equal(statSync(join(dir, ".pd-e2e")).uid, euid, `${label}: ${dir} was written as the job user`);
	}
}
say("every mount was read and written as the job user, git accepted the clone, and /job refused a write and a chmod");

// --- 5. the real runner: as the job user it reaches the auth check; as the image's user it cannot read /job --------
const RUNNER_ENV = { PI_PROVIDER: "anthropic", PI_MODEL: "claude-sonnet-4-5-20250929", PI_MAX_TURNS: "1" };
const runner = (prepared, name, user) =>
	docker(buildDockerRunArgs({ image, name, workspace: prepared.workspace, jobDir: prepared.jobDir, outboxDir: prepared.outboxDir, network: "none", user, env: user ? { ...RUNNER_ENV, HOME: CONTAINER_HOME } : RUNNER_ENV }));
function runnerRows(prepared, label) {
	const ok = runner(prepared, `pd-e2e-runner-${label}-${process.pid}`, jobUser.user);
	assert.equal(ok.status, 2, `${label}: ${ok.stdout}${ok.stderr}`);
	assert.match(`${ok.stdout}${ok.stderr}`, /no configured auth/, `${label}: as the job user the runner gets past its inputs to the auth check`);
	// NEGATIVE CONTROL, and WITHOUT a /session mount: the session check runs first and would answer `config` instead.
	const control = runner(prepared, `pd-e2e-control-${label}-${process.pid}`, null);
	assert.equal(control.status, 2, `${label} control: ${control.stdout}${control.stderr}`);
	assert.match(`${control.stdout}${control.stderr}`, /job-inputs-unreadable/, `${label} control: as the image's uid 1001 the 0700 job dir is unreadable`);
	controls.ran++;
}
runnerRows(local, "local");
say("the runner reached `no configured auth` as the job user, and refused `job-inputs-unreadable` as the image's own user");

// --- 6. what the job left is the worker's, and the worker's own cleanup removes it --------------------------------
const cleanup = makeCleanup();
for (const prepared of [forge, local]) {
	await cleanup(prepared);
	assert.equal(existsSync(prepared.jobDir), false, `${prepared.jobDir} was removed by the real cleanup`);
}
say("the real cleanup removed both job dirs, including what the job wrote");

// --- 7. the same under umask 077, the tightest a service account is given ----------------------------------------
process.umask(0o077);
const tight = await prepareWorkspace({ kind: "local", folder, task: "e2e" }, null, { queueJobId: "local-e2e-077", jobUser });
runnerRows(tight, "umask077");
const tightMounts = docker(mountArgs(tight, `pd-e2e-mounts-077-${process.pid}`, jobUser.user));
assert.equal(tightMounts.status, 0, `umask 077: ${tightMounts.stdout}${tightMounts.stderr}`);
await cleanup(tight);
assert.equal(existsSync(tight.jobDir), false);
say("umask 077 changes nothing for the job user");

// --- 8. doctor --live, run as this user, reads the same answer back -------------------------------------------------
const facts = { endpoint, dockerCode: 0, imageCode: 0, jobImage: image, triggerImages: [], egress: { armed: false, results: [] }, jobUser: doctored.forLive };
const liveFs = { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync };
const checks = await liveChecks({ PI_JOBS_DIR: jobsDir, PI_EGRESS: "0" }, { spawn, liveFs, jobUserIdentity: { euid } }, facts);
const failed = checks.filter((c) => !c.ok && !c.warn);
assert.deepEqual(failed.map((c) => c.label), [], "doctor --live reads nothing back as failing");
assert.ok(checks.some((c) => c.ok && new RegExp(`the probe ran as uid ${euid}, the job user this host decides`).test(c.label)), checks.map((c) => c.label).join("\n"));
assert.ok(checks.some((c) => c.ok && /localFolders holds/.test(c.label)));
// The read-back in a job's modes must also FAIL where a job would: the same probe as the image's own user.
const asImage = await liveChecks({ PI_JOBS_DIR: jobsDir, PI_EGRESS: "0" }, { spawn, liveFs, jobUserIdentity: { euid } }, { ...facts, jobUser: { run: true, user: null } });
// Exactly the job-dir failure: an older fixture in friendlier modes would fail on the workspace write instead.
assert.ok(asImage.some((c) => !c.ok && !c.warn && /localFolders does NOT hold .*cannot list a 0700 job directory/.test(c.label)), `the image's own user must fail on the 0700 job dir here:\n${asImage.map((c) => c.label).join("\n")}`);
controls.ran++;
say("doctor --live read the job user and every mount back, and failed them as the image's own user");

rmSync(scratch, { recursive: true, force: true });
assert.equal(controls.ran, controls.expected, `every negative control must run: ${controls.ran} of ${controls.expected}`);
say(`all ${controls.expected} negative controls ran and failed as they must`);
