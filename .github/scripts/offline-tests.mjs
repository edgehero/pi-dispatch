/**
 * Refuse every connection a test opens to anything but this machine, and write each refusal down, for the CI run
 * that proves the suite is offline (issue #1102).
 *
 * THE JOB'S NAME SAID OFFLINE AND NOTHING MADE IT SO. `contract-tests` is "pinned assumptions still hold (offline, no
 * API key)", yet nothing refused a connection: `worker/test/start-wiring.test.mjs` booted the worker on the real
 * GitHub sign-in, so every boot that injected none ran `gh auth token` and sent `GET /user` to api.github.com, with
 * the machine's own token wherever `gh` is logged in. The issue counted 122 such connections in one run of that file,
 * and every test passed. A suite that reaches a real service depends on the network and on that service's answers,
 * and a token that ever reaches such a request goes with it.
 *
 * SO THE LOG IS THE ORACLE, NOT THE SUITE'S VERDICT. A test that tolerates a refused connect passes whether the
 * connect succeeded or not, which is exactly how the leak above stayed green. Each refusal appends one JSON line to
 * the file `OFFLINE_TESTS_LOG` names, and the step after the suite fails the job when that file has a line, or is
 * missing: this file creates it, empty, as it loads, so a missing log is a suite this never loaded in. With no file
 * named the refusal still happens and nothing is written: a local run of one test file is refused the same way.
 *
 * WHAT IS REFUSED: every `net.Socket` connect, so `http`, `https`, `tls`, undici's `fetch` and every client built on
 * them, whose host is not a literal loopback address or "localhost". The predicate is
 * image/runner/test/fixtures/offline-fetch.mjs's (issue #1098), and the arguments are read by net's own rule
 * (`normalizeArgs`). The refusal comes before any lookup: the socket is destroyed with an error on the next tick, as
 * a connect that failed would be, so a name never reaches a resolver and no packet leaves. A Unix socket path passes;
 * a name that merely starts with "127." (127.example.com) is a name to look up, and is refused. It is the NAME that
 * is judged, not the address: a connect to "localhost" that brings its own `lookup` could resolve it elsewhere.
 *
 * EVERY NODE CHILD, NOT ONLY ONE THAT INHERITS. Delivered through `NODE_OPTIONS`, and handed on the way that variable
 * cannot hand itself: a child spawned with an environment of its own (an allowlist, or one that sets its own
 * `NODE_OPTIONS`, as the runner's child-meter and MCP tests do) gets `--import` of this file added to its
 * `NODE_OPTIONS`, and `OFFLINE_TESTS_LOG` and `OFFLINE_TESTS_FILE` when it names neither. In the child, the
 * `NODE_OPTIONS` its spawner chose is put back before any of its own code runs, so what a test reads there (mcp.test.mjs
 * pins its stdio server's exact value) is still what it set. A test that refuses on purpose names `OFFLINE_TESTS_LOG`
 * as "" in the child's environment, so its expected refusal is not the CI log's.
 *
 * WHAT IT CANNOT SEE, stated rather than implied: a UDP socket or a bare DNS query (`dgram`, `dns.resolve`), which no
 * test makes today; a worker thread, which runs no `--import` module (measured on Node 22.19, its own `execArgv`
 * included), and no test starts one that connects; and a child that is not Node (`gh`, `git`, `curl`), which carries
 * the variables to any Node it starts but whose own connections nothing here can refuse.
 *
 * Through `npm test`, npm itself loads it too, and its own update check is refused and written down when npm's cache
 * has no recent one (an empty HOME); npm skips that check under `CI=true`, which Actions sets, so CI's log holds tests
 * alone (measured both ways). A test file can also import `refusals` from here to fail on its own when it reaches the
 * network (worker/test/helpers/offline.mjs), with or without CI.
 */
import cp from "node:child_process";
import { appendFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const OPTION = `--import ${import.meta.url}`;
// The NODE_OPTIONS a spawner chose for a child this file was added to, as JSON (null: it named none).
const CHOSEN = "OFFLINE_TESTS_NODE_OPTIONS";

// Put back the NODE_OPTIONS this process's spawner chose, before any code of its own reads it.
if (process.env[CHOSEN] !== undefined) {
	let chosen = null;
	try {
		chosen = JSON.parse(process.env[CHOSEN]);
	} catch {
		chosen = null;
	}
	if (typeof chosen === "string") process.env.NODE_OPTIONS = chosen;
	else delete process.env.NODE_OPTIONS;
	delete process.env[CHOSEN];
}

const log = process.env.OFFLINE_TESTS_LOG || "";
// The test file this process runs, else the one its spawner ran: a child names no test file in its own stack, so a
// test file's process puts its path where every child it starts finds it.
if (process.argv[1]?.endsWith(".test.mjs")) process.env.OFFLINE_TESTS_FILE = process.argv[1];
const testFile = process.env.OFFLINE_TESTS_FILE || null;

// Only a literal loopback address or "localhost": a name that merely starts with "127." (127.example.com) is a name
// to look up, and so is anything else.
export const loopback = (host) => host === "localhost" || host === "::1" || host === "[::1]" || (typeof host === "string" && /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host));

/** Every refusal in this process, in order: what a test file's own `after` hook reads. */
export const refusals = [];

/** The test file a stack names: its first frame in a `*.test.mjs`, else the file this process or its spawner ran. */
const testFileOf = (stack) => {
	const frame = stack.find((line) => /\.test\.mjs:\d+/.test(line));
	return frame ? frame.replace(/^.*?(?:file:\/\/)?([^\s(]*\.test\.mjs):\d+.*$/, "$1") : testFile;
};

// Enough frames to get past undici's own (Node's default of ten ends inside them, which is why issue #1102's first
// measurement could not name a caller) to the module that asked. Node's own frames, undici's among them, and this
// file's name nothing a reader can fix.
const callerStack = () => {
	const limit = Error.stackTraceLimit;
	Error.stackTraceLimit = 60;
	const stack = new Error("refused").stack;
	Error.stackTraceLimit = limit;
	return stack
		.split("\n")
		.slice(1)
		.map((line) => line.trim())
		.filter((line) => !/node:|<anonymous>|offline-tests\.mjs/.test(line))
		.slice(0, 30);
};

const record = (refusal) => {
	refusals.push(refusal);
	try {
		if (log) appendFileSync(log, `${JSON.stringify(refusal)}\n`);
	} catch {
		// The connect is refused either way; a line that could not be written shows only as a shorter log.
	}
};

// The log exists from the moment this loads, so CI can tell "nothing refused" from "never loaded".
try {
	if (log) appendFileSync(log, "");
} catch {
	// Unwritable: the step after the suite then finds no log and fails, which is the right answer.
}

const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
	// net's own reading (`normalizeArgs`): an object is the options; a string that is not a number of 0 or more is a
	// pipe path; anything else is a port, with a host only when the second argument is a string (a function there is
	// the callback, and the host is then localhost).
	let options = Array.isArray(args[0]) ? args[0][0] : args[0];
	if (typeof options !== "object" || options === null) options = typeof args[0] === "string" && !(Number(args[0]) >= 0) ? { path: args[0] } : { port: args[0], host: typeof args[1] === "string" ? args[1] : undefined };
	// Any path at all is a Unix socket, as `Socket.prototype.connect` reads it, whatever else is set beside it
	// (node:http's agent passes `path: null` beside its host when it means TCP). A missing host is "localhost".
	if (!options.path && !loopback(options.host ?? "localhost")) {
		const host = options.host;
		const stack = callerStack();
		record({ host: String(host), port: options.port ?? null, test: testFileOf(stack), stack });
		// ECONNREFUSED, what an unreachable host answers, so a caller that reads the code takes its ordinary path.
		const error = Object.assign(new Error("offline: an outbound connection was refused (issue #1102)"), { code: "ECONNREFUSED" });
		process.nextTick(() => this.destroy(error));
		return this;
	}
	return connect.apply(this, args);
};

/** `NODE_OPTIONS` with this file added, unless it already names it. */
const withSelf = (value) => (String(value ?? "").includes(SELF) || String(value ?? "").includes(import.meta.url) ? value : `${value ? `${value} ` : ""}${OPTION}`);

// Every async spawn (spawn, exec, execFile, fork) reaches this with the child's environment as `envPairs`, inherited
// or given. The guard never throws: a child this cannot amend is spawned exactly as asked.
const spawn = cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn = function (options) {
	try {
		const pairs = Array.isArray(options?.envPairs) ? options.envPairs : null;
		if (pairs) {
			const at = pairs.findIndex((pair) => pair.startsWith("NODE_OPTIONS="));
			const chosen = at >= 0 ? pairs[at].slice("NODE_OPTIONS=".length) : null;
			const amended = withSelf(chosen);
			if (amended !== chosen) {
				if (at >= 0) pairs[at] = `NODE_OPTIONS=${amended}`;
				else pairs.push(`NODE_OPTIONS=${amended}`);
				const marker = pairs.findIndex((pair) => pair.startsWith(`${CHOSEN}=`));
				if (marker >= 0) pairs.splice(marker, 1);
				pairs.push(`${CHOSEN}=${JSON.stringify(chosen)}`);
			}
			if (log && !pairs.some((pair) => pair.startsWith("OFFLINE_TESTS_LOG="))) pairs.push(`OFFLINE_TESTS_LOG=${log}`);
			if (testFile && !pairs.some((pair) => pair.startsWith("OFFLINE_TESTS_FILE="))) pairs.push(`OFFLINE_TESTS_FILE=${testFile}`);
		}
	} catch {
		// Spawned as asked.
	}
	return spawn.call(this, options);
};

/** A sync spawn's environment, inherited or given, with this file handed on. */
const handedOn = (env) => {
	const chosen = env.NODE_OPTIONS ?? null;
	const amended = withSelf(chosen);
	return {
		...env,
		...(amended !== chosen ? { NODE_OPTIONS: amended, [CHOSEN]: JSON.stringify(chosen) } : {}),
		...(log && env.OFFLINE_TESTS_LOG === undefined ? { OFFLINE_TESTS_LOG: log } : {}),
		...(testFile && env.OFFLINE_TESTS_FILE === undefined ? { OFFLINE_TESTS_FILE: testFile } : {}),
	};
};

// The sync spawns build their environment where the hook above never sees it, so each gets one here: the options
// object is the last argument when it is one, and a call that passed none gets one, holding a copy of this
// process's environment, which is what that child would have inherited.
for (const name of ["spawnSync", "execFileSync", "execSync"]) {
	const real = cp[name];
	cp[name] = function (...args) {
		try {
			const last = args.length - 1;
			const options = args[last];
			if (last >= 1 && typeof options === "object" && options !== null && !Array.isArray(options)) args[last] = { ...options, env: handedOn(options.env ?? process.env) };
			else if (last >= 1 && options == null) args[last] = { env: handedOn(process.env) };
			else args.push({ env: handedOn(process.env) });
		} catch {
			// Spawned as asked.
		}
		return real.apply(this, args);
	};
}
syncBuiltinESMExports();
