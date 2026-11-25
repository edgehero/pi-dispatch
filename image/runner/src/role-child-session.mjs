/**
 * Issue #946: a role child of a subscription job, run inside this runner, on the job's own admitted runtime.
 *
 * WHY IN PROCESS. A role child started as a separate pi process (model-roles.mjs `runRoleChild`) inherits the
 * subscription's access token but not its admission: only this runner verified the adapter, installed the registration
 * guard and sealed its runtime (community-auth-adapter.mjs). The child's own guard has no admission, so its first call
 * was refused and the parent's child watch stopped the whole job as `model-not-allowed`, after the parent had spent. A
 * second session on the root's sealed runtime is admitted exactly as the root is: the guard, the meter, the model list,
 * the cost cap and the subscription allowance all wrap ModelRuntime.prototype in this process, so its calls pass the same
 * checks and are counted on the same totals (as a session other than the root's). Measured at the pin: creating,
 * prompting and disposing such a session registers and unregisters no provider, so the seal never latches.
 *
 * NO EXTENSIONS. Loading the job's extensions again would run the adapter's `registerProvider` on the sealed runtime, which
 * the guard refuses for the whole job (`auth-adapter-conflicting`). So the child's loader loads none
 * (loader.mjs `buildRoleChildResourceLoader`): pi's built-in tools, the job's skills, the guardrails and personas, and the
 * agent's own prompt. That leaves out the `subagent` tool too, so a child cannot start another, as a CLI child cannot.
 *
 * The rest follows the CLI child: the agent's `tools` as the allowlist, the trigger's exclusions after it (pi's exclusion
 * beats the list in both), the parent's thinking level only for an inherited model, `Task: <task>` as the prompt, the
 * last assistant message's text as the result, the call's abort signal, and no session file. The 1 MiB output limit is the
 * CLI child's, counted on the text of the child's answers, all of them, where the CLI child counts every byte of its JSON stdout.
 */
import { createAgentSession, getAgentDir, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

/** The CLI child's stdout limit (model-roles.mjs `runRoleChild`), held here on the text the child answers with. */
export const ROLE_CHILD_OUTPUT_LIMIT = 1048576;

const textOf = (message) => (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n");

/**
 * The in-process route `createRoleSubagents` takes (`inProcess`): `model(ref)` resolves a listed `provider/id` on the
 * root's runtime (null when it holds no such model, which the tool refuses before anything starts), and `run(call)` takes
 * the call `runRoleChild` takes and answers as it does, `{ exitCode, text }`.
 *
 * `loader({ agentPrompt, settingsManager })` builds the child's resource loader at call time. `settingsManager` is the
 * root's: each child gets its own in-memory copy, with no packages and no extensions, so nothing a child changes reaches
 * the root's settings. `pi` is injected by the tests.
 */
export function createRoleChildSessions({ modelRuntime, settingsManager, loader, agentDir = getAgentDir(), pi = { createAgentSession, SessionManager, SettingsManager } }) {
	const model = (ref) => {
		const slash = ref.indexOf("/");
		return modelRuntime.getModel(ref.slice(0, slash), ref.slice(slash + 1)) ?? null;
	};
	async function run({ agent, task, model: ref, signal, cwd, thinkingLevel, excludeTools = [] }) {
		const resolved = model(ref);
		if (!resolved) return { exitCode: 1, text: "the subagent could not start" };
		let session;
		try {
			const settings = pi.SettingsManager.inMemory({ ...settingsManager?.getSettings?.(), packages: [], extensions: [] });
			const resourceLoader = await loader({ agentPrompt: agent.content, settingsManager: settings });
			({ session } = await pi.createAgentSession({
				cwd,
				agentDir,
				modelRuntime,
				model: resolved,
				settingsManager: settings,
				sessionManager: pi.SessionManager.inMemory(cwd),
				resourceLoader,
				...(thinkingLevel && { thinkingLevel }),
				...(agent.tools?.length && { tools: agent.tools }),
				...(excludeTools.length > 0 && { excludeTools }),
			}));
		} catch {
			// A loader or session error may carry a path or a provider detail; the tool result never does.
			return { exitCode: 1, text: "the subagent could not start" };
		}
		let text = "";
		let last = null;
		let size = 0;
		let limited = false;
		const abort = () => void session.abort();
		const unsubscribe = session.subscribe((event) => {
			if (event.type !== "message_end" || event.message?.role !== "assistant") return;
			last = event.message;
			text = textOf(last);
			// Every answer counts toward the limit, as every line of the CLI child's stdout does.
			size += Buffer.byteLength(text);
			if (size > ROLE_CHILD_OUTPUT_LIMIT && !limited) {
				limited = true;
				abort();
			}
		});
		signal?.addEventListener("abort", abort, { once: true });
		let failed = false;
		try {
			if (!signal?.aborted) await session.prompt(`Task: ${task}`);
		} catch {
			failed = true;
		} finally {
			signal?.removeEventListener("abort", abort);
			unsubscribe();
			session.dispose();
		}
		if (limited) return { exitCode: 1, text: "the subagent exceeded its output limit" };
		// A child stopped by the call's signal, or whose last answer ended in an error, did not finish its task, so the
		// parent reads a failed result and a chain stops there.
		const exitCode = failed || signal?.aborted || last === null || last.stopReason === "error" || last.stopReason === "aborted" ? 1 : 0;
		// One that ended in an error is told to the parent as failed, never with the error, which may carry a provider detail.
		const failure = exitCode !== 0 && (failed || last?.stopReason === "error");
		return { exitCode, text: text || (failure ? "the subagent failed" : "the subagent returned no text") };
	}
	return { model, run };
}
