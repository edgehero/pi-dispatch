import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
function retained({ jobId = "gh-1", image = "pi-job:latest", workspace, keepUntil = null, backend, createdAt = new Date().toISOString(), retainUntil } = {}) {
	const root = tempDir("sbx-");
	const dir = join(root, jobId);
	mkdirSync(dir, { recursive: true });
	const ws = workspace ?? join(dir, "workspace");
	mkdirSync(ws, { recursive: true });
	// `backend` omitted writes no key at all, which is every manifest retained before #277.
	writeFileSync(join(dir, "manifest.json"), JSON.stringify({ jobId, kind: "github", image, workspace: ws, createdAt, ...(retainUntil !== undefined ? { retainUntil } : {}), keepUntil, ...(backend !== undefined ? { backend } : {}) }));
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
	// Neutral about when (#446 gate round 2): this shell's window is not the one that swept it.
	assert.match(c1.errText(), /swept at the end of its retention window/);
	assert.doesNotMatch(c1.errText(), /24h/);

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
	// `PI_EGRESS: "0"` is new here and is the point rather than a workaround: since issue #362 `--publish`
	// belongs to that posture and is refused on the armed default, because a container on an `--internal`
	// network publishes nothing. The rest of this test is about the argv and is unchanged.
	const code = await runSandbox(["gh-1", "--publish", "3000"], { env: envWith(root, { TERM: "xterm-256color", PI_EGRESS: "0" }), deps: c.deps });

	assert.equal(code, 7, "the shell's exit code is the command's");
	assert.ok(args.includes("--name=pi-sandbox-gh-1"));
	assert.ok(args.includes("127.0.0.1:3000:3000"), "published, and bound to loopback");
	assert.ok(args.includes(`${dir}:/job:ro`) && args.includes(`${workspace}:/workspace`));
	assert.ok(args.includes("TMOUT=1800"), "the default 30-minute idle logout");
	assert.ok(!args.join(" ").includes("TOKEN") && !args.join(" ").includes("API_KEY"));
	assert.match(c.text(), /no credentials are set in this container/);
});

test("--publish is REFUSED while the egress policy is armed, before anything is created (#362)", async () => {
	// Docker resolves the contradiction silently: it accepts `-p` on a container joined only to an
	// `--internal` network, exits 0 and binds nothing. Measured on docker 27.4.0, `docker port` prints nothing.
	const { root } = retained();
	let launched = false;
	const c = capture({ launch: async () => ((launched = true), { code: 0 }) });
	const code = await runSandbox(["gh-1", "--publish", "3000"], { env: envWith(root, {}), deps: c.deps });

	assert.equal(code, 1, "a refusal is a failure exit");
	assert.equal(launched, false, "and nothing is created");
	assert.match(c.errText(), /--publish` is refused while the egress policy is armed/);
	assert.match(c.errText(), /PI_EGRESS=0/, "the refusal names the opt-out");
	// BEFORE `beforeLaunch`, which is where the `published:` line is printed. One line later and the CLI would
	// print a false line and then refuse, which is the defect this issue is about wearing a different face.
	assert.equal(c.text(), "", "and prints no `opening`/`published:` line at all");
});

test("with the policy off, --publish is the feature it always was (#362)", async () => {
	const { root } = retained();
	let args = null;
	const c = capture({ launch: async (a) => ((args = a.args), { code: 0 }) });
	await runSandbox(["gh-1", "--publish", "8080:3000"], { env: envWith(root, { PI_EGRESS: "0" }), deps: c.deps });

	assert.ok(args.includes("127.0.0.1:8080:3000"), "published, and still bound to loopback");
	assert.ok(!args.some((a) => String(a).startsWith("--network=")), "and there is no internal network to contradict it");
	assert.match(c.text(), /published: 127\.0\.0\.1:8080:3000/, "and the line is true when it is printed");
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

test("the sandbox is PER JOB: a run from a venue with no launcher here is refused by name, a local one opens (#227, #277, #429)", async () => {
	// `buildSandboxRunArgs` is a SECOND container producer, outside the `runContainer` seam, with a launcher only for
	// the venues that run on this host (`local`, `podman`), and `manifest.workspace` is a path on THIS machine. The
	// refusal used to be deployment-wide because the command could not learn a job's venue; the manifest records it now.
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

// --- issue #429: the podman venue ---------------------------------------------------------------------------------

test("a podman run opens through podman when PI_BACKENDS blesses it, and every line after names podman (#429)", async () => {
	const { root } = retained({ backend: "podman" });
	const launches = [];
	const asks = [];
	const judged = [];
	let n = 0;
	const c = capture({
		running: async (o) => (asks.push(o?.bin), n++ === 0 ? [] : ["gh-1"]),
		launch: async (o) => (launches.push(o.bin), { code: 0 }),
		resolveJobUser: async (o) => (judged.push(o), { user: "1234:1234", home: "/home/pi" }),
	});
	assert.equal(await runSandbox(["gh-1"], { env: envWith(root, { PI_BACKENDS: "podman", PI_BACKEND_FLOOR: "isolation=enforced" }), deps: c.deps }), 0);
	assert.deepEqual(launches, ["podman"]);
	assert.deepEqual(asks, ["podman", "podman"]);
	assert.equal(judged[0].venue, "podman");
	assert.deepEqual(judged[0].backendFloor, { isolation: "enforced" }, "the CLI's own parsed floor reaches the podman judge");
	assert.match(c.text(), /`podman attach pi-sandbox-gh-1` to return/);

	const failed = capture({ launch: async () => ({ code: null, error: new Error("spawn podman ENOENT") }), resolveJobUser: async () => ({ user: "1234:1234", home: "/home/pi" }) });
	assert.equal(await runSandbox(["gh-1"], { env: envWith(root, { PI_BACKENDS: "podman", PI_EGRESS: "0" }), deps: failed.deps }), 1);
	assert.match(failed.errText(), /could not start podman: spawn podman ENOENT/);
});

test("a podman run is refused where PI_BACKENDS does not bless it, and --list says which variable (#429)", async () => {
	const { root } = retained({ backend: "podman" });
	let launched = false;
	const c = capture({ launch: async () => ((launched = true), { code: 0 }) });
	assert.equal(await runSandbox(["gh-1"], { env: envWith(root), deps: c.deps }), 1);
	assert.match(c.errText(), /"podman" backend, which PI_BACKENDS in this process's environment does not bless/);
	assert.equal(launched, false, "never launched under docker instead");

	const list = capture();
	await runSandbox(["--list"], { env: envWith(root), deps: list.deps });
	assert.match(list.text(), /not here \(PI_BACKENDS lacks podman\)/);
});

test("--list asks EVERY blessed sandbox runtime, and one that cannot answer costs only its own sandboxes (#429)", async () => {
	const { root } = retained({ jobId: "gh-1", backend: "podman" });
	mkdirSync(join(root, "gh-2", "workspace"), { recursive: true });
	writeFileSync(join(root, "gh-2", "manifest.json"), JSON.stringify({ jobId: "gh-2", kind: "github", image: "pi-job:latest", backend: "local", workspace: join(root, "gh-2", "workspace"), createdAt: new Date().toISOString(), keepUntil: null }));
	const asked = [];
	const both = capture({ running: async (o) => (asked.push(o?.bin), o?.bin === "podman" ? ["gh-1"] : ["gh-2"]) });
	await runSandbox(["--list"], { env: envWith(root, { PI_BACKENDS: "local,podman" }), deps: both.deps });
	assert.deepEqual(asked, ["docker", "podman"]);
	assert.match(both.text(), /gh-1\s+github\s+RUNNING/);
	assert.match(both.text(), /gh-2\s+github\s+RUNNING/);

	const dockerDown = capture({
		running: async (o) => {
			if (o?.bin === "docker") throw new Error("docker down");
			return ["gh-1"];
		},
	});
	await runSandbox(["--list"], { env: envWith(root, { PI_BACKENDS: "local,podman" }), deps: dockerDown.deps });
	assert.match(dockerDown.text(), /gh-1\s+github\s+RUNNING/, "podman's column survives docker being down");
	assert.doesNotMatch(dockerDown.text(), /gh-2\s+github\s+RUNNING/);

	// Only blessed runtimes are asked: a podman-only host never runs `docker ps` for a column.
	const podmanOnly = [];
	await runSandbox(["--list"], { env: envWith(root, { PI_BACKENDS: "podman" }), deps: capture({ running: async (o) => (podmanOnly.push(o?.bin), []) }).deps });
	assert.deepEqual(podmanOnly, ["podman"]);
});

test("--list names PI_BACKENDS, not a missing record, for a pre-attribution run in a shell without local (#429 review)", async () => {
	const { root } = retained(); // no `backend` key: a local run from before venues were recorded
	const c = capture();
	await runSandbox(["--list"], { env: envWith(root, { PI_BACKENDS: "podman" }), deps: c.deps });
	assert.match(c.text(), /not here \(PI_BACKENDS lacks local\)/);
	assert.doesNotMatch(c.text(), /no venue recorded/);
});

// --- issue #446 ------------------------------------------------------------------------------------------------

const AT_446 = Date.parse("2026-08-03T00:00:00.000Z");
const lapsed = () => retained({ createdAt: "2026-08-01T00:00:00.000Z", retainUntil: "2026-08-02T00:00:00.000Z" });

test("a run past the deadline its manifest records is refused and told the command; with --pin it opens (#446)", async () => {
	const { root, dir } = lapsed();
	let launched = 0;
	const c = capture({ now: () => AT_446, launch: async () => (launched++, { code: 0 }) });
	// This shell's window is far larger than the worker's; the deadline the worker wrote is what refuses.
	assert.equal(await runSandbox(["gh-1"], { env: envWith(root, { PI_SANDBOX_RETENTION_HOURS: "480" }), deps: c.deps }), 1);
	assert.match(c.errText(), /past its retention window .*`pi-dispatch sandbox gh-1 --pin`/);
	assert.equal(launched, 0);

	const pinned = capture({ now: () => AT_446, launch: async () => (launched++, { code: 0 }) });
	assert.equal(await runSandbox(["gh-1", "--pin"], { env: envWith(root), deps: pinned.deps }), 0);
	assert.equal(launched, 1);
	assert.match(pinned.text(), /pinned gh-1 until/);
	const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
	assert.ok(Date.parse(manifest.keepUntil) > AT_446, "the new deadline is on disk");
});

test("a --pin that cannot be written REFUSES the open, where it used to warn and open anyway (#446)", async () => {
	const { root, dir } = lapsed();
	// A path the pin's temp file must not write through: `wx` refuses it, so the pin fails deterministically.
	writeFileSync(join(dir, `.manifest.json.${process.pid}.${AT_446}.tmp`), "planted");
	let launched = false;
	const c = capture({ now: () => AT_446, launch: async () => ((launched = true), { code: 0 }) });
	assert.equal(await runSandbox(["gh-1", "--pin"], { env: envWith(root), deps: c.deps }), 1);
	assert.match(c.errText(), /could not pin gh-1 \(EEXIST/);
	assert.doesNotMatch(c.errText(), /warning/);
	assert.equal(launched, false);
});

test("--list counts down the deadline the worker wrote, not this shell's window (#446)", async () => {
	const { root } = retained({ createdAt: "2026-08-02T21:00:00.000Z", retainUntil: "2026-08-03T03:00:00.000Z" });
	const c = capture({ now: () => AT_446 });
	await runSandbox(["--list"], { env: envWith(root, { PI_SANDBOX_RETENTION_HOURS: "480" }), deps: c.deps });
	assert.match(c.text(), /gh-1\s+github\s+3h left/);
});

test("--list marks a dot id RUNNING by its retained name, which is what the runtime reports (#446)", async () => {
	const root = tempDir("sbx-");
	const dir = join(root, "_.x");
	mkdirSync(join(dir, "workspace"), { recursive: true });
	writeFileSync(join(dir, "manifest.json"), JSON.stringify({ jobId: ".x", kind: "github", image: "pi-job:latest", workspace: join(dir, "workspace"), createdAt: "2026-08-02T21:00:00.000Z", keepUntil: null }));
	const c = capture({ now: () => AT_446, running: async () => ["_.x"] });
	await runSandbox(["--list"], { env: envWith(root), deps: c.deps });
	assert.match(c.text(), /\.x\s+github\s+RUNNING/);
});

test("--list SAYS a run past its window, or inside the grace, needs --pin, rather than counting down to 0h (#446)", async () => {
	for (const [retainUntil, want] of [
		["2026-08-02T23:00:00.000Z", "past its window (open with --pin)"],
		["2026-08-03T00:04:00.000Z", "within the grace (open with --pin)"],
		["2026-08-03T00:06:00.000Z", "1h left"],
	]) {
		const { root } = retained({ createdAt: "2026-08-02T20:00:00.000Z", retainUntil });
		const c = capture({ now: () => AT_446 });
		await runSandbox(["--list"], { env: envWith(root), deps: c.deps });
		assert.match(c.text(), new RegExp(`gh-1\\s+github\\s+${want.replace(/[()]/g, "\\$&")}`), retainUntil);
	}
});

test("a run lost from under a session after it started is said when the shell exits, and the exit code kept (#446)", async () => {
	// Real timers, the look's own 250 ms: listed at once, the run deleted well after the launch check, the shell back later.
	const { root, dir } = retained({ keepUntil: new Date(AT_446 + 86400000).toISOString() });
	let listed = false;
	const c = capture({
		now: () => AT_446,
		running: async () => (listed ? ["gh-1"] : []),
		launch: async () => {
			listed = true;
			await new Promise((r) => setTimeout(r, 600));
			rmSync(dir, { recursive: true, force: true });
			// Generous, so a loaded CI runner still fits several 250 ms looks in before the shell "returns".
			await new Promise((r) => setTimeout(r, 2000));
			return { code: 3 };
		},
	});
	assert.equal(await runSandbox(["gh-1"], { env: envWith(root, { PI_EGRESS: "0" }), deps: c.deps }), 3);
	assert.match(c.errText(), /note: the retained workspace for gh-1 was DELETED while this sandbox was open \(by the retention sweep, or by a retry of the run clearing it\)/);
});
