/** A retained workspace is human-only, including when an operator later points a local trigger at it (#771). */
import * as nodeFs from "node:fs";
import { dirname, resolve, sep } from "node:path";

export const LOCAL_FOLDER_IS_SANDBOX = "local-folder-is-sandbox";
const policy = () => ({ outcome: "policy", reason: LOCAL_FOLDER_IS_SANDBOX });
const within = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
const absent = (error) => error?.code === "ENOENT" || error?.code === "ENOTDIR";
const identity = (stat) => stat && ((typeof stat.dev === "bigint" && typeof stat.ino === "bigint") || (Number.isSafeInteger(stat.dev) && Number.isSafeInteger(stat.ino))) ? `${stat.dev}:${stat.ino}` : null;

/** Policy is returned; an unanswered filesystem read is separate so each caller can preserve infrastructure retry. */
export function checkSandboxWorkspace(job, { sandboxDir, fs = nodeFs, resolvedFolder = undefined } = {}) {
	if (job?.kind !== "local" || typeof job.folder !== "string" || typeof sandboxDir !== "string" || !sandboxDir) return null;
	const named = resolve(job.folder), root = resolve(sandboxDir);
	if (within(named, root)) return policy();
	const realpath = fs.realpathSync?.native ?? fs.realpathSync;
	if (typeof realpath !== "function" || typeof fs.statSync !== "function") return { unavailable: true };
	let actualRoot, folder;
	try { actualRoot = realpath(sandboxDir); }
	catch (error) { return absent(error) ? null : { unavailable: true }; }
	if (within(named, actualRoot)) return policy();
	try { folder = resolvedFolder ?? realpath(job.folder); }
	catch (error) { return absent(error) ? null : { unavailable: true }; }
	if (within(folder, root) || within(folder, actualRoot)) return policy();
	let rootId;
	try { rootId = identity(fs.statSync(actualRoot, { bigint: true })); }
	catch (error) { return absent(error) ? null : { unavailable: true }; }
	if (rootId === null) return { unavailable: true };
	// Case variants and macOS firmlinks can name the same directory without matching either spelling above.
	// Compare the root's identity to every resolved ancestor before trusting a text-only "outside" verdict.
	for (let path = folder;; path = dirname(path)) {
		let here;
		try { here = identity(fs.statSync(path, { bigint: true })); }
		catch (error) { return absent(error) ? null : { unavailable: true }; }
		if (here === null) return { unavailable: true };
		if (here === rootId) return policy();
		if (dirname(path) === path) return null;
	}
}
