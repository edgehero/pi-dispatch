import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installedUnitPaths, readUnitSeam, runService, TEMPLATE_PINS } from "../src/service.mjs";

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
// The read side (issue #216): the rendered unit is the ONLY record of --env-setup, so doctor reads it
// back out. These are the anti-drift pins — every assertion below runs a REAL render through the REAL
// reader, so changing what composeEnvSetupExec or renderPlist emits without changing ENV_SETUP_READERS
// turns this file red rather than making doctor quietly blind.
// ---------------------------------------------------------------------------------------------------

test("round-trip: what the render writes is exactly what readUnitSeam reads back, on every platform", async () => {
	for (const platform of ["linux", "darwin"]) {
		const h = harness({ platform, argv: ["render", "--env-setup", ENV_SETUP], files: ENV_SETUP_FILES });
		assert.equal(await h.run(), 0);
		assert.deepEqual(readUnitSeam(h.text(), platform), { setup: ENV_SETUP, deployDir: DEPLOY_AT }, `${platform}: the path and the deployment survive the round trip`);
	}
	// win32's unit is not a file: the render SETS the value with `nssm set … AppEnvironmentExtra`, and
	// doctor reads it back from `nssm get`, which echoes the NAME=VALUE. That is the pair pinned here.
	const win = harness({ platform: "win32", argv: ["render", "--env-setup", "C:\\pi\\setup.cmd"], files: { "C:\\pi\\setup.cmd": "@echo off\n" } });
	assert.equal(await win.run(), 0);
	const set = win.text().match(/AppEnvironmentExtra "([^"]*)"/);
	assert.ok(set, "the render sets AppEnvironmentExtra");
	assert.deepEqual(readUnitSeam(set[1], "win32"), { setup: "C:\\pi\\setup.cmd", deployDir: null });
});

test("round-trip: a default render carries no seam, which is every unit that predates the flag", async () => {
	for (const platform of ["linux", "darwin"]) {
		const h = harness({ platform, argv: ["render"] });
		assert.equal(await h.run(), 0);
		assert.deepEqual(readUnitSeam(h.text(), platform), { setup: null, deployDir: DEPLOY_AT }, `${platform}: no flag, no seam — and the deployment is still readable`);
	}
});

test("installedUnitPaths names both daemons in both scopes, and the hand-copied worker.service too", () => {
	const linux = installedUnitPaths("linux", "/home/tester").map((u) => u.path);
	assert.ok(linux.includes(USER_UNIT), "the user-scope worker unit install writes");
	assert.ok(linux.includes("/etc/systemd/system/pi-dispatch-worker.service"));
	assert.ok(linux.includes("/etc/systemd/system/worker.service"), "the README's manual `sudo cp` produces this name, and it is still a worker");
	assert.ok(linux.includes("/home/tester/.config/systemd/user/pi-dispatch-receiver.service"));
	const darwin = installedUnitPaths("darwin", "/home/tester").map((u) => u.path);
	assert.ok(darwin.includes(AGENT_PLIST));
	assert.ok(darwin.includes("/Library/LaunchDaemons/com.pi-dispatch.receiver.plist"));
	assert.deepEqual(installedUnitPaths("win32", "/home/tester"), [], "there is no unit FILE on Windows — only `nssm get`");
});

test("regression: the deployment-folder substitution must not rewrite the operator's --env-setup path", async () => {
	// The path the operator typed contains the template's own placeholder. Substituting AFTER the
	// ExecStart was composed turned it into /srv/pi-deploy/setup-env.sh — a file resolveEnvSetup never
	// checked, with the banner comment above it still naming the one that was typed.
	const setup = "/opt/pi-dispatch/setup-env.sh";
	const files = { [setup]: "#!/bin/sh\n" };
	const linux = harness({ platform: "linux", argv: ["render", "--env-setup", setup], files });
	assert.equal(await linux.run(), 0);
	assert.ok(linux.text().includes(`. "${setup}" || exit 1`), "the unit sources the file that was typed");
	assert.equal(readUnitSeam(linux.text(), "linux").setup, setup);
	assert.equal(
		(linux.text().match(/--env-setup ([^\s`]+)/) ?? [])[1],
		setup,
		"the banner comment and the ExecStart below it must name the same file",
	);
	assert.ok(linux.text().includes(`WorkingDirectory=${DEPLOY_AT}`), "the template's own placeholders are still substituted");

	const darwin = harness({ platform: "darwin", argv: ["render", "--env-setup", setup], files });
	assert.equal(await darwin.run(), 0);
	assert.equal(readUnitSeam(darwin.text(), "darwin").setup, setup);
	assert.ok(darwin.text().includes(`<string>${DEPLOY_AT}</string>`), "WorkingDirectory still points at the deployment folder");
});

test("regression: a deployment folder holding `$&` renders literally rather than splicing itself", async () => {
	// String.replace and replaceAll read $& out of a replacement STRING. Every substitution that carries
	// a computed path is a function replacement for exactly this reason.
	const cwd = "/srv/pi$&deploy";
	for (const platform of ["linux", "darwin"]) {
		const h = harness({ platform, argv: ["render"], cwd });
		assert.equal(await h.run(), 0);
		assert.ok(h.text().includes(cwd), `${platform}: the deployment folder appears verbatim`);
		assert.doesNotMatch(h.text(), /\/opt\/pi-dispatch/, `${platform}: and nothing of the placeholder survives`);
		assert.equal(readUnitSeam(h.text(), platform).deployDir, cwd);
	}
});

test("status names the configured env-setup script, and says nothing when there is none", async () => {
	const withSeam = harness({
		platform: "linux",
		argv: ["status"],
		files: { [USER_UNIT]: `WorkingDirectory=${DEPLOY_AT}\nExecStart=/bin/sh -c 'set -a; . "${ENV_SETUP}" || exit 1; set +a; exec "/fake/node/bin/node" "x" "worker"'\n` },
		plan: { systemctl: { code: 0, output: "active\n" } },
	});
	assert.equal(await withSeam.run(), 0);
	assert.match(withSeam.text(), new RegExp(`env-setup: ${ENV_SETUP.replace(/[.\\/]/g, "\\$&")} \\(named by ${USER_UNIT.replace(/[.\\/]/g, "\\$&")}\\)`));

	const without = harness({
		platform: "linux",
		argv: ["status"],
		files: { [USER_UNIT]: `WorkingDirectory=${DEPLOY_AT}\nExecStart=/fake/node/bin/node x worker\n` },
		plan: { systemctl: { code: 0, output: "active\n" } },
	});
	assert.equal(await without.run(), 0);
	assert.doesNotMatch(without.text(), /env-setup/, "a deployment without the seam sees byte-identical status output");
});

test("status reads the seam out of a plist, and out of nssm on win32", async () => {
	const mac = harness({
		platform: "darwin",
		argv: ["status"],
		files: { [AGENT_PLIST]: `<key>WorkingDirectory</key>\n\t<string>${DEPLOY_AT}</string>\n<key>PI_ENV_SETUP</key>\n\t\t<string>${ENV_SETUP}</string>\n` },
		plan: { launchctl: 0 },
	});
	assert.equal(await mac.run(), 0);
	assert.match(mac.text(), /env-setup: \/etc\/pi-dispatch\/setup-env\.sh \(named by /);

	const win = harness({
		platform: "win32",
		argv: ["status"],
		plan: { "nssm get": { code: 0, output: `PI_ENV_SETUP=C:\\pi\\setup.cmd\r\n` }, "nssm status": { code: 0, output: "SERVICE_RUNNING\n" } },
	});
	assert.equal(await win.run(), 0);
	assert.match(win.text(), /env-setup: C:\\pi\\setup\.cmd \(named by pi-dispatch-worker's AppEnvironmentExtra\)/);
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

function runWrapper(dir, { args, onSpawn, env = {}, wrapper = REAL_WRAPPER } = {}) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn("sh", [wrapper, ...(args ?? [join(dir, "bin", "node")])], {
			cwd: dir,
			// `env` is how the daemon manager delivers PI_ENV_SETUP: the plist's EnvironmentVariables
			// dict on macOS, `nssm set … AppEnvironmentExtra` on Windows. Nothing composes a shell.
			env: { ...process.env, MARKER_DIR: dir, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (d) => (stderr += d));
		child.on("error", reject);
		// BOTH must settle before the caller reads anything (issue #221). Resolving on `close` alone let
		// a wrapper that exited EARLY beat its own onSpawn -- and the wrapper now exits early BY DESIGN
		// when a stop arrives during startup. onSpawn is where `ready` is assigned, so the assertion ran
		// against its initial false and reported a readiness timeout that never happened: a fabricated
		// diagnosis, in the one place a real one was needed. The abandoned poll then ran on after the
		// test had finished.
		//
		// Still routed through the promise for the older reason too: a bare onSpawn?.(child) drops an
		// async callback's rejection, so a throw inside it surfaced as an unhandled rejection somewhere
		// else in the run instead of failing this test.
		const closed = new Promise((r) => child.on("close", (code, signal) => r({ code, signal })));
		Promise.all([closed, Promise.resolve(onSpawn?.(child))])
			.then(([result]) => resolvePromise({ ...result, stderr }))
			.catch(reject);
	});
}

// How long the signal stubs below stay alive, and the readiness ceiling that must stay well INSIDE it.
// Derived rather than typed twice, because the old pair was a 30s readiness bound against a 30s stub
// with zero headroom: a slow readiness wait could outlive the very process it was waiting to signal,
// and the failure then came out wearing the FORWARDING message -- the confusion issue #207 existed to
// remove, arriving through a door it did not close (issue #221).
const STUB_LIFETIME_S = 30;
const READY_TIMEOUT_MS = (STUB_LIFETIME_S * 1000) / 3;

/**
 * The stub the signal tests run as their command: it backgrounds a sleep, arms a TERM trap that records
 * the delivery and kills the sleep, and only THEN writes `started`. Order is the point (issue #207) --
 * the marker means "ready to be signalled", not "has begun". One definition, because the tests now
 * reason about its lifetime and a literal typed twice is a lifetime that can drift.
 */
function signalStub() {
	return `#!/bin/sh\nsleep ${STUB_LIFETIME_S} &\nsp=$!\ntrap ': > "$MARKER_DIR/got-term"; kill "$sp" 2>/dev/null; exit 0' TERM\n: > "$MARKER_DIR/started"\nwait\nexit 1\n`;
}

/**
 * Poll for a marker file the wrapper's stub writes, and SAY whether it appeared (issue #207). The old
 * inline loop fell through on timeout and signalled anyway: on a loaded runner the TERM landed before
 * the stub had installed its trap, the stub died on the default disposition, and the resulting failure
 * was word-for-word identical to the wrapper simply not forwarding. Returning the answer lets the
 * caller assert the two apart. The bound is a ceiling on a hang, never a wait in the healthy case,
 * where the marker lands in tens of milliseconds.
 *
 * WALL CLOCK, not `waited += stepMs` (issue #221). The nominal count undercharged every iteration by
 * the existsSync plus the event-loop hop, so the bound it enforced was neither 30s nor knowable, and on
 * a loaded runner it drifted PAST the stub's own lifetime -- at which point the stub exits on its own,
 * the TERM lands on a dead child, and a readiness problem is reported as a forwarding failure.
 */
async function waitForMarker(path, timeoutMs = READY_TIMEOUT_MS, stepMs = 25) {
	const deadline = Date.now() + timeoutMs;
	do {
		if (existsSync(path)) return true;
		await new Promise((r) => setTimeout(r, stepMs));
	} while (Date.now() < deadline);
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
	const dir = wrapperDir(signalStub());
	let ready = false;
	const { code } = await runWrapper(dir, {
		onSpawn: async (child) => {
			// Signal only after the stub is definitely running, so the wrapper's trap is in place. When it
			// never gets there, KILL instead of signalling: a TERM sent into a stub that has not reached
			// its `trap` line tests nothing, and used to be reported as a forwarding failure (issue #207).
			// SIGKILL only ends the wrapper. It does NOT free the pipes: the stub's first line backgrounds
			// the sleep, so a stub caught between there and its `trap` is orphaned holding this spawn's
			// stdio, and `close` waits out the rest of STUB_LIFETIME_S (the comment here used to claim the
			// opposite). Bounded, and only on an already-failing path -- which is why the headroom is
			// bought by lowering READY_TIMEOUT_MS rather than by lengthening the stub.
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
	// The seam adds a `.` before the launch and must cost the drain nothing. This test carried no comment
	// at all until issue #221, which is part of why it was read as a duplicate of the one above: it is
	// not, it pins the SEAM's half, and the two failed on CI for the same reason a month apart. The
	// readiness protocol is the one at :928 -- see it for why `started` is written last.
	const dir = wrapperDir(signalStub());
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

// ---------------------------------------------------------------------------------------------------
// The STOP windows (issue #221). The wrapper accepted a stop and then went on as if it had not: TERM
// carried its DEFAULT disposition for the whole of the preparation (sourcing ./.env, then sourcing an
// operator's secrets manager), and after that a stop landing between the fork and the pid assignment was
// forwarded to nothing and never re-sent. The second one is what the two tests above kept failing on,
// once per CI runner under load, for a month. Everything here drives the SHIPPED wrapper under a real
// sh, except the last test, which says at length why it cannot.
// ---------------------------------------------------------------------------------------------------

// 600 x 0.05s. A hang bound, never a wait: the healthy path is released in tens of milliseconds. It sits
// inside STUB_LIFETIME_S on purpose, so a test that forgets to release fails on an assertion.
const HOLD_STEPS = 600;

/**
 * A shell body that ANNOUNCES it is running and then blocks until the test releases it. This is what
 * makes the stop-during-preparation tests exact rather than lucky: while the marker exists and `release`
 * does not, the wrapper is provably INSIDE the `.` that is reading this body, so a signal sent then
 * cannot land anywhere else. Nothing here is timed.
 */
function blockUntilReleased(marker = "sourcing") {
	return `: > "$MARKER_DIR/${marker}"\ni=0\nwhile [ ! -f "$MARKER_DIR/release" ] && [ "$i" -lt ${HOLD_STEPS} ]; do sleep 0.05; i=$((i+1)); done\n`;
}

/** A command stub that PROVES it ran. Used wherever the promise is "this must never start". */
const NEVER_RUNS = '#!/bin/sh\n: > "$MARKER_DIR/ran"\nexit 0\n';

test("wrapper: a stop arriving while PI_ENV_SETUP is sourced never launches the command", { skip: !POSIX }, async () => {
	// The production defect behind issue #221, on the path that can block for seconds: PI_ENV_SETUP is an
	// operator's secrets manager, so sourcing it is a network round trip (docs/secrets.md's own example
	// runs `infisical login` there). Before the fix TERM had its default disposition for all of it -- the
	// wrapper died where it stood, `code` null and `signal` SIGTERM, with nothing anywhere saying the
	// environment had been half-built. Reachable from this project's own CLI: `pi-dispatch service stop`
	// on macOS is `launchctl kill SIGTERM` at exactly this pid.
	const dir = wrapperDir(NEVER_RUNS);
	const setup = setupScript(dir, blockUntilReleased());
	let inSetup = false;
	const { code, signal, stderr } = await runWrapper(dir, {
		env: { PI_ENV_SETUP: setup },
		onSpawn: async (child) => {
			inSetup = await waitForMarker(join(dir, "sourcing"));
			if (inSetup) child.kill("SIGTERM");
			// Released AFTER the signal and UNCONDITIONALLY: a wrapper still in there must never hold the
			// suite, not even on the path where the readiness wait timed out.
			writeFileSync(join(dir, "release"), "");
		},
	});
	assert.ok(inSetup, "the setup script never announced itself: a readiness timeout, NOT a signal-handling failure");
	assert.equal(signal, null, "the wrapper was KILLED by the signal instead of handling it -- TERM still has its default disposition while the environment is being prepared");
	assert.equal(code, 0, "a stop the manager asked for is a clean stop, and 0 is the only code launchd's KeepAlive leaves stopped");
	assert.equal(existsSync(join(dir, "ran")), false, "the command started after a stop had already arrived -- that is a worker the manager believes it stopped");
	assert.match(stderr, /stopped before the worker started/);
	assert.match(stderr, /never launched/, "the exit 0 must say WHICH stop it is, rather than being indistinguishable from a clean run");
});

test("wrapper: the same holds while ./.env is sourced -- the trap is up before EITHER source", { skip: !POSIX }, async () => {
	// A separate test rather than a parameter, because it pins a different LINE: a fix that armed the trap
	// after ./.env and before the setup script would pass the test above and leave this one red. ./.env is
	// sourced too, so it runs arbitrary shell in this process, and a manager that RENDERS that file
	// (Recipe B in docs/secrets.md) can leave it mid-write under a slow template fetch.
	const dir = wrapperDir(NEVER_RUNS);
	writeFileSync(join(dir, ".env"), `PI_WRAPPER_TEST=1\n${blockUntilReleased()}`);
	let inEnv = false;
	const { code, signal, stderr } = await runWrapper(dir, {
		onSpawn: async (child) => {
			inEnv = await waitForMarker(join(dir, "sourcing"));
			if (inEnv) child.kill("SIGTERM");
			writeFileSync(join(dir, "release"), "");
		},
	});
	assert.ok(inEnv, "./.env never announced itself: a readiness timeout, NOT a signal-handling failure");
	assert.equal(signal, null, "the trap must be armed before ./.env, not merely before the setup script");
	assert.equal(code, 0);
	assert.equal(existsSync(join(dir, "ran")), false, "the command started after a stop had already arrived");
	assert.match(stderr, /stopped before the worker started/);
});

test("wrapper: a setup script that installs its OWN TERM trap does not cost the drain", { skip: !POSIX }, async () => {
	// `.` runs in THIS shell, so a `trap ... TERM` inside a setup script REPLACES the wrapper's handler and
	// the forward silently disappears. Plausible rather than exotic: a manager's cleanup helper does
	// exactly this. It only became reachable when the trap moved ABOVE the sourcing to close the window the
	// two tests above pin, so the one-line re-assert after the sourcing is what keeps the old property.
	// Mutation-checked: drop that line and this goes red with `hijacked` written, `got-term` absent and the
	// wrapper hanging for the stub's whole lifetime.
	const dir = wrapperDir(signalStub());
	const setup = setupScript(dir, `export FROM_MANAGER=1\ntrap ': > "$MARKER_DIR/hijacked"' TERM\n`);
	let ready = false;
	const { code } = await runWrapper(dir, {
		env: { PI_ENV_SETUP: setup },
		onSpawn: async (child) => {
			ready = await waitForMarker(join(dir, "started"));
			child.kill(ready ? "SIGTERM" : "SIGKILL");
		},
	});
	assert.ok(ready, "the stub never wrote its `started` marker: a readiness timeout, NOT a forwarding failure");
	assert.equal(existsSync(join(dir, "hijacked")), false, "the setup script's own handler ran instead of the wrapper's re-asserted one");
	assert.ok(existsSync(join(dir, "got-term")), "a trap left behind by a sourced script ate the stop");
	assert.equal(code, 0);
});

test("wrapper: a setup script that IGNORES TERM does not cost the drain either", { skip: !POSIX }, async () => {
	// The worse shape, and the reason the re-assert is not merely tidy. `trap '' TERM` leaves the signal
	// IGNORED, and a child forked from a shell where TERM is ignored inherits SIG_IGN -- its own `trap`
	// then becomes a no-op it cannot undo, and the drain is dead for the life of the process with nothing
	// in any log. Re-installing a real handler before the fork restores SIG_DFL for the child. Measured:
	// without the re-assert the stub never receives TERM at all and the wrapper waits out its full sleep.
	const dir = wrapperDir(signalStub());
	const setup = setupScript(dir, "export FROM_MANAGER=1\ntrap '' TERM\n");
	let ready = false;
	const { code } = await runWrapper(dir, {
		env: { PI_ENV_SETUP: setup },
		onSpawn: async (child) => {
			ready = await waitForMarker(join(dir, "started"));
			child.kill(ready ? "SIGTERM" : "SIGKILL");
		},
	});
	assert.ok(ready, "the stub never wrote its `started` marker: a readiness timeout, NOT a forwarding failure");
	assert.ok(existsSync(join(dir, "got-term")), "an ignored TERM was inherited by the child, which can no longer trap it");
	assert.equal(code, 0);
});

// ---------------------------------------------------------------------------------------------------
// The FORK WINDOW. Between `"$@" &` and `child=$!` a child exists and its pid does not, so a stop landing
// there ran the handler with nothing to forward to; the re-send after the assignment is what makes it
// harmless. The window is two instructions wide and cannot be scheduled from outside the shell, so this
// ONE test does not execute the shipped bytes, and says so.
//
// It DERIVES a copy from them by a single substitution -- an inert "announce, then block until the test
// says go" between those two lines -- and asserts that the substitution matched exactly once and changed
// nothing else. Built at test time from the real file and never checked in, so a wrapper edit that
// renames or reorders those lines fails HERE rather than leaving a stale shape under test.
//
// The alternatives were considered and are worse. A content pin proves a STRING is present and would
// survive `kill -TERM "$$"` in place of `kill -TERM "$child"`: a spelling check wearing a behaviour
// test's name. A repeat-until-you-hit-it stress test is a coin flip dressed as an assertion, green on
// nearly every iteration and red on a loaded runner for a reason nobody can reproduce, which is the exact
// class of test this issue exists to remove.
// ---------------------------------------------------------------------------------------------------

/** The two lines, adjacent, exactly as the wrapper spells them. The ADJACENCY is the window. */
const FORK_WINDOW = '"$@" &\nchild=$!\n';

function instrumentedWrapper(dir) {
	const real = readFileSync(REAL_WRAPPER, "utf8");
	assert.equal(
		real.split(FORK_WINDOW).length - 1,
		1,
		"deploy/worker-env-wrapper.sh no longer contains the fork window exactly once -- those two lines moved, were reordered or were respelled, so this test measures nothing until FORK_WINDOW follows them",
	);
	// Inert on purpose: no trap, no kill, no exit, nothing backgrounded (which would move `$!`), and no
	// variable the wrapper reads. It only holds, and it gives up on its own.
	const hold = blockUntilReleased("in-fork-window");
	const text = real.replace(FORK_WINDOW, `"$@" &\n${hold}child=$!\n`);
	assert.equal(text.replace(hold, ""), real, "the instrumented copy must differ from the shipped file by the inserted hold and nothing else");
	const path = join(dir, "instrumented-wrapper.sh");
	writeFileSync(path, text);
	return path;
}

test("wrapper: a stop landing in the fork window is re-sent once the pid is known", { skip: !POSIX }, async () => {
	const dir = wrapperDir(signalStub());
	const wrapper = instrumentedWrapper(dir);
	let inWindow = false;
	let stubReady = false;
	const { code } = await runWrapper(dir, {
		wrapper,
		onSpawn: async (child) => {
			// BOTH facts, because either alone is a different test. `in-fork-window` says the wrapper is
			// between the fork and the assignment; `started` says the stub has its own trap up, without
			// which a delivered TERM would kill it on the default disposition and the failure would wear
			// the forwarding message again (issue #207's shape, one layer down).
			inWindow = await waitForMarker(join(dir, "in-fork-window"));
			stubReady = await waitForMarker(join(dir, "started"));
			if (inWindow && stubReady) child.kill("SIGTERM");
			// A fact about the window, not a settle: the stub can only be signalled BY the wrapper, and the
			// wrapper has no pid to signal with yet.
			assert.equal(existsSync(join(dir, "got-term")), false, "the handler forwarded during the window -- it had no pid, so the signal reached the stub some other way");
			writeFileSync(join(dir, "release"), "");
		},
	});
	assert.ok(inWindow && stubReady, "the instrumented wrapper or the stub never announced itself: a readiness timeout, NOT a forwarding failure");
	assert.ok(
		existsSync(join(dir, "got-term")),
		"the stop was dropped: the handler fired with $child unset and nothing re-sent it after `child=$!`, so the wrapper is waiting out the command's whole natural lifetime while the manager believes it asked it to stop",
	);
	assert.equal(code, 0, "the wrapper reports the command's post-drain exit code");
});

// ---------------------------------------------------------------------------------------------------
// Two pins on the HARNESS itself. Both defects below were live in this file while issue #221 was being
// diagnosed, and both make the harness LIE about a signal test rather than fail one -- which is how the
// same drop got misdiagnosed twice. A harness nothing checks is how they survived.
// ---------------------------------------------------------------------------------------------------

test("runWrapper waits for onSpawn as well as close, so an early-exiting wrapper cannot beat its own callback", { skip: !POSIX }, async () => {
	// The wrapper now exits early BY DESIGN when a stop arrives during startup, and `onSpawn` is where
	// every signal test assigns its readiness fact. Resolving on `close` alone let the exit win the race:
	// the assertion then ran against the initial `false` and reported "a readiness timeout, NOT a
	// forwarding failure" -- a diagnosis of something that never happened, printed in the one place a real
	// one was needed. The release below is written FROM the close handler, so it can only land after the
	// wrapper has exited: with the fix this reads true, without it the promise has already resolved.
	const dir = wrapperDir("#!/bin/sh\nexit 0\n");
	let settledAfterClose = false;
	await runWrapper(dir, {
		onSpawn: async (child) => {
			child.on("close", () => writeFileSync(join(dir, "release"), ""));
			settledAfterClose = await waitForMarker(join(dir, "release"));
		},
	});
	assert.ok(settledAfterClose, "runWrapper resolved before onSpawn finished, so a test reading a value it assigns would read the initial one");
});

test("the readiness ceiling stays well inside the stub's own lifetime", { skip: !POSIX }, () => {
	// The pair that produced issue #221's misreport: a 30s readiness bound against a 30s stub, no headroom.
	// Let the wait outlive the stub and the stub exits on its own, the TERM lands on a dead child, and a
	// READINESS problem is reported with the FORWARDING message -- exactly what issue #207 set out to make
	// impossible. An arithmetic pin rather than a timing one, so it costs nothing and cannot flake.
	assert.ok(
		READY_TIMEOUT_MS * 2 <= STUB_LIFETIME_S * 1000,
		`READY_TIMEOUT_MS (${READY_TIMEOUT_MS}) must leave the stub's ${STUB_LIFETIME_S}s lifetime real headroom: a readiness wait that can outlive the process it is waiting to signal reports the wrong failure`,
	);
});
