import assert from "node:assert/strict";
import { test } from "node:test";
import { LIVE_JOBS_MAX, LIVE_JOBS_MAX_BYTES, LIVE_JOB_ID_RE, liveJobsFields, liveJobsOf, parseJobsMore, parseLiveJobs, publishedJobId } from "../src/live-jobs.mjs";
import { chainedJobId, forgeDeliveryJobId, localJobId, manualTriggerJobId } from "../src/job-id.mjs";

// The running jobs a host row publishes (issue #599, phase 2, INT-HOST-REGISTRY-CONTRACT `jobs`).

test("every job id shape the project mints is published as itself", () => {
	const ids = [
		forgeDeliveryJobId("github", "3f2a8c10-1d2e-11ef-9a7c-0242ac120002"),
		forgeDeliveryJobId("github", "3f2a8c10-1d2e-11ef-9a7c-0242ac120002", 3),
		forgeDeliveryJobId("gitlab", "0b7c4e5a-8f1d-4c2b-9e3a-7d6f5e4c3b2a"),
		forgeDeliveryJobId("forgejo", "a1b2c3d4-e5f6-7a8b-9c0d-e1f2a3b4c5d6"),
		forgeDeliveryJobId("azure", "6f9619ff-8b86-d011-b42d-00c04fc964ff"),
		forgeDeliveryJobId("github", "poll-e12345678"),
		"repeat:nightly.web_v2-a:1760000000000",
		manualTriggerJobId({ triggerId: "nightly", now: new Date(1760000000000) }),
		localJobId({ folder: "/srv/site", flow: "f", task: "t", minute: 1 }),
		chainedJobId({ parentJobId: "gh-1", flow: "f", task: "t" }),
		"container:pi-job-gh-3f2a8c10",
	];
	for (const id of ids) {
		assert.match(id, LIVE_JOB_ID_RE, id);
		assert.equal(publishedJobId(id), id);
	}
});

test("an id outside the charset, or too long, is published as its digest; none is never published", () => {
	for (const id of ['gh-"quoted"', "gh-a\\b", "gh-a/b", "gh-\u001b[2J", "gh-é", "x".repeat(129), " "]) {
		const out = publishedJobId(id);
		assert.match(out, /^sha256:[0-9a-f]{16}$/, JSON.stringify(id));
		assert.match(out, LIVE_JOB_ID_RE);
	}
	assert.equal(publishedJobId("x".repeat(128)), "x".repeat(128));
	assert.notEqual(publishedJobId("gh-a/b"), publishedJobId("gh-a/c"), "two ids, two digests");
	for (const none of ["", null, undefined, 7]) assert.equal(publishedJobId(none), null);
});

test("the list: running jobs and only the budget's orphans, oldest first, each id once, every field normalised", () => {
	const { jobs, skipped } = liveJobsOf({
		running: [
			{ id: "b", project: "web", memMiB: 2048, cpuCenti: 100, at: 30 },
			{ id: "a", project: "NOT/AN/ID", memMiB: 0, cpuCenti: 1.5, at: 10 },
			{ id: "c", project: null, memMiB: 1, cpuCenti: 1, at: "20" },
			{ project: "web", at: 5 },
		],
		budgetEntries: [
			{ id: "b", project: "web", memMiB: 2048, cpuCenti: 100, at: 30, orphan: { name: "pi-job-b" } },
			{ id: "held", project: "web", memMiB: 2048, cpuCenti: 100, at: 1, orphan: null },
			{ id: "container:pi-job-x", project: null, memMiB: 512, cpuCenti: 50, at: 20, orphan: { name: "pi-job-x" } },
		],
	});
	assert.deepEqual(jobs, [
		{ id: "a", p: null, at: 10 },
		{ id: "container:pi-job-x", p: null, m: 512, c: 50, at: 20, o: 1 },
		{ id: "b", p: "web", m: 2048, c: 100, at: 30 },
	]);
	assert.equal(skipped, 2, "no instant, no id: counted");
	assert.deepEqual(liveJobsOf(), { jobs: [], skipped: 0 });
	assert.deepEqual(liveJobsOf({ running: "x", budgetEntries: null }), { jobs: [], skipped: 0 });
});

test("the fields: at most 32 listed, the rest and the skipped counted in jobsMore", () => {
	const many = { jobs: Array.from({ length: 40 }, (_, i) => ({ id: `j${i}`, p: null, at: i + 1 })), skipped: 2 };
	const out = liveJobsFields(many);
	assert.equal(JSON.parse(out.jobs).length, LIVE_JOBS_MAX);
	assert.equal(JSON.parse(out.jobs)[0].id, "j0");
	assert.equal(out.jobsMore, "10");
	assert.deepEqual(liveJobsFields({ jobs: [], skipped: 0 }), { jobs: "[]", jobsMore: "0" });
	// The longest list fits well inside what a reader parses.
	const longest = { jobs: Array.from({ length: 32 }, (_, i) => ({ id: `${"x".repeat(124)}${String(i).padStart(4, "0")}`, p: "a".repeat(32), m: 2 ** 53 - 1, c: 2 ** 53 - 1, at: 2 ** 53 - 1, o: 1 })), skipped: 0 };
	assert.ok(liveJobsFields(longest).jobs.length < LIVE_JOBS_MAX_BYTES / 2);
	assert.equal(parseLiveJobs(liveJobsFields(longest).jobs).jobs.length, 32, "and reads back whole");
});

test("the reader's allowlist: a hostile entry is dropped and counted, never read, and nothing throws", () => {
	const good = { id: "gh-1", p: "web", m: 1, c: 1, at: 5 };
	const hostile = [
		null,
		7,
		"gh-1",
		[good],
		{ ...good, id: "gh-1\u001b]0;pwned\u0007" },
		{ ...good, id: "a/b" },
		{ ...good, id: "" },
		{ ...good, id: 12 },
		{ ...good, p: "Web" },
		{ ...good, p: "web‮" },
		{ ...good, m: -1 },
		{ ...good, m: 1.5 },
		{ ...good, c: "1" },
		{ ...good, at: 0 },
		{ ...good, at: "5" },
		{ ...good, at: 2 ** 53 },
		{ ...good, o: "1" },
		{ ...good, o: 2 },
	];
	const read = parseLiveJobs(JSON.stringify([good, ...hostile]));
	assert.deepEqual(read.jobs, [{ id: "gh-1", p: "web", m: 1, c: 1, at: 5, o: false }]);
	assert.equal(read.dropped, hostile.length);
	// Extra keys are not copied; absent sizes read as null; the orphan flag as true.
	assert.deepEqual(parseLiveJobs(JSON.stringify([{ id: "x", at: 9, o: 1, extra: "free text" }])).jobs, [{ id: "x", p: null, m: null, c: null, at: 9, o: true }]);
	// Past 32 entries the rest are counted.
	const many = parseLiveJobs(JSON.stringify(Array.from({ length: 35 }, (_, i) => ({ id: `j${i}`, at: i + 1 }))));
	assert.deepEqual([many.jobs.length, many.dropped], [32, 3]);
	// Not a list, not JSON, too long, absent: no list at all.
	for (const raw of [undefined, null, "", "{", "{}", '"x"', "1", `[${" ".repeat(LIVE_JOBS_MAX_BYTES)}]`, 5]) assert.deepEqual(parseLiveJobs(raw), { jobs: null, dropped: 0 }, String(raw).slice(0, 10));
	// An already parsed list goes through the same allowlist.
	assert.deepEqual(parseLiveJobs([good, { ...good, id: "a b" }]), { jobs: [{ ...good, o: false }], dropped: 1 });
	// What it returns reads back as itself (the capacity report re-reads a row `readLiveHosts` parsed).
	const once = parseLiveJobs(JSON.stringify([good, { ...good, id: "o", o: 1 }])).jobs;
	assert.deepEqual(parseLiveJobs(once), { jobs: once, dropped: 0 });
});

test("jobsMore reads back as a non-negative integer or null", () => {
	assert.equal(parseJobsMore("3"), 3);
	assert.equal(parseJobsMore(4), 4);
	for (const bad of ["", "-1", "1.5", "1e3", "9999999999", undefined, null, -2, "x"]) assert.equal(parseJobsMore(bad), null, String(bad));
});
