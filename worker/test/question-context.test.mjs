import assert from "node:assert/strict";
import { test } from "node:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers/temp-dir.mjs";
import { readQuestionContext } from "../src/question-context.mjs";

test("private context is a contiguous complete suffix and secrets are removed before the excerpt bound", () => {
	const path = join(tempDir("pd-question-context-"), "transcript");
	fs.writeFileSync(path, "old question\n" + "x".repeat(18 * 1024) + "\nlatest question secret\n");
	let readBytes = 0;
	const observed = { ...fs, readSync(...args) { readBytes += args[3]; return fs.readSync(...args); } };
	const result = readQuestionContext({ path, redact: (text) => text.replaceAll("secret", "[redacted]"), fs: observed });
	assert.equal(result.status, "ready");
	assert.equal(result.truncated, true);
	assert.match(result.text, /latest question \[redacted\]/);
	assert.ok(!result.text.includes("old question"));
	assert.ok(!result.text.includes("secret"));
	assert.ok(readBytes <= 64 * 1024);
});

test("an oversized final question is refused, never replaced by an older convenient entry", () => {
	const path = join(tempDir("pd-question-oversize-"), "transcript");
	fs.writeFileSync(path, "old question\n" + "latest-private-question".repeat(5000) + "\n");
	const result = readQuestionContext({ path, redact: (text) => text });
	assert.equal(result.status, "source-oversize");
	assert.equal(result.text, undefined);
});

test("links, changing files and missing redaction yield named unavailable states without text", () => {
	const root = tempDir("pd-question-source-");
	const target = join(root, "secret");
	fs.writeFileSync(target, "host-secret");
	const link = join(root, "link"); fs.symlinkSync(target, link);
	assert.deepEqual(readQuestionContext({ path: link, redact: (text) => text }), { status: "source-unavailable" });
	assert.deepEqual(readQuestionContext({ path: target }), { status: "source-unavailable" });
	let stats = 0;
	const changed = { ...fs, fstatSync(fd) { const stat = fs.fstatSync(fd); stats++; return stats === 2 ? { ...stat, isFile: () => true, size: stat.size + 1 } : stat; } };
	assert.deepEqual(readQuestionContext({ path: target, redact: (text) => text, fs: changed }), { status: "source-unavailable" });
});
