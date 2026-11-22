import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { tempDir } from "./helpers/temp-dir.mjs";
import { collectChecks } from "./helpers/doctor.mjs";
import { makeSubscriptionQuotaStore, normalizeClaudeQuota, normalizeOpenAIQuota, SUBSCRIPTION_QUOTA_LIMITS } from "../src/subscription-quota.mjs";
import { makeSubscriptionRuntime, quotaReserveBlock, subscriptionIdentity, QUOTA_RESERVE_RECHECK_MS } from "../src/subscription-runtime.mjs";
import { publishSubscriptionStatus, readSubscriptionStatus } from "../src/subscription-status.mjs";
import { SubscriptionWait } from "../src/subscription-wait.mjs";
import { makeCheckQuotaReserve } from "../src/triggers-file.mjs";
import { parseTriggers, TRIGGERS_FILE_VERSION } from "../src/triggers.mjs";
import { quotaReserveChecks } from "../src/doctor.mjs";
import { configuredSubscriptions } from "../src/subscription-config.mjs";
import { selectFailoverJob } from "../src/model-failover.mjs";
import { MODEL_RECHECK_MS } from "../src/model-cooldowns.mjs";
import { existsSync, readFileSync } from "node:fs";

// Issue #1008: the deployment quota reserve (`PI_QUOTA_RESERVE_PERCENT`) and the trigger flag that may use it
// (`run.quotaReserve`). Every reading below is a real observation through the real quota store (`normalizeClaudeQuota`,
// `record`, `read`, `admit`) over a byte-comparing Valkey fake, on an injected clock, so "stale", "fresh" and "reset" are
// the store's own verdicts, never a hand-written status.

const NOW = Date.UTC(2030, 0, 1);
const MINUTE = 60_000;
const DAY = 86_400_000;
const iso = (at) => new Date(at).toISOString();
const claude = { id: "claude-main", connectionId: "claude-main", provider: "anthropic", ownerHost: "owner", adapter: "pi-anthropic-oauth@0.3.6", accountGroup: "12345678-1234-4234-8234-123456789abc", generation: 1, state: "connected", active: true };
const chatgpt = { id: "chatgpt-main", connectionId: "chatgpt-main", provider: "openai", ownerHost: "owner", adapter: "openai-chatgpt", accountGroup: "22345678-1234-4234-8234-123456789abc", generation: 1, state: "connected", active: true };
const sonnet = { kind: "github", flow: "fix", provider: "anthropic", model: "claude-sonnet-5-5", models: ["anthropic/claude-sonnet-5-5"], maxCostMicros: 1_000_000 };
const gpt = { kind: "github", flow: "fix", provider: "openai", model: "gpt-5.5", models: ["openai/gpt-5.5"], maxCostMicros: 1_000_000 };
const usage = (sevenDay, extra = {}) => ({ five_hour: { utilization: 20, resets_at: iso(NOW + 3 * 3_600_000) }, seven_day: sevenDay, extra_usage: { is_enabled: false }, ...extra });

function valkeyFake() {
	const rows = new Map();
	return {
		rows,
		async get(key) { return rows.get(key) ?? null; },
		async eval(_script, count, key, before, after) {
			assert.equal(count, 1);
			if ((rows.get(key) ?? "") !== before) return 0;
			rows.set(key, after);
			return 1;
		},
	};
}

function fixture({ reserve = 85, rows = [claude], granted = () => false } = {}) {
	let clock = NOW;
	const redis = valkeyFake();
	const quota = makeSubscriptionQuotaStore({ redis, now: () => clock });
	const calls = [];
	let fetchUsage = async () => usage({ utilization: 30 });
	const bound = (provider) => rows.find((row) => row.provider === provider);
	const auth = {
		check: async (provider) => bound(provider) ? { ok: true, managed: true, ...bound(provider) } : { ok: true, managed: false },
		status: async () => rows,
		async usage(id) {
			calls.push(`usage:${id}`);
			return { kind: "observation", observedAt: clock, ...rows.find((row) => row.id === id), payload: await fetchUsage() };
		},
		async prepareSnapshot(provider) { calls.push(`snapshot:${provider}`); return { ok: true, snapshot: { ...bound(provider) } }; },
	};
	const asked = [];
	const runtime = makeSubscriptionRuntime({
		auth, quota, now: () => clock,
		lookup: (provider) => ({ api: provider === "anthropic" ? "anthropic-messages" : "openai-responses", baseUrl: provider === "anthropic" ? "https://api.anthropic.com" : "https://api.openai.com/v1" }),
		packageRootFor: () => ({ root: "/opt/pi-global/packages/claude", digest: "a".repeat(64) }),
		quotaReservePercent: reserve,
		reserveGranted: (job) => (asked.push(job), granted(job)),
	});
	return {
		runtime, quota, redis, calls, asked,
		setTime(at) { clock = at; },
		setUsage(fn) { fetchUsage = fn; },
		seed: (raw, row = claude, at = clock) => quota.record(subscriptionIdentity(row), (row.provider === "openai" ? normalizeOpenAIQuota : normalizeClaudeQuota)(raw, { observedAt: at })),
	};
}

test("a fresh reading at or above the reserve holds the job until the window's reset or the recheck, whichever is sooner", async () => {
	const f = fixture();
	await f.seed(usage({ utilization: 89, resets_at: iso(NOW + 3 * DAY) }));
	const held = await f.runtime.check(sonnet);
	assert.deepEqual([held.ok, held.wait, held.until, held.resetAt], [false, "subscription-reserve", NOW + QUOTA_RESERVE_RECHECK_MS, NOW + 3 * DAY]);
	assert.equal(held.reason, undefined, "a wait, never a refusal reason a record could carry");
	assert.equal(f.asked.length, 1, "the trigger's flag is asked only for a job the reserve holds");
	// A reset sooner than the recheck ends the wait at the reset.
	const soon = fixture();
	await soon.seed(usage({ utilization: 85, resets_at: iso(NOW + 2 * MINUTE) }));
	assert.deepEqual([(await soon.runtime.check(sonnet)).until, (await soon.runtime.check(sonnet)).resetAt], [NOW + 2 * MINUTE, NOW + 2 * MINUTE]);
	// A fresh reading with no reset holds too, asking again at the recheck with no reset to name.
	const unreset = fixture();
	await unreset.seed(usage({ utilization: 90 }));
	const noReset = await unreset.runtime.check(sonnet);
	assert.deepEqual([noReset.wait, noReset.until, noReset.resetAt], ["subscription-reserve", NOW + QUOTA_RESERVE_RECHECK_MS, null]);
});

test("a stale reading over the reserve with its reset ahead still holds; a stale one with no reset, or under it, passes and is read again", async () => {
	const f = fixture();
	await f.seed(usage({ utilization: 92, resets_at: iso(NOW + 2 * DAY) }));
	f.setTime(NOW + SUBSCRIPTION_QUOTA_LIMITS.freshMs + MINUTE);
	assert.equal((await f.quota.read(subscriptionIdentity(claude))).fresh, false, "the store calls the reading stale");
	assert.equal((await f.runtime.check(sonnet)).wait, "subscription-reserve", "usage only grows until the reset, so a stale over-reading is still true");
	for (const raw of [usage({ utilization: 92 }), usage({ utilization: 40, resets_at: iso(NOW + 2 * DAY) })]) {
		const g = fixture();
		await g.seed(raw);
		g.setTime(NOW + SUBSCRIPTION_QUOTA_LIMITS.freshMs + MINUTE);
		const passed = await g.runtime.check(sonnet);
		assert.equal(passed.ok, true, JSON.stringify(raw.seven_day));
		assert.equal(passed.managed[0].needsUsage, true, "prepare reads usage before it admits");
	}
	// A reset already passed opens a new window: the old percentage says nothing.
	const reset = fixture();
	await reset.seed(usage({ utilization: 92, resets_at: iso(NOW + MINUTE) }));
	reset.setTime(NOW + 2 * MINUTE);
	assert.equal((await reset.runtime.check(sonnet)).ok, true);
});

test("prepare reads a stale-under account again and holds the job when the fresh reading is over the reserve, before any credential is prepared", async () => {
	const f = fixture();
	await f.seed(usage({ utilization: 40, resets_at: iso(NOW + 2 * DAY) }));
	f.setTime(NOW + SUBSCRIPTION_QUOTA_LIMITS.freshMs + MINUTE);
	f.setUsage(async () => usage({ utilization: 88, resets_at: iso(NOW + 2 * DAY) }));
	const prepared = await f.runtime.prepare(sonnet, { deadlineAt: NOW + DAY, attemptId: "delivery-1" });
	assert.deepEqual([prepared.ok, prepared.wait, prepared.resetAt], [false, "subscription-reserve", NOW + 2 * DAY]);
	assert.deepEqual(f.calls, ["usage:claude-main"], "no access snapshot for a held job");
	const wait = new SubscriptionWait(prepared);
	assert.deepEqual([wait.wait, wait.until, wait.resetAt, wait.quotaConfirmed, wait.budgetReserved], ["subscription-reserve", prepared.until, NOW + 2 * DAY, false, false]);
});

test("unknown usage, a ChatGPT connection and an unset reserve never hold", async () => {
	// No observation at all, and one whose provider sent no percentages.
	const empty = fixture();
	assert.equal((await empty.runtime.check(sonnet)).ok, true);
	const blank = fixture();
	await blank.seed({ five_hour: {}, seven_day: {}, extra_usage: { is_enabled: false } });
	assert.equal((await blank.runtime.check(sonnet)).ok, true);
	assert.equal(empty.asked.length + blank.asked.length, 0);
	// ChatGPT: even a percentage on its record is not judged, since the reserve counts Claude windows only.
	const openai = fixture({ rows: [chatgpt] });
	await openai.seed({ rateLimits: { primary: { usedPercent: 97, windowDurationMins: 300, resetsAt: Math.floor((NOW + DAY) / 1000) } } }, chatgpt);
	assert.equal((await openai.quota.read(subscriptionIdentity(chatgpt))).windows.find((row) => row.id === "five-hour").usedPercent, 97);
	assert.equal((await openai.runtime.check(gpt)).ok, true);
	const off = fixture({ reserve: null });
	await off.seed(usage({ utilization: 98, resets_at: iso(NOW + DAY) }));
	assert.equal((await off.runtime.check(sonnet)).ok, true);
});

test("a trigger marked run.quotaReserve starts above the reserve; exhaustion keeps its own wait", async () => {
	const f = fixture({ granted: (job) => job.flow === "deploy" });
	await f.seed(usage({ utilization: 95, resets_at: iso(NOW + DAY) }));
	assert.equal((await f.runtime.check({ ...sonnet, flow: "deploy" })).ok, true);
	assert.equal((await f.runtime.check(sonnet)).wait, "subscription-reserve");
	// The flag is asked with the job, so its trigger can be found.
	assert.equal(f.asked[0].flow, "deploy");
	const exhausted = fixture({ granted: () => true });
	await exhausted.seed(usage({ utilization: 100, resets_at: iso(NOW + DAY) }));
	const result = await exhausted.runtime.check(sonnet);
	assert.deepEqual([result.wait, result.until], ["subscription-quota", NOW + DAY], "an exhausted window waits as exhaustion, marked trigger or not");
	assert.equal(exhausted.asked.length, 0);
});

test("an auxiliary Claude route over the reserve holds the job as an auxiliary wait, which never reselects the root", async () => {
	const f = fixture();
	await f.seed(usage({ utilization: 90, resets_at: iso(NOW + DAY) }));
	const panel = { kind: "github", flow: "review", provider: "openai", model: "gpt-5.5", models: ["openai/gpt-5.5", "anthropic/claude-sonnet-5-5"], auxiliaryModels: ["anthropic/claude-sonnet-5-5"], maxCostMicros: 1_000_000 };
	const held = await f.runtime.check(panel);
	assert.deepEqual([held.wait, held.auxiliary, held.rootManaged], ["subscription-reserve", true, false]);
	assert.equal(new SubscriptionWait(held).auxiliary, true);
	const root = await f.runtime.check({ ...sonnet, auxiliaryModels: ["anthropic/claude-sonnet-5-5"] });
	assert.equal(root.auxiliary, false, "the root's own route is not an auxiliary wait");
});

test("a fallback list's wait names the earliest reset its subscription candidates know, the reserve's and exhaustion's alike", async () => {
	const f = fixture({ rows: [claude, chatgpt] });
	await f.seed(usage({ utilization: 90, resets_at: iso(NOW + 2 * DAY) }));
	await f.seed({ rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.floor((NOW + DAY) / 1000) } } }, chatgpt);
	const job = { ...sonnet, models: ["anthropic/claude-sonnet-5-5", "openai/gpt-5.5"], fallbackModels: ["openai/gpt-5.5"] };
	const result = await selectFailoverJob(job, { redis: null, id: "fallback-reserve", now: () => NOW, checkCandidate: async () => null, subscriptionCheck: (candidate) => f.runtime.check(candidate) });
	assert.deepEqual(result, { wait: "subscription-reserve", until: NOW + MODEL_RECHECK_MS, resetAt: NOW + DAY }, "the first blocker names the reason, the earliest known reset the record");
});

test("the reserve counts the windows admission counts: the reviewed Fable scope does not hold Opus 5.5, and does hold Sonnet", async () => {
	const fable = { limits: [{ kind: "weekly_scoped", group: "weekly", scope: { model: { id: null, display_name: "Fable" }, surface: null }, percent: 96, resets_at: iso(NOW + 2 * DAY) }] };
	const f = fixture();
	await f.seed(usage({ utilization: 30, resets_at: iso(NOW + 2 * DAY) }, fable));
	assert.equal((await f.runtime.check({ ...sonnet, model: "claude-opus-5-5", models: ["anthropic/claude-opus-5-5"] })).ok, true);
	assert.equal((await f.runtime.check(sonnet)).wait, "subscription-reserve");
});

test("quotaReserveBlock: the latest reset among the holding windows, none when one has none, and nothing on a bad reserve", () => {
	const windows = [
		{ usedPercent: 86, resetAt: NOW + DAY, fresh: false },
		{ usedPercent: 90, resetAt: NOW + 2 * DAY, fresh: true },
		{ usedPercent: 84, resetAt: NOW + 3 * DAY, fresh: true },
	];
	assert.deepEqual(quotaReserveBlock({ windows }, 85, NOW), { windows: windows.slice(0, 2), resetAt: NOW + 2 * DAY });
	assert.equal(quotaReserveBlock({ windows: [...windows, { usedPercent: 85, resetAt: null, fresh: true }] }, 85, NOW).resetAt, null);
	for (const percent of [0, 100, 85.5, null, "85"]) assert.equal(quotaReserveBlock({ windows }, percent, NOW), null, String(percent));
	assert.equal(quotaReserveBlock(null, 85, NOW), null);
});

test("status publishes the reserve on the Claude connections this host owns, through the host-status key to its reader", async () => {
	const other = { ...claude, id: "claude-other", connectionId: "claude-other", ownerHost: "elsewhere", state: "other-host" };
	const f = fixture({ rows: [claude, chatgpt, other] });
	const published = (await f.runtime.status()).connections;
	assert.deepEqual(published.map((row) => [row.id, row.reservePercent]), [["claude-main", 85], ["chatgpt-main", undefined], ["claude-other", undefined]]);
	assert.equal((await fixture({ reserve: null }).runtime.status()).connections[0].reservePercent, undefined, "no reserve, no field: an unset reserve publishes what it always did");
	const store = new Map();
	const redis = { async set(key, value) { store.set(key, value); }, async get(key) { return store.get(key) ?? null; } };
	await publishSubscriptionStatus(redis, "owner", f.runtime);
	const read = await readSubscriptionStatus(redis, ["owner"]);
	assert.equal(read.connections.find((row) => row.id === "claude-main").reservePercent, 85);
});

test("the worker wires its reserve from its own config and the flag from its own triggers file", async () => {
	const root = tempDir("quota-reserve-config-");
	const policy = join(root, "connections.json");
	writeFileSync(policy, JSON.stringify({ version: 1, connections: [{ id: "claude-main", provider: "anthropic", adapter: "pi-anthropic-oauth@0.3.6", ownerHost: "owner", root: join(root, "overlay", "packages", "claude"), digest: "a".repeat(64) }, { id: "elsewhere", provider: "openai", adapter: "openai-chatgpt", ownerHost: "other" }], bindings: { anthropic: "claude-main", openai: "elsewhere" } }), { mode: 0o600 });
	const config = { authConnectionsFile: policy, authStoreDir: join(root, "private-auth"), settingsFile: join(root, "settings.json"), workerName: "owner", globalPiDir: join(root, "overlay"), jobsDir: join(root, "jobs"), sandboxDir: join(root, "sandboxes") };
	const published = async (quotaReservePercent) => (await configuredSubscriptions({ config: { ...config, quotaReservePercent }, redis: valkeyFake(), now: () => NOW }).runtime.status()).connections.map((row) => [row.id, row.reservePercent]);
	assert.deepEqual(await published(85), [["claude-main", 85], ["elsewhere", undefined]], "the owned Claude connection, as config.mjs read the setting");
	assert.deepEqual(await published(null), [["claude-main", undefined], ["elsewhere", undefined]]);
	// The flag's reader is the worker's own triggers file, the one its one-shot checks read, handed to the runtime.
	const start = readFileSync(new URL("../src/start.mjs", import.meta.url), "utf8");
	assert.match(start, /configuredSubscriptions\(\{ config, redis, now: \(\) => Number\(now\(\)\), reserveGranted: makeCheckQuotaReserve\(\{ triggersPath: onceTriggersFile \}\) \}\)/);
	assert.ok(start.indexOf("const onceTriggersFile = ") < start.indexOf("reserveGranted: makeCheckQuotaReserve"), "the path is defined before the runtime that reads it");
	assert.match(readFileSync(new URL("../src/subscription-config.mjs", import.meta.url), "utf8"), /makeSubscriptionRuntime\(\{ auth, quota, now, defaultBackend: config\.defaultBackend, quotaReservePercent: config\.quotaReservePercent \?\? null, \.\.\.\(reserveGranted \? \{ reserveGranted \} : \{\}\),/);
});

// ── the worker's read of run.quotaReserve ──────────────────────────────────────────────────────────────────────────

const forgeEntry = (quotaReserve) => ({ on: { type: "label", any: ["deploy"] }, run: { kind: "github", flow: "deploy", ...(quotaReserve === undefined ? {} : { quotaReserve }) } });
const cronEntry = (quotaReserve) => ({ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/app", flow: "fix", task: "Fix the build", ...(quotaReserve === undefined ? {} : { quotaReserve }) } });
const localEventEntry = (quotaReserve) => ({ on: { type: "pull_request", forge: "github", id: "maint", action: ["opened"] }, run: { kind: "local", worker: "owner", folder: "/srv/maint", command: "maintain", ...(quotaReserve === undefined ? {} : { quotaReserve }) } });
const forgeJob = { kind: "github", flow: "deploy", trigger: { matched: { index: 0, type: "label", label: "deploy" } } };
const cronJob = { kind: "local", folder: "/srv/app", flow: "fix", task: "Fix the build", trigger: { id: "nightly" } };
const localEventJob = { kind: "local", worker: "owner", folder: "/srv/maint", command: "maintain", localEvent: { id: "maint", forge: "github", type: "pull_request", worker: "owner", generation: "b".repeat(32), digest: "a".repeat(64) }, trigger: { id: "maint" } };
function triggersFile(triggers, extra = {}) {
	const path = join(tempDir("quota-reserve-"), "triggers.json");
	writeFileSync(path, `${JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers, ...extra }, null, 2)}\n`);
	return path;
}

test("the worker reads run.quotaReserve from the trigger that queued the job: forge, cron and local event, by identity", () => {
	const marked = makeCheckQuotaReserve({ triggersPath: triggersFile([forgeEntry(true), cronEntry(true), localEventEntry(true)]) });
	assert.equal(marked(forgeJob), true);
	assert.equal(marked(cronJob), true);
	assert.equal(marked(localEventJob), true);
	const unmarked = makeCheckQuotaReserve({ triggersPath: triggersFile([forgeEntry(false), cronEntry(), localEventEntry()]) });
	assert.equal(unmarked(forgeJob) || unmarked(cronJob) || unmarked(localEventJob), false);
	// Another trigger at the job's index, a cron entry that is not the job's, a job with no trigger: nothing granted.
	const moved = makeCheckQuotaReserve({ triggersPath: triggersFile([{ ...forgeEntry(true), run: { kind: "github", flow: "review", quotaReserve: true } }, cronEntry(true)]) });
	assert.equal(moved(forgeJob), false);
	assert.equal(moved({ ...cronJob, task: "Another task" }), false);
	assert.equal(moved({ kind: "github", flow: "deploy" }), false);
	assert.equal(moved(null), false);
});

test("a local event job's flag is its own entry's: another forge, or an edited folder, command or worker, grants nothing", () => {
	const flagFor = (entry) => makeCheckQuotaReserve({ triggersPath: triggersFile([entry]) })(localEventJob);
	assert.equal(flagFor(localEventEntry(true)), true);
	const otherForge = { ...localEventEntry(true), on: { ...localEventEntry(true).on, forge: "forgejo" } };
	assert.doesNotThrow(() => parseTriggers(JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [otherForge] }), "/t.json"), "a file the loader takes, so only the forge differs");
	assert.equal(flagFor(otherForge), false, "the same on.id on another forge");
	for (const [key, value] of [["folder", "/srv/other"], ["command", "maintain-all"], ["worker", "another-host"]]) {
		assert.equal(flagFor({ ...localEventEntry(true), run: { ...localEventEntry(true).run, [key]: value } }), false, key);
	}
});

test("a cron job's flag is a cron entry's: a local event listener sharing its id and its folder and command grants nothing", () => {
	// Cron, local event and watch ids are separate namespaces, so a listener may carry a cron trigger's id. (A watch rule
	// cannot carry the flag at all: the loader refuses it there.)
	const cronCommandJob = { kind: "local", folder: "/srv/maint", command: "maintain", trigger: { id: "maint" } };
	const listener = localEventEntry(true);
	assert.equal(makeCheckQuotaReserve({ triggersPath: triggersFile([listener]) })(cronCommandJob), false);
	const cron = { on: { type: "cron", id: "maint", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/maint", command: "maintain", quotaReserve: true } };
	assert.equal(makeCheckQuotaReserve({ triggersPath: triggersFile([listener, cron]) })(cronCommandJob), true, "its own cron entry still grants");
});

test("every doubt about the file grants nothing, and a changed file is read again", () => {
	const dir = tempDir("quota-reserve-doubt-");
	const absent = makeCheckQuotaReserve({ triggersPath: join(dir, "missing.json") });
	assert.equal(absent(forgeJob), false);
	assert.equal(makeCheckQuotaReserve({ triggersPath: "" })(forgeJob), false);
	const broken = join(dir, "broken.json");
	writeFileSync(broken, JSON.stringify({ triggers: [{ ...forgeEntry(true), run: { ...forgeEntry(true).run, quotaReserve: "true" } }] }));
	assert.equal(makeCheckQuotaReserve({ triggersPath: broken })(forgeJob), false, "an entry the loader refuses grants nothing");
	const newer = join(dir, "newer.json");
	writeFileSync(newer, JSON.stringify({ version: TRIGGERS_FILE_VERSION + 1, triggers: [forgeEntry(true)] }));
	assert.equal(makeCheckQuotaReserve({ triggersPath: newer })(forgeJob), false, "a newer pi-dispatch's file is no evidence");
	// The mtime-and-size cache: taking the flag off holds the next pickup.
	const live = join(dir, "live.json");
	writeFileSync(live, JSON.stringify({ triggers: [forgeEntry(true)] }));
	const check = makeCheckQuotaReserve({ triggersPath: live });
	assert.equal(check(forgeJob), true);
	writeFileSync(live, JSON.stringify({ triggers: [forgeEntry(false)] }, null, 1));
	assert.equal(check(forgeJob), false);
});

test("the loader takes run.quotaReserve as a strict boolean on every kind but a watch rule, and never normalizes it into a job", () => {
	const load = (entry, extra = {}) => parseTriggers(JSON.stringify({ version: TRIGGERS_FILE_VERSION, triggers: [entry], ...extra }), "/t.json");
	for (const entry of [forgeEntry(true), forgeEntry(false), cronEntry(true), localEventEntry(true)]) assert.equal(Object.hasOwn(load(entry)[0].run, "quotaReserve"), false, JSON.stringify(entry.on));
	for (const value of ["true", 1, null, {}]) assert.throws(() => load(forgeEntry(value)), /run\.quotaReserve must be true or false/, JSON.stringify(value));
	const watch = { on: { type: "watch", id: "errors", source: "prod", fingerprint: ["service"], minCount: 1, window: "1s", cooldown: "1m", maxPerDay: 1 }, run: { kind: "local", folder: "/srv/w", flow: "triage", task: "Investigate", maxCostUsd: "0.40", quotaReserve: true } };
	assert.throws(() => load(watch, { watchSources: { prod: { verify: "hmac-sha256", secretEnv: "WATCH_SECRET" } } }), /run\.quotaReserve is not available on a watch rule/);
});

// ── doctor ─────────────────────────────────────────────────────────────────────────────────────────────────────────

test("doctor compares each owned connection's windows with the reserve by admission's own rule", async () => {
	const f = fixture({ rows: [claude, chatgpt] });
	await f.seed(usage({ utilization: 89, resets_at: iso(NOW + 3 * DAY) }));
	const env = { PI_QUOTA_RESERVE_PERCENT: "85", PI_AUTH_CONNECTIONS_FILE: "/d/auth-connections.json" };
	const read = (row) => f.quota.read(subscriptionIdentity(row));
	const lines = await quotaReserveChecks(env, { connections: async () => [claude, chatgpt, { ...claude, id: "far", state: "other-host" }], readQuota: read, now: () => NOW });
	assert.deepEqual(lines.map((line) => [line.ok, line.warn, line.label]), [
		[true, undefined, `Quota reserve 85% (anthropic claude-main): the seven-day window at 89% (resets ${iso(NOW + 3 * DAY)}) is at or above it, so jobs of triggers without run.quotaReserve wait until it drops below it or resets`],
		[true, undefined, "Quota reserve 85% (openai chatgpt-main): does not apply, since a ChatGPT connection publishes no usage percentages, so its jobs are never held by it"],
	]);
	f.setTime(NOW + MINUTE);
	await f.seed(usage({ utilization: 40, resets_at: iso(NOW + 3 * DAY) }));
	const under = await quotaReserveChecks(env, { connections: async () => [claude], readQuota: read, now: () => NOW + MINUTE });
	assert.equal(under[0].label, `Quota reserve 85% (anthropic claude-main): no window holds jobs back (five-hour window at 20% (resets ${iso(NOW + 3 * 3_600_000)}), seven-day window at 40% (resets ${iso(NOW + 3 * DAY)}))`);
	const unread = await quotaReserveChecks(env, { connections: async () => [claude], readQuota: async () => null, now: () => NOW });
	assert.deepEqual([unread[0].ok, unread[0].warn, unread[0].label], [false, true, "Quota reserve 85% (anthropic claude-main): its quota could not be read, so nothing is said of its usage"]);
	const unseen = await quotaReserveChecks(env, { connections: async () => [{ ...claude, accountGroup: null }], readQuota: () => assert.fail("no identity to read"), now: () => NOW });
	assert.match(unseen[0].label, /no usage observed yet/);
	// Off, a bad value (the boot refusal is another line) or no connection policy: nothing at all.
	for (const off of [{}, { PI_QUOTA_RESERVE_PERCENT: "" }, { PI_QUOTA_RESERVE_PERCENT: "100", PI_AUTH_CONNECTIONS_FILE: "/d/a.json" }, { PI_QUOTA_RESERVE_PERCENT: "85" }]) {
		assert.deepEqual(await quotaReserveChecks(off, { connections: () => assert.fail("not read"), readQuota: () => assert.fail("not read"), now: () => NOW }), [], JSON.stringify(off));
	}
});

test("collectChecks prints the reserve's lines: the triggers file the worker reads the flag from, and each owned connection", async () => {
	const root = tempDir("doctor-reserve-");
	const f = fixture();
	await f.seed(usage({ utilization: 91, resets_at: iso(NOW + DAY) }));
	const auth = { async check(provider) { return provider === "anthropic" ? { ok: true, managed: true, ...claude } : { ok: true, managed: false }; }, async status() { return [claude]; } };
	const seen = [];
	const run = (extra, fileExists) => collectChecks({ PI_PROVIDER: "anthropic", PI_MODEL: "claude-sonnet-5-5", PI_WORKER_NAME: "owner", PI_AUTH_CONNECTIONS_FILE: "connections.json", PI_AUTH_STORE_DIR: "private", PI_QUOTA_RESERVE_PERCENT: "85", ...extra }, { cwd: root, home: root, out() {}, spawn: () => { throw Object.assign(new Error("not installed"), { code: "ENOENT" }); }, fileExists, probeValkey: async () => false, nodeVersion: "22.19.0", platform: "linux", agentDir: join(root, "agent"), wallClock: () => NOW, subscriptionFactory: () => ({ auth }), readSubscriptionQuota: async (url, row, options) => (seen.push([row.id, options.now()]), f.quota.read(subscriptionIdentity(row))) });
	const reserveLines = (checks) => checks.filter((check) => check.label?.startsWith("Quota reserve")).map((check) => [check.ok, check.warn, check.label, check.fix]);
	// No triggers file where the worker looks: no trigger can use the reserve.
	const absent = reserveLines(await run({}, () => false));
	assert.deepEqual(absent[0], [false, true, `Quota reserve 85%: this host's worker reads run.quotaReserve from ${join(root, "triggers.json")}, which does not exist here, so no trigger can use the reserve and every job on its Claude connections waits while a window stands at or above it`, "put the deployment's triggers file at that path on this host, or point PI_TRIGGERS_FILE at it"]);
	assert.deepEqual(absent[1], [true, undefined, `Quota reserve 85% (anthropic claude-main): the seven-day window at 91% (resets ${iso(NOW + DAY)}) is at or above it, so jobs of triggers without run.quotaReserve wait until it drops below it or resets`, undefined]);
	assert.deepEqual(seen, [["claude-main", NOW]]);
	// A file it reads, with one marked trigger of two.
	const path = triggersFile([forgeEntry(true), cronEntry()]);
	assert.deepEqual(reserveLines(await run({ PI_TRIGGERS_FILE: path }, existsSync))[0], [true, undefined, `Quota reserve 85%: this host's worker reads run.quotaReserve from ${path}, where 1 trigger sets it`, undefined]);
	assert.match(reserveLines(await run({ PI_TRIGGERS_FILE: triggersFile([forgeEntry(false)]) }, existsSync))[0][2], /where no trigger sets it, so every job on its Claude connections waits while a window stands at or above the reserve$/);
	// One it refuses, and one a newer release wrote.
	const refused = join(root, "refused.json");
	writeFileSync(refused, JSON.stringify({ triggers: [{ ...forgeEntry(true), run: { ...forgeEntry(true).run, quotaReserve: "yes" } }] }));
	const newer = join(root, "newer.json");
	writeFileSync(newer, JSON.stringify({ version: TRIGGERS_FILE_VERSION + 1, triggers: [forgeEntry(true)] }));
	for (const [file, words, fix] of [[refused, "does not load", "fix the triggers file so it loads (its own line names why)"], [newer, "was written by a newer pi-dispatch", "upgrade pi-dispatch on this host"]]) {
		const [line] = reserveLines(await run({ PI_TRIGGERS_FILE: file }, existsSync));
		assert.deepEqual([line[0], line[1], line[3]], [false, true, fix], file);
		assert.ok(line[2].startsWith(`Quota reserve 85%: this host's worker reads run.quotaReserve from ${file}, which ${words}, so no trigger can use the reserve`), line[2]);
	}
	// A host that owns no Claude connection gets no file line.
	const chatgptOnly = { ...auth, async status() { return [chatgpt]; } };
	const lines = reserveLines(await collectChecks({ PI_PROVIDER: "openai", PI_MODEL: "gpt-5.5", PI_WORKER_NAME: "owner", PI_AUTH_CONNECTIONS_FILE: "connections.json", PI_QUOTA_RESERVE_PERCENT: "85" }, { cwd: root, home: root, out() {}, spawn: () => { throw Object.assign(new Error("not installed"), { code: "ENOENT" }); }, fileExists: () => false, probeValkey: async () => false, nodeVersion: "22.19.0", platform: "linux", agentDir: join(root, "agent"), wallClock: () => NOW, subscriptionFactory: () => ({ auth: chatgptOnly }) }));
	assert.deepEqual(lines.map((line) => line[2]), ["Quota reserve 85% (openai chatgpt-main): does not apply, since a ChatGPT connection publishes no usage percentages, so its jobs are never held by it"]);
});

test("doctor names a scoped window as holding only its models, and says why an unreadable or stale window holds nothing", async () => {
	const env = { PI_QUOTA_RESERVE_PERCENT: "85", PI_AUTH_CONNECTIONS_FILE: "/d/auth-connections.json" };
	const scoped = { windows: [{ window: "seven-day", scope: "scoped", usedPercent: 96, resetAt: NOW + DAY, fresh: true }, { window: "five-hour", scope: "account", usedPercent: 20, resetAt: NOW + MINUTE, fresh: true }] };
	const lineOf = async (status) => (await quotaReserveChecks(env, { connections: async () => [claude], readQuota: async () => status, now: () => NOW }))[0].label;
	assert.equal(await lineOf(scoped), `Quota reserve 85% (anthropic claude-main): the seven-day scoped window at 96% (resets ${iso(NOW + DAY)}) is at or above it, so jobs of triggers without run.quotaReserve on the models it covers wait until it drops below it or resets`);
	const mixed = { windows: [scoped.windows[0], { window: "five-hour", scope: "account", usedPercent: 90, resetAt: NOW + MINUTE, fresh: true }] };
	assert.match(await lineOf(mixed), /are at or above it, so jobs of triggers without run\.quotaReserve wait until they drop below it or reset \(a scoped window holds only the jobs of the models it covers\)$/);
	const notes = { windows: [{ window: "five-hour", scope: "account", usedPercent: 90, resetAt: null, fresh: false }, { window: "seven-day", scope: "account", usedPercent: null, resetAt: null, fresh: true }, { window: "other", scope: "scoped", usedPercent: null, resetAt: null, fresh: true }] };
	assert.equal(await lineOf(notes), "Quota reserve 85% (anthropic claude-main): no window holds jobs back (five-hour window at 90%); 2 windows without a reading, which never holds; a stale reading at or above it with no reset is read again before the next job starts");
});

