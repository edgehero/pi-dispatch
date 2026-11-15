import { RECORD_REASON_RE } from "./record-reason.mjs";

// A recovery handoff is a returned policy result too, but its work is still running elsewhere. Keep this leaf free
// of processor imports so the enqueue path can share it without loading the worker; the test pins these two tokens
// to the processor's exported constants. Refusals are deliberately NOT listed: a new policy gate gets the same rule.
const CONTINUING_REASONS = new Set(["recovery-enqueued", "recovery-superseded"]);

/** The caller establishes terminal state. Old non-policy return values keep their existing window. */
export function semanticWindowDisposition(result) {
	if (result === null || typeof result !== "object" || Array.isArray(result) || result.outcome !== "policy") return "retain";
	// A malformed policy result may conceal a handoff, so ingress must report it rather than silently swallowing
	// the next intent. Worker completion still keeps its outcome: shouldReleaseSemanticWindow treats this as no release.
	if (typeof result.reason !== "string" || !RECORD_REASON_RE.test(result.reason)) return "invalid";
	return CONTINUING_REASONS.has(result.reason) ? "retain" : "release";
}

/** Worker cleanup is best effort: malformed outcomes retain the key and never rewrite the terminal result. */
export function shouldReleaseSemanticWindow(result) {
	return semanticWindowDisposition(result) === "release";
}
