import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tempDir } from "./temp-dir.mjs";

/**
 * The REAL run-job.mjs, the real pi and no container: the shape of recover.test.mjs's run, for a test that asks what a
 * whole job did. `fixtures/remap-roots.mjs` moves the container's absolute mounts under one temp directory, so the
 * runner's own code path reads them unchanged, which no test that builds its own loader can claim.
 */
const RUN_JOB = fileURLToPath(new URL("../../run-job.mjs", import.meta.url));
const REMAP = fileURLToPath(new URL("../fixtures/remap-roots.mjs", import.meta.url));

export const JOB_PROVIDER = "real-job-fake";
export const JOB_MODEL = "m1";

/**
 * An OpenAI-compatible endpoint answering one short text reply, or, with `hold`, none at all until `release()`, so a
 * test can stop a run while its first call is out. `calls` counts what reached it: a test that means no spend reads it.
 */
export async function chatServer({ hold = false } = {}) {
	const held = [];
	const waiting = [];
	let calls = 0;
	const reply = (res) => {
		const chunk = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);
		res.writeHead(200, { "content-type": "text/event-stream" });
		chunk({ id: "r", object: "chat.completion.chunk", created: 0, model: JOB_MODEL, choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }] });
		chunk({ id: "r", object: "chat.completion.chunk", created: 0, model: JOB_MODEL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } });
		res.write("data: [DONE]\n\n");
		res.end();
	};
	const server = createServer((req, res) => {
		req.resume();
		req.on("end", () => {
			calls++;
			for (const wake of waiting.splice(0)) wake();
			if (hold) held.push(res);
			else reply(res);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		base: `http://127.0.0.1:${server.address().port}/v1`,
		calls: () => calls,
		firstCall: () => new Promise((resolve) => (calls > 0 ? resolve() : waiting.push(resolve))),
		close: () => {
			for (const res of held) res.destroy();
			return new Promise((resolve) => {
				server.close(resolve);
				server.closeAllConnections();
			});
		},
	};
}

/** The job's tree under a temp root, as the mounts the runner reads, with a provider at `base` that costs nothing. */
export function jobTree({ base = "http://127.0.0.1:1/v1", prompt = "do the task", cost = 0 } = {}) {
	const root = tempDir("pi-dispatch-real-job-");
	for (const dir of ["job/pi/skills", "workspace", "session", "outbox", "opt/pi-global", "opt/pi-dispatch", "home", "tmp"]) mkdirSync(join(root, dir), { recursive: true });
	writeFileSync(join(root, "job", "prompt.md"), `${prompt}\n`);
	for (const name of ["HARD_RULES.md", "OUTBOX_PROTOCOL.md", "PORTFOLIO_PROTOCOL.md"]) writeFileSync(join(root, "opt", "pi-dispatch", name), `## ${name}\n`);
	const model = { id: JOB_MODEL, name: JOB_MODEL, api: "openai-completions", reasoning: false, input: ["text"], cost: { input: cost, output: cost, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000, compat: { maxTokensField: "max_tokens" } };
	writeFileSync(join(root, "opt", "pi-global", "models.json"), `${JSON.stringify({ providers: { [JOB_PROVIDER]: { baseUrl: base, apiKey: "real-job-fake-key", api: "openai-completions", models: [model] } } })}\n`);
	return root;
}

/** Write `text` at a path inside the tree, a container path as the runner sees it (`/job/...`), making its folders. */
export function put(root, containerPath, text) {
	const path = join(root, containerPath);
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	return containerPath;
}

/** A theme pi accepts, built from pi's own, so a schema change at a bump breaks this helper and not a guess at it. */
export function piTheme(name) {
	const dark = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "modes", "interactive", "theme", "dark.json");
	return JSON.stringify({ ...JSON.parse(readFileSync(dark, "utf8")), name });
}

/**
 * Run the job in the tree. Resolves with the exit code, the signal, the raw stdout and stderr, the parsed JSON lines and
 * the last exit line. `key` hands the exit key over as the worker does; `stopWhen(line, stdout)` is called for each
 * chunk, and the test may send a SIGTERM from it through `child`.
 */
export async function runRealJob(root, env = {}, { key = null, whenStarted = () => {} } = {}) {
	const child = spawn(process.execPath, [`--import=${REMAP}`, RUN_JOB], {
		env: {
			PATH: process.env.PATH,
			HOME: join(root, "home"),
			TMPDIR: join(root, "tmp"),
			PI_DISPATCH_TEST_ROOT: root,
			PI_JOB_ID: "pi-job-real-1",
			PI_PROVIDER: JOB_PROVIDER,
			PI_MODEL: JOB_MODEL,
			PI_MAX_TURNS: "3",
			...(key ? { PI_EXIT_AUTH: "stdin" } : {}),
			...env,
		},
		cwd: join(root, "workspace"),
		stdio: [key ? "pipe" : "ignore", "pipe", "pipe"],
	});
	if (key) child.stdin.end(`${key}\n`);
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => (stdout += chunk));
	child.stderr.on("data", (chunk) => (stderr += chunk));
	whenStarted(child);
	const { code, signal } = await new Promise((resolve) => child.on("close", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal })));
	const lines = [];
	for (const line of stdout.split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			lines.push(JSON.parse(line));
		} catch {
			// a line of something else that starts with a brace
		}
	}
	return { code, signal, stdout, stderr, lines, exit: lines.findLast((line) => line.event === "exit") };
}
