/** Resolve only the installed worker's own entry; npm's disposable execution cache is never a service target. */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function setupCachePath(path) {
	return /(?:^|[/\\])(?:_npx|_cacache|npm-cache|\.cache)(?:[/\\]|$)/.test(String(path));
}
export function trustedSetupFile(entry, { uid = process.geteuid?.(), realpath = realpathSync, stat = statSync } = {}) {
	try {
		const path = realpath(entry);
		const facts = stat(path);
		if (!facts.isFile() || (facts.uid !== uid && facts.uid !== 0) || (facts.mode & 0o022) || setupCachePath(path)) return null;
		for (let parent = dirname(path); ; parent = dirname(parent)) {
			const st = stat(parent);
			if (!st.isDirectory() || (st.uid !== uid && st.uid !== 0) || ((st.mode & 0o022) && !(st.mode & 0o1000))) return null;
			if (parent === dirname(parent)) break;
		}
		return path;
	} catch { return null; }
}
export function resolveSetupWorkerEntry({ entry = fileURLToPath(new URL("./cli.mjs", import.meta.url)), uid = process.geteuid?.(), realpath = realpathSync, readFile = readFileSync, stat = statSync, exists = existsSync } = {}) {
	try {
		const path = trustedSetupFile(entry, { uid, realpath, stat });
		if (path === null) return { refusal: "unsafe-entry" };
		const metadata = join(dirname(path), "..", "package.json");
		const pkg = JSON.parse(readFile(metadata, "utf8"));
		const facts = stat(path);
		const safeFile = (st) => st.isFile() && (st.uid === uid || st.uid === 0) && !(st.mode & 0o022);
		if (setupCachePath(path) || !exists(path) || !safeFile(facts) || !safeFile(stat(metadata)) || pkg.name !== "@edgehero/pi-dispatch" || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/i.test(pkg.version) || !path.endsWith(`${String(path).includes("\\") ? "\\" : "/"}src${String(path).includes("\\") ? "\\" : "/"}cli.mjs`)) return { refusal: "unsafe-entry" };
		return { entry: path, version: pkg.version };
	} catch { return { refusal: "unsafe-entry" }; }
}
