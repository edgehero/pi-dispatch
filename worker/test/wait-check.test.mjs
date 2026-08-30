import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIT_HOLD } from "../src/exit-code.mjs";
import { makeWaitChecker } from "../src/wait-check.mjs";

// Issue #230, the wait-profile spawner. Driven through a fake `spawnFn` rather than real processes: the
// contract here is which exit code means what and what the seam refuses to read, and a real child would
// make those assertions slower without making them truer. The kill ladder and the timeout ARE exercised,
// because a script that ignores SIGTERM is the case an operator actually hits.

/** A fake child process with the EventEmitter surface `runCheck` uses. */
function fakeChild() {
	const handlers = new Map();
	const child = {
		kills: [],
		stdout: { on: (evt, fn) => handlers.set(`stdout:${evt}`, fn) },
		stderr: { on: (evt, fn) => handlers.set(`stderr:${evt}`, fn) },
		on: (evt, fn) => handlers.set(evt, fn),
		kill: (sig) => child.kills.push(sig ?? "SIGTERM"),
		emit: (evt, ...args) => handlers.get(evt)?.(...args),
		write: (which, bytes) => handlers.get(`${which}:data`)?.(Buffer.alloc(bytes)),
	};
	return child;
}

function checker({ code, profiles = { jira: "/opt/pi/wait.sh" }, timeoutMs = 10_000, spawnThrows = false, onSpawn } = {}) {
	const seen = { args: null, opts: null, logs: [] };
	const child = fakeChild();
	const spawnFn = (path, args, opts) => {
		if (spawnThrows) throw new Error("EACCES");
		seen.args = { path, args };
		seen.opts = opts;
		if (onSpawn) onSpawn(child);
		else queueMicrotask(() => child.emit("exit", code, null));
		return child;
	};
	const check = makeWaitChecker({ profiles, timeoutMs, spawnFn, realExecutablePath: (p) => p, log: (e, f) => seen.logs.push({ e, f }) });
	return { check, seen, child };
}

test("the four codes map to the three verdicts, and only 2 is terminal", async () => {
	for (const [code, expected] of [
		[0, { verdict: "go", fault: false }],
		[EXIT_HOLD, { verdict: "hold", fault: false }],
		[2, { verdict: "refuse", fault: false }],
		[1, { verdict: "hold", fault: true }],
		[6, { verdict: "hold", fault: true }],
		[127, { verdict: "hold", fault: true }],
	]) {
		const { check } = checker({ code });
		assert.deepEqual(await check("jira", "acme/web#7"), expected, `exit ${code}`);
	}
});

test("the check receives the id-only target as argv[1], never a title or a body", async () => {
	const { check, seen } = checker({ code: 0 });
	await check("jira", "acme/web#7");
	assert.deepEqual(seen.args, { path: "/opt/pi/wait.sh", args: ["acme/web#7"] }, "an ARRAY, so nothing interpolates");
	assert.equal(seen.opts.shell, false);
	assert.deepEqual(seen.opts.stdio, ["ignore", "pipe", "pipe"], "stdin ignored: a script that prompts dies at once rather than blocking to its timeout");
});

test("both streams are byte COUNTERS -- a check's output never becomes text this project carries", async () => {
	// stderr for the resolver's reason (a script's error text echoes the ticket or the query); stdout for
	// the same reason one step further, since a check's stdout is a third party's words arriving through an
	// operator's script. The only thing this seam reads from either is how much there was.
	const { check, seen, child } = checker({
		onSpawn: (c) => queueMicrotask(() => {
			c.write("stdout", 40);
			c.write("stderr", 12);
			c.emit("exit", 0, null);
		}),
	});
	const verdict = await check("jira", "acme/web#7");
	assert.deepEqual(verdict, { verdict: "go", fault: false });
	const line = seen.logs.find((l) => l.e === "wait_check");
	assert.equal(line.f.stdoutBytes, 40);
	assert.equal(line.f.stderrBytes, 12);
	// A REAL assertion, not one against a string the fake never produces: the log line carries counts and
	// the profile NAME, and never the resolved path, the raw output, or anything derived from either.
	assert.deepEqual(Object.keys(line.f).sort(), ["code", "detail", "profile", "stdoutBytes", "stderrBytes"].sort());
	assert.equal(JSON.stringify(line.f).includes("/opt/pi"), false, "never the resolved path -- that is deployment topology");
	assert.equal(typeof line.f.stdoutBytes, "number", "a count, so there is no string to leak in the first place");
	assert.equal(typeof line.f.stderrBytes, "number");
	void child;
});

test("an undeclared profile, and a declared one whose path does not resolve, are both profileUnknown", async () => {
	const { check } = checker({ code: 0 });
	assert.deepEqual(await check("nope", "acme/web#7"), { profileUnknown: "nope" });

	const gone = makeWaitChecker({ profiles: { jira: "/opt/gone.sh" }, spawnFn: () => { throw new Error("unreachable"); }, realExecutablePath: () => null });
	assert.deepEqual(await gone("jira", "acme/web#7"), { profileUnknown: "jira" }, "resolved at check time, so a deleted script stops being admitted");

	const throws = makeWaitChecker({ profiles: { jira: "/opt/x.sh" }, spawnFn: () => { throw new Error("unreachable"); }, realExecutablePath: () => { throw new Error("ENOENT"); } });
	assert.deepEqual(await throws("jira", "acme/web#7"), { profileUnknown: "jira" }, "a probe that throws is a probe that said no");
});

test("a check that cannot RUN is a fault hold, never a refusal", async () => {
	// CONST-RETRY-INFRA-ONLY in the cheap direction: a check that has not answered has not answered no, and
	// dropping a paid delivery over an unreachable dependency is the expensive mistake. The fault count is
	// what keeps this from being unbounded.
	const { check } = checker({ spawnThrows: true });
	assert.deepEqual(await check("jira", "acme/web#7"), { verdict: "hold", fault: true });

	const errored = checker({ onSpawn: (c) => queueMicrotask(() => c.emit("error", new Error("EPIPE"))) });
	assert.deepEqual(await errored.check("jira", "acme/web#7"), { verdict: "hold", fault: true });

	// A signalled death reports code null. Classified explicitly rather than left to fall through the code
	// switch, so the log line says `signal-SIGKILL` instead of an exit that never happened.
	const signalled = checker({ onSpawn: (c) => queueMicrotask(() => c.emit("exit", null, "SIGKILL")) });
	assert.deepEqual(await signalled.check("jira", "acme/web#7"), { verdict: "hold", fault: true });
	assert.equal(signalled.seen.logs.find((l) => l.e === "wait_check").f.detail, "signal-SIGKILL");
});

test("a hanging check is killed at the timeout, SIGTERM then SIGKILL, and holds", async () => {
	const { check, child } = checker({ timeoutMs: 5, onSpawn: () => {} }); // never closes
	const verdict = await check("jira", "acme/web#7");
	assert.deepEqual(verdict, { verdict: "hold", fault: true }, "a timeout is unanswered, not refused");
	assert.deepEqual(child.kills, ["SIGTERM"], "the first signal lands immediately");
	await new Promise((r) => setTimeout(r, 2100));
	assert.deepEqual(child.kills, ["SIGTERM", "SIGKILL"], "and the escalation still lands on a child that ignored it -- the kill timer is deliberately not cleared when the promise settles");
});

test("an abort holds but is NOT a fault -- a worker shutdown is not the operator's script failing", async () => {
	// Five restarts landing mid-check would otherwise exhaust PI_WAIT_MAX_FAULTS and terminate the job with
	// a public comment blaming the check for the worker's own rolling deploy.
	const controller = new AbortController();
	const { check, child } = checker({ onSpawn: () => queueMicrotask(() => controller.abort()) });
	const verdict = await check("jira", "acme/web#7", { signal: controller.signal });
	assert.deepEqual(verdict, { verdict: "hold", fault: false, aborted: true });
	assert.deepEqual(child.kills, ["SIGTERM"], "and the child is still stopped, not stranded");

	// A TIMEOUT, by contrast, IS the check failing to answer and does count.
	const slow = checker({ timeoutMs: 5, onSpawn: () => {} });
	assert.deepEqual(await slow.check("jira", "acme/web#7"), { verdict: "hold", fault: true });
});

test("the checker never throws, whatever the child does", async () => {
	// It runs at the pickup gate, ABOVE the processor's try, where a rejection would escape into BullMQ's
	// failed-attempt handling and turn a check that could not run into a retried job.
	for (const onSpawn of [
		(c) => queueMicrotask(() => c.emit("exit", undefined, null)),
		(c) => queueMicrotask(() => c.emit("error", "not even an Error")),
		(c) => queueMicrotask(() => { c.emit("exit", 0, null); c.emit("close", 1, null); }),
	]) {
		const { check } = checker({ onSpawn });
		const verdict = await check("jira", "acme/web#7");
		assert.ok(verdict.verdict === "go" || verdict.verdict === "hold", JSON.stringify(verdict));
	}
});

test("an unusable target holds rather than spawning, and says so", async () => {
	// `targetFor` answers null for any kind that is neither local nor a forge, and `spawn(path, [null])`
	// throws -- which would surface as a silent fault hold, killing the job as `wait-unanswerable` and
	// blaming the operator's check for a shape it never saw. The leading-dash refusal is run.secrets' own.
	for (const bad of [null, undefined, "", 42, "-rf"]) {
		let spawned = 0;
		const check = makeWaitChecker({ profiles: { jira: "/opt/pi/wait.sh" }, spawnFn: () => (spawned++, null), realExecutablePath: (p) => p, log: () => {} });
		const verdict = await check("jira", bad);
		assert.deepEqual(verdict, { verdict: "hold", fault: true, unusableTarget: true }, `target ${JSON.stringify(bad)}`);
		assert.equal(spawned, 0, "and nothing was spawned with it");
	}
});

test("a check whose script leaves a background process still answers at once (#230)", async () => {
	// `close` waits for stdio EOF, which any inherited background process holds open. A check answering
	// `exit 0` in a millisecond would then be reported as a timeout, charged a fault, and after five of them
	// the job dies blaming the operator's script for something it did correctly.
	const { check, child } = checker({
		onSpawn: (c) => queueMicrotask(() => c.emit("exit", 0, null)), // exits; pipes never reach EOF
		timeoutMs: 50,
	});
	const started = Date.now();
	const verdict = await check("jira", "acme/web#7");
	assert.deepEqual(verdict, { verdict: "go", fault: false });
	assert.ok(Date.now() - started < 40, "answered on exit, not after the timeout");
	assert.deepEqual(child.kills, [], "and nothing was killed: it finished on its own");
});
