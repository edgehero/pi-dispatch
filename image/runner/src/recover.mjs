import { configError } from "./outcome.mjs";
import { REPORT_PROGRESS_FACTORY, REPORT_PROGRESS_TOOL } from "./report-progress.mjs";

/**
 * Issue #645, the container's half of a durable run: resume a checkpoint transcript that an infrastructure failure
 * cut off in the middle of a tool batch.
 *
 * WHAT A CRASH LEAVES. pi persists each message on its message_end (agent-session.js: appendMessage, an
 * appendFileSync per entry), and the assistant message that issued a batch is persisted before any of the batch
 * runs. So a SIGKILL or a lost host mid-batch leaves a transcript whose last good assistant message names tool calls
 * that have no result: the ORPHANS. Resumed as is, pi-ai's transform-messages.js answers each orphan at request
 * time with a synthetic "No result provided" error and the model is left to guess whether its push, comment or file
 * write happened. This module answers every orphan before the run goes on, with either the real result (the call is
 * re-run) or a fixed text that says what is and is not known.
 *
 * WHY "ONLY THE FIRST ORPHAN CAN HAVE STARTED". A job armed with run.recover runs its tools one at a time
 * (run-job.mjs sets `session.agent.toolExecution = "sequential"`). In pi-agent-core's sequential executor each result
 * is emitted, and so persisted, before the next call starts; in the parallel one (the default) every result is
 * persisted only after the whole batch, so a crash leaves every call of the batch an orphan whatever ran. Under
 * sequential execution the first orphan is the one call that may have been running, and every orphan after it never
 * started. That is the whole basis of the labels below, and why config.mjs refuses PI_RECOVERING without PI_RECOVER.
 *
 * REPLAY OR HOLD. A call is re-run only when re-running it is known to be safe: a builtin file tool (read, ls, grep,
 * find, edit, write), whose effect is confined to the workspace that the worker restored to match the transcript, or
 * the job's own report_progress, which has no effect at all. Everything else is HELD: bash (any command), an MCP or
 * codemode call, await_human_input, an extension's tool, a tool an extension shadows under a builtin's name, a tool
 * the trigger excluded, and any name this run does not know. A held call is never re-run; it gets a fixed text and
 * the model, told by RECOVERY_PROMPT how to check, decides. Replay stops at the first hold: once one call's effect is
 * unknown, re-running a later call could act on a state the model has not seen, so every later orphan is reported as
 * not run instead.
 *
 * REJECTED: appending the results to the session file before createAgentSession. It is simpler, but the replayed
 * calls would then run with no extension loaded, so an extension's tool_call hook (a permission check, the job's own
 * reserved-name guard) would never see them. Replay goes through pi-agent-core's exported runToolCall with the
 * session's own beforeToolCall and afterToolCall, which are the extensions' tool_call and tool_result hooks
 * (agent-session.js _installAgentToolHooks), exactly as a model-issued call would.
 * REJECTED: `session.agent.continue()` after answering the orphans. It would let the model carry on without being
 * told the run was interrupted, the workspace partly reset, or how to check for an effect that may have happened.
 * The fixed RECOVERY_PROMPT is sent as a user message instead.
 */

/** The builtin tools whose replay is confined to the restored workspace. Not bash: a command may reach anywhere. */
export const REPLAY_TOOLS = Object.freeze(["read", "ls", "grep", "find", "edit", "write"]);

/** The key in a recovered toolResult's `details` that says which of the three answers it is. */
export const RECOVERY_KEY = "piDispatchRecovery";

export const INTERRUPTED_TEXT = "Interrupted by a crash: the effect may or may not have happened. Check before repeating.";
export const NOT_STARTED_TEXT = "Not run: the job crashed while an earlier call in this message was running. Run it again if it is still needed.";

/**
 * The user message a recovering run continues with. Fixed text: nothing in it is chosen by the job, the transcript or
 * the forge. What the worker resets is named because the model may have changed those files and would otherwise
 * believe its change is still there. The worker (worker/src/trust-paths.mjs, TRUST_ROOT_NAMES) puts `.pi/` and
 * `.agents/` whole, and the root context files pi loads (AGENTS.override.md, AGENTS.md and CLAUDE.md, in any casing),
 * back to their content at the commit this run STARTED from (the run's base commit), not the default branch as it is
 * now: those are what pi loads as trusted configuration, so they must be merge gated, never the agent's own writes.
 */
export const RECOVERY_PROMPT = [
	"This job was interrupted by an infrastructure failure and has been restored from its last checkpoint.",
	"The workspace matches the transcript up to this point, with one exception: the `.pi/` and `.agents/` directories and the root AGENTS.override.md, AGENTS.md and CLAUDE.md files were reset to the commit this run started from, so re-apply any change you made to them.",
	"Tool calls marked as interrupted may or may not have taken effect.",
	"Before you repeat anything that acts outside the workspace (a push, a pull request, a comment, an MCP or forge call), check whether it already happened:",
	"run `git fetch` and compare with the remote, push with `--force-with-lease`, run `gh pr list --head <branch>` (or this forge's equivalent) before creating a pull request, and read the issue's comments before posting one.",
	"Then continue the task.",
].join(" ");

const INLINE_REPORT_PROGRESS = `<inline:${REPORT_PROGRESS_FACTORY}>`;
const BUILTIN_PATH_PREFIX = "builtin:";

const isUsableAssistant = (message) => message?.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted";

/**
 * The last usable assistant message and its unanswered tool calls, in the order it issued them.
 *
 * "Usable" is pi-ai's own rule (transform-messages.js): an assistant message whose stopReason is error or aborted
 * is dropped at request time, so it never issued anything the model will see, and is skipped here.
 *
 * Only a tail of toolResult and system messages counts as the batch still being open. A user message, a custom
 * message or a later (even unusable) assistant message after it means pi already closed that batch: transform-
 * messages answers its orphans at that point, and a real result appended after it would be a second, misplaced
 * answer that providers refuse. That is not a crash shape this module recovers, so it reports no orphans and the
 * transcript is left exactly as pi would send it. System messages are transparent, as they are to pi-ai's
 * accounting (it holds them back until the batch is answered).
 */
export function findOrphans(messages) {
	let index = -1;
	for (let i = messages.length - 1; i >= 0; i--) {
		if (isUsableAssistant(messages[i])) {
			index = i;
			break;
		}
	}
	if (index < 0) return { assistant: null, orphans: [] };
	const assistant = messages[index];
	const answered = new Set();
	for (const message of messages.slice(index + 1)) {
		if (message.role === "toolResult") answered.add(message.toolCallId);
		else if (message.role !== "system") return { assistant, orphans: [] };
	}
	const calls = Array.isArray(assistant.content) ? assistant.content.filter((part) => part?.type === "toolCall") : [];
	return { assistant, orphans: calls.filter((call) => !answered.has(call.id)) };
}

/**
 * "replay" when re-running this call is known to be safe, else "hold".
 *
 * `tools` is the session's registry as getAllTools() returns it (name and sourceInfo), `active` the names of the
 * tools the agent can run now. Both are needed: the agent's own tool objects carry no sourceInfo, and a registered
 * but inactive tool is one runToolCall would answer "not found" for. A builtin is recognised by pi's own synthetic
 * source (agent-session.js _refreshToolRegistry: `builtin:<name>`, source "builtin"), path and source both, so an
 * extension that registers `read` (which replaces the builtin in the registry) or a builtin extension's tool cannot
 * pass. report_progress is recognised only as the job's own inline factory, the check reportProgressShadow makes.
 */
export function replayClass(toolCall, { tools, active }) {
	const name = toolCall?.name;
	if (typeof name !== "string") return "hold";
	if (!new Set(active).has(name)) return "hold";
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) return "hold";
	if (REPLAY_TOOLS.includes(name) && tool.sourceInfo?.source === "builtin" && tool.sourceInfo?.path === `${BUILTIN_PATH_PREFIX}${name}`) return "replay";
	if (name === REPORT_PROGRESS_TOOL && tool.sourceInfo?.path === INLINE_REPORT_PROGRESS) return "replay";
	return "hold";
}

const textResult = (toolCall, text, label) => ({
	role: "toolResult",
	toolCallId: toolCall.id,
	toolName: toolCall.name,
	content: [{ type: "text", text }],
	details: { [RECOVERY_KEY]: label },
	isError: true,
	timestamp: Date.now(),
});

/**
 * Answer every orphan of the last usable assistant message, persist each answer, and return the counts.
 *
 * Each answer is appended to the session file (sessionManager.appendMessage, pi's own persistence call) and to the
 * agent's messages, so the next request carries it and a crash during recovery leaves the answered prefix on disk.
 * The SAME object goes to both. That is what keeps pi's persisted-entry bookkeeping consistent: agent-session.js
 * _findPersistedMessageEntryId finds an entry by object identity in the session branch, and falls back to the
 * message's position in agent.state.messages against the session projection; appending one object at the end of both
 * satisfies either lookup. The messages setter copies the array it is given (pi-agent-core agent.js), so a new array
 * is assigned rather than the live one pushed to; pi's own message_end handler pushes, and either leaves the same
 * contents.
 *
 * `runToolCall` is pi-agent-core's export, injected so the tests can count calls. The context it gets is pi's
 * AgentContext at this pin, `{ messages, tools }` (no separate system prompt: at 1.2.0 the system prompt is a system
 * message in the transcript), the same shape agent-session.js hands it for a nested call.
 */
export async function recoverSession({ session, sessionManager, runToolCall, signal, log = () => {} }) {
	const { assistant, orphans } = findOrphans(session.agent.state.messages);
	const counts = { orphans: orphans.length, replayed: 0, interrupted: 0, notStarted: 0 };
	if (orphans.length === 0) {
		log("recovery_resolved", counts);
		return counts;
	}
	const registry = session.getAllTools();
	const active = session.getActiveToolNames();
	const append = (message) => {
		sessionManager.appendMessage(message);
		session.agent.state.messages = [...session.agent.state.messages, message];
	};
	let held = false;
	for (const [index, toolCall] of orphans.entries()) {
		if (!held && replayClass(toolCall, { tools: registry, active }) === "replay") {
			const tools = session.agent.state.tools;
			const outcome = await runToolCall(toolCall, {
				tools,
				assistantMessage: assistant,
				context: { messages: session.agent.state.messages, tools },
				beforeToolCall: session.agent.beforeToolCall,
				afterToolCall: session.agent.afterToolCall,
				signal,
			});
			// createToolResultMessage's shape (agent-loop.js), with the recovery label added to the details.
			append({
				role: "toolResult",
				toolCallId: toolCall.id,
				toolName: toolCall.name,
				content: outcome.result?.content ?? [],
				details: { ...(outcome.result?.details ?? {}), [RECOVERY_KEY]: "replayed" },
				...(outcome.result?.usage === undefined ? {} : { usage: outcome.result.usage }),
				isError: outcome.isError === true,
				...(outcome.durationMs === undefined ? {} : { durationMs: outcome.durationMs }),
				timestamp: Date.now(),
			});
			counts.replayed++;
			continue;
		}
		// Only the first orphan overall can have been running when the job died; a first HOLD after replayed calls
		// is one the crash came before, like every orphan after it.
		if (!held && index === 0) {
			append(textResult(toolCall, INTERRUPTED_TEXT, "interrupted"));
			counts.interrupted++;
		} else {
			append(textResult(toolCall, NOT_STARTED_TEXT, "not-started"));
			counts.notStarted++;
		}
		held = true;
	}
	// A transcript that still has an orphan here would reach the model with pi's "No result provided", the outcome
	// this module exists to prevent. Not retried: the same transcript would fail the same way.
	const left = findOrphans(session.agent.state.messages).orphans.length;
	if (left > 0) throw configError(`recovery left ${left} tool call(s) unanswered`);
	log("recovery_resolved", counts);
	return counts;
}
