import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync as realReadFileSync, rmSync, unlinkSync as realUnlinkSync, writeFileSync as realWriteFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeTriggers, disarmTrigger, makeCheckOnceSpent, makeDisarmOnce, readDisarmState } from "../src/triggers-file.mjs";
import { parseTriggers } from "../src/triggers.mjs";

// In-memory fs modelled on the admin read-model tests' fake (files + mtimes + openSync "wx"/EEXIST +
// statSync mtimeMs) but defined HERE, not imported: worker tests do not reach into admin test helpers,
// and this copy grows three abilities the lock/retry paths need that the admin one does not --
// pre-seeding a lock with an arbitrary mtime (stale takeover), one-shot fs faults (a rename that
// EPERMs once, a write that ENOSPCs), and a call-order trace (proving "gave up BEFORE reading" and
// "released the lock AFTER the rename", which no end-state assertion can).
function triggerFs(initial = {}) {
	const files = { ...initial };
	const mtimes = {};
	const calls = [];
	const faults = {};
	let nextFd = 3;
	const err = (code) => Object.assign(new Error(code), { code });
	// Injected faults fire BEFORE the method's effect, like the real syscall failing: a failed open
	// creates no file, a failed write leaves the old bytes.
	const maybeFail = (method) => {
		const f = faults[method];
		if (!f || f.times <= 0) return;
		f.times -= 1;
		throw err(f.code);
	};
	return {
		files,
		mtimes,
		calls,
		// times = 1 is the transient fault (EPERM once, then clean); Infinity is the persistent one.
		failNext(method, code, times = 1) {
			faults[method] = { code, times };
		},
		// Pre-seed a lock whose age WE choose -- the live-vs-stale branch is pure mtime arithmetic, so
		// the tests never have to actually wait ten seconds.
		seedLock(lockPath, ageMs) {
			files[lockPath] = "";
			mtimes[lockPath] = Date.now() - ageMs;
		},
		readFileSync(p) {
			calls.push(`readFileSync:${p}`);
			maybeFail("readFileSync");
			if (!(p in files)) throw err("ENOENT");
			return files[p];
		},
		writeFileSync(p, data) {
			calls.push(`writeFileSync:${p}`);
			maybeFail("writeFileSync");
			files[p] = String(data);
			mtimes[p] = Date.now();
		},
		renameSync(a, b) {
			calls.push(`renameSync:${a}->${b}`);
			maybeFail("renameSync");
			files[b] = files[a];
			mtimes[b] = mtimes[a] ?? Date.now();
			delete files[a];
			delete mtimes[a];
		},
		openSync(p, flags) {
			calls.push(`openSync:${p}`);
			maybeFail("openSync");
			if (flags === "wx" && p in files) throw err("EEXIST");
			files[p] = "";
			mtimes[p] = Date.now();
			return nextFd++;
		},
		closeSync() {
			calls.push("closeSync");
		},
		unlinkSync(p) {
			calls.push(`unlinkSync:${p}`);
			maybeFail("unlinkSync");
			if (!(p in files)) throw err("ENOENT");
			delete files[p];
			delete mtimes[p];
		},
		statSync(p) {
			calls.push(`statSync:${p}`);
			if (!(p in files)) throw err("ENOENT");
			return { mtimeMs: mtimes[p] ?? Date.now() };
		},
	};
}

const T_PATH = "/repo/.pi/triggers.json";
const LOCK = `${T_PATH}.lock`;
const AT = "2026-08-28T09:00:00.000Z";

// A valid armed one-shot, plus a cron and a label neighbour so the index arithmetic in the disarm
// tests is exercised against a REAL position, not position zero of a one-entry file.
const onceTrigger = (number = 40) => ({ on: { type: "issue", action: ["closed"], number, once: true }, run: { kind: "github", flow: "deploy" } });
const cronTrigger = () => ({ on: { type: "cron", id: "nightly", pattern: "0 3 * * *" }, run: { kind: "local", folder: "/srv/site", flow: "audit", task: "run the nightly audit" } });
const labelTrigger = () => ({ on: { type: "label", any: ["dispatch"] }, run: { kind: "github", flow: "fix" } });
const fileOf = (triggers) => `${JSON.stringify({ triggers }, null, 2)}\n`;
const collectLog = () => {
	const events = [];
	const log = (event, fields) => events.push({ event, fields });
	return { events, log };
};

// ── writeTriggers: moved semantics ──────────────────────────────────────────────────────────────────────

test("writeTriggers emits the exact historical bytes: 2-space JSON plus one trailing newline", () => {
	// Pinned as a LITERAL, not recomputed through JSON.stringify in the test: the move out of the
	// admin (issue #231) put this serializer in a tabs-styled file, and both live-reload watchers and
	// the operator's diffs read these bytes, so any drift (tab indent, lost newline, key reshuffle)
	// must go red here even if the module and the test drifted together.
	const fs = triggerFs({ [T_PATH]: fileOf([]) });
	const res = writeTriggers({ triggersPath: T_PATH, fs, mutate: () => [labelTrigger()] });
	assert.deepEqual(res, { ok: true });
	const pinned = [
		"{",
		"  \"triggers\": [",
		"    {",
		"      \"on\": {",
		"        \"type\": \"label\",",
		"        \"any\": [",
		"          \"dispatch\"",
		"        ]",
		"      },",
		"      \"run\": {",
		"        \"kind\": \"github\",",
		"        \"flow\": \"fix\"",
		"      }",
		"    }",
		"  ]",
		"}",
		"",
	].join("\n");
	assert.equal(fs.files[T_PATH], pinned, "the triggers file format is a contract: 2-space JSON with a trailing newline, byte-for-byte what the admin always wrote");
});

test("writeTriggers scaffolds a missing file from empty (the operator CRUD repair posture)", () => {
	const fs = triggerFs();
	const res = writeTriggers({ triggersPath: T_PATH, fs, mutate: (list) => [...list, labelTrigger()] });
	assert.deepEqual(res, { ok: true });
	const written = JSON.parse(fs.files[T_PATH]);
	assert.equal(written.triggers.length, 1, "a missing file plus 'add trigger' must scaffold the first entry, not refuse");
	assert.equal(`${T_PATH}.tmp` in fs.files, false, "the tmp file is renamed away -- the write stays atomic");
});

test("writeTriggers returns { invalid } for a mutate result the loaders would reject, file untouched", () => {
	const orig = fileOf([labelTrigger()]);
	const fs = triggerFs({ [T_PATH]: orig });
	const res = writeTriggers({ triggersPath: T_PATH, fs, mutate: (list) => [...list, { on: { type: "nope" }, run: {} }] });
	assert.ok(res.invalid, "the shared parseTriggers must refuse before the write, never after it");
	assert.equal(fs.files[T_PATH], orig, "an invalid write never touches the file (fail-closed)");
});

// ── writeTriggers: the lock ─────────────────────────────────────────────────────────────────────────────

test("writeTriggers gives up immediately on a live lock: { invalid } naming the lock, before any read", () => {
	const orig = fileOf([labelTrigger()]);
	const fs = triggerFs({ [T_PATH]: orig });
	fs.seedLock(LOCK, 0); // a live writer: mtime is now
	const res = writeTriggers({ triggersPath: T_PATH, fs, mutate: (list) => list });
	assert.ok(res.invalid, "a held lock is an { invalid } report, not a throw and not a silent success");
	assert.ok(res.invalid.includes(LOCK), `the refusal must name the lock file the operator can inspect, got: ${res.invalid}`);
	assert.equal(fs.files[T_PATH], orig, "losing the lock race must leave the file byte-identical");
	// The give-up happens BEFORE the read-modify-write even starts: the callers sit on the pi TUI
	// event loop, so any retry or sleep here is a frozen panel. The call trace is the only witness.
	assert.ok(!fs.calls.some((c) => c.startsWith("readFileSync:")), "a contended writeTriggers must not read (no retry, no sleep -- the operator re-presses)");
	assert.ok(!fs.calls.some((c) => c.startsWith("writeFileSync:")), "a contended writeTriggers must not write anything");
});

test("writeTriggers takes over a stale lock (crashed writer) and the write succeeds", () => {
	const { events, log } = collectLog();
	const fs = triggerFs({ [T_PATH]: fileOf([labelTrigger()]) });
	fs.seedLock(LOCK, 11_000); // older than LOCK_STALE_MS: a crashed writer's leak, not a live write
	const res = writeTriggers({ triggersPath: T_PATH, fs, log, mutate: (list) => [...list, onceTrigger()] });
	assert.deepEqual(res, { ok: true }, "a stale lock must not wedge every trigger edit forever -- there is no reaper for this file");
	assert.equal(JSON.parse(fs.files[T_PATH]).triggers.length, 2, "the write behind the takeover must land");
	assert.ok(events.some((e) => e.event === "triggers_lock_stale_taken"), "the takeover is logged so an operator can see a writer crashed");
	assert.ok(fs.calls.includes(`unlinkSync:${LOCK}`), "the stale lock is unlinked, not written through");
});

test("writeTriggers releases the lock after success AND after { invalid }, and only after the rename", () => {
	// Success path: the lock must outlive the rename it guards -- released before it, a second writer
	// could read the pre-rename bytes while our tmp is still in flight.
	const fs = triggerFs({ [T_PATH]: fileOf([labelTrigger()]) });
	const res = writeTriggers({ triggersPath: T_PATH, fs, mutate: (list) => [...list, onceTrigger()] });
	assert.deepEqual(res, { ok: true });
	assert.equal(LOCK in fs.files, false, "the lock is released on the success path");
	const renameIx = fs.calls.findIndex((c) => c.startsWith("renameSync:"));
	const unlockIx = fs.calls.lastIndexOf(`unlinkSync:${LOCK}`);
	assert.ok(renameIx !== -1 && unlockIx > renameIx, "the lock must be released AFTER the rename lands, never before");

	// Invalid path: a validation refusal that leaked the lock would turn every later write into a
	// ten-second stale-takeover wait.
	const fs2 = triggerFs({ [T_PATH]: fileOf([labelTrigger()]) });
	const bad = writeTriggers({ triggersPath: T_PATH, fs: fs2, mutate: () => [{ on: { type: "nope" }, run: {} }] });
	assert.ok(bad.invalid, "the mutate result is invalid by construction");
	assert.equal(LOCK in fs2.files, false, "the lock is released on the { invalid } path too");
});

test("writeTriggers retries a single EPERM on rename, then succeeds", () => {
	// writeOverlay's precedent: a Windows AV/indexer briefly holds the destination and the second
	// rename lands. One retry, not a loop.
	const fs = triggerFs({ [T_PATH]: fileOf([labelTrigger()]) });
	fs.failNext("renameSync", "EPERM", 1);
	const res = writeTriggers({ triggersPath: T_PATH, fs, mutate: (list) => [...list, onceTrigger()] });
	assert.deepEqual(res, { ok: true }, "one transient EPERM must be absorbed by the single retry");
	assert.equal(JSON.parse(fs.files[T_PATH]).triggers.length, 2, "the retried rename must have landed the new bytes");
	assert.equal(`${T_PATH}.tmp` in fs.files, false, "the tmp is renamed away on the retry");
});

test("writeTriggers throws when EPERM persists past the single retry (fs failures keep throwing)", () => {
	const orig = fileOf([labelTrigger()]);
	const fs = triggerFs({ [T_PATH]: orig });
	fs.failNext("renameSync", "EPERM", 2);
	// The contract writeTriggers has always had: a determinate validation problem returns { invalid },
	// an fs failure THROWS so the caller surfaces it loudly (CONST-RETRY-INFRA-ONLY's shape).
	assert.throws(
		() => writeTriggers({ triggersPath: T_PATH, fs, mutate: (list) => [...list, onceTrigger()] }),
		(e) => e?.code === "EPERM",
		"a persistent EPERM must propagate, not degrade into { invalid } or a silent success"
	);
	assert.equal(fs.files[T_PATH], orig, "the destination keeps the old bytes when the rename never lands");
	assert.equal(LOCK in fs.files, false, "the lock is released even when the write throws (finally)");
});

test("writeTriggers throws on a non-EEXIST lock-create failure instead of reporting locked", () => {
	// The session-store doctrine: EEXIST is the ONLY failure that means "locked". Reporting EACCES (a
	// read-only dir) as "another write in progress" sends an operator hunting for a stuck lock file
	// that does not exist, while the real problem is a permission bit.
	const orig = fileOf([labelTrigger()]);
	const fs = triggerFs({ [T_PATH]: orig });
	fs.failNext("openSync", "EACCES", 1);
	assert.throws(
		() => writeTriggers({ triggersPath: T_PATH, fs, mutate: (list) => list }),
		(e) => e?.code === "EACCES",
		"a non-EEXIST openSync failure must throw as itself, never masquerade as contention"
	);
	assert.equal(fs.files[T_PATH], orig, "the failed lock attempt must not have touched the file");
	assert.ok(!fs.calls.some((c) => c.startsWith("readFileSync:")), "the throw happens before any read");
});

test("writeTriggers logs triggers_lock_stuck when the lock unlink fails, and still returns ok", () => {
	// The leaked-lock branch (session-store doctrine: logged, never thrown). Without this pin, deleting
	// the catch turns every AV-held unlink into a throw out of the operator's keypress.
	const fs = triggerFs({ [T_PATH]: fileOf([labelTrigger()]) });
	const events = [];
	// The unlink faults fire in order: the first unlink after a write is the LOCK release (tmp is
	// renamed, not unlinked), so one fault hits exactly the release path.
	fs.failNext("unlinkSync", "EPERM", 1);
	const res = writeTriggers({ triggersPath: T_PATH, fs, mutate: (list) => list, log: (event, fields) => events.push({ event, fields }) });
	assert.deepEqual(res, { ok: true }, "a stuck lock is bookkeeping, never a failed write");
	assert.ok(events.some((e) => e.event === "triggers_lock_stuck"), "the leak is logged so the 10s takeover delay has a visible cause");
});

// ── disarmTrigger ───────────────────────────────────────────────────────────────────────────────────────

test("disarmTrigger folds a non-EEXIST lock failure to { invalid }, never a throw", async () => {
	// The branch that makes "never throws" survive a read-only directory: the post-run hook must log a
	// failed disarm, not crash the worker's recordRun path. Deleting the try/catch around takeLock
	// makes this throw EACCES straight into the hook.
	const orig = fileOf([onceTrigger(40)]);
	const fs = triggerFs({ [T_PATH]: orig });
	fs.failNext("openSync", "EACCES", 1);
	const res = await disarmTrigger({ triggersPath: T_PATH, index: 0, number: 40, jobId: "j", at: AT, fs });
	assert.match(res.invalid, /lock failed \(EACCES\)/, "the reason names the real failure, not contention");
	assert.equal(fs.files[T_PATH], orig, "the file is untouched when the lock could not be taken");
});

test("disarmTrigger adds exactly on.disarmed = { at, jobId } to the matched entry and nothing else", async () => {
	const before = [cronTrigger(), onceTrigger(40), labelTrigger()];
	const orig = fileOf(before);
	const fs = triggerFs({ [T_PATH]: orig });
	const res = await disarmTrigger({ triggersPath: T_PATH, index: 1, number: 40, jobId: "job-abc", at: AT, fs });
	assert.deepEqual(res, { ok: true });

	// The worker's entire write authority over this file is ONE added key: parse the result, delete
	// that key, and what remains must deep-equal the original file -- any other difference is the
	// worker editing what only an operator may edit.
	const after = JSON.parse(fs.files[T_PATH]);
	assert.deepEqual(after.triggers[1].on.disarmed, { at: AT, jobId: "job-abc" }, "the disarm mark carries at + jobId, exactly");
	delete after.triggers[1].on.disarmed;
	assert.deepEqual(after, JSON.parse(orig), "removing on.disarmed must restore the original file exactly -- the disarm changed nothing else");

	// And byte-level: reconstructing the expected file from the original parse plus the one mark must
	// reproduce the written bytes, so the neighbours (cron at 0, label at 2) are byte-identical too.
	const expected = JSON.parse(orig);
	expected.triggers[1].on.disarmed = { at: AT, jobId: "job-abc" };
	assert.equal(fs.files[T_PATH], fileOf(expected.triggers), "neighbour entries must come back byte-identical; only the disarmed region is new");
});

test("disarmTrigger with jobId omitted writes a disarmed mark carrying only at", async () => {
	// The hand-disarm shape: an operator disarming deliberately has no run record to point at. The
	// conditional spread keeps the in-memory mark identical to the written one -- JSON.stringify would
	// drop an undefined-valued jobId at serialization anyway, so an unconditional key would make the
	// object the code holds disagree with the bytes it wrote.
	const fs = triggerFs({ [T_PATH]: fileOf([onceTrigger(40)]) });
	const res = await disarmTrigger({ triggersPath: T_PATH, index: 0, number: 40, at: AT, fs });
	assert.deepEqual(res, { ok: true });
	const mark = JSON.parse(fs.files[T_PATH]).triggers[0].on.disarmed;
	assert.deepEqual(mark, { at: AT }, "no jobId given means no jobId key -- the mark must not grow keys");
});

test("disarmTrigger on an already-disarmed entry returns { already } and leaves the file byte-identical", async () => {
	// A sibling replica or a webhook redelivery losing the race is idempotent SUCCESS, not failure:
	// the one-shot was spent, which is what the caller wanted true.
	const spent = onceTrigger(40);
	spent.on.disarmed = { at: "2026-08-27T00:00:00.000Z", jobId: "job-first" };
	const orig = fileOf([spent]);
	const fs = triggerFs({ [T_PATH]: orig });
	const res = await disarmTrigger({ triggersPath: T_PATH, index: 0, number: 40, jobId: "job-second", at: AT, fs });
	assert.deepEqual(res, { already: true });
	assert.equal(fs.files[T_PATH], orig, "the second disarm must not rewrite the mark -- first writer's provenance wins");
});

test("disarmTrigger refuses to disarm a stranger: index gone, not a one-shot, number mismatch", async () => {
	// `index` is positional and the file is operator-editable between enqueue and disarm, so every
	// identity check failing means "the entry this job matched is no longer there" -- refuse loudly,
	// never write.
	const cases = [
		{ name: "index out of range", triggers: [cronTrigger(), onceTrigger(40)], index: 7, number: 40 },
		{ name: "entry is not an armed one-shot", triggers: [cronTrigger(), onceTrigger(40)], index: 0, number: 40 },
		{ name: "entry names a different item", triggers: [onceTrigger(41)], index: 0, number: 40 },
	];
	for (const c of cases) {
		const orig = fileOf(c.triggers);
		const fs = triggerFs({ [T_PATH]: orig });
		const res = await disarmTrigger({ triggersPath: T_PATH, index: c.index, number: c.number, jobId: "job-x", at: AT, fs });
		assert.ok(res.invalid, `${c.name}: must report { invalid }`);
		assert.match(res.invalid, /disarming a stranger/, `${c.name}: the refusal must say it is not disarming a stranger, got: ${res.invalid}`);
		assert.equal(fs.files[T_PATH], orig, `${c.name}: the file must be byte-identical after the refusal`);
	}
});

test("disarmTrigger never repairs an unreadable file: missing and corrupt both refuse with the state intact", async () => {
	// THE no-repair-from-empty pin. writeTriggers' repair posture (missing file scaffolds) is right
	// for the operator CRUD path and catastrophic here: overwriting a file the worker could not read,
	// to record one disarm, would destroy the operator's whole trigger set.
	const missing = triggerFs();
	const resMissing = await disarmTrigger({ triggersPath: T_PATH, index: 0, number: 40, at: AT, fs: missing });
	assert.match(resMissing.invalid, /disarm not written/, "a missing file refuses with 'disarm not written', never scaffolds");
	assert.deepEqual(missing.files, {}, "no file, no tmp, no lock may exist afterwards -- the absent state is exactly as before");

	const corrupt = "{ this is not json";
	const broken = triggerFs({ [T_PATH]: corrupt });
	const resCorrupt = await disarmTrigger({ triggersPath: T_PATH, index: 0, number: 40, at: AT, fs: broken });
	assert.match(resCorrupt.invalid, /disarm not written/, "a corrupt file refuses with 'disarm not written', never repairs");
	assert.deepEqual(broken.files, { [T_PATH]: corrupt }, "the corrupt bytes must survive untouched for the operator to inspect");
});

test("disarmTrigger retries through a live lock that clears, then succeeds", async () => {
	// The disarm caller is the worker's post-run hook with nobody at the keyboard, and what it races
	// (an operator edit, a sibling's disarm) clears in milliseconds -- so unlike writeTriggers it
	// sleeps and retries. The lock is deleted from a short timeout, simulating the holder finishing
	// during the first jittered sleep.
	const fs = triggerFs({ [T_PATH]: fileOf([onceTrigger(40)]) });
	fs.seedLock(LOCK, 0);
	setTimeout(() => {
		delete fs.files[LOCK];
		delete fs.mtimes[LOCK];
	}, 40);
	const res = await disarmTrigger({ triggersPath: T_PATH, index: 0, number: 40, jobId: "job-abc", at: AT, fs });
	assert.deepEqual(res, { ok: true }, "a lock that clears during the retry window must not cost the disarm");
	assert.deepEqual(JSON.parse(fs.files[T_PATH]).triggers[0].on.disarmed, { at: AT, jobId: "job-abc" });
});

test("disarmTrigger gives up after 5 attempts on a lock held forever, naming the attempts", async () => {
	// Bounded on purpose: ~5 x 100-300ms is under the dedup window that caps what a lost disarm
	// costs. The lock stays live throughout (its mtime is seconds old, stale needs ten), so this is
	// pure contention, never a takeover. Wall time here is real sleep, roughly 0.5-1.5s.
	const orig = fileOf([onceTrigger(40)]);
	const fs = triggerFs({ [T_PATH]: orig });
	fs.seedLock(LOCK, 0);
	const res = await disarmTrigger({ triggersPath: T_PATH, index: 0, number: 40, at: AT, fs });
	assert.ok(res.invalid, "a permanently held lock must end in { invalid }, never a throw or a hang");
	assert.match(res.invalid, /5 attempts/, `the report must name the attempt budget so an operator can size the contention, got: ${res.invalid}`);
	assert.equal(fs.files[T_PATH], orig, "the file must be untouched after the give-up");
	assert.ok(!fs.calls.some((c) => c.startsWith("readFileSync:")), "every attempt gave up before reading -- contention is decided at the lock");
});

test("disarmTrigger takes over a stale lock and the disarm lands", async () => {
	const { events, log } = collectLog();
	const fs = triggerFs({ [T_PATH]: fileOf([onceTrigger(40)]) });
	fs.seedLock(LOCK, 11_000); // a crashed writer must not wedge the disarm path either
	const res = await disarmTrigger({ triggersPath: T_PATH, index: 0, number: 40, jobId: "job-abc", at: AT, fs, log });
	assert.deepEqual(res, { ok: true }, "a stale lock is taken over, not waited out through all 5 attempts");
	assert.ok(events.some((e) => e.event === "triggers_lock_stale_taken"), "the takeover is logged for the operator");
	assert.deepEqual(JSON.parse(fs.files[T_PATH]).triggers[0].on.disarmed, { at: AT, jobId: "job-abc" });
});

test("disarmTrigger refuses to write a file the loaders would reject, even when the corruption predates it", async () => {
	// The guard is unreachable via the disarm's own edit (one allowlisted key on a validated entry),
	// but a file can already hold ANOTHER entry today's schema refuses -- here a flow that fails the
	// skill-name charset. The disarm must not launder that file through a fresh write the loaders
	// would then reject at boot; it refuses and leaves the bytes alone.
	const badNeighbour = { on: { type: "label", any: ["x"] }, run: { kind: "github", flow: "BAD FLOW" } };
	const orig = fileOf([onceTrigger(40), badNeighbour]);
	const fs = triggerFs({ [T_PATH]: orig });
	const res = await disarmTrigger({ triggersPath: T_PATH, index: 0, number: 40, at: AT, fs });
	assert.ok(res.invalid, "the shared parseTriggers must veto the write");
	assert.match(res.invalid, /run\.flow/, `the refusal carries the validator's own reason, got: ${res.invalid}`);
	assert.equal(fs.files[T_PATH], orig, "the pre-existing corruption stays exactly as the operator left it");
});

test("disarmTrigger reports a failed write as { invalid }, never throws", async () => {
	// Opposite contract to writeTriggers, deliberately: nobody is at the keyboard to catch a throw
	// from the post-run hook, so every failure folds into the { invalid } channel the caller logs.
	const orig = fileOf([onceTrigger(40)]);
	const fs = triggerFs({ [T_PATH]: orig });
	fs.failNext("writeFileSync", "ENOSPC", 1);
	const res = await disarmTrigger({ triggersPath: T_PATH, index: 0, number: 40, at: AT, fs });
	assert.match(res.invalid, /write failed/, `a full disk must surface as 'write failed', got: ${res.invalid}`);
	assert.equal(fs.files[T_PATH], orig, "the destination keeps its bytes when the tmp write dies");
	assert.equal(LOCK in fs.files, false, "the lock is released even on the write-failure path");
	assert.equal(Object.keys(fs.files).some((p) => p.endsWith(".tmp")), false, "a failed write leaves no tmp straggler -- per-writer tmp names are unlinked, not left for a next write to overwrite");
});

test("disarmTrigger refuses when the entry's flow or dispatch lane no longer matches the job's", async () => {
	// The identity check covers every field the job knows: index and number identify the ITEM, and
	// flow/command identify the TARGET. Without this, an operator who swaps the in-flight one-shot for
	// a different-flow one at the same index (deploy -> rollback, same #40) has the NEW trigger spent
	// by the OLD job, silently. Same-everything re-arms remain indistinguishable by design (the raw
	// index is the identity); the DES entry names that residual.
	const orig = fileOf([onceTrigger(40)]); // dispatches flow "deploy"
	const fs = triggerFs({ [T_PATH]: orig });
	const swapped = await disarmTrigger({ triggersPath: T_PATH, index: 0, number: 40, flow: "rollback", jobId: "j", at: AT, fs });
	assert.match(swapped.invalid, /not disarming a stranger/, "a different flow at the matched index must refuse");
	// Lane mismatch: a command job must not spend a flow one-shot occupying its slot.
	const laned = await disarmTrigger({ triggersPath: T_PATH, index: 0, number: 40, command: "deploy", jobId: "j", at: AT, fs });
	assert.match(laned.invalid, /not disarming a stranger/, "a command job must not spend a flow one-shot");
	assert.equal(fs.files[T_PATH], orig, "both refusals leave the file untouched");
	// And the true match still disarms: flow supplied and agreeing.
	const ok = await disarmTrigger({ triggersPath: T_PATH, index: 0, number: 40, flow: "deploy", jobId: "j", at: AT, fs });
	assert.deepEqual(ok, { ok: true }, "the matching flow disarms as before -- the check narrows, never blocks the honest path");
});

// ── readDisarmState ─────────────────────────────────────────────────────────────────────────────────────

test("readDisarmState: armed, disarmed, and every unknown fold to their states (fail-open by design)", () => {
	// "unknown" means RUN: the caller refuses a job only on positive disarmed evidence, so a broken
	// read must never wedge every once job -- the identity mismatches are the disarm WRITER's to
	// refuse, not this reader's.
	const spent = onceTrigger(40);
	spent.on.disarmed = { at: AT, jobId: "job-abc" };
	const spentNoJob = onceTrigger(40);
	spentNoJob.on.disarmed = { at: AT };
	const cases = [
		{ name: "armed one-shot", files: { [T_PATH]: fileOf([cronTrigger(), onceTrigger(40)]) }, index: 1, number: 40, expect: { state: "armed" } },
		{ name: "disarmed with provenance", files: { [T_PATH]: fileOf([spent]) }, index: 0, number: 40, expect: { state: "disarmed", at: AT, jobId: "job-abc" } },
		{ name: "disarmed by hand (no jobId)", files: { [T_PATH]: fileOf([spentNoJob]) }, index: 0, number: 40, expect: { state: "disarmed", at: AT, jobId: null } },
		{ name: "missing file", files: {}, index: 0, number: 40, expect: { state: "unknown", reason: "ENOENT" } },
		{ name: "index gone", files: { [T_PATH]: fileOf([onceTrigger(40)]) }, index: 9, number: 40, expect: { state: "unknown", reason: "entry-changed" } },
		{ name: "entry no longer a one-shot", files: { [T_PATH]: fileOf([labelTrigger()]) }, index: 0, number: 40, expect: { state: "unknown", reason: "entry-changed" } },
		{ name: "entry names a different item", files: { [T_PATH]: fileOf([onceTrigger(41)]) }, index: 0, number: 40, expect: { state: "unknown", reason: "entry-changed" } },
		// The target fields fold to unknown, not disarmed: a re-armed DIFFERENT one-shot at this index
		// is not spent, so the fail-open answer -- run -- is the true one.
		{ name: "entry dispatches a different flow", files: { [T_PATH]: fileOf([onceTrigger(40)]) }, index: 0, number: 40, flow: "rollback", expect: { state: "unknown", reason: "entry-changed" } },
		{ name: "entry is a flow one-shot, job carried a command", files: { [T_PATH]: fileOf([onceTrigger(40)]) }, index: 0, number: 40, command: "deploy", expect: { state: "unknown", reason: "entry-changed" } },
	];
	for (const c of cases) {
		const res = readDisarmState({ triggersPath: T_PATH, index: c.index, number: c.number, flow: c.flow, command: c.command, fs: triggerFs(c.files) });
		assert.deepEqual(res, c.expect, `${c.name}: readDisarmState must fold to ${JSON.stringify(c.expect)}`);
	}
});

// ── makeDisarmOnce: the post-record hook ────────────────────────────────────────────────────────────────

// The BullMQ wrapper shape recordRun hands the hook: id on the WRAPPER, everything else under data --
// the mirror image of makeCheckOnceSpent's effectiveJob below, which has no id at all.
const onceWrapperJob = (id = "gh-x", index = 1) => ({
	id,
	data: {
		flow: "deploy",
		target: { number: 40 },
		trigger: { matched: { index, type: "issue", action: "closed", number: 40, once: true } },
	},
});

test("makeDisarmOnce is a pure no-op for a job whose matched rule was not a one-shot: zero fs calls", async () => {
	// Issue #231's blast-radius promise: every unflagged job takes ZERO new code paths. A label job
	// carries matched without `once`; a cron job carries `trigger: { id, pattern }` with no matched at
	// all. Neither may read the file, take the lock, write a byte, or log a line -- silence is the
	// correct trace for a path not taken.
	const { events, log } = collectLog();
	const fs = triggerFs({ [T_PATH]: fileOf([cronTrigger(), onceTrigger(40)]) });
	const disarmOnce = makeDisarmOnce({ triggersPath: T_PATH, fs, log });
	const labelJob = { id: "gh-1", data: { flow: "fix", target: { number: 7 }, trigger: { matched: { index: 0, type: "label", label: "dispatch" } } } };
	const cronJob = { id: "repeat:nightly:123", data: { flow: "audit", trigger: { id: "nightly", pattern: "0 3 * * *" } } };
	await disarmOnce({ job: labelJob, endedAt: AT });
	await disarmOnce({ job: cronJob, endedAt: AT });
	assert.deepEqual(fs.calls, [], "a job without matched.once === true must not touch the fs at all");
	assert.deepEqual(events, [], "and must not log -- an unflagged job leaves no one-shot trace");
});

test("makeDisarmOnce disarms the matched entry through the real writer and logs trigger_disarmed", async () => {
	const { events, log } = collectLog();
	const fs = triggerFs({ [T_PATH]: fileOf([cronTrigger(), onceTrigger(40), labelTrigger()]) });
	const disarmOnce = makeDisarmOnce({ triggersPath: T_PATH, fs, log });
	await disarmOnce({ job: onceWrapperJob("gh-x", 1), endedAt: AT });
	// The real disarmTrigger ran (default `disarm`): the mark carries the record's endedAt and the
	// queue job id -- the provenance the pre-spend check's own-jobId exception reads back.
	assert.deepEqual(JSON.parse(fs.files[T_PATH]).triggers[1].on.disarmed, { at: AT, jobId: "gh-x" });
	assert.deepEqual(events, [{ event: "trigger_disarmed", fields: { jobId: "gh-x", triggerIndex: 1 } }]);
});

test("makeDisarmOnce takes the item number from target.number when matched carries none (the PR shape)", async () => {
	// An issue delivery writes matched.number; a pull_request one does not -- its number rides the
	// job's target. If this fallback drifted, every PR one-shot's disarm would refuse as a number
	// mismatch (undefined !== 40) and the trigger would stay armed forever, silently.
	const { events, log } = collectLog();
	const fs = triggerFs({ [T_PATH]: fileOf([onceTrigger(40)]) });
	const disarmOnce = makeDisarmOnce({ triggersPath: T_PATH, fs, log });
	const prJob = { id: "gh-pr", data: { flow: "deploy", target: { number: 40 }, trigger: { matched: { index: 0, type: "pull_request", action: "closed", once: true } } } };
	await disarmOnce({ job: prJob, endedAt: AT });
	assert.deepEqual(JSON.parse(fs.files[T_PATH]).triggers[0].on.disarmed, { at: AT, jobId: "gh-pr" }, "the disarm landed, so the writer's number check was satisfied by target.number");
	assert.deepEqual(events, [{ event: "trigger_disarmed", fields: { jobId: "gh-pr", triggerIndex: 0 } }]);
});

test("makeDisarmOnce maps the writer's non-ok answers to their own log events, unavailable touching nothing", async () => {
	// { already } -> trigger_already_disarmed: a sibling replica or a redelivery won the race, which is
	// idempotent success at the writer and stays a distinct, non-alarming event here.
	{
		const { events, log } = collectLog();
		const spent = onceTrigger(40);
		spent.on.disarmed = { at: "2026-08-27T00:00:00.000Z", jobId: "job-first" };
		const fs = triggerFs({ [T_PATH]: fileOf([cronTrigger(), spent]) });
		await makeDisarmOnce({ triggersPath: T_PATH, fs, log })({ job: onceWrapperJob("gh-2", 1), endedAt: AT });
		assert.deepEqual(events, [{ event: "trigger_already_disarmed", fields: { jobId: "gh-2", triggerIndex: 1 } }]);
	}
	// { invalid } -> trigger_disarm_failed carrying the writer's own operator-actionable reason.
	{
		const { events, log } = collectLog();
		const fs = triggerFs({ [T_PATH]: fileOf([cronTrigger(), onceTrigger(41)]) });
		await makeDisarmOnce({ triggersPath: T_PATH, fs, log })({ job: onceWrapperJob("gh-3", 1), endedAt: AT });
		assert.equal(events.length, 1, "exactly one line per failed disarm");
		assert.equal(events[0].event, "trigger_disarm_failed");
		assert.equal(events[0].fields.jobId, "gh-3");
		assert.equal(events[0].fields.triggerIndex, 1);
		assert.match(events[0].fields.reason, /disarming a stranger/, "the reason is the writer's own refusal, not a summary of it");
	}
	// No resolvable path -> trigger_disarm_unavailable, and the fs is NEVER touched: there is no file
	// to guess at, and a hook that probed anyway would invent a write target the operator never named.
	for (const triggersPath of [undefined, ""]) {
		const { events, log } = collectLog();
		const fs = triggerFs({ [T_PATH]: fileOf([onceTrigger(40)]) });
		await makeDisarmOnce({ triggersPath, fs, log })({ job: onceWrapperJob("gh-4", 1), endedAt: AT });
		assert.deepEqual(events, [{ event: "trigger_disarm_unavailable", fields: { jobId: "gh-4", triggerIndex: 1, reason: "triggers file unresolvable" } }], `triggersPath ${JSON.stringify(triggersPath)} must log unavailable`);
		assert.deepEqual(fs.calls, [], "zero fs calls when the path is unresolvable");
	}
});

test("makeDisarmOnce never rejects: an injected disarm that THROWS resolves and logs trigger_disarm_failed", async () => {
	// The catch is unreachable through the real disarmTrigger (it never throws), and that is exactly why
	// it needs a pin: the hook sits on the record path, and a run record must never be lost to disarm
	// bookkeeping. A coded error keeps its code as the reason; a bare one degrades to the fixed
	// "disarm-error" token, so neither direction logs an undefined.
	const cases = [
		{ name: "coded error", err: Object.assign(new Error("boom"), { code: "EBOOM" }), reason: "EBOOM" },
		{ name: "bare error", err: new Error("boom"), reason: "disarm-error" },
	];
	for (const c of cases) {
		const { events, log } = collectLog();
		const disarmOnce = makeDisarmOnce({
			triggersPath: T_PATH,
			fs: triggerFs(),
			log,
			disarm: async () => {
				throw c.err;
			},
		});
		await assert.doesNotReject(() => disarmOnce({ job: onceWrapperJob("gh-x", 1), endedAt: AT }), `${c.name}: the returned promise must resolve -- recordRun fire-and-forgets this`);
		assert.deepEqual(events, [{ event: "trigger_disarm_failed", fields: { jobId: "gh-x", triggerIndex: 1, reason: c.reason } }], `${c.name}: the failure is a loud log line, never a rejection`);
	}
});

// ── makeCheckOnceSpent: the pre-spend read ──────────────────────────────────────────────────────────────

test("makeCheckOnceSpent: armed runs, a foreign mark refuses with provenance, and every unknown fails open", async () => {
	// The job here is the EFFECTIVE job (a spread of job.data): trigger/target/flow sit directly on it
	// and it has no `.id` -- the queue job id arrives separately, injected by index.mjs, which is the
	// whole reason the second parameter exists.
	const onceJob = { flow: "deploy", target: { number: 40 }, trigger: { matched: { index: 0, type: "issue", action: "closed", number: 40, once: true } } };
	const spentBy = (jobId) => {
		const t = onceTrigger(40);
		t.on.disarmed = jobId === undefined ? { at: AT } : { at: AT, jobId };
		return t;
	};
	const check = (files, triggersPath = T_PATH) => makeCheckOnceSpent({ triggersPath, fs: triggerFs(files) });

	// An armed entry runs.
	assert.deepEqual(await check({ [T_PATH]: fileOf([onceTrigger(40)]) })(onceJob, { queueJobId: "gh-x" }), { ok: true });

	// A FOREIGN mark refuses, carrying the provenance the processor's refusal comment prints.
	assert.deepEqual(
		await check({ [T_PATH]: fileOf([spentBy("job-first")]) })(onceJob, { queueJobId: "job-second" }),
		{ refused: true, at: AT, jobId: "job-first" },
	);

	// The PR shape: matched carries NO number (the target does -- filter.mjs's own literal), and the
	// check must still find the entry. Deleting the `?? job.target.number` fallback leg would fold
	// every PR one-shot to "entry-changed" and fail OPEN -- once-enforcement silently off in exactly
	// the compose topology where this check is declared the enforcement layer.
	const prOnce = { on: { type: "pull_request", action: ["closed"], number: 40, once: true }, run: { kind: "github", flow: "deploy" } };
	prOnce.on.disarmed = { at: AT, jobId: "job-first" };
	const prJob = { flow: "deploy", target: { type: "pull_request", number: 40 }, trigger: { matched: { index: 0, type: "pull_request", action: "closed", once: true } } };
	assert.deepEqual(
		await check({ [T_PATH]: fileOf([prOnce]) })(prJob, { queueJobId: "job-second" }),
		{ refused: true, at: AT, jobId: "job-first" },
		"a spent PR one-shot must refuse a foreign job even though its matched carries no number",
	);

	// THE attempts:2 COMPOSITION PIN. The disarm hook fires after EVERY record -- attempt one's failed
	// record included -- so BullMQ's second attempt of the SAME delivery arrives here with its own mark
	// already in the file. Without the own-jobId exception, that composition silently turns attempts:2
	// into attempts:1 for every once job; with it the retry runs, and only a DIFFERENT delivery refuses.
	assert.deepEqual(
		await check({ [T_PATH]: fileOf([spentBy("job-first")]) })(onceJob, { queueJobId: "job-first" }),
		{ ok: true },
	);

	// A hand-written mark carries no jobId and reads as FOREIGN -- an operator disarming by hand means
	// exactly "do not run", and no queue job may claim a null provenance as its own.
	assert.deepEqual(
		await check({ [T_PATH]: fileOf([spentBy(undefined)]) })(onceJob, { queueJobId: "job-first" }),
		{ refused: true, at: AT, jobId: null },
	);

	// Fail-open: entry changed and unreadable file both mean "run". Refusal is built only on POSITIVE
	// foreign evidence, so a broken read can never wedge every once job -- the identity mismatches are
	// the disarm WRITER's to refuse loudly, not this reader's.
	assert.deepEqual(await check({ [T_PATH]: fileOf([labelTrigger()]) })(onceJob, { queueJobId: "gh-x" }), { ok: true }, "entry no longer a one-shot => run");
	assert.deepEqual(await check({})(onceJob, { queueJobId: "gh-x" }), { ok: true }, "missing file => run");

	// An unresolvable path answers { ok } without touching the fs at all -- even a file that WOULD have
	// refused, because there is no path under which the check could honestly claim to have read it.
	const untouched = triggerFs({ [T_PATH]: fileOf([spentBy("job-first")]) });
	for (const triggersPath of [undefined, ""]) {
		assert.deepEqual(await makeCheckOnceSpent({ triggersPath, fs: untouched })(onceJob, { queueJobId: "gh-x" }), { ok: true }, `triggersPath ${JSON.stringify(triggersPath)} => run`);
	}
	assert.deepEqual(untouched.calls, [], "zero fs calls when the path is unresolvable");
});

// ── cross-writer race, real fs ──────────────────────────────────────────────────────────────────────────

test("cross-writer race on a real file: both disarms land, the file stays loadable", async () => {
	// Real fs, real lock file, real jittered sleeps. A foreign writer holds the lock when everyone
	// arrives, then finishes; accepted outcomes per call are exactly the module's contract:
	//   - writeTriggers under the lock: { invalid } naming the lock (it never retries), OR { ok } if
	//     it happened to run unlocked -- if { ok }, its third trigger must be in the final file;
	//   - each disarm: { ok } or { already } after its retries -- a LOST disarm (invalid/timeout) is
	//     the one outcome this test exists to refuse;
	//   - the final file must load through parseTriggers and carry BOTH disarm marks.
	const dir = mkdtempSync(join(tmpdir(), "pi-dispatch-triggers-race-"));
	try {
		const path = join(dir, "triggers.json");
		const lock = `${path}.lock`;
		realWriteFileSync(path, fileOf([onceTrigger(40), onceTrigger(41)]));
		realWriteFileSync(lock, ""); // the foreign writer, mid-write

		const p1 = disarmTrigger({ triggersPath: path, index: 0, number: 40, jobId: "job-a", at: AT });
		const p2 = disarmTrigger({ triggersPath: path, index: 1, number: 41, jobId: "job-b", at: AT });
		const contended = writeTriggers({ triggersPath: path, mutate: (list) => [...list, labelTrigger()] });

		// The foreign writer finishes inside the disarms' first sleep window (100ms minimum jitter).
		await new Promise((resolve) => setTimeout(resolve, 40));
		realUnlinkSync(lock);

		const [r1, r2] = await Promise.all([p1, p2]);
		for (const [who, r] of [["#40", r1], ["#41", r2]]) {
			assert.ok(r.ok === true || r.already === true, `no lost disarm: ${who} must end { ok } or { already }, got ${JSON.stringify(r)}`);
		}
		// A second writeTriggers after the dust settles: the operator re-pressing after a locked
		// refusal. Both of its outcomes are acceptable too, though with the disarms resolved it
		// should find the lock free.
		const settled = writeTriggers({ triggersPath: path, mutate: (list) => [...list, labelTrigger()] });

		const finalText = realReadFileSync(path, "utf8");
		parseTriggers(finalText, path); // must not throw: no writer may leave an unloadable file
		const final = JSON.parse(finalText);
		assert.deepEqual(final.triggers[0].on.disarmed, { at: AT, jobId: "job-a" }, "the #40 disarm mark must survive the race");
		assert.deepEqual(final.triggers[1].on.disarmed, { at: AT, jobId: "job-b" }, "the #41 disarm mark must survive the race");
		const adds = [contended, settled].filter((r) => r.ok === true).length;
		for (const r of [contended, settled]) {
			if (!r.ok) assert.match(r.invalid, /locked/, `a refused writeTriggers must have been refused by the lock, got: ${r.invalid}`);
		}
		assert.equal(final.triggers.length, 2 + adds, "every writeTriggers that reported ok must have its entry in the file; every refusal must not");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
