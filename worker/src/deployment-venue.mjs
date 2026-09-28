/**
 * WHICH VENUE A DEPLOYMENT RUNS, decided one way for every command that asks (issue #453): `up` since #430, and `init`
 * (its next steps) and `doctor` (what it judges) since #453, which read only their shell before and so answered for a
 * different venue than the service they described. The deployment's `.env` is read with `readStackKeys`, exactly as
 * `service install` reads it, and a key this shell sets differently stops the command, since the service runs the file.
 */
import { parseBackendList } from "./backends.mjs";
import { egressArmed, egressProxyName } from "./egress.mjs";
import { envValueShown } from "./env-file.mjs";
import { STACK_KEYS, readStackKeys } from "./podman-stack.mjs";

/** How each command says what a shell/file disagreement would make it do, the clause before "while the service ...". */
const COMMAND_SAYS = Object.freeze({
	up: "up would drive the shell's venue",
	init: "init's next steps would be for the shell's venue",
	doctor: "doctor would judge the shell's venue",
});

/**
 * The venue keys this pass decides with (D2): this shell's value where it sets one, else the deployment `.env`'s, read
 * with `readStackKeys` exactly as `service install` reads them. Returns `{ env, fromFile, disagreements }` or
 * `{ error }`. `env` is the whole environment with the file's keys filled in; `fromFile` is only what the file
 * supplied, for doctor's layering; `disagreements` names each key both set differently.
 */
export function deploymentVenueEnv({ env, fs, envPath, platform, command = "up", loader: loaderGiven = null, keys: keysWanted = STACK_KEYS }) {
	let keys = {};
	const notes = [];
	// The loader of the file on THIS platform, as service.mjs reads it (round 2, E6): systemd's EnvironmentFile= on
	// Linux, the sh wrapper on macOS, the cmd wrapper on Windows. Off Linux the venue refuses the host anyway, so a
	// line that platform's loader reads differently is noted and never stops `up`.
	const linux = platform === "linux";
	// A caller with a mapping of its own passes it (doctor, so every `.env` read it makes uses one loader).
	const loader = loaderGiven ?? (linux ? "systemd" : platform === "darwin" ? "shell" : "cmd");
	if (fs.existsSync(envPath)) {
		let text = null;
		try {
			// Bytes, not text: `readStackKeys` checks what systemd refuses to load before it decodes (issue #447).
			text = fs.readFileSync(envPath);
		} catch (err) {
			// Said rather than silent (round 2 nit): the venue then comes from this shell alone.
			notes.push(`${envPath} could not be read (${err?.message}), so PI_BACKENDS, PI_EGRESS and PI_EGRESS_PROXY come from this shell alone`);
		}
		if (text !== null) {
			const read = readStackKeys(text, { loader, path: envPath });
			if (read.error && linux) return { error: read.error };
			if (read.error) notes.push(`${read.error}; off Linux the podman venue refuses this host anyway, so this pass reads the venue from this shell`);
			else keys = read.keys;
		}
	}
	const merged = { ...env };
	const fromFile = {};
	const conflicts = [];
	// Only the keys the caller allows are taken from the file (doctor's `SERVICE_ENV_KEYS`); all of them by default.
	for (const key of STACK_KEYS.filter((k) => keysWanted.includes(k))) {
		if (!Object.hasOwn(keys, key)) continue;
		if (typeof env[key] === "string") {
			// Compared as the worker READS them (round 3, D4), not as strings: ` podman` and `podman,podman` are the list
			// `podman`, and refusing them sent an operator to reconcile two values that already agree.
			if (venueKeyMeaning(key, env[key]) !== venueKeyMeaning(key, keys[key])) conflicts.push(`${key} is ${quotedShown(env[key])} in this shell and ${quotedShown(keys[key])} in ${envPath}`);
			continue;
		}
		merged[key] = keys[key];
		fromFile[key] = keys[key];
	}
	// A KNOWN disagreement is a refusal (round 2, E5), not a warning: this pass would stand up one venue's stack and the
	// service installed next would run the other. The file is what the service runs, so it is the one to change unless
	// the shell's value was a one-off.
	if (conflicts.length > 0) {
		return { error: `${conflicts.join("; ")}. ${COMMAND_SAYS[command] ?? COMMAND_SAYS.up} while the service runs the file's. Make them agree: change ${envPath} (what the service reads), or unset the key in this shell` };
	}
	return { env: merged, fromFile, notes };
}

/**
 * What a venue key MEANS to the worker, for comparing two spellings of it: the parsed list for PI_BACKENDS, on or off
 * for PI_EGRESS, the resolved name for PI_EGRESS_PROXY exactly as egressProxyName resolves it (empty is the default
 * name; NOT trimmed, because nothing that reads the name trims it, so " x" and "x" are different proxies to the worker
 * and to podman). A value the worker would refuse keeps its raw spelling, so two different unreadable values still
 * disagree and the doctor below names them.
 */
function venueKeyMeaning(key, value) {
	try {
		if (key === "PI_BACKENDS") return `list:${parseBackendList(value).join(",")}`;
		if (key === "PI_EGRESS") return `egress:${egressArmed({ PI_EGRESS: value }) ? "on" : "off"}`;
		return `proxy:${egressProxyName({ PI_EGRESS_PROXY: value })}`;
	} catch {
		return `raw:${value}`;
	}
}

/** A value shown in quotes, so a leading space or an empty value is visible; control characters escaped as ever. */
function quotedShown(value) {
	const shown = envValueShown(value);
	return shown.startsWith('"') ? shown : `"${shown}"`;
}
