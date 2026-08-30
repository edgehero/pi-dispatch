import assert from "node:assert/strict";
import { test } from "node:test";
import { renderHeldJobs } from "../src/render.mjs";

/**
 * Issue #230, the panel's held-jobs surface. The property that matters most here is what does NOT reach the
 * snapshot: a delayed forge job's `.data` holds the issue title, body and username, which is why this
 * reader takes the worker's own `wait:job:*` hashes instead of enumerating the delayed set. Every assertion
 * about a field is therefore also an assertion about the fields that are absent.
 */

/** A fake redis with just the surface the held reader uses: SMEMBERS, HGETALL, SREM. */
function fakeRedis(hashes, { members } = {}) {
	const set = new Set(members ?? Object.keys(hashes).map((k) => k.slice("wait:job:".length)));
	return {
		smembersCalls: 0,
		hgetallCalls: [],
		srems: [],
		async smembers() {
			this.smembersCalls += 1;
			return [...set];
		},
		async hgetall(key) {
			this.hgetallCalls.push(key);
			const h = hashes[key];
			if (h === "WRONGTYPE") throw new Error("WRONGTYPE Operation against a key holding the wrong kind of value");
			return h ?? {};
		},
		async srem(key, id) {
			this.srems.push(id);
			set.delete(id);
			return 1;
		},
		async get() {
			return null;
		},
		async del() {
			return 1;
		},
		disconnect() {},
	};
}

const NOW = Date.UTC(2026, 7, 30, 12, 0);

test("readHeldJobs projects only host-chosen fields -- no title, no body, no job data", async () => {
	const { readHeldJobs } = await import("../src/read-model.mjs");
	const redis = fakeRedis({
		"wait:job:gh-1": { since: String(NOW - 7_200_000), target: "acme/web#7", label: "jira", dedupId: "acme/web#7:deploy#0", checks: "4" },
		"wait:job:gh-2": { since: String(NOW - 60_000), target: "acme/web#9", label: "after 2026-09-01T09:00:00Z", dedupId: "x#0" },
	});
	const held = await readHeldJobs({ url: "redis://127.0.0.1:6399", redisFn: () => redis, now: () => NOW });

	assert.equal(held.rows.length, 2);
	// Key-for-key: the projection is a closed set, so a future field cannot arrive by accident.
	assert.deepEqual(Object.keys(held.rows[0]).sort(), ["checks", "jobId", "label", "target", "waitedMs"]);
	assert.equal(held.rows[0].jobId, "gh-1", "longest wait first: the row an operator is looking for");
	assert.equal(held.rows[0].target, "acme/web#7", "an id-only target, the same shape a run record carries");
	assert.equal(held.rows[0].waitedMs, 7_200_000);
	assert.equal(held.rows[1].jobId, "gh-2");
	const serialized = JSON.stringify(held);
	for (const f of ["title", "body", "username", "sender"]) assert.equal(serialized.includes(f), false, `never ${f}`);
});

test("readHeldJobs sorts BEFORE it cuts, so the most-stuck job is always in the listing", async () => {
	const { readHeldJobs } = await import("../src/read-model.mjs");
	const hashes = {};
	// Deliberately inserted so the longest wait is NOT first in index order: slicing before sorting would
	// show an arbitrary sample and call it the top, and the stuck job an operator is hunting would be absent.
	for (let i = 0; i < 30; i += 1) hashes[`wait:job:gh-${i}`] = { since: String(NOW - i * 60_000), target: `o/r#${i}`, label: "jira" };
	const redis = fakeRedis(hashes);
	const held = await readHeldJobs({ url: "redis://127.0.0.1:6399", redisFn: () => redis, limit: 5, now: () => NOW });

	assert.equal(held.rows.length, 5);
	assert.equal(held.rows[0].jobId, "gh-29", "the longest wait, not whichever member came back first");
	assert.equal(held.more, 25, "and `more` is the real remainder, not a truncation artifact");
	assert.equal(held.truncated, false);
	assert.equal(redis.smembersCalls, 1, "one index read, never a keyspace walk");
});

test("readHeldJobs prunes stale index members as it reads them", async () => {
	const { readHeldJobs } = await import("../src/read-model.mjs");
	// A member whose hash has expired or been released is stale by definition. The reader removing it is
	// what makes an index safe at all: a SET cannot expire its own members, so the alternative only grows.
	const redis = fakeRedis(
		{ "wait:job:live": { since: String(NOW - 1000), target: "o/r#1", label: "jira" } },
		{ members: ["live", "ghost", "counters-only"] },
	);
	const held = await readHeldJobs({ url: "redis://x", redisFn: () => redis, now: () => NOW });
	assert.deepEqual(held.rows.map((r) => r.jobId), ["live"]);
	assert.deepEqual(redis.srems.sort(), ["counters-only", "ghost"], "both pruned: neither carries a hold clock");
});

test("a counters-only hash is not a hold -- it has no clock, so it is neither listed nor cancellable", async () => {
	const { readHeldJobs } = await import("../src/read-model.mjs");
	// `noteCheck`/`noteThrottle` deliberately CREATE the hash before any hold is stamped, so a non-empty
	// hash is not the same question as "is this job waiting".
	const redis = fakeRedis({ "wait:job:gh-1": { checks: "3", faults: "1", throttles: "0" } });
	const held = await readHeldJobs({ url: "redis://x", redisFn: () => redis, now: () => NOW });
	assert.deepEqual(held.rows, []);
});

test("one unreadable member degrades one row, never the listing", async () => {
	const { readHeldJobs } = await import("../src/read-model.mjs");
	// A stray key of the wrong type under this prefix makes HGETALL throw WRONGTYPE. That must cost one row.
	const redis = fakeRedis({
		"wait:job:good": { since: String(NOW - 1000), target: "o/r#1", label: "jira" },
		"wait:job:bad": "WRONGTYPE",
	});
	const held = await readHeldJobs({ url: "redis://x", redisFn: () => redis, now: () => NOW });
	assert.deepEqual(held.rows.map((r) => r.jobId), ["good"]);
	assert.equal(held.unreachable, undefined, "the section still renders");
});

test("readHeldJobs answers `unreachable` rather than throwing into a panel refresh", async () => {
	const { readHeldJobs } = await import("../src/read-model.mjs");
	const dead = { smembers: async () => { throw new Error("ECONNREFUSED"); }, disconnect() {} };
	const held = await readHeldJobs({ url: "redis://127.0.0.1:6399", redisFn: () => dead });
	assert.ok(held.unreachable, "one degraded section, never a dead panel");
	assert.equal(held.rows, undefined);

	const junk = await readHeldJobs({ url: "not-a-url" });
	assert.ok(junk.unreachable, "and a junk URL fails synchronously rather than burning the timeout");
});

test("a hold with no clock reads as unknown, never as a fabricated zero", async () => {
	const { readHeldJobs } = await import("../src/read-model.mjs");
	const redis = fakeRedis({
		"wait:job:gh-blank": { target: "o/r#1", label: "jira" },
		"wait:job:gh-zero": { since: "0", target: "o/r#2", label: "jira" },
		"wait:job:gh-junk": { since: "soon", target: "o/r#3", label: "jira" },
	});
	const held = await readHeldJobs({ url: "redis://x", redisFn: () => redis, now: () => NOW });
	for (const row of held.rows) assert.equal(row.waitedMs, null, `${row.jobId} has no honest duration to show`);
});

// --- the plain (no-color / non-TTY) twin ---------------------------------------------------------------

test("the plain renderer tells the same facts as the framed one, and nothing when nothing is held", () => {
	assert.equal(renderHeldJobs({ held: null }), null);
	assert.equal(renderHeldJobs({ held: { rows: [] } }), null, "no section at all, so a deployment that never waits is unchanged");
	assert.equal(renderHeldJobs({ held: { unreachable: "timed out" } }), "unreadable (timed out)");

	const text = renderHeldJobs({ held: { rows: [{ jobId: "gh-1", target: "acme/web#7", label: "jira", waitedMs: 7_200_000 }], more: 4 } });
	assert.ok(text.includes("acme/web#7"));
	assert.ok(text.includes("jira"));
	assert.ok(text.includes("waited 2h0m"), "a duration a human reads, not a millisecond count");
	assert.ok(text.includes("4 more"), "and the truncation, so the plain path is not quietly shorter");
});

test("a missing hold clock renders `?` in the plain path too", () => {
	const text = renderHeldJobs({ held: { rows: [{ jobId: "gh-1", target: "o/r#1", label: "jira", waitedMs: null }] } });
	assert.ok(text.includes("waited ?"), "the framed twin's rule: never invent a number the worker did not record");
});

test("cancelHeldJob refuses anything that is not actually HELD", async () => {
	const { cancelHeldJob } = await import("../src/read-model.mjs");
	// A tool whose blast radius were "anything in the delayed set" would reach cron next-occurrences and
	// retry backoff, which is not what its description promises.
	const notHeld = await cancelHeldJob({
		url: "redis://x",
		jobId: "repeat:nightly:123",
		redisFn: () => ({ hgetall: async () => ({}), disconnect() {} }),
		queueFn: () => ({ getJob: async () => ({ getState: async () => "delayed", remove: async () => {} }), close: async () => {} }),
	});
	assert.match(notHeld.invalid, /not waiting on a condition/);

	assert.match((await cancelHeldJob({ url: "redis://x", jobId: "" })).invalid, /job id is required/);
});

test("cancelHeldJob removes the hold FIRST, then the job, and only a lease it owns", async () => {
	const { cancelHeldJob } = await import("../src/read-model.mjs");
	const order = [];
	const res = await cancelHeldJob({
		url: "redis://x",
		jobId: "gh-1",
		redisFn: () => ({
			hgetall: async () => ({ since: "1", target: "o/r#1", label: "jira", dedupId: "o/r#1:fix#0" }),
			get: async () => "gh-1", // the lease names US
			del: async (k) => (order.push(`del ${k}`), 1),
			srem: async (_k, id) => (order.push(`srem ${id}`), 1),
			disconnect() {},
		}),
		queueFn: () => ({ getJob: async () => ({ getState: async () => "delayed", remove: async () => order.push("remove") }), close: async () => order.push("close") }),
	});
	assert.deepEqual(res, { ok: true, jobId: "gh-1" });
	// The hold goes first: if `remove` throws or the timeout fires, an orphaned hash keeps a panel row for a
	// job that is gone, while an orphaned job is merely a job that still runs -- the state we were in.
	assert.deepEqual(order.slice(0, 4), ["del wait:job:gh-1", "srem gh-1", "del wait:key:o/r#1:fix#0", "remove"]);
	assert.ok(order.includes("close"), "the queue's own close is called, not just disconnect");

	// A lease naming a SIBLING is left alone: that job is legitimately still holding the target.
	const dels2 = [];
	await cancelHeldJob({
		url: "redis://x",
		jobId: "gh-1",
		redisFn: () => ({
			hgetall: async () => ({ since: "1", dedupId: "o/r#1:fix#0" }),
			get: async () => "gh-sibling",
			del: async (k) => (dels2.push(k), 1),
			srem: async () => 1,
			disconnect() {},
		}),
		queueFn: () => ({ getJob: async () => ({ getState: async () => "delayed", remove: async () => {} }), close: async () => {} }),
	});
	assert.deepEqual(dels2, ["wait:job:gh-1"], "the sibling's lease survives");
});

test("cancelHeldJob refuses a job that already woke, however stale the hold looks", async () => {
	const { cancelHeldJob } = await import("../src/read-model.mjs");
	// `release` is fail-open by design, so a redis blip leaves the hash while the job wakes and runs. bullmq
	// will remove a COMPLETED job without complaint, so existence is not the question -- state is. Answering
	// `applied: true` here tells an operator who approved "It will never run" the opposite of the truth.
	for (const state of ["completed", "failed", "active", "unknown"]) {
		const res = await cancelHeldJob({
			url: "redis://x",
			jobId: "gh-1",
			redisFn: () => ({ hgetall: async () => ({ since: "1" }), get: async () => null, del: async () => 1, srem: async () => 1, disconnect() {} }),
			queueFn: () => ({ getJob: async () => ({ getState: async () => state, remove: async () => {} }), close: async () => {} }),
		});
		assert.match(res.invalid, /has already left the hold/, `state ${state}`);
	}
});

test("cancelHeldJob refuses a counters-only hash: a job with no clock was never held", async () => {
	const { cancelHeldJob } = await import("../src/read-model.mjs");
	const res = await cancelHeldJob({
		url: "redis://x",
		jobId: "gh-1",
		redisFn: () => ({ hgetall: async () => ({ checks: "3", faults: "1" }), disconnect() {} }),
		queueFn: () => ({ getJob: async () => ({ getState: async () => "delayed", remove: async () => {} }), close: async () => {} }),
	});
	assert.match(res.invalid, /not waiting on a condition/);
});

test("cancelHeldJob refuses a job that has already left the queue", async () => {
	const { cancelHeldJob } = await import("../src/read-model.mjs");
	const res = await cancelHeldJob({
		url: "redis://x",
		jobId: "gh-gone",
		redisFn: () => ({ hgetall: async () => ({ since: "1" }), get: async () => null, del: async () => 1, srem: async () => 1, disconnect() {} }),
		queueFn: () => ({ getJob: async () => undefined, close: async () => {} }),
	});
	assert.match(res.invalid, /no longer in the queue/);
});

// --- the panel's own reader, which nothing had ever executed ------------------------------------------

test("the panel's held reader and the tool's cannot diverge on the four things that matter", async () => {
	// `createDashboardDeps` had no test at all before this slice: every dashboard test injects a canned
	// snapshot, so the code that actually talks to redis on the 1s refresh was never executed by the suite.
	// That is exactly where a sort-after-slice and an unbounded keyspace walk lived unnoticed. The panel copy
	// exists for a real reason (it reuses a client the panel already holds) so it cannot simply be deleted --
	// which makes the two copies agreeing the property to pin.
	const { readFileSync } = await import("node:fs");
	const panel = readFileSync(new URL("../src/dashboard.ts", import.meta.url), "utf8");
	const panelFn = panel.slice(panel.indexOf("async function heldJobs("), panel.indexOf("export function createDashboardDeps"));
	const tool = readFileSync(new URL("../src/read-model.mjs", import.meta.url), "utf8");
	const toolFn = tool.slice(tool.indexOf("export async function readHeldJobs("), tool.indexOf("export async function cancelHeldJob("));

	for (const [what, needle] of [
		["reads the index rather than scanning the keyspace", "smembers"],
		["prunes a stale member as it reads", "srem"],
		["bounds what it hydrates", "HELD_HYDRATE_MAX"],
		["reports a truncated index rather than stating a total it cannot know", "truncated"],
	]) {
		assert.ok(panelFn.includes(needle), `the panel copy ${what}`);
		assert.ok(toolFn.includes(needle), `the tool copy ${what}`);
	}
	// Sorting BEFORE the cut is the one that is invisible in a green suite: slicing first shows an arbitrary
	// sample and calls it the top, so the stuck job an operator is hunting is simply absent.
	// The hydration bound legitimately comes first (bound what you read, sort what you read, then cut), so
	// what must follow the sort is the FINAL cut -- the one that decides which rows a human sees.
	for (const [name, src, finalCut] of [["panel", panelFn, "rows.slice(0, HELD_LIMIT)"], ["tool", toolFn, "rows.slice(0, limit)"]]) {
		assert.ok(src.includes(finalCut), `${name}: cuts the sorted rows`);
		assert.ok(src.indexOf(".sort(") < src.indexOf(finalCut), `${name}: sorts before it cuts`);
	}
	assert.equal(panel.includes('redis.scan('), false, "and neither walks the keyspace any more");
	assert.equal(tool.includes("redis.scan("), false);
});

test("the tool refuses a hold the reader can see but the queue cannot", async () => {
	// The two halves of `dispatch_wait_cancel`'s promise: it resolves the id out of the listing, and the
	// listing is now the whole index rather than a sample -- so an id an operator can SEE is an id it can act
	// on. Previously the listing was a truncation artifact and most held jobs were unreachable.
	const { readHeldJobs, cancelHeldJob } = await import("../src/read-model.mjs");
	const hashes = {};
	for (let i = 0; i < 30; i += 1) hashes[`wait:job:gh-${i}`] = { since: String(NOW - i * 1000), target: `o/r#${i}`, label: "jira" };
	const held = await readHeldJobs({ url: "redis://x", redisFn: () => fakeRedis(hashes), limit: 20, now: () => NOW });
	assert.equal(held.rows.length + held.more, 30, "every held job is accounted for, not just the sampled ones");

	const gone = await cancelHeldJob({
		url: "redis://x",
		jobId: "gh-5",
		redisFn: () => ({ hgetall: async () => ({ since: "1" }), get: async () => null, del: async () => 1, srem: async () => 1, disconnect() {} }),
		queueFn: () => ({ getJob: async () => undefined, close: async () => {} }),
	});
	assert.match(gone.invalid, /no longer in the queue/);
});
