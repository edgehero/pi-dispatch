import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { runSandbox, sandboxUnreachableFrom } from "../src/sandbox-cli.mjs";

/**
 * `pi-dispatch sandbox`, driven through its injected seams. Nothing here reaches docker or a terminal:
 * `running` and `launch` are fakes and `isTty` is stated, so every refusal path is asserted on the
 * machine that runs the suite rather than only on one with a daemon.
 */

/** A retention root with one retained run in it, on a real temp dir (readManifest reads it for real). */
function retained({ jobId = "gh-1", image = "pi-job:latest", workspace, keepUntil = null } = {}) {
	const root = mkdtempSync(join(tmpdir(), "sbx-"));
	const dir = join(root, jobId);
	mkdirSync(dir, { recursive: true });
	const ws = workspace ?? join(dir, "workspace");
	mkdirSync(ws, { recursive: true });
	writeFileSync(join(dir, "manifest.json"), JSON.stringify({ jobId, kind: "github", image, workspace: ws, createdAt: new Date().toISOString(), keepUntil }));
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
	assert.equal(await runSandbox(["gh-404"], { env: envWith(mkdtempSync(join(tmpdir(), "sbx-"))), deps: c1.deps }), 1);
	assert.match(c1.errText(), /swept after 24h/);

	const c2 = capture();
	assert.equal(await runSandbox(["gh-404"], { env: envWith(mkdtempSync(join(tmpdir(), "sbx-")), { PI_SANDBOX_RETENTION_HOURS: "0" }), deps: c2.deps }), 1);
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

test("a docker that will not start is reported as such, not as a shell that exited", async () => {
	const { root } = retained();
	const c = capture({ launch: async () => ({ code: null, error: new Error("spawn docker ENOENT") }) });
	assert.equal(await runSandbox(["gh-1"], { env: envWith(root), deps: c.deps }), 1);
	assert.match(c.errText(), /could not start docker/);
});

test("--pin stamps a deadline BEFORE the shell opens, so a lost session cannot lose the pin", async () => {
	const { root, dir } = retained();
	const order = [];
	const c = capture({
		launch: async () => {
			order.push("launch");
			return { code: 0 };
		},
	});
	await runSandbox(["gh-1", "--pin"], { env: envWith(root), deps: c.deps });

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
	const root = mkdtempSync(join(tmpdir(), "sbx-"));
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

test("the sandbox is LOCAL-ONLY, and says so rather than failing on a missing directory (#227)", async () => {
	// `buildSandboxRunArgs` is a SECOND container producer, outside the `runContainer` seam and hard-wired to
	// this host's docker CLI. It reopens a retained job directory, and `manifest.workspace` is a path on THIS
	// machine -- for a job that ran in another venue that path either does not exist, or exists and
	// reproduces a run from the wrong host, silently. INT-SANDBOX-CONTRACT is already "a SIBLING ... never an
	// amendment"; this is the clause that says which sibling.
	// A deployment that blesses only local must NOT be refused: that is every deployment today, and a
	// refusal here would break the command outright.
	const c = capture({ running: async () => [] });
	assert.equal(await runSandbox(["gh-1"], { env: envWith("/nope", { PI_BACKENDS: "local" }), deps: c.deps }), 1);
	assert.doesNotMatch(c.errText(), /remote venue/, "the local-only deployment reaches the ordinary not-found path");

	// The refusal itself is driven as a predicate, because it is unreachable through the CLI while `local`
	// is the only backend -- and an unreachable rule with no test is one a mutation pass deletes in silence,
	// which is exactly what happened to the trigger-side remote refusal one slice ago.
	assert.equal(sandboxUnreachableFrom({ backends: ["local"] }), false);
	assert.equal(sandboxUnreachableFrom({ backends: ["local", "far"] }), true, "ANY remote venue puts a retained dir out of reach");
	assert.equal(sandboxUnreachableFrom({ backends: ["far"] }), true);
	// An UNCONFIGURED deployment is a local one -- `parseBackendList` returns ["local"] for an unset
	// PI_BACKENDS -- so it must stay reachable. This is the case that would break every existing operator
	// if the predicate were fail-closed on absence, and it is the one place in this feature where "declares
	// nothing" does not mean "gets no benefit of the doubt": the deployment did declare, by default.
	assert.equal(sandboxUnreachableFrom({}), false);
	// A name nothing implements is unreachable, though: that is a venue this host cannot have run.
	assert.equal(sandboxUnreachableFrom({ backends: ["not-a-backend"] }), true);
});
