/**
 * The canary's two facts on a run record (issue #796). Its own small module because `run-history.mjs` is imported almost everywhere, and must not bring npm or the stager with it.
 */
import { EXACT_VERSION_RE, NPM_NAME_RE } from "./package-names.mjs";

export const CANARY_LOADS = Object.freeze(["loaded", "failed"]);
export const CANARY_RECORD_LOADS = Object.freeze(["loaded", "failed", "not-reported"]);

/** `{ name, version }`, rebuilt, or `null`. The one reader of the job field and of the record's copy of it. */
export function parsePackageCanary(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const { name, version } = raw;
	if (typeof name !== "string" || name.length > 214 || !NPM_NAME_RE.test(name)) return null;
	if (typeof version !== "string" || version.length > 128 || !EXACT_VERSION_RE.test(version)) return null;
	return { name, version };
}

/** The run record's field: the job's candidate, and what the runner said of it. A missing report is its own word, which every reader draws as failed. */
export function recordedPackageCanary(field, load) {
	const canary = parsePackageCanary(field);
	if (!canary) return null;
	return { ...canary, load: CANARY_LOADS.includes(load) ? load : "not-reported" };
}
