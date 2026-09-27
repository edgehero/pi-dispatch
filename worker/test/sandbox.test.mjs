import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { ISOLATION_FLAGS, PODMAN_PINNED_FLAGS, buildDockerRunArgs, buildPodmanRunArgs } from "../src/docker-run.mjs";
import { WORKER_ONLY_SECRET_VARS } from "../src/config.mjs";
import { MINTED_TOKEN_VARS } from "../src/forges.mjs";
import { SANDBOX_LAUNCHERS, SANDBOX_NAME_PREFIX, SANDBOX_NETWORK_SHAPE, buildSandboxRunArgs, combineSandboxNetworkSweepers, decideSandboxJobUser, launchSandbox, listRunningSandboxes, makeSandboxNetworkSweeper, makeSandboxRuntimeWatch, openSandbox, parsePublish, resolveSandbox, sandboxContainerName, sandboxEgress, sandboxLauncher, sandboxVenuePolicy, sandboxVenueRefusal, sandboxVenues } from "../src/sandbox.mjs";
import { networkNameFor } from "../src/egress.mjs";
import { makeSandboxReaper } from "../src/sandbox-store.mjs";

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

	assert.match(resolveSandbox({ jobId: "j1", sandboxDir: "/s", retentionHours: 0, fs: missing }).message, /PI_SANDBOX_RETENTION_HOURS/);
	assert.match(resolveSandbox({ jobId: "j1", sandboxDir: "/s", retentionHours: 24, fs: missing }).message, /swept after 24h/);
	assert.equal(resolveSandbox({ jobId: "", sandboxDir: "/s", retentionHours: 24, fs: missing }).refused, "no-job-id");
	assert.equal(resolveSandbox({ jobId: "j1", sandboxDir: "/s", retentionHours: 24, fs: fsWith({ ...manifest, image: null }) }).refused, "no-image");

	const gone = resolveSandbox({ jobId: "j1", sandboxDir: "/s", retentionHours: 24, fs: fsWith(manifest), fileExists: () => false });
	assert.equal(gone.refused, "workspace-gone");
	assert.match(gone.message, /\/w/, "the missing path IS the diagnosis, so it must appear");
});

test("resolveSandbox refuses a run from a venue this host did not run, ahead of the image and the workspace (#277)", () => {
	const manifest = { jobId: "j1", kind: "github", image: "pi-job:latest", workspace: "/w", createdAt: "2026-08-01T00:00:00Z" };
	const fsWith = (m) => ({ readFileSync: () => JSON.stringify(m) });
	const resolve = (m, fileExists = () => true) => resolveSandbox({ jobId: "j1", sandboxDir: "/s", retentionHours: 24, fs: fsWith(m), fileExists });

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
	return { fs: { readFileSync: () => JSON.stringify(manifest) }, fileExists: () => true };
}

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
const session = { jobId: "gh-1", sandboxDir: "/s", retentionHours: 24, term: "xterm", idleSeconds: 1800, running: async () => [], resolveJobUser: async () => ({ user: null, home: null }) };

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
		// The hook first: a throw there (a failed pin) must not leave a network behind, so it runs before one exists.
		"beforeLaunch",
		"docker network create --internal pi-sandbox-gh-1-net",
		"docker network connect pi-sandbox-gh-1-net pi-dispatch-egress-proxy",
		"launch",
		"docker network disconnect -f pi-sandbox-gh-1-net pi-dispatch-egress-proxy",
		"docker network rm pi-sandbox-gh-1-net",
	], "hook, built before the launch, torn down after it -- and nothing is removed before the build");
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
	const exists = await openSandbox({
		...session,
		...openable(),
		egress: { armed: true, proxy: "my-proxy" },
		spawnNetwork: recordingDocker(calls, (args) => (args[1] === "create" ? 1 : 0)),
		launch: async () => ((launched = true), { code: 0 }),
	});
	assert.equal(exists.refused, "egress-network-exists");
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
		launch: async () => ({ code: 0 }),
	});
	assert.equal(missing.refused, "egress-network-failed");
	assert.match(missing.message, /is the proxy running\?.*read from this process's environment/);
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
function fakeNetDaemon({ nets = {}, fail = {}, containers = {} } = {}) {
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
	assert.match(left.message, /\$\(podman network inspect .*podman network disconnect -f .*; podman network rm pi-sandbox-gh-1-net/);
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
	assert.match(src, /export function makeSandboxNetworkSweeper\(\{ bin = "docker", run = boundedRuntime\(bin\) \} = \{\}\)/);
	assert.match(src, /execDockerBounded\(args, \{ timeoutMs: 10_000, bin \}\)/);
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
			// The guard sees the run finished, then the recovery look sees it in `state`.
			if (args[0] === "ps") return asks++ === 0 ? { code: 0, stdout: "", stderr: "" } : e.run(args);
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
	const hostFs = (files = { [USER_MOUNTS]: "" }) => {
		const miss = (path) => {
			throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
		};
		return {
			statSync: (path) => (Object.hasOwn(files, path) ? { size: Buffer.byteLength(files[path]) } : miss(path)),
			readFileSync: (path) => (Object.hasOwn(files, path) ? files[path] : miss(path)),
			readdirSync: (path) => miss(path),
		};
	};
	const INFO = { rootless: true, serviceIsRemote: false, selinux: true, cgroupVersion: "v2", controllers: ["cpuset", "cpu", "io", "memory", "pids"], version: "5.8.1" };
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
		const undelegated = await decideSandboxJobUser({ ...base, backendFloor: floor, readInfo: answered({ controllers: ["cpu"] }), manifest: stamped });
		assert.equal(undelegated.refused, "backend-floor");
		assert.match(undelegated.message, /PI_BACKEND_FLOOR asks for something this host is not observed to provide/);
		assert.ok((await decideSandboxJobUser({ ...base, backendFloor: floor, manifest: stamped })).user, "a delegated host passes the same floor");
		assert.ok((await decideSandboxJobUser({ ...base, readInfo: answered({ controllers: ["cpu"] }), manifest: stamped })).user, "no floor, nothing observed refuses");
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
				const id = p.split("/").at(-2);
				reads[id] = (reads[id] ?? 0) + 1;
				if (flaky[id] && reads[id] === 1) throw Object.assign(new Error(flaky[id]), { code: flaky[id] });
				if (!(p in files)) throw Object.assign(new Error(p), { code: "ENOENT" });
				return files[p];
			},
			rmSync: (p) => {
				removed.push(p.split("/").at(-1));
				for (const k of Object.keys(files)) if (k === p || k.startsWith(`${p}/`)) delete files[k];
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

	test("every directory is read once to place it, and once more only at the point of deletion", async () => {
		const root = rootWith({ "d-1": { backend: "local", createdAt: OLD }, "p-1": { backend: "podman", podmanStore: STORE, createdAt: OLD }, bad: "{", none: null });
		await pass(root, { list: async ({ bin }) => (bin === "docker" ? ["d-1"] : []) });
		assert.deepEqual(root.reads, { "d-1": 1, "p-1": 2, bad: 2, none: 2 }, "the held one is never re-read; each deleted one is confirmed fresh");
		assert.deepEqual(root.removed.sort(), ["bad", "none", "p-1"], "held by its runtime: d-1; the rest expire on their one read");
	});

	test("ENOENT keeps the no-manifest rule without asking anyone; a parse error is asked of every runtime present", async () => {
		// A runtime IS present (podman blessed), so "nobody was asked" is a property of ENOENT, not of an empty host.
		const asked = [];
		const root = rootWith({ none: null });
		await pass(root, { blessed: ["podman"], list: async ({ bin }) => (asked.push(bin), []) });
		assert.deepEqual([root.removed, asked], [["none"], []], "no manifest file: swept, and no runtime asked about it");
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
		if (args[0] === "ps") return asks++ === 0 ? { code: 0, stdout: "", stderr: "" } : d.run(args);
		if (args.slice(0, 2).join(" ") === "network rm") return { code: 2, stdout: "", stderr: "in use" };
		return d.run(args);
	};
	const out = await makeSandboxNetworkSweeper({ bin: "podman", run })({ retained: () => [] });
	assert.deepEqual(out.notes.map((n) => n.reason), ["rm-failed"]);
	assert.ok(!calls.some((c) => /^rm /.test(c)), `nothing removed: ${calls.join(" | ")}`);
});
