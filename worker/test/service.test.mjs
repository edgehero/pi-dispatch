import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runService, TEMPLATE_PINS } from "../src/service.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// The deploy/ copy the render actually reads: worker/deploy, shipped in the npm tarball and kept
// byte-identical to the repo-root deploy/ by the sync test in publish.test.mjs.
const DEPLOY_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "deploy");

// The checkout-layout anchors (issue #96): moduleDir is worker/src, so cliPath and the wrapper paths
// land on REAL files here — the npm-layout tests below build the other shape under a tmpdir.
const WORKER_SRC = join(REPO_ROOT, "worker", "src");
const CLI_PATH = join(WORKER_SRC, "cli.mjs");
const RECEIVER_START = join(REPO_ROOT, "receiver", "src", "start.mjs");
const WRAPPER_SH = join(DEPLOY_DIR, "worker-env-wrapper.sh");
const WRAPPER_CMD = join(DEPLOY_DIR, "worker-env-wrapper.cmd");
// The injected deployment folder (cwd): deliberately NOT the repo root, so any assertion that still
// expected repo-root-derived paths would fail loudly instead of passing by coincidence.
const DEPLOY_AT = "/srv/pi-deploy";
// The operator's env-setup script (issue #209). Absolute and outside the deployment folder on purpose:
// that is where a secrets manager's credentials actually live, and the render must not resolve it.
const ENV_SETUP = "/etc/pi-dispatch/setup-env.sh";
const ENV_SETUP_FILES = { [ENV_SETUP]: "#!/bin/sh\nexport FROM_MANAGER=1\n" };

// ---------------------------------------------------------------------------------------------------
// The pin test: render is a targeted substitution of the templates' KNOWN literals, so a template
// edit that renames one must fail HERE (build time), not at render time on an operator's host. Reads
// the REAL worker/deploy files — the ones readTemplate resolves — on purpose; a fake would pin nothing.
// ---------------------------------------------------------------------------------------------------

test("pin: every literal the render substitutes or preserves is present in its real deploy/ template", () => {
	for (const [name, literals] of Object.entries(TEMPLATE_PINS)) {
		const text = readFileSync(join(DEPLOY_DIR, name), "utf8");
		for (const literal of literals) {
			assert.ok(
				text.includes(literal),
				`deploy/${name} no longer contains ${JSON.stringify(literal)} — update TEMPLATE_PINS and the render together`,
			);
		}
	}
});

// ---------------------------------------------------------------------------------------------------
// Harness: everything injected, everything recorded. The fake fs serves writes from a Map but lets
// reads FALL THROUGH to the real filesystem, so renders exercise the actual deploy/ templates. The
// three path seams (cwd = the deployment folder, moduleDir = where service.mjs lives, resolveReceiver)
// replace the old injected repoRoot: they are what makes checkout AND npm layouts testable.
// ---------------------------------------------------------------------------------------------------

// The up.test.mjs fake spawn: plan keys are command-line prefixes mapped to an exit code, a
// {code, output} pair, or "enoent" for a launch failure. First matching key wins, so put longer
// prefixes ("nssm status") before shorter ones ("nssm").
function fakeSpawn(plan, calls, events) {
	return (cmd, args, opts) => {
		const line = [cmd, ...args].join(" ");
		const key = Object.keys(plan).find((k) => line.startsWith(k));
		const outcome = plan[key];
		calls.push({ cmd, args, opts });
		events?.push(`spawn ${line}`);
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
			const { code, output } = typeof outcome === "object" && outcome !== null ? outcome : { code: outcome ?? 0, output: "" };
			if (output) child.stdout.handlers.data?.(output);
			handlers.close?.(code);
		});
		return child;
	};
}

function harness({
	platform = "linux",
	argv = [],
	files = {},
	euid = 501,
	plan = {},
	queue = null,
	events = null,
	cwd = DEPLOY_AT,
	moduleDir = WORKER_SRC,
	resolveReceiver = () => RECEIVER_START,
} = {}) {
	const calls = [];
	const buf = [];
	const errBuf = [];
	const mkdirs = [];
	const store = new Map(Object.entries(files));
	let clock = 0;
	const deps = {
		env: {},
		platform,
		euid,
		execPath: "/fake/node/bin/node",
		cwd,
		moduleDir,
		resolveReceiver,
		home: "/home/tester",
		user: "tester",
		tmp: "/faketmp",
		spawn: fakeSpawn(plan, calls, events),
		out: (s) => buf.push(s),
		err: (s) => errBuf.push(s),
		// Virtual time: sleep advances the clock instantly so drain-timeout tests need no real waiting.
		sleep: async (ms) => {
			clock += ms;
			events?.push("sleep");
		},
		now: () => clock,
		queue,
		fs: {
			existsSync: (p) => store.has(p),
			readFileSync: (p, encoding) => (store.has(p) ? store.get(p) : readFileSync(p, encoding)),
			writeFileSync: (p, data) => store.set(p, data),
			mkdirSync: (p) => mkdirs.push(p),
			unlinkSync: (p) => store.delete(p),
		},
	};
	return { run: () => runService(argv, deps), calls, store, mkdirs, text: () => buf.join(""), errText: () => errBuf.join("") };
}

const USER_UNIT = "/home/tester/.config/systemd/user/pi-dispatch-worker.service";
const AGENT_PLIST = "/home/tester/Library/LaunchAgents/com.pi-dispatch.worker.plist";

/** The <string> values of the rendered plist's ProgramArguments ARRAY — not the comment prose. */
function programArguments(plist) {
	const block = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
	assert.ok(block, "the plist has a ProgramArguments array");
	return [...block[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------------------------------
// render — checkout layout (moduleDir = worker/src, so every substituted path must EXIST here)
// ---------------------------------------------------------------------------------------------------

test("render linux --user: ExecStart is the absolute module-relative cli, the deployment folder owns WorkingDirectory and .env; the exit-2 and crash-loop semantics survive; User= is stripped", async () => {
	const h = harness({ platform: "linux", argv: ["render"] });
	assert.equal(await h.run(), 0);
	const text = h.text();
	assert.ok(text.includes(`ExecStart=/fake/node/bin/node ${CLI_PATH} worker`), "ExecStart = <node> <cliPath> worker");
	assert.ok(existsSync(CLI_PATH), "the checkout-layout cliPath must be a real file");
	assert.ok(text.includes(`WorkingDirectory=${DEPLOY_AT}`), "the deployment folder landed in WorkingDirectory");
	assert.ok(text.includes(`EnvironmentFile=${DEPLOY_AT}/.env`), ".env is looked up in the deployment folder, never inside the package");
	assert.match(text, /RestartPreventExitStatus=2/, "the EXIT_POLICY never-restart must survive byte-for-byte");
	assert.match(text, /StartLimitBurst=5/, "the crash-loop bound must survive byte-for-byte");
	assert.match(text, /StartLimitIntervalSec=60/);
	assert.match(text, /KillSignal=SIGTERM/);
	assert.match(text, /TimeoutStopSec=30/);
	assert.doesNotMatch(text, /^User=/m, "a systemd --user unit must not carry User= (systemd rejects it)");
	assert.match(text, /WantedBy=default\.target/, "multi-user.target never runs in the user instance");
	assert.equal(h.calls.length, 0, "render spawns nothing");
});

test("render linux --system: User= is rewritten to the invoking user, WantedBy stays multi-user.target", async () => {
	const h = harness({ platform: "linux", argv: ["render", "--system"] });
	assert.equal(await h.run(), 0);
	assert.match(h.text(), /^User=tester$/m);
	assert.match(h.text(), /WantedBy=multi-user\.target/);
});

test("render linux --receiver: ExecStart is the receiver package's resolved ./start export", async () => {
	const h = harness({ platform: "linux", argv: ["render", "--receiver"] });
	assert.equal(await h.run(), 0);
	assert.ok(h.text().includes(`ExecStart=/fake/node/bin/node ${RECEIVER_START}`), "ExecStart = <node> <receiverStart>");
	assert.ok(existsSync(RECEIVER_START), "the workspace-resolved receiver start must be a real file");
	assert.ok(h.text().includes(`WorkingDirectory=${DEPLOY_AT}`));
	assert.doesNotMatch(h.text(), /^User=/m);
	assert.match(h.text(), /pi-dispatch-receiver\.service/, "the receiver unit gets its own name");
});

test("render darwin: ProgramArguments = sh + package wrapper + exec argv in order, logs under the deployment folder, node dir injected into PATH, KeepAlive shape intact, wrapper note printed", async () => {
	const h = harness({ platform: "darwin", argv: ["render"] });
	assert.equal(await h.run(), 0);
	const text = h.text();
	assert.ok(text.includes("<string>com.pi-dispatch.worker</string>"));
	assert.ok(text.includes(`<string>${WRAPPER_SH}</string>`), "the wrapper is the PACKAGE's copy (worker/deploy), not a repo-root guess");
	assert.ok(existsSync(WRAPPER_SH), "the checkout-layout wrapper must be a real file");
	// The exec argv contract: the wrapper runs "$@", so the plist must carry the full command after it.
	// Scoped to the ProgramArguments ARRAY: the template's own comment block quotes example <string>s
	// for hand-editors, which a whole-document search would trip over.
	assert.deepEqual(
		programArguments(text),
		["/bin/sh", WRAPPER_SH, "/fake/node/bin/node", CLI_PATH, "worker"],
		"sh, wrapper, node, cli, worker — in exec order",
	);
	assert.ok(text.includes(`<string>${DEPLOY_AT}/logs/worker.out.log</string>`), "daemon logs live under the deployment folder");
	// launchd's default PATH cannot see an nvm/Homebrew node; the render must pin the installing node's dir.
	assert.ok(text.includes("<string>/fake/node/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>"), "node's directory is prepended to the service PATH");
	assert.ok(text.includes("<key>SuccessfulExit</key>"), "the KeepAlive crash-only-restart shape survives");
	assert.match(text, /converts a policy refusal \(exit 2/, "the wrapper note explains the exit-2 conversion");
});

test("render darwin --receiver: derived plist swaps label and logs and carries the receiver's exec argv — the old `receiver` selector argument is gone", async () => {
	const h = harness({ platform: "darwin", argv: ["render", "--receiver"] });
	assert.equal(await h.run(), 0);
	const text = h.text();
	assert.ok(text.includes("<string>com.pi-dispatch.receiver</string>"));
	assert.ok(!text.includes("<string>com.pi-dispatch.worker</string>"), "the worker label must not survive the derivation");
	assert.deepEqual(
		programArguments(text),
		["/bin/sh", WRAPPER_SH, "/fake/node/bin/node", RECEIVER_START],
		"the receiver argv is the whole difference — no `receiver` selector argument, no worker cli",
	);
	assert.ok(text.includes("receiver.out.log") && text.includes("receiver.err.log"));
});

test("render win32: the nssm sequence carries the package wrapper + exec argv and the AppExit pair byte-for-byte", async () => {
	const h = harness({ platform: "win32", argv: ["render"] });
	assert.equal(await h.run(), 0);
	const text = h.text();
	assert.ok(text.includes(`nssm install pi-dispatch-worker ${WRAPPER_CMD} /fake/node/bin/node ${CLI_PATH} worker`), "Application = the package wrapper; AppParameters = the exec argv");
	assert.ok(text.includes(`nssm set pi-dispatch-worker AppDirectory ${DEPLOY_AT}`), "AppDirectory = the deployment folder — the wrapper's ./.env contract");
	assert.ok(text.includes(`"${DEPLOY_AT}\\logs\\worker.out.log"`), "logs live under the deployment folder");
	assert.match(text, /AppExit Default Restart/);
	assert.match(text, /AppExit 2 Exit/, "the EXIT_POLICY never-retry must survive");
	assert.match(text, /AppStopMethodConsole 15000/, "the console-stop grace must survive");
	assert.match(text, /AppThrottle 5000/, "the crash-loop throttle must survive");
});

// ---------------------------------------------------------------------------------------------------
// --env-setup (issue #209): the seam that lets a secrets manager fill the environment without anyone
// hand-editing a rendered unit. The two halves that matter are (1) with no flag, every render above is
// byte-identical to what it always produced, and (2) with it, the RENDERER owns the `exec`, because the
// hand-edit an operator reaches for instead (`<manager> run -- …`) reports the child's exit 2 as 1.
// ---------------------------------------------------------------------------------------------------

test("render linux --env-setup: sh -c sources the script then EXECS the worker, so exit 2 still reaches systemd; EnvironmentFile and the exit-2 semantics are untouched", async () => {
	const h = harness({ platform: "linux", argv: ["render", "--env-setup", ENV_SETUP], files: ENV_SETUP_FILES });
	assert.equal(await h.run(), 0);
	const text = h.text();
	assert.ok(
		text.includes(`ExecStart=/bin/sh -c 'set -a; . "${ENV_SETUP}" || exit 1; set +a; exec "/fake/node/bin/node" "${CLI_PATH}" "worker"'`),
		"the whole sh script is ONE single-quoted systemd word; the inner double quotes are sh's, and they are what makes a path with spaces work",
	);
	assert.match(text, /exec "/, "`exec` is the point: without it systemd watches a shell and RestartPreventExitStatus=2 never sees a 2");
	assert.match(text, /\|\| exit 1/, "a failed setup is infra-retryable (1), never the determinate refusal (2)");
	assert.match(text, /set -a/, "a bare KEY=value must export, exactly as EnvironmentFile= does");
	assert.ok(text.includes(`EnvironmentFile=${DEPLOY_AT}/.env`), "EnvironmentFile is untouched: it is read first, and the setup script runs after it and wins");
	assert.match(text, /RestartPreventExitStatus=2/, "the EXIT_POLICY never-restart must survive the seam");
	assert.match(text, /# ExecStart also runs `--env-setup/, "the rendered unit explains its own ExecStart");
	assert.match(text, /do not hand-edit this line/);
});

test("render linux --receiver --env-setup: the receiver unit gets the same composed exec", async () => {
	const h = harness({ platform: "linux", argv: ["render", "--receiver", "--env-setup", ENV_SETUP], files: ENV_SETUP_FILES });
	assert.equal(await h.run(), 0);
	assert.ok(
		h.text().includes(`ExecStart=/bin/sh -c 'set -a; . "${ENV_SETUP}" || exit 1; set +a; exec "/fake/node/bin/node" "${RECEIVER_START}"'`),
		"same shape, the receiver's own entry point",
	);
});

test("render darwin --env-setup: the path rides the EnvironmentVariables dict and ProgramArguments does NOT change", async () => {
	const h = harness({ platform: "darwin", argv: ["render", "--env-setup", ENV_SETUP], files: ENV_SETUP_FILES });
	assert.equal(await h.run(), 0);
	const text = h.text();
	// A variable, not a composed command line: launchd has no shell in front of ProgramArguments, so
	// nothing here needs quoting and the argv contract stays exactly what the wrapper already expects.
	assert.deepEqual(
		programArguments(text),
		["/bin/sh", WRAPPER_SH, "/fake/node/bin/node", CLI_PATH, "worker"],
		"ProgramArguments is byte-identical to the default render",
	);
	assert.ok(text.includes("<key>PI_ENV_SETUP</key>"), "the seam is delivered as a variable the wrapper reads");
	assert.ok(text.includes(`<string>${ENV_SETUP}</string>`));
	assert.ok(text.includes("<string>/fake/node/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>"), "PATH still shares the dict");
	assert.match(text, /sources this file after \.\/\.env/, "the plist says which source wins");
	assert.match(text, /With it set, \.\/\.env becomes optional/, "the render note states the relaxed contract");
});

test("render win32 --env-setup: one nssm AppEnvironmentExtra, and AppParameters does NOT change", async () => {
	const setup = "C:\\pi-dispatch\\setup-env.cmd";
	const h = harness({ platform: "win32", argv: ["render", "--env-setup", setup], files: { [setup]: "@echo off\n" } });
	assert.equal(await h.run(), 0);
	const text = h.text();
	assert.ok(text.includes(`nssm install pi-dispatch-worker ${WRAPPER_CMD} /fake/node/bin/node ${CLI_PATH} worker`), "AppParameters is byte-identical to the default render");
	assert.ok(text.includes(`nssm set pi-dispatch-worker AppEnvironmentExtra "PI_ENV_SETUP=${setup}"`), "the seam is one nssm set, no shell in between");
	assert.match(text, /AppExit 2 Exit/, "the EXIT_POLICY never-retry must survive the seam");
});

test("--env-setup refuses a relative path, a path systemd or the plist would reinterpret, and one that is not there", async () => {
	const relative = harness({ platform: "linux", argv: ["render", "--env-setup", "setup-env.sh"], files: ENV_SETUP_FILES });
	assert.equal(await relative.run(), 1);
	assert.match(relative.errText(), /ABSOLUTE path/);
	assert.match(relative.errText(), /searches \$PATH/, "the reason is POSIX `.`, not a style preference");

	// systemd expands $VAR inside Exec lines whatever the quoting, so a $ in the path is unrenderable.
	const dollar = harness({ platform: "linux", argv: ["render", "--env-setup", "/etc/pi-$USER/setup.sh"], files: ENV_SETUP_FILES });
	assert.equal(await dollar.run(), 1);
	assert.match(dollar.errText(), /contains "\$"/);

	// The plist is XML; the same path is fine on Linux, which is why the refusal is per platform.
	const amp = harness({ platform: "darwin", argv: ["render", "--env-setup", "/etc/pi & dispatch/setup.sh"], files: ENV_SETUP_FILES });
	assert.equal(await amp.run(), 1);
	assert.match(amp.errText(), /contains "&"/);
	assert.match(amp.errText(), /plist/);

	const missing = harness({ platform: "linux", argv: ["render", "--env-setup", "/etc/pi-dispatch/nope.sh"], files: ENV_SETUP_FILES });
	assert.equal(await missing.run(), 1);
	assert.match(missing.errText(), /not found/);
	assert.match(missing.errText(), /installs cleanly and then fails at every boot/, "refusing beats rendering a unit that boots into nothing");
});

test("--env-setup on a subcommand that renders nothing refuses instead of being silently ignored", async () => {
	for (const cmd of ["status", "restart", "uninstall"]) {
		const h = harness({ platform: "linux", argv: [cmd, "--env-setup", ENV_SETUP], files: ENV_SETUP_FILES });
		assert.equal(await h.run(), 1, `${cmd} must refuse`);
		assert.match(h.errText(), /--env-setup applies to `service render` and `service install`/);
		assert.equal(h.calls.length, 0, `${cmd} must refuse BEFORE it spawns anything`);
	}
});

test("install linux --user --env-setup: the unit that lands on disk carries the composed exec", async () => {
	const h = harness({
		platform: "linux",
		argv: ["install", "--env-setup", ENV_SETUP],
		files: ENV_SETUP_FILES,
		plan: { systemctl: 0 },
	});
	assert.equal(await h.run(), 0);
	const unit = h.store.get(USER_UNIT);
	assert.ok(unit.includes(`. "${ENV_SETUP}" || exit 1`), "install writes what render printed");
	assert.ok(unit.includes(`exec "/fake/node/bin/node" "${CLI_PATH}" "worker"`));
});

// systemd is the one platform whose rendered artifact has a real parser, so use it. Gated on BOTH linux
// and the binary being present: this skips on a macOS dev box and runs on every PR inside the required
// contract-tests job. The gate on the diagnostics rather than the exit code mirrors deploy-lint.yml —
// systemd-analyze fails on the paths that do not exist on a runner, which is expected, not a defect.
const SYSTEMD = process.platform === "linux" && spawnSync("systemd-analyze", ["--version"]).status === 0;

test("render linux --env-setup: systemd itself parses the composed unit", { skip: !SYSTEMD }, async () => {
	const h = harness({ platform: "linux", argv: ["render", "--env-setup", ENV_SETUP], files: ENV_SETUP_FILES });
	assert.equal(await h.run(), 0);
	const dir = mkdtempSync(join(tmpdir(), "pi-dispatch-unit-"));
	const unitPath = join(dir, "pi-dispatch-worker.service");
	// The first line is the render's "# → <path>" header, which is output, not unit content.
	writeFileSync(unitPath, h.text().split("\n").slice(1).join("\n"));
	const { stdout, stderr } = spawnSync("systemd-analyze", ["verify", "--no-pager", unitPath], { encoding: "utf8" });
	const log = `${stdout}${stderr}`;
	assert.doesNotMatch(
		log,
		/Unknown (key name|lvalue|section)|Failed to parse|Invalid setting|not a valid|expected /i,
		`systemd-analyze found a syntax error in the composed unit:\n${log}`,
	);
});

// ---------------------------------------------------------------------------------------------------
// render — npm layout (issue #96): moduleDir is <deployment>/node_modules/@edgehero/pi-dispatch/src
// under a real tmpdir, with real files, so "the rendered path EXISTS" is a filesystem fact, not a
// string-shape opinion. This is exactly the layout where the old repoRoot ("../..") landed on the
// @edgehero SCOPE directory and every rendered unit pointed at nothing.
// ---------------------------------------------------------------------------------------------------

function npmLayout() {
	const dep = mkdtempSync(join(tmpdir(), "pi-dispatch-npmdep-"));
	const pkg = join(dep, "node_modules", "@edgehero", "pi-dispatch");
	mkdirSync(join(pkg, "src"), { recursive: true });
	writeFileSync(join(pkg, "src", "cli.mjs"), "// stands in for the packed cli.mjs\n");
	mkdirSync(join(pkg, "deploy"), { recursive: true });
	// The real shipped mirrors, copied byte-for-byte: the render must read ITS package's templates.
	for (const name of readdirSync(DEPLOY_DIR)) {
		writeFileSync(join(pkg, "deploy", name), readFileSync(join(DEPLOY_DIR, name)));
	}
	const receiverStart = join(dep, "node_modules", "@edgehero", "pi-dispatch-receiver", "src", "start.mjs");
	mkdirSync(dirname(receiverStart), { recursive: true });
	writeFileSync(receiverStart, "// stands in for the packed start.mjs\n");
	return { dep, moduleDir: join(pkg, "src"), receiverStart };
}

test("npm layout: the rendered linux unit points at files that EXIST under node_modules — never the @edgehero scope dir", async () => {
	const { dep, moduleDir } = npmLayout();
	const h = harness({ platform: "linux", argv: ["render"], cwd: dep, moduleDir });
	assert.equal(await h.run(), 0);
	const text = h.text();
	const exec = text.match(/^ExecStart=(\S+) (\S+) worker$/m);
	assert.ok(exec, "ExecStart parses as <node> <cliPath> worker");
	assert.equal(exec[1], "/fake/node/bin/node");
	assert.ok(existsSync(exec[2]), `the rendered ExecStart target must exist: ${exec[2]}`);
	assert.ok(exec[2].includes(join("node_modules", "@edgehero", "pi-dispatch", "src")), "the cli comes from the PACKAGE");
	assert.ok(!text.includes(join("@edgehero", "worker")), "the issue #96 scope-dir path shape must never render");
	assert.ok(text.includes(`EnvironmentFile=${dep}/.env`), ".env is the deployment folder's, beside node_modules");
	assert.ok(text.includes(`WorkingDirectory=${dep}`));
});

test("npm layout: the plist's wrapper and exec argv exist in the package and logs land in the deployment folder", async () => {
	const { dep, moduleDir } = npmLayout();
	const h = harness({ platform: "darwin", argv: ["render"], cwd: dep, moduleDir });
	assert.equal(await h.run(), 0);
	const text = h.text();
	const cli = join(moduleDir, "cli.mjs");
	const wrapper = join(dep, "node_modules", "@edgehero", "pi-dispatch", "deploy", "worker-env-wrapper.sh");
	assert.deepEqual(
		programArguments(text),
		["/bin/sh", wrapper, "/fake/node/bin/node", cli, "worker"],
		"sh, the PACKAGE's shipped wrapper, then the exec argv the wrapper runs",
	);
	assert.ok(existsSync(wrapper), `the wrapper path must exist: ${wrapper}`);
	assert.ok(existsSync(cli), `the cli path must exist: ${cli}`);
	assert.ok(text.includes(`<string>${dep}/logs/worker.out.log</string>`), "logs belong to the deployment folder, not the package");
});

test("npm layout: the receiver render uses the resolved receiver package; win32 nssm uses the package wrapper and the deployment folder", async () => {
	const { dep, moduleDir, receiverStart } = npmLayout();
	const r = harness({ platform: "linux", argv: ["render", "--receiver"], cwd: dep, moduleDir, resolveReceiver: () => receiverStart });
	assert.equal(await r.run(), 0);
	assert.ok(r.text().includes(`ExecStart=/fake/node/bin/node ${receiverStart}`), "ExecStart = the sibling-installed receiver package's start");
	assert.ok(existsSync(receiverStart));
	const w = harness({ platform: "win32", argv: ["render"], cwd: dep, moduleDir });
	assert.equal(await w.run(), 0);
	const wrapperCmd = join(dep, "node_modules", "@edgehero", "pi-dispatch", "deploy", "worker-env-wrapper.cmd");
	assert.ok(w.text().includes(`nssm install pi-dispatch-worker ${wrapperCmd} /fake/node/bin/node ${join(moduleDir, "cli.mjs")} worker`));
	assert.ok(existsSync(wrapperCmd), "the .cmd wrapper ships in the package");
	assert.ok(w.text().includes(`nssm set pi-dispatch-worker AppDirectory ${dep}`));
});

test("--receiver with no receiver package installed: render and install both refuse with the npm install hint, writing nothing", async () => {
	const r = harness({ platform: "linux", argv: ["render", "--receiver"], resolveReceiver: () => null });
	assert.equal(await r.run(), 1);
	assert.match(r.errText(), /receiver package is not installed here/);
	assert.match(r.errText(), /npm install @edgehero\/pi-dispatch-receiver/);
	assert.match(r.errText(), /from the deployment folder/);
	const i = harness({ platform: "darwin", argv: ["install", "--receiver"], resolveReceiver: () => null, plan: { launchctl: 0 } });
	assert.equal(await i.run(), 1);
	assert.match(i.errText(), /npm install @edgehero\/pi-dispatch-receiver/);
	assert.equal(i.store.size, 0, "nothing written after the refusal");
	assert.equal(i.calls.length, 0, "nothing spawned after the refusal");
});

// ---------------------------------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------------------------------

test("install darwin: refuses euid 0 outright — no writes, no spawns", async () => {
	const h = harness({ platform: "darwin", euid: 0, argv: ["install"] });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /root/);
	assert.match(h.errText(), /without sudo/);
	assert.equal(h.store.size, 0, "nothing written");
	assert.equal(h.calls.length, 0, "nothing spawned");
});

test("install darwin: writes the LaunchAgent with the exec argv, creates the logs dir, bootstraps and enables it, and prints the honest login-scope note", async () => {
	const h = harness({ platform: "darwin", argv: ["install"], plan: { launchctl: 0 } });
	assert.equal(await h.run(), 0);
	const plist = h.store.get(AGENT_PLIST);
	assert.ok(plist, "plist written into ~/Library/LaunchAgents");
	assert.ok(plist.includes(`<string>${WRAPPER_SH}</string>`), "the installed plist runs the package wrapper");
	assert.ok(plist.includes(`<string>${CLI_PATH}</string>`) && plist.includes("<string>worker</string>"), "the installed plist carries the exec argv");
	assert.ok(h.mkdirs.includes(`${DEPLOY_AT}/logs`), "launchd will not create StandardOutPath's directory — install must");
	const argvs = h.calls.map((c) => [c.cmd, ...c.args].join(" "));
	assert.deepEqual(argvs, [`launchctl bootstrap gui/501 ${AGENT_PLIST}`, "launchctl enable gui/501/com.pi-dispatch.worker"]);
	assert.match(h.text(), /LOGIN-scoped/, "no pretending a LaunchAgent is a boot daemon");
	assert.match(h.text(), /Docker Desktop is itself login-scoped/);
});

test("install darwin: a worker unit in the system scope (LaunchDaemons) refuses, citing the boot-reaper invariant", async () => {
	const h = harness({
		platform: "darwin",
		argv: ["install"],
		files: { "/Library/LaunchDaemons/com.pi-dispatch.worker.plist": "<plist/>" },
	});
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /DES-CONCURRENCY-3/);
	assert.match(h.errText(), /boot reaper/);
	assert.equal(h.store.has(AGENT_PLIST), false, "nothing written after a refusal");
	assert.equal(h.calls.length, 0);
});

test("install linux --user: unit written without User=, daemon-reload then enable --now, linger hint printed", async () => {
	const h = harness({ platform: "linux", argv: ["install"], plan: { systemctl: 0 } });
	assert.equal(await h.run(), 0);
	const unit = h.store.get(USER_UNIT);
	assert.ok(unit, "unit written into ~/.config/systemd/user");
	assert.doesNotMatch(unit, /^User=/m);
	assert.ok(unit.includes(`ExecStart=/fake/node/bin/node ${CLI_PATH} worker`), "the installed unit carries the absolute cli path");
	assert.match(unit, /RestartPreventExitStatus=2/);
	assert.match(unit, /WantedBy=default\.target/);
	const argvs = h.calls.map((c) => c.args);
	assert.deepEqual(argvs, [
		["--user", "daemon-reload"],
		["--user", "enable", "--now", "pi-dispatch-worker.service"],
	]);
	assert.match(h.text(), /loginctl enable-linger tester/, "the headless-boot hint is printed");
});

test("install linux --system: prints the exact sudo commands, stages the render, and spawns NOTHING", async () => {
	const h = harness({ platform: "linux", argv: ["install", "--system"] });
	assert.equal(await h.run(), 0);
	assert.equal(h.calls.length, 0, "the pm2 pattern: no command runs, root actions happen only in the operator's shell");
	const staged = h.store.get("/faketmp/pi-dispatch-worker.service");
	assert.ok(staged, "the render is staged for inspection");
	assert.match(staged, /^User=tester$/m, "system scope keeps a User= line, rewritten to the invoking user");
	assert.match(staged, /RestartPreventExitStatus=2/);
	assert.ok(staged.includes(`EnvironmentFile=${DEPLOY_AT}/.env`), "the staged render still points .env at the deployment folder");
	assert.ok(h.text().includes("sudo install -m 644 /faketmp/pi-dispatch-worker.service /etc/systemd/system/pi-dispatch-worker.service"));
	assert.ok(h.text().includes("sudo systemctl daemon-reload"));
	assert.ok(h.text().includes("sudo systemctl enable --now pi-dispatch-worker.service"));
});

test("install linux --user: an existing unit in the SAME scope refuses without --force and touches nothing", async () => {
	const h = harness({ platform: "linux", argv: ["install"], files: { [USER_UNIT]: "operator edited this" } });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /--force/);
	assert.equal(h.store.get(USER_UNIT), "operator edited this", "the existing unit is untouched (init's non-clobber contract)");
	assert.equal(h.calls.length, 0);
});

test("install linux --user: --force replaces the same-scope unit and proceeds to enable", async () => {
	const h = harness({ platform: "linux", argv: ["install", "--force"], files: { [USER_UNIT]: "old" }, plan: { systemctl: 0 } });
	assert.equal(await h.run(), 0);
	assert.notEqual(h.store.get(USER_UNIT), "old", "--force overwrote the unit");
	assert.ok(h.calls.some((c) => c.args.includes("enable")), "enable --now still runs");
});

test("install linux --user: a worker unit in the OTHER scope refuses — one worker per docker daemon", async () => {
	// worker.service is the name the README's manual `sudo cp` produces; a hand-installed worker is
	// still a second worker.
	const h = harness({ platform: "linux", argv: ["install"], files: { "/etc/systemd/system/worker.service": "[Unit]" } });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /other scope/);
	assert.match(h.errText(), /DES-CONCURRENCY-3/);
	assert.match(h.errText(), /boot reaper kills every pi-job container/);
	assert.equal(h.store.has(USER_UNIT), false);
});

test("install linux --receiver: the cross-scope WORKER refusal does not apply to the receiver", async () => {
	// A second receiver is pointless, not destructive — only the worker owns the docker daemon.
	const h = harness({
		platform: "linux",
		argv: ["install", "--receiver"],
		files: { "/etc/systemd/system/worker.service": "[Unit]" },
		plan: { systemctl: 0 },
	});
	assert.equal(await h.run(), 0);
	assert.ok(h.store.has("/home/tester/.config/systemd/user/pi-dispatch-receiver.service"));
});

test("install win32: nssm absent → the download pointer, nothing else", async () => {
	const h = harness({ platform: "win32", argv: ["install"], plan: { nssm: "enoent" } });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /nssm\.cc/);
	assert.match(h.errText(), /winget install nssm/);
	assert.match(h.errText(), /Task Scheduler is not a substitute/);
});

test("install win32: drives the nssm-install.cmd sequence — package wrapper + exec argv, AppDirectory = deployment folder, AppExit 2 Exit included", async () => {
	const h = harness({ platform: "win32", argv: ["install"], plan: { "nssm status": 3, nssm: 0 } });
	assert.equal(await h.run(), 0);
	const argvs = h.calls.map((c) => c.args);
	assert.deepEqual(argvs[0], ["status", "pi-dispatch-worker"], "the probe that answers both on-PATH and already-exists");
	assert.deepEqual(argvs.slice(1), [
		["install", "pi-dispatch-worker", WRAPPER_CMD, "/fake/node/bin/node", CLI_PATH, "worker"],
		["set", "pi-dispatch-worker", "AppDirectory", DEPLOY_AT],
		["set", "pi-dispatch-worker", "AppStdout", `${DEPLOY_AT}\\logs\\worker.out.log`],
		["set", "pi-dispatch-worker", "AppStderr", `${DEPLOY_AT}\\logs\\worker.err.log`],
		["set", "pi-dispatch-worker", "AppStopMethodConsole", "15000"],
		["set", "pi-dispatch-worker", "AppThrottle", "5000"],
		["set", "pi-dispatch-worker", "AppExit", "Default", "Restart"],
		["set", "pi-dispatch-worker", "AppExit", "2", "Exit"],
	]);
	assert.ok(h.mkdirs.includes(join(DEPLOY_AT, "logs")), "nssm will not create the AppStdout directory — install must");
	assert.match(h.text(), /nssm start pi-dispatch-worker/);
});

test("install win32: an existing service refuses without --force", async () => {
	const h = harness({ platform: "win32", argv: ["install"], plan: { "nssm status": 0 } });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /--force/);
	assert.equal(h.calls.length, 1, "only the status probe ran");
});

// ---------------------------------------------------------------------------------------------------
// uninstall / status
// ---------------------------------------------------------------------------------------------------

test("uninstall linux: not installed → refusal that names both looked-at paths", async () => {
	const h = harness({ platform: "linux", argv: ["uninstall"] });
	assert.equal(await h.run(), 1);
	assert.ok(h.errText().includes(USER_UNIT), "the user-scope path it looked at is named");
	assert.ok(h.errText().includes("/etc/systemd/system/pi-dispatch-worker.service"), "the system-scope path it looked at is named");
});

test("uninstall linux: disable --now, remove the unit, daemon-reload", async () => {
	const h = harness({ platform: "linux", argv: ["uninstall"], files: { [USER_UNIT]: "[Unit]" }, plan: { systemctl: 0 } });
	assert.equal(await h.run(), 0);
	assert.equal(h.store.has(USER_UNIT), false, "unit file removed");
	assert.deepEqual(h.calls.map((c) => c.args), [
		["--user", "disable", "--now", "pi-dispatch-worker.service"],
		["--user", "daemon-reload"],
	]);
});

test("uninstall linux: a system-scope unit is never touched — the sudo commands are printed instead", async () => {
	const h = harness({ platform: "linux", argv: ["uninstall"], files: { "/etc/systemd/system/pi-dispatch-worker.service": "[Unit]" } });
	assert.equal(await h.run(), 1);
	assert.match(h.errText(), /never touches root scope/);
	assert.match(h.errText(), /sudo systemctl disable --now pi-dispatch-worker\.service/);
	assert.equal(h.calls.length, 0);
});

test("status is informational: exits 0 whether or not anything is installed", async () => {
	const empty = harness({ platform: "linux", argv: ["status"] });
	assert.equal(await empty.run(), 0);
	assert.match(empty.text(), /not installed/);
	const installed = harness({
		platform: "linux",
		argv: ["status"],
		files: { [USER_UNIT]: "[Unit]" },
		plan: { systemctl: { code: 0, output: "active\n" } },
	});
	assert.equal(await installed.run(), 0);
	assert.match(installed.text(), /active/);
});

// ---------------------------------------------------------------------------------------------------
// restart --drain
// ---------------------------------------------------------------------------------------------------

function fakeQueue(activeSeries, events) {
	return {
		pause: async () => events.push("pause"),
		resume: async () => events.push("resume"),
		getJobCounts: async () => {
			const active = activeSeries.length > 1 ? activeSeries.shift() : activeSeries[0];
			events.push(`counts:${active}`);
			return { active };
		},
		close: async () => events.push("close"),
	};
}

test("restart --drain: pause, poll until active hits 0, restart the unit, resume — in exactly that order", async () => {
	const events = [];
	const h = harness({
		platform: "linux",
		argv: ["restart", "--drain"],
		plan: { systemctl: 0 },
		queue: fakeQueue([3, 1, 0], events),
		events,
	});
	assert.equal(await h.run(), 0);
	assert.deepEqual(events, [
		"pause",
		"counts:3",
		"sleep",
		"counts:1",
		"sleep",
		"counts:0",
		"spawn systemctl --user stop pi-dispatch-worker.service",
		"spawn systemctl --user start pi-dispatch-worker.service",
		"resume",
		"close",
	]);
});

test("restart --drain timeout: stops WITHOUT restarting, and resume is NOT called — a timed-out drain must not un-pause a queue that still has an active job", async () => {
	const events = [];
	const h = harness({
		platform: "linux",
		argv: ["restart", "--drain", "--drain-timeout", "4"],
		plan: { systemctl: 0 },
		queue: fakeQueue([2], events),
		events,
	});
	assert.equal(await h.run(), 1);
	assert.ok(!events.includes("resume"), "resume would feed jobs toward a restart that is still owed");
	assert.ok(!events.some((e) => e.startsWith("spawn")), "no restart of a unit with a job still in flight");
	assert.ok(events.includes("close"), "the queue connection is still closed");
	assert.match(h.text(), /STAYS PAUSED/);
	assert.match(h.text(), /NOT restarting/);
});

// ---------------------------------------------------------------------------------------------------
// misc surface
// ---------------------------------------------------------------------------------------------------

test("an unknown subcommand prints the service usage and exits 1; bare `service` exits 0", async () => {
	const bad = harness({ argv: ["frobnicate"] });
	assert.equal(await bad.run(), 1);
	assert.match(bad.text(), /pi-dispatch service/);
	const bare = harness({ argv: [] });
	assert.equal(await bare.run(), 0);
});

test("--user and --system together refuse; --system refuses on macOS", async () => {
	const both = harness({ platform: "linux", argv: ["install", "--user", "--system"] });
	assert.equal(await both.run(), 1);
	assert.match(both.errText(), /mutually exclusive/);
	const mac = harness({ platform: "darwin", argv: ["install", "--system"] });
	assert.equal(await mac.run(), 1);
	assert.match(mac.errText(), /user-scope only/);
});

// ---------------------------------------------------------------------------------------------------
// The real wrapper under a real sh: the exit-2 conversion, the SIGTERM forwarding, the ./.env contract
// and the argv contract are behaviour of deploy/worker-env-wrapper.sh itself, so these tests execute
// the shipped file exactly the way a rendered unit does: cwd = the deployment folder (the unit's
// WorkingDirectory) and the command as arguments. POSIX-only (win32 has no sh).
// ---------------------------------------------------------------------------------------------------

const POSIX = process.platform === "linux" || process.platform === "darwin";
const REAL_WRAPPER = join(REPO_ROOT, "deploy", "worker-env-wrapper.sh");

function wrapperDir(nodeStub, { env = true } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "pi-dispatch-wrapper-"));
	if (env) writeFileSync(join(dir, ".env"), "PI_WRAPPER_TEST=1\n");
	mkdirSync(join(dir, "bin"));
	writeFileSync(join(dir, "bin", "node"), nodeStub);
	chmodSync(join(dir, "bin", "node"), 0o755);
	return dir;
}

function runWrapper(dir, { args, onSpawn, env = {} } = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("sh", [REAL_WRAPPER, ...(args ?? [join(dir, "bin", "node")])], {
			cwd: dir,
			// `env` is how the daemon manager delivers PI_ENV_SETUP: the plist's EnvironmentVariables
			// dict on macOS, `nssm set … AppEnvironmentExtra` on Windows. Nothing composes a shell.
			env: { ...process.env, MARKER_DIR: dir, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", reject);
		child.on("close", (code) => resolvePromise({ code, stderr }));
		// Routed through the promise on purpose: a bare onSpawn?.(child) drops a rejection on the floor
		// (an async callback here returns a promise nobody holds), so a throw inside it would surface as
		// an unhandled rejection somewhere else in the run instead of failing this test.
		Promise.resolve(onSpawn?.(child)).catch(reject);
	});
}

/**
 * Poll for a marker file the wrapper's stub writes, and SAY whether it appeared (issue #207). The old
 * inline loop fell through on timeout and signalled anyway: on a loaded runner the TERM landed before
 * the stub had installed its trap, the stub died on the default disposition, and the resulting failure
 * was word-for-word identical to the wrapper simply not forwarding. Returning the answer lets the
 * caller assert the two apart. The bound is generous on purpose -- it is a ceiling on a hang, never a
 * wait in the healthy case, where the marker lands in tens of milliseconds.
 */
async function waitForMarker(path, timeoutMs = 30_000, stepMs = 25) {
	for (let waited = 0; waited < timeoutMs; waited += stepMs) {
		if (existsSync(path)) return true;
		await new Promise((r) => setTimeout(r, stepMs));
	}
	return existsSync(path);
}

test("wrapper: a policy refusal (node exits 2) becomes a clean exit 0 with the refusal note — KeepAlive must not relaunch it", { skip: !POSIX }, async () => {
	const dir = wrapperDir("#!/bin/sh\nexit 2\n");
	const { code, stderr } = await runWrapper(dir);
	assert.equal(code, 0, "exit 2 is converted so SuccessfulExit=false KeepAlive leaves it stopped");
	assert.match(stderr, /policy refusal \(exit 2\)/);
	assert.match(stderr, /not restarting/);
});

test("wrapper: every other nonzero exit passes through untouched (7 stays 7, so crashes still restart)", { skip: !POSIX }, async () => {
	const dir = wrapperDir("#!/bin/sh\nexit 7\n");
	const { code } = await runWrapper(dir);
	assert.equal(code, 7);
});

test("wrapper: sources ./.env from its cwd and passes the trailing argv through to the command", { skip: !POSIX }, async () => {
	// The stub proves both halves of the contract at once: the sourced variable arrived, and so did
	// the argument after the script path (the `worker` in `<node> <cli> worker`).
	const dir = wrapperDir('#!/bin/sh\n[ "$PI_WRAPPER_TEST" = "1" ] || exit 9\n[ "$1" = "worker" ] || exit 8\nexit 0\n');
	const { code } = await runWrapper(dir, { args: [join(dir, "bin", "node"), "worker"] });
	assert.equal(code, 0, "exit 9 = .env not sourced; exit 8 = argv not forwarded");
});

test("wrapper: refuses with no argv command — it no longer decides what to run", { skip: !POSIX }, async () => {
	const dir = wrapperDir("#!/bin/sh\nexit 0\n");
	const { code, stderr } = await runWrapper(dir, { args: [] });
	assert.equal(code, 1);
	assert.match(stderr, /no command given/);
	assert.match(stderr, /pi-dispatch service render/, "points at the re-render that composes the argv");
});

test("wrapper: refuses when ./.env is absent from its cwd, naming the directory it looked in", { skip: !POSIX }, async () => {
	const dir = wrapperDir("#!/bin/sh\nexit 0\n", { env: false });
	const { code, stderr } = await runWrapper(dir);
	assert.equal(code, 1);
	assert.match(stderr, /\.env not found in \//, "the message names $PWD, an absolute directory");
	assert.match(stderr, /deployment folder/, "the message explains the WorkingDirectory contract instead of guessing");
});

test("wrapper: SIGTERM to the wrapper reaches node (trap + kill + double wait replaces the old exec)", { skip: !POSIX }, async () => {
	// The stub waits, and on TERM it records the delivery and exits 0. If the wrapper failed to forward,
	// the stub would sit in sleep and the test would time out. The trap must kill the sleep too: an
	// orphaned sleep inherits the wrapper's stdio pipes and would hold the spawn's `close` event (and
	// this test) hostage for the full 30s.
	//
	// ORDER IS THE POINT (issue #207): the `started` marker is written LAST, after the sleep, after $sp
	// and after the trap, so its existence means the stub is genuinely ready to be signalled. It used to
	// be the first line, which made it a marker for "the stub has begun" -- a TERM racing in behind it
	// still landed on the default disposition, and the test blamed the wrapper.
	const dir = wrapperDir('#!/bin/sh\nsleep 30 &\nsp=$!\ntrap \': > "$MARKER_DIR/got-term"; kill "$sp" 2>/dev/null; exit 0\' TERM\n: > "$MARKER_DIR/started"\nwait\nexit 1\n');
	let ready = false;
	const { code } = await runWrapper(dir, {
		onSpawn: async (child) => {
			// Signal only after the stub is definitely running, so the wrapper's trap is in place. When it
			// never gets there, KILL instead of signalling: a TERM sent into a stub that has not reached
			// its `trap` line tests nothing, and used to be reported as a forwarding failure (issue #207).
			// SIGKILL only ends the wrapper, but the stub cannot be past its first line if `started` is
			// missing, so there is nothing left holding the pipes.
			ready = await waitForMarker(join(dir, "started"));
			child.kill(ready ? "SIGTERM" : "SIGKILL");
		},
	});
	assert.ok(
		ready,
		"the stub never wrote its `started` marker: the readiness wait timed out and the wrapper was never signalled, so this is a slow or hung stub, NOT a signal-forwarding failure",
	);
	assert.ok(existsSync(join(dir, "got-term")), "the stub received the forwarded TERM");
	assert.equal(code, 0, "the wrapper reports node's post-drain exit code, not its own interrupted wait");
});

// ---------------------------------------------------------------------------------------------------
// The wrapper's half of the --env-setup seam (issue #209). Same discipline as above: the SHIPPED file
// under a real sh, started the way a rendered unit starts it. These are the tests that make the macOS
// and Windows halves more than a rendered string, because the wrapper is where the behaviour lives.
// ---------------------------------------------------------------------------------------------------

/** Write an env-setup script into the wrapper's temp dir and return its absolute path. */
function setupScript(dir, body, name = "setup-env.sh") {
	const path = join(dir, name);
	writeFileSync(path, body);
	return path;
}

test("wrapper: PI_ENV_SETUP is sourced, and it BEATS ./.env — a stale key in the file must not shadow the manager", { skip: !POSIX }, async () => {
	// .env sets the variable to the stale value; the setup script sets it to the managed one. The stub
	// exits 0 only if the managed value won, which is the whole promise of running the setup after.
	const dir = wrapperDir('#!/bin/sh\n[ "$PI_WRAPPER_TEST" = "managed" ] || exit 9\n[ "$PI_BARE_EXPORT" = "1" ] || exit 8\nexit 0\n');
	// A bare KEY=value, deliberately: `set -a` around the source is what makes it export, exactly as
	// ./.env and systemd's EnvironmentFile= do. Without it the child would never see PI_BARE_EXPORT.
	const setup = setupScript(dir, 'PI_WRAPPER_TEST=managed\nPI_BARE_EXPORT=1\n');
	const { code } = await runWrapper(dir, { env: { PI_ENV_SETUP: setup } });
	assert.equal(code, 0, "exit 9 = .env shadowed the manager; exit 8 = a bare KEY=value did not export");
});

test("wrapper: with PI_ENV_SETUP set, a missing ./.env starts instead of refusing, and says where the environment came from", { skip: !POSIX }, async () => {
	const dir = wrapperDir('#!/bin/sh\n[ "$FROM_MANAGER" = "1" ] || exit 9\nexit 0\n', { env: false });
	const setup = setupScript(dir, "export FROM_MANAGER=1\n");
	const { code, stderr } = await runWrapper(dir, { env: { PI_ENV_SETUP: setup } });
	assert.equal(code, 0, "the .env refusal is relaxed ONLY when the environment demonstrably comes from elsewhere");
	assert.match(stderr, /no \.env in \//, "it still says so, rather than starting silently");
	assert.match(stderr, /PI_ENV_SETUP/);
});

test("wrapper: a PI_ENV_SETUP that does not exist exits 1 and names it — never 2, which would read as a policy refusal", { skip: !POSIX }, async () => {
	const dir = wrapperDir("#!/bin/sh\nexit 0\n");
	const { code, stderr } = await runWrapper(dir, { env: { PI_ENV_SETUP: join(dir, "nope.sh") } });
	assert.equal(code, 1, "infrastructure, worth a restart — not the determinate refusal that must stay stopped");
	assert.match(stderr, /does not exist/);
	assert.match(stderr, /nope\.sh/);
});

test("wrapper: a PI_ENV_SETUP script that FAILS exits 1, and the worker never starts", { skip: !POSIX }, async () => {
	// The stub writes a marker if it ever runs. A failed setup means a half-filled environment, and
	// starting the worker with one would spend a budget reservation on a config that cannot work.
	const dir = wrapperDir('#!/bin/sh\n: > "$MARKER_DIR/ran"\nexit 0\n');
	const setup = setupScript(dir, "echo 'manager unreachable' >&2\nfalse\n");
	const { code, stderr } = await runWrapper(dir, { env: { PI_ENV_SETUP: setup } });
	assert.equal(code, 1, "a failed setup is 1, never 2");
	assert.match(stderr, /script failed/);
	assert.ok(!existsSync(join(dir, "ran")), "the command must not run on a half-filled environment");
});

test("wrapper: a PI_ENV_SETUP line INSIDE ./.env is not honoured — the seam is unit configuration, not file content", { skip: !POSIX }, async () => {
	// The path is captured before ./.env is sourced on purpose. Otherwise anything that could write
	// .env (an operator's editor, a manager's own template render) could name a script the wrapper runs.
	const dir = wrapperDir('#!/bin/sh\n[ -z "$PLANTED" ] || exit 9\nexit 0\n');
	const planted = setupScript(dir, "export PLANTED=1\n", "planted.sh");
	writeFileSync(join(dir, ".env"), `PI_WRAPPER_TEST=1\nPI_ENV_SETUP=${planted}\n`);
	const { code } = await runWrapper(dir);
	assert.equal(code, 0, "exit 9 = a .env line got itself sourced as a setup script");
});

test("wrapper: the exit-2 conversion survives the seam — a policy refusal under PI_ENV_SETUP still stops cleanly", { skip: !POSIX }, async () => {
	const dir = wrapperDir("#!/bin/sh\nexit 2\n");
	const setup = setupScript(dir, "export FROM_MANAGER=1\n");
	const { code, stderr } = await runWrapper(dir, { env: { PI_ENV_SETUP: setup } });
	assert.equal(code, 0, "EXIT_POLICY is still converted, so KeepAlive leaves a refusal stopped");
	assert.match(stderr, /policy refusal \(exit 2\)/);
});

test("wrapper: SIGTERM still reaches the command through the seam", { skip: !POSIX }, async () => {
	const dir = wrapperDir('#!/bin/sh\nsleep 30 &\nsp=$!\ntrap \': > "$MARKER_DIR/got-term"; kill "$sp" 2>/dev/null; exit 0\' TERM\n: > "$MARKER_DIR/started"\nwait\nexit 1\n');
	const setup = setupScript(dir, "export FROM_MANAGER=1\n");
	let ready = false;
	const { code } = await runWrapper(dir, {
		env: { PI_ENV_SETUP: setup },
		onSpawn: async (child) => {
			ready = await waitForMarker(join(dir, "started"));
			child.kill(ready ? "SIGTERM" : "SIGKILL");
		},
	});
	assert.ok(ready, "the stub never wrote its `started` marker: a readiness timeout, NOT a forwarding failure");
	assert.ok(existsSync(join(dir, "got-term")), "sourcing a setup script must not cost the graceful drain");
	assert.equal(code, 0);
});
