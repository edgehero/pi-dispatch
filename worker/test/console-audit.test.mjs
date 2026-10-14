import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { CONSOLE_AUDIT_ACTIONS, CONSOLE_AUDIT_FIELD_MAX, CONSOLE_AUDIT_KEY, CONSOLE_AUDIT_OUTCOMES, makeConsoleAudit, makeConsoleAuditReaper, mirrorRow, verifyConsoleAudit } from "../src/console-audit.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// The console's audit log (issue #640, INT-CONSOLE-AUDIT-LOG). Every test drives an injected clock: rows land in the
// month file of `at`, and the reaper judges mtimes against `now`.
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);
const DAY = 86400000;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const actor = { name: "alice", role: "operator", session: "abc123def456" };
const row = (extra = {}) => ({ actor, action: "login", outcome: "ok", ...extra });

function setup(start = T0) {
	const logsDir = tempDir("pd-console-audit-");
	let t = start;
	const clock = { now: () => t, set: (v) => (t = v) };
	const audit = makeConsoleAudit({ logsDir, now: clock.now });
	const dir = join(logsDir, "console-audit");
	const lines = (month) => fs.readFileSync(join(dir, `${month}.jsonl`), "utf8").split("\n").filter((l) => l !== "");
	return { logsDir, dir, audit, clock, lines };
}

test("the vocabularies are frozen and match the contract", () => {
	assert.ok(Object.isFrozen(CONSOLE_AUDIT_ACTIONS) && Object.isFrozen(CONSOLE_AUDIT_OUTCOMES));
	assert.deepEqual([...CONSOLE_AUDIT_ACTIONS], ["login", "login-failed", "login-code", "logout", "refused", "write", "token-added", "token-revoked", "token-rotated", "sessions-ended", "serve-started"]);
	assert.deepEqual([...CONSOLE_AUDIT_OUTCOMES], ["ok", "refused", "failed"]);
});

test("append stamps at, seq and prev (sha256 of the previous raw line), into a 0700 dir and a 0600 month file", () => {
	const { dir, audit, clock, lines } = setup();
	const first = audit.append(row());
	assert.equal(first.at, new Date(T0).toISOString());
	assert.equal(first.seq, 1);
	assert.equal(first.prev, null, "only the very first row has no prev");
	clock.set(T0 + 1000);
	const second = audit.append(row({ action: "write", target: "pause-windows", beforeDigest: "aa", afterDigest: "bb", ticket: "t1" }));
	const raw = lines("2026-10");
	assert.equal(raw.length, 2);
	assert.equal(second.seq, 2);
	assert.equal(second.prev, sha(raw[0]));
	assert.deepEqual(JSON.parse(raw[1]), second);
	assert.deepEqual(Object.keys(second), ["at", "seq", "prev", "actor", "action", "target", "outcome", "beforeDigest", "afterDigest", "ticket"]);
	assert.deepEqual(audit.head(), { seq: 2, hash: sha(raw[1]) });
	if (process.platform !== "win32") {
		assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
		assert.equal(fs.statSync(join(dir, "2026-10.jsonl")).mode & 0o777, 0o600);
	}
});

test("a new writer recovers the head from the newest month file, across a month boundary", () => {
	const { logsDir, audit, lines } = setup(Date.UTC(2026, 9, 31, 23, 59, 0));
	audit.append(row());
	audit.append(row({ action: "logout" }));
	// A second process (the CLI beside `serve`), a month later: it links to the October file's last line.
	const later = makeConsoleAudit({ logsDir, now: () => Date.UTC(2026, 10, 1, 0, 1, 0) });
	const next = later.append(row({ action: "token-added", actor: { name: "shell", role: "shell", session: null } }));
	assert.equal(next.seq, 3);
	assert.equal(next.prev, sha(lines("2026-10")[1]));
	assert.equal(lines("2026-11").length, 1);
	// And the first writer, which has appended before, sees the CLI's row rather than a stale head of its own.
	const after = audit.append(row({ action: "logout" }));
	assert.equal(after.seq, 4);
	assert.equal(after.prev, sha(lines("2026-11")[0]));
	assert.deepEqual(verifyConsoleAudit({ logsDir }), { ok: true, rows: 4, startsAt: null });
});

test("a clock stepped back across a month keeps appending to the newest file, so the chain stays in file order", () => {
	const { logsDir, audit, clock, lines } = setup(Date.UTC(2026, 10, 1, 0, 0, 5));
	audit.append(row());
	clock.set(Date.UTC(2026, 9, 31, 23, 59, 59));
	audit.append(row({ action: "logout" }));
	assert.equal(lines("2026-11").length, 2);
	assert.equal(fs.existsSync(join(logsDir, "console-audit", "2026-10.jsonl")), false);
	assert.equal(verifyConsoleAudit({ logsDir }).ok, true);
});

test("an unknown action or outcome, or a missing actor, throws and writes nothing", () => {
	const { dir, audit } = setup();
	assert.throws(() => audit.append(row({ action: "delete-everything" })), /unknown action/);
	assert.throws(() => audit.append(row({ outcome: "maybe" })), /unknown outcome/);
	assert.throws(() => audit.append({ action: "login", outcome: "ok" }), /actor must be an object/);
	assert.throws(() => audit.append(row({ actor: { name: 7, role: "operator" } })), /actor\.name must be a string/);
	assert.equal(fs.existsSync(dir), false);
});

test("string fields have their control characters written out and are capped at 200 code points", () => {
	const { audit, lines } = setup();
	const esc = String.fromCharCode(27);
	const bell = String.fromCharCode(7);
	const stored = audit.append(row({ action: "refused", outcome: "refused", target: `evil${esc}[2Jhost${bell}`, reason: "x".repeat(500) }));
	assert.equal(stored.target, "evil\\u{001B}[2Jhost\\u{0007}");
	assert.equal([...stored.reason].length, CONSOLE_AUDIT_FIELD_MAX);
	const raw = lines("2026-10")[0];
	assert.equal([...raw].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127), false, "no raw control byte reaches the file");
	// The cap counts code points, so an astral character is never cut in half.
	const astral = audit.append(row({ reason: "\u{1F600}".repeat(300) }));
	assert.equal([...astral.reason].length, CONSOLE_AUDIT_FIELD_MAX);
	assert.equal(astral.reason.isWellFormed(), true);
});

test("append throws when the file cannot be written, and when the head is not a row", () => {
	const { logsDir, dir, audit } = setup();
	audit.append(row());
	const failing = makeConsoleAudit({ logsDir, now: () => T0, fs: { ...fs, appendFileSync: () => { throw Object.assign(new Error("disk full"), { code: "ENOSPC" }); } } });
	assert.throws(() => failing.append(row()), /disk full/);
	fs.appendFileSync(join(dir, "2026-10.jsonl"), "not json\n");
	assert.throws(() => audit.append(row()), /is not an audit row/);
});

test("a symlinked month file is refused, never written through", { skip: process.platform === "win32" }, () => {
	const { logsDir, dir, audit } = setup();
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const elsewhere = join(logsDir, "elsewhere.jsonl");
	fs.writeFileSync(elsewhere, "");
	fs.symlinkSync(elsewhere, join(dir, "2026-10.jsonl"));
	assert.throws(() => audit.append(row()), /is a symlink/);
	assert.equal(fs.readFileSync(elsewhere, "utf8"), "");
});

function chain(n = 5) {
	const s = setup();
	for (let i = 0; i < n; i++) {
		s.clock.set(T0 + i * 1000);
		s.audit.append(row({ target: `t${i}` }));
	}
	const file = join(s.dir, "2026-10.jsonl");
	const rewrite = (fn) => fs.writeFileSync(file, `${fn(s.lines("2026-10")).join("\n")}\n`);
	return { ...s, rewrite };
}

test("verify passes an intact chain and an empty or missing log", () => {
	const { logsDir } = chain();
	assert.deepEqual(verifyConsoleAudit({ logsDir }), { ok: true, rows: 5, startsAt: null });
	assert.deepEqual(verifyConsoleAudit({ logsDir: tempDir("pd-console-audit-none-") }), { ok: true, rows: 0, startsAt: null });
});

test("verify names a tampered field by the broken link of the row after it", () => {
	const { logsDir, rewrite } = chain();
	rewrite((ls) => ls.map((l, i) => (i === 1 ? l.replace('"t1"', '"tX"') : l)));
	const v = verifyConsoleAudit({ logsDir });
	assert.equal(v.ok, false);
	assert.deepEqual({ file: v.broken.file, line: v.broken.line }, { file: "2026-10.jsonl", line: 3 });
	assert.match(v.broken.reason, /prev does not match/);
	assert.equal(v.rows, 2);
});

test("verify names a deleted middle row, reordered rows and a non-JSON line", () => {
	const deleted = chain();
	deleted.rewrite((ls) => ls.filter((_, i) => i !== 2));
	assert.deepEqual(verifyConsoleAudit({ logsDir: deleted.logsDir }).broken.line, 3);

	const swapped = chain();
	swapped.rewrite((ls) => [ls[0], ls[2], ls[1], ls[3], ls[4]]);
	const v = verifyConsoleAudit({ logsDir: swapped.logsDir });
	assert.equal(v.broken.line, 2);
	assert.match(v.broken.reason, /changed, removed or moved/);

	const junk = chain();
	junk.rewrite((ls) => [ls[0], ls[1], "{not json", ls[2]]);
	const j = verifyConsoleAudit({ logsDir: junk.logsDir });
	assert.deepEqual(j.broken, { file: "2026-10.jsonl", line: 3, reason: "the line is not a JSON row (damaged, or written by something else)" });
});

test("verify reports where a chain whose head was reaped starts, instead of failing", () => {
	const { logsDir, dir, audit, clock } = setup(Date.UTC(2026, 8, 30, 12, 0, 0));
	audit.append(row());
	audit.append(row());
	clock.set(T0);
	audit.append(row());
	audit.append(row());
	fs.unlinkSync(join(dir, "2026-09.jsonl"));
	assert.deepEqual(verifyConsoleAudit({ logsDir }), { ok: true, rows: 2, startsAt: { file: "2026-10.jsonl", seq: 3 } });
	// A forged restart (prev null past seq 1) is not a reaped head: it is broken.
	const forged = chain(2);
	forged.rewrite((ls) => [JSON.stringify({ ...JSON.parse(ls[0]), seq: 7 })]);
	assert.match(verifyConsoleAudit({ logsDir: forged.logsDir }).broken.reason, /first row has no prev but seq 7/);
});

test("the reaper removes month files past retention by mtime, keeps the newest and every other name", () => {
	const { logsDir, dir } = setup();
	fs.mkdirSync(dir, { recursive: true });
	for (const name of ["2026-07.jsonl", "2026-08.jsonl", "2026-09.jsonl", "notes.txt", "2026-7.jsonl"]) fs.writeFileSync(join(dir, name), "");
	const old = (T0 - 100 * DAY) / 1000;
	for (const name of ["2026-07.jsonl", "2026-08.jsonl", "2026-09.jsonl", "notes.txt", "2026-7.jsonl"]) fs.utimesSync(join(dir, name), old, old);
	fs.utimesSync(join(dir, "2026-08.jsonl"), (T0 - 10 * DAY) / 1000, (T0 - 10 * DAY) / 1000);
	const events = [];
	makeConsoleAuditReaper({ logsDir, retentionDays: 30, now: () => T0, log: (e, f) => events.push([e, f]) })();
	assert.deepEqual(fs.readdirSync(dir).sort(), ["2026-08.jsonl", "2026-09.jsonl", "2026-7.jsonl", "notes.txt"], "the newest file holds the head and stays, however old");
	assert.deepEqual(events, [["reaped_console_audit", { file: "2026-07.jsonl" }]]);
	makeConsoleAuditReaper({ logsDir, retentionDays: 0, now: () => T0 + 1000 * DAY })();
	assert.equal(fs.readdirSync(dir).length, 4, "0 keeps everything");
	makeConsoleAuditReaper({ logsDir: tempDir("pd-console-audit-empty-"), retentionDays: 30, now: () => T0 })();
});

test("mirrorRow pushes then trims console:audit, and never throws", async () => {
	const calls = [];
	const redis = { lpush: async (...a) => calls.push(["lpush", ...a]), ltrim: async (...a) => calls.push(["ltrim", ...a]) };
	const r = { at: "x", seq: 1 };
	assert.equal(await mirrorRow(redis, r, 3), true);
	assert.deepEqual(calls, [["lpush", CONSOLE_AUDIT_KEY, JSON.stringify(r)], ["ltrim", CONSOLE_AUDIT_KEY, 0, 2]]);
	assert.equal(await mirrorRow({ lpush: async () => { throw new Error("down"); } }, r), false);
	assert.equal(await mirrorRow(null, r), false);
});

test("two processes appending at once take turns under the append lock: one unbroken chain, no seq written twice", async () => {
	const { logsDir } = setup();
	const { spawn } = await import("node:child_process");
	const src = new URL("../src/console-audit.mjs", import.meta.url).href;
	const script = `import { makeConsoleAudit } from ${JSON.stringify(src)};
const audit = makeConsoleAudit({ logsDir: process.argv[1] });
for (let i = 0; i < 150; i++) audit.append({ actor: { name: "w", role: "operator", session: null }, action: "login", outcome: "ok" });`;
	const run = () => new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", script, logsDir], { stdio: ["ignore", "ignore", "pipe"] });
		let err = "";
		child.stderr.on("data", (c) => (err += c));
		child.on("error", reject);
		child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`writer exited ${code}: ${err}`))));
	});
	await Promise.all([run(), run()]);
	assert.deepEqual(verifyConsoleAudit({ logsDir }), { ok: true, rows: 300, startsAt: null });
	assert.equal(fs.existsSync(join(logsDir, "console-audit", ".append.lock")), false, "the lock is removed after the last append");
});

test("the append lock: a dead holder's lock is taken over, a live one makes append throw and writes nothing, and age never decides", () => {
	const { logsDir, dir, lines } = setup();
	const dead = 4242;
	const audit = makeConsoleAudit({ logsDir, now: () => T0, alive: (pid) => pid !== dead });
	audit.append(row());
	const lock = join(dir, ".append.lock");
	fs.writeFileSync(lock, `${dead}\n`);
	assert.equal(audit.append(row()).seq, 2, "a dead pid's lock is a crashed holder's");
	assert.equal(fs.existsSync(lock), false);
	// A live holder whose lock LOOKS a year old (an mtime far behind this clock, as on a skewed mount or under the
	// clock-shifted CI run) is still live: age never decides.
	fs.writeFileSync(lock, `${process.pid}\n`);
	const old = (Date.now() - 365 * DAY) / 1000;
	fs.utimesSync(lock, old, old);
	assert.throws(() => audit.append(row()), (e) => e.code === "EAUDITLOCKED" && /locked by another writer .*pid \d+/.test(e.message));
	assert.equal(lines("2026-10").length, 2, "nothing was appended while another writer held the lock");
	assert.equal(fs.readFileSync(lock, "utf8"), `${process.pid}\n`, "a refused append leaves the holder's lock alone");
});

test("the append lock removes only a lock that still holds this writer's own token", () => {
	const { logsDir, dir, lines } = setup();
	const lock = join(dir, ".append.lock");
	// While this writer appends, it is judged dead and another writer takes the lock over: the finally must leave the
	// other writer's lock in place, or a third writer would get in beside it.
	const other = `${process.pid} feedfacefeedface\n`;
	let ours = null;
	const takenOver = {
		...fs,
		appendFileSync(...args) {
			ours = fs.readFileSync(lock, "utf8");
			fs.unlinkSync(lock);
			fs.writeFileSync(lock, other);
			return fs.appendFileSync(...args);
		},
	};
	const audit = makeConsoleAudit({ logsDir, now: () => T0, fs: takenOver });
	assert.equal(audit.append(row()).seq, 1);
	assert.match(ours, /^\d+ [0-9a-f]{16}\n$/, "the lock holds the holder's pid and a token of its own");
	assert.equal(fs.readFileSync(lock, "utf8"), other, "another holder's lock is not removed");
	assert.equal(lines("2026-10").length, 1);
});

test("a takeover removes the dead lock only while it still holds the text judged dead", () => {
	const { logsDir, dir } = setup();
	const dead = 4242;
	const lock = join(dir, ".append.lock");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const stale = `${dead} 0000000000000000\n`;
	const fresh = `${process.pid} 1111111111111111\n`;
	fs.writeFileSync(lock, stale);
	// Another writer that judged the same dead lock removes it and creates its fresh one between this writer's judging
	// read and its unlink. The fresh lock must survive; it goes away only when its holder finishes (here, a few reads on).
	let reads = 0;
	const removed = [];
	const racing = {
		...fs,
		readFileSync(p, ...rest) {
			if (p === lock) {
				reads += 1;
				if (reads === 1) {
					const text = fs.readFileSync(p, ...rest);
					fs.unlinkSync(lock);
					fs.writeFileSync(lock, fresh);
					return text;
				}
				if (reads === 4) fs.unlinkSync(lock);
			}
			return fs.readFileSync(p, ...rest);
		},
		unlinkSync(p) {
			if (p === lock) removed.push(fs.readFileSync(lock, "utf8"));
			return fs.unlinkSync(p);
		},
	};
	const audit = makeConsoleAudit({ logsDir, now: () => T0, fs: racing, alive: (pid) => pid !== dead });
	assert.equal(audit.append(row()).seq, 1);
	assert.equal(removed.includes(fresh), false, "the other writer's fresh lock was never unlinked by this one");
});

test("verify names a seq that does not rise by one, and an action or outcome the console never writes", () => {
	const skipped = chain(3);
	// Re-link row 3 to row 2 so only its seq is wrong: prev still matches.
	skipped.rewrite((ls) => [ls[0], ls[1], JSON.stringify({ ...JSON.parse(ls[2]), seq: 5 })]);
	const s = verifyConsoleAudit({ logsDir: skipped.logsDir });
	assert.equal(s.ok, false);
	assert.deepEqual({ line: s.broken.line, reason: s.broken.reason }, { line: 3, reason: "seq 5 follows seq 2" });

	for (const change of [{ action: "delete-everything" }, { outcome: "maybe" }]) {
		const odd = chain(2);
		odd.rewrite((ls) => [ls[0], JSON.stringify({ ...JSON.parse(ls[1]), ...change })]);
		const v = verifyConsoleAudit({ logsDir: odd.logsDir });
		assert.equal(v.ok, false, JSON.stringify(change));
		assert.deepEqual({ line: v.broken.line, reason: v.broken.reason }, { line: 2, reason: "the row's action or outcome is not one the console writes" });
	}
});

test("append refuses a tail that is one partial line longer than the bounded read, and writes nothing", () => {
	const { dir, audit, lines } = setup();
	audit.append(row());
	const file = join(dir, "2026-10.jsonl");
	// A line longer than the tail read (a damaged or foreign write): the read starts mid-line and cannot vouch for it.
	fs.appendFileSync(file, `${"x".repeat(70000)}\n`);
	const before = fs.readFileSync(file, "utf8");
	assert.throws(() => audit.append(row()), /ends in a line longer than 65536 bytes/);
	assert.equal(fs.readFileSync(file, "utf8"), before);
	assert.equal(lines("2026-10").length, 2);
});

test("a symlinked audit directory is refused, never written through", { skip: process.platform === "win32" }, () => {
	const { logsDir, dir, audit } = setup();
	const elsewhere = join(logsDir, "elsewhere");
	fs.mkdirSync(elsewhere, { mode: 0o700 });
	fs.symlinkSync(elsewhere, dir);
	assert.throws(() => audit.append(row()), /audit directory .* is a symlink/);
	assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test("verify walks a file larger than its read chunk, rows with multi-byte characters straddling the chunk edges", () => {
	const { logsDir, dir, audit } = setup();
	// About 3 MiB of rows, each with a target of two-byte and four-byte characters, so chunk edges fall inside them.
	const target = "é😀".repeat(60);
	for (let i = 0; i < 6000; i++) audit.append(row({ action: "refused", outcome: "refused", target }));
	assert.ok(fs.statSync(join(dir, "2026-10.jsonl")).size > 3 * 1024 * 1024);
	assert.deepEqual(verifyConsoleAudit({ logsDir }), { ok: true, rows: 6000, startsAt: null });
	// and a damaged row deep in the file is still found, at its own line
	const path = join(dir, "2026-10.jsonl");
	const lines = fs.readFileSync(path, "utf8").split("\n");
	lines[4321] = lines[4321].replace('"refused","target"', '"refused" ,"target"');
	fs.writeFileSync(path, lines.join("\n"));
	const res = verifyConsoleAudit({ logsDir });
	assert.equal(res.ok, false);
	assert.equal(res.broken.line, 4323, "the row after the edited one breaks, at its 1-based line");
});
