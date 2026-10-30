import assert from "node:assert/strict";
import { test } from "node:test";
import { CONSOLE_TRAIL_CLAIM_MS, runJob } from "../src/processor.mjs";
import { forgeDeliveryJobId } from "../src/job-id.mjs";
import { effectiveJobOf } from "../src/index.mjs";
import { resolveSettings } from "../src/runtime-settings.mjs";
import { enqueueForgeJob } from "../src/queue.mjs";
import { ANSWER_TEXT_MAX_BYTES, answerTrailComment, boundAnswerText, consoleAnswerBy, scrubAnswerText } from "../src/console-answer.mjs";
import { estimateReserve } from "../src/reserve-estimate.mjs";

// Issue #642: an answer typed into the operator console. The worker posts ONE trail comment for it, after the
// `not-parked` gate and before any spend; the queue carries who answered and nothing else; and the console's reserve
// estimate is the worker's own hold for the same job.

const USD = 1_000_000;
const NOW = new Date("2026-10-15T12:00:00Z");

/** Every command in order, so a test can say what happened BEFORE the trail comment. */
function deps(overrides = {}) {
	const calls = [];
	const logs = [];
	const store = new Map();
	const redis = {
		async incr(k) {
			calls.push(`incr:${k}`);
			store.set(k, (store.get(k) ?? 0) + 1);
			return store.get(k);
		},
		async decr(k) {
			store.set(k, (store.get(k) ?? 0) - 1);
			return store.get(k);
		},
		async incrby(k, n) {
			calls.push(`incrby:${k}:${n}`);
			store.set(k, (store.get(k) ?? 0) + n);
			return store.get(k);
		},
		async decrby(k, n) {
			store.set(k, (store.get(k) ?? 0) - n);
			return store.get(k);
		},
		async eval() {
			return [1, 0];
		},
		async expire() {},
		async get() {
			return null;
		},
		// SET with NX and PX as ioredis takes it (the trail claim): "OK" when the key was absent, else null.
		async set(k, v, ...opts) {
			calls.push(`set:${k}:${opts.join(":")}`);
			if (opts.includes("NX") && store.has(k)) return null;
			store.set(k, v);
			return "OK";
		},
	};
	const base = {
		redis,
		caps: { day: 10, week: null, month: null },
		softHoldPct: null,
		isParked: () => true,
		parkedLabel: async () => {},
		sessionsDir: "/srv/pi-sessions",
		imagePreflight: async () => ({ ok: true, piVersion: "0.80.7" }),
		mintToken: async () => (calls.push("mint"), "tok"),
		isDefaultBranchProtected: async () => (calls.push("branch-check"), true),
		prepareWorkspace: async () => (calls.push("prepare"), { workspaceDir: "/w", jobDir: "/j" }),
		runContainer: async () => (calls.push("run-container"), { code: 0, aborted: false }),
		collectChain: async () => ({ enqueued: 0, refused: 0 }),
		cleanup: async () => {},
		comment: async (_j, t) => calls.push(`comment:${t}`),
		log: (event, fields) => logs.push([event, fields]),
		now: NOW,
	};
	return { deps: { ...base, ...overrides }, calls, logs, store };
}

const answer = (body, by = "alice") => ({ kind: "github", repo: "org/repo", provider: "anthropic", model: "m", maxTurns: 20, target: { type: "issue", number: 7 }, resume: true, parkedReply: true, console: { by }, trigger: { event: "issue_comment", action: "created", deliveryId: "console-ab", sender: { id: null }, matched: { index: 0, type: "comment", phrase: "@pi" }, comment: { body, author_association: "OWNER" } } });

test("a console answer posts exactly one trail comment, after every gate and reserve and just before the container", async () => {
	const { deps: d, calls } = deps();
	const r = await runJob(answer("use the staging database\n\nthen rerun"), d);
	assert.equal(r.outcome, "completed");
	const comments = calls.filter((c) => c.startsWith("comment:"));
	assert.deepEqual(comments, ["comment:Answered from the operator console by alice:\n\n> use the staging database\n> \n> then rerun"]);
	const at = calls.indexOf(comments[0]);
	assert.ok(calls.indexOf("mint") < at, "after the mint");
	assert.ok(calls.findIndex((c) => c.startsWith("incr:")) < at, "after the job-count reserve");
	assert.ok(calls.indexOf("prepare") < at, "after the clone");
	assert.equal(calls.indexOf("run-container"), at + 1, "and the very next step is the container");
});

test("the trail is posted once per job: a second run of the same job (an InfraRetry's second attempt, a console retry) posts none", async () => {
	const { deps: d, calls, logs, store } = deps();
	const job = answer("use the staging database");
	await runJob(job, d);
	await runJob(job, d);
	assert.equal(calls.filter((c) => c.startsWith("comment:Answered")).length, 1, "one trail across both runs");
	assert.equal(calls.filter((c) => c === "run-container").length, 2, "the job itself still runs again");
	assert.ok(calls.includes(`set:console:trail:${forgeDeliveryJobId("github", "console-ab")}:PX:${CONSOLE_TRAIL_CLAIM_MS}:NX`), "claimed under the queue's own job id, for 31 days, only if absent");
	assert.equal(CONSOLE_TRAIL_CLAIM_MS, 31 * 24 * 60 * 60 * 1000);
	assert.equal(store.get(`console:trail:${forgeDeliveryJobId("github", "console-ab")}`), "1");
	assert.deepEqual(logs.find((l) => l[0] === "console_trail_skipped"), ["console_trail_skipped", { kind: "github", reason: "already-posted" }]);
	// Another answer (its own delivery id, so its own job id) posts its own trail.
	await runJob({ ...job, trigger: { ...job.trigger, deliveryId: "console-cd" } }, d);
	assert.equal(calls.filter((c) => c.startsWith("comment:Answered")).length, 2);
});

test("a Valkey error on the trail claim skips the trail (at most once), logs it by kind, and never fails the job", async () => {
	const { deps: d, calls, logs } = deps();
	d.redis.set = async () => {
		throw Object.assign(new Error("down"), { code: "ECONNREFUSED" });
	};
	const r = await runJob(answer("hello"), d);
	assert.equal(r.outcome, "completed");
	assert.equal(calls.some((c) => c.startsWith("comment:Answered")), false);
	assert.deepEqual(logs.find((l) => l[0] === "console_trail_skipped"), ["console_trail_skipped", { kind: "github", reason: "valkey-error", code: "ECONNREFUSED" }]);
	// A job whose id cannot be derived (no delivery id: a hand-built entry) posts nothing either.
	const noId = deps();
	const job = answer("hello");
	await runJob({ ...job, trigger: { ...job.trigger, deliveryId: undefined } }, noId.deps);
	assert.equal(noId.calls.some((c) => c.startsWith("comment:Answered")), false);
	assert.deepEqual(noId.logs.find((l) => l[0] === "console_trail_skipped"), ["console_trail_skipped", { kind: "github", reason: "no-job-id" }]);
});

test("a console answer refused by a later pre-spend gate posts no trail: the issue never reads answered above a refusal", async () => {
	const { deps: d, calls } = deps({ sessionsDir: undefined });
	const r = await runJob(answer("hello"), d);
	assert.equal(r.reason, "sessions-dir-unset");
	assert.equal(calls.filter((c) => c.startsWith("comment:Answered")).length, 0);
	assert.equal(calls.includes("run-container"), false);
});

test("refused as not-parked: no trail comment at all (the stale marker is cleared as for any reply)", async () => {
	const { deps: d, calls } = deps({ isParked: () => false });
	const r = await runJob(answer("hello"), d);
	assert.equal(r.reason, "not-parked");
	assert.deepEqual(calls, [], "nothing posted, nothing minted, nothing reserved");
});

test("the trail neutralises mentions and never echoes a control or bidi character; the name needs no escaping", async () => {
	const { deps: d, calls } = deps();
	await runJob(answer("ping @octo-org/team and @alice\u0007\u001b[2J\r\nnext\u202eline\u0085"), d);
	const trail = calls.find((c) => c.startsWith("comment:")).slice("comment:".length);
	assert.equal(trail, "Answered from the operator console by alice:\n\n> ping @\u200bocto-org/team and @\u200balice[2J\n> nextline");
	assert.doesNotMatch(trail, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/);
	assert.doesNotMatch(trail, /@(?!\u200b)/, "every @ is followed by the zero-width space");
});

test("a console field whose name is not a console token's posts nothing and is logged by kind only; a forge reply posts no trail", async () => {
	const bad = deps();
	await runJob(answer("hi", "@everyone"), bad.deps);
	assert.equal(bad.calls.some((c) => c.startsWith("comment:")), false);
	assert.deepEqual(bad.logs.find((l) => l[0] === "console_answer_by_invalid"), ["console_answer_by_invalid", { kind: "github" }]);
	const forge = deps();
	const { console: _drop, ...plain } = answer("hi");
	await runJob(plain, forge.deps);
	assert.equal(forge.calls.some((c) => c.startsWith("comment:")), false, "a reply typed on the forge already has its own comment there");
	// And a console field on a job that is not a parked reply is not an answer: no trail.
	const notReply = deps();
	await runJob({ ...answer("hi"), parkedReply: undefined }, notReply.deps);
	assert.equal(notReply.calls.some((c) => c.startsWith("comment:")), false);
});

test("enqueueForgeJob carries `console` as { by } only, at job level, and refuses a name outside the token charset", async () => {
	const added = [];
	const queue = { add: async (name, data, opts) => (added.push({ name, data, opts }), { id: opts.jobId }) };
	const fields = { repo: "org/repo", target: { type: "issue", number: 7 }, flow: "fix", trigger: { deliveryId: "console-ab", comment: { body: "x" } }, parkedReply: true };
	await enqueueForgeJob(queue, "github", { ...fields, console: { by: "alice", extra: "dropped" } });
	assert.deepEqual(added[0].data.console, { by: "alice" }, "rebuilt from the one field");
	assert.equal("console" in added[0].data.trigger, false, "never inside trigger, which reaches /job/event.json");
	await enqueueForgeJob(queue, "github", fields);
	assert.equal("console" in added[1].data, false, "absent stays absent: a receiver job's data is byte-identical");
	for (const by of ["Alice", "a b", "@x", "", "x".repeat(33), 7]) {
		await assert.rejects(enqueueForgeJob(queue, "github", { ...fields, console: { by } }), /console\.by must be a console token name/, JSON.stringify(by));
	}
	assert.equal(added.length, 2, "a refused name queues nothing");
});

test("the answer bound: scrubbed first, refused when empty or above 8 KiB, never cut", () => {
	assert.equal(scrubAnswerText("a\r\nb\u2028c\td\u0000"), "a\nb\nc d");
	assert.equal(scrubAnswerText(7), "");
	assert.match(boundAnswerText(" \u0000\n\t ").refusal, /empty/);
	assert.deepEqual(boundAnswerText("x".repeat(ANSWER_TEXT_MAX_BYTES)), { text: "x".repeat(ANSWER_TEXT_MAX_BYTES) });
	assert.match(boundAnswerText("\u00e9".repeat(ANSWER_TEXT_MAX_BYTES / 2 + 1)).refusal, /8194 bytes, above the 8192-byte limit/);
	assert.equal(consoleAnswerBy({ by: "ops.rob-1" }), "ops.rob-1");
	assert.equal(consoleAnswerBy(undefined), null);
	assert.equal(answerTrailComment("b", "one"), "Answered from the operator console by b:\n\n> one");
});

// ---- the reserve estimate is the worker's hold ----

/** What the worker holds in its day dollar window for `data` under `overlay`/`env`: the real effectiveJobOf + runJob. */
async function workerHold(data, { overlay = {}, env = {}, modelEndpoints = null } = {}) {
	const settings = resolveSettings({ provider: env.PI_PROVIDER ?? "anthropic", model: env.PI_MODEL ?? "claude-sonnet-5-5", maxTurns: 20, maxCostUsd: env.PI_MAX_COST_USD ?? null, dailyCostUsd: null, weeklyCostUsd: null, monthlyCostUsd: null }, { overlay });
	const job = effectiveJobOf(data, settings, null);
	const { deps: d, calls } = deps({ dollarCaps: { day: 100 * USD, week: null, month: null }, modelEndpoints });
	const r = await runJob(job, d);
	assert.equal(r.outcome, "completed");
	const reserve = calls.find((c) => c.startsWith("incrby:budget:usd:"));
	return reserve ? Number(reserve.split(":").pop()) : 0;
}

test("estimateReserve equals what the worker holds for the same job: trigger narrowing, overlay over env, zero-rated", async () => {
	const forge = { kind: "github", repo: "org/repo", target: { type: "issue", number: 7 }, flow: "fix" };
	for (const [what, data, opts, micros] of [
		["the deployment cap from env", forge, { env: { PI_MAX_COST_USD: "2" } }, 2 * USD],
		["the overlay outranks env", forge, { overlay: { maxCostUsd: "3" }, env: { PI_MAX_COST_USD: "2" } }, 3 * USD],
		["a trigger cap narrows", { ...forge, maxCostUsd: "1.25" }, { env: { PI_MAX_COST_USD: "2" } }, 1_250_000],
		["a trigger cap cannot widen", { ...forge, maxCostUsd: "9" }, { env: { PI_MAX_COST_USD: "2" } }, 2 * USD],
	]) {
		const est = estimateReserve(data, opts);
		assert.deepEqual(est, { slots: 1, dollarsMicros: micros, capMicros: micros, zeroRated: false }, what);
		assert.equal(await workerHold(data, opts), est.dollarsMicros, `${what}: the worker holds the same`);
	}
	// Zero-rated: every callable model on a declared endpoint at zero cost. The worker holds nothing, and so says the estimate.
	const modelEndpoints = { endpoints: [{ id: "mac-ollama", host: "host.docker.internal", port: 11434, slots: 2, keyless: true }], models: { providers: { "local-ollama": { api: "openai-completions", baseUrl: "http://host.docker.internal:11434/v1", apiKey: "$PI_DISPATCH_KEYLESS", models: [{ id: "q" }] } } } };
	const local = { ...forge, provider: "local-ollama", model: "q" };
	const zero = estimateReserve(local, { env: { PI_MAX_COST_USD: "2" }, modelEndpoints });
	assert.deepEqual(zero, { slots: 1, dollarsMicros: 0, capMicros: 2 * USD, zeroRated: true });
	assert.equal(await workerHold(local, { env: { PI_MAX_COST_USD: "2" }, modelEndpoints }), 0);
	// Without the endpoint snapshot the estimate fails closed to the cap: never smaller than what the worker holds.
	assert.equal(estimateReserve(local, { env: { PI_MAX_COST_USD: "2" } }).dollarsMicros, 2 * USD);
	// No cap anywhere: nothing to hold, and the estimate says so rather than inventing a figure.
	assert.deepEqual(estimateReserve(forge, { env: {} }), { slots: 1, dollarsMicros: null, capMicros: null, zeroRated: false });
	assert.match(estimateReserve(forge, { overlay: { maxCostUsd: "1e3" } }).invalid, /maxCostUsd must be a dollar amount/);
});

test("human touch lineage names the exact park only after the runner proves a resume, using receipt time", async () => {
	const parkedAt = NOW.getTime() - 6 * 3600_000;
	const receivedAt = parkedAt + 3600_000;
	const writes = [];
	const { deps: d } = deps({
		readParkedInfo: () => ({ runId: "replaced-before-prepare", at: parkedAt - 1000 }), replyReceivedAt: receivedAt,
		prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j", session: { parkedSource: { runId: "original-park", at: parkedAt } } }),
		recordTouch: async (fact) => writes.push(fact), runContainer: async () => ({ code: 0, session: { resumed: true, reason: "resumed" } }),
	});
	const result = await runJob(answer("private answer"), d);
	assert.equal(result.outcome, "completed");
	assert.equal(writes.length, 1);
	assert.equal(writes[0].runId, "original-park");
	assert.equal(writes[0].at, receivedAt, "queue delay after receipt is not human waiting");
	assert.equal(writes[0].answerSource, "console");
	assert.deepEqual(result.touches, writes, "record fallback survives an index publication failure");
	assert.ok(!JSON.stringify(writes).includes("private answer"));
	for (const resumed of [false, undefined]) {
		writes.length = 0;
		d.runContainer = async () => ({ code: 0, session: { resumed } });
		assert.equal((await runJob(answer("private answer"), d)).touches, undefined);
		assert.equal(writes.length, 0);
	}
});

test("a refused reply or a legacy park without exact source cannot invent an answered touch", async () => {
	const writes = [];
	const { deps: d } = deps({ readParkedInfo: () => ({ runId: "old", at: NOW.getTime() - 1000 }), recordTouch: async (e) => writes.push(e), isParked: () => false });
	assert.equal((await runJob(answer("private"), d)).reason, "not-parked");
	assert.equal(writes.length, 0);
	d.isParked = () => true;
	d.readParkedInfo = () => null;
	d.runContainer = async () => ({ code: 0, session: { resumed: true } });
	const unknown = await runJob(answer("private"), d);
	assert.equal(writes.length, 0);
	assert.equal(unknown.touchLineageSkipped, "source-unavailable", "a proven resume with no staged parent names its accounting gap");
});

test("park capture uses the full job redactor and refuses private text when that redactor is unavailable", async () => {
	const captured = [];
	let reads = 0;
	const prepared = { workspaceDir: "/w", jobDir: "/j", session: { hostDir: "/private-session" }, questionRedact: (text) => text.replaceAll("opaque-provider-credential", "[redacted]").replaceAll("opaque-forwarded-credential", "[redacted]") };
	const { deps: d } = deps({
		prepareWorkspace: async () => prepared,
		runContainer: async () => ({ code: 0, exitReason: "awaiting-input", session: { resumed: false } }),
		promoteSession: () => ({ promoted: true }), questionCaptureEnabled: () => true,
		questionGroupStore: { capture: async (value) => { captured.push(value); return { ok: true, status: value.sourceStatus ?? "unassigned" }; } },
		readQuestionContext: ({ redact }) => { reads++; return { status: "ready", text: redact("Question opaque-provider-credential opaque-forwarded-credential") }; },
	});
	await runJob({ ...answer("private answer"), awaitInput: true }, d);
	assert.equal(captured.length, 1);
	assert.equal(captured[0].text, "Question [redacted] [redacted]");
	assert.ok(!JSON.stringify(captured).includes("opaque-provider-credential"));
	delete prepared.questionRedact;
	await runJob({ ...answer("private answer"), awaitInput: true }, d);
	assert.equal(reads, 1, "no weaker redactor is manufactured at capture time");
	assert.equal(captured[1].text, null);
	assert.equal(captured[1].sourceStatus, "source-unavailable");
});
