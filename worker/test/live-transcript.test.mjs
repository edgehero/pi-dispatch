import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { appendFileSync, renameSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import {
	LIVE_ASSISTANT_TEXT_MAX,
	LIVE_KEY_PREFIX,
	LIVE_KINDS,
	LIVE_MAX_ENTRIES,
	LIVE_OUTCOMES,
	LIVE_TEXT_MAX,
	LIVE_TTL_ENDED_MS,
	LIVE_TTL_LIVE_MS,
	REFUSED_NOTE,
	UNPARSEABLE_NOTE,
	clip,
	entriesOf,
	headOf,
	outcomeOf,
	liveKeyFor,
	makeLiveTranscript,
	stageLiveFile,
} from "../src/live-transcript.mjs";
import { makeRedactor } from "../src/redact-secrets.mjs";
import { sanitizeJobId } from "../src/run-history.mjs";
import { tempDir } from "./helpers/temp-dir.mjs";

// Issue #643: the live transcript publisher. The mapping and the constants need nothing; the stream itself is tested
// against a real Valkey (database 14, flushed first), with a fake transcript writer appending pi-shaped lines to a
// temp file the way the pinned pi does (one JSON object per line, header first).

const AT = "2026-10-16T10:00:00.000Z";
const header = (id = "s1") => `${JSON.stringify({ type: "session", version: 3, id, timestamp: AT, cwd: "/workspace" })}\n`;
const msg = (message, at = AT) => `${JSON.stringify({ type: "message", id: "e", parentId: null, timestamp: at, message })}\n`;

// --- the mapping and the constants ----------------------------------------------------------------------------

test("the constants readers share, and the key is the run mirror's sanitized id", () => {
	assert.equal(LIVE_KEY_PREFIX, "run:live:");
	assert.equal(LIVE_MAX_ENTRIES, 2000);
	assert.equal(LIVE_TTL_LIVE_MS, 7 * 24 * 3600 * 1000);
	assert.equal(LIVE_TTL_ENDED_MS, 24 * 3600 * 1000);
	assert.deepEqual([...LIVE_KINDS], ["user", "assistant", "tool-call", "tool-result", "compaction", "note", "reset", "skipped", "end"]);
	assert.deepEqual([...LIVE_OUTCOMES], ["completed", "policy", "failed", "unknown"]);
	assert.equal(liveKeyFor("repeat:abc:17"), `run:live:${sanitizeJobId("repeat:abc:17")}`);
	assert.equal(liveKeyFor("repeat:abc:17"), "run:live:repeat_abc_17");
});

test("pi entries map to display entries: thinking dropped, one tool-call per call, images as [image]", () => {
	assert.deepEqual(entriesOf({ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }, { type: "image", data: "AAAA", mimeType: "image/png" }] } }, 1), [{ kind: "user", ts: 1, text: "hi\n[image]" }]);
	assert.deepEqual(entriesOf({ type: "message", message: { role: "user", content: "plain" } }, 1), [{ kind: "user", ts: 1, text: "plain" }]);
	const assistant = {
		role: "assistant",
		content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "I will look." }, { type: "toolCall", id: "1", name: "read", arguments: { path: "a.txt" } }, { type: "toolCall", id: "2", name: "bad name!", arguments: {} }],
		stopReason: "toolUse",
	};
	assert.deepEqual(entriesOf({ type: "message", message: assistant }, 2), [
		{ kind: "assistant", ts: 2, text: "I will look." },
		{ kind: "tool-call", ts: 2, tool: "read", text: '{"path":"a.txt"}' },
		{ kind: "tool-call", ts: 2, tool: "?", text: "{}" },
	]);
	assert.ok(!JSON.stringify(entriesOf({ type: "message", message: assistant }, 2)).includes("private reasoning"));
	assert.deepEqual(entriesOf({ type: "message", message: { role: "assistant", content: [{ type: "thinking", thinking: "x" }], stopReason: "error", errorMessage: "provider said sk-secret" } }, 3), [{ kind: "note", ts: 3, text: "the model's turn ended: error" }], "no empty assistant entry, and never the provider's message");
	assert.deepEqual(entriesOf({ type: "message", message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "boom" }, { type: "image", data: "", mimeType: "image/png" }] } }, 4), [{ kind: "tool-result", ts: 4, tool: "bash", text: "boom\n[image]", error: true }]);
	assert.deepEqual(entriesOf({ type: "message", message: { role: "toolResult", toolName: "read", isError: false, content: [] } }, 4), [{ kind: "tool-result", ts: 4, tool: "read", text: "" }]);
	assert.deepEqual(entriesOf({ type: "compaction", summary: "so far" }, 5), [{ kind: "compaction", ts: 5, text: "so far" }]);
	assert.deepEqual(entriesOf({ type: "model_change", provider: "anthropic", modelId: "m-1" }, 6), [{ kind: "note", ts: 6, text: "model: anthropic/m-1" }]);
	assert.deepEqual(entriesOf({ type: "session", cwd: "/home/someone" }, 7), [{ kind: "note", ts: 7, text: "session started" }], "the header's cwd is not published");
	assert.deepEqual(entriesOf({ type: "custom_message", customType: "await-input", content: "need an answer" }, 8), [{ kind: "note", ts: 8, text: "await-input: need an answer" }]);
	for (const type of ["usage", "custom", "session_info", "label", "unheard-of"]) assert.deepEqual(entriesOf({ type, data: "x" }, 9), [], type);
});

// --- against a real Valkey ------------------------------------------------------------------------------------

const valkeyUrl = process.env.VALKEY_TEST_URL;
if (!valkeyUrl && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("live-transcript tests REQUIRE VALKEY_TEST_URL when PI_DISPATCH_REQUIRE_WORKER_TESTS=1");
const live = valkeyUrl ? false : "VALKEY_TEST_URL not set; the stream needs a real Valkey";

let redis = null;
async function client() {
	if (redis) return redis;
	const { makeRedisClient } = await import("../src/connection.mjs");
	const url = new URL(valkeyUrl);
	url.pathname = "/14";
	redis = makeRedisClient(url.toString());
	redis.on("error", () => {});
	await redis.flushdb();
	return redis;
}
test.after(async () => {
	await redis?.quit().catch(() => {});
});

/** A temp transcript file and a publisher on it, with a poll the test drives (`pollMs` far past the test). */
async function setup(jobId, opts = {}) {
	const r = await client();
	const dir = tempDir("pi-live-");
	const file = join(dir, "current.jsonl");
	writeFileSync(file, "");
	const logs = [];
	const pub = makeLiveTranscript({ file, jobId, redis: r, pollMs: 3_600_000, now: () => Date.parse(AT), log: (e, f) => logs.push({ e, f }), ...opts });
	const read = async () => (await r.xrange(liveKeyFor(jobId), "-", "+")).map(([, flat]) => Object.fromEntries(flat.reduce((acc, v, i) => (i % 2 ? acc[acc.length - 1].push(v) : acc.push([v]), acc), [])));
	return { r, file, pub, logs, read, append: (text) => appendFileSync(file, text) };
}

test("entries arrive in order, a partial last line is held until it completes, and the end carries the outcome", { skip: live }, async () => {
	const { pub, read, append } = await setup("order-1");
	append(header());
	const line = msg({ role: "user", content: "first" });
	append(line.slice(0, 20));
	await pub.poll();
	assert.deepEqual((await read()).map((e) => e.kind), ["note"], "the half-written line is not published");
	append(line.slice(20));
	append(msg({ role: "assistant", content: [{ type: "text", text: "second" }, { type: "toolCall", id: "1", name: "bash", arguments: { cmd: "ls" } }] }));
	append(msg({ role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "third" }] }));
	await pub.poll();
	await pub.finish("completed");
	const entries = await read();
	assert.deepEqual(entries.map((e) => [e.kind, e.text ?? null, e.tool ?? null, e.error ?? null]), [
		["note", "session started", null, null],
		["user", "first", null, null],
		["assistant", "second", null, null],
		["tool-call", '{"cmd":"ls"}', "bash", null],
		["tool-result", "third", "bash", "1"],
		["end", null, null, null],
	]);
	assert.equal(entries.at(-1).outcome, "completed");
	assert.equal(entries[1].ts, String(Date.parse(AT)), "the pi entry's own timestamp");
	assert.equal(await pub.finish("failed"), undefined, "idempotent");
	assert.equal((await read()).length, entries.length);
});

test("a header rewrite and a truncation each publish reset and reread from the start", { skip: live }, async () => {
	const { pub, read, append, file } = await setup("reset-1");
	append(header("s1"));
	append(msg({ role: "user", content: "before" }));
	await pub.poll();
	// pi's _rewriteFile: the same path, opened "w", a new header, and more bytes than before.
	writeFileSync(file, header("s2") + msg({ role: "user", content: "after rewrite, longer than before" }));
	await pub.poll();
	writeFileSync(file, header("s3"));
	await pub.poll();
	// A truncation that keeps the first line: only the size says the file shrank.
	append(msg({ role: "user", content: "kept" }));
	await pub.poll();
	writeFileSync(file, header("s3"));
	append(msg({ role: "user", content: "x" }));
	await pub.poll();
	assert.deepEqual((await read()).map((e) => e.kind + (e.text ? `:${e.text}` : "")), ["note:session started", "user:before", "reset", "note:session started", "user:after rewrite, longer than before", "reset", "note:session started", "user:kept", "reset", "note:session started", "user:x"]);
});

test("an oversize line is skipped and an unparseable one becomes a fixed note, never its bytes", { skip: live }, async () => {
	const { pub, read, append } = await setup("odd-1", { lineMaxBytes: 256 });
	append(header());
	append(msg({ role: "user", content: "x".repeat(400) }));
	// an oversize line arriving in pieces, still unterminated at the first poll
	append(`{"type":"message","message":{"role":"user","content":"${"y".repeat(300)}`);
	await pub.poll();
	append(`"}}\n`);
	append("not json {{{ SECRET-LOOKING-RAW-BYTES\n");
	append(msg({ role: "user", content: "fine" }));
	await pub.finish("policy");
	const entries = await read();
	assert.deepEqual(entries.map((e) => e.kind), ["note", "skipped", "skipped", "note", "user", "end"]);
	assert.equal(entries[3].text, UNPARSEABLE_NOTE);
	assert.ok(!JSON.stringify(entries).includes("SECRET-LOOKING"));
	assert.ok(!JSON.stringify(entries).includes("yyyy"));
});

test("text is redacted, then control and bidi characters are escaped, then cut by code points with truncated set", { skip: live }, async () => {
	const { pub, read, append } = await setup("clip-1", { redact: makeRedactor({ values: ["hunter2hunter2"] }) });
	append(msg({ role: "user", content: "pw hunter2hunter2‮\u0007 end" }));
	append(msg({ role: "user", content: "😀".repeat(LIVE_TEXT_MAX + 5) }));
	append(msg({ role: "assistant", content: [{ type: "text", text: "a".repeat(LIVE_ASSISTANT_TEXT_MAX) }] }));
	append(msg({ role: "assistant", content: [{ type: "text", text: "b".repeat(LIVE_ASSISTANT_TEXT_MAX + 1) }] }));
	await pub.finish("completed");
	const [esc, emoji, fits, cut] = await read();
	assert.equal(esc.text, "pw [redacted]\\u{202E}\\u{0007} end");
	assert.equal([...emoji.text].length, LIVE_TEXT_MAX);
	assert.equal(emoji.truncated, "1");
	assert.equal(fits.text.length, LIVE_ASSISTANT_TEXT_MAX);
	assert.equal(fits.truncated, undefined, "an assistant entry gets the larger cap");
	assert.equal(cut.truncated, "1");
});

test("a multi-line tool result keeps its real newlines and tabs, while bidi and ESC are still escaped", { skip: live }, async () => {
	const { pub, read, append } = await setup("lines-1");
	append(msg({ role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: "one\r\ntwo\rthree\n\tfour\u001b[31m\u202e" }] }));
	await pub.finish("completed");
	const [entry] = await read();
	assert.equal(entry.text, "one\ntwo\nthree\n\tfour\\u{001B}[31m\\u{202E}");
});

test("the stream is capped near 2,000 entries, lives 7 days while live and 24 hours after its end", { skip: live }, async () => {
	const { r, pub, append } = await setup("cap-1");
	await r.xadd(liveKeyFor("cap-1"), "*", "kind", "note", "ts", "1", "text", "an earlier attempt's leftover");
	append(header());
	// In two polls, so neither batch reaches the publisher's own pending bound and only MAXLEN can trim.
	for (const half of [0, 1]) {
		let lines = "";
		for (let i = 0; i < (LIVE_MAX_ENTRIES + 600) / 2; i++) lines += msg({ role: "user", content: `n${half}-${i}` });
		append(lines);
		await pub.poll();
	}
	const ttlLive = await r.pttl(liveKeyFor("cap-1"));
	assert.ok(ttlLive > LIVE_TTL_LIVE_MS - 60_000 && ttlLive <= LIVE_TTL_LIVE_MS, `live TTL ${ttlLive}`);
	const len = await r.xlen(liveKeyFor("cap-1"));
	assert.ok(len >= LIVE_MAX_ENTRIES && len <= LIVE_MAX_ENTRIES + 100, `MAXLEN ~ 2000 keeps ${len}`);
	const first = await r.xrange(liveKeyFor("cap-1"), "-", "+", "COUNT", 1);
	assert.notEqual(first[0][1][5], "an earlier attempt's leftover", "an attempt's first write replaces what an earlier one left");
	await pub.finish("completed");
	const ttlEnded = await r.pttl(liveKeyFor("cap-1"));
	assert.ok(ttlEnded > LIVE_TTL_ENDED_MS - 60_000 && ttlEnded <= LIVE_TTL_ENDED_MS, `ended TTL ${ttlEnded}`);
});

test("finish reads the tail the last poll missed, a partial last line included, before it ends the stream", { skip: live }, async () => {
	const { pub, read, append } = await setup("tail-1");
	append(header());
	await pub.poll();
	append(msg({ role: "user", content: "complete" }));
	append(msg({ role: "user", content: "no newline yet" }).trimEnd());
	await pub.finish("failed");
	assert.deepEqual((await read()).map((e) => e.text ?? e.outcome), ["session started", "complete", "no newline yet", "failed"]);
});

test("a closed Valkey client and a rejecting one never throw, never hold the job, and are counted in the log", { skip: live }, async () => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const url = new URL(valkeyUrl);
	url.pathname = "/14";
	const closed = makeRedisClient(url.toString());
	closed.on("error", () => {});
	await closed.ping();
	closed.disconnect();
	const rejecting = { multi: () => ({ del() {
		return this;
	}, xadd() {
		return this;
	}, pexpire() {
		return this;
	}, exec: async () => {
		throw new Error("READONLY");
	} }) };
	for (const bad of [closed, rejecting]) {
		const dir = tempDir("pi-live-");
		const file = join(dir, "current.jsonl");
		writeFileSync(file, header() + msg({ role: "user", content: "lost" }));
		const logs = [];
		const pub = makeLiveTranscript({ file, jobId: "down-1", redis: bad, pollMs: 3_600_000, now: () => Date.parse(AT), timeoutMs: 200, finishTimeoutMs: 1_000, log: (e, f) => logs.push({ e, f }) });
		const began = Date.now();
		await pub.poll();
		await pub.finish("completed");
		assert.ok(Date.now() - began < 2_500, "bounded");
		assert.deepEqual(logs.map((l) => l.e), ["live_transcript_write_failed", "live_transcript_ended"]);
		assert.equal(logs[1].f.published, 0);
		assert.equal(logs[1].f.dropped, 3, "dropped, not buffered: the header, the line and the end");
	}
});

test("nothing of an entry's content reaches the worker log: the job id and counts only", { skip: live }, async () => {
	const { pub, append, logs } = await setup("log-1");
	append(header() + msg({ role: "user", content: "PRIVATE-ISSUE-TEXT" }) + "garbage-PRIVATE-RAW\n");
	await pub.poll();
	await pub.finish("completed");
	assert.deepEqual(logs.map((l) => l.e), ["live_transcript_ended"]);
	assert.deepEqual(Object.keys(logs[0].f).sort(), ["dropped", "errors", "jobId", "notes", "published", "refused", "resets", "skipped"]);
	assert.ok(Object.entries(logs[0].f).every(([k, v]) => (k === "jobId" ? v === "log-1" : Number.isInteger(v))));
	assert.ok(!JSON.stringify(logs).includes("PRIVATE"));
});

// --- the canary -----------------------------------------------------------------------------------------------

let rc;
try {
	rc = await import("../src/run-container.mjs");
} catch {}
if (!rc && process.env.PI_DISPATCH_REQUIRE_WORKER_TESTS === "1") throw new Error("live-transcript canary: run-container is REQUIRED here but could not import");

test("canary: a job whose transcript echoes every secret it holds, in every spelling, publishes none of them", { skip: live || (rc ? false : "pi-ai not installed") }, async () => {
	const r = await client();
	const jobsDir = tempDir("pi-live-canary-");
	const jobDir = join(jobsDir, "job-1");
	const staged = stageLiveFile(jobDir);
	// Every kind of secret a job holds, each with characters that make its three spellings differ.
	const secrets = {
		provider: 'sk-ant-api03-PROV"ider/key+1',
		minted: "ghs_MintedForgeToken0123456789abcd",
		forwarded: "fwd-Value/with+slash=and\"quote",
		trigger: "trigger secret with spaces & ampersand",
		exitKey: "e".repeat(16) + "f".repeat(48),
	};
	const hostEnv = { ANTHROPIC_API_KEY: secrets.provider, CUSTOM_KEY: secrets.forwarded };
	const all = Object.values(secrets);
	const toolDoc = JSON.stringify({ env: Object.fromEntries(all.map((v, i) => [`K${i}`, v])) });
	const runContainer = rc.makeRunContainer({
		image: "pi-job:x",
		hostEnv,
		forwardEnv: ["CUSTOM_KEY"],
		mintExitKey: () => secrets.exitKey,
		openLiveTranscript: (o) => makeLiveTranscript({ ...o, redis: r, pollMs: 3_600_000, now: () => Date.parse(AT) }),
		spawnFn: () => {
			const child = new EventEmitter();
			child.stdout = new EventEmitter();
			child.stderr = new EventEmitter();
			child.stdin = { on() {}, end() {} };
			setImmediate(() => {
				const f = join(staged.hostDir, "current.jsonl");
				appendFileSync(f, header());
				appendFileSync(f, msg({ role: "user", content: `literal: ${all.join(" | ")}` }));
				appendFileSync(f, msg({ role: "toolResult", toolName: "bash", isError: false, content: [{ type: "text", text: toolDoc }] }));
				appendFileSync(f, msg({ role: "assistant", content: [{ type: "toolCall", id: "1", name: "fetch", arguments: { url: `https://x.test/?${all.map((v, i) => `k${i}=${encodeURIComponent(v)}`).join("&")}` } }] }));
				child.emit("close", 0);
			});
			return child;
		},
	});
	await runContainer({ job: { kind: "github", repo: "o/n", provider: "anthropic", model: "m", maxTurns: 5 }, token: secrets.minted, prepared: { workspace: join(jobDir, "workspace"), jobDir, live: staged }, secrets: { TRIGGER_SECRET: secrets.trigger }, name: "pi-job-canary", signal: new AbortController().signal, exitAuth: true, jobId: "canary-1" });
	const stream = JSON.stringify(await r.xrange(liveKeyFor("canary-1"), "-", "+"));
	assert.ok(stream.includes("[redacted]"), "the canary reached the stream");
	assert.ok(stream.includes('"fetch"') && stream.includes('"tool-result"'), "every line was published");
	for (const v of all) {
		for (const form of [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v)]) {
			assert.ok(!stream.includes(JSON.stringify(form).slice(1, -1)), `a secret leaked: ${form.slice(0, 6)}...`);
		}
	}
});

test("a transcript file swapped for a symlink to a host file is refused, never followed, and said once", { skip: live }, async () => {
	const { file, pub, read, append } = await setup("link-1");
	append(header());
	append(msg({ role: "user", content: "mine" }));
	await pub.poll();
	// What another job's stored transcript looks like: pi-shaped, so following the link would publish it.
	const outside = join(tempDir("pi-live-outside-"), "other.jsonl");
	writeFileSync(outside, header("other") + msg({ role: "user", content: "SOMEONE ELSES SECRET" }));
	rmSync(file);
	symlinkSync(outside, file);
	await pub.poll();
	await pub.poll();
	await pub.finish("completed");
	const entries = await read();
	assert.ok(!JSON.stringify(entries).includes("SOMEONE ELSES SECRET"), "the linked file was not read");
	assert.equal(entries.filter((e) => e.text === REFUSED_NOTE).length, 1, "the refusal is said once");
	assert.deepEqual(entries.map((e) => e.kind), ["note", "user", "note", "end"]);
});

test("a transcript file swapped for a FIFO is refused without hanging the read", { skip: live || process.platform === "win32" }, async () => {
	const { file, pub, read } = await setup("fifo-1");
	rmSync(file);
	execFileSync("mkfifo", [file]);
	const started = Date.now();
	await pub.poll();
	await pub.finish("completed");
	assert.ok(Date.now() - started < 5000, "the poll returned instead of blocking on the FIFO");
	assert.equal((await read()).filter((e) => e.text === REFUSED_NOTE).length, 1);
});

// The link and the other file are both refused by the descriptor's inode re-check; O_NOFOLLOW (ELOOP) is defence in depth
// behind it, and no swap is known that only O_NOFOLLOW stops (a link whose target has the lstat'd inode reads this very
// file). O_NONBLOCK is what keeps the FIFO from hanging the open itself.
test("a swap between the lstat and the open is refused too: a link and another file (the inode re-check), a FIFO (O_NONBLOCK)", { skip: live || process.platform === "win32" }, async () => {
	const { lstat, open, rename } = await import("node:fs/promises");
	const outsideDir = tempDir("pi-live-race-");
	const secretFile = join(outsideDir, "other.jsonl");
	writeFileSync(secretFile, header("other") + msg({ role: "user", content: "RACED SECRET" }));
	for (const swap of ["link", "fifo", "file"]) {
		const jobId = `race-${swap}`;
		const { file, read } = await setup(jobId);
		let armed = true;
		// The swap lands after lstat judged the file and before the open: exactly the window the open flags close.
		const fs = {
			open,
			lstat: async (p) => {
				const info = await lstat(p);
				if (armed) {
					armed = false;
					if (swap === "link") { rmSync(p); symlinkSync(secretFile, p); }
					else if (swap === "fifo") { rmSync(p); execFileSync("mkfifo", [p]); }
					else { const other = join(outsideDir, `swap-${jobId}.jsonl`); writeFileSync(other, header("x") + msg({ role: "user", content: "RACED SECRET" })); await rename(other, p); }
				}
				return info;
			},
		};
		const pub = makeLiveTranscript({ file, jobId, redis: await client(), pollMs: 3_600_000, now: () => Date.parse(AT), fs });
		const started = Date.now();
		await pub.poll();
		await pub.finish("completed");
		assert.ok(Date.now() - started < 5000, `${swap}: the read did not hang`);
		const entries = await read();
		assert.ok(!JSON.stringify(entries).includes("RACED SECRET"), `${swap}: nothing of the swapped-in file was published`);
		assert.equal(entries.filter((e) => e.text === REFUSED_NOTE).length, 1, `${swap}: refused once`);
	}
});

// --- review round: mapping survivors ----------------------------------------------------------------------------

test("the rest of the mapping: bashExecution, branch_summary, thinking level, context edit, unknown roles, aborted, and the charset on every name (#643)", () => {
	assert.deepEqual(entriesOf({ type: "message", message: { role: "bashExecution", command: "ls -la", output: "a\nb" } }, 1), [{ kind: "tool-result", ts: 1, tool: "bash", text: "$ ls -la\na\nb" }]);
	assert.deepEqual(entriesOf({ type: "message", message: { role: "bashExecution", command: 7, output: null } }, 1), [{ kind: "tool-result", ts: 1, tool: "bash", text: "$ \n" }], "non-string command and output are empty, never stringified");
	assert.deepEqual(entriesOf({ type: "branch_summary", summary: "the other branch" }, 2), [{ kind: "compaction", ts: 2, text: "the other branch" }]);
	assert.deepEqual(entriesOf({ type: "branch_summary", summary: { not: "text" } }, 2), [{ kind: "compaction", ts: 2, text: "" }]);
	assert.deepEqual(entriesOf({ type: "thinking_level_change", thinkingLevel: "high" }, 3), [{ kind: "note", ts: 3, text: "thinking level: high" }]);
	assert.deepEqual(entriesOf({ type: "thinking_level_change", thinkingLevel: "high level!" }, 3), [{ kind: "note", ts: 3, text: "thinking level: ?" }]);
	assert.deepEqual(entriesOf({ type: "context_edit", removed: ["secret text"] }, 4), [{ kind: "note", ts: 4, text: "an earlier message was edited out of the context" }]);
	assert.deepEqual(entriesOf({ type: "message", message: { role: "system" } }, 5), [{ kind: "note", ts: 5, text: "a system message" }]);
	assert.deepEqual(entriesOf({ type: "message", message: { role: "evil role‮" } }, 5), [{ kind: "note", ts: 5, text: "a ? message" }], "the role through the tool charset");
	assert.deepEqual(entriesOf({ type: "custom_message", customType: "bad type!", content: "x" }, 6), [{ kind: "note", ts: 6, text: "?: x" }]);
	assert.deepEqual(entriesOf({ type: "model_change", provider: "a/b", modelId: "m" }, 7), [{ kind: "note", ts: 7, text: "model: ?/m" }]);
	assert.deepEqual(entriesOf({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "partial" }], stopReason: "aborted", errorMessage: "provider words" } }, 8), [{ kind: "assistant", ts: 8, text: "partial" }, { kind: "note", ts: 8, text: "the model's turn ended: aborted" }]);
	assert.deepEqual(entriesOf({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "length" } }, 8), [{ kind: "assistant", ts: 8, text: "done" }], "an ordinary stop reason adds nothing");
});

test("clip trims half an escape at the cut, headOf counts code points, and outcomeOf passes only the enum (#643)", () => {
	assert.deepEqual(clip("aaaaa\\u{202E}", 8), { text: "aaaaa", truncated: true }, "a cut inside \\u{ is trimmed");
	assert.deepEqual(clip("aaaaaa\\u{0007}", 7), { text: "aaaaaa", truncated: true }, "a cut after the backslash is trimmed");
	assert.deepEqual(clip("abc", 3), { text: "abc", truncated: false });
	assert.equal(headOf("😀😀😀", 2), "😀😀");
	assert.equal(headOf("abc", 5), "abc");
	for (const ok of LIVE_OUTCOMES) assert.equal(outcomeOf(ok), ok);
	for (const bad of ["Completed", "aborted", "<b>x</b>", undefined, null, 0, {}]) assert.equal(outcomeOf(bad), "unknown", String(bad));
});

test("stageLiveFile creates the file 0600 inside the 0700 directory (#643)", () => {
	const jobDir = join(tempDir("pi-live-mode-"), "job");
	const { hostDir } = stageLiveFile(jobDir);
	assert.equal(statSync(hostDir).mode & 0o777, 0o700);
	assert.equal(statSync(join(hostDir, "current.jsonl")).mode & 0o777, 0o600);
});

// --- review round: a fake Valkey with the transaction shape the publisher uses ----------------------------------

/** `exec` answers per command, or as `answer(ops)` returns; every committed XADD's fields land in `writes`. */
function fakeRedis({ answer = null } = {}) {
	const r = { writes: [], ttls: [], dels: 0, execs: 0 };
	r.multi = () => {
		const ops = [];
		const tx = {
			del: () => (ops.push(["del"]), tx),
			xadd: (_k, ...rest) => (ops.push(["xadd", rest.slice(4)]), tx),
			pexpire: (_k, ms) => (ops.push(["pexpire", ms]), tx),
			exec: async () => {
				r.execs += 1;
				if (answer) return answer(ops);
				for (const [op, arg] of ops) {
					if (op === "del") r.dels += 1;
					else if (op === "xadd") r.writes.push(Object.fromEntries(arg.reduce((acc, v, i) => (i % 2 ? acc[acc.length - 1].push(v) : acc.push([v]), acc), [])));
					else r.ttls.push(arg);
				}
				return ops.map(() => [null, "OK"]);
			},
		};
		return tx;
	};
	return r;
}

function fakeSetup(opts = {}) {
	const dir = tempDir("pi-live-fake-");
	const file = join(dir, "current.jsonl");
	writeFileSync(file, "");
	const redis = "redis" in opts ? opts.redis : fakeRedis();
	const logs = [];
	const pub = makeLiveTranscript({ file, jobId: "fake-1", redis, pollMs: 3_600_000, now: () => Date.parse(AT), log: (e, f) => logs.push({ e, f }), ...opts });
	return { file, redis, pub, logs, append: (t) => appendFileSync(file, t) };
}

test("the whole text is redacted before any cut: a secret across the cut leaves no head (#643)", async () => {
	const secret = "SECRETVALUE0123456789";
	const { pub, redis, append } = fakeSetup({ redact: makeRedactor({ values: [secret] }) });
	append(msg({ role: "user", content: `${"a".repeat(LIVE_TEXT_MAX - 5)}${secret} and more` }));
	// Past the head the queue keeps (twice the limit): the secret straddles that cut too.
	append(msg({ role: "user", content: `${"b".repeat(2 * LIVE_TEXT_MAX - 3)}${secret}` }));
	await pub.finish("completed");
	const [first, second] = redis.writes;
	assert.equal(first.text, `${"a".repeat(LIVE_TEXT_MAX - 5)}[reda`);
	assert.equal(first.truncated, "1");
	assert.equal(second.text, "b".repeat(LIVE_TEXT_MAX));
	assert.ok(!JSON.stringify(redis.writes).includes("SECRET"));
});

test("redaction runs before escaping: a secret holding a bidi character is still caught (#643)", async () => {
	const secret = "abc‮defghij";
	const { pub, redis, append } = fakeSetup({ redact: makeRedactor({ values: [secret] }) });
	append(msg({ role: "user", content: `pw ${secret}` }));
	await pub.finish("completed");
	assert.equal(redis.writes[0].text, "pw [redacted]");
});

test("a throwing redactor publishes nothing for that entry, never its raw text (#643)", async () => {
	const redact = (t) => {
		if (String(t).includes("BOOM")) throw new Error("redactor fault");
		return String(t);
	};
	const { pub, redis, append } = fakeSetup({ redact });
	append(msg({ role: "user", content: "before" }) + msg({ role: "user", content: "BOOM raw private" }) + msg({ role: "user", content: "after" }));
	await pub.finish("completed");
	assert.deepEqual(redis.writes.map((w) => w.text ?? w.kind), ["before", "after", "end"]);
	assert.equal(pub.stats().errors, 1);
});

test("the tool field is redacted: a tool named after the job's token is published as ?, and a custom type in note text too (#643)", async () => {
	const token = "tok_ABCDEFGH12";
	const { pub, redis, append } = fakeSetup({ redact: makeRedactor({ values: [token] }) });
	append(msg({ role: "assistant", content: [{ type: "toolCall", id: "1", name: token, arguments: {} }] }));
	append(msg({ role: "toolResult", toolName: token, isError: false, content: [] }));
	append(`${JSON.stringify({ type: "custom_message", customType: token, content: "hi", timestamp: AT })}\n`);
	append(msg({ role: "toolResult", toolName: "read", isError: false, content: [] }));
	await pub.finish("completed");
	assert.deepEqual(redis.writes.map((w) => w.tool ?? null), ["?", "?", null, "read", null]);
	assert.equal(redis.writes[2].text, "[redacted]: hi");
	assert.ok(!JSON.stringify(redis.writes).includes(token));
});

test("ts is the pi entry's own timestamp when sane, else the publish time (#643)", async () => {
	const NOW = Date.parse(AT) + 5_000;
	const { pub, redis, append } = fakeSetup({ now: () => NOW });
	append(msg({ role: "user", content: "own" }, AT));
	append(msg({ role: "user", content: "future" }, "3000-01-01T00:00:00.000Z"));
	append(`${JSON.stringify({ type: "message", timestamp: -5, message: { role: "user", content: "negative" } })}\n`);
	append(`${JSON.stringify({ type: "message", timestamp: 1234.9, message: { role: "user", content: "fraction" } })}\n`);
	append(`${JSON.stringify({ type: "message", timestamp: NOW + 24 * 3600 * 1000, message: { role: "user", content: "edge" } })}\n`);
	append(`${JSON.stringify({ type: "message", timestamp: "garbage", message: { role: "user", content: "unparsed" } })}\n`);
	await pub.finish("completed");
	assert.deepEqual(redis.writes.map((w) => [w.text ?? w.kind, w.ts]), [
		["own", String(Date.parse(AT))],
		["future", String(NOW)],
		["negative", String(NOW)],
		["fraction", "1234"],
		["edge", String(NOW + 24 * 3600 * 1000)],
		["unparsed", String(NOW)],
		["end", String(NOW)],
	]);
});

test("the text limit's exact boundary: 4096 code points fit, 4097 are cut (#643)", async () => {
	const { pub, redis, append } = fakeSetup();
	append(msg({ role: "user", content: "x".repeat(LIVE_TEXT_MAX) }));
	append(msg({ role: "user", content: "y".repeat(LIVE_TEXT_MAX + 1) }));
	await pub.finish("completed");
	assert.equal(redis.writes[0].text.length, LIVE_TEXT_MAX);
	assert.equal(redis.writes[0].truncated, undefined);
	assert.equal(redis.writes[1].text.length, LIVE_TEXT_MAX);
	assert.equal(redis.writes[1].truncated, "1");
});

test("an empty line is skipped, not a note (#643)", async () => {
	const { pub, redis, append } = fakeSetup();
	append(`\n${msg({ role: "user", content: "a" })}\n\n${msg({ role: "user", content: "b" })}`);
	await pub.finish("completed");
	assert.deepEqual(redis.writes.map((w) => w.text ?? w.kind), ["a", "b", "end"]);
});

test("the queue holds entries in their final size: a megabyte line costs one entry's text, never the line (#643)", async () => {
	const { pub, append } = fakeSetup({ redis: null });
	for (let i = 0; i < 3; i++) append(msg({ role: "user", content: "z".repeat(900 * 1024) }));
	await pub.poll();
	const { pending, pendingBytes } = pub.stats();
	assert.equal(pending, 3);
	assert.ok(pendingBytes < 3 * (LIVE_TEXT_MAX * 2 + 200), `queued ${pendingBytes} bytes`);
});

test("the queue is bounded in entries and in bytes, and the OLDEST are dropped (#643)", async () => {
	const byCount = fakeSetup({ pendingMax: 3 });
	for (const n of [1, 2, 3, 4, 5]) byCount.append(msg({ role: "user", content: `m${n}` }));
	await byCount.pub.poll();
	assert.deepEqual(byCount.redis.writes.map((w) => w.text), ["m3", "m4", "m5"]);
	assert.equal(byCount.pub.stats().dropped, 2);
	// Each entry is about 4 KiB of text (2 bytes a code unit) plus its other fields: room for two.
	const byBytes = fakeSetup({ pendingMaxBytes: 10_000 });
	for (const n of [1, 2, 3, 4]) byBytes.append(msg({ role: "user", content: `${n}`.repeat(2000) }));
	await byBytes.pub.poll();
	assert.deepEqual(byBytes.redis.writes.map((w) => w.text[0]), ["3", "4"]);
	assert.equal(byBytes.pub.stats().dropped, 2);
});

test("an oversize line still being written is said once, when it starts, and holds no memory while it grows (#643)", async () => {
	const { pub, redis, append } = fakeSetup({ lineMaxBytes: 256 });
	append(`{"type":"message","message":{"role":"user","content":"${"q".repeat(200)}`);
	await pub.poll();
	assert.equal(pub.stats().held > 0, true);
	append("q".repeat(200));
	await pub.poll();
	assert.deepEqual(redis.writes.map((w) => w.kind), ["skipped"], "said as soon as it passed the bound");
	assert.equal(pub.stats().held, 0);
	append("q".repeat(5000));
	await pub.poll();
	assert.equal(pub.stats().held, 0, "the growing line is dropped as it arrives");
	append(`"}}\n${msg({ role: "user", content: "next" })}`);
	await pub.finish("completed");
	assert.deepEqual(redis.writes.map((w) => w.text ?? w.kind), ["skipped", "next", "end"]);
});

test("a NEW INODE at the same path, same first line and larger, is a reset and a reread (#643)", async () => {
	const { pub, redis, append, file } = fakeSetup();
	append(header("s1") + msg({ role: "user", content: "old" }));
	await pub.poll();
	const other = `${file}.new`;
	writeFileSync(other, header("s1") + msg({ role: "user", content: "replacement, and longer than the old one" }));
	renameSync(other, file);
	await pub.finish("completed");
	assert.deepEqual(redis.writes.map((w) => w.text ?? w.kind), ["session started", "old", "reset", "session started", "replacement, and longer than the old one", "end"]);
});

test("start is idempotent and refused after finish (#643)", async () => {
	const { lstat, open } = await import("node:fs/promises");
	let lstats = 0;
	const { pub } = fakeSetup({ fs: { open, lstat: async (p) => ((lstats += 1), lstat(p)) } });
	pub.start();
	pub.start();
	await pub.poll();
	assert.equal(lstats, 1, "one immediate poll; the second start did nothing, and the explicit poll joined the one in flight");
	await pub.finish("completed");
	// A publisher never started, then finished: a later start polls nothing.
	let late = 0;
	const never = fakeSetup({ fs: { open, lstat: async (p) => ((late += 1), lstat(p)) } });
	await never.pub.finish("completed");
	const after = late;
	// No timer either: a start after finish would leave an interval running for nothing.
	const realSetInterval = globalThis.setInterval;
	let timers = 0;
	globalThis.setInterval = (...a) => ((timers += 1), realSetInterval(...a));
	try {
		never.pub.start();
	} finally {
		globalThis.setInterval = realSetInterval;
	}
	await new Promise((r) => setTimeout(r, 50));
	assert.equal(late, after, "no poll after finish");
	assert.equal(timers, 0, "no timer after finish");
});

test("the final read flushes after every chunk (#643)", async () => {
	const { open, lstat } = await import("node:fs/promises");
	const order = [];
	const redis = fakeRedis();
	const exec0 = redis.multi;
	redis.multi = () => {
		const tx = exec0();
		const exec = tx.exec;
		tx.exec = async () => (order.push("exec"), exec());
		return tx;
	};
	const fs = {
		lstat,
		open: async (p, f) => {
			const h = await open(p, f);
			const read = h.read.bind(h);
			h.read = (...a) => (order.push("read"), read(...a));
			return h;
		},
	};
	const { pub, append } = fakeSetup({ redis, fs, readChunkBytes: 128 });
	for (let i = 0; i < 4; i++) append(msg({ role: "user", content: `line ${i}` }));
	await pub.finish("completed");
	assert.equal(redis.writes.length, 5);
	const firstExec = order.indexOf("exec");
	assert.ok(firstExec > 0 && order.lastIndexOf("read") > firstExec, `a write landed between reads: ${order.join(",")}`);
});

test("the final read stops at its byte budget, said once (#643)", async () => {
	const { open, lstat } = await import("node:fs/promises");
	let bytes = 0;
	const fs = {
		lstat,
		open: async (p, f) => {
			const h = await open(p, f);
			const read = h.read.bind(h);
			h.read = async (...a) => {
				const res = await read(...a);
				bytes += res.bytesRead;
				return res;
			};
			return h;
		},
	};
	const { pub, redis, append } = fakeSetup({ fs, readChunkBytes: 1024, finalReadMaxBytes: 4096 });
	for (let i = 0; i < 200; i++) append(msg({ role: "user", content: `n${i}` }));
	await pub.finish("completed");
	assert.ok(bytes <= 4096, `read ${bytes} bytes`);
	assert.equal(redis.writes.filter((w) => w.kind === "skipped").length, 1);
	assert.equal(redis.writes.at(-1).kind, "end");
});

test("a 64 GiB sparse file: no read starts after finish resolved, whatever the read was doing (#643)", { timeout: 20_000 }, async () => {
	const { open, lstat } = await import("node:fs/promises");
	let reads = 0;
	const fs = {
		lstat,
		open: async (p, f) => {
			const h = await open(p, f);
			const read = h.read.bind(h);
			h.read = async (...a) => {
				reads += 1;
				await new Promise((r) => setTimeout(r, 30));
				return read(...a);
			};
			return h;
		},
	};
	const { pub, file } = fakeSetup({ fs, finishTimeoutMs: 200 });
	truncateSync(file, 64 * 1024 ** 3);
	const began = Date.now();
	await pub.finish("completed");
	assert.ok(Date.now() - began < 1_000, "finish returned at its bound");
	const atFinish = reads;
	await new Promise((r) => setTimeout(r, 500));
	assert.equal(reads, atFinish, "no read after finish resolved");
	assert.equal(pub.stats().closed, true);
});

test("a MULTI reply carrying an error counts as a failed write, and the next write still empties the stream first (#643)", async () => {
	let calls = 0;
	const seen = [];
	const redis = fakeRedis({
		answer: (ops) => {
			calls += 1;
			seen.push(ops.map(([op]) => op));
			return calls === 1 ? ops.map((_, i) => (i === 1 ? [new Error("WRONGTYPE"), null] : [null, "OK"])) : ops.map(() => [null, "OK"]);
		},
	});
	const { pub, logs, append } = fakeSetup({ redis });
	append(msg({ role: "user", content: "a" }));
	await pub.poll();
	append(msg({ role: "user", content: "b" }));
	await pub.finish("completed");
	assert.deepEqual(seen[1][0], "del", "the first write did not count, so the next one starts the attempt again");
	assert.equal(logs[0].e, "live_transcript_write_failed");
	assert.equal(logs.at(-1).f.dropped, 1);
	assert.equal(logs.at(-1).f.published, 2);
});

test("a hung exec is bounded on a poll, and a hung read is bounded by finish's own bound (#643)", { timeout: 10_000 }, async () => {
	const hung = { multi: () => ({ del() {
		return this;
	}, xadd() {
		return this;
	}, pexpire() {
		return this;
	}, exec: () => new Promise(() => {}) }) };
	const a = fakeSetup({ redis: hung, timeoutMs: 50, finishTimeoutMs: 60_000 });
	a.append(msg({ role: "user", content: "x" }));
	let began = Date.now();
	await a.pub.poll();
	assert.ok(Date.now() - began < 1_000, "the exec's own bound");
	const b = fakeSetup({ finishTimeoutMs: 150, fs: { lstat: async () => new Promise(() => {}), open: async () => new Promise(() => {}) } });
	began = Date.now();
	await b.pub.finish("completed");
	assert.ok(Date.now() - began < 1_000, "finish's bound");
	const handed = fakeRedis();
	handed.status = "reconnecting";
	const c = fakeSetup({ redis: handed });
	c.append(msg({ role: "user", content: "y" }));
	await c.pub.finish("completed");
	assert.equal(handed.execs, 0, "a client that is not ready is not handed the write");
	assert.equal(c.logs.at(-1).f.dropped, 2);
});

// --- review round: against a real Valkey ------------------------------------------------------------------------

test("a retry's first write deletes the previous attempt's few entries (#643)", { skip: live }, async () => {
	const { r, pub, read, append } = await setup("retry-1");
	for (const n of [1, 2, 3]) await r.xadd(liveKeyFor("retry-1"), "*", "kind", "note", "ts", "1", "text", `attempt one ${n}`);
	append(header());
	await pub.poll();
	assert.deepEqual((await read()).map((e) => e.text), ["session started"]);
});

test("a stale attempt whose finish timed out never writes into the next attempt's stream, nor changes its TTL (#643)", { skip: live, timeout: 20_000 }, async () => {
	const { open, lstat } = await import("node:fs/promises");
	const r = await client();
	const jobId = "stale-1";
	const dir = tempDir("pi-live-stale-");
	const file1 = join(dir, "a1.jsonl");
	const file2 = join(dir, "a2.jsonl");
	writeFileSync(file1, header("one") + msg({ role: "user", content: "ATTEMPT ONE LATE" }));
	writeFileSync(file2, "");
	let release;
	const gate = new Promise((res) => (release = res));
	// Attempt 1's final read is IN FLIGHT when its finish times out, and returns its bytes only when the test releases
	// it, long after: what it read must be neither written nor even queued.
	const slowFs = {
		lstat,
		open: async (p, f) => {
			const h = await open(p, f);
			const read = h.read.bind(h);
			h.read = async (...a) => (await gate, read(...a));
			return h;
		},
	};
	const one = makeLiveTranscript({ file: file1, jobId, redis: r, pollMs: 3_600_000, now: () => Date.parse(AT), fs: slowFs, finishTimeoutMs: 100 });
	await one.finish("failed");
	const two = makeLiveTranscript({ file: file2, jobId, redis: r, pollMs: 3_600_000, now: () => Date.parse(AT) });
	appendFileSync(file2, header("two") + msg({ role: "user", content: "attempt two" }));
	await two.poll();
	release();
	await new Promise((res) => setTimeout(res, 300));
	const entries = (await r.xrange(liveKeyFor(jobId), "-", "+")).map(([, f]) => f[f.indexOf("text") + 1] ?? f[1]);
	assert.deepEqual(entries, ["session started", "attempt two"]);
	const ttl = await r.pttl(liveKeyFor(jobId));
	assert.ok(ttl > LIVE_TTL_LIVE_MS - 60_000, `attempt two's live TTL stands: ${ttl}`);
	assert.equal(one.stats().pending, 0, "the stale read's bytes were not queued");
	await two.finish("completed");
});

test("a client still connecting keeps the entries queued, and they are written once it is ready (nothing lost at the start)", async () => {
	const r = fakeRedis();
	r.status = "connecting";
	const s = fakeSetup({ redis: r });
	s.append(header());
	s.append(msg({ role: "user", content: "first words" }));
	await s.pub.poll();
	assert.equal(r.execs, 0, "not handed to a client that is not ready");
	r.status = "ready";
	s.append(msg({ role: "user", content: "second" }));
	await s.pub.poll();
	assert.deepEqual(r.writes.map((w) => w.text), ["session started", "first words", "second"], "the queued entries were kept, in order");
	await s.pub.finish("completed");
});

// --- run progress (issue #644): the key writer and the progress-only mode, on the same database 14 ---------------

const { makeLiveTranscriptOpener } = await import("../src/live-transcript.mjs");
const { makeProgressWriter, progressKeyFor, PROGRESS_MAX_BYTES } = await import("../src/run-progress.mjs");
const pcall = (id, name, args = {}) => ({ type: "toolCall", id, name, arguments: args });
const presult = (id, name, durationMs = 1, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: name, content: [], isError, durationMs });
// `fire` runs the timer due soonest (the shortest delay), so the writer's 30 s heartbeat waits behind a trailing write.
const manualTimers = () => {
	const pending = [];
	const setTimer = (fn, ms) => {
		const t = { fn, ms, unref() {} };
		pending.push(t);
		return t;
	};
	const clearTimer = (t) => {
		const i = pending.indexOf(t);
		if (i !== -1) pending.splice(i, 1);
	};
	const fire = () => {
		pending.sort((a, b) => a.ms - b.ms);
		return pending.shift()?.fn();
	};
	return { pending, setTimer, clearTimer, fire };
};

test("the progress key: throttled to once a second with a trailing write, 7 day TTL from the first write, 24 h after the final (#644)", { skip: live }, async () => {
	const r = await client();
	let t = Date.parse(AT);
	const timers = manualTimers();
	const w = makeProgressWriter({ redis: r, jobId: "prog:throttle", now: () => t, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
	const key = progressKeyFor("prog:throttle");
	w.update({ v: 1, turn: 1 });
	await w.init();
	await new Promise((res) => setTimeout(res, 50));
	assert.equal(JSON.parse(await r.get(key)).turn, 1, "the first change is written at once");
	const ttl1 = await r.pttl(key);
	assert.ok(ttl1 > LIVE_TTL_LIVE_MS - 60_000 && ttl1 <= LIVE_TTL_LIVE_MS, `live TTL ${ttl1}`);
	w.update({ v: 1, turn: 2 });
	w.update({ v: 1, turn: 3 });
	await new Promise((res) => setTimeout(res, 20));
	assert.equal(JSON.parse(await r.get(key)).turn, 1, "inside the second: not yet");
	assert.equal(timers.pending.filter((p) => p.ms <= 1000).length, 1, "one trailing write is scheduled, beside the heartbeat");
	t += 1000;
	timers.fire();
	await new Promise((res) => setTimeout(res, 50));
	assert.equal(JSON.parse(await r.get(key)).turn, 3, "the trailing write carries the latest");
	t += 3_600_000;
	w.update({ v: 1, turn: 4 });
	await new Promise((res) => setTimeout(res, 50));
	const ttl2 = await r.pttl(key);
	assert.ok(ttl2 <= LIVE_TTL_LIVE_MS - 3_600_000 + 1000, "a later write never extends the TTL past 7 days from the first");
	await w.final({ v: 1, turn: 4, ended: true, outcome: "completed" });
	const end = JSON.parse(await r.get(key));
	assert.deepEqual([end.ended, end.outcome, end.commentId], [true, "completed", null]);
	const ttl3 = await r.pttl(key);
	assert.ok(ttl3 > LIVE_TTL_ENDED_MS - 60_000 && ttl3 <= LIVE_TTL_ENDED_MS, `ended TTL ${ttl3}`);
	w.update({ v: 1, turn: 99 });
	await new Promise((res) => setTimeout(res, 30));
	assert.equal(JSON.parse(await r.get(key)).turn, 4, "nothing after the final write");
});

test("the progress key carries an earlier attempt's commentId into the next attempt, and caps its size (#644)", { skip: live }, async () => {
	const r = await client();
	const key = progressKeyFor("prog:retry");
	await r.set(key, JSON.stringify({ v: 1, turn: 9, commentId: "IC_kwDO:123" }), "PX", 60_000);
	const w = makeProgressWriter({ redis: r, jobId: "prog:retry", now: () => Date.parse(AT) });
	assert.equal(await w.init(), "IC_kwDO:123");
	const huge = { v: 1, turn: 1, recent: Array.from({ length: 20 }, () => ({ tool: "x".repeat(2000), status: "ok", durationMs: 1, at: 1 })), phases: [], note: null };
	await w.final(huge);
	const raw = await r.get(key);
	assert.ok(Buffer.byteLength(raw) <= PROGRESS_MAX_BYTES, `${Buffer.byteLength(raw)} bytes`);
	const back = JSON.parse(raw);
	assert.deepEqual([back.turn, back.commentId], [1, "IC_kwDO:123"], "replaced, the comment id kept");
	await r.set(key, "not json", "PX", 60_000);
	assert.equal(await makeProgressWriter({ redis: r, jobId: "prog:retry" }).init(), null, "an unreadable old key: a fresh comment");
	await r.set(key, JSON.stringify({ commentId: "bad id!" }), "PX", 60_000);
	assert.equal(await makeProgressWriter({ redis: r, jobId: "prog:retry" }).init(), null, "a malformed id is never carried");
});

test("a Valkey outage never throws from the progress writer: a closed client is counted and logged once (#644)", { skip: live }, async () => {
	const { makeRedisClient } = await import("../src/connection.mjs");
	const url = new URL(valkeyUrl);
	url.pathname = "/14";
	const closed = makeRedisClient(url.toString());
	closed.on("error", () => {});
	await closed.ping();
	closed.disconnect();
	const logs = [];
	const w = makeProgressWriter({ redis: closed, jobId: "prog:down", log: (e) => logs.push(e) });
	w.update({ v: 1 });
	assert.equal(await w.init(), null);
	await w.final({ v: 1, ended: true });
	assert.deepEqual(logs, ["run_progress_write_failed"]);
});

test("transcripts off and progress on: the file is tailed, the progress key written, and no stream is ever touched (#644)", { skip: live }, async () => {
	const r = await client();
	const dir = tempDir("pi-live-prog-");
	const file = join(dir, "current.jsonl");
	// A resume transcript: the earlier run's lines are before the baseline.
	writeFileSync(file, header() + msg({ role: "assistant", content: [pcall("old", "report_progress", { phase: "plan", total: 2 })] }) + msg(presult("old", "report_progress")));
	const open = makeLiveTranscriptOpener({ redis: r, transcripts: false, progress: true, pollMs: 3_600_000, now: () => Date.parse(AT) });
	const pub = open({ file, jobId: "prog:off-1", redact: (t) => String(t), job: { progress: true } });
	pub.start();
	await pub.poll();
	appendFileSync(file, msg({ role: "assistant", content: [pcall("a", "bash", { cmd: "ls" }), pcall("b", "report_progress", { phase: "build", done: 1, total: 4 })] }));
	appendFileSync(file, msg(presult("b", "report_progress", 2)));
	await pub.poll();
	await pub.finish("completed");
	assert.equal(await r.exists(liveKeyFor("prog:off-1")), 0, "no run:live: key");
	const snap = JSON.parse(await r.get(progressKeyFor("prog:off-1")));
	assert.deepEqual([snap.turn, snap.steps, snap.interrupted, snap.ended, snap.outcome], [1, 1, 1, true, "completed"]);
	assert.deepEqual(snap.prior, { turns: 1, steps: 1 });
	assert.deepEqual(snap.phases, ["plan", "build"]);
	assert.deepEqual(snap.phase, { index: 1, done: 1, total: 4 });
	assert.deepEqual(pub.progressSummary(), { turns: 1, steps: 1, interrupted: 1, toolMs: 2, longestStepMs: 2, phasesDeclared: 2, lastPhaseIndex: 1, tools: { report_progress: 1 } });
	assert.equal(pub.stats().pending, 0, "nothing queued for a stream");
});

test("both on: the stream is as before and the progress key beside it; a job without run.progress reads no phases (#644)", { skip: live }, async () => {
	const r = await client();
	const dir = tempDir("pi-live-prog-");
	const file = join(dir, "current.jsonl");
	writeFileSync(file, "");
	const open = makeLiveTranscriptOpener({ redis: r, transcripts: true, progress: true, pollMs: 3_600_000, now: () => Date.parse(AT) });
	const pub = open({ file, jobId: "prog:both-1", redact: (t) => String(t), job: {} });
	pub.start();
	appendFileSync(file, header() + msg({ role: "assistant", content: [pcall("1", "report_progress", { phase: "x" })] }) + msg(presult("1", "report_progress")));
	await pub.poll();
	await pub.finish("completed");
	const kinds = (await r.xrange(liveKeyFor("prog:both-1"), "-", "+")).map(([, f]) => f[1]);
	assert.deepEqual(kinds, ["note", "tool-call", "tool-result", "end"]);
	const snap = JSON.parse(await r.get(progressKeyFor("prog:both-1")));
	assert.deepEqual([snap.steps, snap.phases, snap.prior], [1, [], null], "an empty staged file has no prior, and no phases without run.progress");
	assert.equal(makeLiveTranscriptOpener({ redis: r, transcripts: false, progress: false }), null, "both off: no opener");
	assert.equal(makeLiveTranscriptOpener({ redis: null, progress: true }), null, "no client: no opener");
});

test("the opener with progress off says once that a run.statusComment job gets no comment (#644)", () => {
	const logs = [];
	const open = makeLiveTranscriptOpener({ redis: {}, transcripts: true, progress: false, log: (event, fields) => logs.push([event, fields]) });
	open({ file: "/nonexistent/current.jsonl", jobId: "j/1", redact: (t) => String(t), job: { statusComment: true } });
	open({ file: "/nonexistent/current.jsonl", jobId: "j2", redact: (t) => String(t), job: {} });
	assert.deepEqual(logs, [["status_comment_skipped", { jobId: sanitizeJobId("j/1"), reason: "progress-off" }]]);
});

test("a reset in progress mode: counts kept, the rewritten lines replayed without counting twice (#644)", { skip: live }, async () => {
	const r = await client();
	const dir = tempDir("pi-live-prog-");
	const file = join(dir, "current.jsonl");
	writeFileSync(file, "");
	const open = makeLiveTranscriptOpener({ redis: r, transcripts: false, progress: true, pollMs: 3_600_000, now: () => Date.parse(AT) });
	const pub = open({ file, jobId: "prog:reset-1", redact: (t) => String(t), job: {} });
	pub.start();
	const body = header() + msg({ role: "assistant", content: [pcall("1", "read")] }) + msg(presult("1", "read"));
	appendFileSync(file, body);
	await pub.poll();
	writeFileSync(file, header("s2") + msg({ role: "assistant", content: [pcall("1", "read")] }) + msg(presult("1", "read")));
	await pub.poll();
	appendFileSync(file, msg({ role: "assistant", content: [] }));
	await pub.finish("completed");
	assert.deepEqual(pub.progressSummary(), { turns: 2, steps: 1, toolMs: 1, longestStepMs: 1, tools: { read: 1 } });
	assert.equal(pub.stats().progress.resets, 1);
});

test("the time handed to onParsed is bounded as the stream's is: not negative, at most a day ahead, an integer (#644)", async () => {
	const seen = [];
	const read = Date.parse(AT);
	const { pub, append } = fakeSetup({ stream: false, onParsed: (_parsed, ts) => seen.push(ts) });
	const entry = (timestamp) => `${JSON.stringify({ type: "message", timestamp, message: { role: "user", content: "x" } })}\n`;
	append(entry(new Date(read + 2 * 24 * 3600 * 1000).toISOString()) + entry(-5) + entry(read - 1000.5) + entry(read + 3600 * 1000) + entry(AT) + entry(1e300));
	await pub.finish("completed");
	assert.deepEqual(seen, [read, read, read - 1001, read + 3600 * 1000, read, read], "a forged time is the read time; a fraction is cut");
});
