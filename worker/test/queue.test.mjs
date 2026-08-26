import assert from "node:assert/strict";
import { test } from "node:test";
import { chainedJobId, deliveryJobId, localJobId } from "../src/job-id.mjs";

// localJobId is pure -- runs everywhere. It is the dedup key for local jobs (REQ-DEDUP equivalent).

test("same folder/flow/task/minute -> same jobId (a double-invoke dedups)", () => {
	const a = localJobId({ folder: "/proj", flow: "tidy", task: "dedupe", minute: "2026-07-16T12:00" });
	const b = localJobId({ folder: "/proj", flow: "tidy", task: "dedupe", minute: "2026-07-16T12:00" });
	assert.equal(a, b);
	assert.match(a, /^local-[0-9a-f]{16}$/);
});

test("any field changing changes the id -- a genuinely different run is not swallowed", () => {
	const base = { folder: "/proj", flow: "tidy", task: "dedupe", minute: "2026-07-16T12:00" };
	const id = localJobId(base);
	assert.notEqual(id, localJobId({ ...base, task: "other" }));
	assert.notEqual(id, localJobId({ ...base, folder: "/other" }));
	assert.notEqual(id, localJobId({ ...base, flow: "bug-fix" }));
	assert.notEqual(id, localJobId({ ...base, minute: "2026-07-16T12:01" }), "a minute later is a new run");
});

test("field separation is unambiguous -- concatenation collisions cannot occur", () => {
	// Without a delimiter, {folder:'a', task:'bc'} and {folder:'ab', task:'c'} would collide.
	const x = localJobId({ folder: "a", flow: "", task: "bc", minute: "m" });
	const y = localJobId({ folder: "ab", flow: "", task: "c", minute: "m" });
	assert.notEqual(x, y);
});

// deliveryJobId is pure -- runs everywhere. It is the exact-per-delivery dedup key for GitHub jobs
// (REQ-DEDUP-BY-DELIVERY-GUID): the X-GitHub-Delivery GUID, prefixed.

test("deliveryJobId prefixes the GUID -- a redelivery resolves to the same id", () => {
	assert.equal(deliveryJobId("abc"), "gh-abc");
});

test("deliveryJobId throws on a missing/empty GUID -- no random fallback that would defeat dedup", () => {
	assert.throws(() => deliveryJobId(""));
	assert.throws(() => deliveryJobId(undefined));
	assert.throws(() => deliveryJobId(null));
});

// chainedJobId is pure -- runs everywhere. It is the retry-idempotent dedup key for chained (outbox)
// child jobs (INT-OUTBOX-CONTRACT): parent id + content-hash(flow, task), with NO time component.

test("chainedJobId is deterministic and carries no time component -- a retry re-enqueues the same id", () => {
	const args = { parentJobId: "parent-1", flow: "tidy", task: "dedupe" };
	const a = chainedJobId(args);
	const b = chainedJobId(args); // a later collection (retry) of the same parent+request
	assert.equal(a, b, "same parent+flow+task -> same id regardless of when it is computed");
	assert.match(a, /^chain-[0-9a-f]{16}$/);
});

test("chainedJobId binds the parent -- two parents requesting the same flow+task do not collide", () => {
	const base = { flow: "tidy", task: "dedupe" };
	assert.notEqual(chainedJobId({ ...base, parentJobId: "parent-1" }), chainedJobId({ ...base, parentJobId: "parent-2" }));
});

test("chainedJobId changes when flow or task changes -- a genuinely different request is not swallowed", () => {
	const base = { parentJobId: "parent-1", flow: "tidy", task: "dedupe" };
	const id = chainedJobId(base);
	assert.notEqual(id, chainedJobId({ ...base, flow: "bug-fix" }));
	assert.notEqual(id, chainedJobId({ ...base, task: "other" }));
});

test("chainedJobId field separation is unambiguous -- concatenation collisions cannot occur", () => {
	// NUL-delimited so {parentJobId:'a', flow:'bc'} and {parentJobId:'ab', flow:'c'} cannot collide.
	const x = chainedJobId({ parentJobId: "a", flow: "bc", task: "" });
	const y = chainedJobId({ parentJobId: "ab", flow: "c", task: "" });
	assert.notEqual(x, y);
});

// enqueueLocalJob's chain passthrough, verified without a live Valkey: a fake queue captures the
// (name, data, opts) it hands to queue.add. A non-chained job must stay byte-identical to the base shape.
const NON_CHAINED_KEYS = ["kind", "folder", "flow", "task", "provider", "model", "maxTurns"];

test("enqueueLocalJob keeps a non-chained job byte-identical -- no chainDepth/parentJobId keys", async () => {
	const { enqueueLocalJob } = await import("../src/queue.mjs");
	let captured;
	const fakeQueue = { add: (name, data, opts) => ((captured = { name, data, opts }), { id: opts.jobId }) };

	const now = new Date("2026-07-16T12:00:00Z");
	const jobId = await enqueueLocalJob(fakeQueue, { folder: "/proj", flow: "tidy", task: "t", provider: "anthropic", model: "m", maxTurns: 5, now });

	assert.deepEqual(Object.keys(captured.data), NON_CHAINED_KEYS);
	assert.equal(jobId, localJobId({ folder: "/proj", flow: "tidy", task: "t", minute: "2026-07-16T12:00" }));
	assert.equal(captured.opts.jobId, jobId);
});

test("enqueueLocalJob puts chainDepth/parentJobId on data only when supplied", async () => {
	const { enqueueLocalJob } = await import("../src/queue.mjs");
	let captured;
	const fakeQueue = { add: (name, data, opts) => ((captured = { name, data, opts }), { id: opts.jobId }) };

	await enqueueLocalJob(fakeQueue, { folder: "/proj", flow: "tidy", task: "t", provider: "anthropic", model: "m", maxTurns: 5, chainDepth: 1, parentJobId: "parent-1", now: new Date("2026-07-16T12:00:00Z") });

	assert.equal(captured.data.chainDepth, 1);
	assert.equal(captured.data.parentJobId, "parent-1");
});

test("enqueueLocalJob uses an explicit jobId override instead of the computed localJobId", async () => {
	const { enqueueLocalJob } = await import("../src/queue.mjs");
	let captured;
	const fakeQueue = { add: (name, data, opts) => ((captured = { name, data, opts }), { id: opts.jobId }) };

	const override = chainedJobId({ parentJobId: "parent-1", flow: "tidy", task: "t" });
	const jobId = await enqueueLocalJob(fakeQueue, { folder: "/proj", flow: "tidy", task: "t", provider: "anthropic", model: "m", maxTurns: 5, jobId: override, now: new Date("2026-07-16T12:00:00Z") });

	assert.equal(jobId, override);
	assert.equal(captured.opts.jobId, override);
	assert.notEqual(captured.opts.jobId, localJobId({ folder: "/proj", flow: "tidy", task: "t", minute: "2026-07-16T12:00" }));
});

// The enqueue contract, verified without a live Valkey: a fake queue captures the (name, data, opts)
// that enqueueGitHubJob hands to queue.add. This asserts the money-path invariants -- exact-per-GUID
// jobId, the additive semantic dedup window, 31d retention, and the absence of a `sha` field.
test("enqueueGitHubJob builds the github data shape and dedup opts (fake queue captures add args)", async () => {
	const { enqueueGitHubJob } = await import("../src/queue.mjs");
	let captured;
	const fakeQueue = {
		add: (name, data, opts) => {
			captured = { name, data, opts };
			return { id: opts.jobId };
		},
	};

	// The full widened trigger of issue #49 — matched + comment ride along so the deepEqual below
	// proves enqueueGitHubJob passes the whole trigger through verbatim, adding and dropping nothing.
	const trigger = { event: "issues", action: "labeled", deliveryId: "guid-123", sender: { id: 42 }, matched: { index: 2, type: "label", label: "bug" }, comment: { body: "please fix the overflow", author_association: "MEMBER" } };
	const target = { type: "issue", number: 7, title: "Button is misaligned", body: "The submit button overflows on mobile" };
	const jobId = await enqueueGitHubJob(fakeQueue, {
		repo: "owner/repo",
		target,
		flow: "frontend-fix",
		trigger,
		provider: "anthropic",
		model: "m",
		maxTurns: 5,
	});

	assert.equal(jobId, "gh-guid-123");
	assert.equal(captured.name, "github");

	// Data shape: kind:"github", NO sha, target discriminator + trigger passed through verbatim.
	assert.equal(captured.data.kind, "github");
	assert.equal("sha" in captured.data, false, "no sha -- resolved fresh in prepare (C1)");
	assert.equal("issueNumber" in captured.data, false, "the flat issueNumber field is gone -- target carries the number");
	assert.equal(captured.data.repo, "owner/repo");
	assert.deepEqual(captured.data.target, target);
	assert.equal(captured.data.flow, "frontend-fix");
	assert.deepEqual(captured.data.trigger, trigger);

	// Opts: exact-per-delivery jobId + additive semantic window + 31d retention.
	assert.equal(captured.opts.jobId, `gh-${trigger.deliveryId}`);
	assert.equal(captured.opts.deduplication.id, "owner/repo#7:frontend-fix");
	assert.equal(captured.opts.deduplication.ttl, 10 * 60 * 1000);
	assert.ok(captured.opts.removeOnComplete.age >= 30 * 24 * 3600, "retention >= 30d");
	assert.ok(captured.opts.removeOnFail.age >= 30 * 24 * 3600, "fail retention >= 30d");
});

// The pi-packages opt-in (REQ-GLOBAL-PI-OVERLAY) rides the github path only: the receiver's filter resolves
// it from the matched triggers.json entry and hands it over on the job. It is CONDITIONAL, mirroring
// chainDepth/parentJobId -- an unflagged trigger's data must keep exactly the keys it has today, so the
// absence case asserts the key is not merely undefined but not present at all. The cron path never reaches
// enqueueLocalJob (schedules.mjs writes the scheduler data itself), so NON_CHAINED_KEYS above is unchanged.
test("enqueueGitHubJob puts packages on data only when supplied, and never on an unflagged job", async () => {
	const { enqueueGitHubJob } = await import("../src/queue.mjs");
	let captured;
	const fakeQueue = { add: (name, data, opts) => ((captured = { name, data, opts }), { id: opts.jobId }) };

	const base = {
		repo: "owner/repo",
		target: { type: "issue", number: 7, title: "t", body: "b" },
		flow: "frontend-fix",
		trigger: { event: "issues", action: "labeled", deliveryId: "guid-pkg", sender: { id: 42 }, matched: { index: 2, type: "label", label: "bug" } },
		provider: "anthropic",
		model: "m",
		maxTurns: 5,
	};

	await enqueueGitHubJob(fakeQueue, { ...base, packages: true });
	assert.equal(captured.data.packages, true);
	assert.equal("packages" in captured.data.trigger, false, "an execution knob must not leak into the descriptive trigger");

	await enqueueGitHubJob(fakeQueue, { ...base, packages: false });
	assert.equal(captured.data.packages, false, "an explicit opt-out is carried, never coerced away");

	await enqueueGitHubJob(fakeQueue, base);
	assert.equal("packages" in captured.data, false, "an unflagged job's data keeps exactly today's keys");
	assert.deepEqual(Object.keys(captured.data), ["kind", "repo", "target", "flow", "trigger", "provider", "model", "maxTurns"]);
});

// The per-trigger job image (issue #41) rides BOTH paths, and on both it is CONDITIONAL for the same reason
// packages is: an unflagged trigger's data must keep exactly the keys it has today.
test("enqueueLocalJob puts image on data only when supplied", async () => {
	const { enqueueLocalJob } = await import("../src/queue.mjs");
	let captured;
	const fakeQueue = { add: (name, data, opts) => ((captured = { name, data, opts }), { id: opts.jobId }) };
	const base = { folder: "/proj", flow: "tidy", task: "t", provider: "anthropic", model: "m", maxTurns: 5, now: new Date("2026-07-16T12:00:00Z") };

	await enqueueLocalJob(fakeQueue, { ...base, image: "my-python:1.2.0" });
	assert.equal(captured.data.image, "my-python:1.2.0");

	await enqueueLocalJob(fakeQueue, base);
	assert.equal("image" in captured.data, false, "an imageless job's data keeps exactly today's keys");
	assert.deepEqual(Object.keys(captured.data), NON_CHAINED_KEYS);
});

test("enqueueGitHubJob puts image on data only when supplied, and never inside the descriptive trigger", async () => {
	const { enqueueGitHubJob } = await import("../src/queue.mjs");
	let captured;
	const fakeQueue = { add: (name, data, opts) => ((captured = { name, data, opts }), { id: opts.jobId }) };

	const base = {
		repo: "owner/repo",
		target: { type: "issue", number: 7, title: "t", body: "b" },
		flow: "frontend-fix",
		trigger: { event: "issues", action: "labeled", deliveryId: "guid-img", sender: { id: 42 }, matched: { index: 2, type: "label", label: "bug" } },
		provider: "anthropic",
		model: "m",
		maxTurns: 5,
	};

	await enqueueGitHubJob(fakeQueue, { ...base, image: "node-playwright:1.4.0" });
	assert.equal(captured.data.image, "node-playwright:1.4.0");
	assert.equal("image" in captured.data.trigger, false, "trigger is copied verbatim into /job/event.json -- an execution knob has no business there");

	await enqueueGitHubJob(fakeQueue, base);
	assert.equal("image" in captured.data, false);
	assert.deepEqual(Object.keys(captured.data), ["kind", "repo", "target", "flow", "trigger", "provider", "model", "maxTurns"]);
});

// --- run.command (issue #189): the command rides job data, and both dedup keys stay collision-free ---

test("enqueueLocalJob: a command named X and a flow named X on the same folder produce DIFFERENT ids", async () => {
	// The command fills the flow slot of the dedup key as `cmd:<command>` -- without the prefix a
	// command X would hash identically to a bare flow X and one would silently swallow the other within
	// the minute window. `:` is outside the skill-name charset, so no real flow can spell the prefixed form.
	const { enqueueLocalJob } = await import("../src/queue.mjs");
	const seen = [];
	const fakeQueue = { add: (name, data, opts) => (seen.push({ data, opts }), { id: opts.jobId }) };
	const now = new Date("2026-07-16T12:00:00Z");

	const cmdId = await enqueueLocalJob(fakeQueue, { folder: "/proj", command: "wf", provider: "anthropic", model: "m", maxTurns: 5, now });
	const flowId = await enqueueLocalJob(fakeQueue, { folder: "/proj", flow: "wf", provider: "anthropic", model: "m", maxTurns: 5, now });
	assert.notEqual(cmdId, flowId, "a command must never coalesce against a flow spelling the same name");

	// And two DIFFERENT commands on one folder in one minute are two jobs, not one.
	const otherId = await enqueueLocalJob(fakeQueue, { folder: "/proj", command: "wf nightly", provider: "anthropic", model: "m", maxTurns: 5, now });
	assert.notEqual(cmdId, otherId);
	assert.equal(seen[0].data.command, "wf", "the command rides job data");
});

test("enqueueLocalJob puts command on data only when supplied -- a commandless job keeps exactly today's keys", async () => {
	const { enqueueLocalJob } = await import("../src/queue.mjs");
	let captured;
	const fakeQueue = { add: (name, data, opts) => ((captured = { name, data, opts }), { id: opts.jobId }) };
	const base = { folder: "/proj", flow: "tidy", task: "t", provider: "anthropic", model: "m", maxTurns: 5, now: new Date("2026-07-16T12:00:00Z") };

	await enqueueLocalJob(fakeQueue, base);
	assert.equal("command" in captured.data, false, "a flow job's data is byte-identical to before the feature");
	assert.deepEqual(Object.keys(captured.data), NON_CHAINED_KEYS);

	await enqueueLocalJob(fakeQueue, { ...base, flow: undefined, task: undefined, command: "wf run" });
	assert.equal(captured.data.command, "wf run");
});

test("enqueueForgeJob: the dedup key's flow slot becomes cmd:<command> -- command X and flow X never coalesce", async () => {
	const { enqueueGitHubJob } = await import("../src/queue.mjs");
	const seen = [];
	const fakeQueue = { add: (name, data, opts) => (seen.push({ data, opts }), { id: opts.jobId }) };
	const base = {
		repo: "owner/repo",
		target: { type: "issue", number: 7, title: "t", body: "b" },
		provider: "anthropic",
		model: "m",
		maxTurns: 5,
	};

	await enqueueGitHubJob(fakeQueue, { ...base, command: "wf", trigger: { event: "issues", action: "labeled", deliveryId: "guid-cmd", sender: { id: 1 } } });
	await enqueueGitHubJob(fakeQueue, { ...base, flow: "wf", trigger: { event: "issues", action: "labeled", deliveryId: "guid-flow", sender: { id: 1 } } });

	// The `cmd:` prefix is the whole point: without it both keys would read `owner/repo#7:wf` and the
	// second delivery would coalesce into the first's 10-minute window and never run.
	assert.equal(seen[0].opts.deduplication.id, "owner/repo#7:cmd:wf");
	assert.equal(seen[1].opts.deduplication.id, "owner/repo#7:wf");
	assert.notEqual(seen[0].opts.deduplication.id, seen[1].opts.deduplication.id);

	assert.equal(seen[0].data.command, "wf", "the command rides job data");
	assert.equal("command" in seen[0].data.trigger, false, "an execution knob must not leak into the descriptive trigger");
	assert.equal("command" in seen[1].data, false, "a flow job's data keeps exactly today's keys");
});

// Integration against a real Valkey. Runs when VALKEY_TEST_URL is set (CI provides a service).
const url = process.env.VALKEY_TEST_URL;
const skip = url ? false : "VALKEY_TEST_URL not set; the queue integration test needs a Valkey";

test("enqueue + dedup against a real Valkey", { skip }, async () => {
	const { parseConnection } = await import("../src/connection.mjs");
	const { makeQueue, enqueueLocalJob } = await import("../src/queue.mjs");
	const q = makeQueue(parseConnection(url));
	try {
		await q.obliterate({ force: true }).catch(() => {});
		const now = new Date("2026-07-16T12:00:00Z");
		const args = { folder: "/proj", flow: "tidy", task: "t", provider: "anthropic", model: "m", maxTurns: 5, now };
		const id1 = await enqueueLocalJob(q, args);
		const id2 = await enqueueLocalJob(q, args); // same -> dedup
		assert.equal(id1, id2);
		const counts = await q.getJobCounts("waiting");
		assert.equal(counts.waiting, 1, "the duplicate must be ignored");
		const job = await q.getJob(id1);
		assert.equal(job.data.kind, "local");
		assert.equal(job.data.folder, "/proj");
	} finally {
		await q.close();
	}
});

// A uniquely-named queue per run so parallel/repeated Valkey tests cannot see each other's jobs.
async function freshGitHubQueue() {
	const { Queue } = await import("bullmq");
	const { parseConnection } = await import("../src/connection.mjs");
	const name = `pi-jobs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	return new Queue(name, { connection: parseConnection(url) });
}

test("same delivery GUID twice -> one job (exact redelivery dedup)", { skip }, async () => {
	const { enqueueGitHubJob } = await import("../src/queue.mjs");
	const q = await freshGitHubQueue();
	try {
		const base = { repo: "owner/repo", target: { type: "issue", number: 7, title: "t", body: "b" }, flow: "frontend-fix", provider: "anthropic", model: "m", maxTurns: 5 };
		const trigger = { event: "issues", action: "labeled", deliveryId: "guid-same", sender: { id: 1 } };
		const id1 = await enqueueGitHubJob(q, { ...base, trigger });
		const id2 = await enqueueGitHubJob(q, { ...base, trigger }); // redelivery -> same jobId
		assert.equal(id1, id2);
		const counts = await q.getJobCounts("waiting");
		assert.equal(counts.waiting, 1, "the redelivery must be ignored");
		const job = await q.getJob(id1);
		assert.equal(job.data.kind, "github");
		assert.equal("sha" in job.data, false);
	} finally {
		await q.obliterate({ force: true }).catch(() => {});
		await q.close();
	}
});

test("two different GUIDs on distinct issues -> two jobs", { skip }, async () => {
	const { enqueueGitHubJob } = await import("../src/queue.mjs");
	const q = await freshGitHubQueue();
	try {
		const base = { repo: "owner/repo", flow: "frontend-fix", provider: "anthropic", model: "m", maxTurns: 5 };
		const id1 = await enqueueGitHubJob(q, { ...base, target: { type: "issue", number: 1, title: "t", body: "b" }, trigger: { event: "issues", action: "labeled", deliveryId: "guid-a", sender: { id: 1 } } });
		const id2 = await enqueueGitHubJob(q, { ...base, target: { type: "issue", number: 2, title: "t", body: "b" }, trigger: { event: "issues", action: "labeled", deliveryId: "guid-b", sender: { id: 1 } } });
		assert.notEqual(id1, id2);
		const counts = await q.getJobCounts("waiting");
		assert.equal(counts.waiting, 2, "distinct deliveries on distinct issues are distinct jobs");
	} finally {
		await q.obliterate({ force: true }).catch(() => {});
		await q.close();
	}
});

test("two different GUIDs, same repo#issue:flow within the window -> one active (semantic coalescing)", { skip }, async () => {
	const { enqueueGitHubJob } = await import("../src/queue.mjs");
	const q = await freshGitHubQueue();
	try {
		const base = { repo: "owner/repo", target: { type: "issue", number: 7, title: "t", body: "b" }, flow: "frontend-fix", provider: "anthropic", model: "m", maxTurns: 5 };
		const id1 = await enqueueGitHubJob(q, { ...base, trigger: { event: "issues", action: "labeled", deliveryId: "guid-x", sender: { id: 1 } } });
		const id2 = await enqueueGitHubJob(q, { ...base, trigger: { event: "issues", action: "labeled", deliveryId: "guid-y", sender: { id: 1 } } });
		assert.notEqual(id1, id2, "distinct GUIDs -> distinct jobIds");
		const counts = await q.getJobCounts("waiting");
		assert.equal(counts.waiting, 1, "a rapid re-label coalesces within the semantic window");
	} finally {
		await q.obliterate({ force: true }).catch(() => {});
		await q.close();
	}
});

// --- replica runs: two distinct ids on BOTH dedup layers (REQ-REPLICA-RUNS) ---

test("two replicas of one delivery get two jobIds and two dedup ids, and neither suppresses the other", async () => {
	const { enqueueGitHubJob } = await import("../src/queue.mjs");
	const seen = [];
	const fakeQueue = { add: (name, data, opts) => (seen.push({ data, opts }), { id: opts.jobId }) };
	const base = {
		repo: "owner/repo",
		target: { type: "issue", number: 7, title: "t", body: "b" },
		flow: "frontend-fix",
		trigger: { event: "issues", action: "labeled", deliveryId: "guid-rep", sender: { id: 42 } },
		replicas: 2,
	};

	await enqueueGitHubJob(fakeQueue, { ...base, replica: 1 });
	await enqueueGitHubJob(fakeQueue, { ...base, replica: 2 });

	// Layer one: BullMQ's `EXISTS jobId`. Identical ids would make the second enqueue vanish SILENTLY --
	// duplicate `queue.add` is ignored, not rejected -- so the whole feature would fail with no error.
	assert.deepEqual(seen.map((s) => s.opts.jobId), ["gh-guid-rep-r1", "gh-guid-rep-r2"]);
	// Layer two: the semantic window. Distinct jobIds alone are not enough -- `repo#7:flow` is identical for
	// both replicas, so within the 10-minute TTL the second would coalesce into the first regardless.
	assert.deepEqual(seen.map((s) => s.opts.deduplication.id), ["owner/repo#7:frontend-fix:r1", "owner/repo#7:frontend-fix:r2"]);
	assert.deepEqual(seen.map((s) => s.data.replica), [1, 2]);
	assert.deepEqual(seen.map((s) => s.data.replicas), [2, 2]);
	assert.equal("replica" in seen[0].data.trigger, false, "an execution knob must not leak into the descriptive trigger");
});

test("every forge suffixes BOTH dedup layers, and the pull-request separator rides the semantic key (#187)", async () => {
	// The github test above proves the mechanism; this proves it is not a github mechanism. Two things are
	// forge-specific and both are exercised here: the jobId PREFIX comes from the forge table, and the
	// semantic key's TARGET SEPARATOR does too -- `!` where a forge numbers merge/pull requests in their own
	// sequence, `#` where one sequence serves both. A replica suffix that landed before the separator, or a
	// forge whose prefix was forgotten, would still produce two distinct strings and pass a weaker test.
	const { enqueueForgeJob } = await import("../src/queue.mjs");
	const cases = [
		{ kind: "gitlab", prefix: "gl-", target: { type: "issue", number: 7, title: "t", body: "b" }, key: "owner/repo#7:fix" },
		{ kind: "gitlab", prefix: "gl-", target: { type: "pull_request", number: 5, title: "t", body: "b" }, key: "owner/repo!5:fix" },
		{ kind: "forgejo", prefix: "fj-", target: { type: "pull_request", number: 5, title: "t", body: "b" }, key: "owner/repo#5:fix" },
		{ kind: "azure", prefix: "az-", target: { type: "pull_request", number: 5, title: "t", body: "b" }, key: "owner/repo!5:fix" },
	];

	for (const { kind, prefix, target, key } of cases) {
		const seen = [];
		const fakeQueue = { add: (name, data, opts) => (seen.push({ data, opts }), { id: opts.jobId }) };
		const base = { repo: "owner/repo", projectId: 11, target, flow: "fix", trigger: { deliveryId: "d1", sender: { id: 42 } }, replicas: 2 };

		await enqueueForgeJob(fakeQueue, kind, { ...base, replica: 1 });
		await enqueueForgeJob(fakeQueue, kind, { ...base, replica: 2 });

		assert.deepEqual(seen.map((x) => x.opts.jobId), [`${prefix}d1-r1`, `${prefix}d1-r2`], `${kind} ${target.type} jobIds`);
		assert.deepEqual(seen.map((x) => x.opts.deduplication.id), [`${key}:r1`, `${key}:r2`], `${kind} ${target.type} dedup ids`);
		assert.deepEqual(seen.map((x) => x.data.replica), [1, 2], `${kind} ${target.type} replica indices`);
		assert.deepEqual(seen.map((x) => x.data.replicas), [2, 2], `${kind} ${target.type} set size`);
		assert.equal("replica" in seen[0].data.trigger, false, `${kind}: an execution knob must not leak into the trigger`);
	}
});

test("an unflagged forge job on every kind carries NO replica keys -- byte-identical to before the feature", async () => {
	// The other half of the guarantee, and the one a fanout bug breaks silently: spread `replica` in
	// unconditionally and every ordinary job on that forge changes shape, jobId and dedup id at once.
	const { enqueueForgeJob } = await import("../src/queue.mjs");
	for (const kind of ["gitlab", "forgejo", "azure"]) {
		const seen = [];
		const fakeQueue = { add: (name, data, opts) => (seen.push({ data, opts }), { id: opts.jobId }) };
		await enqueueForgeJob(fakeQueue, kind, {
			repo: "owner/repo",
			target: { type: "issue", number: 7, title: "t", body: "b" },
			flow: "fix",
			trigger: { deliveryId: "d1", sender: { id: 42 } },
		});
		assert.equal("replica" in seen[0].data, false, `${kind} must emit no replica key`);
		assert.equal("replicas" in seen[0].data, false, `${kind} must emit no replicas key`);
		assert.equal(seen[0].opts.jobId.endsWith("-r1"), false, `${kind} jobId must not gain a suffix`);
		assert.equal(seen[0].opts.deduplication.id, "owner/repo#7:fix", `${kind} dedup id must be the pre-feature string`);
	}
});

test("a REDELIVERY of one replica still coalesces -- the window dedups re-deliveries, never the replicas", async () => {
	const { enqueueGitHubJob } = await import("../src/queue.mjs");
	const seen = [];
	const fakeQueue = { add: (name, data, opts) => (seen.push(opts), { id: opts.jobId }) };
	const job = {
		repo: "owner/repo",
		target: { type: "issue", number: 7 },
		flow: "fix",
		trigger: { deliveryId: "guid-x" },
		replica: 2,
		replicas: 2,
	};
	await enqueueGitHubJob(fakeQueue, job);
	await enqueueGitHubJob(fakeQueue, job);
	assert.equal(seen[0].jobId, seen[1].jobId, "the same delivery, same replica, resolves the same id -- BullMQ rejects the second");
	assert.equal(seen[0].deduplication.id, seen[1].deduplication.id);
});

test("an unflagged job's data keys and dedup id are byte-identical to before the feature", async () => {
	const { enqueueGitHubJob } = await import("../src/queue.mjs");
	let captured;
	const fakeQueue = { add: (name, data, opts) => ((captured = { data, opts }), { id: opts.jobId }) };
	await enqueueGitHubJob(fakeQueue, {
		repo: "owner/repo",
		target: { type: "issue", number: 7, title: "t", body: "b" },
		flow: "frontend-fix",
		trigger: { event: "issues", action: "labeled", deliveryId: "guid-plain", sender: { id: 42 } },
		provider: "anthropic",
		model: "m",
		maxTurns: 5,
	});
	assert.deepEqual(Object.keys(captured.data), ["kind", "repo", "target", "flow", "trigger", "provider", "model", "maxTurns"]);
	assert.equal(captured.opts.jobId, "gh-guid-plain", "no -r suffix on a job that carries no replica");
	assert.equal(captured.opts.deduplication.id, "owner/repo#7:frontend-fix", "no :r suffix either");
});

test("secrets and secretsProfile ride a forge job's data, and an unflagged job's keys are unchanged (#225)", async () => {
	// The Object.keys pins above are the byte-identity guarantee; this is its other half. Conditional
	// spreads mean an unflagged job grows neither key, so those deepEquals stay valid untouched.
	const { enqueueGitHubJob } = await import("../src/queue.mjs");
	const cap = (q) => ({ add: (name, data, opts) => ((q.got = { name, data, opts }), { id: opts.jobId }) });
	const trigger = { event: "issues", action: "labeled", deliveryId: "guid-secrets", sender: { id: 42 } };
	const target = { type: "issue", number: 7, title: "T", body: "B" };

	const armed = {};
	await enqueueGitHubJob(cap(armed), { repo: "owner/repo", target, flow: "deploy", trigger, secrets: { STRIPE_KEY: "op://ci/stripe/api-key" }, secretsProfile: "prod" });
	assert.deepEqual(armed.got.data.secrets, { STRIPE_KEY: "op://ci/stripe/api-key" });
	assert.equal(armed.got.data.secretsProfile, "prod");
	// A REFERENCE reached the queue, never a value. Job data is durable in Redis, so a resolved credential
	// here would outlive by days the container it was scoped to -- which is why the worker resolves at job
	// start and the receiver, which holds no manager credential at all, never can.
	assert.equal(armed.got.data.secrets.STRIPE_KEY.startsWith("op://"), true);

	const plain = {};
	await enqueueGitHubJob(cap(plain), { repo: "owner/repo", target, flow: "deploy", trigger });
	assert.equal("secrets" in plain.got.data, false);
	assert.equal("secretsProfile" in plain.got.data, false);
});

test("a local (cron) job may carry secrets too -- unlike replicas, which a local job is refused (#225)", async () => {
	const { enqueueLocalJob } = await import("../src/queue.mjs");
	let captured;
	const fakeQueue = { add: (name, data, opts) => ((captured = { name, data, opts }), { id: opts.jobId }) };
	await enqueueLocalJob(fakeQueue, { folder: "/srv/site", flow: "deploy", task: "ship", secrets: { DEPLOY_KEY: "op://ci/deploy/key" }, secretsProfile: "prod" });
	assert.deepEqual(captured.data.secrets, { DEPLOY_KEY: "op://ci/deploy/key" });
	assert.equal(captured.data.secretsProfile, "prod");
});
