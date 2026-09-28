/**
 * The native rootless `podman` venue's long-lived stack as Quadlet units (issue #430): Valkey, and while the egress
 * policy is armed the allowlist proxy on its named route-out network and the rootless network keeper (issue #458) on a
 * network of its own. ONE installer, used by both
 * `pi-dispatch service install` (user scope) and `pi-dispatch up`, on up.mjs's own doctrine that two ways of starting
 * one thing is two places for it to drift.
 *
 * Quadlet rather than `podman run --restart`: rootless Podman has no daemon to restart anything, so a container
 * started by hand is gone after a reboot. `podman-restart.service` could bring back `--restart=always` containers,
 * but it is a unit the operator would have to enable separately and it orders nothing; a Quadlet unit is a real
 * systemd user unit the worker's own unit can `Wants=`/`After=`. Measured on Fedora 44 with Podman 5.8.1:
 *   - `NetworkName=` and `ContainerName=` give exactly those names (no `systemd-` prefix), and `Network=X.network`
 *     resolves through the network file's `NetworkName=`.
 *   - `systemctl --user enable` REFUSES a generated unit ("transient or generated"); the generator reads the
 *     file's own `[Install] WantedBy=default.target` instead. So install is: write the files, daemon-reload,
 *     `systemctl --user start`. Never enable.
 *   - With linger on, the units were active 25 s after a reboot with nobody logged in; with linger off they did
 *     not start at all. Hence the linger read after every install.
 *   - `systemctl --user restart` of the proxy creates a NEW container (`--replace --rm`), and every per-job network
 *     the worker had connected to the old one is gone. New jobs connect at their start and are fine; see docs.
 *
 * This module decides and describes; it spawns only through the `run` seam it is handed and writes only through the
 * `fs` seam, so `service` and `up` each keep their own spawn helpers and their own tests' fakes.
 */
import { dirname, join } from "node:path";
import { DEFAULT_EGRESS_PROXY, egressProxyName } from "./egress.mjs";
import { SYSTEMD_HAZARD_SHAPES, decodeEnvFile, envFileHazard, envFileSystemdHazard, envFileValueLines, quotedRegions, readEnvAssignments } from "./env-file.mjs";
import { NETNS_KEEPER, NETNS_KEEPER_FORMAT, NETNS_KEEPER_NOW_FORMAT, STARTED_AT_FORMAT, NETNS_KEEPER_MIN_AGE_MS, NETNS_KEEPER_AFTER_PROXY_GRACE_MS, judgeNetnsKeeper, podmanNeedsNetnsKeeper, makeDetachGate, detachBlockedSentence, DETACH_GATE_READ_TIMEOUT_MS, DETACH_GATE_READ_MAX_BUFFER, runtimeFromFacts } from "./netns-keeper.mjs";

// The keeper's identity, its judge and the network detach gate live in the leaf `netns-keeper.mjs` (issue #452, gate
// round 3), because `egress.mjs`, which this module imports, routes every detach through that gate. Re-exported here.
export { NETNS_KEEPER, NETNS_KEEPER_FORMAT, NETNS_KEEPER_NOW_FORMAT, STARTED_AT_FORMAT, NETNS_KEEPER_MIN_AGE_MS, NETNS_KEEPER_AFTER_PROXY_GRACE_MS, judgeNetnsKeeper, podmanNeedsNetnsKeeper, makeDetachGate, detachBlockedSentence, DETACH_GATE_READ_TIMEOUT_MS, DETACH_GATE_READ_MAX_BUFFER, runtimeFromFacts };

/**
 * What to run for a keeper that does not hold: the proxy's restart when that is the damage the order rule cannot rule
 * out (`restartProxy`), else the keeper's own `reset-failed` and restart.
 */
export function netnsKeeperRemedy(judged, proxy) {
	const restartProxy = proxyRestartAdvice(proxy);
	if (judged.restartProxy) return restartProxy;
	if (judged.thenRestartProxy) return `start it as the worker's account: ${NETNS_KEEPER_START}, then ${restartProxy}, since the proxy has been up since before it`;
	return `start it as the worker's account: ${NETNS_KEEPER_START}`;
}

/** "restart the egress proxy once no job is running: <the command for this proxy's name>". */
export function proxyRestartAdvice(proxy) {
	return proxy === DEFAULT_EGRESS_PROXY ? `restart the egress proxy once no job is running: systemctl --user restart ${DEFAULT_EGRESS_PROXY}.service (podman restart ${DEFAULT_EGRESS_PROXY} for one started by hand)` : `restart the egress proxy once no job is running: podman restart ${proxy} (or its own unit)`;
}

/**
 * The installer's hint (PR #463 round 3): a plan that starts the keeper for the first time or restarts it, while the
 * proxy is NOT in the plan (an operator's own PI_EGRESS_PROXY, or `up` leaving a running proxy alone), leaves a proxy up
 * since before the keeper, which the worker's order rule then answers with a retry and a request for the proxy's
 * restart. So both commands say it now, with the proxy's real name. `null` when nothing of that happened.
 */
export function keeperUnderRunningProxyHint(plan, proxy, { keeperStarting = null } = {}) {
	const keeper = plan.files?.find((f) => f.unit === QUADLET_FILES.keeper.unit);
	if (!keeper) return null;
	const restarted = (plan.restart ?? []).includes(keeper.unit);
	// `keeperStarting`: a caller that knows the keeper was not running (`up` plans it only then) says so; otherwise a
	// file the plan writes new, or a restart, is what moves it (a `start` over a running unit changes nothing).
	if (!(keeperStarting ?? (keeper.state === "new" || restarted))) return null;
	if ((plan.start ?? []).includes(QUADLET_FILES.proxy.unit)) return null;
	return `${NETNS_KEEPER} was ${restarted ? "restarted" : "started"} while the egress proxy (${proxy}) is not part of this install: if it is running, ${proxyRestartAdvice(proxy)}; on Podman 4.x the worker retries every egress job, asking for exactly that, until the proxy has started after the keeper`;
}

/**
 * The start command every "the keeper is not holding" message names (doctor, the worker's preflight).
 */
export const NETNS_KEEPER_START = `systemctl --user reset-failed ${NETNS_KEEPER}-network.service ${NETNS_KEEPER}.service; systemctl --user restart ${NETNS_KEEPER}-network.service ${NETNS_KEEPER}.service`;

/**
 * The Quadlet files, in the order they are shown and written. `unit` is the service the generator makes of each; the
 * networks' units are pulled in by the containers' own `Requires=` (Quadlet adds it for `Network=X.network`), so only
 * the container services are ever started by name.
 */
export const QUADLET_FILES = Object.freeze({
	valkeyNetwork: Object.freeze({ file: "pi-dispatch-valkey.network", unit: "pi-dispatch-valkey-network.service" }),
	valkey: Object.freeze({ file: "pi-dispatch-valkey.container", unit: "pi-dispatch-valkey.service", container: "pi-dispatch-valkey" }),
	egressNetwork: Object.freeze({ file: "pi-dispatch-egress-out.network", unit: "pi-dispatch-egress-out-network.service" }),
	proxy: Object.freeze({ file: "pi-dispatch-egress-proxy.container", unit: "pi-dispatch-egress-proxy.service", container: DEFAULT_EGRESS_PROXY }),
	keeperNetwork: Object.freeze({ file: `${NETNS_KEEPER}.network`, unit: `${NETNS_KEEPER}-network.service` }),
	keeper: Object.freeze({ file: `${NETNS_KEEPER}.container`, unit: `${NETNS_KEEPER}.service`, container: NETNS_KEEPER }),
});

/** Every Quadlet file this project ships, for uninstall and status, which act on what exists rather than on a plan. */
export const ALL_QUADLET_FILES = Object.freeze(Object.values(QUADLET_FILES));

/** The two placeholders the proxy's template carries, and what each becomes (TEMPLATE_PINS in service.mjs pins both). */
export const PROXY_CONF_PLACEHOLDER = "/opt/pi-dispatch/deploy/egress-proxy.conf";
export const ALLOWLIST_PLACEHOLDER = "/opt/pi-dispatch/egress-allowlist.conf";

/**
 * Where the proxy's RULES are mounted from: an account-owned COPY of the package's `egress-proxy.conf`, never the
 * package file itself (issue #430 review round 2, E1). The mount carries `z`, which relabels the file, and rootless
 * Podman cannot relabel a file this account does not own: measured on Fedora 44 with the package installed by
 * `sudo npm i -g` under /usr/local/lib/node_modules, the unit failed with `lsetxattr ... operation not permitted`,
 * exit 126. A copy under this account's own config directory can always be relabelled, and is written, compared and
 * forced exactly like the Quadlet files (a planned write, shown before it happens). Not the deployment folder: that
 * is the operator's and may be shared with another account; this file belongs to the account whose Podman mounts it.
 */
export function proxyConfCopyPath(home) {
	return join(home, ".config", "pi-dispatch", "egress-proxy.conf");
}

/**
 * Where the user's Quadlet files live. ALWAYS `~/.config/containers/systemd`, deliberately not `$XDG_CONFIG_HOME`
 * from this shell: the generator runs in the user MANAGER's environment, which usually has no XDG_CONFIG_HOME at
 * all, so a shell that exports one would put the files where the generator never looks, and install would report a
 * start failure for units that simply do not exist.
 */
export function quadletDir(home) {
	return join(home, ".config", "containers", "systemd");
}

/**
 * Characters a path may not carry into a Quadlet `Volume=`. Each is a real parse on the way to `podman run`: `:`
 * splits the volume spec itself; whitespace splits the `RequiresMountsFor=` list Quadlet adds for every absolute
 * source; `%` is a systemd specifier there; `$` is expanded by systemd in the generated `ExecStart=` (`${X}` and
 * `$X` alike); quotes and backslashes are systemd's quoting; control bytes end the line.
 * Refused rather than escaped: none of the escapes was measured, and a unit that fails at boot is the worst place to
 * find out.
 */
const UNSAFE_VOLUME_PATH = /[:\s%$"'\\\x00-\x1f\x7f]/;

/**
 * What the stack for this deployment should hold, and why each part is or is not in it. Pure: every fact is a
 * parameter, so `service` and `up` can each answer "is it listening" and "is it already installed" their own way
 * and get the same rule.
 *
 *   valkey   only where `local` is NOT blessed. With `local` in the list, docker is on this host and its Valkey
 *            (compose, or up's docker step) is the queue, as it always was; a second Valkey on the same port would
 *            only fail to bind. Then `includeValkey` (the caller's own "listening / already installed" answer).
 *   proxy    only while the egress policy is armed, and only under the default name. A PI_EGRESS_PROXY naming
 *            another container is the operator's own proxy: a Quadlet of that name would `podman run --replace`
 *            it away, so it is left alone and the reason is said.
 *   keeper   whenever the egress policy is armed (issue #458), WHATEVER the proxy's name: the worker disconnects the
 *            proxy from every egress job's network, an operator's own proxy as much as ours, and that disconnect is
 *            what Podman 4.9 turns into a dead route out. On every Podman version, since on 5.x it is one idle
 *            container (measured harmless on 5.8.1), and a rule with no version read in it cannot misread one.
 */
export function stackComponents({ venues, env, includeValkey, armed }) {
	const notes = [];
	const valkey = !venues.localUsed && includeValkey;
	const keeper = armed === true;
	let proxy = false;
	if (armed) {
		const name = egressProxyName(env);
		if (name === DEFAULT_EGRESS_PROXY) proxy = true;
		else notes.push(`PI_EGRESS_PROXY names ${name}, your own proxy: the shipped ${DEFAULT_EGRESS_PROXY} unit is not installed for it, because its \`--replace\` would remove any container of that name. Keep ${name} running under this account's Podman yourself`);
	}
	return { valkey, proxy, keeper, notes };
}

/**
 * The files and commands for `components`, rendered from the shipped templates (`readTemplate(name)`, separate from
 * `fs` because the templates are the PACKAGE's files while `fs` is the host's, and a caller's fake of the one is not a
 * fake of the other). Returns `{ error }` for a path the
 * proxy's mounts cannot carry, else `{ dir, files: [{ path, text, unit, state }], start: [units], actions }`, where
 * `state` is "new", "same" or "changed" against what is on disk, and `actions` is exactly what `applyStack` does,
 * in order: the caller shows these lines, and a test holds the two equal.
 */
export function planStack({ components, templatesDir, deployDir, home, fs, readTemplate = (name) => fs.readFileSync(join(templatesDir, name), "utf8"), restartUnits = [] }) {
	const dir = quadletDir(home);
	const picked = [];
	if (components.valkey) picked.push(QUADLET_FILES.valkeyNetwork, QUADLET_FILES.valkey);
	if (components.proxy) picked.push(QUADLET_FILES.egressNetwork, QUADLET_FILES.proxy);
	if (components.keeper) picked.push(QUADLET_FILES.keeperNetwork, QUADLET_FILES.keeper);
	const conf = proxyConfCopyPath(home);
	const allowlist = join(deployDir, "egress-allowlist.conf");
	if (components.proxy) {
		for (const p of [conf, allowlist]) {
			if (UNSAFE_VOLUME_PATH.test(p)) {
				return { error: `the egress proxy's Quadlet unit would mount ${JSON.stringify(p)}, and a Quadlet Volume= cannot carry a colon, whitespace, %, $, a quote, a backslash or a control byte in a path (each is split or expanded on the way to podman run). Move the deployment folder, or start the proxy by hand (docs/podman.md)` };
			}
		}
	}
	const files = picked.map(({ file, unit }) => {
		let text = String(readTemplate(file));
		if (file === QUADLET_FILES.proxy.file) {
			// Function replacements: a computed path is the REPLACEMENT, and String.replace reads `$&` out of a string one.
			text = text.replace(`Volume=${PROXY_CONF_PLACEHOLDER}:`, () => `Volume=${conf}:`).replace(`Volume=${ALLOWLIST_PLACEHOLDER}:`, () => `Volume=${allowlist}:`);
		}
		const path = join(dir, file);
		let state = "new";
		if (fs.existsSync(path)) {
			let current = null;
			try {
				current = String(fs.readFileSync(path, "utf8"));
			} catch {
				// Unreadable reads as changed: the write below is then what tells the operator.
			}
			state = current === text ? "same" : "changed";
		}
		// `restarts`: the unit a CHANGE to this file must restart. A .container file restarts its own unit; a .network file
		// restarts nothing, because its unit runs `podman network create --ignore`, which cannot change an existing
		// network, so restarting the container over it would cost the proxy's per-job networks and apply nothing.
		return { path, text, unit, state, restarts: file.endsWith(".container") ? unit : null };
	});
	if (components.proxy) {
		// The account-owned copy of the rules (E1), placed before the proxy's unit so it exists when the unit starts.
		// squid reads it only at start, so a changed copy restarts the proxy, as a changed unit file does.
		const text = String(readTemplate("egress-proxy.conf"));
		let state = "new";
		if (fs.existsSync(conf)) {
			let current = null;
			try {
				current = String(fs.readFileSync(conf, "utf8"));
			} catch {
				// Unreadable reads as changed, as for the unit files.
			}
			state = current === text ? "same" : "changed";
		}
		files.splice(files.findIndex((f) => f.unit === QUADLET_FILES.proxy.unit), 0, { path: conf, text, unit: null, state, restarts: QUADLET_FILES.proxy.unit, kind: "conf" });
	}
	const containers = files.filter((f) => f.path.endsWith(".container"));
	const start = containers.map((f) => f.unit);
	// A unit whose file changed is RESTARTED, not started: `start` on an active unit is a no-op, so a replaced file
	// would otherwise change nothing until the next reboot while the command said it was done.
	// `restartUnits`: units the caller knows are up but wrong with their files unchanged (PR #463 round 2: `up` meeting a
	// Quadlet keeper that does not hold, a paused one say), where `start` would be the same no-op.
	const restart = start.filter((u) => restartUnits.includes(u) || files.some((f) => f.state === "changed" && f.restarts === u));
	// A keeper (re)started under a proxy that stays up is what the worker and doctor read as possible damage (issue #458,
	// PR #463 round 2): a teardown while it was down cuts the proxy's route out for good, nothing outside shows it, so
	// both ask for a proxy restart whenever the keeper started more than the grace (15 s) after the proxy. So a plan that
	// restarts the keeper, or starts it beside a proxy whose unit file it leaves as it was (an upgrade: that proxy has
	// been up all along), restarts the proxy with it. Both files new is a first install: both start together.
	const keeperFile = files.find((f) => f.unit === QUADLET_FILES.keeper.unit);
	const proxyFile = files.find((f) => f.unit === QUADLET_FILES.proxy.unit);
	const keeperMoves = keeperFile && (restart.includes(keeperFile.unit) || keeperFile.state === "new");
	if (keeperMoves && proxyFile && proxyFile.state === "same" && !restart.includes(proxyFile.unit)) restart.push(proxyFile.unit);
	const fresh = start.filter((u) => !restart.includes(u));
	const actions = [];
	for (const f of files) if (f.state !== "same") actions.push({ kind: "write", path: f.path });
	if (files.length > 0) {
		// daemon-reload even when every file is unchanged: a file written by an earlier run that failed before its own
		// reload is otherwise invisible to the manager, and the reload is idempotent.
		actions.push({ kind: "run", argv: ["systemctl", "--user", "daemon-reload"] });
		if (fresh.length > 0) actions.push({ kind: "run", argv: ["systemctl", "--user", "start", ...fresh] });
		if (restart.length > 0) actions.push({ kind: "run", argv: ["systemctl", "--user", "restart", ...restart] });
	}
	return { dir, files, start, restart, actions };
}

/** The measured cost of restarting the proxy, said wherever a plan restarts it. */
export function proxyRestartWarning(plan) {
	if (!plan.restart?.includes(QUADLET_FILES.proxy.unit)) return null;
	return `restarting ${QUADLET_FILES.proxy.unit} makes a NEW proxy container (measured: the unit runs podman run --replace --rm), so a job running right now loses its only route out for the rest of that run. Pause first if one is (pi-dispatch pause, wait for active jobs, then pi-dispatch resume)`;
}

/**
 * Containers this plan would REPLACE without owning them (issue #430 review). A Quadlet container unit runs
 * `podman run --replace`, which removes any container of the same name, running or not: a proxy started by hand from
 * docs/podman.md, with every job's per-job network on it, would vanish without a word. One rule for both commands and
 * both containers: a container of the unit's name that does not carry the `PODMAN_SYSTEMD_UNIT` label naming OUR unit
 * is someone else's, and the caller refuses unless told to replace it. Podman labels a container with the unit
 * that started it from the `PODMAN_SYSTEMD_UNIT` variable the generated unit sets (the auto-update mechanism reads
 * the same label).
 *
 * `runQuery(cmd, args)` resolves `{ code, stdout, stderr }`, the two streams SEPARATE (round 2, E2): podman prints
 * warnings on stderr on an ordinary account ("cgroupv2 manager is set to systemd but there is no systemd user session
 * available", "/ is not a shared mount"), and a merged capture made our own containers read as foreign. Only stdout
 * is the label.
 *
 * FAILS CLOSED (round 2, E3). podman exits 125 for a container that does not exist AND for a store it cannot open
 * ("database is locked"), so a non-zero exit is "absent" only when stderr says no such container or object; any other
 * failure means the state is not known, and a caller must not run a `--replace` into it.
 *
 * Returns `{ found: [{ container, unit, label }], unknown: [{ container, detail }] }`.
 */
export async function foreignContainers(plan, runQuery) {
	const found = [];
	const unknown = [];
	for (const q of [QUADLET_FILES.valkey, QUADLET_FILES.proxy, QUADLET_FILES.keeper]) {
		if (!plan.start.includes(q.unit)) continue;
		const res = await runQuery("podman", ["container", "inspect", "--format", '{{index .Config.Labels "PODMAN_SYSTEMD_UNIT"}}', q.container]);
		if (res.code === 0) {
			const label = String(res.stdout ?? "").trim();
			if (label !== q.unit) found.push({ container: q.container, unit: q.unit, label });
			continue;
		}
		if (res.code !== null && /no such (container|object)/i.test(String(res.stderr ?? ""))) continue;
		unknown.push({ container: q.container, detail: res.code === null ? "podman could not be run" : `podman container inspect exited ${res.code} without saying the container does not exist` });
	}
	return { found, unknown };
}

/** The refusal for containers whose state could not be read. Not forceable: `--replace` into an unknown is a guess. */
export function unknownContainerRefusal(unknown) {
	return `whether ${unknown.map((u) => u.container).join(" and ")} already ${unknown.length === 1 ? "exists" : "exist"} could not be read (${unknown.map((u) => u.detail).join("; ")}). The unit's podman run --replace would remove whatever is there, so nothing is installed until podman answers: check \`podman ps -a\` as this account, then re-run`;
}

/**
 * The refusal when this process cannot reach its own user manager (round 2, E8, measured). `sudo -iu <account>` is the
 * natural way to act as a dedicated account and gives neither XDG_RUNTIME_DIR nor a session bus, so every
 * `systemctl --user` fails with "Failed to connect to user scope bus"; checked BEFORE anything is written, so a
 * refused run leaves no Quadlet file behind that nothing loaded. `null` when either is set.
 */
export function userBusRefusal({ env, user, euid }) {
	// env-internal XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: how systemctl --user finds the user manager; set by a login.
	if (env?.XDG_RUNTIME_DIR || env?.DBUS_SESSION_BUS_ADDRESS) return null;
	const uid = Number.isInteger(euid) ? euid : "<uid>";
	return `this shell has no user manager to talk to (neither XDG_RUNTIME_DIR nor DBUS_SESSION_BUS_ADDRESS is set, as under \`sudo -iu ${user}\`), so \`systemctl --user\` would fail after the files were written. Run it from a real login as ${user}, or \`machinectl shell ${user}@\`, or, while ${user}'s manager is running (linger on), \`sudo -iu ${user} env XDG_RUNTIME_DIR=/run/user/${uid} pi-dispatch ...\``;
}

/**
 * The user MANAGER's own environment, read before anything is written (PR #463 round 3, measured). Every Quadlet unit
 * this installer starts, and the worker unit, runs with the manager's environment, and the Quadlet generator reads its
 * unit files from the manager's XDG_CONFIG_HOME. On a host whose /etc/environment names another account's
 * XDG_RUNTIME_DIR or XDG_CONFIG_HOME (Ubuntu's user managers read /etc/environment through environment.d; a GitHub
 * runner image writes both), measured on Podman 4.9.3: the generator looked in the other home and the units were "not
 * found" (exit 5), and with that fixed, every podman command in a unit failed "XDG_RUNTIME_DIR directory
 * \"/run/user/1001\" is not owned by the current user". This installer writes to ~/.config/containers/systemd (see
 * `quadletDir`), so either value being another account's makes a stack that cannot start. `read` is
 * `systemctl --user show-environment`'s `{ code, stdout }`; `null` when both are this account's own or unset.
 * A manager that did not answer is left to the commands that follow, whose failures are said already.
 */
/**
 * One value as `systemctl --user show-environment` prints it (PR #463 round 3): plain when it needs no quoting, else
 * shell-quoted as `$'...'` with C escapes (systemd's shell_maybe_quote with ESCAPE_POSIX), so a home with a space reads
 * `XDG_CONFIG_HOME=$'/home/a b/.config'`. Anything else is taken as printed.
 */
export function unquoteShowEnvironment(value) {
	const m = /^\$'(.*)'$/s.exec(value);
	if (!m) return value;
	return m[1].replace(/\\(x[0-9a-fA-F]{1,2}|[0-7]{1,3}|.)/g, (_all, e) => {
		const simple = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };
		if (e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
		if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
		return Object.hasOwn(simple, e) ? simple[e] : e;
	});
}

export function managerEnvRefusal(read, { home, euid, user, realpath = (p) => p }) {
	if (read?.code !== 0) return null;
	const env = {};
	for (const line of String(read.stdout ?? "").split("\n")) {
		const eq = line.indexOf("=");
		if (eq > 0) env[line.slice(0, eq)] = unquoteShowEnvironment(line.slice(eq + 1));
	}
	// A symlinked home (PR #463 round 3): the same directory under two spellings is the same directory.
	const same = (a, b) => {
		const tidy = (p) => p.replace(/\/+$/, "");
		if (tidy(a) === tidy(b)) return true;
		try {
			return tidy(realpath(tidy(a))) === tidy(realpath(tidy(b)));
		} catch {
			return false;
		}
	};
	const wrong = [];
	// env-internal XDG_RUNTIME_DIR, XDG_CONFIG_HOME: read from the user MANAGER's show-environment, never this process's.
	const ownRuntime = Number.isInteger(euid) ? `/run/user/${euid}` : null;
	if (env.XDG_RUNTIME_DIR !== undefined && ownRuntime !== null && !same(env.XDG_RUNTIME_DIR, ownRuntime)) wrong.push(`XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR}, not ${ownRuntime}: every podman command in a unit would fail ("XDG_RUNTIME_DIR directory ... is not owned by the current user", measured)`);
	const ownConfig = typeof home === "string" && home ? join(home, ".config") : null;
	if (env.XDG_CONFIG_HOME !== undefined && ownConfig !== null && !same(env.XDG_CONFIG_HOME, ownConfig)) wrong.push(`XDG_CONFIG_HOME=${env.XDG_CONFIG_HOME}, not ${ownConfig}: the Quadlet generator would look for the units there, not in ${quadletDir(home)} where they are written, and say they do not exist (measured)`);
	if (wrong.length === 0) return null;
	return `${user}'s user manager runs with ${wrong.join("; and ")}. That environment is what every unit it starts inherits, so nothing is installed. Find where it is set (a line in /etc/environment, which Ubuntu's user managers read through environment.d, or a file in ~/.config/environment.d), override it for this account in ~/.config/environment.d/ (for example a file zz-pi-dispatch.conf with ${ownRuntime ? `XDG_RUNTIME_DIR=${ownRuntime}` : "XDG_RUNTIME_DIR=/run/user/<uid>"}${ownConfig ? ` and XDG_CONFIG_HOME=${ownConfig}` : ""}), restart the manager (sudo systemctl restart user@${Number.isInteger(euid) ? euid : "<uid>"}.service, which stops this account's units), check \`systemctl --user show-environment\`, and re-run`;
}

/** The refusal for `foreignContainers`' answer, naming both ways out. */
export function foreignContainerRefusal(found, { forceHint }) {
	const names = found.map((f) => f.container).join(" and ");
	return `${names} already ${found.length === 1 ? "exists" : "exist"} under this account's Podman and ${found.length === 1 ? "is" : "are"} not managed by the Quadlet ${found.length === 1 ? "unit" : "units"} (started by hand, or by an older setup). The unit's podman run --replace would remove ${found.length === 1 ? "it" : "them"} without asking, and a proxy takes every running job's per-job network with it. Remove ${found.length === 1 ? "it" : "them"} yourself (podman rm -f ${found.map((f) => f.container).join(" ")}), or ${forceHint}`;
}

/**
 * The three stack keys as a deployment's `.env` assigns them, for the loader that reads that file (issue #430 review,
 * D6). `{ keys }` (only keys the file assigns), or `{ error }` when a line touching one of them is in a form this
 * reader cannot vouch for. A key with NO record is not proof of no assignment: `PI_BACKENDS =podman` is set by
 * systemd 252 (measured, see env-file.mjs's ASSIGNMENT) and produces no record here, `export PI_BACKENDS=podman` is
 * ignored by systemd and set by the shells, and a line inside a multi-line quote belongs to the value above it. Any
 * such line, or any file-level hazard while a key is mentioned at all, refuses: guessing "no podman" installs a
 * docker-shaped worker for a podman deployment, and the opposite guess a stack for a docker one. So does a line systemd
 * splits differently from this reader (`envFileSystemdHazard`, issue #447), for the whole file.
 */
export const STACK_KEYS = Object.freeze(["PI_BACKENDS", "PI_EGRESS", "PI_EGRESS_PROXY"]);

/** The longest venue-key value `readStackKeys` accepts, in bytes (issue #447 gate round 2; systemd's own limit is ~128 KiB). */
export const STACK_VALUE_MAX = 4096;

/** A sourcing shell's named hazard (a NUL, a CRLF file), as the sentence that names it and its fix. systemd's shapes are refused above. */
function shapedRefusal(path, hazard, why) {
	const shape = SYSTEMD_HAZARD_SHAPES[hazard.shape];
	return `${path} line ${hazard.line} has ${shape.what}, and ${why}, so what the service reads for it is unknown: ${shape.fix}`;
}

export function readStackKeys(content, { loader = "systemd", path = ".env", assumeSpelled = false } = {}) {
	// The file's BYTES where the caller has them (issue #447, gate round 1): systemd refuses to LOAD a file with a NUL
	// or with invalid UTF-8 in a key or value, and the unit then fails with every key unset, which no reading of the
	// decoded text can see. Refused whatever the file assigns, because the service does not start on it at all.
	const { text, loadHazard } = decodeEnvFile(content, { loader });
	if (loadHazard !== null) {
		const shape = SYSTEMD_HAZARD_SHAPES[loadHazard.shape];
		return { error: `${path} line ${loadHazard.line} has ${shape.what}${loadHazard.detail ? ` (${loadHazard.detail})` : ""}: ${shape.fix}` };
	}
	const lines = String(text ?? "").split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	// A line TOUCHES a key when the key is its leading word, `export ` allowed: that is where a loader could read an
	// assignment of it. A key name inside another key's value (`PI_ENV_SETUP=/opt/PI_BACKENDS.sh`) touches nothing.
	const touches = new RegExp(`^[ \\t]*(?:export[ \\t]+)?(${STACK_KEYS.join("|")})(?![A-Za-z0-9_])`);
	// `export K=v` is an assignment only to a loader that SOURCES the file (the macOS wrapper); systemd ignores it.
	const exact = new RegExp(`^[ \\t]*${loader === "shell" ? "(?:export[ \\t]+)?" : ""}(${STACK_KEYS.join("|")})=`);
	// A `#` line is a comment to every loader. A `;` line (a comment to systemd's EnvironmentFile=) needs no rule of its
	// own: its leading word is `;`, never a key, so it touches nothing and is not refused (the round 2 nit).
	const comment = /^[ \t]*#/;
	// WHERE systemd AND THIS READER DISAGREE ABOUT WHAT A LINE IS (issue #447): a lone CR, a quote reopened after a
	// close, a quoted value under a non-identifier key, a continuation the line scan misses, a quoted value whose extent
	// the reader's region model gets wrong. Refused rather than modelled, for the whole file, because such a line can
	// move a venue key into or out of another value anywhere below it, or split one out of the middle of a line
	// (`X=1<CR>PI_BACKENDS=podman`, which the `touches` scan above never sees).
	//
	// GATED on a venue key being SPELLED where a loader could read it as one, which is sound: systemd builds a key only
	// from contiguous text on one line, and a line that starts with `#` or `;` is a comment to it except for text after
	// a lone CR, which systemd reads as a line break (`# note<CR>PI_BACKENDS=podman` sets the key, measured). So a key
	// spelled on a non-comment line counts, and on a comment line only after a lone CR on that same line; a comment
	// that is really the tail of a continuation is value text, split into a line again only by such a CR. Counting
	// every comment spelling refused every docker deployment with an unrelated odd line, since `init` copies
	// `.env.example`, which spells all three keys in comments (gate round 1), and counting them all whenever the file
	// had a lone CR ANYWHERE did the same for a CR on another line (gate round 2). `assumeSpelled` is for a caller about
	// to WRITE a key into this file (the setup wizard), which must refuse on any hazard before it changes a byte.
	// A comment is a line that STARTS as one: a `#` line inside a value or a continuation for this loader is part of that
	// value, and to a shell part of the joined line (`X=a\` + `#;PI_EGRESS=0` sets PI_EGRESS, gate round 2).
	const afterLoneCr = (l) => (l.includes("\r") ? l.slice(l.indexOf("\r") + 1) : "");
	const inValue = loader === "cmd" ? [] : envFileValueLines(text, { loader });
	const spelledOutside = (commentLine) => (assumeSpelled ? STACK_KEYS[0] : STACK_KEYS.find((k) => lines.some((l, i) => (commentLine.test(l) && !inValue[i] ? afterLoneCr(l) : l).includes(k))));
	if (loader === "systemd") {
		const h = envFileSystemdHazard(text);
		const spelled = h === null ? undefined : spelledOutside(/^[ \t]*[#;]/);
		if (h !== null && spelled !== undefined) {
			const shape = SYSTEMD_HAZARD_SHAPES[h.shape];
			return { error: `${path} line ${h.line} has ${shape.what}. The service's systemd would read the lines of this file differently from this command, so which venue keys (${STACK_KEYS.join(", ")}) it sets is unknown: ${shape.fix}` };
		}
	}
	let touched = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (comment.test(line)) continue;
		const m = touches.exec(line);
		if (!m) continue;
		touched ??= { key: m[1], line: i + 1 };
		if (!exact.test(line)) {
			return { error: `${path} line ${i + 1} assigns ${m[1]} in a form other than a plain ${m[1]}=value line, which the loaders do not agree on (systemd sets \`${m[1]} =x\` and ignores \`export ${m[1]}=x\`; the shells do the opposite). Whether this deployment runs the podman venue is therefore unknown: write it as a plain ${m[1]}=value line` };
		}
	}
	if (touched) {
		// A value that OPENS with a quote continues across lines in systemd's parser until that quote closes (round 2,
		// E4: systemd's test-env-file.c, env_file_6), so a key line INSIDE such a value is part of it, not an
		// assignment. The general reader knows this too since #447; this check stays for the sentence it can say. Only a
		// key line inside a still-open region is in doubt (round 3, D1): the documented multi-line
		// GITHUB_APP_PRIVATE_KEY="-----BEGIN ...-----" closes, and a PI_BACKENDS above or below it reads normally
		// (measured on systemd 259: the unit saw both). A quote that never closes runs to the end of the file, so every
		// key line after it is in doubt.
		if (loader !== "cmd") {
			const regions = quotedRegions(text);
			for (let i = 0; i < lines.length; i++) {
				const m = touches.exec(lines[i]);
				if (!m || comment.test(lines[i])) continue;
				const inside = regions.find((r) => i + 1 > r.open && (r.close === null || i + 1 <= r.close));
				if (inside) {
					return { error: `${path} line ${i + 1} (${m[1]}) lies inside the quoted value that opens on line ${inside.open}${inside.close === null ? " and never closes" : ` and closes on line ${inside.close}`}, so the service reads it as part of that value, not as ${m[1]}. Close that quote on its own line, write the value's newlines as \\n escapes, or for a GitHub App key use GITHUB_APP_PRIVATE_KEY_PATH` };
				}
			}
		}
		const hazard = envFileHazard(text, { loader });
		if (hazard?.shape?.startsWith("shell-")) return { error: shapedRefusal(path, hazard, `the file assigns ${touched.key}`) };
		if (hazard !== null) {
			return { error: `${path} line ${hazard.line} is one this command cannot read (an open quote, a continuation, or a line that runs), and the file assigns ${touched.key}, so what the service reads for it is unknown. Fix that line first` };
		}
	} else if (loader === "shell" || (assumeSpelled && loader !== "cmd")) {
		// A sourcing shell can assign a key in the MIDDLE of a line (`X=a PI_EGRESS=0` is two assignments), which touches
		// no line at its start, so here the shell's file-level hazard is asked whenever a key is spelled on a line that is
		// not a comment (issue #447, gate round 1; the same gate as systemd's above, with `#` the shells' only comment).
		const named = spelledOutside(/^[ \t]*#/);
		const hazard = named === undefined ? null : envFileHazard(text, { loader });
		const why = assumeSpelled ? "a venue key is about to be written into it" : `the file names ${named}`;
		if (hazard?.shape?.startsWith("shell-")) return { error: shapedRefusal(path, hazard, why) };
		if (hazard !== null) {
			return { error: `${path} line ${hazard.line} is one this command cannot read (an open quote, a continuation, a line that runs, or a second assignment on one line), and ${why}, so what the service reads for it is unknown. Fix that line first` };
		}
	}
	const found = readEnvAssignments(text, STACK_KEYS, { loader });
	const keys = {};
	for (const key of STACK_KEYS) {
		const read = found[key];
		if (!read) continue;
		if (!read.plain) return { error: `${path} line ${read.line} assigns ${key} in a form this command cannot read the way the service's loader will ($, quotes, spaces or a backslash in the value), so whether this deployment runs the podman venue is unknown. Write it as a plain ${key}=value line` };
		// THE PROJECT'S OWN CAP, not systemd's (gate round 3 corrected the wording): systemd 259 passes a value up to about
		// 128 KiB, and past that the whole environment is `envFileLoadHazard`'s `exec-too-large`. A venue key names a list,
		// a switch or a container, so 4096 bytes is far more than one needs, and a longer one is a mistake worth naming.
		if (Buffer.byteLength(read.value, "utf8") > STACK_VALUE_MAX) return { error: `${path} line ${read.line} assigns ${key} a value of ${Buffer.byteLength(read.value, "utf8")} bytes, and a venue value longer than ${STACK_VALUE_MAX} bytes is refused by pi-dispatch (a venue key never needs that much; systemd itself passes up to about 128 KiB). Shorten it to at most ${STACK_VALUE_MAX} bytes` };
		keys[key] = read.value;
	}
	return { keys };
}

/** The shown form of one action. `applyStack` runs the same objects these lines were made from. */
export function describeAction(action) {
	return action.kind === "write" ? `write ${action.path}` : action.argv.join(" ");
}

/**
 * Carry out `plan.actions`, in order, stopping at the first failure. `run(cmd, args)` resolves an exit code, null for
 * a command that could not launch. Returns `{ ok: true }` or `{ ok: false, failed, code }`.
 */
export async function applyStack(plan, { fs, run }) {
	const byPath = new Map(plan.files.map((f) => [f.path, f]));
	for (const action of plan.actions) {
		if (action.kind === "write") {
			try {
				fs.mkdirSync(dirname(action.path), { recursive: true });
				fs.writeFileSync(action.path, byPath.get(action.path).text);
			} catch (err) {
				return { ok: false, failed: describeAction(action), code: null, message: err?.message };
			}
			continue;
		}
		const [cmd, ...args] = action.argv;
		const code = await run(cmd, args);
		if (code !== 0) return { ok: false, failed: describeAction(action), code };
	}
	return { ok: true };
}

/**
 * The worker unit's dependency lines on the stack. `Wants=`, never `Requires=`: a Valkey that failed to start must not
 * also take the worker down with it, since the worker's own queue connection retries and says why, and a proxy that
 * is down refuses jobs pre-spend by itself. `After=` so a boot starts the queue before the worker reaches for it.
 */
export function workerUnitDeps(units) {
	if (units.length === 0) return "";
	return `# Added by \`pi-dispatch service install\` for the podman venue (issue #430): the Quadlet units it installed.\nWants=${units.join(" ")}\nAfter=${units.join(" ")}\n`;
}

/**
 * Linger, read without side effects. `loginctl show-user <user> -p Linger` prints `Linger=yes|no`, and unlike
 * `systemctl --machine=<user>@ --user status` it does not START the user manager it asks about (measured: that probe
 * starts it, and the units with it, which would report a boot-time answer that is not one). Returns true, false, or
 * null when loginctl could not answer.
 */
export async function readLinger(user, runCapture) {
	const res = await runCapture("loginctl", ["show-user", user, "-p", "Linger"]);
	if (res.code !== 0) return null;
	const m = /^Linger=(yes|no)\s*$/m.exec(String(res.output ?? ""));
	return m ? m[1] === "yes" : null;
}

/** The sentence for each linger answer, shared by `service install` and `up`. */
export function lingerNote(linger, user) {
	if (linger === true) return `linger is on for ${user}: measured, the Quadlet units come back at boot with nobody logged in\n`;
	if (linger === false) return `⚠ linger is OFF for ${user}: measured, without it neither these Quadlet units nor a user-scope worker start at boot. Turn it on:  sudo loginctl enable-linger ${user}\n`;
	return `note: could not read linger for ${user} (loginctl did not answer). Without linger these units start only while you have a session:  sudo loginctl enable-linger ${user}\n`;
}
