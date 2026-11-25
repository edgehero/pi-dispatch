import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { enqueueForgeJob, enqueueLocalJob } from "../src/queue.mjs";
import { JOB_DATA_FIELD_VERSIONS, JOB_DATA_VERSION, jobDataNewer } from "../src/job-data-version.mjs";
import { loadSchedules } from "../src/schedules.mjs";
import { localRunData } from "../src/local-job.mjs";
import { TERMINAL_COMMENTS } from "../src/comment-tables.mjs";
import { CAPABILITY_GATES, makeImagePreflight, FIELD_SEP } from "../src/image-preflight.mjs";
import { explainReason } from "../src/reason-catalog.mjs";
import { parseExitReason, parseExitTokens, RUNNER_POLICY_REASONS, TOKEN_KEYS } from "../src/run-history.mjs";
import { buildContainerEnv } from "../src/env-allowlist.mjs";
import { effectiveAllowanceMicros } from "../src/money.mjs";
import { isReservedEnvName, parseTriggers, runModelFieldNearMiss, TRIGGER_RUN_FIELD_VERSIONS, triggersFileVersionFor } from "../src/triggers.mjs";
import { AUTHORED_NARROWING_FIELDS, makeCheckWaitSkew, writeTriggers } from "../src/triggers-file.mjs";
import { NON_SECRET_ENV_KEYS } from "../src/redact-secrets.mjs";
import { mixedBillingPoolChecks, notionalCapChecks } from "../src/doctor.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #1008: `run.maxSubscriptionUsd`, the list-price allowance for a job's subscription calls. The worker's half: the
 * loader parses it by the cap's grammar, every producer carries it as written, it asks for trigger file version 11 and
 * job data version 12, a producer that drops it is refused as trigger-skew, `effectiveJobOf` turns it into
 * `maxSubscriptionMicros` (malformed reads as 0), the container gets PI_SUBSCRIPTION_ALLOWANCE_MICROS after every forward
 * and secret, and an image without `subscriptionAllowance` never runs a job that carries one.
 */

const KINDS = [
	["cron", (run = {}, on = {}) => ({ on: { type: "cron", id: "n", pattern: "0 3 * * *", ...on }, run: { kind: "local", folder: "/p", flow: "f", task: "t", ...run } })],
	["label", (run = {}, on = {}) => ({ on: { type: "label", any: ["pi"], ...on }, run: { kind: "github", flow: "f", ...run } })],
	["comment", (run = {}, on = {}) => ({ on: { type: "comment", phrase: "@pi", ...on }, run: { kind: "github", flow: "f", ...run } })],
	["issue", (run = {}, on = {}) => ({ on: { type: "issue", action: ["closed"], ...on }, run: { kind: "github", flow: "f", ...run } })],
	["pull_request", (run = {}, on = {}) => ({ on: { type: "pull_request", action: ["opened"], ...on }, run: { kind: "github", flow: "f", ...run } })],
];
const parse = (entries, version = 11) => parseTriggers(JSON.stringify({ version, triggers: entries }), "/x/triggers.json");
const fakeQueue = () => {
	const adds = [];
	return { adds, add: async (_name, data, opts) => (adds.push(data), { id: opts.jobId }) };
};
const FORGE = { repo: "acme/web", target: { type: "issue", number: 7 }, flow: "fix", trigger: { deliveryId: "d-1008", sender: { id: 1 } } };

test("the loader keeps run.maxSubscriptionUsd as written on every kind, a decimal by the cap's grammar, and null is absent", () => {
	for (const [kind, entry] of KINDS) {
		for (const value of ["12.50", 3, "0.000001", "1000000"]) assert.equal(parse([entry({ maxSubscriptionUsd: value })])[0].run.maxSubscriptionUsd, value, `${kind} ${value}`);
		for (const absent of [{}, { maxSubscriptionUsd: null }]) assert.equal(Object.hasOwn(parse([entry(absent)])[0].run, "maxSubscriptionUsd"), false, `${kind}: no key`);
		// Each refusal names the trigger and the key, never the value.
		for (const bad of [0, "0", -1, "1e3", "sk-ant-oops", "1000000.000001", "1.0000001", true, ["1"]]) {
			assert.throws(() => parse([entry({ maxSubscriptionUsd: bad })]), (e) => /^(trigger at index 0|cron trigger "n"): run\.maxSubscriptionUsd must be a dollar amount above 0 and at most 1000000/.test(e.message) && !e.message.includes("sk-ant-oops") && !e.message.includes("1e3"), `${kind} ${JSON.stringify(bad)}`);
		}
	}
});

test("a near miss of the name, under run or on, refuses as the field it spells, and the exact name under on refuses too", () => {
	for (const miss of ["maxSubscription", "max_subscription_usd", "MaxSubscriptionUsd", "maxSubscriptionsUsd", "subscriptionAllowance", "subscription_allowance_usd", "maxSubscriptionCostUsd"]) {
		assert.equal(runModelFieldNearMiss(miss), "run.maxSubscriptionUsd", miss);
		assert.throws(() => parse([KINDS[1][1]({ [miss]: "5" })]), /did you mean run\.maxSubscriptionUsd\?/, `run.${miss}`);
		assert.throws(() => parse([KINDS[1][1]({}, { [miss]: "5" })]), /did you mean run\.maxSubscriptionUsd\?/, `on.${miss}`);
	}
	assert.throws(() => parse([KINDS[1][1]({}, { maxSubscriptionUsd: "5" })]), /on\.maxSubscriptionUsd is not a field -- did you mean run\.maxSubscriptionUsd\?/);
	// The cap's own spellings still mean the cap, never the allowance.
	assert.equal(runModelFieldNearMiss("maxCost"), "run.maxCostUsd");
	assert.equal(runModelFieldNearMiss("maxSubscriptionUsd"), "run.maxSubscriptionUsd", "the exact name, for the console's sweep");
});

test("the field needs triggers file version 11: an older loader would drop it, so a file without the stamp refuses, and the writer stamps it", () => {
	assert.equal(TRIGGER_RUN_FIELD_VERSIONS.maxSubscriptionUsd, 11);
	const entry = KINDS[1][1]({ maxSubscriptionUsd: "5" });
	assert.throws(() => parseTriggers(JSON.stringify({ triggers: [entry] }), "/t"), (e) => e.message === "trigger at index 0: run.maxSubscriptionUsd needs triggers file version 11, and the file declares 1: /t");
	assert.equal(triggersFileVersionFor({ triggers: [entry] }), 11);
	assert.equal(triggersFileVersionFor({ triggers: [KINDS[1][1]({ maxCostUsd: "5" })] }), 1, "the cap needs nothing, so no existing file moves");
	const path = join(tempDir("subscription-allowance-"), "triggers.json");
	writeFileSync(path, JSON.stringify({ triggers: [] }));
	assert.deepEqual(writeTriggers({ triggersPath: path, mutate: () => [entry] }), { ok: true });
	assert.equal(JSON.parse(readFileSync(path, "utf8")).version, 11, "the writer's own stamp");
});

test("job data: the allowance rides every builder as written, stamps version 12, and a job without it keeps its bytes", async () => {
	assert.equal(JOB_DATA_FIELD_VERSIONS.maxSubscriptionUsd, 12);
	assert.ok(JOB_DATA_VERSION >= 12, "this build reads what it stamps (issue #996 raised it to 13)");
	const q = fakeQueue();
	await enqueueForgeJob(q, "github", FORGE);
	await enqueueForgeJob(q, "github", { ...FORGE, trigger: { ...FORGE.trigger, deliveryId: "d-1008-b" }, maxSubscriptionUsd: "12.50" });
	await enqueueLocalJob(q, { folder: "/srv", flow: "tidy", task: "t", maxSubscriptionUsd: 7 });
	const [plain, forge, local] = q.adds.map((data) => JSON.parse(JSON.stringify(data)));
	assert.equal("maxSubscriptionUsd" in plain || "dataVersion" in plain, false);
	assert.deepEqual([forge.maxSubscriptionUsd, forge.dataVersion], ["12.50", 12]);
	assert.deepEqual([local.maxSubscriptionUsd, local.dataVersion], [7, 12]);
	assert.ok(!JSON.stringify(forge.trigger).includes("12.50"), "at job level, never in `trigger`, which becomes /job/event.json");
	// A worker that reads 11 defers it rather than run its subscription calls with no allowance.
	assert.deepEqual(jobDataNewer(forge, { supported: 11 }), { version: 12 });
	assert.equal(jobDataNewer(forge), null, "and this build reads what it wrote");
	// The cron path and the local event path build from localRunData.
	assert.equal(localRunData({ kind: "local", folder: "/p", flow: "f", task: "t", maxSubscriptionUsd: "3" }).maxSubscriptionUsd, "3");
	assert.equal(Object.hasOwn(localRunData({ kind: "local", folder: "/p", flow: "f", task: "t" }), "maxSubscriptionUsd"), false);
	const schedule = loadSchedules({ triggersFile: "/triggers.json" }, { readFileSync: () => JSON.stringify({ version: 11, triggers: [KINDS[0][1]({ maxSubscriptionUsd: "3" })] }), existsSync: () => true })[0].data;
	assert.deepEqual([schedule.maxSubscriptionUsd, schedule.dataVersion], ["3", 12]);
});

test("a producer that drops the allowance is refused as trigger-skew: one narrowing row, any present value authored", async () => {
	const row = AUTHORED_NARROWING_FIELDS.find((r) => r.key === "maxSubscriptionUsd");
	assert.ok(row);
	for (const value of ["5", 0.5, 0, "x"]) assert.equal(row.authored(value), true, JSON.stringify(value));
	for (const value of [undefined, null]) assert.equal(row.authored(value), false, String(value));
	const file = (run) => ({ readFileSync: () => JSON.stringify({ version: 11, triggers: [{ on: { type: "label", any: ["pi:go"] }, run: { kind: "github", flow: "fix", ...run } }] }) });
	const arrived = (extra = {}) => ({ trigger: { matched: { index: 0, type: "label" } }, kind: "github", flow: "fix", ...extra });
	const check = makeCheckWaitSkew({ triggersPath: "/t.json", fs: file({ maxSubscriptionUsd: "5" }) });
	assert.deepEqual(await check(arrived()), { skewed: true, field: "maxSubscriptionUsd" }, "a stale producer dropped it");
	assert.deepEqual(await check(arrived({ maxSubscriptionUsd: null })), { skewed: true, field: "maxSubscriptionUsd" }, "null is absent");
	assert.deepEqual(await check(arrived({ maxSubscriptionUsd: "5" })), { ok: true });
	assert.deepEqual(await makeCheckWaitSkew({ triggersPath: "/t.json", fs: file({}) })(arrived()), { ok: true }, "nothing authored, nothing missing");
	assert.deepEqual(await check(arrived({ flow: "other" })), { ok: true }, "the identity guard fails open");
});

test("the effective allowance is the trigger's alone, in micro-dollars, and a malformed queued value fails closed to 0, logged by key", () => {
	const keys = [];
	assert.equal(effectiveAllowanceMicros("12.50"), 12_500_000);
	assert.equal(effectiveAllowanceMicros(3), 3_000_000);
	for (const absent of [undefined, null]) assert.equal(effectiveAllowanceMicros(absent), null);
	for (const bad of ["sk-ant-oops", 0, -1, "1e3", {}]) {
		assert.equal(effectiveAllowanceMicros(bad, (key) => keys.push(key)), 0, JSON.stringify(bad));
	}
	assert.deepEqual([...new Set(keys)], ["maxSubscriptionUsd"], "the key, never the value");
});

test("the container gets PI_SUBSCRIPTION_ALLOWANCE_MICROS from the job alone: no forwarded or secret value can set or replace it", () => {
	const base = { provider: "anthropic", model: "claude-x", maxTurns: 20, jobId: "abc", githubToken: "ghs_scoped", forgeKind: "github", hostEnv: { ANTHROPIC_API_KEY: "sk-ant-real", PI_SUBSCRIPTION_ALLOWANCE_MICROS: "999999999" }, forwardEnv: ["PI_SUBSCRIPTION_ALLOWANCE_MICROS"], secrets: { PI_SUBSCRIPTION_ALLOWANCE_MICROS: "888888888" } };
	assert.equal(buildContainerEnv({ ...base, subscriptionAllowanceMicros: 12_500_000 }).PI_SUBSCRIPTION_ALLOWANCE_MICROS, "12500000");
	assert.equal(buildContainerEnv({ ...base, subscriptionAllowanceMicros: 0 }).PI_SUBSCRIPTION_ALLOWANCE_MICROS, "0", "0 is a real allowance, a malformed value's reading");
	for (const absent of [null, undefined]) assert.equal(Object.hasOwn(buildContainerEnv({ ...base, subscriptionAllowanceMicros: absent }), "PI_SUBSCRIPTION_ALLOWANCE_MICROS"), false, "no allowance: no variable, whatever was forwarded");
	assert.equal(isReservedEnvName("PI_SUBSCRIPTION_ALLOWANCE_MICROS"), true, "run.secrets and PI_FORWARD_ENV refuse the name upstream");
	assert.ok(NON_SECRET_ENV_KEYS.has("PI_SUBSCRIPTION_ALLOWANCE_MICROS"), "a number, never a secret");
	assert.throws(() => parseTriggers(JSON.stringify({ triggers: [KINDS[1][1]({ secrets: { PI_SUBSCRIPTION_ALLOWANCE_MICROS: "vault://x" } })] }), "/t"), /PI_SUBSCRIPTION_ALLOWANCE_MICROS/);
});

test("subscriptionAllowance: any job carrying an allowance, 0 included, needs it before any spend; a job with none never does", async () => {
	const label = (caps) => `sha256:abc${FIELD_SEP}1.5.2${FIELD_SEP}github${FIELD_SEP}${caps}\n`;
	const spawn = (caps) => (_cmd, _args, opts) => fakeChild(label(caps), opts);
	const declared = ["costCap", "modelPolicy", "subscriptionAuth"];
	const old = makeImagePreflight({ image: "i", spawnFn: spawn(declared.join(",")) });
	for (const maxSubscriptionMicros of [0, 1, 12_500_000]) {
		assert.deepEqual(await old({ kind: "github", maxSubscriptionMicros }), { subscriptionAllowanceUnsupported: "i", declared }, `allowance ${maxSubscriptionMicros}`);
	}
	for (const job of [{ kind: "github", maxSubscriptionMicros: null }, { kind: "github" }]) assert.equal((await old(job)).ok, true, JSON.stringify(job));
	const current = makeImagePreflight({ image: "i", spawnFn: spawn([...declared, "subscriptionAllowance"].join(",")) });
	assert.equal((await current({ kind: "github", maxSubscriptionMicros: 0 })).ok, true);
	const row = CAPABILITY_GATES.find((gate) => gate.token === "subscriptionAllowance");
	assert.equal(row.reason, "job-image-subscription-allowance-unsupported");
	assert.equal(row.event, "refused_image_subscription_allowance_unsupported");
	assert.match(row.comment("img", "is absent"), /run\.maxSubscriptionUsd and run this job's subscription calls with no dollar limit at all/);
	assert.equal(CAPABILITY_GATES.at(-1), row, "last, so a job lacking an older feature is refused for that one as before");
});

test("subscription-allowance is a runner policy stop: exit 2 read back, a terminal comment, a catalog row, and the image refusal's row", () => {
	assert.ok(RUNNER_POLICY_REASONS.has("subscription-allowance"));
	assert.equal(parseExitReason('{"event":"exit","code":2,"reason":"subscription-allowance"}'), "subscription-allowance");
	assert.equal(parseExitReason('{"event":"exit","code":1,"reason":"subscription-allowance"}'), null, "only on exit 2");
	// True of both causes: the allowance reached, and a subscription call whose cost could not be read.
	assert.match(TERMINAL_COMMENTS["subscription-allowance"], /^Stopped: this run reached its allowance for subscription AI calls, counted at list price, or could no longer count against it because a subscription call's cost could not be read, so its next subscription call was not made\. Partial work may exist\. Not retried\.$/);
	assert.equal(explainReason("subscription-allowance").sentence, TERMINAL_COMMENTS["subscription-allowance"]);
	assert.match(explainReason("subscription-allowance").next, /run\.maxSubscriptionUsd/);
	assert.match(explainReason("job-image-subscription-allowance-unsupported").sentence, /run\.maxSubscriptionUsd/);
	assert.equal(explainReason("job-image-subscription-allowance-unsupported").anchor, "docs/reasons.md#job-image-subscription-allowance-unsupported");
});

test("the record keeps tokens.allowanceMicros, right after modelRefused in TOKEN_KEYS, and an exit line without it keeps its keys", () => {
	const at = TOKEN_KEYS.indexOf("allowanceMicros");
	assert.equal(TOKEN_KEYS[at - 1], "modelRefused", "after the model guard's counter, the runner's order");
	assert.equal(TOKEN_KEYS[at + 1], "costChargedMicros", "and before the cap's charge keys, which run-job spreads after the policy guard's fields");
	const line = { input: 1, output: 1, total: 2, cost: 0.5, metered: true, costNotional: 0.5, costCapMicros: 1_000_000, modelRefused: 0, allowanceMicros: 12_500_000 };
	assert.equal(parseExitTokens(`{"event":"exit","tokens":${JSON.stringify(line)}}`).allowanceMicros, 12_500_000);
	assert.equal(Object.hasOwn(parseExitTokens('{"event":"exit","tokens":{"total":1}}'), "allowanceMicros"), false);
	assert.equal(parseExitTokens('{"event":"exit","tokens":{"total":1,"allowanceMicros":"many"}}').allowanceMicros, undefined, "numbers only");
});

test("doctor's mixed pool line names the trigger's allowance, or says it sets none, and the bounds-nothing fix points at it", () => {
	const subject = (provider, id, allowance) => ({ label: `t (random candidate ${provider}/${id})`, main: { provider, id }, list: [{ provider, id }], cap: 2_000_000, random: true, trigger: "t", triggerCap: 2_000_000, allowance });
	const verdictOf = (provider) => (provider === "anthropic" ? { ok: true, managed: true, extraUsageCreditMicros: null } : { ok: true, managed: false });
	const lineOf = (allowance) => mixedBillingPoolChecks([subject("anthropic", "claude", allowance), subject("openrouter", "deepseek", allowance)], { verdictOf })[0].label;
	assert.match(lineOf(12_500_000), /a draw on a subscription without paid extra usage is notional: its calls leave the cap and the dollar windows, and the trigger's \$12\.50 run\.maxSubscriptionUsd \(its calls' settled list price, checked between calls\), its quota and the job's turn and time limits bound it/);
	assert.match(lineOf(null), /and only its quota and the job's turn and time limits bound it, as the trigger sets no run\.maxSubscriptionUsd/);
	const capped = { label: "t", main: { provider: "anthropic", id: "claude" }, list: [{ provider: "anthropic", id: "claude" }], auxiliaryModels: [], decisionModel: null, triggerCap: 2_000_000 };
	assert.match(notionalCapChecks([capped], { verdictOf })[0].fix, /^set run\.maxSubscriptionUsd to give its subscription calls a list-price allowance/);
});

// Integration against a real Valkey: the allowance survives the real queue's serialization and the stamp with it.
const url = process.env.VALKEY_TEST_URL;
const skip = url ? false : "VALKEY_TEST_URL not set; the queue integration test needs a Valkey";

test("against a real Valkey: a forge job and a local job carry the allowance and version 12 through the queue, and one without it carries neither", { skip }, async () => {
	const { parseConnection } = await import("../src/connection.mjs");
	const { makeQueue } = await import("../src/queue.mjs");
	const q = makeQueue(parseConnection(url), { name: `allowance-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}` });
	try {
		const { jobId: forgeId } = await enqueueForgeJob(q, "github", { ...FORGE, maxSubscriptionUsd: "12.50" });
		// Another issue, so the semantic window does not fold it into the first.
		const { jobId: plainId } = await enqueueForgeJob(q, "github", { ...FORGE, target: { type: "issue", number: 8 }, trigger: { ...FORGE.trigger, deliveryId: "d-1008-plain" } });
		const localId = await enqueueLocalJob(q, { folder: "/srv", flow: "tidy", task: "t", maxSubscriptionUsd: 7, now: new Date("2026-11-22T10:00:00Z") });
		const [forge, plain, local] = await Promise.all([forgeId, plainId, localId].map((id) => q.getJob(id)));
		assert.deepEqual([forge.data.maxSubscriptionUsd, forge.data.dataVersion], ["12.50", 12]);
		assert.deepEqual([local.data.maxSubscriptionUsd, local.data.dataVersion], [7, 12]);
		assert.equal(Object.hasOwn(plain.data, "maxSubscriptionUsd") || Object.hasOwn(plain.data, "dataVersion"), false);
		assert.deepEqual(jobDataNewer(forge.data, { supported: 11 }), { version: 12 }, "a worker that reads 11 defers what it read back");
	} finally {
		await q.obliterate({ force: true }).catch(() => {});
		await q.close();
	}
});

/** A docker child for the image preflight (processor.test.mjs' shape): the label line on stdout, then exit 0. */
function fakeChild(stdout, opts) {
	const child = new EventEmitter();
	if (opts?.stdio?.[1] === "pipe") {
		const out = new EventEmitter();
		out.setEncoding = () => {};
		child.stdout = out;
		queueMicrotask(() => out.emit("data", stdout));
	}
	queueMicrotask(() => child.emit("close", 0));
	return child;
}
