/**
 * ONE resolver for the keys a pi-dispatch service reads from its deployment's `.env` (issue #471), shared by `doctor`
 * and the admin panel so the two cannot answer "what does the service run with" two ways.
 *
 * The service never sees the environment of the shell an operator runs a command in: under systemd its environment is
 * the unit's plus `EnvironmentFile=`, and the launchd and Windows wrappers source the file inside the child. A worker
 * started by hand (`pi-dispatch worker`) sees that shell and no file at all. A command asked about the deployment
 * cannot tell which of the two runs it, and does not guess. Its rule, the one `up` and doctor already apply to the
 * venue keys (`deploymentVenueEnv`, issue #453) and doctor to `PI_WORKER_NAME` (#464), now for every key:
 *
 *   - this shell's value where it sets the key (an operator who starts the worker by hand from this shell runs it);
 *   - else the `.env` value, read with the service's own loader, from a line that loader reads exactly as written;
 *   - both set and different is a DISAGREEMENT, returned for the caller to report: it is never resolved in silence;
 *   - a line naming the key that the loader reads differently from this reader (a quote, a `$`, a space) is UNREAD:
 *     its value is never used, and the line is named;
 *   - a file the service's loader reads differently somewhere, or refuses to load (`hazard`), gives no value for any
 *     key the file spells, and each such key is named.
 *
 * A key only this shell sets is taken as the shell's and not reported: the service may be given it by its
 * `--env-setup` script or its unit, neither of which a command can read in general.
 *
 * Nothing here loads a `.env` into a process (`docs/secrets.md`): the result is an object the caller judges from.
 */
import { constants as fsConstants } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { SYSTEMD_HAZARD_SHAPES, decodeEnvFile, envFileHazard, readEnvAssignments } from "./env-file.mjs";

/** The loader of the deployment's `.env` on this platform, as `service.mjs` renders it: systemd, the cmd wrapper, or a
 * sourcing shell everywhere else. ONE mapping for every `.env` read. */
export function serviceEnvLoader(platform) {
	return platform === "linux" ? "systemd" : platform === "win32" ? "cmd" : "shell";
}

/**
 * The deployment `.env` as the service is judged by (issue #464, gate round 3): decoded from its BYTES with the
 * hardened reader, and `hazard` set to the first thing the service's loader reads differently from this reader, or
 * refuses to load (a NUL, invalid UTF-8, an environment too big to exec, a lone CR), as `{ line, what, fix }`, or null.
 */
export function serviceEnvFileOf(raw, path, loader) {
	const { text, loadHazard } = decodeEnvFile(raw, { loader });
	const h = loadHazard ?? envFileHazard(text, { loader });
	let hazard = null;
	if (h !== null) {
		const shape = h.shape !== undefined ? SYSTEMD_HAZARD_SHAPES[h.shape] : null;
		hazard = shape ? { line: h.line, what: `has ${shape.what}${h.detail ? ` (${h.detail})` : ""}`, fix: shape.fix } : { line: h.line, what: "is one this command cannot read the way the service's loader will (an open quote, a continuation, or a line that runs)", fix: "fix that line, then re-run doctor" };
	}
	return { text, path, loader, hazard };
}

/**
 * Resolve `keys` by the rule in the header. `env` is this shell's environment, `file` a `serviceEnvFileOf` result or
 * null (no file, or none this command could read). Returns
 * `{ env, fromFile, disagreements, unread, hazardSkipped, shellOnly }`: `env` a copy of this shell's with the file's
 * values filled in, `fromFile` only what the file supplied, `disagreements` `[{ key, shell, file }]`, `unread` `[{ key,
 * line, shellSet }]`, `hazardSkipped` the keys a hazard kept this from reading while this shell sets none of them, and
 * `shellOnly` the keys this shell sets and the file does not.
 */
export function resolveServiceEnv({ env, file, keys }) {
	const resolved = { ...env };
	const out = { env: resolved, fromFile: {}, disagreements: [], unread: [], hazardSkipped: [], shellOnly: [] };
	const wanted = [...new Set(keys)];
	if (!file || wanted.length === 0) return out;
	const reads = readEnvAssignments(file.text, wanted, { loader: file.loader });
	for (const key of wanted) {
		const shell = typeof env[key] === "string" ? env[key] : undefined;
		// The hardened reader's verdict on the whole file: where it has a line the service's loader reads differently, or
		// refuses to load, and spells this key, no value is taken from it, and that is said, never read as "unset".
		if (file.hazard && file.text.includes(key)) {
			if (shell === undefined) out.hazardSkipped.push(key);
			continue;
		}
		// An empty value UNSETS under the cmd wrapper (`set "K="`), so there the service runs without the key.
		const own = file.loader === "cmd" && reads[key]?.plain && reads[key].value === "" ? undefined : reads[key];
		if (own === undefined) {
			// Set only in this shell (issue #471, gate round 1): a worker started from this shell runs with it, a service
			// reading this file does not, so the caller can name it where it knows a service is installed.
			if (shell !== undefined) out.shellOnly.push(key);
			continue;
		}
		if (!own.plain || typeof own.value !== "string") {
			out.unread.push({ key, line: own.line, shellSet: shell !== undefined });
			continue;
		}
		if (shell !== undefined) {
			if (shell !== own.value) out.disagreements.push({ key, shell, file: own.value });
			continue;
		}
		resolved[key] = own.value;
		out.fromFile[key] = own.value;
	}
	return out;
}

/**
 * Account and group names from `/etc/passwd` and `/etc/group`, for a message that names an owner (gate round 3: the
 * panel printed a bare uid). A name that cannot be read is the number, said as such.
 */
export function accountNames(fs) {
	const table = (path) => {
		try {
			return String(fs.readFileSync(path, "utf8")).split("\n").map((l) => l.split(":")).filter((f) => f.length >= 3 && f[0] !== "");
		} catch {
			return [];
		}
	};
	let users = null;
	let groups = null;
	return {
		// This account's own name from the OS where /etc/passwd does not list it (macOS keeps accounts in a directory
		// service), so the panel's line names the owner rather than a number.
		ownerName: (id) => ((users ??= table("/etc/passwd")).find((f) => f[2] === String(id))?.[0] ?? (id === process.geteuid?.() ? safeUserName() : null) ?? `uid ${id}`),
		groupName: (id) => ((groups ??= table("/etc/group")).find((f) => f[2] === String(id))?.[0] ?? `gid ${id}`),
	};
}

function safeUserName() {
	try {
		return userInfo().username || null;
	} catch {
		return null;
	}
}

/**
 * Why `stat` fails the trust rule, in words that are true of it, or null (gate round 3 fixed the wording): owned by `uid`
 * or root and writable by neither its group nor every account. A group-writable file is named with its group, and when
 * that group has the owner's own name (a user-private group, what a umask 002 login makes) the line says so: its
 * members may be the owner alone, which doctor cannot see, and it trusts only a file no group can write.
 */
function trustReason(stat, uid, { ownerName = (id) => `uid ${id}`, groupName = (id) => `gid ${id}` } = {}, path = "") {
	const owned = stat.uid === uid || stat.uid === 0;
	const worldWritable = (stat.mode & 0o002) !== 0;
	const groupWritable = (stat.mode & 0o020) !== 0;
	const stickyRoot = stat.uid === 0 && (stat.mode & 0o1000) !== 0 && stat.isDirectory?.();
	if (owned && ((!worldWritable && !groupWritable) || stickyRoot)) return null;
	const mode = (stat.mode & 0o7777).toString(8).padStart(4, "0");
	const owner = ownerName(stat.uid);
	const at = path ? `${path} ` : "";
	if (!owned) return `${at}is owned by ${owner} with mode ${mode}, not by this account or root`;
	if (worldWritable) return `${at}is owned by ${owner} with mode ${mode}, writable by every account`;
	const group = groupName(stat.gid);
	return `${at}is owned by ${owner} with mode ${mode}, writable by the members of its group ${group}${group === owner ? ` (${owner}'s own group, which may have no other member; doctor trusts only a file no group can write)` : ""}`;
}

/**
 * Whether a `.env` may steer anything (issue #471, gate round 1): `null` when it is owned by `uid` (the account asking)
 * or by root and neither its group nor others may write it, else the reason, naming the owner, the mode and, for a
 * group-writable file, the group. A value in a file another account can write is that account's choice: through a
 * CONTAINERS_CONF naming a containers.conf with a `conmon_path`, a `.env` made doctor's own `podman info` run a program
 * (measured on Podman 5.8.1). `uid` undefined (a platform with no uids) trusts the file. `names` is `accountNames`'s.
 */
export function envFileTrust(stat, uid, names = {}) {
	if (!Number.isInteger(uid) || !stat) return null;
	return trustReason(stat, uid, typeof names === "function" ? { ownerName: names } : names);
}

/**
 * Issue #471 (gate round 2): whether nobody but `uid` and root can change what `realPath` names, as `null` or the reason.
 * Every directory from `/` down to it, and it, must be owned by `uid` or root and writable by neither group nor others;
 * a root-owned directory with the sticky bit (`/tmp`) is the one writable exception, since there only an entry's owner
 * can rename or remove it, and the next component is then judged on its own. Judged with `lstat` on a path `realpath`
 * already resolved, so a component that is a symlink now was swapped in since, and refuses. One trusted-once check of a
 * symlink target was measured racing: another account flipped a DOCKER_CONFIG link between the check and docker's own
 * open, and its plugin ran as the doctor account. A chain nobody else can write cannot be flipped.
 */
export function trustedChain(realPath, { fs, uid, names = {} }) {
	if (!Number.isInteger(uid)) return null;
	const parts = realPath.split("/").filter(Boolean);
	for (let n = 0; n <= parts.length; n++) {
		const here = `/${parts.slice(0, n).join("/")}`;
		let st;
		try {
			st = fs.lstatSync(here);
		} catch (err) {
			return `${here} could not be read (${err?.code ?? err?.message})`;
		}
		if (st.isSymbolicLink?.()) return `${here} became a symbolic link after it was resolved`;
		const why = trustReason(st, uid, names, here);
		if (why !== null) return why;
	}
	return null;
}

/**
 * The deployment `.env` in `dir`, read ONCE through one descriptor (issue #471, gate round 2), shared by doctor and the
 * panel: `{ path, bytes, absent, unreadable, untrusted }`. Measured before: judged by `stat` and then read by path,
 * another account's folder swapped a symlink between the two and its value was taken (2 of 20000 reads). Now the
 * real path is opened with O_NOFOLLOW and O_NONBLOCK (a FIFO then cannot hang the read), judged by `fstat` of that same
 * descriptor, and read from it; the file itself must be this account's or root's and closed (`envFileTrust`), and the
 * deployment folder and the file's own folder, with every ancestor, must pass `trustedChain`, since an account that can
 * write a folder can replace what is in it. `bytes` comes back even from an untrusted file, for a caller that only
 * decides what to SAY from it; `untrusted` is then the reason, and no value may be taken.
 */
export function readDeploymentEnv({ dir, fs, uid = process.geteuid?.(), names = accountNames(fs) }) {
	const path = join(dir, ".env");
	let real;
	try {
		real = fs.realpathSync(path);
	} catch (err) {
		if (err?.code === "ENOENT") return { path, bytes: null, absent: true, unreadable: null, untrusted: null };
		return { path, bytes: null, absent: false, unreadable: err?.code ?? err?.message ?? "error", untrusted: null };
	}
	let fd;
	try {
		fd = fs.openSync(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
	} catch (err) {
		return { path, bytes: null, absent: false, unreadable: err?.code ?? err?.message ?? "error", untrusted: null };
	}
	try {
		const st = fs.fstatSync(fd);
		if (!st.isFile()) return { path, bytes: null, absent: false, unreadable: "not a regular file", untrusted: null };
		const bytes = fs.readFileSync(fd);
		let untrusted = envFileTrust(st, uid, names);
		if (untrusted === null && Number.isInteger(uid)) {
			let folder = null;
			try {
				folder = fs.realpathSync(dir);
			} catch (err) {
				untrusted = `${dir} could not be resolved (${err?.code ?? err?.message})`;
			}
			const why = folder === null ? null : (trustedChain(folder, { fs, uid, names }) ?? trustedChain(dirname(real), { fs, uid, names }));
			if (why) untrusted = `is in a folder another account can change: ${why}`;
		}
		return { path, bytes, absent: false, unreadable: null, untrusted };
	} catch (err) {
		return { path, bytes: null, absent: false, unreadable: err?.code ?? err?.message ?? "error", untrusted: null };
	} finally {
		try {
			fs.closeSync(fd);
		} catch {}
	}
}

/**
 * The `.env` of the deployment in `dir`, read the way doctor reads it (a regular file only, as bytes, one read) and
 * resolved for `keys` (`resolveServiceEnv`). For a caller that has no file of its own in hand (the admin panel).
 * Returns the resolution plus `path`, `unreadable` (a reason, when something is at the path and could not be read) and
 * `untrusted` (`envFileTrust`'s reason); in either case nothing was taken from it.
 */
export function deploymentServiceEnv({ env, dir, keys, platform = process.platform, fs, uid = process.geteuid?.() }) {
	// Issue #471 (gate rounds 1 and 2): one descriptor, and nothing taken from a file another account can change.
	const { path, bytes, unreadable, untrusted } = readDeploymentEnv({ dir, fs, uid });
	const raw = untrusted ? null : bytes;
	const file = raw === null ? null : serviceEnvFileOf(raw, path, serviceEnvLoader(platform));
	return { ...resolveServiceEnv({ env, file, keys }), path, unreadable, untrusted, hazard: file?.hazard ?? null };
}
