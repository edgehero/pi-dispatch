import * as nodeFs from "node:fs";
import { resolve } from "node:path";

/**
 * The mutex follows the directory, not its spelling (#911). Budget scopes deliberately keep their
 * authored path keys: changing those to real paths would silently start new counters on upgrade.
 * Both realpath and stat are repeated at preparation, before mounting, to detect a replaced directory.
 * Filesystem failures stay native so the caller can distinguish determinate absence from an outage.
 */
export function readLocalWorkspaceIdentity(named, { fs = nodeFs } = {}) {
	const folder = (fs.realpathSync?.native ?? fs.realpathSync)(resolve(named.trim()));
	const stat = fs.statSync(folder, { bigint: true });
	if (!stat.isDirectory()) throw Object.assign(new Error("the local workspace is not a directory"), { code: "ENOTDIR" });
	if ((typeof stat.dev !== "bigint" && !Number.isSafeInteger(stat.dev)) || (typeof stat.ino !== "bigint" && !Number.isSafeInteger(stat.ino))) {
		throw Object.assign(new Error("the local workspace identity could not be read"), { code: "EIO" });
	}
	return { key: `local-workspace:${stat.dev}:${stat.ino}`, folder };
}
