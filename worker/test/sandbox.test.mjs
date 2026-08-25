import assert from "node:assert/strict";
import { test } from "node:test";
import { ISOLATION_FLAGS } from "../src/docker-run.mjs";
import { WORKER_ONLY_SECRET_VARS } from "../src/config.mjs";
import { MINTED_TOKEN_VARS } from "../src/forges.mjs";
import { buildSandboxRunArgs, listRunningSandboxes, parsePublish, resolveSandbox, sandboxContainerName, SANDBOX_NAME_PREFIX } from "../src/sandbox.mjs";

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
