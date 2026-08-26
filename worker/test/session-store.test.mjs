import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { makeSessionStore, SESSION_FILE_NAME } from "../src/session-store.mjs";
import { sessionKeyFor } from "../src/session-key.mjs";

const HEADER = `${JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/workspace" })}\n`;
const PI = "0.80.7";
/** The fake clock every fixture runs on, so a header timestamp can be placed relative to it. */
const NOW = 1_000_000_000;
/** A header the way pi actually writes one: `timestamp` is the instant the session was created. */
const headerAt = (ms) => `${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: new Date(ms).toISOString(), cwd: "/workspace" })}\n`;
const daysAgo = (n) => NOW - n * 86400000;
const ghIssue = { kind: "github", repo: "o/r", target: { type: "issue", number: 7 } };

function fixture({ ttlDays = 14, maxBytes = 1_000_000, maxAgeDays = 0, maxResumeChain = 0, now = () => NOW, fs } = {}) {
	const root = mkdtempSync(join(tmpdir(), "pi-store-"));
	const sessionsDir = join(root, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	const logs = [];
	// `fs` omitted = the store's own real-fs default. Passing one is how a disk fault is injected on a
	// specific call without a chmod, which root ignores and Windows spells differently.
	const store = makeSessionStore({ sessionsDir, ttlDays, maxBytes, maxAgeDays, maxResumeChain, now, log: (e, f) => logs.push([e, f]), ...(fs ? { fs } : {}) });
	const jobDir = mkdtempSync(join(root, "job-"));
	return { root, sessionsDir, store, jobDir, logs };
}

/** Seed the canonical store for a key, the way a promotion would have. */
function seed(sessionsDir, key, { body = HEADER, piVersion = PI } = {}) {
	const dir = join(sessionsDir, key);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, SESSION_FILE_NAME), body);
	writeFileSync(join(dir, "pi-version"), piVersion);
	return join(dir, SESSION_FILE_NAME);
}

test("a cold start stages a 0-BYTE file, never an absent one", () => {
	const { store, jobDir } = fixture();
	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	assert.equal(s.resume, false);
	assert.equal(s.reason, "absent");
	// 0 bytes is what makes pi write its own header at open and mark the manager flushed, so _persist
	// never reaches openSync(path, "wx") -- the EEXIST race becomes unreachable rather than unlikely.
	assert.equal(statSync(join(s.hostDir, SESSION_FILE_NAME)).size, 0);
});

test("a seeded transcript resumes, and the canonical store is NOT what gets mounted", () => {
	const { store, jobDir, sessionsDir } = fixture();
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key);
	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	assert.equal(s.resume, true);
	assert.equal(s.reason, "resumed");
	// The mount is a per-job COPY under jobDir. The container can name its own transcript and nothing
	// else, so a compromised agent that computes another repo's key still cannot reach it -- the mount is
	// the capability, and the hash is not one.
	assert.equal(s.hostDir, join(jobDir, "session"));
	assert.equal(s.hostDir.startsWith(sessionsDir), false, "mounting the store itself would expose every key to one job");
	assert.equal(readFileSync(join(s.hostDir, SESSION_FILE_NAME), "utf8"), HEADER);
});

test("a SYMLINK in the store is refused and its target is never read", () => {
	const { store, jobDir, sessionsDir, root } = fixture();
	const key = sessionKeyFor(ghIssue);
	const dir = join(sessionsDir, key);
	mkdirSync(dir, { recursive: true });
	const secret = join(root, "worker-secret");
	writeFileSync(secret, "AWS_SECRET=hunter2\n");
	symlinkSync(secret, join(dir, SESSION_FILE_NAME));
	writeFileSync(join(dir, "pi-version"), PI);

	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	assert.equal(s.resume, false, "the agent owns /session; a symlink it plants resolves on the HOST, so following one would replay any worker-readable file into the next job");
	assert.equal(s.reason, "not-a-regular-file");
	assert.equal(readFileSync(join(s.hostDir, SESSION_FILE_NAME), "utf8"), "", "and nothing of the target reaches the staged copy");
});

test("a symlink written BY THE CONTAINER is refused at promotion too -- both edges, not just one", () => {
	const { store, jobDir, sessionsDir, root } = fixture();
	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	const secret = join(root, "host-secret");
	writeFileSync(secret, "sensitive\n");
	const staged = join(s.hostDir, SESSION_FILE_NAME);
	writeFileSync(staged, "");
	symlinkSync(secret, `${staged}.link`);
	// Simulate the agent replacing its transcript with a symlink.
	renameSync(`${staged}.link`, staged);

	const p = store.promoteSession(s, { piVersion: PI });
	assert.equal(p.promoted, false);
	assert.equal(p.reason, "not-a-regular-file");
	assert.equal(sessionKeyFor(ghIssue) && statSync(join(sessionsDir, sessionKeyFor(ghIssue)), { throwIfNoEntry: false }), undefined, "nothing was promoted at all");
});

test("an expired transcript cold-starts, and mtime is the authority", () => {
	const { store, jobDir, sessionsDir } = fixture({ ttlDays: 1, now: () => Date.now() });
	const key = sessionKeyFor(ghIssue);
	const file = seed(sessionsDir, key);
	const old = (Date.now() - 3 * 86400000) / 1000;
	utimesSync(file, old, old);
	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	assert.equal(s.resume, false);
	assert.equal(s.reason, "expired", "a stale transcript is a live input to a future job, not debris -- so the gate runs at OPEN, not only at boot");
});

test("a transcript written by a different pi version cold-starts rather than resuming into a moved schema", () => {
	const { store, jobDir, sessionsDir } = fixture();
	seed(sessionsDir, sessionKeyFor(ghIssue), { piVersion: "0.79.0" });
	assert.equal(store.resolveSession(ghIssue, { jobDir, piVersion: PI }).reason, "pi-version-changed");
	// An image that declares no version never resumes: null is the SAFE answer, never "assume it matches".
	assert.equal(store.resolveSession(ghIssue, { jobDir, piVersion: null }).reason, "pi-version-changed");
});

test("an oversized or unparseable transcript cold-starts instead of reaching the container", () => {
	const big = fixture({ maxBytes: 10 });
	seed(big.sessionsDir, sessionKeyFor(ghIssue), { body: HEADER });
	assert.equal(big.store.resolveSession(ghIssue, { jobDir: big.jobDir, piVersion: PI }).reason, "too-large");

	const bad = fixture();
	seed(bad.sessionsDir, sessionKeyFor(ghIssue), { body: "not a session\n" });
	assert.equal(bad.store.resolveSession(ghIssue, { jobDir: bad.jobDir, piVersion: PI }).reason, "unparseable");
});

test("promotion writes the transcript and stamps the pi version that produced it", () => {
	const { store, jobDir, sessionsDir } = fixture();
	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), HEADER);
	const p = store.promoteSession(s, { piVersion: PI });
	assert.equal(p.promoted, true);
	const key = sessionKeyFor(ghIssue);
	assert.equal(readFileSync(join(sessionsDir, key, SESSION_FILE_NAME), "utf8"), HEADER);
	assert.equal(readFileSync(join(sessionsDir, key, "pi-version"), "utf8"), PI);
});

test("a job with no key gets no mount at all -- byte-identical to a pre-feature job", () => {
	const { store, jobDir } = fixture();
	// A fork PR, and a CLI local run: both resolve no key, so there is no /session and nothing on disk.
	const fork = { kind: "github", repo: "o/r", target: { type: "pull_request", number: 8 } };
	assert.equal(store.resolveSession(fork, { jobDir, resolved: { headRef: "pi/issue-7", headRepo: "stranger/r" }, piVersion: PI }), null);
	assert.equal(store.resolveSession({ kind: "local", folder: "/srv", flow: "f" }, { jobDir, piVersion: PI }), null);
});

test("an unset PI_SESSIONS_DIR yields no session rather than a temp-dir default", () => {
	// The BACKSTOP, not the live behaviour: an armed job never gets this far, because processor.mjs returns
	// a `sessions-dir-unset` policy refusal pre-spend (REQ-RESUMABLE-SESSION's one fail-closed case). Pinned
	// anyway because the store and the preparer are both injected, so neither can assume its caller came
	// through that gate -- and a null here is the same no-mount, nothing-written shape as no key at all.
	const store = makeSessionStore({ sessionsDir: null, ttlDays: 14, maxBytes: 1000 });
	assert.equal(store.resolveSession(ghIssue, { jobDir: "/tmp", piVersion: PI }), null);
});

test("the store never throws -- a disk fault must not fail the prepare that only asked", () => {
	const store = makeSessionStore({
		sessionsDir: "/nonexistent-root/sessions",
		ttlDays: 14,
		maxBytes: 1000,
		fs: {
			mkdirSync: () => {
				throw new Error("EACCES");
			},
		},
	});
	assert.doesNotThrow(() => store.resolveSession(ghIssue, { jobDir: "/tmp", piVersion: PI }));
	assert.equal(store.resolveSession(ghIssue, { jobDir: "/tmp", piVersion: PI }), null);
	assert.doesNotThrow(() => store.reapSessions());
});

test("a second writer on one key discards rather than clobbers", () => {
	// Two jobs on one PR inside one runtime is a real shape (REQ-QUEUE-BURST-NO-DROP), and last-write-wins
	// there would interleave two agents' turns into one transcript, then resume whichever wrote last.
	const { store, jobDir, sessionsDir } = fixture();
	const key = sessionKeyFor(ghIssue);
	const first = seed(sessionsDir, key);
	writeFileSync(first, HEADER);

	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), `${HEADER}{"type":"message"}\n`);

	// Another worker holds the key: the lock is an exclusive create, so this one must stand down.
	writeFileSync(join(sessionsDir, key, "lock"), "");
	const p = store.promoteSession(s, { piVersion: PI });
	assert.equal(p.promoted, false);
	assert.equal(p.reason, "locked");
	assert.equal(readFileSync(first, "utf8"), HEADER, "the loser must leave the canonical transcript untouched");
});

test("the lock is released, so the next job on the key is not wedged forever", () => {
	const { store, jobDir, sessionsDir } = fixture();
	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), HEADER);
	assert.equal(store.promoteSession(s, { piVersion: PI }).promoted, true);

	const s2 = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	writeFileSync(join(s2.hostDir, SESSION_FILE_NAME), `${HEADER}{"type":"message"}\n`);
	assert.equal(store.promoteSession(s2, { piVersion: PI }).promoted, true, "a held-and-released lock must not outlive the run that took it");
	assert.match(readFileSync(join(sessionsDir, sessionKeyFor(ghIssue), SESSION_FILE_NAME), "utf8"), /"type":"message"/);
});

test("a disk fault mid-promotion is named promote-failed, and does not wedge the key", () => {
	// The promote-path reason an operator actually meets (INT-RUN-HISTORY-FILE-CONTRACT): a full disk or a
	// permissions change under the store while the swap is in flight. Faulted at renameSync, which ONLY the
	// promote path calls -- copyFileSync would also fault the resolve path's read-in and the job would never
	// reach a promotion. By then the lock is HELD, which is the interesting half: a promotion that failed
	// while leaving the lock behind would cold-start every future run for that key, a worse and much
	// quieter outcome than the failure that caused it.
	const { store, jobDir, sessionsDir, logs } = fixture({
		fs: {
			...realFs,
			renameSync: () => {
				throw new Error("ENOSPC: no space left on device");
			},
		},
	});
	const key = sessionKeyFor(ghIssue);
	const canonical = seed(sessionsDir, key);

	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), `${HEADER}{"type":"message"}\n`);

	let p;
	assert.doesNotThrow(() => {
		p = store.promoteSession(s, { piVersion: PI });
	}, "the store NEVER throws: a promotion fault must not turn a completed run into a retry");
	assert.equal(p.promoted, false);
	assert.equal(p.reason, "promote-failed");

	assert.equal(readFileSync(canonical, "utf8"), HEADER, "a failed swap must leave the canonical transcript untouched");
	assert.equal(existsSync(join(sessionsDir, key, "lock")), false, "the lock must be released even when the promotion under it failed");
	assert.ok(
		logs.some(([event, fields]) => event === "session_store_failed" && fields.phase === "promote"),
		"the fault is logged with its phase, so an operator can tell a refused promotion from a broken one",
	);
});


test("the conversation-age bound reads the header's clock, which mtime cannot see", () => {
	// The whole point of the bound: mtime is FRESH here (seed just wrote the file), so `expired` passes and
	// only the header's own timestamp can tell that the lineage is old.
	const { store, jobDir, sessionsDir } = fixture({ maxAgeDays: 30 });
	seed(sessionsDir, sessionKeyFor(ghIssue), { body: headerAt(daysAgo(45)) });
	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	assert.equal(s.resume, false);
	assert.equal(s.reason, "conversation-too-old");
	assert.notEqual(s.reason, "expired", "the two clocks must stay distinguishable in the record");
});

test("a conversation inside the age bound still resumes", () => {
	const { store, jobDir, sessionsDir } = fixture({ maxAgeDays: 30 });
	seed(sessionsDir, sessionKeyFor(ghIssue), { body: headerAt(daysAgo(29)) });
	assert.equal(store.resolveSession(ghIssue, { jobDir, piVersion: PI }).reason, "resumed");
});

test("an unreadable conversation clock fails CLOSED, and a future one does not", () => {
	// Three causes, one token, exactly as `pi-version-changed` covers three: a header that cannot say how
	// old it is cannot be shown to be young enough.
	for (const body of [
		HEADER, // no timestamp key at all
		`${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: 12345, cwd: "/w" })}\n`, // not a string
		`${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: "not a date", cwd: "/w" })}\n`,
	]) {
		const f = fixture({ maxAgeDays: 30 });
		seed(f.sessionsDir, sessionKeyFor(ghIssue), { body });
		assert.equal(f.store.resolveSession(ghIssue, { jobDir: f.jobDir, piVersion: PI }).reason, "conversation-too-old");
	}

	// A future timestamp passes deliberately: the agent owns /session, so anything able to write one is
	// equally able to write the current instant, and refusing would turn container/host clock skew into a
	// cold start for every key. Both magnitudes are pinned -- a minute of skew, which is the real case, and
	// a year, which is the one an "impossible timestamps are hostile" rewrite would start refusing.
	for (const ahead of [60000, 365 * 86400000]) {
		const skewed = fixture({ maxAgeDays: 30 });
		seed(skewed.sessionsDir, sessionKeyFor(ghIssue), { body: headerAt(NOW + ahead) });
		assert.equal(skewed.store.resolveSession(ghIssue, { jobDir: skewed.jobDir, piVersion: PI }).reason, "resumed");
	}
});

test("an unset age bound ignores the header clock entirely", () => {
	// The inert case, and it is the one that must not regress: with the knob absent, a decade-old
	// conversation resumes exactly as it did before this gate existed.
	const { store, jobDir, sessionsDir } = fixture();
	seed(sessionsDir, sessionKeyFor(ghIssue), { body: headerAt(daysAgo(3650)) });
	assert.equal(store.resolveSession(ghIssue, { jobDir, piVersion: PI }).reason, "resumed");
});

test("a corrupt transcript is corrupt, not old: unparseable still wins over the age bound", () => {
	// Both halves of the shape check, because they are separate branches: a line that is not JSON at all,
	// and one that parses into something that is not a session header. Each carries an ancient timestamp,
	// so an arm ordered the other way round would report the lineage as aged out and hide the damage.
	for (const body of [
		"not a session\n",
		`${JSON.stringify({ type: "message", timestamp: new Date(daysAgo(9999)).toISOString() })}\n`,
	]) {
		const { store, jobDir, sessionsDir } = fixture({ maxAgeDays: 1 });
		seed(sessionsDir, sessionKeyFor(ghIssue), { body });
		assert.equal(store.resolveSession(ghIssue, { jobDir, piVersion: PI }).reason, "unparseable");
	}
});


test("the resume chain counts consecutive resumed completions, and a cold one starts the lineage over", () => {
	// The acceptance case from the issue, driven end to end through the real store: bound of 3, so the
	// fourth job in a row starts fresh, and its own completion lets the next one resume again.
	const { store, jobDir, sessionsDir } = fixture({ maxResumeChain: 3 });
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key);
	const chain = join(sessionsDir, key, "resume-chain");

	const runOnce = () => {
		const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
		// What a completed container leaves behind, and the verdict it reports for it.
		writeFileSync(join(s.hostDir, SESSION_FILE_NAME), HEADER);
		store.promoteSession(s, { piVersion: PI, resumed: s.resume });
		return s.reason;
	};

	assert.equal(runOnce(), "resumed");
	assert.equal(readFileSync(chain, "utf8"), "1");
	assert.equal(runOnce(), "resumed");
	assert.equal(runOnce(), "resumed");
	assert.equal(readFileSync(chain, "utf8"), "3", "three consecutive resumed completions");

	assert.equal(runOnce(), "resume-chain-too-long", "the fourth job starts fresh");
	assert.equal(readFileSync(chain, "utf8"), "0", "and its own completion resets the lineage");
	assert.equal(runOnce(), "resumed", "so the next one resumes again");
});

test("the chain counter follows what pi observed, not what the host intended", () => {
	// A host that staged a transcript pi then declined to continue did not extend the lineage, and
	// counting the host's intent would let a broken transcript exhaust a bound it never used.
	const { store, jobDir, sessionsDir } = fixture({ maxResumeChain: 2 });
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key);
	const chain = join(sessionsDir, key, "resume-chain");

	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	assert.equal(s.resume, true, "the host did resolve a transcript");
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), HEADER);
	store.promoteSession(s, { piVersion: PI, resumed: false });
	assert.equal(readFileSync(chain, "utf8"), "0", "the container is the one that observed the outcome");

	// And with no verdict at all (a runner image predating the field), the host's intent is the fallback.
	const s2 = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	writeFileSync(join(s2.hostDir, SESSION_FILE_NAME), HEADER);
	store.promoteSession(s2, { piVersion: PI });
	assert.equal(readFileSync(chain, "utf8"), "1");
});

test("an unset chain bound counts anyway, so setting it later is honest immediately", () => {
	// A counter that only starts when the knob does is a bound that does nothing for its first N runs.
	const { store, jobDir, sessionsDir } = fixture();
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key);
	for (let i = 0; i < 4; i++) {
		const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
		assert.equal(s.reason, "resumed", "with no bound set, nothing is ever refused for chain length");
		writeFileSync(join(s.hostDir, SESSION_FILE_NAME), HEADER);
		store.promoteSession(s, { piVersion: PI, resumed: true });
	}
	assert.equal(readFileSync(join(sessionsDir, key, "resume-chain"), "utf8"), "4");
});

test("a missing or unreadable chain counter is a chain of zero, never an exhausted one", () => {
	// Fails OPEN, the opposite of the age gate, because every key that predates this counter has no file
	// and reading that as exhausted would cold-start a whole store the day the bound is set.
	for (const body of [null, "", "  ", "not a number", "-4", "3.5"]) {
		const { store, jobDir, sessionsDir } = fixture({ maxResumeChain: 1 });
		const key = sessionKeyFor(ghIssue);
		seed(sessionsDir, key);
		if (body !== null) writeFileSync(join(sessionsDir, key, "resume-chain"), body);
		assert.equal(store.resolveSession(ghIssue, { jobDir, piVersion: PI }).reason, "resumed", `counter=${JSON.stringify(body)}`);
	}
});

test("the chain bound refuses before the transcript is read at all", () => {
	// The arm sits ahead of the header read on purpose: it asks about the lineage, not the file, so an
	// exhausted chain must not require pulling a transcript that may be megabytes. A body that would
	// otherwise be reported as unparseable proves the file was never inspected.
	const { store, jobDir, sessionsDir } = fixture({ maxResumeChain: 1 });
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key, { body: "not a session\n" });
	writeFileSync(join(sessionsDir, key, "resume-chain"), "1");
	assert.equal(store.resolveSession(ghIssue, { jobDir, piVersion: PI }).reason, "resume-chain-too-long");
});

test("a promotion that never happened leaves the counter alone", () => {
	// Only a completed run promotes, and a refused promotion must not advance a lineage that gained no
	// turn. Nothing is seeded, so this is a cold start whose container wrote nothing back: the staged file
	// is still the 0-byte one the host laid down, and inspectFile refuses before the lock is taken.
	const { store, jobDir, sessionsDir } = fixture({ maxResumeChain: 3 });
	const key = sessionKeyFor(ghIssue);
	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	assert.equal(s.reason, "absent");
	const p = store.promoteSession(s, { piVersion: PI, resumed: true });
	assert.equal(p.promoted, false);
	assert.equal(p.reason, "absent");
	assert.equal(existsSync(join(sessionsDir, key, "resume-chain")), false, "no promotion, no counter");
});
