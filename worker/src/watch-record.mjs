/** Only reviewed names and numeric answers may enter a durable run record. */
export function recordedWatchDecision(value) {
	if (!value || typeof value !== "object" || !["investigate", "file_issue", "ignore"].includes(value.action) || typeof value.model !== "string" || !/^[A-Za-z0-9_.:/@~-]{1,128}$/.test(value.model)) return null;
	const out = { model: value.model, action: value.action, shadow: value.shadow === true };
	if (Array.isArray(value.questions) && value.questions.length <= 16 && value.questions.every(n => /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(n))) out.questions = [...value.questions];
	if (value.probabilities && Object.keys(value.probabilities).every(k => ["investigate", "file_issue", "ignore"].includes(k)) && Object.values(value.probabilities).every(p => Number.isFinite(p) && p >= 0 && p <= 1)) out.probabilities = { ...value.probabilities };
	if (Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1) out.confidence = value.confidence;
	if (Number.isFinite(value.costUsd) && value.costUsd >= 0) out.costUsd = value.costUsd;
	return out;
}
