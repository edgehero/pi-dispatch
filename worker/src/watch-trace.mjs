const ACTIONS = ["investigate", "file_issue", "ignore"];
const STATUSES = ["started", "completed", "failed", "proposed", "held", "suppressed", "capped", "unmatched", "decision", "investigate", "answered", "decide-unanswered", "decide-refused", "watch-ignored", "watch-board-invalid", "watch-board-oversize", "trace-trimmed"];
const token = value => typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0 && value <= 1000000;

/** Public trace values have types and closed vocabularies, not merely familiar key names. */
export function publicWatchTrace(entry) {
	const out = {};
	if (token(entry.id)) out.id = entry.id;
	if (["stream", "rule", "decide", "query", "turn", "board"].includes(entry.kind)) out.kind = entry.kind;
	if (Number.isSafeInteger(entry.at) && entry.at >= 0) out.at = entry.at;
	if (STATUSES.includes(entry.status)) out.status = entry.status;
	for (const key of ["count", "rows"]) if (integer(entry[key])) out[key] = entry[key];
	if (typeof entry.fingerprint === "string" && /^[a-f0-9]{64}$/.test(entry.fingerprint)) out.fingerprint = entry.fingerprint;
	for (const key of ["ruleId", "source"]) if (token(entry[key])) out[key] = entry[key];
	if (["verified", "pull"].includes(entry.signature)) out.signature = entry.signature;
	if (ACTIONS.includes(entry.action ?? entry.option)) out.action = entry.action ?? entry.option;
	if (entry.modelReviewed === true && typeof entry.model === "string" && /^[A-Za-z0-9_./:@~-]{1,128}$/.test(entry.model)) { out.model = entry.model; out.modelReviewed = true; }
	if (Number.isFinite(entry.confidence) && entry.confidence >= 0 && entry.confidence <= 1) out.confidence = entry.confidence;
	if (Number.isFinite(entry.costUsd) && entry.costUsd >= 0) out.costUsd = entry.costUsd;
	// A yes from the worker's own reading of pi's usage, never the provider's words: the cost is what the provider
	// billed (OpenRouter's System One answers since pi 1.6.1), not the catalog price applied to its token counts.
	if (entry.billed === true) out.billed = true;
	if (entry.probabilities && !Array.isArray(entry.probabilities) && Object.keys(entry.probabilities).every(k => ACTIONS.includes(k)) && Object.values(entry.probabilities).every(p => Number.isFinite(p) && p >= 0 && p <= 1)) out.probabilities = { ...entry.probabilities };
	if (entry.checks && Object.keys(entry.checks).every(k => ["match", "threshold", "cooldown", "cap"].includes(k)) && Object.values(entry.checks).every(v => ["passed", "refused", "active", "at-window-end"].includes(v))) out.checks = { ...entry.checks };
	return out;
}

export function collectedWatchTrace(entry, { model, ruleId, runId }) {
	if (!entry || !["query", "decide", "board"].includes(entry.kind) || !/^watch-\d{1,4}$/.test(entry.id) || !STATUSES.includes(entry.status)) return null;
	const out = { id: `${runId}:${entry.id}`, kind: entry.kind, status: entry.status, ruleId };
	if (entry.kind === "decide" && model) Object.assign(out, { model, modelReviewed: true });
	for (const key of ["rows", "blocks"]) if (integer(entry[key])) out[key] = entry[key];
	// Query text, agent-chosen questions and state remain in the operator projection alone.
	for (const key of ["state", "questions", "answers", "usage", "query", "callId"]) if (entry[key] !== undefined && Buffer.byteLength(JSON.stringify(entry[key])) <= 16384) out[key] = entry[key];
	if (entry.kind === "decide") Object.assign(out, decisionCallFacts(entry));
	return out;
}

/**
 * What a decision's classify call says about itself (pi 1.6.1): the provider's own id for the answer, which stays in the
 * operator projection because it names a paid call in the provider's records, and whether the provider billed the cost
 * (`usage.cost.totalFromProvider`), which the public projection shows as a yes. Neither is read from anything but the
 * runner's output, and an output without them (an older image) gives neither.
 */
export function decisionCallFacts(output) {
	const out = {};
	if (token(output?.responseId)) out.responseId = output.responseId;
	if (output?.usage?.cost?.totalFromProvider === true) out.billed = true;
	return out;
}
