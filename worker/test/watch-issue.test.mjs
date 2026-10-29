import assert from "node:assert/strict";
import { test } from "node:test";
import { makeWatchIssuePublisher, issueIdentity } from "../src/watch-issue.mjs";
function fakeRedis() {
	const values = new Map(); const sorted = new Map();
	const redis = {
		async set(key, value, nx) { if (nx === "NX" && values.has(key)) return null; values.set(key, value); return "OK"; },
		async get(key) { return values.get(key) ?? null; },
		async zadd(key, score, member) { if (!sorted.has(key)) sorted.set(key, new Map()); sorted.get(key).set(member, Number(score)); },
		async zrem(key, member) { sorted.get(key)?.delete(member); },
		async zrangebyscore(key, _min, max) { return [...(sorted.get(key) ?? [])].filter(([, score]) => score <= max).sort((a, b) => a[1] - b[1]).slice(0, 128).map(([member]) => member); },
		async eval(script, count, ...args) {
			const keys = args.slice(0, count); const argv = args.slice(count);
			if (script.startsWith("-- watch-issue-activity")) {
				if (!values.has(keys[1])) return JSON.stringify({ at: argv[0], version: 0 });
				const old = JSON.parse(values.get(keys[0]) ?? '{"at":0,"version":0}'); const activity = { at: Math.max(old.at, argv[0]), version: old.version + 1 };
				values.set(keys[0], JSON.stringify(activity)); const mapping = JSON.parse(values.get(keys[1]) ?? "null");
				if (mapping?.closeAfterMs && mapping.state === "mapped") await redis.zadd(keys[2], activity.at + mapping.closeAfterMs, argv[1]);
				return JSON.stringify(activity);
			}
			if (script.startsWith("-- watch-issue-reserve")) {
				if (values.has(keys[0])) return JSON.stringify({ owner: false, mapping: JSON.parse(values.get(keys[0])) });
				if ((sorted.get(keys[1])?.size ?? 0) >= argv[0]) return JSON.stringify({ capped: true });
				values.set(keys[0], argv[3]); await redis.zadd(keys[1], argv[1], argv[2]); return JSON.stringify({ owner: true, mapping: JSON.parse(argv[3]) });
			}
			if (script.startsWith("-- watch-issue-close-claim")) {
				if (values.get(keys[0]) !== argv[0] || values.get(keys[1]) !== argv[1] || values.has(keys[2])) return 0;
				values.set(keys[2], argv[2]); return 1;
			}
			if (script.startsWith("-- watch-issue-close-commit")) {
				if (values.get(keys[2]) !== argv[0] || values.get(keys[0]) !== argv[1] || values.get(keys[1]) !== argv[2]) return 0;
				values.set(keys[0], argv[3]); await redis.zrem(keys[3], argv[4]); return 1;
			}
			if (script.startsWith("-- watch-issue-unlock")) { if (values.get(keys[0]) === argv[0]) values.delete(keys[0]); return 1; }
			assert.fail("unexpected redis script");
		},
	};
	return { redis, values, sorted };
}
function fixture({ uncertain = false, reconciliation = true, maxPerSource = 4096, close = async () => {}, canClose = async () => true, reportClose = async () => {} } = {}) {
	const { redis, values, sorted } = fakeRedis(); const calls = []; let issue; let clock = 1000;
	const adapter = { async closeIssue(args) { calls.push(["close", args]); await close(args); }, async findIssue(input) { calls.push(["find", input]); return reconciliation ? issue : null; }, async createIssue(input) { calls.push(["create", input]); issue = { id: 12 }; if (uncertain) throw new Error("private remote response"); return issue; }, async updateIssue(input) { calls.push(["update", input]); } };
	return { publish: makeWatchIssuePublisher({ redis, adapter, now: () => clock, maxPerSource, canClose, reportClose }), calls, redis, values, sorted, setNow: value => { clock = value; } };
}
const input = () => ({ source: "prod", ruleId: "errors", fingerprint: "a".repeat(64), target: { kind: "github", repo: "owner/repo" }, finding: { count: 10, severity: "error", samples: ["private credential attacker instructions"], fields: { service: "private account" } } });
test("one issue per fingerprint updates later digest and never publishes samples or structured values", async () => {
	const { publish, calls } = fixture(); assert.deepEqual(await publish(input()), { status: "created", issueId: "12" }); assert.deepEqual(await publish(input()), { status: "updated", issueId: "12" });
	assert.equal(calls.filter(([name]) => name === "create").length, 1); assert.doesNotMatch(JSON.stringify(calls), /private credential|private account|samples/);
});
test("an uncertain create is reconciled by marker without creating a second issue", async () => {
	const { publish, calls } = fixture({ uncertain: true }); await assert.rejects(publish(input()), /outcome unknown/);
	assert.deepEqual(await publish(input()), { status: "updated", issueId: "12" }); assert.equal(calls.filter(([name]) => name === "create").length, 1); assert.match(calls.find(([name]) => name === "find")[1].marker, /^pi-dispatch-watch:/);
});
test("uncertain create without a visible marker refuses another create and names the uncertainty", async () => {
	const { publish, calls } = fixture({ uncertain: true, reconciliation: false }); await assert.rejects(publish(input())); assert.deepEqual(await publish(input()), { status: "uncertain", reason: "watch-issue-uncertain" }); assert.equal(calls.filter(([name]) => name === "create").length, 1);
});
test("concurrent findings never call create twice", async () => {
	const { publish, calls } = fixture(); await Promise.all(Array.from({ length: 20 }, () => publish(input()))); assert.equal(calls.filter(([name]) => name === "create").length, 1);
});

test("quiet policy never changes remote issue identity and disabled quiet closing makes no remote close", async () => {
	assert.equal(issueIdentity(input().target, "prod", "errors", "a".repeat(64)), issueIdentity({ ...input().target, closeAfter: "1h" }, "prod", "errors", "a".repeat(64)));
	const f = fixture(); await f.publish(input()); f.setNow(99999999); assert.deepEqual(await f.publish.sweep(), []);
	assert.equal(f.calls.filter(([method]) => method === "close").length, 0);
});
test("source issue index cap refuses new fingerprint before forge calls while mapped retries still update", async () => {
	const f = fixture({ maxPerSource: 1 }); await f.publish(input());
	assert.deepEqual(await f.publish({ ...input(), fingerprint: "b".repeat(64) }), { status: "capped", reason: "watch-issue-cap" });
	assert.equal(f.calls.filter(([method]) => method === "create").length, 1);
	assert.equal((await f.publish(input())).status, "updated");
});
test("suppressed finding activity postpones quiet closure and recurrence reopens the same issue", async () => {
	const f = fixture(); const args = { ...input(), target: { ...input().target, closeAfter: "1m" } };
	await f.publish(args); f.setNow(60000); await f.publish.noteActivity(args);
	f.setNow(61001); assert.deepEqual(await f.publish.sweep(), []);
	f.setNow(120000); assert.equal((await f.publish.sweep())[0].status, "closed");
	assert.equal(f.calls.filter(([method]) => method === "close").length, 1);
	await f.publish(args); assert.equal(f.calls.at(-1)[0], "update"); assert.equal(f.calls.at(-1)[1].state, "open");
	assert.equal(f.calls.filter(([method]) => method === "create").length, 1);
});
test("activity arriving during a remote close is noticed by CAS and immediately reopens", async () => {
	let f; const args = { ...input(), target: { ...input().target, closeAfter: "1m" } };
	f = fixture({ close: async () => { await f.publish.noteActivity(args); } });
	await f.publish(args); f.setNow(61001);
	const outcomes = await f.publish.sweep();
	assert.equal(outcomes[0].status, "active"); assert.equal(outcomes[0].reason, "watch-issue-close-raced");
	assert.equal(f.calls.at(-1)[0], "update"); assert.equal(f.calls.at(-1)[1].state, "open");
});
test("uncertain remote close never claims success and retains durable work for reconciliation", async () => {
	const f = fixture({ close: async () => { throw new Error("private remote reply"); } });
	await f.publish({ ...input(), target: { ...input().target, closeAfter: "1m" } }); f.setNow(61001);
	const outcomes = await f.publish.sweep(); assert.equal(outcomes[0].status, "uncertain"); assert.equal(outcomes[0].reason, "watch-issue-close-uncertain");
	assert.equal(JSON.stringify(outcomes).includes("private"), false);
});

test("removed or disabled reviewed quiet policy blocks remote closure and reports policy change", async () => {
	const reports = []; const f = fixture({ canClose: async () => false, reportClose: async (outcome, mapping) => { reports.push({ outcome, mapping }); } });
	await f.publish({ ...input(), target: { ...input().target, closeAfter: "1m" } }); f.setNow(61001);
	assert.equal((await f.publish.sweep())[0].reason, "watch-issue-close-policy-changed");
	assert.equal(f.calls.filter(([method]) => method === "close").length, 0);
	assert.equal(reports[0].mapping.ruleId, "errors"); assert.equal(reports[0].mapping.fingerprint, "a".repeat(64));
});
