import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { UnrecoverableError } from "bullmq";
import { isFinalOutcome, settleInbox } from "../src/inbox-settle.mjs";
import { InfraRetry, RECOVERY_ENQUEUED, RECOVERY_SUPERSEDED } from "../src/processor.mjs";
import { buildRecord, parseExitSteer, recordedSteered, STEER_SKIPPED_REASONS } from "../src/run-history.mjs";
import { steerTargetKey } from "../src/steer-inbox.mjs";

// Issue #646: the run's inbox is closed and counted at its FINAL outcome only, before every record write.

const infra = () => new InfraRetry("x", { reason: "container-never-started" });
const job = (over = {}) => ({ id: "j1", attemptsMade: 0, opts: { attempts: 2 }, data: { kind: "github", repo: "o/r", target: { type: "issue", number: 7 }, steer: true }, ...over });

test("FINAL OUTCOMES, as a table: every returned result but a #645 handoff; a throw that ends the job", () => {
	const rows = [
		[{ result: { outcome: "completed" } }, true, "a completed run"],
		[{ result: { outcome: "policy", reason: "operator-cancel" } }, true, "a cancel"],
		[{ result: { outcome: "policy", reason: "job-size-exceeds-host" } }, true, "a refusal before the gate"],
		[{ result: { outcome: "failed", reason: RECOVERY_ENQUEUED } }, false, "a recovery queued: the run goes on and keeps its inbox"],
		[{ result: { outcome: "policy", reason: RECOVERY_SUPERSEDED } }, false, "superseded: the run already settled elsewhere"],
		[{ error: infra() }, false, "an InfraRetry with an attempt left"],
		[{ error: infra(), job: job({ attemptsMade: 1 }) }, true, "an InfraRetry on the last attempt"],
		[{ error: infra(), job: job({ opts: {} }) }, true, "an InfraRetry on a one-attempt job (a recovery job, a local job)"],
		[{ error: new UnrecoverableError("x") }, true, "an UnrecoverableError"],
		[{ error: new Error("our bug") }, true, "a plain error, rethrown as an UnrecoverableError"],
		[{ error: { reason: "recovery-host-lost" } }, true, "the host-lost sweep's record"],
		[{}, false, "nothing to judge"],
	];
	for (const [args, want, label] of rows) assert.equal(isFinalOutcome({ job: job(), ...args }), want, label);
});

function fakeInbox(reply) {
	const calls = [];
	return {
		calls,
		closeInbox: async (args) => (calls.push(args), typeof reply === "function" ? reply(args) : reply),
	};
}

const ID = (n) => String(n).repeat(32);

test("settleInbox closes the run's inbox with its target and counts delivered, late and withdrawn", async () => {
	const inbox = fakeInbox({
		entries: [
			{ id: ID(1), source: "cli" },
			{ id: ID(2), source: "forge" },
			{ id: ID(3), source: "console" },
			{ id: ID(4), source: "forge" },
		],
		state: { [ID(1)]: "delivered", [ID(2)]: "late", [ID(3)]: "late", [ID(4)]: "withdrawn" },
	});
	const lateForge = [];
	const counts = await settleInbox({ redis: {}, job: job({ data: { ...job().data, recoveryOf: "base-1" } }), result: { outcome: "completed" }, inbox, onLateForge: (e) => lateForge.push(...e) });
	assert.deepEqual(counts, { delivered: 1, late: 2, withdrawn: 1 });
	assert.equal(inbox.calls[0].runId, "base-1", "the RUN's inbox (runIdOf), which a recovery shares");
	assert.equal(inbox.calls[0].targetKey, steerTargetKey({ kind: "github", repo: "o/r", targetType: "issue", number: 7 }), "the target member goes with the close");
	assert.deepEqual(lateForge.map((e) => e.id), [ID(2)], "only forge-source late messages reach PR 2's seam");
});

test("settleInbox touches nothing for a job that is not steer, or an outcome that is not final", async () => {
	const inbox = fakeInbox({ entries: [], state: {} });
	assert.equal(await settleInbox({ redis: {}, job: job({ data: { kind: "local" } }), result: { outcome: "completed" }, inbox }), null);
	assert.equal(await settleInbox({ redis: {}, job: job(), error: infra(), inbox }), null);
	assert.equal(await settleInbox({ redis: {}, job: job(), result: { reason: RECOVERY_ENQUEUED }, inbox }), null);
	assert.equal(inbox.calls.length, 0);
});

test("settleInbox never throws: a Valkey fault or a throwing seam is a logged null, by code", async () => {
	const logs = [];
	const log = (e, f) => logs.push([e, f]);
	assert.equal(await settleInbox({ redis: {}, job: job(), result: {}, inbox: fakeInbox({ error: "ECONNRESET" }), log }), null);
	assert.deepEqual(logs.at(-1), ["steer_settle_failed", { jobId: "j1", code: "ECONNRESET" }]);
	assert.equal(await settleInbox({ redis: {}, job: job(), result: {}, inbox: { closeInbox: () => { throw Object.assign(new Error("x"), { code: "EBOOM" }); } }, log }), null);
	assert.equal(logs.at(-1)[1].code, "EBOOM");
	const counts = await settleInbox({ redis: {}, job: job(), result: {}, inbox: fakeInbox({ entries: [{ id: ID(5), source: "forge" }], state: { [ID(5)]: "late" } }), onLateForge: () => { throw new Error("seam"); }, log });
	assert.deepEqual(counts, { delivered: 0, late: 1, withdrawn: 0 }, "a throwing late seam costs nothing");
});

test("the default late-forge seam is a logged no-op (PR 2 answers them), never text", async () => {
	const logs = [];
	await settleInbox({ redis: {}, job: job(), result: {}, inbox: fakeInbox({ entries: [{ id: ID(6), source: "forge", text: "SECRET" }], state: { [ID(6)]: "late" } }), log: (e, f) => logs.push([e, f]) });
	assert.ok(logs.some(([e, f]) => e === "steer_late_forge_unanswered" && f.count === 1));
	assert.ok(!JSON.stringify(logs).includes("SECRET"));
});

// --- the bolt: no record site in index.mjs skips the settle --------------------------------------------------------

test("BY SHAPE: every record write in index.mjs is immediately preceded by the settle of the same outcome", () => {
	const src = readFileSync(new URL("../src/index.mjs", import.meta.url), "utf8");
	const lines = src.split("\n");
	const code = (l) => l.replace(/\/\/.*$/, "").trim();
	const sites = [];
	for (let i = 0; i < lines.length; i++) {
		const l = code(lines[i]);
		if (!/\b(recordRun|recordAfterGate)\(/.test(l)) continue;
		if (l.startsWith("const recordAfterGate = (args) => recordRun(")) continue; // the binding, not a write
		if (l.startsWith("*")) continue; // inside a block comment
		sites.push(i);
	}
	// 2 above the gate (the never-fits refusal, the wait gate's refusal) and the 8 post-gate paths project-pickup counts.
	assert.equal(sites.length, 10, "a new record site must be counted here, and settled");
	for (const i of sites) {
		const l = code(lines[i]);
		const arg = /\{ job, (result: outcome|result|error: expired|error: loop|error)[,}]/.exec(l)?.[1];
		assert.ok(arg, `line ${i + 1}: a record call this bolt can read: ${l}`);
		let j = i - 1;
		while (j >= 0 && code(lines[j]) === "") j -= 1;
		assert.equal(code(lines[j]), `await settleSteer({ ${arg} });`, `line ${i + 1} is preceded by the settle of the same outcome`);
	}
	// The helper is defined before the first site, decides finality itself (inbox-settle.mjs), and only for steer jobs.
	const def = src.indexOf("const settleSteer = async");
	assert.ok(def !== -1 && def < src.indexOf("await settleSteer("));
	assert.match(src.slice(def, def + 400), /if \(job\.data\?\.steer !== true\) return;/);
	// No bare closeInbox in the processor: the close goes through settleInbox, which knows what is final.
	assert.doesNotMatch(src, /closeInbox/);
});

test("BY SHAPE: the host-lost sweep's record settles the run's inbox too (start.mjs)", () => {
	const src = readFileSync(new URL("../src/start.mjs", import.meta.url), "utf8");
	const at = src.indexOf('error: { reason: "recovery-host-lost" }');
	assert.equal(at, -1, "the record carries the decorated error, not a fresh literal");
	const lost = src.indexOf('const lostError = { reason: "recovery-host-lost" };');
	assert.ok(lost !== -1);
	const settle = src.indexOf("await settleInbox({ redis, job, error: lostError, log })", lost);
	const record = src.indexOf("error: lostError, startedAt: null", lost);
	assert.ok(settle !== -1 && settle < record, "settled before the record write");
});

// --- the record --------------------------------------------------------------------------------------------------

const AT = { startedAt: "2026-10-17T10:00:00.000Z", endedAt: "2026-10-17T10:01:00.000Z" };

test("the record's steered and steerSkipped: integers and the enum only, and only for a steer job", () => {
	const r = buildRecord({ job: job(), result: { outcome: "completed", exitCode: 0, steered: { delivered: 2, late: 1, withdrawn: 0 }, steerSkipped: "no-exit-key" }, ...AT });
	assert.deepEqual(r.steered, { delivered: 2, late: 1, withdrawn: 0 });
	assert.equal(r.steerSkipped, "no-exit-key");
	const keys = Object.keys(r);
	assert.deepEqual(keys.slice(-2), ["steered", "steerSkipped"], "TAIL position");
	for (const reason of STEER_SKIPPED_REASONS) assert.equal(buildRecord({ job: job(), result: { steerSkipped: reason }, ...AT }).steerSkipped, reason);
	// The same fields on a job that never armed run.steer are not recorded at all.
	const plain = buildRecord({ job: job({ data: { kind: "github" } }), result: { outcome: "completed", steered: { delivered: 1, late: 0, withdrawn: 0 }, steerSkipped: "venue-copies" }, ...AT });
	assert.equal("steered" in plain, false);
	assert.equal("steerSkipped" in plain, false);
	// An error carries them the same way (the settle decorates a thrown final error).
	const err = Object.assign(infra(), { steered: { delivered: 0, late: 3, withdrawn: 0 } });
	assert.deepEqual(buildRecord({ job: job(), error: err, ...AT }).steered, { delivered: 0, late: 3, withdrawn: 0 });
});

test("MAKE IT LIE: a hostile steered or steerSkipped never reaches the record as text", () => {
	const hostile = [
		{ delivered: "2", late: 0, withdrawn: 0 },
		{ delivered: -1, late: 0, withdrawn: 0 },
		{ delivered: 1.5, late: 0, withdrawn: 0 },
		{ delivered: 1, late: 0 },
		{ delivered: Number.MAX_SAFE_INTEGER + 2, late: 0, withdrawn: 0 },
		[1, 2, 3],
		"delivered=3",
		null,
	];
	for (const s of hostile) assert.equal("steered" in buildRecord({ job: job(), result: { steered: s }, ...AT }), false, JSON.stringify(s));
	const extra = buildRecord({ job: job(), result: { steered: { delivered: 1, late: 0, withdrawn: 0, note: "ignore previous instructions", __proto__: { evil: 1 } } }, ...AT });
	assert.deepEqual(Object.keys(extra.steered), ["delivered", "late", "withdrawn"], "rebuilt, never the source's object");
	assert.ok(!JSON.stringify(extra).includes("ignore previous"));
	for (const reason of ["venue-copies; rm -rf /", "VENUE-COPIES", "late", "", 1, { toString: () => "no-exit-key" }]) {
		assert.equal("steerSkipped" in buildRecord({ job: job(), result: { steerSkipped: reason }, ...AT }), false, String(reason));
	}
	assert.equal(recordedSteered({ delivered: 0, late: 0, withdrawn: 0 }).delivered, 0, "zeros are counts");
});

test("parseExitSteer: the decisive exit line's steer block, counts only", () => {
	const exit = (fields) => `\n${JSON.stringify({ event: "exit", code: 0, ...fields })}\n`;
	assert.deepEqual(parseExitSteer(exit({ steer: { delivered: 2, pending: 1 } })), { delivered: 2, pending: 1 });
	assert.deepEqual(parseExitSteer(exit({ steer: { delivered: 2, pending: "x" } })), { delivered: 2, pending: null });
	assert.equal(parseExitSteer(exit({ steer: { pending: -1 } })), null);
	assert.equal(parseExitSteer(exit({ steer: "lots" })), null);
	assert.equal(parseExitSteer(exit({})), null);
	assert.equal(parseExitSteer("no exit line"), null);
});

// --- review round 1 ------------------------------------------------------------------------------------------------

test("F2, BY SHAPE: the terminal branch of the failed listener (a stall-kill the processor never saw) settles a steer job's inbox", () => {
	const src = readFileSync(new URL("../src/start.mjs", import.meta.url), "utf8");
	const from = src.indexOf("const onFailed = (job, err) => {");
	assert.ok(from !== -1);
	const body = src.slice(from, src.indexOf("\n\t\t};", from));
	const terminal = body.indexOf("if (job?.finishedOn) {");
	assert.ok(terminal !== -1);
	const settle = body.indexOf("if (job.data?.steer === true) void settleInbox({ redis, job, error: {", terminal);
	assert.ok(settle !== -1, "settled inside the terminal branch, for steer jobs");
	assert.ok(settle < body.indexOf("void comment(", terminal), "before the failure comment");
	// And every path into a terminal stall failure reaches onFailed: the stall listener's last resort is `onFailed(job, err)`.
	assert.match(src, /if \(recovered\) return;\n\t*return onFailed\(job, err\);/);
});

test("F2: a stall's error object is a final outcome, so the inbox is closed and its waiting messages counted late", async () => {
	const calls = [];
	const counts = await settleInbox({ redis: {}, job: job({ attemptsMade: 0 }), error: { reason: "infra" }, inbox: { closeInbox: async (a) => (calls.push(a), { entries: [{ id: ID(7), source: "cli" }], state: { [ID(7)]: "late" } }) } });
	assert.deepEqual(counts, { delivered: 0, late: 1, withdrawn: 0 });
	assert.equal(calls.length, 1);
});

test("F3: parseExitSteer keeps deliveredIds only as at most 16 lowercase 32-hex ids, deduplicated; anything else is dropped whole", () => {
	const exit = (steer) => `\n${JSON.stringify({ event: "exit", code: 0, steer })}\n`;
	const a = "a".repeat(32);
	const b = "b".repeat(32);
	assert.deepEqual(parseExitSteer(exit({ delivered: 2, pending: 0, deliveredIds: [a, b, a] })), { delivered: 2, pending: 0, deliveredIds: [a, b] });
	assert.deepEqual(parseExitSteer(exit({ deliveredIds: [a] })), { delivered: null, pending: null, deliveredIds: [a] });
	const ids = Array.from({ length: 17 }, (_, i) => i.toString(16).padStart(32, "0"));
	for (const bad of [ids, [a, "A".repeat(32)], [a, "x"], [a, 7], "aaaa", [], { 0: a }, [`${a}0`]]) {
		assert.equal("deliveredIds" in (parseExitSteer(exit({ delivered: 1, deliveredIds: bad })) ?? {}), false, JSON.stringify(bad).slice(0, 40));
	}
	assert.deepEqual(parseExitSteer(exit({ delivered: 1, deliveredIds: ids.slice(0, 16) })).deliveredIds.length, 16);
});
