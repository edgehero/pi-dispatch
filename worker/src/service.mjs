/**
 * `pi-dispatch service` — render and install the deploy/ daemon templates for THIS host (issue #80).
 *
 * Durable running used to mean hand-editing the per-OS examples in deploy/. This module reads those
 * SAME files from the package and substitutes a documented table of their known literals —
 * `/usr/bin/node` → `process.execPath`, `/opt/pi-dispatch` → the deployment folder — rather than
 * introducing a `{{placeholder}}` dialect. That keeps the deploy/ files byte-usable examples (and
 * deploy-lint keeps parsing exactly what ships); TEMPLATE_PINS below is the table's enforcement — the
 * test suite asserts every literal is still present in every template, so template drift breaks the
 * build loudly instead of breaking the render silently.
 *
 * Path doctrine (issue #96): this module used to derive a REPO_ROOT from its own location ("../..").
 * Right in a checkout; WRONG under `npm install`, where src/ lives at
 * node_modules/@edgehero/pi-dispatch/src and "../.." is the @edgehero SCOPE directory — every rendered
 * unit pointed at files that do not exist. Three anchors replace it, each correct in BOTH layouts:
 *   - deployDir     the deployment folder = the cwd `service` is invoked from. Owns everything
 *                   host-side: WorkingDirectory, EnvironmentFile (<deployDir>/.env) and the daemon
 *                   logs (<deployDir>/logs/, created at install time) — never the package dir, which
 *                   npm may replace wholesale on update.
 *   - cliPath       join(moduleDir, "cli.mjs"): cli.mjs sits beside this module in src/ in both
 *                   layouts, so the worker ExecStart needs no repo root at all.
 *   - receiverStart import.meta.resolve("@edgehero/pi-dispatch-receiver/start"): the receiver
 *                   package's own exported entry, wherever npm (or the workspace symlink) put it.
 *                   null when the package is not installed — receiver renders refuse loudly instead
 *                   of writing a unit that would crash-loop at boot.
 *
 * Scope doctrine:
 *   - User-level by default, everywhere. macOS REFUSES root outright (a LaunchAgent is per-user, and a
 *     root agent could not see the login session's Docker Desktop anyway — the svc.sh precedent).
 *     Linux `--system` never executes a privileged write: it stages the render and PRINTS the exact
 *     sudo commands (the pm2-startup pattern), so root actions only ever happen in the operator's own
 *     shell.
 *   - ONE worker per docker daemon (DES-CONCURRENCY-3): install refuses a worker unit when one exists
 *     in the OTHER scope, because the worker's boot reaper kills every pi-job container it did not
 *     start — a second worker would reap the first's live jobs on every restart. Receivers are exempt
 *     from the cross-scope check (a second receiver is pointless, not destructive) but still refuse
 *     same-scope duplicates.
 *
 * `restart --drain` composes the README's manual ritual (pause → poll active → restart → resume) with
 * the same VALKEY_URL-only queue connection as cli.mjs's pause/resume: the drain must work even when
 * the rest of the config is broken.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { connect as netConnect } from "node:net";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parseBackendList, venuesOf } from "./backends.mjs";
import { egressArmed, egressProxyName } from "./egress.mjs";
import { ALL_QUADLET_FILES, ALLOWLIST_PLACEHOLDER, NETNS_KEEPER, NETNS_KEEPER_FORMAT, judgeNetnsKeeper, keeperUnderRunningProxyHint, managerEnvRefusal, PROXY_CONF_PLACEHOLDER, QUADLET_FILES, applyStack, describeAction, foreignContainerRefusal, foreignContainers, lingerNote, planStack, proxyConfCopyPath, proxyRestartWarning, quadletDir, readLinger, readStackKeys, stackComponents, unknownContainerRefusal, userBusRefusal, workerUnitDeps } from "./podman-stack.mjs";

// src/ is where this module lives in BOTH layouts (worker/src in a checkout,
// node_modules/@edgehero/pi-dispatch/src under npm). Deploy templates resolve one level up from it
// (the init.mjs pattern): worker/deploy is SHIPPED in the npm tarball and kept byte-identical to the
// repo-root deploy/ (the documented source) by worker/test/publish.test.mjs — so `service` renders
// the same templates from a checkout and from an npm install, no matter where the CLI is invoked from.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * The receiver's entry point comes from the receiver PACKAGE (its ./start export), wherever module
 * resolution finds it from here — the workspace symlink in a checkout, the sibling install under the
 * deployment folder's node_modules in production. Never a path guessed off this module: that guess is
 * exactly what issue #96 is about. null = not installed, and the receiver renders refuse on it.
 */
function resolveReceiverStart() {
	try {
		return fileURLToPath(import.meta.resolve("@edgehero/pi-dispatch-receiver/start"));
	} catch {
		return null;
	}
}

/**
 * The whole substitution surface, template by template. The render replaces ONLY these literals (plus
 * the scope-dependent `User=` / `WantedBy=` rewrites called out below); the pin test in
 * worker/test/service.test.mjs asserts each one is still present in the real deploy/ file, so an edit
 * to a template that would break the render fails the build instead of shipping a broken `service`.
 */
// The two worker-template literals a podman render rewrites (issue #430), spelled once for the pin table and the render.
const WORKER_DESCRIPTION = "Description=pi-dispatch worker (drains the job queue on the host; launches job containers via docker)";
const WORKER_VALKEY_COMMENT = "# Valkey must be reachable (docker compose -f deploy/docker-compose.yml up -d), but it is a separate\n# unit/container -- not ordered here since it may be remote.\n";

export const TEMPLATE_PINS = {
	"worker.service": [
		"ExecStart=/usr/bin/node worker/src/cli.mjs worker", // the WHOLE line → `<execPath> <cliPath> worker` (cli.mjs sits beside this module in src/ in both layouts)
		"WorkingDirectory=/opt/pi-dispatch", // /opt/pi-dispatch → the deployment folder (the cwd `service` runs from)
		"EnvironmentFile=/opt/pi-dispatch/.env", // → <deployDir>/.env — the operator's .env lives beside the units, never inside the package
		"\nUser=pi\n", // the DIRECTIVE line (the header comment also says User=pi mid-line, hence the \n anchors): stripped for --user scope; rewritten to the invoking user for --system
		"WantedBy=multi-user.target", // → default.target in user scope (multi-user.target never runs there)
		"\nWants=network-online.target\n", // the anchor the podman venue's Wants=/After= on its Quadlet units go after (issue #430), user scope only
		"Description=pi-dispatch worker (drains the job queue on the host; launches job containers via docker)", // → names rootless podman on a podman deployment (issue #430)
		"# Valkey must be reachable (docker compose -f deploy/docker-compose.yml up -d), but it is a separate\n# unit/container -- not ordered here since it may be remote.\n", // → says it IS ordered, when the Quadlet Valkey is installed
		// Byte-for-byte survivors — semantics the render must not lose:
		"RestartPreventExitStatus=2", // EXIT_POLICY is never restarted (a retry loop is a bill)
		"StartLimitIntervalSec=60",
		"StartLimitBurst=5",
		"KillSignal=SIGTERM",
		"TimeoutStopSec=30",
	],
	"receiver.service": [
		"ExecStart=/usr/bin/node receiver/src/start.mjs", // the WHOLE line → `<execPath> <receiverStart>` (the receiver package's resolved ./start export)
		"WorkingDirectory=/opt/pi-dispatch",
		"EnvironmentFile=/opt/pi-dispatch/.env",
		"\nUser=pi\n",
		"WantedBy=multi-user.target",
		// Byte-for-byte survivors — semantics the render must not lose, matching worker.service's list
		// above. Added with #187: the receiver had none of the three, so any config it could not parse
		// produced an unbounded five-second restart loop, and `service install` rendering them away would
		// put that back on a deployment that had just been fixed.
		"RestartPreventExitStatus=2", // EXIT_POLICY is never restarted (the next start reads the same bad file)
		"StartLimitIntervalSec=60",
		"StartLimitBurst=5",
		"KillSignal=SIGTERM",
		"TimeoutStopSec=30",
	],
	"com.pi-dispatch.worker.plist": [
		"<string>com.pi-dispatch.worker</string>", // → com.pi-dispatch.receiver for --receiver
		"<string>/opt/pi-dispatch/deploy/worker-env-wrapper.sh</string>", // → the PACKAGE's wrapper copy, followed by the exec argv (<node> <script> …) the wrapper now runs verbatim
		"<key>WorkingDirectory</key>\n\t<string>/opt/pi-dispatch</string>", // → the deployment folder (load-bearing: the wrapper sources ./.env there); also the anchor for the PATH injection below
		"<string>/opt/pi-dispatch/logs/worker.out.log</string>", // → <deployDir>/logs/… (install creates the dir; launchd will not)
		"<string>/opt/pi-dispatch/logs/worker.err.log</string>",
		"<key>SuccessfulExit</key>", // the KeepAlive shape the wrapper's exit-2 conversion pairs with
		"<integer>30</integer>", // ExitTimeOut — room for the SIGTERM drain
	],
	// Windows is command-driven, not file-rendered: install SPAWNS nssmSequence() below instead of
	// copying the .cmd. These pins hold the worked example to the same values the sequence uses, so
	// the two cannot drift apart — especially the AppExit pair, which is the EXIT_POLICY never-retry.
	"nssm-install.cmd": [
		"pi-dispatch-worker",
		"C:\\pi-dispatch", // the REPO placeholder → the deployment folder (cwd)
		"deploy\\worker-env-wrapper.cmd", // the sequence points at the PACKAGE's wrapper copy and passes the exec argv behind it
		"AppStopMethodConsole 15000",
		"AppThrottle 5000",
		"AppExit Default Restart",
		"AppExit 2 Exit",
	],
	// The wrappers are COPIED, never substituted, so they have no substitution surface of their own.
	// They are pinned anyway for the same reason nssm-install.cmd is: the render EMITS the variable name
	// they read back (`--env-setup`, issue #209 — the plist's EnvironmentVariables dict on macOS, nssm's
	// AppEnvironmentExtra on Windows), and a rename on one side with silence on the other would produce
	// a unit that starts fine and ignores the operator's secrets manager.
	"worker-env-wrapper.sh": ["PI_ENV_SETUP"],
	"worker-env-wrapper.cmd": ["PI_ENV_SETUP"],
	// The podman venue's stack as Quadlet units (issue #430, podman-stack.mjs). Three are copied verbatim, so what is
	// pinned is what the worker and the installer rely on by NAME: the container and network names the worker attaches
	// by, the unit names the worker unit Wants=, the loopback-only port, and an explicit Network= in every .container
	// (a containers.conf `netns = "host"` would otherwise put it in the host namespace, measured).
	"pi-dispatch-valkey.network": ["NetworkName=pi-dispatch-valkey"],
	"pi-dispatch-valkey.container": [
		"ContainerName=pi-dispatch-valkey",
		"Network=pi-dispatch-valkey.network",
		"PublishPort=127.0.0.1:6379:6379",
		"Volume=pi-dispatch-valkey-data:/data",
		"Exec=valkey-server --appendonly yes",
		"WantedBy=default.target",
	],
	"pi-dispatch-egress-out.network": ["NetworkName=pi-dispatch-egress-out"],
	"pi-dispatch-egress-proxy.container": [
		`Volume=${PROXY_CONF_PLACEHOLDER}:/etc/squid/squid.conf:ro,z`, // → the account-owned COPY of the package's egress-proxy.conf (~/.config/pi-dispatch/egress-proxy.conf, podman-stack.mjs proxyConfCopyPath), because `z` cannot relabel a root-owned package file (measured)
		`Volume=${ALLOWLIST_PLACEHOLDER}:/etc/pi-dispatch/allowlist.conf:ro,z`, // → <deployDir>/egress-allowlist.conf, the list `init` scaffolds
		"ContainerName=pi-dispatch-egress-proxy",
		"Network=pi-dispatch-egress-out.network",
		"WantedBy=default.target",
	],
	// The rootless network keeper (issue #458), copied verbatim. Pinned: the names (outside every sweep's prefix, and
	// what doctor reads), its own network with no route and no DNS, and every line that keeps it from widening anything
	// (podman-stack.test.mjs reads the same lines back as the argv they generate).
	"pi-dispatch-netns-keeper.network": ["NetworkName=pi-dispatch-netns-keeper", "Internal=true", "DisableDNS=true"],
	"pi-dispatch-netns-keeper.container": [
		"ContainerName=pi-dispatch-netns-keeper",
		"Network=pi-dispatch-netns-keeper.network",
		"ReadOnly=true",
		"DropCapability=all",
		"NoNewPrivileges=true",
		"User=65534",
		"Group=65534",
		"RunInit=true",
		"ExecStartPre=/usr/bin/podman network create --ignore --disable-dns --internal pi-dispatch-netns-keeper",
		"Restart=always",
		"RestartSec=1s",
		"StartLimitIntervalSec=0",
		"SuccessExitStatus=143",
		"WantedBy=default.target",
	],
};

/**
 * The env-setup seam (issue #209): an operator-typed path to their OWN script, sourced before the
 * worker starts, so a secrets manager can put the provider key and the forge token into the process
 * environment without anyone hand-editing a rendered unit. The renderer owns the `exec` that follows
 * it, which is the whole point — the hand-edit an operator naturally reaches for (`<manager> run -- …`)
 * reports the CHILD's exit 2 as 1, and exit 2 is the determinate policy refusal that
 * RestartPreventExitStatus=2, nssm's `AppExit 2 Exit` and the wrapper's exit-2 conversion all key on.
 *
 * A PATH and not a command, deliberately. systemd expands `$…`/`${…}` inside Exec lines whatever the
 * quoting, a plist is XML, and nssm's argv is neither, so an inline command would need three separate
 * escaping stories — and it is the shape docs/secrets.md already tells operators not to write.
 *
 * Absolute, and never resolved against anything: `.` in POSIX sh SEARCHES $PATH for an operand with no
 * slash in it, so a relative path here would be a different file depending on the service manager's
 * environment. Refuse rather than guess.
 *
 * The refused characters are per platform because the constraint is: on Linux the path lands inside a
 * systemd Exec word (which owns `$`, `"` and `\`), on macOS inside a plist <string> (XML), and on
 * Windows inside an nssm NAME=VALUE that cmd expands with `%`. Spaces are fine everywhere: every
 * composed form quotes.
 */
const ENV_SETUP_REFUSALS = {
	linux: { re: /['"$\\\x00-\x1f\x7f]/, why: "the path lands inside a single-quoted systemd Exec word, and systemd expands $VAR there whatever the quoting" },
	darwin: { re: /[<>&"\x00-\x1f\x7f]/, why: "the launchd unit is a plist, and the path lands in an XML <string>" },
	win32: { re: /[%"\x00-\x1f\x7f]/, why: "cmd expands %VAR% when the wrapper runs the script" },
};

function resolveEnvSetup(ctx, raw) {
	const path = String(raw);
	const absolute = ctx.platform === "win32" ? /^([A-Za-z]:[\\/]|\\\\)/.test(path) : path.startsWith("/");
	if (!absolute) {
		return { error: `--env-setup needs an ABSOLUTE path, got: ${path}\nPOSIX \`.\` searches $PATH for an operand with no slash in it, and a service manager's environment is not your shell's, so a relative path here is a different file on every host.` };
	}
	const { re, why } = ENV_SETUP_REFUSALS[ctx.platform];
	const hit = re.exec(path);
	if (hit) {
		const shown = hit[0].charCodeAt(0) < 0x20 || hit[0].charCodeAt(0) === 0x7f ? `\\x${hit[0].charCodeAt(0).toString(16).padStart(2, "0")}` : hit[0];
		return { error: `--env-setup path contains ${JSON.stringify(shown)}, which cannot be rendered safely on ${ctx.platform}: ${why}. Move the script somewhere without it: ${path}` };
	}
	if (!ctx.fs.existsSync(path)) {
		return { error: `--env-setup script not found: ${path}\nRefusing rather than rendering: a unit pointing at a script that is not there installs cleanly and then fails at every boot.` };
	}
	return { path };
}

/**
 * The read side of the same seam (issue #216). `--env-setup` is a RENDER-TIME flag: once the unit is
 * written, the unit is the only record of the path, so a preflight that wants to check the script has
 * to read it back out of the file that actually boots. These patterns match exactly what
 * composeEnvSetupExec and renderPlist emit, and they live here beside ENV_SETUP_REFUSALS so the writer
 * and the reader cannot drift apart unnoticed — worker/test/service.test.mjs round-trips every render
 * through readUnitSeam, so changing one half without the other turns the suite red.
 *
 * The capture classes are exact rather than lazy because ENV_SETUP_REFUSALS already guarantees what
 * cannot be in the path: no `"` on any platform, so `[^"]*` ends where the renderer's quote does, and
 * no `<`/`>`/`&` on macOS, so a plist <string> can never hold an XML entity to decode.
 *
 * win32 is not a file at all — the value comes back from `nssm get <service> AppEnvironmentExtra`,
 * which some nssm builds write as UTF-16, hence the NUL strip in readUnitSeam.
 */
const ENV_SETUP_READERS = {
	linux: {
		setup: /^ExecStart=\/bin\/sh -c 'set -a; \. "([^"]*)" \|\| exit 1;/m,
		deployDir: /^WorkingDirectory=(.*)$/m,
	},
	darwin: {
		setup: /<key>PI_ENV_SETUP<\/key>\s*<string>([^<]*)<\/string>/,
		deployDir: /<key>WorkingDirectory<\/key>\s*<string>([^<]*)<\/string>/,
	},
	win32: {
		setup: /^PI_ENV_SETUP=(.*)$/m,
		// nssm holds the deployment folder in a SEPARATE property (AppDirectory), and there is only one
		// machine-scoped service per name to confuse it with — so the caller matches on nothing here
		// rather than spending a second `nssm get` to answer a question Windows cannot ask twice.
		deployDir: null,
	},
};

/**
 * What an installed unit records: the configured `--env-setup` path and the deployment folder it
 * serves. Both null for a unit rendered without the flag, which is every unit that predates issue #209
 * and every default render since. Never throws: an unreadable, truncated or hand-rewritten unit simply
 * reads as "no seam configured", because a preflight guessing at a shape it does not recognise is
 * worse than one that says nothing.
 */
export function readUnitSeam(text, platform) {
	const readers = ENV_SETUP_READERS[platform];
	if (!readers || typeof text !== "string") return { setup: null, deployDir: null };
	const clean = text.replace(/\0/g, "");
	const grab = (re) => (re ? (re.exec(clean)?.[1] ?? null) : null);
	// Only a trailing CR is stripped, never surrounding whitespace: on the quoted and XML forms the
	// capture already ends exactly where the renderer's delimiter does, and a path is allowed to hold a
	// space anywhere in it. An empty value means the same as no value at all.
	const clip = (v) => (v === null ? null : v.replace(/\r$/, "") || null);
	return { setup: clip(grab(readers.setup)), deployDir: clip(grab(readers.deployDir)) };
}

/**
 * The account a SYSTEM unit runs the worker as (`User=`), or `null` when it names none (issue #341). Only systemd has
 * one: a user-scope unit, a launchd agent and an nssm service run as whoever installed them. Separate from
 * `readUnitSeam` because it is not part of the render round trip (a `--system` render writes the invoking user, a
 * `--user` render strips the line). Read as systemd does: whitespace around `=` allowed, and the LAST assignment wins.
 */
export function readUnitUser(text, platform) {
	if (platform !== "linux" || typeof text !== "string") return null;
	const hits = [...text.replace(/\0/g, "").matchAll(/^[ \t]*User[ \t]*=[ \t]*(.*?)[ \t]*\r?$/gm)];
	const value = hits.at(-1)?.[1];
	return value ? value : null;
}

const SUBCOMMANDS = new Set(["render", "install", "uninstall", "status", "start", "stop", "restart"]);

const SERVICE_USAGE = `pi-dispatch service — run the worker (or --receiver) as an OS service, rendered for THIS host

  pi-dispatch service render                the unit(s) with this host's real node + repo paths
  pi-dispatch service install [--force]     write + enable the user-level unit
                                            (linux --system: prints the exact sudo commands, runs nothing)
  pi-dispatch service uninstall             stop, disable and remove the installed unit
  pi-dispatch service status                which unit exists in which scope, and whether it is active
  pi-dispatch service start|stop            thin launchctl / systemctl --user / nssm wrappers
  pi-dispatch service restart [--drain]     restart; --drain pauses the queue, waits for active jobs
                                            to finish, restarts, resumes  [--drain-timeout <s>, default 600]

  flags: --receiver          the webhook receiver instead of the worker
         --user | --system   linux scope (default --user; --system never executes root commands)
         --force             replace an existing unit in the same scope
         --print             also print the rendered unit before installing
         --env-setup <path>  render|install: source YOUR script before the worker starts, so a secrets
                             manager fills the environment. Absolute path, env only (no exec, no paths):
                             the render owns the exec, so a policy refusal still exits 2. docs/secrets.md
`;

export async function runService(argv = [], deps = {}) {
	const {
		env = process.env,
		platform = process.platform,
		euid = typeof process.geteuid === "function" ? process.geteuid() : null,
		execPath = process.execPath,
		// The deployment folder: where the operator ran `service`, where .env lives, where logs/ goes.
		cwd = process.cwd(),
		// Injectable so tests can render as if from an npm install without installing anything.
		moduleDir = MODULE_DIR,
		resolveReceiver = resolveReceiverStart,
		home = homedir(),
		// env-internal USER: whose account a rendered unit runs as, taken from the login already running
		// this command. An operator changes it by running the command as someone else, not by declaring it.
		user = env.USER || userInfo().username,
		tmp = tmpdir(),
		fs = { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync },
		spawn = nodeSpawn,
		out = (s) => process.stdout.write(s),
		err = (s) => process.stderr.write(s),
		sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
		now = () => Date.now(),
		queue = null, // test seam; production builds one lazily in doRestart from VALKEY_URL
		// Is anything on 127.0.0.1:6379? Asked only on a podman deployment, to decide whether the Quadlet Valkey is
		// wanted (issue #430); the same plain TCP connect `up` uses, for up's reason.
		probeTcp = defaultProbeTcp,
		// PR #463: how a path resolves through symlinks, for the manager-environment rule (a symlinked home).
		realpath = (p) => realpathSync(p),
	} = deps;

	let values, positionals;
	try {
		({ values, positionals } = parseArgs({
			args: argv,
			allowPositionals: true,
			options: {
				receiver: { type: "boolean", default: false },
				user: { type: "boolean", default: false },
				system: { type: "boolean", default: false },
				force: { type: "boolean", default: false },
				print: { type: "boolean", default: false },
				drain: { type: "boolean", default: false },
				"drain-timeout": { type: "string" },
				"env-setup": { type: "string" },
			},
		}));
	} catch (error) {
		return fail(err, error.message);
	}

	const cmd = positionals[0];
	if (!cmd || !SUBCOMMANDS.has(cmd)) {
		out(SERVICE_USAGE);
		return cmd ? 1 : 0; // bare `service` is a usage view, an unknown subcommand is an error
	}
	if (values.user && values.system) return fail(err, "--user and --system are mutually exclusive");
	if (platform === "darwin" && values.system) {
		return fail(err, "macOS is user-scope only (a LaunchAgent): Docker Desktop lives in the login session, so a system daemon would wait on a docker socket that only exists once you log in. Drop --system.");
	}
	if (platform === "win32" && (values.user || values.system)) {
		return fail(err, "Windows services via nssm are machine-scoped; --user/--system do not apply here");
	}
	if (!["darwin", "linux", "win32"].includes(platform)) return fail(err, `unsupported platform: ${platform}`);

	// The templates dir is module-relative like moduleDir itself: worker/deploy in a checkout,
	// <pkg>/deploy under npm — the SHIPPED copies, correct in both layouts (unlike the old repo root).
	const templatesDir = resolve(moduleDir, "..", "deploy");
	const ctx = {
		env,
		platform,
		euid,
		execPath,
		deployDir: cwd,
		cliPath: join(moduleDir, "cli.mjs"),
		templatesDir,
		wrapperSh: join(templatesDir, "worker-env-wrapper.sh"),
		wrapperCmd: join(templatesDir, "worker-env-wrapper.cmd"),
		// Resolved only when asked for: worker-only invocations must not care whether the receiver
		// package exists here at all.
		receiverStart: values.receiver ? resolveReceiver() : null,
		home,
		user,
		tmp,
		fs,
		spawn,
		out,
		err,
		sleep,
		now,
		queue,
		probeTcp,
		realpath,
		which: values.receiver ? "receiver" : "worker",
		scope: platform === "linux" && values.system ? "system" : "user",
		force: values.force,
		// The operator's env-setup script, or null for the shipped default. Null is load-bearing: with no
		// seam configured every render below is byte-identical to what it produced before issue #209.
		envSetup: null,
	};

	if (values["env-setup"] !== undefined) {
		// Only the two subcommands that COMPOSE a command line can honour it. Ignoring the flag on the
		// others would be the silent no-op this project refuses on principle: an operator who typed it on
		// `restart` would believe the seam was in place.
		if (cmd !== "render" && cmd !== "install") {
			return fail(err, `--env-setup applies to \`service render\` and \`service install\`, which compose the command the unit runs; \`service ${cmd}\` renders nothing. Re-render (or re-install --force) to change it.`);
		}
		const resolved = resolveEnvSetup(ctx, values["env-setup"]);
		if (resolved.error) return fail(err, resolved.error);
		ctx.envSetup = resolved.path;
	}

	switch (cmd) {
		case "render":
			return doRender(ctx);
		case "install":
			// --print is implied for render and opt-in here: see what will be written, then write it.
			if (values.print) await doRender(ctx);
			return doInstall(ctx);
		case "uninstall":
			return doUninstall(ctx);
		case "status":
			return doStatus(ctx);
		case "start":
			return doStart(ctx);
		case "stop":
			return doStop(ctx);
		case "restart":
			return doRestart(ctx, values);
	}
}

/**
 * Where each unit lives (or is looked for) per platform. `otherScopeWorkerPaths` exists only to
 * enforce DES-CONCURRENCY-3 at install time — those locations are READ, never written. On Linux the
 * system-scope check covers both our canonical name and `worker.service`, the name the README's
 * manual `sudo cp` instructions produce: a hand-installed worker is still a second worker.
 */
function unitPaths(ctx) {
	if (ctx.platform === "darwin") {
		const label = `com.pi-dispatch.${ctx.which}`;
		return {
			name: label,
			installPath: join(ctx.home, "Library", "LaunchAgents", `${label}.plist`),
			systemPath: join("/Library/LaunchDaemons", `${label}.plist`),
			otherScopeWorkerPaths: ["/Library/LaunchDaemons/com.pi-dispatch.worker.plist"],
		};
	}
	if (ctx.platform === "linux") {
		const unit = `pi-dispatch-${ctx.which}.service`;
		const userPath = join(ctx.home, ".config", "systemd", "user", unit);
		const systemPath = join("/etc/systemd/system", unit);
		return {
			name: unit,
			userPath,
			systemPath,
			installPath: ctx.scope === "system" ? systemPath : userPath,
			otherScopeWorkerPaths:
				ctx.scope === "system"
					? [join(ctx.home, ".config", "systemd", "user", "pi-dispatch-worker.service")]
					: ["/etc/systemd/system/pi-dispatch-worker.service", "/etc/systemd/system/worker.service"],
		};
	}
	// win32: the unit is an nssm-registered service, not a file this tool addresses. Same-scope
	// detection happens via `nssm status`, and there is no second scope to cross-check.
	return { name: `pi-dispatch-${ctx.which}` };
}

/**
 * Every unit FILE this tool could have installed on this host: both daemons, both scopes, plus the
 * `worker.service` name the README's manual `sudo cp` instructions produce (doStatus already counts
 * that one as a real worker unit, so a preflight reading units must too). Derived from unitPaths
 * rather than restated, so the two cannot disagree about where a unit lives.
 *
 * Empty on win32 by construction: there is no file to read there, only `nssm get`.
 */
export function installedUnitPaths(platform, home) {
	if (platform !== "linux" && platform !== "darwin") return [];
	const found = [];
	for (const which of ["worker", "receiver"]) {
		const paths = unitPaths({ platform, home, which, scope: "user" });
		found.push({ which, scope: "user", path: platform === "linux" ? paths.userPath : paths.installPath });
		found.push({ which, scope: "system", path: paths.systemPath });
		if (platform === "linux" && which === "worker") found.push({ which, scope: "system", path: "/etc/systemd/system/worker.service" });
	}
	return found;
}

function readTemplate(ctx, name) {
	return ctx.fs.readFileSync(join(ctx.templatesDir, name), "utf8");
}

/**
 * The per-host path substitutions, applied to a TEMPLATE and never to anything a render composed.
 * /opt/pi-dispatch becomes the deployment folder (the cwd this render ran from): WorkingDirectory and
 * EnvironmentFile stay operator territory, never the package dir npm may wipe on update.
 *
 * The ordering matters and used to be wrong. A composed value is already absolute for THIS host, so
 * putting it through these rewrites a path the operator typed rather than a placeholder the template
 * shipped — and an `--env-setup /opt/pi-dispatch/setup-env.sh` on a deployment at /srv/pi-deploy became
 * `. "/srv/pi-deploy/setup-env.sh"`, a file resolveEnvSetup never checked, while the banner above it
 * still named the one that was typed. Substitute first, compose second, and anchor on the substituted
 * form.
 */
function subDeployDir(ctx, text) {
	// Function replacement, here and everywhere below a computed path is the REPLACEMENT: String.replace
	// and replaceAll both read `$&` and its relatives out of a replacement STRING, so a deployment folder
	// holding one would splice itself into the unit. A function replacement is taken literally.
	return text.replaceAll("/opt/pi-dispatch", () => ctx.deployDir);
}

/**
 * subDeployDir plus the systemd unit's node: the shipped `/usr/bin/node` literal does not exist on an
 * nvm host. The PLIST deliberately gets only subDeployDir — its header comment SHOWS
 * `<string>/usr/bin/node</string>` as the argv an operator would append by hand, and that prose is
 * meant to keep reading as an example rather than silently becoming this host's node.
 */
function subUnitPaths(ctx, text) {
	return subDeployDir(ctx, text).replaceAll("/usr/bin/node", () => ctx.execPath);
}

/**
 * The receiver refusal, shared by render and install: a null receiverStart means the receiver package
 * is not resolvable from this worker install. Refusing beats rendering — a unit pointing at a
 * nonexistent start.mjs would install cleanly and then crash-loop at boot, which is exactly the failure
 * mode issue #96 shipped for every path.
 */
function refuseMissingReceiver(ctx) {
	return fail(
		ctx.err,
		"the receiver package is not installed here — run: npm install @edgehero/pi-dispatch-receiver (from the deployment folder)",
	);
}

/**
 * The systemd form of the env-setup seam. Three pieces, each load-bearing:
 *
 *   - `exec` keeps systemd watching the WORKER and not a shell in front of it, so an exit 2 arrives as
 *     an exit 2 and RestartPreventExitStatus=2 still sees a real policy refusal. This is the whole
 *     reason the renderer owns this line instead of leaving it to a hand-edit.
 *   - `|| exit 1` maps a failed setup (an expired token, an unreachable manager) onto the
 *     infrastructure code, so systemd retries it under Restart=on-failure inside the StartLimit bound,
 *     and it can never be mistaken for the determinate refusal that must stay stopped. A setup script
 *     that calls `exit 2` ITSELF still exits 2 — sourcing cannot intercept that — which is why
 *     docs/secrets.md tells operators not to.
 *   - `set -a` exports a bare KEY=value, exactly as EnvironmentFile= does, so the seam accepts both an
 *     `export`-style script and raw dotenv output. EnvironmentFile= is untouched and still read first;
 *     this runs after it, so the manager wins over a stale value left in the file.
 *
 * The whole sh script is ONE single-quoted systemd word, which is why resolveEnvSetup refuses a single
 * quote in the path (it would end the word) and a `$` (systemd expands those inside Exec lines whatever
 * the quoting). The inner double quotes are sh's, and they are what makes a path with spaces work.
 * Verified against systemd 252: `systemctl show -p ExecStart` reports argv[] as /bin/sh, -c, and the
 * whole script as one word, and a worker exiting 2 under it reports ExecMainStatus=2 with NRestarts=0.
 */
function composeEnvSetupExec(setup, argv) {
	const command = argv.map((a) => `"${a}"`).join(" ");
	return `/bin/sh -c 'set -a; . "${setup}" || exit 1; set +a; exec ${command}'`;
}

/**
 * Render worker.service / receiver.service for this host. Targeted substitution of the templates'
 * known literals (see TEMPLATE_PINS); everything else — RestartPreventExitStatus=2, the StartLimit
 * crash-loop bound, KillSignal, TimeoutStopSec — passes through byte-for-byte.
 */
function renderLinuxUnit(ctx, stackUnits = [], venues = null) {
	const template = ctx.which === "receiver" ? "receiver.service" : "worker.service";
	// The ExecStart line is replaced WHOLE, not path-by-path: the template's script path is relative
	// to a repo-root WorkingDirectory that only a checkout has. The rendered unit points at absolute
	// entries that exist in both layouts — cliPath beside this module; the receiver package's ./start
	// export — so ExecStart works no matter what WorkingDirectory is.
	const argv = ctx.which === "receiver" ? [ctx.execPath, ctx.receiverStart] : [ctx.execPath, ctx.cliPath, "worker"];
	const templateLine =
		ctx.which === "receiver" ? "ExecStart=/usr/bin/node receiver/src/start.mjs" : "ExecStart=/usr/bin/node worker/src/cli.mjs worker";
	const execStart = `ExecStart=${ctx.envSetup ? composeEnvSetupExec(ctx.envSetup, argv) : argv.join(" ")}`;
	// The banner outranks the template's own "TEMPLATE/UNTESTED EXAMPLE — set the PLACEHOLDERs" header,
	// which renders through below (the no-markers design keeps templates byte-usable, so their prose
	// survives): a reader of the rendered unit should know the placeholders are already substituted.
	const seamNote = ctx.envSetup
		? `# ExecStart also runs \`--env-setup ${ctx.envSetup}\` first: sourced with \`set -a\` (a bare\n# KEY=value exports, exactly as EnvironmentFile= does, and it runs AFTER EnvironmentFile so a secrets\n# manager wins over a stale value in .env). A failed setup exits 1, never the exit 2 below, and \`exec\`\n# keeps systemd watching the worker itself. Re-render to change it; do not hand-edit this line.\n`
		: "";
	// Substituted first, then the composed line goes in — see subUnitPaths for why that order is
	// load-bearing. The anchor is the template's own ExecStart put through the same substitutions, which
	// is what it looks like by the time we search for it. Function replacements throughout: a deployment
	// path holding `$&` would otherwise be spliced by String.replace's own syntax.
	const substituted = subUnitPaths(ctx, readTemplate(ctx, template));
	let unit =
		`# rendered by \`pi-dispatch service\` — paths computed for this host from deploy/${template};\n# the template's PLACEHOLDER prose below is already substituted.\n${seamNote}` +
		substituted.replace(subUnitPaths(ctx, templateLine), () => execStart);
	if (ctx.scope === "user") {
		// A systemd --user unit always runs as the invoking user, and systemd REJECTS a User= line in
		// user scope ("Unknown lvalue"); the line must not survive the render. The replacement is a
		// comment so the rendered unit explains its own difference from the shipped template. Anchored
		// to the whole line (^…$) because the template's header comment ALSO says "User=pi" mid-line —
		// a bare replace would rewrite the prose and leave the directive standing.
		unit = unit.replace(
			/^User=pi$/m,
			"# User= stripped by `pi-dispatch service`: a --user unit always runs as the invoking user,\n# and systemd rejects User= in user scope.",
		);
		// multi-user.target exists only in the SYSTEM instance. A user unit enabled into it would
		// symlink into a .wants/ directory no user-instance boot ever walks — enabled but never
		// started. default.target is the user manager's boot target.
		unit = unit.replace("WantedBy=multi-user.target", "WantedBy=default.target");
		// The podman venue's Quadlet units (issue #430), which live in this same user manager, so the worker can be
		// ordered after them. Nothing is added when there are none, which keeps every other render byte-identical.
		const deps = workerUnitDeps(stackUnits);
		if (deps) unit = unit.replace("\nWants=network-online.target\n", () => `\nWants=network-online.target\n${deps}`);
		// The template's own words, made true for a podman deployment (round 2 nit): its Description says jobs launch
		// via docker, and its comment says Valkey is not ordered here. Both anchors are TEMPLATE_PINS.
		if (venues?.podmanUsed) {
			const runtime = venues.localUsed ? "docker and rootless podman" : "rootless podman";
			unit = unit.replace(WORKER_DESCRIPTION, () => `Description=pi-dispatch worker (drains the job queue on the host; launches job containers via ${runtime})`);
			if (stackUnits.includes(QUADLET_FILES.valkey.unit)) {
				unit = unit.replace(WORKER_VALKEY_COMMENT, () => "# Valkey is the podman venue's Quadlet unit in this same user manager, so the worker is ordered after it\n# (the Wants=/After= lines `pi-dispatch service install` added below).\n");
			}
		}
	} else {
		unit = unit.replace(/^User=pi$/m, () => `User=${ctx.user}`);
	}
	return unit;
}

/**
 * Render the launchd plist for this host. For --receiver the worker plist is DERIVED, not a second
 * template: same KeepAlive/ExitTimeOut shape, label and log names swapped, and the shared wrapper given
 * the receiver's exec argv instead of the worker's. The wrapper's exit-2 conversion is LOAD-BEARING for
 * the receiver too, not the no-op an earlier version of this comment claimed: since
 * receiver/src/cli.mjs gained entryExitCode, a determinate receiver refusal exits EXIT_POLICY (2), and
 * the wrapper's conversion to a clean 0 is exactly what KeepAlive/SuccessfulExit=false reads as
 * "leave it stopped" -- launchd's only way to spell RestartPreventExitStatus=2.
 */
function renderPlist(ctx) {
	// Substituted before anything composed goes in (subDeployDir): the two anchors below are therefore
	// written in their post-substitution form, and PI_ENV_SETUP can no longer be rewritten into a path
	// the operator never typed. Only subDeployDir here — the template's /usr/bin/node is example prose.
	let plist = subDeployDir(ctx, readTemplate(ctx, "com.pi-dispatch.worker.plist"));
	// One wrapper, two daemons: the exec argv IS the difference now. The wrapper sources ./.env in the
	// unit's WorkingDirectory and runs exactly these arguments — no `receiver` selector flag, no paths
	// guessed inside the wrapper (issue #96: the wrapper's self-relative guess broke under npm install).
	const execArgv = ctx.which === "receiver" ? [ctx.execPath, ctx.receiverStart] : [ctx.execPath, ctx.cliPath, "worker"];
	if (ctx.which === "receiver") {
		plist = plist
			.replace("<string>com.pi-dispatch.worker</string>", "<string>com.pi-dispatch.receiver</string>")
			.replaceAll("worker.out.log", "receiver.out.log")
			.replaceAll("worker.err.log", "receiver.err.log");
	}
	// The template's two-element ProgramArguments (sh + wrapper) becomes sh + the PACKAGE's wrapper +
	// the command: absolute node, absolute script. The wrapper path is module-relative (templatesDir),
	// so it exists in a checkout AND under node_modules — unlike the old repo-root guess.
	plist = plist.replace(
		`<string>${ctx.deployDir}/deploy/worker-env-wrapper.sh</string>`,
		() =>
			[
				`<string>${ctx.wrapperSh}</string>`,
				"<!-- the command the wrapper execs after sourcing ./.env in WorkingDirectory - absolute paths, nothing guessed -->",
				...execArgv.map((a) => `<string>${a}</string>`),
			].join("\n\t\t"),
	);
	// launchd's default PATH is /usr/bin:/bin — an nvm or Homebrew node is invisible to it. The exec
	// argv above pins THIS node absolutely, but the worker's own children (npx-style hooks, tooling
	// that spawns bare `node`) still resolve via PATH; prepending the render node's directory keeps
	// them on the SAME binary. PATH is configuration, not a secret: the template's deliberate
	// no-EnvironmentVariables stance is about credentials, which still live only in .env.
	// The dict is built as a list so the seam below can extend it without a second anchor. Everything
	// in it is a PATH; nothing in it is a credential, which is what keeps this file committable.
	const envEntries = ["\t\t<key>PATH</key>", `\t\t<string>${dirname(ctx.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin</string>`];
	if (ctx.envSetup) {
		// launchd has no EnvironmentFile and no shell in front of ProgramArguments, so the seam is a
		// VARIABLE the wrapper reads rather than a composed command line: nothing here has to be quoted
		// for a shell, and ProgramArguments stays byte-identical to the default render. The wrapper
		// sources it AFTER ./.env, so a secrets manager wins over a stale key left in the file.
		envEntries.push(
			"\t\t<!-- `pi-dispatch service --env-setup`: worker-env-wrapper.sh sources this file after ./.env.\n\t\t     A path, not a credential. Re-render to change it. -->",
			"\t\t<key>PI_ENV_SETUP</key>",
			`\t\t<string>${ctx.envSetup}</string>`,
		);
	}
	const workingDir = `<key>WorkingDirectory</key>\n\t<string>${ctx.deployDir}</string>`;
	plist = plist.replace(
		workingDir,
		() =>
			`${workingDir}\n\n\t<!-- Injected by \`pi-dispatch service\`: launchd's default PATH cannot see an nvm/Homebrew node,\n\t     and child processes may call bare \`node\`. Not a secrets dict - credentials still live only\n\t     in .env (see the header comment). -->\n\t<key>EnvironmentVariables</key>\n\t<dict>\n` +
			`${envEntries.join("\n")}\n\t</dict>`,
	);
	return plist;
}

/**
 * The nssm command sequence — deploy/nssm-install.cmd's exact steps with computed paths: the service
 * Application is the PACKAGE's .cmd wrapper, its AppParameters are the exec argv (<node> <script> …)
 * the wrapper now runs verbatim, and AppDirectory is the deployment folder so the wrapper finds ./.env
 * there (the same WorkingDirectory contract as launchd). Values that carry semantics
 * (AppStopMethodConsole 15000, AppThrottle 5000, AppExit Default Restart, AppExit 2 Exit) mirror the
 * template byte-for-byte and are pinned. Backslashes on purpose where paths are BUILT here: this argv
 * reaches nssm on a real Windows host, where deployDir is already a Windows path (wrapperCmd and
 * cliPath come from win32 path.join and need no help).
 */
function nssmSequence(ctx) {
	const service = `pi-dispatch-${ctx.which}`;
	const logDir = `${ctx.deployDir}\\logs`;
	const execArgv = ctx.which === "receiver" ? [ctx.execPath, ctx.receiverStart] : [ctx.execPath, ctx.cliPath, "worker"];
	return {
		service,
		commands: [
			["install", service, ctx.wrapperCmd, ...execArgv],
			["set", service, "AppDirectory", ctx.deployDir],
			// Same seam as the plist's EnvironmentVariables dict, for the same reason: nssm takes a
			// NAME=VALUE with no shell between it and the wrapper, so the path needs no quoting and
			// AppParameters stays byte-identical to the default render.
			...(ctx.envSetup ? [["set", service, "AppEnvironmentExtra", `PI_ENV_SETUP=${ctx.envSetup}`]] : []),
			["set", service, "AppStdout", `${logDir}\\${ctx.which}.out.log`],
			["set", service, "AppStderr", `${logDir}\\${ctx.which}.err.log`],
			["set", service, "AppStopMethodConsole", "15000"],
			["set", service, "AppThrottle", "5000"],
			["set", service, "AppExit", "Default", "Restart"],
			["set", service, "AppExit", "2", "Exit"],
		],
	};
}

/**
 * Does this worker deployment run the podman venue, per the `.env` its unit loads? `{ used: false }`, `{ error }`,
 * or `{ used: true, venues, env }`. Only the worker has a stack: the receiver runs no job and needs no Podman.
 *
 * The keys come from the deployment's `.env`, the file the unit's `EnvironmentFile=` loads, read the way that loader
 * reads it (`readStackKeys`, shared with `up`). NOT this shell's environment: nothing in this project loads `.env` into
 * a process (docs/secrets.md), so a shell that exports PI_BACKENDS=podman says nothing about what the SERVICE will
 * run, and installing Quadlet units off it would stand up a stack for a worker that then runs docker. A key an
 * `--env-setup` script exports is invisible here for the same reason, which docs/podman.md says.
 *
 * On macOS and Windows the answer decides only a NOTE (the venue runs only on Linux, so there is no stack to
 * install), so it is read with that platform's own loader (the wrapper sources the file with sh; the cmd wrapper
 * splits it) and a file it cannot read there is not a refusal: refusing an install over a key that could change
 * nothing about it would be a refusal with no remedy.
 */
function podmanVenue(ctx) {
	if (ctx.which !== "worker") return { used: false };
	const envPath = join(ctx.deployDir, ".env");
	const linux = ctx.platform === "linux";
	let fileKeys = {};
	if (ctx.fs.existsSync(envPath)) {
		let text;
		try {
			// Bytes, not text: `readStackKeys` checks what systemd refuses to load before it decodes (issue #447).
			text = ctx.fs.readFileSync(envPath);
		} catch (err) {
			if (!linux) return { used: false };
			return { error: `cannot read ${envPath} to learn whether this deployment runs the podman venue: ${err?.message}` };
		}
		const read = readStackKeys(text, { loader: linux ? "systemd" : ctx.platform === "darwin" ? "shell" : "cmd", path: envPath });
		if (read.error) return linux ? { error: read.error } : { used: false };
		fileKeys = read.keys;
	}
	// Refused here, unlike doctor's venuesOf, which reads an unparseable list as `local`: doctor then reports the parse,
	// but an install that guessed would write a unit and a stack for a deployment the worker refuses to boot.
	try {
		parseBackendList(fileKeys.PI_BACKENDS);
	} catch (err) {
		return linux ? { error: `${envPath}: ${err.message}` } : { used: false };
	}
	const venues = venuesOf(fileKeys);
	if (!venues.podmanUsed) return { used: false };
	return { used: true, venues, env: fileKeys };
}

/**
 * The refusal for the podman venue in SYSTEM scope. Not "podman cannot run under a system unit": a system unit with
 * `User=` runs rootless Podman fine (measured, docs/podman.md step 2). The stack is the problem. Its Quadlet units
 * belong to the account's own user manager, and a system unit cannot `Wants=`/`After=` a unit of another manager, so
 * the worker would race its own queue at every boot; and installing them means writing into a user's config from a
 * command whose system-scope doctrine is to write nothing. User scope with linger does both properly.
 */
function refusePodmanSystemScope(ctx) {
	return fail(
		ctx.err,
		`PI_BACKENDS in ${join(ctx.deployDir, ".env")} lists podman, and the podman venue's stack (Valkey, the egress proxy) runs as Quadlet units in the worker account's OWN user manager, which a system unit cannot order itself after. Install in user scope (drop --system) with linger on:  sudo loginctl enable-linger ${ctx.user}\nOr keep a hand-written system unit and start the stack by hand (docs/podman.md, steps 6 and 7).`,
	);
}

/**
 * The podman venue's stack for this install: which parts, rendered, with the actions that install them. `{ error }`
 * for what cannot be installed, else `{ components, plan, notes }`. The Valkey rule differs from `up`'s on purpose:
 * `up` starts what is not running, while an install also keeps (and orders the worker after) a Valkey unit an
 * earlier run already installed, even though that Valkey is now the thing listening.
 */
async function podmanStackFor(ctx, venue, { readKeeper = false } = {}) {
	let armed;
	try {
		armed = egressArmed(venue.env);
	} catch (err) {
		return { error: `${join(ctx.deployDir, ".env")}: ${err.message}` };
	}
	const installed = ctx.fs.existsSync(join(quadletDir(ctx.home), QUADLET_FILES.valkey.file));
	const includeValkey = venue.venues.localUsed ? false : installed || !(await ctx.probeTcp("127.0.0.1", 6379));
	const components = stackComponents({ venues: venue.venues, env: venue.env, includeValkey, armed });
	if (!venue.venues.localUsed && !includeValkey) {
		components.notes.push("something already listens on 127.0.0.1:6379 and no Quadlet Valkey is installed, so none is added: that listener is taken to be your Valkey, as `up` does");
	}
	// The keeper, read as `up` reads it (PR #463 final review), install only (render spawns nothing): a Quadlet keeper
	// whose file is already there and unchanged but that does not hold (stopped, paused, off its bridge) is RESTARTED,
	// since `start` over it is a no-op for a paused one and would say nothing of the proxy either way; the plan then
	// restarts our proxy after it (planStack), or the install names the operator's own proxy to restart.
	let restartUnits = [];
	if (readKeeper && components.keeper && ctx.fs.existsSync(join(quadletDir(ctx.home), QUADLET_FILES.keeper.file))) {
		const keeper = judgeNetnsKeeper(await runQuery(ctx, "podman", ["inspect", NETNS_KEEPER_FORMAT, NETNS_KEEPER]));
		if (!keeper.holds) restartUnits = [QUADLET_FILES.keeper.unit];
	}
	const plan = planStack({ components, templatesDir: ctx.templatesDir, deployDir: ctx.deployDir, home: ctx.home, fs: ctx.fs, restartUnits });
	if (plan.error) return { error: plan.error };
	return { components, plan, notes: components.notes, venues: venue.venues, proxy: egressProxyName(venue.env) };
}

async function doRender(ctx) {
	if (ctx.which === "receiver" && !ctx.receiverStart) return refuseMissingReceiver(ctx);
	const paths = unitPaths(ctx);
	if (ctx.platform === "darwin") {
		ctx.out(`# → ${paths.installPath}\n`);
		ctx.out(renderPlist(ctx));
		ctx.out(
			"\n# note: ProgramArguments runs the package's worker-env-wrapper.sh, which sources ./.env in the\n# WorkingDirectory above and then runs the argv that follows it — launchd has no EnvironmentFile.\n# The wrapper also converts a policy refusal (exit 2, EXIT_POLICY) into a clean exit, so KeepAlive\n# never relaunch-loops a refusal into a provider bill.\n",
		);
		if (ctx.envSetup) {
			ctx.out(
				`# note: --env-setup is delivered as PI_ENV_SETUP above. The wrapper sources ${ctx.envSetup} AFTER\n# ./.env, so your manager wins over a stale value in the file, and a missing or failing script exits 1\n# rather than the exit 2 that means a policy refusal. With it set, ./.env becomes optional.\n`,
			);
		}
		return 0;
	}
	if (ctx.platform === "linux") {
		const venue = podmanVenue(ctx);
		if (venue.error) return fail(ctx.err, venue.error);
		let stack = null;
		if (venue.used) {
			if (ctx.scope === "system") return refusePodmanSystemScope(ctx);
			stack = await podmanStackFor(ctx, venue);
			if (stack.error) return fail(ctx.err, stack.error);
		}
		ctx.out(`# → ${paths.installPath}\n`);
		ctx.out(renderLinuxUnit(ctx, stack?.plan.start ?? [], stack?.venues ?? null));
		// The proxy's rules copy is named, not printed (round 3 nit): it is the package's egress-proxy.conf verbatim, and
		// 4.7 KB of squid configuration under a "Quadlet" heading read as a unit file.
		for (const f of stack?.plan.files ?? []) {
			if (f.kind === "conf") ctx.out(`\n# → ${f.path} (the egress proxy's rules: install copies the package's egress-proxy.conf here, unchanged)\n`);
			else ctx.out(`\n# → ${f.path} (Quadlet, podman venue)\n${f.text}`);
		}
		for (const note of stack?.notes ?? []) ctx.out(`# note: ${note}\n`);
		return 0;
	}
	const { service, commands } = nssmSequence(ctx);
	ctx.out("The nssm sequence for this host (nssm.exe: https://nssm.cc, or `winget install nssm`):\n\n");
	for (const args of commands) ctx.out(`  nssm ${quoteArgs(args)}\n`);
	ctx.out(`  nssm start ${service}\n`);
	return 0;
}

async function doInstall(ctx) {
	if (ctx.which === "receiver" && !ctx.receiverStart) return refuseMissingReceiver(ctx);
	const paths = unitPaths(ctx);

	// THE refusal, worker only: one worker per docker daemon (DES-CONCURRENCY-3). The worker's boot
	// reaper treats every running pi-job container as an orphan of its OWN previous life and kills it,
	// so a second worker — even in the other scope — would reap the first worker's live jobs on every
	// restart. Receivers are exempt: a second receiver is pointless, not destructive.
	if (ctx.which === "worker") {
		const other = paths.otherScopeWorkerPaths?.find((p) => ctx.fs.existsSync(p));
		if (other) {
			return fail(
				ctx.err,
				`a worker unit already exists in the other scope: ${other}\n` +
					"one worker per docker daemon (DES-CONCURRENCY-3): the worker's boot reaper kills every pi-job container it did not start, so a second worker would kill the first's live jobs. Remove that unit first.",
			);
		}
	}

	const venue = podmanVenue(ctx);
	if (venue.error) return fail(ctx.err, venue.error);
	if (ctx.platform === "darwin" || ctx.platform === "win32") {
		const code = ctx.platform === "darwin" ? await installDarwin(ctx, paths) : await installWindows(ctx);
		// Said, never silently skipped: the venue refuses every host that is not Linux (podman-platform), so there is
		// no stack to install here, and a deployment listing it should know why nothing about Podman happened.
		if (code === 0 && venue.used) ctx.out("note: PI_BACKENDS lists podman, and the podman venue runs only on Linux (it refuses this host as podman-platform), so no podman stack was installed here\n");
		return code;
	}
	if (ctx.scope === "system") return venue.used ? refusePodmanSystemScope(ctx) : installLinuxSystem(ctx, paths);
	let stack = null;
	let foreign = [];
	if (venue.used) {
		stack = await podmanStackFor(ctx, venue, { readKeeper: true });
		if (stack.error) return fail(ctx.err, stack.error);
		// Every stack refusal first, the unit's own among them, so installLinuxUser's unit check never fires alone.
		const refused = await stackRefusal(ctx, paths, stack);
		if (refused.error) return fail(ctx.err, refused.error);
		foreign = refused.foreign;
	}
	return installLinuxUser(ctx, paths, stack, foreign);
}

async function installDarwin(ctx, paths) {
	// Root refusal (the svc.sh darwin precedent): sudo would bootstrap into ROOT's gui domain and
	// write root's LaunchAgents — a unit the operator's own session neither sees nor controls, running
	// outside the login session that owns Docker Desktop.
	if (ctx.euid === 0) {
		return fail(
			ctx.err,
			"refusing to run as root on macOS: the unit belongs in YOUR ~/Library/LaunchAgents, bootstrapped into your gui domain — sudo would install it for root, outside the login session that owns Docker Desktop. Re-run without sudo.",
		);
	}
	const existed = ctx.fs.existsSync(paths.installPath);
	if (existed && !ctx.force) {
		return fail(ctx.err, `${paths.installPath} already exists — pass --force to replace and re-bootstrap it (same non-clobber contract as init)`);
	}
	if (existed) {
		// --force replaces a possibly-loaded unit: bootstrap refuses an already-loaded label, so boot
		// the old copy out first. "Not loaded" is a fine answer — the nonzero exit is ignored.
		await run(ctx, "launchctl", ["bootout", `gui/${ctx.euid}/${paths.name}`]);
	}
	ctx.fs.mkdirSync(dirname(paths.installPath), { recursive: true });
	// launchd creates the StandardOutPath FILES but not their parent directory: without this the job
	// spawns and dies with its error unwritable. Done at install, not render — render stays read-only.
	ctx.fs.mkdirSync(join(ctx.deployDir, "logs"), { recursive: true });
	ctx.fs.writeFileSync(paths.installPath, renderPlist(ctx));
	const bootstrap = await run(ctx, "launchctl", ["bootstrap", `gui/${ctx.euid}`, paths.installPath]);
	if (bootstrap !== 0) {
		return fail(ctx.err, `launchctl bootstrap failed (exit ${bootstrap}) — the plist is written; retry by hand: launchctl bootstrap gui/${ctx.euid} ${paths.installPath}`);
	}
	const enable = await run(ctx, "launchctl", ["enable", `gui/${ctx.euid}/${paths.name}`]);
	if (enable !== 0) return fail(ctx.err, `launchctl enable gui/${ctx.euid}/${paths.name} failed (exit ${enable})`);
	ctx.out(`installed ${paths.name} → ${paths.installPath} (bootstrapped into gui/${ctx.euid}; RunAtLoad starts it now and on login)\n`);
	// The honest note: no pretending a LaunchAgent is a boot daemon. It is the right fit anyway.
	ctx.out(
		"note: a LaunchAgent is LOGIN-scoped — it runs while you are logged in, not from boot. That is the honest fit here: Docker Desktop is itself login-scoped, so a boot-time daemon would only wait on a docker socket that appears at login anyway.\n",
	);
	return 0;
}

/**
 * Every reason the podman venue's stack refuses an install, gathered BEFORE anything is written (round 2, E9): the
 * worker unit existing used to be the only thing said, so an operator re-ran with --force and then met a replaced
 * container and a restarted proxy nobody had mentioned. `--force` is consent to exactly the list printed here. Three
 * reasons are not forceable: a missing allowlist, a container whose state could not be read, and no user manager.
 * Returns `{ error }` or `{ foreign }` (the foreign containers --force will replace, for the warnings).
 */
async function stackRefusal(ctx, paths, stack) {
	const blocking = [];
	const forceable = [];
	if (ctx.fs.existsSync(paths.installPath)) forceable.push(`${paths.installPath} already exists (same non-clobber contract as init); --force replaces it`);
	const changed = stack.plan.files.filter((f) => f.state === "changed");
	if (changed.length > 0) forceable.push(`${changed.map((f) => f.path).join(", ")} already ${changed.length === 1 ? "exists" : "exist"} with other content than this version renders; --force replaces ${changed.length === 1 ? "it" : "them"} and restarts ${(stack.plan.restart ?? []).join(" ") || "nothing"}${proxyRestartWarning(stack.plan) ? ` (${proxyRestartWarning(stack.plan)})` : ""}`);
	const allowlist = join(ctx.deployDir, "egress-allowlist.conf");
	if (stack.components.proxy && !ctx.fs.existsSync(allowlist)) {
		blocking.push(`the egress policy is on, and ${allowlist} does not exist: a proxy unit mounting a missing file makes Podman create a DIRECTORY there and squid fail confusingly. Run \`pi-dispatch init\` in ${ctx.deployDir} first (it never overwrites), or set PI_EGRESS=0 in .env to opt out of the policy`);
	}
	const bus = stack.plan.actions.length > 0 ? userBusRefusal({ env: ctx.env, user: ctx.user, euid: ctx.euid }) : null;
	if (bus) blocking.push(bus);
	// The manager's own XDG_RUNTIME_DIR and XDG_CONFIG_HOME (PR #463 round 3, measured): another account's makes every
	// unit this installs fail to start, or not exist at all. Asked only where the manager can be asked.
	if (!bus && stack.plan.actions.length > 0) {
		const managerEnv = managerEnvRefusal(await runQuery(ctx, "systemctl", ["--user", "show-environment"]), { home: ctx.home, euid: ctx.euid, user: ctx.user, realpath: ctx.realpath });
		if (managerEnv) blocking.push(managerEnv);
	}
	// A container of the unit's name that the unit does not own would be removed by its `podman run --replace`
	// (issue #430 review): refused unless --force says to replace it, and then said out loud.
	const containers = await foreignContainers(stack.plan, (cmd, args) => runQuery(ctx, cmd, args));
	const foreign = containers.found;
	if (containers.unknown.length > 0) blocking.push(unknownContainerRefusal(containers.unknown));
	if (foreign.length > 0) forceable.push(foreignContainerRefusal(foreign, { forceHint: "pass --force to let the Quadlet unit replace it" }));
	if (blocking.length > 0 || (forceable.length > 0 && !ctx.force)) {
		const lines = [...blocking, ...(ctx.force ? [] : forceable)];
		// Worded from the counts, since both lists can hold several (round 3 nit): the blocking reasons come first.
		const byHand = blocking.length === 1 ? "The first item must be fixed by hand" : `The first ${blocking.length} items must be fixed by hand`;
		const tail = blocking.length === 0 ? "\n--force accepts every item above at once." : forceable.length > 0 && !ctx.force ? `\n${byHand}; --force accepts the rest.` : `\n${blocking.length === 1 ? "It" : "Each"} must be fixed by hand; --force does not apply.`;
		return { error: `${lines.length === 1 ? lines[0] : `nothing installed, for these reasons:\n${lines.map((l) => `  - ${l}`).join("\n")}`}${lines.length > 1 ? tail : ""}` };
	}
	return { foreign };
}

async function installLinuxUser(ctx, paths, stack = null, foreign = []) {
	if (ctx.fs.existsSync(paths.installPath) && !ctx.force) {
		return fail(ctx.err, `${paths.installPath} already exists — pass --force to replace it (same non-clobber contract as init)`);
	}
	if (stack) {
		for (const note of stack.notes) ctx.out(`note: ${note}\n`);
		for (const f of foreign) {
			ctx.out(`⚠ --force: ${f.container} is not managed by ${f.unit} and will be REPLACED by it${f.unit === QUADLET_FILES.proxy.unit ? "; every job running right now loses the per-job network it had on that proxy" : ""}\n`);
		}
		const restartWarning = proxyRestartWarning(stack.plan);
		if (restartWarning) ctx.out(`⚠ ${restartWarning}\n`);
		if (stack.plan.actions.length > 0) {
			// Shown, then done: the same lines `up` asks consent for, carried out by the same function.
			ctx.out(`podman venue (PI_BACKENDS in .env): its stack, as Quadlet units in ${stack.plan.dir}:\n`);
			for (const action of stack.plan.actions) ctx.out(`  ${describeAction(action)}\n`);
			const applied = await applyStack(stack.plan, { fs: ctx.fs, run: (cmd, args) => run(ctx, cmd, args) });
			if (!applied.ok) {
				return fail(
					ctx.err,
					`${applied.failed} failed (${applied.code === null ? applied.message ?? "command not found" : `exit ${applied.code}`}), so the worker unit was NOT installed: it would only start against a missing queue or proxy. \`systemctl --user status ${stack.plan.start.join(" ")}\` and \`journalctl --user -u <unit>\` have the details; fix it, then re-run this install`,
				);
			}
		}
	}
	ctx.fs.mkdirSync(dirname(paths.installPath), { recursive: true });
	ctx.fs.writeFileSync(paths.installPath, renderLinuxUnit(ctx, stack?.plan.start ?? [], stack?.venues ?? null));
	const reload = await run(ctx, "systemctl", ["--user", "daemon-reload"]);
	if (reload === null) return fail(ctx.err, `systemctl not found — is this a systemd host? The unit is written at ${paths.installPath}`);
	const enable = await run(ctx, "systemctl", ["--user", "enable", "--now", paths.name]);
	if (enable !== 0) {
		return fail(ctx.err, `systemctl --user enable --now ${paths.name} failed (exit ${enable}) — the unit is written at ${paths.installPath}; \`systemctl --user status ${paths.name}\` has the details`);
	}
	ctx.out(`installed ${paths.name} → ${paths.installPath} (enabled and started in your user manager)\n`);
	if (stack) {
		// Said as it happened: `start` on a unit already active is a no-op, so a unit whose file this run replaced was
		// RESTARTED (planStack), and the line names which is which rather than calling everything "started".
		const restarted = stack.plan.restart ?? [];
		const started = stack.plan.start.filter((u) => !restarted.includes(u));
		if (started.length > 0) ctx.out(`started ${started.join(" ")} (Quadlet units: never enabled, the generator reads their own [Install] section; a unit already running is left as it is)\n`);
		// Named by the file that changed (round 3 nit): the proxy also restarts for its rules copy alone.
		for (const unit of restarted) {
			const changedFiles = stack.plan.files.filter((f) => f.state === "changed" && f.restarts === unit).map((f) => f.path);
			ctx.out(`restarted ${unit}, because this install replaced ${changedFiles.join(" and ")}\n`);
		}
		if (stack.plan.start.length > 0) ctx.out(`${paths.name} Wants= and is After= ${stack.plan.start.join(" ")}\n`);
		// PR #463 round 3: a keeper started or restarted beside a proxy this install does not own (PI_EGRESS_PROXY naming
		// the operator's own) leaves that proxy up since before the keeper; said, with its name.
		const hint = keeperUnderRunningProxyHint(stack.plan, stack.proxy);
		if (hint) ctx.out(`⚠ ${hint}\n`);
		// A WARNING, not a refusal, like the note below it: a worker that runs only while its operator is logged in is a
		// real (desktop) deployment. But on this venue linger is also what brings the queue and the proxy back, and it
		// was measured both ways, so the line says which of the two this host is rather than the general caution.
		ctx.out(lingerNote(await readLinger(ctx.user, (cmd, args) => runCapture(ctx, cmd, args)), ctx.user));
		return 0;
	}
	// Without linger a user manager only runs while a session exists — fine on a desktop, a silent
	// no-worker-after-reboot on a headless box. Say so instead of letting the operator find out.
	ctx.out(`note: user units run while you have a session. For a headless host that must start at boot:  sudo loginctl enable-linger ${ctx.user}\n`);
	return 0;
}

async function installLinuxSystem(ctx, paths) {
	if (ctx.fs.existsSync(paths.installPath) && !ctx.force) {
		return fail(ctx.err, `${paths.installPath} already exists — pass --force to re-stage the render (the printed sudo commands would overwrite it)`);
	}
	// The pm2-startup pattern: this tool NEVER writes or spawns as root. The render is staged where
	// the operator can read it, and the exact commands are printed — their shell is the consent gate.
	const staged = join(ctx.tmp, paths.name);
	ctx.fs.writeFileSync(staged, renderLinuxUnit(ctx));
	ctx.out(`--system never runs root commands from this tool. The rendered unit is staged at:\n  ${staged}\n\nInspect it, then run:\n  sudo install -m 644 ${staged} ${paths.installPath}\n  sudo systemctl daemon-reload\n  sudo systemctl enable --now ${paths.name}\n`);
	return 0;
}

async function installWindows(ctx) {
	const { service, commands } = nssmSequence(ctx);
	// One probe answers two questions: is nssm on PATH (ENOENT → no), and does the service already
	// exist (exit 0 → yes). Task Scheduler is deliberately never offered — it stops tasks with a hard
	// kill, so the worker could never drain (see deploy/nssm-install.cmd's rationale).
	const status = await runCapture(ctx, "nssm", ["status", service]);
	if (status.code === null) {
		return fail(ctx.err, "nssm.exe not found on PATH — download it from https://nssm.cc (or `winget install nssm`) and re-run. Task Scheduler is not a substitute: it kills instead of stopping, so the worker could never drain.");
	}
	if (status.code === 0 && !ctx.force) {
		return fail(ctx.err, `service ${service} already exists (nssm status reports it) — pass --force to remove and re-install it`);
	}
	if (status.code === 0) {
		await run(ctx, "nssm", ["stop", service]); // may already be stopped; nonzero is fine
		const removed = await run(ctx, "nssm", ["remove", service, "confirm"]);
		if (removed !== 0) return fail(ctx.err, `nssm remove ${service} confirm failed (exit ${removed})`);
	}
	// nssm, like launchd, does not create the AppStdout/AppStderr directory. join(), not the
	// sequence's literal backslashes: this branch runs on the actual Windows host, where join is
	// win32-flavoured anyway.
	ctx.fs.mkdirSync(join(ctx.deployDir, "logs"), { recursive: true });
	for (const args of commands) {
		const code = await run(ctx, "nssm", args);
		if (code !== 0) return fail(ctx.err, `nssm ${args.join(" ")} failed (exit ${code})`);
	}
	// Mirrors the template's own last line: install registers, `nssm start` is the one visible step
	// left to the operator (the service auto-starts on the next boot either way).
	ctx.out(`installed service ${service}. Start it with:  nssm start ${service}\n`);
	return 0;
}

async function doUninstall(ctx) {
	const paths = unitPaths(ctx);
	if (ctx.platform === "win32") {
		const status = await runCapture(ctx, "nssm", ["status", paths.name]);
		if (status.code === null) return fail(ctx.err, "nssm.exe not found on PATH — it is also how uninstall talks to the service manager (https://nssm.cc)");
		if (status.code !== 0) return fail(ctx.err, `service ${paths.name} is not installed (\`nssm status ${paths.name}\` reports none)`);
		await run(ctx, "nssm", ["stop", paths.name]); // already-stopped is fine
		const removed = await run(ctx, "nssm", ["remove", paths.name, "confirm"]);
		if (removed !== 0) return fail(ctx.err, `nssm remove ${paths.name} confirm failed (exit ${removed})`);
		ctx.out(`uninstalled service ${paths.name}\n`);
		return 0;
	}
	const userPath = ctx.platform === "darwin" ? paths.installPath : paths.userPath;
	// The podman venue's Quadlet units (issue #430), removed with the worker, or on their own when `up` installed them
	// and no worker unit was ever written. Decided by what EXISTS, not by today's PI_BACKENDS: an operator who dropped
	// podman from the list still has the units, and they are still this tool's to remove.
	const quadlets = ctx.platform === "linux" && ctx.which === "worker" && ctx.scope === "user" ? ALL_QUADLET_FILES.filter((q) => ctx.fs.existsSync(join(quadletDir(ctx.home), q.file))) : [];
	// No user manager to talk to (`sudo -iu`, round 3 D3, measured): every `systemctl --user` below would fail, and the
	// old code ignored the exits, printed success with exit 0, and left the worker and the stack running with a
	// dangling default.target.wants link. Refused before anything is touched, whenever this run would talk to it.
	if (ctx.platform === "linux" && (ctx.fs.existsSync(userPath) || quadlets.length > 0)) {
		const bus = userBusRefusal({ env: ctx.env, user: ctx.user, euid: ctx.euid });
		if (bus) return fail(ctx.err, bus.replace("so `systemctl --user` would fail after the files were written", "so `systemctl --user` could stop and disable nothing"));
	}
	if (!ctx.fs.existsSync(userPath) && quadlets.length > 0 && !ctx.fs.existsSync(paths.systemPath)) {
		return removeQuadlets(ctx, quadlets);
	}
	if (!ctx.fs.existsSync(userPath)) {
		// Say where it looked — both scopes — and if the unit turns out to live in ROOT scope, print
		// the removal commands instead of touching them (the same never-root doctrine as install).
		if (ctx.fs.existsSync(paths.systemPath)) {
			const rootCmds =
				ctx.platform === "darwin"
					? `  sudo launchctl bootout system/${paths.name}\n  sudo rm ${paths.systemPath}`
					: `  sudo systemctl disable --now ${paths.name}\n  sudo rm ${paths.systemPath}\n  sudo systemctl daemon-reload`;
			return fail(ctx.err, `not installed in user scope (looked at ${userPath}); a SYSTEM-scope unit exists at ${paths.systemPath} — this tool never touches root scope. Remove it with:\n${rootCmds}`);
		}
		return fail(ctx.err, `${paths.name} is not installed — looked at ${userPath} (user scope) and ${paths.systemPath} (system scope)`);
	}
	if (ctx.platform === "darwin") {
		await run(ctx, "launchctl", ["bootout", `gui/${ctx.euid}/${paths.name}`]); // not-loaded is fine
		ctx.fs.unlinkSync(userPath);
		ctx.out(`uninstalled ${paths.name} (booted out of gui/${ctx.euid}, plist removed)\n`);
		return 0;
	}
	// A non-zero exit here is a unit that is still enabled or still running (round 3, D3): nothing is removed and nothing
	// is claimed. `disable --now` on an installed unit that is merely not enabled exits 0.
	const disabled = await run(ctx, "systemctl", ["--user", "disable", "--now", paths.name]);
	if (disabled !== 0) {
		return fail(ctx.err, `systemctl --user disable --now ${paths.name} failed (${disabled === null ? "systemctl not found" : `exit ${disabled}`}), so nothing was removed: the worker may still be running. \`systemctl --user status ${paths.name}\` has the details`);
	}
	ctx.fs.unlinkSync(userPath);
	const reload = await run(ctx, "systemctl", ["--user", "daemon-reload"]);
	if (reload !== 0) {
		return fail(ctx.err, `${paths.name} is disabled, stopped and its unit file removed, but systemctl --user daemon-reload failed (${reload === null ? "systemctl not found" : `exit ${reload}`}): run it yourself`);
	}
	ctx.out(`uninstalled ${paths.name} (disabled, stopped, unit removed)\n`);
	if (quadlets.length > 0) return removeQuadlets(ctx, quadlets);
	return 0;
}

/**
 * Stop and remove the podman venue's Quadlet units. `stop`, never `disable`: a generated unit cannot be disabled any
 * more than enabled, and removing its file plus a daemon-reload is what unlinks it from default.target. The Valkey
 * volume and the three networks are deliberately LEFT: the volume holds the queue's wait-list, and a re-install that
 * found it gone would have dropped every waiting job on an uninstall nobody meant as a purge.
 */
async function removeQuadlets(ctx, quadlets) {
	// The network units too (round 3, D2, measured): left behind, they stay `active (exited)` in the manager, so after the
	// `podman network rm` the message below suggests, a reinstall in the same manager lifetime found its network unit
	// already "started" and the container failed with "network not found". Containers first, then their networks.
	const containers = quadlets.filter((q) => q.file.endsWith(".container")).map((q) => q.unit);
	const networks = quadlets.filter((q) => q.file.endsWith(".network")).map((q) => q.unit);
	const units = [...containers, ...networks];
	if (units.length > 0) {
		// A unit that is already stopped stops with exit 0; a non-zero exit is a stop that did not happen (no manager, a
		// unit that would not die), and removing the files under a running container would leave it running unmanaged
		// while this command claimed it was gone (round 3, D3).
		const stopped = await run(ctx, "systemctl", ["--user", "stop", ...units]);
		if (stopped !== 0) {
			return fail(ctx.err, `systemctl --user stop ${units.join(" ")} failed (${stopped === null ? "systemctl not found" : `exit ${stopped}`}), so nothing was removed: the containers may still be running. \`systemctl --user status ${units.join(" ")}\` has the details`);
		}
	}
	for (const q of quadlets) ctx.fs.unlinkSync(join(quadletDir(ctx.home), q.file));
	// The account-owned copy of the proxy's rules (E1) goes with its unit.
	const conf = proxyConfCopyPath(ctx.home);
	if (ctx.fs.existsSync(conf)) ctx.fs.unlinkSync(conf);
	const reload = await run(ctx, "systemctl", ["--user", "daemon-reload"]);
	if (reload !== 0) {
		return fail(ctx.err, `the Quadlet files are removed and their units stopped, but systemctl --user daemon-reload failed (${reload === null ? "systemctl not found" : `exit ${reload}`}): run it yourself so the manager forgets them`);
	}
	// squid ignores SIGTERM, so its stop takes systemd's 10 s and ends in SIGKILL, exit 137, and the unit is left
	// `failed` (measured): after the file is gone `systemctl --user list-units` would show a not-found failed unit
	// forever. reset-failed clears it. Its exit is not checked: a unit that never failed is already what it asks for.
	if (units.length > 0) await run(ctx, "systemctl", ["--user", "reset-failed", ...units]);
	// The volume is named only when a Valkey unit was among what was removed (issue #452 gate round 2): a stack installed
	// without Valkey never had one, and the line used to claim a volume nothing here made was kept.
	const hadValkey = quadlets.some((q) => q.file === QUADLET_FILES.valkey.file);
	ctx.out(`removed the podman venue's Quadlet units (${quadlets.map((q) => q.file).join(", ")}); ${hadValkey ? "the pi-dispatch-valkey-data volume and the networks are" : "the networks are"} kept, remove them with podman if you mean to\n`);
	return 0;
}

/** Informational only — reports every scope it knows about and always exits 0. */
async function doStatus(ctx) {
	const paths = unitPaths(ctx);
	if (ctx.platform === "win32") {
		const status = await runCapture(ctx, "nssm", ["status", paths.name]);
		if (status.code === null) ctx.out(`${paths.name}: cannot query — nssm.exe not on PATH (https://nssm.cc)\n`);
		else if (status.code !== 0) ctx.out(`${paths.name}: not installed\n`);
		else ctx.out(`${paths.name}: ${status.output.trim()}\n`);
		if (status.code === 0) {
			const extra = await runCapture(ctx, "nssm", ["get", paths.name, "AppEnvironmentExtra"]);
			const setup = extra.code === 0 ? readUnitSeam(extra.output, "win32").setup : null;
			if (setup) ctx.out(`env-setup: ${setup} (named by ${paths.name}'s AppEnvironmentExtra)\n`);
		}
		return 0;
	}
	if (ctx.platform === "darwin") {
		if (ctx.fs.existsSync(paths.installPath)) {
			const print = await runCapture(ctx, "launchctl", ["print", `gui/${ctx.euid}/${paths.name}`]);
			ctx.out(`user scope: ${paths.installPath} — ${print.code === 0 ? "loaded" : "installed but NOT loaded (launchctl bootstrap it, or `pi-dispatch service start`)"}\n`);
		} else {
			ctx.out(`user scope: not installed (${paths.installPath})\n`);
		}
		ctx.out(ctx.fs.existsSync(paths.systemPath) ? `system scope: ${paths.systemPath} EXISTS — not managed by this tool\n` : "system scope: none\n");
		reportEnvSetup(ctx, [paths.installPath, paths.systemPath]);
		return 0;
	}
	if (ctx.fs.existsSync(paths.userPath)) {
		const active = await runCapture(ctx, "systemctl", ["--user", "is-active", paths.name]);
		ctx.out(`user scope: ${paths.userPath} — ${active.code === null ? "systemctl not found" : active.output.trim() || "unknown"}\n`);
	} else {
		ctx.out(`user scope: not installed (${paths.userPath})\n`);
	}
	const systemHits = [paths.systemPath, ...(ctx.which === "worker" ? ["/etc/systemd/system/worker.service"] : [])].filter((p) => ctx.fs.existsSync(p));
	ctx.out(systemHits.length ? `system scope: ${systemHits.join(", ")} EXISTS — not managed by this tool\n` : "system scope: none\n");
	reportEnvSetup(ctx, [paths.userPath, ...systemHits]);
	// The podman venue's Quadlet units, one line each, and nothing at all where there are none, so the output of every
	// other deployment is byte-identical to before issue #430.
	if (ctx.which === "worker") {
		for (const q of ALL_QUADLET_FILES) {
			const path = join(quadletDir(ctx.home), q.file);
			if (!ctx.fs.existsSync(path)) continue;
			const active = await runCapture(ctx, "systemctl", ["--user", "is-active", q.unit]);
			ctx.out(`quadlet: ${path} (${q.unit}): ${active.code === null ? "systemctl not found" : active.output.trim() || "unknown"}\n`);
		}
	}
	return 0;
}

/**
 * One informational line per unit that names an `--env-setup` script (issue #216). status REPORTS: it
 * says where the seam is configured, and nothing about whether the script is still there, still
 * private, or still uncommitted. Those are `doctor`'s — it is the preflight, it owns the warn tiers,
 * and it already has the git check-ignore seam. Prints nothing when no seam is configured, so the
 * output of every deployment that does not use one is byte-identical to before.
 */
function reportEnvSetup(ctx, paths) {
	for (const path of paths) {
		if (!ctx.fs.existsSync(path)) continue;
		let setup = null;
		try {
			setup = readUnitSeam(ctx.fs.readFileSync(path, "utf8"), ctx.platform).setup;
		} catch {
			// Unreadable — a system-scope unit this user may not read is the ordinary case. The scope line
			// above already reported that it exists; status never fails on what it could not look at.
		}
		if (setup) ctx.out(`env-setup: ${setup} (named by ${path})\n`);
	}
}

async function doStart(ctx) {
	return startStop(ctx, "start");
}

async function doStop(ctx) {
	return startStop(ctx, "stop");
}

/**
 * Thin per-OS start/stop. macOS stop is `launchctl kill SIGTERM`, NOT bootout: bootout unloads the
 * unit entirely, while kill delivers the same graceful SIGTERM systemd's stop does — the worker
 * drains, exits 0, and KeepAlive's SuccessfulExit=false leaves a clean exit stopped.
 */
async function startStop(ctx, verb) {
	const paths = unitPaths(ctx);
	if (ctx.platform === "linux" && ctx.scope === "system") {
		return fail(ctx.err, `--system is print-only (this tool never runs root commands). Run:\n  sudo systemctl ${verb} ${paths.name}`);
	}
	let code;
	if (ctx.platform === "darwin") {
		code =
			verb === "start"
				? await run(ctx, "launchctl", ["kickstart", `gui/${ctx.euid}/${paths.name}`])
				: await run(ctx, "launchctl", ["kill", "SIGTERM", `gui/${ctx.euid}/${paths.name}`]);
	} else if (ctx.platform === "linux") {
		code = await run(ctx, "systemctl", ["--user", verb, paths.name]);
	} else {
		code = await run(ctx, "nssm", [verb, paths.name]);
	}
	if (code !== 0) return fail(ctx.err, `${verb} ${paths.name} failed (${code === null ? "service tool not found" : `exit ${code}`}) — is it installed? (pi-dispatch service status)`);
	ctx.out(`${verb === "start" ? "started" : "stopped"} ${paths.name}\n`);
	return 0;
}

async function doRestart(ctx, values) {
	if (!values.drain) {
		const stopped = await doStop(ctx);
		if (stopped !== 0) return stopped;
		return doStart(ctx);
	}

	const timeoutS = Number(values["drain-timeout"] ?? "600");
	if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
		return fail(ctx.err, `--drain-timeout must be a positive number of seconds, got: ${values["drain-timeout"]}`);
	}
	let queue = ctx.queue;
	if (!queue) {
		// VALKEY_URL only, exactly like cli.mjs's pause/resume: the drain must work even when the rest
		// of the config (forge auth …) is broken, and failFast keeps a down Valkey an error in seconds
		// instead of a hung restart. Lazy imports for the same reason cli.mjs uses them: `service`
		// subcommands that never touch the queue must not load bullmq/ioredis.
		const url = ctx.env.VALKEY_URL ?? "redis://127.0.0.1:6379";
		const { parseConnection } = await import("./connection.mjs");
		const { makeQueue } = await import("./queue.mjs");
		queue = makeQueue(parseConnection(url, { failFast: true }));
	}
	try {
		await queue.pause();
		ctx.out("paused — no new jobs will start; waiting for active jobs to finish\n");
		const deadline = ctx.now() + timeoutS * 1000;
		let { active = 0 } = await queue.getJobCounts("active");
		while (active > 0) {
			if (ctx.now() >= deadline) {
				// Deliberately NO resume and NO restart: a job is still running. Restarting would abort
				// it; resuming would feed new jobs toward a restart that is still owed. Paused is the
				// safe durable state (it survives the restart the operator will now do by hand).
				ctx.out(
					`drain timed out after ${timeoutS}s with ${active} job(s) still active — NOT restarting.\nThe queue STAYS PAUSED so the running job can finish undisturbed. Investigate (pi-dispatch status), then restart and \`pi-dispatch resume\` yourself.\n`,
				);
				return 1;
			}
			ctx.out(`  ${active} active — waiting\n`);
			await ctx.sleep(2000);
			({ active = 0 } = await queue.getJobCounts("active"));
		}
		// A HELD job is neither active nor waiting, so the loop above has just reported a drained queue with
		// however many jobs still parked on `run.waitFor` (issue #230). They are safe -- a hold spends
		// nothing, survives a restart and reserves no slot -- but the operator is upgrading, and those jobs
		// will wake against the new version. Said plainly rather than left to be discovered, which is what
		// this command would otherwise be doing: reporting a drained queue it cannot see all of.
		const delayed = await queue.getJobCounts("delayed").then((c) => Number(c?.delayed ?? 0), () => 0);
		if (delayed > 0) {
			ctx.out(`note: ${delayed} job(s) sit in the delayed set (cron next-occurrences, retry backoff, quiet hours, scope/host deferrals, or jobs held on run.waitFor). None is active, so none blocked this drain; they will wake against the new version.\n`);
		}
		const stopped = await doStop(ctx);
		if (stopped !== 0) {
			ctx.out("restart did not happen — the queue STAYS PAUSED; fix the service, then `pi-dispatch resume`.\n");
			return 1;
		}
		const started = await doStart(ctx);
		if (started !== 0) {
			ctx.out("the service did not come back — the queue STAYS PAUSED; fix the service, then `pi-dispatch resume`.\n");
			return 1;
		}
		await queue.resume();
		ctx.out("resumed — drained restart complete\n");
		return 0;
	} catch (error) {
		return fail(ctx.err, `could not reach Valkey — is it running? (docker compose up)\n  ${error.message}`);
	} finally {
		await queue.close().catch(() => {});
	}
}

function fail(err, message) {
	err(`error: ${message}\n`);
	return 1;
}

/** Re-join an argv for display; quote what cmd.exe would split (spaces) or what is a path (backslashes). */
function quoteArgs(args) {
	return args.map((a) => (a.includes(" ") || a.includes("\\") ? `"${a}"` : a)).join(" ");
}

/** Is anything listening on host:port? up.mjs's probe, for up.mjs's reason: a plain connect, no protocol. */
function defaultProbeTcp(host, port, timeoutMs = 1500) {
	return new Promise((resolvePromise) => {
		const socket = netConnect({ host, port });
		const done = (result) => {
			socket.destroy();
			resolvePromise(result);
		};
		socket.setTimeout(timeoutMs, () => done(false));
		socket.on("connect", () => done(true));
		socket.on("error", () => done(false));
	});
}

/** Exit code of a spawned command; null when it could not launch (not on PATH) — the up.mjs pattern. */
function run(ctx, cmd, args) {
	return new Promise((resolvePromise) => {
		let child;
		try {
			child = ctx.spawn(cmd, args, { stdio: "ignore" });
		} catch {
			resolvePromise(null);
			return;
		}
		child.on("error", () => resolvePromise(null));
		child.on("close", (code) => resolvePromise(code));
	});
}

/**
 * Like runCapture() with the two streams SEPARATE, for a query whose answer is stdout alone (round 2, E2): podman
 * prints warnings on stderr on ordinary accounts, and merged into the answer they made a label read as someone else's.
 */
function runQuery(ctx, cmd, args) {
	return new Promise((resolvePromise) => {
		let child;
		try {
			child = ctx.spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			resolvePromise({ code: null, stdout: "", stderr: "" });
			return;
		}
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (d) => (stdout += d));
		child.stderr?.on("data", (d) => (stderr += d));
		child.on("error", () => resolvePromise({ code: null, stdout, stderr }));
		child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
	});
}

/** Like run() but with stdout+stderr captured, for read-only lookups (nssm status, is-active …). */
function runCapture(ctx, cmd, args) {
	return new Promise((resolvePromise) => {
		let child;
		try {
			child = ctx.spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			resolvePromise({ code: null, output: "" });
			return;
		}
		let output = "";
		child.stdout?.on("data", (d) => (output += d));
		child.stderr?.on("data", (d) => (output += d));
		child.on("error", () => resolvePromise({ code: null, output }));
		child.on("close", (code) => resolvePromise({ code, output }));
	});
}
