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
import { spawnSync } from "node:child_process";
import { chmodSync, closeSync, constants as fsConstants, fstatSync, ftruncateSync, lstatSync, openSync, readFileSync, fsyncSync, writeSync, existsSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { venuesOf } from "./backends.mjs";
import { DEFAULT_VALKEY_URL } from "./config.mjs";
import { deploymentVenueEnv } from "./deployment-venue.mjs";
import { egressArmed, egressProxyName } from "./egress.mjs";
import { GRANT_HELPER_TARGET, GRANTS_TARGET, PRIVATE_DIR_NAME, PRIVATE_DIR_TARGET, PRIVATE_INCLUDE_NAME, PROXY_STATE_FORMAT, parseProxyState, rulesIncludeEndpoints, rulesIncludePrivate } from "./egress-proxy-state.mjs";
import { proxyConfCopyPath } from "./podman-stack.mjs";
import { readEnvAssignments } from "./env-file.mjs";
import { MODEL_ENDPOINTS_INCLUDE_NAME, loadModelEndpoints, renderEndpointsInclude } from "./model-endpoints.mjs";
import { endpointsOverlap, loadPrivateEndpoints, renderPrivateInclude } from "./private-endpoints.mjs";
import { valkeyClientContext } from "./valkey-endpoint.mjs";

const USAGE = `pi-dispatch egress render
    write model-endpoints.conf in this deployment folder from model-endpoints.json (PI_MODEL_ENDPOINTS_FILE
    overrides), in place, and egress-private/private-endpoints.conf from private-endpoints.json
    (PI_PRIVATE_ENDPOINTS_FILE overrides), then print the command that reloads the egress proxy. It never reloads
    the proxy itself.
`;

/** The reload, for one runtime and one proxy name: a reconfigure, never a restart (see the header). */
export function reloadCommand(bin, proxy) {
	return `${bin} exec ${proxy} squid -k reconfigure`;
}

/**
 * A deployment file's path setting as the service reads it: this shell's value where it sets one, else the deployment
 * `.env`'s. Both set differently is refused, since the service runs the file's and a render of the other file would
 * write rules the worker does not believe in. A `.env` line this reader cannot vouch for is refused too. Returns
 * `{ value }` (null for unset) or `{ error }`. `key` is `PI_MODEL_ENDPOINTS_FILE` or, issue #918, `PI_PRIVATE_ENDPOINTS_FILE`;
 * `what` names the declaration in the error.
 */
export function fileSetting(key, what, { env, cwd, platform = process.platform, readEnv = (p) => readFileSync(p), exists = existsSync }) {
	const envPath = join(cwd, ".env");
	const shell = typeof env[key] === "string" ? env[key] : null;
	let file = null;
	if (exists(envPath)) {
		let text;
		try {
			text = String(readEnv(envPath));
		} catch (err) {
			return { error: `${envPath} could not be read (${err?.code ?? err?.message}), so where ${what} are is not known` };
		}
		const loader = platform === "linux" ? "systemd" : platform === "win32" ? "cmd" : "shell";
		const found = readEnvAssignments(text, [key], { loader })[key];
		if (found) {
			if (!found.plain) return { error: `${envPath} line ${found.line} sets ${key} in a way this command cannot read the same as the service does: write it as a plain KEY=value line` };
			file = found.value;
		}
	}
	// Compared as the paths they name, resolved against the deployment folder as the loader resolves them, so
	// `./x.json` and `x.json` agree.
	if (shell !== null && file !== null && (shell === "" || file === "" ? shell !== file : resolve(cwd, shell) !== resolve(cwd, file))) {
		return { error: `${key} is ${JSON.stringify(shell)} in this shell and ${JSON.stringify(file)} in ${envPath}, and the service reads the file's. Make them agree, or unset it in this shell` };
	}
	// Set in this shell alone: the service does not see it, so its worker reads another file than this render did.
	const note = shell !== null && file === null ? `${key} comes from this shell only, and the service reads ${envPath}, which does not set it: put it in ${envPath}, or the worker reads another file than this render did` : null;
	return { value: shell ?? file, note };
}

/** PI_MODEL_ENDPOINTS_FILE as the service reads it (`fileSetting`). */
export function endpointsFileSetting(opts) {
	return fileSetting("PI_MODEL_ENDPOINTS_FILE", "the declared model endpoints", opts);
}

/** Issue #918: PI_PRIVATE_ENDPOINTS_FILE as the service reads it, by the same rule (`fileSetting`). */
export function privateEndpointsFileSetting(opts) {
	return fileSetting("PI_PRIVATE_ENDPOINTS_FILE", "the declared private endpoints", opts);
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
 * What is at the private endpoints' folder (issue #918), by lstat: null for a real folder holding the include as a
 * regular file, else the sentence naming what is there and what to do. The folder is the proxy's mount, so a symlinked
 * folder would put the include wherever the link points, and init refuses it for the same reason.
 */
export function privateDirProblem(cwd, { lstat = lstatSync } = {}) {
	const dir = join(cwd, PRIVATE_DIR_NAME);
	let st;
	try {
		st = lstat(dir);
	} catch (err) {
		if (err?.code === "ENOENT") return `${dir}/ does not exist: \`pi-dispatch init\` in the deployment folder writes it, and the egress proxy mounts it from there. Run this command from that folder`;
		return `${dir}/ could not be read (${err?.code ?? err?.message})`;
	}
	if (st.isSymbolicLink() || !st.isDirectory()) return `${dir} is ${st.isSymbolicLink() ? "a symlink" : "not a directory"}: the proxy mounts the folder itself. Make it a directory of this folder, then \`pi-dispatch init\` writes what goes in it`;
	return includePathProblem(join(dir, PRIVATE_INCLUDE_NAME), { lstat });
}

/**
 * Write `text` to the private endpoints' include BY RENAME (issue #918): a temp file beside it, created exclusively,
 * made 0644, synced, then renamed over the include. The proxy mounts the FOLDER, which sees the rename, so the whole new
 * file replaces the old one at once and a reader never sees half of it. The temp file is removed when anything fails.
 */
export function writeByRename(path, text, fs = { writeFileSync, chmodSync, openSync, fsyncSync, closeSync, renameSync, rmSync }) {
	const tmp = `${path}.render-${process.pid}`;
	try {
		fs.writeFileSync(tmp, text, { flag: "wx", mode: 0o644 });
		// 0644 whatever the umask: squid reads the include as its own `proxy` user, and a 0600 one is a reload that fails.
		fs.chmodSync(tmp, 0o644);
		const fd = fs.openSync(tmp, "r");
		try {
			fs.fsyncSync(fd);
		} finally {
			fs.closeSync(fd);
		}
		fs.renameSync(tmp, path);
	} catch (e) {
		try {
			fs.rmSync(tmp, { force: true });
		} catch {
			// best effort: a leftover temp file is named by its pid and read by nothing
		}
		throw e;
	}
}

/** One bounded, synchronous command for the checks below: `{ code, stdout }`, `code` null when it could not run. */
function runQuiet(bin, args, { input = "" } = {}) {
	const res = spawnSync(bin, args, { input, encoding: "utf8", timeout: 15_000, maxBuffer: 256 * 1024 });
	return { code: typeof res.status === "number" ? res.status : null, stdout: String(res.stdout ?? "") };
}

/**
 * Whether the shipped proxy of one runtime can carry declared private endpoints (issue #918), BEFORE a render that
 * declares any is written: its rules include the private include, it mounts the private folder and its grant folder,
 * and the grant helper answers there as squid's own user. A helper squid cannot run is respawned in a loop that fills
 * its log, and a request to a private endpoint is what starts it (measured, DES-PRIVATE-ENDPOINT-GRANTS), so a rule
 * that would run it is not written while it does not answer. `{ refusal }` names what is wrong and the step that fixes
 * it; `{ note }` says what could not be checked (no proxy running: \`up\` and doctor check it once it runs); `{}` is
 * ready.
 */
export function privateProxyReadiness(venue, { cwd, home, proxy = "pi-dispatch-egress-proxy", exists = existsSync, readRules = (p, enc) => readFileSync(p, enc), run = runQuiet }) {
	const bin = venue === "podman" ? "podman" : "docker";
	const fix = venue === "podman" ? "`pi-dispatch service install --force`" : "`pi-dispatch up`, and accept the refresh";
	const rules = runningRulesPath(venue, { cwd, home });
	if (exists(rules) && !rulesFileIncludes(rules, { readFileSync: readRules }, rulesIncludePrivate)) {
		return { refusal: `the ${venue === "podman" ? "podman proxy's rules (~/.config/pi-dispatch/egress-proxy.conf)" : "proxy's rules (deploy/egress-proxy.conf)"} predate #918 and do not include ${PRIVATE_INCLUDE_NAME}, so a private endpoint would stay unreachable: ${fix}, then render again` };
	}
	const inspect = run(bin, ["inspect", PROXY_STATE_FORMAT, proxy]);
	const state = inspect.code === 0 ? parseProxyState(inspect.stdout) : null;
	if (state?.status !== "running") return { note: `${proxy} is not running under ${bin}, so its grant helper was not checked: \`pi-dispatch up\` and \`pi-dispatch doctor\` check it once it runs` };
	const missing = [PRIVATE_DIR_TARGET, GRANTS_TARGET].filter((target) => !state.mounts.some((m) => m.type === "bind" && m.destination === target));
	if (missing.length > 0) return { refusal: `${proxy} mounts nothing at ${missing.join(" or ")}: it was started before #918, so its rules could not run the grant helper. ${fix} replaces it, then render again` };
	// A line no grant can match: the helper must read it and answer ERR, which proves it runs as squid's user.
	const probe = run(bin, ["exec", "-i", "--user", "proxy", proxy, GRANT_HELPER_TARGET], { input: "0.0.0.0 pi-dispatch-render-check\n" });
	if (probe.code !== 0 || probe.stdout.trim() !== "ERR") {
		return { refusal: `the grant helper ${GRANT_HELPER_TARGET} does not answer inside ${proxy} as squid's user (exit ${probe.code ?? "none"}), and squid would respawn it in a loop on the first request to a private endpoint: make ${join(cwd, PRIVATE_DIR_NAME, "endpoint-grant")} the package's copy, mode 0755 (\`pi-dispatch init\` writes it when it is missing), then render again` };
	}
	return {};
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
		// Issue #918: the private endpoints' loader, writer and the proxy readiness check.
		loadPrivate = loadPrivateEndpoints,
		writePrivate = writeByRename,
		readiness = privateProxyReadiness,
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
	// Issue #918: the private endpoints' file, by the same rule.
	const privateSetting = privateEndpointsFileSetting({ env, cwd, platform, readEnv, exists });
	if (privateSetting.error) {
		err(`✗ ${privateSetting.error}\n`);
		return 1;
	}
	if (privateSetting.note) out(`⚠ ${privateSetting.note}\n`);
	const path = join(cwd, MODEL_ENDPOINTS_INCLUDE_NAME);
	const privatePath = join(cwd, PRIVATE_DIR_NAME, PRIVATE_INCLUDE_NAME);
	// Validated and rendered in memory BEFORE either include is touched: a refused declaration leaves the rules in force.
	// Both files together (issue #918, `endpointsOverlap`): a server declared in both would not be private.
	let text;
	let endpoints;
	let privateText;
	let declared;
	try {
		const valkey = valkeyUrl({ env, cwd });
		endpoints = load({ modelEndpointsFile: setting.value, valkeyUrl: valkey }, { cwd });
		declared = loadPrivate({ privateEndpointsFile: privateSetting.value, valkeyUrl: valkey }, { cwd });
		const overlap = endpointsOverlap(endpoints, declared);
		if (overlap.length > 0) throw new Error(`model-endpoints and private-endpoints disagree: ${overlap[0]}`);
		text = renderEndpointsInclude(endpoints);
		privateText = renderPrivateInclude(declared);
	} catch (e) {
		err(`✗ ${e?.message ?? e}\n${exists(path) ? `${MODEL_ENDPOINTS_INCLUDE_NAME} was not changed, nor was ${PRIVATE_DIR_NAME}/${PRIVATE_INCLUDE_NAME}.` : "Nothing was written."}\n`);
		return 1;
	}
	const problem = includePathProblem(path, { lstat });
	if (problem) {
		err(`✗ ${problem}\n`);
		return 1;
	}
	// Issue #918: a folder made before #918 has no `egress-private/`. With nothing declared there is no private rule to
	// write, so the model endpoints' render goes on and the missing folder is said; with something declared it is refused.
	const privateProblem = privateDirProblem(cwd, { lstat });
	const skipPrivate = privateProblem !== null && declared.length === 0 && !exists(join(cwd, PRIVATE_DIR_NAME));
	if (privateProblem && !skipPrivate) {
		err(`✗ ${privateProblem}\n`);
		return 1;
	}
	const currentOf = (p) => {
		try {
			return String(readInclude(p));
		} catch {
			// Unreadable reads as changed: the write below then says what is wrong.
			return null;
		}
	};
	const current = currentOf(path);
	const privateCurrent = skipPrivate ? privateText : currentOf(privatePath);
	const venue = venueEnv({ env, fs: { existsSync: exists, readFileSync: readEnv }, envPath: join(cwd, ".env"), platform, command: "egress" });
	let armed = true;
	try {
		armed = venue.error ? true : egressArmed(venue.env);
	} catch {
		// A malformed PI_EGRESS is the worker's boot failure, and doctor's to report; it reads as armed here.
	}
	const unchanged = current === text;
	const privateUnchanged = privateCurrent === privateText;
	// Issue #918: a rule that runs the grant helper is written only where the proxy can run it (`privateProxyReadiness`).
	// Checked for a CHANGED include that declares anything, on every runtime this deployment uses, before any write.
	const notes = [];
	if (!privateUnchanged && declared.length > 0 && armed) {
		if (venue.error) {
			err(`✗ the venue could not be read (${venue.error}), so the proxy that would run the private endpoints' grant helper could not be checked. Fix it, then render again.\nNothing was written.\n`);
			return 1;
		}
		const proxy = egressProxyName(venue.env);
		if (proxy === "pi-dispatch-egress-proxy") {
			const venues = venuesOf(venue.env);
			for (const v of [...(venues.localUsed ? ["docker"] : []), ...(venues.podmanUsed ? ["podman"] : [])]) {
				const ready = readiness(v, { cwd, home, proxy, exists, readRules });
				if (ready.refusal) {
					err(`✗ ${ready.refusal}\nNothing was written.\n`);
					return 1;
				}
				if (ready.note) notes.push(ready.note);
			}
		}
	}
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
	if (skipPrivate) {
		out(`⚠ ${join(cwd, PRIVATE_DIR_NAME)}/ is not here, and no private endpoint is declared, so only the model endpoints were rendered. \`pi-dispatch init\` writes it, and the proxy mounts it once \`pi-dispatch up\` refreshes it.\n`);
	} else if (privateUnchanged) {
		out(`✓ ${privatePath} already matches the declared private endpoints: nothing written.\n`);
	} else {
		try {
			writePrivate(privatePath, privateText);
		} catch (e) {
			err(`✗ could not write ${privatePath} (${e?.message ?? e?.code ?? e}). It was not changed: fix the cause and run this command again\n`);
			return 1;
		}
		out(`✓ wrote ${privatePath}\n`);
	}
	for (const note of notes) out(`⚠ ${note}\n`);
	const nothingChanged = unchanged && privateUnchanged;
	if (venue.error) {
		out(`The reload depends on the venue, which could not be read: ${venue.error}\nOn Docker: ${reloadCommand("docker", "pi-dispatch-egress-proxy")}\nOn rootless Podman: ${reloadCommand("podman", "pi-dispatch-egress-proxy")}\n`);
		return 0;
	}
	if (!armed) {
		out("The egress policy is off (PI_EGRESS=0), so no proxy reads these files now. They take effect once the policy is on and the proxy starts.\n");
		return 0;
	}
	const { lines, proxy } = reloadLines(venue.env);
	out(`${nothingChanged ? "If the proxy started before it last changed, reload it" : "Reload the egress proxy so it reads the new rules"} (no restart; open tunnels and running jobs are kept):\n${lines.map((l) => `  ${l}`).join("\n")}\n`);
	if (proxy !== "pi-dispatch-egress-proxy") out(`${proxy} is your own proxy (PI_EGRESS_PROXY): it must mount ${path} at /etc/pi-dispatch/model-endpoints.conf and include it, and mount ${join(cwd, PRIVATE_DIR_NAME)} at ${PRIVATE_DIR_TARGET} and include its ${PRIVATE_INCLUDE_NAME}, as the shipped rules do.\n`);
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

/**
 * Whether the rules file at `path` includes the model endpoints' file, or what `includes` asks (issue #918:
 * `rulesIncludePrivate`, the private endpoints' file). Unreadable or absent reads as no.
 */
export function rulesFileIncludes(path, fs, includes = rulesIncludeEndpoints) {
	try {
		return includes(String(fs.readFileSync(path, "utf8")));
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
export function declaredEndpointsIn({ env, cwd, fs, platform = process.platform, valkeyUrl = null }) {
	try {
		const setting = endpointsFileSetting({ env, cwd, platform, readEnv: (p) => fs.readFileSync(p), exists: (p) => fs.existsSync(p) });
		if (setting.error) return [];
		// `valkeyUrl` null skips the queue-port refusal; doctor's keyless line passes the service's (issue #503), so an
		// endpoint on the queue's port, which refuses the worker's boot, is not called keyless.
		return loadModelEndpoints({ modelEndpointsFile: setting.value, valkeyUrl }, { cwd, readFileSync: (p, enc) => fs.readFileSync(p, enc), existsSync: (p) => fs.existsSync(p) });
	} catch {
		return [];
	}
}
