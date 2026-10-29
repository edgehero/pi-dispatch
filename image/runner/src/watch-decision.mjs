import { lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configError } from "./outcome.mjs";
import { LAYOUT } from "./layout.mjs";
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = () => configError("invalid deterministic watch decision", "watch-config-invalid");
export function readWatchDecision({ path = `${LAYOUT.job}/watch-decision.json`, fs = { lstatSync, readFileSync } } = {}) {
	let stat;
	try { stat = fs.lstatSync(path); } catch (error) { if (error?.code === "ENOENT") return null; throw fail(); }
	if (!stat.isFile() || stat.size > 32768) throw fail();
	let value; try { value = JSON.parse(fs.readFileSync(path, "utf8")); } catch { throw fail(); }
	return validateWatchDecisionInput(value);
}
export function validateWatchDecisionInput(value) {
	if (!object(value) || Object.keys(value).sort().join() !== "model,questions,state,version" || value.version !== 1 || !object(value.model) || Object.keys(value.model).sort().join() !== "id,provider" || typeof value.model.id !== "string" || typeof value.model.provider !== "string" || !value.model.id || !value.model.provider || value.model.id.length > 256 || !object(value.state) || !object(value.questions)) throw fail();
	if (Buffer.byteLength(JSON.stringify(value)) > 32768 || Object.keys(value.state).length > 40 || !Object.keys(value.questions).length || Object.keys(value.questions).length > 16) throw fail();
	for (const [key, field] of Object.entries(value.state)) {
		if (["samples", "text", "message", "__proto__", "constructor", "prototype"].includes(key) || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) || !["string", "number", "boolean"].includes(typeof field) || typeof field === "string" && Buffer.byteLength(field) > 256 || typeof field === "number" && !Number.isFinite(field)) throw fail();
	}
	for (const [name, question] of Object.entries(value.questions)) {
		if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name) || ["constructor", "prototype", "__proto__"].includes(name) || !object(question) || !["choice", "bool", "noul", "score"].includes(question.type) || !object(question.criteria) || Object.keys(question).some((k) => !["type", "criteria", "instructions"].includes(k)) || Object.keys(question.criteria).length > 16 || !Object.keys(question.criteria).length) throw fail();
		if (question.instructions !== undefined && (typeof question.instructions !== "string" || question.instructions.length > 2048)) throw fail();
		for (const [option, criteria] of Object.entries(question.criteria)) if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(option) || ["constructor", "prototype", "__proto__"].includes(option) || typeof criteria !== "string" || criteria.length > 2048) throw fail();
	}
	return JSON.parse(JSON.stringify(value));
}
/** One runtime call, no AgentSession and no loader. Runtime dispatch is already guarded by the caller. */
export async function executeWatchDecision({ input, runtime, outbox = LAYOUT.outbox, fs = { writeFileSync } }) {
	input = validateWatchDecisionInput(input);
	const model = runtime.getModelsOfType("classifier", input.model.provider).find((candidate) => candidate.id === input.model.id);
	if (!model || !Number.isFinite(model.cost?.input) || model.cost.input < 0 || model.cost.output !== 0) return { ok: false, reason: "decide-refused" };
	const questions = Object.fromEntries(Object.entries(input.questions).map(([key, question]) => [key, { ...question, type: question.type === "noul" ? "bool" : question.type }]));
	let result;
	try { result = await runtime.classify(model, { state: input.state, questions }, { signal: AbortSignal.timeout(10000) }); } catch { result = { stopReason: "error", answers: {} }; }
	const output = { version: 1, stopReason: result.stopReason, answers: result.answers ?? {}, ...(result.usage && { usage: result.usage }) };
	let raw;
	try { raw = JSON.stringify(output); } catch { return { ok: false, reason: "decide-unanswered" }; }
	if (Buffer.byteLength(raw) > 16384) return { ok: false, reason: "decide-unanswered" };
	fs.writeFileSync(join(outbox, "decision.json"), raw, { mode: 0o600 });
	return { ok: true, output };
}
