/**
 * A copy of the egress proxy's RULES that has gone stale (issue #484). Two copies of the package's
 * `deploy/egress-proxy.conf` live outside the package: the deployment folder's `deploy/egress-proxy.conf`, which `init`
 * writes create-only (issue #480) and the docker proxy mounts, and the podman venue's account-owned copy,
 * `~/.config/pi-dispatch/egress-proxy.conf`, which `service install` writes (podman-stack.mjs, `proxyConfCopyPath`).
 * Neither is rewritten by an upgrade, so a release that changes the shipped rules leaves the proxy on the old ones, and
 * the mount-path comparison `up` and `doctor` make (egress-proxy-state.mjs) cannot see it: the path is right, only the
 * bytes are old.
 *
 * So the bytes are compared with the INSTALLED package's copy, the one `init` copies from, and a difference is said.
 * Said, never repaired on its own: a difference reads the same whether an upgrade left the file behind or the operator
 * edited it on purpose, and nothing here can tell the two apart. `doctor` warns (⚠: a differing copy still runs a
 * proxy, and may be exactly what the operator meant); `up` offers the refresh, shown and asked, and keeps the old file.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The proxy's RULES (INT-EGRESS-POLICY-CONTRACT), the package's own copy: `../deploy/` from this module, the layout
 * service.mjs resolves its templates by, which is worker/deploy in a checkout (byte-identical to the root deploy/,
 * pinned by worker/test/publish.test.mjs) and the shipped deploy/ under npm. Issue #480: the docker proxy mounts
 * `./deploy/egress-proxy.conf` from the deployment folder, and a folder made by `npx @edgehero/pi-dispatch up` had
 * none, so `up` declined to start the proxy the policy is on by default for and every job was refused before it spent.
 */
export const PACKAGED_EGRESS_PROXY_CONF = fileURLToPath(new URL("../deploy/egress-proxy.conf", import.meta.url));

/** The installed package's version, for the words "the package's copy (<version>)". Null when it cannot be read. */
export const PACKAGE_VERSION = (() => {
	try {
		const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
		return typeof version === "string" ? version : null;
	} catch {
		return null;
	}
})();

/** The installed package's rules, as text: the file `init` copies. */
export function readPackagedProxyConf() {
	return String(readFileSync(PACKAGED_EGRESS_PROXY_CONF, "utf8"));
}

/** "the package's copy (2.0.0)", or without the version where it could not be read. */
export function packageCopyName(version = PACKAGE_VERSION) {
	return version ? `the package's copy (${version})` : "the package's copy";
}

/**
 * A short account of how `current` differs from `packaged`, by lines counted as a multiset (a line's order is not
 * compared, only whether it is there, which is what an operator reading the summary asks first). `diff` is named for
 * the rest. Never the lines themselves: a rules file is short, but a summary that quoted it would print an operator's
 * own edit into every doctor run.
 */
export function describeConfDifference(current, packaged) {
	// Line endings alone (PR #491's review): an editor or a checkout that wrote CRLF changes every line, and "66 lines of
	// it not in the package's copy" then reads as a rewrite. Said as what it is, naming which side has which.
	const lf = (text) => String(text).replace(/\r\n/g, "\n");
	if (lf(current) === lf(packaged)) {
		const crlf = (text) => String(text).includes("\r\n");
		return `only in its line endings, ${crlf(current) ? "CRLF" : "LF"} here and ${crlf(packaged) ? "CRLF" : "LF"} in the package's`;
	}
	const count = (text) => {
		const m = new Map();
		for (const line of String(text).split("\n")) m.set(line, (m.get(line) ?? 0) + 1);
		return m;
	};
	const a = count(current);
	const b = count(packaged);
	let onlyHere = 0;
	let onlyThere = 0;
	for (const [line, n] of a) onlyHere += Math.max(0, n - (b.get(line) ?? 0));
	for (const [line, n] of b) onlyThere += Math.max(0, n - (a.get(line) ?? 0));
	if (onlyHere === 0 && onlyThere === 0) return "the same lines, in another order";
	const lines = (n) => `${n} line${n === 1 ? "" : "s"}`;
	return `${lines(onlyHere)} of it not in the package's copy, ${lines(onlyThere)} of the package's not in it`;
}

/**
 * Judges one copy against the package's: `{ state }` is "absent" (nothing to compare; whoever mounts it says so),
 * "same", "differs" (with `summary`), "unreadable" (with `error`, the copy could not be read), or "no-package" (with
 * `error`, the package's own copy could not be read, which is a broken install and said as one). `read(path)` reads the
 * copy; `readPackaged()` the package's.
 */
export function judgeProxyConfCopy({ path, read, readPackaged = readPackagedProxyConf }) {
	let current;
	try {
		current = String(read(path));
	} catch (err) {
		if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return { state: "absent" };
		return { state: "unreadable", error: err?.code ?? err?.message ?? String(err) };
	}
	let packaged;
	try {
		packaged = String(readPackaged());
	} catch (err) {
		return { state: "no-package", error: err?.code ?? err?.message ?? String(err) };
	}
	if (current === packaged) return { state: "same" };
	return { state: "differs", summary: describeConfDifference(current, packaged), packaged };
}

/** A timestamp for a backup's name, from the injected clock: 20260929T101500Z. No colon, which Windows refuses. */
export function backupStamp(now) {
	return new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

/**
 * Replaces the copy at `path` with `text`, keeping the old bytes as `<path>.bak-<stamp>` (issue #484). Returns
 * `{ ok: true, backup }` or `{ ok: false, reason }`, where `reason` finishes the sentence "not replaced: ...".
 *
 * NO SYMLINK IS FOLLOWED, and both ends are asked with `lstat`: a symlinked parent (`deploy/` a link) would put the new
 * file and the backup wherever it points, and a symlinked file would have the backup read through it; both are refused
 * with nothing written, as `init` refuses a symlinked `deploy/` (PR #488's review). Anything that is not a regular file
 * is refused too.
 *
 * ATOMIC: the new text is written to a temp file in the SAME directory (`wx`, so nothing that exists is written through)
 * and renamed over the copy, so a reader (a proxy starting this second) sees the old file or the new one, never half of
 * either, and a failed write leaves the old file exactly as it was. `rename` replaces the directory ENTRY, so a link
 * that appeared at `path` after the check is replaced, never written through. The backup is written `wx` before the
 * rename, so a backup that could not be written replaces nothing. A second refresh in the same second finds the backup
 * name taken and refuses rather than overwrite the first backup.
 */
export function replaceProxyConfCopy({ path, text, fs, now = Date.now, random = () => randomBytes(6).toString("hex") }) {
	if (typeof fs.lstatSync !== "function") return { ok: false, reason: "this build cannot check the path for a symlink, so it is left as it is" };
	const dir = dirname(path);
	const lst = (p) => {
		try {
			return fs.lstatSync(p);
		} catch {
			return null;
		}
	};
	const parent = lst(dir);
	if (!parent || parent.isSymbolicLink() || !parent.isDirectory()) return { ok: false, reason: `${dir} is ${!parent ? "not there" : parent.isSymbolicLink() ? "a symlink" : "not a directory"}, and the new file would be written wherever it leads` };
	const own = lst(path);
	if (!own) return { ok: false, reason: `${path} is not there` };
	if (own.isSymbolicLink()) return { ok: false, reason: `${path} is a symlink, and the file it points to is not this folder's to replace` };
	if (!own.isFile()) return { ok: false, reason: `${path} is not a regular file` };
	const mode = typeof own.mode === "number" ? own.mode & 0o777 : 0o644;
	let previous;
	try {
		previous = fs.readFileSync(path);
	} catch (err) {
		return { ok: false, reason: `${path} could not be read (${err?.code ?? err?.message})` };
	}
	const backup = `${path}.bak-${backupStamp(now())}`;
	try {
		fs.writeFileSync(backup, previous, { flag: "wx", mode });
	} catch (err) {
		return { ok: false, reason: `the backup ${backup} could not be written (${err?.code ?? err?.message}), so the copy was not touched` };
	}
	const tmp = join(dir, `.${basename(path)}.tmp-${random()}`);
	try {
		fs.writeFileSync(tmp, text, { flag: "wx", mode });
		fs.renameSync(tmp, path);
	} catch (err) {
		try {
			fs.unlinkSync(tmp);
		} catch {
			// Never written, or already renamed: nothing to take back.
		}
		return { ok: false, reason: `the new file could not be written beside it (${err?.code ?? err?.message}); the copy is as it was, and ${backup} holds the same bytes` };
	}
	return { ok: true, backup };
}
