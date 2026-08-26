import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { assertSessionMountReady } from "../src/config.mjs";
import { openSessionManager } from "../src/session.mjs";

// Real pi, real files. The whole point of this file is the behaviour of pi's OWN setSessionFile on
// inputs an agent can produce, so a fake SessionManager would test the fake.
const mod = await import("@earendil-works/pi-coding-agent").catch(() => null);
const skip = mod ? false : `pi not installed (node ${process.version} < 22.19.0); CI runs these`;

function stage(contents) {
	const dir = mkdtempSync(join(tmpdir(), "pi-session-"));
	const file = join(dir, "current.jsonl");
	writeFileSync(file, contents);
	return { dir, file };
}

test("no PI_SESSION_FILE builds pi's ephemeral session, exactly as before the feature", { skip }, () => {
	const { sessionManager, resumed, reason } = openSessionManager({ sessionFile: null, cwd: "/tmp" });
	assert.equal(resumed, false);
	assert.equal(reason, "disabled");
	assert.ok(sessionManager.getSessionId(), "the root id must exist before createUsageMeter reads it");
	assert.equal(sessionManager.isPersisted(), false, "an unarmed job must write nothing to disk at all");
});

test("a host-staged 0-byte file is flushed to a real header at open, so _persist never takes its wx branch", { skip }, () => {
	const { file } = stage("");
	const { sessionManager, resumed, reason } = openSessionManager({ sessionFile: file, cwd: "/workspace" });

	assert.equal(resumed, false, "an empty transcript has no messages, so this is a cold start");
	// The token matters beyond this file. The host stages 0 bytes on EVERY read-path refusal, so `absent`
	// is what the container reports whenever a host gate said no -- which is why the record's merge treats
	// it as the one runner token a host gate outranks (mergeSession, worker/src/processor.mjs). Pin it, or
	// a rename here silently turns that rule off and the host's reason starts winning everywhere.
	assert.equal(reason, "absent");
	assert.ok(statSync(file).size > 0, "pi must write its header at open");
	const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0]);
	assert.equal(header.type, "session");
	assert.equal(header.cwd, "/workspace", "cwdOverride must win over anything a stored header claims");
	assert.equal(sessionManager.getSessionFile(), file, "the explicit path must survive newSession()");
	// If a pin bump ever stops flushing here, pi's _persist falls back to openSync(path, "wx") -- an
	// exclusive create that throws EEXIST the moment two jobs share a key. Staging 0 bytes is what makes
	// that branch unreachable rather than merely unlikely, and this assertion is its tripwire.
});

test("a corrupt transcript degrades to a cold start and NEVER to a retryable exit", { skip }, () => {
	const { dir, file } = stage("this is not a pi session\n");
	const logged = [];

	let result;
	assert.doesNotThrow(() => {
		result = openSessionManager({ sessionFile: file, cwd: "/workspace", log: (e, f) => logged.push([e, f]), now: () => 1234 });
	}, "an unhandled throw here classifies as exit 1 = RETRYABLE, so four bad bytes written by the agent that owns this mount would burn every retry and repeat on every later job for the same key");

	assert.equal(result.resumed, false);
	assert.equal(result.reason, "unparseable");
	assert.ok(result.sessionManager.getSessionId(), "the meter still needs a root id on the degraded path");
	assert.deepEqual(logged.map(([e]) => e), ["session_resume_degraded"], "degrading silently is not the same as degrading invisibly");

	const names = readdirSync(dir);
	assert.ok(names.includes("current.jsonl.invalid-1234"), "the bad bytes are moved aside, not deleted -- the operator may want them and the reaper sweeps them");
	assert.equal(readFileSync(join(dir, "current.jsonl.invalid-1234"), "utf8"), "this is not a pi session\n");
	assert.ok(statSync(file).size > 0, "a fresh session must be re-staged at the same path, or this key is wedged forever");
});

test("a real transcript with messages resumes, and reports what pi will actually do", { skip }, () => {
	const { file } = stage("");
	// Write a session the way pi does, then reopen it.
	const first = openSessionManager({ sessionFile: file, cwd: "/workspace" });
	first.sessionManager.appendUserMessage?.({ role: "user", content: "hello" }) ??
		first.sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "hello" }] });

	const second = openSessionManager({ sessionFile: file, cwd: "/workspace" });
	assert.equal(second.resumed, true, "resumed must be buildSessionContext().messages.length > 0 -- the same predicate createAgentSession uses, so we report what pi does rather than what the host hoped");
	assert.equal(second.reason, "resumed");
	assert.equal(second.sessionManager.getSessionId(), first.sessionManager.getSessionId(), "reopening must adopt the stored header id, not mint a new one");
});

test("an absent session file is a mount failure, not an empty transcript", () => {
	// checkWritable is stubbed to SUCCEED on purpose. Left to the real one it throws ENOENT on a
	// /session that does not exist here, which satisfies assert.throws for the wrong reason -- the
	// existence check could be deleted outright and this test would still pass. Mutation-caught.
	assert.throws(
		() => assertSessionMountReady("/session/current.jsonl", { fileExists: () => false, checkWritable: () => {} }),
		(e) => e.piDispatchExit === 2 && /did not land/.test(e.message),
		"the host stages this file ALWAYS, 0 bytes on a cold start included -- so absence proves the bind mount did not land, and that must not be retried",
	);
	assert.doesNotThrow(
		() => assertSessionMountReady("/session/current.jsonl", { fileExists: () => true, checkWritable: () => {} }),
		"a staged file on a writable mount is the normal armed case and must pass both gates",
	);
});

test("an unwritable session dir refuses pre-spend rather than as an EACCES from inside pi", () => {
	assert.throws(
		() => assertSessionMountReady("/session/current.jsonl", {
			fileExists: () => true,
			checkWritable: () => {
				throw new Error("EACCES: permission denied");
			},
		}),
		(e) => e.piDispatchExit === 2 && /not writable/.test(e.message),
		"createAgentSession appends a thinking-level entry BEFORE the first prompt, so a uid mismatch would otherwise surface as a throw from inside pi that classifyThrow files as exit 1 -- retryable, for a fault no retry can fix",
	);
});

test("an unarmed job skips both checks entirely", () => {
	assert.doesNotThrow(() => assertSessionMountReady(null, { fileExists: () => false }));
	assert.doesNotThrow(() => assertSessionMountReady(undefined, { fileExists: () => false }));
});
