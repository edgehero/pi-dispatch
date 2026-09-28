import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as realFs from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { describe, test } from "node:test";
import { ISOLATION_FLAGS, PODMAN_PINNED_FLAGS, buildDockerRunArgs, buildPodmanRunArgs } from "../src/docker-run.mjs";
import { WORKER_ONLY_SECRET_VARS } from "../src/config.mjs";
import { MINTED_TOKEN_VARS } from "../src/forges.mjs";
import { SANDBOX_LAUNCHERS, SANDBOX_LAUNCH_WATCH_MS, SANDBOX_LAUNCH_WATCH_TRIES, SANDBOX_NAME_PREFIX, SANDBOX_NETWORK_SHAPE, SANDBOX_OPEN_GRACE_MS, buildSandboxRunArgs, combineSandboxNetworkSweepers, decideSandboxJobUser, launchSandbox, listRunningSandboxes, makeSandboxNetworkSweeper, makeSandboxRuntimeWatch, openSandbox, sandboxKeeperCheck, boundedRuntime, parsePublish, resolveSandbox, sandboxContainerName, sandboxEgress, stopSandbox, sandboxLauncher, sandboxVenuePolicy, sandboxVenueRefusal, sandboxVenues } from "../src/sandbox.mjs";
import { networkNameFor } from "../src/egress.mjs";
import { makeSandboxReaper, pinSandbox } from "../src/sandbox-store.mjs";

const base = {
	image: "pi-job:pinned",
	name: "pi-sandbox-abc",
	workspace: "/srv/sandboxes/abc/workspace",
	jobDir: "/srv/sandboxes/abc",
};

test("an operator session carries every isolation flag -- the boundary is the same one", () => {
	const args = buildSandboxRunArgs(base);
	const s = args.join(" ");
	// Imported, never retyped: a flag added to the boundary must reach BOTH container shapes, and a test
	// with its own copy of the list would keep passing while the sandbox quietly lost one.
	for (const flag of ISOLATION_FLAGS) {
		assert.ok(args.includes(flag), `missing isolation flag: ${flag}`);
	}
	assert.ok(args.includes("--memory=4g") && args.includes("--cpus=2"), "resource limits apply to a sandbox too");
	assert.ok(!s.includes("--ipc=host"), "--ipc=host shares the host IPC namespace");
	assert.ok(!s.includes("--privileged"), "--privileged");
	assert.ok(!s.includes("--pull=missing") && !s.includes("--pull=always"), "no argv may re-enable the fetch");
});

test("it is an interactive shell: -i -t, bash as the entrypoint, image still last", () => {
	const args = buildSandboxRunArgs(base);
	assert.ok(args.includes("-i") && args.includes("-t"), "an operator session needs a TTY");
	const entry = args.indexOf("--entrypoint");
	assert.ok(entry >= 0 && args[entry + 1] === "bash", "the runner entrypoint is replaced by a shell");
	assert.equal(args.at(-1), base.image, "the image is the final argv element");
	assert.ok(entry < args.length - 1, "--entrypoint must precede the image");
});

test("NO credential of any kind reaches a resurrected sandbox", () => {
	const args = buildSandboxRunArgs({ ...base, term: "xterm-256color", idleSeconds: 1800 });
	const s = args.join(" ");
	// Every forge's minted variable names, from the table itself -- so a forge added later cannot leak in
	// through a hand-maintained list that nobody updated.
	for (const name of [...MINTED_TOKEN_VARS, ...WORKER_ONLY_SECRET_VARS]) {
		assert.ok(!s.includes(name), `a sandbox must not carry ${name}`);
	}
	for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "PI_PROVIDER", "PI_MODEL"]) {
		assert.ok(!s.includes(name), `a sandbox must not carry ${name}`);
	}
	// The whole env, positively: exactly the two terminal variables and nothing else.
	const envValues = args.filter((a, i) => args[i - 1] === "-e");
	assert.deepEqual(envValues.sort(), ["TERM=xterm-256color", "TMOUT=1800"]);
});

test("the mounts are the run's own, and only those", () => {
	const args = buildSandboxRunArgs(base);
	assert.ok(args.includes("/srv/sandboxes/abc:/job:ro"), "/job stays read-only, exactly as the run had it");
	assert.ok(args.includes("/srv/sandboxes/abc/workspace:/workspace"), "/workspace is writable");
	assert.ok(!args.some((a) => a.includes(":/outbox")), "no chain channel: no agent is running");
	assert.ok(!args.some((a) => a.includes(":/session")), "no transcript: it is not carried into a sandbox");
	assert.ok(!args.some((a) => a.includes("/opt/pi-global")), "no operator overlay: pi is not running");
});

test("an unset TERM and a disabled idle timeout emit nothing rather than empty strings", () => {
	const args = buildSandboxRunArgs({ ...base, term: undefined, idleSeconds: 0 });
	assert.ok(!args.includes("-e"), "no env pair at all when both are absent");
	assert.ok(!args.join(" ").includes("TMOUT"), "idleSeconds 0 disables the idle logout");
});

test("the name namespace sits OUTSIDE the boot reaper's pi-job- filter", () => {
	const name = sandboxContainerName("gh-12345");
	assert.equal(name, "pi-sandbox-gh-12345");
	// docker's `name=` filter is a SUBSTRING match, so this is the whole guarantee that a worker restart
	// does not `docker rm -f` the shell an operator is sitting in.
	assert.ok(!name.includes("pi-job-"), "a sandbox name must never contain the reaped prefix");
	assert.ok(name.startsWith(SANDBOX_NAME_PREFIX));
	// A scheduled id carries a colon, which is not legal in a docker name.
	assert.equal(sandboxContainerName("repeat:sched:100"), "pi-sandbox-repeat_sched_100");
});

test("openSandbox REFUSES a published port while the policy is armed, and creates nothing (#362)", async () => {
	// The refusal sits after `resolveSandbox` (a run that cannot be opened says why first), before the first
	// docker ask (a determinate refusal must not cost a round trip), and before `beforeLaunch` (where the CLI
	// prints `published: ...`, so one line later it would print a false line and then refuse).
	const calls = [];
	const r = await openSandbox({
		jobId: "gh-1",
		sandboxDir: "/sbx",
		retentionHours: 24,
		publish: ["-p", "127.0.0.1:3000:3000"],
		egress: { armed: true, proxy: "pi-dispatch-egress-proxy" },
		running: async () => (calls.push("running"), []),
		launch: async () => (calls.push("launch"), { code: 0 }),
		spawnNetwork: () => (calls.push("network"), null),
		beforeLaunch: () => calls.push("beforeLaunch"),
		resolveJobUser: async () => (calls.push("jobUser"), { user: null, home: null }),
		...openable(),
	});

	assert.equal(r.refused, "publish-needs-egress-off");
	assert.match(r.message, /PI_EGRESS=0/);
	assert.deepEqual(calls, [], "no docker ask, no job-user ask, and above all no beforeLaunch");
});

test("a run that cannot be opened at all says ITS reason, not the publish one (#362)", async () => {
	// CAUSE BEFORE SYMPTOM, and it was asserted in three places with nothing holding it: hoisting the refusal
	// above `resolveSandbox` leaves the suite green while every swept, wrong-venue or no-image run is told
	// about a flag instead of why it cannot be opened at all.
	const cases = [
		["swept or never retained", { fs: { readFileSync: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } }, fileExists: () => true }, "absent"],
		["no image in the manifest", openable({ image: null }), "no-image"],
		["another venue wrote it", openable({ backend: "far" }), "venue-unreachable"],
	];
	for (const [name, seam, expected] of cases) {
		const r = await openSandbox({
			jobId: "gh-1",
			sandboxDir: "/sbx",
			retentionHours: 24,
			publish: ["-p", "127.0.0.1:3000:3000"],
			egress: { armed: true, proxy: "p" },
			running: async () => [],
			launch: async () => ({ code: 0 }),
			resolveJobUser: async () => ({ user: null, home: null }),
			...seam,
		});
		assert.equal(r.refused, expected, `${name}: its own reason must win over the flag`);
	}
});

test("openSandbox allows a published port with the policy off (#362)", async () => {
	let args = null;
	const r = await openSandbox({
		jobId: "gh-1",
		sandboxDir: "/sbx",
		retentionHours: 24,
		publish: ["-p", "127.0.0.1:3000:3000"],
		egress: { armed: false, proxy: "pi-dispatch-egress-proxy" },
		running: async () => [],
		launch: async (a) => ((args = a.args), { code: 0 }),
		resolveJobUser: async () => ({ user: null, home: null }),
		...openable(),
	});
	assert.equal(r.refused, undefined);
	assert.ok(args.includes("127.0.0.1:3000:3000"));
});

test("buildSandboxRunArgs THROWS on the one argv that would lie (#362)", () => {
	// A refusal is for an operator's mistake; this is for a caller assembling an argv from parts that cannot
	// mean what it says. Same place and shape as the user/home pairing beside it.
	assert.throws(
		() => buildSandboxRunArgs({ image: "img", name: "pi-sandbox-a", workspace: "/w", jobDir: "/j", publish: ["-p", "127.0.0.1:3000:3000"], network: "pi-sandbox-a-net" }),
		/cannot be paired with a session network/,
	);
	// and the two halves apart are still fine
	assert.ok(buildSandboxRunArgs({ image: "img", name: "pi-sandbox-a", workspace: "/w", jobDir: "/j", publish: ["-p", "127.0.0.1:3000:3000"] }).includes("127.0.0.1:3000:3000"));
	assert.ok(buildSandboxRunArgs({ image: "img", name: "pi-sandbox-a", workspace: "/w", jobDir: "/j", network: "pi-sandbox-a-net" }).includes("--network=pi-sandbox-a-net"));
});

test("--publish is always bound to loopback, and an explicit bind address is refused", () => {
	assert.deepEqual(parsePublish(["3000"]), ["-p", "127.0.0.1:3000:3000"]);
	assert.deepEqual(parsePublish(["8080:3000"]), ["-p", "127.0.0.1:8080:3000"]);
	assert.deepEqual(parsePublish(["3000", "9229"]), ["-p", "127.0.0.1:3000:3000", "-p", "127.0.0.1:9229:9229"]);
	for (const bad of ["0.0.0.0:3000:3000", "3000:3000:3000", "0", "70000", "3000/tcp", "", "abc", "-1"]) {
		assert.throws(() => parsePublish([bad]), /invalid --publish/, `must refuse ${JSON.stringify(bad)}`);
	}
	// Refusing is a config error, so the CLI's entry maps it to the policy exit code rather than retrying.
	assert.throws(() => parsePublish(["0.0.0.0:3000:3000"]), (e) => e.piDispatchConfig === true);
});

test("a published port lands in the argv ahead of the image", () => {
	const args = buildSandboxRunArgs({ ...base, publish: parsePublish(["3000"]) });
	assert.ok(args.includes("127.0.0.1:3000:3000"));
	assert.equal(args.at(-1), base.image);
});

test("resolveSandbox names the cause: retention off, swept, imageless, workspace gone", () => {
	const manifest = { jobId: "j1", kind: "github", image: "pi-job:latest", workspace: "/w", createdAt: "2026-08-01T00:00:00Z" };
	const fsWith = (m) => ({ readFileSync: () => JSON.stringify(m) });
	const missing = { readFileSync: () => { throw new Error("ENOENT"); } };

	// Issue #446: an hour into the fixture's window, so the past-window refusal is never what these read.
	const now = () => Date.parse("2026-08-01T01:00:00Z");
	assert.match(resolveSandbox({ jobId: "j1", sandboxDir: "/s", retentionHours: 0, fs: missing, now }).message, /PI_SANDBOX_RETENTION_HOURS/);
	assert.match(resolveSandbox({ jobId: "j1", sandboxDir: "/s", retentionHours: 24, fs: missing, now }).message, /swept at the end of its retention window/);
	assert.equal(resolveSandbox({ jobId: "", sandboxDir: "/s", retentionHours: 24, fs: missing, now }).refused, "no-job-id");
	assert.equal(resolveSandbox({ jobId: "j1", sandboxDir: "/s", retentionHours: 24, fs: fsWith({ ...manifest, image: null }), now }).refused, "no-image");

	const gone = resolveSandbox({ jobId: "j1", sandboxDir: "/s", retentionHours: 24, fs: fsWith(manifest), fileExists: () => false, now });
	assert.equal(gone.refused, "workspace-gone");
	assert.match(gone.message, /\/w/, "the missing path IS the diagnosis, so it must appear");
});

test("resolveSandbox refuses a run from a venue this host did not run, ahead of the image and the workspace (#277)", () => {
	const manifest = { jobId: "j1", kind: "github", image: "pi-job:latest", workspace: "/w", createdAt: "2026-08-01T00:00:00Z" };
	const fsWith = (m) => ({ readFileSync: () => JSON.stringify(m) });
	const resolve = (m, fileExists = () => true) => resolveSandbox({ jobId: "j1", sandboxDir: "/s", retentionHours: 24, fs: fsWith(m), fileExists, now: () => Date.parse("2026-08-01T01:00:00Z") });

	// Another venue: refused by name, and BEFORE the symptoms -- an imageless manifest whose workspace is gone
	// still reports the venue, because that is the cause an operator can act on.
	const far = resolve({ ...manifest, backend: "far", image: null }, () => false);
	assert.equal(far.refused, "venue-unreachable");
	assert.match(far.message, /"far"/);
	// Both sides by name (issue #354): the venue that ran it, and the venues a sandbox opens through, which since issue
	// #429 are every row of the launcher table, each with its CLI.
	assert.match(far.message, /ran on the "far" backend, and a sandbox opens a shell only through a venue it has a launcher for on this host \("local" through the docker CLI, "podman" through the podman CLI\)/);
	assert.doesNotMatch(far.message, /not on this host/);
	// A workspace that happens to exist at the same path here must not let it through either.
	assert.equal(resolve({ ...manifest, backend: "far" }).refused, "venue-unreachable");
	// A name this build does not know is not a venue this host holds.
	assert.equal(resolve({ ...manifest, backend: "not-a-backend" }).refused, "venue-unreachable");
	// A stamp that is PRESENT but names nothing is refused, not read as local -- the table's backendFor(null)
	// would say `local`, and a venue that was never known is not a local one.
	for (const backend of [null, "", 7]) {
		const r = resolve({ ...manifest, backend });
		assert.equal(r.refused, "venue-unreachable", JSON.stringify(backend));
		assert.match(r.message, /names no backend/);
	}
	// The native podman venue (issue #429) opens WHEN THIS PROCESS BLESSES IT, and is refused otherwise in words that
	// name the variable and where it is read: the default is `PI_BACKENDS` unset, which is `local` alone.
	const podman = resolve({ ...manifest, backend: "podman" });
	assert.equal(podman.refused, "venue-unreachable");
	assert.match(podman.message, /ran on the "podman" backend, which PI_BACKENDS in this process's environment does not bless \(it reads "local"\)/);
	assert.match(podman.message, /through that venue's own CLI \(podman\)/);
	assert.match(podman.message, /read from this environment, not from the deployment's \.env/);
	assert.doesNotMatch(podman.message, /Open it on the venue that ran it/);
	assert.match(far.message, /Open it on the venue that ran it/, "another venue keeps its own sentence");
	assert.equal(sandboxVenueRefusal({ jobId: "j1", manifest: { ...manifest, backend: "podman" }, blessed: ["podman"] }), null);
	assert.equal(sandboxVenueRefusal({ jobId: "j1", manifest: { ...manifest, backend: "podman" }, blessed: ["local", "podman"] }), null);
	// And `local` is held by the same rule: a host whose PI_BACKENDS leaves it out has said it does not run docker, and
	// its retention reaper does not ask docker which sandboxes are open.
	const localUnblessed = sandboxVenueRefusal({ jobId: "j1", manifest: { ...manifest, backend: "local" }, blessed: ["podman"] });
	assert.equal(localUnblessed?.refused, "venue-unreachable");
	assert.match(localUnblessed.message, /"local" backend, which PI_BACKENDS .* does not bless \(it reads "podman"\)/);
	assert.equal(sandboxVenueRefusal({ jobId: "j1", manifest, blessed: ["podman"] })?.refused, "venue-unreachable", "an unstamped run is local's, and refused where local is not blessed");
	// A venue with no launcher is refused however it is blessed.
	assert.equal(sandboxVenueRefusal({ jobId: "j1", manifest: { ...manifest, backend: "far" }, blessed: ["far", "local", "podman"] })?.refused, "venue-unreachable");
	// Held means the local adapter by name.
	assert.equal(resolve({ ...manifest, backend: "local" }).refused, undefined);
	assert.equal(sandboxVenueRefusal({ jobId: "j1", manifest: { ...manifest, backend: "local" } }), null);
	// A manifest with no key at all predates venue attribution, and ran on local.
	assert.equal(sandboxVenueRefusal({ jobId: "j1", manifest }), null);
});

test("held means a venue with a LAUNCHER, by name, never by `remote: false` (#277, #429)", () => {
	// "has a launcher row" and "backendFor(venue).remote === false" answer identically for every venue the table holds
	// today (local and podman are the two non-remote venues), so no behavioural test can catch a swap to the second --
	// which the design rejects, because a future non-remote venue on a third runtime would then be reopened under one of
	// these two. The relation is pinned here as text rather than manufactured as behaviour.
	const src = readFileSync(new URL("../src/sandbox.mjs", import.meta.url), "utf8");
	const body = src.slice(src.indexOf("export function sandboxVenueRefusal"), src.indexOf("export function resolveSandbox"));
	assert.match(body, /const launcher = sandboxLauncher\(venue\);/);
	assert.match(body, /if \(launcher && held\) return null;/);
	assert.doesNotMatch(body, /\.remote/);
	// The table is exactly the two runtimes, each paired with the CLI and builder its job bundle is built with, so a
	// sandbox's argv and spawns are a job's on the same venue (`makePodmanBackend` passes `bin: "podman"` beside
	// `buildArgs: buildPodmanRunArgs`; `local`'s defaults are docker and `buildDockerRunArgs`).
	assert.deepEqual(Object.keys(SANDBOX_LAUNCHERS).sort(), ["local", "podman"]);
	assert.equal(SANDBOX_LAUNCHERS.local.bin, "docker");
	assert.equal(SANDBOX_LAUNCHERS.local.build, buildDockerRunArgs);
	assert.equal(SANDBOX_LAUNCHERS.podman.bin, "podman");
	assert.equal(SANDBOX_LAUNCHERS.podman.build, buildPodmanRunArgs);
	const podmanSrc = readFileSync(new URL("../src/backend-podman.mjs", import.meta.url), "utf8");
	assert.match(podmanSrc, /bin: "podman",\n\t\tbuildArgs: buildPodmanRunArgs,/, "the job bundle pairs the same two");
	assert.equal(sandboxLauncher("toString"), null);
	assert.equal(sandboxLauncher(null), null);
});

test("resolveSandbox yields the manifest and the container name when the run is intact", () => {
	const manifest = { jobId: "j1", kind: "local", image: "pi-job:latest", workspace: "/folder", createdAt: "2026-08-01T00:00:00Z" };
	const resolved = resolveSandbox({
		jobId: "j1",
		sandboxDir: "/s",
		retentionHours: 24,
		fs: { readFileSync: () => JSON.stringify(manifest) },
		fileExists: () => true,
		now: () => Date.parse("2026-08-01T01:00:00Z"),
	});
	assert.equal(resolved.refused, undefined);
	assert.equal(resolved.name, "pi-sandbox-j1");
	assert.equal(resolved.manifest.image, "pi-job:latest");
	assert.equal(resolved.manifest.dir, "/s/j1", "the retained dir is what gets mounted /job:ro");
});

test("listRunningSandboxes returns ids, and THROWS rather than reporting an empty set it cannot vouch for", async () => {
	const ids = await listRunningSandboxes({
		execFn: async () => ({ stdout: "pi-sandbox-gh-1\npi-job-gh-2\n\npi-sandbox-local-3\n" }),
	});
	assert.deepEqual(ids, ["gh-1", "local-3"], "prefix stripped, and a job container is not a sandbox");

	// The distinction the reaper depends on: it deletes directories, so "could not ask docker" must not
	// arrive looking like "nothing is running".
	await assert.rejects(() => listRunningSandboxes({ execFn: async () => { throw new Error("daemon down"); } }), /daemon down/);
});

// --- REQ-EGRESS-ALLOWLIST: a sandbox reaches no further than the run it reproduces --------------------

test("a sandbox with no egress policy is byte-identical to one built before the feature existed", () => {
	const base = { image: "pi-job:latest", name: "pi-sandbox-gh-1", workspace: "/w", jobDir: "/j" };
	assert.deepEqual(buildSandboxRunArgs(base), buildSandboxRunArgs({ ...base, network: null, egressEnv: {} }));
	assert.ok(!buildSandboxRunArgs(base).join(" ").includes("--network"));
});

test("an armed sandbox joins its OWN network and carries the proxy variables -- still no credentials", () => {
	const args = buildSandboxRunArgs({
		image: "pi-job:latest",
		name: "pi-sandbox-gh-1",
		workspace: "/w",
		jobDir: "/j",
		term: "xterm",
		network: "pi-sandbox-gh-1-net",
		egressEnv: { HTTPS_PROXY: "http://pi-dispatch-egress-proxy:3128", NODE_USE_ENV_PROXY: "1" },
	});
	assert.ok(args.includes("--network=pi-sandbox-gh-1-net"));
	// Its own network, never a job's: `pi-sandbox-` shares no substring with the reaper's `pi-job-` filter,
	// so a worker restart cannot tear the network out from under a shell an operator is sitting in.
	assert.ok(!args.join(" ").includes("pi-job-"), "a sandbox network is outside the reaper's filter");
	const envValues = args.filter((_, i) => args[i - 1] === "-e");
	assert.ok(envValues.includes("HTTPS_PROXY=http://pi-dispatch-egress-proxy:3128"));
	assert.ok(envValues.includes("NODE_USE_ENV_PROXY=1"));
	// The clause that does not move. A proxy URL is not a credential, and buildContainerEnv is still not
	// reused here, so there is no path by which a mint or a provider key could arrive.
	assert.ok(!envValues.some((v) => /TOKEN|API_KEY|_KEY=/.test(v)), "no credential reaches a sandbox");
	// And every isolation flag still reaches this shape, asserted against the imported array as ever.
	for (const flag of ISOLATION_FLAGS) assert.ok(args.includes(flag), `missing isolation flag: ${flag}`);
});

// --- one launcher for both entry points (issue #277) ----------------------------------------------------------

/** A retained local run, read through an injected fs, with its workspace present. */
function openable(over = {}) {
	const manifest = { jobId: "gh-1", kind: "github", image: "pi-job:latest", backend: "local", workspace: "/w", createdAt: "2026-09-14T08:00:00Z", keepUntil: null, ...over };
	// `now` rides along (issue #446): an hour into the run's 24h window, so the past-window refusal is decided on a fixed
	// clock and never on the wall clock drifting past this fixture's createdAt.
	return { fs: { readFileSync: () => JSON.stringify(manifest) }, fileExists: () => true, now: () => OPENABLE_NOW };
}

/** An hour after `openable()`'s createdAt. */
const OPENABLE_NOW = Date.parse("2026-09-14T09:00:00Z");

/** A docker that records every call and answers each with `codeFor(args)` (0 by default). */
function recordingDocker(calls, codeFor = () => 0) {
	return (cmd, args) => {
		calls.push(["docker", ...args].join(" "));
		const child = new EventEmitter();
		queueMicrotask(() => child.emit("close", codeFor(args)));
		return child;
	};
}

// `resolveJobUser` is seamed like every docker call here (issue #341): the image's own user unless a test says otherwise.
// `detachGate`: held open for these tests of the session's own MECHANICS (issue #452, gate round 3); the gate has its own.
const session = { jobId: "gh-1", sandboxDir: "/s", retentionHours: 24, term: "xterm", idleSeconds: 1800, running: async () => [], resolveJobUser: async () => ({ user: null, home: null }), detachGate: async () => null };

test("openSandbox puts an armed session on its own egress network, and removes it after the shell exits", async () => {
	const calls = [];
	let launchedWith = null;
	const result = await openSandbox({
		...session,
		...openable(),
		egress: { armed: true, proxy: "pi-dispatch-egress-proxy" },
		spawnNetwork: recordingDocker(calls),
		beforeLaunch: () => calls.push("beforeLaunch"),
		launch: async ({ args }) => ((launchedWith = args), calls.push("launch"), { code: 3 }),
	});
	assert.deepEqual(result, { code: 3, error: null }, "the shell's exit code is the session's");
	assert.ok(launchedWith.includes("--network=pi-sandbox-gh-1-net"), "the network the job would have had");
	assert.ok(launchedWith.some((a) => a.startsWith("HTTPS_PROXY=http://pi-dispatch-egress-proxy:")), "and the proxy variables that make it usable");
	assert.deepEqual(calls, [
		"docker network create --internal pi-sandbox-gh-1-net",
		"docker network connect pi-sandbox-gh-1-net pi-dispatch-egress-proxy",
		// The hook AFTER the network (issue #462): it is where the CLI prints "opening ...", so it follows the last refusal.
		"beforeLaunch",
		"launch",
		"docker network disconnect -f pi-sandbox-gh-1-net pi-dispatch-egress-proxy",
		"docker network rm pi-sandbox-gh-1-net",
	], "built, then the hook, then the launch, torn down after it -- and nothing is removed before the build");
});

test("openSandbox with egress off builds exactly the argv it always did, and touches no network", async () => {
	const calls = [];
	let launchedWith = null;
	await openSandbox({ ...session, ...openable(), egress: { armed: false, proxy: "p" }, spawnNetwork: recordingDocker(calls), launch: async ({ args }) => ((launchedWith = args), { code: 0 }) });
	assert.deepEqual(launchedWith, buildSandboxRunArgs({ image: "pi-job:latest", name: "pi-sandbox-gh-1", workspace: "/w", jobDir: "/s/gh-1", publish: [], term: "xterm", idleSeconds: 1800 }));
	assert.deepEqual(calls, []);
});

test("openSandbox refuses a session already running, before any network or shell", async () => {
	const calls = [];
	let launched = false;
	const result = await openSandbox({ ...session, ...openable(), running: async () => ["gh-1"], egress: { armed: true, proxy: "p" }, spawnNetwork: recordingDocker(calls), launch: async () => ((launched = true), { code: 0 }) });
	assert.equal(result.refused, "already-running");
	assert.match(result.message, /docker attach pi-sandbox-gh-1/);
	assert.equal(launched, false);
	assert.deepEqual(calls, []);
	// A docker that cannot be asked costs the check, never the session.
	const unknown = await openSandbox({ ...session, ...openable(), running: () => { throw new Error("daemon down"); }, egress: { armed: false }, launch: async () => ({ code: 0 }) });
	assert.equal(unknown.code, 0);
});

test("openSandbox launches nothing when the egress network cannot be built", async () => {
	let launched = false;
	const result = await openSandbox({
		...session,
		...openable(),
		egress: { armed: true, proxy: "p" },
		// The proxy is missing: connect fails, createJobNetwork rolls its own network back, so inspect finds none.
		spawnNetwork: recordingDocker([], (args) => (args[1] === "connect" || args[1] === "inspect" ? 1 : 0)),
		launch: async () => ((launched = true), { code: 0 }),
	});
	assert.equal(result.refused, "egress-network-failed");
	assert.equal(launched, false, "never the default bridge instead");
});

test("openSandbox removes the network even when the launch throws, and refusals come before everything", async () => {
	const calls = [];
	await assert.rejects(
		() => openSandbox({ ...session, ...openable(), egress: { armed: true, proxy: "p" }, spawnNetwork: recordingDocker(calls), launch: async () => { throw new Error("boom"); } }),
		/boom/,
	);
	assert.equal(calls.at(-1), "docker network rm pi-sandbox-gh-1-net");

	const hooks = [];
	const far = await openSandbox({ ...session, ...openable({ backend: "far" }), egress: { armed: true, proxy: "p" }, spawnNetwork: recordingDocker(hooks), beforeLaunch: () => hooks.push("before"), launch: async () => ((hooks.push("launch")), { code: 0 }) });
	assert.equal(far.refused, "venue-unreachable");
	assert.deepEqual(hooks, [], "a refused run prints nothing, builds nothing and launches nothing");
});

test("sandboxEgress reads the posture exactly as the worker does, and refuses a malformed switch", () => {
	assert.deepEqual(sandboxEgress({}), { armed: true, proxy: "pi-dispatch-egress-proxy" });
	assert.deepEqual(sandboxEgress({ PI_EGRESS: "0", PI_EGRESS_PROXY: "my-proxy" }), { armed: false, proxy: "my-proxy" });
	assert.equal(sandboxEgress({ PI_EGRESS_PROXY: "" }).proxy, "pi-dispatch-egress-proxy", "empty falls back, like the worker");
	assert.throws(() => sandboxEgress({ PI_EGRESS: "no" }), /PI_EGRESS must be exactly/);
});

test("openSandbox leaves the network of a DETACHED sandbox, and tears it down when docker cannot say or the run failed", async () => {
	// Detach (Ctrl-P Ctrl-Q) returns while the container keeps running; tearing the network down would strip the
	// proxy from a live sandbox.
	const calls = [];
	let asked = 0;
	const detached = await openSandbox({
		...session,
		...openable(),
		running: async () => (asked++ === 0 ? [] : ["gh-1"]),
		egress: { armed: true, proxy: "p" },
		spawnNetwork: recordingDocker(calls),
		launch: async () => ({ code: 0 }),
	});
	assert.equal(detached.detached, true);
	assert.equal(calls.at(-1), "docker network connect pi-sandbox-gh-1-net p", "nothing after the launch: the live sandbox keeps its network");

	// A docker that cannot be asked AFTER the launch is not a detach: the network is torn down, as it always was.
	const unknown = [];
	let asks = 0;
	const gone = await openSandbox({
		...session,
		...openable(),
		running: async () => {
			if (asks++ === 0) return [];
			throw new Error("daemon went away");
		},
		egress: { armed: true, proxy: "p" },
		spawnNetwork: recordingDocker(unknown),
		launch: async () => ({ code: 0 }),
	});
	assert.equal(gone.detached, undefined);
	assert.equal(unknown.at(-1), "docker network rm pi-sandbox-gh-1-net");

	// A docker run that failed (125: another open of this run, with a different egress setting, took the name)
	// is not this session detaching, even though docker now lists a sandbox by that name.
	const conflict = [];
	let asked2 = 0;
	const failed = await openSandbox({
		...session,
		...openable(),
		running: async () => (asked2++ === 0 ? [] : ["gh-1"]),
		egress: { armed: true, proxy: "p" },
		spawnNetwork: recordingDocker(conflict),
		launch: async () => ({ code: 125 }),
	});
	assert.equal(failed.detached, undefined);
	assert.equal(conflict.at(-1), "docker network rm pi-sandbox-gh-1-net", "its own network is removed");
});

test("openSandbox REFUSES a network already under the session's name and names it, never removing it", async () => {
	// A leftover from a dead session, a detached sandbox that has exited, or an open of the same run in progress:
	// removing it automatically stripped the proxy from a racing open's live shell, so it is named instead.
	const calls = [];
	let launched = false;
	const hooked = [];
	const exists = await openSandbox({
		...session,
		...openable(),
		egress: { armed: true, proxy: "my-proxy" },
		spawnNetwork: recordingDocker(calls, (args) => (args[1] === "create" ? 1 : 0)),
		beforeLaunch: () => hooked.push("beforeLaunch"),
		launch: async () => ((launched = true), { code: 0 }),
	});
	assert.equal(exists.refused, "egress-network-exists");
	assert.deepEqual(hooked, [], "a refusal at the network never reaches the hook that prints the opening banner (#462)");
	// Disconnects whatever is attached, not the configured proxy: a leftover can carry a different one.
	assert.match(exists.message, /docker network inspect -f '\{\{range \.Containers\}\}\{\{\.Name\}\} \{\{end\}\}' pi-sandbox-gh-1-net\); do docker network disconnect -f pi-sandbox-gh-1-net "\$c"; done; docker network rm pi-sandbox-gh-1-net/);
	assert.equal(launched, false);
	assert.ok(!calls.some((c) => c.includes(" rm ") || c.includes("disconnect")), "nothing was removed or disconnected");

	// No such network: the failure is about the proxy, and says where the setting is read.
	const missing = await openSandbox({
		...session,
		...openable(),
		egress: { armed: true, proxy: "p" },
		spawnNetwork: recordingDocker([], (args) => (args[1] === "create" || args[1] === "inspect" ? 1 : 0)),
		beforeLaunch: () => hooked.push("beforeLaunch"),
		launch: async () => ({ code: 0 }),
	});
	assert.equal(missing.refused, "egress-network-failed");
	assert.match(missing.message, /is the proxy running\?.*read from this process's environment/);
	assert.deepEqual(hooked, [], "nor does a network that could not be created");
});

test("a hook that throws still has the session's network removed, and launches nothing (#462)", async () => {
	// The hook runs after the network exists now, so the `finally` that removes it has to cover the hook too.
	const calls = [];
	let launched = false;
	await assert.rejects(
		() =>
			openSandbox({
				...session,
				...openable(),
				egress: { armed: true, proxy: "p" },
				spawnNetwork: recordingDocker(calls),
				beforeLaunch: () => {
					throw new Error("hook");
				},
				launch: async () => ((launched = true), { code: 0 }),
			}),
		/hook/,
	);
	assert.equal(launched, false);
	assert.deepEqual(calls.slice(-2), ["docker network disconnect -f pi-sandbox-gh-1-net p", "docker network rm pi-sandbox-gh-1-net"]);
});

test("openSandbox refuses a running sandbox by its SANITIZED id, which is what docker reports", async () => {
	// A cron job's id carries colons; the container name, and so docker's answer, carries underscores.
	const r = await openSandbox({
		...session,
		jobId: "repeat:nightly:1726300000000",
		...openable({ jobId: "repeat:nightly:1726300000000" }),
		running: async () => ["repeat_nightly_1726300000000"],
		egress: { armed: false },
		launch: async () => ({ code: 0 }),
	});
	assert.equal(r.refused, "already-running");
});

test("openSandbox requires the egress posture, rather than defaulting a forgetful caller to the open bridge", async () => {
	for (const egress of [undefined, {}, { armed: "true" }, { armed: 1 }]) {
		await assert.rejects(() => openSandbox({ ...session, ...openable(), egress, launch: async () => ({ code: 0 }) }), /egress\.armed must be a boolean/, JSON.stringify(egress));
	}
});

// --- issue #341: which uid a re-opened sandbox runs as -----------------------------------------------------------

test("a sandbox runs as the user its resolver decides, with HOME beside it, and refuses before building a network", async () => {
	let launchedWith = null;
	const calls = [];
	await openSandbox({ ...session, ...openable(), egress: { armed: false, proxy: "p" }, spawnNetwork: recordingDocker(calls), resolveJobUser: async () => ({ user: "1234:1234", home: "/home/pi" }), launch: async ({ args }) => ((launchedWith = args), { code: 0 }) });
	assert.ok(launchedWith.includes("--user=1234:1234") && launchedWith.includes("HOME=/home/pi"));
	const refusedCalls = [];
	let launched = false;
	const refused = await openSandbox({ ...session, ...openable(), egress: { armed: true, proxy: "p" }, spawnNetwork: recordingDocker(refusedCalls), resolveJobUser: async () => ({ refused: "job-user-unmappable", message: "no uid works" }), launch: async () => ((launched = true), { code: 0 }) });
	assert.deepEqual(refused, { refused: "job-user-unmappable", message: "no uid works" });
	assert.equal(launched, false);
	assert.deepEqual(refusedCalls, [], "no network is built for a sandbox that cannot run");
});

test("buildSandboxRunArgs refuses a user without HOME=/home/pi", () => {
	assert.throws(() => buildSandboxRunArgs({ image: "i", name: "pi-sandbox-1", workspace: "/w", jobDir: "/j", user: "1234:1234" }), /must be paired with HOME/);
	const plain = buildSandboxRunArgs({ image: "i", name: "pi-sandbox-1", workspace: "/w", jobDir: "/j" });
	assert.ok(!plain.some((a) => a.startsWith("--user") || a.startsWith("HOME=")));
});

describe("decideSandboxJobUser", () => {
	const LOCAL = { local: true, context: "default", endpoint: "unix:///var/run/docker.sock", reason: null, transient: false };
	const rootful = async () => ({ answered: true, facts: { shape: "docker", podman: false, os: "Ubuntu", rootless: false, userns: false, bounds: { pids: true, memory: true }, serviceIsRemote: null, remoteSocketPath: null } });
	const base = { platform: "linux", release: "6.8.0", resolveEndpoint: async () => LOCAL, readFacts: rootful, stat: () => ({ uid: 0, gid: 2375 }), imageCapabilities: async () => ({ ok: true, capabilities: ["anyUid"] }) };

	test("macOS and Windows keep the image's user without asking docker", async () => {
		let asked = false;
		assert.deepEqual(await decideSandboxJobUser({ ...base, platform: "darwin", resolveEndpoint: async () => ((asked = true), LOCAL), manifest: {} }), { user: null, home: null });
		assert.equal(asked, false);
	});

	test("the run's stamp supplies the uid: sudo (euid 0) reopens a worker-mode run as that run's user", async () => {
		const manifest = { image: "pi-job:x", jobUser: { user: "1234:1234", home: "/home/pi" } };
		assert.deepEqual(await decideSandboxJobUser({ ...base, euid: 0, egid: 0, manifest }), { user: "1234:1234", home: "/home/pi" });
		assert.deepEqual(await decideSandboxJobUser({ ...base, euid: 0, egid: 0, manifest: { image: "pi-job:x", jobUser: { user: null, home: null } } }), { user: null, home: null }, "a uid-1001 run reopens as the image's user");
	});

	test("a malformed stamp refuses, never reads as absent", async () => {
		for (const jobUser of ["1234:1234", { user: "0:0", home: "/home/pi" }, { user: "1234:1234", home: "/" }, { user: null, home: "/home/pi" }, {}]) {
			const r = await decideSandboxJobUser({ ...base, euid: 1234, egid: 1234, manifest: { image: "pi-job:x", jobUser } });
			assert.equal(r.refused, "job-user-stamp-invalid", JSON.stringify(jobUser));
		}
	});

	test("no stamp decides from this CLI's ids, and the retained image must declare anyUid for another uid", async () => {
		assert.deepEqual(await decideSandboxJobUser({ ...base, euid: 1234, egid: 1234, manifest: { image: "pi-job:x" } }), { user: "1234:1234", home: "/home/pi" });
		const noLabel = await decideSandboxJobUser({ ...base, euid: 1234, egid: 1234, imageCapabilities: async () => ({ ok: true, capabilities: [] }), manifest: { image: "pi-job:old" } });
		assert.equal(noLabel.refused, "job-image-any-uid-unsupported");
		assert.match(noLabel.message, /pi-job:old/);
	});

	test("a stamped worker-mode user is refused when the retained image no longer declares anyUid", async () => {
		const r = await decideSandboxJobUser({ ...base, euid: 1234, egid: 1234, imageCapabilities: async () => ({ ok: true, capabilities: [] }), manifest: { image: "pi-job:x", jobUser: { user: "1234:1234", home: "/home/pi" } } });
		assert.equal(r.refused, "job-image-any-uid-unsupported");
	});

	test("the daemon rows are this CLI's own: rootless refuses even with a valid stamp, and an unanswered daemon refuses", async () => {
		const rootless = async () => ({ answered: true, facts: { shape: "docker", podman: false, os: "Ubuntu", rootless: true, userns: false, bounds: { pids: false, memory: false }, serviceIsRemote: null, remoteSocketPath: null } });
		const stamped = { image: "pi-job:x", jobUser: { user: "1234:1234", home: "/home/pi" } };
		assert.equal((await decideSandboxJobUser({ ...base, readFacts: rootless, euid: 1234, egid: 1234, manifest: stamped })).refused, "job-user-unmappable");
		assert.equal((await decideSandboxJobUser({ ...base, readFacts: async () => ({ answered: false, reason: "timeout", transient: true }), euid: 1234, egid: 1234, manifest: stamped })).refused, "job-user-unknown");
	});

	test("the group rows run through this CLI's socket: a stamped docker-group gid refuses, and the socket read is the endpoint's", async () => {
		const statted = [];
		const stat = (p) => (statted.push(p), { uid: 0, gid: 2375 });
		const r = await decideSandboxJobUser({ ...base, stat, euid: 0, egid: 0, manifest: { image: "pi-job:x", jobUser: { user: "1235:2375", home: "/home/pi" } } });
		assert.equal(r.refused, "job-user-unmappable");
		assert.match(r.message, /docker socket's group/);
		assert.deepEqual(statted, ["/var/run/docker.sock"]);
	});

	test("a retained image that cannot be inspected refuses in its own words, and a stampless run under sudo is told to use the worker's account", async () => {
		const gone = await decideSandboxJobUser({ ...base, euid: 1234, egid: 1234, imageCapabilities: async () => ({ missing: "pi-job:gone" }), manifest: { image: "pi-job:gone", jobUser: { user: "1234:1234", home: "/home/pi" } } });
		assert.equal(gone.refused, "job-user-image");
		assert.match(gone.message, /could not be inspected/);
		for (const manifest of [{ image: "pi-job:x" }, { image: "pi-job:x", jobUser: null }]) {
			const sudo = await decideSandboxJobUser({ ...base, euid: 0, egid: 0, manifest });
			assert.equal(sudo.refused, "job-user-unmappable", JSON.stringify(manifest));
			assert.match(sudo.message, /recorded no job user/, "a missing key and the null retainJobDir writes read alike");
			assert.doesNotMatch(sudo.message, /run the worker as an unprivileged account/, "the root is this shell's, not the worker's");
		}
	});
});

// --- issue #355: SELinux relabelling, by the job path's rule ----------------------------------------------------

const sandboxMounts = (args) => args.filter((_a, i) => args[i - 1] === "-v");

test("buildSandboxRunArgs: relabel puts :Z on the retained job dir and, only when owned, on the workspace (#355)", () => {
	const shape = { image: "i", name: "pi-sandbox-1", workspace: "/s/1/workspace", jobDir: "/s/1" };
	assert.deepEqual(sandboxMounts(buildSandboxRunArgs({ ...shape, relabel: true, workspaceOwned: true })), ["/s/1:/job:ro,Z", "/s/1/workspace:/workspace:Z"]);
	assert.deepEqual(sandboxMounts(buildSandboxRunArgs({ ...shape, relabel: true, workspaceOwned: false })), ["/s/1:/job:ro,Z", "/s/1/workspace:/workspace"]);
	assert.deepEqual(buildSandboxRunArgs({ ...shape, relabel: false, workspaceOwned: true }), buildSandboxRunArgs(shape), "no relabel: the argv it always was");
});

test("openSandbox relabels a retained clone but never a local run's own folder (#355)", async () => {
	const relabelled = async (manifest) => {
		let launchedWith = null;
		await openSandbox({ ...session, ...openable(manifest), egress: { armed: false, proxy: "p" }, spawnNetwork: recordingDocker([]), resolveJobUser: async () => ({ user: null, home: null, relabel: true }), launch: async ({ args }) => ((launchedWith = args), { code: 0 }) });
		return sandboxMounts(launchedWith);
	};
	assert.deepEqual(await relabelled({ kind: "github", workspace: "/s/gh-1/workspace" }), ["/s/gh-1:/job:ro,Z", "/s/gh-1/workspace:/workspace:Z"]);
	assert.deepEqual(await relabelled({ kind: "local", workspace: "/home/op/repo" }), ["/s/gh-1:/job:ro,Z", "/home/op/repo:/workspace"], "the operator's folder keeps its own label");
	assert.deepEqual(await relabelled({ kind: "github", workspace: "/s/gh-10/workspace" }), ["/s/gh-1:/job:ro,Z", "/s/gh-10/workspace:/workspace"], "a sibling whose name only starts the same is not inside");
	let plain = null;
	await openSandbox({ ...session, ...openable({ workspace: "/s/gh-1/workspace" }), egress: { armed: false, proxy: "p" }, spawnNetwork: recordingDocker([]), launch: async ({ args }) => ((plain = args), { code: 0 }) });
	assert.deepEqual(sandboxMounts(plain), ["/s/gh-1:/job:ro", "/s/gh-1/workspace:/workspace"], "no relabel from the resolver, none in the argv");
});

describe("decideSandboxJobUser relabel (#355)", () => {
	const LOCAL = { local: true, context: "podman", endpoint: "unix:///run/podman/podman.sock", reason: null, transient: false };
	const factsWith = (over) => async () => ({ answered: true, facts: { shape: "docker", podman: true, os: "fedora", rootless: false, selinux: true, userns: false, bounds: null, serviceIsRemote: null, remoteSocketPath: null, ...over } });
	const base = { platform: "linux", release: "6.19.10", resolveEndpoint: async () => LOCAL, stat: () => ({ uid: 0, gid: 2375 }), imageCapabilities: async () => ({ ok: true, capabilities: ["anyUid"] }), euid: 1234, egid: 1234 };

	test("this CLI's own local Podman with SELinux relabels, in worker mode and for a uid-1001 run", async () => {
		assert.deepEqual(await decideSandboxJobUser({ ...base, readFacts: factsWith({}), manifest: { image: "pi-job:x" } }), { user: "1234:1234", home: "/home/pi", relabel: true });
		assert.deepEqual(await decideSandboxJobUser({ ...base, readFacts: factsWith({}), manifest: { image: "pi-job:x", jobUser: { user: null, home: null } } }), { user: null, home: null, relabel: true });
	});

	test("docker with selinux, Podman without it, and a remote endpoint answer as they always did", async () => {
		assert.deepEqual(await decideSandboxJobUser({ ...base, readFacts: factsWith({ podman: false, bounds: { pids: true, memory: true } }), manifest: { image: "pi-job:x" } }), { user: "1234:1234", home: "/home/pi" });
		assert.deepEqual(await decideSandboxJobUser({ ...base, readFacts: factsWith({ selinux: false }), manifest: { image: "pi-job:x" } }), { user: "1234:1234", home: "/home/pi" });
		assert.deepEqual(await decideSandboxJobUser({ ...base, readFacts: factsWith({}), resolveEndpoint: async () => ({ ...LOCAL, local: false }), manifest: { image: "pi-job:x" } }), { user: null, home: null });
		// podman-docker resolves no endpoint, and its own shape still decides the uid: the socket it names is not the
		// endpoint this CLI observed on this host, so nothing is relabelled.
		const shim = async () => ({ answered: true, facts: { shape: "podman", podman: true, os: "linux", rootless: false, selinux: true, userns: false, bounds: null, serviceIsRemote: false, remoteSocketPath: "/run/podman/podman.sock" } });
		assert.deepEqual(await decideSandboxJobUser({ ...base, readFacts: shim, resolveEndpoint: async () => ({ local: null, context: null, endpoint: null, reason: "unparseable", transient: false }), manifest: { image: "pi-job:x" } }), { user: "1234:1234", home: "/home/pi" });
	});
});

// --- the session-network sweep (issue #337) ----------------------------------------------------------

/** A fake daemon: `nets` maps a network name to its attached endpoint NAMES; `rm` refuses while any remain. */
function fakeNetDaemon({ nets = {}, fail = {}, containers = {}, podmanVersion = "5.8.1", dockerInfo = JSON.stringify({ ServerVersion: "27.4.0", OperatingSystem: "Ubuntu", SecurityOptions: ["name=seccomp,profile=default"] }), keeperRead = { code: 125, stdout: "", stderr: "no such container" } } = {}) {
	const calls = [];
	const state = new Map(Object.entries(nets).map(([n, m]) => [n, [...m]]));
	const run = async (args) => {
		calls.push(args.join(" "));
		const key = args.slice(0, 2).join(" ");
		if (fail[key]) return { code: 1, stdout: "", stderr: fail[key] };
		// `docker ps -a`, every state, name-filtered: the listing that sees the launch window, which nothing
		// else on this daemon can. Measured on 27.4.0 (issue #337): a container created on a network but not
		// started is absent from `docker ps` AND from `network inspect`, and the `network rm` still succeeds.
		// The filter is a substring match here too, so the fixtures carry foreign names on purpose.
		// Podman's endpoint read (issue #452): `ps -a --filter network=`, every endpoint here a RUNNING member, then
		// `network exists`, 0 or 1 as Podman answers (measured on 4.9.3 and 5.8.1).
		if (key === "ps -a" && args[args.indexOf("--filter") + 1].startsWith("network=")) {
			const net = args[args.indexOf("--filter") + 1].slice("network=".length);
			return { code: 0, stdout: (state.get(net) ?? []).map((n) => `${n}\trunning`).join("\n"), stderr: "" };
		}
		if (key === "network exists") return { code: state.has(args.at(-1)) ? 0 : 1, stdout: "", stderr: "" };
		// The keeper guard's version read (issue #452 with #458): 5.x by default, where no keeper is needed.
		// The keeper guard's runtime read (issue #452 with #458): `podman info --format json` on the podman venue, `docker info
		// --format={{json .}}` on docker's. Docker Engine by default on docker's (no guard), 5.x on podman's.
		if (key === "info --format") return { code: 0, stdout: `${JSON.stringify({ host: { security: { rootless: true } }, version: { Version: podmanVersion } })}\n`, stderr: "" };
		if (key === "info --format={{json .}}") return { code: 0, stdout: `${dockerInfo}\n`, stderr: "" };
		if (args[0] === "inspect" && String(args[1]).startsWith("--format={{.State.Status}}|")) return keeperRead;
		if (key === "ps -a") {
			const want = args[args.indexOf("--filter") + 1].slice("name=".length);
			return { code: 0, stdout: Object.entries(containers).filter(([n]) => n.includes(want)).map(([n, st]) => `${n}\t${st}`).join("\n"), stderr: "" };
		}
		if (key === "network ls") return { code: 0, stdout: [...state.keys()].join("\n"), stderr: "" };
		if (key === "network inspect") {
			const net = args.at(-1);
			if (!state.has(net)) return { code: 1, stdout: "", stderr: `Error response from daemon: network ${net} not found` };
			return { code: 0, stdout: JSON.stringify(Object.fromEntries((state.get(net) ?? []).map((n, i) => [`id${i}`, { Name: n }]))), stderr: "" };
		}
		if (key === "network disconnect") {
			const [net, ep] = args.slice(-2);
			state.set(net, (state.get(net) ?? []).filter((x) => x !== ep));
			return { code: 0, stdout: "", stderr: "" };
		}
		// The inverse, because an aborted pass puts back what it detached (#363). Without it this daemon
		// accepted the reconnect and silently kept the endpoint off, which is the state the abort exists to
		// avoid: a fake that cannot represent the repair cannot test it.
		if (key === "network connect") {
			const [net, ep] = args.slice(-2);
			if (fail["network connect"]) return { code: 1, stdout: "", stderr: fail["network connect"] };
			const on = state.get(net) ?? [];
			if (!on.includes(ep)) state.set(net, [...on, ep]);
			return { code: 0, stdout: "", stderr: "" };
		}
		if (key === "network rm") {
			const net = args.at(-1);
			if (!state.has(net)) return { code: 1, stdout: "", stderr: `Error response from daemon: network ${net} not found` };
			if ((state.get(net) ?? []).length > 0) return { code: 1, stdout: "", stderr: "has active endpoints" };
			state.delete(net);
			return { code: 0, stdout: net, stderr: "" };
		}
		return { code: 0, stdout: "", stderr: "" };
	};
	return { run, calls, state };
}

test("the guard gates BOTH destructive verbs, so a launch in the window is not cut (#363)", async () => {
	// THE PROPERTY THIS CHANGE EXISTS FOR. The guard used to be asked once, before a detach loop that pushed
	// the removal one command further out per endpoint. A sandbox whose `docker create` landed in that window
	// is in `created` state: absent from `docker ps`, absent from `network inspect`, and no obstacle to
	// `network rm` -- after which `docker start` fails with "network not found" and that sandbox never runs.
	let asks = 0;
	// The fake reads this object by reference, so mutating it mid-pass is what makes the race real.
	const containers = {};
	const d = fakeNetDaemon({ nets: { "pi-sandbox-a-net": ["pi-dispatch-egress-proxy"] }, containers });
	const run = async (args) => {
		const key = args.slice(0, 2).join(" ");
		if (key !== "ps -a") return d.run(args);
		// The first guard answers CLEAR, and the container is created immediately after it: the exact window.
		// The answer is taken BEFORE the mutation, or the first guard would see what it is meant to miss.
		const answer = await d.run(args);
		if (++asks === 1) containers["pi-sandbox-a"] = "created";
		return answer;
	};
	const out = await makeSandboxNetworkSweeper({ run })({ retained: () => [] });

	assert.equal(asks, 2, "the guard is asked twice: once before the detach, once before the rm");
	assert.deepEqual(out.swept, [], "nothing is removed once the late container is seen");
	assert.ok(!d.calls.some((c) => c.startsWith("network rm")), "the rm never runs");

	// AND THE PROXY GOES BACK ON. Without this the mid-launch sandbox starts on a network whose proxy has been
	// disconnected, with the proxy variables pointing at a name that no longer resolves there: a shell with
	// silently dead egress, where the shape this replaced gave a loud `docker run` failure. Silent is worse.
	assert.deepEqual(out.notes, [{ network: "pi-sandbox-a-net", reason: "sandbox-present", restored: ["pi-dispatch-egress-proxy"] }], "the note reports a restore, not a removal");
	assert.deepEqual(d.state.get("pi-sandbox-a-net"), ["pi-dispatch-egress-proxy"], "and the network really has its proxy again");
	assert.ok(d.calls.includes("network connect pi-sandbox-a-net pi-dispatch-egress-proxy"), "by an actual reconnect");
});

test("a guard that stops answering between the two asks fails CLOSED (#363)", async () => {
	let asks = 0;
	const d = fakeNetDaemon({ nets: { "pi-sandbox-a-net": ["pi-dispatch-egress-proxy"] }, containers: {} });
	const run = async (args) => {
		if (args.slice(0, 2).join(" ") === "ps -a" && ++asks > 1) return { code: 1, stdout: "", stderr: "" };
		return d.run(args);
	};
	const out = await makeSandboxNetworkSweeper({ run })({ retained: () => [] });
	assert.deepEqual(out.swept, []);
	assert.equal(out.notes[0].reason, "containers-unreadable", "could-not-ask is not could-not-find");
	assert.ok(!d.calls.some((c) => c.startsWith("network rm")));
});

test("a network held back by a directory this pass could not remove is NAMED (#363)", async () => {
	// Correct behaviour (a directory that exists is a run that can be re-opened, so its network is wanted) and
	// it used to be invisible: the skip line names a DIRECTORY and nothing named the network it holds.
	const d = fakeNetDaemon({ nets: { "pi-sandbox-a-net": ["p"] }, containers: {} });
	const out = await makeSandboxNetworkSweeper({ run: d.run })({ retained: () => ["a"], keep: new Set(["a"]), blocked: new Set(["a"]) });
	assert.deepEqual(out.swept, []);
	assert.deepEqual(out.notes, [{ network: "pi-sandbox-a-net", reason: "directory-not-removed" }]);

	// and an ORDINARY retained run stays silent, because a line per retained run per pass is noise
	const d2 = fakeNetDaemon({ nets: { "pi-sandbox-a-net": ["p"] }, containers: {} });
	const quiet = await makeSandboxNetworkSweeper({ run: d2.run })({ retained: () => ["a"], keep: new Set(["a"]) });
	assert.deepEqual(quiet.notes, [], "a retained run says nothing");
});

test("the sweep takes only a session network whose run is neither running nor retained (#337)", async () => {
	const d = fakeNetDaemon({
		nets: {
			"pi-sandbox-gone-net": ["pi-dispatch-egress-proxy"],
			"pi-sandbox-retained-net": ["pi-dispatch-egress-proxy"],
			"pi-sandbox-live-net": ["pi-dispatch-egress-proxy"],
			"pi-job-someones-net": ["a-job"],
			"my-pi-sandbox-notes": ["someone-elses-app"],
			// The two that only an ANCHOR keeps out, and `docker network ls --filter name=pi-sandbox-`
			// really does return both, because the filter is a substring match. Drop either `^` or `$`
			// from `SANDBOX_NETWORK_SHAPE` and these are swept: an operator's own network, detached from
			// its own containers first. That is the defect issue #357 shipped in the boot reaper.
			"my-pi-sandbox-notes-net": ["someone-elses-app"],
			"pi-sandbox-x-net-backup": ["someone-elses-app"],
		},
	});
	const out = await makeSandboxNetworkSweeper({ run: d.run })({ running: new Set(["live"]), keep: new Set(["retained", "live"]), retained: () => [] });
	assert.deepEqual(out.swept, [{ network: "pi-sandbox-gone-net", detached: ["pi-dispatch-egress-proxy"] }]);
	assert.ok(d.state.has("pi-sandbox-retained-net") && d.state.has("pi-sandbox-live-net"), "a retained run and a live shell keep theirs");
	const foreign = { "pi-job-someones-net": ["a-job"], "my-pi-sandbox-notes": ["someone-elses-app"], "my-pi-sandbox-notes-net": ["someone-elses-app"], "pi-sandbox-x-net-backup": ["someone-elses-app"] };
	for (const [name, endpoints] of Object.entries(foreign)) {
		assert.deepEqual(d.state.get(name), endpoints, `${name} is not ours: it keeps its network AND its endpoints`);
		assert.ok(!d.calls.some((c) => c.endsWith(name)), `${name} is never even inspected`);
	}
	assert.ok(!d.calls.some((c) => c.startsWith("network rm -f")), "never `network rm -f`");
});

test("a session container attached blocks the DETACH, not just the removal (#337)", async () => {
	// Docker itself refuses to remove a network a live container is on (measured), so asserting the network
	// survived would pass on docker's refusal alone. The harm issue #277 withdrew a fix for is stripping the
	// proxy off a live session, so what must be asserted is that NO disconnect is issued.
	const d = fakeNetDaemon({ nets: { "pi-sandbox-open-net": ["pi-sandbox-open", "pi-dispatch-egress-proxy"] } });
	const out = await makeSandboxNetworkSweeper({ run: d.run })({ running: new Set(), keep: new Set(), retained: () => [] });
	assert.deepEqual(out.swept, []);
	assert.deepEqual(out.notes, [{ network: "pi-sandbox-open-net", reason: "sandbox-attached" }]);
	assert.ok(!d.calls.some((c) => c.startsWith("network disconnect")), "the proxy is never stripped off a session that may be open");
	assert.deepEqual(d.state.get("pi-sandbox-open-net"), ["pi-sandbox-open", "pi-dispatch-egress-proxy"], "nothing moved");
});

test("a network that will not go is a note, one already gone is silent (#337)", async () => {
	const d = fakeNetDaemon({ nets: { "pi-sandbox-a-net": [] }, fail: { "network rm": "Cannot connect to the Docker daemon", "network inspect": "Cannot connect to the Docker daemon" } });
	const out = await makeSandboxNetworkSweeper({ run: d.run })({ retained: () => [] });
	assert.deepEqual(out.notes, [{ network: "pi-sandbox-a-net", reason: "unreadable" }]);

	const gone = fakeNetDaemon({ nets: {} });
	const empty = await makeSandboxNetworkSweeper({ run: gone.run })({ retained: () => [] });
	assert.deepEqual(empty, { swept: [], notes: [] }, "no leftovers, nothing to say");

	// A look that did not answer is the sweep's own fault, so it comes back as `failed` rather than as a
	// note about a network nobody saw. The reaper logs the two under different names deliberately
	// (`OQ-007`), so a note here would put a fault into the per-network vocabulary.
	const listFailed = fakeNetDaemon({ nets: {}, fail: { "network ls": "daemon down" } });
	const failed = await makeSandboxNetworkSweeper({ run: listFailed.run })({ retained: () => [] });
	assert.deepEqual(failed, { swept: [], notes: [], failed: "network-list-failed" }, "a failed look must not read as 'there are none'");
});

test("the id in a session network name is the one the directories and `--list` use (#337)", async () => {
	// `sandboxContainerName` sanitises; the retained directories and `listRunningSandboxes` are keyed by the
	// same sanitised form, so the three compare without a second grammar. A round trip through the RAW id
	// would pin a relationship that does not exist.
	// Against the sweeper's OWN constant, never a copy of it built here: a rebuilt pattern asserts a
	// property of this file's string, and the two drift apart exactly when the shape changes.
	for (const raw of ["gh-1", "local-abc", "a.b~c", "weird-net"]) {
		const net = networkNameFor(sandboxContainerName(raw));
		const m = SANDBOX_NETWORK_SHAPE.exec(net);
		assert.equal(m?.[1], sandboxContainerName(raw).slice(SANDBOX_NAME_PREFIX.length), raw);
	}
	// And the anchor in the other direction, which is the one that LEAKS: the container half is a bare
	// prefix, so the network half must not be stricter (the lesson issue #357 paid for twice).
	assert.ok(SANDBOX_NETWORK_SHAPE.test(`${SANDBOX_NAME_PREFIX}-net`), "a degenerate id is still ours");
	assert.ok(!SANDBOX_NETWORK_SHAPE.test("my-pi-sandbox-notes"), "a name that merely contains the prefix is not");
	assert.ok(!SANDBOX_NETWORK_SHAPE.test(`${SANDBOX_NAME_PREFIX}x-net-backup`), "nor our shape with something appended");
});

test("a sandbox being LAUNCHED keeps its network, which no other guard here can see (#337)", async () => {
	// The window `docker run` opens between create and start: measured at 230ms on a local image, the whole
	// pull when the image is not local. In it the container is in `created` state, where `docker ps` does not
	// list it, `network inspect` does not list it as an endpoint, and -- the part that makes this a guard
	// rather than a nicety -- `network rm` SUCCEEDS, after which `docker start` fails with "network not
	// found" and that sandbox can never run. Docker is a backstop for a RUNNING endpoint and for nothing else.
	//
	// The foreign container is here for the reason the network fixtures carry foreign names: `--filter name=`
	// is a substring match on this call too, and slicing the prefix off `my-pi-sandbox-notes` yields the
	// garbage id `ox-notes`, which would shield some other run's network from ever being swept.
	const d = fakeNetDaemon({
		nets: { "pi-sandbox-opening-net": ["pi-dispatch-egress-proxy"], "pi-sandbox-ox-notes-net": ["pi-dispatch-egress-proxy"], "pi-sandbox-a-net": ["pi-dispatch-egress-proxy"] },
		// Three containers, and only the first is a reason to keep anything. `my-pi-sandbox-notes` is the
		// noise on the LEFT that a filter on `pi-sandbox-ox-notes` would not even return; `pi-sandbox-abcdef`
		// is the noise on the RIGHT, which it does: measured, `--filter name=pi-sandbox-a` comes back with
		// every id that merely starts with `a`, and `gh-1` beside `gh-12` is that shape in real job ids. A
		// prefix comparison instead of a whole-name one lets one run's container shield another run's network
		// for as long as it exists.
		containers: { "pi-sandbox-opening": "created", "my-pi-sandbox-notes": "created", "pi-sandbox-abcdef": "created" },
	});
	const out = await makeSandboxNetworkSweeper({ run: d.run })({ running: new Set(), keep: new Set(), retained: () => [] });
	assert.deepEqual(out.notes, [{ network: "pi-sandbox-opening-net", reason: "sandbox-present" }], "a launch in flight is not a leftover, and unlike a retained run it is SAID");
	assert.deepEqual(
		out.swept,
		[
			{ network: "pi-sandbox-ox-notes-net", detached: ["pi-dispatch-egress-proxy"] },
			{ network: "pi-sandbox-a-net", detached: ["pi-dispatch-egress-proxy"] },
		],
		"and neither a foreign container name nor another run's longer id shields a network",
	);
	assert.ok(!d.calls.some((c) => /^network (disconnect|rm)\b/.test(c) && c.includes("pi-sandbox-opening-net")), "nothing is taken off the launching one");
	assert.deepEqual(d.state.get("pi-sandbox-opening-net"), ["pi-dispatch-egress-proxy"], "the proxy stays where the launch expects it");
	// The order is the finding it came from: this look must be the LAST call before the removal, not the
	// first of the pass. Read first, it is older than the network it has to protect, because an open creates
	// its network before its container.
	const forNotes = d.calls.indexOf("ps -a --filter name=pi-sandbox-ox-notes --format {{.Names}}\t{{.State}}");
	assert.ok(forNotes > d.calls.indexOf("network inspect --format {{json .Containers}} pi-sandbox-ox-notes-net"), "after the endpoint read");
	assert.ok(forNotes < d.calls.findIndex((c) => c.startsWith("network disconnect")), "and before anything is detached");
});

test("only a FINISHED container frees a session network, and an unknown state never does (#337)", async () => {
	// An allowlist, so a state a future daemon adds is hands off by default. `--rm` means an exited sandbox is
	// normally gone already, so one still listed is abnormal and its network is a leftover either way.
	// The capitalised pair are here because this parses ANOTHER tool's rendering, which is why the sibling
	// classifier `networkAbsentInDaemonWords` is case-insensitive too. Docker renders `{{.State}}` lowercase
	// (measured, and note it is `.State` rather than `.Status`, which would render "Exited (0) 2 minutes ago"
	// and match nothing, holding every leftover back forever); a runtime that does not is not a reason to
	// leak a network.
	for (const [state, swept] of [["exited", true], ["dead", true], ["Exited", true], ["DEAD", true], ["created", false], ["running", false], ["paused", false], ["restarting", false], ["hibernating", false]]) {
		const d = fakeNetDaemon({ nets: { "pi-sandbox-a-net": [] }, containers: { "pi-sandbox-a": state } });
		const out = await makeSandboxNetworkSweeper({ run: d.run })({ retained: () => [] });
		assert.equal(out.swept.length, swept ? 1 : 0, state);
		assert.deepEqual(out.notes, swept ? [] : [{ network: "pi-sandbox-a-net", reason: "sandbox-present" }], state);
	}
});

test("a container look that did not answer leaves THAT network alone, and says so (#337)", async () => {
	// Fail closed per network: without this answer the launch window is unguarded for it, and the whole point
	// of the look is that nothing else on the daemon reports that state. One network's unreadable answer is
	// not a reason to abandon the others, which is why it is a note rather than a `failed`.
	const d = fakeNetDaemon({ nets: { "pi-sandbox-a-net": [] }, fail: { "ps -a": "Cannot connect to the Docker daemon" } });
	const out = await makeSandboxNetworkSweeper({ run: d.run })({ retained: () => [] });
	// Its own token, not the network inspect's: the two reads fail for different reasons and are fixed
	// differently, and an operator grepping the log should not have to guess which one went quiet.
	assert.deepEqual(out, { swept: [], notes: [{ network: "pi-sandbox-a-net", reason: "containers-unreadable" }] });
	assert.ok(!d.calls.some((c) => c.startsWith("network rm")), "and nothing is removed on an answer we did not get");
});

test("the retained listing is read by the SWEEPER, after its candidates, and a throw leaves it (#337)", async () => {
	// Handed over as a closure rather than as a set, so it is read after the `network ls` above. Evidence that
	// protects a network must never be older than the listing that nominated it.
	const d = fakeNetDaemon({ nets: { "pi-sandbox-a-net": [] } });
	const order = [];
	const outer = d.run;
	const run = async (args) => {
		order.push(args.slice(0, 2).join(" "));
		return outer(args);
	};
	const out = await makeSandboxNetworkSweeper({ run })({ retained: () => { order.push("retained"); return ["a"]; } });
	assert.deepEqual(order.slice(0, 2), ["network ls", "retained"]);
	assert.deepEqual(out, { swept: [], notes: [] }, "and what it returns is kept, silently");

	await assert.rejects(
		makeSandboxNetworkSweeper({ run: d.run })({ retained: () => { throw new Error("EIO"); } }),
		/EIO/,
		"half a keep set is worse than no sweep, so the throw leaves this function",
	);
});

test("a caller with no retained listing has to SAY so, rather than get the unsafe answer (#337)", async () => {
	// The sibling default in `sandbox-store.mjs` can be a no-op, because a missing sweeper means no sweep and
	// that is safe. A missing directory listing means a sweep that ignores every retained run, which is the
	// #277 harm with no log line, so the default here throws instead of answering "nothing is retained".
	const d = fakeNetDaemon({ nets: { "pi-sandbox-a-net": ["pi-dispatch-egress-proxy"] } });
	await assert.rejects(makeSandboxNetworkSweeper({ run: d.run })({ running: new Set(), keep: new Set() }), /retained/);
	assert.deepEqual(d.state.get("pi-sandbox-a-net"), ["pi-dispatch-egress-proxy"], "and nothing was touched on the way to finding out");
});

test("the sweep yields between networks, so it is never one uninterruptible block (#337)", async () => {
	// `retention-sweep.mjs` records why this matters and `retention-sweep.test.mjs` pins the sibling yield
	// the same way: this loop runs on a timer beside draining jobs, `index.mjs` runs with
	// `maxStalledCount: 0`, and a block past BullMQ's 30s lock renewal FAILS a paid job. This loop is the
	// worse of the two, because every step is an await on a docker CLI rather than one `rmSync`.
	const d = fakeNetDaemon({ nets: { "pi-sandbox-a-net": [], "pi-sandbox-b-net": [] } });
	const order = [];
	const run = async (args) => {
		const out = await d.run(args);
		if (args[0] === "network" && args[1] === "rm") order.push(args.at(-1));
		return out;
	};
	const sweeping = makeSandboxNetworkSweeper({ run })({ retained: () => [] });
	setImmediate(() => order.push("<loop got a turn>"));
	await sweeping;
	assert.deepEqual(order, ["pi-sandbox-a-net", "<loop got a turn>", "pi-sandbox-b-net"], "the event loop runs between networks, not only after all of them");
});

test("a shell that is OPEN keeps its network even with no retained directory left (#337)", async () => {
	// `running` is not redundant with `keep`. The directory pass never removes a running sandbox's directory,
	// so the two usually agree -- but an operator who deleted the retained folder by hand, or a detached
	// session whose folder went another way, is running and NOT kept. Stripping the proxy off that session is
	// exactly the #277 harm, so the liveness answer has to stand on its own.
	const d = fakeNetDaemon({ nets: { "pi-sandbox-orphaned-net": ["pi-dispatch-egress-proxy"] } });
	const out = await makeSandboxNetworkSweeper({ run: d.run })({ running: new Set(["orphaned"]), keep: new Set(), retained: () => [] });
	assert.deepEqual(out, { swept: [], notes: [] }, "nothing swept and nothing to report");
	assert.ok(!d.calls.some((c) => c.startsWith("network disconnect") || c.startsWith("network rm")), "and it is not even inspected");
	assert.deepEqual(d.state.get("pi-sandbox-orphaned-net"), ["pi-dispatch-egress-proxy"]);
});

// --- issue #429: the sandbox on the native podman venue --------------------------------------------------------------

test("the LOCAL sandbox argv is byte-identical to the one before issue #429 (pinned as literals)", () => {
	// Literals rather than a second call through the builder: a test comparing the builder to itself cannot see the
	// venue table change what `local` builds. Captured from the tree before the change, both shapes.
	const full = { image: "pi-job:pinned", name: "pi-sandbox-gh-1", workspace: "/s/gh-1/workspace", jobDir: "/s/gh-1", term: "xterm-256color", idleSeconds: 1800, user: "1234:1234", home: "/home/pi", relabel: true, workspaceOwned: true, network: "pi-sandbox-gh-1-net", egressEnv: { HTTPS_PROXY: "http://p:3128" } };
	const expected = ["run", "--name=pi-sandbox-gh-1", "--pull=never", "--rm", "--init", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--pids-limit=512", "--shm-size=1g", "--memory=4g", "--cpus=2", "--network=pi-sandbox-gh-1-net", "--user=1234:1234", "-i", "-t", "--entrypoint", "bash", "-e", "TERM=xterm-256color", "-e", "TMOUT=1800", "-e", "HOME=/home/pi", "-e", "HTTPS_PROXY=http://p:3128", "-v", "/s/gh-1:/job:ro,Z", "-v", "/s/gh-1/workspace:/workspace:Z", "pi-job:pinned"];
	assert.deepEqual(buildSandboxRunArgs(full), expected);
	assert.deepEqual(buildSandboxRunArgs({ ...full, venue: "local" }), expected, "naming the venue changes nothing");
	const published = { image: "pi-job:pinned", name: "pi-sandbox-gh-1", workspace: "/w", jobDir: "/j", publish: ["-p", "127.0.0.1:3000:3000"] };
	assert.deepEqual(buildSandboxRunArgs(published), ["run", "--name=pi-sandbox-gh-1", "--pull=never", "--rm", "--init", "--cap-drop=ALL", "--security-opt", "no-new-privileges", "--pids-limit=512", "--shm-size=1g", "--memory=4g", "--cpus=2", "-i", "-t", "--entrypoint", "bash", "-p", "127.0.0.1:3000:3000", "-v", "/j:/job:ro", "-v", "/w:/workspace", "pi-job:pinned"]);
});

const podmanShape = { venue: "podman", image: "pi-job:pinned", name: "pi-sandbox-gh-1", workspace: "/s/gh-1/workspace", jobDir: "/s/gh-1", term: "xterm", idleSeconds: 1800, user: "1234:1234", home: "/home/pi", workspaceOwned: true };

test("a podman sandbox carries the job's whole boundary: ISOLATION_FLAGS, PODMAN_PINNED_FLAGS, keep-id, --user and a NAMED network (#429)", () => {
	for (const [label, over, network] of [
		["egress off", {}, "--network=private"],
		["egress armed", { network: "pi-sandbox-gh-1-net", egressEnv: { HTTPS_PROXY: "http://p:3128" } }, "--network=pi-sandbox-gh-1-net"],
	]) {
		const args = buildSandboxRunArgs({ ...podmanShape, ...over });
		// Both arrays IMPORTED, never retyped, for the reason the local test gives.
		for (const flag of ISOLATION_FLAGS) assert.ok(args.includes(flag), `${label}: missing isolation flag ${flag}`);
		for (const flag of PODMAN_PINNED_FLAGS) assert.ok(args.includes(flag), `${label}: missing pinned flag ${flag}`);
		assert.ok(args.includes("--userns=keep-id"), `${label}: keep-id`);
		assert.ok(args.includes("--user=1234:1234") && args.includes("HOME=/home/pi"), `${label}: --user with HOME beside it`);
		// EXACTLY ONE network flag, and it is named: a containers.conf `netns = "host"` puts a container launched with
		// none on the host's network namespace (measured under issue #354).
		assert.deepEqual(args.filter((a) => a.startsWith("--network")), [network], label);
		assert.ok(args.includes("-i") && args.includes("-t"), `${label}: interactive`);
		assert.equal(args[args.indexOf("--entrypoint") + 1], "bash", label);
		assert.ok(args.includes("--memory=4g") && args.includes("--cpus=2"), label);
		assert.equal(args.at(-1), "pi-job:pinned", `${label}: the image is still last`);
		// And it IS the podman job builder's argv for the same spec, so nothing here can drift from a job's.
		assert.deepEqual(args, buildPodmanRunArgs({ image: "pi-job:pinned", name: "pi-sandbox-gh-1", workspace: "/s/gh-1/workspace", jobDir: "/s/gh-1", user: "1234:1234", relabel: false, workspaceOwned: true, network: over.network ?? null, env: { TERM: "xterm", TMOUT: "1800", HOME: "/home/pi", ...(over.egressEnv ?? {}) }, extraFlags: ["-i", "-t", "--entrypoint", "bash"] }), label);
	}
	// No credential reaches it either.
	const s = buildSandboxRunArgs(podmanShape).join(" ");
	for (const name of [...MINTED_TOKEN_VARS, ...WORKER_ONLY_SECRET_VARS, "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) assert.ok(!s.includes(name), name);
	// SELinux: `:Z` on the retained job dir and the retained clone, by the job path's rule.
	assert.deepEqual(sandboxMounts(buildSandboxRunArgs({ ...podmanShape, relabel: true })), ["/s/gh-1:/job:ro,Z", "/s/gh-1/workspace:/workspace:Z"]);
	// A published port with the policy off rides beside the named private network.
	const published = buildSandboxRunArgs({ ...podmanShape, publish: ["-p", "127.0.0.1:3000:3000"] });
	assert.ok(published.includes("--network=private") && published.includes("127.0.0.1:3000:3000"));
});

test("buildSandboxRunArgs refuses a venue with no launcher, and podman without a user (#429)", () => {
	assert.throws(() => buildSandboxRunArgs({ ...podmanShape, venue: "far" }), /no sandbox launcher for venue "far"/);
	assert.throws(() => buildSandboxRunArgs({ ...podmanShape, venue: "toString" }), /no sandbox launcher/);
	assert.throws(() => buildSandboxRunArgs({ ...podmanShape, user: null, home: null }), /no job user/);
});

/** A spawn that records `<bin> <args>` for EVERY runtime and answers each with `codeFor(bin, args)` (0 by default). */
function recordingRuntime(calls, codeFor = () => 0) {
	return (bin, args) => {
		calls.push([bin, ...args].join(" "));
		const child = new EventEmitter();
		queueMicrotask(() => child.emit("close", codeFor(bin, args)));
		return child;
	};
}

const podmanSession = (over = {}) => {
	const calls = [];
	const asked = [];
	const judged = [];
	const spawn = recordingRuntime(calls);
	return {
		calls,
		asked,
		judged,
		opts: {
			...session,
			...openable({ backend: "podman", workspace: "/s/gh-1/workspace" }),
			blessed: ["podman"],
			backendFloor: { isolation: "enforced" },
			egress: { armed: true, proxy: "pi-dispatch-egress-proxy" },
			// The keeper holds (issue #452 gate round 2); the refusal has its own test.
			keeperCheck: async () => null,
			running: async (o) => (asked.push(o?.bin), []),
			resolveJobUser: async (o) => (judged.push(o), { user: "1234:1234", home: "/home/pi", relabel: true }),
			spawnNetwork: spawn,
			// The REAL launcher over the same recording spawn, so the bin it is handed is the bin that is spawned.
			launch: (o) => launchSandbox({ ...o, spawnFn: spawn }),
			...over,
		},
	};
};

test("a podman sandbox never spawns docker: its asks, network, launch and teardown all go through podman (#429)", async () => {
	const { calls, asked, judged, opts } = podmanSession();
	const result = await openSandbox(opts);
	assert.deepEqual(result, { code: 0, error: null });
	assert.deepEqual(asked, ["podman", "podman"], "both running asks are podman's");
	assert.ok(calls.length > 0 && calls.every((c) => c.startsWith("podman ")), `nothing but podman: ${calls.join(" | ")}`);
	assert.deepEqual(calls.slice(0, 2), ["podman network create --internal pi-sandbox-gh-1-net", "podman network connect pi-sandbox-gh-1-net pi-dispatch-egress-proxy"]);
	const run = calls.find((c) => c.startsWith("podman run "));
	assert.ok(run.includes("--userns=keep-id") && run.includes("--network=pi-sandbox-gh-1-net") && run.includes("/s/gh-1/workspace:/workspace:Z"), run);
	assert.deepEqual(calls.slice(-2), ["podman network disconnect -f pi-sandbox-gh-1-net pi-dispatch-egress-proxy", "podman network rm pi-sandbox-gh-1-net"]);
	// The job-user decision is handed the venue and this process's floor, so it can refuse what a job would be.
	assert.equal(judged[0].venue, "podman");
	assert.deepEqual(judged[0].backendFloor, { isolation: "enforced" });

	// Egress off: no network at all, and still podman's argv with its own named private network.
	const off = podmanSession({ egress: { armed: false, proxy: "p" } });
	await openSandbox(off.opts);
	assert.equal(off.calls.length, 1);
	assert.match(off.calls[0], /^podman run .*--network=private /);
});

test("a local sandbox never spawns podman, and hands its asks docker's bin (#429)", async () => {
	const calls = [];
	const asked = [];
	const spawn = recordingRuntime(calls);
	const judged = [];
	await openSandbox({ ...session, ...openable(), egress: { armed: true, proxy: "p" }, running: async (o) => (asked.push(o?.bin), []), resolveJobUser: async (o) => (judged.push(o.venue), { user: null, home: null }), spawnNetwork: spawn, launch: (o) => launchSandbox({ ...o, spawnFn: spawn }) });
	assert.deepEqual(asked, ["docker", "docker"]);
	assert.deepEqual(judged, ["local"]);
	assert.ok(calls.every((c) => c.startsWith("docker ")), calls.join(" | "));
	assert.ok(calls.some((c) => c.startsWith("docker run ")));
	assert.ok(!calls.some((c) => c.includes("keep-id")));
});

test("a podman sandbox's own lines name podman: attach, the leftover network, the proxy (#429)", async () => {
	const busy = podmanSession({ running: async () => ["gh-1"] });
	const r = await openSandbox(busy.opts);
	assert.equal(r.refused, "already-running");
	assert.match(r.message, /`podman attach pi-sandbox-gh-1`/);

	const exists = podmanSession({ spawnNetwork: recordingRuntime([], (_bin, args) => (args[1] === "create" ? 1 : 0)) });
	const left = await openSandbox(exists.opts);
	assert.equal(left.refused, "egress-network-exists");
	// Every member by `ps -a --filter network=` (issue #452): Podman 4.9's `network inspect` renders no `.Containers`, so
	// the loop over it disconnected nothing there, and Podman's `rm` refuses while a member in any state remains.
	assert.ok(left.message.includes(`for c in $(podman ps -a --filter network=pi-sandbox-gh-1-net --format '{{.Names}}'); do podman network disconnect -f pi-sandbox-gh-1-net "$c"; done; podman network rm pi-sandbox-gh-1-net`), left.message);
	assert.doesNotMatch(left.message, /\.Containers/);
	assert.doesNotMatch(left.message, /docker/);

	const noProxy = podmanSession({ spawnNetwork: recordingRuntime([], (_bin, args) => (args[1] === "connect" || args[1] === "inspect" ? 1 : 0)) });
	const failed = await openSandbox(noProxy.opts);
	assert.equal(failed.refused, "egress-network-failed");
	assert.match(failed.message, /rootless podman, started as docs\/podman\.md shows/);
	assert.doesNotMatch(failed.message, /docker compose/);

	const publish = podmanSession({ publish: ["-p", "127.0.0.1:3000:3000"] });
	const refusedPublish = await openSandbox(publish.opts);
	assert.equal(refusedPublish.refused, "publish-needs-egress-off");
	assert.match(refusedPublish.message, /private network \(`--network=private`/);
	// On podman the reason is the posture, not a port that is not there: podman DOES bind on an `--internal` network
	// (measured on 5.8.1), so docker's sentence would be false here.
	assert.doesNotMatch(refusedPublish.message, /binds no host port/);
	assert.match(refusedPublish.message, /podman would publish a host port into it anyway/);

	// The hook is told the runtime, which is how the CLI and the panel say `podman attach` after a detach.
	let runtime = null;
	const told = podmanSession({ egress: { armed: false, proxy: "p" }, beforeLaunch: (o) => (runtime = o.runtime) });
	await openSandbox(told.opts);
	assert.equal(runtime, "podman");
});

test("an UNBLESSED podman run is refused before anything is asked, and never launched under docker (#429)", async () => {
	for (const blessed of [undefined, ["local"], ["local", "far"]]) {
		const { calls, asked, judged, opts } = podmanSession({ blessed });
		const r = await openSandbox(opts);
		assert.equal(r.refused, "venue-unreachable", JSON.stringify(blessed));
		assert.match(r.message, /PI_BACKENDS in this process's environment does not bless/);
		assert.deepEqual([calls, asked, judged], [[], [], []], "no spawn, no ask, no job-user decision");
	}
});

test("launchSandbox spawns the bin it is handed, and docker when handed none (#429)", async () => {
	const calls = [];
	await launchSandbox({ args: ["run", "x"], bin: "podman", spawnFn: recordingRuntime(calls) });
	await launchSandbox({ args: ["run", "y"], spawnFn: recordingRuntime(calls) });
	assert.deepEqual(calls, ["podman run x", "docker run y"]);
});

test("listRunningSandboxes asks the bin it is handed (#429)", async () => {
	const asked = [];
	const execFn = async (bin, args) => (asked.push([bin, args[0]].join(" ")), { stdout: "pi-sandbox-p-1\n" });
	assert.deepEqual(await listRunningSandboxes({ bin: "podman", execFn }), ["p-1"]);
	assert.deepEqual(asked, ["podman ps"]);
	assert.deepEqual(sandboxVenues(["far", "podman", "local"]), ["podman", "local"], "blessed order, launcher venues only");
	assert.deepEqual(sandboxVenues(undefined), []);
});

/** A retention root on a fake fs: `runs` maps a directory name to its manifest object, or to a string for bad JSON. */
function retainedFs(runs, { rootError = null, readError = {} } = {}) {
	return {
		lstatSync: () => ({ isDirectory: () => true }),
		readdirSync: (dir) => {
			if (rootError) throw Object.assign(new Error(rootError), { code: rootError });
			assert.equal(dir, "/sbx");
			return Object.keys(runs);
		},
		readFileSync: (path) => {
			const name = path.split("/").at(-2);
			if (readError[name]) throw Object.assign(new Error(readError[name]), { code: readError[name] });
			const m = runs[name];
			return typeof m === "string" ? m : JSON.stringify(m);
		},
	};
}

describe("makeSandboxRuntimeWatch: the retention reaper asks the runtime EACH RUN recorded (#429 review)", () => {
	const STORE = "/home/op/.local/share/containers/storage";
	const runs = {
		"d-live": { backend: "local" },
		"d-idle": { backend: "local" },
		"old-1": { jobId: "old-1" }, // no key: predates attribution, and ran on local
		"p-live": { backend: "podman", podmanStore: STORE },
		"p-idle": { backend: "podman", podmanStore: STORE },
		"p-old": { backend: "podman" }, // from before the store was recorded: asked as it always was
	};
	const answering = (answers, asked = []) => async ({ bin }) => {
		asked.push(bin);
		const a = answers[bin];
		if (a instanceof Error) throw a;
		return a;
	};
	const watchOf = (over = {}) => makeSandboxRuntimeWatch({ sandboxDir: "/sbx", fs: retainedFs(runs), readPodmanStore: async () => STORE, ...over });

	test("holds what each run's own runtime reports open, whatever the worker blesses", async () => {
		for (const blessed of [["podman"], ["local"], ["local", "podman"], ["far"]]) {
			const asked = [];
			const watch = watchOf({ blessed, list: answering({ docker: ["d-live", "elsewhere"], podman: ["p-live"] }, asked) });
			assert.deepEqual((await watch.listRunning()).sort(), ["d-live", "elsewhere", "p-live"].sort(), JSON.stringify(blessed));
			// The reproduction round 1 ran: a podman-only worker must still ask DOCKER for a local run's shell.
			assert.deepEqual(asked, ["docker", "podman"], `each runtime a retained run records is asked, once (${blessed})`);
		}
	});

	test("a runtime that cannot answer holds ITS runs and nothing else, and the log names it", async () => {
		for (const failing of ["docker", "podman"]) {
			const logs = [];
			const answers = { docker: [], podman: [] };
			answers[failing] = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
			const held = new Set(await watchOf({ list: answering(answers), log: (e, f) => logs.push([e, f]) }).listRunning());
			const own = failing === "docker" ? ["d-live", "d-idle", "old-1"] : ["p-live", "p-idle", "p-old"];
			const other = failing === "docker" ? ["p-live", "p-idle", "p-old"] : ["d-live", "d-idle", "old-1"];
			for (const id of own) assert.ok(held.has(id), `${failing} down holds ${id}`);
			for (const id of other) assert.ok(!held.has(id), `${failing} down does not hold ${id}`);
			assert.deepEqual(logs.find(([, f]) => f.reason === "runtime-unanswered"), ["sandbox_reaper_skipped", { reason: "runtime-unanswered", runtime: failing, held: own.length }]);
		}
	});

	test("a run it cannot PLACE (unreadable manifest, unknown venue) is asked of every runtime present, and is bounded", async () => {
		const odd = { ...runs, broken: "{not json", "far-1": { backend: "far" }, "null-1": { backend: null } };
		const unplaced = ["broken", "far-1", "null-1"];
		const fs = retainedFs(odd);
		// Every runtime answers "not open": swept, never kept forever.
		assert.deepEqual((await makeSandboxRuntimeWatch({ sandboxDir: "/sbx", fs, readPodmanStore: async () => STORE, list: answering({ docker: [], podman: [] }) }).listRunning()), []);
		// One reports it open: held.
		assert.ok((await makeSandboxRuntimeWatch({ sandboxDir: "/sbx", fs, readPodmanStore: async () => STORE, list: answering({ docker: [], podman: ["broken"] }) }).listRunning()).includes("broken"));
		// Any runtime present that cannot answer: held, every one of them, and the log's count includes them.
		for (const failing of ["docker", "podman"]) {
			const answers = { docker: [], podman: [] };
			answers[failing] = new Error("down");
			const logs = [];
			const held = await makeSandboxRuntimeWatch({ sandboxDir: "/sbx", fs, readPodmanStore: async () => STORE, list: answering(answers), log: (e, f) => logs.push(f) }).listRunning();
			for (const id of unplaced) assert.ok(held.includes(id), `${failing} down holds ${id}`);
			// Three runs of its own either way (d-live, d-idle, old-1 on docker; p-live, p-idle, p-old on podman).
			const own = Object.values(runs).filter((m) => (m.backend ?? "local") === (failing === "docker" ? "local" : "podman")).length;
			assert.equal(own, 3);
			assert.equal(logs.find((f) => f.reason === "runtime-unanswered")?.held, own + unplaced.length, `${failing}: held counts the unplaced runs`);
		}
		// Present means blessed or recorded: with only unplaced runs and podman blessed, podman alone is asked.
		const asked = [];
		const lone = makeSandboxRuntimeWatch({ sandboxDir: "/sbx", blessed: ["podman"], fs: retainedFs({ broken: "{" }), list: answering({ podman: [] }, asked) });
		assert.deepEqual(await lone.listRunning(), []);
		assert.deepEqual(asked, ["podman"]);
	});

	test("a podman run is HELD while the podman asked uses another store, or cannot say which (measured: its ps answers empty)", async () => {
		for (const current of ["/home/other/.local/share/containers/storage", null]) {
			const logs = [];
			const held = await watchOf({ readPodmanStore: async () => current, list: answering({ docker: [], podman: [] }), log: (e, f) => logs.push(f) }).listRunning();
			assert.deepEqual(held.sort(), ["p-idle", "p-live"], `store ${current}: the recorded ones held, the unrecorded one asked as before`);
			assert.deepEqual(logs.filter((f) => f.reason === "podman-store-mismatch").map((f) => f.entry).sort(), ["p-idle", "p-live"]);
			assert.ok(!logs.some((f) => JSON.stringify(f).includes("/home/")), "no path in the log");
		}
		const threw = await watchOf({ readPodmanStore: async () => { throw new Error("x"); }, list: answering({ docker: [], podman: [] }) }).listRunning();
		assert.deepEqual(threw.sort(), ["p-idle", "p-live"]);
		// The same store: asked as always, and the store is read only when a podman run recorded one.
		let reads = 0;
		assert.deepEqual(await watchOf({ readPodmanStore: async () => (reads++, STORE), list: answering({ docker: [], podman: [] }) }).listRunning(), []);
		assert.equal(reads, 1);
		await makeSandboxRuntimeWatch({ sandboxDir: "/sbx", fs: retainedFs({ "d-1": { backend: "local" } }), readPodmanStore: async () => (reads++, STORE), list: answering({ docker: [] }) }).listRunning();
		assert.equal(reads, 1, "no podman run recorded a store, so podman info is not asked");
	});

	test("a runtime no retained run recorded is never asked, and only an unreadable ROOT throws", async () => {
		const asked = [];
		const podmanOnly = makeSandboxRuntimeWatch({ sandboxDir: "/sbx", blessed: ["podman"], fs: retainedFs({ "p-1": { backend: "podman" } }), list: answering({ podman: [] }, asked) });
		assert.deepEqual(await podmanOnly.listRunning(), []);
		assert.deepEqual(asked, ["podman"], "a host with no local run never runs docker");
		const empty = makeSandboxRuntimeWatch({ sandboxDir: "/sbx", fs: retainedFs({}, { rootError: "ENOENT" }), list: () => assert.fail("nothing to ask about") });
		assert.deepEqual(await empty.listRunning(), []);
		const walled = makeSandboxRuntimeWatch({ sandboxDir: "/sbx", fs: retainedFs({}, { rootError: "EACCES" }) });
		await assert.rejects(walled.listRunning(), /EACCES/);
	});

	test("the network sweep visits every runtime PRESENT since start, cumulatively, each built once", async () => {
		const made = [];
		const makeSweeper = ({ bin }) => (made.push(bin), async () => ({ swept: [{ network: `pi-sandbox-${bin}-net`, detached: [] }], notes: [] }));
		const none = makeSandboxRuntimeWatch({ sandboxDir: "/sbx", blessed: ["far"], fs: retainedFs({}), list: answering({}), makeSweeper });
		await none.listRunning();
		assert.deepEqual(await none.sweepNetworks({}), { swept: [], notes: [] });
		assert.deepEqual(made, [], "a host blessing neither and retaining nothing from either spawns neither CLI");

		const files = { "d-1": { backend: "local" } };
		const podman = makeSandboxRuntimeWatch({ sandboxDir: "/sbx", blessed: ["podman"], fs: retainedFs(files), list: answering({ docker: [] }), makeSweeper });
		assert.deepEqual((await podman.sweepNetworks({})).swept.map((x) => x.network), ["pi-sandbox-podman-net"], "blessed before any listing");
		await podman.listRunning();
		assert.deepEqual((await podman.sweepNetworks({})).swept.map((x) => x.network), ["pi-sandbox-docker-net", "pi-sandbox-podman-net"], "and docker once a retained run says it ran there");
		// The last docker run's directory is gone: its session network is still visited (cumulative).
		delete files["d-1"];
		await podman.listRunning();
		assert.deepEqual((await podman.sweepNetworks({})).swept.map((x) => x.network), ["pi-sandbox-docker-net", "pi-sandbox-podman-net"]);
		assert.deepEqual(made, ["podman", "docker"], "each sweeper built once");
	});
});

test("each runtime's network sweeper runs in its own runtime, and every failure is named with its runtime (#429)", async () => {
	const docker = fakeNetDaemon({ nets: { "pi-sandbox-d-net": [] } });
	const podman = fakeNetDaemon({ nets: { "pi-sandbox-p-net": [] } });
	const combined = combineSandboxNetworkSweepers([{ runtime: "docker", sweep: makeSandboxNetworkSweeper({ run: docker.run }) }, { runtime: "podman", sweep: makeSandboxNetworkSweeper({ bin: "podman", run: podman.run }) }]);
	const out = await combined({ retained: () => [] });
	assert.deepEqual(out.swept.map((s) => s.network), ["pi-sandbox-d-net", "pi-sandbox-p-net"]);
	assert.equal(out.failures, undefined);
	assert.ok(!docker.calls.some((c) => c.includes("pi-sandbox-p")), "docker never touches podman's network");
	assert.ok(!podman.calls.some((c) => c.includes("pi-sandbox-d")), "and the reverse");
	// Both failing: BOTH named, not only the first.
	const d2 = fakeNetDaemon({ fail: { "network ls": "cannot connect" } });
	const p2 = fakeNetDaemon({ fail: { "network ls": "cannot connect" } });
	const both = await combineSandboxNetworkSweepers([{ runtime: "docker", sweep: makeSandboxNetworkSweeper({ run: d2.run }) }, { runtime: "podman", sweep: makeSandboxNetworkSweeper({ bin: "podman", run: p2.run }) }])({ retained: () => [] });
	assert.deepEqual(both.failures, [{ reason: "network-list-failed", runtime: "docker" }, { reason: "network-list-failed", runtime: "podman" }]);
	assert.equal(both.failed, "network-list-failed");
	// One failing: said, and the other's pass still runs.
	const d3 = fakeNetDaemon({ fail: { "network ls": "cannot connect" } });
	const p3 = fakeNetDaemon({ nets: { "pi-sandbox-p-net": [] } });
	const half = await combineSandboxNetworkSweepers([{ runtime: "docker", sweep: makeSandboxNetworkSweeper({ run: d3.run }) }, { runtime: "podman", sweep: makeSandboxNetworkSweeper({ bin: "podman", run: p3.run }) }])({ retained: () => [] });
	assert.deepEqual(half.failures, [{ reason: "network-list-failed", runtime: "docker" }]);
	assert.deepEqual(half.swept.map((s) => s.network), ["pi-sandbox-p-net"]);
	const src = readFileSync(new URL("../src/sandbox.mjs", import.meta.url), "utf8");
	assert.match(src, /export function makeSandboxNetworkSweeper\(\{ bin = "docker", run = boundedRuntime\(bin\), proxy = DEFAULT_EGRESS_PROXY \} = \{\}\)/);
	// The bound, behaviourally (issue #452, gate round 3, which replaced the source pin): 10 s per network verb in `bin`.
	const seen = [];
	const fake = (bin, args, opts, cb) => (seen.push({ bin, opts }), queueMicrotask(() => cb(null, "", "")), { kill() {} });
	await boundedRuntime("podman", { execFileFn: fake })(["network", "ls"]);
	assert.deepEqual([seen[0].bin, seen[0].opts.maxBuffer], ["podman", 64 * 1024]);
});

test("the podman session sweep reads members with `ps -a` and `network exists`, never `.Containers`, with every guard it has on docker (#452)", async () => {
	// Podman 4.9.3 renders no `.Containers` (exit 125 for every network, measured), so this sweep noted every leftover
	// session network `unreadable` on every pass there.
	const d = fakeNetDaemon({ nets: { "pi-sandbox-a-net": ["pi-dispatch-egress-proxy"], "pi-sandbox-b-net": ["pi-sandbox-b", "pi-dispatch-egress-proxy"] } });
	const out = await makeSandboxNetworkSweeper({ bin: "podman", run: d.run })({ retained: () => [] });
	assert.deepEqual(out.swept, [{ network: "pi-sandbox-a-net", detached: ["pi-dispatch-egress-proxy"] }]);
	assert.deepEqual(out.notes, [{ network: "pi-sandbox-b-net", reason: "sandbox-attached" }], "a session container on it still keeps it, and says so");
	assert.ok(!d.calls.some((c) => c.includes(".Containers") || c.startsWith("network inspect")), d.calls.join(" | "));
	assert.ok(d.calls.includes("ps -a --filter network=pi-sandbox-a-net --format {{.Names}}\t{{.State}}"));
	assert.ok(d.calls.includes("network exists pi-sandbox-a-net"));
	// A Podman that cannot say whether the network is there: unreadable, said, nothing touched.
	const unsure = fakeNetDaemon({ nets: { "pi-sandbox-c-net": [] } });
	const unsureRun = async (args) => (args[0] === "network" && args[1] === "exists" ? (unsure.calls.push(args.join(" ")), { code: 125, stdout: "", stderr: "Error: boom" }) : unsure.run(args));
	const u = await makeSandboxNetworkSweeper({ bin: "podman", run: unsureRun })({ retained: () => [] });
	assert.deepEqual(u, { swept: [], notes: [{ network: "pi-sandbox-c-net", reason: "unreadable" }] });
	assert.ok(!unsure.calls.some((c) => c.startsWith("network rm") || c.startsWith("network disconnect")));
});

test("the podman session sweep detaches a STOPPED configured proxy, and a failed rm names what still holds the network (#452 gate round 1)", async () => {
	// A Podman whose member `ps` reports stopped members by state; `network rm` refuses while ANY member remains, as
	// Podman's does (measured on 4.9.3 and 5.8.1, a lone member in each state).
	const podmanNet = (members) => {
		const calls = [];
		const on = new Map(Object.entries(members).map(([n, m]) => [n, new Map(m)]));
		const run = async (args) => {
			calls.push(args.join(" "));
			const key = args.slice(0, 2).join(" ");
			if (key === "network ls") return { code: 0, stdout: [...on.keys()].join("\n"), stderr: "" };
			if (key === "ps -a" && args.some((a) => a.startsWith("network="))) {
				const net = args.find((a) => a.startsWith("network=")).slice("network=".length);
				return { code: 0, stdout: [...(on.get(net) ?? new Map())].map(([n, st]) => `${n}\t${st}`).join("\n"), stderr: "" };
			}
			if (key === "ps -a") return { code: 0, stdout: "", stderr: "" };
			if (key === "network exists") return { code: on.has(args.at(-1)) ? 0 : 1, stdout: "", stderr: "" };
			if (key === "info --format") return { code: 0, stdout: `${JSON.stringify({ host: { security: { rootless: true } }, version: { Version: "5.8.1" } })}\n`, stderr: "" };
			if (key === "network disconnect") {
				on.get(args.at(-2))?.delete(args.at(-1));
				return { code: 0, stdout: "", stderr: "" };
			}
			if (key === "network rm") {
				if ((on.get(args.at(-1))?.size ?? 0) > 0) return { code: 2, stdout: "", stderr: "network is being used" };
				on.delete(args.at(-1));
				return { code: 0, stdout: "", stderr: "" };
			}
			return { code: 0, stdout: "", stderr: "" };
		};
		return { run, calls, on };
	};
	// The measured gate finding: a stopped proxy alone kept the network, `rm-failed` with `detached: []` every pass.
	const alone = podmanNet({ "pi-sandbox-a-net": [["pi-dispatch-egress-proxy", "exited"]] });
	const out = await makeSandboxNetworkSweeper({ bin: "podman", run: alone.run })({ retained: () => [] });
	assert.deepEqual(out, { swept: [{ network: "pi-sandbox-a-net", detached: ["pi-dispatch-egress-proxy"] }], notes: [] });
	// The CONFIGURED proxy, by name: another name for it is detached, the default one is then a stranger.
	const custom = podmanNet({ "pi-sandbox-a-net": [["my-proxy", "exited"]] });
	assert.deepEqual((await makeSandboxNetworkSweeper({ bin: "podman", run: custom.run, proxy: "my-proxy" })({ retained: () => [] })).swept, [{ network: "pi-sandbox-a-net", detached: ["my-proxy"] }]);
	// Anything else stopped is NOT detached: it keeps the network, and the line names it with the proxy it took off.
	const held = podmanNet({ "pi-sandbox-a-net": [["pi-dispatch-egress-proxy", "exited"], ["operators-box", "created"]] });
	const kept = await makeSandboxNetworkSweeper({ bin: "podman", run: held.run })({ retained: () => [] });
	assert.deepEqual(kept, { swept: [], notes: [{ network: "pi-sandbox-a-net", reason: "rm-failed", detached: ["pi-dispatch-egress-proxy"], holding: ["operators-box"], more: 0 }] });
	assert.ok(!held.calls.includes("network disconnect -f pi-sandbox-a-net operators-box"), "an operator's container is never detached");
	// Bounded, as the boot reaper's list is: five names and a count.
	const many = podmanNet({ "pi-sandbox-a-net": Array.from({ length: 7 }, (_, i) => [`box${i}`, "exited"]) });
	const bounded = await makeSandboxNetworkSweeper({ bin: "podman", run: many.run })({ retained: () => [] });
	assert.deepEqual(bounded.notes, [{ network: "pi-sandbox-a-net", reason: "rm-failed", detached: [], holding: ["box0", "box1", "box2", "box3", "box4"], more: 2 }]);
	// A re-read that cannot answer says so rather than naming nobody.
	let asks = 0;
	const flaky = podmanNet({ "pi-sandbox-a-net": [["box", "exited"]] });
	const flakyRun = async (args) => (args[0] === "network" && args[1] === "exists" && asks++ > 0 ? { code: 125, stdout: "", stderr: "boom" } : flaky.run(args));
	assert.deepEqual((await makeSandboxNetworkSweeper({ bin: "podman", run: flakyRun })({ retained: () => [] })).notes, [{ network: "pi-sandbox-a-net", reason: "rm-failed", detached: [], holding: "unreadable" }]);
	// The watch hands the configured proxy to every sweeper it makes.
	const made = [];
	const watch = makeSandboxRuntimeWatch({ sandboxDir: "/sbx", blessed: ["podman"], fs: { lstatSync: () => ({ isDirectory: () => true, isSymbolicLink: () => false }), readdirSync: () => [], readFileSync: () => "{}" }, list: async () => [], proxy: "my-proxy", makeSweeper: (o) => (made.push(o), async () => ({ swept: [], notes: [] })) });
	await watch.sweepNetworks({ retained: () => [] });
	assert.deepEqual(made, [{ bin: "podman", proxy: "my-proxy" }]);
});

test("docker's failed session-network rm names what holds it too, and docker's detach list is unchanged (#452 gate round 1)", async () => {
	const d = fakeNetDaemon({ nets: { "pi-sandbox-a-net": ["pi-dispatch-egress-proxy"] } });
	const run = async (args) => {
		if (args.slice(0, 2).join(" ") === "network rm") {
			d.calls.push(args.join(" "));
			return { code: 1, stdout: "", stderr: "has active endpoints" };
		}
		return d.run(args);
	};
	const out = await makeSandboxNetworkSweeper({ run })({ retained: () => [] });
	assert.deepEqual(out.notes, [{ network: "pi-sandbox-a-net", reason: "rm-failed", detached: ["pi-dispatch-egress-proxy"], holding: [], more: 0 }]);
	assert.equal(d.calls.filter((c) => c.startsWith("network inspect --format {{json .Containers}}")).length, 2, "the first read, and the re-read after the failed rm");
});

test("on Podman 4.x the session sweep detaches nothing RUNNING while the rootless network keeper does not hold, on both venues (#452 with #458, gate round 2)", async () => {
	// Detaching the RUNNING proxy is the 4.9 trigger #458 measured; before #452 this sweep never got that far on 4.9.
	const holding = { code: 0, stdout: "running|bridge|pi-dispatch-netns-keeper,\n", stderr: "" };
	const blocked = fakeNetDaemon({ nets: { "pi-sandbox-a-net": ["pi-dispatch-egress-proxy"], "pi-sandbox-e-net": [] }, podmanVersion: "4.9.3" });
	const out = await makeSandboxNetworkSweeper({ bin: "podman", run: blocked.run })({ retained: () => [] });
	assert.deepEqual(out.notes, [{ network: "pi-sandbox-a-net", reason: "keeper-not-holding" }]);
	assert.deepEqual(out.swept, [{ network: "pi-sandbox-e-net", detached: [] }], "a network with nothing to detach is removed without asking");
	assert.ok(!blocked.calls.some((c) => c.startsWith("network disconnect") || c === "network rm pi-sandbox-a-net"), blocked.calls.join(" | "));
	// The runtime is read from `podman info`'s JSON, the keeper by its state, mode and networks only (no age rule).
	assert.ok(blocked.calls.includes("info --format json"));
	assert.ok(blocked.calls.includes("inspect --format={{.State.Status}}|{{.HostConfig.NetworkMode}}|{{range $k, $v := .NetworkSettings.Networks}}{{$k}},{{end}} pi-dispatch-netns-keeper"));
	const held = fakeNetDaemon({ nets: { "pi-sandbox-a-net": ["pi-dispatch-egress-proxy"] }, podmanVersion: "4.9.3", keeperRead: holding });
	assert.deepEqual((await makeSandboxNetworkSweeper({ bin: "podman", run: held.run })({ retained: () => [] })).swept, [{ network: "pi-sandbox-a-net", detached: ["pi-dispatch-egress-proxy"] }], "a keeper holding NOW is enough, however young");
	// The docker venue reaching a rootless Podman 4.9 (the real CLI against its API: Docker's shape, Podman's licence):
	// the same guard, the keeper read through docker.
	const compat = JSON.stringify({ ServerVersion: "4.9.3", ProductLicense: "Apache-2.0", OperatingSystem: "ubuntu", SecurityOptions: ["name=seccomp,profile=default", "name=rootless"] });
	const viaApi = fakeNetDaemon({ nets: { "pi-sandbox-a-net": ["pi-dispatch-egress-proxy"] }, dockerInfo: compat });
	assert.deepEqual((await makeSandboxNetworkSweeper({ run: viaApi.run })({ retained: () => [] })).notes, [{ network: "pi-sandbox-a-net", reason: "keeper-not-holding" }]);
	assert.ok(!viaApi.calls.some((c) => c.startsWith("network disconnect")));
	const viaApiHeld = fakeNetDaemon({ nets: { "pi-sandbox-a-net": ["pi-dispatch-egress-proxy"] }, dockerInfo: compat, keeperRead: holding });
	assert.equal((await makeSandboxNetworkSweeper({ run: viaApiHeld.run })({ retained: () => [] })).swept.length, 1);
	// podman-docker on 4.9 (Podman's own shape through `docker`): the same.
	const shim = fakeNetDaemon({ nets: { "pi-sandbox-a-net": ["pi-dispatch-egress-proxy"] }, dockerInfo: JSON.stringify({ host: { security: { rootless: true } }, version: { Version: "4.9.3" } }) });
	assert.deepEqual((await makeSandboxNetworkSweeper({ run: shim.run })({ retained: () => [] })).notes, [{ network: "pi-sandbox-a-net", reason: "keeper-not-holding" }]);
	// Docker Engine, rootful Podman and 5.x: no keeper read at all.
	// M4 (gate round 3): a Docker Engine reporting `ServerVersion: "dev"`, or a version no display rule reads (null), with no
	// Podman licence, is Docker: no keeper read, whatever its version would say to `podmanNeedsNetnsKeeper`.
	for (const dockerInfo of [undefined, JSON.stringify({ ServerVersion: "dev", OperatingSystem: "Ubuntu", SecurityOptions: [] }), JSON.stringify({ ServerVersion: "dev", OperatingSystem: "Ubuntu", SecurityOptions: ["name=rootless"] }), JSON.stringify({ ServerVersion: "27.4.0 custom build", OperatingSystem: "Ubuntu", SecurityOptions: [] }), JSON.stringify({ ServerVersion: "4.9.3", ProductLicense: "Apache-2.0", OperatingSystem: "ubuntu", SecurityOptions: ["name=seccomp,profile=default"] }), JSON.stringify({ ServerVersion: "5.8.1", ProductLicense: "Apache-2.0", OperatingSystem: "fedora", SecurityOptions: ["name=rootless"] })]) {
		const d = fakeNetDaemon({ nets: { "pi-sandbox-a-net": ["pi-dispatch-egress-proxy"] }, ...(dockerInfo ? { dockerInfo } : {}) });
		assert.equal((await makeSandboxNetworkSweeper({ run: d.run })({ retained: () => [] })).swept.length, 1, dockerInfo ?? "docker");
		assert.ok(!d.calls.some((c) => c.startsWith("inspect")), d.calls.join(" | "));
	}
	// A runtime that cannot be read: fail closed for a RUNNING member only, with its own token.
	const dark = fakeNetDaemon({ nets: { "pi-sandbox-a-net": ["pi-dispatch-egress-proxy"] }, dockerInfo: "not json" });
	assert.deepEqual((await makeSandboxNetworkSweeper({ run: dark.run })({ retained: () => [] })).notes, [{ network: "pi-sandbox-a-net", reason: "runtime-unreadable" }]);
	// A STOPPED proxy is not the trigger: detached with no runtime or keeper read, even on 4.9 without a keeper.
	const stopped = fakeNetDaemon({ nets: { "pi-sandbox-s-net": [] }, podmanVersion: "4.9.3" });
	const parkedRun = async (args) => (args[0] === "ps" && args.includes("network=pi-sandbox-s-net") ? (stopped.calls.push(args.join(" ")), { code: 0, stdout: "pi-dispatch-egress-proxy\texited\n", stderr: "" }) : stopped.run(args));
	const s2 = await makeSandboxNetworkSweeper({ bin: "podman", run: parkedRun })({ retained: () => [] });
	assert.deepEqual(s2.swept, [{ network: "pi-sandbox-s-net", detached: ["pi-dispatch-egress-proxy"] }]);
	assert.ok(!stopped.calls.some((c) => c.startsWith("info") || c.startsWith("inspect")), stopped.calls.join(" | "));
});

test("an EXITED container of this run still on its network is removed, then the network, only after rm failed (#429 review, podman)", async () => {
	// Podman keeps an exited container attached (measured on 5.8.1), so `network rm` failed on every pass forever.
	const d = fakeNetDaemon({ nets: { "pi-sandbox-a-net": [] }, containers: { "pi-sandbox-a": "exited", "my-pi-sandbox-a": "exited" } });
	let attached = true;
	const run = async (args) => {
		const key = args.slice(0, 2).join(" ");
		if (key === "network rm" && attached) {
			d.calls.push(args.join(" "));
			return { code: 2, stdout: "", stderr: "network is being used" };
		}
		if (args[0] === "rm" && args[1] === "pi-sandbox-a") {
			d.calls.push(args.join(" "));
			attached = false;
			return { code: 0, stdout: "", stderr: "" };
		}
		return d.run(args);
	};
	const out = await makeSandboxNetworkSweeper({ bin: "podman", run })({ retained: () => [] });
	assert.deepEqual(out.swept, [{ network: "pi-sandbox-a-net", detached: [], removedContainer: "pi-sandbox-a" }]);
	assert.ok(d.calls.includes("rm pi-sandbox-a"));
	assert.ok(!d.calls.some((c) => c.includes("rm my-pi-sandbox-a") || c.includes("rm -f")), "only its own container, never -f");
	// A container in any other state is never removed, and the note stays.
	for (const state of ["created", "running", "paused", "stopping"]) {
		const e = fakeNetDaemon({ nets: { "pi-sandbox-b-net": [] }, containers: { "pi-sandbox-b": state } });
		const calls = [];
		let asks = 0;
		const r = async (args) => {
			calls.push(args.join(" "));
			// The guard sees the run finished, then the recovery look sees it in `state`. The endpoint read's own `ps`
			// (Podman's, issue #452) is not one of those two asks.
			if (args[0] === "ps" && !args.some((a) => a.startsWith("network="))) return asks++ === 0 ? { code: 0, stdout: "", stderr: "" } : e.run(args);
			if (args.slice(0, 2).join(" ") === "network rm") return { code: 2, stdout: "", stderr: "in use" };
			return e.run(args);
		};
		const o = await makeSandboxNetworkSweeper({ bin: "podman", run: r })({ retained: () => [] });
		assert.deepEqual(o.notes.map((n) => n.reason), ["rm-failed"], state);
		assert.ok(!calls.some((c) => /^rm /.test(c)), `${state}: nothing removed`);
	}
});

test("sandboxVenuePolicy reads PI_BACKENDS and PI_BACKEND_FLOOR as the worker does, and throws on a typo (#429)", () => {
	assert.deepEqual(sandboxVenuePolicy({}), { blessed: ["local"], backendFloor: {} });
	assert.deepEqual(sandboxVenuePolicy({ PI_BACKENDS: "podman,local", PI_BACKEND_FLOOR: "isolation=enforced" }), { blessed: ["podman", "local"], backendFloor: { isolation: "enforced" } });
	assert.throws(() => sandboxVenuePolicy({ PI_BACKENDS: "podmn" }), /unknown backend/);
	assert.throws(() => sandboxVenuePolicy({ PI_BACKEND_FLOOR: "isolation" }));
	assert.equal(sandboxLauncher("podman").bin, "podman");
});

describe("decideSandboxJobUser on the podman venue (#429)", () => {
	const HOME = "/home/op";
	const USER_MOUNTS = `${HOME}/.config/containers/mounts.conf`;
	const USER_CONF = `${HOME}/.config/containers/containers.conf`;
	/** A host fs: `files` maps a path to its text, everything else is ENOENT. */
	// user@1234.service's controllers: the account's user manager running with them delegated (issue #453).
	const USER_MANAGER = "/sys/fs/cgroup/user.slice/user-1234.slice/user@1234.service/cgroup.controllers";
	const hostFs = (given = { [USER_MOUNTS]: "" }) => {
		const files = { [USER_MANAGER]: "cpuset cpu io memory pids\n", ...given };
		const miss = (path) => {
			throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
		};
		return {
			statSync: (path) => (Object.hasOwn(files, path) ? { size: Buffer.byteLength(files[path]) } : miss(path)),
			readFileSync: (path) => (Object.hasOwn(files, path) ? files[path] : miss(path)),
			readdirSync: (path) => miss(path),
		};
	};
	const INFO = { rootless: true, serviceIsRemote: false, selinux: true, cgroupVersion: "v2", cgroupManager: "systemd", controllers: ["cpuset", "cpu", "io", "memory", "pids"], version: "5.8.1" };
	const answered = (over = {}) => async () => ({ answered: true, info: { ...INFO, ...over } });
	const base = { venue: "podman", platform: "linux", euid: 1234, egid: 1234, home: HOME, env: {}, fs: hostFs(), readInfo: answered(), imageCapabilities: async () => ({ ok: true, capabilities: ["anyUid"] }) };
	const stamped = { image: "pi-job:x", jobUser: { user: "1234:1234", home: "/home/pi" } };

	test("the run's own account opens it as its uid, with keep-id's user and SELinux's relabel", async () => {
		assert.deepEqual(await decideSandboxJobUser({ ...base, manifest: stamped }), { user: "1234:1234", home: "/home/pi", relabel: true });
		assert.deepEqual(await decideSandboxJobUser({ ...base, readInfo: answered({ selinux: false }), manifest: stamped }), { user: "1234:1234", home: "/home/pi" });
		// No stamp: this process's ids, as `local` decides a run from before the stamp.
		assert.deepEqual(await decideSandboxJobUser({ ...base, manifest: { image: "pi-job:x" } }), { user: "1234:1234", home: "/home/pi", relabel: true });
	});

	test("refused for what a podman JOB is refused for: rootful, remote, no podman", async () => {
		const rootful = await decideSandboxJobUser({ ...base, readInfo: answered({ rootless: false }), manifest: stamped });
		assert.equal(rootful.refused, "job-user-unmappable");
		assert.match(rootful.message, /podman is not rootless for this account/);
		const remote = await decideSandboxJobUser({ ...base, readInfo: answered({ serviceIsRemote: true }), manifest: stamped });
		assert.match(remote.message, /remote service/);
		const none = await decideSandboxJobUser({ ...base, readInfo: async () => ({ answered: false, reason: "podman-not-found", transient: false }), manifest: stamped });
		assert.match(none.message, /no podman CLI was found/);
		const slow = await decideSandboxJobUser({ ...base, readInfo: async () => ({ answered: false, reason: "timeout", transient: true }), manifest: stamped });
		assert.equal(slow.refused, "job-user-unknown");
	});

	test("a containers.conf that widens a job refuses the sandbox too, as podman-conf-widens-job (#428)", async () => {
		for (const text of ['[network]\npasta_options = ["--map-host-loopback", "169.254.1.2"]\n', '[containers]\nannotations = ["run.oci.keep_original_groups=1"]\n']) {
			const r = await decideSandboxJobUser({ ...base, fs: hostFs({ [USER_MOUNTS]: "", [USER_CONF]: text }), manifest: stamped });
			assert.equal(r.refused, "podman-conf-widens-job", text);
			assert.match(r.message, /^Refused: .*containers\.conf sets (pasta_options|annotations)/);
		}
		// With no floor at all, as a job is.
		const r = await decideSandboxJobUser({ ...base, backendFloor: {}, fs: hostFs({ [USER_MOUNTS]: "", [USER_CONF]: "[network]\npasta_options = []\n" }), manifest: stamped });
		assert.equal(r.refused, "podman-conf-widens-job");
		// A refused identity names its own fix first, exactly as for a job.
		const both = await decideSandboxJobUser({ ...base, readInfo: answered({ rootless: false }), fs: hostFs({ [USER_MOUNTS]: "", [USER_CONF]: "[network]\npasta_options = []\n" }), manifest: stamped });
		assert.equal(both.refused, "job-user-unmappable");
	});

	test("the observations are judged against the floor exactly as a job's are", async () => {
		const floor = { isolation: "enforced" };
		const undelegated = await decideSandboxJobUser({ ...base, backendFloor: floor, fs: hostFs({ [USER_MOUNTS]: "", [USER_MANAGER]: "cpu\n" }), manifest: stamped });
		assert.equal(undelegated.refused, "backend-floor");
		assert.match(undelegated.message, /PI_BACKEND_FLOOR asks for something this host is not observed to provide/);
		assert.ok((await decideSandboxJobUser({ ...base, backendFloor: floor, manifest: stamped })).user, "a delegated host passes the same floor");
		assert.ok((await decideSandboxJobUser({ ...base, fs: hostFs({ [USER_MOUNTS]: "", [USER_MANAGER]: "cpu\n" }), manifest: stamped })).user, "no floor, nothing observed refuses");
		// A miss that rests only on a read that did not answer is its own token, not the floor's: the fix is to make
		// podman answer, not to change the host.
		const unread = await decideSandboxJobUser({ ...base, backendFloor: floor, readInfo: async () => ({ answered: false, reason: "timeout", transient: true }), manifest: stamped });
		assert.equal(unread.refused, "podman-unobserved");
		assert.match(unread.message, /did not answer \(timeout\)/);
	});

	test("a run that recorded its container STORE opens only under that store (#429 review, measured)", async () => {
		const STORE = "/home/op/.local/share/containers/storage";
		const withStore = { ...stamped, podmanStore: STORE };
		assert.equal((await decideSandboxJobUser({ ...base, readInfo: answered({ graphRoot: STORE }), manifest: withStore })).user, "1234:1234");
		for (const graphRoot of ["/home/op2/.local/share/containers/storage", null]) {
			const r = await decideSandboxJobUser({ ...base, readInfo: answered({ graphRoot }), manifest: withStore });
			assert.equal(r.refused, "podman-store-mismatch", String(graphRoot));
			assert.ok(r.message.includes(STORE), "names the recorded store");
			if (graphRoot) assert.ok(r.message.includes(graphRoot), "and this podman's");
			assert.match(r.message, /HOME and XDG_DATA_HOME/);
		}
		// A run from before the key opens as it did.
		assert.equal((await decideSandboxJobUser({ ...base, readInfo: answered({ graphRoot: "/elsewhere" }), manifest: stamped })).user, "1234:1234");
	});

	test("a containers.conf or a podman file that could not be read JUST NOW refuses in its own words (#428's transient rule)", async () => {
		const busyFs = { ...hostFs(), readFileSync: (path) => { if (path === "/etc/containers/containers.conf") throw Object.assign(new Error("busy"), { code: "EMFILE" }); return hostFs().readFileSync(path); }, statSync: (path) => { if (path === "/etc/containers/containers.conf") return { size: 1 }; return hostFs().statSync(path); } };
		const r = await decideSandboxJobUser({ ...base, fs: busyFs, manifest: stamped });
		assert.equal(r.refused, "podman-conf-unread");
		assert.match(r.message, /could not be read just now.*EMFILE.*try again/);
		const mountsBusy = { ...hostFs(), statSync: (path) => { if (path === USER_MOUNTS) throw Object.assign(new Error("io"), { code: "EIO" }); return hostFs().statSync(path); } };
		const m = await decideSandboxJobUser({ ...base, fs: mountsBusy, backendFloor: { mountSet: "enforced" }, manifest: stamped });
		assert.equal(m.refused, "podman-unobserved");
		assert.match(m.message, /mounts\.conf could not be read \(EIO\)/);
	});

	test("a run of another account, sudo, macOS and a malformed stamp refuse before anything is created", async () => {
		const other = await decideSandboxJobUser({ ...base, manifest: { image: "pi-job:x", jobUser: { user: "1300:1300", home: "/home/pi" } } });
		assert.equal(other.refused, "job-user-unmappable");
		assert.match(other.message, /ran as 1300:1300, .* runs as the account that opens it \(1234:1234\) under keep-id/);
		const image = await decideSandboxJobUser({ ...base, manifest: { image: "pi-job:x", jobUser: { user: null, home: null } } });
		assert.match(image.message, /as the image's own user, which no podman run does/);
		let read = 0;
		const counting = async () => (read++, { answered: true, info: INFO });
		const sudo = await decideSandboxJobUser({ ...base, euid: 0, egid: 0, readInfo: counting, manifest: stamped });
		assert.match(sudo.message, /open it as the worker's own account/);
		const mac = await decideSandboxJobUser({ ...base, platform: "darwin", readInfo: counting, manifest: stamped });
		assert.match(mac.message, /runs only on Linux/);
		assert.equal(read, 0, "neither asks podman");
		assert.equal((await decideSandboxJobUser({ ...base, manifest: { image: "pi-job:x", jobUser: "1234:1234" } })).refused, "job-user-stamp-invalid");
	});

	test("the retained image must declare anyUid in THIS account's store, unless the uid is the image's own", async () => {
		const bare = await decideSandboxJobUser({ ...base, imageCapabilities: async () => ({ ok: true, capabilities: [] }), manifest: stamped });
		assert.equal(bare.refused, "job-image-any-uid-unsupported");
		const gone = await decideSandboxJobUser({ ...base, imageCapabilities: async () => ({ missing: "pi-job:x" }), manifest: stamped });
		assert.equal(gone.refused, "job-user-image");
		const own = { image: "pi-job:x", jobUser: { user: "1001:1001", home: "/home/pi" } };
		assert.deepEqual(await decideSandboxJobUser({ ...base, euid: 1001, egid: 1001, imageCapabilities: async () => ({ ok: true, capabilities: [] }), manifest: own }), { user: "1001:1001", home: "/home/pi", relabel: true });
		const rootGroup = await decideSandboxJobUser({ ...base, egid: 0, manifest: { image: "pi-job:x" } });
		assert.equal(rootGroup.refused, "job-user-unmappable");
	});

	test("a local run is still decided by the local rules, never by podman info", async () => {
		let asked = false;
		const r = await decideSandboxJobUser({ platform: "darwin", readInfo: async () => ((asked = true), { answered: true, info: INFO }), manifest: stamped });
		assert.deepEqual(r, { user: null, home: null });
		assert.equal(asked, false);
	});
});

// --- review round 3: one read per directory decides the whole pass -----------------------------------------------

describe("the reaper and the watch decide on ONE manifest read per directory (#429 review round 3)", () => {
	const STORE = "/home/w/.local/share/containers/storage";
	const OLD = "2026-01-01T00:00:00.000Z";
	const NOW = Date.parse("2026-09-27T00:00:00.000Z");
	/** A real-shaped retention root on a fake fs, counting reads per manifest; `flaky` maps a name to its first read's errno. */
	const rootWith = (runs, flaky = {}, { lstatFlaky = {}, links = [] } = {}) => {
		const files = { "/sbx": "<dir>" };
		for (const [id, m] of Object.entries(runs)) {
			files[`/sbx/${id}`] = "<dir>";
			if (m !== null) files[`/sbx/${id}/manifest.json`] = typeof m === "string" ? m : JSON.stringify(m);
		}
		for (const id of links) files[`/sbx/${id}`] = "<link>";
		const reads = {};
		const removed = [];
		const lstats = {};
		// Issue #446: the sweep deletes a TOMBSTONE it renamed the run to, so what it removed and read is counted under the
		// run's own name, mapped back through the renames.
		const origin = {};
		const idOf = (segment) => origin[segment] ?? segment;
		const fs = {
			lstatSync: (p) => {
				const id = p.split("/").at(-1);
				lstats[id] = (lstats[id] ?? 0) + 1;
				if (lstatFlaky[id] && lstats[id] === 1) throw Object.assign(new Error(lstatFlaky[id]), { code: lstatFlaky[id] });
				if (!(p in files)) throw Object.assign(new Error(p), { code: "ENOENT" });
				return { isDirectory: () => files[p] === "<dir>" };
			},
			readdirSync: (p) => Object.keys(files).filter((k) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes("/")).map((k) => k.slice(p.length + 1)),
			readFileSync: (p) => {
				const id = idOf(p.split("/").at(-2));
				reads[id] = (reads[id] ?? 0) + 1;
				if (flaky[id] && reads[id] === 1) throw Object.assign(new Error(flaky[id]), { code: flaky[id] });
				if (!(p in files)) throw Object.assign(new Error(p), { code: "ENOENT" });
				return files[p];
			},
			rmSync: (p) => {
				removed.push(idOf(p.split("/").at(-1)));
				for (const k of Object.keys(files)) if (k === p || k.startsWith(`${p}/`)) delete files[k];
			},
			// A rename moves the whole subtree, as a directory rename does.
			renameSync: (from, to) => {
				origin[to.split("/").at(-1)] = idOf(from.split("/").at(-1));
				for (const k of Object.keys(files)) {
					if (k !== from && !k.startsWith(`${from}/`)) continue;
					files[`${to}${k.slice(from.length)}`] = files[k];
					delete files[k];
				}
			},
		};
		return { fs, reads, removed, files };
	};
	const pass = async ({ fs }, { list = async () => [], store = STORE, blessed = [] } = {}) => {
		const logs = [];
		const watch = makeSandboxRuntimeWatch({ sandboxDir: "/sbx", blessed, fs, list, readPodmanStore: async () => store, makeSweeper: () => async () => ({ swept: [], notes: [] }), log: (e, f) => logs.push(f) });
		await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 1, fs, now: () => NOW, listRunning: watch.listRunning, sweepNetworks: watch.sweepNetworks, log: (e, f) => logs.push(f) })();
		return logs;
	};

	test("a manifest read that fails for a moment HOLDS the run, whatever the runtimes say (D2 reproduced)", async () => {
		// The store hold used to be skipped on a transient read, and expiry's second read then succeeded and deleted it.
		for (const code of ["EMFILE", "EIO", "EAGAIN"]) {
			const root = rootWith({ "p-open": { backend: "podman", podmanStore: STORE, createdAt: OLD } }, { "p-open": code });
			const logs = await pass(root, { store: "/srv/new/storage" });
			assert.deepEqual(root.removed, [], `${code}: held`);
			assert.deepEqual(logs.filter((f) => f.reason === "manifest-unread"), [{ entry: "p-open", reason: "manifest-unread" }], `${code}: said once`);
			assert.equal(root.reads["p-open"], 1, `${code}: ONE read decides the pass`);
		}
		// The next pass reads again and, the store differing, still holds; the same store and nothing open sweeps it.
		const root = rootWith({ "p-open": { backend: "podman", podmanStore: STORE, createdAt: OLD } }, { "p-open": "EMFILE" });
		await pass(root);
		assert.deepEqual(root.removed, [], "first pass: held for the transient read");
		await pass(root);
		assert.deepEqual(root.removed, ["p-open"], "second pass: read, same store, not open: swept");
	});

	test("every directory is read once to place it, and again only at the point of deletion", async () => {
		const root = rootWith({ "d-1": { backend: "local", createdAt: OLD }, "p-1": { backend: "podman", podmanStore: STORE, createdAt: OLD }, bad: "{", none: null });
		await pass(root, { list: async ({ bin }) => (bin === "docker" ? ["d-1"] : []) });
		// Three for a deleted one since issue #446: the pass's read, the fresh read, and the read through its tombstone.
		assert.deepEqual(root.reads, { "d-1": 1, "p-1": 3, bad: 3, none: 3 }, "the held one is never re-read; each deleted one is confirmed fresh, and again after it is renamed aside");
		assert.deepEqual(root.removed.sort(), ["bad", "none", "p-1"], "held by its runtime: d-1; the rest expire on their one read");
	});

	test("a directory with NO manifest file is asked of every runtime present, and held while one reports it open or cannot answer (PR #466 gate round 1)", async () => {
		// Reproduced on a real host: a `pi-sandbox-none` container running over a directory whose manifest had been removed
		// was deleted under it, because ENOENT was the no-manifest rule and no runtime was asked.
		const asked = [];
		const open = rootWith({ none: null });
		await pass(open, { blessed: ["podman"], list: async ({ bin }) => (asked.push(bin), ["none"]) });
		assert.deepEqual([open.removed, asked], [[], ["podman"]], "a sandbox of that name is running: held");
		const down = rootWith({ none: null });
		const logs = await pass(down, { blessed: ["podman"], list: async () => {
			throw new Error("down");
		} });
		assert.deepEqual(down.removed, [], "the runtime could not answer: held");
		assert.deepEqual(logs.filter((f) => f.reason === "runtime-unanswered"), [{ reason: "runtime-unanswered", runtime: "podman", held: 1 }]);
		const closed = rootWith({ none: null });
		await pass(closed, { blessed: ["podman"], list: async () => [] });
		assert.deepEqual(closed.removed, ["none"], "every runtime present answered not open: the no-manifest rule sweeps it");
		const bare = rootWith({ none: null });
		const bareAsked = [];
		await pass(bare, { list: async ({ bin }) => (bareAsked.push(bin), []) });
		assert.deepEqual([bare.removed, bareAsked], [["none"], []], "no runtime present at all: nothing on this host can hold it open");
		const unplacedAsked = [];
		await pass(rootWith({ bad: "{" }), { blessed: ["podman"], list: async ({ bin }) => (unplacedAsked.push(bin), []) });
		assert.deepEqual(unplacedAsked, ["podman"], "while a parse error IS asked of the runtime present");
		const bad = rootWith({ bad: "{", "p-1": { backend: "podman", createdAt: new Date(NOW).toISOString() } });
		await pass(bad, { list: async ({ bin }) => (bin === "podman" ? ["bad"] : []) });
		assert.deepEqual(bad.removed, [], "a runtime reports it open: held");
	});

	test("a pin landing while the runtimes are asked is honoured: the delete re-reads and holds (final review, reproduced)", async () => {
		const root = rootWith({ "p-1": { jobId: "p-1", backend: "podman", podmanStore: STORE, createdAt: OLD, keepUntil: null } });
		const logs = await pass(root, {
			// A slow runtime: the operator pins the run while the pass waits on it.
			list: async () => {
				await new Promise((r) => setTimeout(r, 5));
				root.files["/sbx/p-1/manifest.json"] = JSON.stringify({ jobId: "p-1", backend: "podman", podmanStore: STORE, createdAt: OLD, keepUntil: new Date(NOW + 7 * 86400000).toISOString() });
				return [];
			},
		});
		assert.deepEqual(root.removed, [], "the pinned run survives");
		assert.deepEqual(logs.filter((f) => f.entry === "p-1").map((f) => f.reason), ["manifest-changed"]);
	});

	test("a directory REPLACED by a retry's fresh run while the runtimes are asked is not deleted on the old read", async () => {
		const root = rootWith({ "gh-1": { jobId: "gh-1", backend: "local", createdAt: OLD, keepUntil: null } });
		await pass(root, {
			list: async () => {
				await new Promise((r) => setTimeout(r, 5));
				// BullMQ reused the id: the retry's retention removed the old tree and wrote a fresh manifest.
				root.files["/sbx/gh-1/manifest.json"] = JSON.stringify({ jobId: "gh-1", backend: "local", createdAt: new Date(NOW).toISOString(), keepUntil: null });
				return [];
			},
		});
		assert.deepEqual(root.removed, [], "the fresh run survives");
		// Unchanged, the same run expires as before: the fresh read is only a confirmation.
		const plain = rootWith({ "gh-1": { jobId: "gh-1", backend: "local", createdAt: OLD, keepUntil: null } });
		await pass(plain, { list: async () => (await new Promise((r) => setTimeout(r, 5)), []) });
		assert.deepEqual(plain.removed, ["gh-1"]);
	});

	test("a fresh read that fails for a moment at the point of deletion holds too", async () => {
		const root = rootWith({ "d-1": { backend: "local", createdAt: OLD } });
		let n = 0;
		const read = root.fs.readFileSync;
		root.fs.readFileSync = (p) => {
			if (++n === 2) throw Object.assign(new Error("EMFILE"), { code: "EMFILE" });
			return read(p);
		};
		const logs = await pass(root);
		assert.deepEqual(root.removed, []);
		assert.deepEqual(logs.filter((f) => f.entry === "d-1").map((f) => f.reason), ["manifest-unread"]);
	});

	test("a TRANSIENT lstat holds the directory through the real deletion path, never reads as absent (M1)", async () => {
		const root = rootWith({ "d-1": { backend: "local", createdAt: OLD } }, {}, { lstatFlaky: { "d-1": "EIO" } });
		const logs = await pass(root);
		assert.deepEqual(root.removed, [], "held, not swept as no-manifest");
		assert.deepEqual(logs.filter((f) => f.entry === "d-1").map((f) => f.reason), ["manifest-unread"]);
		assert.equal(root.reads["d-1"], undefined, "and nothing was read through an entry that could not be stat'ed");
	});

	test("a symlinked entry is never followed: no manifest is read through it (M2)", async () => {
		const root = rootWith({}, {}, { links: ["evil"] });
		const readThrough = [];
		const read = root.fs.readFileSync;
		root.fs.readFileSync = (p) => (readThrough.push(p), read(p));
		await pass(root);
		assert.deepEqual(readThrough, [], "the pass read nothing through the link");
		assert.deepEqual(root.removed, ["evil"], "and the reaper removed the link itself as not-a-directory");
	});
});

test("the finished-container repair matches THIS run by its whole name, never a sibling the filter also returns (#429 review round 3)", async () => {
	// `--filter name=pi-sandbox-gh-1` also returns `pi-sandbox-gh-12` (unanchored). A sibling that is exited must not be
	// read as this run finished: this run's own container is `created`, mid-launch, and nothing may be removed.
	const d = fakeNetDaemon({ nets: { "pi-sandbox-gh-1-net": [] }, containers: { "pi-sandbox-gh-12": "exited", "pi-sandbox-gh-1": "created" } });
	const calls = [];
	let asks = 0;
	const run = async (args) => {
		calls.push(args.join(" "));
		// The guard answers clear (the container is created after it), then the repair's look sees both containers.
		// The endpoint read's own `ps` (Podman's, issue #452) is neither.
		if (args[0] === "ps" && !args.some((a) => a.startsWith("network="))) return asks++ === 0 ? { code: 0, stdout: "", stderr: "" } : d.run(args);
		if (args.slice(0, 2).join(" ") === "network rm") return { code: 2, stdout: "", stderr: "in use" };
		return d.run(args);
	};
	const out = await makeSandboxNetworkSweeper({ bin: "podman", run })({ retained: () => [] });
	assert.deepEqual(out.notes.map((n) => n.reason), ["rm-failed"]);
	assert.ok(!calls.some((c) => /^rm /.test(c)), `nothing removed: ${calls.join(" | ")}`);
});

// --- issue #446: the past-window refusal, the pin first, and the post-launch look --------------------------------

test("the opener's grace and the post-launch look's bounds are pinned by literal (#446)", () => {
	assert.deepEqual({ SANDBOX_OPEN_GRACE_MS, SANDBOX_LAUNCH_WATCH_MS, SANDBOX_LAUNCH_WATCH_TRIES }, { SANDBOX_OPEN_GRACE_MS: 300000, SANDBOX_LAUNCH_WATCH_MS: 250, SANDBOX_LAUNCH_WATCH_TRIES: 120 });
});

describe("the past-window refusal (#446)", () => {
	const T = Date.parse("2026-08-02T00:00:00Z");
	const manifest = { jobId: "j1", kind: "github", image: "pi-job:latest", backend: "local", workspace: "/w", createdAt: "2026-08-01T00:00:00.000Z", retainUntil: new Date(T).toISOString(), keepUntil: null };
	const resolve = (at, over = {}, extra = {}) => resolveSandbox({ jobId: "j1", sandboxDir: "/s", retentionHours: 24, fs: { readFileSync: () => JSON.stringify({ ...manifest, ...over }) }, fileExists: () => true, now: () => at, ...extra });

	test("the grace boundary: more than SANDBOX_OPEN_GRACE_MS left opens, exactly that much or less is refused", () => {
		assert.equal(resolve(T - SANDBOX_OPEN_GRACE_MS - 1).refused, undefined);
		const edge = resolve(T - SANDBOX_OPEN_GRACE_MS);
		assert.equal(edge.refused, "past-window");
		assert.match(edge.message, /within 5 minutes of the end of its retention window \(2026-08-02T00:00:00\.000Z\)/);
		const past = resolve(T + 1);
		assert.equal(past.refused, "past-window");
		assert.match(past.message, /is past its retention window \(it closed at 2026-08-02T00:00:00\.000Z\)/);
		assert.match(past.message, /`pi-dispatch sandbox j1 --pin`/, "the refusal names the command that opens it");
	});

	test("with a pin requested it opens, past the window or not", () => {
		assert.equal(resolve(T + DAY_MS, {}, { pin: true }).refused, undefined);
	});

	test("an opener whose own window is LARGER than the worker's is still refused: it reads the deadline the worker wrote", () => {
		// The worker retained this with 24h and wrote retainUntil; this shell says 480h. Only a manifest from before the
		// key falls back to the shell's own window.
		assert.equal(resolve(T + HOUR_MS, {}, { retentionHours: 480 }).refused, "past-window");
		assert.equal(resolve(T + HOUR_MS, { retainUntil: undefined }, { retentionHours: 480 }).refused, undefined, "an old manifest: the reader's window, as before");
		assert.equal(resolve(T + HOUR_MS, { keepUntil: new Date(T + DAY_MS).toISOString() }).refused, undefined, "a live pin wins over both");
	});

	test("a manifest with no creation time is refused, since the sweep deletes it on sight", () => {
		assert.equal(resolve(T - DAY_MS, { createdAt: undefined, retainUntil: undefined }).refused, "past-window");
	});

	test("the run's own refusals come first: another venue is told as that, never as a pin away", () => {
		assert.equal(resolve(T + DAY_MS, { backend: "far" }).refused, "venue-unreachable");
	});
});

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

/**
 * A retention root in memory that the REAL store functions run on (the reaper, `pinSandbox`, `readManifest`), so the
 * races below are between the actual sweep and the actual pin. A write into a directory that is not there fails, as
 * it does on disk, which is how a pin loses to a rename.
 */
function memoryRoot(runs) {
	const files = { "/sbx": "<dir>" };
	for (const [id, m] of Object.entries(runs)) {
		files[`/sbx/${id}`] = "<dir>";
		files[`/sbx/${id}/manifest.json`] = JSON.stringify(m);
	}
	const enoent = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
	const parentOf = (p) => p.slice(0, p.lastIndexOf("/"));
	const fs = {
		lstatSync: (p) => {
			if (!(p in files)) throw enoent(p);
			return { isDirectory: () => files[p] === "<dir>", uid: 1000, gid: 1000, mode: 0o100600 };
		},
		readdirSync: (p) => {
			if (!(p in files)) throw enoent(p);
			return Object.keys(files).filter((k) => k.startsWith(`${p}/`) && !k.slice(p.length + 1).includes("/")).map((k) => k.slice(p.length + 1));
		},
		readFileSync: (p) => {
			if (!(p in files) || files[p] === "<dir>") throw enoent(p);
			return files[p];
		},
		writeFileSync: (p, body, o) => {
			if (!(parentOf(p) in files)) throw enoent(p);
			if (o?.flag === "wx" && p in files) throw Object.assign(new Error(`EEXIST: ${p}`), { code: "EEXIST" });
			files[p] = body;
		},
		chownSync: () => {},
		chmodSync: () => {},
		renameSync: (from, to) => {
			if (!(from in files) || !(parentOf(to) in files)) throw enoent(from);
			for (const k of Object.keys(files)) {
				if (k !== from && !k.startsWith(`${from}/`)) continue;
				files[`${to}${k.slice(from.length)}`] = files[k];
				delete files[k];
			}
		},
		rmSync: (p) => {
			for (const k of Object.keys(files)) if (k === p || k.startsWith(`${p}/`)) delete files[k];
		},
	};
	return { fs, files };
}

describe("an open racing the sweep (#446)", () => {
	const AT = Date.parse("2026-09-01T12:00:00Z");
	const expired = { jobId: "gh-1", kind: "github", image: "pi-job:latest", backend: "local", workspace: "/sbx/gh-1/workspace", createdAt: "2026-08-30T12:00:00.000Z", retainUntil: "2026-08-31T12:00:00.000Z", keepUntil: null };
	const opener = (root, over = {}) => ({
		jobId: "gh-1",
		sandboxDir: "/sbx",
		retentionHours: 24,
		egress: { armed: false, proxy: "p" },
		fs: root.fs,
		fileExists: () => true,
		now: () => AT,
		resolveJobUser: async () => ({ user: null, home: null }),
		running: async () => [],
		...over,
	});
	const pinFor = (root) => () => pinSandbox({ sandboxDir: "/sbx", jobId: "gh-1", pinDays: 7, fs: root.fs, now: () => AT, euid: 1000 });
	/** A sweep pass whose runtime ask waits on `gate`, as a slow `ps` does. */
	const slowPass = (root, gate, logs) => makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 24, fs: root.fs, now: () => AT, listRunning: async () => (await gate, []), log: (e, f) => logs.push([e, f]) })();

	test("window 1: an unpinned open while the sweep waits on the runtime is REFUSED, so no shell is under the delete", async () => {
		const root = memoryRoot({ "gh-1": expired });
		let release;
		const gate = new Promise((r) => (release = r));
		const logs = [];
		const sweeping = slowPass(root, gate, logs);
		let launched = false;
		const r = await openSandbox(opener(root, { launch: async () => ((launched = true), { code: 0 }) }));
		release();
		await sweeping;
		assert.equal(r.refused, "past-window");
		assert.equal(launched, false);
		assert.deepEqual(logs, [["reaped_sandbox", { entry: "gh-1", reason: "window" }]], "the sweep went ahead, with no shell under it");
	});

	test("window 1, pinned: the pin lands while the sweep waits, and the sweep's fresh read holds the run", async () => {
		const root = memoryRoot({ "gh-1": expired });
		let release;
		const gate = new Promise((r) => (release = r));
		const logs = [];
		const sweeping = slowPass(root, gate, logs);
		let mounted = null;
		const r = await openSandbox(opener(root, { pin: pinFor(root), launch: async () => ((mounted = "/sbx/gh-1/manifest.json" in root.files), { code: 0 }) }));
		release();
		await sweeping;
		assert.equal(r.code, 0);
		assert.equal(mounted, true);
		assert.ok("/sbx/gh-1/manifest.json" in root.files, "the run survives the pass");
		assert.deepEqual(logs, [["sandbox_reaper_skipped", { entry: "gh-1", reason: "manifest-changed" }]]);
	});

	test("the pin lands BEFORE any runtime call: a sweep deciding during the open's first runtime ask is held", async () => {
		// The pass read the run (unpinned, expired) and is waiting on its runtime; the open resolves, and the sweep then
		// finishes while the open is asking ITS runtime whether the sandbox is up. With the pin where it used to be (in
		// `beforeLaunch`, after that ask and the job-user decision) the pass deleted the run there and the pin failed.
		const root = memoryRoot({ "gh-1": expired });
		let release;
		const gate = new Promise((r) => (release = r));
		const logs = [];
		const sweeping = slowPass(root, gate, logs);
		const order = [];
		let mounted = null;
		const r = await openSandbox(
			opener(root, {
				pin: () => (order.push("pin"), pinFor(root)()),
				running: async () => {
					order.push("running");
					release();
					await sweeping;
					return [];
				},
				resolveJobUser: async () => (order.push("jobUser"), { user: null, home: null }),
				launch: async () => ((mounted = "/sbx/gh-1/manifest.json" in root.files), { code: 0 }),
			}),
		);
		assert.deepEqual(order.slice(0, 2), ["pin", "running"], "the pin first");
		assert.equal(r.refused, undefined, JSON.stringify(r));
		assert.equal(mounted, true, "the launch binds the run's own directory");
		assert.deepEqual(logs, [["sandbox_reaper_skipped", { entry: "gh-1", reason: "manifest-changed" }]]);
	});

	test("a pin that fails REFUSES the open before any runtime call, never a warning above a shell", async () => {
		for (const [pin, why] of [
			[() => ({ pinned: false, reason: "absent" }), /its retained workspace is gone/],
			[() => ({ pinned: false, reason: "EPERM: operation not permitted" }), /EPERM/],
			[() => {
				throw new Error("disk on fire");
			}, /disk on fire/],
		]) {
			const root = memoryRoot({ "gh-1": expired });
			const asked = [];
			const r = await openSandbox(opener(root, { pin, running: async () => (asked.push("running"), []), resolveJobUser: async () => (asked.push("jobUser"), { user: null, home: null }), launch: async () => (asked.push("launch"), { code: 0 }) }));
			assert.equal(r.refused, "pin-failed");
			assert.match(r.message, why);
			assert.deepEqual(asked, []);
		}
		// And a refusal that costs nothing comes before the pin: a refused open leaves no pin behind.
		const root = memoryRoot({ "gh-1": expired });
		const pinned = [];
		const r = await openSandbox(opener(root, { publish: ["-p", "127.0.0.1:3000:3000"], egress: { armed: true, proxy: "p" }, pin: () => (pinned.push(1), { pinned: true }) }));
		assert.equal(r.refused, "publish-needs-egress-off");
		assert.deepEqual(pinned, []);
	});

	test("the post-launch look: a run gone once the container is listed has its container removed and is reported (#446)", async () => {
		const root = memoryRoot({ "gh-1": { ...expired, keepUntil: new Date(AT + DAY_MS).toISOString() } });
		let finish;
		const stopped = [];
		let listed = false;
		const r = await openSandbox(
			opener(root, {
				running: async () => (listed ? ["gh-1"] : []),
				pause: async () => {},
				launch: async () => {
					// The sweep's rename and the runtime's start raced: the directory is not at the run's name any more.
					root.fs.renameSync("/sbx/gh-1", "/sbx/.reap-1-2-3");
					listed = true;
					// The shell "exits" on its own a moment later, so a look that never stops it fails here rather than hangs;
					// the look itself runs on microtasks, long before this.
					return new Promise((resolve) => {
						finish = resolve;
						setTimeout(() => resolve({ code: -1 }), 10_000).unref();
					});
				},
				stop: async ({ bin, name }) => (stopped.push(`${bin} ${name}`), finish({ code: 137 }), true),
			}),
		);
		assert.deepEqual(stopped, ["docker pi-sandbox-gh-1"]);
		assert.equal(r.refused, "swept-at-launch");
		assert.match(r.message, /deleted or replaced as this sandbox started, so the sandbox was stopped/);
	});

	test("the post-launch look keeps watching a run in place, and a transient, unreadable or unparsed read never stops the shell (#446)", async () => {
		const root = memoryRoot({ "gh-1": { ...expired, keepUntil: new Date(AT + DAY_MS).toISOString() } });
		const stopped = [];
		let listed = false;
		let finish;
		// After the container is listed, the look's reads of the manifest go: fine, a transient errno, a permanent one, a
		// manifest caught unparseable, then fine again. None of those says the run is gone.
		const faults = ["EMFILE", "EACCES", "unparsed"];
		let checks = 0;
		const read = root.fs.readFileSync;
		root.fs.readFileSync = (p) => {
			if (!listed || !p.endsWith("/gh-1/manifest.json")) return read(p);
			const fault = faults[checks++ - 1];
			if (fault === "unparsed") return "{";
			if (fault) throw Object.assign(new Error(fault), { code: fault });
			return read(p);
		};
		const done = openSandbox(
			opener(root, {
				running: async () => (listed ? ["gh-1"] : []),
				pause: () => new Promise((resolve) => setImmediate(resolve)),
				launch: async () => {
					listed = true;
					return new Promise((resolve) => (finish = resolve));
				},
				stop: async () => (stopped.push(1), true),
			}),
		);
		for (let i = 0; i < 200 && checks < 6; i++) await new Promise((r) => setImmediate(r));
		assert.ok(checks >= 6, `the look kept watching after the first check (${checks})`);
		finish({ code: 4 });
		const r = await done;
		assert.equal(r.code, 4);
		assert.deepEqual(stopped, []);
	});

	test("the accepted residual: a worker window LOWERED below the opener's admits an open the sweep then takes, and the look reports it (#446)", async () => {
		// Retained under 24h (retainUntil 14h out), the worker since lowered to 6h, the opener still at 24h: the opener's
		// earlier-of rule sees 14h left and admits it; the worker's sees it 4h expired. The pass runs as the container
		// starts and before it is listed, so nothing holds the run; the post-launch look is what reports it.
		const retained = { ...expired, createdAt: new Date(AT - 10 * HOUR_MS).toISOString(), retainUntil: new Date(AT + 14 * HOUR_MS).toISOString() };
		const root = memoryRoot({ "gh-1": retained });
		const logs = [];
		let listed = false;
		let finish;
		const stopped = [];
		const r = await openSandbox(
			opener(root, {
				running: async () => (listed ? ["gh-1"] : []),
				// A macrotask per look, as the real 250 ms timer is: the pass below yields between trees, and a look on
				// microtasks alone would spend all its tries before the container is listed.
				pause: () => new Promise((resolve) => setImmediate(resolve)),
				launch: async () => {
					await makeSandboxReaper({ sandboxDir: "/sbx", retentionHours: 6, fs: root.fs, now: () => AT, log: (e, f) => logs.push([e, f]) })();
					listed = true;
					return new Promise((resolve) => {
						finish = resolve;
						setTimeout(() => resolve({ code: -1 }), 10_000).unref();
					});
				},
				stop: async ({ name }) => (stopped.push(name), finish({ code: 137 }), true),
			}),
		);
		assert.deepEqual(logs, [["reaped_sandbox", { entry: "gh-1", reason: "window" }]], "the shorter worker window applies");
		assert.equal(r.refused, "swept-at-launch");
		assert.deepEqual(stopped, ["pi-sandbox-gh-1"]);
	});

	test("the look stops the moment the shell returns, abandoning a runtime ask in flight (#446)", async () => {
		const root = memoryRoot({ "gh-1": { ...expired, keepUntil: new Date(AT + DAY_MS).toISOString() } });
		let first = true;
		let signalled = null;
		let askSettled = false;
		let finish;
		const done = openSandbox(
			opener(root, {
				// The opener's own already-running ask answers; the look's ask hangs (a wedged `ps`) until it is aborted.
				running: ({ signal } = {}) => {
					if (first) return ((first = false), Promise.resolve([]));
					signalled = signal ?? null;
					// A wedged `ps` that answers only at its own timeout: far past anything the test waits for, and `unref`'d, so
					// "returned without waiting out the hung ask" is never a race against a short timer (PR #466 gate round 2).
					return new Promise((resolve) => setTimeout(() => ((askSettled = true), resolve([])), 10_000).unref());
				},
				pause: async () => {},
				launch: async () => new Promise((resolve) => (finish = resolve)),
			}),
		);
		for (let i = 0; i < 20 && !signalled; i++) await new Promise((r) => setImmediate(r));
		assert.ok(signalled, "the look's ask carries a signal");
		finish({ code: 3 });
		const r = await done;
		assert.equal(r.code, 3);
		assert.equal(askSettled, false, "returned without waiting out the hung ask");
		assert.equal(signalled.aborted, true, "and the ask was aborted");
	});

	test("listRunningSandboxes hands a signal to its runner, and only when given one (#446)", async () => {
		const seen = [];
		const execFn = async (bin, args, opts) => (seen.push(opts), { stdout: "" });
		const controller = new AbortController();
		await listRunningSandboxes({ execFn, signal: controller.signal });
		await listRunningSandboxes({ execFn });
		assert.deepEqual(seen, [{ timeout: 5000, signal: controller.signal }, { timeout: 5000 }]);
	});

	test("the runtime watch never places a tombstone, and a dot id's container is named off its retained directory (#446)", async () => {
		const root = memoryRoot({ ".reap-1-2-3": { jobId: "gone", backend: "podman", createdAt: "2026-01-01T00:00:00Z" } });
		const asked = [];
		const watch = makeSandboxRuntimeWatch({ sandboxDir: "/sbx", fs: root.fs, list: async ({ bin }) => (asked.push(bin), []), readPodmanStore: async () => null, log: () => {} });
		assert.deepEqual(await watch.listRunning(), []);
		assert.deepEqual(asked, [], "no runtime is asked about a tombstone");
		assert.equal(sandboxContainerName(".reap-9"), "pi-sandbox-_.reap-9");
	});

	test("the runtime watch's isOpen asks the run's own runtime, every runtime present for a run with no manifest, and throws when unanswered (#446)", async () => {
		const asked = [];
		let fail = false;
		// `blessed` puts docker in the runtimes present, so "nobody asked" below is a property of the absent manifest.
		const watch = makeSandboxRuntimeWatch({ sandboxDir: "/sbx", blessed: ["local"], fs: memoryRoot({}).fs, list: async ({ bin }) => {
			asked.push(bin);
			if (fail) throw new Error("down");
			return ["p-1"];
		}, readPodmanStore: async () => null, log: () => {} });
		assert.equal(await watch.isOpen({ name: "p-1", read: { manifest: { backend: "podman" } } }), true);
		assert.equal(await watch.isOpen({ name: "d-1", read: { manifest: { backend: "local" } } }), false);
		assert.deepEqual(asked, ["podman", "docker"]);
		// PR #466 gate round 1: no manifest file is a run this cannot place, so every runtime present is asked.
		assert.equal(await watch.isOpen({ name: "none", read: { absent: true } }), false);
		assert.deepEqual(asked, ["podman", "docker", "docker"], "no manifest file: docker, the runtime present, asked");
		assert.equal(await watch.isOpen({ name: "p-1", read: { absent: true } }), true, "and one it reports open is open");
		fail = true;
		await assert.rejects(watch.isOpen({ name: "d-1", read: { manifest: { backend: "local" } } }), /down/);
	});

	test("a dot id is checked for an open sandbox under its RETAINED name, which is what the runtime reports (#446)", async () => {
		const root = memoryRoot({ "_.x": { ...expired, jobId: ".x", workspace: "/sbx/_.x/workspace", keepUntil: new Date(AT + DAY_MS).toISOString() } });
		let launched = false;
		const r = await openSandbox(opener(root, { jobId: ".x", running: async () => ["_.x"], launch: async () => ((launched = true), { code: 0 }) }));
		assert.equal(r.refused, "already-running");
		assert.match(r.message, /pi-sandbox-_\.x/);
		assert.equal(launched, false);
	});

	test("a directory holding ANOTHER run than the id asked for is refused by name (#446)", () => {
		const root = memoryRoot({ repeat_a_1: { ...expired, jobId: "repeat_a_1", workspace: "/w", keepUntil: new Date(AT + DAY_MS).toISOString() } });
		const r = resolveSandbox({ jobId: "repeat:a:1", sandboxDir: "/sbx", retentionHours: 24, fs: root.fs, fileExists: () => true, now: () => AT });
		assert.equal(r.refused, "id-mismatch");
		assert.match(r.message, /holds run repeat_a_1, not repeat:a:1/);
		assert.equal(resolveSandbox({ jobId: "repeat_a_1", sandboxDir: "/sbx", retentionHours: 24, fs: root.fs, fileExists: () => true, now: () => AT }).refused, undefined);
	});
});

// --- issue #446, gate round 1: the same races on a REAL filesystem -----------------------------------------------

describe("the #446 races on a real filesystem (gate round 1)", () => {
	const AT = Date.parse("2026-09-01T12:00:00Z");
	const H = 3600000;
	/** A retention root with one retained run `id` in it, its workspace holding the operator's file. */
	const realRoot = (id, over = {}) => {
		const sbx = tempDir("sbx446-");
		const dir = join(sbx, id);
		mkdirSync(join(dir, "workspace"), { recursive: true });
		writeFileSync(join(dir, "workspace", "work.txt"), "operator's work");
		const manifest = { jobId: id, kind: "github", image: "pi-job:latest", backend: "local", workspace: join(dir, "workspace"), createdAt: new Date(AT - 10 * H).toISOString(), retainUntil: new Date(AT + 14 * H).toISOString(), keepUntil: null, ...over };
		writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
		return { sbx, dir, manifest };
	};
	const opener = (sbx, over) => ({ jobId: "gh-1", sandboxDir: sbx, retentionHours: 24, egress: { armed: false, proxy: "p" }, now: () => AT, resolveJobUser: async () => ({ user: null, home: null }), pause: () => new Promise((resolve) => setImmediate(resolve)), ...over });

	/**
	 * The adversary's shape: the worker's window was LOWERED to 6h, the opener's is 24h, and the pass's `ps` answers
	 * "none" only after the container is listed and the post-launch look has already found the run in place.
	 */
	const adversary = async ({ wired }) => {
		const { sbx, dir } = realRoot("gh-1");
		let listed = false;
		let finish;
		const stopped = [];
		const logs = [];
		const r = await openSandbox(
			opener(sbx, {
				running: async () => (listed ? ["gh-1"] : []),
				launch: async () => {
					await makeSandboxReaper({
						sandboxDir: sbx,
						retentionHours: 6,
						now: () => AT,
						listRunning: async () => {
							listed = true;
							for (let i = 0; i < 50; i++) await new Promise((res) => setImmediate(res));
							return [];
						},
						// The runtime watch's own re-ask, answered by the same runtime the opener asks.
						...(wired ? { isOpen: async ({ name }) => (listed ? ["gh-1"] : []).includes(name) } : {}),
						log: (e, f) => logs.push([e, f]),
					})();
					return new Promise((resolve) => {
						finish = resolve;
						setTimeout(() => resolve({ code: 0 }), 200);
					});
				},
				stop: async ({ name }) => (stopped.push(name), finish?.({ code: 137 }), true),
			}),
		);
		return { r, stopped, logs, kept: existsSync(join(dir, "workspace", "work.txt")) };
	};

	test("the pass re-asks the run's runtime before the rename, and holds a run whose sandbox opened during the pass", async () => {
		const { r, stopped, logs, kept } = await adversary({ wired: true });
		assert.deepEqual(logs, [["sandbox_reaper_skipped", { entry: "gh-1", reason: "opened-during-pass" }]]);
		assert.equal(kept, true, "the operator's work is still there");
		assert.deepEqual(stopped, []);
		assert.equal(r.code, 0);
	});

	test("without the re-ask, the look keeps watching, never removes a shell past its launch check, and reports the loss when it exits", async () => {
		// Gate round 2: after the launch check the shell may hold state outside the mounts, so a loss is RECORDED, not
		// acted on, and said when the shell returns.
		const { r, stopped, logs, kept } = await adversary({ wired: false });
		assert.deepEqual(logs, [["reaped_sandbox", { entry: "gh-1", reason: "window" }]]);
		assert.equal(kept, false);
		assert.deepEqual(stopped, [], "the live shell is left alone");
		assert.equal(r.refused, undefined);
		assert.equal(r.code, 0, "the shell's own exit");
		assert.equal(r.lost, "swept");
		assert.match(r.message, /DELETED while this sandbox was open \(by the retention sweep/);
	});

	test("a run REPLACED after the launch check (a retry's retainJobDir) is recorded and said, and the shell left alone", async () => {
		const { sbx, dir } = realRoot("gh-1");
		let listed = false;
		let finish;
		const stopped = [];
		let checks = 0;
		const read = realFs.readFileSync;
		const fs = {
			...realFs,
			readFileSync: (p, o) => {
				// After the launch check has passed, the directory is replaced by a fresh one with a manifest.
				if (listed && p === join(dir, "manifest.json") && ++checks === 2) {
					const body = read(p);
					renameSync(dir, join(sbx, "gone-old"));
					mkdirSync(dir);
					writeFileSync(p, body);
					// The shell exits once the watch has made the read that sees the replacement (this one), never on a
					// timer that the watch has to beat (PR #466 gate round 2).
					setImmediate(() => finish({ code: 5 }));
				}
				return read(p, o);
			},
		};
		const r = await openSandbox(
			opener(sbx, {
				fs,
				fileExists: () => true,
				running: async () => (listed ? ["gh-1"] : []),
				launch: async () => {
					listed = true;
					return new Promise((resolve) => {
						finish = resolve;
						setTimeout(() => resolve({ code: -1 }), 10_000).unref();
					});
				},
				stop: async ({ name }) => (stopped.push(name), finish?.({ code: 137 }), true),
			}),
		);
		assert.deepEqual(stopped, []);
		assert.equal(r.code, 5);
		assert.equal(r.lost, "replaced");
		assert.match(r.message, /REPLACED while this sandbox was open/);
	});

	test("a runtime that REFUSES the bind of a swept run (podman: statfs, exit 125) is reported as swept, not a bare 125", async () => {
		const { sbx, dir } = realRoot("gh-1");
		const r = await openSandbox(
			opener(sbx, {
				running: async () => [],
				launch: async () => {
					realFs.rmSync(dir, { recursive: true, force: true });
					return { code: 125 };
				},
			}),
		);
		assert.equal(r.refused, "swept-at-launch");
		assert.match(r.message, /the runtime refused the mount, exit 125/);
		// And a 125 with the run in place is the runtime's own, left as it was.
		const other = realRoot("gh-1");
		const plain = await openSandbox(opener(other.sbx, { running: async () => [], launch: async () => ({ code: 125 }) }));
		assert.equal(plain.code, 125);
		assert.equal(plain.refused, undefined);
	});

	test("only a 125 from a container never listed is the runtime refusing the mount; any other exit with the run gone is LOST, from a check at exit (#446 gate round 3)", async () => {
		// A shell that ran and exited 1, never listed (its `ps` answered nothing): the run was deleted while it ran.
		const a = realRoot("gh-1");
		const ran = await openSandbox(opener(a.sbx, { running: async () => [], launch: async () => (realFs.rmSync(a.dir, { recursive: true, force: true }), { code: 1 }) }));
		assert.equal(ran.refused, undefined);
		assert.deepEqual([ran.code, ran.lost], [1, "swept"]);
		// Its `ps` failing throughout: never listed, never touched, and still told at exit.
		const b = realRoot("gh-1");
		const failing = await openSandbox(
			opener(b.sbx, {
				running: async () => {
					throw new Error("ps down");
				},
				launch: async () => (realFs.rmSync(b.dir, { recursive: true, force: true }), { code: 0 }),
			}),
		);
		assert.deepEqual([failing.code, failing.lost], [0, "swept"]);
		// A 125 from a container that WAS listed is not a refused mount either.
		const c = realRoot("gh-1");
		let listed = false;
		const stopped = [];
		// Deleted only once the look has listed the container and made its launch check (the macrotask after that
		// answer), never after a 50 ms window the look had to land in (PR #466 gate round 2).
		let lookListed;
		const listedByLook = new Promise((resolve) => (lookListed = resolve));
		const seen = await openSandbox(
			opener(c.sbx, {
				running: async () => (listed ? (lookListed(), ["gh-1"]) : []),
				stop: async () => (stopped.push(1), true),
				launch: async () => {
					listed = true;
					await listedByLook;
					await new Promise((r) => setImmediate(r));
					realFs.rmSync(c.dir, { recursive: true, force: true });
					return { code: 125 };
				},
			}),
		);
		assert.equal(seen.refused, undefined);
		assert.deepEqual([seen.code, seen.lost, stopped], [125, "swept", []]);
	});

	test("a container never listed is watched for the whole session but never removed, and a brief loss is still reported (#446 gate round 3)", async () => {
		// NO WALL-CLOCK WINDOWS (PR #466 gate round 2: the 60 ms rename window below flaked once under full-suite load).
		// The launch waits on the look's own read of the run's directory, taken from an `lstatSync` hook, so each loss is
		// seen by the watch because the test waited for the watch to look, not because a timer happened to land.
		const watched = (dir) => {
			let wake = null;
			return {
				fs: { ...realFs, lstatSync: (p, o) => (p === dir && wake ? (wake(), (wake = null)) : null, realFs.lstatSync(p, o)) },
				// A 10 s guard so a watch that never reads fails the assertions below instead of hanging; it decides no ordering.
				nextRead: () =>
					new Promise((resolve) => {
						const guard = setTimeout(resolve, 10_000);
						wake = () => (clearTimeout(guard), resolve());
					}),
			};
		};
		// `ps` fails throughout, so the look never lists the container and spends its asking budget; then the run goes.
		const gone = realRoot("gh-1");
		const goneWatch = watched(gone.dir);
		const stopped = [];
		const r = await openSandbox(
			opener(gone.sbx, {
				fs: goneWatch.fs,
				running: async () => {
					throw new Error("ps down");
				},
				stop: async () => (stopped.push(1), true),
				launch: async () => {
					// Gone while the look watches: the watch reads it gone, and still does not remove the container.
					realFs.rmSync(gone.dir, { recursive: true, force: true });
					await goneWatch.nextRead();
					return { code: 0 };
				},
			}),
		);
		assert.deepEqual(stopped, [], "never removed: it was never known to be a fresh shell");
		assert.deepEqual([r.refused, r.lost], [undefined, "swept"]);
		// And a loss the exit check alone cannot see (the directory renamed away and back, same inode) is seen by the
		// watch, which keeps running after the asking budget.
		const back = realRoot("gh-1");
		const backWatch = watched(back.dir);
		const r2 = await openSandbox(
			opener(back.sbx, {
				fs: backWatch.fs,
				running: async () => {
					throw new Error("ps down");
				},
				launch: async () => {
					renameSync(back.dir, join(back.sbx, "away"));
					// Back only once the watch has read the run's path while it was away.
					await backWatch.nextRead();
					renameSync(join(back.sbx, "away"), back.dir);
					return { code: 0 };
				},
			}),
		);
		assert.equal(r2.lost, "swept");
		assert.ok(realFs.existsSync(join(back.dir, "manifest.json")), "and the run is back in place, so only the watch could have seen it");
	});

	test("a run retained BEFORE the escape (`_x`) is found, opened and held under its old name (#446 gate round 2)", async () => {
		const { sbx } = realRoot("_x", { jobId: "_x", keepUntil: new Date(AT + DAY_MS).toISOString() });
		const r = resolveSandbox({ jobId: "_x", sandboxDir: sbx, retentionHours: 24, now: () => AT });
		assert.equal(r.refused, undefined, JSON.stringify(r));
		assert.equal(r.name, "pi-sandbox-_x", "named off the directory it was found in, which the sweep holds by");
		assert.equal(resolveSandbox({ jobId: ".x", sandboxDir: sbx, retentionHours: 24, now: () => AT }).refused, "absent", "and never under another id");
		let launched = null;
		const open = await openSandbox(opener(sbx, { jobId: "_x", running: async () => ["_x"], launch: async ({ args }) => ((launched = args), { code: 0 }) }));
		assert.equal(open.refused, "already-running", "the running check keys off the same directory name");
		assert.equal(launched, null);
	});

	test("a directory REPLACED at the run's path (another inode) is seen by the look, whatever its manifest says", async () => {
		const { sbx, dir } = realRoot("gh-1");
		let listed = false;
		let finish;
		const stopped = [];
		const r = await openSandbox(
			opener(sbx, {
				running: async () => (listed ? ["gh-1"] : []),
				launch: async () => {
					// A fresh directory with a byte-identical manifest where the run was: only its inode differs.
					const away = join(sbx, "elsewhere");
					renameSync(dir, away);
					mkdirSync(dir);
					writeFileSync(join(dir, "manifest.json"), readFileSync(join(away, "manifest.json")));
					listed = true;
					return new Promise((resolve) => {
						finish = resolve;
						setTimeout(() => resolve({ code: -1 }), 10_000).unref();
					});
				},
				stop: async ({ name }) => (stopped.push(name), finish?.({ code: 137 }), true),
			}),
		);
		assert.equal(r.refused, "swept-at-launch");
		assert.deepEqual(stopped, ["pi-sandbox-gh-1"]);
	});

	test("a pin between the fresh read and the rename, with the name taken by an empty directory, keeps the pinned run on disk", async () => {
		const { sbx, dir } = realRoot("gh-2", { jobId: "gh-2", createdAt: new Date(AT - 48 * H).toISOString(), retainUntil: new Date(AT - 24 * H).toISOString() });
		let pinned = null;
		const fs = {
			...realFs,
			renameSync: (from, to) => {
				if (from === dir && to.includes(".reap-")) {
					pinned = pinSandbox({ sandboxDir: sbx, jobId: "gh-2", pinDays: 7, now: () => AT });
					realFs.renameSync(from, to);
					realFs.mkdirSync(from); // a runtime's auto-created bind source
					return;
				}
				return realFs.renameSync(from, to);
			},
		};
		const reap = makeSandboxReaper({ sandboxDir: sbx, retentionHours: 24, fs, now: () => AT, pid: 4242 });
		await reap();
		await reap();
		assert.equal(pinned.pinned, true);
		assert.equal(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")).keepUntil, pinned.keepUntil, "the pinned run is under its name");
		assert.equal(readFileSync(join(dir, "workspace", "work.txt"), "utf8"), "operator's work");
		assert.deepEqual(readdirSync(sbx).filter((n) => n.startsWith(".reap-")), []);
	});
});

test("a sandbox's container is removed AT ONCE on each runtime: podman needs --time=0, docker's rm -f already kills (#446)", async () => {
	// Measured on pd-fedora (#457 gate): bash under --init ignores SIGTERM, and podman's rm -f waited its 10 s stop timeout,
	// past this call's own 10 000 ms bound, so the shell stayed up.
	const seen = [];
	const run = async (args, opts) => (seen.push([opts.bin, args.join(" "), opts.timeoutMs]), { code: 0 });
	assert.equal(await stopSandbox({ bin: "podman", name: "pi-sandbox-gh-1", run }), true);
	assert.equal(await stopSandbox({ bin: "docker", name: "pi-sandbox-gh-1", run }), true);
	assert.deepEqual(seen, [
		["podman", "rm -f --time=0 pi-sandbox-gh-1", 10000],
		["docker", "rm -f pi-sandbox-gh-1", 10000],
	]);
	assert.equal(await stopSandbox({ bin: "docker", name: "x", run: async () => ({ code: 1 }) }), false);
	assert.equal(await stopSandbox({ bin: "docker", name: "x", run: async () => { throw new Error("boom"); } }), false);
});

test("an egress-armed podman sandbox is not opened while the keeper does not hold, since its own teardown is #458's trigger (#452 gate round 2)", async () => {
	const refusal = { refused: "netns-keeper-not-holding", message: "the keeper is not holding" };
	const asked = [];
	const blocked = podmanSession({ keeperCheck: async (o) => (asked.push(o), refusal) });
	let launched = false;
	const r = await openSandbox({ ...blocked.opts, launch: async () => ((launched = true), { code: 0 }) });
	assert.deepEqual(r, refusal);
	assert.deepEqual(asked, [{ proxy: "pi-dispatch-egress-proxy" }]);
	assert.equal(launched, false);
	assert.deepEqual(blocked.calls, [], "no network was made, so no teardown can run");
	// Egress off: nothing to tear down under a proxy, and nothing asked.
	const off = [];
	const unarmed = podmanSession({ keeperCheck: async (o) => (off.push(o), refusal) });
	await openSandbox({ ...unarmed.opts, egress: { armed: false, proxy: "pi-dispatch-egress-proxy" } });
	assert.deepEqual(off, []);
});

test("sandboxKeeperCheck is the worker's own keeper preflight: refused on 4.x without a holding keeper, nothing on 5.x (#452 gate round 2)", async () => {
	const NOW = Date.now();
	const info = (version) => async () => ({ answered: true, info: { version } });
	const reads = (keeper) => async (args) => (args[0] === "inspect" && args.at(-1) === "pi-dispatch-netns-keeper" ? keeper : { code: 0, stdout: `${NOW - 120_000}\n` });
	const absent = { code: 125, stdout: "" };
	const refused = await sandboxKeeperCheck({ proxy: "pi-dispatch-egress-proxy", info: info("4.9.3"), readKeeper: reads(absent) });
	assert.equal(refused.refused, "netns-keeper-not-holding");
	assert.match(refused.message, /^the rootless network keeper pi-dispatch-netns-keeper is not under this account's Podman, and on Podman 4\.9\.3 a job network's teardown would then cut the egress proxy's route out \(issue #458\), so this sandbox is not opened: closing it tears its network down under the proxy, which is that same teardown\. To fix it, start it as the worker's account: /);
	assert.equal(await sandboxKeeperCheck({ proxy: "pi-dispatch-egress-proxy", info: info("5.8.1"), readKeeper: reads(absent) }), null);
	const holding = { code: 0, stdout: `running|bridge|pi-dispatch-netns-keeper,|${NOW - 130_000}\n` };
	assert.equal(await sandboxKeeperCheck({ proxy: "pi-dispatch-egress-proxy", info: info("4.9.3"), readKeeper: reads(holding) }), null);
});

test("the sandbox sweep's runner hands the CLI's stderr on, so the podman-docker `.Containers` fallback fires there (#452 gate round 3)", async () => {
	// MEASURED (gate round 3, dbg-shim-sandbox-runner-ubuntu.txt): through podman-docker on 4.9.3 the `.Containers` read exits
	// 125, `execFile` puts the template error in the callback's stderr and in `err.message`, and `err.stderr` is EMPTY. The
	// runner read `error.stderr`, so the fallback's wording never reached `networkEndpoints` and every network read as
	// unreadable in this sweep.
	const TEMPLATE = "Error: template: inspect:1:8: executing \"inspect\" at <.Containers>: can't evaluate field Containers in type interface {}\n";
	const calls = [];
	const fake = (bin, args, opts, cb) => {
		calls.push({ args, opts });
		queueMicrotask(() => {
			if (args[1] === "inspect" && args.includes("{{json .Containers}}")) return cb(Object.assign(new Error(`Command failed: docker ${args.join(" ")}\n${TEMPLATE}`), { code: 125 }), "", TEMPLATE);
			if (args[0] === "ps") return cb(null, "pi-dispatch-egress-proxy\trunning\n", "");
			if (args[1] === "inspect") return cb(null, "[{}]", "");
			return cb(null, "", "");
		});
		return { kill() {} };
	};
	const run = boundedRuntime("docker", { execFileFn: fake });
	const inspected = await run(["network", "inspect", "--format", "{{json .Containers}}", "pi-sandbox-a-net"]);
	assert.equal(inspected.code, 125);
	assert.match(inspected.stderr, /can't evaluate field Containers/, "the callback's stderr, not the error's (which is empty)");
	const { networkEndpoints } = await import("../src/egress.mjs");
	assert.deepEqual(await networkEndpoints(run, "pi-sandbox-a-net"), { ok: true, absent: false, names: ["pi-dispatch-egress-proxy"], parked: [] }, "the fallback fired through the sweep's own runner");
	// And the gate's runtime read asks with the facts readers' bound, not the verbs' 10 s and 64 KiB.
	await run(["info", "--format={{json .}}"], { timeoutMs: 15_000, maxBuffer: 1024 * 1024 });
	assert.equal(calls.at(-1).opts.maxBuffer, 1024 * 1024);
});

test("the session sweep reads the runtime and the keeper ONCE per pass, however many networks it holds back (#452 gate round 3)", async () => {
	const d = fakeNetDaemon({ nets: { "pi-sandbox-a-net": ["pi-dispatch-egress-proxy"], "pi-sandbox-b-net": ["pi-dispatch-egress-proxy"], "pi-sandbox-c-net": ["pi-dispatch-egress-proxy"] }, podmanVersion: "4.9.3" });
	const out = await makeSandboxNetworkSweeper({ bin: "podman", run: d.run })({ retained: () => [] });
	assert.deepEqual(out.notes.map((n) => n.reason), ["keeper-not-holding", "keeper-not-holding", "keeper-not-holding"]);
	assert.equal(d.calls.filter((c) => c.startsWith("info ")).length, 1, "one runtime read for the pass");
	assert.equal(d.calls.filter((c) => c.startsWith("inspect ")).length, 1, "one keeper read for the pass");
	// A new pass reads again: the keeper may have been started since.
	await makeSandboxNetworkSweeper({ bin: "podman", run: d.run })({ retained: () => [] });
	assert.equal(d.calls.filter((c) => c.startsWith("info ")).length, 2);
});
