// Issue #645: the job recover.test.mjs kills. A real pi session on a persisted session file, whose scripted model
// issues ONE message with two tool calls: a write, then a bash that records its pid and sleeps. The parent waits for
// the bash pid (and, sequentially, the write's result in the file), then SIGKILLs this process mid-tool.
// argv[2] is JSON: { root, mode: "sequential" | "parallel", pidFile }.
import { createJobModelRuntime } from "../../src/model-runtime.mjs";
import { openSessionManager } from "../../src/session.mjs";
import { sessionFixture, scriptedSession } from "../helpers/recover-session.mjs";

const { root, mode, pidFile } = JSON.parse(process.argv[2]);
const pi = await import("@earendil-works/pi-coding-agent");
const piAi = await import("@earendil-works/pi-ai");
const loaderModule = await import("../../src/loader.mjs");

const f = sessionFixture(root);
const { sessionManager } = openSessionManager({ sessionFile: f.sessionFile, cwd: f.workspace });
const script = [
	[
		{ type: "toolCall", id: "call-write", name: "write", arguments: { path: "written.txt", content: "one\n" } },
		// `exec` so the recorded pid is the sleep itself, which the parent kills after this process: SIGKILL does not
		// reach a tool's own process group.
		{ type: "toolCall", id: "call-bash", name: "bash", arguments: { command: `echo $$ > '${pidFile}'; exec sleep 60` } },
	],
	[{ type: "text", text: "unreachable" }],
];
const { session } = await scriptedSession({ pi, piAi, loaderModule, createJobModelRuntime }, f, { api: `pi-dispatch-recover-child-${mode}`, script, sessionManager });
if (mode === "sequential") session.agent.toolExecution = "sequential";
process.stdout.write("ready\n");
await session.prompt("do the work");
