import * as nodeFs from "node:fs";
import { join } from "node:path";
import { parseTriggersDocument } from "./triggers.mjs";
import { questionDigest, QUESTION_RUN_RE, QUESTION_GROUP_LIMITS } from "./question-groups.mjs";

export const QUESTION_GROUP_REASONS = Object.freeze(["question-group-unavailable", "question-group-config-changed", "question-group-source-expired", "question-group-source-unavailable", "question-group-source-oversize", "question-group-candidates-expired", "question-group-limit", "question-group-stale", "question-group-refused", "question-group-unanswered", "question-group-output-invalid"]);
const policy = (reason) => ({ outcome: "policy", reason, budgetReserved: false });
const modelRef = (text) => { const slash = text.indexOf("/"); return { provider: text.slice(0, slash), id: text.slice(slash + 1) }; };
export const questionGroupConfigDigest = (config) => questionDigest(config);

/** Queue data is references only. Private context is non-enumerable because queue deferrals serialize job.data. */
export function makeQuestionGroupRuntime({ store, triggersPath, getSettings = () => ({}), resolveClassifier = () => null, readFile = nodeFs.readFileSync, fs = nodeFs } = {}) {
	const config = () => parseTriggersDocument(readFile(triggersPath, "utf8"), triggersPath).zeroTouch;
	return {
		async resolve(data, runId) {
			const ref = data?.questionGrouping;
			// Admission deferrals can persist the resolved, text-free local wrapper. Rebuild it from the same narrow
			// reference on every pickup; no queued execution setting or lost private property is reused.
			if (!(data?.kind === "question-grouping" || data?.kind === "local" && data?.purpose === "zero-touch-grouping") || !ref || Object.keys(ref).sort().join() !== "configDigest,digest,runId" || !QUESTION_RUN_RE.test(ref.runId ?? "") || !/^[a-f0-9]{64}$/.test(ref.digest ?? "") || !/^[a-f0-9]{64}$/.test(ref.configDigest ?? "")) return { result: policy("question-group-refused") };
			let current;
			try { current = config(); } catch { return { result: policy("question-group-config-changed") }; }
			if (!current?.capture || questionGroupConfigDigest(current) !== ref.configDigest) return { result: policy("question-group-config-changed") };
			const source = await store.privateInput(ref.runId);
			if (source.status !== "ready") {
				await store.setStatus(ref.runId, source.status);
				const reason = ({ "source-expired": "question-group-source-expired", "source-unavailable": "question-group-source-unavailable", "source-oversize": "question-group-source-oversize", "candidates-expired": "question-group-candidates-expired", "group-limit": "question-group-limit" })[source.status] ?? "question-group-refused";
				return { result: policy(reason) };
			}
			if (source.meta.digest !== ref.digest) return { result: policy("question-group-stale") };
			const settings = getSettings();
			if (settings.invalid || typeof settings.provider !== "string" || typeof settings.model !== "string") return { result: policy("question-group-refused") };
			const classifier = modelRef(current.model);
			let selected;
			try { selected = await resolveClassifier(classifier); } catch { return { result: policy("question-group-refused") }; }
			// The full reviewed context window is a conservative input-only price ceiling, not a guessed tokenizer.
			// The runner still checks the exact call at its dispatch boundary before it can reach the provider.
			if (!selected || selected.type !== "classifier" || !Number.isFinite(selected.cost?.input) || selected.cost.input < 0 || selected.cost.output !== 0 || !Number.isSafeInteger(selected.contextWindow) || selected.contextWindow <= 0) return { result: policy("question-group-refused") };
			const boundMicros = Math.ceil(selected.contextWindow * selected.cost.input);
			if (!Number.isSafeInteger(boundMicros) || boundMicros > Math.round(Number(current.maxCostUsd) * 1000000)) return { result: policy("question-group-refused") };
			const grouping = { ...ref };
			Object.defineProperties(grouping, {
				input: { value: { version: 1, model: classifier, source: source.excerpt, candidates: source.candidates.map((candidate, i) => ({ slot: `g${i}`, excerpt: candidate.excerpt })), confidence: current.confidence } },
				candidateIds: { value: source.candidates.map((candidate) => candidate.id) },
				revision: { value: source.revision }, project: { value: source.meta.project }, jobId: { value: runId },
			});
			await store.setStatus(ref.runId, "pending");
			return { data: { kind: "local", purpose: "zero-touch-grouping", provider: settings.provider, model: settings.model, maxCostUsd: current.maxCostUsd, models: [...new Set([`${settings.provider}/${settings.model}`, current.model])], maxTurns: 1, packages: false, github: false, questionGroupModel: classifier, questionGrouping: grouping } };
		},
		/** Collection never throws: neither invalid output nor a store failure is permission to buy the call again. */
		async collect({ job, prepared, completed }) {
			if (!job?.questionGrouping || !prepared?.outboxDir) return null;
			const ref = job.questionGrouping;
			try {
				if (!completed) { await store.setStatus(ref.runId, "failed"); return { status: "failed" }; }
				const current = config();
				if (!current?.capture || questionGroupConfigDigest(current) !== ref.configDigest) { await store.setStatus(ref.runId, "stale"); return { status: "stale" }; }
				const path = join(prepared.outboxDir, "question-group.json");
				const stat = fs.lstatSync(path);
				if (!stat.isFile() || stat.isSymbolicLink?.() || stat.size > 1024) throw new Error("invalid output");
				const bytes = fs.readFileSync(path);
				if (Buffer.byteLength(bytes) > 1024) throw new Error("invalid output");
				const output = JSON.parse(bytes);
				const allowed = ["new", "unassigned", ...ref.candidateIds.map((_, i) => `g${i}`)];
				if (!output || Object.keys(output).sort().join() !== "confidence,slot,version" || output.version !== 1 || !allowed.includes(output.slot) || typeof output.confidence !== "number" || !Number.isFinite(output.confidence) || output.confidence < current.confidence || output.confidence > 1) throw new Error("invalid output");
				if (output.slot === "unassigned") { await store.setStatus(ref.runId, "unassigned"); return { status: "unassigned" }; }
				const groupId = output.slot === "new" ? null : ref.candidateIds[Number(output.slot.slice(1))];
				const result = await store.assign({ runId: ref.runId, digest: ref.digest, revision: ref.revision, groupId });
				if (result.status !== "assigned" && result.status !== "existing") await store.setStatus(ref.runId, "stale");
				return result;
			} catch { try { await store.setStatus(ref.runId, "failed"); } catch {} return { status: "failed" }; }
		},
	};
}

/** A classifier needs no repository tree or credentials; the existing container's /job and /outbox suffice. */
export function prepareQuestionGrouping(job, { jobDir, fs = nodeFs } = {}) {
	const input = job?.questionGrouping?.input;
	if (!input || Buffer.byteLength(JSON.stringify(input)) > QUESTION_GROUP_LIMITS.inputBytes) return policy("question-group-source-oversize");
	const workspace = join(jobDir, "workspace");
	const outboxDir = join(jobDir, "outbox");
	fs.mkdirSync(workspace, { recursive: true }); fs.mkdirSync(outboxDir, { recursive: true });
	fs.writeFileSync(join(jobDir, "prompt.md"), "", { mode: 0o444 });
	fs.writeFileSync(join(jobDir, "event.json"), JSON.stringify({ source: "zero-touch-grouping" }), { mode: 0o444 });
	fs.writeFileSync(join(jobDir, "question-grouping.json"), JSON.stringify(input), { mode: 0o444 });
	return { workspace, jobDir, outboxDir, sha: null, materialised: [], workspaceReadOnly: true };
}
