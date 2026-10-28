// env-internal PI_APPROVAL_GATES: validated worker declarations, never a host setting.
// env-internal PI_APPROVAL_DECISION: the host-owned durable decision for this staged session.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configError } from "./outcome.mjs";

export const APPROVAL_TOOL = "request_approval";
export const APPROVAL_FACTORY = "job-request-approval";
const OURS = `<inline:${APPROVAL_FACTORY}>`;
const ACTION = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?$/;
const CALL_ID = /^[A-Za-z0-9_.:|/-]{1,256}$/;

export function parseApprovalEnv(env) {
	try {
		const gates = env.PI_APPROVAL_GATES ? JSON.parse(env.PI_APPROVAL_GATES) : [];
		const decision = env.PI_APPROVAL_DECISION ? JSON.parse(env.PI_APPROVAL_DECISION) : null;
		if (env.PI_APPROVAL_DECISION && decision === null) throw new Error();
		if (!Array.isArray(gates) || gates.length > 32 || gates.some((action) => typeof action !== "string" || !ACTION.test(action)) || new Set(gates).size !== gates.length) throw new Error();
		if (decision !== null && (!decision || Array.isArray(decision) || typeof decision !== "object" || Object.keys(decision).some((key) => !["requestId", "action", "toolCallId", "decision", "text"].includes(key)) || typeof decision.requestId !== "string" || !CALL_ID.test(decision.requestId) || !gates.includes(decision.action) || typeof decision.toolCallId !== "string" || !CALL_ID.test(decision.toolCallId) || !["approved", "declined", "question"].includes(decision.decision) || (decision.text !== undefined && (typeof decision.text !== "string" || decision.text.length > 16384)))) throw new Error();
		return { approvalGates: gates, approvalDecision: decision };
	} catch {
		throw configError("invalid approval gate configuration", "approval-config-invalid");
	}
}

export function createRequestApproval(gates) {
	const state = { called: false, approval: null };
	return { state, factories: [{ name: APPROVAL_FACTORY, factory(api) {
		api.registerTool({
			name: APPROVAL_TOOL,
			label: "request approval",
			description: "Ask a person to approve a declared action. First post the summary on the issue. Call this tool alone; the run ends and resumes with the person's decision as this tool's result. External actions remain advisory to your skill.",
			parameters: { type: "object", properties: { action: { type: "string", enum: gates }, summary: { type: "string", maxLength: 16384 } }, required: ["action", "summary"], additionalProperties: false },
			async execute(toolCallId, args) {
				if (!args || !gates.includes(args.action) || typeof args.summary !== "string" || args.summary.length > 16384 || typeof toolCallId !== "string" || !CALL_ID.test(toolCallId)) return { content: [{ type: "text", text: "The requested action is not a declared approval gate." }], isError: true };
				state.called = true;
				state.approval = { action: args.action, toolCallId };
				return { content: [{ type: "text", text: "Approval pending. This run ends here and resumes with the person's decision." }], details: { approval: state.approval }, terminate: true };
			},
		});
		api.on("tool_call", (event) => {
			if (event.toolName === APPROVAL_TOOL && approvalShadow(api.getAllTools())) return { block: true, reason: "request_approval is reserved for the job" };
		});
	} }] };
}

export function approvalShadow(tools) {
	return tools.some((tool) => tool.name === APPROVAL_TOOL && tool.sourceInfo?.path !== OURS) ? APPROVAL_TOOL : null;
}

export function approvalTerminal(terminal, state) {
	const a = state?.approval;
	return state?.called === true && terminal?.role === "toolResult" && terminal.toolName === APPROVAL_TOOL && terminal.isError !== true && terminal.toolCallId === a?.toolCallId && terminal.details?.approval?.action === a?.action ? a : null;
}

// pi 1.2.0's public append-only context edit preserves the original call identity and raw audit trail.
// Apply only to the staged transcript before createAgentSession restores the model context.
export function applyApprovalDecision(manager, decision) {
	if (!decision) return;
	const messages = manager.buildSessionContext().messages;
	const terminal = messages.at(-1);
	const entries = manager.getBranch();
	const target = entries.findLast((entry) => entry.type === "message" && entry.message?.role === "toolResult");
	const caller = messages.at(-2);
	const call = caller?.role === "assistant" && Array.isArray(caller.content) && caller.content.find((part) => part?.type === "toolCall" && part.id === decision.toolCallId && part.name === APPROVAL_TOOL && part.arguments?.action === decision.action);
	if (!target || target.message.toolCallId !== terminal?.toolCallId || terminal?.role !== "toolResult" || terminal.toolName !== APPROVAL_TOOL || terminal.toolCallId !== decision.toolCallId || terminal.isError === true || terminal.details?.approval?.action !== decision.action || !call || entries.some((entry) => entry.type === "context_edit" && entry.targetId === target.id)) throw configError("approval decision does not match the parked tool result", "approval-decision-invalid");
	manager.appendContextEdit(target.id, { content: JSON.stringify(decision) });
}


/** The gateway logs exec argv, so only decision metadata rides the env. Read its private text once from the
 * worker-staged event file before extensions or the model can run. An absent/malformed event refuses, never
 * degrades to a decision whose explanation differs from what the person sent. */
export function approvalDecisionFromEvent(decision, { jobDir, readFile = readFileSync } = {}) {
	if (!decision) return null;
	try {
		const event = JSON.parse(readFile(join(jobDir, "event.json"), "utf8"));
		const text = event?.comment?.body;
		if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 8192 || (typeof text.isWellFormed === "function" && !text.isWellFormed())) throw new Error();
		return { ...decision, text };
	} catch {
		throw configError("approval decision text is unavailable", "approval-decision-invalid");
	}
}
