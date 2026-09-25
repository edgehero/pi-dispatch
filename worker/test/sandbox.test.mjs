import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { ISOLATION_FLAGS } from "../src/docker-run.mjs";
import { WORKER_ONLY_SECRET_VARS } from "../src/config.mjs";
import { MINTED_TOKEN_VARS } from "../src/forges.mjs";
import { SANDBOX_NAME_PREFIX, SANDBOX_NETWORK_SHAPE, buildSandboxRunArgs, decideSandboxJobUser, listRunningSandboxes, makeSandboxNetworkSweeper, openSandbox, parsePublish, resolveSandbox, sandboxContainerName, sandboxEgress, sandboxVenueRefusal } from "../src/sandbox.mjs";
import { networkNameFor } from "../src/egress.mjs";

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
	// Held means the local adapter by name.
	assert.equal(resolve({ ...manifest, backend: "local" }).refused, undefined);
	assert.equal(sandboxVenueRefusal({ jobId: "j1", manifest: { ...manifest, backend: "local" } }), null);
	// A manifest with no key at all predates venue attribution, and ran on local.
	assert.equal(sandboxVenueRefusal({ jobId: "j1", manifest }), null);
});

test("held means the local adapter BY NAME, pinned in the source because no behaviour can tell it apart yet (#277)", () => {
	// While `local` is the table's only entry, "venue === DEFAULT_BACKEND" and "backendFor(venue).remote === false"
	// answer identically for every string, so no behavioural test can catch a swap to the second -- which the
	// design rejects, because a future non-remote venue on another runtime would then be reopened under docker.
	// The relation is pinned here as text rather than manufactured as behaviour.
	const src = readFileSync(new URL("../src/sandbox.mjs", import.meta.url), "utf8");
	const body = src.slice(src.indexOf("export function sandboxVenueRefusal"), src.indexOf("export function resolveSandbox"));
	assert.match(body, /if \(venue === DEFAULT_BACKEND\) return null;/);
	assert.doesNotMatch(body, /\.remote/);
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
