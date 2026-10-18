/**
 * `pi-dispatch chat <run-id | issue-or-PR-url | session-key> [--fork] [--force] [--tools] [--pi <path>] [--console <addr>] [--yes]`
 * (issue #647, REQ-TERMINAL-CHAT): open a run's chat in this terminal.
 *
 * THREE ARGUMENT CLASSES, told apart by shape alone (`classifyChatTarget`):
 *   - a session key (32 lowercase hex) is ALWAYS the fork, on this host, with no console at all: a key names a stored
 *     transcript and nothing else, so there is no run to ask about;
 *   - an http(s) URL is an issue or pull request on a forge, which the console resolves to its newest run (`?url=`);
 *   - anything else in the run-id charset is a job id (`?id=`).
 *
 * THE MODE IS THE CONSOLE'S (`/api/run`'s `mode`, from the one rule `chatModeOf` that the web Chat panel and
 * `/dispatch chat` share), so the terminal can never disagree with the page about what a run is: `live` attaches,
 * `reply` answers a parked run, `fork` forks a finished one, and `null` prints the console's sentence (`says`: queued,
 * unknown, already answered) and exits 1. `--fork` forces the fork; with a run id whose record this host's run history
 * holds, that needs no console either. The record a fork judges comes from the local run history when present (the
 * record the worker wrote here), else from `/api/run`'s `run`.
 *
 * A live attach that ends (the run finished while watched) asks `/api/run` again and goes on in the new mode, so
 * watching a run that parks drops straight into its reply box.
 *
 * A CONSOLE OFF THIS MACHINE IS A QUESTION FIRST. The console speaks plain HTTP, so signing in to an address that is not
 * loopback or a unix socket sends the token readable to the whole path. Such an address (only `--console` or
 * `PI_CONSOLE_URL` can name one; `consoleAddressOf` refuses it from a `.env`) gets a warning naming the host and a y/N
 * whose default is no, before the token is read or sent; `--yes` answers it for a script (the warning still prints).
 */
import { parseArgs } from "node:util";
import { homedir } from "node:os";
import { askHidden, askYesNo, consoleAddressOf, consoleToken, dotenvTrustRefusal, makeConsoleClient } from "./console-client.mjs";
import { SESSION_KEY_PATTERN } from "./session-key.mjs";

/** The usage line, shared with the CLI's own usage text (a test holds both). */
export const CHAT_USAGE = "pi-dispatch chat <run-id | issue-or-PR-url | session-key> [--fork] [--force] [--tools] [--pi <path>] [--console <addr>] [--yes]";

/** The longest issue or pull request URL taken, the console's `?url=` limit (`/dispatch chat`'s, which a test holds to it). */
export const CHAT_URL_MAX = 2048;

/** A job id as the worker mints it (the console's charset). */
const RUN_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

/** How many times, 2 s apart, a run that just ended is asked again before its new mode is taken as it stands. */
const SETTLE_TRIES = 5;
const SETTLE_MS = 2000;

/** The deployment keys this command reads, each only where it is needed. */
export const CHAT_DEPLOYMENT_KEYS = Object.freeze(["PI_CONSOLE_LISTEN", "PI_SESSIONS_DIR", "PI_LOGS_DIR"]);

/**
 * What the argument names: `{kind: "key", key}`, `{kind: "url", url}`, `{kind: "id", id}`, or `{refusal}`. A key is
 * tested first, so a 32-hex string is never read as a job id (job ids that are pure hex of that length are not minted).
 */
export function classifyChatTarget(arg) {
	const s = typeof arg === "string" ? arg.trim() : "";
	if (s === "") return { refusal: `name a run: ${CHAT_USAGE}` };
	if (SESSION_KEY_PATTERN.test(s)) return { kind: "key", key: s };
	if (/^https?:\/\//i.test(s)) {
		if (s.length > CHAT_URL_MAX) return { refusal: `the URL is longer than ${CHAT_URL_MAX} characters` };
		try {
			new URL(s);
		} catch {
			return { refusal: "the URL does not parse" };
		}
		return { kind: "url", url: s };
	}
	if (RUN_ID_RE.test(s)) return { kind: "id", id: s };
	return { refusal: "the argument is neither a run id (letters, digits and . _ : -), an issue or pull request URL, nor a 32-hex session key" };
}

/**
 * One line of console-supplied text, made safe for this terminal: the view's scrub (no pi-tui is loaded for it), then
 * every line break folded to a space, so a multi-line refusal cannot draw a second, fake line of output.
 */
async function safe(text) {
	const { scrubForTerminal } = await import("./chat-view.mjs");
	return scrubForTerminal(text, { maxBytes: 4096 }).replace(/\s*\n\s*/g, " ");
}

/**
 * Run the command. Seams: `env` (this shell's), `out`/`err` (line writers), `deploymentEnv` (cli.mjs's
 * `cliDeploymentEnv`, handed in so this module does not import the CLI's entry), `cwd`, `home`, and `deps` for tests:
 * `makeClient`, `askToken`, `ask`, `readRecord`, `runLive`, `runReply`, `question`, `fork` (`{plan, run}`), `sleep`,
 * `envTrust` (`dotenvTrustRefusal` of `cwd` by default).
 * Returns the exit code.
 */
export async function runChat(argv, { env = process.env, out = (l) => process.stdout.write(`${l}\n`), err = (l) => process.stderr.write(`${l}\n`), deploymentEnv, cwd = process.cwd(), home = homedir(), deps = {} } = {}) {
	let parsed;
	try {
		parsed = parseArgs({
			args: argv,
			allowPositionals: true,
			options: { fork: { type: "boolean", default: false }, force: { type: "boolean", default: false }, tools: { type: "boolean", default: false }, pi: { type: "string" }, console: { type: "string" }, yes: { type: "boolean", default: false } },
		});
	} catch (e) {
		err(`error: ${e.message}\n  ${CHAT_USAGE}`);
		return 1;
	}
	const { values, positionals } = parsed;
	if (positionals.length !== 1) {
		err(`error: ${positionals.length === 0 ? "name a run" : "chat takes one run"}\n  ${CHAT_USAGE}`);
		return 1;
	}
	const target = classifyChatTarget(positionals[0]);
	if (target.refusal) {
		err(`error: ${target.refusal}`);
		return 1;
	}
	const deployment = (keys) => (typeof deploymentEnv === "function" ? deploymentEnv(env, keys, { cwd }) : { env });
	const forkOpts = { values, env, out, err, cwd, home, deployment, deps };

	if (target.kind === "key") return forkRun({ ...forkOpts, record: null, key: target.key, newerRunOnTarget: null });

	// --fork with a run id this host's history holds needs no console: the record is here.
	if (values.fork && target.kind === "id") {
		const local = await readLocalRecord(target.id, { deployment, deps });
		if (local.problem) {
			err(`error: ${local.problem}`);
			return 1;
		}
		if (local.record) return forkRun({ ...forkOpts, record: local.record, key: null, newerRunOnTarget: null });
	}

	const where = consoleAddressOf({ flag: values.console ?? null, env, deployment: () => deployment(["PI_CONSOLE_LISTEN"]), envTrust: deps.envTrust ?? (() => dotenvTrustRefusal({ dir: cwd })) });
	if (where.refusal) {
		err(`error: ${await safe(where.refusal)}`);
		return 1;
	}
	if (!where.loopback) {
		err(`warning: ${where.address.shown} is not on this machine, and the console speaks plain HTTP: the console token goes over the network to it unencrypted, readable to anything on the path. A tunnel to a loopback address (ssh -L 4790:127.0.0.1:4790 <host>) keeps it private.`);
		const ok = values.yes || (await (deps.ask ?? ((q) => askYesNo(q)))(`Send the console token to ${where.address.shown} anyway? [y/N] `));
		if (!ok) {
			err("error: not signed in; nothing was sent");
			return 1;
		}
	}
	const tok = await consoleToken({ env, askHidden: deps.askToken ?? ((q) => askHidden(q)) });
	if (tok.refusal) {
		err(`error: ${tok.refusal}`);
		return 1;
	}
	const client = (deps.makeClient ?? makeConsoleClient)({ address: where.address, token: tok.token });
	const lookup = target.kind === "url" ? { url: target.url } : { id: target.id };
	try {
		const who = await client.whoami();
		let info = await lookupRun(client, lookup, { err });
		if (!info) return 1;
		for (let round = 0; round < 8; round += 1) {
			const mode = values.fork ? "fork" : info.mode;
			if (mode === "fork") {
				const id = typeof info.run?.jobId === "string" ? info.run.jobId : null;
				const local = id ? await readLocalRecord(id, { deployment, deps }) : { record: null };
				if (local.problem) {
					err(`error: ${local.problem}`);
					return 1;
				}
				return forkRun({ ...forkOpts, record: local.record ?? info.run ?? null, key: null, newerRunOnTarget: typeof info.newerRunOnTarget === "string" ? info.newerRunOnTarget : null });
			}
			if (mode === "live") {
				const pi = await (deps.loadPiTui ?? (async () => (await import("./chat-view.mjs")).loadPiTui()))();
				const terminal = deps.terminal ?? new pi.ProcessTerminal();
				const runLive = deps.runLive ?? (await import("./chat-view.mjs")).runLiveView;
				const got = await runLive({ client, lookup, info, who, pi, terminal });
				if (got.detached) {
					out("detached; the run goes on");
					return 0;
				}
				info = await settle(client, lookup, got.info ?? info, deps.sleep);
				out(`the run is no longer live (${await safe(info.state ?? "?")})`);
				continue;
			}
			if (mode === "reply") {
				const view = await import("./chat-view.mjs");
				const question = await (deps.question ?? view.questionOf)({ client, info, who });
				const pi = await (deps.loadPiTui ?? view.loadPiTui)();
				const terminal = deps.terminal ?? new pi.ProcessTerminal();
				const got = await (deps.runReply ?? view.runReplyView)({ client, info, who, question, pi, terminal });
				if (got.detached) {
					out("left without answering");
					return 0;
				}
				const jobs = Array.isArray(got.result?.jobIds) ? got.result.jobIds.map(String) : [];
				out(`answered: the run resumes${jobs.length > 0 ? ` as ${await safe(jobs.join(", "))}` : ""}; follow it with pi-dispatch chat ${await safe(jobs[0] ?? info.run?.jobId ?? "<run-id>")}`);
				return 0;
			}
			err(`error: ${await safe(typeof info.says === "string" && info.says !== "" ? info.says : "this run has no chat to open")}`);
			return 1;
		}
		err("error: the run kept changing mode; open it again");
		return 1;
	} catch (e) {
		err(`error: ${await safe(e?.message ?? "the console could not be asked")}`);
		return 1;
	}
}

/** `/api/run` for `lookup`: its JSON, or null after printing the console's refusal (and an Azure item's candidates). */
async function lookupRun(client, lookup, { err }) {
	const got = await client.run(lookup);
	if (got.status === 200 && got.json && typeof got.json === "object") return got.json;
	const sentence = typeof got.json?.error === "string" ? got.json.error : `the console answered ${got.status}`;
	err(`error: ${await safe(sentence)}`);
	const candidates = Array.isArray(got.json?.candidates) ? got.json.candidates.slice(0, 20) : [];
	for (const c of candidates) {
		const line = typeof c === "string" ? c : [c?.jobId ?? c?.id, c?.target, c?.url].filter((v) => typeof v === "string").join("  ");
		if (line !== "") err(`  ${await safe(line)}`);
	}
	if (candidates.length > 0) err("  name one of them: pi-dispatch chat <run-id>");
	return null;
}

/** After a live view ends, ask again until the run has left `live` (its record may land a moment after `done`). */
async function settle(client, lookup, info, sleep = (ms) => new Promise((r) => setTimeout(r, ms))) {
	let current = info;
	for (let i = 0; i < SETTLE_TRIES && current?.mode === "live"; i += 1) {
		await sleep(SETTLE_MS);
		const got = await client.run(lookup).catch(() => null);
		if (got?.status === 200 && got.json) current = got.json;
	}
	if (current?.mode === "live") return { ...current, mode: null, says: "the run's stream ended but the console still shows it live; open it again in a moment" };
	return current;
}

/** This host's record of `jobId` (the run history the worker writes): `{record}` (null when absent) or `{problem}`. */
async function readLocalRecord(jobId, { deployment, deps }) {
	let read = deps.readRecord;
	if (typeof read !== "function") {
		const d = deployment(["PI_LOGS_DIR"]);
		if (d.problem) return { problem: `${d.problem}, so this host's run history cannot be found` };
		const [{ makeReadRecord }, { logsDirPath }] = await Promise.all([import("./run-history.mjs"), import("./config.mjs")]);
		read = makeReadRecord({ logsDir: logsDirPath(d.env) });
	}
	const got = read(jobId);
	// An unreadable file (`UNREADABLE_RECORD` names no job), or another job's record under a sanitized name that
	// collides, is no record: the console's copy is asked instead.
	return { record: got !== null && typeof got === "object" && got.jobId === jobId ? got : null };
}

/** The fork: plan, then run, printing refusals as sentences. */
async function forkRun({ values, env, out, err, cwd, home, deployment, deps, record, key, newerRunOnTarget }) {
	const fork = deps.fork ?? (await import("./chat-fork.mjs"));
	const d = deployment(["PI_SESSIONS_DIR"]);
	if (d.problem) {
		err(`error: ${d.problem}, so the session store cannot be found`);
		return 1;
	}
	const pi = fork.resolvePiBinary({ flag: values.pi ?? null, env });
	const piVersion = pi.path ? fork.piVersionOf(pi.path, { env }) : null;
	const planned = fork.planFork({ record, key, env: d.env, force: values.force, newerRunOnTarget, pi, piVersion });
	if (planned.refusal) {
		err(`error: ${await safe(planned.refusal)}`);
		return 1;
	}
	const { agentDirFrom } = await import("./host-pi.mjs");
	return fork.runFork({ plan: planned.plan, out, ask: deps.ask ?? ((q) => askYesNo(q)), agentDir: agentDirFrom(env), cwd, home, tools: values.tools, env });
}
