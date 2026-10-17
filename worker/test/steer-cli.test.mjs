import assert from "node:assert/strict";
import { test } from "node:test";
import { Readable } from "node:stream";
import { readStdinBounded, runSteer } from "../src/steer-cli.mjs";

// runSteer lazily imports connection/queue/host-registry even when every seam is injected (cancel's shape), so these
// skip below the node floor exactly as cancel-cli's tests do.
let depsOk = false;
try {
	await import("../src/connection.mjs");
	depsOk = true;
} catch {}
const needsDeps = depsOk ? false : `queue deps not installed (node ${process.version} < 22.19.0); CI runs these`;

const T0 = 1_800_000_000_000;
const MSG = "ab".repeat(16);
const TEXT = "please use the staging bucket";

/**
 * A fake deployment behind runSteer's seams. The probe answers the inbox's calls by shape: `exists` is the open key,
 * `eval` with four keys is the push and with one key the withdraw, `hget` the poll (a sequence of states).
 */
function world({ state = "active", jobKnown = true, open = 1, push = "ok", polls = ["written"], prior = "queued", data = {}, id = "j1" } = {}) {
	const ops = [];
	const out = [];
	const err = [];
	const pushed = [];
	const pollQueue = [...polls];
	let redisMade = 0;
	const job = {
		id,
		data,
		async getState() {
			ops.push(["getState"]);
			return state;
		},
	};
	const probe = {
		on() {},
		async exists(key) {
			ops.push(["exists", key]);
			return open;
		},
		async eval(_script, numKeys, ...rest) {
			if (numKeys === 4) {
				ops.push(["push", rest[0]]);
				pushed.push(JSON.parse(rest[5]));
				return push;
			}
			ops.push(["withdraw", rest[0], rest[1]]);
			return prior;
		},
		async hget(key) {
			ops.push(["hget", key]);
			return pollQueue.length > 1 ? pollQueue.shift() : pollQueue[0];
		},
		disconnect() {
			ops.push(["disconnect"]);
		},
	};
	const closed = [];
	const seams = {
		write: (chunk) => out.push(chunk),
		errWrite: (chunk) => err.push(chunk),
		redisFn: () => (redisMade++, probe),
		parseConnectionFn: (url) => ({ url }),
		queueFn: (_conn, { name } = {}) => ({
			async getJob(jid) {
				ops.push(["getJob", name, jid]);
				return jobKnown && jid === id ? job : null;
			},
			async close() {
				closed.push(name);
			},
		}),
		readLiveHostsFn: async () => ({ hosts: {} }),
		discoverHostQueuesFn: async () => ["pi-jobs"],
		fleetQueueNamesFn: () => ["pi-jobs"],
		unionQueueNamesFn: (a, b) => [...new Set([...a, ...b])],
		randomBytes: () => Buffer.from(MSG, "hex"),
		now: () => T0,
		sleep: async () => {},
		pollMs: 250,
		ackTimeoutMs: 10_000,
	};
	return { ops, out, err, pushed, closed, seams, redisMade: () => redisMade, all: () => out.join("") + err.join("") };
}

test("an active, open job takes the message: pushed as the command line, polled to written, id and state printed", { skip: needsDeps }, async () => {
	const w = world({ polls: ["queued", "queued", "written"] });
	assert.equal(await runSteer({ positionals: ["j1", "please", "use", "the", "staging", "bucket"] }, "redis://x", w.seams), 0);
	assert.deepEqual(w.pushed, [{ v: 1, id: MSG, mode: "steer", source: "cli", author: { kind: "operator", by: "cli" }, text: TEXT, at: T0 }]);
	assert.equal(w.out.join(""), `message ${MSG} for j1 (steer): written. The run holds it, and the agent reads it after its current tool calls\n`);
	assert.ok(!w.all().includes("staging"), "the text is never printed back");
	assert.deepEqual(w.ops.filter((o) => o[0] === "exists"), [["exists", "run:steer:open:j1"]]);
	assert.equal(w.ops.filter((o) => o[0] === "hget").length, 3);
	assert.deepEqual(w.closed, ["pi-jobs"]);
	assert.ok(w.ops.some((o) => o[0] === "disconnect"));
});

test("--later sends a follow-up and says when the agent reads it", { skip: needsDeps }, async () => {
	const w = world({ polls: ["delivered"] });
	assert.equal(await runSteer({ positionals: ["j1", TEXT], later: true }, "redis://x", w.seams), 0);
	assert.equal(w.pushed[0].mode, "followUp");
	assert.match(w.out.join(""), /\(follow-up\): delivered\. The agent has received it/);
});

test("a recovery job steers its run: the run id is recoveryOf, not the job id", { skip: needsDeps }, async () => {
	const w = world({ id: "gh-1.r1", data: { recoveryOf: "gh-1" } });
	assert.equal(await runSteer({ positionals: ["gh-1.r1", TEXT] }, "redis://x", w.seams), 0);
	assert.deepEqual(w.ops.find((o) => o[0] === "exists"), ["exists", "run:steer:open:gh-1"]);
	assert.equal(w.ops.find((o) => o[0] === "push")[1], "run:steer:open:gh-1");
});

test("a message still queued at the end of the window was accepted: exit 0, said as queued", { skip: needsDeps }, async () => {
	const w = world({ polls: ["queued"] });
	assert.equal(await runSteer({ positionals: ["j1", TEXT] }, "redis://x", w.seams), 0);
	assert.match(w.out.join(""), /: queued\. The worker has not written it into the run yet/);
	assert.equal(w.ops.filter((o) => o[0] === "hget").length, 40, "ten seconds of 250 ms polls");
});

test("a message that turns late during the poll is exit 1: the agent did not see it", { skip: needsDeps }, async () => {
	const w = world({ polls: ["queued", "late"] });
	assert.equal(await runSteer({ positionals: ["j1", TEXT] }, "redis://x", w.seams), 1);
	assert.match(w.err.join(""), /the run ended before the worker could write it \(late\)/);
});

test("a job that is not active is refused before anything is pushed", { skip: needsDeps }, async () => {
	for (const state of ["waiting", "delayed", "completed"]) {
		const w = world({ state });
		assert.equal(await runSteer({ positionals: ["j1", TEXT] }, "redis://x", w.seams), 1, state);
		assert.equal(w.err.join(""), `error: job j1 is ${state}: only a running job takes messages. Nothing was sent\n`);
		assert.equal(w.pushed.length, 0);
	}
	const gone = world({ jobKnown: false });
	assert.equal(await runSteer({ positionals: ["j1", TEXT] }, "redis://x", gone.seams), 1);
	assert.match(gone.err.join(""), /no job j1 in 1 queue\(s\)/);
});

test("an active job whose run is not open is refused with the three causes", { skip: needsDeps }, async () => {
	const w = world({ open: 0 });
	assert.equal(await runSteer({ positionals: ["j1", TEXT] }, "redis://x", w.seams), 1);
	assert.equal(w.err.join(""), "error: the run is not accepting messages: it is not steer-armed, not running, or its venue cannot deliver\n");
	assert.equal(w.pushed.length, 0);
});

test("full, closed and gone are exit 1 with what happened, and never the text", { skip: needsDeps }, async () => {
	const cases = { full: /inbox is full \(at most 16 messages and 65536 bytes per run/, closed: /has finished and its inbox is closed/, gone: /stopped accepting messages before this one arrived/ };
	for (const [push, re] of Object.entries(cases)) {
		const w = world({ push });
		assert.equal(await runSteer({ positionals: ["j1", TEXT] }, "redis://x", w.seams), 1, push);
		assert.match(w.err.join(""), re);
		assert.ok(!w.all().includes("staging"));
		assert.equal(w.ops.filter((o) => o[0] === "hget").length, 0, "no poll after a refusal");
	}
});

test("- reads the message from stdin; an oversize stdin or text is refused before Valkey", { skip: needsDeps }, async () => {
	const w = world();
	assert.equal(await runSteer({ positionals: ["j1", "-"] }, "redis://x", { ...w.seams, readStdin: async () => ({ text: "from\r\nstdin" }) }), 0);
	assert.equal(w.pushed[0].text, "from\nstdin", "scrubbed like any message");

	const over = world();
	assert.equal(await runSteer({ positionals: ["j1", "-"] }, "redis://x", { ...over.seams, readStdin: async () => ({ over: true }) }), 1);
	assert.match(over.err.join(""), /stdin carried more than 32768 bytes/);
	assert.equal(over.redisMade(), 0, "refused before a client exists");

	const big = world();
	assert.equal(await runSteer({ positionals: ["j1", "z".repeat(9000)] }, "redis://x", big.seams), 1);
	assert.match(big.err.join(""), /the message is 9000 bytes, above the 8192-byte limit/);
	assert.ok(!big.all().includes("zzzz"), "a bound refusal never echoes the text");
	assert.equal(big.redisMade(), 0);

	const dash = world();
	assert.equal(await runSteer({ positionals: ["j1", "hello", "-"] }, "redis://x", dash.seams), 0, "a dash among words is text");
	assert.equal(dash.pushed[0].text, "hello -");
});

test("usage errors are exit 1 before Valkey", { skip: needsDeps }, async () => {
	for (const [args, re] of [
		[{ positionals: [] }, /a job id is required/],
		[{ positionals: ["j1"] }, /no message/],
		[{ positionals: ["j1", MSG], withdraw: true, later: true }, /--later and --withdraw do not go together/],
		[{ positionals: ["j1"], withdraw: true }, /--withdraw takes a job id and one message id/],
		[{ positionals: ["j1", "XYZ"], withdraw: true }, /the message id is 32 lowercase hex characters/],
	]) {
		const w = world();
		assert.equal(await runSteer(args, "redis://x", w.seams), 1, JSON.stringify(args));
		assert.match(w.err.join(""), re);
		assert.equal(w.redisMade(), 0);
	}
});

test("withdraw words the prior state: guaranteed while queued, best effort once written", { skip: needsDeps }, async () => {
	const ok = { queued: /it was queued, so the run never sees it \(guaranteed\)/, written: /best effort: it was already written into the run's inbox, so the agent may have read it/, withdrawn: /was already withdrawn; nothing was changed/ };
	for (const [prior, re] of Object.entries(ok)) {
		const w = world({ prior, state: "completed" });
		assert.equal(await runSteer({ positionals: ["j1", MSG], withdraw: true }, "redis://x", w.seams), 0, prior);
		assert.match(w.out.join(""), re);
		assert.deepEqual(w.ops.find((o) => o[0] === "withdraw"), ["withdraw", "run:inbox:state:j1", MSG]);
	}
	const bad = { delivered: /already delivered: the agent has received it/, late: /arrived after the run had ended \(late\)/, null: /no message abab.* in the inbox of j1/ };
	for (const [prior, re] of Object.entries(bad)) {
		const w = world({ prior: prior === "null" ? null : prior });
		assert.equal(await runSteer({ positionals: ["j1", MSG], withdraw: true }, "redis://x", w.seams), 1, prior);
		assert.match(w.err.join(""), re);
	}
});

test("a Valkey fault on the open check or the push is a named failure, exit 1", { skip: needsDeps }, async () => {
	const w = world();
	const seams = { ...w.seams, redisFn: () => ({ on() {}, exists: async () => { throw Object.assign(new Error("boom"), { code: "ECONNRESET" }); }, disconnect() {} }) };
	assert.equal(await runSteer({ positionals: ["j1", TEXT] }, "redis://127.0.0.1:1", seams), 1);
	assert.match(w.err.join(""), /could not reach Valkey at /);
});

test("readStdinBounded reads to the end, and stops the moment it passes the bound", async () => {
	assert.deepEqual(await readStdinBounded(10, Readable.from([Buffer.from("héllo")])), { text: "héllo" });
	assert.deepEqual(await readStdinBounded(4, Readable.from([Buffer.from("abc"), Buffer.from("de")])), { over: true });
	assert.deepEqual(await readStdinBounded(10, Readable.from(["ab", "c"])), { text: "abc" });
});

test("a poll fault after the push still exits 0: the message was accepted, and is said as queued", { skip: needsDeps }, async () => {
	const w = world();
	const seams = { ...w.seams, redisFn: () => ({ on() {}, exists: async () => 1, eval: async () => "ok", hget: async () => { throw new Error("poll fault"); }, disconnect() {} }) };
	assert.equal(await runSteer({ positionals: ["j1", TEXT] }, "redis://x", seams), 0);
	assert.match(w.out.join(""), new RegExp(`^message ${MSG} for j1 \\(steer\\): queued\\.`));
});

test("a message withdrawn before the relay wrote it exits 0 and says so", { skip: needsDeps }, async () => {
	const w = world({ polls: ["withdrawn"] });
	assert.equal(await runSteer({ positionals: ["j1", TEXT] }, "redis://x", w.seams), 0);
	assert.equal(w.out.join(""), `message ${MSG} for j1: withdrawn before it was written\n`);
});
