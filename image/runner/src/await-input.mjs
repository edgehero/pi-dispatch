/**
 * REQ-AWAIT-INPUT (issue #625): the one tool a job armed with `run.awaitInput` can end its run with.
 *
 * The agent posts its question on the issue or pull request itself, with the forge CLI it already uses for
 * every other comment, then calls this tool. The tool returns `terminate: true`, so pi ends the loop after
 * the round without another model request (pi-agent-core 1.1.0 agent-loop.js:167), and the runner exits 0 as
 * `awaiting-input`. Exit 0 is the point: only a completed run promotes its transcript (REQ-RESUMABLE-SESSION),
 * and the next run on this key resumes from it with the human's reply. Nothing waits in the container
 * (DES-SANDBOX-IS-A-FRESH-CONTAINER, DES-AWAIT-INPUT-ENDS-THE-JOB).
 *
 * The question never rides the exit line. It is model text, and the exit line feeds the PII-free run record,
 * so the agent posts it and the worker posts only a fixed sentence of its own.
 *
 * An inline extension, like the job's MCP (mcp.mjs), so it reaches the session through the loader's
 * `extensionFactories` and no new createAgentSession option (INT-SDK-SESSION-OPTIONS stays exact). Its name
 * is reserved: another extension that registers a tool of the same name would answer the call the job ends
 * on, so run-job refuses that before the prompt (awaitInputShadow) and the tool_call hook blocks it after.
 */

export const AWAIT_INPUT_TOOL = "await_human_input";
export const AWAIT_INPUT_FACTORY = "job-await-input";
// The exit reason of a parked run lives in outcome.mjs (AWAITING_INPUT), one spelling, beside the other reasons.

const OURS = `<inline:${AWAIT_INPUT_FACTORY}>`;

const DESCRIPTION = [
	"End this run and wait for a person's answer. Use it only when you cannot go on without a decision or",
	"information that only a person can give. First post your question as a comment on the issue or pull request",
	"you are working on, with the forge CLI this job uses, so the person sees it. Then call this tool on its own,",
	"as the only tool call in your message. The run ends after it; your work so far is kept, and the next run",
	"continues from here with the person's reply.",
].join(" ");

/**
 * The factory to hand the loader, and the flag run-job reads at exit. `state.called` says the tool ran; whether
 * the run actually ENDED on it is the terminal's to say (parkedTerminal), because a call batched with a tool
 * that does not terminate leaves pi's loop running.
 */
export function createAwaitInput() {
	const state = { called: false };
	const factories = [
		{
			name: AWAIT_INPUT_FACTORY,
			factory: (api) => {
				api.registerTool({
					name: AWAIT_INPUT_TOOL,
					label: "await human input",
					description: DESCRIPTION,
					promptSnippet: "end the run and wait for a person's answer to a question you posted",
					parameters: { type: "object", properties: {} },
					async execute() {
						state.called = true;
						return {
							content: [{ type: "text", text: "The run ends here. The next run continues from this point with the reply." }],
							details: {},
							terminate: true,
						};
					},
				});
				// Held at every call, not only at the pre-prompt check: an extension that registers the name later (from a
				// timer, say) is refused its call rather than ending the job in our name.
				api.on("tool_call", (event) => {
					if (event.toolName !== AWAIT_INPUT_TOOL) return undefined;
					const tool = api.getAllTools().find((candidate) => candidate.name === AWAIT_INPUT_TOOL);
					if (tool && tool.sourceInfo?.path !== OURS) return { block: true, reason: `${AWAIT_INPUT_TOOL} is the job's own tool, and another extension registered it` };
					return undefined;
				});
			},
		},
	];
	return { factories, state };
}

/** The reserved name, when an extension other than ours registered it, else null. mcpShadow's shape. */
export function awaitInputShadow(tools) {
	for (const tool of tools) if (tool.name === AWAIT_INPUT_TOOL && tool.sourceInfo?.path !== OURS) return tool.name;
	return null;
}

/** Whether the run ended on this tool's own successful result: the only shape that parks. */
export function parkedTerminal(terminal) {
	return terminal?.role === "toolResult" && terminal.toolName === AWAIT_INPUT_TOOL && terminal.isError !== true;
}
