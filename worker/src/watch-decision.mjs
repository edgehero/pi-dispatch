/** Pure watch admission policy. Provider calls and dollar reservations belong to the caller. */
const ACTIONS = new Set(["investigate", "file_issue", "ignore"]);
const NAME = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = () => ({ ok: false, reason: "decide-refused" });
const finite = (value) => typeof value === "number" && Number.isFinite(value);
const safeName = (value) => typeof value === "string" && NAME.test(value) && !["constructor", "prototype", "__proto__", "samples", "message", "text"].includes(value);

export function validateWatchDecision(value, { resolveModel = () => null } = {}) {
	if (!record(value) || Object.keys(value).some((key) => !["model", "maxCostUsd", "questions", "act", "fields"].includes(key))) return fail();
	if (typeof value.model !== "string" || value.model.length > 256 || !value.model.includes("/")) return fail();
	if (typeof value.maxCostUsd !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value.maxCostUsd)) return fail();
	const capMicros = Math.round(Number(value.maxCostUsd) * 1e6);
	if (!Number.isSafeInteger(capMicros)) return fail();
	let model;
	try { model = resolveModel(value.model); } catch { return fail(); }
	if (!model || model.type !== "classifier" || !record(model.cost) || !finite(model.cost.input) || model.cost.input < 0 || model.cost.output !== 0) return fail();
	if (!record(value.questions) || !Object.keys(value.questions).length || Object.keys(value.questions).length > 16) return fail();
	for (const [name, question] of Object.entries(value.questions)) {
		if (!safeName(name) || !record(question) || Object.keys(question).some((key) => !["type", "criteria", "instructions"].includes(key))) return fail();
		if (!["choice", "bool", "noul", "score"].includes(question.type) || !record(question.criteria) || !Object.keys(question.criteria).length || Object.keys(question.criteria).length > 16) return fail();
		if (question.instructions !== undefined && (typeof question.instructions !== "string" || question.instructions.length > 2048)) return fail();
		for (const [option, criteria] of Object.entries(question.criteria)) if (!safeName(option) || typeof criteria !== "string" || criteria.length > 2048) return fail();
		if (["bool", "noul"].includes(question.type) && Object.keys(question.criteria).sort().join() !== "false,true") return fail();
	}
	if (value.questions.act?.type !== "choice" || Object.keys(value.questions.act.criteria).some((option) => !ACTIONS.has(option))) return fail();
	if (!record(value.act) || Object.keys(value.act).some((key) => !ACTIONS.has(key) && key !== "otherwise")) return fail();
	if (value.act.otherwise !== undefined && value.act.otherwise !== "file_issue") return fail();
	for (const [action, threshold] of Object.entries(value.act)) {
		if (action === "otherwise") continue;
		if (!Object.hasOwn(value.questions.act.criteria, action) || !finite(threshold) || threshold <= 0.5 || threshold > 1) return fail();
	}
	if (value.fields !== undefined && (!Array.isArray(value.fields) || value.fields.length > 32 || new Set(value.fields).size !== value.fields.length || !value.fields.every(safeName))) return fail();
	if (Buffer.byteLength(JSON.stringify(value)) > 16384) return fail();
	return { ok: true, config: JSON.parse(JSON.stringify(value)), capMicros };
}

/** Arbitrary fingerprint values and sample text are deliberately excluded from the default state. */
export function projectWatchDecisionState(finding, fields = []) {
	const state = {};
	if (!record(finding)) return state;
	for (const key of ["severity", "count", "firstSeen", "lastSeen", "window", ...fields]) {
		if (!safeName(key)) continue;
		const value = Object.hasOwn(finding, key) ? finding[key] : fields.includes(key) && record(finding.fields) && Object.hasOwn(finding.fields, key) ? finding.fields[key] : undefined;
		if ((typeof value === "string" && Buffer.byteLength(value) <= 256 && !/[\u0000-\u001f\u007f]/.test(value)) || (finite(value) && value >= 0) || typeof value === "boolean") state[key] = value;
	}
	return state;
}

/** A trusted pinned-runtime bound is required; input-only pricing alone is no token bound. */
export function prepareWatchDecision(config, finding, { resolveModel, boundCostMicros } = {}) {
	const checked = validateWatchDecision(config, { resolveModel });
	if (!checked.ok || typeof boundCostMicros !== "function") return fail();
	const state = projectWatchDecisionState(finding, checked.config.fields);
	let boundMicros;
	try { boundMicros = boundCostMicros({ model: checked.config.model, state, questions: checked.config.questions }); } catch { return fail(); }
	if (!Number.isSafeInteger(boundMicros) || boundMicros < 0 || boundMicros > checked.capMicros) return fail();
	return { ...checked, state, boundMicros };
}

export function selectWatchDecision(config, result) {
	const fallback = { action: "file_issue", reason: "decide-unanswered" };
	if (!record(result) || result.stopReason !== "stop" || !record(result.answers)) return fallback;
	const answer = result.answers.act;
	if (!record(answer) || answer.type !== "choice" || !ACTIONS.has(answer.choice) || !record(answer.probabilities) || !finite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) return fallback;
	const allowed = config?.questions?.act?.criteria;
	if (!record(allowed) || !Object.hasOwn(allowed, answer.choice) || Object.keys(answer.probabilities).sort().join() !== Object.keys(allowed).sort().join()) return fallback;
	let sum = 0;
	for (const probability of Object.values(answer.probabilities)) {
		if (!finite(probability) || probability < 0 || probability > 1) return fallback;
		sum += probability;
	}
	if (Math.abs(sum - 1) > 0.000001) return fallback;
	const probability = answer.probabilities[answer.choice];
	const threshold = config.act?.[answer.choice];
	if (!finite(threshold) || probability < threshold || Object.values(answer.probabilities).some((p) => p > probability)) return { ...fallback, probabilities: { ...answer.probabilities }, confidence: answer.confidence };
	return { action: answer.choice, ...(answer.choice === "ignore" && { reason: "watch-ignored" }), probabilities: { ...answer.probabilities }, confidence: answer.confidence };
}
