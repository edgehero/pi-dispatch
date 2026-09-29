import assert from "node:assert/strict";
import { test } from "node:test";
import { runCancel } from "../src/cancel-cli.mjs";
import { ranBefore } from "../src/cancel-state.mjs";

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
function world({ hash = {}, state = "delayed", jobKnown = true, removeThrows = 0, ack, registryDown = false, queueNames = ["pi-jobs"], attemptsMade = 0, attemptsStarted = 0 } = {}) {
	const ops = [];
	const out = [];
	const err = [];
	let removeAttempts = 0;
	const states = Array.isArray(state) ? [...state] : [state];
	const job = {
		attemptsMade,
		attemptsStarted,
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
	assert.equal(out.join(""), "removed j2 (delayed): it never ran; no record written\n");
	assert.ok(ops.some((op) => op[0] === "remove"));
	assert.ok(!ops.some((op) => op[0] === "del" && String(op[1]).startsWith("wait:")), "an unheld job has no hold keys to touch");
});

test("a delayed job waiting to retry after a failed attempt is said to have run, with its record kept (#477)", { skip: needsDeps }, async () => {
	// Round-446 final verification (pd-fedora, raw/76-77): a job retrying after an infra failure had a run record and a
	// retained sandbox, and cancel printed "it never ran; no record written".
	const once = world({ hash: {}, state: "delayed", attemptsMade: 1, attemptsStarted: 1 });
	assert.equal(await runCancel("j6", "redis://x", once.seams), 0);
	assert.equal(once.out.join(""), "removed j6 (delayed): it made 1 attempt before and was waiting to retry; whatever that attempt recorded stays, and cancel writes none\n");
	assert.ok(once.ops.some((op) => op[0] === "remove"));
	const twice = world({ hash: {}, state: "waiting", attemptsMade: 2, attemptsStarted: 2 });
	assert.equal(await runCancel("j7", "redis://x", twice.seams), 0);
	assert.equal(twice.out.join(""), "removed j7 (waiting): it made 2 attempts before and was waiting to retry; whatever those attempts recorded stays, and cancel writes none\n");
	// No attempt made: it never ran, even where BullMQ counted a start (a hold, a pause-gate move or a deferral hands
	// the job back with skipAttempt, which counts a start and no attempt).
	const never = world({ hash: {}, state: "delayed", attemptsMade: 0, attemptsStarted: 3 });
	assert.equal(await runCancel("j8", "redis://x", never.seams), 0);
	assert.equal(never.out.join(""), "removed j8 (delayed): it never ran; no record written\n");
	// A held job is worded from the same counter.
	const heldNever = world({ hash: { since: "123" }, state: "delayed", attemptsStarted: 4 });
	assert.equal(await runCancel("j9", "redis://x", heldNever.seams), 0);
	assert.equal(heldNever.out.join(""), "cancelled j9: it was held on its wait condition, and it never ran; no record written\n");
	const heldRan = world({ hash: { since: "123" }, state: "delayed", attemptsMade: 1 });
	assert.equal(await runCancel("j10", "redis://x", heldRan.seams), 0);
	assert.equal(heldRan.out.join(""), "cancelled j10: it was held on its wait condition, and it made 1 attempt before and was waiting to retry; whatever that attempt recorded stays, and cancel writes none\n");
	// Anything that is not a positive whole count reads as none.
	for (const made of [undefined, null, 0, -1, 1.5, "2", Number.NaN]) assert.equal(ranBefore({ attemptsMade: made }), "it never ran; no record written", String(made));
	assert.equal(ranBefore(undefined), "it never ran; no record written");
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
	// Not loopback, so not a Valkey `pi-dispatch up` starts (PR #488's review): asked about by its host.
	assert.match(err.join(""), /: is the Valkey at x running\?\n/);
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

test("against a real Valkey, a job retrying after a failed attempt is removed and said to have run (#477, VALKEY_TEST_URL)", { skip: needsDeps || (process.env.VALKEY_TEST_URL ? false : "needs VALKEY_TEST_URL") }, async () => {
	// BullMQ's own counter on the job cancel reads: one failed attempt with a long backoff leaves the job delayed with
	// attemptsMade 1, the state the round-446 verification cancelled.
	const url = process.env.VALKEY_TEST_URL;
	const { Queue, Worker } = await import("bullmq");
	const { parseConnection } = await import("../src/connection.mjs");
	const connection = parseConnection(url);
	const name = `pi-jobs-test-477-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const queue = new Queue(name, { connection });
	const worker = new Worker(name, async () => { throw new Error("infra failure, container exit 1"); }, { connection });
	worker.on("error", () => {});
	try {
		const job = await queue.add("t", { n: 1 }, { attempts: 2, backoff: { type: "fixed", delay: 600_000 } });
		const deadline = Date.now() + 10_000;
		while ((await queue.getJobState(job.id)) !== "delayed" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
		assert.equal(await queue.getJobState(job.id), "delayed", "the failed attempt put the job in the delayed set to retry");
		await worker.close();
		const out = [];
		const seams = { write: (c) => out.push(c), errWrite: (c) => out.push(c), refusalFn: async () => null, readLiveHostsFn: async () => ({ hosts: {} }), discoverHostQueuesFn: async () => [], fleetQueueNamesFn: () => [], unionQueueNamesFn: () => [name] };
		assert.equal(await runCancel(job.id, url, seams), 0, out.join(""));
		assert.equal(out.join(""), `removed ${job.id} (delayed): it made 1 attempt before and was waiting to retry; whatever that attempt recorded stays, and cancel writes none\n`);
		assert.equal(await queue.getJob(job.id), undefined, "and it is gone");
		// A job that never ran, beside it, still says so.
		const fresh = await queue.add("t", { n: 2 }, { delay: 600_000 });
		out.length = 0;
		assert.equal(await runCancel(fresh.id, url, seams), 0, out.join(""));
		assert.equal(out.join(""), `removed ${fresh.id} (delayed): it never ran; no record written\n`);
	} finally {
		await worker.close().catch(() => {});
		await queue.obliterate({ force: true }).catch(() => {});
		await queue.close().catch(() => {});
	}
});

test("no operator-facing text says a removed or held job never ran, or has spent nothing, as a fact about every job (#477, PR #478's gate)", async () => {
	// A held job can be a retry held again, which made an attempt (and may have spent on it): the five places the gate
	// found said otherwise. Each now words it from the job's real state, or says what is true of every held job.
	const { readFileSync } = await import("node:fs");
	const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");
	const { main } = await import("../src/cli.mjs");
	let usage = "";
	await main(["--help"], {}, { write: (c) => (usage += c) });
	const cancelHelp = usage.slice(usage.indexOf("pi-dispatch cancel <jobId>"), usage.indexOf("Config comes from"));
	assert.doesNotMatch(cancelHelp, /never ran/);
	assert.match(cancelHelp, /the line says whether it had\s+made attempts; cancel records nothing/);
	assert.doesNotMatch(read("admin/skills/operate-pi-dispatch/SKILL.md"), /\(the\s+job never ran\)|held job has spent nothing/);
	assert.doesNotMatch(read("docs/wait-for.md"), /because a\s+held job never ran/);
	assert.doesNotMatch(read("admin/src/index.ts"), /A held job has spent nothing|because the job never ran/);
	assert.doesNotMatch(read("admin/src/read-model.mjs"), /a held job has spent nothing/);
	// The removeHeldJob docblock is its own again, and says what the result carries.
	const state = read("worker/src/cancel-state.mjs");
	const doc = state.slice(state.lastIndexOf("/**", state.indexOf("export async function removeHeldJob")), state.indexOf("export async function removeHeldJob"));
	assert.match(doc, /^\/\*\*\n \* Remove a job that is held on a `run\.waitFor` condition/);
	assert.match(doc, /`\{ ok: true, jobId, attemptsMade \}`/);
	assert.doesNotMatch(doc, /never ran/);
});
