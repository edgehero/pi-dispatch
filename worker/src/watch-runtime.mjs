import { collectedWatchTrace } from "./watch-trace.mjs";
import { makeRedactor } from "./redact-secrets.mjs";
import { recordedWatchDecision } from "./watch-record.mjs";
import * as nodeFs from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { parseTriggersDocument } from "./triggers.mjs";
import { selectWatchDecision, projectWatchDecisionState } from "./watch-decision.mjs";
import { validateWatchBoard } from "./watch-board.mjs";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const refusal = reason => ({ outcome: "policy", reason, budgetReserved: false });
const modelRef = ref => { const at = ref.indexOf("/"); return { provider: ref.slice(0, at), id: ref.slice(at + 1) }; };

/** Open the inode once: an agent may replace an outbox path, including with a FIFO or symlink. */
export function readWatchOutput(path, maxBytes, fs = nodeFs) {
	let fd;
	try {
		fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > maxBytes) return null;
		const bytes = Buffer.alloc(maxBytes + 1);
		let used = 0;
		while (used < bytes.length) { const n = fs.readSync(fd, bytes, used, bytes.length - used, null); if (!n) break; used += n; }
		return used > maxBytes ? null : bytes.subarray(0, used).toString("utf8");
	} catch { return null; } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function refusedOutput(path, maxBytes, fs) {
	try { const stat = fs.lstatSync(path); return stat.size > maxBytes ? "watch-board-oversize" : "watch-board-invalid"; }
	catch (error) { return error?.code === "ENOENT" ? null : "watch-board-invalid"; }
}

/** Producer references are resolved again at pickup; queue bytes never select execution settings. */
export function makeWatchRuntime({ store, triggersPath, readFile = nodeFs.readFileSync, enqueue, publishIssue, getSettings = () => ({}), pauseUntil = () => null, now = Date.now, fs = nodeFs, log = () => {} }) {
	const document = () => parseTriggersDocument(readFile(triggersPath, "utf8"), triggersPath);
	const currentRule = (doc, id) => doc.triggers.find(t => t.on.type === "watch" && t.on.id === id);
	let draining = false;
	return {
		async started(job) {
			if (job.watch?.stage !== "decision") return;
			await store.updateFinding(job.watch.findingId, { status: "deciding", runId: job.watch.runId });
			await store.scheduleAction(job.watch.findingId, job.watch.ruleId, now() + 35 * 60 * 1000);
		},
		async drain() {
			if (draining) return;
			draining = true;
			try {
			if (publishIssue?.sweep) for (const outcome of await publishIssue.sweep()) log("watch_issue_close", { identity: outcome.identity, status: outcome.status, ...(outcome.reason ? { reason: outcome.reason } : {}) });
			for (const fields of await store.pendingActions()) {
				if (!await store.readFinding(fields.id)) { await store.acknowledgeAction(fields.id); continue; }
				await enqueue(fields, { phase: "action" });
			}
			} finally { draining = false; }
		},
		async resolve(data, runId) {
			if (data?.kind !== "watch" && !data?.watch) return { data };
			const ref = data.watch;
			if (!ref || !/^[a-f0-9]{64}$/.test(ref.findingId) || !["dispatch", "action"].includes(ref.phase)) return { result: refusal("watch-reference-invalid") };
			let doc;
			try { doc = document(); } catch (error) { if (error?.piDispatchConfig || error?.code === "ENOENT") return { result: refusal("watch-config-changed") }; throw error; }
			const rule = currentRule(doc, ref.ruleId);
			if (!rule || !doc.watchSources?.[rule.on.source]) return { result: refusal("watch-config-changed") };
			const target = rule.run.mode === "issue" ? { kind: rule.run.issue.kind, repo: rule.run.issue.repo } : { kind: "local", folder: rule.run.folder };
			const until = pauseUntil(target, now());
			if (Number.isFinite(until) && until > now()) return { deferUntil: until };
			const taken = await store.takeFinding(ref.findingId);
			if (taken.status !== "ready") return { result: refusal(taken.status === "below-threshold" ? "watch-threshold" : taken.status === "held" ? "watch-window-pending" : "watch-evidence-expired") };
			const finding = taken.finding;
			if (finding.ruleId !== ref.ruleId || finding.source !== rule.on.source) return { result: refusal("watch-reference-invalid") };
			if (finding.policyDigest && finding.policyDigest !== digest(rule)) return { result: refusal("watch-config-changed") };
			const latest = await store.readFinding(ref.findingId, { private: true });
			if (ref.phase === "action") await store.acknowledgeAction(ref.findingId);
			const decision = recordedWatchDecision(latest?.decision);
			let phase = "investigate";
			let action = rule.run.mode === "issue" ? "file_issue" : "investigate";
			if (rule.decide) {
				if (ref.phase === "dispatch" && !decision && latest?.status !== "deciding") phase = "decision";
				else action = decision ? (rule.decide.shadow ? "investigate" : decision.action) : "file_issue";
			}
			if (phase !== "decision" && action === "ignore") { await store.updateFinding(ref.findingId, { status: "ignored", reason: "watch-ignored" }); return { result: { outcome: "completed", reason: "watch-ignored", budgetReserved: false, ...(decision ? { decision } : {}) } }; }
			if (phase !== "decision" && action === "file_issue") {
				if (!rule.run.issue || typeof publishIssue !== "function") return { result: refusal("watch-issue-target-missing") };
				const published = await publishIssue({ source: finding.source, ruleId: ref.ruleId, fingerprint: finding.fingerprint, finding, target: rule.run.issue });
				await store.updateFinding(ref.findingId, { status: published.status === "uncertain" ? "issue-uncertain" : published.status === "capped" ? "capped" : "issue", ...(published.reason ? { reason: published.reason } : {}) });
				return { result: { outcome: ["uncertain", "capped"].includes(published.status) ? "policy" : "completed", budgetReserved: false, ...(published.reason ? { reason: published.reason } : {}), ...(decision ? { decision } : {}) } };
			}
			const board = await store.readBoard(ref.ruleId);
			const execution = { ...rule.run };
			delete execution.mode; delete execution.issue; delete execution.queryLogs;
			const watch = { findingId: ref.findingId, ruleId: ref.ruleId, phase: ref.phase, configDigest: digest(rule), ...(decision ? { decision } : {}) };
			// BullMQ deferrals may persist job.data. Private evidence must survive in memory without
			// becoming queue data when an unrelated admission gate persists its data.
			Object.defineProperties(watch, { stage: { value: phase }, project: { value: doc.watchSources[rule.on.source].project ?? null }, runId: { value: runId }, finding: { value: finding }, board: { value: { version: 1, blocks: board.blocks } }, queries: { value: rule.run.queryLogs ?? {} } });
			if (phase === "decision") {
				Object.defineProperty(watch, "gate", { value: { version: 1, model: modelRef(rule.decide.model), state: projectWatchDecisionState({ ...finding, window: rule.on.window }, rule.decide.fields), questions: rule.decide.questions } });
				execution.maxCostUsd = rule.decide.maxCostUsd;
				const settings = getSettings();
				if (settings.invalid) return { result: refusal("watch-config-changed") };
				const primary = `${execution.provider ?? settings.provider}/${execution.model ?? settings.model}`;
				execution.models = [...new Set([...(execution.models ?? []), primary, rule.decide.model])];
				await store.updateFinding(ref.findingId, { status: "decision-pending", runId });
			} else await store.updateFinding(ref.findingId, { status: "running", runId });
			await store.appendTrace(ref.findingId, { id: `${runId}:admit`, kind: "rule", status: phase, ruleId: ref.ruleId, count: finding.count });
			return { data: { ...execution, kind: "local", github: false, packages: false, watch, ...(rule.decide ? { watchDecisionModel: modelRef(rule.decide.model) } : {}) } };
		},
		/** A completed paid attempt is never retried because collecting its output failed. */
		async collect({ job, prepared, completed, policyRefused = false, usage }) {
			if (!job.watch || !prepared?.outboxDir) return;
			const watch = job.watch;
			const redact = prepared.watchRedact ?? makeRedactor();
			const privateEntry = entry => JSON.parse(redact(JSON.stringify(entry)));
			try {
				const raw = readWatchOutput(join(prepared.outboxDir, "watch-trace.jsonl"), 262144, fs);
				const traceIds = new Set();
				let traceUnavailable = false;
				if (raw === null && refusedOutput(join(prepared.outboxDir, "watch-trace.jsonl"), 262144, fs)) traceUnavailable = true;
				if (raw !== null) for (const line of raw.split("\n").filter(Boolean).slice(0, 128)) {
					let entry; try { entry = JSON.parse(line); } catch { traceUnavailable = true; continue; }
					const projected = collectedWatchTrace(entry, { model: job.watchDecisionModel ? `${job.watchDecisionModel.provider}/${job.watchDecisionModel.id}` : null, ruleId: watch.ruleId, runId: watch.runId });
					if (!projected) { traceUnavailable = true; continue; }
					if (["query", "decide"].includes(entry.kind) && entry.status === "completed") traceIds.add(entry.id);
					try { await store.appendTrace(watch.findingId, privateEntry(projected)); } catch { traceUnavailable = true; }
				}
				let rule;
				try { rule = currentRule(document(), watch.ruleId); } catch {}
				if (!rule || digest(rule) !== watch.configDigest) { await store.updateFinding(watch.findingId, { status: "refused", reason: "watch-config-changed" }); return; }
				if (watch.stage === "decision") {
					let output; try { output = JSON.parse(readWatchOutput(join(prepared.outboxDir, "decision.json"), 16384, fs)); } catch {}
					const selected = completed ? selectWatchDecision(rule.decide, output) : { action: "file_issue", reason: policyRefused ? "decide-refused" : "decide-unanswered" };
					const summary = recordedWatchDecision({ ...selected, model: rule.decide.model, questions: Object.keys(rule.decide.questions), shadow: rule.decide.shadow, costUsd: usage?.costUsd });
					watch.decision = summary;
					try { await store.appendTrace(watch.findingId, privateEntry({ id: "decision", kind: "decide", state: watch.gate.state, questions: rule.decide.questions, ...summary, modelReviewed: true, status: selected.reason ?? "answered" })); } catch { traceUnavailable = true; }
					await store.updateFinding(watch.findingId, { status: "decided", decision: summary, ...(selected.reason ? { reason: selected.reason } : {}) });
					await store.scheduleAction(watch.findingId, watch.ruleId);
					await enqueue({ id: watch.findingId, ruleId: watch.ruleId, dueAt: now() }, { phase: "action" });
				} else {
					const boardRaw = completed ? readWatchOutput(join(prepared.outboxDir, "board.json"), 16384, fs) : null;
					const boardProblem = completed && boardRaw === null ? refusedOutput(join(prepared.outboxDir, "board.json"), 16384, fs) : null;
					if (boardProblem) await store.appendTrace(watch.findingId, { id: "board-refused", kind: "board", status: boardProblem });
					if (boardRaw !== null && !traceUnavailable) {
						const checked = validateWatchBoard(redact(boardRaw), { traceIds });
						if (checked.ok) {
							for (const block of checked.board.blocks) block.traceId = `${watch.runId}:${block.traceId}`;
							const remapped = validateWatchBoard(checked.board);
							if (remapped.ok) await store.proposeBoard(watch.ruleId, checked.board, watch.findingId);
							else await store.appendTrace(watch.findingId, { id: "board-refused", kind: "board", status: remapped.reason });
						}
						else await store.appendTrace(watch.findingId, { id: "board-refused", kind: "board", status: checked.reason });
					}
					await store.updateFinding(watch.findingId, { status: completed ? "completed" : "failed" });
				}
				if (traceUnavailable) await store.updateFinding(watch.findingId, { reason: "watch-trace-unavailable" });
			} catch {
				log("watch-output-unavailable", { ruleId: watch.ruleId });
				try { await store.updateFinding(watch.findingId, { status: "unavailable", reason: "watch-output-unavailable" }); } catch {}
			}
		},
	};
}
