import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { precheckAtExit } from "../src/plan-check.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// The runner's plan pre-check (issue #505): log-only, never throws, never decides. Every case injects `now`.

const NOW = Date.parse("2026-10-07T06:00:00.000Z");
const PLAN = JSON.stringify({ version: 1, basis: null, projects: [{ id: "shop", weight: 3 }, { id: "_other", weight: 0 }] });

function job({ plan = PLAN, snapshot = true } = {}) {
	const root = tempDir("pi-dispatch-precheck-");
	const outboxDir = join(root, "outbox");
	mkdirSync(outboxDir);
	const snapshotPath = join(root, "portfolio.json");
	if (snapshot) writeFileSync(snapshotPath, JSON.stringify({ version: 1, envelope: { maxPlanDays: 14 } }));
	if (typeof plan === "string") writeFileSync(join(outboxDir, "priorities.json"), plan);
	return { root, outboxDir, snapshotPath, planPath: join(outboxDir, "priorities.json") };
}

function run(paths, extra = {}) {
	const logs = [];
	const ret = precheckAtExit({ outboxDir: paths.outboxDir, snapshotPath: paths.snapshotPath, log: (event, fields) => logs.push({ event, ...fields }), now: () => NOW, ...extra });
	return { ret, logs };
}

test("no plan file and no snapshot: nothing logged, nothing returned (every job that is not a portfolio job) (#505)", () => {
	const { ret, logs } = run(job({ plan: null, snapshot: false }));
	assert.equal(ret, undefined);
	assert.deepEqual(logs, []);
	assert.equal(precheckAtExit({ outboxDir: "/nonexistent/outbox", snapshotPath: "/nonexistent/portfolio.json", log: () => assert.fail("logged") }), undefined, "no /outbox at all (a forge job)");
});

test("no plan file in a portfolio job (it has the snapshot) logs plan-absent, the host's answer (#507)", () => {
	const { ret, logs } = run(job({ plan: null }));
	assert.equal(ret, undefined);
	assert.deepEqual(logs, [{ event: "plan_precheck", outcome: "refused", reason: "plan-absent" }]);
	const noOutbox = job({ plan: null });
	assert.deepEqual(run({ ...noOutbox, outboxDir: join(noOutbox.root, "gone") }).logs, [{ event: "plan_precheck", outcome: "refused", reason: "plan-absent" }], "no outbox at all");
});

test("a well-formed plan logs ok; a malformed one logs plan-invalid with the field and rule, never a byte of the plan (#505)", () => {
	assert.deepEqual(run(job()).logs, [{ event: "plan_precheck", outcome: "ok", reason: null }]);
	const secret = "Fix the login bug before Friday";
	const bad = JSON.stringify({ version: 1, basis: null, projects: [{ id: "shop", weight: 3000, reason: secret }] });
	const { ret, logs } = run(job({ plan: bad }));
	assert.equal(ret, undefined);
	assert.deepEqual(logs, [{ event: "plan_precheck", outcome: "refused", reason: "plan-invalid", field: "projects.weight", rule: "range" }]);
	assert.ok(!JSON.stringify(logs).includes("Fix the"));
	assert.deepEqual(run(job({ plan: "{nope" })).logs[0].reason, "plan-parse-error");
	assert.deepEqual(run(job({ snapshot: false })).logs, [{ event: "plan_precheck", outcome: "refused", reason: "plan-not-portfolio" }]);
});

test("a FIFO, a symlink, a directory and a huge file are refused at once, the FIFO without blocking (#505)", () => {
	const fifo = job({ plan: null });
	execFileSync("mkfifo", [fifo.planPath]);
	assert.deepEqual(run(fifo).logs, [{ event: "plan_precheck", outcome: "refused", reason: "plan-not-regular-file" }]);

	const link = job({ plan: null });
	writeFileSync(join(link.root, "target.json"), PLAN);
	symlinkSync(join(link.root, "target.json"), link.planPath);
	assert.deepEqual(run(link).logs[0].reason, "plan-not-regular-file");

	const dir = job({ plan: null });
	mkdirSync(dir.planPath);
	assert.deepEqual(run(dir).logs[0].reason, "plan-not-regular-file");

	const huge = job({ plan: "x".repeat(4 * 1024 * 1024) });
	assert.deepEqual(run(huge).logs[0].reason, "plan-oversize");
});

test("the pre-check never throws and always returns undefined, whatever the fs or the logger does (#505)", () => {
	const paths = job();
	const throwing = new Proxy({}, { get: () => () => {
		throw Object.assign(new Error("io"), { code: "EIO" });
	} });
	assert.equal(precheckAtExit({ ...paths, fs: throwing, log: () => {}, now: () => NOW }), undefined);
	assert.equal(precheckAtExit({ ...paths, log: () => {
		throw new Error("stdout closed");
	}, now: () => NOW }), undefined);
	assert.equal(precheckAtExit({ ...paths, log: () => {}, now: () => {
		throw new Error("clock");
	} }), undefined);
});

test("run-job.mjs calls the pre-check as a bare guarded statement right before the decided exit line, so it can change neither the code nor the line (#505)", () => {
	const src = readFileSync(new URL("../run-job.mjs", import.meta.url), "utf8");
	assert.match(src, /\n\ttry \{\n\t\tprecheckAtExit\(\{ log \}\);\n\t\} catch \{\}\n/, "a bare statement inside its own try, its result discarded");
	assert.equal(src.match(/precheckAtExit\(/g).length, 1, "called once, on the decided path only");
	assert.doesNotMatch(src, /=\s*precheckAtExit\(|precheckAtExit\([^)]*\)\s*[?|&]/, "its result is never read");
	assert.match(src, /\} catch \{\}\n(?:\t\/\/[^\n]*\n)*\texitWriter\.writeExit\(\{ \.\.\.capExitMessage\(outcome\), turns: /, "the exit line follows, unchanged");
	assert.match(src, /\n\treturn outcome\.code;\n\}/, "and the exit code is still the decided outcome's");
});
