import assert from "node:assert/strict";
import * as realFs from "node:fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { makeSessionStore, SESSION_FILE_NAME } from "../src/session-store.mjs";
import { sessionKeyFor } from "../src/session-key.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

const HEADER = `${JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/workspace" })}\n`;
const PI = "0.80.7";
/** The fake clock every fixture runs on, so a header timestamp can be placed relative to it. */
const NOW = 1_000_000_000;
/** A header the way pi actually writes one: `timestamp` is the instant the session was created. */
const headerAt = (ms) => `${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: new Date(ms).toISOString(), cwd: "/workspace" })}\n`;
const daysAgo = (n) => NOW - n * 86400000;
const ghIssue = { kind: "github", repo: "o/r", target: { type: "issue", number: 7 } };

function fixture({ ttlDays = 14, maxBytes = 1_000_000, maxAgeDays = 0, maxResumeChain = 0, maxContextPct = null, defaultBackend = "local", now = () => NOW, fs } = {}) {
	const root = tempDir("pi-store-");
	const sessionsDir = join(root, "sessions");
	mkdirSync(sessionsDir, { recursive: true });
	const logs = [];
	// `fs` omitted = the store's own real-fs default. Passing one is how a disk fault is injected on a
	// specific call without a chmod, which root ignores and Windows spells differently.
	// `defaultBackend` is the wired worker's `config.defaultBackend`. Every pre-#277 test here is a job that names
	// no venue on a deployment whose default is `local`, which is what a wired worker always passes today.
	const store = makeSessionStore({ sessionsDir, ttlDays, maxBytes, maxAgeDays, maxResumeChain, maxContextPct, defaultBackend, now, log: (e, f) => logs.push([e, f]), ...(fs ? { fs } : {}) });
	const jobDir = mkdtempSync(join(root, "job-"));
	return { root, sessionsDir, store, jobDir, logs };
}

/** Seed the canonical store for a key, the way a promotion would have. */
function seed(sessionsDir, key, { body = HEADER, piVersion = PI, venue } = {}) {
	const dir = join(sessionsDir, key);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, SESSION_FILE_NAME), body);
	writeFileSync(join(dir, "pi-version"), piVersion);
	// Omitted = no stamp at all, which is every transcript promoted before #277.
	if (venue !== undefined) writeFileSync(join(dir, "venue"), venue);
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
	const { store, jobDir, sessionsDir, logs } = fixture();
	const key = sessionKeyFor(ghIssue);
	const first = seed(sessionsDir, key);
	writeFileSync(first, HEADER);

	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), `${HEADER}{"type":"message"}\n`);

	// Another worker holds the key: the lock is an exclusive create, so this one must stand down.
	//
	// THIS STAYS A CONCURRENCY PIN ONLY BECAUSE THE LOCK IS FRESH, and that is worth saying, because the
	// reason is not visible here. `fixture()`'s clock is `NOW` (2001) while a hand-planted file gets a real
	// filesystem mtime, so `now() - mtimeMs` is hugely NEGATIVE and the staleness takeover can never fire in
	// this test. Change the fixture's default clock to the wall clock and this silently becomes a takeover
	// test asserting the opposite of its own name. The negative assertion below is what would say so.
	writeFileSync(join(sessionsDir, key, "lock"), "");
	const p = store.promoteSession(s, { piVersion: PI });
	assert.equal(p.promoted, false);
	assert.equal(p.reason, "locked");
	assert.equal(readFileSync(first, "utf8"), HEADER, "the loser must leave the canonical transcript untouched");
	assert.equal(logs.some(([event]) => event === "session_lock_stale_taken"), false, "a live lock is never taken over");
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
		store.promoteSession(s, { piVersion: PI });
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

test("the chain counter follows the HOST's delivery, which is the half no container can influence", () => {
	// This counted pi's `resumed` first, on the reasoning that a transcript pi declined to continue
	// extended nothing. That reasoning loses to the agent, which owns /session: a transcript whose payload
	// sits on lines pi's parser DROPS is delivered by the host every run while pi reports zero messages,
	// so the counter reset every run and the bound never fired. The regression test below drives that
	// exact file through the real store; this one pins the rule it rests on.
	const { store, jobDir, sessionsDir } = fixture({ maxResumeChain: 5 });
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key);
	const chain = join(sessionsDir, key, "resume-chain");

	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	assert.equal(s.resume, true, "the host did hand the transcript over");
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), HEADER);
	store.promoteSession(s, { piVersion: PI });
	assert.equal(readFileSync(chain, "utf8"), "1", "the delivery is what counts, whatever pi made of it");

	// A cold start resets, because the host did NOT hand anything over.
	const { store: s2store, jobDir: jd2, sessionsDir: sd2 } = fixture({ maxResumeChain: 5 });
	const k2 = sessionKeyFor(ghIssue);
	const cold = s2store.resolveSession(ghIssue, { jobDir: jd2, piVersion: PI });
	assert.equal(cold.resume, false);
	writeFileSync(join(cold.hostDir, SESSION_FILE_NAME), HEADER);
	s2store.promoteSession(cold, { piVersion: PI });
	assert.equal(readFileSync(join(sd2, k2, "resume-chain"), "utf8"), "0");
});

test("a transcript pi reports zero messages for still counts as a delivery", () => {
	// The regression. `payload` is a line pi's parser drops, so the runner reports `absent` every run
	// while the file rides back and forth intact. Counting pi's verdict made this a chain of zero
	// forever; counting the delivery makes the bound fire on schedule.
	const { store, jobDir, sessionsDir } = fixture({ maxResumeChain: 3, maxAgeDays: 7 });
	const key = sessionKeyFor(ghIssue);
	const carrier = () =>
		`${JSON.stringify({ type: "session", version: 3, id: "s1", timestamp: new Date(NOW).toISOString(), cwd: "/workspace" })}\n${JSON.stringify({ type: "carry", note: "payload pi drops" })}\n`;
	seed(sessionsDir, key, { body: carrier() });

	const reasons = [];
	for (let run = 0; run < 4; run++) {
		const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
		reasons.push(s.reason);
		// The agent rewrites its carrier, header timestamp refreshed, exactly as it would each run.
		writeFileSync(join(s.hostDir, SESSION_FILE_NAME), carrier());
		store.promoteSession(s, { piVersion: PI });
	}
	assert.deepEqual(reasons, ["resumed", "resumed", "resumed", "resume-chain-too-long"], "the bound must fire even though pi never reports a resume");
});

test("a sidecar is read through an lstat, so a planted link cannot decide a gate", () => {
	// The transcript has been guarded against this since the feature shipped; the sidecars inherit it
	// rather than being the exception. The store is host-only and never mounted, but the directory NAME is
	// derived rather than random, so the path can be precomputed by anyone who knows the repo and branch.
	const { store, jobDir, sessionsDir, root } = fixture({ maxResumeChain: 3, maxContextPct: 50 });
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key);
	const outside = join(root, "outside.txt");

	writeFileSync(outside, "9");
	symlinkSync(outside, join(sessionsDir, key, "resume-chain"));
	writeFileSync(join(root, "outside-ctx.txt"), "999 1000");
	symlinkSync(join(root, "outside-ctx.txt"), join(sessionsDir, key, "context"));

	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	assert.equal(s.reason, "resumed", "neither link may be followed, so neither gate acts on a file outside the store");

	// ...and the write side must not truncate what a link points at either.
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), HEADER);
	store.promoteSession(s, { piVersion: PI, context: { tokens: 1, window: 1000 } });
	assert.equal(readFileSync(outside, "utf8"), "9", "a promotion must not write through a planted link");
});

test("an oversized sidecar is no measurement, not a slow one", () => {
	// maxBytes bounds the transcript and never covered these. Both formats are a handful of bytes, and
	// reading a huge file happens on the job's own path, before any container starts.
	const { store, jobDir, sessionsDir } = fixture({ maxResumeChain: 3, maxContextPct: 50 });
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key);
	writeFileSync(join(sessionsDir, key, "resume-chain"), `${"9".repeat(5000)}`);
	writeFileSync(join(sessionsDir, key, "context"), `999 1000${" ".repeat(5000)}`);
	assert.equal(store.resolveSession(ghIssue, { jobDir, piVersion: PI }).reason, "resumed");
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
		store.promoteSession(s, { piVersion: PI });
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
	const p = store.promoteSession(s, { piVersion: PI });
	assert.equal(p.promoted, false);
	assert.equal(p.reason, "absent");
	assert.equal(existsSync(join(sessionsDir, key, "resume-chain")), false, "no promotion, no counter");
});

test("the context bound refuses at or above the threshold and resumes below it", () => {
	// 80% of a 200k window is 160000 tokens. At the line and over it refuse; one token under resumes.
	for (const [tokens, expected] of [
		[160000, "context-too-full"],
		[180000, "context-too-full"],
		[159999, "resumed"],
	]) {
		const { store, jobDir, sessionsDir } = fixture({ maxContextPct: 80 });
		const key = sessionKeyFor(ghIssue);
		seed(sessionsDir, key);
		writeFileSync(join(sessionsDir, key, "context"), `${tokens} 200000`);
		assert.equal(store.resolveSession(ghIssue, { jobDir, piVersion: PI }).reason, expected, `tokens=${tokens}`);
	}
});

test("with no measurement the context gate passes and invents no denominator", () => {
	// Every key promoted before this shipped has no sidecar, and so does every key under an image whose
	// runner predates the field. A gate with nothing to act on must pass, not guess: a bytes-against-window
	// fallback would over-read exactly past the compaction threshold this bound exists to catch.
	// Every corrupt value here would read as NEARLY FULL if it were accepted, so a parser that truncated
	// "199999.5" to 199999 would refuse rather than pass and this test would catch it. A corrupt value that
	// happens to truncate to something small proves nothing.
	for (const body of [null, "", "   ", "not numbers", "199999", "199999 0", "-1 200000", "199999.5 200000", "199999 200000.7", "199999 abc"]) {
		const { store, jobDir, sessionsDir } = fixture({ maxContextPct: 1 });
		const key = sessionKeyFor(ghIssue);
		seed(sessionsDir, key);
		if (body !== null) writeFileSync(join(sessionsDir, key, "context"), body);
		assert.equal(store.resolveSession(ghIssue, { jobDir, piVersion: PI }).reason, "resumed", `sidecar=${JSON.stringify(body)}`);
	}
});

test("an unset context bound never reads the sidecar at all", () => {
	const { store, jobDir, sessionsDir } = fixture();
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key);
	writeFileSync(join(sessionsDir, key, "context"), "199999 200000");
	assert.equal(store.resolveSession(ghIssue, { jobDir, piVersion: PI }).reason, "resumed");
});

test("a cold start CLEARS the context reading, because it promoted a different conversation", () => {
	// The trap this closes: the gate cold-started on a stale high reading, and the cold start left the same
	// reading behind for the next run to read, forever. The transcript a cold start promotes shares nothing
	// with the one the old number described, so keeping it is not caution, it is a false statement that
	// re-refuses the key every run. Nothing releases it either: every promotion refreshes the transcript's
	// mtime, so neither the TTL gate nor the reaper can reach an actively-used key.
	const { store, jobDir, sessionsDir } = fixture({ maxContextPct: 80 });
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key);
	const sidecar = join(sessionsDir, key, "context");
	writeFileSync(sidecar, "170000 200000");

	const first = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	assert.equal(first.reason, "context-too-full");
	// The container completes and reports no measurement, the case the runner's own comment enumerates.
	writeFileSync(join(first.hostDir, SESSION_FILE_NAME), HEADER);
	store.promoteSession(first, { piVersion: PI });
	assert.equal(existsSync(sidecar), false, "the reading described a transcript that no longer exists");

	assert.equal(store.resolveSession(ghIssue, { jobDir, piVersion: PI }).reason, "resumed", "and the key is usable again");
});

test("a reading stamped with another model is not a reading about this one", () => {
	// A key is (kind, repo, ref) and carries no model, so two triggers on one issue can name different
	// ones. 25000 tokens is 78% of a 32k window and 2.5% of a 1M one, so using a foreign reading is wrong
	// in both directions: it refuses a job with a far larger window and passes one with a far smaller.
	const big = { ...ghIssue, provider: "anthropic", model: "big-window" };
	const small = { ...ghIssue, provider: "anthropic", model: "small-window" };

	const { store, jobDir, sessionsDir } = fixture({ maxContextPct: 70 });
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key);
	writeFileSync(join(sessionsDir, key, "context"), "25000 32000 anthropic/small-window");
	assert.equal(store.resolveSession(small, { jobDir, piVersion: PI }).reason, "context-too-full", "78% of its own window");
	assert.equal(store.resolveSession(big, { jobDir, piVersion: PI }).reason, "resumed", "the same number says nothing about a different window");

	// Case is normalised, and the case that proves it must be one where a MISSING stamp and a MATCHING one
	// give different answers. A capitalised job against a reading from a DIFFERENT model: normalised, the
	// two ids differ and the reading is ignored; unnormalised, the job's id falls out of the charset,
	// counts as unknown, and the foreign reading is used after all.
	const shouty = { ...ghIssue, provider: "Anthropic", model: "Big-Window" };
	assert.equal(store.resolveSession(shouty, { jobDir, piVersion: PI }).reason, "resumed");

	// Unknown on either side stays usable, so a deployment naming no model keeps the bound it had.
	const bare = fixture({ maxContextPct: 70 });
	seed(bare.sessionsDir, key);
	writeFileSync(join(bare.sessionsDir, key, "context"), "25000 32000");
	assert.equal(bare.store.resolveSession(ghIssue, { jobDir: bare.jobDir, piVersion: PI }).reason, "context-too-full");
});

test("a promotion that landed is never reported as promote-failed by its own bookkeeping", () => {
	// The sidecars are written AFTER the transcript is swapped in. Letting one throw returned
	// `promote-failed` for a promotion that demonstrably happened, which tells an operator the next run
	// will cold start when it will in fact resume, and freezes the counter below its bound forever.
	const { store, jobDir, sessionsDir, logs } = fixture({
		maxResumeChain: 5,
		fs: {
			...realFs,
			writeFileSync: (p, ...rest) => {
				if (String(p).includes("resume-chain")) throw new Error("ENOSPC: no space left on device");
				return realFs.writeFileSync(p, ...rest);
			},
		},
	});
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key);
	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), `${HEADER}extended\n`);
	const p = store.promoteSession(s, { piVersion: PI });

	assert.equal(p.promoted, true, "the transcript really was promoted");
	assert.equal(p.reason, "promoted");
	assert.equal(readFileSync(join(sessionsDir, key, SESSION_FILE_NAME), "utf8").includes("extended"), true);
	assert.ok(
		logs.some(([event, fields]) => event === "session_sidecar_failed" && fields.file === "resume-chain"),
		"the bookkeeping loss is logged rather than reported as a failed promotion",
	);
	assert.equal(existsSync(join(sessionsDir, key, "lock")), false, "and the lock is still released");
});

test("locked means locked: any other failure to take the lock is promote-failed", () => {
	// openSync(lock, "wx") fails for a read-only directory, a full disk and a vanished store too, and
	// reporting those as `locked` sends an operator looking for a stuck lock file that does not exist.
	const { store, jobDir, sessionsDir, logs } = fixture({
		fs: {
			...realFs,
			openSync: (p, flags) => {
				if (String(p).endsWith("lock")) {
					const err = new Error("EACCES: permission denied");
					err.code = "EACCES";
					throw err;
				}
				return realFs.openSync(p, flags);
			},
		},
	});
	seed(sessionsDir, sessionKeyFor(ghIssue));
	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), HEADER);
	const p = store.promoteSession(s, { piVersion: PI });
	assert.equal(p.reason, "promote-failed");
	assert.equal(logs.some(([, fields]) => fields?.reason === "locked"), false, "nothing may be reported as a concurrency event that was not one");
});

test("promotion stores the container's context reading, and never erases one it cannot replace", () => {
	const { store, jobDir, sessionsDir } = fixture();
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key);
	const sidecar = join(sessionsDir, key, "context");

	const first = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	writeFileSync(join(first.hostDir, SESSION_FILE_NAME), HEADER);
	store.promoteSession(first, { piVersion: PI, resumed: true, context: { tokens: 12345, window: 200000 } });
	assert.equal(readFileSync(sidecar, "utf8"), "12345 200000", "both numbers, so a later reader can see what the refusal was judged against");

	// A run that measured nothing (a compaction left pi's count unknown, or an older runner) must leave the
	// last real reading in place: writing 0 would read as "the context emptied", which cannot have happened.
	const second = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	writeFileSync(join(second.hostDir, SESSION_FILE_NAME), HEADER);
	store.promoteSession(second, { piVersion: PI });
	assert.equal(readFileSync(sidecar, "utf8"), "12345 200000");
});

// --- the venue stamp (issue #277) ----------------------------------------------------------------------------

const farIssue = { ...ghIssue, backend: "far" };
const venueFile = (sessionsDir) => join(sessionsDir, sessionKeyFor(ghIssue), "venue");

test("a transcript stamped with another venue cold-starts as venue-changed, and its own venue resumes it", () => {
	const { store, jobDir, sessionsDir } = fixture();
	seed(sessionsDir, sessionKeyFor(ghIssue), { venue: "far" });
	const local = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	assert.equal(local.reason, "venue-changed", "a trigger moved off `far` must not stage far's transcript into a local container");
	assert.equal(local.resume, false);
	assert.equal(readFileSync(join(local.hostDir, SESSION_FILE_NAME), "utf8"), "", "and nothing of it is staged");
	const far = store.resolveSession(farIssue, { jobDir, piVersion: PI });
	assert.equal(far.reason, "resumed");
	assert.equal(far.venue, "far", "the session carries the venue it resolved, for the promotion to stamp");
});

test("an UNSTAMPED transcript was written on local, never on whatever the default is now", () => {
	const a = fixture();
	seed(a.sessionsDir, sessionKeyFor(ghIssue));
	assert.equal(a.store.resolveSession(ghIssue, { jobDir: a.jobDir, piVersion: PI }).reason, "resumed", "every pre-#277 key keeps resuming on local");
	assert.equal(a.store.resolveSession(farIssue, { jobDir: a.jobDir, piVersion: PI }).reason, "venue-changed");
	// A deployment whose default venue is not `local`: an unflagged job resolves to `far`, and an unstamped
	// transcript is still a LOCAL one. Reading absence as the default would resume it there.
	const b = fixture({ defaultBackend: "far" });
	seed(b.sessionsDir, sessionKeyFor(ghIssue));
	assert.equal(b.store.resolveSession(ghIssue, { jobDir: b.jobDir, piVersion: PI }).reason, "venue-changed");
});

test("venue-changed names itself ahead of both pi-version arms, and expired still names itself first", () => {
	const v = fixture();
	seed(v.sessionsDir, sessionKeyFor(ghIssue), { venue: "far", piVersion: "0.79.0" });
	assert.equal(v.store.resolveSession(ghIssue, { jobDir: v.jobDir, piVersion: PI }).reason, "venue-changed", "a move between venues is not a version change");
	assert.equal(v.store.resolveSession(ghIssue, { jobDir: v.jobDir, piVersion: null }).reason, "venue-changed", "nor is a venue whose image declares no version");

	const e = fixture({ ttlDays: 1, now: () => Date.now() });
	const file = seed(e.sessionsDir, sessionKeyFor(ghIssue), { venue: "far" });
	const old = (Date.now() - 3 * 86400000) / 1000;
	utimesSync(file, old, old);
	assert.equal(e.store.resolveSession(ghIssue, { jobDir: e.jobDir, piVersion: PI }).reason, "expired", "a transcript past its TTL is expired on every venue");
});

test("the venue arm refuses before the transcript body is read", () => {
	const { store, jobDir, sessionsDir } = fixture();
	seed(sessionsDir, sessionKeyFor(ghIssue), { body: "not a session\n", venue: "far" });
	assert.equal(store.resolveSession(ghIssue, { jobDir, piVersion: PI }).reason, "venue-changed");
});

test("a stamp that exists but cannot be read fails CLOSED, and only a missing one reads as local", () => {
	const key = sessionKeyFor(ghIssue);
	const cases = {
		// A link that points nowhere. `stat`/`existsSync` would call this absent, read it as `local`, and resume.
		dangling: (dir, root) => symlinkSync(join(root, "no-such-file"), join(dir, "venue")),
		// A link to a file that says `local`: the value must never be read through a link.
		planted: (dir, root) => (writeFileSync(join(root, "says-local"), "local"), symlinkSync(join(root, "says-local"), join(dir, "venue"))),
		empty: (dir) => writeFileSync(join(dir, "venue"), ""),
		oversized: (dir) => writeFileSync(join(dir, "venue"), "local".padEnd(5000, " ")),
		directory: (dir) => mkdirSync(join(dir, "venue")),
	};
	for (const [name, plant] of Object.entries(cases)) {
		const { store, jobDir, sessionsDir, root } = fixture();
		seed(sessionsDir, key);
		plant(join(sessionsDir, key), root);
		const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
		assert.equal(s.reason, "venue-changed", `${name}: an unusable stamp matches no venue`);
		assert.equal(s.resume, false, name);
	}
	// A trailing newline is formatting, not a different venue.
	const t = fixture();
	seed(t.sessionsDir, key, { venue: "local\n" });
	assert.equal(t.store.resolveSession(ghIssue, { jobDir: t.jobDir, piVersion: PI }).reason, "resumed");
});

test("a job whose venue cannot be resolved never resumes", () => {
	const { store, jobDir, sessionsDir } = fixture({ defaultBackend: null });
	seed(sessionsDir, sessionKeyFor(ghIssue));
	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	assert.equal(s.reason, "venue-changed", "the DI seam with no default fails closed, the pi-version gate's polarity");
	assert.equal(s.venue, null);
});

test("a promotion stamps the venue that produced the transcript, and the next job is gated on it", () => {
	const { store, jobDir, sessionsDir } = fixture();
	const s = store.resolveSession(farIssue, { jobDir, piVersion: PI });
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), HEADER);
	assert.equal(store.promoteSession(s, { piVersion: PI }).promoted, true);
	assert.equal(readFileSync(venueFile(sessionsDir), "utf8"), "far");
	assert.equal(store.resolveSession(ghIssue, { jobDir, piVersion: PI }).reason, "venue-changed");
	assert.equal(store.resolveSession(farIssue, { jobDir, piVersion: PI }).reason, "resumed");
});

test("a promotion invalidates the stamp BEFORE the swap, so a failed swap can never leave a transcript misattributed", () => {
	// Faulted at the CANONICAL rename only: the sentinel's own rename succeeds, the transcript's does not.
	const key = sessionKeyFor(ghIssue);
	const renameFaulted = fixture({
		fs: {
			...realFs,
			renameSync: (from, to) => {
				if (String(to).endsWith(SESSION_FILE_NAME)) throw new Error("ENOSPC: no space left on device");
				return realFs.renameSync(from, to);
			},
		},
	});
	const canonical = seed(renameFaulted.sessionsDir, key);
	const s = renameFaulted.store.resolveSession(farIssue, { jobDir: renameFaulted.jobDir, piVersion: PI });
	assert.equal(s.reason, "venue-changed");
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), `${HEADER}{"type":"message","from":"far"}\n`);
	assert.equal(renameFaulted.store.promoteSession(s, { piVersion: PI }).reason, "promote-failed");
	assert.equal(readFileSync(canonical, "utf8"), HEADER, "the local transcript is still in place");
	assert.equal(readFileSync(join(renameFaulted.sessionsDir, key, "venue"), "utf8"), "(pending)", "and no longer claims any venue");
	assert.equal(renameFaulted.store.resolveSession(ghIssue, { jobDir: renameFaulted.jobDir, piVersion: PI }).reason, "venue-changed");
	assert.equal(renameFaulted.store.resolveSession(farIssue, { jobDir: renameFaulted.jobDir, piVersion: PI }).reason, "venue-changed");

	// Faulted at the sentinel write itself: fatal, and nothing is touched.
	const sentinelFaulted = fixture({
		fs: {
			...realFs,
			writeFileSync: (p, ...rest) => {
				if (String(p).endsWith("venue.incoming")) throw new Error("EACCES: permission denied");
				return realFs.writeFileSync(p, ...rest);
			},
		},
	});
	const canonical2 = seed(sentinelFaulted.sessionsDir, key, { venue: "local" });
	const s2 = sentinelFaulted.store.resolveSession(farIssue, { jobDir: sentinelFaulted.jobDir, piVersion: PI });
	writeFileSync(join(s2.hostDir, SESSION_FILE_NAME), `${HEADER}{"type":"message","from":"far"}\n`);
	assert.equal(sentinelFaulted.store.promoteSession(s2, { piVersion: PI }).reason, "promote-failed");
	assert.equal(readFileSync(canonical2, "utf8"), HEADER, "no swap happened");
	assert.equal(readFileSync(join(sentinelFaulted.sessionsDir, key, "venue"), "utf8"), "local", "and the stamp that described it still does");
	assert.equal(existsSync(join(sentinelFaulted.sessionsDir, key, "lock")), false, "and the lock is released");
});

test("a promotion whose real stamp cannot be written landed, and leaves the key cold rather than misattributed", () => {
	// The sentinel write succeeds; the SECOND write of the stamp (the real venue) fails.
	let venueWrites = 0;
	const { store, jobDir, sessionsDir, logs } = fixture({
		fs: {
			...realFs,
			writeFileSync: (p, ...rest) => {
				if (String(p).endsWith("venue.incoming") && ++venueWrites === 2) throw new Error("ENOSPC: no space left on device");
				return realFs.writeFileSync(p, ...rest);
			},
		},
	});
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key);
	const s = store.resolveSession(farIssue, { jobDir, piVersion: PI });
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), `${HEADER}far-turns\n`);
	const p = store.promoteSession(s, { piVersion: PI });
	assert.equal(p.promoted, true, "the transcript really was promoted");
	assert.equal(readFileSync(join(sessionsDir, key, SESSION_FILE_NAME), "utf8").includes("far-turns"), true);
	assert.equal(readFileSync(join(sessionsDir, key, "venue"), "utf8"), "(pending)");
	assert.ok(logs.some(([event, fields]) => event === "session_sidecar_failed" && fields.file === "venue"));
	assert.equal(store.resolveSession(ghIssue, { jobDir, piVersion: PI }).reason, "venue-changed", "a local job never resumes far's transcript under a stamp that was never written");
});

test("the stamp follows the transcript that last landed, whichever venue promoted in between", () => {
	const { store, sessionsDir, root } = fixture();
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key, { venue: "local" });
	const jobA = mkdtempSync(join(root, "job-a-"));
	const jobB = mkdtempSync(join(root, "job-b-"));
	const a = store.resolveSession(ghIssue, { jobDir: jobA, piVersion: PI });
	assert.equal(a.reason, "resumed");
	const b = store.resolveSession(farIssue, { jobDir: jobB, piVersion: PI });
	writeFileSync(join(b.hostDir, SESSION_FILE_NAME), `${HEADER}from-far\n`);
	assert.equal(store.promoteSession(b, { piVersion: PI }).promoted, true);
	assert.equal(readFileSync(join(sessionsDir, key, "venue"), "utf8"), "far");
	// A, still holding its resolve-time verdict, promotes last.
	writeFileSync(join(a.hostDir, SESSION_FILE_NAME), `${HEADER}from-local\n`);
	assert.equal(store.promoteSession(a, { piVersion: PI }).promoted, true);
	assert.equal(readFileSync(join(sessionsDir, key, "venue"), "utf8"), "local", "the stamp names the venue of the transcript now in place");
	assert.equal(readFileSync(join(sessionsDir, key, SESSION_FILE_NAME), "utf8").includes("from-local"), true);
});

test("a promotion from another venue that lands between the gate and the open is caught, and nothing of it is staged", () => {
	const key = sessionKeyFor(ghIssue);
	let sessionsDirRef;
	const { store, jobDir, sessionsDir } = fixture({
		maxResumeChain: 5,
		fs: {
			...realFs,
			// The OPEN of the canonical transcript is where the race lands (issue #375): a concurrent far
			// promotion writes its sentinel and swaps its transcript in, and the descriptor this store is about
			// to take is therefore the new file rather than the judged one.
			openSync: (path, flags, ...rest) => {
				if (flags === "r" && String(path).startsWith(sessionsDirRef) && String(path).endsWith(SESSION_FILE_NAME)) {
					realFs.writeFileSync(join(sessionsDirRef, key, "venue"), "(pending)");
					realFs.writeFileSync(path, `${HEADER}far-transcript\n`);
				}
				return realFs.openSync(path, flags, ...rest);
			},
		},
	});
	sessionsDirRef = sessionsDir;
	seed(sessionsDir, key, { venue: "local" });
	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	assert.equal(s.reason, "venue-changed");
	assert.equal(s.resume, false, "resume is false, so the chain counter and the context reading reset like any cold start");
	assert.equal(s.bytes, null);
	assert.equal(statSync(join(s.hostDir, SESSION_FILE_NAME)).size, 0, "the copied far transcript is emptied, never handed to the container");
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), HEADER);
	assert.equal(store.promoteSession(s, { piVersion: PI }).promoted, true);
	assert.equal(readFileSync(join(sessionsDir, key, "resume-chain"), "utf8"), "0", "a cold start resets the chain");
});

test("an lstat failure on the stamp that is NOT absence fails closed, never reading as local", () => {
	// Only ENOENT is absence. An EIO or EACCES on the stamp says nothing about which venue wrote the transcript,
	// and reading it as `local` would resume another venue's conversation on the strength of a disk fault.
	const { store, jobDir, sessionsDir } = fixture({
		fs: {
			...realFs,
			lstatSync: (p, ...rest) => {
				if (String(p).endsWith(`${join(sessionKeyFor(ghIssue), "venue")}`)) {
					const err = new Error("EIO: i/o error");
					err.code = "EIO";
					throw err;
				}
				return realFs.lstatSync(p, ...rest);
			},
		},
	});
	seed(sessionsDir, sessionKeyFor(ghIssue), { venue: "far" });
	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	assert.equal(s.reason, "venue-changed");
	assert.equal(s.resume, false);
});

test("a job with no resolvable venue never resumes, even where the stamp cannot be read either", () => {
	// The one input where the stamp read also yields nothing: an unusable stamp. Without the explicit null
	// check, "nothing" would equal "nothing" and the job would resume.
	const { store, jobDir, sessionsDir } = fixture({ defaultBackend: null });
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key);
	mkdirSync(join(sessionsDir, key, "venue"));
	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	assert.equal(s.reason, "venue-changed");
	assert.equal(s.resume, false);
	assert.equal(statSync(join(s.hostDir, SESSION_FILE_NAME)).size, 0, "nothing was staged");
	// And the arm itself names the refusal, ahead of the pi-version arm, without the re-check behind it.
	const v = fixture({ defaultBackend: null });
	seed(v.sessionsDir, key);
	assert.equal(v.store.resolveSession(ghIssue, { jobDir: v.jobDir, piVersion: null }).reason, "venue-changed");
});

// --- the stale-lock takeover (issue #336) ---

// A lock's age is decided against the store's own injected clock, so the planted mtime is derived from NOW
// rather than from the wall clock: a real 2026 mtime against a 2001 fixture clock is NEGATIVE age, which is
// exactly the trap that kept the pin above honest by accident.
const agedLock = (sessionsDir, key, ageMs) => {
	const lock = join(sessionsDir, key, "lock");
	writeFileSync(lock, "");
	const at = new Date(NOW - ageMs);
	realFs.utimesSync(lock, at, at);
	return lock;
};

test("a lock older than any plausible promotion is TAKEN OVER, and the promotion lands (#336)", () => {
	// A process killed inside the lock leaks it, and nothing released it: later promotions reported `locked`
	// until the reaper swept the key, which it could not do for a key whose first promotion died before any
	// transcript landed, and does not do at all under PI_SESSIONS_TTL_DAYS=0.
	const { store, jobDir, sessionsDir, logs } = fixture();
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key, { venue: "local" });
	const lock = agedLock(sessionsDir, key, 2 * 3600_000);

	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), `${HEADER}after-takeover\n`);
	const p = store.promoteSession(s, { piVersion: PI });

	assert.equal(p.promoted, true, "a crashed writer's lock must not wedge the key forever");
	assert.equal(readFileSync(join(sessionsDir, key, SESSION_FILE_NAME), "utf8").includes("after-takeover"), true);
	const taken = logs.find(([event]) => event === "session_lock_stale_taken");
	assert.ok(taken, "the takeover has its own line, or it happens silently");
	assert.equal(taken[1].key, key);
	assert.ok(taken[1].ageMs >= 2 * 3600_000, "and the line carries how stale it was");
	assert.equal(existsSync(lock), false, "the lock is released again afterwards");
});

test("the takeover reaches the two shapes the reaper never could: no transcript, and TTL 0 (#336)", () => {
	// These are the Acceptance clauses of the issue, and they are the whole reason a takeover is the primary
	// fix rather than a reaper change. A key whose FIRST promotion died has no transcript for the reaper to
	// key on, and `PI_SESSIONS_TTL_DAYS=0` stops the reaper running at all. The mechanism does not depend on
	// either, which is exactly why both are pinned rather than argued.
	for (const [name, ttlDays] of [["a key with no transcript", 14], ["a store with TTL 0", 0]]) {
		const { store, jobDir, sessionsDir, logs } = fixture({ ttlDays });
		const key = sessionKeyFor(ghIssue);
		// No seed: the key directory exists with a leaked lock and nothing else, which is what a promotion
		// killed before its first swap leaves behind.
		mkdirSync(join(sessionsDir, key), { recursive: true });
		agedLock(sessionsDir, key, 2 * 3600_000);

		const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
		assert.equal(s.reason, "absent", `${name}: there is no transcript to resume`);
		writeFileSync(join(s.hostDir, SESSION_FILE_NAME), `${HEADER}recovered\n`);

		assert.equal(store.promoteSession(s, { piVersion: PI }).promoted, true, `${name}: the key must not stay wedged`);
		assert.ok(logs.some(([event]) => event === "session_lock_stale_taken"), `${name}: and the takeover is said`);
		assert.equal(readFileSync(join(sessionsDir, key, SESSION_FILE_NAME), "utf8").includes("recovered"), true, name);
	}
});

test("a lock YOUNGER than the threshold is a live writer, and the loser still discards (#336)", () => {
	// The bound is exercised from both sides on purpose: a bound nothing tests is a bound that drifts, and
	// this half is what stops the takeover from stealing a slow writer's lock.
	const { store, jobDir, sessionsDir, logs } = fixture();
	const key = sessionKeyFor(ghIssue);
	const first = seed(sessionsDir, key, { venue: "local" });
	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), `${HEADER}loser\n`);
	// ONE MINUTE UNDER THE BOUND, not merely "young". A bound pinned only between a minute and two hours is
	// a bound that can be set to a minute without a test objecting, and a one-minute takeover steals a live
	// writer's lock on any store slower than a minute.
	const lock = agedLock(sessionsDir, key, 3_600_000 - 60_000);

	const p = store.promoteSession(s, { piVersion: PI });
	assert.equal(p.reason, "locked", "a lock a minute under the bound is still a live writer");
	assert.equal(readFileSync(first, "utf8"), HEADER, "and the loser leaves the canonical transcript alone");
	assert.equal(existsSync(lock), true, "and does not remove the holder's lock");
	assert.equal(logs.some(([event]) => event === "session_lock_stale_taken"), false, "and says nothing about a takeover");
});

test("the takeover is ONE retake, and the retake is still an exclusive create (#336)", () => {
	// Two properties the contract states and nothing pinned. Retrying N times would make the takeover a loop
	// that outlasts a rival rather than a single concession, and a non-exclusive retake would stop it being a
	// lock at all -- the second is the very race the log-ordering rule above exists for.
	const opens = [];
	const { store, jobDir, sessionsDir } = fixture({
		fs: {
			...realFs,
			openSync: (p, flags, ...rest) => {
				if (String(p).endsWith("lock")) opens.push(flags);
				return realFs.openSync(p, flags, ...rest);
			},
		},
	});
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key, { venue: "local" });
	agedLock(sessionsDir, key, 2 * 3600_000);

	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), HEADER);
	assert.equal(store.promoteSession(s, { piVersion: PI }).promoted, true);

	assert.ok(opens.length <= 2, `one takeover means at most two creates, got ${opens.length}`);
	for (const flags of opens) assert.equal(flags, "wx", "every attempt is an EXCLUSIVE create, retake included");
});

test("a takeover is logged only AFTER the retake succeeded (#336)", () => {
	// A rival sweeper can win the recreate race. Logging on the unlink would tell an operator this process
	// took a lock it does not hold.
	let creates = 0;
	const { store, jobDir, sessionsDir, logs } = fixture({
		fs: {
			...realFs,
			openSync: (p, ...rest) => {
				if (String(p).endsWith("lock")) {
					creates++;
					throw Object.assign(new Error("EEXIST"), { code: "EEXIST" });
				}
				return realFs.openSync(p, ...rest);
			},
		},
	});
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key, { venue: "local" });
	agedLock(sessionsDir, key, 2 * 3600_000);

	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), HEADER);
	assert.equal(store.promoteSession(s, { piVersion: PI }).reason, "locked", "the retake lost, so this job stands down");
	assert.equal(logs.some(([event]) => event === "session_lock_stale_taken"), false, "and claims no takeover it did not complete");
	// ONE retake, even when it keeps losing. A loop that retries until it wins is a takeover that outlasts a
	// rival rather than a single concession, and this is the only path where the difference is observable.
	assert.equal(creates, 2, "one initial create and one retake, never a retry loop");
});

test("a DANGLING link planted at the lock name does not wedge the key forever (#336)", () => {
	// `openSync(..., "wx")` fails EEXIST on a dangling symlink, so a link planted at this name was a permanent
	// wedge. It is also why the age is read with `lstat`: under `stat` a dangling link throws ENOENT on every
	// attempt, and the key stays wedged with the takeover in place.
	const { store, jobDir, sessionsDir, root, logs } = fixture();
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key, { venue: "local" });
	const lock = join(sessionsDir, key, "lock");
	symlinkSync(join(root, "nothing-here"), lock);
	const at = new Date(NOW - 2 * 3600_000);
	realFs.lutimesSync(lock, at, at);

	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), `${HEADER}unwedged\n`);
	assert.equal(store.promoteSession(s, { piVersion: PI }).promoted, true, "a planted link must not hold the key for good");
	assert.ok(logs.some(([event]) => event === "session_lock_stale_taken"));
	assert.equal(readFileSync(join(sessionsDir, key, SESSION_FILE_NAME), "utf8").includes("unwedged"), true);
});

test("a promotion that LANDED is never reported as promote-failed by its pi-version stamp (#336)", () => {
	// This test used to pin the opposite, because the pi-version write was the one plain, in-try write left
	// and a fault there reported `promote-failed` for a promotion that had already swapped. That was a stated
	// residual of INT-SESSION-STORE-CONTRACT, not an intention, and it is closed.
	//
	// The fault predicate moved with the fix and that is the point: the write now goes through
	// `writeSidecar` -> `replaceSidecar`, so the byte-carrying write lands on `pi-version.incoming` and a
	// predicate on `pi-version` itself would no longer fire at all -- a test that silently stopped testing.
	const { store, jobDir, sessionsDir, logs } = fixture({
		fs: {
			...realFs,
			writeFileSync: (p, ...rest) => {
				if (String(p).endsWith("pi-version.incoming")) throw new Error("ENOSPC: no space left on device");
				return realFs.writeFileSync(p, ...rest);
			},
		},
	});
	const key = sessionKeyFor(ghIssue);
	const s = store.resolveSession(farIssue, { jobDir, piVersion: PI });
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), `${HEADER}far\n`);

	const p = store.promoteSession(s, { piVersion: PI });
	assert.equal(p.promoted, true, "the transcript swapped, so the promotion happened");
	assert.equal(p.reason, "promoted", "and the record must not claim otherwise");
	assert.equal(readFileSync(join(sessionsDir, key, SESSION_FILE_NAME), "utf8").includes("far"), true, "the transcript did land");
	assert.equal(readFileSync(join(sessionsDir, key, "venue"), "utf8"), "far", "and its venue is stamped, not left pending");
	assert.ok(
		logs.some(([event, f]) => event === "session_sidecar_failed" && f.file === "pi-version"),
		"the bookkeeping loss is logged, which is what links this promotion to the cold start that follows it",
	);

	// The safe direction, asserted rather than argued: no stamp means the next job cold-starts.
	const next = store.resolveSession(farIssue, { jobDir, piVersion: PI });
	assert.equal(next.reason, "pi-version-changed", "an unstamped transcript is never resumed");
});

test("a link planted at pi-version is not written THROUGH by a promotion (#336)", () => {
	// The write edge. `writeFileSync` follows a link, and the key directory's name is DERIVED, so the path is
	// precomputable by anyone who knows the repository and the branch: the plain write turned a promotion into
	// a truncating write of the link's target, with the pi version as the payload. A reviewer confirmed the
	// target file was overwritten, which is why this is a test and not a comment.
	const { store, jobDir, sessionsDir, root } = fixture();
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key);
	const outside = join(root, "outside-version.txt");
	writeFileSync(outside, "untouched");
	realFs.rmSync(join(sessionsDir, key, "pi-version"));
	symlinkSync(outside, join(sessionsDir, key, "pi-version"));

	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), HEADER);
	assert.equal(store.promoteSession(s, { piVersion: PI }).promoted, true);

	assert.equal(readFileSync(outside, "utf8"), "untouched", "a promotion must not write through a planted link");
	assert.equal(realFs.lstatSync(join(sessionsDir, key, "pi-version")).isSymbolicLink(), false, "the rename replaces the link with a regular file");
	assert.equal(readFileSync(join(sessionsDir, key, "pi-version"), "utf8"), PI, "and the stamp is this promotion's own");
});

test("a link planted at pi-version cannot decide the pi-version gate either (#336)", () => {
	// The read edge, which `readSidecar`'s lstat already guarded: a regression bolt, so the guard cannot be
	// quietly dropped back to a bare readFileSync. Every shape reads as no usable stamp, hence a cold start.
	const cases = {
		dangling: (dir, root) => symlinkSync(join(root, "gone.txt"), join(dir, "pi-version")),
		planted: (dir, root) => (writeFileSync(join(root, "elsewhere.txt"), PI), symlinkSync(join(root, "elsewhere.txt"), join(dir, "pi-version"))),
		directory: (dir) => realFs.mkdirSync(join(dir, "pi-version")),
	};
	for (const [name, plant] of Object.entries(cases)) {
		const { store, jobDir, sessionsDir, root } = fixture();
		const key = sessionKeyFor(ghIssue);
		seed(sessionsDir, key);
		realFs.rmSync(join(sessionsDir, key, "pi-version"));
		plant(join(sessionsDir, key), root);
		assert.equal(store.resolveSession(ghIssue, { jobDir, piVersion: PI }).reason, "pi-version-changed", `${name} must not be read as a stamp`);
	}
});

test("a promotion that knows no pi version INVALIDATES the stamp rather than leaving the old one (#336)", () => {
	// `String(piVersion ?? "")` writes a 0-byte file, which `readSidecar`'s size check refuses, so the key
	// cold-starts. Skipping the write instead -- the obvious simplification -- would leave a PREVIOUS version
	// beside a transcript written by an unknown pi, and the next job on that version would resume it.
	const { store, jobDir, sessionsDir } = fixture();
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key);

	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	assert.equal(s.reason, "resumed", "the seeded stamp matches, so this run resumes");
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), `${HEADER}next\n`);
	assert.equal(store.promoteSession(s, { piVersion: null }).promoted, true);

	assert.equal(readFileSync(join(sessionsDir, key, "pi-version"), "utf8"), "", "the stamp is emptied, not left naming a pi that did not write this");
	assert.equal(store.resolveSession(ghIssue, { jobDir, piVersion: PI }).reason, "pi-version-changed", "so the next job cold-starts");
});

test("every temp is REMOVED before it is written, so a link planted at one receives nothing (#336)", () => {
	// The defence is the removal, not the name, and nothing pinned it. Removing either `rmSync` leaves the
	// whole suite green while a link planted at that temp receives the agent's entire transcript (at the
	// transcript temp) or the pi version (at a sidecar temp) -- which is issue #336 part 1's own defect, one
	// name along. Both were demonstrated as passing mutants before this test existed.
	//
	// Pinned as ORDER on the injected fs rather than by planting a link: the transcript temp now carries
	// random bytes, so its name cannot be predicted by a test any more than by an attacker, and the property
	// that matters is that the remove happens first for the SAME path.
	const calls = [];
	const { store, jobDir, sessionsDir } = fixture({
		fs: {
			...realFs,
			// BOTH removals count: `removeTemp` reaches for `unlinkSync` first and `rmSync` only for the one
			// shape unlink cannot take, so a test that watched only one of them would pin half the rule.
			unlinkSync: (p, ...rest) => {
				if (String(p).includes(".incoming")) calls.push(["rm", String(p)]);
				return realFs.unlinkSync(p, ...rest);
			},
			rmSync: (p, ...rest) => {
				if (String(p).includes(".incoming")) calls.push(["rm", String(p)]);
				return realFs.rmSync(p, ...rest);
			},
			copyFileSync: (from, to, ...rest) => {
				if (String(to).includes(".incoming")) calls.push(["write", String(to)]);
				return realFs.copyFileSync(from, to, ...rest);
			},
			writeFileSync: (p, ...rest) => {
				if (String(p).includes(".incoming")) calls.push(["write", String(p)]);
				return realFs.writeFileSync(p, ...rest);
			},
		},
	});
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key, { venue: "local" });
	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), `${HEADER}body\n`);
	assert.equal(store.promoteSession(s, { piVersion: PI, context: { tokens: 1, window: 1000 } }).promoted, true);

	const written = calls.filter(([kind]) => kind === "write").map(([, p]) => p);
	assert.ok(written.length >= 4, "the transcript temp and the sidecar temps are all written through one");
	for (const path of new Set(written)) {
		const first = calls.findIndex(([, p]) => p === path);
		assert.equal(calls[first][0], "rm", `${path.split("/").pop()} must be REMOVED before anything writes it`);
	}
});

test("a temp name carrying ANY shape is cleared, and nothing is written through it (#336)", () => {
	// Arms a fixture whose injected `unlinkSync` plants `shape` at the TRANSCRIPT temp the first time the
	// store reaches for it, so the plant is in place exactly when the removal runs.
	const fixture0 = (shape, plant) => {
		let armed = false;
		let root;
		const made = fixture({
			fs: {
				...realFs,
				unlinkSync: (p, ...rest) => {
					const path = String(p);
					if (!armed && /current\.jsonl\.\d+\.\d+\.[0-9a-f]{12}\.incoming$/.test(path)) {
						armed = true;
						plant(path, join(root, "victim-transcript"));
					}
					return realFs.unlinkSync(p, ...rest);
				},
			},
		});
		root = made.root;
		return made;
	};

	// The three shapes a temp name can be left in, and each was got wrong by a different version of this
	// rule. A DANGLING link is the sharp one: `rmSync` resolves the path, finds nothing, and reports success
	// while LEAVING the link, so the write that follows creates a file at the link's target -- the
	// write-through-a-link hole this series exists to close, reintroduced by the fix for the directory case.
	// A directory cannot be unlinked at all, and at `venue.incoming`, the one fatal sidecar write, that
	// wedged every promotion on the key forever.
	//
	// The sidecar temp names are FIXED and precomputable, which is the threat model this module already
	// states; the transcript temp now carries random bytes, so it is covered by the shared rule rather than
	// by a plantable name.
	const shapes = [
		["a dangling link", (at, victim) => symlinkSync(victim, at)],
		["a link to an existing file", (at, victim) => (writeFileSync(victim, "PRECIOUS"), symlinkSync(victim, at))],
		["a directory", (at) => (mkdirSync(at, { recursive: true }), writeFileSync(join(at, "inside"), "x"))],
	];

	// SITE 2, the TRANSCRIPT temp, and it needs the seam rather than a path: its name carries random bytes,
	// so a test cannot plant at it any more than an attacker can guess it. Planting from inside the injected
	// `unlinkSync` puts the shape there at the instant the removal runs, which is the real ordering. Without
	// this site the transcript call site is unpinned, and reverting IT alone to either single call -- the two
	// rules that actually shipped -- passes.
	for (const [shape, plant] of shapes) {
		const { store, jobDir, sessionsDir, root } = fixture0(shape, plant);
		const key = sessionKeyFor(ghIssue);
		seed(sessionsDir, key, { venue: "local" });
		const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
		writeFileSync(join(s.hostDir, SESSION_FILE_NAME), `${HEADER}${shape}\n`);
		const p = store.promoteSession(s, { piVersion: PI });

		assert.equal(p.promoted, true, `transcript temp, ${shape}: a planted temp must not wedge the key`);
		assert.equal(readFileSync(join(sessionsDir, key, SESSION_FILE_NAME), "utf8").includes(shape), true, `transcript temp, ${shape}: the transcript lands`);
		const victim = join(root, "victim-transcript");
		if (shape === "a dangling link") assert.equal(existsSync(victim), false, `transcript temp, ${shape}: nothing may be created at the link's target`);
		if (shape === "a link to an existing file") assert.equal(readFileSync(victim, "utf8"), "PRECIOUS", `transcript temp, ${shape}: the target is untouched`);
	}

	for (const [shape, plant] of shapes) {
		const { store, jobDir, sessionsDir, root } = fixture();
		const key = sessionKeyFor(ghIssue);
		seed(sessionsDir, key, { venue: "local" });
		const victim = join(root, `victim-${shape.replace(/\W+/g, "-")}`);
		// `venue.incoming` is the sentinel's temp: the ONE sidecar write that is fatal, so a shape that
		// survives here fails every promotion on the key rather than logging a lost sidecar.
		plant(join(sessionsDir, key, "venue.incoming"), victim);

		const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
		writeFileSync(join(s.hostDir, SESSION_FILE_NAME), `${HEADER}${shape}\n`);
		const p = store.promoteSession(s, { piVersion: PI });

		assert.equal(p.promoted, true, `${shape}: a planted temp must not wedge the key`);
		assert.equal(readFileSync(join(sessionsDir, key, SESSION_FILE_NAME), "utf8").includes(shape), true, `${shape}: the transcript lands`);
		assert.equal(readFileSync(join(sessionsDir, key, "venue"), "utf8"), "local", `${shape}: and the stamp is real, not the sentinel`);
		if (shape === "a dangling link") assert.equal(existsSync(victim), false, `${shape}: nothing may be created at the link's target`);
		if (shape === "a link to an existing file") assert.equal(readFileSync(victim, "utf8"), "PRECIOUS", `${shape}: the target is untouched`);
	}
});

test("two WORKER PROCESSES that share a pid still do not share a temp name (#336)", async () => {
	// The pid is not a writer identity: two containers where node is pid 1, or two hosts on one shared
	// PI_SESSIONS_DIR (the OQ-031 shape the takeover's own skew analysis invokes) share it. Measured as
	// byte-identical temp names before the random half existed, and a shared destination does tear.
	//
	// A SECOND MODULE INSTANCE is what makes this the real case rather than a weaker one. `tmpSeq` is module
	// state, so two stores built in ONE process already differ by the counter and would pass against a
	// constant random half -- which is exactly the mutant that survived the first version of this test. A
	// cache-busting import gives a genuinely fresh module registry entry, counter back at zero, which is what
	// a second worker process is.
	const second = await import(`../src/session-store.mjs?worker=2`);
	const seen = [];
	const capture = () => ({
		...realFs,
		copyFileSync: (from, to, ...rest) => {
			if (String(to).includes(".incoming")) seen.push(String(to));
			return realFs.copyFileSync(from, to, ...rest);
		},
	});
	const key = sessionKeyFor(ghIssue);
	const a = fixture({ fs: capture() });
	seed(a.sessionsDir, key, { venue: "local" });
	const opts = { sessionsDir: a.sessionsDir, ttlDays: 14, maxBytes: 1_000_000, defaultBackend: "local", now: () => NOW, log: () => {} };
	const b = second.makeSessionStore({ ...opts, fs: capture() });

	for (const store of [a.store, b]) {
		const s = store.resolveSession(ghIssue, { jobDir: a.jobDir, piVersion: PI });
		writeFileSync(join(s.hostDir, SESSION_FILE_NAME), `${HEADER}x\n`);
		assert.equal(store.promoteSession(s, { piVersion: PI }).promoted, true);
	}

	assert.equal(seen.length, 2);
	// The RANDOM segment is the assertion, not the whole name: the counter happens to differ here only
	// because earlier tests in this file advanced the first instance's, and two genuinely fresh processes
	// would both be at zero. So compare the half that has to carry the separation.
	const rand = (p) => p.split(".").at(-2);
	assert.notEqual(rand(seen[0]), rand(seen[1]), "the random half must differ, since the pid and counter can both collide across processes");
	assert.notEqual(seen[0], seen[1], "two writers sharing a pid AND a counter must still not share a destination");
	for (const p of seen) assert.match(p, /\.\d+\.\d+\.[0-9a-f]{12}\.incoming$/, "the name carries the pid, a counter and random bytes");
	// WHAT IS NOT PINNED: that the pid is the PID. Replacing it with a constant still separates two writers,
	// because the random half does that, so such a change passes here. It stays in the name to make a
	// straggler attributable to the process that left it, which is a debugging property and not a safety one.
});

test("the transcript's in-flight copy is named PER WRITER, so two promotions never share one tmp (#336)", () => {
	// WHAT THIS PINS, and no more: the NAME, for two promotions inside ONE process. Two writers that do not
	// share a process are the case that matters and they are pinned separately above, because a pid is not a
	// writer identity.
	//
	// WHAT IT CANNOT PIN: the interleaving the per-writer name protects against. `copyFileSync` is
	// synchronous, so two writers inside ONE process can never be mid-copy at the same time -- a seam that
	// fires before or after a copy is not a seam in the middle of one. The hazard is two PROCESSES sharing a
	// store, which this suite cannot create, and it is reachable at all only because the stale-lock takeover
	// concedes a second writer. So the name is what is testable here, and the corruption it prevents is
	// argued in the source rather than demonstrated.
	const seen = [];
	const { store, jobDir, sessionsDir } = fixture({
		fs: {
			...realFs,
			copyFileSync: (from, to) => {
				if (String(to).includes(".incoming")) seen.push(String(to));
				return realFs.copyFileSync(from, to);
			},
		},
	});
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key, { venue: "local" });

	for (const body of ["one", "two"]) {
		const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
		writeFileSync(join(s.hostDir, SESSION_FILE_NAME), `${HEADER}${body}\n`);
		assert.equal(store.promoteSession(s, { piVersion: PI }).promoted, true);
	}

	assert.equal(seen.length, 2, "both promotions copied through a tmp");
	assert.notEqual(seen[0], seen[1], "and the two tmp paths differ, so neither can unlink or overwrite the other's");
	for (const p of seen) assert.match(p, /\.\d+\.\d+\.[0-9a-f]{12}\.incoming$/, "the name carries the pid, a counter and random bytes");
	assert.equal(readFileSync(join(sessionsDir, key, SESSION_FILE_NAME), "utf8").includes("two"), true, "and the last promotion is what landed");
});

test("a SAME-venue promotion that lands between the gate and the open cold-starts rather than resuming unjudged (#336)", () => {
	// The race the venue stamp cannot see: the promoting job shares this venue, so the stamp matches before and
	// after and only the transcript moved. Before the identity re-check this job resumed a transcript no gate
	// had judged -- it could be past its TTL, past the age bound, chain-exhausted, or written by another pi.
	//
	// A TABLE over two replacements, so this pins WHICH fields are compared and not merely that something is:
	// dropping `dev:ino` from the identity fails the first and dropping `size:mtime` fails the second. The
	// renamed case is the load-bearing one, because it is what a real promotion does, and only `dev:ino`
	// differs there.
	const key = sessionKeyFor(ghIssue);
	// A whole second, and inside the fixture clock's TTL window so the age gate stays out of this.
	const STEADY = new Date(NOW - 1000);
	const cases = {
		// The mtime is normalised to a whole second on BOTH sides, before the gate reads it and after the
		// replacement, because a filesystem mtime carries sub-millisecond precision that `utimesSync` cannot
		// round-trip: restoring it from the stat's own Date left `mtimeMs` slightly different, and the case
		// then isolated nothing. A mutation dropping `dev:ino` from the identity SURVIVED against the first
		// version of this fixture, which is how that was found.
		"renamed over, byte-identical and same mtime": (canonical, root) => {
			const before = realFs.statSync(canonical);
			const sibling = join(root, "sibling.jsonl");
			realFs.writeFileSync(sibling, realFs.readFileSync(canonical));
			realFs.renameSync(sibling, canonical);
			realFs.utimesSync(canonical, STEADY, STEADY);
			const after = realFs.statSync(canonical);
			assert.equal(after.size, before.size, "the fixture must keep the size, or it is not isolating the inode");
			assert.equal(after.mtimeMs, before.mtimeMs, "and the mtime, or it is not isolating the inode");
		},
		"rewritten in place, different bytes": (canonical) => realFs.writeFileSync(canonical, `${HEADER}{"type":"message"}\n`),
		// The two cases above move `ino` alone and `size`+`mtime` together, so neither isolates `size` or
		// `mtimeMs`. Dropping either from the identity left the suite green, which is a finding about this
		// table rather than about the code. These two separate them.
		//
		// WHAT IS NOT PINNED, and cannot be from here: `dev`. Isolating it needs the canonical file to move to
		// another DEVICE between the gate and the open, which no test on one filesystem can arrange, so
		// dropping `dev` from the identity passes. It stays in because an inode number is unique per device and
		// a store spanning a mount point is otherwise two keys that can compare equal.
		"same inode and mtime, different SIZE": (canonical) => {
			const before = realFs.statSync(canonical);
			realFs.writeFileSync(canonical, `${HEADER}{"type":"message"}\n`);
			realFs.utimesSync(canonical, STEADY, STEADY);
			assert.notEqual(realFs.statSync(canonical).size, before.size, "the fixture must change the size");
			assert.equal(realFs.statSync(canonical).mtimeMs, before.mtimeMs, "and hold the mtime");
		},
		"same inode and SIZE, different mtime": (canonical) => {
			const before = realFs.statSync(canonical);
			const body = realFs.readFileSync(canonical, "utf8");
			// Same length, different bytes: only the mtime moves.
			realFs.writeFileSync(canonical, body.slice(0, -2) + "X\n");
			const later = new Date(NOW + 5000);
			realFs.utimesSync(canonical, later, later);
			assert.equal(realFs.statSync(canonical).size, before.size, "the fixture must hold the size");
			assert.notEqual(realFs.statSync(canonical).mtimeMs, before.mtimeMs, "and move the mtime");
		},
	};

	for (const [name, replace] of Object.entries(cases)) {
		let ref;
		const { store, jobDir, sessionsDir, root } = fixture({
			fs: {
				...realFs,
				// The seam is the OPEN, not the copy (issue #375): the store takes one descriptor on the
				// canonical transcript and reads the staged bytes off it, so a promotion that lands after that
				// open is one this job simply does not see. Landing it here is landing it between the gate and
				// the open, which is the window that remains.
				openSync: (path, flags, ...rest) => {
					if (flags === "r" && String(path).startsWith(ref) && String(path).endsWith(SESSION_FILE_NAME)) replace(String(path), root);
					return realFs.openSync(path, flags, ...rest);
				},
			},
		});
		ref = sessionsDir;
		seed(sessionsDir, key, { venue: "local" });
		realFs.utimesSync(join(sessionsDir, key, SESSION_FILE_NAME), STEADY, STEADY);

		const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
		assert.equal(s.reason, "transcript-replaced", name);
		assert.equal(s.resume, false, `${name}: an unjudged transcript is never resumed`);
		assert.equal(s.bytes, null, `${name}: a cold start reports no bytes`);
		assert.equal(statSync(join(s.hostDir, SESSION_FILE_NAME)).size, 0, `${name}: the container is handed nothing of it`);
	}
});

test("the transcript identity never rides the session object (#336)", () => {
	// `resolveSession`'s return is spread onto the session the processor holds for the whole run, and the
	// contract says the identity is deliberately split off it so a promotion an hour later cannot read it.
	// Carrying it was a mutation the suite accepted.
	const { store, jobDir, sessionsDir } = fixture();
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key, { venue: "local" });
	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	assert.equal(s.reason, "resumed");
	assert.deepEqual(Object.keys(s).sort(), ["bytes", "hostDir", "key", "modelId", "reason", "resume", "venue"], "no inode number leaves this function");
});

test("an untouched transcript still RESUMES: the re-check must not fire on the quiet path (#336)", () => {
	// The false-positive guard, and the most important test in this set. A re-check that fired spuriously would
	// turn every resume into a silent cold start -- the feature never resuming again, with nothing in the log
	// that looks wrong. Two consecutive deliveries, both of which must resume.
	const { store, jobDir, sessionsDir } = fixture();
	const key = sessionKeyFor(ghIssue);
	seed(sessionsDir, key, { venue: "local" });

	const first = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	assert.equal(first.reason, "resumed", "nothing touched the transcript, so it resumes");
	writeFileSync(join(first.hostDir, SESSION_FILE_NAME), `${HEADER}{"type":"message"}\n`);
	assert.equal(store.promoteSession(first, { piVersion: PI }).promoted, true);

	const second = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	assert.equal(second.reason, "resumed", "and a promotion this job's OWN run completed is not a race either");
});

test("a promotion from another venue that COMPLETES between the gate and the open is caught too", () => {
	// The stamp then names the other venue outright rather than the sentinel. A re-check that only looked for
	// the sentinel would resume that venue's transcript.
	const key = sessionKeyFor(ghIssue);
	let sessionsDirRef;
	const { store, jobDir, sessionsDir } = fixture({
		fs: {
			...realFs,
			// The seam is the OPEN, not the copy (issue #375): the staged bytes are read off one descriptor
			// taken here, so this is the window between the gate and that open.
			openSync: (path, flags, ...rest) => {
				if (flags === "r" && String(path).startsWith(sessionsDirRef) && String(path).endsWith(SESSION_FILE_NAME)) {
					realFs.writeFileSync(path, `${HEADER}far-transcript\n`);
					realFs.writeFileSync(join(sessionsDirRef, key, "venue"), "far");
				}
				return realFs.openSync(path, flags, ...rest);
			},
		},
	});
	sessionsDirRef = sessionsDir;
	seed(sessionsDir, key, { venue: "local" });
	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	assert.equal(s.reason, "venue-changed");
	assert.equal(s.resume, false);
	assert.equal(statSync(join(s.hostDir, SESSION_FILE_NAME)).size, 0);
});

test("a fault while emptying a re-checked copy leaves nothing of it under the job dir", () => {
	// The job dir is mounted /job:ro. A `null` resolve means no /session mount, but a transcript left at
	// jobDir/session/current.jsonl would still be readable there.
	const key = sessionKeyFor(ghIssue);
	let sessionsDirRef;
	const { store, jobDir, sessionsDir } = fixture({
		fs: {
			...realFs,
			// The seam is the OPEN, not the copy (issue #375): the staged bytes are read off one descriptor
			// taken here, so this is the window between the gate and that open.
			openSync: (path, flags, ...rest) => {
				if (flags === "r" && String(path).startsWith(sessionsDirRef) && String(path).endsWith(SESSION_FILE_NAME)) {
					realFs.writeFileSync(path, `${HEADER}far-transcript\n`);
					realFs.writeFileSync(join(sessionsDirRef, key, "venue"), "far");
				}
				return realFs.openSync(path, flags, ...rest);
			},
			writeFileSync: (p, data, ...rest) => {
				if (String(p).includes(join("session", SESSION_FILE_NAME)) && data === "") throw new Error("EIO: i/o error");
				return realFs.writeFileSync(p, data, ...rest);
			},
		},
	});
	sessionsDirRef = sessionsDir;
	seed(sessionsDir, key, { venue: "local" });
	assert.equal(store.resolveSession(ghIssue, { jobDir, piVersion: PI }), null);
	assert.equal(existsSync(join(jobDir, "session", SESSION_FILE_NAME)), false, "the far transcript is not left behind");
});

test("the reaper's fallback keys on the directory's MTIME, not its birthtime or atime (#336)", () => {
	// Both alternatives were mutations the suite accepted, and both are wrong in the same direction: a
	// directory's birthtime never moves, so a key in active use would never age out of it, and an atime moves
	// on a READ, so merely listing the store would keep a dead key alive (and `noatime` would stop it moving
	// at all). Only the mtime tracks entries being created and removed inside the directory, which is what
	// "this key is still in use" means here.
	//
	// The three stamps are INJECTED rather than set with `utimes`, and that is not fastidiousness: on APFS,
	// moving a directory's mtime backwards drags its BIRTHTIME back with it (measured), so on this platform a
	// real directory cannot hold an old mtime and a fresh birthtime at once, and a test built on one lets the
	// birthtime mutant through. A synthetic stat is the only way to separate the three fields here.
	const later = Date.now() + 3 * 86400000;
	const key = sessionKeyFor(ghIssue);
	const { store, sessionsDir } = fixture({
		ttlDays: 1,
		now: () => later,
		fs: {
			...realFs,
			lstatSync: (p, ...rest) => {
				const st = realFs.lstatSync(p, ...rest);
				if (String(p).endsWith(key)) {
					// Aged mtime; birthtime and atime both FRESH, which only the mtime rule sweeps.
					return { isDirectory: () => true, mtimeMs: later - 90 * 86400000, birthtimeMs: later, atimeMs: later };
				}
				return st;
			},
		},
	});
	const dir = join(sessionsDir, key);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "lock"), "");

	store.reapSessions();
	assert.equal(existsSync(dir), false, "an old mtime is what makes a transcript-less key dead, whatever its birthtime or atime say");
});

test("a FRESH transcript in an ancient directory survives the reaper (#336)", () => {
	// The guard on the fallback, and the mutation that matters most: making the directory-mtime rule
	// unconditional instead of ENOENT-only would sweep an actively used key whose directory nobody has written
	// to lately, which is an operator's conversations deleted. Only the transcript's own mtime can say a key is
	// alive, so the fallback may never outrank it.
	const later = Date.now() + 3 * 86400000;
	const { store, sessionsDir } = fixture({ ttlDays: 1, now: () => later });
	const key = sessionKeyFor(ghIssue);
	const file = seed(sessionsDir, key, { venue: "local" });
	utimesSync(file, later / 1000, later / 1000);
	const ancient = (later - 90 * 86400000) / 1000;
	utimesSync(join(sessionsDir, key), ancient, ancient);

	store.reapSessions();
	assert.equal(existsSync(file), true, "a key with a fresh transcript is alive, whatever its directory's mtime says");
});

test("a disk fault on the transcript is not evidence that a key is old (#336)", () => {
	// ENOENT-only, again from the other side. An EIO means the reaper could not ASK, and a reaper that treats
	// "could not ask" as "old" deletes on a transient fault.
	const later = Date.now() + 3 * 86400000;
	const key = sessionKeyFor(ghIssue);
	const { store, sessionsDir, logs } = fixture({
		ttlDays: 1,
		now: () => later,
		fs: {
			...realFs,
			lstatSync: (p, ...rest) => {
				if (String(p).endsWith(join(key, SESSION_FILE_NAME))) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
				return realFs.lstatSync(p, ...rest);
			},
		},
	});
	seed(sessionsDir, key, { venue: "local" });

	store.reapSessions();
	assert.equal(existsSync(join(sessionsDir, key)), true, "a key the reaper could not read is kept");
	assert.ok(logs.some(([event, f]) => event === "session_reaper_skipped" && f.key === key), "and the fault is said");
});

test("the reaper removes neither a stray file nor an aged link out of the store (#336, #375)", () => {
	// The outcome is the same as when this test was written for #336; the mechanism under it moved. Then, a
	// stray file gave ENOTDIR on the inner lstat and a symlink gave ENOENT and reached a fallback guard. Since
	// issue #375 the reaper lstats the ENTRY first, so neither reaches that fallback at all: both are named as
	// `session_not_reaped` and left, which the #375 reaper test pins. What this test keeps is the OUTCOME, and
	// the measurement behind it, because the obvious reading is wrong twice over: `rmSync` with `recursive`
	// and `force` does NOT follow a link, so on a DANGLING one it silently does nothing (a test using one
	// passed even with the old guard removed, which is how that was found) and on a link to a real directory
	// it removes the LINK and leaves the target alone. The target was never at risk; what is at stake is the
	// reaper unlinking an operator's own symlink out of the store.
	const later = Date.now() + 3 * 86400000;
	const { store, sessionsDir, root } = fixture({ ttlDays: 1, now: () => later });
	mkdirSync(sessionsDir, { recursive: true });
	const stray = join(sessionsDir, "stray");
	writeFileSync(stray, "not a key");

	const target = join(root, "elsewhere");
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "precious.txt"), "not ours to remove");
	const linked = join(sessionsDir, "linked");
	symlinkSync(target, linked);
	const aged = (later - 90 * 86400000) / 1000;
	realFs.lutimesSync(linked, aged, aged);

	store.reapSessions();
	assert.equal(existsSync(stray), true, "a stray file is left alone");
	assert.equal(realFs.lstatSync(linked).isSymbolicLink(), true, "and an aged symlink is not a key, so it is not swept");
	assert.equal(existsSync(join(target, "precious.txt")), true, "and nothing behind it is touched");
});

test("the reaper removes an expired key, keeps a fresh one, and SWEEPS a key with no transcript (#336)", () => {
	// The disk sweep keys on the TRANSCRIPT's mtime, and falls back to the key DIRECTORY's own mtime when there
	// is no transcript to key on -- a first promotion that died before the swap. That key used to be skipped on
	// every pass forever, so anything leaked in it outlived the store.
	const later = Date.now() + 3 * 86400000;
	const { store, sessionsDir, logs } = fixture({ ttlDays: 1, now: () => later });
	const expired = sessionKeyFor(ghIssue);
	const fresh = sessionKeyFor({ ...ghIssue, target: { type: "issue", number: 8 } });
	const empty = sessionKeyFor({ ...ghIssue, target: { type: "issue", number: 9 } });
	seed(sessionsDir, expired, { venue: "local" });
	const freshFile = seed(sessionsDir, fresh, { venue: "local" });
	utimesSync(freshFile, later / 1000, later / 1000);
	mkdirSync(join(sessionsDir, empty), { recursive: true });
	writeFileSync(join(sessionsDir, empty, "lock"), "");

	store.reapSessions();
	assert.equal(existsSync(join(sessionsDir, expired)), false, "an expired transcript's key is swept whole, stamp and all");
	assert.equal(existsSync(join(sessionsDir, fresh, SESSION_FILE_NAME)), true, "a fresh one is kept");
	assert.equal(existsSync(join(sessionsDir, empty)), false, "a key with no transcript is swept on the directory's own mtime");
	assert.ok(logs.some(([event, fields]) => event === "reaped_session" && fields.key === expired));

	// Retention 0 is "keep forever": the sweep does nothing at all, and it is NOT relaxed for the case above.
	// That is deliberate and it is why the stale-lock takeover is the primary recovery: `0` is an explicit
	// operator instruction, and a reaper that removed something under it would be a surprise, so what makes a
	// wedged key recoverable there is the takeover rather than this.
	const keep = fixture({ ttlDays: 0, now: () => later });
	seed(keep.sessionsDir, expired);
	keep.store.reapSessions();
	assert.equal(existsSync(join(keep.sessionsDir, expired, SESSION_FILE_NAME)), true);
});

// --------------------------------------------------------------------------------------------------
// Issue #375: the key DIRECTORY itself. Every guarantee above is an lstat on a name INSIDE that
// directory, and a key directory that is a symlink defeats all of them at once, because the link IS the
// directory. Measured against the real store before the fix: a link planted at the derived path made
// resolve return `resumed` from a transcript outside the store, and promote write `current.jsonl`,
// `pi-version`, `venue` and `resume-chain` through it into that outside directory.
// --------------------------------------------------------------------------------------------------

/** The shapes a key's own name can carry that are not a real directory, and how to plant each. */
const NOT_A_DIRECTORY = {
	"a link to a directory holding a transcript": (at, root) => {
		const outside = join(root, "outside-seeded");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, SESSION_FILE_NAME), HEADER);
		writeFileSync(join(outside, "pi-version"), PI);
		writeFileSync(join(outside, "venue"), "local");
		symlinkSync(outside, at);
		return outside;
	},
	"a link to a directory holding something else": (at, root) => {
		const outside = join(root, "outside-precious");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "PRECIOUS"), "keep me\n");
		symlinkSync(outside, at);
		return outside;
	},
	"a dangling link": (at, root) => {
		const outside = join(root, "outside-absent");
		symlinkSync(outside, at);
		return outside;
	},
	"a link to a regular file": (at, root) => {
		const outside = join(root, "outside-file");
		writeFileSync(outside, "not a key\n");
		symlinkSync(outside, at);
		return outside;
	},
	"a regular file": (at) => {
		writeFileSync(at, "not a key\n");
		return null;
	},
};

test("a key directory that is NOT A DIRECTORY is refused on the READ edge, and its target is never read (#375)", () => {
	for (const [name, plant] of Object.entries(NOT_A_DIRECTORY)) {
		const { store, jobDir, sessionsDir, root, logs } = fixture();
		const key = sessionKeyFor(ghIssue);
		plant(join(sessionsDir, key), root);

		const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
		assert.equal(s.resume, false, `${name} must never resume`);
		assert.equal(s.reason, "key-not-a-directory", `${name} names what it is, not what a file inside it would have been`);
		assert.equal(readFileSync(join(s.hostDir, SESSION_FILE_NAME), "utf8"), "", `${name}: the container is handed the 0-byte cold start`);
		assert.ok(
			logs.some(([event, fields]) => event === "session_resolved" && fields.reason === "key-not-a-directory"),
			`${name}: the refusal rides the line an operator already greps, with no new event name`,
		);
	}
});

test("a key directory that is NOT A DIRECTORY is refused on the WRITE edge, and nothing is written through it (#375)", () => {
	for (const [name, plant] of Object.entries(NOT_A_DIRECTORY)) {
		const { store, jobDir, sessionsDir, root, logs } = fixture();
		const key = sessionKeyFor(ghIssue);
		const at = join(sessionsDir, key);
		const outside = plant(at, root);
		const before = outside !== null && existsSync(outside) && realFs.lstatSync(outside).isDirectory() ? readdirSync(outside).sort().join(",") : null;

		const hostDir = join(jobDir, "session");
		mkdirSync(hostDir, { recursive: true });
		writeFileSync(join(hostDir, SESSION_FILE_NAME), `${HEADER}${JSON.stringify({ type: "message", role: "user" })}\n`);
		const p = store.promoteSession({ key, hostDir, modelId: "m", venue: "local" }, { piVersion: PI });

		assert.equal(p.promoted, false, `${name} must never promote`);
		assert.equal(p.reason, "key-not-a-directory", `${name}: the refusal names the directory, not the transcript`);
		assert.ok(
			logs.some(([event, fields]) => event === "session_promote_skipped" && fields.reason === "key-not-a-directory"),
			`${name}: and it is said, on the line the other promote refusals use`,
		);
		// The entry is LEFT: it is not this store's to remove, and a refusal an operator can read beats a
		// sweep that deletes whatever is standing at a precomputable path.
		assert.equal(realFs.lstatSync(at).isDirectory(), false, `${name}: the planted entry is left exactly as it was`);
		if (outside !== null && before !== null) {
			assert.equal(readdirSync(outside).sort().join(","), before, `${name}: the target directory gains nothing -- no transcript, no stamp, no lock, no temp`);
		}
		if (name === "a dangling link") assert.equal(existsSync(outside), false, "a dangling link's target is never created");
	}
});

test("a link planted between the lstat and the mkdir is still caught: the second lstat is why (#375)", () => {
	// `mkdirSync(dir, { recursive: true })` SUCCEEDS on an existing link to a directory, so a promotion that
	// asked only "did mkdir work" would accept exactly the shape the read edge refuses. This arms an injected
	// `mkdirSync` that plants the link the instant the store reaches for the key directory.
	const { store, jobDir, sessionsDir, root, logs } = (() => {
		let armed = false;
		let made;
		const outside = () => join(made.root, "outside-raced");
		made = fixture({
			fs: {
				...realFs,
				mkdirSync: (p, ...rest) => {
					const path = String(p);
					if (!armed && path.startsWith(join(made.sessionsDir, sessionKeyFor(ghIssue)))) {
						armed = true;
						mkdirSync(outside(), { recursive: true });
						writeFileSync(join(outside(), "PRECIOUS"), "keep me\n");
						symlinkSync(outside(), path);
						return undefined; // the real mkdir would have succeeded on the link, silently
					}
					return realFs.mkdirSync(p, ...rest);
				},
			},
		});
		return made;
	})();

	const hostDir = join(jobDir, "session");
	mkdirSync(hostDir, { recursive: true });
	writeFileSync(join(hostDir, SESSION_FILE_NAME), `${HEADER}${JSON.stringify({ type: "message", role: "user" })}\n`);
	const p = store.promoteSession({ key: sessionKeyFor(ghIssue), hostDir, modelId: "m", venue: "local" }, { piVersion: PI });

	assert.equal(p.promoted, false, "a link that appears during the create is refused like one that was already there");
	assert.equal(p.reason, "key-not-a-directory");
	assert.deepEqual(readdirSync(join(root, "outside-raced")), ["PRECIOUS"], "and the target gains nothing");
	assert.ok(logs.some(([event, fields]) => event === "session_promote_skipped" && fields.reason === "key-not-a-directory"));
});

test("a link swapped in between the gates and the OPEN is caught, and stages nothing of its target (#375)", () => {
	// The gates and the open are not under the promotion lock, so the key directory can be replaced between
	// them. The injected `openSync` swaps the real key directory for a link the instant the store reaches for
	// the transcript, which is the window that remains once the bytes come off one descriptor.
	const key = sessionKeyFor(ghIssue);
	let made;
	made = fixture({
		fs: {
			...realFs,
			openSync: (path, flags, ...rest) => {
				if (flags === "r" && String(path).startsWith(made.sessionsDir) && String(path).endsWith(SESSION_FILE_NAME)) {
					const at = join(made.sessionsDir, key);
					const attacker = join(made.root, "attacker");
					mkdirSync(attacker, { recursive: true });
					writeFileSync(join(attacker, SESSION_FILE_NAME), `${HEADER}${JSON.stringify({ type: "message", role: "user", content: "ATTACKER" })}\n`);
					writeFileSync(join(attacker, "pi-version"), PI);
					writeFileSync(join(attacker, "venue"), "local");
					realFs.rmSync(at, { recursive: true, force: true });
					symlinkSync(attacker, at);
				}
				return realFs.openSync(path, flags, ...rest);
			},
		},
	});
	seed(made.sessionsDir, key, { venue: "local" });

	const s = made.store.resolveSession(ghIssue, { jobDir: made.jobDir, piVersion: PI });
	assert.equal(s.resume, false, "a key directory replaced before the open must not resume");
	assert.equal(s.reason, "key-not-a-directory", "and the miss names the directory, which is what moved");
	assert.equal(readFileSync(join(s.hostDir, SESSION_FILE_NAME), "utf8"), "", "nothing of the attacker's transcript reaches the container");
});

test("a link swapped in with a DIFFERENT venue is still the directory's miss, not a venue move (#375)", () => {
	// What pins the ladder's ORDER. With the directory arm below the venue arm, a planted symlink whose target
	// happens to stamp another venue reports `venue-changed`, which sends an operator to the venue docs
	// instead of to the symlink standing in their store.
	const key = sessionKeyFor(ghIssue);
	let made;
	made = fixture({
		fs: {
			...realFs,
			openSync: (path, flags, ...rest) => {
				if (flags === "r" && String(path).startsWith(made.sessionsDir) && String(path).endsWith(SESSION_FILE_NAME)) {
					const at = join(made.sessionsDir, key);
					const attacker = join(made.root, "attacker-far");
					mkdirSync(attacker, { recursive: true });
					writeFileSync(join(attacker, SESSION_FILE_NAME), HEADER);
					writeFileSync(join(attacker, "pi-version"), PI);
					writeFileSync(join(attacker, "venue"), "far");
					realFs.rmSync(at, { recursive: true, force: true });
					symlinkSync(attacker, at);
				}
				return realFs.openSync(path, flags, ...rest);
			},
		},
	});
	seed(made.sessionsDir, key, { venue: "local" });

	const s = made.store.resolveSession(ghIssue, { jobDir: made.jobDir, piVersion: PI });
	assert.equal(s.reason, "key-not-a-directory", "the directory arm runs ahead of the venue arm, and a name that is not a directory is neither a venue move nor a swap");
});

test("a swap AFTER the open cannot change what is staged: the bytes come off the judged descriptor (#375)", () => {
	// The attack the gate round found, and the reason the copy runs off a descriptor at all. Every arm of the
	// old re-check read BY PATH after a path-based copy, so an attacker who was a symlink DURING the copy and
	// the original directory again before the re-check matched all three arms while the bytes came from
	// somewhere else: measured at 195 of 757 successful resumes against a plain second process. Here the swap
	// lands after the open and is then restored, which is exactly that A, B, A -- and it now buys nothing,
	// because a descriptor is bound to its inode and cannot be re-pointed by a later rename.
	const key = sessionKeyFor(ghIssue);
	let made;
	let swapped = false;
	made = fixture({
		fs: {
			...realFs,
			readSync: (fd, ...rest) => {
				if (!swapped) {
					swapped = true;
					const at = join(made.sessionsDir, key);
					const attacker = join(made.root, "attacker");
					mkdirSync(attacker, { recursive: true });
					writeFileSync(join(attacker, SESSION_FILE_NAME), `${HEADER}${JSON.stringify({ type: "message", role: "user", content: "ATTACKER" })}\n`);
					writeFileSync(join(attacker, "pi-version"), PI);
					writeFileSync(join(attacker, "venue"), "local");
					const stash = join(made.root, "stash");
					renameSync(at, stash);
					symlinkSync(attacker, at);
					realFs.unlinkSync(at); // and back again, so every by-path re-check would see the original
					renameSync(stash, at);
				}
				return realFs.readSync(fd, ...rest);
			},
		},
	});
	seed(made.sessionsDir, key, { venue: "local" });

	const s = made.store.resolveSession(ghIssue, { jobDir: made.jobDir, piVersion: PI });
	assert.equal(s.resume, true, "the judged transcript is still the one this job reads, so it resumes");
	const staged = readFileSync(join(s.hostDir, SESSION_FILE_NAME), "utf8");
	assert.equal(staged.includes("ATTACKER"), false, "and no byte of the attacker's transcript reaches the container");
	assert.equal(staged, HEADER, "what is staged is exactly the transcript the gates judged");
});

test("an ordinary write inside the key directory does NOT disturb a resume (#375)", () => {
	// The quiet path, pinned because the first draft of this change broke it: the post-copy re-check compared
	// the key directory with the FILE identity rule, `dev:ino:size:mtime`, and a directory's size and mtime
	// move on every entry created inside it (64 -> 96 -> 1376 bytes on APFS, measured), so an ordinary
	// concurrent promotion reported a race on every run. The directory identity is gone entirely now -- the
	// staged bytes come off one descriptor -- and this is what keeps that regression from coming back.
	const key = sessionKeyFor(ghIssue);
	let made;
	made = fixture({
		fs: {
			...realFs,
			copyFileSync: (src, dest, ...rest) => {
				const out = realFs.copyFileSync(src, dest, ...rest);
				if (String(src).endsWith(SESSION_FILE_NAME) && !String(src).includes("job-")) {
					writeFileSync(join(made.sessionsDir, key, "lock"), ""); // an entry created, so the mtime moves
				}
				return out;
			},
		},
	});
	seed(made.sessionsDir, key, { venue: "local" });

	const s = made.store.resolveSession(ghIssue, { jobDir: made.jobDir, piVersion: PI });
	assert.equal(s.resume, true, "the key directory is the same one, so this resumes");
	assert.equal(s.reason, "resumed");
});

test("the STORE itself may be a symlink: only the key's own name is checked (#375)", () => {
	// macOS's own temp root is `/var -> private/var`, and moving the whole store behind a link is a supported
	// layout. A realpath or an ancestor walk would refuse both, and every fixture on this platform with them.
	const { store, jobDir, root } = (() => {
		const made = fixture();
		const real = join(made.root, "real-store");
		renameSync(made.sessionsDir, real);
		symlinkSync(real, made.sessionsDir);
		return made;
	})();
	const key = sessionKeyFor(ghIssue);
	seed(join(root, "real-store", ".."), key, { venue: "local" }); // seeded through the link's own parent
	renameSync(join(root, key), join(root, "real-store", key));

	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	assert.equal(s.resume, true, "a linked STORE is a layout, not an attack: the check is the final component only");

	const p = store.promoteSession(s, { piVersion: PI });
	assert.equal(p.promoted, true, "and a promotion lands through it too");
});

test("the reaper judges NOTHING through a link, and says so as a verdict rather than a fault (#375)", () => {
	const later = NOW + 40 * 86400000;
	const aged = (NOW - 30 * 86400000) / 1000;
	const { store, sessionsDir, root, logs } = fixture({ ttlDays: 14, now: () => later });

	// A link whose TARGET holds an aged transcript. Before this, the reaper resolved through the link, judged
	// the target's transcript, and removed the link once it aged: a decision taken on a file outside the store.
	const linked = sessionKeyFor(ghIssue);
	const outside = join(root, "outside-aged");
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, SESSION_FILE_NAME), HEADER);
	realFs.lutimesSync(join(outside, SESSION_FILE_NAME), aged, aged);
	symlinkSync(outside, join(sessionsDir, linked));
	// And a stray file, which reached the same skip through an ENOTDIR fault before.
	writeFileSync(join(sessionsDir, "stray"), "not a key\n");

	store.reapSessions();

	assert.equal(existsSync(join(sessionsDir, linked)), true, "the link is left where it stands");
	assert.equal(existsSync(join(outside, SESSION_FILE_NAME)), true, "and its target is untouched");
	assert.equal(existsSync(join(sessionsDir, "stray")), true, "so is a stray file");
	const verdicts = logs.filter(([event]) => event === "session_not_reaped").map(([, f]) => `${f.key}:${f.reason}`).sort();
	assert.deepEqual(verdicts, ["stray:key-not-a-directory", `${linked}:key-not-a-directory`].sort(), "both are named, once each");
	assert.equal(
		logs.some(([event]) => event === "session_reaper_skipped"),
		false,
		"and neither wears the FAULT name: `*_reaper_skipped` means a pass could not establish something, which is not what this is (OQ-007)",
	);
});

test("a link swapped in UNDER the lock is refused before anything is written through it (#375)", () => {
	// `ensureKeyDir` runs before `takeLock`, so the segment between them is a window: measured on the first
	// draft of this change, a swap there put the transcript and all four sidecars in the attacker's directory
	// and still reported `promoted: true`. The lock's own `openSync` is the first call after the check, so
	// this fires exactly in that window.
	const key = sessionKeyFor(ghIssue);
	let made;
	let armed = false;
	made = fixture({
		fs: {
			...realFs,
			openSync: (path, flags, ...rest) => {
				if (!armed && flags === "wx" && String(path).endsWith("lock")) {
					armed = true;
					const at = join(made.sessionsDir, key);
					const attacker = join(made.root, "attacker-lock");
					mkdirSync(attacker, { recursive: true });
					realFs.rmSync(at, { recursive: true, force: true });
					symlinkSync(attacker, at);
				}
				return realFs.openSync(path, flags, ...rest);
			},
		},
	});
	const hostDir = join(made.jobDir, "session");
	mkdirSync(hostDir, { recursive: true });
	writeFileSync(join(hostDir, SESSION_FILE_NAME), `${HEADER}${JSON.stringify({ type: "message", role: "user" })}\n`);

	const p = made.store.promoteSession({ key, hostDir, modelId: "m", venue: "local" }, { piVersion: PI });
	assert.equal(p.promoted, false, "a key directory replaced between the check and the lock must not be promoted into");
	assert.equal(p.reason, "key-not-a-directory");
	assert.deepEqual(readdirSync(join(made.root, "attacker-lock")), [], "and the target gains nothing at all: no transcript, no stamp, no temp");
});

test("a swap the write path cannot prevent is at least not CLAIMED as promoted (#375)", () => {
	// Prevention stops at the last check: Node exposes no `renameat`, so every write after it resolves the
	// name again and a swap landing there really does put the bytes outside the store. What must not happen is
	// the record saying the work is in the store when it is not, which is what the old code reported. This
	// swaps at the rename, the latest point that still precedes the post-swap check.
	const key = sessionKeyFor(ghIssue);
	let made;
	let armed = false;
	made = fixture({
		fs: {
			...realFs,
			renameSync: (from, to, ...rest) => {
				const out = realFs.renameSync(from, to, ...rest);
				if (!armed && String(to).endsWith(SESSION_FILE_NAME)) {
					armed = true;
					const at = join(made.sessionsDir, key);
					const attacker = join(made.root, "attacker-late");
					mkdirSync(attacker, { recursive: true });
					realFs.rmSync(at, { recursive: true, force: true });
					symlinkSync(attacker, at);
				}
				return out;
			},
		},
	});
	const hostDir = join(made.jobDir, "session");
	mkdirSync(hostDir, { recursive: true });
	writeFileSync(join(hostDir, SESSION_FILE_NAME), `${HEADER}${JSON.stringify({ type: "message", role: "user" })}\n`);

	const p = made.store.promoteSession({ key, hostDir, modelId: "m", venue: "local" }, { piVersion: PI });
	assert.equal(p.promoted, false, "the record must not claim a promotion that landed somewhere else");
	assert.equal(p.reason, "key-not-a-directory");
});

test("a promoted key directory is created 0700, because transcripts are PII-bearing (#375)", () => {
	// The mode moved into `ensureKeyDir` with this change, and nothing pinned it: `doctor.test.mjs` pins 0700
	// for `PI_SESSIONS_DIR` itself, and `SECURITY.md` promises it for the store, but the per-key directory the
	// worker creates on every first promotion had no assertion at all. Dropping the mode here leaves the whole
	// suite green and the transcripts world-readable.
	const { store, jobDir, sessionsDir } = fixture();
	const s = store.resolveSession(ghIssue, { jobDir, piVersion: PI });
	writeFileSync(join(s.hostDir, SESSION_FILE_NAME), HEADER);
	assert.equal(store.promoteSession(s, { piVersion: PI }).promoted, true);
	assert.equal(statSync(join(sessionsDir, sessionKeyFor(ghIssue))).mode & 0o777, 0o700, "the key directory is the worker's alone");
});

test("a link planted after the GATES read, before the open, is caught by the by-path re-check (#375)", () => {
	// The gates run by path, so a link planted after the FIRST of their lstats has every one of them judge the
	// attacker's files -- and then the descriptor agrees, because `judged` is the attacker's identity too. The
	// descriptor alone cannot see this; the by-path re-check after the copy is what does. A round that had
	// only the descriptor staged 2 attacker transcripts in 16,594 resumes against a live flipper.
	const key = sessionKeyFor(ghIssue);
	let made;
	let armed = false;
	made = fixture({
		fs: {
			...realFs,
			lstatSync: (path, ...rest) => {
				const out = realFs.lstatSync(path, ...rest);
				if (!armed && String(path) === join(made.sessionsDir, key)) {
					armed = true;
					const attacker = join(made.root, "attacker-gates");
					mkdirSync(attacker, { recursive: true });
					writeFileSync(join(attacker, SESSION_FILE_NAME), `${HEADER}${JSON.stringify({ type: "message", role: "user", content: "ATTACKER" })}\n`);
					writeFileSync(join(attacker, "pi-version"), PI);
					writeFileSync(join(attacker, "venue"), "local");
					realFs.renameSync(join(made.sessionsDir, key), join(made.root, "stash"));
					symlinkSync(attacker, join(made.sessionsDir, key));
				}
				return out;
			},
		},
	});
	seed(made.sessionsDir, key, { venue: "local" });

	const s = made.store.resolveSession(ghIssue, { jobDir: made.jobDir, piVersion: PI });
	assert.equal(s.resume, false, "a key directory replaced before the gates ran must not resume");
	assert.equal(s.reason, "key-not-a-directory");
	assert.equal(readFileSync(join(s.hostDir, SESSION_FILE_NAME), "utf8"), "", "and nothing of the attacker's transcript is staged");
});

test("the staged bytes are READ FROM THE DESCRIPTOR, not re-fetched by path (#375)", () => {
	// What kills the one mutation the first descriptor round left alive: `copyFromDescriptor(fd, staged)`
	// replaced by `copyFileSync(canonicalFile(key), staged)` passed the whole suite, because the only test
	// that could have seen it drove its swap from `readSync`, which the mutant never calls. This one swaps the
	// TRANSCRIPT's bytes at the staged file's own open, a seam both versions take, and then asserts which
	// bytes arrived. Reading by path stages the new ones; reading the descriptor stages the judged ones.
	const key = sessionKeyFor(ghIssue);
	let made;
	let armed = false;
	made = fixture({
		fs: {
			...realFs,
			openSync: (path, flags, ...rest) => {
				if (!armed && flags === "w" && String(path).includes(join("session", SESSION_FILE_NAME))) {
					armed = true;
					// The canonical NAME now holds a different file: a fresh inode, so a by-path read gets it.
					const swapped = join(made.root, "swapped.jsonl");
					writeFileSync(swapped, `${HEADER}${JSON.stringify({ type: "message", role: "user", content: "BY-PATH" })}\n`);
					renameSync(swapped, join(made.sessionsDir, key, SESSION_FILE_NAME));
				}
				return realFs.openSync(path, flags, ...rest);
			},
		},
	});
	seed(made.sessionsDir, key, { venue: "local" });

	const s = made.store.resolveSession(ghIssue, { jobDir: made.jobDir, piVersion: PI });
	const staged = readFileSync(join(s.hostDir, SESSION_FILE_NAME), "utf8");
	assert.equal(staged.includes("BY-PATH"), false, "a copy that re-resolved the name would have staged the file that replaced it");
	// The by-path re-check then sees the swap and refuses, which is the other half of the pair: the bytes were
	// never the attacker's, and the job is told the transcript moved rather than resuming a stale one.
	assert.equal(s.reason, "transcript-replaced");
	assert.equal(staged, "", "and a refused resume stages the 0-byte cold start");
});

test("a promotion refuses a key directory swapped for ANOTHER REAL directory, on identity not shape (#375)", () => {
	// Shape alone passed this: a swap to a real directory under the lock let the transcript and all four
	// sidecars land in it while the promotion reported `promoted: true`. Both write-edge re-checks compare the
	// directory's `dev:ino` with what `ensureKeyDir` saw.
	const key = sessionKeyFor(ghIssue);
	let made;
	let armed = false;
	made = fixture({
		fs: {
			...realFs,
			openSync: (path, flags, ...rest) => {
				if (!armed && flags === "wx" && String(path).endsWith("lock")) {
					armed = true;
					const attacker = join(made.root, "attacker-real");
					mkdirSync(attacker, { recursive: true });
					realFs.rmSync(join(made.sessionsDir, key), { recursive: true, force: true });
					renameSync(attacker, join(made.sessionsDir, key));
				}
				return realFs.openSync(path, flags, ...rest);
			},
		},
	});
	const hostDir = join(made.jobDir, "session");
	mkdirSync(hostDir, { recursive: true });
	writeFileSync(join(hostDir, SESSION_FILE_NAME), `${HEADER}${JSON.stringify({ type: "message", role: "user" })}\n`);

	const p = made.store.promoteSession({ key, hostDir, modelId: "m", venue: "local" }, { piVersion: PI });
	assert.equal(p.promoted, false, "the directory this promotion prepared is not the one it would be writing into");
	assert.equal(p.reason, "key-not-a-directory");
	assert.deepEqual(readdirSync(join(made.sessionsDir, key)), [], "and nothing reaches the replacement: the lock this took is released on the way out, and no transcript or sidecar is written");
});

test("a transcript that GROWS under the copy is a race, and nothing of it is staged (#375)", () => {
	// A transcript that changes under the copy has moved, whatever direction it moved in: the by-path
	// re-check sees the identity change and cold-starts. The copy is ALSO bounded by the judged size, which
	// is belt and braces behind that and is what keeps `PI_SESSION_MAX_BYTES` and the record's `bytes` true
	// of what was staged while it was being staged: an unbounded copy put 2,460,306 bytes under the job dir
	// against a 1,000,000 cap while the record said 306.
	const key = sessionKeyFor(ghIssue);
	let made;
	let armed = false;
	made = fixture({
		fs: {
			...realFs,
			readSync: (fd, ...rest) => {
				if (!armed) {
					armed = true;
					realFs.appendFileSync(join(made.sessionsDir, key, SESSION_FILE_NAME), "x".repeat(500000));
				}
				return realFs.readSync(fd, ...rest);
			},
		},
	});
	seed(made.sessionsDir, key, { venue: "local" });

	const s = made.store.resolveSession(ghIssue, { jobDir: made.jobDir, piVersion: PI });
	assert.equal(s.resume, false, "a transcript that grew under the copy is not the one the gates judged");
	assert.equal(s.reason, "transcript-replaced");
	assert.equal(statSync(join(s.hostDir, SESSION_FILE_NAME)).size, 0, "and the container gets the 0-byte cold start rather than a transcript nothing gated");
});

test("a transcript TRUNCATED under the copy is a race, not a half transcript (#375)", () => {
	const key = sessionKeyFor(ghIssue);
	let made;
	let armed = false;
	made = fixture({
		fs: {
			...realFs,
			readSync: (fd, ...rest) => {
				if (!armed) {
					armed = true;
					realFs.truncateSync(join(made.sessionsDir, key, SESSION_FILE_NAME), 0);
				}
				return realFs.readSync(fd, ...rest);
			},
		},
	});
	seed(made.sessionsDir, key, { body: `${HEADER}${"y".repeat(200000)}\n`, venue: "local" });

	const s = made.store.resolveSession(ghIssue, { jobDir: made.jobDir, piVersion: PI });
	assert.equal(s.resume, false, "a short read means the judged transcript shrank under the copy");
	assert.equal(s.reason, "transcript-replaced");
	assert.equal(statSync(join(s.hostDir, SESSION_FILE_NAME)).size, 0, "and the container gets the 0-byte cold start, never a half conversation");
});

test("a promotion still landing, with its sentinel in place, cold-starts as venue-changed (#375)", () => {
	// The venue arm must stay reachable when NO identity moved. A promotion that wrote `(pending)` and has not
	// yet swapped is exactly that shape, and an identity-gated ladder never asks about it: a round that gated
	// the whole ladder on the identity resumed this, where #277's design cold-starts it.
	const key = sessionKeyFor(ghIssue);
	let made;
	let armed = false;
	made = fixture({
		fs: {
			...realFs,
			readSync: (fd, ...rest) => {
				if (!armed) {
					armed = true;
					realFs.writeFileSync(join(made.sessionsDir, key, "venue"), "(pending)");
				}
				return realFs.readSync(fd, ...rest);
			},
		},
	});
	seed(made.sessionsDir, key, { venue: "local" });

	const s = made.store.resolveSession(ghIssue, { jobDir: made.jobDir, piVersion: PI });
	assert.equal(s.resume, false, "a sentinel that appeared under this job means a promotion is mid-flight");
	assert.equal(s.reason, "venue-changed");
});

test("a transcript swapped for the attacker's and back again is refused by the DESCRIPTOR check (#375)", () => {
	// The A, B, A the descriptor exists for, at file level: the attacker's file is at the name when the open
	// happens, and the judged one is back before anything re-reads the path. A by-path re-check alone sees
	// nothing moved and stages what the descriptor holds, which is the attacker's conversation. `fstat` on the
	// descriptor is what refuses it, and it is the one check that cannot be lied to by a later rename.
	const key = sessionKeyFor(ghIssue);
	let made;
	let armed = false;
	made = fixture({
		fs: {
			...realFs,
			openSync: (path, flags, ...rest) => {
				const canonical = join(made.sessionsDir, key, SESSION_FILE_NAME);
				if (!armed && flags === "r" && String(path) === canonical) {
					armed = true;
					const attacker = join(made.root, "attacker.jsonl");
					writeFileSync(attacker, `${HEADER}${JSON.stringify({ type: "message", role: "user", content: "ATTACKER" })}\n`);
					renameSync(canonical, join(made.root, "stash.jsonl"));
					renameSync(attacker, canonical);
					const fd = realFs.openSync(path, flags, ...rest); // the descriptor the store will hold
					renameSync(canonical, join(made.root, "gone.jsonl")); // and now put the judged file back
					renameSync(join(made.root, "stash.jsonl"), canonical);
					return fd;
				}
				return realFs.openSync(path, flags, ...rest);
			},
		},
	});
	seed(made.sessionsDir, key, { venue: "local" });

	const s = made.store.resolveSession(ghIssue, { jobDir: made.jobDir, piVersion: PI });
	assert.equal(s.resume, false, "the descriptor is not the file the gates judged, whatever the name says now");
	assert.equal(s.reason, "transcript-replaced");
	const staged = readFileSync(join(s.hostDir, SESSION_FILE_NAME), "utf8");
	assert.equal(staged.includes("ATTACKER"), false, "and no byte of the attacker's conversation is staged");
	assert.equal(staged, "");
});

test("the copy reads no more than the judged size, whatever the file does under it (#375)", () => {
	// The bound is not what refuses a grown transcript (the identity re-check is), so it is invisible in the
	// verdict. What it does is stop an unbounded append from being READ at all, and this is the only way to
	// see it: count the bytes handed to the staged file while the transcript grows under the copy.
	const key = sessionKeyFor(ghIssue);
	let made;
	let armed = false;
	let written = 0;
	made = fixture({
		fs: {
			...realFs,
			readSync: (fd, ...rest) => {
				if (!armed) {
					armed = true;
					realFs.appendFileSync(join(made.sessionsDir, key, SESSION_FILE_NAME), "x".repeat(300000));
				}
				return realFs.readSync(fd, ...rest);
			},
			writeFileSync: (target, data, ...rest) => {
				if (typeof target === "number") written += data.length;
				return realFs.writeFileSync(target, data, ...rest);
			},
		},
	});
	// LARGER THAN ONE CHUNK, and deliberately not a multiple of it: the clamp only shows itself on the LAST
	// read, where an unclamped one would take a whole 64 KiB buffer's worth of whatever arrived meanwhile. A
	// transcript smaller than a chunk cannot see this, because the buffer is sized to the file.
	const body = `${HEADER}${"z".repeat(100_000)}\n`;
	seed(made.sessionsDir, key, { body, venue: "local" });

	made.store.resolveSession(ghIssue, { jobDir: made.jobDir, piVersion: PI });
	assert.equal(written, body.length, "exactly the judged size was read and staged, not the 300kB that arrived during the copy");
});
