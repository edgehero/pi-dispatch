import assert from "node:assert/strict";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { CHAT_USAGE, classifyChatTarget, runChat } from "../src/chat-cli.mjs";
import { main } from "../src/cli.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #647: `pi-dispatch chat`'s argument classes and its dispatch on the console's mode, every collaborator faked.

const KEY = "0123456789abcdef0123456789abcdef";
const TOKEN = "pdc_cli-token-value";

test("argument classes: a 32-hex key, an http(s) URL, a run id, and anything else refused", () => {
	assert.deepEqual(classifyChatTarget(KEY), { kind: "key", key: KEY });
	assert.deepEqual(classifyChatTarget("https://github.com/o/r/issues/7"), { kind: "url", url: "https://github.com/o/r/issues/7" });
	assert.deepEqual(classifyChatTarget("repeat:nightly:1760000000000"), { kind: "id", id: "repeat:nightly:1760000000000" });
	assert.deepEqual(classifyChatTarget("1234"), { kind: "id", id: "1234" });
	assert.equal(classifyChatTarget(KEY.toUpperCase()).kind, "id", "an uppercase hex string is a run id, never a key");
	assert.match(classifyChatTarget("").refusal, /name a run/);
	assert.match(classifyChatTarget("http://[bad").refusal, /does not parse/);
	assert.match(classifyChatTarget("a b").refusal, /neither a run id/);
	assert.match(classifyChatTarget(`https://x/${"a".repeat(2100)}`).refusal, /longer than 2048/);
});

test("the CLI's usage lists chat, and an unknown chat flag is refused before anything is asked", async () => {
	let usage = "";
	await main(["--help"], {}, { write: (c) => (usage += c) });
	assert.ok(usage.includes(CHAT_USAGE));
	const err = [];
	assert.equal(await runChat(["j1", "--bogus"], { env: {}, err: (l) => err.push(l), out: () => {} }), 1);
	assert.match(err[0], /Unknown option/);
	assert.equal(await runChat([], { env: {}, err: () => {}, out: () => {} }), 1);
	assert.equal(await runChat(["a", "b"], { env: {}, err: () => {}, out: () => {} }), 1);
});

/** A world of fakes: the console client, the views and the fork, each recording what it was given. */
function world({ runs = [{ status: 200, json: { run: { jobId: "j1" }, mode: "fork" } }], who = { name: "rob", role: "operator", readOnly: false }, local = null, live = { detached: true }, reply = { detached: true }, readRecord = null, answer = false, deploymentExtra = {}, cwd = undefined } = {}) {
	const seen = { clients: 0, runs: [], forks: [], runForks: [], asks: [], lives: 0, replies: 0, questions: 0, out: [], err: [] };
	const client = {
		async whoami() {
			return who;
		},
		async run(q) {
			seen.runs.push(q);
			return runs[Math.min(seen.runs.length - 1, runs.length - 1)];
		},
	};
	const fork = {
		resolvePiBinary: () => ({ path: "/bin/pi", from: "PATH" }),
		piVersionOf: () => "1.2.0",
		planFork: (input) => {
			seen.forks.push(input);
			return input.record?.refuse ? { refusal: "this run worked on a pull or merge request" } : { plan: { key: KEY } };
		},
		runFork: async (input) => {
			seen.runForks.push(input);
			return 0;
		},
	};
	const deps = {
		makeClient: (opts) => {
			seen.clients += 1;
			seen.clientOpts = opts;
			return client;
		},
		readRecord: readRecord ?? ((id) => (local && local.jobId === id ? local : null)),
		ask: async (q) => {
			seen.asks.push(q);
			return answer;
		},
		fork,
		loadPiTui: async () => ({ ProcessTerminal: class {} }),
		terminal: {},
		runLive: async () => {
			seen.lives += 1;
			return typeof live === "function" ? live() : live;
		},
		runReply: async () => {
			seen.replies += 1;
			return reply;
		},
		question: async () => {
			seen.questions += 1;
			return { question: "which?" };
		},
		sleep: async () => {},
		askToken: async () => null,
		// The .env trust check reads a real folder; a world names one with `cwd`, and otherwise the file is trusted.
		...(cwd === undefined ? { envTrust: () => null } : {}),
	};
	const run = (argv, env = { PI_CONSOLE_TOKEN: TOKEN }) => runChat(argv, { env, out: (l) => seen.out.push(l), err: (l) => seen.err.push(l), deploymentEnv: (e) => ({ env: { ...e, PI_SESSIONS_DIR: "/s", ...deploymentExtra } }), cwd, deps });
	return { seen, run, client };
}

test("a session key always forks on this host, with no console at all", async () => {
	const w = world();
	assert.equal(await w.run([KEY], {}), 0);
	assert.equal(w.seen.clients, 0, "no console is dialled and no token asked for");
	assert.deepEqual(w.seen.forks.map((f) => [f.record, f.key, f.env.PI_SESSIONS_DIR]), [[null, KEY, "/s"]]);
});

test("--fork with a run id this host's history holds needs no console; without one, the console's record is forked", async () => {
	const local = { jobId: "j1", kind: "github", target: "o/r#7" };
	const w = world({ local });
	assert.equal(await w.run(["j1", "--fork"], {}), 0);
	assert.equal(w.seen.clients, 0);
	assert.equal(w.seen.forks[0].record, local);
	const remote = { jobId: "j9", kind: "github", target: "o/r#9" };
	const v = world({ runs: [{ status: 200, json: { run: remote, mode: "live", newerRunOnTarget: "j10" } }] });
	assert.equal(await v.run(["j9", "--fork"]), 0);
	assert.equal(v.seen.lives, 0, "--fork forces the fork whatever the mode");
	assert.equal(v.seen.forks[0].record, remote);
	assert.equal(v.seen.forks[0].newerRunOnTarget, "j10", "the console names the newer run by its job id");
	const refused = world({ local: { jobId: "j1", refuse: true } });
	assert.equal(await refused.run(["j1", "--fork"], {}), 1);
	assert.match(refused.seen.err[0], /pull or merge request/);
});

test("the console's mode decides: fork prefers the local record, reply asks the question, null prints says", async () => {
	const local = { jobId: "j1", kind: "github", target: "o/r#7", endedAt: "x" };
	const f = world({ local, runs: [{ status: 200, json: { run: { jobId: "j1" }, mode: "fork" } }] });
	assert.equal(await f.run(["https://github.com/o/r/issues/7"]), 0);
	assert.deepEqual(f.seen.runs, [{ url: "https://github.com/o/r/issues/7" }]);
	assert.equal(f.seen.forks[0].record, local);
	assert.equal(f.seen.clientOpts.token, TOKEN);
	assert.equal(f.seen.clientOpts.address.hostHeader, "127.0.0.1:4790");
	const r = world({ runs: [{ status: 200, json: { run: { jobId: "j1" }, mode: "reply" } }], reply: { answered: true, result: { jobIds: ["j2"] } } });
	assert.equal(await r.run(["j1"]), 0);
	assert.equal(r.seen.questions, 1);
	assert.match(r.seen.out.at(-1), /answered: the run resumes as j2; follow it with pi-dispatch chat j2/);
	const n = world({ runs: [{ status: 200, json: { run: { jobId: "j1" }, mode: null, says: "this run is still queued: it has no chat until it starts \u001b[2J" } }] });
	assert.equal(await n.run(["j1"]), 1);
	assert.match(n.seen.err[0], /still queued/);
	assert.ok(!n.seen.err[0].includes("\u001b"), "console text is scrubbed for the terminal");
});

test("a live attach that ends asks again and goes on in the new mode; a detach exits 0", async () => {
	const w = world({
		runs: [
			{ status: 200, json: { run: { jobId: "j1" }, mode: "live" } },
			{ status: 200, json: { run: { jobId: "j1" }, mode: "live" } },
			{ status: 200, json: { run: { jobId: "j1" }, mode: "reply", state: "awaiting-input" } },
		],
		live: { ended: true, info: { run: { jobId: "j1" }, mode: "live" } },
		reply: { detached: true },
	});
	assert.equal(await w.run(["j1"]), 0);
	assert.equal(w.seen.lives, 1);
	assert.equal(w.seen.replies, 1, "the parked run's reply box follows the live view");
	assert.match(w.seen.out.join("\n"), /no longer live \(awaiting-input\)/);
	const d = world({ runs: [{ status: 200, json: { run: { jobId: "j1" }, mode: "live" } }], live: { detached: true } });
	assert.equal(await d.run(["j1"]), 0);
	assert.deepEqual(d.seen.out, ["detached; the run goes on"]);
});

test("a refused lookup prints the console's sentence and an ambiguous item's candidates; no token is a refusal", async () => {
	const w = world({ runs: [{ status: 409, json: { error: "that Azure work item has runs in two projects", candidates: [{ jobId: "a1", target: "org/p1#5" }, { jobId: "a2", target: "org/p2#5" }] } }] });
	assert.equal(await w.run(["https://dev.azure.com/org/_workitems/edit/5"]), 1);
	assert.deepEqual(w.seen.err, ["error: that Azure work item has runs in two projects", "  a1  org/p1#5", "  a2  org/p2#5", "  name one of them: pi-dispatch chat <run-id>"]);
	const t = world();
	assert.equal(await t.run(["j1"], {}), 1);
	assert.match(t.seen.err[0], /no console token: set PI_CONSOLE_TOKEN/);
	assert.equal(t.seen.clients, 0);
	const bad = world();
	assert.equal(await bad.run(["j1", "--console", "https://x:1"]), 1);
	assert.match(bad.seen.err[0], /--console: the console speaks plain http/);
	assert.ok(!bad.seen.err.join("").includes(TOKEN));
});

test("a console that is not loopback is warned about and asked y/N (default no) before any token is read; --yes answers it", async () => {
	const no = world();
	assert.equal(await no.run(["j1", "--console", "console.example.com:4790"]), 1);
	assert.match(no.seen.err[0], /^warning: http:\/\/console\.example\.com:4790 is not on this machine, and the console speaks plain HTTP: the console token goes over the network to it unencrypted/);
	assert.deepEqual(no.seen.asks, ["Send the console token to http://console.example.com:4790 anyway? [y/N] "]);
	assert.equal(no.seen.err.at(-1), "error: not signed in; nothing was sent");
	assert.equal(no.seen.clients, 0, "nothing was dialled");
	const yes = world({ answer: true });
	assert.equal(await yes.run(["j1", "--console", "console.example.com:4790"]), 0);
	assert.equal(yes.seen.clients, 1);
	const flagged = world();
	assert.equal(await flagged.run(["j1", "--yes"], { PI_CONSOLE_TOKEN: TOKEN, PI_CONSOLE_URL: "10.0.0.5:4790" }), 0);
	assert.deepEqual(flagged.seen.asks, [], "--yes answers the question");
	assert.match(flagged.seen.err[0], /^warning: http:\/\/10\.0\.0\.5:4790 is not on this machine/, "the warning still prints");
	assert.equal(flagged.seen.clients, 1);
	const local = world();
	assert.equal(await local.run(["j1", "--console", "127.0.0.1:4790"]), 0);
	assert.deepEqual([local.seen.asks, local.seen.err], [[], []], "loopback is not asked about");
	const planted = world({ deploymentExtra: { PI_CONSOLE_LISTEN: "evil.example.com:80" } });
	assert.equal(await planted.run(["j1"]), 1);
	assert.match(planted.seen.err[0], /PI_CONSOLE_LISTEN in the deployment's \.env names http:\/\/evil\.example\.com:80, which is not a loopback address/);
	assert.deepEqual([planted.seen.asks, planted.seen.clients], [[], 0]);
});

test("a PI_CONSOLE_LISTEN from the folder's .env is taken only from a file no other account can change; the shell's always", async () => {
	const dir = tempDir("chat-cli-env-");
	writeFileSync(join(dir, ".env"), "PI_CONSOLE_LISTEN=127.0.0.1:4791\n");
	chmodSync(join(dir, ".env"), 0o620);
	const loose = world({ deploymentExtra: { PI_CONSOLE_LISTEN: "127.0.0.1:4791" }, cwd: dir });
	assert.equal(await loose.run(["j1"]), 1);
	assert.match(loose.seen.err[0], /PI_CONSOLE_LISTEN comes from .*\.env, which is owned by .* writable by the members of its group .*--console <host:port> or PI_CONSOLE_URL/);
	assert.equal(loose.seen.clients, 0, "no token went anywhere");
	const shell = world({ deploymentExtra: { PI_CONSOLE_LISTEN: "127.0.0.1:4791" }, cwd: dir });
	assert.equal(await shell.run(["j1"], { PI_CONSOLE_TOKEN: TOKEN, PI_CONSOLE_LISTEN: "127.0.0.1:4791" }), 0, "the shell's own value is the operator's");
	chmodSync(join(dir, ".env"), 0o600);
	const tight = world({ deploymentExtra: { PI_CONSOLE_LISTEN: "127.0.0.1:4791" }, cwd: dir });
	assert.equal(await tight.run(["j1"]), 0);
	assert.equal(tight.seen.clientOpts.address.port, 4791);
});

test("a local record is used only for its own job id; --force and --tools reach the fork; the fork is given pi's agent dir", async () => {
	const other = { jobId: "j1-other", kind: "github", target: "o/r#8" };
	const consoleRun = { jobId: "j1", kind: "github", target: "o/r#7" };
	const collided = world({ readRecord: () => other, runs: [{ status: 200, json: { run: consoleRun, mode: "fork" } }] });
	assert.equal(await collided.run(["j1", "--fork"]), 0);
	assert.equal(collided.seen.clients, 1, "the collided record is not taken: the console is asked");
	assert.equal(collided.seen.forks[0].record, consoleRun);
	const forced = world();
	assert.equal(await forced.run([KEY, "--force", "--tools"], { PI_CODING_AGENT_DIR: "/agent" }), 0);
	assert.equal(forced.seen.forks[0].force, true);
	assert.equal(forced.seen.runForks[0].tools, true);
	assert.equal(forced.seen.runForks[0].agentDir, "/agent");
	const plain = world();
	assert.equal(await plain.run([KEY], {}), 0);
	assert.equal(plain.seen.forks[0].force, false);
	assert.equal(plain.seen.runForks[0].tools, false);
});

test("a refused lookup's sentence is scrubbed for the terminal and kept on one line", async () => {
	const w = world({ runs: [{ status: 404, json: { error: "no run j1 \u001b]0;pwned\u0007here\nsecond line" } }] });
	assert.equal(await w.run(["j1"]), 1);
	assert.equal(w.seen.err.length, 1);
	assert.ok(!w.seen.err[0].includes("\u001b") && !w.seen.err[0].includes("\u0007"), JSON.stringify(w.seen.err[0]));
	assert.equal(w.seen.err[0], "error: no run j1 ]0;pwnedhere second line");
});

test("the CLI hands chat its positional and writes its refusals to stderr", async () => {
	const out = [];
	const errs = [];
	assert.equal(await main(["chat", "a b"], {}, { write: (c) => out.push(c), writeErr: (c) => errs.push(c) }), 1);
	assert.deepEqual(errs, ["error: the argument is neither a run id (letters, digits and . _ : -), an issue or pull request URL, nor a 32-hex session key\n"]);
	assert.deepEqual(out, []);
});


test("managed fork lists only supported source point metadata without invoking host pi", async () => {
	const w = world();
	w.client.getJson = async (path) => {
		assert.equal(path, "/api/fork-points?id=j1");
		return { status: 200, json: { entries: [{ id: "first", role: "user", positions: ["before"] }, { id: "unsafe", type: "message", positions: [] }] } };
	};
	assert.equal(await w.run(["j1", "--fork-as-job"]), 0);
	assert.match(w.seen.out.join("\n"), /first user/);
	assert.doesNotMatch(w.seen.out.join("\n"), /unsafe/);
	assert.equal(w.seen.forks.length, 0);
});

test("managed fork uses the same paid preview and confirmation with explicit point and model", async () => {
	const w = world({ answer: true });
	w.client.act = async (action, body, opts) => {
		assert.equal(action, "run-fork");
		assert.deepEqual(body, { jobId: "j1", entry: "first", position: "before", provider: "test", model: "large", thinking: "high", message: "Try again" });
		assert.equal(await opts.confirm(), true);
		return { ok: true, result: { jobId: "fork-job" } };
	};
	assert.equal(await w.run(["j1", "--fork-as-job", "--entry", "first", "--provider", "test", "--model", "large", "--thinking", "high", "--message", "Try again"]), 0);
	assert.equal(w.seen.forks.length, 0);
	assert.match(w.seen.asks[0], /paid fork/);
});

test("managed fork refuses viewers and conflicts with host-fork options", async () => {
	const viewer = world({ who: { role: "viewer" } });
	assert.equal(await viewer.run(["j1", "--fork-as-job", "--entry", "first"]), 1);
	assert.match(viewer.seen.err[0], /operator/);
	for (const args of [[KEY, "--fork-as-job"], ["j1", "--fork-as-job", "--fork"], ["j1", "--model", "large"]]) {
		const w = world();
		assert.equal(await w.run(args), 1);
		assert.equal(w.seen.clients, 0);
	}
});
