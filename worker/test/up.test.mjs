import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { defaultPrompt, runUp } from "../src/up.mjs";

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
			const { code, output } = typeof outcome === "object" && outcome !== null ? outcome : { code: outcome, output: "" };
			if (output) child.stdout.handlers.data?.(output);
			handlers.close?.(code);
		});
		return child;
	};
}

// 64 hex chars, distinctive on purpose: the no-secret-in-output assertions grep for exactly this.
const SECRET = "cafef00d".repeat(8);

// Everything injected, everything recorded. `files` seeds the in-memory fs (path → text); the fake
// init deliberately creates nothing, so a test that wants a .env after init seeds it up front.
function harness({ plan = {}, listening = true, answers = [], files = {}, doctorCode = 0, argv = [], env = { PI_PROVIDER: "anthropic" }, cwd = "/deploy", platform = "linux", logsDirPathFn, settingsFilePathFn } = {}) {
	const calls = [];
	const promptCalls = [];
	const initCalls = [];
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
		runInitFn: (cwd) => {
			initCalls.push(cwd);
			return 0;
		},
		runDoctorFn: (env, opts) => {
			doctorCalls.push(env);
			doctorOpts.push(opts);
			return doctorCode;
		},
	};
	return { run: () => runUp(argv, deps), calls, promptCalls, initCalls, doctorCalls, doctorOpts, store, text: () => buf.join("") };
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
		["inspect", "--format={{.State.Running}}", "pi-dispatch-egress-proxy"],
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
	assert.equal(h.doctorCalls[0].PI_PAUSE_WINDOWS_FILE, "/deploy/pause-windows.json", "a blank export is not a value, so the layer fills it");
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
const EGRESS_NET = ["network", "create", "pi-dispatch-egress-out"];
const EGRESS_RUN = [
	"run", "-d", "--name", "pi-dispatch-egress-proxy", "--restart", "unless-stopped",
	"--network", "pi-dispatch-egress-out",
	"-v", "./deploy/egress-proxy.conf:/etc/squid/squid.conf:ro",
	"-v", "./egress-allowlist.conf:/etc/pi-dispatch/allowlist.conf:ro",
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
		plan: { ...green, "docker inspect --format={{.State.Running}} pi-dispatch-egress-proxy": 0 },
		listening: true,
	});
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /✓ Egress proxy already present/);
	assert.equal(h.promptCalls.length, 0);
});

test("up: --yes starts the proxy with exactly the argv it showed", async () => {
	const h = harness({
		env: EGRESS_ENV,
		plan: { ...green, "docker inspect --format={{.State.Running}} pi-dispatch-egress-proxy": 1, "docker network create": 0, "docker run -d --name pi-dispatch-egress-proxy": 0 },
		listening: true,
		files: { "/deploy/egress-allowlist.conf": "api.anthropic.com\n" },
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
		plan: { ...green, "docker inspect --format={{.State.Running}} pi-dispatch-egress-proxy": 1 },
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
		plan: { ...green, "docker inspect --format={{.State.Running}} pi-dispatch-egress-proxy": 1 },
		listening: true,
		files: { "/deploy/egress-allowlist.conf": "api.anthropic.com\n" },
		answers: ["n"],
	});
	await h.run();
	assert.ok(!h.calls.some((c) => c.args[0] === "run" && c.args.includes("pi-dispatch-egress-proxy")));
	assert.match(h.text(), /every job is refused pre-spend until the proxy is up/);
});
