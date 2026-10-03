import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
	CHILD_LEDGER_MAX_BYTES,
	CHILD_LEDGER_MAX_ROWS,
	CHILD_LEDGER_NAME,
	CHILD_LEDGER_ROWS,
	createUsageMeter,
	foldChildLedgers,
	parseChildLedger,
	USAGE_ID_PATTERN,
} from "../src/usage-meter.mjs";
import { MODEL_REF_PATTERN } from "../../../worker/src/model-ref.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

/**
 * Issue #500: the child ledger file and the parent's fold over it (foldChildLedgers, DES-USAGE-METER-VIA-API-PROVIDER-
 * REGISTRY). PURE apart from one test that runs the fold on a real directory, for the two things a fake cannot prove:
 * a FIFO does not hang it and a symlink is not followed.
 */

const NAME_A = "101.0123456789abcdef.json";
const NAME_B = "202.fedcba9876543210.json";

/** A ledger row with the ten numerics, zero unless given. */
const row = (provider, model, fields = {}) => ({ provider, model, calls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, reasoning: 0, total: 0, cost: 0, unpriced: 0, ...fields });

/** A well-formed ledger whose rows partition its totals: `calls` settled calls of `each` tokens on one model. */
function ledger({ calls = 1, each = 10, cost = 0.5, unresolved = 0, state = "running", metered = true, extra = {} } = {}) {
	const rows = calls === 0 ? [] : [row("anthropic", "claude-x", { calls, input: calls * each, total: calls * each, cost: calls * cost })];
	return {
		v: 1,
		state,
		metered,
		totals: { input: calls * each, output: 0, total: calls * each, cost: calls * cost, calls: calls + unresolved, unresolved, unpriced: 0, sessions: 1 },
		rows,
		spentMicros: calls * cost * 1e6,
		inflightMicros: unresolved * 1000,
		costRefused: 0,
		modelRefused: 0,
		...extra,
	};
}

/**
 * An in-memory directory with the five fs calls the fold makes. `files` maps a name to its content (a string, or
 * `{ kind: "fifo" }`, or `{ vanish: true }` for a file listed but gone at open). Every open is recorded, so a test can
 * prove a file is never read again.
 */
function fakeFs(files, { listError = null } = {}) {
	const opened = [];
	const fds = new Map();
	let next = 3;
	return {
		files,
		opened,
		constants: { O_RDONLY: 0, O_NOFOLLOW: 0x100, O_NONBLOCK: 0x4 },
		readdirSync(dir) {
			if (listError) throw Object.assign(new Error(dir), { code: listError });
			return Object.keys(files);
		},
		openSync(path) {
			const name = path.split("/").at(-1);
			opened.push(name);
			const entry = files[name];
			if (entry === undefined || entry?.vanish) throw Object.assign(new Error("gone"), { code: "ENOENT" });
			if (entry?.kind === "symlink") throw Object.assign(new Error("loop"), { code: "ELOOP" });
			const fd = next++;
			fds.set(fd, { entry, offset: 0 });
			return fd;
		},
		fstatSync(fd) {
			const { entry } = fds.get(fd);
			const isFile = typeof entry === "string" || Buffer.isBuffer(entry);
			return { isFile: () => isFile, size: isFile ? Buffer.byteLength(entry) : 0 };
		},
		readSync(fd, buffer, offset, length) {
			const handle = fds.get(fd);
			const bytes = Buffer.from(handle.entry);
			const n = bytes.copy(buffer, offset, handle.offset, Math.min(bytes.length, handle.offset + length));
			handle.offset += n;
			return n;
		},
		closeSync(fd) {
			fds.delete(fd);
		},
	};
}

const json = (value) => JSON.stringify(value);
const fold = (fs, prev = null) => foldChildLedgers({ dir: "/run/meter", fs, prev });

test("USAGE_ID_PATTERN is a copy of the worker's id rule, character for character", () => {
	// The worker refuses a whole usage block for one row it refuses, so the fold must admit exactly what it admits.
	assert.equal(USAGE_ID_PATTERN.source, MODEL_REF_PATTERN.source);
	assert.equal(USAGE_ID_PATTERN.flags, MODEL_REF_PATTERN.flags);
});

test("the ledger name is <pid>.<nonce>.json; STOP, SPENT and a rename's temporary file are not ledgers", () => {
	assert.ok(CHILD_LEDGER_NAME.test(NAME_A));
	for (const name of ["STOP", "SPENT", `${NAME_A}.tmp`, "0.0123456789abcdef.json", "12.0123456789ABCDEF.json", "12.0123.json", "x.0123456789abcdef.json"]) {
		assert.equal(CHILD_LEDGER_NAME.test(name), false, name);
	}
});

test("parseChildLedger accepts a well-formed ledger, ids checked lowercased as the worker does", () => {
	const parsed = parseChildLedger(json(ledger({ calls: 2, unresolved: 1, extra: { rows: [row("Anthropic", "Claude-X", { calls: 2, input: 20, total: 20, cost: 1 })] } })));
	assert.deepEqual([parsed.state, parsed.metered, parsed.totals.calls, parsed.totals.unresolved, parsed.inflightMicros], ["running", true, 3, 1, 1000]);
	assert.deepEqual([...parsed.rows.keys()], ["Anthropic\u0000Claude-X"]);
	const modelless = parseChildLedger(json(ledger({ calls: 1, extra: { rows: [row(null, null, { calls: 1, input: 10, total: 10, cost: 0.5 })] } })));
	assert.deepEqual([...modelless.rows.keys()], [""], "both ids null is the model-less row");
	assert.equal(parseChildLedger(json({ ...ledger(), future: "ignored" })).state, "running", "an unknown key is never read");
});

test("parseChildLedger refuses the whole file for any one bad part", () => {
	const good = ledger({ calls: 2 });
	const bad = {
		"not json": "{",
		"an array": "[]",
		"v 2": json({ ...good, v: 2 }),
		"an unknown state": json({ ...good, state: "stopped" }),
		"metered as a string": json({ ...good, metered: "true" }),
		"no totals": json({ ...good, totals: undefined }),
		"a total missing": json({ ...good, totals: { ...good.totals, sessions: undefined } }),
		"a string number": json({ ...good, totals: { ...good.totals, input: "20" } }),
		"a negative amount": json({ ...good, totals: { ...good.totals, cost: -1 } }),
		"a fractional count": json({ ...good, totals: { ...good.totals, sessions: 1.5 } }),
		"an infinite amount": json(good).replace('"output":0', '"output":1e999'),
		"more unresolved than calls": json({ ...good, totals: { ...good.totals, unresolved: 3 } }),
		"a guard counter missing": json({ ...good, modelRefused: undefined }),
		"a negative guard counter": json({ ...good, spentMicros: -5 }),
		"rows not an array": json({ ...good, rows: {} }),
		"an id the worker refuses": json({ ...good, rows: [{ ...good.rows[0], model: "has space" }] }),
		"one id null": json({ ...good, rows: [{ ...good.rows[0], model: null }] }),
		// A bad row that carries nothing: dropping it alone would leave a file that still partitions, so only the
		// whole-file rule refuses it.
		"an empty row with a refused id": json({ ...good, rows: [...good.rows, row("has space", "m")] }),
		"an empty row with one id null": json({ ...good, rows: [...good.rows, row("p", null)] }),
		"a row number missing": json({ ...good, rows: [{ ...good.rows[0], reasoning: undefined }] }),
		"rows that sum to less than the totals": json({ ...good, rows: [{ ...good.rows[0], total: 1 }] }),
		"rows with calls the totals do not have": json({ ...good, rows: [{ ...good.rows[0], calls: 3 }] }),
		"too many rows": json({ ...good, rows: Array.from({ length: CHILD_LEDGER_MAX_ROWS + 1 }, () => row(null, null)) }),
	};
	for (const [why, text] of Object.entries(bad)) assert.equal(parseChildLedger(text), null, why);
	assert.ok(parseChildLedger(json({ ...good, rows: [...good.rows, ...Array.from({ length: CHILD_LEDGER_MAX_ROWS - 1 }, () => row(null, null))] })), "exactly the cap is fine");
});

test("the fold sums good files, merges their rows by pair, and puts the model-less row last", () => {
	const a = ledger({ calls: 2 });
	a.rows.push(row(null, null, { calls: 1, input: 5, total: 5 }));
	a.totals = { ...a.totals, input: 25, total: 25, calls: 3 };
	const fs = fakeFs({ [NAME_A]: json(a), [NAME_B]: json(ledger({ calls: 1, each: 7, cost: 0.25 })), STOP: "cost-cap", "notes.txt": "x" });
	const result = fold(fs);
	assert.deepEqual([result.processes, result.unmetered, result.missing], [2, 0, false]);
	assert.deepEqual(result.totals, { input: 32, output: 0, total: 32, cost: 1.25, calls: 4, unresolved: 0, unpriced: 0, sessions: 2 });
	assert.deepEqual(result.rows.map((r) => [r.provider, r.model, r.calls, r.total]), [["anthropic", "claude-x", 3, 27], [null, null, 1, 5]]);
	assert.deepEqual([result.spentMicros, result.inflightMicros], [1_250_000, 0]);
	assert.deepEqual(fs.opened.sort(), [NAME_A, NAME_B], "only ledger names are opened");
	assert.deepEqual([result.files.get(NAME_A).pid, result.files.get(NAME_A).state], [101, "running"]);
});

test("the high-water mark: growth replaces it; unresolved and in-flight may fall", () => {
	const fs = fakeFs({ [NAME_A]: json(ledger({ calls: 1, unresolved: 1 })) });
	const first = fold(fs);
	assert.deepEqual([first.totals.calls, first.totals.unresolved, first.inflightMicros], [2, 1, 1000]);
	fs.files[NAME_A] = json(ledger({ calls: 2, state: "done" }));
	const second = fold(fs, first);
	assert.deepEqual([second.totals.total, second.totals.unresolved, second.inflightMicros, second.unmetered], [20, 0, 0, 0]);
	assert.equal(second.files.get(NAME_A).state, "done");
	assert.equal(first.files.get(NAME_A).high.totals.total, 10, "prev is never mutated");
});

test("a shrink counts once as unmetered, keeps the mark it reached, and the file is never read again", () => {
	const fs = fakeFs({ [NAME_A]: json(ledger({ calls: 3 })) });
	const first = fold(fs);
	fs.files[NAME_A] = json(ledger({ calls: 1 }));
	const second = fold(fs, first);
	assert.deepEqual([second.unmetered, second.totals.total, second.files.get(NAME_A).why], [1, 30, "shrank"]);
	fs.files[NAME_A] = json(ledger({ calls: 9 }));
	fs.opened.length = 0;
	const third = fold(fs, second);
	assert.deepEqual([third.unmetered, third.totals.total, fs.opened], [1, 30, []], "once, frozen, unread");
});

test("a row that shrinks or disappears is a shrink, even when the totals grew", () => {
	const two = ledger({ calls: 1 });
	two.rows.push(row("openai", "gpt-x", { calls: 1, input: 4, total: 4 }));
	two.totals = { ...two.totals, input: 14, total: 14, calls: 2 };
	const fs = fakeFs({ [NAME_A]: json(two) });
	const first = fold(fs);
	const moved = ledger({ calls: 2, each: 9 });
	moved.rows[0] = { ...moved.rows[0], cost: 1 };
	fs.files[NAME_A] = json(moved);
	const second = fold(fs, first);
	assert.deepEqual([second.unmetered, second.files.get(NAME_A).why, second.totals.total], [1, "shrank", 14]);
});

test("a vanished file counts once as unmetered and keeps its mark, unresolved included", () => {
	const fs = fakeFs({ [NAME_A]: json(ledger({ calls: 1, unresolved: 1 })), [NAME_B]: json(ledger()) });
	const first = fold(fs);
	delete fs.files[NAME_A];
	const second = fold(fs, first);
	assert.deepEqual([second.unmetered, second.files.get(NAME_A).why, second.totals.unresolved, second.processes], [1, "vanished", 1, 2], "a child killed mid-call leaves its call unresolved");
	const third = fold(fs, second);
	assert.equal(third.unmetered, 1, "counted once");
	fs.files[NAME_A] = json(ledger({ calls: 5 }));
	assert.equal(fold(fs, third).totals.total, 20, "a file that comes back is not trusted again");
});

test("a file gone between the listing and the open: vanished if known, unseen if new", () => {
	const fs = fakeFs({ [NAME_A]: json(ledger()) });
	const first = fold(fs);
	fs.files[NAME_A] = { vanish: true };
	fs.files[NAME_B] = { vanish: true };
	const second = fold(fs, first);
	assert.deepEqual([second.processes, second.unmetered, second.files.has(NAME_B)], [1, 1, false]);
});

test("a bad file is never partly trusted: it counts as unmetered and contributes nothing it had not already reached", () => {
	const half = json(ledger({ calls: 4 })).replace('"sessions":1', '"sessions":"1"');
	const fs = fakeFs({ [NAME_A]: half, [NAME_B]: json(ledger({ calls: 2, metered: false })) });
	const result = fold(fs);
	assert.deepEqual([result.unmetered, result.totals.total, result.totals.calls, result.rows, result.spentMicros], [2, 0, 0, [], 0], "valid-looking totals and rows in a bad file are not read");
	assert.deepEqual([result.files.get(NAME_A).why, result.files.get(NAME_B).why], ["malformed", "unmetered"]);

	const good = fakeFs({ [NAME_A]: json(ledger({ calls: 1 })) });
	const first = fold(good);
	good.files[NAME_A] = json(ledger({ calls: 5, metered: false }));
	const second = fold(good, first);
	assert.deepEqual([second.unmetered, second.totals.total], [1, 10], "good then metered:false keeps the good mark, not the new numbers");
});

test("size, kind and encoding: over 64 KiB, a non-regular file, a symlink and invalid UTF-8 are malformed", () => {
	// Valid JSON then whitespace past the cap: JSON.parse accepts trailing whitespace, so only the size rule refuses it.
	const big = `${json(ledger())}${" ".repeat(CHILD_LEDGER_MAX_BYTES)}`;
	const names = ["1.0000000000000001.json", "2.0000000000000002.json", "3.0000000000000003.json", "4.0000000000000004.json"];
	const fs = fakeFs({ [names[0]]: big, [names[1]]: { kind: "fifo" }, [names[2]]: { kind: "symlink" }, [names[3]]: Buffer.from([0x7b, 0xff, 0x7d]) });
	const result = fold(fs);
	assert.deepEqual([result.processes, result.unmetered], [4, 4]);
	for (const name of names) assert.equal(result.files.get(name).why, "malformed", name);
});

test("a directory that cannot be listed is reported, and every file it held is then vanished", () => {
	const fs = fakeFs({ [NAME_A]: json(ledger()) });
	const first = fold(fs);
	const second = foldChildLedgers({ dir: "/run/meter", fs: fakeFs({}, { listError: "ENOENT" }), prev: first });
	assert.deepEqual([second.missing, second.unmetered, second.totals.total], [true, 1, 10]);
	assert.deepEqual(foldChildLedgers({ dir: "/run/meter", fs: fakeFs({}, { listError: "EACCES" }) }).processes, 0);
});

test("a child meter's own ledger round-trips through the fold, and the parent's snapshot partitions the total", async () => {
	const child = createUsageMeter({ maxTokens: null, rootSessionId: "c" });
	const settle = (u) => ({ result: () => Promise.resolve({ usage: u }) });
	child.observe(settle({ input: 5, output: 1, totalTokens: 6, cost: { total: 0.1 } }), { sessionId: "c", provider: "anthropic", modelId: "claude-x" });
	child.observe(settle({ input: 2, totalTokens: 2 }), { sessionId: "c" });
	child.observe({ result: () => new Promise(() => {}) }, { sessionId: "c", provider: "anthropic", modelId: "claude-x" });
	await new Promise((resolve) => setImmediate(resolve));
	const { metered, rootTotal, otherTotal, looseTotal, ...totals } = child.snapshot();
	const text = json({ v: 1, state: "running", metered, totals, rows: child.rows(), spentMicros: 0, inflightMicros: 0, costRefused: 0, modelRefused: 0 });
	const result = fold(fakeFs({ [NAME_A]: text }));
	assert.equal(result.unmetered, 0, "the meter's own snapshot and rows() make a ledger the fold accepts");
	const parent = createUsageMeter({ maxTokens: null, rootSessionId: "p" });
	parent.observe(settle({ input: 40, totalTokens: 40 }), { sessionId: "p", provider: "anthropic", modelId: "claude-x" });
	await new Promise((resolve) => setImmediate(resolve));
	parent.setChildren(result);
	const snap = parent.snapshot();
	assert.deepEqual([snap.total, snap.calls, snap.unresolved, snap.childTotal], [48, 4, 1, 8]);
	assert.equal(snap.rootTotal + snap.otherTotal + snap.looseTotal + snap.childTotal, snap.total);
	assert.equal(parent.usageSnapshot().models.reduce((sum, r) => sum + r.total, 0), snap.total);
});

test("a child writing CHILD_LEDGER_ROWS worst-case rows stays under the 64 KiB read cap", () => {
	const id = (prefix, i) => `${prefix}${String(i).padStart(3, "0")}`.padEnd(64, "x");
	const longest = 1.2345678901234567e300;
	const rows = Array.from({ length: CHILD_LEDGER_ROWS }, (_, i) => ({
		provider: id("p", i),
		model: id("m", i),
		calls: Number.MAX_SAFE_INTEGER,
		input: longest,
		output: longest,
		cacheRead: longest,
		cacheWrite: longest,
		cacheWrite1h: longest,
		reasoning: longest,
		total: longest,
		cost: longest,
		unpriced: Number.MAX_SAFE_INTEGER,
	}));
	const text = json({ v: 1, state: "running", metered: true, totals: { input: longest, output: longest, total: longest, cost: longest, calls: Number.MAX_SAFE_INTEGER, unresolved: Number.MAX_SAFE_INTEGER, unpriced: Number.MAX_SAFE_INTEGER, sessions: Number.MAX_SAFE_INTEGER }, rows, spentMicros: Number.MAX_SAFE_INTEGER, inflightMicros: Number.MAX_SAFE_INTEGER, costRefused: Number.MAX_SAFE_INTEGER, modelRefused: Number.MAX_SAFE_INTEGER });
	assert.ok(Buffer.byteLength(text) <= CHILD_LEDGER_MAX_BYTES, `${Buffer.byteLength(text)} bytes`);
	assert.ok(CHILD_LEDGER_ROWS <= CHILD_LEDGER_MAX_ROWS);
});

test("on a real directory: a FIFO does not hang the fold, a symlink is not followed, a real ledger is read", { skip: process.platform === "win32" }, () => {
	const dir = tempDir("pi-dispatch-ledger-");
	writeFileSync(join(dir, NAME_A), json(ledger({ calls: 2 })));
	writeFileSync(join(dir, "target.json"), json(ledger({ calls: 50 })));
	symlinkSync(join(dir, "target.json"), join(dir, NAME_B));
	const fifo = "303.00000000000000ff.json";
	execFileSync("mkfifo", [join(dir, fifo)]);
	const result = foldChildLedgers({ dir });
	assert.deepEqual([result.processes, result.unmetered, result.totals.total], [3, 2, 20]);
	assert.deepEqual([result.files.get(NAME_B).why, result.files.get(fifo).why], ["malformed", "malformed"]);
});
