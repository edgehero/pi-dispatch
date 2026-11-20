import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const snapshots = new WeakMap();

/** Read once per loader. Reload must not silently pick up an edit between turns. Each new loader selects a fresh snapshot. */
export function readPromptAdditions({ globalPiDir, jobPiDir, readFile = readFileSync }) {
	const read = (dir) => {
		try { return readFile(join(dir, "APPEND_SYSTEM.md"), "utf8"); }
		catch (error) {
			if (error?.code === "ENOENT") return undefined;
			throw error;
		}
	};
	const overlay = read(globalPiDir);
	const repository = read(jobPiDir);
	const digest = (text) => text ? createHash("sha256").update(text, "utf8").digest("hex") : null;
	return Object.freeze({ overlay, repository, hashes: Object.freeze({ overlay: digest(overlay), repository: digest(repository) }) });
}

/** Metadata describes the append files composed by the loader, not a provider's complete wire prompt. */
export function rememberPromptAdditions(loader, snapshot) {
	snapshots.set(loader, snapshot.hashes);
	return loader;
}

export function promptAdditionsOf(loader) {
	return snapshots.get(loader);
}
