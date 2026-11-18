import * as nodeFs from "node:fs";
import { canonicalFuturePath, insideDirectory, privateStoreExposed } from "./private-store-boundary.mjs";

export const SECRET_FILES_PLACEMENT_UNSAFE = "secret-files-placement-unsafe";

/** Both directions matter: a source inside another attempt's private tree is as unsafe as its ancestor. */
export function checkSecretFileSources(sources, protectedDir, { fs = nodeFs } = {}) {
	if (typeof protectedDir !== "string" || protectedDir === "") return null;
	try {
		for (const source of sources) {
			if (typeof source !== "string" || source === "") continue;
			if (privateStoreExposed(source, protectedDir, { fs }) || privateStoreExposed(protectedDir, source, { fs })) {
				return { outcome: "policy", reason: SECRET_FILES_PLACEMENT_UNSAFE };
			}
		}
		return null;
	} catch {
		// Never guess that an unreadable parent is disjoint, or carry a filesystem error's paths into a record.
		return { unavailable: true };
	}
}

/** All jobs protect other attempts' secrets, including jobs that themselves have no file grant. */
export function checkSecretFilesPlacement(job, { jobsDir, globalPiDir = null, fs = nodeFs, resolvedFolder = null, prepared = null } = {}) {
	let workspace = job?.kind === "local" ? resolvedFolder ?? job.folder : null;
	if (prepared !== null) {
		workspace = prepared.workspace;
		try {
			if (job?.kind !== "local" && typeof workspace === "string" && typeof prepared.jobDir === "string"
				&& insideDirectory(canonicalFuturePath(prepared.jobDir, { fs }), canonicalFuturePath(workspace, { fs }))) workspace = null;
		} catch { return { unavailable: true }; }
	}
	const sources = [workspace, job?.skillsDir, globalPiDir];
	// Forge workspaces are worker-created children of jobDir and intentionally absent here. The final staging
	// check compares their exact mount against its sibling secret root instead of against the whole jobs tree.
	return checkSecretFileSources(sources, jobsDir, { fs });
}
