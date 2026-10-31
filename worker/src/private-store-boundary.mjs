import * as realFs from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { isDeterminateFsCode } from "./transient.mjs";

export const LOCAL_FOLDER_HOLDS_SUBSCRIPTION_AUTH = "local-folder-holds-subscription-auth";

export function insideDirectory(base, path) {
	const rel = relative(resolve(base), resolve(path));
	return rel === "" || rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function boundaryError(error) {
	return Object.assign(new Error("the private subscription store boundary could not be read"), {
		code: isDeterminateFsCode(error?.code) ? error.code : "EIO",
		transient: !isDeterminateFsCode(error?.code),
	});
}

/** Resolve existing parents even before login creates the store. A dangling symlink still has a target. */
export function canonicalFuturePath(path, { fs = realFs } = {}) {
	let cursor = resolve(path);
	let pending = [];
	let links = 0;
	for (;;) {
		try {
			return resolve((fs.realpathSync?.native ?? fs.realpathSync)(cursor), ...pending);
		} catch (error) {
			if (!["ENOENT", "ENOTDIR"].includes(error?.code)) throw boundaryError(error);
		}
		try {
			if (fs.lstatSync(cursor).isSymbolicLink()) {
				if (++links > 40) throw Object.assign(new Error(), { code: "ELOOP" });
				cursor = resolve(dirname(cursor), fs.readlinkSync(cursor), ...pending);
				pending = [];
				continue;
			}
		} catch (error) {
			if (!["ENOENT", "ENOTDIR"].includes(error?.code)) throw boundaryError(error);
		}
		const parent = dirname(cursor);
		if (parent === cursor) throw boundaryError({ code: "ENOENT" });
		pending.unshift(basename(cursor));
		cursor = parent;
	}
}

function identityAt(path, fs) {
	try {
		const stat = fs.statSync(path, { bigint: true });
		return `${stat.dev}:${stat.ino}`;
	} catch (error) {
		if (["ENOENT", "ENOTDIR"].includes(error?.code)) return null;
		throw boundaryError(error);
	}
}

/** Host-only mount check, repeated at preparation against the exact resolved /workspace source. */
export function privateStoreExposed(folder, storeDir, { fs = realFs, resolvedFolder = null } = {}) {
	if (!storeDir || typeof folder !== "string" || folder.length === 0) return false;
	const mount = resolvedFolder ?? canonicalFuturePath(folder, { fs });
	const store = canonicalFuturePath(storeDir, { fs });
	if (insideDirectory(mount, store)) return true;
	// Directory identity also catches case aliases, firmlinks and bind aliases whose realpath spellings differ.
	const mountedId = identityAt(mount, fs);
	if (mountedId === null) return false;
	for (let ancestor = store;; ancestor = dirname(ancestor)) {
		if (identityAt(ancestor, fs) === mountedId) return true;
		if (dirname(ancestor) === ancestor) return false;
	}
}
