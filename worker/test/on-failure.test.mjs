import assert from "node:assert/strict";
import { test } from "node:test";
import { makeOnFailure } from "../src/on-failure.mjs";

// Issue #288, the operator's failure hook. Driven through a fake spawnFn (wait-check.test.mjs's
// harness, reduced with its subject): the contract is the argv shape, the never-throws posture and the
// pinned log line, and a real child would make none of those truer.

/** A fake child process with the EventEmitter surface `fire` uses. */
function fakeChild() {
	const handlers = new Map();
	const child = {
		kills: [],
		on: (evt, fn) => handlers.set(evt, fn),
		kill: (sig) => child.kills.push(sig ?? "SIGTERM"),
		emit: (evt, ...args) => handlers.get(evt)?.(...args),
	};
	return child;
}

function hook({ code = 0, spawnThrows = false, onSpawn, timeoutMs = 10_000, host = "mini", command = "/opt/pi/notify.sh" } = {}) {
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
	const fire = makeOnFailure({ command, timeoutMs, spawnFn, realExecutablePath: (p) => p, hostEnv: { HOME: "/h" }, host, log: (e, f) => seen.logs.push({ e, f }) });
	return { fire, seen, child };
}

const flush = () => new Promise((r) => setImmediate(r));

test("the hook receives exactly [jobId, outcome, reason, host], exec'd with no shell and every stream ignored", async () => {
	const { fire, seen } = hook();
	fire({ jobId: "gh-1", outcome: "failed", reason: "container-never-started" });
	await flush();
	assert.deepEqual(seen.args, { path: "/opt/pi/notify.sh", args: ["gh-1", "failed", "container-never-started", "mini"] }, "an ARRAY, so nothing interpolates");
	assert.equal(seen.opts.shell, false);
	assert.deepEqual(seen.opts.stdio, ["ignore", "ignore", "ignore"], "nothing is entitled to read a notification's output");
	assert.deepEqual(seen.opts.env, { HOME: "/h" }, "the worker's own env, injected");
	assert.deepEqual(seen.logs, [{ e: "on_failure", f: { jobId: "gh-1", code: 0, detail: "exit" } }]);
	assert.deepEqual(Object.keys(seen.logs[0].f), ["jobId", "code", "detail"], "the pinned key set -- no message, no argv echo");
});

test("a message-shaped reason flattens to the fixed token infra before it can become argv", async () => {
	const { fire, seen } = hook();
	fire({ jobId: "gh-1", outcome: "failed", reason: "infra failure, container exit 1" });
	await flush();
	assert.equal(seen.args.args[2], "infra", "InfraRetry.reason defaults to the whole message; nothing message-shaped crosses");
	const shouty = hook();
	shouty.fire({ jobId: "gh-1", outcome: "failed", reason: "Not-A-Token" });
	await flush();
	assert.equal(shouty.seen.args.args[2], "infra", "uppercase is not the fixed-token shape");
});

test("unusable argv never spawns: a leading-dash jobId, an empty outcome, a missing jobId", async () => {
	for (const bad of [{ jobId: "-rf", outcome: "failed", reason: "infra" }, { jobId: "gh-1", outcome: "", reason: "infra" }, { outcome: "failed", reason: "infra" }]) {
		const { fire, seen } = hook();
		fire(bad);
		await flush();
		assert.equal(seen.args, null, `${JSON.stringify(bad)} must not spawn -- argv[1] is where a dash parses as a flag`);
		assert.equal(seen.logs[0]?.f?.detail, "argv-unusable");
	}
	// An empty HOST is legitimate (an undeclared single-host deployment) and spawns.
	const anon = hook({ host: "" });
	anon.fire({ jobId: "gh-1", outcome: "failed", reason: "infra" });
	await flush();
	assert.deepEqual(anon.seen.args.args, ["gh-1", "failed", "infra", ""]);
});

test("an unresolvable command logs and never spawns; resolution happens at FIRE time, not construction", async () => {
	const seen = { logs: [] };
	let answer = null;
	const fire = makeOnFailure({ command: "/opt/pi/notify.sh", spawnFn: () => assert.fail("must not spawn"), realExecutablePath: () => answer, log: (e, f) => seen.logs.push({ e, f }) });
	fire({ jobId: "gh-1", outcome: "failed", reason: "infra" });
	assert.deepEqual(seen.logs, [{ e: "on_failure", f: { jobId: "gh-1", code: null, detail: "unresolvable" } }]);
	// The operator fixes the path mid-day; the SAME hook now resolves (a probing spawnFn proves it ran).
	let spawned = false;
	const fire2 = makeOnFailure({
		command: "/opt/pi/notify.sh",
		spawnFn: () => ((spawned = true), fakeChild()),
		realExecutablePath: () => "/opt/pi/notify.sh",
		log: () => {},
	});
	fire2({ jobId: "gh-1", outcome: "failed", reason: "infra" });
	assert.equal(spawned, true);
});

test("a throwing spawn, a throwing log sink, and a signalled death are all absorbed -- fire never throws", async () => {
	const { fire, seen } = hook({ spawnThrows: true });
	fire({ jobId: "gh-1", outcome: "failed", reason: "infra" });
	assert.equal(seen.logs[0].f.detail, "spawn");
	const loud = makeOnFailure({ command: "/x", spawnFn: () => fakeChild(), realExecutablePath: (p) => p, log: () => { throw new Error("sink"); } });
	loud({ jobId: "gh-1", outcome: "failed", reason: "infra" }); // not throwing IS the assertion
	const sig = hook({ onSpawn: (child) => queueMicrotask(() => child.emit("exit", null, "SIGKILL")) });
	sig.fire({ jobId: "gh-1", outcome: "failed", reason: "infra" });
	await flush();
	assert.deepEqual(sig.seen.logs[0].f, { jobId: "gh-1", code: null, detail: "signal-SIGKILL" });
});

test("the timeout SIGTERMs, escalates to SIGKILL after the grace, and names itself timeout rather than blaming the signal", async () => {
	const { fire, seen, child } = hook({ timeoutMs: 20, onSpawn: () => {} });
	fire({ jobId: "gh-1", outcome: "failed", reason: "infra" });
	await new Promise((r) => setTimeout(r, 40));
	assert.deepEqual(child.kills, ["SIGTERM"], "the polite kill first");
	child.emit("exit", null, "SIGTERM");
	assert.deepEqual(seen.logs[0].f, { jobId: "gh-1", code: null, detail: "timeout" });
	// A child that ignores SIGTERM meets the escalation.
	const stubborn = hook({ timeoutMs: 20, onSpawn: () => {} });
	stubborn.fire({ jobId: "gh-1", outcome: "failed", reason: "infra" });
	await new Promise((r) => setTimeout(r, 40 + 2100));
	assert.deepEqual(stubborn.child.kills, ["SIGTERM", "SIGKILL"], "the ladder lands on a child that ignored SIGTERM");
});
