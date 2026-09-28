import { test } from "node:test";
import assert from "node:assert/strict";
import { lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { defaultPrompt, runUp } from "../src/up.mjs";
import { NETNS_KEEPER_FORMAT } from "../src/podman-stack.mjs";

// A fake `spawn`, mirroring doctor.test.mjs: plan keys are command-line prefixes ("docker version",
// "docker image inspect", "docker pull", "docker tag", "docker ps", "docker volume", "docker run")
// mapped to a canned exit code, a `{code, output}` pair, or "enoent" for a launch failure. Every spawn
// is recorded into `calls` so tests can assert the EXACT argv of every host mutation.
function fakeSpawn(plan, calls = []) {
	return (cmd, args, opts) => {
		const line = [cmd, ...args].join(" ");
		const key = Object.keys(plan).find((k) => line.startsWith(k));
		const outcome = plan[key];
		calls.push({ cmd, args, opts });
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
			kill() {},
			on(ev, cb) {
				handlers[ev] = cb;
				return this;
			},
		};
		queueMicrotask(() => {
			if (outcome === "enoent") {
				handlers.error?.(new Error(`spawn ${cmd} ENOENT`));
				return;
			}
			const { code, output, stderr } = typeof outcome === "object" && outcome !== null ? outcome : { code: outcome, output: "" };
			if (output) child.stdout.handlers.data?.(output);
			if (stderr) child.stderr.handlers.data?.(stderr);
			handlers.close?.(code);
		});
		return child;
	};
}

// 64 hex chars, distinctive on purpose: the no-secret-in-output assertions grep for exactly this.
const SECRET = "cafef00d".repeat(8);

// Everything injected, everything recorded. `files` seeds the in-memory fs (path → text); the fake
// init deliberately creates nothing, so a test that wants a .env after init seeds it up front.
function harness({ plan = {}, listening = true, answers = [], files = {}, doctorCode = 0, argv = [], env = { PI_PROVIDER: "anthropic" }, cwd = "/deploy", platform = "linux", logsDirPathFn, settingsFilePathFn, extra = {} } = {}) {
	// The podman tests (those that inject a podman info reader) get what a real login has unless they say otherwise: a
	// user manager to talk to (XDG_RUNTIME_DIR, round 2 E8) and a podman that answers "no such container" for the two
	// names the stack would claim (E3: any other failure now refuses).
	if (extra.readPodmanInfo) {
		if (!("XDG_RUNTIME_DIR" in env) && !extra.noBus) env = { ...env, XDG_RUNTIME_DIR: "/run/user/1234" };
		if (!Object.keys(plan).some((k) => k.startsWith("podman container inspect"))) plan = { "podman container inspect": { code: 125, stderr: "Error: no such container pi-dispatch-valkey\n" }, ...plan };
	}
	const calls = [];
	const promptCalls = [];
	const initCalls = [];
	const initOpts = [];
	const doctorCalls = [];
	const doctorOpts = [];
	const buf = [];
	const store = new Map(Object.entries(files));
	const deps = {
		env,
		spawn: fakeSpawn(plan, calls),
		out: (s) => buf.push(s),
		prompt: (q) => {
			promptCalls.push(q);
			return answers.shift() ?? "";
		},
		fs: {
			existsSync: (p) => store.has(p),
			readFileSync: (p) => {
				if (!store.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
				return store.get(p);
			},
			writeFileSync: (p, data) => store.set(p, data),
			renameSync: (from, to) => {
				store.set(to, store.get(from));
				store.delete(from);
			},
			statSync: () => ({ mode: 0o100600 }),
			chmodSync: () => {},
		},
		probeTcp: async () => listening,
		cwd,
		platform,
		randomHex: () => SECRET,
		// Resolved defaults, pinned rather than read off this host: `logsDirPath` calls the real
		// `homedir()`, so without these the byte-exact `.env` assertions below would assert whose account
		// ran the suite (issue #357).
		// The real ones RESOLVE rather than default (`env.PI_LOGS_DIR || <account default>`), and these
		// mirror that shape exactly: a fake that ignored the environment would hide the one case where
		// `up` can persist a path it must never persist.
		logsDirPathFn: logsDirPathFn ?? ((e) => e.PI_LOGS_DIR || "/home/op/.pi-dispatch/logs"),
		settingsFilePathFn: settingsFilePathFn ?? ((e) => e.PI_SETTINGS_FILE || "/home/op/.pi-dispatch/settings.json"),
		runInitFn: (cwd, opts) => {
			initCalls.push(cwd);
			initOpts.push(opts);
			return 0;
		},
		runDoctorFn: (env, opts) => {
			doctorCalls.push(env);
			doctorOpts.push(opts);
			return doctorCode;
		},
		...extra,
	};
	return { run: () => runUp(argv, deps), deps, calls, promptCalls, initCalls, initOpts, doctorCalls, doctorOpts, store, text: () => buf.join("") };
}

const green = { "docker version": 0, "docker image inspect": 0, "docker ps": { code: 0, output: "pi-dispatch-valkey\n" } };

// The exact host mutations up may ever run — asserted array-for-array below, because "shown then run"
// only holds if what runs is literally what was shown.
const PULL = ["pull", "ghcr.io/edgehero/pi-job:latest"];
const TAG = ["tag", "ghcr.io/edgehero/pi-job:latest", "pi-job:latest"];
const VOLUME = ["volume", "create", "pi-dispatch-valkey-data"];
const VALKEY_RUN = [
	"run", "-d", "--name", "pi-dispatch-valkey", "--restart", "unless-stopped",
	"-p", "127.0.0.1:6379:6379", "-v", "pi-dispatch-valkey-data:/data",
	"--health-cmd", "valkey-cli ping", "--health-interval", "10s", "--health-timeout", "3s", "--health-retries", "5",
	"valkey/valkey:8", "valkey-server", "--appendonly", "yes",
];

test("up: everything already in place prompts for nothing and exits 0", async () => {
	const h = harness({ plan: green, listening: true });
	assert.equal(await h.run(), 0);
	assert.equal(h.promptCalls.length, 0, "nothing missing, nothing to consent to");
	assert.match(h.text(), /Job image present \(pi-job:latest\)/);
	assert.match(h.text(), /assuming your Valkey/);
	assert.match(h.text(), /up: summary/);
});

test("up: declined prompts run NOTHING and the summary says skipped", async () => {
	const h = harness({
		plan: { "docker version": 0, "docker image inspect": 1 },
		listening: false,
		answers: ["", ""], // two prompts, both answered with Enter — the default is No
	});
	assert.equal(await h.run(), 0, "declining is not an error; doctor still ran and was green");
	assert.equal(h.promptCalls.length, 2, "one consent per docker action pair (image, valkey)");
	// The ONLY spawns are the three read-only probes — no pull, no tag, no volume, no run. The third is the
	// egress proxy, which the policy being ON by default makes up look for; it asks nothing here because
	// this deployment has no egress-allowlist.conf, and up declines that step itself rather than standing
	// up a proxy with no allowlist behind it.
	assert.deepEqual(h.calls.map((c) => c.args), [
		["version"],
		["image", "inspect", "pi-job:latest"],
		["inspect", PROXY_INSPECT.slice("docker inspect ".length, -" pi-dispatch-egress-proxy".length), "pi-dispatch-egress-proxy"],
	]);
	assert.match(h.text(), /job image\s+skipped \(declined\)/);
	assert.match(h.text(), /valkey\s+skipped \(declined\)/);
	assert.match(h.text(), /egress-allowlist\.conf is not here/);
});

test("up: --yes runs both docker action pairs with exactly the argv that was shown", async () => {
	const h = harness({
		plan: { "docker version": 0, "docker image inspect": 1, "docker pull": 0, "docker tag": 0, "docker volume": 0, "docker run": 0 },
		listening: false,
		argv: ["--yes"],
	});
	assert.equal(await h.run(), 0);
	assert.equal(h.promptCalls.length, 0, "--yes waives every prompt");
	const argvs = h.calls.map((c) => c.args);
	assert.deepEqual(argvs.find((a) => a[0] === "pull"), PULL);
	assert.deepEqual(argvs.find((a) => a[0] === "tag"), TAG);
	assert.deepEqual(argvs.find((a) => a[0] === "volume"), VOLUME);
	assert.deepEqual(argvs.find((a) => a[0] === "run"), VALKEY_RUN);
	assert.ok(argvs.findIndex((a) => a[0] === "pull") < argvs.findIndex((a) => a[0] === "tag"), "pull before tag");
	assert.ok(argvs.findIndex((a) => a[0] === "volume") < argvs.findIndex((a) => a[0] === "run"), "volume before run");
	// --yes waives consent, never visibility: the commands are still printed before they run.
	assert.match(h.text(), /docker pull ghcr\.io\/edgehero\/pi-job:latest/);
	assert.match(h.text(), /docker volume create pi-dispatch-valkey-data/);
});

test("up: an image already present is never prompted for", async () => {
	const h = harness({ plan: { "docker version": 0, "docker image inspect": 0 }, listening: false, answers: [""] });
	await h.run();
	assert.equal(h.promptCalls.length, 1, "only the valkey consent remains");
	assert.match(h.promptCalls[0], /Proceed/);
	assert.equal(h.calls.map((c) => c.args).find((a) => a[0] === "pull"), undefined);
});

test("up: something listening on 6379 never prompts and never runs docker run", async () => {
	const h = harness({ plan: green, listening: true });
	await h.run();
	assert.equal(h.promptCalls.length, 0);
	const argvs = h.calls.map((c) => c.args);
	assert.equal(argvs.find((a) => a[0] === "run"), undefined);
	assert.equal(argvs.find((a) => a[0] === "volume"), undefined);
	assert.match(h.text(), /assuming your Valkey \(it is the pi-dispatch-valkey container\)/);
});

test("up: a foreign listener on 6379 is assumed but not claimed as ours", async () => {
	const h = harness({ plan: { ...green, "docker ps": { code: 0, output: "" } }, listening: true });
	await h.run();
	assert.match(h.text(), /assuming your Valkey/);
	assert.doesNotMatch(h.text(), /it is the pi-dispatch-valkey container/);
});

test("up: init and doctor always run, even when every docker action was declined", async () => {
	const h = harness({ plan: { "docker version": 0, "docker image inspect": 1 }, listening: false, answers: ["n", "n"] });
	await h.run();
	assert.deepEqual(h.initCalls, ["/deploy"], "init ran, in the working directory");
	assert.equal(h.doctorCalls.length, 1, "doctor ran");
	// Issue #278: `up` runs plain doctor. `--live` starts containers, and `up`'s consent covers only the actions it
	// shows, so it must never pass the flag through.
	assert.equal(Object.hasOwn(h.doctorOpts[0] ?? {}, "live"), false, "up never asks doctor to run live probes");
	assert.match(h.text(), /never overwrites/, "the never-clobber contract is said out loud");
});

test("up: WEBHOOK_SECRET is generated into an empty .env and the value NEVER reaches output", async () => {
	const h = harness({ plan: green, files: { "/deploy/.env": "A=1\nWEBHOOK_SECRET=\n" } });
	await h.run();
	// The four path keys land beside it (issue #357), which four other files have promised for a year.
	assert.equal(
		h.store.get("/deploy/.env"),
		`A=1\nWEBHOOK_SECRET=${SECRET}\nPI_PAUSE_WINDOWS_FILE=/deploy/pause-windows.json\nPI_SCOPED_LIMITS_FILE=/deploy/scoped-limits.json\nPI_LOGS_DIR=/home/op/.pi-dispatch/logs\nPI_SETTINGS_FILE=/home/op/.pi-dispatch/settings.json\n`,
		"the key was filled, the four paths appended, other lines untouched",
	);
	assert.ok(!h.text().includes(SECRET), "the secret value must never be printed");
	assert.match(h.text(), /generated WEBHOOK_SECRET/);
});

test("up: a key whose value is `\"\"` is named as EMPTY, not merely `already set` (#365)", async () => {
	// `KEY=""` is SET to the never-clobber rule -- an operator who wrote it meant something by it, and `up`
	// mutating a value they chose is the one thing this command must not do -- and EMPTY to every consumer
	// that reads the key at all. NOT unset, which is what this comment said and what doctor acted on until
	// issue #384: the shells and `EnvironmentFile=` both SET the variable to an empty string (measured in
	// sh, bash, dash and zsh, and on systemd 252), `config.mjs` keeps it through `??`, and the worker then
	// refuses to start on a path that is nothing. So `up` said "already set" three lines above a doctor
	// warning saying the feature is OFF, when the deployment was in fact DOWN.
	//
	// The cmd wrapper is the third reading and the one exception: `set "K="` genuinely unsets there, so a
	// Windows service under nssm sees no key where the POSIX loaders see an empty one.
	//
	// NAMED ON `up`'S SIDE. A fourth doctor state was rejected: a state exists to carry a DECISION, and
	// this is a wording overlap between two correct sentences.
	const h = harness({ plan: green, files: { "/deploy/.env": `WEBHOOK_SECRET=x\nPI_PAUSE_WINDOWS_FILE=""\nPI_SCOPED_LIMITS_FILE=/deploy/scoped-limits.json\n` } });
	await h.run();
	assert.equal(h.store.get("/deploy/.env").includes('PI_PAUSE_WINDOWS_FILE=""'), true, "and the line itself is STILL untouched, which is the point of saying it rather than fixing it");
	const text = h.text();
	// THE CONSEQUENCE IS THE POINT, and the first version of this said the opposite. `config.mjs` reads this
	// key with `??`, so an empty string survives, and `start.mjs` calls `loadPauseWindows` unconditionally at
	// boot, which throws on a path that does not exist (measured: `pause-windows file does not exist: `). So
	// "every consumer reads as unset" was false and the worker does not ignore the feature: it refuses to
	// start. Two sentences that read as a contradiction had been replaced by two that agreed with each other
	// and disagreed with the worker.
	assert.match(text, /PI_PAUSE_WINDOWS_FILE[\s\S]*?its value is EMPTY[\s\S]*?REFUSES TO BOOT/, "the empty value is named with what it actually does");
	assert.doesNotMatch(text, /which every consumer reads as unset/, "the false reading is gone");
	// The key beside it, with a real value, keeps the plain sentence -- so the new wording is about the
	// value and not about every untouched key.
	assert.match(text, /PI_SCOPED_LIMITS_FILE[\s\S]*?already set — left untouched/, "a key with a real value reads as before");
	// And a `KEY=` with nothing after it is not this case at all: `setEnvKeyIfEmpty` FILLS that one, so it
	// is reported as written and never reaches the untouched branch.
	const filled = harness({ plan: green, files: { "/deploy/.env": "WEBHOOK_SECRET=x\nPI_PAUSE_WINDOWS_FILE=\n" } });
	await filled.run();
	assert.match(filled.text(), /PI_PAUSE_WINDOWS_FILE=\/deploy\/pause-windows\.json written into \.env/);
	assert.doesNotMatch(filled.text(), /PI_PAUSE_WINDOWS_FILE[^\n]*the line is there and its value is/);

	// THE CONSEQUENCE IS PER KEY, and only the two `config.mjs` reads with `??` refuse a boot. `PI_LOGS_DIR`
	// and `PI_SETTINGS_FILE` use `||` and fall back to the account default; `WEBHOOK_SECRET` reads as absent.
	// Saying "refuses to boot" for those three would be the same overstatement one key over.
	const secret = harness({ plan: green, files: { "/deploy/.env": `WEBHOOK_SECRET=""\nPI_PAUSE_WINDOWS_FILE=/deploy/pause-windows.json\nPI_SCOPED_LIMITS_FILE=/deploy/scoped-limits.json\nPI_LOGS_DIR=/home/op/.pi-dispatch/logs\nPI_SETTINGS_FILE=/home/op/.pi-dispatch/settings.json\n` } });
	await secret.run();
	const secretText = secret.text();
	assert.match(secretText, /⚠ WEBHOOK_SECRET has a line in \.env and its value is EMPTY — left untouched/, "a ⚠, because every other ✓ in that block means this is fine");
	assert.match(secretText, /WEBHOOK_SECRET[\s\S]*?its value is empty, which reads as unset/, "and the plain consequence, not the boot one");
	assert.doesNotMatch(secretText, /WEBHOOK_SECRET[^\n]*REFUSES TO BOOT/, "WEBHOOK_SECRET does not refuse a boot");
	assert.equal(secret.store.get("/deploy/.env").includes('WEBHOOK_SECRET=""'), true, "and it is still untouched");

	// The other direction of "both readings are asked": set for systemd, EMPTIED by a later export line. The
	// key is configured for `EnvironmentFile=` and unset for the wrappers, so calling it empty would be wrong
	// for the systemd operator. (The mirror of this is pinned above.)
	const halfEmpty = harness({ plan: green, files: { "/deploy/.env": "WEBHOOK_SECRET=x\nPI_PAUSE_WINDOWS_FILE=/systemd.json\nexport PI_PAUSE_WINDOWS_FILE=\n" } });
	await halfEmpty.run();
	assert.doesNotMatch(halfEmpty.text(), /PI_PAUSE_WINDOWS_FILE[^\n]*its value is/, "set for one consumer is not empty, whichever consumer it is");

	// BOTH READINGS ARE ASKED, and this is the case that needs the second one. A bare `PI_X=` with an
	// `export PI_X=/v.json` below it is empty for systemd's `EnvironmentFile=` and SET for the wrapper
	// deployments, which source the file and take the last assignment. Calling that "empty" would tell a
	// launchd or nssm operator their configured key is unset. `up` leaves it alone either way, because the
	// export line is a value the operator wrote.
	const halfSet = harness({ plan: green, files: { "/deploy/.env": "WEBHOOK_SECRET=x\nPI_PAUSE_WINDOWS_FILE=\nexport PI_PAUSE_WINDOWS_FILE=/v.json\n" } });
	await halfSet.run();
	assert.doesNotMatch(halfSet.text(), /PI_PAUSE_WINDOWS_FILE[^\n]*the line is there and its value is empty/, "set for one consumer is not empty");
	assert.equal(halfSet.store.get("/deploy/.env").includes("export PI_PAUSE_WINDOWS_FILE=/v.json"), true, "and never clobbered");
});

test("up and the deployment pointer agree on the two basenames they share, and only those two (#357)", async () => {
	// Two surfaces write paths for one deployment: `up` into the `.env` the WORKER reads, and the setup
	// wizard into the pointer the PANEL reads. Where they overlap they must not drift, because a panel
	// writing quiet hours into one file while the worker loads another is the exact trap both exist to
	// close. They overlap in two keys, and the overlap is checked here rather than assumed.
	//
	// The other two `up` writes are NOT comparable and must not be added to this list. `PI_LOGS_DIR` and
	// `PI_SETTINGS_FILE` are deliberately absent from what the wizard emits (they are allowlisted and left
	// unwritten, `INT-DEPLOYMENT-POINTER-CONTRACT`), because the pointer moves only the panel; and `up`
	// writes those two as the resolved ACCOUNT DEFAULT rather than a deployment path, so even the shape
	// would not match.
	const wizard = readFileSync(new URL("../../admin/src/setup-wizard.ts", import.meta.url), "utf8");
	const h = harness({ plan: green, files: { "/deploy/.env": "" } });
	await h.run();
	const written = Object.fromEntries(
		h.store
			.get("/deploy/.env")
			.split("\n")
			.filter(Boolean)
			.map((l) => l.split("=")),
	);
	for (const key of ["PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE"]) {
		const basename = written[key].split("/").pop();
		assert.ok(wizard.includes(`${key}: join(dir, "${basename}")`), `${key}: up writes ${basename}, and the wizard's pointer must name the same file`);
	}
	for (const key of ["PI_LOGS_DIR", "PI_SETTINGS_FILE"]) {
		assert.ok(!new RegExp(`${key}:\\s*join\\(dir`).test(wizard), `${key} is deliberately not in the pointer, so there is nothing to compare`);
	}
});

test("up: the two FILE keys get this folder and the two DURABLE ones get the account default (#357)", async () => {
	// The split is the sharpest edge in this change. `makeLogReaper` unlinks every `.log` and `.json` in
	// PI_LOGS_DIR past the window with no name shape and no ownership check, so a deployment folder there
	// would eat triggers.json and its siblings thirty days in, silently, and the worker would then run
	// nothing while reporting success. A pinned resolved default changes no behaviour and makes the value
	// explicit, which is what stops a worker under another `User=` and the panel resolving two directories.
	const h = harness({ plan: green, files: { "/deploy/.env": "" } });
	await h.run();
	const written = Object.fromEntries(
		h.store
			.get("/deploy/.env")
			.split("\n")
			.filter(Boolean)
			.map((l) => l.split("=")),
	);
	assert.equal(written.PI_PAUSE_WINDOWS_FILE, "/deploy/pause-windows.json");
	assert.equal(written.PI_SCOPED_LIMITS_FILE, "/deploy/scoped-limits.json");
	assert.equal(written.PI_LOGS_DIR, "/home/op/.pi-dispatch/logs");
	assert.equal(written.PI_SETTINGS_FILE, "/home/op/.pi-dispatch/settings.json");
	for (const key of Object.keys(written)) assert.notEqual(written[key], "/deploy", `${key} must never be the deployment folder itself`);
	assert.notEqual(written.PI_LOGS_DIR, "/deploy/logs", "nor the directory the service installer already owns");
});

test("up REFUSES to pin a durable path that resolves inside this folder, and says why (#357)", async () => {
	// `logsDirPath` RESOLVES rather than defaults: `env.PI_LOGS_DIR || <account default>`. Three shipped
	// files told operators for a year that `up` pins these to the deployment folder, so a shell that
	// already exports one there is exactly the case this change makes reachable -- and persisting it would
	// hand the log retention sweep a directory holding triggers.json, which it deletes a month later with
	// no name shape and no ownership check. The refusal lives here rather than in the resolver, because
	// the resolver is right for the worker: an exported path SHOULD be honoured at run time.
	const h = harness({ plan: green, files: { "/deploy/.env": "" }, env: { PI_PROVIDER: "anthropic", PI_LOGS_DIR: "/deploy", PI_SETTINGS_FILE: "/deploy/logs/settings.json" } });
	await h.run();
	const written = h.store.get("/deploy/.env");
	assert.doesNotMatch(written, /^PI_LOGS_DIR=/m, "the deployment folder itself is refused");
	assert.doesNotMatch(written, /^PI_SETTINGS_FILE=/m, "and so is anything under it");
	assert.match(h.text(), /PI_LOGS_DIR is \/deploy in this shell, which is inside this deployment folder/, "and it names where the value came from, or the operator looks in .env and finds nothing to change");
	assert.match(h.text(), /NOT written/);
	// The two FOLDER keys are unaffected: they are meant to be here, and nothing sweeps them.
	assert.match(written, /^PI_PAUSE_WINDOWS_FILE=\/deploy\/pause-windows\.json$/m);
});

test("up REFUSES a RELATIVE durable path, which is the same harm reached the short way (#357)", async () => {
	// `PI_LOGS_DIR=.` in the shell that runs `up` is persisted verbatim, and a relative value resolves
	// against the unit's `WorkingDirectory`, which is the deployment folder. The retention sweep then takes
	// `triggers.json` and its siblings a month later. All three deploy templates document this key as
	// absolute, and until this refusal nothing enforced it.
	for (const relative of [".", "./logs", "logs", "../pi-logs"]) {
		const h = harness({ plan: green, files: { "/deploy/.env": "" }, env: { PI_PROVIDER: "anthropic", PI_LOGS_DIR: relative } });
		await h.run();
		assert.doesNotMatch(h.store.get("/deploy/.env"), /^PI_LOGS_DIR=/m, relative);
		assert.match(h.text(), /is not an absolute path/, relative);
	}
});

test("up does NOT refuse a computed default that happens to sit under this folder (#357)", async () => {
	// A deployment folder that IS the service account's home is an ordinary layout, and the account default
	// is then `<home>/.pi-dispatch/logs`, which is "inside" it. Nothing is at risk there: that directory
	// holds run records only, `triggers.json` is a sibling of `.pi-dispatch` rather than inside it, and the
	// worker resolves that same path anyway. Refusing would reject the path already chosen and blame the
	// operator for a layout that is fine, so only a value THIS SHELL supplied is checked.
	const h = harness({ plan: green, files: { "/deploy/.env": "" }, env: { PI_PROVIDER: "anthropic" }, logsDirPathFn: () => "/deploy/.pi-dispatch/logs", settingsFilePathFn: () => "/deploy/.pi-dispatch/settings.json" });
	await h.run();
	assert.match(h.store.get("/deploy/.env"), /^PI_LOGS_DIR=\/deploy\/\.pi-dispatch\/logs$/m);
	assert.doesNotMatch(h.text(), /NOT written/);
});

test("up: the inside-the-folder compare folds case on Windows and does not on POSIX (#357)", async () => {
	// `nssm-install.cmd` is a supported deployment. Windows paths are case-insensitive and accept either
	// separator, so a byte compare misses `c:\\pi\\deploy\\logs` against `C:/pi/deploy` and writes exactly
	// the value this guard exists to refuse. POSIX is case-sensitive, where folding would refuse a
	// different directory that merely looks alike.
	const win = harness({ plan: green, files: { "C:/pi/deploy/.env": "" }, env: { PI_PROVIDER: "anthropic", PI_LOGS_DIR: "c:\\pi\\deploy\\logs" }, cwd: "C:/pi/deploy", platform: "win32" });
	await win.run();
	assert.doesNotMatch(win.store.get("C:/pi/deploy/.env"), /^PI_LOGS_DIR=/m, "the same folder in another spelling is still this folder");

	const posix = harness({ plan: green, files: { "/deploy/.env": "" }, env: { PI_PROVIDER: "anthropic", PI_LOGS_DIR: "/DEPLOY/logs" }, cwd: "/deploy", platform: "linux" });
	await posix.run();
	assert.match(posix.store.get("/deploy/.env"), /^PI_LOGS_DIR=\/DEPLOY\/logs$/m, "and a differently-cased path on POSIX is a different directory");

	// And the absolute check has to use the same platform, or a perfectly good drive-letter path reads as
	// relative and is refused with a message about a `WorkingDirectory` that has nothing to do with it.
	const otherDrive = harness({ plan: green, files: { "C:/pi/deploy/.env": "" }, env: { PI_PROVIDER: "anthropic", PI_LOGS_DIR: "D:/pi-history" }, cwd: "C:/pi/deploy", platform: "win32" });
	await otherDrive.run();
	assert.match(otherDrive.store.get("C:/pi/deploy/.env"), /^PI_LOGS_DIR=D:\/pi-history$/m, "another drive is absolute, and is not inside this folder");
	assert.doesNotMatch(otherDrive.text(), /not an absolute path/);
});

test("up writes Windows paths with forward slashes, so the cmd loader reads them bare (#357)", async () => {
	// `deploy/worker-env-wrapper.cmd` states its own contract: "Values MUST be UNQUOTED -- cmd's `set`
	// keeps surrounding quotes as part of the value." A backslash is outside the bare set, so quoting one
	// there produces four directories that do not exist, behind four ✓. Forward slashes are accepted
	// everywhere Node accepts a path on Windows, and `config.mjs` already spells its own defaults that way.
	const h = harness({
		plan: green,
		files: { "C:/pi/deploy/.env": "" },
		env: { PI_PROVIDER: "anthropic" },
		// Forward slashes in `cwd` because `join` here is this host's, not win32's; what the win32 branch
		// has to convert is the RESOLVER output below, which is where a real Windows path comes from.
		cwd: "C:/pi/deploy",
		platform: "win32",
		logsDirPathFn: () => "C:\\Users\\op\\.pi-dispatch\\logs",
		settingsFilePathFn: () => "C:\\Users\\op\\.pi-dispatch\\settings.json",
	});
	await h.run();
	const written = h.store.get("C:/pi/deploy/.env") ?? "";
	assert.doesNotMatch(written, /'/, "no value is quoted, because cmd's `set` would keep the quotes");
	assert.doesNotMatch(written, /\\\\/, "and none carries a backslash, which the bare set excludes for the shells");
	assert.match(written, /^PI_LOGS_DIR=C:\/Users\/op\/\.pi-dispatch\/logs$/m);
});

test("up edits a symlinked .env through the link, with the REAL fs seam (#357)", async () => {
	// The one test here that uses no fs fake, because the defect it pins is a fake's shape rather than a
	// behaviour: `updateEnvFile` resolves the path with an OPTIONAL call, so a seam missing
	// `realpathSync` makes the resolution silently inert. It shipped that way, and the test that covered
	// it attached the method to its own fake. A deployment whose `.env` points at a shared env file is an
	// ordinary layout, and replacing the link orphans every later edit to the shared file.
	const dir = tempDir("pi-up-link-");
	const shared = join(dir, "shared.env");
	writeFileSync(shared, "WEBHOOK_SECRET=\n");
	symlinkSync(shared, join(dir, ".env"));
	const buf = [];
	await runUp(["--yes"], {
		env: { PI_PROVIDER: "anthropic" },
		cwd: dir,
		out: (s) => buf.push(s),
		spawn: fakeSpawn(green, []),
		prompt: async () => "n",
		probeTcp: async () => true,
		randomHex: () => SECRET,
		runInitFn: () => 0,
		runDoctorFn: () => 0,
	});
	assert.ok(lstatSync(join(dir, ".env")).isSymbolicLink(), "the link survives a real up");
	assert.match(readFileSync(shared, "utf8"), /^WEBHOOK_SECRET=/m, "and the shared file is what was edited");
});

test("up reports a .env it cannot write at all, rather than dying with a stack trace (#357)", async () => {
	// A read-only deployment directory, a full disk, or a `.env` this account does not own. The
	// WEBHOOK_SECRET write is the first one and used to be the unwrapped one.
	const h = harness({ plan: green, files: { "/deploy/.env": "" } });
	h.store.set("/deploy/.env", "");
	const original = h.deps.fs.writeFileSync;
	h.deps.fs.writeFileSync = () => {
		throw Object.assign(new Error("EACCES: permission denied, open '/deploy/.env.tmp'"), { code: "EACCES" });
	};
	assert.equal(await h.run(), 0, "a .env it cannot write is reported, not fatal");
	h.deps.fs.writeFileSync = original;
	assert.match(h.text(), /WEBHOOK_SECRET could not be written: EACCES/);
	assert.match(h.text(), /PI_LOGS_DIR could not be written: EACCES/);
});

test("up refuses a value this .env cannot represent, rather than writing one nothing reads back (#357)", async () => {
	// `renderEnvValue` throws on a single quote: the shells want it escaped as `'\\''` and systemd's parser
	// does not understand that, so no one rendering is read identically by both consumers.
	const h = harness({ plan: green, files: { "/it's/deploy/.env": "" }, env: { PI_PROVIDER: "anthropic" }, cwd: "/it's/deploy" });
	await h.run();
	assert.match(h.text(), /PI_PAUSE_WINDOWS_FILE could not be written: .*single quote/);
	assert.match(h.text(), /NOT written/);
});

test("up: a sibling folder with the same prefix is not 'inside' this one (#357)", async () => {
	// `/deploy-archive` starts with `/deploy` and is a different directory. A prefix compare would refuse
	// a perfectly good path and send the operator looking for a problem that is not there.
	const h = harness({ plan: green, files: { "/deploy/.env": "" }, env: { PI_PROVIDER: "anthropic", PI_LOGS_DIR: "/deploy-archive/logs" } });
	await h.run();
	assert.match(h.store.get("/deploy/.env"), /^PI_LOGS_DIR=\/deploy-archive\/logs$/m);
});

test("up: the doctor layer never overrides a value THIS SHELL sets (#357)", async () => {
	// `wrote` holds keys that were empty in the FILE, which is a different question from whether the
	// environment sets them. An operator exporting a limits file while the key is still commented in
	// `.env` would otherwise have up's doctor read back the file up chose, not the one their worker loads.
	const h = harness({
		plan: green,
		files: { "/deploy/.env": "" },
		env: { PI_PROVIDER: "anthropic", PI_SCOPED_LIMITS_FILE: "/etc/pi/limits.json", PI_PAUSE_WINDOWS_FILE: "   " },
	});
	await h.run();
	assert.equal(h.doctorCalls[0].PI_SCOPED_LIMITS_FILE, "/etc/pi/limits.json", "the exported value is what this shell's worker would load");
	// THE PIN THAT FLIPPED (issue #384). It used to read "a blank export is not a value, so the layer fills
	// it", and that sentence was the defect: three exported spaces are exactly what this shell's worker gets,
	// it keeps them through `??`, and `start.mjs` throws on them before the first job. Filling the key handed
	// doctor a deployment the operator is not running, so `up` exited 0 on a worker that cannot start. What
	// this shell sets is what doctor judges, and doctor says the value is blank.
	assert.equal(h.doctorCalls[0].PI_PAUSE_WINDOWS_FILE, "   ", "a blank export is what the worker would load, so it is what doctor is given");
	assert.match(h.store.get("/deploy/.env"), /^PI_SCOPED_LIMITS_FILE=\/deploy\/scoped-limits\.json$/m, "and the FILE still gets this folder, which is what the service will read");
});

test("up hands its OWN doctor call what it just wrote, or it warns about what it just fixed (#357)", async () => {
	// Nothing in this project loads `.env` into an environment (docs/secrets.md), so the lines above
	// configure the SERVICE and not this process. Unlayered, `up` would write both file paths and then warn
	// three lines later that they are unset, which is the defect issue #357 reported from the other end.
	const h = harness({ plan: green, files: { "/deploy/.env": "" }, env: { PI_PROVIDER: "anthropic" } });
	await h.run();
	assert.equal(h.doctorCalls.length, 1);
	assert.equal(h.doctorCalls[0].PI_PAUSE_WINDOWS_FILE, "/deploy/pause-windows.json");
	assert.equal(h.doctorCalls[0].PI_SCOPED_LIMITS_FILE, "/deploy/scoped-limits.json");
	assert.equal(h.doctorCalls[0].PI_LOGS_DIR, "/home/op/.pi-dispatch/logs");
	assert.equal(h.doctorCalls[0].PI_PROVIDER, "anthropic", "and the layer adds, it does not replace the environment");
});

test("up leaves every one of the four alone when the operator already set it (#357)", async () => {
	const mine = ["PI_PAUSE_WINDOWS_FILE=/elsewhere/windows.json", "PI_SCOPED_LIMITS_FILE=/elsewhere/limits.json", "PI_LOGS_DIR=/var/log/pi", "PI_SETTINGS_FILE=/etc/pi/settings.json"].join("\n");
	const h = harness({ plan: green, files: { "/deploy/.env": `${mine}\nWEBHOOK_SECRET=x\n` } });
	await h.run();
	assert.equal(h.store.get("/deploy/.env"), `${mine}\nWEBHOOK_SECRET=x\n`, "four keys, four chances to clobber, none taken");
	// And the layer must not put back what the operator overrode: `wrote` holds only keys that were empty.
	assert.equal(h.doctorCalls[0].PI_LOGS_DIR, undefined, "an operator value stays the environment's business");
	for (const key of ["PI_PAUSE_WINDOWS_FILE", "PI_SCOPED_LIMITS_FILE", "PI_LOGS_DIR", "PI_SETTINGS_FILE"]) {
		assert.match(h.text(), new RegExp(`${key}\\s+already set`), `${key} says it was left alone`);
	}
	assert.doesNotMatch(h.text(), /written into \.env/, "and nothing claims a write that did not happen");
});

test("up: an operator's existing WEBHOOK_SECRET is never touched", async () => {
	const h = harness({ plan: green, files: { "/deploy/.env": "WEBHOOK_SECRET=operator-chose-this\n" } });
	await h.run();
	assert.match(h.store.get("/deploy/.env"), /^WEBHOOK_SECRET=operator-chose-this\n/, "the operator's line is the first line still, byte for byte");
	assert.match(h.text(), /already set/);
	assert.ok(!h.text().includes("operator-chose-this"), "existing values are secrets too");
});

test("up: no .env after init means the secret step is skipped, not invented", async () => {
	const h = harness({ plan: green, files: {} });
	assert.equal(await h.run(), 0);
	assert.equal(h.store.has("/deploy/.env"), false, "up never creates a .env behind init's back");
	assert.match(h.text(), /no \.env here/);
});

test("up: a down docker daemon returns 1 before any prompt, init, or doctor", async () => {
	const h = harness({ plan: { "docker version": 1 }, listening: false });
	assert.equal(await h.run(), 1);
	assert.equal(h.promptCalls.length, 0, "no consent is collected for actions that cannot run");
	assert.equal(h.initCalls.length, 0);
	assert.equal(h.doctorCalls.length, 0);
	assert.match(h.text(), /start Docker/, "a down daemon is distinguished from a missing binary");
});

test("up: a missing docker binary reads as 'install', not 'start', and also returns 1", async () => {
	const h = harness({ plan: { "docker version": "enoent" } });
	assert.equal(await h.run(), 1);
	assert.match(h.text(), /install Docker/);
});

test("up: doctor's nonzero exit code propagates as up's own", async () => {
	const h = harness({ plan: green, doctorCode: 1 });
	assert.equal(await h.run(), 1);
});

test("up: a failed accepted pull is reported, skips the tag, and still reaches doctor (converge-style)", async () => {
	const h = harness({
		plan: { "docker version": 0, "docker image inspect": 1, "docker pull": 1 },
		listening: true,
		argv: ["--yes"],
	});
	assert.equal(await h.run(), 0, "a failed step does not fail up; doctor's verdict is the exit code");
	assert.equal(h.calls.map((c) => c.args).find((a) => a[0] === "tag"), undefined, "no tag of an image that never arrived");
	assert.equal(h.doctorCalls.length, 1);
	assert.match(h.text(), /pull FAILED/);
});

test("defaultPrompt: non-TTY stdin declines immediately without readline (the event-loop-drain trap)", async () => {
	// Against an ended stream, rl.question()'s promise never settles and holds no handle, so a real
	// `up < /dev/null` would exit 0 mid-sequence, skipping init and doctor while looking like success.
	// The guard turns that into an explicit printed decline. Regression test for exactly that run.
	let printed = "";
	const answer = await defaultPrompt("Proceed? [y/N] ", { isTTY: false, output: { write: (s) => (printed += s) } });
	assert.equal(answer, "", "an empty answer is the No contract");
	assert.match(printed, /Proceed\? \[y\/N\] /, "the question still reaches the transcript");
	assert.match(printed, /defaulting to No/, "the default is stated, not silent");
});

// --- REQ-EGRESS-ALLOWLIST: up offers the proxy, and only to a deployment that armed the policy --------

const EGRESS_ENV = { PI_PROVIDER: "anthropic", PI_EGRESS: "1" };
// Issue #453: the shipped proxy's state is one inspect, status, image and mounts (`egress-proxy-state.mjs`). A container
// made by `up` or compose in THIS folder carries the pinned image and the two files below.
const PROXY_INSPECT = 'docker inspect --format={"status":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}"none"{{end}},"image":{{json .Config.Image}},"entrypoint":{{json .Config.Entrypoint}},"cmd":{{json .Config.Cmd}},"mounts":{{json .Mounts}},"networks":{{json .NetworkSettings.Networks}}} pi-dispatch-egress-proxy';
const PINNED_SQUID = "ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029";
// The pinned image's own entrypoint and command and its two anonymous volumes (its registry config, 2026-09-27).
const SQUID_ENTRYPOINT = ["entrypoint.sh"];
const SQUID_CMD = ["-f", "/etc/squid/squid.conf", "-NYC"];
const proxyState = (status, { image = PINNED_SQUID, conf = "/deploy/deploy/egress-proxy.conf", allowlist = "/deploy/egress-allowlist.conf", entrypoint = SQUID_ENTRYPOINT, cmd = SQUID_CMD, extra = [], networks = ["pi-dispatch-egress-out"], stderr } = {}) => ({
	code: 0,
	output: `${JSON.stringify({
		status,
		health: "none",
		image,
		entrypoint,
		cmd,
		mounts: [
			...(conf ? [{ Type: "bind", Source: conf, Destination: "/etc/squid/squid.conf" }] : []),
			...(allowlist ? [{ Type: "bind", Source: allowlist, Destination: "/etc/pi-dispatch/allowlist.conf" }] : []),
			{ Type: "volume", Source: "/var/lib/docker/volumes/a1/_data", Destination: "/var/log/squid" },
			{ Type: "volume", Source: "/var/lib/docker/volumes/b2/_data", Destination: "/var/spool/squid" },
			...extra,
		],
		networks: Object.fromEntries(networks.map((n) => [n, {}])),
	})}\n`,
	...(stderr ? { stderr } : {}),
});
const EGRESS_NET = ["network", "create", "pi-dispatch-egress-out"];
const EGRESS_RUN = [
	"run", "-d", "--name", "pi-dispatch-egress-proxy", "--restart", "unless-stopped",
	"--network", "pi-dispatch-egress-out",
	"-v", "./deploy/egress-proxy.conf:/etc/squid/squid.conf:ro,z",
	"-v", "./egress-allowlist.conf:/etc/pi-dispatch/allowlist.conf:ro,z",
	"ubuntu/squid@sha256:6a097f68bae708cedbabd6188d68c7e2e7a38cedd05a176e1cc0ba29e3bbe029",
];

test("up: a deployment that turned the policy OFF is never asked about a proxy", async () => {
	// PI_EGRESS=0 is the opt-out rather than the default now, and up still says nothing to a deployment
	// that took it: up never invents operator policy, the same doctrine that keeps it pulling this repo's
	// own image and no other.
	const h = harness({ env: { PI_PROVIDER: "anthropic", PI_EGRESS: "0" }, plan: green, listening: true });
	await h.run();
	assert.doesNotMatch(h.text(), /egress/i);
	assert.ok(!h.calls.some((c) => c.args.includes("pi-dispatch-egress-proxy")));
});

test("up: an armed policy with the proxy already up prompts for nothing", async () => {
	const h = harness({
		env: EGRESS_ENV,
		plan: { ...green, [PROXY_INSPECT]: proxyState("running") },
		listening: true,
	});
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /✓ Egress proxy already present/);
	assert.equal(h.promptCalls.length, 0);
});

test("up: --yes starts the proxy with exactly the argv it showed", async () => {
	const h = harness({
		env: EGRESS_ENV,
		plan: { ...green, [PROXY_INSPECT]: 1, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 },
		listening: true,
		files: { "/deploy/egress-allowlist.conf": "api.anthropic.com\n", "/deploy/deploy/egress-proxy.conf": "conf\n" },
		argv: ["--yes"],
	});
	await h.run();
	const ran = h.calls.filter((c) => c.args[0] === "network" || c.args[0] === "run").map((c) => c.args);
	assert.ok(ran.some((a) => JSON.stringify(a) === JSON.stringify(EGRESS_NET)), "the network argv is the one shown");
	assert.ok(ran.some((a) => JSON.stringify(a) === JSON.stringify(EGRESS_RUN)), "the proxy argv is the one shown");
	assert.match(h.text(), /started pi-dispatch-egress-proxy/);
});

test("up: an armed policy with NO allowlist file declines itself rather than starting a deny-everything proxy", async () => {
	// Starting a proxy whose allowlist file does not exist gets a DIRECTORY created by docker where a file
	// belonged, and a squid that fails confusingly. Naming the file is the fix; starting it is not.
	const h = harness({
		env: EGRESS_ENV,
		plan: { ...green, [PROXY_INSPECT]: 1 },
		listening: true,
		argv: ["--yes"],
	});
	await h.run();
	assert.match(h.text(), /egress-allowlist\.conf is not here/);
	assert.ok(!h.calls.some((c) => c.args.includes("pi-dispatch-egress-proxy") && c.args[0] === "run"), "nothing is started");
});

test("up: a declined proxy prompt runs nothing, and the summary says what that costs", async () => {
	const h = harness({
		env: EGRESS_ENV,
		plan: { ...green, [PROXY_INSPECT]: 1 },
		listening: true,
		files: { "/deploy/egress-allowlist.conf": "api.anthropic.com\n", "/deploy/deploy/egress-proxy.conf": "conf\n" },
		answers: ["n"],
	});
	await h.run();
	assert.ok(!h.calls.some((c) => c.args[0] === "run" && c.args.includes("pi-dispatch-egress-proxy")));
	assert.match(h.text(), /every job is refused pre-spend until the proxy is up/);
});

// ---------------------------------------------------------------------------------------------------
// The podman venue (issue #430): with PI_BACKENDS naming podman and not local, `up` drives rootless Podman and the
// SAME Quadlet installer `service install` uses, and never runs docker. The info read is injected as the venue's own
// reader shape, so the gate is the worker's `decidePodmanJobUser` and nothing re-implemented here.
// ---------------------------------------------------------------------------------------------------

const QDIR = "/home/op/.config/containers/systemd";
const rootless = async () => ({ answered: true, info: { rootless: true, serviceIsRemote: false, selinux: false } });
const podmanExtra = (over = {}) => ({ readPodmanInfo: rootless, euid: 1234, egid: 1234, home: "/home/op", user: "op", mkdir: () => {}, ...over });

test("up on podman: --yes runs exactly the lines it showed, installs the Quadlet stack, and never spawns docker", async () => {
	const h = harness({
		env: { PI_PROVIDER: "anthropic", PI_BACKENDS: "podman" },
		plan: { "podman image exists": 1, "podman pull": 0, "podman tag": 0, "podman inspect": 1, systemctl: 0, "loginctl show-user": { code: 0, output: "Linger=no\n" } },
		listening: false,
		argv: ["--yes"],
		files: { "/deploy/egress-allowlist.conf": "api.anthropic.com\n", "/deploy/deploy/egress-proxy.conf": "conf\n" },
		extra: podmanExtra(),
	});
	assert.equal(await h.run(), 0);
	assert.ok(!h.calls.some((c) => c.cmd === "docker"), "a podman-only deployment never asks docker anything");
	const text = h.text();
	// What was shown: the consent block's indented lines after the Quadlet intro.
	const from = text.indexOf("as Quadlet units in your user manager");
	const block = text.slice(from, text.indexOf("--yes: accepted", from));
	const shown = block.split("\n").slice(1).filter((l) => l.startsWith("  ")).map((l) => l.trim());
	const ran = [];
	for (const c of h.calls) if ((c.cmd === "systemctl" && c.args[1] !== "show-environment")) ran.push([c.cmd, ...c.args].join(" "));
	const written = [...h.store.keys()].filter((p) => p.startsWith(QDIR) || p === "/home/op/.config/pi-dispatch/egress-proxy.conf").map((p) => `write ${p}`);
	assert.deepEqual(shown, [...written, ...ran], "shown then run: the same lines, in the same order");
	assert.deepEqual(ran, ["systemctl --user daemon-reload", "systemctl --user start pi-dispatch-valkey.service pi-dispatch-egress-proxy.service pi-dispatch-netns-keeper.service"]);
	assert.equal(written.length, 7, "six units (the keeper's two since #458) and the account-owned copy of the rules");
	assert.ok(!ran.some((l) => / enable /.test(l)), "a generated unit is never enabled");
	assert.deepEqual(h.calls.filter((c) => c.cmd === "podman" && c.args[0] !== "inspect" && c.args[0] !== "container").map((c) => c.args), [
		["image", "exists", "pi-job:latest"],
		["pull", "ghcr.io/edgehero/pi-job:latest"],
		["tag", "ghcr.io/edgehero/pi-job:latest", "pi-job:latest"],
	]);
	assert.match(text, /⚠ linger is OFF for op/);
	assert.match(text, /sudo loginctl enable-linger op/);
	assert.match(text, /podman stack\s+installed as Quadlet units and started/);
});

test("up on podman: a rootful Podman stops up with the worker's own refusal, having run and written nothing", async () => {
	const h = harness({
		env: { PI_BACKENDS: "podman" },
		listening: false,
		argv: ["--yes"],
		extra: podmanExtra({ readPodmanInfo: async () => ({ answered: true, info: { rootless: false, serviceIsRemote: false } }) }),
	});
	assert.equal(await h.run(), 1);
	assert.match(h.text(), /podman is not rootless for this account/);
	assert.equal(h.calls.length, 0);
	assert.equal(h.initCalls.length, 0, "stops before init, like the docker gate");
	assert.equal(h.doctorCalls.length, 0);
});

test("up on podman: declining the stack runs nothing and writes no Quadlet file", async () => {
	const h = harness({
		env: { PI_BACKENDS: "podman", PI_EGRESS: "0" },
		plan: { "podman image exists": 0 },
		listening: false,
		answers: [""],
		extra: podmanExtra(),
	});
	assert.equal(await h.run(), 0);
	assert.equal(h.promptCalls.length, 1);
	assert.ok(![...h.store.keys()].some((p) => p.startsWith(QDIR)));
	assert.ok(!h.calls.some((c) => (c.cmd === "systemctl" && c.args[1] !== "show-environment")));
	assert.match(h.text(), /valkey\s+skipped \(declined\)/);
});

test("up on podman: a listener on 6379 is left alone, as on docker", async () => {
	const h = harness({
		env: { PI_BACKENDS: "podman", PI_EGRESS: "0" },
		plan: { "podman image exists": 0, "podman ps": { code: 0, output: "pi-dispatch-valkey\n" } },
		listening: true,
		extra: podmanExtra(),
	});
	assert.equal(await h.run(), 0);
	assert.equal(h.promptCalls.length, 0);
	assert.match(h.text(), /container pi-dispatch-valkey already running/);
});

test("up on local,podman: the docker steps are unchanged, then podman's image and proxy; Valkey stays docker's", async () => {
	const h = harness({
		env: { PI_BACKENDS: "local,podman" },
		plan: { ...green, [PROXY_INSPECT]: proxyState("running"), "podman image exists": 0, "podman inspect": 1, systemctl: 0, "loginctl show-user": { code: 0, output: "Linger=yes\n" } },
		listening: true,
		argv: ["--yes"],
		files: { "/deploy/egress-allowlist.conf": "x\n", "/deploy/deploy/egress-proxy.conf": "conf\n" },
		extra: podmanExtra(),
	});
	assert.equal(await h.run(), 0);
	assert.deepEqual(h.calls.slice(0, 3).map((c) => [c.cmd, ...c.args]), [
		["docker", "version"],
		["docker", "image", "inspect", "pi-job:latest"],
		["docker", "ps", "--filter", "name=pi-dispatch-valkey", "--format", "{{.Names}}"],
	]);
	assert.ok(![...h.store.keys()].some((p) => p.endsWith("pi-dispatch-valkey.container")), "no second Valkey on a docker host");
	assert.ok(h.store.has(`${QDIR}/pi-dispatch-egress-proxy.container`), "podman jobs still need podman's own proxy");
	assert.ok(h.calls.some((c) => (c.cmd === "systemctl" && c.args[1] !== "show-environment") && c.args.join(" ") === "--user start pi-dispatch-egress-proxy.service pi-dispatch-netns-keeper.service"));
});

// Issue #453: the docker proxy is RUNNING only when `docker inspect` prints `true` on stdout, as the podman path has read it
// since #430. An exited container also exits 0, so the exit code alone called a stopped proxy present and offered nothing.
const EGRESS_START = ["start", "pi-dispatch-egress-proxy"];

test("up on docker: a stopped shipped proxy is started as it is, never recreated, with exactly the argv shown (#453)", async () => {
	const h = harness({
		env: EGRESS_ENV,
		plan: { ...green, [PROXY_INSPECT]: proxyState("exited"), "docker start pi-dispatch-egress-proxy": 0 },
		listening: true,
		files: { "/deploy/egress-allowlist.conf": "api.anthropic.com\n", "/deploy/deploy/egress-proxy.conf": "conf\n" },
		argv: ["--yes"],
	});
	assert.equal(await h.run(), 0);
	assert.doesNotMatch(h.text(), /Egress proxy already present/);
	assert.match(h.text(), /the allowlist proxy exists but is exited\. up would start that same container \(as deploy\/docker-compose\.yml --profile egress up -d does\):\n\s+docker start pi-dispatch-egress-proxy\n/);
	const mutations = h.calls.filter((c) => c.cmd === "docker" && ["start", "run", "network", "rm"].includes(c.args[0])).map((c) => c.args);
	assert.deepEqual(mutations, [EGRESS_START], "one start of the existing container: no rm, no run on a taken name, no network create");
	assert.match(h.text(), /egress\s+started the exited pi-dispatch-egress-proxy/);
});

test("up on docker: a stopped shipped proxy, declined or failing to start, is said, and nothing else runs (#453)", async () => {
	const declined = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("exited") }, listening: true, files: { "/deploy/egress-allowlist.conf": "x\n", "/deploy/deploy/egress-proxy.conf": "conf\n" }, answers: ["n"] });
	assert.equal(await declined.run(), 0);
	assert.ok(!declined.calls.some((c) => ["start", "run", "network"].includes(c.args[0])), "declined runs nothing");
	assert.match(declined.text(), /skipped: start it later with `docker start pi-dispatch-egress-proxy`/);
	assert.match(declined.text(), /egress\s+skipped \(declined\): every job is refused pre-spend until the proxy is up/);
	const failing = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("exited"), "docker start": 1 }, listening: true, files: { "/deploy/egress-allowlist.conf": "x\n", "/deploy/deploy/egress-proxy.conf": "conf\n" }, argv: ["--yes"] });
	assert.equal(await failing.run(), 0, "doctor is the judge of what remains");
	assert.match(failing.text(), /✗ could not start the egress proxy; `docker rm -f pi-dispatch-egress-proxy` and re-run `pi-dispatch up` recreates it/);
	assert.ok(!failing.calls.some((c) => c.args[0] === "run" || c.args[0] === "rm"), "never removes or recreates it by itself");
	// No allowlist here: declined before any offer, as for an absent proxy.
	const bare = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("exited") }, listening: true, argv: ["--yes"] });
	await bare.run();
	assert.match(bare.text(), /egress-allowlist\.conf is not here/);
	assert.ok(!bare.calls.some((c) => c.args[0] === "start"));
});

test("up on docker: a running proxy is read off stdout alone, whatever docker prints on stderr (#453)", async () => {
	const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running", { stderr: "WARNING: something the CLI says\n" }) }, listening: true, files: { "/deploy/egress-allowlist.conf": "x\n", "/deploy/deploy/egress-proxy.conf": "conf\n" }, argv: ["--yes"] });
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /✓ Egress proxy already present \(pi-dispatch-egress-proxy\)/);
	assert.ok(!h.calls.some((c) => ["start", "run", "network"].includes(c.args[0])));
});

test("up on docker: a PI_EGRESS_PROXY container that exists but is stopped is reported, never started (#453)", async () => {
	const stopped = harness({ env: { PI_EGRESS_PROXY: "my-squid" }, plan: { ...green, "docker inspect": { code: 0, output: "exited\n" } }, listening: true, files: { "/deploy/egress-allowlist.conf": "x\n", "/deploy/deploy/egress-proxy.conf": "conf\n" }, argv: ["--yes"] });
	assert.equal(await stopped.run(), 0);
	assert.match(stopped.text(), /✗ PI_EGRESS_PROXY names my-squid, and that container exists but is not running \(exited\)\. up starts only the shipped pi-dispatch-egress-proxy, so start my-squid yourself\n/);
	assert.match(stopped.text(), /egress\s+my-squid \(PI_EGRESS_PROXY\) exists but is not running; every job is refused pre-spend until it runs/);
	assert.doesNotMatch(stopped.text(), /Egress proxy present/);
	assert.ok(!stopped.calls.some((c) => ["start", "run", "network"].includes(c.args[0])), "the operator's container is never started");
	const running = harness({ env: { PI_EGRESS_PROXY: "my-squid" }, plan: { ...green, "docker inspect": { code: 0, output: "running\n" } }, listening: true, files: { "/deploy/egress-allowlist.conf": "x\n", "/deploy/deploy/egress-proxy.conf": "conf\n" } });
	assert.equal(await running.run(), 0);
	assert.match(running.text(), /✓ Egress proxy present \(my-squid, named by PI_EGRESS_PROXY\)/);
});

const EGRESS_RM = ["rm", "-f", "pi-dispatch-egress-proxy"];
const PROXY_FILES = { "/deploy/egress-allowlist.conf": "x\n", "/deploy/deploy/egress-proxy.conf": "conf\n" };
// Mutations only: the quiet `network inspect` before a create is a read (exec round 3).
const dockerMutations = (h) => h.calls.filter((c) => c.cmd === "docker" && ["start", "unpause", "run", "network", "rm"].includes(c.args[0]) && c.args[1] !== "inspect").map((c) => c.args);

test("up on docker: a shipped proxy from another squid or another folder is never started as it is, running or not, and is offered a recreate (#453 gate)", async () => {
	for (const [label, state, said] of [
		["stale digest, exited", proxyState("exited", { image: "ubuntu/squid@sha256:" + "0".repeat(64) }), /it was created from ubuntu\/squid@sha256:0{64}, not the pinned ubuntu\/squid@sha256:6a097f68/],
		["another folder's allowlist, exited", proxyState("exited", { allowlist: "/srv/other/egress-allowlist.conf" }), /its \/etc\/pi-dispatch\/allowlist\.conf is \/srv\/other\/egress-allowlist\.conf, not \/deploy\/egress-allowlist\.conf/],
		["another folder's squid.conf, RUNNING", proxyState("running", { conf: "/srv/other/deploy/egress-proxy.conf" }), /its \/etc\/squid\/squid\.conf is \/srv\/other\/deploy\/egress-proxy\.conf, not \/deploy\/deploy\/egress-proxy\.conf/],
		["no mounts at all, running", proxyState("running", { conf: null, allowlist: null }), /nothing is mounted at \/etc\/squid\/squid\.conf, where \/deploy\/deploy\/egress-proxy\.conf belongs/],
	]) {
		const yes = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: state, "docker rm": 0, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
		assert.equal(await yes.run(), 0, label);
		assert.match(yes.text(), /✗ pi-dispatch-egress-proxy exists \((exited|running)\) but is not this deployment's proxy: /, label);
		assert.match(yes.text(), said, label);
		assert.doesNotMatch(yes.text(), /Egress proxy already present/, label);
		assert.deepEqual(dockerMutations(yes), [EGRESS_RM, EGRESS_NET, EGRESS_RUN], `${label}: removed and run from the shown argv, never started as it is`);
		assert.match(yes.text(), /egress\s+replaced the stale pi-dispatch-egress-proxy with the shipped one/, label);
		const no = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: state }, listening: true, files: PROXY_FILES, answers: ["n"] });
		await no.run();
		assert.deepEqual(dockerMutations(no), [], `${label}: declined runs nothing`);
		assert.match(no.text(), /egress\s+stale proxy left as it is \(declined\): its policy is not this deployment's/, label);
	}
	// A symlinked deployment folder is one folder: the realpath of both sides decides.
	const linked = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running", { conf: "/real/deploy/egress-proxy.conf", allowlist: "/real/egress-allowlist.conf" }) }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	linked.deps.fs.realpathSync = (p) => p.replace(/^\/deploy\//, "/real/");
	assert.equal(await linked.run(), 0);
	assert.match(linked.text(), /✓ Egress proxy already present/);
	// Stale, and this folder cannot recreate it: said, nothing run.
	const bare = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("exited", { image: "squid:old" }) }, listening: true, files: { "/deploy/egress-allowlist.conf": "x\n" }, argv: ["--yes"] });
	await bare.run();
	assert.match(bare.text(), /✗ deploy\/egress-proxy\.conf is not here, so up cannot recreate it from this folder/);
	assert.deepEqual(dockerMutations(bare), []);
});

test("up on docker: running means Status running: a paused proxy is unpaused, a crash-looping one is reported, and a missing egress-proxy.conf is never mounted (#453 gate)", async () => {
	const paused = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("paused"), "docker unpause": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	assert.equal(await paused.run(), 0);
	assert.doesNotMatch(paused.text(), /Egress proxy already present/);
	assert.deepEqual(dockerMutations(paused), [["unpause", "pi-dispatch-egress-proxy"]]);
	assert.match(paused.text(), /egress\s+unpaused the paused pi-dispatch-egress-proxy/);
	const looping = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("restarting") }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	assert.equal(await looping.run(), 0);
	assert.match(looping.text(), /✗ pi-dispatch-egress-proxy is restarting: its squid keeps exiting and its restart policy keeps bringing it back\. `docker logs pi-dispatch-egress-proxy` says why; meanwhile each job is retried once, then failed\n/);
	assert.deepEqual(dockerMutations(looping), []);
	// Absent proxy, allowlist here, the shipped squid.conf not: the runtime would create a directory there (gate 456).
	const noConf = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: 1 }, listening: true, files: { "/deploy/egress-allowlist.conf": "x\n" }, argv: ["--yes"] });
	await noConf.run();
	assert.match(noConf.text(), /✗ the egress policy is on but deploy\/egress-proxy\.conf is not here, so no proxy is started without it/);
	assert.deepEqual(dockerMutations(noConf), []);
});

test("up on docker: another entrypoint or command, or a bind the shipped proxy does not have, is stale; its anonymous volumes are not (#453 gate 2)", async () => {
	for (const [label, state, said] of [
		["a command pointing squid at another config (adversary Y7)", proxyState("running", { entrypoint: ["squid"], cmd: ["-N", "-f", "/tmp/open.conf"] }), /its entrypoint is \["squid"\], not the image's \["entrypoint\.sh"\]; its command is \["-N","-f","\/tmp\/open\.conf"\], not the image's \["-f","\/etc\/squid\/squid\.conf","-NYC"\]/],
		["an extra bind", proxyState("running", { extra: [{ Type: "bind", Source: "/deploy/open.conf", Destination: "/tmp/open.conf" }] }), /it has a bind at \/tmp\/open\.conf \(from \/deploy\/open\.conf\) that the shipped proxy does not/],
		["a volume somewhere else", proxyState("exited", { extra: [{ Type: "volume", Source: "/var/lib/docker/volumes/c3/_data", Destination: "/etc/squid/conf.d" }] }), /it has a volume at \/etc\/squid\/conf\.d/],
	]) {
		const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: state, "docker rm": 0, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
		await h.run();
		assert.match(h.text(), said, label);
		assert.deepEqual(dockerMutations(h), [EGRESS_RM, EGRESS_NET, EGRESS_RUN], label);
	}
	// The shipped shape itself, with its two anonymous volumes, is current.
	const current = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running") }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	await current.run();
	assert.match(current.text(), /✓ Egress proxy already present/);
});

test("up on docker: bind sources that do not resolve on this host make the mounts UNKNOWN, never stale, and never a removal (#453 gate 2)", async () => {
	// The shape Docker Desktop is expected to report (its VM's own paths); not measured here, so never acted on.
	const desktop = { conf: "/host_mnt/Users/op/deploy/deploy/egress-proxy.conf", allowlist: "/host_mnt/Users/op/deploy/egress-allowlist.conf" };
	const noResolve = (p) => {
		if (p.startsWith("/host_mnt/")) throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
		return p;
	};
	for (const status of ["running", "exited"]) {
		const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState(status, desktop), "docker start": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
		h.deps.fs.realpathSync = noResolve;
		await h.run();
		assert.match(h.text(), /⚠ could not compare pi-dispatch-egress-proxy's mounts on this host: \/host_mnt\/Users\/op\/deploy\/deploy\/egress-proxy\.conf, \/host_mnt\/Users\/op\/deploy\/egress-allowlist\.conf are paths this host cannot resolve \(the runtime's own VM's, as Docker Desktop reports its sources\), so those mounts cannot be compared from here\. Everything else about it is still judged, and up replaces nothing while one of its own two mounts is unknown\n/, status);
		assert.doesNotMatch(h.text(), /is not this deployment's proxy/, status);
		assert.ok(!dockerMutations(h).some((a) => a[0] === "rm" || a[0] === "run"), `${status}: never removed or recreated on an unknown`);
	}
	// Stale by image while an expected mount is unknown: the finding is said, and nothing is removed until it can be judged.
	const staleImage = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running", { ...desktop, image: "squid:old" }), "docker rm": 0, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	staleImage.deps.fs.realpathSync = noResolve;
	await staleImage.run();
	assert.match(staleImage.text(), /is not this deployment's proxy: it was created from squid:old, not the pinned ubuntu\/squid@sha256:6a097f68[0-9a-f]{56}\n/, "the image drift alone, the unknown mounts not called stale");
	assert.match(staleImage.text(), /not replaced: one of its own mounts could not be compared on this host \(above\)/);
	assert.deepEqual(dockerMutations(staleImage), []);
	// One bind unknown, the other and an extra mount still judged (round-cap re-review): each on its own.
	const partial = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running", { conf: "/host_mnt/Users/op/deploy/deploy/egress-proxy.conf", allowlist: "/srv/other/egress-allowlist.conf", extra: [{ Type: "bind", Source: "/host_mnt/tmp/open.conf", Destination: "/tmp/open.conf" }] }) }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	partial.deps.fs.realpathSync = (p) => (p.startsWith("/host_mnt/") ? noResolve(p) : p);
	await partial.run();
	assert.match(partial.text(), /⚠ could not compare pi-dispatch-egress-proxy's mounts on this host: \/host_mnt\/Users\/op\/deploy\/deploy\/egress-proxy\.conf is a path this host cannot resolve/);
	assert.match(partial.text(), /is not this deployment's proxy: its \/etc\/pi-dispatch\/allowlist\.conf is \/srv\/other\/egress-allowlist\.conf, not \/deploy\/egress-allowlist\.conf; it has a bind at \/tmp\/open\.conf/);
	assert.deepEqual(dockerMutations(partial), [], "an expected mount is unknown, so nothing is removed");
});

test("up on docker: replacing a stale proxy that carries job networks says so and says to stop the worker first; an unreadable state is left alone (#453 gate 2)", async () => {
	const state = proxyState("running", { image: "squid:old", networks: ["pi-dispatch-egress-out", "pi-job-local-a1-net", "pi-sandbox-b2-net"] });
	const h = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: state }, listening: true, files: PROXY_FILES, answers: ["n"] });
	await h.run();
	assert.match(h.promptCalls.join("\n") + h.text(), /It is attached to pi-job-local-a1-net, pi-sandbox-b2-net: removing it cuts those jobs off from their egress mid-run, so stop the worker first \(and let running jobs finish\):/);
	// --yes does not cover it (gate round 3): the lines are printed, a person is asked, and without a yes nothing runs.
	const unattended = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: state, "docker rm": 0, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	await unattended.run();
	assert.match(unattended.text(), /--yes does not cover replacing a proxy that jobs are using: answer below, or stop the worker and re-run\n/);
	assert.equal(unattended.promptCalls.length, 1, "asked, even under --yes");
	assert.deepEqual(dockerMutations(unattended), [], "an unanswered prompt removes nothing");
	const answered = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: state, "docker rm": 0, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"], answers: ["y"] });
	await answered.run();
	assert.deepEqual(dockerMutations(answered), [EGRESS_RM, EGRESS_NET, EGRESS_RUN], "a person's yes does");
	// A STOPPED stale proxy carries no traffic, so --yes still covers replacing it.
	const stopped = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("exited", { image: "squid:old", networks: ["pi-job-local-a1-net"] }), "docker rm": 0, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	await stopped.run();
	assert.deepEqual(dockerMutations(stopped), [EGRESS_RM, EGRESS_NET, EGRESS_RUN]);
	const quiet = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: proxyState("running", { image: "squid:old" }) }, listening: true, files: PROXY_FILES, answers: ["n"] });
	await quiet.run();
	assert.doesNotMatch(quiet.promptCalls.join("\n") + quiet.text(), /It is attached to/);
	// Exists, and its inspect answer reads as nothing: no start, no run on a taken name.
	const junk = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: { code: 0, output: "not json\n" } }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	await junk.run();
	assert.match(junk.text(), /✗ pi-dispatch-egress-proxy exists, but its state could not be read from `docker inspect`, so up leaves it as it is/);
	assert.deepEqual(dockerMutations(junk), []);
});

test("up's recreate creates the proxy's network only where it does not exist, so the daemon's 'already used' never prints (#453 exec round 3)", async () => {
	const plan = (exists) => ({ ...green, [PROXY_INSPECT]: proxyState("exited", { image: "squid:old" }), "docker network inspect pi-dispatch-egress-out": exists ? 0 : { code: 1, stderr: "Error: no such network\n" }, "docker rm": 0, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 });
	const there = harness({ env: EGRESS_ENV, plan: plan(true), listening: true, files: PROXY_FILES, argv: ["--yes"] });
	await there.run();
	assert.deepEqual(dockerMutations(there), [EGRESS_RM, EGRESS_RUN], "no create for a network that exists");
	assert.match(there.text(), /docker network create pi-dispatch-egress-out {3}\(only if it does not exist yet\)\n/, "the shown line says it is conditional");
	const absent = harness({ env: EGRESS_ENV, plan: plan(false), listening: true, files: PROXY_FILES, argv: ["--yes"] });
	await absent.run();
	assert.deepEqual(dockerMutations(absent), [EGRESS_RM, EGRESS_NET, EGRESS_RUN]);
	// The first start of an absent proxy follows the same rule.
	const fresh = harness({ env: EGRESS_ENV, plan: { ...green, [PROXY_INSPECT]: 1, "docker network inspect pi-dispatch-egress-out": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 }, listening: true, files: PROXY_FILES, argv: ["--yes"] });
	await fresh.run();
	assert.deepEqual(dockerMutations(fresh), [EGRESS_RUN]);
});

test("up's proxy image is the compose file's and the Quadlet unit's, one pinned digest (#453 gate)", () => {
	const compose = readFileSync(new URL("../../deploy/docker-compose.yml", import.meta.url), "utf8");
	const quadlet = readFileSync(new URL("../../deploy/pi-dispatch-egress-proxy.container", import.meta.url), "utf8");
	assert.match(compose, new RegExp(`^\\s*image: ${PINNED_SQUID.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}\\s*$`, "m"));
	assert.ok(quadlet.includes(`Image=docker.io/${PINNED_SQUID}\n`));
	assert.equal(EGRESS_RUN.at(-1), PINNED_SQUID);
});

test("up hands init the venues it decided, so init's next steps match the pass (#453)", async () => {
	const docker = harness({ plan: green, listening: true });
	await docker.run();
	assert.deepEqual(docker.initOpts.map((o) => o.venues), [{ localUsed: true, podmanUsed: false, podmanDefault: false }]);
	const podman = harness({ env: { PI_BACKENDS: "podman" }, plan: podmanPlan(), listening: true, extra: podmanExtra() });
	await podman.run();
	assert.deepEqual(podman.initOpts.map((o) => o.venues), [{ localUsed: false, podmanUsed: true, podmanDefault: true }]);
});

test("up on docker: PI_EGRESS_PROXY is the name up looks for, and it never starts the shipped proxy in its place", async () => {
	const h = harness({
		env: { PI_EGRESS_PROXY: "my-squid" },
		plan: { ...green, "docker inspect": 1 },
		listening: true,
		files: { "/deploy/egress-allowlist.conf": "x\n", "/deploy/deploy/egress-proxy.conf": "conf\n" },
	});
	assert.equal(await h.run(), 0);
	assert.ok(h.calls.some((c) => c.args.join(" ") === "inspect --format={{.State.Status}} my-squid"));
	assert.ok(!h.calls.some((c) => c.args[0] === "run" || c.args[0] === "network"), "nothing started");
	assert.match(h.text(), /PI_EGRESS_PROXY names my-squid, and docker has no container of that name/);
});

// ---------------------------------------------------------------------------------------------------
// Review round 1 (issue #430): the defects and the gaps each mutation survived
// ---------------------------------------------------------------------------------------------------

const KEEPER_READ = `podman inspect ${NETNS_KEEPER_FORMAT} pi-dispatch-netns-keeper`;
const podmanPlan = (over = {}) => ({ "podman image exists": 0, "podman ps": { code: 0, output: "" }, systemctl: 0, "loginctl show-user": { code: 0, output: "Linger=yes\n" }, ...over });

test("D2: PI_BACKENDS=podman in the deployment's .env drives the podman pass, as it drives service install", async () => {
	const h = harness({
		env: { PI_PROVIDER: "anthropic" },
		plan: podmanPlan(),
		listening: true,
		files: { "/deploy/.env": "PI_BACKENDS=podman\nPI_EGRESS=0\n" },
		extra: podmanExtra(),
	});
	assert.equal(await h.run(), 0);
	assert.ok(!h.calls.some((c) => c.cmd === "docker"), "the .env's venue, not the docker default");
	assert.equal(h.doctorCalls[0].PI_BACKENDS, "podman", "doctor judges the venue this pass drove");
	assert.match(h.text(), /export the same PI_BACKENDS there first/, "the closing lines say how a hand-run worker gets the venue");
});

test("E5: a shell and a .env that disagree on a venue key stop up before anything runs, naming both and which to change", async () => {
	const h = harness({ env: { PI_BACKENDS: "local" }, plan: green, listening: true, files: { "/deploy/.env": "PI_BACKENDS=podman\n" } });
	assert.equal(await h.run(), 1);
	assert.match(h.text(), /PI_BACKENDS is "local" in this shell and "podman" in \/deploy\/\.env\. up would drive the shell's venue while the service runs the file's/);
	assert.match(h.text(), /change \/deploy\/\.env \(what the service reads\), or unset the key in this shell/);
	assert.equal(h.calls.length, 0);
	assert.equal(h.initCalls.length, 0);
	// Agreement, or a key only one side sets, is no conflict: the shell's value is then simply the file's.
	const same = harness({ env: { PI_BACKENDS: "local" }, plan: green, listening: true, files: { "/deploy/.env": "PI_BACKENDS=local\n" } });
	assert.equal(await same.run(), 0);
});

test("D2/D6: a .env line the loaders read differently stops up before anything runs", async () => {
	const h = harness({ env: {}, plan: green, files: { "/deploy/.env": "PI_BACKENDS =podman\n" } });
	assert.equal(await h.run(), 1);
	assert.match(h.text(), /cannot tell which venue this deployment runs/);
	assert.equal(h.calls.length, 0);
	assert.equal(h.initCalls.length, 0);
});

test("D4: an EXITED proxy prints false with exit 0, and is offered the unit rather than called present", async () => {
	const h = harness({
		env: { PI_BACKENDS: "podman" },
		plan: podmanPlan({ "podman inspect": { code: 0, output: "exited\n" } }),
		listening: true,
		argv: ["--yes"],
		files: { "/deploy/egress-allowlist.conf": "x\n", "/deploy/deploy/egress-proxy.conf": "conf\n" },
		extra: podmanExtra(),
	});
	assert.equal(await h.run(), 0);
	assert.ok(h.store.has(`${QDIR}/pi-dispatch-egress-proxy.container`), "the stopped proxy's replacement was installed");
});

test("M7: a RUNNING proxy (true) is left alone and nothing is planned for it", async () => {
	const h = harness({
		env: { PI_BACKENDS: "podman" },
		// Issue #458: the keeper answers its own read, holding (the keeper key FIRST: the fake takes the first matching prefix).
		plan: podmanPlan({ [KEEPER_READ]: { code: 0, output: "running|bridge|pi-dispatch-netns-keeper,\n" }, "podman inspect": { code: 0, output: "running\n" } }),
		listening: true,
		argv: ["--yes"],
		files: { "/deploy/egress-allowlist.conf": "x\n", "/deploy/deploy/egress-proxy.conf": "conf\n" },
		extra: podmanExtra(),
	});
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /Egress proxy already present under this account's Podman/);
	assert.ok(![...h.store.keys()].some((p) => p.startsWith(QDIR)));
	assert.ok(!h.calls.some((c) => (c.cmd === "systemctl" && c.args[1] !== "show-environment")));
});

test("D3: up installs nothing over a container of the unit's name that the unit does not own", async () => {
	const h = harness({
		env: { PI_BACKENDS: "podman" },
		plan: podmanPlan({ "podman inspect": { code: 0, output: "exited\n" }, "podman container inspect": { code: 0, output: "<no value>\n" } }),
		listening: true,
		argv: ["--yes"],
		files: { "/deploy/egress-allowlist.conf": "x\n", "/deploy/deploy/egress-proxy.conf": "conf\n" },
		extra: podmanExtra(),
	});
	assert.equal(await h.run(), 0);
	// Issue #458: the keeper is read by the same rule, and this fake answers "<no value>" for both.
	assert.match(h.text(), /pi-dispatch-egress-proxy and pi-dispatch-netns-keeper already exist under this account's Podman and are not managed by the Quadlet units/);
	assert.match(h.text(), /pi-dispatch service install --force/);
	assert.ok(![...h.store.keys()].some((p) => p.startsWith(QDIR)));
	assert.ok(!h.calls.some((c) => (c.cmd === "systemctl" && c.args[1] !== "show-environment")));
});

test("M6: up never overwrites a Quadlet file that differs from what it renders", async () => {
	const edited = `${QDIR}/pi-dispatch-valkey.container`;
	const h = harness({
		env: { PI_BACKENDS: "podman", PI_EGRESS: "0" },
		plan: podmanPlan(),
		listening: false,
		argv: ["--yes"],
		files: { [edited]: "[Container]\nImage=mine\n" },
		extra: podmanExtra(),
	});
	assert.equal(await h.run(), 0);
	assert.equal(h.store.get(edited), "[Container]\nImage=mine\n");
	assert.match(h.text(), /podman stack\s+NOT installed: a Quadlet file differs/);
	assert.ok(!h.calls.some((c) => (c.cmd === "systemctl" && c.args[1] !== "show-environment")));
});

test("M13: on podman an armed policy with no allowlist starts no proxy and says which file", async () => {
	const h = harness({ env: { PI_BACKENDS: "podman" }, plan: podmanPlan({ "podman inspect": 1 }), listening: true, argv: ["--yes"], extra: podmanExtra() });
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /egress-allowlist\.conf is not here, not starting a proxy with no allowlist/);
	// Issue #458: the keeper mounts nothing, and the proxy started after `init` needs it just the same, so only its two
	// files are written; nothing of the proxy's is.
	assert.deepEqual([...h.store.keys()].filter((p) => p.startsWith(QDIR)).sort(), [`${QDIR}/pi-dispatch-netns-keeper.container`, `${QDIR}/pi-dispatch-netns-keeper.network`]);
	assert.ok(h.calls.some((c) => (c.cmd === "systemctl" && c.args[1] !== "show-environment") && c.args.join(" ") === "--user start pi-dispatch-netns-keeper.service"));
	assert.match(h.text(), /netns keeper \(podman\)\s+installed as Quadlet units and started/);
});

// Issue #458: up reads the keeper like the proxy, off stdout: running is left alone, anything else is offered the unit.
test("up on podman (#458): a keeper that holds is left alone, a stopped one or one off its bridge is offered its unit with the proxy already up", async () => {
	// The keeper's own key FIRST: the fake takes the first matching prefix.
	const inspect = (keeper) => ({ [KEEPER_READ]: { code: 0, output: `${keeper}\n` }, "podman inspect": { code: 0, output: "running\n" } });
	const running = harness({ env: { PI_BACKENDS: "podman" }, plan: podmanPlan(inspect("running|bridge|pi-dispatch-netns-keeper,")), listening: true, argv: ["--yes"], files: { "/deploy/egress-allowlist.conf": "x\n" }, extra: podmanExtra() });
	assert.equal(await running.run(), 0);
	assert.match(running.text(), /✓ Rootless network keeper already running under this account's Podman on its own bridge network \(pi-dispatch-netns-keeper\)/);
	assert.ok(![...running.store.keys()].some((p) => p.startsWith(QDIR)));
	// Issue #463's gate: RUNNING on `--network none` holds nothing, and was called "already running" here.
	const offBridge = harness({ env: { PI_BACKENDS: "podman" }, plan: podmanPlan(inspect("running|none|none,")), listening: true, argv: ["--yes"], files: { "/deploy/egress-allowlist.conf": "x\n" }, extra: podmanExtra() });
	assert.equal(await offBridge.run(), 0);
	assert.doesNotMatch(offBridge.text(), /already running/);
	assert.match(offBridge.text(), /⚠ pi-dispatch-netns-keeper is running on the none network mode, not on its pi-dispatch-netns-keeper bridge network, so it holds nothing open: offering its unit, restarted/);
	assert.ok(offBridge.store.has(`${QDIR}/pi-dispatch-netns-keeper.container`));
	const stopped = harness({ env: { PI_BACKENDS: "podman" }, plan: podmanPlan(inspect("exited|bridge|pi-dispatch-netns-keeper,")), listening: true, argv: ["--yes"], files: { "/deploy/egress-allowlist.conf": "x\n" }, extra: podmanExtra() });
	assert.equal(await stopped.run(), 0);
	assert.match(stopped.text(), /the rootless network keeper \(pi-dispatch-netns-keeper, which keeps the proxy's route out on Podman 4\.x\) is not running under this account's Podman/);
	assert.deepEqual([...stopped.store.keys()].filter((p) => p.startsWith(QDIR)).sort(), [`${QDIR}/pi-dispatch-netns-keeper.container`, `${QDIR}/pi-dispatch-netns-keeper.network`]);
	assert.deepEqual(stopped.calls.filter((c) => c.cmd === "podman" && c.args[0] === "inspect").map((c) => c.args), [
		["inspect", "--format={{.State.Status}}", "pi-dispatch-egress-proxy"],
		["inspect", NETNS_KEEPER_FORMAT, "pi-dispatch-netns-keeper"],
	]);
	// Egress off: neither is asked about, and nothing of the keeper's is written.
	const off = harness({ env: { PI_BACKENDS: "podman", PI_EGRESS: "0" }, plan: podmanPlan(inspect("exited|bridge|pi-dispatch-netns-keeper,")), listening: true, argv: ["--yes"], extra: podmanExtra() });
	assert.equal(await off.run(), 0);
	assert.ok(!off.calls.some((c) => c.cmd === "podman" && c.args[0] === "inspect"));
	assert.ok(![...off.store.keys()].some((p) => p.includes("netns-keeper")));
});

// PR #463 round 2: a Quadlet keeper that is there, ours and unchanged, but not holding (paused, say). `start` on its
// active unit is a no-op, and up used to report "installed as Quadlet units and started" over a keeper still paused.
// Its unit is RESTARTED instead, the files are left alone, and since the proxy stayed up, up says to restart it.
test("up on podman (#458): a Quadlet keeper that does not hold, with its files unchanged, is restarted, and the proxy's restart is asked for", async () => {
	const unit = (name) => readFileSync(new URL(`../deploy/${name}`, import.meta.url), "utf8");
	const files = { "/deploy/egress-allowlist.conf": "x\n", [`${QDIR}/pi-dispatch-netns-keeper.container`]: unit("pi-dispatch-netns-keeper.container"), [`${QDIR}/pi-dispatch-netns-keeper.network`]: unit("pi-dispatch-netns-keeper.network") };
	const plan = podmanPlan({
		[KEEPER_READ]: { code: 0, output: "paused|bridge|pi-dispatch-netns-keeper,|1000000\n" },
		"podman inspect": { code: 0, output: "running\n" },
		"podman container inspect": { code: 0, output: "pi-dispatch-netns-keeper.service\n" },
	});
	const h = harness({ env: { PI_BACKENDS: "podman" }, plan, listening: true, argv: ["--yes"], files, extra: podmanExtra() });
	assert.equal(await h.run(), 0);
	const ran = h.calls.filter((c) => (c.cmd === "systemctl" && c.args[1] !== "show-environment")).map((c) => c.args.join(" "));
	assert.deepEqual(ran, ["--user daemon-reload", "--user restart pi-dispatch-netns-keeper.service"], "restarted, never a no-op start");
	assert.equal(h.store.get(`${QDIR}/pi-dispatch-netns-keeper.container`), unit("pi-dispatch-netns-keeper.container"), "the files are left as they were");
	assert.match(h.text(), /✓ restarted pi-dispatch-netns-keeper\.service/);
	assert.doesNotMatch(h.text(), /✓ started /);
	assert.match(h.text(), /netns keeper \(podman\)\s+installed as Quadlet units and restarted \(pi-dispatch-netns-keeper\.service\)/);
	assert.match(h.text(), /⚠ pi-dispatch-netns-keeper was restarted while the egress proxy \(pi-dispatch-egress-proxy\) is not part of this install: if it is running, restart the egress proxy once no job is running: systemctl --user restart pi-dispatch-egress-proxy\.service/);
});

test("E7: up stops on a podman info that did not answer, stricter than the worker on purpose, and says so", async () => {
	for (const read of [{ answered: false, reason: "timeout", transient: true }, { answered: false, reason: "unparseable", transient: false }]) {
		const h = harness({ env: { PI_BACKENDS: "podman", PI_EGRESS: "0" }, plan: podmanPlan(), listening: true, extra: podmanExtra({ readPodmanInfo: async () => read }) });
		assert.equal(await h.run(), 1, read.reason);
		assert.match(h.text(), /✗ podman venue not answering/);
		assert.match(h.text(), /up stops here although the worker would only retry this per job: it will not install units for a Podman it could not see/);
		assert.equal(h.calls.length, 0, "no podman command without a timeout runs after it");
	}
});

test("M32: the gate judges the worker's own ids: as root, up refuses exactly as the worker's boot does", async () => {
	const h = harness({ env: { PI_BACKENDS: "podman" }, listening: true, extra: podmanExtra({ euid: 0, egid: 0 }) });
	assert.equal(await h.run(), 1);
	assert.match(h.text(), /the worker runs as root/);
	assert.equal(h.calls.length, 0);
});

test("M17/M28: on local,podman a refused podman gate leaves the docker pass whole and installs no podman stack", async () => {
	const h = harness({
		env: { PI_BACKENDS: "local,podman" },
		plan: { ...green, [PROXY_INSPECT]: proxyState("running") },
		listening: true,
		argv: ["--yes"],
		files: { "/deploy/egress-allowlist.conf": "x\n", "/deploy/deploy/egress-proxy.conf": "conf\n" },
		extra: podmanExtra({ readPodmanInfo: async () => ({ answered: true, info: { rootless: false, serviceIsRemote: false } }) }),
	});
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /the docker steps above are unaffected; the podman steps below are skipped/);
	assert.ok(h.calls.some((c) => c.cmd === "docker" && c.args[0] === "version"));
	assert.ok(!h.calls.some((c) => c.cmd === "podman"), "no podman step after a refused gate");
	assert.ok(![...h.store.keys()].some((p) => p.startsWith(QDIR)));
	assert.equal(h.initCalls.length, 1);
});

test("M30: a deployment path the proxy's Volume= cannot carry is reported by up, and nothing is installed", async () => {
	const h = harness({
		env: { PI_BACKENDS: "podman" },
		plan: podmanPlan({ "podman inspect": 1 }),
		listening: true,
		argv: ["--yes"],
		cwd: "/srv/pi deploy",
		files: { "/srv/pi deploy/egress-allowlist.conf": "x\n" },
		extra: podmanExtra(),
	});
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /podman stack\s+NOT installed: the egress proxy's Quadlet unit would mount/);
	assert.ok(![...h.store.keys()].some((p) => p.startsWith(QDIR)));
});

// ---------------------------------------------------------------------------------------------------
// Review round 2 (issue #430)
// ---------------------------------------------------------------------------------------------------

const PODMAN_WARN = "time=\"2026-09-27T10:00:00Z\" level=warning msg=\"The cgroupv2 manager is set to systemd but there is no systemd user session available\"\n";

test("E2: a running proxy is read off stdout, so podman's stderr warnings cannot make `true` unequal", async () => {
	const h = harness({
		env: { PI_BACKENDS: "podman" },
		plan: podmanPlan({ "podman inspect": { code: 0, output: "running\n", stderr: PODMAN_WARN } }),
		listening: true,
		argv: ["--yes"],
		files: { "/deploy/egress-allowlist.conf": "x\n", "/deploy/deploy/egress-proxy.conf": "conf\n" },
		extra: podmanExtra(),
	});
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /Egress proxy already present under this account's Podman/);
	// And our own label with a warning beside it is ours.
	const own = harness({
		env: { PI_BACKENDS: "podman", PI_EGRESS: "0" },
		plan: podmanPlan({ "podman container inspect": { code: 0, output: "pi-dispatch-valkey.service\n", stderr: PODMAN_WARN } }),
		listening: false,
		argv: ["--yes"],
		extra: podmanExtra(),
	});
	assert.equal(await own.run(), 0);
	assert.ok(own.calls.some((c) => (c.cmd === "systemctl" && c.args[1] !== "show-environment") && c.args[1] === "start"), "installed, not refused as foreign");
});

test("E3: up installs nothing when podman cannot say whether a container exists", async () => {
	const h = harness({
		env: { PI_BACKENDS: "podman", PI_EGRESS: "0" },
		plan: podmanPlan({ "podman container inspect": { code: 125, stderr: "Error: database is locked\n" } }),
		listening: false,
		argv: ["--yes"],
		extra: podmanExtra(),
	});
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /podman stack\s+NOT installed: podman did not say whether the containers exist/);
	assert.ok(![...h.store.keys()].some((p) => p.startsWith(QDIR)));
	assert.ok(!h.calls.some((c) => (c.cmd === "systemctl" && c.args[1] !== "show-environment")));
});

test("E8: up with no user manager reachable writes nothing and names the remedy", async () => {
	const h = harness({ env: { PI_BACKENDS: "podman", PI_EGRESS: "0" }, plan: podmanPlan(), listening: false, argv: ["--yes"], extra: podmanExtra({ noBus: true, euid: 1234 }) });
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /as under `sudo -iu op`/);
	assert.match(h.text(), /XDG_RUNTIME_DIR=\/run\/user\/1234/);
	assert.ok(![...h.store.keys()].some((p) => p.startsWith(QDIR)), "no file left behind that nothing loaded");
	assert.ok(!h.calls.some((c) => (c.cmd === "systemctl" && c.args[1] !== "show-environment")));
});

test("E6/R31: the .env is read with the platform's loader, and off Linux a line it reads differently never stops up", async () => {
	const file = { "/deploy/.env": "export PI_BACKENDS=podman\n" };
	const linux = harness({ env: {}, plan: green, files: file });
	assert.equal(await linux.run(), 1, "systemd ignores `export`: which venue the service runs is unknown");
	// The macOS wrapper sources the file, so `export` IS the assignment there: the podman venue, refused on this host.
	const mac = harness({ env: {}, platform: "darwin", plan: green, files: file, extra: podmanExtra() });
	await mac.run();
	assert.match(mac.text(), /the podman venue runs only on Linux/);
	// A line that loader cannot read off Linux: noted, and up goes on with the shell's venue.
	const odd = harness({ env: {}, platform: "darwin", plan: green, listening: true, files: { "/deploy/.env": "PI_BACKENDS =podman\n" } });
	assert.equal(await odd.run(), 0);
	assert.match(odd.text(), /off Linux the podman venue refuses this host anyway, so this pass reads the venue from this shell/);
});

test("nit: an unreadable .env is said, not silently replaced by the shell's venue", async () => {
	const h = harness({ env: {}, plan: green, listening: true, files: { "/deploy/.env": "x" } });
	h.deps.fs.readFileSync = (p) => {
		if (p === "/deploy/.env") throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
		throw new Error(`ENOENT: ${p}`);
	};
	await h.run();
	assert.match(h.text(), /\/deploy\/\.env could not be read \(EACCES: permission denied\), so PI_BACKENDS, PI_EGRESS and PI_EGRESS_PROXY come from this shell alone/);
});

test("R25: the docker path never asks the passwd database, so an account with no entry and no USER still runs up", async () => {
	const h = harness({ env: {}, plan: green, listening: true, extra: { userInfoFn: () => { throw new Error("ENOENT: no such user"); } } });
	assert.equal(await h.run(), 0);
});

test("D4 (round 3): shell and .env are compared as the worker reads them, and shown in quotes", async () => {
	for (const shell of [" podman", "podman,podman", "podman "]) {
		const h = harness({ env: { PI_BACKENDS: shell, PI_EGRESS: "0" }, plan: podmanPlan(), listening: true, files: { "/deploy/.env": "PI_BACKENDS=podman\nPI_EGRESS=0\n" }, extra: podmanExtra() });
		assert.equal(await h.run(), 0, JSON.stringify(shell));
		assert.doesNotMatch(h.text(), /in this shell and/);
	}
	// PI_EGRESS "" and "1" are both ON; PI_EGRESS_PROXY "" is the default name, like the file's explicit default.
	const egress = harness({ env: { PI_EGRESS: "", PI_EGRESS_PROXY: "" }, plan: green, listening: true, files: { "/deploy/.env": "PI_EGRESS=1\nPI_EGRESS_PROXY=pi-dispatch-egress-proxy\n" } });
	assert.equal(await egress.run(), 0);
	assert.doesNotMatch(egress.text(), /in this shell and/);
	// A proxy name is NOT trimmed by anything that reads it, so a stray space is a different proxy and a disagreement.
	for (const shell of [" ", "pi-dispatch-egress-proxy "]) {
		const spaced = harness({ env: { PI_EGRESS_PROXY: shell }, plan: green, files: { "/deploy/.env": "PI_EGRESS_PROXY=pi-dispatch-egress-proxy\n" } });
		assert.equal(await spaced.run(), 1, JSON.stringify(shell));
		assert.match(spaced.text(), /PI_EGRESS_PROXY is "[^"]*" in this shell and "pi-dispatch-egress-proxy" in \/deploy\/\.env/);
	}
	// A real disagreement, with an empty shell value made visible.
	const empty = harness({ env: { PI_BACKENDS: "" }, plan: green, files: { "/deploy/.env": "PI_BACKENDS=podman\n" } });
	assert.equal(await empty.run(), 1);
	assert.match(empty.text(), /PI_BACKENDS is "" in this shell and "podman" in \/deploy\/\.env/);
});

// PR #463 round 3: up asks the manager's environment with service install's rule, before its consent, and installs
// nothing when it names another account's XDG_RUNTIME_DIR or XDG_CONFIG_HOME.
test("up on podman (#458): a manager environment naming another account's directories installs nothing", async () => {
	const h = harness({
		env: { PI_BACKENDS: "podman" },
		// The environment key FIRST: the fake takes the first matching prefix, and podmanPlan answers every `systemctl`.
		plan: { "systemctl --user show-environment": { code: 0, output: "XDG_CONFIG_HOME=/home/runner/.config\n" }, ...podmanPlan({ "podman inspect": 1 }) },
		listening: true,
		argv: ["--yes"],
		files: { "/deploy/egress-allowlist.conf": "x\n" },
		extra: podmanExtra(),
	});
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /✗ op's user manager runs with XDG_CONFIG_HOME=\/home\/runner\/\.config, not \/home\/op\/\.config/);
	assert.match(h.text(), /podman stack\s+NOT installed: the user manager's environment names another account's directories/);
	assert.ok(![...h.store.keys()].some((p) => p.startsWith(QDIR)));
	assert.ok(!h.calls.some((c) => c.cmd === "systemctl" && c.args[1] !== "show-environment"));
});

// PR #463 round 3: the operator's own proxy (PI_EGRESS_PROXY) is never ours to restart, and a keeper started beside it
// leaves it up since before the keeper: said, with its real name. A keeper that stays holding says nothing.
test("up on podman (#458): starting the keeper beside the operator's own proxy names that proxy's restart", async () => {
	const h = harness({ env: { PI_BACKENDS: "podman", PI_EGRESS_PROXY: "my-squid" }, plan: podmanPlan({ [KEEPER_READ]: { code: 125, output: "" } }), listening: true, argv: ["--yes"], files: { "/deploy/egress-allowlist.conf": "x\n" }, extra: podmanExtra() });
	assert.equal(await h.run(), 0);
	assert.ok(h.store.has(`${QDIR}/pi-dispatch-netns-keeper.container`));
	assert.match(h.text(), /⚠ pi-dispatch-netns-keeper was started while the egress proxy \(my-squid\) is not part of this install: if it is running, restart the egress proxy once no job is running: podman restart my-squid \(or its own unit\)/);
	const held = harness({ env: { PI_BACKENDS: "podman", PI_EGRESS_PROXY: "my-squid" }, plan: podmanPlan({ [KEEPER_READ]: { code: 0, output: "running|bridge|pi-dispatch-netns-keeper,|1000000\n" } }), listening: true, argv: ["--yes"], files: { "/deploy/egress-allowlist.conf": "x\n" }, extra: podmanExtra() });
	assert.equal(await held.run(), 0);
	assert.doesNotMatch(held.text(), /is not part of this install/);
});

// PR #463 final review: the symlinked-home tolerance through up, so dropping its realpath seam is caught.
test("up on podman (#458): a manager XDG_CONFIG_HOME that resolves to this home's .config is not refused", async () => {
	const env = { "systemctl --user show-environment": { code: 0, output: "XDG_CONFIG_HOME=/srv/link/.config\n" } };
	const links = { "/srv/link/.config": "/home/op/.config", "/home/op/.config": "/home/op/.config" };
	const run = (realpath) => harness({ env: { PI_BACKENDS: "podman" }, plan: { ...env, ...podmanPlan({ "podman inspect": 1 }) }, listening: true, argv: ["--yes"], files: { "/deploy/egress-allowlist.conf": "x\n" }, extra: podmanExtra(realpath ? { realpath } : {}) });
	const linked = run((p) => links[p] ?? p);
	assert.equal(await linked.run(), 0);
	assert.doesNotMatch(linked.text(), /user manager runs with/);
	assert.ok([...linked.store.keys()].some((p) => p.startsWith(QDIR)), "installed");
	const plain = run((p) => p);
	assert.equal(await plain.run(), 0);
	assert.match(plain.text(), /✗ op's user manager runs with XDG_CONFIG_HOME=\/srv\/link\/\.config, not \/home\/op\/\.config/);
});
