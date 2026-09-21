import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { runSandbox } from "../src/sandbox-cli.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * `pi-dispatch sandbox`, driven through its injected seams. Nothing here reaches docker or a terminal:
 * `running` and `launch` are fakes and `isTty` is stated, so every refusal path is asserted on the
 * machine that runs the suite rather than only on one with a daemon.
 */

/** A retention root with one retained run in it, on a real temp dir (readManifest reads it for real). */
function retained({ jobId = "gh-1", image = "pi-job:latest", workspace, keepUntil = null, backend } = {}) {
	const root = tempDir("sbx-");
	const dir = join(root, jobId);
	mkdirSync(dir, { recursive: true });
	const ws = workspace ?? join(dir, "workspace");
	mkdirSync(ws, { recursive: true });
	// `backend` omitted writes no key at all, which is every manifest retained before #277.
	writeFileSync(join(dir, "manifest.json"), JSON.stringify({ jobId, kind: "github", image, workspace: ws, createdAt: new Date().toISOString(), keepUntil, ...(backend !== undefined ? { backend } : {}) }));
	return { root, dir, workspace: ws };
}

/** A `docker` that always succeeds, so the per-job network lifecycle never touches a real daemon. */
function fakeDockerSpawn() {
	return () => {
		const child = new EventEmitter();
		queueMicrotask(() => child.emit("close", 0));
		return child;
	};
}

function capture(over = {}) {
	const out = [];
	const err = [];
	return {
		out,
		err,
		text: () => out.join(""),
		errText: () => err.join(""),
		deps: {
			out: (s) => out.push(s),
			err: (s) => err.push(s),
			isTty: true,
			running: async () => [],
			launch: async () => ({ code: 0 }),
			// The egress policy is ON by default, so a sandbox builds its own network. Seamed here for the
			// reason every docker call in this suite is: a unit test must never reach a daemon.
			spawnNetwork: fakeDockerSpawn(),
			// Issue #341: which uid the shell runs as, never decided against a real daemon here.
			resolveJobUser: async () => ({ user: null, home: null }),
			...over,
		},
	};
}

const envWith = (root, over = {}) => ({ VALKEY_URL: "redis://127.0.0.1:6399", PI_SANDBOX_DIR: root, ...over });

test("a missing job id refuses, and never shells out to docker", async () => {
	let asked = false;
	const c = capture({
		running: async () => {
			asked = true;
			return [];
		},
	});
	assert.equal(await runSandbox([], { env: envWith("/nope"), deps: c.deps }), 1);
	assert.match(c.errText(), /a job id is required/);
	assert.equal(asked, false, "a typo must not cost a docker call");
});

test("without a terminal it refuses in words, rather than letting docker say 'the input device is not a TTY'", async () => {
	const { root } = retained();
	const c = capture({ isTty: false });
	assert.equal(await runSandbox(["gh-1"], { env: envWith(root), deps: c.deps }), 1);
	assert.match(c.errText(), /needs a terminal/);
});

test("a swept run names the window that expired; retention off names the variable", async () => {
	const c1 = capture();
	assert.equal(await runSandbox(["gh-404"], { env: envWith(tempDir("sbx-")), deps: c1.deps }), 1);
	assert.match(c1.errText(), /swept after 24h/);

	const c2 = capture();
	assert.equal(await runSandbox(["gh-404"], { env: envWith(tempDir("sbx-"), { PI_SANDBOX_RETENTION_HOURS: "0" }), deps: c2.deps }), 1);
	assert.match(c2.errText(), /PI_SANDBOX_RETENTION_HOURS/);
});

test("an already-running sandbox is not opened twice; it points at docker attach", async () => {
	const { root } = retained();
	const c = capture({ running: async () => ["gh-1"] });
	assert.equal(await runSandbox(["gh-1"], { env: envWith(root), deps: c.deps }), 1);
	assert.match(c.errText(), /docker attach pi-sandbox-gh-1/);
});

test("a bad --publish is refused before anything launches", async () => {
	const { root } = retained();
	let launched = false;
	const c = capture({
		launch: async () => {
			launched = true;
			return { code: 0 };
		},
	});
	assert.equal(await runSandbox(["gh-1", "--publish", "0.0.0.0:3000:3000"], { env: envWith(root), deps: c.deps }), 1);
	assert.match(c.errText(), /invalid --publish/);
	assert.equal(launched, false);
});

test("a good run builds a credential-free argv, launches it, and returns the shell's exit code", async () => {
	const { root, dir, workspace } = retained();
	let args = null;
	const c = capture({
		launch: async (a) => {
			args = a.args;
			return { code: 7 };
		},
	});
	const code = await runSandbox(["gh-1", "--publish", "3000"], { env: envWith(root, { TERM: "xterm-256color" }), deps: c.deps });

	assert.equal(code, 7, "the shell's exit code is the command's");
	assert.ok(args.includes("--name=pi-sandbox-gh-1"));
	assert.ok(args.includes("127.0.0.1:3000:3000"), "published, and bound to loopback");
	assert.ok(args.includes(`${dir}:/job:ro`) && args.includes(`${workspace}:/workspace`));
	assert.ok(args.includes("TMOUT=1800"), "the default 30-minute idle logout");
	assert.ok(!args.join(" ").includes("TOKEN") && !args.join(" ").includes("API_KEY"));
	assert.match(c.text(), /no credentials are set in this container/);
});

test("the CLI hands the run's manifest to the job-user seam and launches as the user it answers (#341)", async () => {
	const { root } = retained();
	let args = null;
	let asked = null;
	const c = capture({
		resolveJobUser: async ({ manifest }) => ((asked = manifest), { user: "1234:1234", home: "/home/pi" }),
		launch: async (a) => ((args = a.args), { code: 0 }),
	});
	assert.equal(await runSandbox(["gh-1"], { env: envWith(root, { PI_EGRESS: "0" }), deps: c.deps }), 0);
	assert.equal(asked?.jobId, "gh-1", "the seam is asked about this run");
	assert.ok(args.includes("--user=1234:1234"));
	assert.ok(args.includes("HOME=/home/pi"));
});

test("a docker that will not start is reported as such, not as a shell that exited", async () => {
	const { root } = retained();
	const c = capture({ launch: async () => ({ code: null, error: new Error("spawn docker ENOENT") }) });
	assert.equal(await runSandbox(["gh-1"], { env: envWith(root), deps: c.deps }), 1);
	assert.match(c.errText(), /could not start docker/);
});

test("--pin stamps a deadline BEFORE the shell opens, so a lost session cannot lose the pin", async () => {
	const { root, dir } = retained();
	const order = [];
	let pinnedAtLaunch = null;
	const c = capture({
		launch: async () => {
			// Read the manifest AS the shell opens: a pin that lands only after the shell exits is the one a
			// closed laptop lid loses, and an after-the-fact read of the file cannot tell the two apart.
			pinnedAtLaunch = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(join(dir, "manifest.json"), "utf8"))).keepUntil;
			order.push("launch");
			return { code: 0 };
		},
	});
	await runSandbox(["gh-1", "--pin"], { env: envWith(root), deps: c.deps });
	assert.ok(pinnedAtLaunch, "the deadline was on disk before the shell opened");

	const manifest = JSON.parse(await import("node:fs").then((fs) => fs.readFileSync(join(dir, "manifest.json"), "utf8")));
	assert.ok(manifest.keepUntil, "the pin is on disk");
	assert.ok(Date.parse(manifest.keepUntil) > Date.now(), "and it is in the future");
	assert.match(c.text(), /pinned gh-1 until/);
	assert.deepEqual(order, ["launch"], "the pin landed first; the launch still happened");
});

test("--list shows what is left, how long it has, and what is running", async () => {
	const { root } = retained({ jobId: "gh-1" });
	retained({ jobId: "gh-2" }); // a second root; only the configured one is listed
	const c = capture({ running: async () => ["gh-1"] });
	assert.equal(await runSandbox(["--list"], { env: envWith(root), deps: c.deps }), 0);

	assert.match(c.text(), /gh-1\s+github\s+RUNNING/);
	assert.ok(!c.text().includes("gh-2"), "only the configured retention root is read");
});

test("--list says so when retention is off, rather than showing an empty table", async () => {
	const c = capture();
	const root = tempDir("sbx-");
	assert.equal(await runSandbox(["--list"], { env: envWith(root, { PI_SANDBOX_RETENTION_HOURS: "0" }), deps: c.deps }), 0);
	assert.match(c.text(), /retention is off/);
});

test("a pinned row reads as pinned, and a plain one counts down the window", async () => {
	const soon = new Date(Date.now() + 3 * 86400000).toISOString();
	const { root } = retained({ jobId: "gh-1", keepUntil: soon });
	const c = capture();
	await runSandbox(["--list"], { env: envWith(root), deps: c.deps });
	assert.match(c.text(), /pinned, 3d left/);

	const { root: root2 } = retained({ jobId: "gh-9" });
	const c2 = capture();
	await runSandbox(["--list"], { env: envWith(root2), deps: c2.deps });
	assert.match(c2.text(), /24h left/);
});

test("the sandbox is LOCAL-ONLY PER JOB: a run from another venue is refused by name, a local one opens (#227, #277)", async () => {
	// `buildSandboxRunArgs` is a SECOND container producer, outside the `runContainer` seam and hard-wired to
	// this host's docker CLI, and `manifest.workspace` is a path on THIS machine. The refusal used to be
	// deployment-wide because the command could not learn a job's venue; the manifest records it now.
	const far = retained({ backend: "far" });
	let launched = false;
	const c = capture({ launch: async () => ((launched = true), { code: 0 }) });
	assert.equal(await runSandbox(["gh-1"], { env: envWith(far.root), deps: c.deps }), 1);
	assert.match(c.errText(), /"far" backend/, "the refusal names the venue, which is the whole diagnosis");
	assert.equal(launched, false, "and no container starts");

	// A run retained before venues were recorded ran on local, and opens as it always did.
	const old = retained();
	const c2 = capture();
	assert.equal(await runSandbox(["gh-1"], { env: envWith(old.root), deps: c2.deps }), 0);
	const local = retained({ backend: "local" });
	const c3 = capture();
	assert.equal(await runSandbox(["gh-1"], { env: envWith(local.root), deps: c3.deps }), 0);
});

test("--list still shows a run from another venue, but not as time left on something re-openable (#277)", async () => {
	const far = retained({ backend: "far" });
	const c = capture();
	await runSandbox(["--list"], { env: envWith(far.root), deps: c.deps });
	assert.match(c.text(), /not here \(ran on far\)/);
	assert.doesNotMatch(c.text(), /left/);
});

test("--list says no venue is recorded for a manifest whose stamp names none, rather than inventing one (#277)", async () => {
	const unnamed = retained({ backend: null });
	const c = capture();
	await runSandbox(["--list"], { env: envWith(unnamed.root), deps: c.deps });
	assert.match(c.text(), /not openable \(no venue recorded\)/);
	assert.doesNotMatch(c.text(), /ran on|left/);
});

test("a detached shell says the sandbox is still running and that its network is left in place (#277)", async () => {
	const { root } = retained({ backend: "local" });
	let asks = 0;
	const c = capture({ running: async () => (asks++ === 0 ? [] : ["gh-1"]) });
	assert.equal(await runSandbox(["gh-1"], { env: envWith(root), deps: c.deps }), 0);
	assert.match(c.text(), /detached: pi-sandbox-gh-1 is still running with its egress network, which is left in place after it exits/);
});
