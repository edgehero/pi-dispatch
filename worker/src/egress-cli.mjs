/**
 * `pi-dispatch egress render` (issue #503, INT-MODEL-ENDPOINTS-FILE-CONTRACT, INT-EGRESS-POLICY-CONTRACT): writes the
 * egress proxy's include, `model-endpoints.conf` in the deployment folder, from the declared model endpoints, then
 * prints the command that reloads the proxy. It never reloads the proxy itself: the worker does not manage the proxy's
 * lifecycle, and a reload is the operator's step.
 *
 * IN PLACE, and that is the measured part (issue #503, Docker 29.1.3 and rootless and rootful Podman 4.9.3 and 5.8.1 on
 * Linux, 2026-09-30). The include is a single-file bind mount, and such a mount holds the file's inode. A temp file
 * renamed over the path is a new inode the running container never sees, and `squid -k reconfigure` then reloads the
 * OLD rules and says nothing. So the existing file is opened without O_CREAT, truncated and written, and the inode the
 * proxy holds is the one that changes. The render is built and checked in memory first, so a refused declaration never
 * truncates anything.
 *
 * Refused at the path: a symlink (a write through it would land wherever it points, and the mount holds the target,
 * not the link), a directory (Docker creates one for a missing bind source, and squid then reads it as empty with no
 * warning, measured on Docker Desktop), anything else that is not a regular file, and nothing at all. A missing file
 * is not created: `pi-dispatch init` scaffolds it, and a render run from the wrong folder must say so rather than
 * write a file no proxy mounts and then print a reload that changes nothing.
 *
 * The reload is `squid -k reconfigure` through `docker exec` or `podman exec`, on every venue (measured the same day):
 * it re-reads the include and the allowlist in well under a second, keeps the same squid, its networks and their
 * addresses, and keeps every open tunnel, so a running job is not cut off. A restart kills every tunnel, takes about
 * 11 s with this image, and changes the proxy's addresses on Podman.
 */
import { closeSync, constants as fsConstants, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, fsyncSync, writeSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { venuesOf } from "./backends.mjs";
import { DEFAULT_VALKEY_URL } from "./config.mjs";
import { deploymentVenueEnv } from "./deployment-venue.mjs";
import { egressArmed, egressProxyName } from "./egress.mjs";
import { rulesIncludeEndpoints } from "./egress-proxy-state.mjs";
import { proxyConfCopyPath } from "./podman-stack.mjs";
import { readEnvAssignments } from "./env-file.mjs";
import { MODEL_ENDPOINTS_INCLUDE_NAME, loadModelEndpoints, renderEndpointsInclude } from "./model-endpoints.mjs";
import { valkeyClientContext } from "./valkey-endpoint.mjs";

const USAGE = `pi-dispatch egress render
    write model-endpoints.conf in this deployment folder from model-endpoints.json (PI_MODEL_ENDPOINTS_FILE
    overrides), in place, then print the command that reloads the egress proxy. It never reloads the proxy itself.
`;

/** The reload, for one runtime and one proxy name: a reconfigure, never a restart (see the header). */
export function reloadCommand(bin, proxy) {
	return `${bin} exec ${proxy} squid -k reconfigure`;
}

/**
 * PI_MODEL_ENDPOINTS_FILE as the service reads it: this shell's value where it sets one, else the deployment `.env`'s.
 * Both set differently is refused, since the service runs the file's and a render of the other file would write rules
 * the worker does not believe in. A `.env` line this reader cannot vouch for is refused too. Returns `{ value }`
 * (null for unset) or `{ error }`.
 */
export function endpointsFileSetting({ env, cwd, platform = process.platform, readEnv = (p) => readFileSync(p), exists = existsSync }) {
	const envPath = join(cwd, ".env");
	const shell = typeof env.PI_MODEL_ENDPOINTS_FILE === "string" ? env.PI_MODEL_ENDPOINTS_FILE : null;
	let file = null;
	if (exists(envPath)) {
		let text;
		try {
			text = String(readEnv(envPath));
		} catch (err) {
			return { error: `${envPath} could not be read (${err?.code ?? err?.message}), so where the declared model endpoints are is not known` };
		}
		const loader = platform === "linux" ? "systemd" : platform === "win32" ? "cmd" : "shell";
		const found = readEnvAssignments(text, ["PI_MODEL_ENDPOINTS_FILE"], { loader }).PI_MODEL_ENDPOINTS_FILE;
		if (found) {
			if (!found.plain) return { error: `${envPath} line ${found.line} sets PI_MODEL_ENDPOINTS_FILE in a way this command cannot read the same as the service does: write it as a plain KEY=value line` };
			file = found.value;
		}
	}
	// Compared as the paths they name, resolved against the deployment folder as the loader resolves them, so
	// `./x.json` and `x.json` agree.
	if (shell !== null && file !== null && (shell === "" || file === "" ? shell !== file : resolve(cwd, shell) !== resolve(cwd, file))) {
		return { error: `PI_MODEL_ENDPOINTS_FILE is ${JSON.stringify(shell)} in this shell and ${JSON.stringify(file)} in ${envPath}, and the service reads the file's. Make them agree, or unset it in this shell` };
	}
	// Set in this shell alone: the service does not see it, so its worker reads another file than this render did.
	const note = shell !== null && file === null ? `PI_MODEL_ENDPOINTS_FILE comes from this shell only, and the service reads ${envPath}, which does not set it: put it in ${envPath}, or the worker reads another file than this render did` : null;
	return { value: shell ?? file, note };
}

/** VALKEY_URL as the service reads it (the `.env`'s, else this shell's, else the default), for the port refusal. */
function serviceValkeyUrl({ env, cwd }) {
	const context = valkeyClientContext({ env, cwd });
	return context?.url?.file ?? context?.url?.environment ?? DEFAULT_VALKEY_URL;
}

/**
 * What is at the include's path, by lstat (a symlink is judged as itself): `{ ok: true }` for a regular file, else
 * `{ error }` naming what is there and what to do.
 */
export function includePathProblem(path, { lstat = lstatSync } = {}) {
	let st;
	try {
		st = lstat(path);
	} catch (err) {
		if (err?.code === "ENOENT") return `${path} does not exist: \`pi-dispatch init\` in the deployment folder writes it (create-only), and the egress proxy mounts it from there. Run this command from that folder`;
		return `${path} could not be read (${err?.code ?? err?.message})`;
	}
	if (st.isSymbolicLink()) return `${path} is a symlink: the proxy mounts the file itself, so a render through a link could write a file the proxy does not read. Replace the link with a regular file (\`pi-dispatch init\` writes one when nothing is there)`;
	if (st.isDirectory()) return `${path} is a directory, not a file (a runtime creates one when it mounts a path that does not exist), and squid reads it as no rules at all. Remove the directory, then \`pi-dispatch init\` writes the file`;
	if (!st.isFile()) return `${path} is not a regular file`;
	return null;
}

/**
 * Write `text` over the regular file at `path` IN PLACE: no O_CREAT, so nothing new is ever made here; O_NOFOLLOW where
 * the platform has it, so a link swapped in after the check is refused by the kernel; O_TRUNC, so the inode the
 * proxy's mount holds is the one that changes. Then fsync. Throws on any failure.
 */
export function writeInPlace(path, text, fs = { openSync, fstatSync, ftruncateSync, writeSync, fsyncSync, closeSync }) {
	// Opened WITHOUT O_TRUNC, so a refusal below leaves the file as it was; truncated only once it is judged.
	const flags = fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0);
	const fd = fs.openSync(path, flags);
	try {
		const st = fs.fstatSync(fd);
		if (!st.isFile()) throw Object.assign(new Error(`${path} is not a regular file`), { untouched: true });
		// A second name for this inode (a hard link) is a file the render would also rewrite, wherever it is.
		if (st.nlink > 1) throw Object.assign(new Error(`${path} has ${st.nlink} hard links: a write in place would change every one of them. Replace it with a file of its own`), { untouched: true });
		fs.ftruncateSync(fd, 0);
		try {
			const bytes = Buffer.from(text, "utf8");
			let off = 0;
			while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off);
			fs.fsyncSync(fd);
		} catch (e) {
			// A PARTIAL include is not safe: a prefix ending in the middle of an endpoint's lines can be an allow without
			// its port ACL, which opens every port of that host (measured). An EMPTY include is valid and closes every
			// endpoint, so a failed write leaves it empty, never half written.
			try {
				fs.ftruncateSync(fd, 0);
				fs.fsyncSync(fd);
				e.emptied = true;
			} catch {
				e.emptied = false;
			}
			throw e;
		}
	} finally {
		fs.closeSync(fd);
	}
}

/**
 * The reload lines for this deployment's venues: docker's for the docker venue (Docker Engine, Docker Desktop, and
 * rootful Podman through its Docker API, all reached as `docker`), podman's for the native rootless one. Both when
 * the deployment runs both. The proxy's name is PI_EGRESS_PROXY's when it names the operator's own proxy, which then
 * has to mount the include itself.
 */
export function reloadLines(env) {
	const venues = venuesOf(env);
	const proxy = egressProxyName(env);
	const lines = [];
	if (venues.localUsed) lines.push(reloadCommand("docker", proxy));
	if (venues.podmanUsed) lines.push(reloadCommand("podman", proxy));
	return { lines, proxy };
}

/**
 * The verb. `deps` are seams for tests: `cwd`, `env`, `platform`, `out`, `err`, `fsRead` (the include's current text),
 * `lstat`, `write` (the in-place writer), `load` (the endpoints loader), `venueEnv` (the deployment venue resolver).
 */
export async function runEgress(argv = [], deps = {}) {
	const {
		env = process.env,
		cwd = process.cwd(),
		platform = process.platform,
		out = (s) => process.stdout.write(s),
		err = (s) => process.stderr.write(s),
		lstat = lstatSync,
		readInclude = (p) => readFileSync(p, "utf8"),
		write = writeInPlace,
		load = loadModelEndpoints,
		readEnv = (p) => readFileSync(p),
		exists = existsSync,
		venueEnv = (args) => deploymentVenueEnv(args),
		valkeyUrl = serviceValkeyUrl,
		home = homedir(),
		readRules = (p, enc) => readFileSync(p, enc),
	} = deps;
	const sub = argv[0];
	if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
		out(USAGE);
		return sub === undefined ? 1 : 0;
	}
	if (sub !== "render") {
		err(`pi-dispatch egress: unknown subcommand ${JSON.stringify(sub)}\n${USAGE}`);
		return 1;
	}
	if (argv.length > 1) {
		err(`pi-dispatch egress render takes no argument (got ${argv.slice(1).map((a) => JSON.stringify(a)).join(" ")})\n`);
		return 1;
	}
	const setting = endpointsFileSetting({ env, cwd, platform, readEnv, exists });
	if (setting.error) {
		err(`✗ ${setting.error}\n`);
		return 1;
	}
	if (setting.note) out(`⚠ ${setting.note}\n`);
	const path = join(cwd, MODEL_ENDPOINTS_INCLUDE_NAME);
	// Validated and rendered in memory BEFORE the include is touched: a refused declaration leaves the rules in force.
	let text;
	let endpoints;
	try {
		endpoints = load({ modelEndpointsFile: setting.value, valkeyUrl: valkeyUrl({ env, cwd }) }, { cwd });
		text = renderEndpointsInclude(endpoints);
	} catch (e) {
		err(`✗ ${e?.message ?? e}\n${exists(path) ? `${MODEL_ENDPOINTS_INCLUDE_NAME} was not changed.` : `Nothing was written.`}\n`);
		return 1;
	}
	const problem = includePathProblem(path, { lstat });
	if (problem) {
		err(`✗ ${problem}\n`);
		return 1;
	}
	let current = null;
	try {
		current = String(readInclude(path));
	} catch {
		// Unreadable reads as changed: the write below then says what is wrong.
	}
	const venue = venueEnv({ env, fs: { existsSync: exists, readFileSync: readEnv }, envPath: join(cwd, ".env"), platform, command: "egress" });
	const unchanged = current === text;
	if (unchanged) {
		out(`✓ ${path} already matches the declared model endpoints: nothing written.\n`);
	} else {
		try {
			write(path, text);
		} catch (e) {
			const state = e?.untouched ? "It was not changed" : e?.emptied ? "It was EMPTIED rather than left half written, which closes every declared endpoint until a render succeeds" : "It may be partly written";
			err(`✗ could not write ${path} in place (${e?.message ?? e?.code ?? e}). ${state}: fix the cause and run this command again\n`);
			return 1;
		}
		out(`✓ wrote ${path} (in place)\n`);
	}
	if (venue.error) {
		out(`The reload depends on the venue, which could not be read: ${venue.error}\nOn Docker: ${reloadCommand("docker", "pi-dispatch-egress-proxy")}\nOn rootless Podman: ${reloadCommand("podman", "pi-dispatch-egress-proxy")}\n`);
		return 0;
	}
	let armed = true;
	try {
		armed = egressArmed(venue.env);
	} catch {
		// A malformed PI_EGRESS is the worker's boot failure, and doctor's to report; it reads as armed here.
	}
	if (!armed) {
		out("The egress policy is off (PI_EGRESS=0), so no proxy reads this file now. It takes effect once the policy is on and the proxy starts.\n");
		return 0;
	}
	const { lines, proxy } = reloadLines(venue.env);
	out(`${unchanged ? "If the proxy started before it last changed, reload it" : "Reload the egress proxy so it reads the new rules"} (no restart; open tunnels and running jobs are kept):\n${lines.map((l) => `  ${l}`).join("\n")}\n`);
	if (proxy !== "pi-dispatch-egress-proxy") out(`${proxy} is your own proxy (PI_EGRESS_PROXY): it must mount ${path} at /etc/pi-dispatch/model-endpoints.conf and include it, as the shipped rules do.\n`);
	// The one state the reload cannot fix (issue #503): endpoints declared, and the rules the proxy runs predate the include.
	if (proxy === "pi-dispatch-egress-proxy" && endpoints.length > 0) {
		const venues = venuesOf(venue.env);
		for (const v of [...(venues.localUsed ? ["docker"] : []), ...(venues.podmanUsed ? ["podman"] : [])]) {
			const rules = runningRulesPath(v, { cwd, home });
			// No rules file at all is not that state: init or `service install` writes the current rules, include and all.
			if (exists(rules) && !rulesFileIncludes(rules, { readFileSync: readRules })) out(`⚠ ${rulesPredateEndpointsLine(v)}\n`);
		}
	}
	return 0;
}

/**
 * The rules file the shipped proxy runs, per venue (issue #503): docker's mounts the deployment folder's
 * `deploy/egress-proxy.conf`; the rootless podman venue's mounts the account-owned copy `service install` writes.
 */
export function runningRulesPath(venue, { cwd, home }) {
	return venue === "podman" ? proxyConfCopyPath(home) : join(cwd, "deploy/egress-proxy.conf");
}

/** Whether the rules file at `path` includes the model endpoints' file. Unreadable or absent reads as no. */
export function rulesFileIncludes(path, fs) {
	try {
		return rulesIncludeEndpoints(String(fs.readFileSync(path, "utf8")));
	} catch {
		return false;
	}
}

/**
 * THE ONE LINE for endpoints declared under rules that predate #503 (issue #503's governing rule): `up`, `doctor` and
 * `egress render` print it alike. Replacing or reloading the proxy fixes nothing here, since its rules do not read the
 * include; the rules refresh does, and it brings the proxy's third mount with it.
 */
export function rulesPredateEndpointsLine(venue) {
	return venue === "podman"
		? "model endpoints are declared, but the podman proxy's rules (~/.config/pi-dispatch/egress-proxy.conf) predate #503 and do not include model-endpoints.conf, so the endpoints stay unreachable until the rules are refreshed: `pi-dispatch service install --force`"
		: "model endpoints are declared, but deploy/egress-proxy.conf predates #503 and does not include model-endpoints.conf, so the endpoints stay unreachable until the rules are refreshed: `pi-dispatch up`, and accept the refresh";
}

/**
 * Whether model endpoints are declared for this deployment, read as the service reads them. A declaration that does
 * not load counts as none here: doctor names why it does not load, and the worker refuses it.
 */
export function endpointsDeclaredIn({ env, cwd, fs, platform = process.platform }) {
	return declaredEndpointsIn({ env, cwd, fs, platform }).length > 0;
}

/**
 * The declared model endpoints for this deployment, read as the service reads them (the same rule as
 * `endpointsDeclaredIn`, which counts them): `[]` for none, and for a declaration that does not load, which doctor's
 * boot-file line names. Doctor's endpoint rows (issue #503) are built from this list and from nothing else.
 */
export function declaredEndpointsIn({ env, cwd, fs, platform = process.platform }) {
	try {
		const setting = endpointsFileSetting({ env, cwd, platform, readEnv: (p) => fs.readFileSync(p), exists: (p) => fs.existsSync(p) });
		if (setting.error) return [];
		return loadModelEndpoints({ modelEndpointsFile: setting.value, valkeyUrl: null }, { cwd, readFileSync: (p, enc) => fs.readFileSync(p, enc), existsSync: (p) => fs.existsSync(p) });
	} catch {
		return [];
	}
}
