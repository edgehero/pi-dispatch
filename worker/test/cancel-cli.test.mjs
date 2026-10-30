import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { boundedText, runCancel } from "../src/cancel-cli.mjs";
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
function world({ hash = {}, state = "delayed", jobKnown = true, removeThrows = 0, removeError = "could not be removed because it is locked by another worker", ack, registryDown = false, queueNames = ["pi-jobs"], attemptsMade = 0, attemptsStarted = 0 } = {}) {
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
			if (removeAttempts <= removeThrows) throw new Error(removeError);
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
		readLiveHostsFn: async () => (registryDown ? { unreachable: registryDown === true ? "registry boom" : registryDown } : { hosts: {} }),
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

test("successful queued and held cancellations say when touch publication failed, without retrying removal", { skip: needsDeps }, async () => {
	for (const hash of [{}, { since: "1" }]) {
		const { ops, out, err, seams } = world({ hash });
		const touchStore = { begin: async (event) => ({ ok: true, event }), write: async () => ({ error: "touch-index-unavailable" }), abort: async () => ({ ok: true }) };
		assert.equal(await runCancel("j1", "redis://x", { ...seams, touchStore, now: () => 1000 }), 0);
		assert.match(out.join(""), /(?:cancelled|removed) j1/);
		assert.match(err.join(""), /warning: the job was removed; touch tracking is incomplete\. Do not repeat/);
		assert.equal(ops.filter(([name]) => name === "remove").length, 1);
	}
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

test("a held job whose remove fails after its hold was cleared says the hold is gone and how to finish, exit 1", { skip: needsDeps }, async () => {
	// A worker locked the job between the state read and the remove: the hold's keys are already deleted, so the line
	// must not read as a refusal that changed nothing.
	const { ops, err, seams } = world({ hash: { since: "123" }, state: "delayed", removeThrows: 1 });
	assert.equal(await runCancel("j1", "redis://x", seams), 1);
	assert.equal(err.join(""), "error: could not cancel held job j1: its hold was cleared, but the job itself could not be removed (could not be removed because it is locked by another worker); it may still be queued, now without its hold. Run `pi-dispatch cancel j1` again to remove or stop it\n");
	assert.ok(ops.some((op) => op[0] === "del" && op[1] === "wait:job:j1"), "the hold really was cleared (this test would be vacuous otherwise)");
	// A held job refused before anything was deleted keeps the plain words.
	const done = world({ hash: { since: "123" }, state: "completed" });
	assert.equal(await runCancel("j1", "redis://x", done.seams), 1);
	assert.equal(done.err.join(""), "error: could not cancel held job j1: job j1 is completed, not waiting -- it has already left the hold\n");
});

test("the cleared line carries the remove's error with each terminal control a space and at most 200 characters of it", { skip: needsDeps }, async () => {
	// The error is another module's words: a clipboard write (OSC 52, ended by a bell), a CSI with no ESC, and 10,000 more.
	const hostile = `\u001b]52;c;cHduZWQ=\u0007locked \u009b2J\r\n${"x".repeat(10_000)}`;
	const { err, seams } = world({ hash: { since: "123" }, state: "delayed", removeThrows: 1, removeError: hostile });
	assert.equal(await runCancel("j1", "redis://x", seams), 1);
	const shown = ` ]52;c;cHduZWQ= locked  2J  ${"x".repeat(172)}`;
	assert.equal(shown.length, 200);
	assert.equal(err.join(""), `error: could not cancel held job j1: its hold was cleared, but the job itself could not be removed (${shown}); it may still be queued, now without its hold. Run \`pi-dispatch cancel j1\` again to remove or stop it\n`);
	assert.doesNotMatch(err.join("").slice(0, -1), /[\u0000-\u001f\u007f-\u009f]/, "one line, and nothing in it a terminal acts on");
});

test("every other module's words a line carries reach stderr bounded: a registry's, a remove's, a lookup's", { skip: needsDeps }, async () => {
	// What a job's data, a Valkey reply or a client can hold: a terminal's clipboard write, a screen clear, a long tail.
	const planted = `\u001b]52;c;aGk=\u0007\u001b[2J${"x".repeat(300)}`;
	const clean = (text) => !/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/.test(text);
	const blind = world({ jobKnown: false, registryDown: planted });
	assert.equal(await runCancel("j1", "redis://x", blind.seams), 1);
	assert.ok(clean(blind.err.join("")) && blind.err.join("").includes(`registry unreadable: ${boundedText(planted)} — a host`), "the registry's words");
	const raced = world({ hash: {}, state: ["delayed", "delayed"], removeThrows: 1, removeError: planted });
	assert.equal(await runCancel("j3", "redis://x", raced.seams), 1);
	assert.equal(raced.err.join(""), `error: could not remove j3 — it is now delayed; the remove failed with: ${boundedText(planted)}\n`);
	const lookup = world();
	const queueFn = lookup.seams.queueFn;
	lookup.seams.queueFn = (conn, opts) => ({ ...queueFn(conn, opts), getJob: async () => { throw new Error(planted); } });
	assert.equal(await runCancel("j4", "redis://x", lookup.seams), 1);
	assert.ok(clean(lookup.err.join("")), "the lookup's own error, under the could-not-reach line");
	assert.ok(lookup.err.join("").endsWith(`\n  ${boundedText(planted)}\n`));
	// A held job whose first delete failed with its hold read back in place: the refusal's own words, bounded.
	const held = world({ hash: { since: "1" } });
	const heldProbe = held.seams.redisFn();
	heldProbe.del = async () => {
		throw new Error(planted);
	};
	heldProbe.hexists = async () => 1;
	held.seams.redisFn = () => heldProbe;
	assert.equal(await runCancel("j1", "redis://x", held.seams), 1);
	assert.equal(held.err.join(""), `error: could not cancel held job j1: ${boundedText(planted)}\n`);
});

test("boundedText substitutes and cuts as the console's boundedText does, on every character a terminal acts on", async () => {
	assert.equal(boundedText("plain words"), "plain words");
	assert.equal(boundedText(undefined), "no reason given");
	assert.equal(boundedText("a\u001b[31mb\u009bc\u007fd\te\nf"), "a [31mb c d e f");
	assert.equal(boundedText("y".repeat(201)), "y".repeat(200));
	// The worker cannot import the admin, so the CLI keeps its own copy; this holds it to the console's own function,
	// input by input, where the admin is beside it.
	const actionsPath = new URL("../../admin/src/job-actions.mjs", import.meta.url);
	if (!existsSync(actionsPath)) return;
	const { boundedText: theirs } = await import(actionsPath.href);
	// C0, printable ASCII, DEL and C1: the class a terminal executes, where the two must agree character for character.
	// Past U+009F the console substitutes more (a bidi control, a zero-width or a no-break space, for a reader of a page)
	// and the CLI does not: no relation is claimed there.
	for (let cp = 0; cp <= 0x9f; cp++) {
		const s = `a${String.fromCodePoint(cp)}b`;
		assert.equal(boundedText(s), theirs(s), `U+${cp.toString(16).padStart(4, "0")}`);
	}
	for (const s of [null, undefined, "", "x".repeat(10_000), `\u001b[2J${"y".repeat(500)}`, "\u00e9".repeat(300), `a${"\u{1f600}".repeat(150)}`, 42]) {
		assert.equal(boundedText(s), theirs(s), JSON.stringify(s)?.slice(0, 40));
	}
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

test("a remove that throws while the job still waits says the state read after and the throw, labelled apart, exit 1", { skip: needsDeps }, async () => {
	const { err, seams } = world({ hash: {}, state: ["delayed", "delayed"], removeThrows: 1 });
	assert.equal(await runCancel("j3", "redis://x", seams), 1);
	assert.equal(err.join(""), "error: could not remove j3 — it is now delayed; the remove failed with: could not be removed because it is locked by another worker\n");
});

test("an active job's ack names the host, and an empty-string ack still reads as a worker", { skip: needsDeps }, async () => {
	const named = world({ hash: {}, state: "active", ack: "hostA" });
	assert.equal(await runCancel("j4", "redis://x", named.seams), 0);
	assert.match(named.out.join(""), /cancel accepted by hostA/);
	assert.match(named.out.join(""), /operator-cancel/);
	// The ack is a value read from Valkey, so it reaches the terminal bounded like any other module's words.
	const planted = world({ hash: {}, state: "active", ack: "\u001b]52;c;aGk=\u0007\u001b[2J" });
	assert.equal(await runCancel("j4", "redis://x", planted.seams), 0);
	assert.ok(planted.out.join("").startsWith("cancel accepted by  ]52;c;aGk=  [2J — stopping"), JSON.stringify(planted.out.join("")));
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
