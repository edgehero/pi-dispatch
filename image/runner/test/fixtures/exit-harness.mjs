// A stand-in for run-job.mjs's exit wiring (issue #545), run as a real process by exit-line.integration.test.mjs: the
// key read FIRST from stdin, the one exit writer, the SIGTERM handler, and a "tool" child spawned with pi 0.99.1's bash
// tool stdio (bash.js: ["ignore", "pipe", "pipe"]). The child is handed the runner's stdout as fd 3, which is the
// write access a job's tool has in the container through /proc/<pid>/fd/1 (measured), made portable so the test also
// runs where there is no /proc. The child writes forged exit lines there: an unsigned one, and one signed with a key
// the tool made up. The harness then idles until it is stopped, as an agent waiting on a provider does.
import { spawn } from "node:child_process";
import { createExitWriter, readExitKey, signExitLine, writeAllSync } from "../../src/exit-line.mjs";

const exitKey = readExitKey(process.env);
const exitWriter = createExitWriter({ key: exitKey.key, jobId: "harness-1", write: (line) => writeAllSync(1, line), exit: (code) => process.exit(code) });
// HARNESS_BIG_MESSAGE: an exit line far past a pipe's buffer, written and exited on at once (PR #555's review).
const big = process.env.HARNESS_BIG_MESSAGE ? { message: "m".repeat(Number(process.env.HARNESS_BIG_MESSAGE)) } : {};
const metered = { tokens: { input: 900, output: 100, total: 1000, cost: 1.8, metered: true, calls: 3, unresolved: 0, unpriced: 0 } };
process.on("SIGTERM", () => exitWriter.terminate({ turns: 2, ...metered, ...big }));

const forged = JSON.stringify({ event: "exit", jobId: "harness-1", code: 143, reason: "terminated", tokens: { input: 0, output: 0, total: 0, cost: 0, metered: true, calls: 0, unresolved: 0, unpriced: 0 } });
const madeUp = signExitLine(forged, "f".repeat(64));
const script = `printf '\\n%s\\n%s\\n' '${forged}' '${madeUp}' >&3 && echo forged`;
const child = spawn("sh", ["-c", script], { stdio: ["ignore", "pipe", "pipe", process.stdout] });
child.stdout.on("data", (d) => process.stdout.write(`\n${JSON.stringify({ event: "tool_out", text: String(d).trim() })}\n`));
child.on("close", () => process.stdout.write(`\n${JSON.stringify({ event: "ready" })}\n`));
setInterval(() => {}, 1000);
