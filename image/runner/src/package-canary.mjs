/**
 * Whether a canary's candidate loaded (issue #796). pi records a failed load in `getExtensions().errors` and carries on, so a job can end cleanly having never run the code it
 * was started to try. The runner says which on the exit line; a line that says nothing reads as not reported, which the page draws as failed.
 *
 * A package may hold only skills, prompts or themes, so an extension is not the only proof. A candidate that contributed nothing at all did not load.
 */
import { isUnderAnyRoot } from "./packages.mjs";

/** The candidate's container path. Set by the worker only, and reserved against a trigger's secrets, but held to `parsePackagePaths`' rules all the same. */
export function parseCanaryPath(env) {
	// env-internal PI_PACKAGE_CANARY: the worker's own per-job input (INT-UPDATES-KEYS), present only on a canary job.
	const raw = env.PI_PACKAGE_CANARY;
	return typeof raw === "string" && raw.startsWith("/") && !raw.split("/").includes("..") ? raw : null;
}

/** `loaded` or `failed`, from what pi loaded. Never throws: a loader that cannot answer has not shown it loaded. */
export function canaryLoadOf(root, resourceLoader) {
	try {
		const roots = [root];
		const extensions = resourceLoader.getExtensions();
		if ((extensions?.errors ?? []).some((error) => isUnderAnyRoot(error?.path, roots))) return "failed";
		const paths = [
			...(extensions?.extensions ?? []).map((extension) => extension?.path),
			...(resourceLoader.getSkills()?.skills ?? []).map((skill) => skill?.filePath),
			...(resourceLoader.getPrompts()?.prompts ?? []).map((prompt) => prompt?.filePath),
			...(resourceLoader.getThemes()?.themes ?? []).map((theme) => theme?.filePath ?? theme?.sourcePath),
		];
		return paths.some((path) => isUnderAnyRoot(path, roots)) ? "loaded" : "failed";
	} catch {
		return "failed";
	}
}
