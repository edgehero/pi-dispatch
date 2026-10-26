import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderHeldJobs } from "../src/render.mjs";
import { DEFER_TIME_MAX_MS } from "@edgehero/pi-dispatch/defer-reasons";

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
	assert.deepEqual(res, { ok: true, jobId: "gh-1", attemptsMade: 0 });
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

test("cancelHeldJob: a removal that fails after the hold was cleared is partial, in the console's words and never the error's", async () => {
	const { cancelHeldJob } = await import("../src/read-model.mjs");
	const { heldClearedAnswer } = await import("../src/job-actions.mjs");
	// A worker locked the job between removeHeldJob's state read and its remove: the hold's keys are already gone.
	const world = (getJobState) => ({
		url: "redis://x",
		jobId: "gh-1",
		redisFn: () => ({ hgetall: async () => ({ since: "1" }), get: async () => null, del: async () => 1, srem: async () => 1, disconnect() {} }),
		queueFn: () => ({
			getJob: async () => ({
				getState: async () => "delayed",
				remove: async () => {
					throw new Error("Job gh-1 could not be removed because it is locked by another worker");
				},
			}),
			getJobState,
			close: async () => {},
		}),
	});
	for (const [state, getJobState] of [["active", async () => "active"], ["delayed", async () => "delayed"], ["unknown", async () => { throw new Error("ECONNRESET"); }]]) {
		const res = await cancelHeldJob(world(getJobState));
		assert.deepEqual(res, heldClearedAnswer("gh-1", state), state);
		assert.equal(res.partial, true, `${state}: the hold is gone, so never "nothing was changed"`);
		assert.ok(!/locked by another worker|nothing was changed|ECONNRESET/i.test(res.invalid), res.invalid);
	}
	// Shared with the TUI's panel and the model's tool, which show no preview: the sentence names none.
	assert.equal(heldClearedAnswer("gh-1", "active").invalid, "the job was not removed: it started while its hold was being cleared, and its hold's record is gone; look at the fleet (job gh-1)");
	assert.equal(heldClearedAnswer("gh-1", "completed").invalid, heldClearedAnswer("gh-1", "active").invalid);
	for (const state of ["active", "completed", "failed", "delayed", "unknown"]) assert.ok(!/preview/.test(heldClearedAnswer("gh-1", state).invalid), state);
	assert.equal(heldClearedAnswer("gh-1", "delayed").invalid, "the job was not removed, though its hold was cleared: it may still be queued without one; cancel it again if the fleet shows it (job gh-1)");
});

/**
 * The blocks of `fnName` (and of the functions inside it) that never ran, from V8's block coverage of the module copy at
 * `url`: every one that holds code once its comments are left out (a block of a closing brace alone is the end of one
 * that returned, and holds none).
 */
function blocksNotRun(coverage, url, fnName) {
	const script = coverage.result.find((s) => s.url === url);
	assert.ok(script, `${url} was covered`);
	const file = new URL(url);
	file.search = "";
	const source = readFileSync(fileURLToPath(file), "utf8");
	const top = script.functions.find((f) => f.functionName === fnName);
	assert.ok(top?.isBlockCoverage === true, `${fnName}: block coverage (a function compiled before the coverage started counts only whole calls)`);
	const [start, end] = [top.ranges[0].startOffset, top.ranges[0].endOffset];
	const missed = [];
	for (const f of script.functions.filter((g) => g.ranges[0].startOffset >= start && g.ranges[0].endOffset <= end)) {
		for (const r of f.ranges) {
			const code = source.slice(r.startOffset, r.endOffset).replace(/\/\/[^\n]*/g, "");
			if (r.count === 0 && /[A-Za-z0-9"'`]/.test(code)) missed.push(`${fnName}: ${code.trim().slice(0, 160)}`);
		}
	}
	return missed;
}

/**
 * The functions of the module copy at `url` that build a cancel answer `fnName` can give through `jobLast` or
 * `cancelQueuedRefusal` (the two ways an answer names its job): each named function whose source calls one of them and
 * that `fnName` names, or one of those names, so an answer built in such a helper is walked as the function's own are,
 * and one added later is walked without a list kept by hand. A helper that names the job any other way is the next
 * test's to refuse, whichever of the two modules it is in.
 */
function answerBuildersOf(coverage, url, fnName) {
	const script = coverage.result.find((s) => s.url === url);
	const file = new URL(url);
	file.search = "";
	const source = readFileSync(fileURLToPath(file), "utf8");
	const named = new Map(script.functions.filter((f) => f.functionName !== "").map((f) => [f.functionName, source.slice(f.ranges[0].startOffset, f.ranges[0].endOffset)]));
	const builds = (body) => /\b(?:jobLast|cancelQueuedRefusal)\(/.test(body);
	const found = [];
	const next = [fnName];
	while (next.length > 0) {
		const body = named.get(next.shift());
		for (const [name, own] of named) {
			if (name === fnName || found.includes(name) || !builds(own) || !new RegExp(`\\b${name}\\(`).test(body)) continue;
			found.push(name);
			next.push(name);
		}
	}
	return found.sort();
}

// Issue #737: every cancel answer is also the audit row's `reason`, which the log cuts at CONSOLE_AUDIT_FIELD_MAX. The
// answers are the two functions' own, driven through each path their seams can take (each answer `removeQueuedJob`
// documents, each re-check, each never-started rule, each bound, each fallback), and V8's block coverage of the two, and
// of every job-actions.mjs helper that names the job in one of their answers through `jobLast` or `cancelQueuedRefusal`
// (`answerBuildersOf`), then says whether a path was left out: one added later fails here until it is driven, where a
// list of sentences kept by hand would not see it. That no other function on their paths names the job is the next
// test's, read from the source.
test("every cancel answer driven names its job once and last, after what happened, and a partial one fits the audit row's field whole with a 64-character id; every path of cancelQueuedJob and cancelHeldJob, and of the job-actions helpers on their paths that name the job through jobLast or cancelQueuedRefusal, is driven", async () => {
	const { CONSOLE_AUDIT_FIELD_MAX } = await import("@edgehero/pi-dispatch/console-audit");
	const { removeQueuedJob } = await import("@edgehero/pi-dispatch/cancel-state");
	const { Session } = await import("node:inspector/promises");
	assert.equal(CONSOLE_AUDIT_FIELD_MAX, 200);
	const id = `gh-${"a".repeat(61)}`;
	assert.equal(id.length, 64);
	const SCHEDULER = "n".repeat(43);
	const SCHEDULED = `repeat:${SCHEDULER}:1700000000000`;
	assert.equal(SCHEDULED.length, 64);
	const session = new Session();
	session.connect();
	await session.post("Profiler.enable");
	await session.post("Profiler.startPreciseCoverage", { callCount: true, detailed: true });
	// Copies of the two modules of their own, compiled after the coverage started.
	const jobActionsUrl = new URL("../src/job-actions.mjs?cancel-answers", import.meta.url).href;
	const readModelUrl = new URL("../src/read-model.mjs?cancel-answers", import.meta.url).href;
	const { cancelQueuedJob, cancelQueuedRefusal } = await import(jobActionsUrl);
	const { cancelHeldJob } = await import(readModelUrl);
	const T = 150;
	const never = () => new Promise(() => {});
	const answers = [];
	const alive = setInterval(() => {}, 1000); // the bounds' timers are unref'd; a real client's socket would hold the loop
	let coverage;
	try {
		// cancel-queued: a fleet of the shared queue (and pi-jobs@h1 when `elsewhere`), a job that never started on it.
		const states = (...seq) => {
			let n = 0;
			return () => {
				const next = seq[Math.min(n++, seq.length - 1)];
				return typeof next === "function" ? next() : Promise.resolve(next);
			};
		};
		const queued = (o = {}) => {
			const job = { id: o.jobId ?? id, name: "github", data: o.data ?? { kind: "github", repo: "acme/web", target: { type: "issue", number: 1 } }, attemptsMade: 0, stalledCounter: 0, getState: o.getState ?? (async () => "delayed"), remove: async () => {}, ...o.job };
			let made = 0;
			let gets = 0;
			return cancelQueuedJob({
				url: "redis://x",
				jobId: o.jobId ?? id,
				expect: o.expect === undefined ? { queue: "pi-jobs", attemptsMade: 0, stalledCounter: 0 } : o.expect,
				parseConnectionFn: () => ({}),
				timeoutMs: T,
				redisFn: () => {
					made += 1;
					if (o.clientThrows !== undefined && made === 2) throw o.clientThrows;
					return { on() {}, async smembers() { return []; }, async scan() { return ["0", o.elsewhere ? ["bull:pi-jobs@h1:meta"] : []]; }, async zscore() { return o.zscore ?? null; }, hget: o.hget ?? (async () => (o.held ? "1700000000000" : null)), async hgetall() { return {}; }, disconnect() {} };
				},
				queueFn: (_c, { name }) => ({
					name,
					toKey: (t) => `bull:${name}:${t}`,
					getJob: o.getJob ?? (async () => {
						gets += 1;
						if (o.gone || (o.elsewhere && name !== "pi-jobs@h1")) return undefined;
						if (gets > 1 && o.fresh !== undefined) return o.fresh === null ? undefined : { ...job, ...o.fresh };
						return job;
					}),
					close: async () => {},
				}),
				removeQueuedJobFn: o.remove ?? (async () => ({ ok: true, held: false })),
			});
		};
		// The seam answering one of the answers `removeQueuedJob` documents.
		const answer = (res) => async () => res;
		const queuedCases = {
			badId: { jobId: "a b" },
			badExpect: { expect: null },
			gone: { gone: true },
			elsewhere: { elsewhere: true },
			startedAtCheck: { getState: async () => "active" },
			stateUnread: { getState: async () => { throw new Error("ECONNRESET"); } },
			recovery: { data: { kind: "github", repo: "acme/web", target: { type: "issue", number: 1 }, recoveryOf: "gh-run-1" } },
			// The never-started rules at the confirm, with the counts the preview saw: the scheduler's next run (a 64-character
			// cron run id), a job that made an attempt, one handed back after a stall.
			scheduled: { jobId: SCHEDULED, job: { repeatJobKey: SCHEDULER }, zscore: "1700000000000" },
			retried: { job: { attemptsMade: 2 }, expect: { queue: "pi-jobs", attemptsMade: 2, stalledCounter: 0 } },
			stalled: { job: { stalledCounter: 1 }, expect: { queue: "pi-jobs", attemptsMade: 0, stalledCounter: 1 } },
			clientThrows: { clientThrows: new Error("connect ECONNREFUSED 10.0.0.5:6379") },
			clientThrewNoError: { clientThrows: "ECONNREFUSED" },
			holdUnread: { hget: async () => { throw new Error("ECONNRESET"); } },
			checkUnanswered: { getJob: never },
			removed: {},
			removalThrew: { remove: () => { throw new Error("bug"); } },
			heldRemovalThrew: { held: true, remove: () => { throw new Error("bug"); } },
			removalUnanswered: { remove: never },
			heldRemovalUnanswered: { held: true, remove: never },
			guardSawAnAttempt: { remove: removeQueuedJob, fresh: { attemptsMade: 1 } },
			guardSawItGone: { remove: removeQueuedJob, fresh: null },
			guardSawFinished: { remove: removeQueuedJob, fresh: { finishedOn: 1700000000000 } },
			guardSawStall: { remove: removeQueuedJob, fresh: { stalledCounter: 1 } },
			guardSawCountsGone: { remove: removeQueuedJob, fresh: { attemptsMade: null, stalledCounter: null } },
			guardReadThrew: { remove: removeQueuedJob, getState: states("delayed", () => Promise.reject(new Error("ECONNRESET"))) },
			guardThrew: { remove: answer({ refused: null, error: new Error("ECONNRESET") }) },
			clearedStarted: { remove: answer({ invalid: `Job ${id} could not be removed because it is locked by another worker`, cleared: true }), getState: states("delayed", "active") },
			clearedStayed: { remove: answer({ invalid: "locked", cleared: true }), getState: states("delayed", "delayed") },
			clearedUnanswered: { remove: answer({ invalid: "locked", cleared: true }), getState: states("delayed", never) },
			clearedUnread: { remove: answer({ invalid: "locked", cleared: true }), getState: states("delayed", () => Promise.reject(new Error("ECONNRESET"))) },
			heldRefused: { remove: answer({ invalid: `job ${id} is no longer in the queue` }) },
			notQueuedFinished: { remove: answer({ notQueued: true, state: "completed" }) },
			notQueuedOther: { remove: answer({ notQueued: true, state: "waiting-children" }) },
			notQueuedUnsaid: { remove: answer({ notQueued: true }) },
			racedUnread: { remove: answer({ raced: true, state: "unknown", error: new Error("Connection is closed.") }) },
			racedUnsaid: { remove: answer({ raced: true, error: new Error("Connection is closed.") }) },
			racedStarted: { remove: answer({ raced: true, state: "active", error: new Error("locked") }) },
			racedStayed: { remove: answer({ raced: true, state: "delayed", error: new Error(`Job ${id} belongs to a job scheduler and cannot be removed directly. remove`) }) },
			racedNoError: { remove: answer({ raced: true, state: "delayed", error: "ERR unknown" }) },
			unknownAnswer: { remove: answer({ weird: true }) },
			noAnswer: { remove: answer(undefined) },
		};
		for (const [name, o] of Object.entries(queuedCases)) answers.push([`cancelQueuedJob ${name}`, await queued(o), o.jobId ?? id]);
		// cancel-held: the worker's removeHeldJob on a held job of the shared queue.
		const held = (o = {}) =>
			cancelHeldJob({
				url: o.url ?? "redis://x",
				jobId: o.jobId ?? id,
				timeoutMs: T,
				redisFn: () => {
					if (o.clientThrows !== undefined) throw o.clientThrows;
					return { on() {}, async smembers() { return []; }, async scan() { return ["0", []]; }, hgetall: o.hgetall ?? (async () => ({ since: "1" })), async hexists() { return 0; }, get: async () => null, del: o.del ?? (async () => 1), srem: async () => 1, disconnect: o.disconnect ?? (() => {}) };
				},
				queueFn: (_c, { name }) => ({
					name,
					getJob: o.getJob ?? (async () => ({ getState: o.state ?? (async () => "delayed"), remove: o.removeJob ?? (async () => {}) })),
					getJobState: o.after ?? (async () => "delayed"),
					close: o.close ?? (async () => {}),
				}),
			});
		const locked = async () => {
			throw new Error(`Job ${id} could not be removed because it is locked by another worker`);
		};
		const heldCases = {
			noId: { jobId: "" },
			badUrl: { url: "not a url" },
			clientThrewNoError: { clientThrows: "ECONNREFUSED" },
			closesThrow: { disconnect: () => { throw new Error("already closed"); }, close: () => { throw new Error("already closed"); } },
			removed: {},
			notHeld: { hgetall: async () => ({}) },
			holdUnread: { hgetall: async () => { throw new Error("ECONNRESET"); } },
			leftTheQueue: { getJob: async () => undefined },
			woke: { state: async () => "active" },
			clearedStarted: { removeJob: locked, after: async () => "active" },
			clearedStayed: { removeJob: locked, after: async () => "delayed" },
			clearedUnread: { removeJob: locked, after: async () => { throw new Error("ECONNRESET"); } },
			removalUnanswered: { del: never },
			lookupUnanswered: { getJob: never },
		};
		for (const [name, o] of Object.entries(heldCases)) answers.push([`cancelHeldJob ${name}`, await held(o), o.jobId ?? id]);
	} finally {
		clearInterval(alive);
		coverage = await session.post("Profiler.takePreciseCoverage");
		await session.post("Profiler.stopPreciseCoverage");
		session.disconnect();
	}
	const last = ` (job ${id})`;
	for (const [name, a, jobId] of answers) {
		if (typeof a?.invalid !== "string") continue;
		if (a.partial === true || (jobId !== "" && a.invalid.includes(jobId))) {
			assert.ok(a.invalid.endsWith(` (job ${jobId})`), `${name}: the job named last: ${a.invalid}`);
			assert.ok(!a.invalid.slice(0, -` (job ${jobId})`.length).includes(jobId), `${name}: and only there: ${a.invalid}`);
		}
		if (a.partial === true) assert.ok([...a.invalid].length <= CONSOLE_AUDIT_FIELD_MAX, `${name}: ${[...a.invalid].length} characters: ${a.invalid}`);
	}
	assert.ok(answers.some(([, a]) => a?.partial === true) && answers.some(([, a]) => typeof a?.invalid === "string" && a.partial !== true && a.invalid.endsWith(last)), "both kinds were driven");
	// The two doors say one thing of one outcome: a held job's removal asked for and not answered within the bound.
	const said = Object.fromEntries(answers);
	assert.deepEqual(said["cancelHeldJob removalUnanswered"], said["cancelQueuedJob heldRemovalUnanswered"]);
	assert.equal(said["cancelHeldJob removalUnanswered"].partial, true);
	// The never-started rules refuse in their own words at the confirm as at the preview.
	assert.deepEqual(said["cancelQueuedJob scheduled"], { invalid: cancelQueuedRefusal("scheduled", { jobId: SCHEDULED, scheduler: SCHEDULER }) });
	assert.deepEqual(said["cancelQueuedJob retried"], { invalid: cancelQueuedRefusal("retried", { jobId: id, attempts: 2 }) });
	assert.deepEqual(said["cancelQueuedJob stalled"], { invalid: cancelQueuedRefusal("stalled", { jobId: id }) });
	// The answers the two build in helpers are walked as theirs are: every helper of the module that builds one.
	const builders = answerBuildersOf(coverage, jobActionsUrl, "cancelQueuedJob");
	for (const helper of ["cancelQueuedRefusal", "heldClearedAnswer", "heldRefused", "movedSince", "neverStartedRefusal", "removalUnknown", "removalUnreadBack", "unreadBeforeRemoval"]) assert.ok(builders.includes(helper), `${helper} builds an answer of cancelQueuedJob's: ${builders}`);
	assert.deepEqual([...blocksNotRun(coverage, jobActionsUrl, "cancelQueuedJob"), ...blocksNotRun(coverage, readModelUrl, "cancelHeldJob"), ...builders.flatMap((f) => blocksNotRun(coverage, jobActionsUrl, f))], [], "every path of the two, and of their job-actions helpers that name the job through jobLast or cancelQueuedRefusal, was driven");
});

/**
 * A module's top-level declarations by name (each function, and each const: a helper may be an arrow bound to one), each
 * with its source from its line to the next declaration's, comment lines left out.
 */
function topLevelFunctions(url) {
	const DECL = /^(?:export )?(?:async )?function\*? ([A-Za-z_$][\w$]*)\(|^(?:export )?const ([A-Za-z_$][\w$]*) = /;
	const out = new Map();
	let name = null;
	for (const line of readFileSync(fileURLToPath(url), "utf8").split("\n")) {
		const m = DECL.exec(line);
		if (m) out.set((name = m[1] ?? m[2]), []);
		if (name !== null && !/^\s*(?:\/\/|\/?\*)/.test(line)) out.get(name).push(line);
	}
	return new Map([...out].map(([n, lines]) => [n, lines.join("\n")]));
}

// Issue #737: the walk above drives the answers a cancel gives today; this holds the rule for every function a cancel
// can reach, read from the source, so a helper added later that names the job before what happened fails here whether
// or not a case drives it, whether or not it calls `jobLast`, and whichever of the two modules it is in. The reach is
// every top-level function of job-actions.mjs and read-model.mjs that `cancelQueuedJob` or `cancelHeldJob` names, and
// every one those name, across the two; on it only `jobLast` (the id last) and `theirWords` (another module's words,
// the job in them said as "the job") put the job's id in text.
test("no function a cancel reaches in job-actions.mjs or read-model.mjs writes the job's id into its text but jobLast, which names it last, and theirWords, which takes it out", () => {
	const mods = { ja: topLevelFunctions(new URL("../src/job-actions.mjs", import.meta.url)), rm: topLevelFunctions(new URL("../src/read-model.mjs", import.meta.url)) };
	const reached = new Set();
	const next = [["ja", "cancelQueuedJob"], ["rm", "cancelHeldJob"]];
	while (next.length > 0) {
		const [mod, fn] = next.shift();
		if (reached.has(`${mod}:${fn}`)) continue;
		reached.add(`${mod}:${fn}`);
		const body = mods[mod].get(fn) ?? "";
		for (const m of ["ja", "rm"]) for (const name of mods[m].keys()) if (name !== fn && new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`).test(body)) next.push([m, name]);
	}
	for (const fn of ["ja:movedSince", "ja:heldRefused", "ja:heldClearedAnswer", "ja:removalUnknown", "ja:theirWords", "ja:jobLast"]) assert.ok(reached.has(fn), `${fn} is on a cancel's path: ${[...reached].join(" ")}`);
	const bad = [];
	for (const key of reached) {
		const [mod, fn] = key.split(":");
		if (fn === "jobLast" || fn === "theirWords") continue;
		for (const lit of mods[mod].get(fn).match(/`(?:[^`\\]|\\.)*`/g) ?? []) if (/\$\{\s*(?:[\w$?.]*\.)?(?:jobId|id)\s*\}/.test(lit)) bad.push(`${key}: ${lit.slice(0, 100)}`);
	}
	assert.deepEqual(bad, [], "a cancel answer names its job through jobLast alone");
});

test("cancelHeldJob answers within its bound whatever Valkey does: a close that never settles, and a removal asked for and never answered", async () => {
	const { cancelHeldJob } = await import("../src/read-model.mjs");
	const alive = setInterval(() => {}, 1000); // the bound's timer is unref'd; a real client's socket would hold the loop
	const bounded = async (promise) => {
		const t0 = Date.now();
		let timer;
		const res = await Promise.race([promise, new Promise((resolve) => (timer = setTimeout(() => resolve("hung"), 5_000)))]);
		clearTimeout(timer);
		return { res, ms: Date.now() - t0 };
	};
	try {
		const never = () => new Promise(() => {});
		const closes = [];
		const job = { getState: async () => "delayed", remove: async () => {} };
		const redis = (del) => () => ({ hgetall: async () => ({ since: "1" }), get: async () => null, del, srem: async () => 1, disconnect() {} });
		const queueFn = (getJob) => (_c, { name }) => ({ name, getJob, close: () => (closes.push(name), never()) });
		// The removal went through and the queue's close never settles: the answer does not wait on it.
		const done = await bounded(cancelHeldJob({ url: "redis://x", jobId: "gh-1", redisFn: redis(async () => 1), queueFn: queueFn(async () => job), timeoutMs: 300 }));
		assert.deepEqual(done.res, { ok: true, jobId: "gh-1", attemptsMade: 0 });
		assert.ok(done.ms < 900, `${done.ms} ms`);
		// The removal was asked for and the hold's delete never answered: it may have landed, so partial.
		const cut = await bounded(cancelHeldJob({ url: "redis://x", jobId: "gh-1", redisFn: redis(never), queueFn: queueFn(async () => job), timeoutMs: 300 }));
		const unanswered = { invalid: "the job or its hold may or may not be gone: their removal was asked for and not answered within the bound; look at the fleet (job gh-1)", partial: true };
		assert.deepEqual(cut.res, unanswered);
		assert.ok(cut.ms < 900, `${cut.ms} ms`);
		// The bound fired in the removal's first read, before any delete was sent: the same words, which say it was asked
		// for, never that it was sent.
		const first = await bounded(cancelHeldJob({ url: "redis://x", jobId: "gh-1", redisFn: () => ({ ...redis(async () => 1)(), hgetall: never }), queueFn: queueFn(async () => job), timeoutMs: 300 }));
		assert.deepEqual(first.res, unanswered);
		// The job was never found because the lookup never answered: nothing was asked, nothing changed.
		const lost = await bounded(cancelHeldJob({ url: "redis://x", jobId: "gh-1", redisFn: redis(async () => 1), queueFn: queueFn(never), timeoutMs: 300 }));
		assert.deepEqual(lost.res, { invalid: "timed out reaching the queue" });
		assert.ok(lost.ms < 900, `${lost.ms} ms`);
		assert.ok(closes.length >= 3, `every queue opened was asked to close (${closes.length})`);
	} finally {
		clearInterval(alive);
	}
});

test("cancelHeldJob: a lookup that outlasts the bound closes the queue it opens after the bound, once it settles", async () => {
	const { cancelHeldJob } = await import("../src/read-model.mjs");
	const T = 200;
	const opened = [];
	const closed = [];
	const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
	// A host queue the keyspace holds, asked after the shared queue, whose lookup takes twice the bound.
	const redisFn = () => ({ on() {}, smembers: async () => [], scan: async () => ["0", ["bull:pi-jobs@h1:meta"]], hgetall: async () => ({ since: "1" }), get: async () => null, del: async () => 1, srem: async () => 1, disconnect() {} });
	const queueFn = (_c, { name }) => {
		opened.push(name);
		return { name, getJob: async () => (name === "pi-jobs" ? (await sleep(2 * T), undefined) : { getState: async () => "completed", remove: async () => {} }), close: async () => closed.push(name) };
	};
	const res = await cancelHeldJob({ url: "redis://127.0.0.1:1", jobId: "gh-1", redisFn, queueFn, timeoutMs: T });
	assert.deepEqual(res, { invalid: "timed out reaching the queue" });
	await sleep(5 * T);
	assert.deepEqual(opened, ["pi-jobs", "pi-jobs@h1"], "the second queue was opened after the bound");
	assert.deepEqual([...closed].sort(), [...opened].sort(), "every queue opened was closed once the lookup settled");
});

test("cancelHeldJob carries an error's own words only bounded: control bytes made spaces, at most 200 characters, and the job named after them", async () => {
	const { cancelHeldJob } = await import("../src/read-model.mjs");
	const long = `Unexpected token \u001b[2J\u0007 in JSON at position ${"9".repeat(300)}`;
	const bounded = `Unexpected token  [2J  in JSON at position ${"9".repeat(300)}`.slice(0, 200);
	// removeHeldJob refused before its first delete, with a client's words: its read of the hold threw.
	const refused = await cancelHeldJob({
		url: "redis://x",
		jobId: "gh-1",
		redisFn: () => ({ hgetall: async () => { throw new Error(long); }, disconnect() {} }),
		queueFn: () => ({ getJob: async () => ({ getState: async () => "delayed", remove: async () => {} }), close: async () => {} }),
	});
	assert.deepEqual(refused, { invalid: `${bounded} (job gh-1)` });
	// The sequence itself threw before it could answer: its client could not be made.
	const thrown = await cancelHeldJob({
		url: "redis://x",
		jobId: "gh-1",
		redisFn: () => {
			throw new Error(long);
		},
		queueFn: () => ({ getJob: async () => undefined, close: async () => {} }),
	});
	assert.deepEqual(thrown, { invalid: bounded });
	// Its own sentences pass with the job named last, once.
	const notHeld = await cancelHeldJob({ url: "redis://x", jobId: "gh-1", redisFn: () => ({ hgetall: async () => ({}), disconnect() {} }), queueFn: () => ({ getJob: async () => ({}), close: async () => {} }) });
	assert.deepEqual(notHeld, { invalid: "the job is not waiting on a condition (job gh-1)" });
});

test("a refusal whose words name the job where the bound falls names it once, last: the job is said as the job before the words are cut, so no cut piece of its id is left in them", async () => {
	const { heldRefused } = await import("../src/job-actions.mjs");
	const id = `gh-${"a".repeat(61)}`;
	const last = ` (job ${id})`;
	for (const lead of [150, 170, 185, 195]) {
		const said = heldRefused(id, `${"x".repeat(lead)} job ${id} is no longer in the queue`).invalid;
		assert.ok(said.endsWith(last), said);
		assert.ok(!said.slice(0, -last.length).includes("gh-a"), `${lead}: a cut piece of the id in the words: ${said.slice(-90)}`);
	}
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
	// The panel's copy moved with the fleet reader into read-model.mjs (issue #641); it is still the twin this pins.
	const panel = readFileSync(new URL("../src/read-model.mjs", import.meta.url), "utf8");
	const panelFn = panel.slice(panel.indexOf("async function heldJobs("), panel.indexOf("export function createFleetReader"));
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

test("the fleet reader's held rows carry the checks, the after instant and each profile's last answer; the tool's listing keeps its keys (#737)", async () => {
	const { createFleetReader } = await import("../src/read-model.mjs");
	const { tempDir } = await import("./helpers/temp-dir.mjs");
	const { join } = await import("node:path");
	const hashes = {
		"wait:job:gh-1": {
			since: String(NOW - 60_000),
			target: "acme/web#7",
			label: "jira + after 2026-10-15T09:00:00Z",
			checks: "4",
			after: String(NOW + 3_600_000),
			// The worker's `a:<profile>` = `<answer>:<ms>`: sorted by profile, at most four, each judged by its rule.
			"a:jira": `hold:${NOW - 1000}`,
			"a:deploy": `go:${NOW - 2000}`,
			"a:bad profile": `go:${NOW}`,
			"a:ci": "maybe:5",
			"a:e2e": "fault:soon",
			"a:aa": `fault:${NOW}`,
			"a:ab": `refuse:${NOW}`,
			"a:zz": `unclear:${NOW}`,
		},
		"wait:job:gh-2": { since: String(NOW - 1000), target: "acme/web#9", label: "deploy", checks: "lots", after: "tomorrow" },
		// Counters `Number` would take and the decimal rule does not.
		"wait:job:gh-3": { since: String(NOW - 2000), target: "acme/web#10", label: "deploy", checks: "1e3", after: "0x10" },
		// Instants past the last one a page can draw: none, never an instant no date can show.
		"wait:job:gh-4": { since: String(NOW - 3000), target: "acme/web#11", label: "deploy", after: String(DEFER_TIME_MAX_MS + 1), "a:jira": `hold:${DEFER_TIME_MAX_MS + 1}`, "a:ci": `go:${DEFER_TIME_MAX_MS}` },
	};
	const redis = Object.assign(fakeRedis(hashes), { on() {}, async mget(...keys) { return keys.map(() => null); }, async zrevrangebyscore() { return []; }, async exists() { return 0; } });
	const queue = (_c, opts) => ({ name: opts?.name ?? "pi-jobs", async isPaused() { return false; }, async getJobCounts() { return {}; }, async getWorkers() { return []; }, async getJobSchedulers() { return []; }, async getActive() { return []; }, async getFailed() { return []; }, async close() {} });
	const logsDir = tempDir("pd-737-held-rows-");
	const reader = createFleetReader({ valkeyUrl: "redis://unused", logsDir, triggersPath: join(logsDir, "none.json"), schedulerStallMax: 2 }, { makeQueueFn: queue, parseConnectionFn: () => ({}), redisFn: () => redis, readLiveHostsFn: async () => ({ hosts: [] }), discoverHostQueuesFn: async () => [], nowFn: () => NOW });
	const { held } = await reader.snapshot();
	const by = Object.fromEntries(held.rows.map((r) => [r.jobId, r]));
	assert.deepEqual(Object.keys(by["gh-1"]).sort(), ["after", "answers", "checks", "jobId", "label", "target", "waitedMs"]);
	assert.equal(by["gh-1"].checks, 4);
	assert.equal(by["gh-1"].after, NOW + 3_600_000);
	assert.deepEqual(by["gh-1"].answers, [
		{ profile: "aa", answer: "fault", at: NOW },
		{ profile: "ab", answer: "refuse", at: NOW },
		{ profile: "deploy", answer: "go", at: NOW - 2000 },
		{ profile: "jira", answer: "hold", at: NOW - 1000 },
	]);
	assert.deepEqual([by["gh-2"].checks, by["gh-2"].after, by["gh-2"].answers], [0, null, []], "a malformed count or instant is none, never a guess");
	assert.deepEqual([by["gh-3"].checks, by["gh-3"].after], [0, null], "1e3 and 0x10 are no decimal count or instant");
	assert.deepEqual([by["gh-4"].after, by["gh-4"].answers], [null, [{ profile: "ci", answer: "go", at: DEFER_TIME_MAX_MS }]], "the last drawable instant is kept, one past it is none");
	const { readHeldJobs } = await import("../src/read-model.mjs");
	const tool = await readHeldJobs({ url: "redis://x", redisFn: () => fakeRedis(hashes), now: () => NOW });
	assert.deepEqual(Object.keys(tool.rows[0]).sort(), ["checks", "jobId", "label", "target", "waitedMs"], "the tool's listing is unchanged");
	await reader.dispose();
});
