import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as retention from "../src/retention.mjs";
import { FORGE_JOB_RETENTION_DAYS, FORGE_JOB_RETENTION_MS, FORGE_JOB_RETENTION_S, LOCAL_JOB_KEPT_COMPLETED_S, LOCAL_JOB_KEPT_FAILED_S, RUN_MIRROR_MAX_RUNS_DEFAULT, RUN_MIRROR_MAX_RUNS_MAX, RUN_MIRROR_MAX_RUNS_MIN, runMirrorMaxRunsOf } from "../src/retention.mjs";
import { APPROVAL_FINISHED_TTL_MS, makeApprovalStore } from "../src/approval-state.mjs";
import { CONSOLE_TRAIL_CLAIM_MS } from "../src/processor.mjs";
import { RUNS_INDEX_MAX } from "../src/run-mirror.mjs";
import { enqueueAnswerDraftJob, enqueueForgeJob, enqueueLateForgeJob, enqueueLocalJob, enqueueQuestionGroupJob } from "../src/queue.mjs";
import { loadSchedules } from "../src/schedules.mjs";
import { approvalExpiryJobOpts } from "../src/start.mjs";

// How long the queue keeps a finished job, and the markers that stand in for a job key once it is gone (issue #761):
// one value in one leaf module, every site derived from it, the units each call takes pinned through the real options
// objects, and a source scan so a literal cannot come back beside the constant.

const DAY_S = 86_400;
const DAY_MS = DAY_S * 1000;

test("the values: a forge job is kept 31 days, a local job a day after it completes and a week after it fails", () => {
	assert.equal(FORGE_JOB_RETENTION_DAYS, 31);
	assert.equal(FORGE_JOB_RETENTION_S, 2_678_400);
	assert.equal(FORGE_JOB_RETENTION_MS, 2_678_400_000);
	assert.equal(FORGE_JOB_RETENTION_S, FORGE_JOB_RETENTION_DAYS * DAY_S, "seconds");
	assert.equal(FORGE_JOB_RETENTION_MS, FORGE_JOB_RETENTION_S * 1000, "milliseconds");
	assert.equal(LOCAL_JOB_KEPT_COMPLETED_S, 86_400);
	assert.equal(LOCAL_JOB_KEPT_FAILED_S, 604_800);
	assert.deepEqual([RUN_MIRROR_MAX_RUNS_MIN, RUN_MIRROR_MAX_RUNS_DEFAULT, RUN_MIRROR_MAX_RUNS_MAX], [1_000, 5_000, 20_000]);
	assert.equal(RUNS_INDEX_MAX, RUN_MIRROR_MAX_RUNS_DEFAULT, "the run mirror's built-in cap is the setting's default");
});

test("retention.mjs is a leaf, exported as @edgehero/pi-dispatch/retention, and that subpath resolves to it", async () => {
	const src = readFileSync(new URL("../src/retention.mjs", import.meta.url), "utf8");
	assert.equal(/^\s*import\s/m.test(src), false, "no import statement");
	assert.equal(/\bimport\s*\(/.test(src), false, "no dynamic import");
	assert.equal(/\brequire\s*\(/.test(src), false, "no require");
	const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
	assert.equal(pkg.exports["./retention"], "./src/retention.mjs");
	// The receiver and the admin import it by this name: the self-reference resolves through the same exports map.
	assert.equal(await import("@edgehero/pi-dispatch/retention"), retention);
});

test("runMirrorMaxRunsOf reads the cap leniently: the default for unset, empty or anything out of bounds, with the problem named", () => {
	for (const raw of [undefined, null, ""]) assert.deepEqual(runMirrorMaxRunsOf(raw), { value: 5_000 }, String(raw));
	for (const [raw, value] of [["1000", 1_000], ["20000", 20_000], [" 7500 ", 7_500], [12_000, 12_000]]) assert.deepEqual(runMirrorMaxRunsOf(raw), { value }, JSON.stringify(raw));
	for (const raw of ["999", "20001", "abc", "1.5", "-1", "0", " ", "1e4", "05000", "+5000", 999]) assert.deepEqual(runMirrorMaxRunsOf(raw), { value: 5_000, problem: "not an integer 1000-20000" }, JSON.stringify(raw));
});

test("the approval's finished mark is a day past a forge job's retention, 32 days, and its script text is the literal's", async () => {
	assert.ok(APPROVAL_FINISHED_TTL_MS > FORGE_JOB_RETENTION_MS, "outlives every queued job that can still carry the request id");
	assert.equal(APPROVAL_FINISHED_TTL_MS, 32 * DAY_MS);
	assert.equal(APPROVAL_FINISHED_TTL_MS, FORGE_JOB_RETENTION_MS + DAY_MS);
	// The value is interpolated into the transition script, which `redis.eval` sends as text: the derived value prints as
	// the plain integer the literal did, so the script a server caches is the same one.
	const scripts = [];
	const at = Date.parse("2026-11-03T12:00:00Z");
	const stored = { version: 1, state: "pending", requestId: "request-1", runId: "run-1", kind: "github", repo: "org/repo", target: { type: "issue", number: 761 }, action: "budget-raise", toolCallId: "call-1", configDigest: "abc", sessionKey: "session-1", host: "host-1", createdAt: at, expiresAt: at + 1000 };
	const store = makeApprovalStore({
		redis: {
			get: async () => JSON.stringify(stored),
			eval: async (script) => (scripts.push(script), ["refused", "not-claimed"]),
		},
		now: () => at,
	});
	assert.deepEqual(await store.finish({ requestId: "request-1", jobId: "job-1" }), { refused: "not-claimed" });
	assert.equal(scripts.length, 1);
	assert.ok(scripts[0].includes("if op == 'finish' or op == 'cancel' then redis.call('PEXPIRE', KEYS[1], 2764800000) end"), "the PEXPIRE line, byte for byte");
});

test("the console answer's trail claim lives exactly a forge job's retention, in milliseconds", () => {
	assert.equal(CONSOLE_TRAIL_CLAIM_MS, FORGE_JOB_RETENTION_MS);
});

/** A queue that records every add, enough for the builders below (the binding read finds nothing). */
function recordingQueue() {
	const adds = [];
	const redis = {
		eval() {
			throw new Error("binding must only read");
		},
		get: async () => null,
	};
	return {
		adds,
		name: "pi-jobs",
		client: Promise.resolve(redis),
		async add(name, data, opts) {
			adds.push({ name, data, opts });
			return { id: opts.jobId };
		},
		async getJob() {
			return null;
		},
	};
}

const retained = (opts) => [opts.removeOnComplete, opts.removeOnFail];

test("every forge-kind job the queue adds is kept FORGE_JOB_RETENTION_S, BullMQ's age in seconds, its counts unchanged", async () => {
	const q = recordingQueue();
	const forge = { repo: "acme/web", target: { type: "issue", number: 7 }, flow: "fix", trigger: { deliveryId: "d-761", sender: { id: 1 } } };
	await enqueueForgeJob(q, "github", forge);
	await enqueueLateForgeJob(q, "github", { ...forge, trigger: { ...forge.trigger, deliveryId: "d-late" } });
	await enqueueAnswerDraftJob(q, { runId: "run-1", ruleId: "rule-1", draftRunId: `answer-draft-${"a".repeat(40)}` });
	await enqueueQuestionGroupJob(q, { runId: "run-1", digest: "b".repeat(64), configDigest: "c".repeat(64) }, { nonce: () => "n-1" });
	const [onDelivery, late, draft, grouping] = q.adds;
	assert.deepEqual(retained(onDelivery.opts), [{ age: FORGE_JOB_RETENTION_S }, { age: FORGE_JOB_RETENTION_S }], "a delivery's job");
	assert.deepEqual(retained(late.opts), [{ age: FORGE_JOB_RETENTION_S }, { age: FORGE_JOB_RETENTION_S }], "a late message's job");
	assert.deepEqual(retained(draft.opts), [{ age: FORGE_JOB_RETENTION_S, count: 5000 }, { age: FORGE_JOB_RETENTION_S, count: 5000 }], "an answer draft");
	assert.deepEqual(retained(grouping.opts), [{ age: FORGE_JOB_RETENTION_S, count: 5000 }, { age: FORGE_JOB_RETENTION_S, count: 5000 }], "a question grouping");
	assert.deepEqual(retained(approvalExpiryJobOpts("approval-expiry-r1")), [{ age: FORGE_JOB_RETENTION_S }, { age: FORGE_JOB_RETENTION_S }], "an approval's expiry job");
	assert.deepEqual(approvalExpiryJobOpts("approval-expiry-r1"), { jobId: "approval-expiry-r1", attempts: 2, backoff: { type: "exponential", delay: 5000 }, removeOnComplete: { age: 2_678_400 }, removeOnFail: { age: 2_678_400 } });
});

test("a local job and a cron tick are kept LOCAL_JOB_KEPT_*_S, in seconds", async () => {
	const q = recordingQueue();
	await enqueueLocalJob(q, { folder: "/srv/site", flow: "tidy", task: "t", now: new Date("2026-11-03T09:00:00Z") });
	assert.deepEqual(retained(q.adds[0].opts), [{ age: LOCAL_JOB_KEPT_COMPLETED_S }, { age: LOCAL_JOB_KEPT_FAILED_S }]);
	const [cron] = loadSchedules({ triggersFile: "/triggers.json" }, {
		readFileSync: () => JSON.stringify({ triggers: [{ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/proj", flow: "tidy", task: "t" } }] }),
		existsSync: () => true,
	});
	assert.deepEqual(cron.opts, { removeOnComplete: { age: LOCAL_JOB_KEPT_COMPLETED_S }, removeOnFail: { age: LOCAL_JOB_KEPT_FAILED_S } });
});

test("the approval expiry comment's one-per-request mark is set for the finished request's lifetime, PX in milliseconds", () => {
	// The mark is written inside the wiring's closure, so its call is read from the source: `PX` with the millisecond
	// constant, never a seconds value and never a literal.
	const start = readFileSync(new URL("../src/start.mjs", import.meta.url), "utf8");
	assert.match(start, /redis\.set\(`run:approval:expiry-comment:\$\{request\.requestId\}`, "1", "PX", APPROVAL_FINISHED_TTL_MS, "NX"\)/);
	assert.match(start, /await queue\.add\(request\.kind, \{[\s\S]{0,400}?\}, approvalExpiryJobOpts\(jobId\)\);/, "the expiry job is added with the shared options");
});

// THE SOURCE SCAN. A forge retention written as a number is how a site drifts from the constant: refused in every tree
// that runs in a deployment. Each exemption names the one line it allows and why that number is not this retention; an
// exemption that no longer matches anything fails too, so the list cannot outlive what it excuses.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TREES = ["worker/src", "receiver/src", "admin/src"];
const SKIP_DIRS = new Set(["node_modules", "dist", "test"]);
const SOURCE_EXTS = new Set([".mjs", ".js", ".cjs", ".ts", ".mts"]);
// A day's factor, as a whole token: hours (24), minutes (1440), a day in seconds or milliseconds in these spellings
// (86400, 86_400, 864e2, 8.64e4, 86400000, 86_400_000, 86400e3, 864e5, 86.4e6, 8.64e7), or a name with "day" in it
// (DAY_MS, ONE_DAY_S, dayMs). 31 is a forge retention when it multiplies one, on either side and through any other
// factors (`31 * 24 * 3600`, `86400 * 31`, `24 * 3600 * 31`, `DAY_MS * 31`), brackets read through. 2678400 (2_678_400,
// 2.6784e6) is 31 days in seconds, and 2.6784e9, or 2678400000 by its leading digits, the same in milliseconds. The
// scan also takes `_` between any digit groups and a capital `E`, reads one line at a time, and misses every other
// spelling (`8.64e+7`, a BigInt) and a product split across lines.
// A bare `* 31` is not refused: a string hash multiplies by 31 (fleet-lease.mjs).
const DAY_FACTOR = String.raw`(?:24|1_?440|86_?400(?:_?000|e3)?|864e[25]|8\.64e[47]|86\.4e6|\w*day\w*)`;
const RETENTION_LITERAL = new RegExp(String.raw`\b31\s*\*\s*(?:[\w.]+\s*\*\s*)*${DAY_FACTOR}\b|\b${DAY_FACTOR}\s*\*\s*(?:[\w.]+\s*\*\s*)*31\b|2_?678_?400|2\.6784e[69]`, "i");
const retentionLiteralIn = (text) => RETENTION_LITERAL.test(text.replace(/[()]/g, ""));
const EXEMPT = [
	{ file: "worker/src/watch-issue.mjs", line: /'PX',2678400000\)/, why: "a watch issue's activity mark: the 30-day watch duration ceiling (watch-contract.mjs) plus a day, not a job's retention" },
	{ file: "worker/src/oauth-openai.mjs", line: /data\.expires_in > 31 \* 24 \* 3600/, why: "the longest token lifetime an OAuth answer may claim, a bound on the provider's response" },
	{ file: "worker/src/community-auth-helper.mjs", line: /data\.expires_in > 31 \* 24 \* 3600/, why: "the same OAuth token lifetime bound, for a community adapter's answer" },
];

function sourceFiles(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		if (statSync(path).isDirectory()) {
			if (!SKIP_DIRS.has(name)) out.push(...sourceFiles(path));
		} else if (SOURCE_EXTS.has(extname(name))) out.push(path);
	}
	return out;
}

test("the scan's pattern: 31 times a day's factor in either order, through other factors and brackets, and 2678400; never a hash's 31 or a near number", () => {
	const refused = [
		"31 * 24 * 3600", "31 * 24 * 60 * 60 * 1000", "31 * 86400", "31 * 86_400", "31 * 86400000", "31 * 864e5", "31 * DAY_MS", "31 * 1440",
		"86400 * 31", "86_400 * 31", "24 * 3600 * 31", "3600 * 24 * 31", "60 * 60 * 24 * 31", "1000 * 86400 * 31", "DAY_MS * 31", "ONE_DAY_S * 31",
		"dayMs * 31", "(24 * 3600) * 31", "31 * (24 * 3600)", "age: 2678400", "age: 2_678_400", "PX, 2678400000",
		"31 * 86400e3", "31 * 86_400e3", "31 * 8.64e4", "31 * 8.64e7", "31 * 86.4e6", "8.64e7 * 31", "86.4e6 * 31", "age: 2.6784e6", "PX, 2.6784e9",
	];
	for (const text of refused) assert.equal(retentionLiteralIn(text), true, text);
	const allowed = ["h = (h * 31 + s.charCodeAt(i)) | 0", "31", "day 31", "131 * 24", "24 * 310", "31 * 240", "30 * 24 * 3600", "24 * 3600 * 30", "86400 * 32", "DAY_MS * 7", "31 + 24", "31 * 86400e2", "31 * 8.64e5", "31 * 86.4e5"];
	for (const text of allowed) assert.equal(retentionLiteralIn(text), false, text);
});

test("no forge retention is written as a number in worker/src, receiver/src or admin/src outside the named exemptions", () => {
	const offences = [];
	const used = new Map(EXEMPT.map((e) => [e, 0]));
	for (const tree of TREES) {
		for (const path of sourceFiles(join(REPO_ROOT, tree))) {
			const file = relative(REPO_ROOT, path).split("\\").join("/");
			readFileSync(path, "utf8")
				.split("\n")
				.forEach((text, i) => {
					if (!retentionLiteralIn(text)) return;
					const exemption = EXEMPT.find((e) => e.file === file && e.line.test(text));
					if (exemption) used.set(exemption, used.get(exemption) + 1);
					else offences.push(`${file}:${i + 1}: ${text.trim().slice(0, 160)}`);
				});
		}
	}
	assert.deepEqual(offences, [], "derive it from retention.mjs (FORGE_JOB_RETENTION_S / _MS / _DAYS), or name an exemption with its reason");
	for (const [e, n] of used) assert.equal(n, 1, `the exemption for ${e.file} matches exactly one line (${e.why})`);
});
