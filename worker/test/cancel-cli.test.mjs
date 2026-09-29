import assert from "node:assert/strict";
import { test } from "node:test";
import { runCancel } from "../src/cancel-cli.mjs";

// runCancel lazily imports connection/queue/host-registry even when every seam is injected (the pause
// verb's shape), so these skip below the node floor exactly as cli-control's queue tests do; CI runs them
// with PI_DISPATCH_REQUIRE_WORKER_TESTS=1 turning the skip into a hard failure elsewhere in the suite.
let depsOk = false;
try {
	await import("../src/connection.mjs");
	depsOk = true;
} catch {}
const needsDeps = depsOk ? false : `queue deps not installed (node ${process.version} < 22.19.0); CI runs these`;

/**
 * A whole fake deployment behind runCancel's seams. One shared `ops` array records redis and job calls in
 * order, because the held path's contract IS an order (hold keys before remove).
 */
function world({ hash = {}, state = "delayed", jobKnown = true, removeThrows = 0, ack, registryDown = false, queueNames = ["pi-jobs"] } = {}) {
	const ops = [];
	const out = [];
	const err = [];
	let removeAttempts = 0;
	const states = Array.isArray(state) ? [...state] : [state];
	const job = {
		async getState() {
			ops.push(["getState"]);
			return states.length > 1 ? states.shift() : states[0];
		},
		async remove() {
			ops.push(["remove"]);
			removeAttempts += 1;
			if (removeAttempts <= removeThrows) throw new Error("could not be removed because it is locked by another worker");
		},
	};
	const probe = {
		on() {},
		async hgetall(key) {
			ops.push(["hgetall", key]);
			return hash;
		},
		async get(key) {
			ops.push(["get", key]);
			return ack === undefined ? null : ack;
		},
		async set(key, value, px, ttl) {
			ops.push(["set", key, value, px, ttl]);
		},
		async del(key) {
			ops.push(["del", key]);
			return 1;
		},
		async srem(key, member) {
			ops.push(["srem", key, member]);
			return 1;
		},
		disconnect() {
			ops.push(["disconnect"]);
		},
	};
	const closed = [];
	const seams = {
		write: (chunk) => out.push(chunk),
		errWrite: (chunk) => err.push(chunk),
		redisFn: () => probe,
		parseConnectionFn: (url) => ({ url }),
		queueFn: (_conn, { name } = {}) => ({
			name,
			async getJob(id) {
				ops.push(["getJob", name, id]);
				return jobKnown ? job : null;
			},
			async close() {
				closed.push(name);
			},
		}),
		readLiveHostsFn: async () => (registryDown ? { unreachable: "registry boom" } : { hosts: {} }),
		discoverHostQueuesFn: async () => [],
		fleetQueueNamesFn: () => [],
		unionQueueNamesFn: () => queueNames,
		sleep: async () => {},
		pollMs: 250,
	};
	return { ops, out, err, closed, seams };
}

// Issue #464 (gate round 3): cancel judges the Valkey before it builds a client.
test("cancel stops on the Valkey refusal before it builds a client (#464)", { skip: needsDeps }, async () => {
	const { ops, err, seams } = world();
	const code = await runCancel("j1", "redis://x", { ...seams, refusalFn: async () => "the Valkey VALKEY_URL reaches is refused: held by op2" });
	assert.equal(code, 1);
	assert.match(err.join(""), /refused: held by op2/);
	assert.deepEqual(ops, [], "no client was asked anything");
});

test("a missing job id refuses with usage, before any connection", { skip: needsDeps }, async () => {
	const { err, seams } = world();
	const code = await runCancel(undefined, "redis://x", seams);
	assert.equal(code, 1);
	assert.match(err.join(""), /a job id is required/);
});

test("not-found names the queue count, and a degraded registry read separately -- an unregistered host may still hold it", { skip: needsDeps }, async () => {
	const plain = world({ jobKnown: false, queueNames: ["pi-jobs", "pi-jobs@a"] });
	assert.equal(await runCancel("j1", "redis://x", plain.seams), 1);
	assert.match(plain.err.join(""), /no job j1 in 2 queue\(s\)/);
	assert.ok(!plain.err.join("").includes("registry unreadable"), "a healthy registry adds no noise");
	const blind = world({ jobKnown: false, registryDown: true });
	assert.equal(await runCancel("j1", "redis://x", blind.seams), 1);
	assert.match(blind.err.join(""), /registry unreadable: registry boom/);
});

test("a held job goes through the shared removeHeldJob sequence: hold keys first, no record, exit 0", { skip: needsDeps }, async () => {
	const { ops, out, seams } = world({ hash: { since: "123", dedupId: "d1" }, state: "delayed" });
	const code = await runCancel("j1", "redis://x", seams);
	assert.equal(code, 0);
	assert.match(out.join(""), /cancelled j1/);
	assert.match(out.join(""), /never ran; no record written/);
	const names = ops.map((op) => op[0] + (op[1] ? `:${op[1]}` : ""));
	const delIdx = names.indexOf("del:wait:job:j1");
	const removeIdx = names.indexOf("remove");
	assert.ok(delIdx !== -1 && removeIdx !== -1 && delIdx < removeIdx, `hold keys must go before the job (${names.join(" -> ")})`);
});

test("a plain delayed job is removed: it never ran, no record, exit 0", { skip: needsDeps }, async () => {
	const { ops, out, seams } = world({ hash: {}, state: "delayed" });
	const code = await runCancel("j2", "redis://x", seams);
	assert.equal(code, 0);
	assert.match(out.join(""), /removed j2 \(delayed\)/);
	assert.ok(ops.some((op) => op[0] === "remove"));
	assert.ok(!ops.some((op) => op[0] === "del" && String(op[1]).startsWith("wait:")), "an unheld job has no hold keys to touch");
});

test("the queued-to-active race falls through to the cancel channel instead of failing the operator", { skip: needsDeps }, async () => {
	// remove() throws (picked up between getState and remove), the re-read says active, the channel acks.
	const { out, seams } = world({ hash: {}, state: ["delayed", "active"], removeThrows: 1, ack: "hostB" });
	const code = await runCancel("j3", "redis://x", seams);
	assert.equal(code, 0);
	assert.match(out.join(""), /cancel accepted by hostB/);
});

test("an active job's ack names the host, and an empty-string ack still reads as a worker", { skip: needsDeps }, async () => {
	const named = world({ hash: {}, state: "active", ack: "hostA" });
	assert.equal(await runCancel("j4", "redis://x", named.seams), 0);
	assert.match(named.out.join(""), /cancel accepted by hostA/);
	assert.match(named.out.join(""), /operator-cancel/);
	const anon = world({ hash: {}, state: "active", ack: "" });
	assert.equal(await runCancel("j4", "redis://x", anon.seams), 0);
	assert.match(anon.out.join(""), /cancel accepted by the worker/);
});

test("an unacknowledged active cancel says so, deletes its request, and exits 1 -- never a silent no-op", { skip: needsDeps }, async () => {
	const { ops, err, seams } = world({ hash: {}, state: "active" });
	const code = await runCancel("j5", "redis://x", { ...seams, ackTimeoutMs: 1000 });
	assert.equal(code, 1);
	assert.match(err.join(""), /no worker acknowledged within 1s/);
	assert.match(err.join(""), /nothing was changed/);
	assert.ok(ops.some((op) => op[0] === "del" && op[1] === "cancel:req:j5"), "the abandoned request must not fire after the operator walked away");
});

test("an unacknowledged cancel of a job that went back to the queue says so truthfully, and to cancel again (#476, PR #479 gate round 2)", { skip: needsDeps }, async () => {
	// The worker stops its cancel poll before it holds or retries a job, so a request landing then is never acknowledged,
	// and the job is delayed by the time the requester gives up: "the job is active" would be false.
	const { err, seams } = world({ hash: {}, state: ["active", "delayed"] });
	const code = await runCancel("j6", "redis://x", { ...seams, ackTimeoutMs: 1000 });
	assert.equal(code, 1);
	assert.match(err.join(""), /no worker acknowledged within 1s: the job went back to the queue before its worker read the cancel \(it is now delayed\), and nothing was changed\. Run `pi-dispatch cancel j6` again to remove it/);
	assert.doesNotMatch(err.join(""), /is active/);
});

test("an unacknowledged cancel names what became of the job: finished, or no longer in the queue (#476, PR #479 gate round 3)", { skip: needsDeps }, async () => {
	for (const after of ["completed", "failed"]) {
		const { err, seams } = world({ hash: {}, state: ["active", after] });
		assert.equal(await runCancel("j7", "redis://x", { ...seams, ackTimeoutMs: 1000 }), 1);
		assert.match(err.join(""), new RegExp(`no worker acknowledged within 1s: the job finished \\(${after}\\) before its worker read the cancel, and nothing was changed`), after);
		assert.doesNotMatch(err.join(""), /cancel .* again|went back to the queue/, `${after}: a finished job cannot be removed`);
	}
	const gone = world({ hash: {}, state: ["active", "unknown"] });
	assert.equal(await runCancel("j7", "redis://x", { ...gone.seams, ackTimeoutMs: 1000 }), 1);
	assert.match(gone.err.join(""), /no worker acknowledged within 1s: the job is no longer in the queue \(its state reads unknown\), and nothing was changed/);
	assert.doesNotMatch(gone.err.join(""), /again|went back/);
	for (const after of ["waiting", "prioritized", "paused"]) {
		const back = world({ hash: {}, state: ["active", after] });
		await runCancel("j7", "redis://x", { ...back.seams, ackTimeoutMs: 1000 });
		assert.match(back.err.join(""), new RegExp(`went back to the queue before its worker read the cancel \\(it is now ${after}\\).*again to remove it`), after);
	}
});

test("a paused-queue job removes like any other never-ran job", { skip: needsDeps }, async () => {
	// Jobs enqueued while the kill switch is on land in the paused list; they never ran either.
	const { out, seams } = world({ hash: {}, state: "paused" });
	assert.equal(await runCancel("j9", "redis://x", seams), 0);
	assert.match(out.join(""), /removed j9 \(paused\)/);
});

test("Valkey dying MID-active-cancel still deletes the placed request, promptly (review finding)", { skip: needsDeps }, async () => {
	// The ack poll throws after the request was SET: the catch must delete the request it placed (an
	// abandoned cancel must not fire after the operator read an error) without the bounded race's timer
	// holding the process open past the del.
	const { ops, err, seams } = world({ hash: {}, state: "active" });
	const probeGet = seams.redisFn();
	probeGet.get = async (key) => {
		ops.push(["get", key]);
		throw new Error("boom mid-poll");
	};
	const start = Date.now();
	const code = await runCancel("j8", "redis://x", seams);
	assert.equal(code, 1);
	assert.match(err.join(""), /could not reach Valkey/);
	assert.match(err.join(""), /boom mid-poll/);
	assert.ok(ops.some((op) => op[0] === "set" && op[1] === "cancel:req:j8"), "the request was really placed (this test would be vacuous otherwise)");
	assert.ok(ops.some((op) => op[0] === "del" && op[1] === "cancel:req:j8"), "the placed request is deleted on the error path");
	assert.ok(Date.now() - start < 500, "the cleanup race's timer must not hold the verb open");
});

test("a finished job refuses: there is nothing to cancel", { skip: needsDeps }, async () => {
	const { err, seams } = world({ hash: {}, state: "completed" });
	assert.equal(await runCancel("j6", "redis://x", seams), 1);
	assert.match(err.join(""), /job j6 is completed — nothing to cancel/);
});

test("every opened queue is closed, on success and on refusal", { skip: needsDeps }, async () => {
	const okWorld = world({ hash: {}, state: "delayed" });
	await runCancel("j7", "redis://x", okWorld.seams);
	assert.deepEqual(okWorld.closed, ["pi-jobs"]);
	const missing = world({ jobKnown: false, queueNames: ["pi-jobs", "pi-jobs@a"] });
	await runCancel("j7", "redis://x", missing.seams);
	assert.deepEqual(missing.closed, ["pi-jobs", "pi-jobs@a"]);
});
