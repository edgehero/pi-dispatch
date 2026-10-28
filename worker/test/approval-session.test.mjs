import assert from "node:assert/strict";
import * as fs from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { tempDir } from "./helpers/temp-dir.mjs";
import { approvalTranscriptMatches, makeApprovalSessionCheck } from "../src/approval-session.mjs";

const AT = Date.parse("2026-10-28T10:00:00Z");
const now = () => AT;
const request = { sessionKey: "a".repeat(32), toolCallId: "call-1", action: "deploy:staging" };
const refused = { refused: "approval-session-unavailable" };
const entries = () => [
	{ type: "session", version: 3, id: "session", timestamp: new Date(AT).toISOString(), cwd: "/workspace" },
	{ type: "message", id: "user", parentId: null, message: { role: "user", content: "work", timestamp: AT } },
	{ type: "message", id: "assistant", parentId: "user", message: { role: "assistant", content: [{ type: "toolCall", id: request.toolCallId, name: "request_approval", arguments: { action: request.action, summary: "private" } }], stopReason: "toolUse", timestamp: AT } },
	{ type: "message", id: "result", parentId: "assistant", message: { role: "toolResult", toolName: "request_approval", toolCallId: request.toolCallId, details: { approval: { action: request.action, toolCallId: request.toolCallId } }, content: [{ type: "text", text: "pending" }], isError: false, timestamp: AT } },
];
const serialize = (value) => value.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
function fixture() {
	const root = tempDir("approval-session-");
	const directory = join(root, request.sessionKey);
	fs.mkdirSync(directory);
	const file = join(directory, "current.jsonl");
	fs.writeFileSync(file, serialize(entries()));
	fs.utimesSync(file, new Date(AT), new Date(AT));
	return { root, directory, file, check: (options = {}) => makeApprovalSessionCheck({ sessionsDir: root, now, ...options }) };
}

test("canonical unanswered approval matches its call and refuses mismatched, consumed and superseded results", () => {
	const raw = entries();
	assert.equal(approvalTranscriptMatches(serialize(raw), request, { now }), true);
	for (const wrong of [{ ...request, toolCallId: "other" }, { ...request, action: "deploy:production" }]) assert.equal(approvalTranscriptMatches(serialize(raw), wrong, { now }), false);
	for (const append of [
		{ type: "message", id: "later", parentId: "result", message: { role: "user", content: "later" } },
		{ type: "context_edit", id: "edit", parentId: "result", targetId: "result", replacement: { content: "approved" } },
		{ type: "compaction", id: "compact", parentId: "result", summary: "compacted", firstKeptEntryId: null },
	]) assert.equal(approvalTranscriptMatches(serialize([...raw, append]), request, { now }), false);
	const errored = entries();
	errored[3].message.isError = true;
	assert.equal(approvalTranscriptMatches(serialize(errored), request, { now }), false);
	const missingCall = entries();
	missingCall[2].message.content = [];
	assert.equal(approvalTranscriptMatches(serialize(missingCall), request, { now }), false);
});

test("ambiguous branch IDs, broken parents, cycles, malformed JSON and empty sessions fail closed", () => {
	for (const text of ["", "{}", "not json", serialize(entries().slice(0, 1)), serialize([...entries(), { type: "message", id: "result", parentId: "result", message: {} }])]) assert.equal(approvalTranscriptMatches(text, request, { now }), false);
	for (const parentId of ["missing", "result"]) {
		const raw = entries(); raw[3].parentId = parentId;
		assert.equal(approvalTranscriptMatches(serialize(raw), request, { now }), false);
	}
});

test("filesystem preflight requires a real key directory and a nonempty bounded regular canonical file", () => {
	const { check, file, directory } = fixture();
	assert.deepEqual(check()(request), { ok: true });
	assert.deepEqual(check({ maxBytes: 20 })(request), refused);
	assert.deepEqual(check()({ ...request, sessionKey: "../escape" }), refused);
	assert.deepEqual(check()({ ...request, sessionKey: `${request.sessionKey}.${"b".repeat(32)}` }), refused, "gate forks are unsupported");
	fs.writeFileSync(file, "");
	assert.deepEqual(check()(request), refused);
	fs.unlinkSync(file);
	fs.mkdirSync(file);
	assert.deepEqual(check()(request), refused);
	fs.rmSync(file, { recursive: true });
	fs.rmSync(directory, { recursive: true });
	assert.deepEqual(check()(request), refused);
});

test("key and transcript symlinks refuse, while the configured store root may be a symlink", () => {
	const a = fixture();
	const alias = join(tempDir("approval-root-alias-"), "sessions");
	fs.symlinkSync(a.root, alias);
	assert.deepEqual(makeApprovalSessionCheck({ sessionsDir: alias, now })(request), { ok: true });
	const external = tempDir("approval-external-");
	fs.renameSync(a.directory, join(external, "saved"));
	fs.symlinkSync(join(external, "saved"), a.directory);
	assert.deepEqual(a.check()(request), refused);
	const b = fixture();
	fs.renameSync(b.file, join(external, "transcript"));
	fs.symlinkSync(join(external, "transcript"), b.file);
	assert.deepEqual(b.check()(request), refused);
});

test("TTL and conversation-age bounds use the injected clock and preserve exact store boundaries", () => {
	const { check } = fixture();
	assert.deepEqual(check({ ttlDays: 1, now: () => AT + 86400_000 })(request), { ok: true });
	assert.deepEqual(check({ ttlDays: 1, now: () => AT + 86400_001 })(request), refused);
	assert.deepEqual(check({ maxAgeDays: 1, now: () => AT + 86400_000 })(request), { ok: true });
	assert.deepEqual(check({ maxAgeDays: 1, now: () => AT + 86400_001 })(request), refused);
	assert.deepEqual(check({ ttlDays: 0, maxAgeDays: 0, now: () => AT + 999 * 86400_000 })(request), { ok: true });
});

test("resume-chain exhaustion refuses before mint; absent or corrupt counts match store's zero fallback", () => {
	const { check, directory } = fixture();
	const sidecar = join(directory, "resume-chain");
	assert.deepEqual(check({ maxResumeChain: 2 })(request), { ok: true });
	fs.writeFileSync(sidecar, "2");
	assert.deepEqual(check({ maxResumeChain: 2 })(request), refused);
	fs.writeFileSync(sidecar, "1");
	assert.deepEqual(check({ maxResumeChain: 2 })(request), { ok: true });
	fs.writeFileSync(sidecar, "2.5");
	assert.deepEqual(check({ maxResumeChain: 2 })(request), { ok: true });
});

test("image-version and venue checks match the store's missing-versus-corrupt sidecar rules", () => {
	const { check, directory } = fixture();
	assert.deepEqual(check()(request, { piVersion: "1.2.0" }), refused);
	fs.writeFileSync(join(directory, "pi-version"), "1.2.0");
	assert.deepEqual(check()(request, { piVersion: "1.2.0" }), { ok: true });
	assert.deepEqual(check()(request, { piVersion: "1.3.0" }), refused);
	assert.deepEqual(check()(request, { piVersion: null }), refused);
	assert.deepEqual(check()(request, { venue: "local" }), { ok: true }, "a missing stamp is the legacy local venue");
	assert.deepEqual(check()(request, { venue: "podman" }), refused);
	fs.writeFileSync(join(directory, "venue"), "podman");
	assert.deepEqual(check()(request, { venue: "podman" }), { ok: true });
	fs.writeFileSync(join(directory, "venue"), "");
	assert.deepEqual(check()(request, { venue: "local" }), refused, "an empty stamp cannot inherit the missing stamp default");
});

test("context fullness uses the current model, preserves foreign-model and unknown-counter semantics", () => {
	const { check, directory } = fixture();
	const bounded = check({ maxContextPct: 80 });
	fs.writeFileSync(join(directory, "context"), "80 100 provider/model");
	assert.deepEqual(bounded(request), { ok: true }, "early preflight defers this model-sensitive gate");
	assert.deepEqual(bounded(request, { modelId: "model", provider: "provider" }), refused);
	assert.deepEqual(bounded(request, { modelId: "provider/model" }), refused);
	assert.deepEqual(bounded(request, { modelId: "other", provider: "provider" }), { ok: true });
	assert.deepEqual(bounded(request, { modelId: null, provider: null }), refused, "unknown current model has no foreign-model exemption");
	fs.writeFileSync(join(directory, "context"), "79 100 provider/model");
	assert.deepEqual(bounded(request, { modelId: "model", provider: "provider" }), { ok: true });
	for (const raw of ["unknown", "80 0", "80.5 100", "-1 100"]) {
		fs.writeFileSync(join(directory, "context"), raw);
		assert.deepEqual(bounded(request, { modelId: "model", provider: "provider" }), { ok: true });
	}
});

test("approval generation binds the exact canonical transcript even when a provider reuses the same tool call id", () => {
	const { check, file } = fixture();
	const preflight = check();
	const fingerprint = preflight.fingerprint(request);
	assert.equal(fingerprint.ok, true);
	assert.match(fingerprint.digest, /^[a-f0-9]{64}$/);
	const bound = { ...request, sessionDigest: fingerprint.digest };
	assert.deepEqual(preflight(bound), { ok: true });
	const later = entries();
	later[1].message.content = "a later run's different task, with the provider reusing call-1";
	fs.writeFileSync(file, serialize(later));
	assert.deepEqual(preflight(request), { ok: true }, "action and tool-call id alone still match the later valid transcript");
	assert.deepEqual(preflight(bound), refused);
	assert.deepEqual(preflight.fingerprint(bound), refused);
	assert.notEqual(preflight.fingerprint(request).digest, fingerprint.digest);
});

test("a transcript or directory identity changed during the descriptor read cannot pass", () => {
	const { root, file, directory } = fixture();
	let changed = false;
	const io = { ...fs, readSync(...args) {
		const count = fs.readSync(...args);
		if (!changed) { changed = true; fs.renameSync(file, `${file}.old`); fs.writeFileSync(file, serialize(entries())); }
		return count;
	} };
	assert.deepEqual(makeApprovalSessionCheck({ sessionsDir: root, now, fs: io })(request), refused);
	let moved = false;
	const swapped = { ...fs, readSync(...args) {
		const count = fs.readSync(...args);
		if (!moved) { moved = true; fs.renameSync(directory, `${directory}.old`); fs.mkdirSync(directory); fs.writeFileSync(join(directory, "current.jsonl"), serialize(entries())); }
		return count;
	} };
	assert.deepEqual(makeApprovalSessionCheck({ sessionsDir: root, now, fs: swapped })(request), refused);
});
