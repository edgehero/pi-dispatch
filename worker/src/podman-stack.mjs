/**
 * The native rootless `podman` venue's long-lived stack as Quadlet units (issue #430): Valkey, and while the egress
 * policy is armed the allowlist proxy on its named route-out network. ONE installer, used by both
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
import { join } from "node:path";
import { DEFAULT_EGRESS_PROXY, egressProxyName } from "./egress.mjs";
import { envFileHazard, readEnvAssignments } from "./env-file.mjs";

/**
 * The Quadlet files, in the order they are shown and written. `unit` is the service the generator makes of each; the
 * networks' units are pulled in by the containers' own `Requires=` (Quadlet adds it for `Network=X.network`), so only
 * the two container services are ever started by name.
 */
export const QUADLET_FILES = Object.freeze({
	valkeyNetwork: Object.freeze({ file: "pi-dispatch-valkey.network", unit: "pi-dispatch-valkey-network.service" }),
	valkey: Object.freeze({ file: "pi-dispatch-valkey.container", unit: "pi-dispatch-valkey.service", container: "pi-dispatch-valkey" }),
	egressNetwork: Object.freeze({ file: "pi-dispatch-egress-out.network", unit: "pi-dispatch-egress-out-network.service" }),
	proxy: Object.freeze({ file: "pi-dispatch-egress-proxy.container", unit: "pi-dispatch-egress-proxy.service", container: DEFAULT_EGRESS_PROXY }),
});

/** Every Quadlet file this project ships, for uninstall and status, which act on what exists rather than on a plan. */
export const ALL_QUADLET_FILES = Object.freeze(Object.values(QUADLET_FILES));

/** The two placeholders the proxy's template carries, and what each becomes (TEMPLATE_PINS in service.mjs pins both). */
export const PROXY_CONF_PLACEHOLDER = "/opt/pi-dispatch/deploy/egress-proxy.conf";
export const ALLOWLIST_PLACEHOLDER = "/opt/pi-dispatch/egress-allowlist.conf";

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
 */
export function stackComponents({ venues, env, includeValkey, armed }) {
	const notes = [];
	const valkey = !venues.localUsed && includeValkey;
	let proxy = false;
	if (armed) {
		const name = egressProxyName(env);
		if (name === DEFAULT_EGRESS_PROXY) proxy = true;
		else notes.push(`PI_EGRESS_PROXY names ${name}, your own proxy: the shipped ${DEFAULT_EGRESS_PROXY} unit is not installed for it, because its \`--replace\` would remove any container of that name. Keep ${name} running under this account's Podman yourself`);
	}
	return { valkey, proxy, notes };
}

/**
 * The files and commands for `components`, rendered from the shipped templates (`readTemplate(name)`, separate from
 * `fs` because the templates are the PACKAGE's files while `fs` is the host's, and a caller's fake of the one is not a
 * fake of the other). Returns `{ error }` for a path the
 * proxy's mounts cannot carry, else `{ dir, files: [{ path, text, unit, state }], start: [units], actions }`, where
 * `state` is "new", "same" or "changed" against what is on disk, and `actions` is exactly what `applyStack` does,
 * in order: the caller shows these lines, and a test holds the two equal.
 */
export function planStack({ components, templatesDir, deployDir, home, fs, readTemplate = (name) => fs.readFileSync(join(templatesDir, name), "utf8") }) {
	const dir = quadletDir(home);
	const picked = [];
	if (components.valkey) picked.push(QUADLET_FILES.valkeyNetwork, QUADLET_FILES.valkey);
	if (components.proxy) picked.push(QUADLET_FILES.egressNetwork, QUADLET_FILES.proxy);
	const conf = join(templatesDir, "egress-proxy.conf");
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
		return { path, text, unit, state };
	});
	const containers = files.filter((f) => f.path.endsWith(".container"));
	const start = containers.map((f) => f.unit);
	// A container whose OWN file changed is RESTARTED, not started: `start` on an active unit is a no-op, so a replaced
	// file would otherwise change nothing until the next reboot while the command said it was done. Only the
	// .container file counts. A changed .network file cannot change an existing network (its unit runs
	// `podman network create --ignore`), so restarting the container over it would cost the proxy's per-job networks
	// and apply nothing.
	const restart = containers.filter((f) => f.state === "changed").map((f) => f.unit);
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
 * `runCapture(cmd, args)` resolves `{ code, output }`. A non-zero exit is "no such container". Returns
 * `[{ container, unit, label }]`, empty when nothing would be replaced that is not already ours.
 */
export async function foreignContainers(plan, runCapture) {
	const found = [];
	for (const q of [QUADLET_FILES.valkey, QUADLET_FILES.proxy]) {
		if (!plan.start.includes(q.unit)) continue;
		const res = await runCapture("podman", ["container", "inspect", "--format", '{{index .Config.Labels "PODMAN_SYSTEMD_UNIT"}}', q.container]);
		if (res.code !== 0) continue;
		const label = String(res.output ?? "").trim();
		if (label !== q.unit) found.push({ container: q.container, unit: q.unit, label });
	}
	return found;
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
 * docker-shaped worker for a podman deployment, and the opposite guess a stack for a docker one.
 */
export const STACK_KEYS = Object.freeze(["PI_BACKENDS", "PI_EGRESS", "PI_EGRESS_PROXY"]);

export function readStackKeys(text, { loader = "systemd", path = ".env" } = {}) {
	const lines = String(text ?? "").split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
	const mention = new RegExp(`(?:^|[^A-Za-z0-9_])(${STACK_KEYS.join("|")})(?![A-Za-z0-9_])`);
	const exact = new RegExp(`^[ \\t]*(${STACK_KEYS.join("|")})=`);
	let mentioned = null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (/^[ \t]*#/.test(line)) continue;
		const m = mention.exec(line);
		if (!m) continue;
		mentioned ??= { key: m[1], line: i + 1 };
		if (!exact.test(line)) {
			return { error: `${path} line ${i + 1} mentions ${m[1]} in a form other than a plain ${m[1]}=value line, which the loaders do not agree on (systemd sets \`${m[1]} =x\` and ignores \`export ${m[1]}=x\`; the shells do the opposite). Whether this deployment runs the podman venue is therefore unknown: write it as a plain ${m[1]}=value line` };
		}
	}
	if (mentioned && envFileHazard(text, { loader }) !== null) {
		const at = envFileHazard(text, { loader }).line;
		return { error: `${path} line ${at} is one this command cannot read (an open quote, a continuation, or a line that runs), and the file assigns ${mentioned.key}, so what the service reads for it is unknown. Fix that line first` };
	}
	const found = readEnvAssignments(text, STACK_KEYS, { loader });
	const keys = {};
	for (const key of STACK_KEYS) {
		const read = found[key];
		if (!read) continue;
		if (!read.plain) return { error: `${path} line ${read.line} assigns ${key} in a form this command cannot read the way the service's loader will ($, quotes, spaces or a backslash in the value), so whether this deployment runs the podman venue is unknown. Write it as a plain ${key}=value line` };
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
				fs.mkdirSync(plan.dir, { recursive: true });
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
