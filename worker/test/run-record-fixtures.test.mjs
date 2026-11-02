import assert from "node:assert/strict";
import { readdirSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FIXTURE_NAME_RE, NEXT_ID, releaseTags } from "../../.github/scripts/run-record-fixtures.mjs";
import { computeCapacity } from "../src/capacity.mjs";
import { readCapacityRecords, readLocalWindow, readMirrorWindow } from "../src/capacity-records.mjs";
import { readLocalRuns } from "../src/portfolio-snapshot.mjs";
import { RUN_RECORD_VERSION, buildRecord, earlierFrom, makeFindPreviousRun, makeReadRecord, makeRecordWriter, recordReadable, recordVerdict, recordVersionOf, sanitizeJobId } from "../src/run-history.mjs";
import { READ_SCRIPT, RUNS_INDEX, TRIM_SCRIPT, makeRunMirror, readMirroredRecord, readMirroredRuns } from "../src/run-mirror.mjs";
import { readSizingRecords } from "../src/size-records.mjs";
import { RUN_RECORD_CASES, caseInput } from "./fixtures/run-records/cases.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// The run-record fixtures (issue #761): the record each released `buildRecord` makes from the shared cases, one shape
// per release that changed it (`manifest.json`, written by `.github/scripts/run-record-fixtures.mjs`), and one record of
// a version no release has written yet (`synthetic-v2.json`). Every instant below is read from the fixtures, never the
// wall clock, so the suite reads the same 399 days from now.

const FIXTURES = fileURLToPath(new URL("./fixtures/run-records/", import.meta.url));
const readJson = (name) => JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
const manifest = readJson("manifest.json");
const SYNTHETIC = readJson("synthetic-v2.json");
const HOUR = 60 * 60 * 1000;

/** A shape's five records, each beside the input it was built from. */
const casesOf = (shape) => RUN_RECORD_CASES.map((name) => ({ name, input: caseInput(name), record: readJson(`${shape.id}.${name}.json`) }));

/** Whether a shape was written by `tag` or a later release (`next` is later than every tag). */
function since(shape, tag) {
	if (shape.id === NEXT_ID) return true;
	return releaseTags([shape.id, tag])[0] === tag;
}

/**
 * The key structure of a value, recursively, with each leaf's type: what a reader depends on. Ordered, since a record's
 * field order is its serialisation order (INT-RUN-HISTORY-FILE-CONTRACT).
 */
function shapeOf(value) {
	if (value === null) return "null";
	if (Array.isArray(value)) return ["array", value.map(shapeOf)];
	if (typeof value === "object") return ["object", Object.entries(value).map(([key, v]) => [key, shapeOf(v)])];
	return typeof value;
}

/**
 * A logs directory holding one shape's records and the synthetic newer one, each written by the record writer and
 * dated by its own `endedAt` (the writer writes a record when its run ends, and every reader's mtime prefilter reads
 * that), with the window around them: from an hour before the first start to an hour after the last end.
 */
function deployment(shape) {
	const logsDir = tempDir("run-record-fixtures-");
	const cases = casesOf(shape);
	const write = makeRecordWriter({ logsDir });
	for (const record of [...cases.map((c) => c.record), SYNTHETIC]) {
		write(record);
		const at = Date.parse(record.endedAt) / 1000;
		utimesSync(join(logsDir, `${sanitizeJobId(record.jobId)}.json`), at, at);
	}
	const all = [...cases.map((c) => c.record), SYNTHETIC];
	const sinceMs = Math.min(...all.map((r) => Date.parse(r.startedAt))) - HOUR;
	const nowMs = Math.max(...all.map((r) => Date.parse(r.endedAt))) + HOUR;
	return { logsDir, cases, sinceMs, nowMs };
}

const OUTCOMES = { "forge-completed": "completed", "local-cron-completed": "completed", "policy-refused": "policy", "failed-infra": "failed", maximal: "completed" };
const sourceOf = (input) => input.result ?? input.error;
const ids = (records) => records.map((r) => r.jobId).sort();
const caseIds = (cases) => cases.map((c) => c.input.job.id).sort();

// ---- the bolt: the fixtures follow buildRecord ----

test("buildRecord's shape is the newest fixture's for every case", () => {
	const newest = manifest.shapes.at(-1);
	for (const name of RUN_RECORD_CASES) {
		assert.deepEqual(shapeOf(buildRecord(caseInput(name))), shapeOf(readJson(`${newest.id}.${name}.json`)), `${name}: buildRecord's shape changed: run \`node .github/scripts/run-record-fixtures.mjs --next-only\` and commit the fixtures it writes`);
	}
});

test("the manifest lists every release once and in order, each shape under its first tag, and at most one untagged entry, last", () => {
	assert.deepEqual(Object.keys(manifest), ["shapes", "skipped"]);
	const untagged = manifest.shapes.filter((s) => s.tags.length === 0);
	assert.ok(untagged.length <= 1, "one working tree, so at most one untagged entry");
	if (untagged.length === 1) {
		assert.equal(manifest.shapes.at(-1), untagged[0], "the untagged entry is the newest");
		assert.equal(untagged[0].id, NEXT_ID);
	}
	for (const shape of manifest.shapes.filter((s) => s.tags.length > 0)) assert.equal(shape.id, shape.tags[0], "a shape is named after the first release that wrote it");
	const tagged = manifest.shapes.flatMap((s) => s.tags);
	for (const { tag, reason } of manifest.skipped) assert.ok(typeof tag === "string" && typeof reason === "string" && reason !== "", "a skipped tag says why");
	const every = [...tagged, ...manifest.skipped.map((s) => s.tag)];
	assert.equal(new Set(every).size, every.length, "no release twice");
	assert.deepEqual(tagged, releaseTags(tagged), "oldest first");
	assert.ok(every.includes("v0.1.0"), "the first release is covered, or listed as skipped with its reason");
	// Every shape has a record per case, and no generated file is left that the manifest does not name.
	const named = new Set(manifest.shapes.flatMap((s) => RUN_RECORD_CASES.map((name) => `${s.id}.${name}.json`)));
	const onDisk = readdirSync(FIXTURES).filter((n) => FIXTURE_NAME_RE.test(n));
	assert.deepEqual(onDisk.sort(), [...named].sort());
	assert.deepEqual(readdirSync(FIXTURES).filter((n) => !FIXTURE_NAME_RE.test(n)).sort(), ["cases.mjs", "manifest.json", "synthetic-v2.json"]);
});

test("releaseTags keeps vX.Y.Z tags only, in version order rather than text order", () => {
	assert.deepEqual(releaseTags(["v0.10.0", "worker-v1.0.0", "v0.9.0", "v1.0.0-rc.1", "v0.2.0", "v10.0.0", "v2.0.0"]), ["v0.2.0", "v0.9.0", "v0.10.0", "v2.0.0", "v10.0.0"]);
});

// ---- every worker reader, against every shape ----

test("every shape reads back whole by its job id, says what its case was, and is version 1", () => {
	for (const shape of manifest.shapes) {
		const { logsDir, cases } = deployment(shape);
		const readRecord = makeReadRecord({ logsDir });
		for (const { name, input, record } of cases) {
			const at = `${shape.id} ${name}`;
			assert.deepEqual(readRecord(input.job.id), record, at);
			assert.equal(record.jobId, input.job.id, at);
			assert.equal(record.outcome, OUTCOMES[name], at);
			assert.equal(record.kind, input.job.data.kind, at);
			assert.equal(record.startedAt, input.startedAt, at);
			assert.equal(record.endedAt, input.endedAt, at);
			// `attempt` counted from 0 before v2.0.0 (BullMQ's `attemptsMade` as it was), from 1 since.
			assert.equal(record.attempt, input.job.attemptsMade + (since(shape, "v2.0.0") ? 1 : 0), at);
			assert.equal(record.host, since(shape, "v1.7.0") ? input.host : undefined, at);
			assert.equal(record.project, since(shape, "v3.0.0") ? input.project : undefined, at);
			// Money, where the shape records it: the settled micro-dollars the run reported, or null for a run with none.
			if (since(shape, "v3.0.0")) assert.equal(record.dollars?.settledMicros ?? null, sourceOf(input).dollars?.settledMicros ?? null, at);
			else assert.equal(Object.hasOwn(record, "dollars"), false, at);
			assert.equal(recordVersionOf(record), 1, at);
			assert.equal(recordReadable(record), true, at);
			if (shape.id === NEXT_ID) assert.equal(Object.keys(record).at(-1), "v", at);
			else assert.equal(Object.hasOwn(record, "v"), false, `${at}: no release wrote one`);
		}
		const synthetic = readRecord(SYNTHETIC.jobId);
		assert.deepEqual(synthetic, SYNTHETIC, "a newer record is read back as it is, not refused");
		assert.equal(recordVersionOf(synthetic), 2);
		assert.equal(recordReadable(synthetic), false);
		assert.equal(recordReadable(synthetic, { supported: 2 }), true);
	}
	assert.equal(RUN_RECORD_VERSION, 1);
});

test("recordVerdict judges every shape, and the newer record, on the core alone", () => {
	for (const shape of manifest.shapes) {
		const { logsDir, cases } = deployment(shape);
		const readRecord = makeReadRecord({ logsDir });
		for (const { name, input, record } of cases) {
			const at = `${shape.id} ${name}`;
			const verdict = recordVerdict(readRecord(input.job.id), { jobId: input.job.id, attempt: record.attempt, since: input.job.timestamp });
			assert.equal(verdict, name === "failed-infra" ? "failed" : null, at);
		}
		// A record from before v2.0.0 counted attempts from 0, so it never settles the 1-based attempt asked for: the
		// verdict fails toward the queue's own (a failure comment, or a run), never toward a false "finished".
		const first = cases.find((c) => c.name === "forge-completed");
		assert.equal(recordVerdict(first.record, { jobId: first.input.job.id, attempt: 1, since: first.input.job.timestamp }), since(shape, "v2.0.0") ? null : "other-attempt", shape.id);
		// A newer host finished the run: its record settles the attempt for this one, whatever else it carries.
		assert.equal(recordVerdict(readRecord(SYNTHETIC.jobId), { jobId: SYNTHETIC.jobId, attempt: 2, since: Date.parse(SYNTHETIC.startedAt) }), null);
		assert.equal(recordVerdict(SYNTHETIC, { jobId: SYNTHETIC.jobId, attempt: 1 }), "other-attempt");
	}
});

test("makeFindPreviousRun finds the cron fixture of every shape by its scheduler", () => {
	const cron = caseInput("local-cron-completed");
	const slot = Number(cron.job.id.split(":").at(-1));
	for (const shape of manifest.shapes) {
		const { logsDir } = deployment(shape);
		const findPreviousRun = makeFindPreviousRun({ logsDir });
		assert.equal(findPreviousRun({ schedulerId: "nightly-docs", beforeMillis: slot + 1 }), cron.endedAt, shape.id);
		assert.equal(findPreviousRun({ schedulerId: "nightly-docs", beforeMillis: slot }), null, shape.id);
	}
});

test("earlierFrom carries a shape's slot interval and chain, and only the core times of a newer record", () => {
	for (const shape of manifest.shapes) {
		for (const { name, input, record } of casesOf(shape)) {
			// A record that held a slot (`capacity`, v4.1.0 on) hands on its own interval with its size, after the chain it
			// carried; an older shape recorded neither, so a retry after an upgrade carries nothing.
			const own = input.capacity ? [{ host: input.host, startedAt: input.startedAt, endedAt: input.endedAt, memMiB: input.size.memMiB, cpuCenti: input.size.cpuCenti }] : [];
			const expected = since(shape, "v4.1.0") ? [...(input.earlier ?? []), ...own] : [];
			assert.deepEqual(earlierFrom(record), expected.length > 0 ? expected : null, `${shape.id} ${name}`);
		}
	}
	// Its sizes, `capacity` and `earlier` may mean something else in a newer release: none is read.
	assert.deepEqual(earlierFrom(SYNTHETIC), [{ host: SYNTHETIC.host, startedAt: SYNTHETIC.startedAt, endedAt: SYNTHETIC.endedAt, memMiB: null, cpuCenti: null }]);
});

/** Each host's slot time the cases describe: every run that held a slot, and the earlier attempts a shape records. */
function expectedBusy(shape) {
	const busy = {};
	const add = (host, from, to) => (busy[host] = (busy[host] ?? 0) + Date.parse(to) - Date.parse(from));
	for (const { input } of casesOf(shape)) {
		if (input.capacity) add(input.host, input.startedAt, input.endedAt);
		if (since(shape, "v4.1.0")) for (const e of input.earlier ?? []) add(e.host, e.startedAt, e.endedAt);
	}
	return busy;
}

test("the capacity reads take every shape whole and skip the newer record, saying how many", async () => {
	for (const shape of manifest.shapes) {
		const { logsDir, cases, sinceMs, nowMs } = deployment(shape);
		const local = readLocalWindow(logsDir, { sinceMs });
		assert.deepEqual(ids(local.records), caseIds(cases), shape.id);
		assert.equal(local.newerSkipped, 1, shape.id);
		const read = await readCapacityRecords({ redis: null, logsDir, sinceMs, nowMs, retentionDays: 0, localHost: "mini-1" });
		assert.deepEqual(ids(read.records), caseIds(cases), shape.id);
		assert.equal(read.coverage.newerSkipped, 1, shape.id);
		assert.match(read.coverage.reason, /; 1 record from a newer pi-dispatch not read$/, shape.id);
		const report = computeCapacity({ records: read.records, live: [], windowStartMs: sinceMs, nowMs, bucketMs: HOUR, coverage: read.coverage });
		assert.equal(report.coverage.unreadable, 0, `${shape.id}: no shape is unreadable to the capacity report`);
		// A record from before v1.7.0 names no host, so it is counted and set aside rather than put on a guessed one.
		assert.equal(report.coverage.withoutHost, since(shape, "v1.7.0") ? 0 : cases.length, shape.id);
		assert.deepEqual(Object.fromEntries(report.hosts.map((h) => [h.name, h.busyMs])), since(shape, "v1.7.0") ? expectedBusy(shape) : {}, `${shape.id}: each host's slot time, and none on the newer record's host`);
		assert.match(report.coverage.reason, /1 record from a newer pi-dispatch not read/, `${shape.id}: the report says it is partial`);
	}
});

test("the sizing read takes every shape's measured runs and skips the newer record, saying how many", () => {
	for (const shape of manifest.shapes) {
		const { logsDir, cases, nowMs } = deployment(shape);
		const read = readSizingRecords(logsDir, { nowMs });
		// `resources` and `size` arrived in v4.0.0; an older record measured nothing, so it suggests nothing.
		const measured = since(shape, "v4.0.0") ? cases.filter((c) => sourceOf(c.input).resources) : [];
		assert.deepEqual(ids(read.records), measured.map((c) => c.input.job.id).sort(), shape.id);
		for (const { input } of measured) {
			const record = read.records.find((r) => r.jobId === input.job.id);
			assert.equal(record.project, input.project, shape.id);
			assert.equal(record.resources.memPeak, sourceOf(input).resources.memPeak, shape.id);
			assert.deepEqual(record.size, input.size, shape.id);
		}
		assert.equal(read.newerSkipped, 1, shape.id);
		assert.equal(read.skipped, 0, shape.id);
	}
});

test("the portfolio's local read takes every shape and skips the newer record, saying how many", () => {
	for (const shape of manifest.shapes) {
		const { logsDir, cases, sinceMs } = deployment(shape);
		const read = readLocalRuns({ logsDir, sinceMs });
		assert.deepEqual(ids(read.records), caseIds(cases), shape.id);
		assert.deepEqual(read.records.map((r) => [r.jobId, r.outcome]).sort(), cases.map((c) => [c.input.job.id, OUTCOMES[c.name]]).sort(), shape.id);
		assert.equal(read.complete, true, shape.id);
		assert.equal(read.newerSkipped, 1, shape.id);
	}
});

/**
 * A Valkey holding the run mirror's bodies and index, for the writer (`TRIM_SCRIPT`: the member is added, nothing is
 * trimmed) and the readers (`READ_SCRIPT`, the index range, GET and MGET). The trims, the horizon and the start are
 * run-mirror.test.mjs' business; this one only carries records there and back.
 */
function mirrorValkey() {
	const kv = new Map();
	const index = new Map();
	const sorted = () => [...index.entries()].sort((a, b) => a[1] - b[1]);
	return {
		set: async (key, value) => void kv.set(key, value),
		get: async (key) => kv.get(key) ?? null,
		mget: async (...keys) => keys.map((k) => kv.get(k) ?? null),
		zrevrangebyscore: async (_key, _max, min) => sorted().filter(([, s]) => s > Number(String(min).replace("(", ""))).reverse().map(([id]) => id),
		eval: async (script, _n, key, ...args) => {
			assert.equal(key, RUNS_INDEX);
			if (script === TRIM_SCRIPT) {
				const [, , , , , , score, id] = args;
				index.set(id, Number(score));
				return null;
			}
			assert.equal(script, READ_SCRIPT);
			const min = Number(args[3]);
			const range = sorted().filter(([, s]) => s > min).reverse().flatMap(([id, s]) => [id, String(s)]);
			return [index.size, String(sorted()[0][1]), null, null, 0, range];
		},
	};
}

test("every shape survives the run mirror: written, read back by id and by window, the newer record skipped by the fold", async () => {
	for (const shape of manifest.shapes) {
		const { logsDir, cases, sinceMs, nowMs } = deployment(shape);
		const redis = mirrorValkey();
		const { mirror } = makeRunMirror({ redis, retentionDays: 0, now: () => nowMs });
		for (const record of [...cases.map((c) => c.record), SYNTHETIC]) assert.equal(await mirror(record, sanitizeJobId(record.jobId)), true, shape.id);
		for (const { record } of cases) assert.deepEqual(await readMirroredRecord(redis, sanitizeJobId(record.jobId)), record, shape.id);
		const runs = await readMirroredRuns(redis, { limit: 50, sinceMs, prune: false, now: () => nowMs });
		assert.deepEqual(ids(runs.runs), [...caseIds(cases), SYNTHETIC.jobId].sort(), `${shape.id}: the runs list shows every record; only the folds skip`);
		const window = await readMirrorWindow(redis, { sinceMs, nowMs });
		assert.equal(window.state, "ok", shape.id);
		assert.deepEqual(ids(window.records), caseIds(cases), shape.id);
		assert.equal(window.newerSkipped, 1, shape.id);
		// Both sources: one record per job id, and the newer one, skipped by each, counted once (distinct job ids, as the
		// merge keeps the readable ones).
		const both = await readCapacityRecords({ redis, logsDir, sinceMs, nowMs, retentionDays: 0, localHost: "mini-1" });
		assert.deepEqual(ids(both.records), caseIds(cases), shape.id);
		assert.equal(both.coverage.newerSkipped, 1, shape.id);
		assert.match(both.coverage.reason, /^1 record from a newer pi-dispatch not read$/, shape.id);
	}
});
