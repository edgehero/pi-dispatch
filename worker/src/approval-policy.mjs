import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { parseUsdMicros } from "./money.mjs";

export const APPROVAL_ACTION_RE = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?$/;
export const APPROVAL_DECISIONS = Object.freeze(["approved", "declined", "question"]);
const UNSUPPORTED = new Set(["push", "push-default-branch", "pr-open", "open-pr", "merge", "approve"]);
const hash = (value) => createHash("sha256").update(value).digest("hex");

/** An action name declares policy; it cannot give a container a new forge permission. */
export function validateApprovalConfig(run) {
	const present = ["gates", "gateTimeout", "gateBudgetRaiseUsd"].some((key) => run[key] !== undefined);
	if (!present) return {};
	if (!Array.isArray(run.gates) || run.gates.length === 0 || run.gates.length > 32 || run.gates.some((gate) => typeof gate !== "string" || gate.length > 80 || !APPROVAL_ACTION_RE.test(gate) || UNSUPPORTED.has(gate)) || new Set(run.gates).size !== run.gates.length) throw new TypeError("run.gates must contain 1 to 32 distinct action tokens; push, PR opening and merge gates have no supported enforcement boundary");
	if (run.resume !== true || run.kind === "local" || run.command !== undefined || run.replicas !== undefined || run.recover === true) throw new TypeError("run.gates requires a resumable forge flow without replicas or recovery");
	if (run.awaitInput === false) throw new TypeError("run.gates cannot disable run.awaitInput");
	if (run.gateTimeout !== undefined && (!Number.isSafeInteger(run.gateTimeout) || run.gateTimeout < 1 || run.gateTimeout > 365)) throw new TypeError("run.gateTimeout must be an integer number of days from 1 to 365");
	if (run.gates.includes("budget-raise")) {
		if (run.maxCostUsd === undefined || run.gateBudgetRaiseUsd === undefined || parseUsdMicros(run.gateBudgetRaiseUsd, "run.gateBudgetRaiseUsd") <= parseUsdMicros(run.maxCostUsd, "run.maxCostUsd")) throw new TypeError("budget-raise needs run.gateBudgetRaiseUsd greater than run.maxCostUsd (the absolute cap for one resumed job)");
	} else if (run.gateBudgetRaiseUsd !== undefined) throw new TypeError("run.gateBudgetRaiseUsd needs the budget-raise gate");
	return { gates: [...run.gates], ...(run.gateTimeout !== undefined ? { gateTimeout: run.gateTimeout } : {}), ...(run.gateBudgetRaiseUsd !== undefined ? { gateBudgetRaiseUsd: run.gateBudgetRaiseUsd } : {}) };
}

export function approvalConfigDigest(run) {
	return hash(JSON.stringify({ gates: run.gates, gateTimeout: run.gateTimeout ?? null, gateBudgetRaiseUsd: run.gateBudgetRaiseUsd ?? null, maxCostUsd: run.maxCostUsd ?? null }));
}

/** Free live-file check: a queued decision cannot keep a declaration an operator removed. */
export function makeCheckApprovalPolicy({ triggersPath, parseTriggers, fs = nodeFs }) {
	return (job) => {
		try {
			const index = job?.trigger?.matched?.index;
			const entries = parseTriggers(fs.readFileSync(triggersPath, "utf8"), triggersPath);
			const entry = entries[index];
			if (!entry || entry.run.kind !== job.kind || entry.on.type !== job.trigger.matched.type || !entry.run.gates || entry.run.resume !== true || approvalConfigDigest(entry.run) !== approvalConfigDigest(job)) return { refused: "approval-policy-changed" };
			return { ok: true, digest: approvalConfigDigest(entry.run) };
		} catch { return { refused: "approval-policy-unavailable" }; }
	};
}

export function approvalReply(text, { phrase } = {}) {
	let value = typeof text === "string" ? text.trim() : "";
	if (typeof phrase === "string" && phrase.length > 0 && value.startsWith(phrase) && (value.length === phrase.length || /\s/.test(value[phrase.length]))) value = value.slice(phrase.length).trimStart();
	if (/^\/approve\s*$/.test(value)) return { decision: "approved", text: "" };
	const declined = /^\/decline(?:\s+([\s\S]*))?$/.exec(value);
	// The private store bounds UTF-8 bytes and refuses oversized replies. Cutting here would accept a decision whose
	// explanation is not the one the person sent, and would hide the overflow from that validator.
	if (declined) return { decision: "declined", text: declined[1] ?? "" };
	return { decision: "question", text: value };
}

export function approvalActor(job) {
	if (job.console?.by) return { kind: job.console.by === "panel" ? "panel" : "operator", id: hash(job.console.by) };
	const id = job.trigger?.sender?.id;
	return typeof id === "number" && Number.isSafeInteger(id) && id > 0 || typeof id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(id) ? { kind: "forge", id: hash(String(id)) } : null;
}

export function approvalRequestId(runId, toolCallId) { return hash(`${runId}\0${toolCallId}`); }

/** Public audit shape: text and display names have no path into a record. */
export function approvalAudit(request) {
	return {
		requestId: request.requestId,
		action: request.action,
		...(request.decision ? { decision: request.decision.decision, actorKind: request.decision.actor.kind, actorId: request.decision.actor.id, decidedAt: request.decision.at } : {}),
	};
}
