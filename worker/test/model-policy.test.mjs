import assert from "node:assert/strict";
import { test } from "node:test";
import { InfraRetry, runJob } from "../src/processor.mjs";
import { makeInFlight } from "../src/scoped-limits.mjs";
import { AUTHORED_NARROWING_FIELDS, makeCheckWaitSkew } from "../src/triggers-file.mjs";

/**
 * Issue #502 parts 2 and 3, the worker half of the model policy: the free model gates (`model-unknown`,
 * `model-not-allowed`), the effective allowed-model list (`run.models ?? PI_ALLOWED_MODELS ?? unrestricted`), and the
 * endpoint set widened to every listed model. The runner's own guard is image/runner's.
 */

// index.mjs imports bullmq; skip below the node floor / without deps, hard-fail in CI (the scope-mutex rule).
let mod;
let importError;
try {
	mod = await import("../src/index.mjs");
} catch (error) {
	importError = error;
}
if (!mod && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") {
	throw new Error(`model-policy tests are REQUIRED here but bullmq could not import.\n${importError}`);
}
const skip = mod ? false : `bullmq not installed (node ${process.version} < 22.19.0); CI runs these`;

function fakeRedis() {
	const redis = { incrCalls: 0, decrCalls: 0 };
	redis.incr = async () => (redis.incrCalls++, 1);
	redis.decr = async () => (redis.decrCalls++, 0);
	redis.expire = async () => {};
	redis.get = async () => null;
	return redis;
}

// runJob deps with every spend step recorded, so a refusal can be shown to precede all of them.
function deps(overrides = {}) {
	const calls = [];
	const redis = fakeRedis();
	const base = {
		redis,
		caps: { day: 10, week: null, month: null },
		softHoldPct: null,
		imagePreflight: async () => (calls.push("image"), { ok: true }),
		egressPreflight: async () => (calls.push("egress"), { ok: true }),
		checkProviderCredential: () => (calls.push("credential"), { ok: true }),
		mintToken: async () => (calls.push("mint"), "tok"),
		isDefaultBranchProtected: async () => (calls.push("branch-check"), true),
		prepareWorkspace: async () => (calls.push("prepare"), { workspaceDir: "/w", jobDir: "/j" }),
		runContainer: async () => (calls.push("run-container"), { code: 0, aborted: false }),
		cleanup: async () => {},
		comment: async (_j, t) => calls.push(`comment:${t}`),
		log: (event, fields) => calls.push({ event, fields }),
		now: new Date("2026-07-16T10:00:00Z"),
	};
	return { deps: { ...base, ...overrides }, calls, redis };
}
const job = (extra = {}) => ({ kind: "github", repo: "org/repo", provider: "openai", model: "gpt-x", maxTurns: 20, ...extra });
const SPEND = ["egress", "credential", "mint", "branch-check", "prepare", "run-container"];

test("model-unknown: refused after the image probe and before the credential gate, the mint, the clone and any INCR", async () => {
	const seen = [];
	const { deps: d, calls, redis } = deps({ checkModelsKnown: (refs) => (seen.push(refs), { unknown: refs[2], why: "not-in-catalog" }) });
	const r = await runJob(job({ models: ["openai/gpt-x", "openrouter/~anthropic/claude"] }), d);
	assert.deepEqual(r, { outcome: "policy", reason: "model-unknown", exitCode: null, turns: null, tokens: null, provider: "openai", model: "gpt-x", budgetReserved: false });
	// The main model first, then every listed entry, split at its FIRST slash.
	assert.deepEqual(seen, [[{ provider: "openai", id: "gpt-x", main: true }, { provider: "openai", id: "gpt-x" }, { provider: "openrouter", id: "~anthropic/claude" }]]);
	assert.equal(redis.incrCalls, 0, "CONST-BUDGET-BEFORE-TOKENS: no reservation");
	for (const step of SPEND) assert.ok(!calls.includes(step), `${step} never ran`);
	assert.ok(calls.includes("image"), "the image probe stays first, as for the credential gate");
	const comment = calls.find((c) => typeof c === "string" && c.startsWith("comment:"));
	assert.match(comment, /^comment:Refused: this job names an AI model that this deployment does not know .* Not run\.$/);
	assert.ok(!comment.includes("gpt-x") && !comment.includes("claude"), "the comment names no model: its reader may be an issue author");
	const logged = calls.find((c) => c.event === "refused_model_unknown");
	assert.deepEqual(logged.fields, { provider: "openrouter", model: "~anthropic/claude", why: "not-in-catalog" }, "the log names the unknown ref and why");
});

test("model-unknown names its cause when the overlay was unparseable", async () => {
	const { deps: d, calls } = deps({ checkModelsKnown: (refs) => ({ unknown: refs[0], why: "overlay-unparseable" }) });
	assert.equal((await runJob(job(), d)).reason, "model-unknown");
	assert.equal(calls.find((c) => c.event === "refused_model_unknown").fields.why, "overlay-unparseable");
});

test("a transient overlay read is retried as infra, never refused, and reserves nothing", async () => {
	const { deps: d, calls, redis } = deps({ checkModelsKnown: () => ({ unavailable: "EIO" }) });
	await assert.rejects(() => runJob(job(), d), (e) => e instanceof InfraRetry && e.reason === "container-never-started");
	assert.equal(redis.incrCalls, 0);
	assert.ok(!calls.some((c) => typeof c === "string" && c.startsWith("comment:")), "a retry comments nothing");
	assert.deepEqual(calls.find((c) => c.event === "model_catalog_unavailable").fields, { provider: "openai", model: "gpt-x", reason: "EIO" });
});

test("model-not-allowed: a main model off the effective list is refused pre-spend; both halves and case count", async () => {
	for (const models of [["anthropic/claude-x"], ["azure-openai-responses/gpt-x"], ["openai/GPT-x"]]) {
		const { deps: d, calls, redis } = deps();
		const r = await runJob(job({ models }), d);
		assert.equal(r.reason, "model-not-allowed", JSON.stringify(models));
		assert.equal(r.budgetReserved, false);
		assert.equal(redis.incrCalls, 0);
		for (const step of SPEND) assert.ok(!calls.includes(step), `${step} never ran`);
		assert.ok(calls.some((c) => typeof c === "string" && /^comment:Refused: the AI model this job would run on is not on the list/.test(c)));
	}
	// On the list: no refusal, and the job runs.
	const { deps: d } = deps();
	assert.equal((await runJob(job({ models: ["anthropic/claude-x", "openai/gpt-x"] }), d)).outcome, "completed");
	// No list: unrestricted, today's behaviour.
	const { deps: d2 } = deps();
	assert.equal((await runJob(job(), d2)).outcome, "completed");
});

test("model-not-allowed: a listed model whose fallbacks are not listed is refused pre-spend, naming no model in the comment", async () => {
	const fable = { provider: "anthropic", id: "claude-fable-5" };
	const { deps: d, calls, redis } = deps({ checkModelsKnown: () => ({ fallbackUnlisted: fable, why: "fallback-unlisted" }) });
	const r = await runJob(job({ provider: "anthropic", model: "claude-fable-5", models: ["anthropic/claude-fable-5"] }), d);
	assert.deepEqual([r.reason, r.budgetReserved, redis.incrCalls], ["model-not-allowed", false, 0]);
	for (const step of SPEND) assert.ok(!calls.includes(step), `${step} never ran`);
	const comment = calls.find((c) => typeof c === "string" && c.startsWith("comment:"));
	assert.match(comment, /^comment:Refused: a model this job is allowed to use declares fallback models that are not on the job's list/);
	assert.ok(!/fable|opus|claude/.test(comment), "the comment names no model");
	assert.deepEqual(calls.find((c) => c.event === "refused_model_not_allowed").fields, { provider: "anthropic", model: "claude-fable-5", why: "fallback-unlisted" });
});

test("model-unknown is decided before model-not-allowed, and both before the credential gate", async () => {
	const { deps: d, calls } = deps({ checkModelsKnown: (refs) => ({ unknown: refs[0], why: "not-in-catalog" }), checkProviderCredential: () => (calls.push("credential"), { ok: false, message: "x" }) });
	assert.equal((await runJob(job({ models: ["anthropic/claude-x"] }), d)).reason, "model-unknown");
	assert.ok(!calls.includes("credential"));
});

// --- the effective job and the endpoint set (index.mjs) ---

const SETTINGS = (extra = {}) => () => ({ provider: "openai", model: "gpt-x", maxTurns: 30, dailyCap: 10, weeklyCap: null, monthlyCap: null, concurrency: 3, softHoldPct: null, ...extra });

function harness({ getSettings = SETTINGS(), allowedModels, extra = {}, extraDeps = {} } = {}) {
	const seen = { ctx: [], records: [], logs: [], comments: [] };
	const redis = fakeRedis();
	const processor = mod.makeProcessor({
		cancelJob: () => {},
		stopContainer: () => {},
		redis,
		getSettings,
		applyConcurrency: () => {},
		now: () => Date.UTC(2026, 7, 29, 12, 0),
		recordRun: (r) => seen.records.push(r),
		timeoutMs: 100000,
		deps: {
			...(allowedModels !== undefined ? { allowedModels } : {}),
			mintToken: async () => "tok",
			isDefaultBranchProtected: async () => true,
			prepareWorkspace: async () => ({ workspaceDir: "/w", jobDir: "/j" }),
			runContainer: async (ctx) => (seen.ctx.push(ctx), { code: 0, aborted: false, turns: 1 }),
			cleanup: async () => {},
			comment: async (_j, t) => seen.comments.push(t),
			log: (event, fields) => seen.logs.push({ event, fields }),
			...extraDeps,
		},
		...extra,
	});
	return { processor, seen, redis };
}
const qJob = (id, data) => ({ id, attemptsMade: 0, name: data.kind, data, moveToDelayed: async () => {} });
const LOCAL = { kind: "local", folder: "/f", flow: "tidy", task: "t" };
const run = (h, data) => h.processor(qJob("j-1", data), "tok", new AbortController().signal);

test("effectiveJobOf: the list is the trigger's, else the env's, else absent; the overlay never supplies one", { skip }, () => {
	const settings = SETTINGS({ models: ["x/overlay"], allowedModels: ["x/overlay"] })();
	assert.equal("models" in mod.effectiveJobOf({ kind: "local" }, settings), false, "unrestricted: no key at all, even with list-shaped overlay keys");
	assert.deepEqual(mod.effectiveJobOf({ kind: "local" }, settings, ["openai/gpt-x"]).models, ["openai/gpt-x"], "the env list");
	assert.deepEqual(mod.effectiveJobOf({ kind: "local", models: ["a/b"] }, settings, ["openai/gpt-x"]).models, ["a/b"], "the trigger's own list wins");
	assert.deepEqual(mod.effectiveJobOf({ kind: "local", models: null }, settings, ["openai/gpt-x"]).models, ["openai/gpt-x"], "null is absent");
});

test("PI_ALLOWED_MODELS without the default model refuses pre-spend; a trigger's own list replaces it", { skip }, async () => {
	const h = harness({ allowedModels: ["anthropic/claude-x"] });
	const r = await run(h, LOCAL);
	assert.equal(r.reason, "model-not-allowed");
	assert.equal(h.seen.ctx.length, 0, "no container");
	assert.equal(h.redis.incrCalls, 0, "no reservation");
	// The trigger's run.models replaces the env list, and the container is handed the trigger's.
	const h2 = harness({ allowedModels: ["anthropic/claude-x"] });
	assert.equal((await run(h2, { ...LOCAL, models: ["openai/gpt-x"] })).outcome, "completed");
	assert.deepEqual(h2.seen.ctx[0].job.models, ["openai/gpt-x"]);
	// With the env list holding the default, the job runs and carries the env list to its container.
	const h3 = harness({ allowedModels: ["openai/gpt-x", "anthropic/claude-x"] });
	assert.equal((await run(h3, LOCAL)).outcome, "completed");
	assert.deepEqual(h3.seen.ctx[0].job.models, ["openai/gpt-x", "anthropic/claude-x"]);
});

test("a list never comes from the settings overlay, which dispatch_set writes", { skip }, async () => {
	const h = harness({ getSettings: SETTINGS({ models: ["anthropic/claude-x"], allowedModels: ["anthropic/claude-x"] }) });
	assert.equal((await run(h, LOCAL)).outcome, "completed", "overlay keys shaped like a list are not a list");
	assert.equal("models" in h.seen.ctx[0].job, false, "and the container gets no PI_ALLOWED_MODELS source");
});

test("a dispatch_set that moves the default model off a trigger's list is refused pre-spend", { skip }, async () => {
	// The trigger names a list but no model: its main model is the overlay's, which a model-callable tool can change.
	const h = harness({ getSettings: SETTINGS({ model: "gpt-y" }) });
	const r = await run(h, { ...LOCAL, models: ["openai/gpt-x"] });
	assert.equal(r.reason, "model-not-allowed");
	assert.equal(r.model, "gpt-y");
	assert.equal(h.seen.ctx.length, 0);
});

test("the model-exists gate reads the EFFECTIVE model: one the overlay or env supplied is checked too", { skip }, async () => {
	const { checkModelsKnown } = await import("../src/model-catalog.mjs");
	// Most forge triggers name no model. A gate that only looked at the trigger's own fields would wave this through.
	const h = harness({ getSettings: SETTINGS({ provider: "anthropic", model: "claude-sonnet-9" }), extraDeps: { checkModelsKnown: (refs) => checkModelsKnown(refs) } });
	const r = await run(h, LOCAL);
	assert.equal(r.reason, "model-unknown");
	assert.equal(h.redis.incrCalls, 0);
	assert.deepEqual(h.seen.logs.find((l) => l.event === "refused_model_unknown").fields, { provider: "anthropic", model: "claude-sonnet-9", why: "not-in-catalog" });
	// And a real builtin passes.
	const ok = harness({ getSettings: SETTINGS({ provider: "anthropic", model: "claude-sonnet-4-5-20250929" }), extraDeps: { checkModelsKnown: (refs) => checkModelsKnown(refs) } });
	assert.equal((await run(ok, LOCAL)).outcome, "completed");
});

// The endpoint set: a listed model on another local server holds that server's slot too.
const GPU1 = { id: "gpu-one", host: "gpu1.lan", port: 11434, slots: 1 };
const GPU2 = { id: "gpu-two", host: "gpu2.lan", port: 11434, slots: 1 };
const OVERLAY = { providers: { openai: { models: [{ id: "small", baseUrl: "http://gpu1.lan:11434/v1" }, { id: "smaller", baseUrl: "http://gpu1.lan:11434/v1" }, { id: "big", baseUrl: "http://gpu2.lan:11434/v1" }] } } };

test("mainModelEndpoints: the union over the main model and every listed one; the main model alone without a list", { skip }, () => {
	const ids = (job) => mod.mainModelEndpoints({ models: OVERLAY, job, endpoints: [GPU1, GPU2] }).map((e) => e.id);
	assert.deepEqual(ids({ provider: "openai", model: "small" }), ["gpu-one"]);
	assert.deepEqual(ids({ provider: "openai", model: "small", models: ["openai/small", "openai/big"] }), ["gpu-one", "gpu-one", "gpu-two"], "duplicates are the caller's to drop");
	assert.deepEqual(ids({ provider: "anthropic", model: "claude-x", models: ["anthropic/claude-x"] }), [], "a hosted model uses no declared endpoint");
});

test("the pickup gate holds one slot per endpoint the list reaches, deduplicated, and gives them all back", { skip }, async () => {
	const endpointSlots = makeInFlight();
	const held = [];
	const extra = { endpointSlots, modelEndpoints: () => [GPU1, GPU2], overlayModels: () => OVERLAY };
	const h = harness({
		getSettings: SETTINGS({ model: "small" }),
		extra,
		extraDeps: { runContainer: async (ctx) => (held.push([endpointSlots.count("gpu-one"), endpointSlots.count("gpu-two")]), h.seen.ctx.push(ctx), { code: 0, aborted: false }) },
	});
	assert.equal((await run(h, { ...LOCAL, models: ["openai/small", "openai/smaller", "openai/big"] })).outcome, "completed");
	assert.deepEqual(held, [[1, 1]], "one hold on each server, though two listed models share gpu-one");
	assert.deepEqual(h.seen.ctx[0].modelEndpoints.set.map((e) => e.id), ["gpu-one", "gpu-two"]);
	assert.deepEqual([endpointSlots.count("gpu-one"), endpointSlots.count("gpu-two")], [0, 0]);
	// No list: the main model's endpoint only, as before.
	const h2 = harness({ getSettings: SETTINGS({ model: "small" }), extra: { ...extra } });
	await run(h2, LOCAL);
	assert.deepEqual(h2.seen.ctx[0].modelEndpoints.set.map((e) => e.id), ["gpu-one"]);
});

// --- PR #536's review: version skew, the overlay as pi reads it, the wiring ---


const skewFile = (run) => ({ readFileSync: () => JSON.stringify({ triggers: [{ on: { type: "label", any: ["pi:go"] }, run: { kind: "github", flow: "fix", ...run } }] }) });
const arrived = (extra = {}) => ({ trigger: { matched: { index: 0, type: "label" } }, kind: "github", flow: "fix", ...extra });

test("the skew check refuses a job whose AUTHORED trigger lists models it arrived without, and reads one row per field", async () => {
	assert.deepEqual(AUTHORED_NARROWING_FIELDS.map((row) => row.key), ["models", "maxCostUsd"], "a new narrowing field is one row here");
	const check = makeCheckWaitSkew({ triggersPath: "/t.json", fs: skewFile({ models: ["openai/gpt-x"] }) });
	assert.deepEqual(await check(arrived()), { skewed: true, field: "models" }, "a stale receiver dropped the list");
	assert.deepEqual(await check(arrived({ models: null })), { skewed: true, field: "models" }, "null is absent");
	assert.deepEqual(await check(arrived({ models: ["openai/gpt-x"] })), { ok: true });
	// Fail OPEN on the identity guard and on an unreadable file, the waitFor rule.
	assert.deepEqual(await check(arrived({ models: undefined, flow: "other" })), { ok: true });
	assert.deepEqual(await makeCheckWaitSkew({ triggersPath: "/t.json", fs: { readFileSync: () => "{ nope" } })(arrived()), { ok: true });
	assert.deepEqual(await makeCheckWaitSkew({ triggersPath: "" })(arrived()), { ok: true }, "no file to read: the documented limit");
	assert.deepEqual(await makeCheckWaitSkew({ triggersPath: "/t.json", fs: skewFile({}) })(arrived()), { ok: true }, "nothing authored, nothing missing");
	// A wait skew keeps its own answer when both dropped.
	const both = makeCheckWaitSkew({ triggersPath: "/t.json", fs: skewFile({ models: ["openai/gpt-x"], waitFor: [{ profile: "jira" }] }) });
	assert.deepEqual(await both(arrived()), { skewed: true, conditions: 1 });
});

test("the skew check refuses a job whose AUTHORED trigger sets maxCostUsd it arrived without (#501)", async () => {
	// A receiver from before #501 tolerated the key as unknown and dropped it: the job would run under the deployment's
	// wider cap, or none, on a clean record.
	for (const authored of ["2.50", 0.5]) {
		const check = makeCheckWaitSkew({ triggersPath: "/t.json", fs: skewFile({ maxCostUsd: authored }) });
		assert.deepEqual(await check(arrived()), { skewed: true, field: "maxCostUsd" }, `a stale receiver dropped ${authored}`);
		assert.deepEqual(await check(arrived({ maxCostUsd: null })), { skewed: true, field: "maxCostUsd" }, "null is absent");
		assert.deepEqual(await check(arrived({ maxCostUsd: authored })), { ok: true });
	}
	assert.deepEqual(await makeCheckWaitSkew({ triggersPath: "/t.json", fs: skewFile({}) })(arrived()), { ok: true }, "nothing authored, nothing missing");
	// The identity guard and the unreadable file fail OPEN, as for every row.
	const check = makeCheckWaitSkew({ triggersPath: "/t.json", fs: skewFile({ maxCostUsd: "1" }) });
	assert.deepEqual(await check(arrived({ flow: "other" })), { ok: true });
});

test("the processor hands the skew check maxCostUsd as the job ARRIVED, and refuses a dropped cap as trigger-skew (#501)", { skip }, async () => {
	const seen = [];
	const checkWaitSkew = makeCheckWaitSkew({ triggersPath: "/t.json", fs: skewFile({ maxCostUsd: "2.50" }) });
	const h = harness({ extraDeps: { checkWaitSkew: (j) => (seen.push(j.maxCostUsd), checkWaitSkew(j)) } });
	const r = await h.processor(qJob("j-cap", { kind: "github", repo: "o/r", flow: "fix", target: { number: 1 }, trigger: { matched: { index: 0, type: "label" } } }), "tok", new AbortController().signal);
	assert.equal(r.reason, "trigger-skew");
	assert.equal(r.budgetReserved, false);
	assert.deepEqual(seen, [undefined]);
	assert.equal(h.seen.ctx.length, 0, "no container");
});

test("a deployment cap never fills a maxCostUsd the job arrived without, before the skew check (#540)", { skip }, async () => {
	// The harness above sets no deployment cap, so a wrapper that fell back to it (`job.data?.maxCostUsd ??
	// settings.maxCostUsd`) still handed the check undefined. Here the overlay holds a cap, the SAME value the trigger
	// authored, so such a fill would make the dropped cap read as present and the job would run.
	for (const deployment of ["2.50", "9"]) {
		const seen = [];
		const checkWaitSkew = makeCheckWaitSkew({ triggersPath: "/t.json", fs: skewFile({ maxCostUsd: "2.50" }) });
		const h = harness({ getSettings: SETTINGS({ maxCostUsd: deployment }), extraDeps: { checkWaitSkew: (j) => (seen.push(j.maxCostUsd), checkWaitSkew(j)) } });
		const r = await h.processor(qJob("j-cap", { kind: "github", repo: "o/r", flow: "fix", target: { number: 1 }, trigger: { matched: { index: 0, type: "label" } } }), "tok", new AbortController().signal);
		assert.equal(r.reason, "trigger-skew", `deployment cap ${deployment}`);
		assert.equal(r.budgetReserved, false);
		assert.deepEqual(seen, [undefined], "the check sees the job as it arrived");
		assert.equal(h.seen.ctx.length, 0, "no container");
	}
	// The arrived cap still reaches the check, beside a deployment cap.
	const seen = [];
	const h = harness({ getSettings: SETTINGS({ maxCostUsd: "9" }), extraDeps: { checkWaitSkew: (j) => (seen.push(j.maxCostUsd), { ok: true }) } });
	await h.processor(qJob("j-cap", { kind: "github", repo: "o/r", flow: "fix", target: { number: 1 }, maxCostUsd: "2.50", trigger: { matched: { index: 0, type: "label" } } }), "tok", new AbortController().signal);
	assert.deepEqual(seen, ["2.50"]);
});

test("a trigger-skew refusal is pre-spend and names the field, never its value", async () => {
	const { deps: d, calls, redis } = deps({ checkWaitSkew: async () => ({ skewed: true, field: "models" }) });
	const r = await runJob(job(), d);
	assert.equal(r.reason, "trigger-skew");
	assert.equal(r.budgetReserved, false);
	assert.equal(redis.incrCalls, 0);
	for (const step of ["image", ...SPEND]) assert.ok(!calls.includes(step), `${step} never ran`);
	const comment = calls.find((c) => typeof c === "string" && c.startsWith("comment:"));
	assert.match(comment, /run\.models/);
	assert.match(comment, /Not run\.$/);
	assert.deepEqual(calls.find((c) => c.event === "refused_trigger_skew").fields, { triggerIndex: null, field: "models", causes: "trigger-changed-after-queue-or-stale-service" });
});

test("the skew check sees the list as the job ARRIVED, not as PI_ALLOWED_MODELS filled it", { skip }, async () => {
	const seen = [];
	const checkWaitSkew = makeCheckWaitSkew({ triggersPath: "/t.json", fs: skewFile({ models: ["openai/gpt-x"] }) });
	const h = harness({ allowedModels: ["openai/gpt-x", "anthropic/claude-x"], extraDeps: { checkWaitSkew: (j) => (seen.push(j.models), checkWaitSkew(j)) } });
	const r = await h.processor(qJob("j-1", { kind: "github", repo: "o/r", flow: "fix", target: { number: 1 }, trigger: { matched: { index: 0, type: "label" } } }), "tok", new AbortController().signal);
	assert.equal(r.reason, "trigger-skew", "the env list must not hide the trigger list a stale receiver dropped");
	assert.deepEqual(seen, [undefined]);
	assert.equal(h.seen.ctx.length, 0);
});

test("a PRESENT but invalid list refuses pre-spend rather than reading as no list", { skip }, async () => {
	for (const models of ["openai/gpt-x", {}, 0, false, "", [], ["nope"]]) {
		const h = harness({ allowedModels: ["openai/gpt-x"] });
		const r = await run(h, { ...LOCAL, models });
		assert.equal(r.reason, "model-unknown", JSON.stringify(models));
		assert.equal(h.seen.ctx.length, 0);
		assert.equal(h.redis.incrCalls, 0);
		assert.equal(h.seen.logs.find((l) => l.event === "refused_model_unknown").fields.why, "list-malformed");
	}
});

test("the MAIN model must be a chat model; a list entry may be an image or classifier model", async () => {
	const { checkModelsKnown } = await import("../src/model-catalog.mjs");
	const image = { provider: "openrouter", id: "black-forest-labs/flux.2-pro" };
	assert.deepEqual(checkModelsKnown([{ ...image, main: true }]), { unknown: image, why: "not-in-catalog" }, "pi's getModel answers chat models only, so this main model would exit 2 in a paid container");
	assert.deepEqual(checkModelsKnown([{ provider: "anthropic", id: "claude-haiku-4-5", main: true }, image]), { ok: true });
	// The processor marks the main ref.
	const seen = [];
	const { deps: d } = deps({ checkModelsKnown: (refs) => (seen.push(refs), { ok: true }) });
	await runJob(job({ models: ["openai/gpt-x"] }), d);
	assert.deepEqual(seen[0].map((r) => r.main === true), [true, false]);
});

test("an overlay that is a directory is refused as such, not retried", async () => {
	const { checkModelsKnown } = await import("../src/model-catalog.mjs");
	const eisdir = () => {
		throw Object.assign(new Error("EISDIR"), { code: "EISDIR" });
	};
	assert.deepEqual(checkModelsKnown([{ provider: "ollama", id: "qwen" }], { readOverlay: eisdir }), { unknown: { provider: "ollama", id: "qwen" }, why: "overlay-is-a-directory" });
});

test("the pickup endpoint set counts the env list too", { skip }, async () => {
	const endpointSlots = makeInFlight();
	const h = harness({ getSettings: SETTINGS({ model: "small" }), allowedModels: ["openai/small", "openai/big"], extra: { endpointSlots, modelEndpoints: () => [GPU1, GPU2], overlayModels: () => OVERLAY } });
	assert.equal((await run(h, LOCAL)).outcome, "completed");
	assert.deepEqual(h.seen.ctx[0].modelEndpoints.set.map((e) => e.id), ["gpu-one", "gpu-two"], "a deployment list reaches a second server, so the job holds its slot");
});

// --- PR #536's review, round 2 ---

test("a job that arrived WITH waitFor and WITHOUT models is skewed: a receiver that carries waitFor but predates models", async () => {
	const check = makeCheckWaitSkew({ triggersPath: "/t.json", fs: skewFile({ models: ["openai/gpt-x"], waitFor: [{ profile: "jira" }] }) });
	assert.deepEqual(await check(arrived({ waitFor: [{ profile: "jira" }] })), { skewed: true, field: "models" });
});

test("the identity guard covers the models row: a different trigger at the index is not skew", async () => {
	const check = makeCheckWaitSkew({ triggersPath: "/t.json", fs: skewFile({ models: ["openai/gpt-x"] }) });
	assert.deepEqual(await check(arrived({ kind: "gitlab" })), { ok: true }, "another forge at this index");
	assert.deepEqual(await check(arrived({ trigger: { matched: { index: 0, type: "comment" } } })), { ok: true }, "another on-type at this index");
	assert.deepEqual(await check(arrived({ command: "x", flow: undefined })), { ok: true }, "a command job where a flow was authored");
});

test("the skew check is STRICT: a later write of the triggers file does not reopen it", async () => {
	// A fail-open fenced on the file's mtime was tried and removed (PR #536's review, round 3): the worker's own one-shot
	// disarm, a console edit or a touch rewrites the file, and every skewed job after it would have run. So a file with
	// the latest possible mtime refuses exactly like an old one, and a job queued before the field was added is refused too.
	const fresh = { statSync: () => ({ mtimeMs: 8.64e15, size: 1 }), readFileSync: skewFile({ models: ["openai/gpt-x"] }).readFileSync };
	assert.deepEqual(await makeCheckWaitSkew({ triggersPath: "/t.json", fs: fresh })(arrived()), { skewed: true, field: "models" });
});

test("the trigger-skew comment names the likeliest cause first: the trigger changed after the job was queued", async () => {
	const { deps: d, calls } = deps({ checkWaitSkew: async () => ({ skewed: true, field: "models" }) });
	assert.equal((await runJob(job(), d)).reason, "trigger-skew");
	const comment = calls.find((c) => typeof c === "string" && c.startsWith("comment:"));
	assert.match(comment, /the trigger changed after this job was queued \(re-run it\)/);
	assert.match(comment, /a service in this deployment is stale/);
});

test("an overlay-only MAIN model is known: the main model reads the overlay too", async () => {
	const { checkModelsKnown } = await import("../src/model-catalog.mjs");
	const readOverlay = () => ({ providers: { ollama: { baseUrl: "http://gpu.lan:11434/v1", api: "openai-completions", models: [{ id: "qwen" }] } } });
	assert.deepEqual(checkModelsKnown([{ provider: "ollama", id: "qwen", main: true }], { readOverlay }), { ok: true });
});

test("a model under an overlay provider pi would not compose is unknown, with its own why", async () => {
	const { checkModelsKnown } = await import("../src/model-catalog.mjs");
	for (const cfg of [{ baseUrl: "http://gpu:11434/v1", models: [{ id: "qwen" }] }, { api: "openai-completions", models: [{ id: "qwen" }] }, { baseUrl: "http://gpu:11434/v1", api: "openai-completions", models: [{ id: "qwen", maxTokens: 0 }] }]) {
		const r = checkModelsKnown([{ provider: "ollama", id: "qwen", main: true }], { readOverlay: () => ({ providers: { ollama: cfg } }) });
		assert.deepEqual(r, { unknown: { provider: "ollama", id: "qwen" }, why: "overlay-provider-invalid" }, JSON.stringify(cfg));
	}
	// A BUILTIN model of that provider is refused too (round 3): pi drops the whole entry, so it would run against the
	// provider's public endpoint while the file routes it through the operator's.
	const broken = { providers: { openai: { baseUrl: "http://proxy.lan:8080/v1", models: [{ id: "my-ft", maxTokens: 0 }] } } };
	assert.deepEqual(checkModelsKnown([{ provider: "openai", id: "gpt-4o", main: true }], { readOverlay: () => broken }), { unknown: { provider: "openai", id: "gpt-4o" }, why: "overlay-provider-invalid" });
	// A builtin model of ANOTHER provider is untouched, and an entry with nothing pi could drop refuses nothing.
	assert.deepEqual(checkModelsKnown([{ provider: "anthropic", id: "claude-haiku-4-5", main: true }], { readOverlay: () => broken }), { ok: true });
	assert.deepEqual(checkModelsKnown([{ provider: "openai", id: "gpt-4o", main: true }], { readOverlay: () => ({ providers: { openai: {} } }) }), { ok: true });
});
