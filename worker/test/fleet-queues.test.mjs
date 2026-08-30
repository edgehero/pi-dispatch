import assert from "node:assert/strict";
import { test } from "node:test";
import { authoredCron } from "../src/schedules.mjs";
import { cronFingerprint } from "../src/fingerprint.mjs";
import { QUEUE, discoverHostQueues, fleetQueueNames, hostQueueName, unionQueueNames } from "../src/queue.mjs";

// --- fleetQueueNames ------------------------------------------------------------------------------------
//
// This is the load-bearing claim of the whole slice: it decides which queues the kill switch, the status
// read and the scheduler view span. It was asserted only in a doc comment, and the comment was wrong.

test("a deployment that declared no name yields exactly the shared queue", () => {
	// EVERY worker publishes a registry row, named or not -- that is what lets an unnamed fleet be seen at
	// all. Only a DECLARED name means the worker actually drains a queue of its own. Deriving queue names
	// from the mere presence of a row invented `pi-jobs@<hostname>` for a queue nothing reads: pausing it
	// created a real Valkey key for a phantom, and its counts could never be anything but zero.
	assert.deepEqual(fleetQueueNames([{ name: "my-mac", routes: "false" }]), [QUEUE]);
	assert.deepEqual(fleetQueueNames([]), [QUEUE]);
	assert.deepEqual(fleetQueueNames(undefined), [QUEUE], "an unreadable registry is not a fleet");
});

test("a declared host contributes its queue, and the shared one is always first", () => {
	assert.deepEqual(fleetQueueNames([{ name: "mini2", routes: "true" }, { name: "mini1", routes: "true" }]), [
		QUEUE,
		hostQueueName("mini1"),
		hostQueueName("mini2"),
	]);
});

test("a peer-written name is VALIDATED, because one bad row must not take out the kill switch", () => {
	// These rows cross a trust boundary: another host wrote them. A name containing `:` makes BullMQ's
	// `new Queue` throw, and the throw happens while the kill switch is enumerating -- so an unvalidated
	// name means `pi-dispatch pause` dies having paused NOTHING. A name containing `@` would not decompose,
	// which is the property `hostQueueName` picked `@` for.
	const rows = [
		{ name: "mini1", routes: "true" },
		{ name: "a:b", routes: "true" },
		{ name: "evil@x", routes: "true" },
		{ name: "..", routes: "true" },
		{ name: "", routes: "true" },
		{ name: null, routes: "true" },
		{ routes: "true" },
	];
	assert.deepEqual(fleetQueueNames(rows), [QUEUE, hostQueueName("mini1")]);
});

test("duplicate rows are deduped, or one host's jobs are counted twice", () => {
	const rows = [{ name: "mini1", routes: "true" }, { name: "mini1", routes: "true" }];
	assert.deepEqual(fleetQueueNames(rows), [QUEUE, hostQueueName("mini1")]);
});

// --- authoredCron and the divergence gate's input --------------------------------------------------------

const triggersFile = "/triggers.json";
const seams = (body) => ({ readFileSync: () => body, existsSync: () => true });
const fileWith = (run) =>
	JSON.stringify({ triggers: [{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run }] });
const base = { kind: "local", folder: "/srv/site", flow: "review", task: "check" };

test("two hosts with the SAME file fingerprint alike, whatever either can serve", () => {
	// The bug this pins: the gate used to hash `loadSchedules`'s output, which has already replaced every
	// trigger whose folder is not on THIS host with a stub. Two hosts running one identical file therefore
	// produced two different hashes and refused each other forever -- the one outcome placement exists to
	// make impossible. `authoredCron` reads the file BEFORE any placement decision, so the hash describes
	// the operator's intent rather than this machine's disk.
	const a = authoredCron({ triggersFile }, seams(fileWith(base)));
	const b = authoredCron({ triggersFile }, seams(fileWith(base)));
	assert.equal(cronFingerprint(a, { tz: "UTC" }), cronFingerprint(b, { tz: "UTC" }));
});

test("the fingerprint moves when ANY part of `run` moves", () => {
	// It used to project the keys of a NORMALIZED schedule (`name`, `data`, `opts`), every one of which is
	// `undefined` on an authored entry -- so the hash saw the id and the pattern and nothing else, and an
	// operator changing the folder, the flow or the image on one host only passed the gate silently. That
	// is a divergence gate that cannot see the divergence it exists for.
	const fp = (run) => cronFingerprint(authoredCron({ triggersFile }, seams(fileWith(run))), { tz: "UTC" });
	const mine = fp(base);
	for (const [field, value] of [
		["folder", "/srv/other"],
		["flow", "audit"],
		["task", "something else"],
		["image", "pi-job:custom"],
		["maxTurns", 40],
	]) {
		assert.notEqual(fp({ ...base, [field]: value }), mine, `${field} must move the hash`);
	}
});

test("the timezone rides in the hash, since one pattern is two instants in two zones", () => {
	const a = authoredCron({ triggersFile }, seams(fileWith(base)));
	assert.notEqual(cronFingerprint(a, { tz: "UTC" }), cronFingerprint(a, { tz: "Europe/Amsterdam" }));
});

test("an absent or unparseable file ABSTAINS rather than opining", () => {
	// Abstaining and opining are different facts and must not hash alike: a worker with cron switched off
	// is not a party to the disagreement, while a file holding zero cron entries genuinely asserts "there
	// should be no schedulers" and must be able to disagree with a host that has some.
	assert.equal(authoredCron({ triggersFile }, { readFileSync: () => "", existsSync: () => false }), null);
	assert.equal(authoredCron({ triggersFile }, seams("{not json")), null);
	assert.equal(cronFingerprint(null, { tz: "UTC" }), null, "null abstains");

	const empty = authoredCron({ triggersFile }, seams(JSON.stringify({ triggers: [] })));
	assert.deepEqual(empty, []);
	assert.ok(cronFingerprint(empty, { tz: "UTC" }), "an empty set is an OPINION, and hashes to one");
});

test("webhook triggers are not cron and must not enter the hash", () => {
	// Two hosts differing only in a webhook trigger would otherwise freeze cron over something that cannot
	// affect a schedule.
	const withHook = JSON.stringify({
		triggers: [
			{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: base },
			{ on: { type: "issue", id: "hook", repo: "acme/web", action: ["closed"] }, run: { kind: "github", repo: "acme/web", flow: "review" } },
		],
	});
	const only = authoredCron({ triggersFile }, seams(fileWith(base)));
	assert.equal(cronFingerprint(authoredCron({ triggersFile }, seams(withHook)), { tz: "UTC" }), cronFingerprint(only, { tz: "UTC" }));
});

// --- what EXISTS, not just what is live ------------------------------------------------------------------

const scanning = (keys) => ({
	async scan(cursor) {
		return cursor === "0" ? ["0", keys] : ["0", []];
	},
});

test("host queues are discoverable from the keyspace, which outlives the host", () => 	{
	// The registry is a lease: it expires ninety seconds after a host stops writing. Its worker's queue is
	// not, and neither is the queue's paused flag. This is the read that closes the window.
	return discoverHostQueues(scanning(["bull:pi-jobs@mini2:meta", "bull:pi-jobs@mini1:meta"])).then((names) => {
		assert.deepEqual(names, [hostQueueName("mini1"), hostQueueName("mini2")]);
	});
});

test("a hand-created key with an illegal name is refused here too", async () => {
	// `new Queue` throws on a `:`, and the throw would happen mid-enumeration -- so an unvalidated name
	// read out of the keyspace takes the kill switch out just as surely as one read out of the registry.
	assert.deepEqual(await discoverHostQueues(scanning(["bull:pi-jobs@a:b:meta", "bull:pi-jobs@ok:meta"])), [hostQueueName("ok")]);
});

test("an unreadable or HANGING keyspace fails open rather than wedging the kill switch", async () => {
	// BullMQ connections carry `maxRetriesPerRequest: null`, so a command against an unreachable server
	// queues forever rather than rejecting. An unbounded await here would hang `pi-dispatch pause` instead
	// of degrading it -- the worst possible behaviour for the one command that has to work.
	assert.deepEqual(await discoverHostQueues({ async scan() { throw new Error("down"); } }), []);
	const started = Date.now();
	assert.deepEqual(await discoverHostQueues({ scan: () => new Promise(() => {}) }, { timeoutMs: 200 }), []);
	assert.ok(Date.now() - started < 2_000, "bounded, not hung");
});

test("the bound leaves no timer behind once the scan has answered", async () => {
	// The timer must not be `unref`'d -- it has to fire when a hang is the last thing on the loop, which is
	// the only case it exists for -- so it has to be CLEARED instead. Left pending, it held the event loop
	// open for the rest of the budget after the work was done, and `pi-dispatch pause` sat for two seconds
	// having already paused everything.
	const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
	await discoverHostQueues({ async scan(c) { return c === "0" ? ["0", ["bull:pi-jobs@a:meta"]] : ["0", []]; } }, { timeoutMs: 30_000 });
	assert.equal(process.getActiveResourcesInfo().filter((r) => r === "Timeout").length, before, "no timer outlives the call");
});

test("the union covers a queue whose host is GONE, which is the direction with no recovery", () => {
	// Pause with mini1 live durably pauses `pi-jobs@mini1`. Resume while mini1 is down, off the registry
	// alone, enumerates nothing for it: the queue stays paused permanently and no surface names it.
	const live = fleetQueueNames([{ name: "mini2", routes: "true" }]);
	const exists = [hostQueueName("mini1"), hostQueueName("mini2")];
	assert.deepEqual(unionQueueNames(live, exists), [QUEUE, hostQueueName("mini1"), hostQueueName("mini2")]);
	assert.deepEqual(unionQueueNames([QUEUE], []), [QUEUE], "and a single-host deployment is still exactly one queue");
});
